// SPDX-License-Identifier: Apache-2.0
/**
 * L2 verification of one atom against its contract (#1421).
 *
 * @decision DEC-VERIFY-L2-OUTCOMES-001
 * title: one outcome per obligation; L2 only when every obligation is proven
 * status: decided (#1421)
 * rationale:
 *   Each postcondition is one obligation, `pre ∧ ¬post(result)`, with one of five outcomes:
 *   proven (unsat), disproven (sat, with a counterexample that execution confirms), unknown,
 *   timeout, or unsupported (a construct the encoder cannot model exactly, named). An atom is L2
 *   only when it has at least one obligation and all are proven, and its preconditions are
 *   satisfiable: no obligations is "not a proof", and unsatisfiable preconditions make every
 *   proof vacuous (both after Eidic's verifier). A counterexample the reference lowering does not
 *   reproduce is an encoder bug, reported as unknown, never as disproven.
 *
 *   Conditions are ECMAScript expressions over the parameters (and `result`), lifted by the same
 *   lifter as the atom, so a condition means what the graph's operations mean.
 */
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type DucGraph, emitTypeScript, liftAtom } from "@yakcc/duc";
import {
  type Sort,
  type Term,
  Unsupported,
  encodeGraph,
  f64FromBits,
  smtSort,
  truthy,
} from "./encode.js";
import { type SolverAnswer, check, solverVersion } from "./solver.js";

/** The encoder's version: part of every record, since a query's meaning depends on it. */
export const ENCODER_VERSION = "verify-l2/1";

/** The part of a contract L2 reads: the typed signature and the conditions. */
export interface L2Contract {
  readonly inputs: readonly { readonly name: string; readonly type: string }[];
  readonly outputs: readonly { readonly type: string }[];
  readonly preconditions: readonly string[];
  readonly postconditions: readonly string[];
}

export interface L2Options {
  /** Per obligation, in milliseconds. Default 5000. */
  readonly timeoutMs?: number;
  /** Z3's resource limit per obligation (solver work, not time). Default: none (0). */
  readonly rlimit?: number;
}

export type Outcome = "proven" | "disproven" | "unknown" | "timeout" | "unsupported";

/** One input of a counterexample. A number carries its bits, since NaN and -0 do not survive JSON. */
export interface CounterexampleInput {
  readonly name: string;
  readonly value: number | boolean;
  /** For a number: its binary64 bits, 16 hex digits. */
  readonly bits?: string;
  /** How ECMAScript prints it (`NaN`, `-0`, `Infinity`, `1e+308`). */
  readonly text: string;
}

export interface Obligation {
  /** `post_<i>`, in the contract's order. */
  readonly id: string;
  readonly condition: string;
  readonly outcome: Outcome;
  /** Why, for every outcome but proven. */
  readonly reason?: string;
  readonly counterexample?: readonly CounterexampleInput[];
  /** The atom's result on the counterexample, as ECMAScript prints it. */
  readonly counterexampleResult?: string;
  /** The SMT-LIB2 query, absent when the obligation could not be encoded. */
  readonly query?: string;
  /** BLAKE3 of the query text, hex. */
  readonly queryHash?: string;
}

export type Verdict =
  /** At least one obligation, all proven, and the preconditions are satisfiable. */
  | "proven"
  /** Some obligation is not proven. */
  | "not-proven"
  /** No postconditions: nothing was checked. Not a proof. */
  | "no-obligations"
  /** The preconditions are unsatisfiable, so every proof is vacuous. Not a proof. */
  | "vacuous";

export interface L2Report {
  readonly verdict: Verdict;
  readonly obligations: readonly Obligation[];
  /** Whether the preconditions have a model: `unknown` when the solver could not tell. */
  readonly preconditionsSatisfiable: "yes" | "no" | "unknown" | "not-checked";
  readonly encoder: string;
  readonly solver: string;
  readonly budgets: { readonly timeoutMs: number; readonly rlimit: number };
}

const SORT_OF_TYPE: Readonly<Record<string, Sort>> = { number: "F64", boolean: "Bool" };

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
  const base = { encoder: ENCODER_VERSION, solver: await solverVersion(), budgets };
  const unsupportedAll = (reason: string): L2Report => ({
    ...base,
    verdict: contract.postconditions.length === 0 ? "no-obligations" : "not-proven",
    preconditionsSatisfiable: "not-checked",
    obligations: contract.postconditions.map((condition, i) => ({
      id: `post_${i}`,
      condition,
      outcome: "unsupported",
      reason,
    })),
  });

  // The signature: every parameter and the result must have a sort.
  const names = contract.inputs.map((p) => p.name);
  const sorts: Sort[] = [];
  for (const p of contract.inputs) {
    const sort = SORT_OF_TYPE[p.type.trim()];
    if (sort === undefined) return unsupportedAll(`parameter ${p.name}: the type ${p.type}`);
    sorts.push(sort);
  }
  const outType = contract.outputs[0]?.type.trim();
  const resultSort = outType === undefined ? undefined : SORT_OF_TYPE[outType];
  if (resultSort === undefined || contract.outputs.length !== 1) {
    return unsupportedAll(`the result type ${outType ?? "(none)"}`);
  }
  if (names.includes("result") || new Set(names).size !== names.length) {
    return unsupportedAll("parameter names must be distinct and not `result`");
  }

  const params: Term[] = sorts.map((sort, i) => paramTerm(sort, i));
  const declarations = sorts.map((sort, i) =>
    sort === "F64" ? `(declare-const p${i} (_ BitVec 64))` : `(declare-const p${i} Bool)`,
  );

  // The atom.
  let implGraph: DucGraph;
  let impl: ReturnType<typeof encodeGraph>;
  try {
    implGraph = typeof atom === "string" ? liftAtom(atom) : atom;
    impl = encodeGraph(implGraph, "impl", params);
  } catch (e) {
    return unsupportedAll(`the atom: ${describe(e)}`);
  }
  if (impl.result.sort !== resultSort) {
    return unsupportedAll(`the atom returns ${impl.result.sort}, the contract says ${outType}`);
  }
  const resultTerm: Term = { sort: resultSort, smt: "result" };
  const resultDef = `(define-fun result () ${smtSort(resultSort)} ${impl.result.smt})`;

  // The preconditions, shared by every obligation.
  const pres: { defs: readonly string[]; holds: string; graph: DucGraph }[] = [];
  for (const [i, condition] of contract.preconditions.entries()) {
    try {
      pres.push(encodeCondition(condition, names, params, `pre${i}`));
    } catch (e) {
      return unsupportedAll(`precondition ${i} (${condition}): ${describe(e)}`);
    }
  }

  const header = [
    `; yakcc L2 obligation, ${ENCODER_VERSION}`,
    "(set-option :produce-models true)",
    `(set-option :timeout ${budgets.timeoutMs})`,
    `(set-option :rlimit ${budgets.rlimit})`,
    ...declarations,
    ...impl.defs,
    resultDef,
    ...pres.flatMap((p) => [...p.defs, `(assert ${p.holds})`]),
  ];
  const modelOf = sorts.map((_, i) => `p${i}`);

  // Are the preconditions satisfiable at all?
  let preconditionsSatisfiable: L2Report["preconditionsSatisfiable"] = "not-checked";
  if (pres.length > 0) {
    const answer = await check([...header, "(check-sat)"].join("\n"), []);
    preconditionsSatisfiable =
      answer.status === "sat" ? "yes" : answer.status === "unsat" ? "no" : "unknown";
  } else {
    preconditionsSatisfiable = "yes";
  }

  const obligations: Obligation[] = [];
  for (const [i, condition] of contract.postconditions.entries()) {
    const id = `post_${i}`;
    let post: ReturnType<typeof encodeCondition>;
    try {
      post = encodeCondition(condition, [...names, "result"], [...params, resultTerm], `post${i}`);
    } catch (e) {
      obligations.push({ id, condition, outcome: "unsupported", reason: describe(e) });
      continue;
    }
    const query = [...header, ...post.defs, `(assert (not ${post.holds}))`, "(check-sat)", ""].join(
      "\n",
    );
    const queryHash = bytesToHex(blake3(new TextEncoder().encode(query)));
    const answer = await check(query, modelOf);
    obligations.push({
      id,
      condition,
      query,
      queryHash,
      ...judge(answer, { names, sorts, implGraph, pres: pres.map((p) => p.graph), post }),
    });
  }

  const verdict: Verdict =
    obligations.length === 0
      ? "no-obligations"
      : preconditionsSatisfiable === "no"
        ? "vacuous"
        : obligations.every((o) => o.outcome === "proven") && preconditionsSatisfiable === "yes"
          ? "proven"
          : "not-proven";
  return { ...base, verdict, obligations, preconditionsSatisfiable };
}

function paramTerm(sort: Sort, i: number): Term {
  return sort === "F64" ? { sort, smt: `((_ to_fp 11 53) p${i})` } : { sort, smt: `p${i}` };
}

/** A condition, lifted as a function of `names` and encoded with them bound to `params`. */
function encodeCondition(
  condition: string,
  names: readonly string[],
  params: readonly Term[],
  ns: string,
): { defs: readonly string[]; holds: string; graph: DucGraph } {
  let graph: DucGraph;
  try {
    graph = liftAtom(`function __condition(${names.join(", ")}) { return (${condition}); }`);
  } catch (e) {
    throw new Unsupported("condition", `not an ECMAScript expression: ${describe(e)}`);
  }
  const encoded = encodeGraph(graph, ns, params);
  return { defs: encoded.defs, holds: truthy(encoded.result).smt, graph };
}

interface ReplayInputs {
  readonly names: readonly string[];
  readonly sorts: readonly Sort[];
  readonly implGraph: DucGraph;
  readonly pres: readonly DucGraph[];
  readonly post: { readonly graph: DucGraph };
}

function judge(
  answer: SolverAnswer,
  replay: ReplayInputs,
): Pick<Obligation, "outcome" | "reason" | "counterexample" | "counterexampleResult"> {
  if (answer.status === "unsat") return { outcome: "proven" };
  if (answer.status === "unknown") {
    const timedOut = /timeout|canceled|resource limit|rlimit/i.test(answer.reason);
    return { outcome: timedOut ? "timeout" : "unknown", reason: answer.reason };
  }
  const counterexample = parseModel(answer.values, replay.names, replay.sorts);
  if (counterexample === undefined) {
    return { outcome: "unknown", reason: `unreadable model: ${answer.values.trim()}` };
  }
  // The model is a claim; the reference lowering must reproduce it.
  const args = counterexample.map((c) => c.value);
  try {
    const result = run(replay.implGraph, args);
    const presHold = replay.pres.every((g) => Boolean(run(g, args)));
    const postHolds = Boolean(run(replay.post.graph, [...args, result]));
    if (!presHold || postHolds) {
      return {
        outcome: "unknown",
        reason: `the solver's counterexample does not reproduce on the reference lowering (preconditions ${presHold ? "hold" : "fail"}, postcondition ${postHolds ? "holds" : "fails"}): an encoder bug`,
        counterexample,
        counterexampleResult: show(result),
      };
    }
    return { outcome: "disproven", counterexample, counterexampleResult: show(result) };
  } catch (e) {
    return {
      outcome: "unknown",
      reason: `the counterexample could not be replayed: ${describe(e)}`,
      counterexample,
    };
  }
}

/** Runs a graph through the reference lowering (`emitTypeScript`), which is plain ECMAScript here. */
function run(graph: DucGraph, args: readonly unknown[]): unknown {
  const source = emitTypeScript(graph, undefined, { name: "f" }).replace(/^export\s+/m, "");
  const f = new Function(`${source}\nreturn f;`)() as (...a: unknown[]) => unknown;
  return f(...args);
}

function parseModel(
  values: string,
  names: readonly string[],
  sorts: readonly Sort[],
): CounterexampleInput[] | undefined {
  const out: CounterexampleInput[] = [];
  for (const [i, sort] of sorts.entries()) {
    const m = new RegExp(`\\(p${i}\\s+(#x[0-9a-fA-F]{16}|true|false)\\)`).exec(values);
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

function show(v: unknown): string {
  return Object.is(v, -0) ? "-0" : String(v);
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
