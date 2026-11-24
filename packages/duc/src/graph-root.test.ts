// SPDX-License-Identifier: Apache-2.0
// A block's root commits to its graph (#1306): nothing that decides what the block computes can be
// swapped under a root. Each part — one node's label, one link's target, the format version, the
// contract, the proof — changes the root when it changes; a lift of the same graph gives the same root.
import { describe, expect, it } from "vitest";
import { liftAtom } from "./lift.js";
import { ducBlockRoot, graphRoot, packGraph } from "./store.js";
import type { DucGraph } from "./types.js";

const SPEC = "11".repeat(32);
const PROOF = "22".repeat(32);

/** The graph with each diamond for `helper` linked to a contract. */
function linked(g: DucGraph, spec: string): DucGraph {
  return {
    ...g,
    nodes: g.nodes.map((n) =>
      n.diamond?.symbol === "helper" ? { ...n, diamond: { ...n.diamond, spec } } : n,
    ),
  };
}

describe("a block's root commits to its graph (#1306)", () => {
  const source = "export function f(a) { return helper(a) + 1; }";
  const base = packGraph(linked(liftAtom(source), "aa".repeat(32)));
  const root = (p: { root: string }) => ducBlockRoot(SPEC, p.root, PROOF);

  it("is the same for the same graph, lifted again", () => {
    expect(packGraph(linked(liftAtom(source), "aa".repeat(32))).root).toBe(base.root);
  });
  it("changes with one node's label", () => {
    const other = packGraph(
      linked(liftAtom("export function f(a) { return helper(a) - 1; }"), "aa".repeat(32)),
    );
    expect(other.identity).not.toBe(base.identity);
    expect(root(other)).not.toBe(root(base));
  });
  it("changes with one link's target, though the structure (the identity) is the same", () => {
    const other = packGraph(linked(liftAtom(source), "bb".repeat(32)));
    expect(other.identity).toBe(base.identity);
    expect(other.root).not.toBe(base.root);
    expect(root(other)).not.toBe(root(base));
  });
  it("changes with the format version", () => {
    expect(graphRoot(base.identity, base.links, base.formatVersion + 1)).not.toBe(base.root);
  });
  it("changes with the contract and with the proof", () => {
    expect(ducBlockRoot("33".repeat(32), base.root, PROOF)).not.toBe(root(base));
    expect(ducBlockRoot(SPEC, base.root, "44".repeat(32))).not.toBe(root(base));
  });
  it("is BLAKE3 throughout: 32-byte digests", () => {
    expect(base.identity).toMatch(/^[0-9a-f]{64}$/);
    expect(base.root).toMatch(/^[0-9a-f]{64}$/);
    expect(root(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
