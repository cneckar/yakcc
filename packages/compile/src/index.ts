// @decision DEC-COMPILE-FACADE-V0: The v0 compiler exposes a typed Backend
// interface and an assemble() facade that returns an empty Artifact.
// Status: provisional (WI-005 wires the real TS backend and block assembly)
// Rationale: CLI needs a stable API surface before the real backend exists.
// compile() returns an empty-source Artifact with an empty ProvenanceManifest;
// assemble() delegates to backend.compile() with an empty block list.
import type { ContractId } from "@yakcc/contracts";
import type { BlockAst } from "@yakcc/ir";
import type { Registry } from "@yakcc/registry";

export type { ContractId };

// ---------------------------------------------------------------------------
// Provenance types
// ---------------------------------------------------------------------------

/** Whether this block's implementation has been verified against its contract. */
export type VerificationStatus = "passing" | "unverified";

/** One entry in a provenance manifest, linking a block to its contract. */
export interface ProvenanceEntry {
  readonly contractId: ContractId;
  /** Content-address of the implementation source text. */
  readonly blockSource: string;
  readonly verificationStatus: VerificationStatus;
}

/**
 * The provenance manifest for an assembled artifact. Every block that was
 * linked into the artifact has exactly one entry here, keyed by contractId.
 */
export interface ProvenanceManifest {
  readonly entries: ReadonlyArray<ProvenanceEntry>;
}

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

/**
 * The output of a compile pass: generated source text plus a provenance
 * manifest naming every block by its content-address.
 */
export interface Artifact {
  /** The emitted program source text. */
  readonly source: string;
  readonly manifest: ProvenanceManifest;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

/**
 * A compilation backend. Backends are responsible for turning a block list
 * into an Artifact for a specific target language or module format.
 *
 * v0: only the "ts" backend exists; it returns an empty Artifact.
 */
export interface Backend {
  /** Human-readable backend identifier (e.g. "ts"). */
  readonly name: string;
  compile(blocks: ReadonlyArray<BlockAst>, entry: ContractId): Promise<Artifact>;
}

/**
 * Create the built-in TypeScript backend.
 *
 * v0 facade: compile() returns an empty-source Artifact with no provenance
 * entries. WI-005 replaces the body with real block assembly and emission.
 */
export function tsBackend(): Backend {
  return {
    name: "ts",
    compile(_blocks, _entry) {
      return Promise.resolve({
        source: "",
        manifest: { entries: [] },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Top-level assembly entry point
// ---------------------------------------------------------------------------

/**
 * Assemble a runnable program for the given entry contract from the registry.
 *
 * v0 facade: delegates to backend.compile() with an empty block list, returning
 * an empty Artifact. WI-005 adds registry lookup and block ordering.
 *
 * @param entry   - ContractId of the program entry point.
 * @param _registry - Registry instance to resolve block implementations from.
 * @param backend - Compilation backend; defaults to the TypeScript backend.
 */
export function assemble(
  entry: ContractId,
  _registry: Registry,
  backend: Backend = tsBackend(),
): Promise<Artifact> {
  return backend.compile([], entry);
}
