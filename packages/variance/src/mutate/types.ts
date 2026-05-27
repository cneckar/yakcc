// SPDX-License-Identifier: MIT
// @decision DEC-MUTATE-TYPES-001
// title: MutationInput/Result types are isolated in types.ts (excluded from coverage)
// status: decided
// rationale: Separating types from logic keeps operators.ts and run.ts fully
//   testable without requiring cross-module imports for type-only constructs.

/** A single mutated variant of an atom's implementation. */
export interface Mutant {
  readonly id: number;
  /** The original source text (for diffing). */
  readonly originalSource: string;
  /** The mutated source text. */
  readonly mutatedSource: string;
  /** Which operator produced this mutation. */
  readonly operatorName: string;
  /** Human-readable description of the mutation (e.g. "replaced + with - at 3:12"). */
  readonly description: string;
  /** 1-based line number of the mutation site. */
  readonly line: number;
  /** 1-based column number of the mutation site. */
  readonly col: number;
}

/** Why a mutant was not killed. */
export type SurvivorReason =
  /** The corpus tests ran against the mutant and all passed. */
  | "tests_passed"
  /** The corpus tests do not reach the mutation site (equivalent mutant). */
  | "equivalent";

export interface SurvivorInfo {
  readonly mutant: Mutant;
  readonly reason: SurvivorReason;
}

/** Full result of a mutation-testing run for a single atom. */
export interface MutationResult {
  /** Fraction of non-equivalent mutants killed. Range [0, 1]. */
  readonly killRate: number;
  /** Mutants that were NOT killed (surviving or equivalent). */
  readonly survivors: readonly SurvivorInfo[];
  /** Count of mutants where at least one test failed. */
  readonly killed: number;
  /** Total mutants generated. */
  readonly total: number;
  /** Mutants that actually reached execution (non-equivalent). */
  readonly nonEquivalent: number;
  /** Wall-clock milliseconds for the entire run. */
  readonly elapsed: number;
  /**
   * True when the gate was skipped because no corpus tests can reach the impl
   * (all mutants are equivalent). Kill rate is 1.0 by convention in this case.
   */
  readonly skipped: boolean;
}

/** Inputs to runMutationTesting(). */
export interface MutationInput {
  /** TypeScript source of the atom's implementation. */
  readonly implSource: string;
  /** UTF-8 content of the corpus property-test file. */
  readonly corpusTestSource: string;
  /** BLAKE3 hex hash of the canonical AST — used as the cache key. */
  readonly canonicalAstHash: string;
  /** Optional atom name for diagnostic messages. */
  readonly atomName?: string | undefined;
}

/** Tuning options for the mutation-testing gate. */
export interface MutationOptions {
  /** Maximum number of mutants to generate and test. Default: 20. */
  readonly maxMutants?: number | undefined;
  /** Minimum fraction of non-equivalent mutants that must be killed. Default: 0.80. */
  readonly killRateThreshold?: number | undefined;
  /** Per-mutant test execution timeout in milliseconds. Default: 5000. */
  readonly timeoutMs?: number | undefined;
  /** Deterministic seed for mutant selection when truncating to maxMutants. */
  readonly seed?: number | undefined;
}
