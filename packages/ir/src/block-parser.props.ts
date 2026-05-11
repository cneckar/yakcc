// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-BLOCK-PARSER-001: hand-authored property-test corpus
// for @yakcc/ir block-parser.ts. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the harness.
// Status: accepted (WI-87-fill-ir)
// Rationale: parseBlockTriplet is disk-bound (readFileSync), so pure property
// generation is not applicable to the full API. Properties exercise observable
// invariants using the existing triplet fixtures: determinism, result-shape,
// composition detection, and merkle-root stability. The pure internal logic
// (isBlockImport pattern matching) is covered indirectly via composition output.

// ---------------------------------------------------------------------------
// Property-test corpus for block-parser.ts
//
// Public surface covered:
//   parseBlockTriplet (C1.1) — disk-bound block triplet parser
//
// Atoms:
//   C1.1a — result shape: all required fields are present and correctly typed
//   C1.1b — determinism: two consecutive calls produce structurally identical results
//   C1.1c — validation result is always a valid ValidationResult discriminated union
//   C1.1d — merkleRoot is a non-empty string (64-char hex) for valid triplets
//   C1.1e — specHashValue is a non-empty string for valid triplets
//   C1.1f — composition: detected sub-block refs always have required fields
//   C1.1g — isBlockImport: patterns matching @yakcc/seeds/ and @yakcc/blocks/ are detected
//   C1.1h — composition specHashRef is always null at parse time (L0 invariant)
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as fc from "fast-check";
import {
  type BlockTripletParseResult,
  type SubBlockRef,
  parseBlockTriplet,
} from "./block-parser.js";

// ---------------------------------------------------------------------------
// Fixture directory resolution
//
// These are the same fixtures used by block-parser.test.ts (EC-1 through EC-6).
// Properties run against real disk fixtures rather than generated directories
// because parseBlockTriplet is fundamentally disk-bound.
// ---------------------------------------------------------------------------

const FIXTURE_BASE = join(fileURLToPath(import.meta.url), "..", "__fixtures__", "triplets");

/** Three valid triplet directories — each covers a different spec shape. */
const VALID_TRIPLET_DIRS = [
  join(FIXTURE_BASE, "digit-of"),
  join(FIXTURE_BASE, "add-numbers"),
  join(FIXTURE_BASE, "all-whitespace"),
] as const;

/**
 * Arbitrary over the valid triplet fixture directories.
 * Properties that exercise parse results use this to cover all three fixtures.
 */
const validTripletDirArb: fc.Arbitrary<string> = fc.constantFrom(...VALID_TRIPLET_DIRS);

// ---------------------------------------------------------------------------
// C1.1a: Result shape — all required fields are present and correctly typed
// ---------------------------------------------------------------------------

/**
 * prop_parseBlockTriplet_result_shape
 *
 * For every valid triplet fixture, parseBlockTriplet returns a BlockTripletParseResult
 * with all required fields: spec, specHashValue, implSource, manifest, artifacts,
 * validation, triplet, merkleRoot, and composition.
 *
 * Invariant: the return statement in parseBlockTriplet always constructs a complete
 * BlockTripletParseResult; no field is absent or undefined except optional ones.
 */
export const prop_parseBlockTriplet_result_shape = fc.property(validTripletDirArb, (dir) => {
  const result: BlockTripletParseResult = parseBlockTriplet(dir);

  // spec must be an object with a name string
  if (typeof result.spec !== "object" || result.spec === null) return false;
  if (typeof result.spec.name !== "string" || result.spec.name.length === 0) return false;

  // specHashValue must be a non-empty string
  if (typeof result.specHashValue !== "string" || result.specHashValue.length === 0) return false;

  // implSource must be a string
  if (typeof result.implSource !== "string") return false;

  // manifest must be an object
  if (typeof result.manifest !== "object" || result.manifest === null) return false;

  // artifacts must be a Map
  if (!(result.artifacts instanceof Map)) return false;

  // validation must be a discriminated union
  if (typeof result.validation !== "object" || result.validation === null) return false;
  if (typeof result.validation.ok !== "boolean") return false;

  // triplet must be an object
  if (typeof result.triplet !== "object" || result.triplet === null) return false;

  // merkleRoot must be a non-empty string
  if (typeof result.merkleRoot !== "string" || result.merkleRoot.length === 0) return false;

  // composition must be an array
  if (!Array.isArray(result.composition)) return false;

  return true;
});

// ---------------------------------------------------------------------------
// C1.1b: Determinism — two consecutive calls produce structurally identical results
// ---------------------------------------------------------------------------

/**
 * prop_parseBlockTriplet_deterministic
 *
 * For any valid triplet fixture, two consecutive calls to parseBlockTriplet produce
 * results with identical specHashValue, merkleRoot, implSource, and validation shape.
 *
 * Invariant: parseBlockTriplet reads the same files each time; no shared mutable state
 * exists between calls. The function is deterministic with respect to observable outputs.
 */
export const prop_parseBlockTriplet_deterministic = fc.property(validTripletDirArb, (dir) => {
  const r1 = parseBlockTriplet(dir);
  const r2 = parseBlockTriplet(dir);

  // specHashValue must be identical (BLAKE3 is deterministic)
  if (r1.specHashValue !== r2.specHashValue) return false;

  // merkleRoot must be identical
  if (r1.merkleRoot !== r2.merkleRoot) return false;

  // implSource must be identical (same file content)
  if (r1.implSource !== r2.implSource) return false;

  // validation.ok must match
  if (r1.validation.ok !== r2.validation.ok) return false;

  // composition length must match
  if (r1.composition.length !== r2.composition.length) return false;

  return true;
});

// ---------------------------------------------------------------------------
// C1.1c: Validation result is always a valid ValidationResult discriminated union
// ---------------------------------------------------------------------------

/**
 * prop_parseBlockTriplet_validation_shape
 *
 * For every valid triplet fixture, result.validation is either { ok: true } or
 * { ok: false, errors: ReadonlyArray<ValidationError> }. It never throws, never
 * returns undefined, and never returns a partial result.
 *
 * Invariant: the strict-subset validator always returns a complete ValidationResult;
 * parseBlockTriplet surfaces it without transformation.
 */
export const prop_parseBlockTriplet_validation_shape = fc.property(validTripletDirArb, (dir) => {
  const result = parseBlockTriplet(dir);
  const v = result.validation;

  if (v === null || v === undefined) return false;
  if (typeof v.ok !== "boolean") return false;
  if (v.ok === false) {
    if (!Array.isArray(v.errors)) return false;
    for (const err of v.errors) {
      if (typeof err.rule !== "string" || err.rule.length === 0) return false;
      if (typeof err.message !== "string" || err.message.length === 0) return false;
    }
  }
  return true;
});

// ---------------------------------------------------------------------------
// C1.1d: merkleRoot is a non-empty 64-char hex string for valid triplets
// ---------------------------------------------------------------------------

/**
 * prop_parseBlockTriplet_merkleRoot_hex
 *
 * For every valid triplet fixture, result.merkleRoot is a 64-character lowercase
 * hexadecimal string (BLAKE3 hash in hex encoding).
 *
 * Invariant: blockMerkleRoot() always produces a 256-bit BLAKE3 hash as a 64-char
 * hex string; parseBlockTriplet surfaces it unchanged.
 */
export const prop_parseBlockTriplet_merkleRoot_hex = fc.property(validTripletDirArb, (dir) => {
  const result = parseBlockTriplet(dir);
  const root = result.merkleRoot;

  if (typeof root !== "string") return false;
  if (root.length !== 64) return false;
  // Must be all lowercase hex characters
  if (!/^[0-9a-f]{64}$/.test(root)) return false;

  return true;
});

// ---------------------------------------------------------------------------
// C1.1e: specHashValue is a non-empty hex string for valid triplets
// ---------------------------------------------------------------------------

/**
 * prop_parseBlockTriplet_specHashValue_nonempty
 *
 * For every valid triplet fixture, result.specHashValue is a non-empty string.
 * The exact length depends on the hash algorithm used by specHash(); the invariant
 * is that it is always non-empty and consistent across calls.
 *
 * Invariant: specHash() always returns a non-empty string for any valid SpecYak;
 * parseBlockTriplet never drops or truncates the result.
 */
export const prop_parseBlockTriplet_specHashValue_nonempty = fc.property(
  validTripletDirArb,
  (dir) => {
    const result = parseBlockTriplet(dir);
    const hash = result.specHashValue;

    if (typeof hash !== "string") return false;
    if (hash.length === 0) return false;

    // Must be consistent across two calls
    const r2 = parseBlockTriplet(dir);
    if (r2.specHashValue !== hash) return false;

    return true;
  },
);

// ---------------------------------------------------------------------------
// C1.1f: Composition — detected sub-block refs always have required fields
// ---------------------------------------------------------------------------

/**
 * prop_parseBlockTriplet_composition_ref_shape
 *
 * For every valid triplet fixture, every SubBlockRef in result.composition has
 * all required fields: localName (non-empty string), importedFrom (non-empty string),
 * and specHashRef (null at parse time — L0 invariant).
 *
 * Invariant: extractComposition() always returns fully-populated SubBlockRef objects.
 * The fixtures (digit-of, add-numbers, all-whitespace) have no sub-block imports,
 * so this property vacuously holds for the empty array; the shape guard enforces
 * correctness of the type contract for any fixture that does have imports.
 */
export const prop_parseBlockTriplet_composition_ref_shape = fc.property(
  validTripletDirArb,
  (dir) => {
    const result = parseBlockTriplet(dir);

    for (const ref of result.composition) {
      const r = ref as SubBlockRef;
      if (typeof r.localName !== "string" || r.localName.length === 0) return false;
      if (typeof r.importedFrom !== "string" || r.importedFrom.length === 0) return false;
      // L0 invariant: specHashRef is always null at parse time
      if (r.specHashRef !== null) return false;
    }

    return true;
  },
);

// ---------------------------------------------------------------------------
// C1.1g: isBlockImport — patterns matching @yakcc/seeds/ and @yakcc/blocks/ detected
//
// The isBlockImport() function is private. We test its semantics through two
// observable behaviors:
//   (a) Fixtures without @yakcc/seeds/ or @yakcc/blocks/ imports yield composition=[].
//   (b) The all-whitespace fixture, which imports from @yakcc/seeds/, yields
//       composition.length > 0, proving the pattern is detected.
// ---------------------------------------------------------------------------

/** Fixtures with no sub-block imports — composition must be empty. */
const noCompositionDirArb: fc.Arbitrary<string> = fc.constantFrom(
  join(FIXTURE_BASE, "digit-of"),
  join(FIXTURE_BASE, "add-numbers"),
);

/**
 * prop_parseBlockTriplet_composition_empty_for_simple_blocks
 *
 * For fixtures whose impl.ts contains no @yakcc/seeds/ or @yakcc/blocks/ imports
 * (digit-of and add-numbers), result.composition is always an empty array.
 *
 * Invariant: isBlockImport() returns false for all module specifiers in these
 * fixtures; extractComposition() produces no SubBlockRef values.
 */
export const prop_parseBlockTriplet_composition_empty_for_simple_blocks = fc.property(
  noCompositionDirArb,
  (dir) => {
    const result = parseBlockTriplet(dir);
    return result.composition.length === 0;
  },
);

/**
 * prop_parseBlockTriplet_composition_detected_for_seeds_import
 *
 * The all-whitespace fixture imports `@yakcc/seeds/blocks/is-whitespace-char`,
 * which matches the built-in "@yakcc/seeds/" pattern in isBlockImport(). Its
 * composition array must be non-empty, proving that the pattern detection works.
 *
 * Invariant: isBlockImport() returns true for module specifiers starting with
 * "@yakcc/seeds/"; extractComposition() produces at least one SubBlockRef.
 */
export const prop_parseBlockTriplet_composition_detected_for_seeds_import = fc.property(
  fc.constant(join(FIXTURE_BASE, "all-whitespace")),
  (dir) => {
    const result = parseBlockTriplet(dir);
    // all-whitespace imports from @yakcc/seeds/ — must have at least one ref
    if (result.composition.length === 0) return false;
    // The ref must point to the expected specifier
    const ref = result.composition[0];
    if (ref === undefined) return false;
    return ref.importedFrom.startsWith("@yakcc/seeds/");
  },
);

// ---------------------------------------------------------------------------
// C1.1h: composition specHashRef is always null at parse time (L0 invariant)
//
// Covered inline in C1.1f above. This standalone property makes the invariant
// explicit as a named export for documentation and the test harness.
// ---------------------------------------------------------------------------

/**
 * prop_parseBlockTriplet_specHashRef_null_at_L0
 *
 * For every valid triplet fixture, every SubBlockRef in result.composition has
 * specHashRef === null. The registry (T03+) is responsible for resolving SpecHash
 * values; parseBlockTriplet does not touch the registry at L0.
 *
 * Invariant: extractComposition() always sets specHashRef: null. This is the
 * documented contract for the L0 parse phase.
 */
export const prop_parseBlockTriplet_specHashRef_null_at_L0 = fc.property(
  validTripletDirArb,
  (dir) => {
    const result = parseBlockTriplet(dir);
    for (const ref of result.composition) {
      if (ref.specHashRef !== null) return false;
    }
    return true;
  },
);
