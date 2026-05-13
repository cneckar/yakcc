// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/topological-sort-kahns/reference-impl.ts
//
// @decision DEC-V0-B4-TASKS-EXPAND-001
// @title B4 Slice 2 task corpus: topological-sort-kahns reference implementation
// @status accepted
// @rationale
//   Reference implementation for oracle validation. Proves the oracle tests correctly
//   distinguish correct Kahn's-algorithm from broken DFS-based or in-degree-miscounted
//   implementations. Hand-written; not LLM-generated (DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001).
//
//   Adversarial trap: models use DFS-based sort (produces valid ordering but wrong
//   pattern), miss nodes with zero out-degree in in-degree computation, or skip cycle
//   detection. Deterministic ascending-queue ordering is the discriminating test.

/**
 * Topological sort using Kahn's algorithm.
 *
 * @param graph - Adjacency list: Map<node, neighbors[]> where edges point FROM node TO neighbor.
 *                Every node must appear as a key, even with empty neighbor list.
 * @returns Topologically sorted array of nodes, or null if the graph contains a cycle.
 */
export function topologicalSort(graph: Map<number, number[]>): number[] | null {
  const nodes = Array.from(graph.keys());
  const nodeCount = nodes.length;

  if (nodeCount === 0) return [];

  // Step 1: Compute in-degree for every node
  const inDegree = new Map<number, number>();
  for (const node of nodes) {
    if (!inDegree.has(node)) inDegree.set(node, 0);
    for (const neighbor of graph.get(node) ?? []) {
      inDegree.set(neighbor, (inDegree.get(neighbor) ?? 0) + 1);
    }
  }

  // Step 2: Initialize queue with zero-in-degree nodes, sorted ascending for determinism
  const queue: number[] = nodes
    .filter((n) => (inDegree.get(n) ?? 0) === 0)
    .sort((a, b) => a - b);

  const result: number[] = [];

  // Step 3: Queue drain
  while (queue.length > 0) {
    // Dequeue from front (FIFO)
    const node = queue.shift()!;
    result.push(node);

    // Reduce in-degree of neighbors
    const neighbors = graph.get(node) ?? [];
    for (const neighbor of neighbors) {
      const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        // Insert in ascending sorted position for determinism
        let inserted = false;
        for (let i = 0; i < queue.length; i++) {
          if (neighbor < queue[i]!) {
            queue.splice(i, 0, neighbor);
            inserted = true;
            break;
          }
        }
        if (!inserted) queue.push(neighbor);
      }
    }
  }

  // Step 4: Cycle detection
  if (result.length !== nodeCount) {
    return null; // cycle detected
  }

  return result;
}
