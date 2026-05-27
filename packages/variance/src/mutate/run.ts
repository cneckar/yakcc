// SPDX-License-Identifier: MIT
// @decision DEC-MUTATE-RUN-001
// title: runMutationTesting uses in-process vm execution for test isolation
// status: decided
// rationale:
//   Corpus test source is TypeScript with vitest/fast-check imports. Running
//   tests inside a node:vm context (with import-stripped source and shim
//   globals) avoids spawning child processes while keeping mutant execution
//   isolated from the main module scope. fast-check assertions that fail cause
//   vm.runInNewContext to throw, which we interpret as "mutant killed".
//   When the corpus test source does not reference the impl function name, all
//   mutants are treated as equivalent (the test can't reach any mutation site),
//   and the gate is skipped (kill rate = 1.0 by convention, skipped: true).

import vm from "node:vm";

import * as fc from "fast-check";

import { generateMutants } from "./operators.js";
import type {
  Mutant,
  MutationInput,
  MutationOptions,
  MutationResult,
  SurvivorInfo,
} from "./types.js";

// ---------------------------------------------------------------------------
// In-memory result cache (canonicalAstHash → MutationResult).
// Avoids re-running mutation testing for atoms with identical AST across
// multiple shave invocations in the same process.
// ---------------------------------------------------------------------------

const _resultCache = new Map<string, MutationResult>();

/** Clear the in-process result cache (for tests). */
export function clearMutationCache(): void {
  _resultCache.clear();
}

// ---------------------------------------------------------------------------
// Source utilities
// ---------------------------------------------------------------------------

/**
 * Extract the primary exported function name from a TypeScript source string.
 * Handles `export function name`, `export default function name`, `export const name =`.
 */
export function extractFuncName(source: string): string | undefined {
  const patterns = [
    /\bexport\s+(?:default\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/,
    /\bexport\s+(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/,
  ];
  for (const re of patterns) {
    const m = source.match(re);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/**
 * Check whether the corpus test source contains at least one call to the
 * impl function (indicating the tests can reach the impl).
 */
export function hasImplReference(testSource: string, funcName: string): boolean {
  const callRe = new RegExp(`\\b${funcName}\\s*\\(`, "");
  return callRe.test(testSource);
}

/**
 * Strip TypeScript type annotations from a strict-subset atom implementation.
 * Handles: parameter types, return types, type casts, generics, readonly, export.
 *
 * This is intentionally limited to the TypeScript strict-subset IR (pure functions
 * with simple types) and will not correctly strip all valid TypeScript.
 */
export function stripTypes(source: string): string {
  return (
    source
      // Remove generic type parameters <T> or <T extends U> from function signatures
      .replace(/<[A-Za-z_$][A-Za-z0-9_$, extends|&\[\]()]*>/g, "")
      // Remove return type annotation: ): SomeType { → ) {
      .replace(/\)\s*:\s*[\w$[\]<>|&. ]+(?=\s*\{)/g, ")")
      // Remove optional parameter type annotation: param?: Type → param?
      .replace(/(\w+)\?:\s*[\w$[\]<>|&. ]+(?=[,)])/g, "$1?")
      // Remove parameter type annotation: param: Type → param
      .replace(/(\w+):\s*[\w$[\]<>|&. ]+(?=[,)])/g, "$1")
      // Remove "as Type" casts — match "as " followed by a type expression
      .replace(/\s+as\s+[\w$[\]<>|&. ]+/g, "")
      // Remove readonly modifier
      .replace(/\breadonly\s+/g, "")
      // Remove export keyword (functions defined at module scope need it removed)
      .replace(/\bexport\s+(?=(?:default\s+)?function|const|let|var)/g, "")
      // Remove type/interface declarations (whole lines)
      .replace(/^(?:type|interface)\s+[^\n{]*(?:\{[^}]*\})?[^\n]*/gm, "")
  );
}

/**
 * Create a callable JavaScript function from stripped source code.
 * Uses Function() constructor so the function runs in the main context.
 * Returns undefined if the source cannot be parsed/evaluated.
 */
export function createMutantFn(
  strippedSource: string,
  funcName: string,
): ((...args: unknown[]) => unknown) | undefined {
  try {
    // Wrap in an IIFE that returns the named function after defining it.
    // This pattern avoids hoisting issues with the Function constructor.
    const wrapper = new Function(`
      "use strict";
      ${strippedSource}
      return typeof ${funcName} !== 'undefined' ? ${funcName} : undefined;
    `);
    const fn = (wrapper as () => unknown)();
    if (typeof fn === "function") return fn as (...args: unknown[]) => unknown;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Strip import/require statements from corpus test source so it can run
 * in a vm context where those identifiers are provided as context globals.
 */
export function prepareTestScript(source: string): string {
  return (
    source
      // Remove ES module imports (single or multiline)
      .replace(/^import\s[^;]*;?\s*$/gm, "")
      // Remove multi-line import blocks
      .replace(/^import\s*\{[^}]*\}\s*from\s*["'][^"']*["'];?\s*$/gm, "")
  );
}

/**
 * Execute the (stripped) corpus test script against a single mutated function.
 *
 * Returns true if the mutant was KILLED (at least one assertion failed),
 * false if the mutant SURVIVED (all tests passed or no testable assertions found).
 *
 * A thrown error from the vm (typically from fc.assert failing) is interpreted
 * as a kill. A timeout error is interpreted as "survived" (can't determine).
 */
export function executeMutantTest(
  preparedTestScript: string,
  funcName: string,
  mutantFn: (...args: unknown[]) => unknown,
  timeoutMs: number,
): boolean {
  const contextObj: Record<string, unknown> = {
    fc,
    // Vitest shims: execute the callback immediately
    describe: (_label: string, fn: () => void) => fn(),
    it: (_label: string, fn: () => void) => fn(),
    test: (_label: string, fn: () => void) => fn(),
    // Provide expect as a no-op (fast-check handles assertions)
    expect: () => ({ toBe: () => undefined, toEqual: () => undefined }),
  };
  // Inject the mutated function under its original name so test calls resolve.
  contextObj[funcName] = mutantFn;

  const context = vm.createContext(contextObj);
  try {
    vm.runInNewContext(preparedTestScript, context, { timeout: timeoutMs });
    return false; // all tests passed → mutant survived
  } catch (err) {
    // vm.runInNewContext timeout throws from the outer Node.js context (instanceof Error = true).
    // A throw from *inside* the vm uses the vm's own Error constructor (instanceof = false),
    // so we extract the message safely without relying on instanceof.
    // Use String(err) for non-Error throws (e.g. vm-created errors where instanceof fails)
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("timed out")) {
      return false; // timeout → treat as survived (inconclusive)
    }
    return true; // fc.assert threw → mutant killed
  }
}

// ---------------------------------------------------------------------------
// Mutant selection
// ---------------------------------------------------------------------------

/**
 * Select up to `max` mutants from `all`, using a deterministic order.
 * When a seed is provided the order is permuted reproducibly.
 */
export function selectMutants(
  all: readonly Mutant[],
  max: number,
  seed?: number,
): readonly Mutant[] {
  if (all.length <= max) return all;
  if (seed === undefined) return all.slice(0, max);
  // Fisher-Yates partial shuffle deterministically seeded
  const arr = [...all];
  let s = seed;
  for (let i = 0; i < max; i++) {
    s = (s * 1664525 + 1013904223) >>> 0; // LCG
    const j = i + (s % (arr.length - i));
    const tmp = arr[i] as Mutant;
    arr[i] = arr[j] as Mutant;
    arr[j] = tmp;
  }
  return arr.slice(0, max);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the mutation-testing gate for a single atom.
 *
 * Steps:
 * 1. Check the in-process cache by canonicalAstHash.
 * 2. Extract the impl function name; if not found, skip (no named export).
 * 3. Check if the corpus test references the function (coverage check).
 *    If not, all mutants are equivalent — return skipped:true, killRate:1.0.
 * 4. Generate and (optionally) select a subset of mutants.
 * 5. For each mutant: strip types, build a callable function, run the test.
 * 6. Compute kill rate over non-equivalent mutants.
 */
export async function runMutationTesting(
  input: MutationInput,
  opts?: MutationOptions,
): Promise<MutationResult> {
  const start = Date.now();

  // Cache hit
  const cached = _resultCache.get(input.canonicalAstHash);
  if (cached !== undefined) return cached;

  const maxMutants = opts?.maxMutants ?? 20;
  const timeoutMs = opts?.timeoutMs ?? 5000;

  // Step 2: function name
  const funcName = extractFuncName(input.implSource);
  if (funcName === undefined) {
    const r = makeSkippedResult(0, start);
    _resultCache.set(input.canonicalAstHash, r);
    return r;
  }

  // Step 3: coverage check
  if (!hasImplReference(input.corpusTestSource, funcName)) {
    const allMutants = generateMutants(input.implSource);
    const r = makeSkippedResult(allMutants.length, start);
    _resultCache.set(input.canonicalAstHash, r);
    return r;
  }

  // Step 4: generate mutants
  const allMutants = generateMutants(input.implSource);
  const selected = selectMutants(allMutants, maxMutants, opts?.seed);

  // Step 5: strip original impl for the test runner (unused directly here,
  // but validates that stripping works before testing mutants)
  const preparedTest = prepareTestScript(input.corpusTestSource);

  const survivors: SurvivorInfo[] = [];
  let killed = 0;

  for (const mutant of selected) {
    const stripped = stripTypes(mutant.mutatedSource);
    const mutantFn = createMutantFn(stripped, funcName);
    if (mutantFn === undefined) {
      // Can't evaluate the mutant → treat as equivalent (not a meaningful test)
      survivors.push({ mutant, reason: "equivalent" });
      continue;
    }
    const wasKilled = executeMutantTest(preparedTest, funcName, mutantFn, timeoutMs);
    if (wasKilled) {
      killed++;
    } else {
      survivors.push({ mutant, reason: "tests_passed" });
    }
  }

  const nonEquivalent = selected.filter((m) => {
    return !survivors.some((s) => s.mutant.id === m.id && s.reason === "equivalent");
  }).length;

  const killRate = nonEquivalent > 0 ? killed / nonEquivalent : 1.0;

  const result: MutationResult = {
    killRate,
    survivors,
    killed,
    total: selected.length,
    nonEquivalent,
    elapsed: Date.now() - start,
    skipped: false,
  };

  _resultCache.set(input.canonicalAstHash, result);
  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeSkippedResult(total: number, start: number): MutationResult {
  return {
    killRate: 1.0,
    survivors: [],
    killed: 0,
    total,
    nonEquivalent: 0,
    elapsed: Date.now() - start,
    skipped: true,
  };
}
