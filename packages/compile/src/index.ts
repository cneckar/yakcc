// SPDX-License-Identifier: MIT
// @decision DEC-COMPILE-INDEX-002: @yakcc/compile barrel re-exports all public types
// and functions updated for the triplet substrate (WI-T04).
// Status: updated (WI-AS-CLEANUP-WAVE3-LOWERER, #148) — wasm-backend.ts / wasm-host.ts
// deleted in Phase 3; wasmBackend/compileToWasm/WasmTrap/createHost/instantiateAndRun
// removed from public surface. WasmBackend type now lives in as-backend.ts.
// Originally implemented WI-T04; supersedes DEC-COMPILE-INDEX-001 (ContractId-based,
// WI-005). The ContractId re-export is removed; BlockMerkleRoot and SpecHash are
// the new identity types. AssembleOptions.knownContractIds → knownMerkleRoots.
// Rationale: The public API surface is: assemble(), tsBackend(), assemblyScriptBackend(),
// and the associated types Artifact, ProvenanceManifest, ProvenanceEntry,
// VerificationStatus, Backend, WasmBackend.
// BlockMerkleRoot and SpecHash are re-exported for callers who need them without
// importing @yakcc/contracts directly.

export type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";

// Provenance manifest types
export type { VerificationStatus, ProvenanceEntry, ProvenanceManifest } from "./manifest.js";

// Backend types and factories
export type { Backend } from "./ts-backend.js";
export { tsBackend } from "./ts-backend.js";
// AssemblyScript backend + WasmBackend type (sole WASM path after Phase 3 retirement of
// in-house wasm-backend.ts — WI-AS-CLEANUP-WAVE3-LOWERER #148, DEC-AS-BACKEND-PIVOT-001)
export type { WasmBackend } from "./as-backend.js";
export { assemblyScriptBackend } from "./as-backend.js";

// Artifact type and assembly entry point
export type { Artifact, AssembleOptions } from "./assemble.js";
export { assemble, resolveGranularity } from "./assemble.js";

// Resolution types (exported for advanced callers and testing)
export type { ResolvedBlock, ResolutionResult, SubBlockResolver } from "./resolve.js";
export { ResolutionError } from "./resolve.js";
export type { ResolutionErrorKind } from "./resolve.js";

// resolveComposition is exported for callers who want the traversal without assembly
export { resolveComposition } from "./resolve.js";

// buildManifest is exported for callers who build manifests from external ResolutionResults
export { buildManifest } from "./manifest.js";

// Slice-plan compilation path (WI-V2-GLUE-LEAF-CONTRACT)
// compileToTypeScript: SlicePlan → TS source (handles GlueLeafEntry verbatim)
// assertNoGlueLeaf: validate no glue before WASM compilation (DEC-V2-GLUE-LEAF-WASM-001)
// GlueLeafInWasmModeError: typed error for glue-in-WASM rejection
export {
  compileToTypeScript,
  assertNoGlueLeaf,
  GlueLeafInWasmModeError,
} from "./slice-plan.js";

// Candidate assembly entry point (WI-014-05)
export type { AssembleCandidateOptions } from "./assemble-candidate.js";
export { assembleCandidate, CandidateNotResolvableError } from "./assemble-candidate.js";

// Import gate -- compile-time enforcement of covered foreign imports (WI-508)
// DEC-WI508-IMPORT-GATE-001
export {
  assertNoUnexpandedImports,
  UnexpandedImportError,
  GATE_INTERCEPT_ALLOWLIST,
} from "./import-gate.js";
export type { AssertNoUnexpandedImportsOptions } from "./import-gate.js";
