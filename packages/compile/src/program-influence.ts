// SPDX-License-Identifier: MIT
//
// @decision DEC-DUC-COMPOSITION-MONOTONE-001 (program influence at compile time)
// A compiled program is a DAG of blocks (resolveComposition). Its whole-program
// influence is assembled from per-atom summaries, not by re-traversing sub-bodies:
// each block is lifted to a DUC graph exactly once, summarized as a param->obs
// matrix, and a caller's opaque call node has its complete step relation replaced
// by the callee's summary (DUC Thm 6.2(2), via
// `influenceIndexWithSummaries`). Processing blocks in topological order (leaves
// first) means every callee's summary is ready before its callers are analyzed.
//
// Two products for the compile boundary:
//   (1) the program's *external* unknown-support — the ♦-sources the whole
//       assembled program depends on that are NOT resolved by composition (a
//       sub-block reference is internal; a `node:fs` import or an unresolved free
//       identifier is external). This is the W1/W2 attack-surface answer at
//       program scope.
//   (2) the strictness falsifier (`checkStrictnessRefinement`): a candidate block
//       claimed stricter than an incumbent whose param->obs influence *adds* an
//       edge is provably not a refinement (W5).

import type { BlockMerkleRoot } from "@yakcc/contracts";
import {
  type DiamondReason,
  type DucGraph,
  type DucNode,
  type NodeId,
  type NodeSummary,
  type RefinesInfluenceResult,
  type ValueId,
  boundaryType,
  defMap,
  influenceCone,
  influenceIndexWithSummaries,
  liftAtom,
  nodeIndex,
  paramSources,
  refinesInfluence,
  usuppOfObservations,
} from "@yakcc/duc";
import type { ResolutionResult } from "./resolve.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One external unknown (♦-source) a program depends on, keyed by symbol. */
export interface ProgramUnknown {
  readonly symbol: string;
  readonly reason: DiamondReason;
  readonly module?: string;
}

/** The influence contract of one block within a program. */
export interface BlockInfluence {
  readonly merkleRoot: BlockMerkleRoot;
  /** The block's primary exported binding name, or null if none was found. */
  readonly exportName: string | null;
  /** Boundary arity: parameter-sources, ♦-sources, observations. */
  readonly boundary: { readonly params: number; readonly diamonds: number; readonly obs: number };
  /**
   * The block's param->obs influence summary *with its callees composed in* —
   * `[i][j]` is true iff parameter i may-influence observation j once every
   * internal call has been narrowed to its callee's summary.
   */
  readonly summary: readonly (readonly boolean[])[];
  /** This block's own direct external unknowns (excludes internal sub-block calls). */
  readonly external: readonly ProgramUnknown[];
  /** Present when the block's source could not be lifted for analysis. */
  readonly liftError?: string;
}

/** The whole-program influence view. */
export interface ProgramInfluence {
  readonly entry: BlockMerkleRoot;
  readonly blocks: ReadonlyMap<BlockMerkleRoot, BlockInfluence>;
  /** The entry block's influence (undefined only if the entry failed to lift). */
  readonly entryInfluence: BlockInfluence | undefined;
  /** The de-duplicated union of every block's external unknowns. */
  readonly externalUnknowns: readonly ProgramUnknown[];
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Analyze the whole-program influence of a resolved composition. Each block is
 * lifted once; callees are composed into callers by summary (no sub-body
 * re-traversal). Blocks are visited in `resolution.order` (leaves first).
 */
export function analyzeProgramInfluence(resolution: ResolutionResult): ProgramInfluence {
  const blocks = new Map<BlockMerkleRoot, BlockInfluence>();
  // export-name -> that block's composed param->obs summary, filled as we go.
  const summaryByExport = new Map<string, readonly (readonly boolean[])[]>();
  const programExternal = new Map<string, ProgramUnknown>();

  for (const root of resolution.order) {
    const block = resolution.blocks.get(root);
    if (block === undefined) continue;

    const exportName = primaryExportName(block.source);
    let graph: DucGraph;
    try {
      graph = liftAtom(block.source);
    } catch (err) {
      blocks.set(root, {
        merkleRoot: root,
        exportName,
        boundary: { params: 0, diamonds: 0, obs: 0 },
        summary: [],
        external: [],
        liftError: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const internal = internalSubBlockSymbols(block.source);
    const external = externalUnknowns(graph, internal);
    for (const unknown of external) {
      if (!programExternal.has(unknown.symbol)) programExternal.set(unknown.symbol, unknown);
    }

    const nodeSummaries = buildCallNodeSummaries(graph, internal, summaryByExport);
    const summary = composedSummary(graph, nodeSummaries);
    if (exportName !== null) summaryByExport.set(exportName, summary);

    blocks.set(root, {
      merkleRoot: root,
      exportName,
      boundary: boundaryType(graph),
      summary,
      external,
    });
  }

  return {
    entry: resolution.entry,
    blocks,
    entryInfluence: blocks.get(resolution.entry),
    externalUnknowns: [...programExternal.values()],
  };
}

/**
 * The strictness falsifier (W5): decide whether `stricterSource` refines
 * `looserSource` in influence. A claimed-stricter block whose param->obs
 * influence adds an edge over the incumbent is rejected with the offending edges.
 * Lift failures surface as `boundary-mismatch` (nothing to compare).
 */
export function checkStrictnessRefinement(
  stricterSource: string,
  looserSource: string,
): RefinesInfluenceResult {
  let stricter: DucGraph;
  let looser: DucGraph;
  try {
    stricter = liftAtom(stricterSource);
    looser = liftAtom(looserSource);
  } catch {
    return { refines: false, reason: "boundary-mismatch", added: [] };
  }
  return refinesInfluence(stricter, looser);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The block's param->obs summary, computed with any internal call nodes narrowed
 * to their callees' summaries (nodes absent from `nodeSummaries` stay opaque).
 */
function composedSummary(
  graph: DucGraph,
  nodeSummaries: ReadonlyMap<NodeId, NodeSummary>,
): readonly (readonly boolean[])[] {
  const index = influenceIndexWithSummaries(graph, nodeSummaries);
  const conePerObs = graph.obs.map((observed) => ({
    observed,
    cone: influenceCone(graph, observed, index),
  }));
  return paramSources(graph).map((param) => {
    const source = param.outputs[0] as ValueId;
    return conePerObs.map(({ observed, cone }) => source === observed || cone.has(source));
  });
}

/**
 * For each internal call node in `graph`, build the node summary that narrows its
 * opaque all-to-all relation to its callee's summary. A call node is an `op` node
 * whose origin is a CallExpression and whose first input is a ♦-source naming an
 * internal sub-block for which a composed summary is known. Nodes whose arity
 * does not line up with the callee are left opaque (sound fallback).
 */
function buildCallNodeSummaries(
  graph: DucGraph,
  internal: ReadonlySet<string>,
  summaryByExport: ReadonlyMap<string, readonly (readonly boolean[])[]>,
): Map<NodeId, NodeSummary> {
  const def = defMap(graph);
  const nodes = nodeIndex(graph);
  const summaries = new Map<NodeId, NodeSummary>();

  for (const node of graph.nodes) {
    if (node.kind !== "op" || node.origin?.kind !== "CallExpression") continue;
    if (node.inputs.length === 0 || node.outputs.length !== 1) continue;
    const calleeSymbol = diamondSymbolOf(node.inputs[0] as ValueId, def, nodes);
    if (calleeSymbol === undefined || !internal.has(calleeSymbol)) continue;
    const calleeSummary = summaryByExport.get(calleeSymbol);
    if (calleeSummary === undefined) continue;

    // Call node inputs are [callee, arg0, arg1, ...]; single output is the result.
    const argCount = node.inputs.length - 1;
    if (argCount !== calleeSummary.length) continue; // arity mismatch → stay opaque

    // The callee's identity influences the result (DUC Rem 6.3); an argument
    // influences the result iff it influences any of the callee's observations.
    const allowed = new Set<string>(["0->0"]);
    for (let i = 0; i < argCount; i++) {
      if (calleeSummary[i]?.some(Boolean)) allowed.add(`${i + 1}->0`);
    }
    summaries.set(node.id, allowed);
  }
  return summaries;
}

/** The diamond symbol of a value, if that value is defined by a ♦-source. */
function diamondSymbolOf(
  value: ValueId,
  def: ReadonlyMap<ValueId, NodeId>,
  nodes: ReadonlyMap<NodeId, DucNode>,
): string | undefined {
  const definer = def.get(value);
  if (definer === undefined) return undefined;
  return nodes.get(definer)?.diamond?.symbol;
}

/** A block's external unknowns: usupp minus symbols resolved by internal sub-block calls. */
function externalUnknowns(graph: DucGraph, internal: ReadonlySet<string>): ProgramUnknown[] {
  const seen = new Map<string, ProgramUnknown>();
  for (const supports of usuppOfObservations(graph).values()) {
    for (const support of supports) {
      const { symbol, reason, module } = support.label;
      if (internal.has(symbol)) continue; // resolved by composition — not external
      if (!seen.has(symbol)) {
        seen.set(symbol, { symbol, reason, ...(module !== undefined ? { module } : {}) });
      }
    }
  }
  return [...seen.values()];
}

// Sub-block composition references: `import type { ... } from "<sub-block spec>"`
// where the specifier is a relative or seed/blocks path (mirrors resolve.ts).
const SUB_BLOCK_IMPORT_RE =
  /^import\s+type\s+\{([^}]*)\}\s+from\s+["'](?:\.\/|@yakcc\/seeds\/|@yakcc\/blocks\/)[^"']*["'];?\s*$/;

/** The local binding names imported from sub-blocks (the internal call symbols). */
function internalSubBlockSymbols(source: string): Set<string> {
  const names = new Set<string>();
  for (const line of source.split("\n")) {
    const match = line.match(SUB_BLOCK_IMPORT_RE);
    if (match === null) continue;
    for (const raw of (match[1] ?? "").split(",")) {
      // Handle `A` and `A as B` — the local binding is the last identifier.
      const parts = raw.trim().split(/\s+as\s+/);
      const local = (parts[parts.length - 1] ?? "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(local)) names.add(local);
    }
  }
  return names;
}

const EXPORT_FN_RE = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
const EXPORT_CONST_RE = /export\s+const\s+([A-Za-z_$][\w$]*)/;

/** The primary exported binding name of a block, or null. */
function primaryExportName(source: string): string | null {
  return source.match(EXPORT_FN_RE)?.[1] ?? source.match(EXPORT_CONST_RE)?.[1] ?? null;
}
