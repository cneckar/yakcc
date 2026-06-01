// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/tasks-hard/dijkstra-heap/reference-impl.ts
//
// Dijkstra's shortest-path algorithm backed by an inline binary min-heap.
// No external libraries; the heap is implemented from scratch.
//
// @decision DEC-BENCH-B4-V5-HARD-TASKS-001
// title: Dijkstra + inline binary min-heap reference
// status: accepted
// rationale: Three distinct Haiku failure modes compound here:
//   (1) Heap correctness: Haiku commonly gets sift-down wrong (comparing
//       parent against only one child instead of the smaller of both, or
//       using 1-based index arithmetic when the array is 0-based).
//   (2) Decrease-key handling: a correct Prims/Dijkstra needs decrease-key
//       or lazy deletion. Haiku often implements neither, leading to stale
//       entries being processed and wrong distances for graphs with
//       multiple paths to the same node.
//   (3) O(V²) fallback: Haiku sometimes just scans the unvisited set
//       linearly (correct but doesn't satisfy "backed by a binary min-heap").
//   (4) Negative-weight rejection: must throw a typed error, not silently
//       produce garbage distances.
//   (5) Unreachable node handling: must return Infinity for distance and
//       empty path, not crash or return undefined.

// ── Typed errors ───────────────────────────────────────────────────────────

/** Thrown when a negative edge weight is added to the graph. */
export class NegativeWeightError extends Error {
  constructor(u: string, v: string, weight: number) {
    super(
      `NegativeWeightError: edge ${u}→${v} has negative weight ${weight}. ` +
      'Dijkstra requires non-negative weights.',
    );
    this.name = 'NegativeWeightError';
  }
}

// ── Binary min-heap ────────────────────────────────────────────────────────
//
// Stores (priority, value) pairs. Lower priority = higher precedence.
// 0-based array layout: parent of i is floor((i-1)/2);
//   children of i are 2i+1 and 2i+2.
//
// Uses LAZY DELETION to handle decrease-key:
// New (lower-priority) entries are pushed; stale (higher-priority) entries
// for the same node are discarded during pop via the `valid` callback.

interface HeapEntry {
  priority: number; // tentative distance
  node: string;
}

class MinHeap {
  private data: HeapEntry[] = [];

  get size(): number {
    return this.data.length;
  }

  push(entry: HeapEntry): void {
    this.data.push(entry);
    this.siftUp(this.data.length - 1);
  }

  /** Remove and return the entry with the smallest priority. */
  pop(): HeapEntry | undefined {
    if (this.data.length === 0) return undefined;
    // Swap root with last element, then shrink.
    this.swap(0, this.data.length - 1);
    const min = this.data.pop()!;
    if (this.data.length > 0) this.siftDown(0);
    return min;
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1; // floor((i-1)/2)
      if (this.data[parent].priority <= this.data[i].priority) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const left  = 2 * i + 1;
      const right = 2 * i + 2;

      if (left  < n && this.data[left].priority  < this.data[smallest].priority) {
        smallest = left;
      }
      if (right < n && this.data[right].priority < this.data[smallest].priority) {
        smallest = right;
      }

      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const tmp = this.data[a];
    this.data[a] = this.data[b];
    this.data[b] = tmp;
  }
}

// ── Adjacency list ─────────────────────────────────────────────────────────

interface Edge {
  to: string;
  weight: number;
}

// ── Graph ──────────────────────────────────────────────────────────────────

/** Result of a single-source-to-destination query. */
export interface ShortestPathResult {
  /** Total distance from source to destination. Infinity if unreachable. */
  distance: number;
  /** Node sequence from source to destination (inclusive). Empty if unreachable. */
  path: string[];
}

/**
 * Directed weighted graph with Dijkstra shortest-path backed by a binary min-heap.
 *
 * All edge weights must be non-negative (Dijkstra's requirement).
 * Undirected graphs can be modelled by calling addEdge twice (both directions).
 */
export class Graph {
  private adj: Map<string, Edge[]> = new Map();

  // ── graph construction ─────────────────────────────────────────────

  /**
   * Add a directed edge from u to v with the given weight.
   * @throws {NegativeWeightError} if weight < 0.
   */
  addEdge(u: string, v: string, weight: number): void {
    if (weight < 0) throw new NegativeWeightError(u, v, weight);

    if (!this.adj.has(u)) this.adj.set(u, []);
    if (!this.adj.has(v)) this.adj.set(v, []); // ensure v is a known node

    this.adj.get(u)!.push({ to: v, weight });
  }

  // ── Dijkstra: single destination ──────────────────────────────────

  /**
   * Return the shortest distance and path from src to dst.
   * If dst is unreachable from src, returns { distance: Infinity, path: [] }.
   * If src === dst, returns { distance: 0, path: [src] }.
   */
  shortestPath(src: string, dst: string): ShortestPathResult {
    const { dist, prev } = this.dijkstra(src);

    const distance = dist.get(dst) ?? Infinity;
    if (distance === Infinity) return { distance: Infinity, path: [] };

    // Reconstruct path by following prev pointers from dst → src.
    const path: string[] = [];
    let cur: string | undefined = dst;
    while (cur !== undefined) {
      path.push(cur);
      cur = prev.get(cur);
    }
    path.reverse();

    return { distance, path };
  }

  // ── Dijkstra: all reachable distances from src ─────────────────────

  /**
   * Return a Map<node, distance> for all nodes reachable from src.
   * Unreachable (but known) nodes appear with distance Infinity.
   * The src node itself has distance 0.
   */
  shortestDistances(src: string): Map<string, number> {
    const { dist } = this.dijkstra(src);
    return dist;
  }

  // ── core Dijkstra implementation ───────────────────────────────────

  private dijkstra(src: string): {
    dist: Map<string, number>;
    prev: Map<string, string | undefined>;
  } {
    // Initialise distances for all known nodes.
    const dist = new Map<string, number>();
    const prev = new Map<string, string | undefined>();

    for (const node of this.adj.keys()) {
      dist.set(node, Infinity);
      prev.set(node, undefined);
    }

    // src might not be in adj if it was only ever a destination
    if (!dist.has(src)) {
      dist.set(src, Infinity);
      prev.set(src, undefined);
    }
    dist.set(src, 0);

    const heap = new MinHeap();
    heap.push({ priority: 0, node: src });

    while (heap.size > 0) {
      const entry = heap.pop()!;
      const { priority: d, node: u } = entry;

      // Lazy-deletion: skip stale entries.
      // A stale entry is one whose priority is greater than the best known
      // distance for this node (we already found a shorter path).
      const knownDist = dist.get(u) ?? Infinity;
      if (d > knownDist) continue;

      const neighbours = this.adj.get(u) ?? [];
      for (const { to: v, weight } of neighbours) {
        const alt = d + weight;
        const vDist = dist.get(v) ?? Infinity;
        if (alt < vDist) {
          dist.set(v, alt);
          prev.set(v, u);
          // Push a new (better) entry; the old one will be lazily discarded.
          heap.push({ priority: alt, node: v });
        }
      }
    }

    return { dist, prev };
  }
}
