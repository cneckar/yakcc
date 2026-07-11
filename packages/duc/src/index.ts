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
export { DucLiftError, liftAtom } from "./lift.js";

export type { DiamondSupport, InfluenceIndex, WitnessTerm } from "./influence.js";
export {
  influenceCone,
  influenceIndex,
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
