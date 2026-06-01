Implement Dijkstra's shortest-path algorithm backed by an inline binary min-heap.

Export:

```typescript
/** Thrown when a negative edge weight is added. */
export class NegativeWeightError extends Error {
  constructor(u: string, v: string, weight: number);
}

export interface ShortestPathResult {
  /** Total distance src→dst. Infinity if dst is unreachable. */
  distance: number;
  /** Node sequence [src, ..., dst]. Empty array if unreachable. */
  path: string[];
}

export class Graph {
  /**
   * Add a directed edge u→v with the given non-negative weight.
   * @throws {NegativeWeightError} if weight < 0.
   */
  addEdge(u: string, v: string, weight: number): void;

  /**
   * Return the shortest path from src to dst.
   * If src === dst, returns { distance: 0, path: [src] }.
   * If dst is unreachable, returns { distance: Infinity, path: [] }.
   */
  shortestPath(src: string, dst: string): ShortestPathResult;

  /**
   * Return a Map<node, distance> for every known node.
   * src has distance 0; unreachable nodes have distance Infinity.
   */
  shortestDistances(src: string): Map<string, number>;
}
```

**Requirements:**
- Implement the priority queue as a **binary min-heap** (0-based array layout) defined inline in the same file — do NOT use a library or a sorted array.
  - `siftUp`: swap with parent `floor((i-1)/2)` while child < parent.
  - `siftDown`: swap with the **smaller of the two children** (not just the left child) until the heap property holds.
- Handle **decrease-key** via **lazy deletion**: when a shorter path to a node is found, push a new entry and skip stale entries during `pop` (check if the popped priority > best known distance for that node).
- Nodes are strings. Edges are directed. For undirected graphs, callers call `addEdge` twice.
- Reject negative weights with a typed `NegativeWeightError` thrown from `addEdge`.

**Adversarial traps:**
1. **Heap sift-down bug** — Haiku commonly compares against only the left child, not `min(left, right)`. This makes the heap non-minimal on certain inputs.
2. **Missing decrease-key** — Without lazy deletion, when a shorter path is found for a node already in the heap, the stale entry wins and produces wrong distances.
3. **O(V²) fallback** — Scanning unvisited nodes in a linear array instead of a heap is disqualifying.
4. **Unreachable node crash** — Must return `Infinity` / `[]`, not throw or return `undefined`.
5. **Negative weight silent corruption** — Must throw `NegativeWeightError`, not silently continue.
