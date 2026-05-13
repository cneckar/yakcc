// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/topological-sort-kahns/oracle.test.ts
//
// @decision DEC-V0-B4-TASKS-EXPAND-001
// @title B4 Slice 2 oracle: topological sort (Kahn's algorithm)
// @status accepted
// @rationale
//   Oracle tests for semantic-equivalence verification. Must pass against reference-impl.ts
//   before Slice 2 measures LLM-generated implementations. Tests cover: empty graph,
//   linear chains, diamond DAGs, multi-root graphs, cycle detection, and adversarial
//   inputs (nodes with no outgoing edges, all-same in-degree graphs, large fan-out).
//   Deterministic ordering requirement (ascending queue) is the key discriminator.
//
// Usage:
//   vitest run --config bench/B4-tokens/vitest.config.mjs bench/B4-tokens/tasks/topological-sort-kahns/oracle.test.ts

import { describe, expect, it, beforeEach } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const implPath = process.env["IMPL_PATH"]
  ? resolve(process.env["IMPL_PATH"])
  : resolve(__dirname, "reference-impl.ts");

const implUrl = pathToFileURL(implPath).href;

let topologicalSort: (graph: Map<number, number[]>) => number[] | null;

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  topologicalSort = mod.topologicalSort ?? mod.default;
  if (typeof topologicalSort !== "function") {
    throw new Error(
      `Implementation at ${implPath} must export topologicalSort as a named or default export function`
    );
  }
});

// Helper: verify a result is a valid topological ordering of the given graph
function isValidTopologicalOrder(graph: Map<number, number[]>, order: number[]): boolean {
  const pos = new Map<number, number>();
  for (let i = 0; i < order.length; i++) pos.set(order[i]!, i);
  for (const [node, neighbors] of graph) {
    for (const neighbor of neighbors) {
      if ((pos.get(node) ?? -1) >= (pos.get(neighbor) ?? Infinity)) return false;
    }
  }
  return true;
}

describe("topologicalSort — empty and trivial graphs", () => {
  it("empty graph: returns []", () => {
    expect(topologicalSort(new Map())).toEqual([]);
  });

  it("single node, no edges: returns [0]", () => {
    const g = new Map([[0, []]]);
    expect(topologicalSort(g)).toEqual([0]);
  });

  it("two nodes, no edges: returns [0, 1] (ascending)", () => {
    const g = new Map([[0, []], [1, []]]);
    expect(topologicalSort(g)).toEqual([0, 1]);
  });

  it("two nodes with edge 0→1: [0, 1]", () => {
    const g = new Map([[0, [1]], [1, []]]);
    expect(topologicalSort(g)).toEqual([0, 1]);
  });

  it("two nodes with edge 1→0: [1, 0]", () => {
    const g = new Map([[0, []], [1, [0]]]);
    expect(topologicalSort(g)).toEqual([1, 0]);
  });
});

describe("topologicalSort — linear chains", () => {
  it("linear chain 0→1→2→3: [0,1,2,3]", () => {
    const g = new Map([[0, [1]], [1, [2]], [2, [3]], [3, []]]);
    expect(topologicalSort(g)).toEqual([0, 1, 2, 3]);
  });

  it("linear chain 3→2→1→0 (reverse numbering): [3,2,1,0]", () => {
    const g = new Map([[3, [2]], [2, [1]], [1, [0]], [0, []]]);
    expect(topologicalSort(g)).toEqual([3, 2, 1, 0]);
  });

  it("5-node chain: valid ordering", () => {
    const g = new Map([[0, [1]], [1, [2]], [2, [3]], [3, [4]], [4, []]]);
    const result = topologicalSort(g);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(5);
    expect(isValidTopologicalOrder(g, result!)).toBe(true);
  });
});

describe("topologicalSort — diamond and multi-path DAGs", () => {
  it("diamond: 0→1, 0→2, 1→3, 2→3", () => {
    // 0 must come first, 3 must come last
    const g = new Map([[0, [1, 2]], [1, [3]], [2, [3]], [3, []]]);
    const result = topologicalSort(g);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4);
    expect(isValidTopologicalOrder(g, result!)).toBe(true);
    expect(result![0]).toBe(0);
    expect(result![3]).toBe(3);
  });

  it("diamond determinism: 1 comes before 2 (ascending queue)", () => {
    // With ascending queue: after processing 0, enqueue {1,2} → [1,2].
    // Process 1 → enqueue 3 if its in-degree hits 0 (not yet, 2→3 still pending).
    // Process 2 → 3's in-degree hits 0, enqueue 3. Result: [0,1,2,3].
    const g = new Map([[0, [1, 2]], [1, [3]], [2, [3]], [3, []]]);
    expect(topologicalSort(g)).toEqual([0, 1, 2, 3]);
  });

  it("W-shape: 0→2, 1→2, 0→3, 1→4, 2→5, 3→5, 4→5", () => {
    const g = new Map([
      [0, [2, 3]],
      [1, [2, 4]],
      [2, [5]],
      [3, [5]],
      [4, [5]],
      [5, []],
    ]);
    const result = topologicalSort(g);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(6);
    expect(isValidTopologicalOrder(g, result!)).toBe(true);
  });
});

describe("topologicalSort — multi-root graphs", () => {
  it("two independent roots: ascending root order", () => {
    // Nodes 0 and 5 both have in-degree 0; ascending queue: [0, 5]
    const g = new Map([[0, [1]], [1, []], [5, [6]], [6, []]]);
    const result = topologicalSort(g);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4);
    expect(isValidTopologicalOrder(g, result!)).toBe(true);
    expect(result![0]).toBe(0);
    expect(result![2]).toBe(5);
  });

  it("three independent singleton nodes: [0,1,2]", () => {
    const g = new Map([[0, []], [1, []], [2, []]]);
    expect(topologicalSort(g)).toEqual([0, 1, 2]);
  });
});

describe("topologicalSort — cycle detection", () => {
  it("simple self-loop (0→0): returns null", () => {
    const g = new Map([[0, [0]]]);
    expect(topologicalSort(g)).toBeNull();
  });

  it("two-node cycle (0→1, 1→0): returns null", () => {
    const g = new Map([[0, [1]], [1, [0]]]);
    expect(topologicalSort(g)).toBeNull();
  });

  it("three-node cycle (0→1→2→0): returns null", () => {
    const g = new Map([[0, [1]], [1, [2]], [2, [0]]]);
    expect(topologicalSort(g)).toBeNull();
  });

  it("cycle with acyclic prefix: cycle part returns null", () => {
    // 0→1 (acyclic), 1→2→3→1 (cycle)
    const g = new Map([[0, [1]], [1, [2]], [2, [3]], [3, [1]]]);
    expect(topologicalSort(g)).toBeNull();
  });

  it("large cycle: returns null", () => {
    // 0→1→2→3→4→5→0
    const g = new Map([[0, [1]], [1, [2]], [2, [3]], [3, [4]], [4, [5]], [5, [0]]]);
    expect(topologicalSort(g)).toBeNull();
  });
});

describe("topologicalSort — adversarial: nodes with no outgoing edges", () => {
  it("sink nodes (no outgoing edges) must appear in result", () => {
    // 0→1, 0→2, 1→3, 2→4; nodes 3 and 4 are sinks
    const g = new Map([[0, [1, 2]], [1, [3]], [2, [4]], [3, []], [4, []]]);
    const result = topologicalSort(g);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(5);
    expect(result!.includes(3)).toBe(true);
    expect(result!.includes(4)).toBe(true);
    expect(isValidTopologicalOrder(g, result!)).toBe(true);
  });

  it("all nodes are sinks (no edges at all): ascending order", () => {
    const g = new Map([[2, []], [0, []], [4, []], [1, []], [3, []]]);
    expect(topologicalSort(g)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("topologicalSort — result completeness", () => {
  it("result contains all nodes in graph", () => {
    const g = new Map([[0, [2]], [1, [2]], [2, [3]], [3, []]]);
    const result = topologicalSort(g);
    expect(result).not.toBeNull();
    expect(new Set(result!)).toEqual(new Set([0, 1, 2, 3]));
  });

  it("result has no duplicates", () => {
    const g = new Map([[0, [1, 2]], [1, [3]], [2, [3]], [3, []]]);
    const result = topologicalSort(g);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(new Set(result!).size);
  });
});
