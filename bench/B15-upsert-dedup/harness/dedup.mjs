// SPDX-License-Identifier: MIT
// B15 core: the upsert check. Given a newly written function, find the stored definitions that
// behave the same, by running both on the same inputs, and say how they compare. No model calls,
// no network: the B12 vm sandbox runs both sides.
//
// Candidates come from two places: text (the new block's spec, searched against the library's
// descriptions; supplied by the caller) and behavior (the new function's outputs on the probe
// inputs and on its own examples, compared with every stored definition's). Each candidate is
// then verified on the union of the probe inputs, the new block's examples and the candidate's
// own examples, and given a verdict:
//   equivalent    agrees on every comparable input, with enough informative agreements
//   near          agrees on all of the new block's examples and on most other inputs; the
//                 inputs where they differ are reported (an edge-case difference to look at)
//   different     otherwise
//   inconclusive  too few informative comparisons to say (both return nothing useful)
// "Equivalent" is observed on finitely many inputs: evidence, not proof.
import vm from "node:vm";
import { transpile } from "../../B11-reuse-economics/harness/lib.mjs";
import { degenerate, probeArgs } from "../../B12-need-to-code/harness/cards.mjs";
import {
  CALL_TIMEOUT_MS,
  bareContext,
  callTagged,
  taggedEqual,
} from "../../B12-need-to-code/harness/sandbox.mjs";

/** Informative agreements needed before a verdict other than inconclusive. */
export const MIN_INFORMATIVE = 3;
/** Agreement on other inputs a "near" verdict needs. */
export const NEAR_AGREEMENT = 0.8;

/**
 * A callable for standalone code (a model-written function): transpiled, run in a bare
 * context, and the exported function picked (by name, else the first exported function).
 */
export function standaloneCallable(code, name = null) {
  let js;
  try {
    js = transpile(code);
  } catch (err) {
    return { callable: false, reason: `transpile: ${String(err.message).slice(0, 120)}` };
  }
  const context = bareContext();
  try {
    vm.runInContext(
      `(function(){ var module = { exports: {} }; var exports = module.exports; ${js}\n; globalThis.__exports = module.exports; })()`,
      context,
      { timeout: 2000 },
    );
  } catch (err) {
    return { callable: false, reason: `load: ${String(err.message).slice(0, 120)}` };
  }
  const exp = context.__exports ?? {};
  const fn =
    name && typeof exp[name] === "function"
      ? exp[name]
      : Object.values(exp).find((v) => typeof v === "function");
  if (typeof fn !== "function") return { callable: false, reason: "no exported function" };
  return { callable: true, context, fn, arity: fn.length };
}

/** Run a callable on each argument list (tagged JSON). */
export function runInputs(callable, inputs) {
  return inputs.map((args) => callTagged(callable, args));
}

const unusable = (r) => !r.ok && (r.error === "timeout" || r.error === "host");

/**
 * Compare two runs over the same inputs. Both throwing counts as agreement (not informative);
 * one throwing is a disagreement; a timeout on either side makes the input not comparable.
 */
export function compareRuns(inputs, a, b) {
  let comparable = 0;
  let agree = 0;
  let informative = 0;
  const outputs = new Set();
  const counterexamples = [];
  inputs.forEach((args, i) => {
    const x = a[i];
    const y = b[i];
    if (!x || !y || unusable(x) || unusable(y)) return;
    comparable++;
    if (!x.ok && !y.ok) {
      agree++;
      return;
    }
    if (x.ok && y.ok && taggedEqual(x.value, y.value)) {
      agree++;
      if (!degenerate(x.value)) {
        informative++;
        outputs.add(JSON.stringify(x.value));
      }
      return;
    }
    if (counterexamples.length < 3)
      counterexamples.push({
        args,
        a: x.ok ? x.value : { throws: x.error },
        b: y.ok ? y.value : { throws: y.error },
      });
  });
  return { comparable, agree, informative, distinct: outputs.size, counterexamples };
}

/**
 * The verdict for a comparison. `examples` is the comparison on the new block's own examples
 * (null when it has none).
 */
export function verdict(all, examples = null) {
  const weak = all.informative < MIN_INFORMATIVE || all.distinct < 2;
  if (all.agree === all.comparable) return weak ? "inconclusive" : "equivalent";
  const examplesHold = examples === null || examples.agree === examples.comparable;
  if (!weak && examplesHold && all.agree / all.comparable >= NEAR_AGREEMENT) return "near";
  return "different";
}

/** The tagged kind of a probe value. */
const kindOf = (v) =>
  Array.isArray(v)
    ? "array"
    : v && typeof v === "object"
      ? "$date" in v
        ? "date"
        : "object"
      : typeof v;

/** The kinds a declared parameter type admits, or null for any (unknown, generic, a union). */
export function kindsOf(type) {
  const t = String(type ?? "").trim();
  if (!t || /\bany\b|\bunknown\b|^[A-Z]$|^T\b/.test(t)) return null;
  // An array type (string[], [a, b][], Array<T>, readonly T[]) that is not a union: arrays only.
  if (!/\|/.test(t) && /(\[\]|^Array<.*>|^readonly .*|^\[.*\])$/.test(t)) return new Set(["array"]);
  const kinds = new Set();
  if (/\bstring\b|["'`]/.test(t)) kinds.add("string");
  if (/\bnumber\b|\bbigint\b/.test(t)) kinds.add("number");
  if (/\bboolean\b/.test(t)) kinds.add("boolean");
  if (/\[\]|\bArray\b|^\[|\breadonly\b/.test(t)) kinds.add("array");
  if (/\bDate\b/.test(t)) kinds.add("date");
  if (/^\{|\bRecord\b|\bobject\b|\bMap\b|\bSet\b/.test(t)) kinds.add("object");
  return kinds.size === 0 ? null : kinds;
}

/**
 * The probe inputs for a spec: probeArgs(arity), kept to the argument lists whose values fit
 * the declared parameter types. Two implementations of one spec may differ on inputs outside
 * it (a number passed where a string is declared); those differences are not the spec's.
 */
export function probeInputs(arity, paramTypes = []) {
  return probeArgs(arity).filter((args) => fitsTypes(args, paramTypes));
}

/** Whether an argument list fits the declared parameter types (unknown types admit anything). */
export function fitsTypes(args, paramTypes = []) {
  return args.every((v, i) => fitsType(v, paramTypes[i]));
}

/** Whether a value fits a declared type; for `T[]`, each element must fit T. */
export function fitsType(v, type) {
  const kinds = kindsOf(type);
  if (!kinds) return true;
  if (!kinds.has(kindOf(v))) return false;
  const t = String(type).trim();
  const elem = /^(?:readonly\s+)?(.+)\[\]$/.exec(t)?.[1] ?? /^Array<(.+)>$/.exec(t)?.[1];
  if (Array.isArray(v) && elem && !/\|/.test(t))
    return v.every((x) => fitsType(x, elem.replace(/^\((.*)\)$/, "$1")));
  return true;
}

/**
 * Microseconds per call of a callable over some inputs: the inputs are decoded once, then run
 * `reps` times inside the context; the median of five batches. Both sides of a comparison are
 * timed the same way, so the vm overhead cancels in a ratio.
 */
export function timeCalls(callable, inputs, reps = 50) {
  const { context, fn } = callable;
  context.__fn = fn;
  context.__argsJson = JSON.stringify(inputs);
  const batch = () => {
    const t0 = performance.now();
    vm.runInContext(
      `(function(){ var L = __dec(JSON.parse(__argsJson)); for (var r = 0; r < ${reps}; r++) for (var i = 0; i < L.length; i++) { try { __fn.apply(undefined, JSON.parse(JSON.stringify(L[i]))); } catch (e) {} } })()`,
      context,
      { timeout: CALL_TIMEOUT_MS * 20 },
    );
    return performance.now() - t0;
  };
  try {
    batch(); // warm up
    const ts = Array.from({ length: 5 }, batch).sort((a, b) => a - b);
    return (ts[2] * 1000) / (reps * Math.max(1, inputs.length));
  } catch {
    return null;
  }
}

/** Distinct argument lists, by JSON. */
export function uniqueInputs(lists) {
  const seen = new Set();
  const out = [];
  for (const args of lists) {
    const k = JSON.stringify(args);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(args);
    }
  }
  return out;
}

const VERDICT_ORDER = { equivalent: 0, near: 1, inconclusive: 2, different: 3 };

/**
 * The upsert check for one new function.
 *   newCallable    from standaloneCallable
 *   arity          the arity to probe at (the spec's parameter count)
 *   paramTypes     the spec's declared parameter types (strings), to keep probes in the spec
 *   newExamples    the new block's examples ([{ args }]), or []
 *   atoms          stored definitions: [{ id, card, callable, fingerprint }] where fingerprint is
 *                  runInputs(callable, probeInputs(arity, paramTypes)) (cache it: it does not
 *                  depend on the new function)
 *   textIds        candidate ids from text search, best first
 *   k              how many candidates to take from each source
 * Returns the behavioral ranking (ids), and the verified neighbors, best verdict first.
 */
export function upsertCheck({
  newCallable,
  arity,
  paramTypes = [],
  newExamples = [],
  atoms,
  textIds = [],
  k = 5,
}) {
  const probes = probeInputs(arity, paramTypes);
  const exampleArgs = newExamples.map((e) => e.args);
  const newProbe = runInputs(newCallable, probes);
  const newEx = runInputs(newCallable, exampleArgs);

  // Stage 1, behavior: score every stored definition by its agreement with the new function
  // on the probes (cached fingerprint) and on the new block's examples (run now).
  const scored = [];
  for (const a of atoms) {
    const p = compareRuns(probes, newProbe, a.fingerprint);
    const e = compareRuns(exampleArgs, newEx, runInputs(a.callable, exampleArgs));
    const informative = p.informative + e.informative;
    if (informative === 0) continue;
    const comparable = p.comparable + e.comparable;
    const agree = p.agree + e.agree;
    scored.push({ id: a.id, score: informative * (agree / Math.max(1, comparable)) ** 4 });
  }
  scored.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1));
  const behaviorIds = scored.map((s) => s.id);

  // Stage 2, verify the union of both sources on probes ∪ new examples ∪ candidate examples.
  const byId = new Map(atoms.map((a) => [a.id, a]));
  const ids = [...new Set([...behaviorIds.slice(0, k), ...textIds.slice(0, k)])].filter((id) =>
    byId.has(id),
  );
  const neighbors = ids.map((id) => {
    const a = byId.get(id);
    const inputs = uniqueInputs([
      ...probes,
      ...exampleArgs,
      ...(a.card.examples ?? []).map((e) => e.args).filter((args) => fitsTypes(args, paramTypes)),
    ]);
    const all = compareRuns(inputs, runInputs(newCallable, inputs), runInputs(a.callable, inputs));
    const ex =
      exampleArgs.length > 0
        ? compareRuns(exampleArgs, newEx, runInputs(a.callable, exampleArgs))
        : null;
    const v = verdict(all, ex);
    let timing = null;
    if (v === "equivalent" || v === "near") {
      const tNew = timeCalls(newCallable, inputs);
      const tOld = timeCalls(a.callable, inputs);
      timing = { newMicros: tNew, storedMicros: tOld, ratio: tNew && tOld ? tNew / tOld : null };
    }
    return {
      id,
      verdict: v,
      agree: all.agree,
      comparable: all.comparable,
      informative: all.informative,
      counterexamples: all.counterexamples,
      fromBehavior: behaviorIds.slice(0, k).includes(id),
      fromText: textIds.slice(0, k).includes(id),
      timing,
    };
  });
  neighbors.sort(
    (x, y) =>
      VERDICT_ORDER[x.verdict] - VERDICT_ORDER[y.verdict] ||
      y.agree / Math.max(1, y.comparable) - x.agree / Math.max(1, x.comparable),
  );
  return { behaviorIds, neighbors };
}
