// SPDX-License-Identifier: MIT
// @decision DEC-COMPILE-INDEX-002: @yakcc/compile barrel re-exports all public types
// and functions updated for the triplet substrate (WI-T04).
// Status: implemented (WI-T04); supersedes DEC-COMPILE-INDEX-001 (ContractId-based,
// WI-005). The ContractId re-export is removed; BlockMerkleRoot and SpecHash are
// the new identity types. AssembleOptions.knownContractIds → knownMerkleRoots.
// Rationale: The public API surface is: assemble(), tsBackend(), wasmBackend(), and
// the associated types Artifact, ProvenanceManifest, ProvenanceEntry,
// VerificationStatus, Backend, WasmBackend.
// BlockMerkleRoot and SpecHash are re-exported for callers who need them without
// importing @yakcc/contracts directly.

export type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";

// Provenance manifest types
export type { VerificationStatus, ProvenanceEntry, ProvenanceManifest } from "./manifest.js";

// Backend types and factories
export type { Backend } from "./ts-backend.js";
export { tsBackend } from "./ts-backend.js";
export type { WasmBackend } from "./wasm-backend.js";
export { wasmBackend, compileToWasm } from "./wasm-backend.js";

// WASM host runtime (WI-V1W2-WASM-03 — DEC-V1-WAVE-2-WASM-HOST-CONTRACT-001)
// v2 syscall surface (WI-WASM-HOST-CONTRACT-V2 — DEC-V2-WASM-HOST-CONTRACT-WASI-001)
export type { WasmTrapKind, WasiErrnoValue, YakccHost, CreateHostOptions } from "./wasm-host.js";
export { WasmTrap, WasiErrno, createHost, instantiateAndRun } from "./wasm-host.js";

// Artifact type and assembly entry point
export type { Artifact, AssembleOptions } from "./assemble.js";
export { assemble } from "./assemble.js";

// Resolution types (exported for advanced callers and testing)
export type { ResolvedBlock, ResolutionResult, SubBlockResolver } from "./resolve.js";
export { ResolutionError } from "./resolve.js";
export type { ResolutionErrorKind } from "./resolve.js";

// resolveComposition is exported for callers who want the traversal without assembly
export { resolveComposition } from "./resolve.js";

// buildManifest is exported for callers who build manifests from external ResolutionResults
export { buildManifest } from "./manifest.js";

// Candidate assembly entry point (WI-014-05)
export type { AssembleCandidateOptions } from "./assemble-candidate.js";
export { assembleCandidate, CandidateNotResolvableError } from "./assemble-candidate.js";
