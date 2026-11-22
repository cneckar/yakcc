// SPDX-License-Identifier: Apache-2.0
/**
 * The retrieval signature: the deterministic text an atom is embedded from (#1275, item 3).
 *
 * It is built from what minimization preserves and what a model is likely to vary. It leaves out
 * local names, statement order and comments. It keeps the signature shape, the influence matrix
 * (which parameters can affect which results), the operation and literal histograms, the platform
 * primitives used, the unlinked names, and the control shape. The text is fixed-order, so the same
 * structure always gives the same text.
 *
 * Embeddings are an index over this text. Selection is a structural check, never a similarity score.
 */
import { mayInfluence } from "./influence.js";
import type { DucGraph } from "./types.js";

export interface RetrievalSignatureOptions {
  /** The intent text from the spec, if any. */
  readonly intent?: string;
}

function histogram(items: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([label, n]) => `${JSON.stringify(label)}x${n}`)
    .join(" ");
}

function sortedUnique(items: readonly string[]): string {
  return [...new Set(items)].sort().map((s) => JSON.stringify(s)).join(" ");
}

export function retrievalSignature(g: DucGraph, options: RetrievalSignatureOptions = {}): string {
  const params = g.nodes.filter((n) => n.kind === "param-source");
  const paramValues = params.map((n) => n.outputs[0]);
  const obs = g.obs;

  const influence: string[] = [];
  paramValues.forEach((p, i) => {
    obs.forEach((o, j) => {
      // A parameter returned directly is an identity flow: mayInfluence is irreflexive, so count it here.
      if (p !== undefined && (p === o || mayInfluence(g, p, o))) influence.push(`p${i}>o${j}`);
    });
  });

  // An opaque node's label ends in a content hash, which is noise for retrieval: keep its kind.
  const ops = g.nodes
    .filter((n) => n.kind === "op")
    .map((n) => (n.label ?? n.origin?.kind ?? "op").replace(/#[0-9a-f]+$/, ""));
  const literals = g.nodes
    .filter((n) => n.kind === "literal-source")
    .map((n) => n.label ?? "");
  const diamonds = g.nodes.filter((n) => n.diamond !== undefined).map((n) => n.diamond);
  const primitives = diamonds.filter((d) => d?.reason === "platform-primitive").map((d) => d?.symbol ?? "");
  const unlinked = diamonds.filter((d) => d?.reason !== "platform-primitive").map((d) => d?.symbol ?? "");
  const sel = g.nodes.filter((n) => n.kind === "sel").length;
  const loop = g.nodes.filter((n) => n.kind === "loop").length;

  const lines: string[] = [];
  if (options.intent !== undefined) lines.push(`intent: ${options.intent}`);
  lines.push(`arity: ${params.length} in ${obs.length} out`);
  lines.push(`influence: ${influence.join(" ") || "none"}`);
  lines.push(`ops: ${histogram(ops) || "none"}`);
  lines.push(`literals: ${histogram(literals) || "none"}`);
  lines.push(`primitives: ${sortedUnique(primitives) || "none"}`);
  lines.push(`unlinked: ${sortedUnique(unlinked) || "none"}`);
  lines.push(`control: sel=${sel} loop=${loop}`);
  return `${lines.join("\n")}\n`;
}
