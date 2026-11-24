// SPDX-License-Identifier: MIT
/**
 * graph-search.test.ts — graph search over the registry (#1280, DEC-COMPILE-GRAPH-SEARCH-001).
 *
 * Production sequence: openRegistry → storeDucImplementation(packGraph(lift), retrievalSignature)
 *   → searchGraphs(registry, queryGraph) → the stored structure, selected structurally, as line form.
 */
import { createOfflineEmbeddingProvider } from "@yakcc/contracts";
import {
  type DucGraph,
  graphIdentity,
  liftAtom,
  packGraph,
  printLineForm,
  retrievalSignature,
} from "@yakcc/duc";
import { openRegistry } from "@yakcc/registry";
import type { Registry } from "@yakcc/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchGraphs } from "./graph-search.js";

const ATOMS: Record<string, string> = {
  clamp:
    "export function clamp(x: number, lo: number, hi: number): number { if (x < lo) return lo; if (x > hi) return hi; return x; }",
  scale: "export function scale(a: number, b: number): number { return a * b + 1; }",
  mean: "export function mean(xs: number[]): number { let s = 0; for (const x of xs) s += x; return s / xs.length; }",
  pad: "export function pad(s: string, n: number): string { return s.length >= n ? s : pad(' ' + s, n); }",
  label:
    "export function label(n: number): string { return n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero'; }",
};

let registry: Registry;
const graphs = new Map<string, DucGraph>();

beforeAll(async () => {
  registry = await openRegistry(":memory:", { embeddings: createOfflineEmbeddingProvider() });
  for (const [name, source] of Object.entries(ATOMS)) {
    const graph = liftAtom(source);
    graphs.set(name, graph);
    const packed = packGraph(graph);
    await registry.storeDucImplementation({
      specHash: `spec-${name}`,
      graphIdentity: packed.identity,
      graphRoot: packed.root,
      formatVersion: packed.formatVersion,
      lifterVersion: packed.lifterVersion,
      structure: packed.structure,
      links: packed.links,
      signature: retrievalSignature(graph),
    });
  }
});

afterAll(async () => {
  await registry.close();
});

describe("graph search over the registry (#1280)", () => {
  it("an atom's own graph is found first, as an exact match, with its line form", async () => {
    for (const [name, graph] of graphs) {
      const [best] = await searchGraphs(registry, graph);
      expect(best?.graphIdentity).toBe(graphIdentity(graph));
      expect(best?.exact).toBe(true);
      expect(best?.structuralDistance).toBe(0);
      expect(best?.specHashes).toEqual([`spec-${name}`]);
      expect(best?.lineForm).toBe(printLineForm(graph));
    }
  });

  it("a rewritten query selects the original by structure", async () => {
    // scale with a redundant `+ 0`: a different identity, structurally nearest the original.
    const rewritten = liftAtom(
      "export function scale(p: number, q: number): number { return p * q + 0 + 1; }",
    );
    const results = await searchGraphs(registry, rewritten);
    expect(results[0]?.graphIdentity).toBe(graphIdentity(graphs.get("scale") as DucGraph));
    expect(results[0]?.exact).toBe(false);
    expect(results[0]?.structuralDistance).toBeGreaterThan(0);
    // Every result after the first is no nearer in structure.
    for (const r of results.slice(1)) {
      expect(r.structuralDistance).toBeGreaterThanOrEqual(results[0]?.structuralDistance ?? 1);
    }
  });

  it("takes the query as line form", async () => {
    const clamp = graphs.get("clamp") as DucGraph;
    const [best] = await searchGraphs(registry, printLineForm(clamp), { k: 3 });
    expect(best?.graphIdentity).toBe(graphIdentity(clamp));
    expect(best?.exact).toBe(true);
  });
});
