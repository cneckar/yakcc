// SPDX-License-Identifier: MIT
// @decision DEC-TRIPLET-IDENTITY-020: SpecHash is the existing ContractId derivation
// applied to a canonicalized SpecYak. The spec hash is retained as the index used
// by selectBlocks(specHash) → BlockMerkleRoot[], not the block's identity. The
// canonicalization rule is unchanged from v0: BLAKE3-256 over canonicalize(spec).
// Status: decided (MASTER_PLAN.md, VERIFICATION.md DEC-VERIFY-002)
// Rationale: Continuous with v0's ContractId derivation so the migration path can
// re-index the seed corpus without recomputing SpecHash from scratch. Two specs with
// identical canonical representations share a SpecHash (and are therefore the same
// contract), even if their corresponding block MerkleRoots differ (different impls).

// @decision DEC-TRIPLET-L0-ONLY-019: The optional level-dependent fields (theory,
// bounds, totality_witness, proof_kind, constant_time) are accepted by the schema
// without enforcement at L0. The L1/L2/L3 validators that would enforce these fields
// are deferred per the scope decision.
// Status: decided (MASTER_PLAN.md)

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

/**
 * A stable content-address identifying a SpecYak by the hash of its canonical
 * form. Continuous with v0's ContractId: SpecHash = BLAKE3(canonicalize(spec.yak)).
 *
 * Two SpecYak values with identical canonical representations share a SpecHash.
 * The SpecHash is the index used by the registry's block selector:
 *   selectBlocks(specHash) → BlockMerkleRoot[]
 *
 * Format: 64 lowercase hex characters (BLAKE3-256 output).
 */
export type SpecHash = string & { readonly __brand: "SpecHash" };

// ---------------------------------------------------------------------------
// SpecYak — the v1 contract specification format
// ---------------------------------------------------------------------------

/**
 * The v1 contract specification. Stored as JSON alongside impl.ts and proof/
 * in the block triplet. JSON-shaped for LLM-friendly authoring and mechanical
 * extraction into solver theories.
 *
 * Required fields per VERIFICATION.md §"spec.yak":
 *   name, inputs, outputs, preconditions, postconditions, invariants, effects, level
 *
 * Optional, level-dependent fields:
 *   theory (required at L2), bounds, totality_witness (required at L1+ when needed),
 *   proof_kind (required at L3), constant_time
 *
 * SpecYak is structurally a superset of the v0 ContractSpec so existing seed specs
 * lift naturally. The v0 ContractSpec fields (behavior, guarantees, errorConditions,
 * nonFunctional, propertyTests) are preserved as optional fields here to allow a
 * clean structural lift; WI-T05 populates them during seed migration.
 */
export interface SpecYak {
  // -------------------------------------------------------------------------
  // Required fields (VERIFICATION.md §"spec.yak" required fields)
  // -------------------------------------------------------------------------

  /** Human-readable identifier. Informational; identity is derived from the hash. */
  readonly name: string;

  /**
   * Typed input schema in the strict-TS-subset type language.
   * At L0 this is free-form string-typed; the encoder lifts it at L2+.
   */
  readonly inputs: readonly SpecYakParameter[];

  /** Typed output schema. */
  readonly outputs: readonly SpecYakParameter[];

  /**
   * Assertions on inputs that the implementation may assume. Pure blocks with
   * no preconditions declare an empty array.
   */
  readonly preconditions: readonly string[];

  /**
   * Assertions on outputs the implementation must guarantee. The spec's
   * postconditions are lifted by the L2 encoder into the SMT refinement query.
   */
  readonly postconditions: readonly string[];

  /**
   * Properties preserved across the operation. Stateful contracts use this for
   * invariants; pure-by-default blocks with no state declare an empty array.
   */
  readonly invariants: readonly string[];

  /**
   * Declared object-capability requirements. Pure blocks declare an empty array.
   * Effectful blocks list each attenuated capability (e.g. "WriteOnly:/tmp/x").
   */
  readonly effects: readonly string[];

  /**
   * Declared verification level. The registry enforces the claim at registration.
   * L0 is the v0 floor (strict-TS + fast-check property tests).
   */
  readonly level: "L0" | "L1" | "L2" | "L3";

  // -------------------------------------------------------------------------
  // Optional, level-dependent fields (accepted without enforcement at L0)
  // -------------------------------------------------------------------------

  /**
   * Required at L2. Array of declared SMT theory tags (e.g. ["bv64", "arrays"]).
   * The encoder uses this to choose its lifting strategy; an undeclared theory
   * at L2 is a registration error.
   */
  readonly theory?: readonly string[] | undefined;

  /**
   * Explicit fuzz/BMC budgets. Visible contract metadata so consumers know
   * exactly what bound was used when a block falls back to bounded checking.
   * E.g. { bmc_depth: 16, fuzz_samples: 100000, solver_budget_ms: 5000 }
   */
  readonly bounds?: Record<string, number> | undefined;

  /**
   * Required at L1+ when the totality checker cannot conclude purely syntactically.
   * Either { structural_on: "<argument-name>" } or { fuel: "<argument-name>", max: <N> }.
   */
  readonly totality_witness?: Record<string, string | number> | undefined;

  /**
   * Required at L3. Identifies which checker artifact in proof/ is the canonical
   * refinement proof.
   */
  readonly proof_kind?: string | undefined;

  /**
   * Non-functional contract property for cryptographically-sensitive blocks.
   * Separate from verification level because constant-time is a side-channel
   * property, not a behavioral one (VERIFICATION.md DEC-VERIFY-004).
   */
  readonly constant_time?: boolean | undefined;

  // -------------------------------------------------------------------------
  // v0 structural lift fields (optional; populated by WI-T05 seed migration)
  // -------------------------------------------------------------------------

  /** Natural-language behavioral description (v0 ContractSpec.behavior). */
  readonly behavior?: string | undefined;

  /** Declared behavioral guarantees (v0 ContractSpec.guarantees). */
  readonly guarantees?:
    | ReadonlyArray<{ readonly id: string; readonly description: string }>
    | undefined;

  /** Declared error conditions (v0 ContractSpec.errorConditions). */
  readonly errorConditions?:
    | ReadonlyArray<{
        readonly description: string;
        readonly errorType?: string | undefined;
      }>
    | undefined;

  /** Non-functional properties (v0 ContractSpec.nonFunctional). */
  readonly nonFunctional?:
    | {
        readonly time?: string | undefined;
        readonly space?: string | undefined;
        readonly purity: string;
        readonly threadSafety: string;
      }
    | undefined;

  /** Property test cases (v0 ContractSpec.propertyTests). */
  readonly propertyTests?:
    | ReadonlyArray<{
        readonly id: string;
        readonly description: string;
        readonly arbitraries?: readonly string[] | undefined;
      }>
    | undefined;
}

/** A named, typed parameter in a SpecYak input or output schema. */
export interface SpecYakParameter {
  readonly name: string;
  readonly type: string;
  readonly description?: string | undefined;
}

// ---------------------------------------------------------------------------
// Required field names (used by the validator to produce typed errors)
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS = [
  "name",
  "inputs",
  "outputs",
  "preconditions",
  "postconditions",
  "invariants",
  "effects",
  "level",
] as const;

type RequiredField = (typeof REQUIRED_FIELDS)[number];

const VALID_LEVELS = new Set<string>(["L0", "L1", "L2", "L3"]);

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validate and narrow an unknown value to SpecYak.
 *
 * Throws a TypeError naming the first missing or invalid required field.
 * Optional fields are accepted as-is (no deep validation at L0).
 *
 * Forbidden shortcuts enforced here:
 * - No parallel "validateContractSpecV0" entry point ships (this is the sole
 *   entry point for spec validation per Evaluation Contract forbidden shortcuts).
 */
export function validateSpecYak(value: unknown): SpecYak {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("validateSpecYak: expected a non-null object");
  }

  const obj = value as Record<string, unknown>;

  // Check all required fields are present and have valid types.
  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj) || obj[field] === undefined) {
      throw new TypeError(`validateSpecYak: missing required field "${field as RequiredField}"`);
    }
  }

  // Validate level is a known value.
  const level = obj.level;
  if (typeof level !== "string" || !VALID_LEVELS.has(level)) {
    throw new TypeError(
      `validateSpecYak: invalid "level" value ${JSON.stringify(level)}; expected one of "L0", "L1", "L2", "L3"`,
    );
  }

  // Validate array fields are actually arrays.
  for (const arrayField of [
    "inputs",
    "outputs",
    "preconditions",
    "postconditions",
    "invariants",
    "effects",
  ] as const) {
    if (!Array.isArray(obj[arrayField])) {
      throw new TypeError(`validateSpecYak: field "${arrayField}" must be an array`);
    }
  }

  // Validate name is a non-empty string.
  if (typeof obj.name !== "string" || (obj.name as string).length === 0) {
    throw new TypeError(`validateSpecYak: field "name" must be a non-empty string`);
  }

  // The value is structurally valid. Return as SpecYak.
  return obj as unknown as SpecYak;
}
