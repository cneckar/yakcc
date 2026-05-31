/**
 * Tool registry — re-exports all 10 MCP tool modules as a single array.
 *
 * @decision DEC-MCP-TOOLS-REGISTRY-020
 * @title TOOLS array as the single authority for registered tool modules
 * @status decided (wi-944, bite 2)
 * @rationale
 *   The bite-3 stdio server iterates this array to register tools with the MCP
 *   SDK. Keeping a single ordered array here prevents the server from having to
 *   enumerate individual modules. Adding a new tool requires only appending to
 *   this array — no other file needs to change except the server entry in bite 3.
 *   Sacred Practice #12: one authority per operational fact.
 *
 * Implements: yakcc#944
 */

import { compileTool } from "./compile.js";
import { getAtom } from "./get-atom.js";
import { getProvenance } from "./get-provenance.js";
import { getShaveStatus } from "./get-shave-status.js";
import { getSpec } from "./get-spec.js";
import { listSpecs } from "./list-specs.js";
import { requestShave } from "./request-shave.js";
import { resolveTool } from "./resolve.js";
import { searchAtoms } from "./search-atoms.js";
import { submitAtom } from "./submit-atom.js";
import type { ToolModule } from "./types.js";

export { compileTool } from "./compile.js";
export { getAtom } from "./get-atom.js";
export { getProvenance } from "./get-provenance.js";
export { getShaveStatus } from "./get-shave-status.js";
export { getSpec } from "./get-spec.js";
export { listSpecs } from "./list-specs.js";
export { requestShave } from "./request-shave.js";
export { resolveTool } from "./resolve.js";
export { searchAtoms } from "./search-atoms.js";
export { submitAtom } from "./submit-atom.js";
export type { ToolModule } from "./types.js";

/**
 * Ordered registry of all 10 tool modules.
 * The bite-3 stdio server iterates this array to register with the MCP SDK.
 * resolveTool added per wi-953 (DEC-HOOK-PROACTIVE-A-001).
 * compileTool added per wi-1007 (DEC-MCP-COMPILE-EXEC-1007-001).
 */
export const TOOLS: ToolModule[] = [
  resolveTool,
  compileTool,
  searchAtoms,
  getAtom,
  listSpecs,
  getSpec,
  submitAtom,
  requestShave,
  getShaveStatus,
  getProvenance,
];
