// @decision DEC-COMPILE-INDEX-001: @yakcc/compile barrel re-exports all public types
// and functions. The legacy Backend interface (compile(blocks, entry)) is replaced by
// the WI-005 Backend interface (emit(resolution)), which accepts a ResolutionResult.
// Status: supersedes DEC-COMPILE-FACADE-V0 (WI-005 wires the real backend).
// Rationale: The public API surface is: assemble(), tsBackend(), and the associated
// types Artifact, ProvenanceManifest, ProvenanceEntry, VerificationStatus, Backend.
// ContractId is re-exported for callers who need it without importing @yakcc/contracts.

export type { ContractId } from "@yakcc/contracts";

// Provenance manifest types
export type { VerificationStatus, ProvenanceEntry, ProvenanceManifest } from "./manifest.js";

// Backend types and factory
export type { Backend } from "./ts-backend.js";
export { tsBackend } from "./ts-backend.js";

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
