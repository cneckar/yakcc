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
 * v0 derives this via an FNV-style hash; WI-002 replaces the hash algorithm
 * with BLAKE3 without changing this type or any public call site.
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
  readonly errorConditions: readonly string[];
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
// Canonicalization
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic JSON string from a ContractSpec with all object keys
 * sorted recursively.
 *
 * Canonicalization is the equivalence relation for contract identity: two specs
 * are "the same contract" if and only if they produce the same canonical string.
 * The canonical string is what gets hashed to derive the ContractId.
 *
 * Key sort order: lexicographic, depth-first.
 */
export function canonicalize(spec: ContractSpec): string {
  return JSON.stringify(sortDeep(spec as unknown as JsonValue));
}

// Internal recursive sorter for canonical JSON
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function sortDeep(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  const sorted: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value).sort()) {
    const child = (value as { [key: string]: JsonValue })[key];
    if (child !== undefined) {
      sorted[key] = sortDeep(child);
    }
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Content-address derivation
// ---------------------------------------------------------------------------

// @decision DEC-HASH-V0-FACADE: v0 uses an FNV-1a-style hash over the UTF-8
// bytes of the canonical JSON string. WI-002 replaces this with BLAKE3.
// Status: provisional (WI-002 will supersede)
// Rationale: FNV-1a is dependency-free and sufficient to prove stable identity
// for the v0 facade. Collision resistance is not critical before a shared
// registry exists; hash strength is a WI-002 concern.

/**
 * Derive a stable ContractId from a ContractSpec.
 *
 * v0: FNV-1a-style hash over the UTF-8 bytes of the canonical JSON.
 * WI-002: replaced with BLAKE3. Call sites are unchanged by the upgrade.
 */
export function contractId(spec: ContractSpec): ContractId {
  const canonical = canonicalize(spec);
  const hash = fnv1a32(canonical);
  return `cid:${hash.toString(16).padStart(8, "0")}` as ContractId;
}

/** FNV-1a 32-bit hash over a string's UTF-16 code units. Returns a non-negative integer. */
function fnv1a32(input: string): number {
  const FNV_PRIME = 0x01000193;
  const FNV_OFFSET_BASIS = 0x811c9dc5;
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    // XOR the low 8 bits of the char code, then multiply by the FNV prime.
    // Bitwise ops in JS work on signed 32-bit integers; >>> 0 coerces to uint32.
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Embedding generation
// ---------------------------------------------------------------------------

/**
 * Generate a vector embedding of a ContractSpec for use in similarity search.
 *
 * Returns a 384-dimensional Float32Array. The dimensionality matches the
 * all-MiniLM-L6-v2 sentence-embedding model, which is the planned local
 * provider in WI-002. v0 returns a zero vector so the registry facade can
 * store and retrieve without a live model.
 *
 * Callers must not treat the zero vector as a meaningful similarity score.
 * The embedding is only useful once WI-002 wires `transformers.js`.
 */
export async function generateEmbedding(_spec: ContractSpec): Promise<Float32Array> {
  // Facade: zero vector. WI-002 replaces this with a live transformers.js call.
  return new Float32Array(384);
}

// ---------------------------------------------------------------------------
// Proposal submission
// ---------------------------------------------------------------------------

/**
 * Submit a ContractSpec as a proposal.
 *
 * Returns a ProposalResult indicating whether the spec matched an existing
 * contract in the registry or was accepted as new. v0 always returns "accepted"
 * using the derived ContractId; WI-003 connects this to the live registry for
 * real match detection.
 */
export async function proposeContract(spec: ContractSpec): Promise<ProposalResult> {
  // Facade: always accept. WI-003 replaces this with a registry roundtrip.
  return {
    status: "accepted",
    id: contractId(spec),
  };
}
