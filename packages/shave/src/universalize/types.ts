// Universalize sub-module types.
// Re-exports the slicer-facing types from the top-level types module so that
// WI-012's DFG slicer can import from this sub-path without a circular
// dependency on the full public API surface.

export type {
  CandidateBlock,
  UniversalizeResult,
  UniversalizeSlicePlanEntry,
} from "../types.js";
