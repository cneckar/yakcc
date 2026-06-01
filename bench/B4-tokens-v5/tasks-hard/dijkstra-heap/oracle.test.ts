// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/tasks-hard/dijkstra-heap/oracle.test.ts
//
// Oracle tests for the dijkstra-heap task (B4-v5-hard).
// Tests are deterministic and hand-authored per DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001.
// Load implementation via IMPL_PATH env var (defaults to reference-impl.ts).
//
// Adversarial coverage targets documented Haiku failure modes:
//   1. Heap sift-down bug: comparing against only one child (misses the minimum).
//   2. Lazy-deletion / decrease-key omission: stale heap entries cause wrong distances.
//   3. Unreachable node: must return Infinity / empty path, not crash.
//   4. Negative-weight edge: must throw NegativeWeightError.
//   5. src === dst trivial case: distance 0, path [src].

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const implPath = process.env['IMPL_PATH']
  ? resolve(process.env['IMPL_PATH'])
  : resolve(__dirname, 'reference-impl.ts');
const implUrl = pathToFileURL(implPath).href;

type GraphCtor = new () => {
  addEdge(u: string, v: string, weight: number): void;
  shortestPath(src: string, dst: string): { distance: number; path: string[] };
  shortestDistances(src: string): Map<string, number>;
};

let Graph: GraphCtor;

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  Graph = mod.Graph;
  if (typeof Graph !== 'function') {
    throw new Error(`Implementation at ${implPath} must export Graph as a named class`);
  }
});

// ── trivial cases ──────────────────────────────────────────────────────────

describe('dijkstra-heap — trivial cases', () => {
  it('src === dst: distance 0, path [src]', () => {
    const g = new Graph();
    g.addEdge('A', 'B', 1);
    const r = g.shortestPath('A', 'A');
    expect(r.distance).toBe(0);
    expect(r.path).toEqual(['A']);
  });

  it('single edge: direct path', () => {
    const g = new Graph();
    g.addEdge('A', 'B', 5);
    const r = g.shortestPath('A', 'B');
    expect(r.distance).toBe(5);
    expect(r.path).toEqual(['A', 'B']);
  });

  it('unreachable node: Infinity distance, empty path', () => {
    const g = new Graph();
    g.addEdge('A', 'B', 3);
    g.addEdge('C', 'D', 2);
    const r = g.shortestPath('A', 'D');
    expect(r.distance).toBe(Infinity);
    expect(r.path).toEqual([]);
  });
});

// ── negative-weight rejection ──────────────────────────────────────────────

describe('dijkstra-heap — negative weight rejection', () => {
  it('addEdge with negative weight throws', () => {
    const g = new Graph();
    expect(() => g.addEdge('A', 'B', -1)).toThrow();
    expect(() => g.addEdge('A', 'B', -1)).toThrowError(/negative/i);
  });

  it('zero-weight edge is allowed', () => {
    const g = new Graph();
    expect(() => g.addEdge('A', 'B', 0)).not.toThrow();
    const r = g.shortestPath('A', 'B');
    expect(r.distance).toBe(0);
    expect(r.path).toEqual(['A', 'B']);
  });
});

// ── simple 3-node graph ─────────────────────────────────────────────────────

describe('dijkstra-heap — simple 3-node directed graph', () => {
  // A →(1)→ B →(2)→ C
  // A →(4)→ C
  // Shortest A→C: A→B→C = 3, not A→C = 4.

  it('prefers multi-hop path when it is shorter', () => {
    const g = new Graph();
    g.addEdge('A', 'B', 1);
    g.addEdge('B', 'C', 2);
    g.addEdge('A', 'C', 4);
    const r = g.shortestPath('A', 'C');
    expect(r.distance).toBe(3);
    expect(r.path).toEqual(['A', 'B', 'C']);
  });

  it('shortestDistances returns correct map', () => {
    const g = new Graph();
    g.addEdge('A', 'B', 1);
    g.addEdge('B', 'C', 2);
    g.addEdge('A', 'C', 4);
    const d = g.shortestDistances('A');
    expect(d.get('A')).toBe(0);
    expect(d.get('B')).toBe(1);
    expect(d.get('C')).toBe(3);
  });
});

// ── 5-node graph (decrease-key / lazy-deletion test) ──────────────────────
//
// This is the canonical test for correct decrease-key / lazy-deletion:
// a node is first reached via one path, then a better path is discovered,
// and the shorter distance must win.

describe('dijkstra-heap — 5-node graph (decrease-key stress)', () => {
  // Graph (directed):
  //   S→A:10  S→B:1  B→A:1  A→T:1  B→T:15
  // Shortest S→T: S→B(1)→A(1+1=2)→T(2+1=3) = 3
  // Without decrease-key, S→A gets 10 first, then 2 should win.

  it('decrease-key: S→T via S→B→A→T = 3, not S→A→T = 11', () => {
    const g = new Graph();
    g.addEdge('S', 'A', 10);
    g.addEdge('S', 'B', 1);
    g.addEdge('B', 'A', 1);
    g.addEdge('A', 'T', 1);
    g.addEdge('B', 'T', 15);
    const r = g.shortestPath('S', 'T');
    expect(r.distance).toBe(3);
    expect(r.path).toEqual(['S', 'B', 'A', 'T']);
  });

  it('all distances from S are correct', () => {
    const g = new Graph();
    g.addEdge('S', 'A', 10);
    g.addEdge('S', 'B', 1);
    g.addEdge('B', 'A', 1);
    g.addEdge('A', 'T', 1);
    g.addEdge('B', 'T', 15);
    const d = g.shortestDistances('S');
    expect(d.get('S')).toBe(0);
    expect(d.get('B')).toBe(1);
    expect(d.get('A')).toBe(2);
    expect(d.get('T')).toBe(3);
  });
});

// ── 6-node graph (heap sift-down stress) ─────────────────────────────────
//
// Dijkstra on this graph requires the heap to correctly surface the minimum
// each time. A sift-down that only compares against one child will produce
// the wrong order on some step, leading to a wrong shortest path.

describe('dijkstra-heap — 6-node graph (heap correctness)', () => {
  // Nodes: 1..6 (as strings)
  // Edges chosen to force several heap restructures:
  //   1→2:7   1→3:9   1→6:14
  //   2→3:10  2→4:15
  //   3→4:11  3→6:2
  //   4→5:6
  //   6→5:9
  // Classic Dijkstra textbook graph.
  // Known shortest distances from "1":
  //   1→1:0  1→2:7  1→3:9  1→4:20  1→5:20  1→6:11

  function buildClassic(): InstanceType<GraphCtor> {
    const g = new Graph();
    g.addEdge('1', '2', 7);
    g.addEdge('1', '3', 9);
    g.addEdge('1', '6', 14);
    g.addEdge('2', '3', 10);
    g.addEdge('2', '4', 15);
    g.addEdge('3', '4', 11);
    g.addEdge('3', '6', 2);
    g.addEdge('4', '5', 6);
    g.addEdge('6', '5', 9);
    return g;
  }

  it('distance 1→2 = 7', () => {
    expect(buildClassic().shortestPath('1', '2').distance).toBe(7);
  });

  it('distance 1→3 = 9', () => {
    expect(buildClassic().shortestPath('1', '3').distance).toBe(9);
  });

  it('distance 1→6 = 11 (via 1→3→6, not direct 1→6=14)', () => {
    const r = buildClassic().shortestPath('1', '6');
    expect(r.distance).toBe(11);
    expect(r.path).toEqual(['1', '3', '6']);
  });

  it('distance 1→4 = 20 (via 1→3→4)', () => {
    const r = buildClassic().shortestPath('1', '4');
    expect(r.distance).toBe(20);
    expect(r.path).toEqual(['1', '3', '4']);
  });

  it('distance 1→5 = 20 (via 1→3→6→5)', () => {
    const r = buildClassic().shortestPath('1', '5');
    expect(r.distance).toBe(20);
    expect(r.path).toEqual(['1', '3', '6', '5']);
  });

  it('shortestDistances from "1" matches all expected values', () => {
    const d = buildClassic().shortestDistances('1');
    expect(d.get('1')).toBe(0);
    expect(d.get('2')).toBe(7);
    expect(d.get('3')).toBe(9);
    expect(d.get('4')).toBe(20);
    expect(d.get('5')).toBe(20);
    expect(d.get('6')).toBe(11);
  });
});

// ── directed vs undirected ─────────────────────────────────────────────────

describe('dijkstra-heap — directed: reverse path does not exist', () => {
  it('A→B exists but B→A does not (directed)', () => {
    const g = new Graph();
    g.addEdge('A', 'B', 3);
    const r = g.shortestPath('B', 'A');
    expect(r.distance).toBe(Infinity);
    expect(r.path).toEqual([]);
  });
});

// ── compound production-sequence test ─────────────────────────────────────

describe('dijkstra-heap — compound end-to-end', () => {
  it('builds graph incrementally and queries multiple paths', () => {
    const g = new Graph();
    // Undirected-style (add both directions)
    const edges: [string, string, number][] = [
      ['A', 'B', 4], ['B', 'A', 4],
      ['A', 'C', 2], ['C', 'A', 2],
      ['B', 'C', 1], ['C', 'B', 1],
      ['B', 'D', 5], ['D', 'B', 5],
      ['C', 'D', 8], ['D', 'C', 8],
      ['C', 'E', 10],['E', 'C', 10],
      ['D', 'E', 2], ['E', 'D', 2],
    ];
    for (const [u, v, w] of edges) g.addEdge(u, v, w);

    // A→E: A→C(2)→B(2+1=3)→D(3+5=8)→E(8+2=10)  OR  A→C(2)→E(2+10=12)
    // Shortest: A→C→B→D→E = 10
    const ae = g.shortestPath('A', 'E');
    expect(ae.distance).toBe(10);
    expect(ae.path[0]).toBe('A');
    expect(ae.path[ae.path.length - 1]).toBe('E');

    // A→D: A→C(2)→B(3)→D(8) = 8
    const ad = g.shortestPath('A', 'D');
    expect(ad.distance).toBe(8);

    // E→A: reverse of above, same distance
    const ea = g.shortestPath('E', 'A');
    expect(ea.distance).toBe(10);
  });
});
