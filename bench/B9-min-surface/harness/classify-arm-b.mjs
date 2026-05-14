// SPDX-License-Identifier: MIT
//
// bench/B9-min-surface/harness/classify-arm-b.mjs
//
// @decision DEC-V0-MIN-SURFACE-005
// @title Arm B symmetric REFUSED-EARLY classifier
// @status accepted
// @rationale
//   SYMMETRIC CLASSIFIER MOTIVATION
//   Axis 2 measures REFUSED-EARLY rate across both arms. The Arm A classifier
//   (DEC-V0-MIN-SURFACE-001 in measure-axis2.mjs) is the primary claim: yakcc's
//   atomic emit refuses adversarial inputs at the type-shape boundary before any
//   atom body executes. Arm B (LLM baseline) has no atomic decomposition, but we
//   apply the same REFUSED-EARLY definition symmetrically so the per-arm comparison
//   is on equal footing.
//
//   ARM B REFUSED-EARLY DEFINITION (symmetric with DEC-V0-MIN-SURFACE-001):
//   An adversarial fuzz input is classified REFUSED-EARLY for Arm B iff:
//   - The entry function throws a type-shape error (TypeError, SyntaxError, RangeError,
//     or Error whose .name matches /Shape|Type|Range|Syntax/).
//   - The error is thrown "early" — before the main parsing body executes.
//
//   PRACTICAL DEFINITION FOR SLICE 1:
//   Since Arm B has no atomic decomposition, "early" means: the throw happens
//   before any iteration of the main parsing logic. In practice, this is indistinguishable
//   from the full Arm A definition in Slice 1 (we use the same type-shape error check).
//   A more rigorous definition (e.g., via V8 Inspector profiling) is deferred to Slice 2.
//
//   SHAPE-ESCAPE (Arm B):
//   A shape-escape occurs when an adversarial input with expected_outcome=REFUSED-EARLY
//   returns normally (no throw) from the Arm B entry function. This is especially
//   significant for Arm B: LLM emits often use JSON.parse internally, which accepts
//   many "adversarial" inputs that the spec would reject (e.g., prototype pollution,
//   NaN injection). A shape-escape in Arm B is filed as a correctness finding.
//
//   COMPARISON CONTEXT (for the paired-differential headline per #446 Gap 6):
//   The Arm B REFUSED-EARLY rate is compared against the Arm A rate to produce:
//   "At granularity X, atom-composed emit increases REFUSED-EARLY rate by Z pp vs LLM baseline."
//   A positive Z means yakcc's atomic emit refuses more adversarial inputs early.
//   A negative Z (Arm B refuses more) would be a surprising finding filed as a bug WI.
//
//   LIMITATIONS:
//   The LLM baseline is non-deterministic (N=3 reps per task per DEC-V0-MIN-SURFACE-003).
//   Arm B REFUSED-EARLY rate is the median over N=3 reps for each input.
//   Range is recorded alongside the median.
//
//   Cross-references:
//   DEC-V0-MIN-SURFACE-001 (Arm A classifier) — harness/measure-axis2.mjs
//   DEC-V0-MIN-SURFACE-003 (Arm B prompt) — harness/llm-baseline.mjs
//   DEC-BENCH-B9-SLICE1-001 (verdict) — harness/run.mjs
//
// Usage:
//   import { classifyArmBResult, computeArmBRefusalSummary } from './classify-arm-b.mjs';
//
//   // classifyArmBResult: classify a single (emitPath, attackClasses, entryFn) run
//   // computeArmBRefusalSummary: aggregate N=3 reps into median + range

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Type-shape error classifier (identical to DEC-V0-MIN-SURFACE-001 for symmetry)
// ---------------------------------------------------------------------------

const TYPE_SHAPE_PATTERN = /Shape|Type|Range|Syntax/;

export function isTypeShapeError(err) {
  if (!(err instanceof Error)) return false;
  if (err instanceof TypeError || err instanceof SyntaxError || err instanceof RangeError) return true;
  if (TYPE_SHAPE_PATTERN.test(err.name)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Classify a single arm B invocation result
// Per DEC-V0-MIN-SURFACE-005 (symmetric with DEC-V0-MIN-SURFACE-001)
// ---------------------------------------------------------------------------

/**
 * Classify the result of calling an Arm B emit on one adversarial input.
 *
 * @param {{ threw: boolean, thrownError: Error|null, returnValue: any }} invokeResult
 * @param {"REFUSED-EARLY"|"BENIGN-PASS"|"CONTAINED-EXCEPTION"} expectedOutcome
 * @returns {"refused-early"|"shape-escape"|"benign-pass"|"unexpected-refusal"|"executed"|"contained-exception"}
 */
export function classifyArmBResult(invokeResult, expectedOutcome) {
  const { threw, thrownError } = invokeResult;

  if (!threw) {
    if (expectedOutcome === "REFUSED-EARLY") return "shape-escape";
    return "benign-pass";
  }

  if (isTypeShapeError(thrownError)) {
    if (expectedOutcome === "REFUSED-EARLY") return "refused-early";
    if (expectedOutcome === "BENIGN-PASS") return "unexpected-refusal";
    if (expectedOutcome === "CONTAINED-EXCEPTION") return "contained-exception";
    return "refused-early";
  }

  if (expectedOutcome === "REFUSED-EARLY") return "executed";
  if (expectedOutcome === "CONTAINED-EXCEPTION") return "contained-exception";
  return "executed";
}

// ---------------------------------------------------------------------------
// Load attack classes
// ---------------------------------------------------------------------------

export function loadAttackClasses(attackDir) {
  if (!existsSync(attackDir)) throw new Error(`attack-classes dir not found: ${attackDir}`);
  const jsonFiles = readdirSync(attackDir).filter(f => f.endsWith(".json"));
  return jsonFiles.sort().map(f => JSON.parse(readFileSync(resolve(attackDir, f), "utf8")));
}

// ---------------------------------------------------------------------------
// Run Arm B classification on a single emit (one rep)
// ---------------------------------------------------------------------------

/**
 * Classify a single Arm B emit against all attack classes.
 *
 * @param {string} emitPath
 * @param {Array<{attack_class_id: string, inputs: Array<{label:string,payload:string,expected_outcome:string}>}>} attackClasses
 * @param {string} entryFuncName
 * @param {string[]|null} [applicableClasses] - array of applicable attack_class_id values,
 *   or null/undefined to apply all classes. Per DEC-B9-APPLICABILITY-001.
 */
export async function classifyArmBEmit(emitPath, attackClasses, entryFuncName, applicableClasses) {
  let loadPath = emitPath;
  if (!existsSync(loadPath)) throw new Error(`Emit not found: ${loadPath}`);

  const mod = await import(pathToFileURL(loadPath).href);
  const entryFn = mod[entryFuncName] ?? mod.default?.[entryFuncName];

  if (typeof entryFn !== "function") {
    throw new Error(`Entry function '${entryFuncName}' not found in ${loadPath}. Available: ${Object.keys(mod).join(", ")}`);
  }

  // Build a fast lookup set; null means "all applicable"
  const applicableSet = (applicableClasses != null) ? new Set(applicableClasses) : null;

  const byClass = {};
  let totalAll = 0, refusedEarlyAll = 0, executedAll = 0, shapeEscapesAll = 0, notApplicableAll = 0;

  for (const attackClass of attackClasses) {
    const classId = attackClass.attack_class_id;
    const isApplicable = applicableSet === null || applicableSet.has(classId);
    const classResult = { total: 0, refused_early: 0, executed: 0, contained_exception: 0, benign_pass: 0, unexpected_refusal: 0, shape_escapes: 0, not_applicable: 0, applicable: isApplicable, inputs: [] };

    for (const input of attackClass.inputs) {
      classResult.total++;
      totalAll++;

      if (!isApplicable) {
        classResult.not_applicable++;
        notApplicableAll++;
        classResult.inputs.push({
          label: input.label,
          expected_outcome: input.expected_outcome,
          classification: "not-applicable",
          threw: null,
          error_type: null,
          error_message: null,
        });
        continue;
      }

      let threw = false, thrownError = null, returnValue;
      try {
        returnValue = entryFn(input.payload);
      } catch (err) {
        threw = true;
        thrownError = err;
      }

      const invokeResult = { threw, thrownError, returnValue };
      const classification = classifyArmBResult(invokeResult, input.expected_outcome);

      switch (classification) {
        case "refused-early": classResult.refused_early++; refusedEarlyAll++; break;
        case "executed": classResult.executed++; executedAll++; break;
        case "contained-exception": classResult.contained_exception++; break;
        case "benign-pass": classResult.benign_pass++; break;
        case "unexpected-refusal": classResult.unexpected_refusal++; break;
        case "shape-escape": classResult.shape_escapes++; shapeEscapesAll++; break;
      }

      classResult.inputs.push({
        label: input.label,
        expected_outcome: input.expected_outcome,
        classification,
        threw,
        error_type: thrownError ? (thrownError.constructor?.name ?? "Error") : null,
        error_message: thrownError?.message?.slice(0, 200) ?? null,
      });
    }

    byClass[classId] = classResult;
  }

  // Only count applicable inputs toward refused_early_targets
  const refusedEarlyTargets = Object.values(byClass).reduce(
    (acc, c) => acc + c.inputs.filter(i => i.expected_outcome === "REFUSED-EARLY" && i.classification !== "not-applicable").length, 0
  );

  return {
    by_class: byClass,
    summary: {
      total_inputs: totalAll,
      not_applicable: notApplicableAll,
      refused_early_targets: refusedEarlyTargets,
      refused_early: refusedEarlyAll,
      executed: executedAll,
      shape_escapes: shapeEscapesAll,
      refused_early_rate: refusedEarlyTargets > 0 ? (refusedEarlyAll / refusedEarlyTargets) * 100 : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Aggregate N=3 reps into median + range (per DEC-V0-MIN-SURFACE-003 N-reps)
// ---------------------------------------------------------------------------

/**
 * Given N classification results (one per rep), compute the aggregate summary
 * with median refused_early_rate and range across reps.
 *
 * @param {Array<{summary: {refused_early_rate: number, shape_escapes: number, refused_early: number, total_inputs: number}}>} reps
 * @returns {{ median_refused_early_rate: number, range: [number, number], shape_escapes_any_rep: number, reps: number }}
 */
export function computeArmBRefusalSummary(reps) {
  if (!reps || reps.length === 0) throw new Error("No reps provided");

  const rates = reps.map(r => r.summary.refused_early_rate).sort((a, b) => a - b);
  const mid = Math.floor(rates.length / 2);
  const median = rates.length % 2 === 0 ? (rates[mid - 1] + rates[mid]) / 2 : rates[mid];

  const maxShapeEscapes = Math.max(...reps.map(r => r.summary.shape_escapes));

  return {
    n_reps: reps.length,
    median_refused_early_rate: median,
    refused_early_rate_range: [rates[0], rates[rates.length - 1]],
    shape_escapes_any_rep: maxShapeEscapes,
    per_rep_rates: rates,
    note: `N=${reps.length} reps; directional target only — no KILL pre-data per #167 Principle 1`,
  };
}

export default { classifyArmBEmit, computeArmBRefusalSummary, classifyArmBResult, loadAttackClasses };
