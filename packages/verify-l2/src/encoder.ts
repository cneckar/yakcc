// SPDX-License-Identifier: Apache-2.0
/**
 * The encoder: a DUC graph as SMT-LIB2 definitions, facts and obligations (#1421).
 *
 * @decision DEC-VERIFY-L2-CONTEXT-001
 * title: loops, calls and throws as ordered facts and obligations
 * status: decided (#1421 slices 3 to 5)
 * rationale:
 *   A value is encoded in an environment: the graph it belongs to, its parameters, the terms its
 *   loop-carried values are bound to, and the assumptions under which it is computed. A loop's body
 *   is encoded twice with fresh carried values: once to check the invariant is preserved
 *   (`I(c) ∧ cond(c) ⇒ I(next(c))`), once to describe the exit (`I(e) ∧ ¬cond(e)`), whose fresh
 *   values are the loop's outputs. Entry (`I(init)`) is an obligation too. A call through a link is
 *   a fresh result: the callee's preconditions are obligations at the call, and its postconditions
 *   are a fact about the result only when the callee is L2-proven.
 *
 *   Facts are global assertions, each guarded by the path to the loop or call that made it, and
 *   numbered in the order they are made. An obligation assumes only the facts made before it, so a
 *   loop's own exit fact (which a wrong invariant could make unsatisfiable) never proves that
 *   loop's own entry or preservation. A postcondition assumes every fact.
 *
 *   A region that contains a `throw` directly never returns normally: its nodes are not encoded,
 *   a join's value from that side is never used, and postconditions assume no such region is
 *   entered (partial correctness on normal returns, as Eidic's verifier). Every other effect is
 *   unsupported, anywhere in the graph.
 */
import {
  type DucGraph,
  type DucNode,
  type NodeId,
  type ValueId,
  ecmaScriptView,
  liftAtom,
} from "@yakcc/duc";
import {
  MATH_EXACT,
  PLATFORM_NUMBERS,
  type Sort,
  type Term,
  Unsupported,
  f64Literal,
  literal,
  mathCall,
  operation,
  smtSort,
  truthy,
} from "./terms.js";
import type { Callee, L2Contract } from "./types.js";

/** A proof obligation a loop or a call adds, beside the contract's postconditions. */
export interface GoalObligation {
  /** `loop_<i>_entry`, `loop_<i>_preserve`, `call_<symbol>_<n>_pre_<k>`. */
  readonly id: string;
  readonly kind: "loop-entry" | "loop-preserve" | "call-precondition";
  /** What is claimed, for a reader. */
  readonly condition: string;
  /** The Bool term that must hold. */
  readonly goal: string;
  /** How many facts (in order) the obligation may assume. */
  readonly facts: number;
  /** Symbols worth showing in a counterexample, beside the parameters. */
  readonly show: readonly { readonly name: string; readonly smt: string; readonly sort: Sort }[];
}

/** A region that throws, and the condition under which it is entered. */
export interface ThrowSite {
  readonly region: string;
  /** The Bool term: the path to the region is taken. */
  readonly path: string;
  /** The source of the throw, for a reader. */
  readonly text: string;
}

/** A loop of a graph, in the order `loopInvariants` is indexed by. */
export interface LoopInfo {
  readonly index: number;
  readonly id: string;
  readonly text: string;
  /** Its carried variables, by their source names. */
  readonly carried: readonly string[];
}

/** The loops of a graph, in the order `L2Contract.loopInvariants` lists their invariants. */
export function loopsOf(graph: DucGraph): LoopInfo[] {
  const defOf = new Map<ValueId, DucNode>();
  for (const n of graph.nodes) for (const v of n.outputs) defOf.set(v, n);
  return graph.nodes
    .filter((n) => n.kind === "loop" && n.loop !== undefined)
    .map((n, index) => ({
      index,
      id: n.loop?.id ?? n.id,
      text: n.origin?.text ?? "",
      carried: carriedNames(n, defOf, []),
    }));
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

function carriedNames(
  loop: DucNode,
  defOf: ReadonlyMap<ValueId, DucNode>,
  taken: readonly string[],
): string[] {
  const used = new Set(taken);
  return (loop.loop?.carry ?? []).map((v, i) => {
    const text = defOf.get(v)?.origin?.text;
    const name = text !== undefined && IDENT.test(text) && !used.has(text) ? text : `$carry${i}`;
    used.add(name);
    return name;
  });
}

interface GraphCtx {
  readonly g: DucGraph;
  readonly defOf: ReadonlyMap<ValueId, DucNode>;
  /** Branch id → its condition value and the region it sits in. */
  readonly branches: ReadonlyMap<string, { readonly cond: ValueId; readonly within?: string }>;
  /** Regions that contain a throw directly. */
  readonly throwing: ReadonlySet<string>;
  readonly loopIndex: ReadonlyMap<NodeId, number>;
  readonly params: readonly Term[];
  /** Whether loop invariants and throws apply: the atom itself, not a condition. */
  readonly isAtom: boolean;
}

interface Env {
  readonly gc: GraphCtx;
  readonly ns: string;
  /** Carried and loop-invariant source values, bound for this pass through a body. */
  readonly bind: ReadonlyMap<ValueId, Term>;
  /** Assumptions under which the values of this environment are computed. */
  readonly ctx: readonly string[];
}

/** A value that is not a number or a boolean, which only some nodes accept. */
type Value =
  | Term
  | { readonly sort: "Undef" }
  | {
      readonly sort: "Fn";
      readonly fn: { kind: "math"; name: string } | { kind: "link"; key: string; symbol: string };
    };

function and(xs: readonly string[]): string {
  const real = xs.filter((x) => x !== "true");
  return real.length === 0
    ? "true"
    : real.length === 1
      ? (real[0] as string)
      : `(and ${real.join(" ")})`;
}

/** The encoder of one atom with its conditions: one instance per verification. */
export class Encoder {
  readonly decls: string[] = [];
  readonly defs: string[] = [];
  readonly facts: string[] = [];
  readonly obligations: GoalObligation[] = [];
  readonly throws: ThrowSite[] = [];
  /** What makes a counterexample possibly spurious: a loop or a call replaced by its contract. */
  readonly abstractions: string[] = [];
  /** The callees used, by link key: for replay. */
  readonly calleesUsed = new Map<string, { symbol: string; callee: Callee }>();
  private fresh = 0;
  private calls = 0;
  private readonly memo = new Map<string, Value>();
  private readonly loopMemo = new Map<string, readonly Term[]>();

  constructor(
    private readonly contract: L2Contract,
    private readonly paramTerms: readonly Term[],
    private readonly callees: Readonly<Record<string, Callee>> = {},
  ) {}

  /** Encodes the atom; returns its result. Records throw sites for the caller. */
  atom(graph: DucGraph): Term {
    const gc = this.graphCtx(graph, this.paramTerms, true);
    const env: Env = { gc, ns: "impl", bind: new Map(), ctx: [] };
    for (const region of gc.throwing) {
      if (/(^|\/)L[^/]*\.b(\/|$)/.test(region)) {
        throw new Unsupported("throw", "a throw inside a loop body (#1421: throws in loops)");
      }
      const site = gc.g.nodes.find((n) => n.label === "throw" && n.region === region);
      this.throws.push({
        region,
        path: this.path(region, env),
        text: site?.origin?.text ?? "throw",
      });
    }
    const result = this.term(this.value(gc.g.obs[0] as ValueId, env), "the result");
    this.touchCalls(env, undefined);
    return result;
  }

  /**
   * Encodes every call in a scope (the top level, or one loop's body), so each callee precondition
   * is an obligation even where the call's result is never read.
   */
  private touchCalls(env: Env, loopId: string | undefined): void {
    const inThrowing = (region: string): boolean =>
      [...env.gc.throwing].some((t) => region === t || region.startsWith(`${t}/`));
    for (const n of env.gc.g.nodes) {
      if (n.label !== "CallExpression") continue;
      const region = n.region ?? "";
      if (inThrowing(region)) continue;
      const innermost = region
        .split("/")
        .filter((seg) => /^L[^/]*\.b$/.test(seg))
        .at(-1);
      if (innermost === (loopId !== undefined ? `${loopId}.b` : undefined)) {
        this.value(n.outputs[0] as ValueId, env);
      }
    }
  }

  /** A condition (an ECMAScript expression over `names`) as a Bool term, with `names` bound. */
  condition(source: string, names: readonly string[], params: readonly Term[], ns: string): string {
    let graph: DucGraph;
    try {
      graph = liftAtom(`function __condition(${names.join(", ")}) { return (${source}); }`);
    } catch (e) {
      throw new Unsupported(
        "condition",
        `not an ECMAScript expression: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const gc = this.graphCtx(graph, params, false);
    if (gc.throwing.size > 0) throw new Unsupported("throw", "a condition that throws");
    const env: Env = { gc, ns, bind: new Map(), ctx: [] };
    return truthy(this.term(this.value(gc.g.obs[0] as ValueId, env), "a condition")).smt;
  }

  /** A fresh constant of a sort. A number is declared as its 64 bits, so a model gives them exactly. */
  freshConst(sort: Sort, hint: string): Term {
    const name = `${hint.replace(/[^\w]/g, "_")}_${this.fresh++}`;
    if (sort === "Bool") {
      this.decls.push(`(declare-const ${name} Bool)`);
      return { sort, smt: name };
    }
    this.decls.push(`(declare-const ${name} (_ BitVec 64))`);
    return { sort, smt: `((_ to_fp 11 53) ${name})` };
  }

  private graphCtx(graph: DucGraph, params: readonly Term[], isAtom: boolean): GraphCtx {
    const g = ecmaScriptView(graph);
    if (g.mode !== undefined) throw new Unsupported(g.mode, `an ${g.mode} function`);
    if (g.obs.length !== 1) {
      throw new Unsupported("observations", `${g.obs.length} observations; one result is required`);
    }
    const throwing = new Set(g.nodes.filter((n) => n.label === "throw").map((n) => n.region ?? ""));
    if (throwing.has(""))
      throw new Unsupported("throw", "a throw outside every branch: never returns");
    const inThrowing = (region: string | undefined): boolean =>
      region !== undefined && [...throwing].some((t) => region === t || region.startsWith(`${t}/`));
    const defOf = new Map<ValueId, DucNode>();
    for (const n of g.nodes) for (const v of n.outputs) defOf.set(v, n);
    // Effects: refused anywhere but in a region that throws. Checked over every node, not only the
    // ones the result reads: a call whose result is unused still runs. A member read must be of one
    // of Math's exact functions; a call must call one, or a callee supplied by link.
    const isMath = (v: ValueId | undefined): boolean => {
      const d = v !== undefined ? defOf.get(v)?.diamond : undefined;
      return d?.reason === "platform-primitive" && d.symbol === "Math";
    };
    for (const n of g.nodes) {
      if (inThrowing(n.region)) continue;
      if (n.closure !== undefined) throw new Unsupported("closure", "a closure");
      if (n.kind === "loop" && (n.loop?.iterate !== undefined || n.loop?.cond === undefined)) {
        throw new Unsupported("for-of", "a loop over an iterable");
      }
      const label = n.label ?? "";
      if (n.kind === "op" && label.startsWith(".")) {
        if (!isMath(n.inputs[0]) || !MATH_EXACT.has(label.slice(1))) {
          throw new Unsupported(
            label,
            `the member read ${label}: only Math's exact functions are read`,
          );
        }
        continue;
      }
      if (n.kind === "op" && label === "CallExpression") {
        const callee = defOf.get(n.inputs[0] as ValueId);
        const mathFn =
          callee?.kind === "op" &&
          callee.label?.startsWith(".") === true &&
          isMath(callee.inputs[0]);
        const linked = callee?.diamond !== undefined && this.linkKey(callee.diamond) !== undefined;
        if (!mathFn && !linked) {
          const what = callee?.diamond?.symbol ?? callee?.label ?? "a computed function";
          throw new Unsupported(
            "call",
            `a call of ${what}: neither an exact Math function nor a supplied callee`,
          );
        }
        continue;
      }
      if (n.order === 1 || n.label === "heap") {
        throw new Unsupported(label || n.kind, `${label || n.kind}: an effect`);
      }
    }
    const branches = new Map((g.branches ?? []).map((b) => [b.id, b] as const));
    const loopIndex = new Map(
      g.nodes.filter((n) => n.kind === "loop").map((n, i) => [n.id, i] as const),
    );
    return { g, defOf, branches, throwing, loopIndex, params, isAtom };
  }

  private term(v: Value, what: string): Term {
    if (v.sort === "Undef") throw new Unsupported("undefined", `${what} may be undefined`);
    if (v.sort === "Fn") throw new Unsupported("function", `${what} is a function`);
    return v;
  }

  /** The condition that the path to a region is taken, in an environment. */
  private path(region: string | undefined, env: Env): string {
    if (region === undefined || region === "") return "true";
    const conds: string[] = [];
    for (const seg of region.split("/")) {
      const m = /^(.+)\.(t|e)$/.exec(seg);
      const b = m !== null ? env.gc.branches.get(m[1] as string) : undefined;
      if (m === null || b === undefined) continue; // a loop body: its environment is the context
      const c = truthy(this.term(this.value(b.cond, env), "a branch condition")).smt;
      conds.push(m[2] === "t" ? c : `(not ${c})`);
    }
    return and(conds);
  }

  private value(v: ValueId, env: Env): Value {
    const bound = env.bind.get(v);
    if (bound !== undefined) return bound;
    const key = `${env.ns}:${v}`;
    const done = this.memo.get(key);
    if (done !== undefined) return done;
    const n = env.gc.defOf.get(v);
    if (n === undefined) throw new Unsupported("dangling", `value ${v} has no definition`);
    const result = this.node(n, v, env);
    if (
      result.sort === "Undef" ||
      result.sort === "Fn" ||
      n.kind === "param-source" ||
      n.kind === "literal-source" ||
      n.kind === "diamond-source" ||
      n.kind === "loop"
    ) {
      this.memo.set(key, result);
      return result;
    }
    const name = `${env.ns}_${v}`;
    this.defs.push(`(define-fun ${name} () ${smtSort(result.sort)} ${result.smt})`);
    const named: Term = { sort: result.sort, smt: name };
    this.memo.set(key, named);
    return named;
  }

  private node(n: DucNode, v: ValueId, env: Env): Value {
    switch (n.kind) {
      case "param-source": {
        const index = Number(n.label);
        const p = Number.isInteger(index) ? env.gc.params[index] : undefined;
        if (p === undefined) throw new Unsupported("parameter", `parameter ${n.label ?? "?"}`);
        return p;
      }
      case "literal-source":
        return n.label === "undefined" ? { sort: "Undef" } : literal(n.label ?? "");
      case "diamond-source":
        return this.reference(n);
      case "carry-source":
        throw new Unsupported("carry", `a carried value ${v} outside its loop`);
      case "sel":
        return this.select(n, env);
      case "loop": {
        const outputs = this.loop(n, env);
        const i = n.outputs.indexOf(v);
        return outputs[i] as Term;
      }
      case "op":
        return this.op(n, env);
      default:
        throw new Unsupported(n.kind, `a ${n.kind} node`);
    }
  }

  private reference(n: DucNode): Value {
    const d = n.diamond;
    if (d === undefined) throw new Unsupported("reference", "a reference without a label");
    if (d.reason === "platform-primitive") {
      const value = PLATFORM_NUMBERS[d.symbol];
      if (value !== undefined) return f64Literal(value);
      if (d.symbol === "Math") return { sort: "Fn", fn: { kind: "math", name: "" } };
    }
    const key = this.linkKey(d);
    if (key !== undefined) return { sort: "Fn", fn: { kind: "link", key, symbol: d.symbol } };
    throw new Unsupported(d.symbol, `a reference to ${d.symbol} (${d.reason})`);
  }

  /** The key a reference's callee is supplied under: its link's spec, `<module>#<symbol>`, or its symbol. */
  private linkKey(d: NonNullable<DucNode["diamond"]>): string | undefined {
    if (d.reason !== "unlinked-reference" && d.reason !== "free-identifier") return undefined;
    const keys = [d.spec, d.module !== undefined ? `${d.module}#${d.symbol}` : undefined, d.symbol];
    return keys.find((k) => k !== undefined && this.callees[k] !== undefined);
  }

  private select(n: DucNode, env: Env): Value {
    if (n.label !== undefined || n.inputs.length !== 3) {
      throw new Unsupported("sel", `a select labelled ${n.label ?? "?"}`);
    }
    const [cv, tv, ev] = n.inputs as [ValueId, ValueId, ValueId];
    // A side whose region throws is never the value of a normal return: the other side is.
    const branch = [...env.gc.branches.entries()].find(
      ([, b]) => b.cond === cv && (b.within ?? "") === (n.region ?? ""),
    );
    const side = (s: "t" | "e"): string | undefined =>
      branch === undefined
        ? undefined
        : `${n.region !== undefined ? `${n.region}/` : ""}${branch[0]}.${s}`;
    const thenThrows = env.gc.throwing.has(side("t") ?? "\0");
    const elseThrows = env.gc.throwing.has(side("e") ?? "\0");
    if (thenThrows && !elseThrows) return this.value(ev, env);
    if (elseThrows && !thenThrows) return this.value(tv, env);
    const c = truthy(this.term(this.value(cv, env), "a condition"));
    const t = this.term(this.value(tv, env), "a branch's value");
    const e = this.term(this.value(ev, env), "a branch's value");
    if (t.sort !== e.sort) {
      throw new Unsupported("union", "a select whose two values have different types");
    }
    return { sort: t.sort, smt: `(ite ${c.smt} ${t.smt} ${e.smt})` };
  }

  private op(n: DucNode, env: Env): Value {
    const label = n.label ?? "";
    const operands = n.order === 1 ? n.inputs.slice(0, -1) : n.inputs;
    if (label.startsWith(".") && n.order === 1) {
      // A read of one of Math's functions (checked in graphCtx).
      const name = label.slice(1);
      if (!MATH_EXACT.has(name)) throw new Unsupported(`Math.${name}`, `Math.${name}: not exact`);
      return { sort: "Fn", fn: { kind: "math", name } };
    }
    if (label.startsWith(".")) {
      const target = this.value(operands[0] as ValueId, env);
      if (target.sort === "Fn" && target.fn.kind === "math" && target.fn.name === "") {
        const name = label.slice(1);
        if (!MATH_EXACT.has(name)) throw new Unsupported(`Math.${name}`, `Math.${name}: not exact`);
        return { sort: "Fn", fn: { kind: "math", name } };
      }
      throw new Unsupported(label, `the member read ${label}`);
    }
    if (label === "CallExpression") {
      const callee = this.value(operands[0] as ValueId, env);
      if (callee.sort !== "Fn")
        throw new Unsupported("call", "a call of a value that is not a known function");
      const args = operands.slice(1).map((a) => this.term(this.value(a, env), "an argument"));
      if (callee.fn.kind === "math") return mathCall(callee.fn.name, args);
      return this.linkedCall(callee.fn.key, callee.fn.symbol, args, n, env);
    }
    if (n.order === 1) throw new Unsupported(label, `${label}: an effect`);
    return operation(
      label,
      operands.map((a) => this.term(this.value(a, env), `an operand of ${label}`)),
    );
  }

  private linkedCall(
    key: string,
    symbol: string,
    args: readonly Term[],
    n: DucNode,
    env: Env,
  ): Term {
    const callee = this.callees[key] as Callee;
    const c = callee.contract;
    const sorts = c.inputs.map((p) => sortOf(p.type, `${symbol}'s parameter ${p.name}`));
    const resultSort = sortOf(c.outputs[0]?.type ?? "", `${symbol}'s result`);
    if (args.length !== sorts.length || args.some((a, i) => a.sort !== sorts[i])) {
      throw new Unsupported(
        "call",
        `a call of ${symbol} whose arguments do not match its contract`,
      );
    }
    this.calleesUsed.set(key, { symbol, callee });
    const site = this.calls++;
    const guard = and([...env.ctx, this.path(n.region, env)]);
    const names = c.inputs.map((p) => p.name);
    for (const [k, pre] of c.preconditions.entries()) {
      const holds = this.condition(pre, names, args, `call${site}_pre${k}`);
      this.obligations.push({
        id: `call_${symbol}_${site}_pre_${k}`,
        kind: "call-precondition",
        condition: `${symbol}: ${pre}`,
        goal: `(=> ${guard} ${holds})`,
        facts: this.facts.length,
        show: [],
      });
    }
    const result = this.freshConst(resultSort, `${symbol}_result`);
    if (callee.proven) {
      const posts = c.postconditions.map((post, k) =>
        this.condition(post, [...names, "result"], [...args, result], `call${site}_post${k}`),
      );
      this.facts.push(`(=> ${guard} ${and(posts)})`);
      this.abstractions.push(`call of ${symbol} (by its proven contract)`);
    } else {
      this.abstractions.push(`call of ${symbol} (unproven: its result is unconstrained)`);
    }
    return result;
  }

  private loop(n: DucNode, env: Env): readonly Term[] {
    const key = `${env.ns}:${n.id}`;
    const done = this.loopMemo.get(key);
    if (done !== undefined) return done;
    const rec = n.loop;
    if (rec === undefined || rec.cond === undefined)
      throw new Unsupported("loop", "a loop without a condition");
    const k = rec.carry.length;
    const init = n.inputs.slice(0, k).map((v) => this.term(this.value(v, env), "a carried value"));
    const outer = n.inputs.slice(k).map((v) => this.value(v, env));
    const index = env.gc.loopIndex.get(n.id) ?? 0;
    const invariants = env.gc.isAtom ? (this.contract.loopInvariants?.[index] ?? []) : [];
    const paramNames = this.contract.inputs.map((p) => p.name);
    const carried = carriedNames(n, env.gc.defOf, paramNames);
    const ctx = [...env.ctx, this.path(n.region, env)];
    const tag = `${env.ns}_L${index}`;

    const inv = (terms: readonly Term[], ns: string): string =>
      and(
        invariants.map((s, j) =>
          this.condition(
            s,
            [...paramNames, ...carried],
            [...this.paramTerms, ...terms],
            `${ns}_inv${j}`,
          ),
        ),
      );
    const body = (terms: readonly Term[], ns: string, extra: readonly string[]): Env => {
      const bind = new Map<ValueId, Term>(env.bind);
      rec.carry.forEach((v, i) => bind.set(v, terms[i] as Term));
      rec.invariant.forEach((v, j) => {
        const o = outer[j];
        if (o !== undefined && o.sort !== "Undef" && o.sort !== "Fn") bind.set(v, o);
        else
          throw new Unsupported(
            "loop",
            "a loop that reads a value that is not a number or a boolean",
          );
      });
      return { gc: env.gc, ns, bind, ctx: [...ctx, ...extra] };
    };

    if (invariants.length > 0) {
      this.obligations.push({
        id: `loop_${index}_entry`,
        kind: "loop-entry",
        condition: `loop ${index} invariant on entry: ${invariants.join(" && ")}`,
        goal: `(=> ${and(ctx)} ${inv(init, `${tag}_entry`)})`,
        facts: this.facts.length,
        show: [],
      });
    }
    // Preservation, from an arbitrary state that satisfies the invariant.
    const c = init.map((t, i) => this.freshConst(t.sort, `${tag}_${carried[i]}`));
    const invC = inv(c, `${tag}_pre`);
    const pe = body(c, `${tag}_pass`, [invC]);
    const cond = truthy(this.term(this.value(rec.cond, pe), "a loop condition")).smt;
    const next = rec.next.map((v, i) => {
      const t = this.term(this.value(v, pe), "a carried value");
      if (t.sort !== init[i]?.sort)
        throw new Unsupported("loop", "a carried value that changes type");
      return t;
    });
    this.touchCalls(pe, rec.id);
    if (invariants.length > 0) {
      this.obligations.push({
        id: `loop_${index}_preserve`,
        kind: "loop-preserve",
        condition: `loop ${index} invariant preserved by a pass: ${invariants.join(" && ")}`,
        goal: `(=> ${and([...ctx, invC, cond])} ${inv(next, `${tag}_post`)})`,
        facts: this.facts.length,
        show: c.map((t, i) => ({ name: carried[i] as string, smt: t.smt, sort: t.sort })),
      });
    }
    // The exit: an arbitrary state that satisfies the invariant and not the condition.
    const e = init.map((t, i) => this.freshConst(t.sort, `${tag}_exit_${carried[i]}`));
    const invE = inv(e, `${tag}_exit`);
    const xe = body(e, `${tag}_exitpass`, [invE]);
    const condE = truthy(this.term(this.value(rec.cond, xe), "a loop condition")).smt;
    this.facts.push(`(=> ${and(ctx)} ${and([invE, `(not ${condE})`])})`);
    this.abstractions.push(
      `loop ${index} (by ${invariants.length > 0 ? "its invariants" : "no invariant"})`,
    );
    this.loopMemo.set(key, e);
    return e;
  }
}

const SORT_OF_TYPE: Readonly<Record<string, Sort>> = { number: "F64", boolean: "Bool" };

/** The sort of a contract type: `number` or `boolean`; anything else is unsupported. */
export function sortOf(type: string, what: string): Sort {
  const sort = SORT_OF_TYPE[type.trim()];
  if (sort === undefined) throw new Unsupported(type, `${what}: the type ${type || "(none)"}`);
  return sort;
}
