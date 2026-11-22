// SPDX-License-Identifier: Apache-2.0
//
// @decision DEC-DUC-CHECKER-SPEC-001 (wi-guard A3, GH #1256)
// Declarative checker specifications (GFP §6, adapted). A checker names its sources,
// its sinks, and its declared sanitizers. A finding is a flow from a source to a sink
// call that no declared sanitizer cuts. The spec is data: content-addressed (a hash
// of its canonical JSON) and versioned, so it can be stored and reused like spec.yak.
//
// Sanitizers are declared, never inferred. A call that is not declared as a sanitizer
// does not cut a flow, however much it looks like a check. This is the soundness
// condition: DUC over-approximates, and a wrongly trusted sanitizer would hide a real
// flow. Findings are structural (may-reach through an undeclared path), not
// feasibility claims. Guard predicates are reported as annotations (A2).

import { createHash } from "node:crypto";
import { guardedFlows } from "./guard.js";
import { renderWitness, witness } from "./influence.js";
import type { DiamondReason, DucGraph, DucNode, NodeId, ValueId } from "./types.js";
import { defMap, nodeIndex } from "./types.js";

/** The checker spec schema version. */
export const CHECKER_SPEC_VERSION = 1 as const;

/** Where flows start. `param` is every parameter-source; `diamond` is a ♦-source. */
export type SourceSelector =
  | { readonly kind: "param" }
  | { readonly kind: "diamond"; readonly symbol?: string; readonly reason?: DiamondReason };

/** A declarative checker. */
export interface CheckerSpec {
  readonly name: string;
  readonly version: typeof CHECKER_SPEC_VERSION;
  readonly description?: string;
  readonly sources: readonly SourceSelector[];
  /** Callee symbols whose calls are sensitive sinks (e.g. "write", "eval"). */
  readonly sinks: readonly string[];
  /** Callee symbols declared as sanitizers. Only these cut a flow. */
  readonly sanitizers: readonly string[];
}

/** One flow from a source to a sink that no declared sanitizer cuts. */
export interface CheckerFinding {
  readonly sink: string;
  readonly sourceLabel: string;
  readonly node: NodeId;
  /** True iff some path reaches the sink argument with no branch (no guard). */
  readonly unguarded: boolean;
  /** Rendered guard predicates on the guarded paths (empty when unguarded). */
  readonly guards: readonly string[];
  /** Rendered provenance of the sink argument: where the source enters. */
  readonly witness: string;
}

/** Validate a spec's structure. Returns the first violation, or null. */
export function validateCheckerSpec(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "not an object";
  const spec = value as Partial<CheckerSpec>;
  if (typeof spec.name !== "string" || spec.name.length === 0) return "name is required";
  if (spec.version !== CHECKER_SPEC_VERSION) return `unsupported version ${String(spec.version)}`;
  if (!Array.isArray(spec.sources) || spec.sources.length === 0)
    return "at least one source is required";
  for (const s of spec.sources) {
    if (s.kind !== "param" && s.kind !== "diamond")
      return `unknown source kind ${String((s as { kind?: unknown }).kind)}`;
  }
  if (!Array.isArray(spec.sinks) || spec.sinks.length === 0) return "at least one sink is required";
  if (!Array.isArray(spec.sanitizers)) return "sanitizers must be an array (may be empty)";
  return null;
}

/** The content address of a checker: a SHA-256 of its canonical JSON. */
export function checkerSpecHash(spec: CheckerSpec): string {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** The callee symbol of a call node: the ♦-symbol its first input is defined by. */
function calleeSymbolOf(
  node: DucNode,
  def: ReadonlyMap<ValueId, NodeId>,
  nodes: ReadonlyMap<NodeId, DucNode>,
): string | undefined {
  if (node.kind !== "op" || node.origin?.kind !== "CallExpression") return undefined;
  const callee = node.inputs[0];
  if (callee === undefined) return undefined;
  const definer = def.get(callee);
  if (definer === undefined) return undefined;
  return nodes.get(definer)?.diamond?.symbol;
}

/**
 * Run a checker over a lifted graph. For each selected source, every sink call whose
 * argument is reached from the source, along a path that no declared sanitizer cuts,
 * is a finding.
 */
export function runChecker(spec: CheckerSpec, graph: DucGraph): CheckerFinding[] {
  const def = defMap(graph);
  const nodes = nodeIndex(graph);
  const sinks = new Set(spec.sinks);
  const sanitizers = new Set(spec.sanitizers);

  // Sanitizer calls are barriers: their outputs are not reached through them.
  const blocked = (node: DucNode): boolean => {
    const callee = calleeSymbolOf(node, def, nodes);
    return callee !== undefined && sanitizers.has(callee);
  };

  const findings: CheckerFinding[] = [];
  for (const node of graph.nodes) {
    if (node.kind === "param-source") {
      if (!spec.sources.some((s) => s.kind === "param")) continue;
      for (const finding of findFrom(spec, graph, node, blocked, sinks, "param"))
        findings.push(finding);
    } else if (node.kind === "diamond-source" && node.diamond !== undefined) {
      const { symbol, reason } = node.diamond;
      const selected = spec.sources.some(
        (s) =>
          s.kind === "diamond" &&
          (s.symbol === undefined || s.symbol === symbol) &&
          (s.reason === undefined || s.reason === reason),
      );
      if (!selected) continue;
      for (const finding of findFrom(spec, graph, node, blocked, sinks, symbol))
        findings.push(finding);
    }
  }
  return findings;
}

function findFrom(
  _spec: CheckerSpec,
  graph: DucGraph,
  source: DucNode,
  blocked: (node: DucNode) => boolean,
  sinks: ReadonlySet<string>,
  sourceLabel: string,
): CheckerFinding[] {
  const out: CheckerFinding[] = [];
  const def = defMap(graph);
  const nodes = nodeIndex(graph);
  const src = source.outputs[0];
  if (src === undefined) return out;
  const flows = guardedFlows(graph, src, blocked);
  for (const node of graph.nodes) {
    const symbol = calleeSymbolOf(node, def, nodes);
    if (symbol === undefined || !sinks.has(symbol)) continue;
    // A sink's arguments are its inputs after the callee.
    for (const arg of node.inputs.slice(1)) {
      const flow = flows.get(arg);
      if (flow === undefined) continue;
      out.push({
        sink: symbol,
        sourceLabel,
        node: node.id,
        unguarded: flow.unguarded,
        guards: flow.guards.map((g) => renderWitness(witness(graph, g))),
        witness: renderWitness(witness(graph, arg)),
      });
      break; // one finding per sink call per source
    }
  }
  return out;
}
