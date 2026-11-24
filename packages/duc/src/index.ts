// SPDX-License-Identifier: Apache-2.0
//
// @yakcc/duc — the Def-Use Calculus influence layer.
//
// A semantics-free def-use graph over a strict-TS atom, plus the analyses that
// are theorems of the graph, quantified over every interpretation of its opaque
// nodes: sound may-influence with inspectable witnesses, graph non-interference
// as linear-time reachability, and monotone composition. See
// plans/wi-duc-influence-layer.md and GH #1161.

export type {
  DiamondLabel,
  DiamondReason,
  DucGraph,
  DucNode,
  NodeId,
  NodeKind,
  NodeOrigin,
  ValueId,
} from "./types.js";
export { defMap, diamondSources, nodeId, nodeIndex, sources, valueId } from "./types.js";

export type {
  AcyclicityViolation,
  ConservationViolation,
  SingleAssignmentViolation,
  WellFormednessResult,
  WellFormednessViolation,
} from "./wellformed.js";
export { isWellFormed } from "./wellformed.js";

export type { LiftOptions } from "./lift.js";
export type { AtomShape } from "./lift.js";
export {
  COMPLETES,
  DECLARES,
  DucLiftError,
  atomShape,
  completionOf,
  declaredNamesOf,
  liftAtom,
} from "./lift.js";
export type { LiftFidelity } from "./fidelity.js";
export {
  graphFreeNames,
  liftFidelity,
  probedNames,
  sourceFreeNames,
  topLevelNames,
} from "./fidelity.js";
export type { EmitSignature } from "./emit-ts.js";
export { EmitError, emitTypeScript } from "./emit-ts.js";
export type { PackedGraph, StoredLink } from "./store.js";
export {
  GRAPH_FORMAT_VERSION,
  LIFTER_VERSION,
  ducBlockRoot,
  graphRoot,
  packGraph,
  unpackGraph,
} from "./store.js";
export { canonicalizeGraph, graphIdentity } from "./canonical.js";

export type { DiamondSupport, InfluenceIndex, NodeSummary, WitnessTerm } from "./influence.js";
export {
  influenceCone,
  influenceIndex,
  influenceIndexWithSummaries,
  mayInfluence,
  mayInfluencePairs,
  renderWitness,
  usupp,
  usuppOfObservations,
  witness,
} from "./influence.js";

export type { Label, Labeling, NILeak, NIResult } from "./ni.js";
export { graphNI, labelBySymbol } from "./ni.js";

export type { BoundaryType, InfluenceEdge, RefinesInfluenceResult } from "./compose.js";
export {
  boundaryType,
  paramSources,
  paramSummaryMatrix,
  refine,
  RefineError,
  refinementIsMonotone,
  refinesInfluence,
} from "./compose.js";

export type {
  DucAttestation,
  DucInfluenceAttestation,
  DucNiAttestation,
  DucNiLeak,
} from "./attest.js";
export {
  DUC_ATTESTATION_VERSION,
  influenceAttestation,
  niAttestation,
  validateDucAttestation,
} from "./attest.js";
export type { AuthorityDelta, AuthorityEdge } from "./authority.js";
export { authorityDelta } from "./authority.js";
export type { GuardedFlow } from "./guard.js";
export { controlInfluence, guardedInfluence } from "./guard.js";
export type {
  CheckerFinding,
  CheckerSpec,
  SourceSelector,
} from "./checker.js";
export {
  CHECKER_SPEC_VERSION,
  checkerSpecHash,
  runChecker,
  validateCheckerSpec,
} from "./checker.js";
export { isHeapToken, type LoweringView, loweringView } from "./ordering.js";
export type {
  AtomSubmission,
  ClosureOptions,
  ClosureReport,
  SubmissionReport,
  SubmittedAtom,
} from "./closure.js";
export { checkSubmission, closureOf, linkReferences, requireSpecifiers } from "./closure.js";
export { LineFormError, parseLineForm, printLineForm } from "./line-form.js";
export type { RetrievalSignatureOptions } from "./retrieval-signature.js";
export { retrievalSignature } from "./retrieval-signature.js";
export type { Candidate } from "./similarity.js";
export { bagDistance, rankStructurally, structuralBag, structuralDistance } from "./similarity.js";
export type { BaseSet, PrimitiveLabels, PrimitiveReport, PrimitiveUse } from "./base-set.js";
export {
  ECMASCRIPT,
  NODE,
  WEB,
  nondeterministicObservations,
  platformModule,
  primitiveReport,
} from "./base-set.js";
export type { Ambiguity, DucType, Signature, TypeReport } from "./infer-types.js";
export { assignable, inferTypes, parseType, typeToText } from "./infer-types.js";
export type { WasmModule, WasmSignature } from "./emit-wasm.js";
export { WASM_HOST, WasmEmitError, emitWasm, instantiateWasm } from "./emit-wasm.js";
export type { LlvmModule, NativeSignature, NativeType } from "./emit-llvm.js";
export { LlvmEmitError, emitLlvm } from "./emit-llvm.js";
export type { ObjectOptions } from "./native.js";
export {
  NATIVE_TARGETS,
  NativeToolError,
  RUNTIME_SOURCE,
  compileObject,
  compileRuntime,
} from "./native.js";
export type { NativeModule, NativeModuleStatement, NativeModules } from "./emit-llvm-boxed.js";
export { emitLlvmBoxed, emitNativeModules, moduleSymbol } from "./emit-llvm-boxed.js";
