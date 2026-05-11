// SPDX-License-Identifier: MIT
// @decision DEC-IDENTITY-005: Contract identity is the hash of the canonicalized
// contract spec; verification evidence is separate, mutable metadata.
// Status: decided (MASTER_PLAN.md)
// Rationale: Identity must be immutable so references are stable; trust evidence
// must be mutable so monotonic improvement is possible. Conflating them breaks both.

// @decision DEC-NO-OWNERSHIP-011: No author identity, no signatures, no reserved
// columns for either in any type or schema in this package.
// Status: decided (MASTER_PLAN.md)
// Rationale: Cornerstone. The registry is a public-domain commons.

// ---------------------------------------------------------------------------
// Branded primitive types
// ---------------------------------------------------------------------------

/**
 * A stable content-address identifying a ContractSpec by the hash of its
 * canonical form. Two specs with identical canonical representations share an id.
 *
 * The brand prevents accidental substitution of bare strings for contract ids.
 * Derived via BLAKE3-256 over the canonicalized UTF-8 bytes of the ContractSpec.
 * Format: 64 lowercase hex characters (32 bytes).
 */
export type ContractId = string & { readonly __brand: "ContractId" };

// ---------------------------------------------------------------------------
// Non-functional property types
// ---------------------------------------------------------------------------

/** Purity classification for a basic block. */
export type Purity =
  | "pure" // referentially transparent; no side effects
  | "io" // performs I/O but is otherwise deterministic
  | "stateful" // reads or writes mutable state
  | "nondeterministic"; // result may differ across calls with identical inputs

/** Thread-safety classification for a basic block. */
export type ThreadSafety =
  | "safe" // safe to call concurrently without external synchronization
  | "unsafe" // requires external synchronization
  | "sequential"; // must be called on a single dedicated thread

/**
 * Non-functional properties of a basic block. All fields are optional to allow
 * partial declarations; absence means "unspecified," not "unconstrained."
 */
export interface NonFunctionalProperties {
  /** Big-O time complexity as a free-form string, e.g. "O(n)". */
  readonly time?: string | undefined;
  /** Big-O space complexity as a free-form string, e.g. "O(1)". */
  readonly space?: string | undefined;
  /** Purity classification. */
  readonly purity: Purity;
  /** Thread-safety classification. */
  readonly threadSafety: ThreadSafety;
}

// ---------------------------------------------------------------------------
// Contract spec sub-types
// ---------------------------------------------------------------------------

/**
 * A named, typed parameter or return value in a contract.
 * Types are expressed as free-form TypeScript type strings in v0; WI-004
 * introduces a structured AST representation when the IR validator lands.
 */
export interface TypeSignature {
  readonly name: string;
  readonly type: string;
  /** Optional description of this parameter's role. */
  readonly description?: string | undefined;
}

/** A declared behavioral guarantee for a basic block. */
export interface BehavioralGuarantee {
  /** Short identifier for the guarantee, e.g. "idempotent". */
  readonly id: string;
  /** Human-readable description of what is guaranteed. */
  readonly description: string;
}

/** A declared error condition — when and what the block throws or rejects with. */
export interface ErrorCondition {
  /** Human-readable description of the error condition. */
  readonly description: string;
  /** The error type thrown or rejected, as a TS type string, e.g. "SyntaxError". */
  readonly errorType?: string | undefined;
}

/**
 * A property test case that exercises the block's contract.
 * Each test case is expressed as a fast-check property description; WI-006
 * provides the runner.
 */
export interface PropertyTestCase {
  /** Short identifier for this test case, e.g. "round-trips through parse". */
  readonly id: string;
  /** Human-readable description of what property is tested. */
  readonly description: string;
  /** fast-check arbitrary expressions used to generate inputs, as strings. */
  readonly arbitraries?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// ContractSpec — the core declaration
// ---------------------------------------------------------------------------

/**
 * The complete behavioral specification of a basic block.
 *
 * A ContractSpec is the unit of identity in Yakcc: the hash of its canonical
 * form is the ContractId. Two specs that are semantically equivalent but
 * canonicalize differently will receive distinct ids — canonicalization is
 * the equivalence relation, not semantic reasoning.
 *
 * All fields that affect identity are `readonly`. Verification evidence that
 * may evolve over time lives on `VerificationEvidence`, not here.
 */
export interface ContractSpec {
  /** Input parameters. */
  readonly inputs: readonly TypeSignature[];
  /** Output parameters. */
  readonly outputs: readonly TypeSignature[];
  /** Natural-language behavioral description. This is searchable and embedded. */
  readonly behavior: string;
  /** Declared behavioral guarantees. */
  readonly guarantees: readonly BehavioralGuarantee[];
  /** Declared error conditions. */
  readonly errorConditions: readonly ErrorCondition[];
  /** Non-functional properties. */
  readonly nonFunctional: NonFunctionalProperties;
  /** Property test cases that any conforming implementation must pass. */
  readonly propertyTests: readonly PropertyTestCase[];
}

// ---------------------------------------------------------------------------
// Verification evidence — mutable metadata attached to an immutable id
// ---------------------------------------------------------------------------

/**
 * Mutable metadata attached to a ContractId describing what verification has
 * been performed against implementations that claim to satisfy this contract.
 *
 * Evidence grows monotonically — entries are appended, never removed. The
 * schema intentionally carries no author identity or signature fields.
 * DEC-NO-OWNERSHIP-011.
 */
export interface VerificationEvidence {
  /** History of test runs against implementations registered under this contract. */
  readonly testHistory: readonly TestHistoryEntry[];
}

/** One recorded test run. */
export interface TestHistoryEntry {
  /** ISO-8601 timestamp of the test run. */
  readonly runAt: string;
  /** Whether all property tests passed. */
  readonly passed: boolean;
  /** Number of property test cases exercised. */
  readonly caseCount: number;
}

// ---------------------------------------------------------------------------
// Contract — id + spec + evidence
// ---------------------------------------------------------------------------

/**
 * A complete contract record: a stable id, the spec it was derived from, and
 * accumulated verification evidence.
 */
export interface Contract {
  readonly id: ContractId;
  readonly spec: ContractSpec;
  readonly evidence: VerificationEvidence;
}

// ---------------------------------------------------------------------------
// Proposal result — discriminated union
// ---------------------------------------------------------------------------

/** The proposal was accepted as a new contract. */
export interface ProposalAccepted {
  readonly status: "accepted";
  readonly id: ContractId;
}

/**
 * The proposal matched an existing contract in the registry.
 * The caller should use the existing id rather than registering a new one.
 */
export interface ProposalMatched {
  readonly status: "matched";
  readonly id: ContractId;
  /** Similarity score in [0, 1] where 1.0 is an exact canonical match. */
  readonly score: number;
}

/** Discriminated union of outcomes from submitting a contract proposal. */
export type ProposalResult = ProposalAccepted | ProposalMatched;

// ---------------------------------------------------------------------------
// Proposal submission (facade — WI-003 connects this to the live registry)
// ---------------------------------------------------------------------------

export { contractId } from "./contract-id.js";

/**
 * Submit a ContractSpec as a proposal.
 *
 * Returns a ProposalResult indicating whether the spec matched an existing
 * contract in the registry or was accepted as new. v0 always returns "accepted"
 * using the derived ContractId; WI-003 connects this to the live registry for
 * real match detection.
 */
export async function proposeContract(spec: ContractSpec): Promise<ProposalResult> {
  const { contractId } = await import("./contract-id.js");
  return {
    status: "accepted",
    id: contractId(spec),
  };
}

// ---------------------------------------------------------------------------
// Re-exports from sub-modules
// ---------------------------------------------------------------------------

export {
  canonicalize,
  canonicalizeText,
  canonicalizeQueryText,
  type QueryIntentCard,
  type QueryTypeSignatureParam,
} from "./canonicalize.js";
export {
  contractIdFromBytes,
  isValidContractId,
} from "./contract-id.js";
export {
  type EmbeddingProvider,
  LOCAL_KNOWN_MODELS,
  createLocalEmbeddingProvider,
  createOfflineEmbeddingProvider,
  generateEmbedding,
} from "./embeddings.js";
export { type SpecHash, type SpecYak, type SpecYakParameter, validateSpecYak } from "./spec-yak.js";
export {
  type ProofArtifact,
  type ProofManifest,
  type ArtifactKind,
  validateProofManifestL0,
} from "./proof-manifest.js";
export {
  type BlockTriplet,
  type LocalTriplet,
  type ForeignTripletFields,
  type BlockMerkleRoot,
  blockMerkleRoot,
  specHash,
  isLocalTriplet,
  isForeignTriplet,
} from "./merkle.js";
export {
  canonicalAstHash,
  CanonicalAstParseError,
  type CanonicalAstHash,
} from "./canonical-ast.js";
