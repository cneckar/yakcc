// SPDX-License-Identifier: Apache-2.0
/**
 * L2 verification of one atom against its contract (#1421).
 *
 * @decision DEC-VERIFY-L2-OUTCOMES-001
 * title: one outcome per obligation; L2 only when every obligation is proven
 * status: decided (#1421)
 * rationale:
 *   Each postcondition is one obligation, `pre ∧ no-throw ∧ facts ⇒ post(result)`; each loop adds
 *   an entry and a preservation obligation for its invariants, and each call through a link one per
 *   callee precondition. Every obligation has one of five outcomes: proven (unsat), disproven (sat,
 *   with a counterexample), unknown, timeout, or unsupported (a construct the encoder cannot model
 *   exactly, named). An atom is L2 only when it has at least one postcondition, every obligation is
 *   proven, and its preconditions are satisfiable: no postconditions is "not a proof", and
 *   unsatisfiable preconditions make every proof vacuous (both after Eidic's verifier).
 *
 *   A postcondition's counterexample is replayed on the reference lowering (`emitTypeScript`). One
 *   that does not reproduce is reported unknown, never disproven: with no loop or call in the atom it
 *   is an encoder bug; with one, the loop's invariants or the callee's contract are too weak to
 *   decide. A loop's or a call's obligation is about a state the solver chose (an arbitrary pass of
 *   a loop, a call's arguments), so its counterexample is shown, not replayed.
 *
 *   Conditions are ECMAScript expressions over the parameters (and `result`), lifted by the same
 *   lifter as the atom, so a condition means what the graph's operations mean.
 */
import { runInNewContext } from "node:vm";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type DucGraph, emitTypeScript, liftAtom } from "@yakcc/duc";
import { Encoder, type GoalObligation, sortOf } from "./encoder.js";
import { type SolverAnswer, check, solverVersion } from "./solver.js";
import { PRELUDE, type Sort, type Term, Unsupported, f64FromBits, smtSort } from "./terms.js";
import type { Callee, L2Contract } from "./types.js";

/** The encoder's version: part of every record, since a query's meaning depends on it. */
export const ENCODER_VERSION = "verify-l2/3";

export interface L2Options {
  /** Per obligation, in milliseconds. Default 5000. */
  readonly timeoutMs?: number;
  /** Z3's resource limit per obligation (solver work, not time). Default: none (0). */
  readonly rlimit?: number;
  /**
   * Callees the atom calls through links (#1421 slice 4), by link key: the reference's `spec` when
   * linked, else `<module>#<symbol>`, else the symbol.
   */
  readonly callees?: Readonly<Record<string, Callee>>;
  /** How long a replay may run, in milliseconds. Default 1000. */
  readonly replayTimeoutMs?: number;
}

export type Outcome = "proven" | "disproven" | "unknown" | "timeout" | "unsupported";

/** One value of a counterexample. A number carries its bits, since NaN and -0 do not survive JSON. */
export interface CounterexampleInput {
  readonly name: string;
  readonly value: number | boolean;
  /** For a number: its binary64 bits, 16 hex digits. */
  readonly bits?: string;
  /** How ECMAScript prints it (`NaN`, `-0`, `Infinity`, `1e+308`). */
  readonly text: string;
}

export type ObligationKind = "postcondition" | GoalObligation["kind"];

export interface Obligation {
  /** `post_<i>`, `loop_<i>_entry`, `loop_<i>_preserve`, `call_<symbol>_<n>_pre_<k>`. */
  readonly id: string;
  readonly kind: ObligationKind;
  readonly condition: string;
  readonly outcome: Outcome;
  /** Why, for every outcome but proven. */
  readonly reason?: string;
  readonly counterexample?: readonly CounterexampleInput[];
  /** Whether running the atom reproduced the counterexample (postconditions only). */
  readonly confirmed?: boolean;
  /** The atom's result on the counterexample, as ECMAScript prints it. */
  readonly counterexampleResult?: string;
  /** The SMT-LIB2 query, absent when the obligation could not be encoded. */
  readonly query?: string;
  /** BLAKE3 of the query text, hex. */
  readonly queryHash?: string;
}

export type Verdict =
  /** At least one postcondition, every obligation proven, and satisfiable preconditions. */
  | "proven"
  /** Some obligation is not proven. */
  | "not-proven"
  /** No postconditions: nothing was claimed. Not a proof. */
  | "no-obligations"
  /** The preconditions are unsatisfiable, so every proof is vacuous. Not a proof. */
  | "vacuous";

/** Whether a `throw` of the atom can be reached by inputs that meet the preconditions. */
export interface ThrowReport {
  readonly region: string;
  readonly text: string;
  readonly reachable: "yes" | "no" | "unknown";
  /** For `yes`: inputs that reach it. */
  readonly example?: readonly CounterexampleInput[];
}

export interface L2Report {
  readonly verdict: Verdict;
  readonly obligations: readonly Obligation[];
  /** Whether the preconditions have a model: `unknown` when the solver could not tell. */
  readonly preconditionsSatisfiable: "yes" | "no" | "unknown" | "not-checked";
  /** Every throw site: postconditions hold on normal returns only, so these say when there is none. */
  readonly throws: readonly ThrowReport[];
  /** The loops and calls replaced by their invariants or contracts. */
  readonly abstractions: readonly string[];
  /** The callees assumed, with the roots their proofs are for. */
  readonly callees: readonly {
    readonly key: string;
    readonly proven: boolean;
    readonly root?: string;
  }[];
  readonly encoder: string;
  readonly solver: string;
  readonly budgets: { readonly timeoutMs: number; readonly rlimit: number };
}

/**
 * Verifies an atom (its source or its graph) against a contract. Resolves to a report; throws only
 * on a solver error, which is a bug in this package, never on an atom it cannot handle.
 */
export async function verifyL2(
  atom: string | DucGraph,
  contract: L2Contract,
  options: L2Options = {},
): Promise<L2Report> {
  const budgets = { timeoutMs: options.timeoutMs ?? 5000, rlimit: options.rlimit ?? 0 };
  const replayTimeoutMs = options.replayTimeoutMs ?? 1000;
  const base = {
    encoder: ENCODER_VERSION,
    solver: await solverVersion(),
    budgets,
    throws: [],
    abstractions: [],
    callees: [],
  };
  const unsupportedAll = (reason: string): L2Report => ({
    ...base,
    verdict: contract.postconditions.length === 0 ? "no-obligations" : "not-proven",
    preconditionsSatisfiable: "not-checked",
    obligations: contract.postconditions.map((condition, i) => ({
      id: `post_${i}`,
      kind: "postcondition",
      condition,
      outcome: "unsupported",
      reason,
    })),
  });

  // The signature: every parameter and the result must have a sort.
  const names = contract.inputs.map((p) => p.name);
  let sorts: Sort[];
  let resultSort: Sort;
  try {
    sorts = contract.inputs.map((p) => sortOf(p.type, `parameter ${p.name}`));
    if (contract.outputs.length !== 1) throw new Unsupported("result", "one result is required");
    resultSort = sortOf(contract.outputs[0]?.type ?? "", "the result");
  } catch (e) {
    return unsupportedAll(describe(e));
  }
  if (names.includes("result") || new Set(names).size !== names.length) {
    return unsupportedAll("parameter names must be distinct and not `result`");
  }

  const params: Term[] = sorts.map((sort, i) =>
    sort === "F64" ? { sort, smt: `((_ to_fp 11 53) p${i})` } : { sort, smt: `p${i}` },
  );
  const declarations = sorts.map((sort, i) =>
    sort === "F64" ? `(declare-const p${i} (_ BitVec 64))` : `(declare-const p${i} Bool)`,
  );
  const enc = new Encoder(contract, params, options.callees ?? {});

  // The atom.
  let implGraph: DucGraph;
  let result: Term;
  try {
    implGraph = typeof atom === "string" ? liftAtom(atom) : atom;
    result = enc.atom(implGraph);
  } catch (e) {
    return unsupportedAll(`the atom: ${describe(e)}`);
  }
  if (result.sort !== resultSort) {
    return unsupportedAll(
      `the atom returns ${result.sort}, the contract says ${contract.outputs[0]?.type}`,
    );
  }
  const resultDef = `(define-fun result () ${smtSort(resultSort)} ${result.smt})`;

  // The preconditions, assumed by every obligation.
  const pres: string[] = [];
  for (const [i, condition] of contract.preconditions.entries()) {
    try {
      pres.push(enc.condition(condition, names, params, `pre${i}`));
    } catch (e) {
      return unsupportedAll(`precondition ${i} (${condition}): ${describe(e)}`);
    }
  }
  // The postconditions; an unsupported one is reported, the others still checked. Their
  // definitions read `result`, so they come after its definition in a query.
  const beforePosts = enc.defs.length;
  const posts: ({ holds: string } | { error: string })[] = contract.postconditions.map(
    (condition, i) => {
      try {
        const holds = enc.condition(
          condition,
          [...names, "result"],
          [...params, { sort: resultSort, smt: "result" }],
          `post${i}`,
        );
        return { holds };
      } catch (e) {
        return { error: describe(e) };
      }
    },
  );

  const modelOf = sorts.map((_, i) => `p${i}`);
  const query = (assumptions: readonly string[], facts: number, goal: string | undefined): string =>
    [
      `; yakcc L2 obligation, ${ENCODER_VERSION}`,
      "(set-option :produce-models true)",
      `(set-option :timeout ${budgets.timeoutMs})`,
      `(set-option :rlimit ${budgets.rlimit})`,
      ...PRELUDE,
      ...declarations,
      ...enc.decls,
      ...enc.defs.slice(0, beforePosts),
      resultDef,
      ...enc.defs.slice(beforePosts),
      ...enc.facts.slice(0, facts).map((f) => `(assert ${f})`),
      ...pres.map((p) => `(assert ${p})`),
      ...assumptions.map((a) => `(assert ${a})`),
      ...(goal !== undefined ? [`(assert (not ${goal}))`] : []),
      "(check-sat)",
      "",
    ].join("\n");
  const hash = (q: string): string => bytesToHex(blake3(new TextEncoder().encode(q)));

  // Are the preconditions satisfiable at all?
  let preconditionsSatisfiable: L2Report["preconditionsSatisfiable"] = "yes";
  if (pres.length > 0) {
    const answer = await check(query([], 0, undefined), []);
    preconditionsSatisfiable =
      answer.status === "sat" ? "yes" : answer.status === "unsat" ? "no" : "unknown";
  }

  const replay: ReplayInputs = {
    names,
    sorts,
    implGraph,
    contract,
    calleesUsed: enc.calleesUsed,
    abstracted: enc.abstractions.length > 0,
    timeoutMs: replayTimeoutMs,
  };
  const noThrow = enc.throws.map((t) => `(not ${t.path})`);
  const obligations: Obligation[] = [];
  for (const [i, condition] of contract.postconditions.entries()) {
    const id = `post_${i}`;
    const post = posts[i];
    if (post === undefined || "error" in post) {
      obligations.push({
        id,
        kind: "postcondition",
        condition,
        outcome: "unsupported",
        reason: post !== undefined && "error" in post ? post.error : "missing",
      });
      continue;
    }
    const q = query(noThrow, enc.facts.length, post.holds);
    const answer = await check(q, modelOf);
    obligations.push({
      id,
      kind: "postcondition",
      condition,
      query: q,
      queryHash: hash(q),
      ...(await judgePost(answer, replay, i)),
    });
  }
  for (const o of enc.obligations) {
    const q = query([], o.facts, o.goal);
    const answer = await check(q, [...modelOf, ...o.show.map((s) => bareName(s.smt))]);
    obligations.push({
      id: o.id,
      kind: o.kind,
      condition: o.condition,
      query: q,
      queryHash: hash(q),
      ...judgeGoal(answer, names, sorts, o),
    });
  }

  // Where a throw can be reached: information, not an obligation.
  const throws: ThrowReport[] = [];
  for (const t of enc.throws) {
    const answer = await check(query([t.path], enc.facts.length, undefined), modelOf);
    if (answer.status === "sat") {
      const example = parseValues(answer.values, names, sorts, modelOf);
      throws.push({
        region: t.region,
        text: t.text,
        reachable: "yes",
        ...(example ? { example } : {}),
      });
    } else {
      throws.push({
        region: t.region,
        text: t.text,
        reachable: answer.status === "unsat" ? "no" : "unknown",
      });
    }
  }

  const hasPosts = contract.postconditions.length > 0;
  const verdict: Verdict = !hasPosts
    ? "no-obligations"
    : preconditionsSatisfiable === "no"
      ? "vacuous"
      : obligations.every((o) => o.outcome === "proven") && preconditionsSatisfiable === "yes"
        ? "proven"
        : "not-proven";
  return {
    ...base,
    verdict,
    obligations,
    preconditionsSatisfiable,
    throws,
    abstractions: enc.abstractions,
    callees: [...enc.calleesUsed.entries()].map(([key, { callee }]) => ({
      key,
      proven: callee.proven,
      ...(callee.root !== undefined ? { root: callee.root } : {}),
    })),
  };
}

interface ReplayInputs {
  readonly names: readonly string[];
  readonly sorts: readonly Sort[];
  readonly implGraph: DucGraph;
  readonly contract: L2Contract;
  readonly calleesUsed: ReadonlyMap<string, { symbol: string; callee: Callee }>;
  readonly abstracted: boolean;
  readonly timeoutMs: number;
}

type Judgement = Pick<
  Obligation,
  "outcome" | "reason" | "counterexample" | "counterexampleResult" | "confirmed"
>;

function unknownOrTimeout(answer: { reason: string }): Judgement {
  const timedOut = /timeout|canceled|resource limit|rlimit/i.test(answer.reason);
  return { outcome: timedOut ? "timeout" : "unknown", reason: answer.reason };
}

async function judgePost(answer: SolverAnswer, r: ReplayInputs, index: number): Promise<Judgement> {
  if (answer.status === "unsat") return { outcome: "proven" };
  if (answer.status === "unknown") return unknownOrTimeout(answer);
  const counterexample = parseValues(
    answer.values,
    r.names,
    r.sorts,
    r.sorts.map((_, i) => `p${i}`),
  );
  if (counterexample === undefined) {
    return { outcome: "unknown", reason: `unreadable model: ${answer.values.trim()}` };
  }
  const args = counterexample.slice(0, r.names.length).map((c) => c.value);
  const notReproduced = (why: string, result?: unknown): Judgement => ({
    outcome: "unknown",
    reason: r.abstracted
      ? `the counterexample does not reproduce (${why}): a loop's invariants or a callee's contract are too weak to decide`
      : `the counterexample does not reproduce on the reference lowering (${why}): an encoder bug`,
    counterexample,
    confirmed: false,
    ...(result !== undefined ? { counterexampleResult: show(result) } : {}),
  });
  let replayed: { result: unknown; presHold: boolean; postHolds: boolean };
  try {
    replayed = replayPost(r, args, index);
  } catch (e) {
    return notReproduced(`the replay failed: ${describe(e)}`);
  }
  if (!replayed.presHold) return notReproduced("the preconditions fail", replayed.result);
  if (replayed.postHolds) return notReproduced("the postcondition holds", replayed.result);
  return {
    outcome: "disproven",
    counterexample,
    confirmed: true,
    counterexampleResult: show(replayed.result),
  };
}

function judgeGoal(
  answer: SolverAnswer,
  names: readonly string[],
  sorts: readonly Sort[],
  o: GoalObligation,
): Judgement {
  if (answer.status === "unsat") return { outcome: "proven" };
  if (answer.status === "unknown") return unknownOrTimeout(answer);
  const counterexample = parseValues(
    answer.values,
    [...names, ...o.show.map((s) => s.name)],
    [...sorts, ...o.show.map((s) => s.sort)],
    [...sorts.map((_, i) => `p${i}`), ...o.show.map((s) => s.smt)],
  );
  const reason =
    o.kind === "loop-entry"
      ? "the invariant does not hold when the loop is entered"
      : o.kind === "loop-preserve"
        ? "the invariant is not inductive: a pass from a state that satisfies it can leave it"
        : "the callee's precondition can fail at this call";
  return { outcome: "disproven", reason, ...(counterexample ? { counterexample } : {}) };
}

/**
 * Runs the atom and its conditions on the counterexample, in a fresh context with a time limit
 * (a counterexample may not terminate a loop). Callees are defined from their sources.
 */
function replayPost(
  r: ReplayInputs,
  args: readonly (number | boolean)[],
  index: number,
): { result: unknown; presHold: boolean; postHolds: boolean } {
  const fn = (graph: DucGraph, name: string): string =>
    emitTypeScript(graph, undefined, { name })
      .split("\n")
      .filter((l) => !l.startsWith("import "))
      .join("\n")
      .replace(/^export\s+/m, "");
  const callees = [...r.calleesUsed.values()].map(({ symbol, callee }) => {
    if (callee.source === undefined) throw new Error(`no source for ${symbol}`);
    return fn(liftAtom(callee.source), symbol);
  });
  const cond = (source: string, names: readonly string[], name: string): string =>
    fn(liftAtom(`function __c(${names.join(", ")}) { return (${source}); }`), name);
  const pres = r.contract.preconditions.map((p, i) => cond(p, r.names, `__pre${i}`));
  const post = cond(r.contract.postconditions[index] as string, [...r.names, "result"], "__post");
  const code = [
    ...callees,
    fn(r.implGraph, "__atom"),
    ...pres,
    post,
    "const __result = __atom(...__args);",
    `const __presHold = [${pres.map((_, i) => `__pre${i}`).join(", ")}].every((p) => Boolean(p(...__args)));`,
    "({ result: __result, presHold: __presHold, postHolds: Boolean(__post(...__args, __result)) });",
  ].join("\n");
  return runInNewContext(code, { __args: args }, { timeout: r.timeoutMs }) as {
    result: unknown;
    presHold: boolean;
    postHolds: boolean;
  };
}

/** Values from a `(get-value …)` answer: bit vectors as binary64, booleans as they are. */
function parseValues(
  values: string,
  names: readonly string[],
  sorts: readonly Sort[],
  smts: readonly string[],
): CounterexampleInput[] | undefined {
  const out: CounterexampleInput[] = [];
  for (const [i, sort] of sorts.entries()) {
    const smt = bareName(smts[i] as string);
    const escaped = smt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`\\(${escaped}\\s+(#x[0-9a-fA-F]{16}|true|false)\\)`).exec(values);
    if (m === null) return undefined;
    const raw = m[1] as string;
    const name = names[i] as string;
    if (sort === "Bool") {
      out.push({ name, value: raw === "true", text: raw });
    } else {
      const bits = raw.slice(2).toLowerCase();
      const value = f64FromBits(bits);
      out.push({ name, value, bits, text: show(value) });
    }
  }
  return out;
}

/** A fresh number is asked for through its bit-vector constant: `((_ to_fp 11 53) name)` → `name`. */
function bareName(smt: string): string {
  return smt.replace(/^\(\(_ to_fp 11 53\) (\S+)\)$/, "$1");
}

function show(v: unknown): string {
  return Object.is(v, -0) ? "-0" : String(v);
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
