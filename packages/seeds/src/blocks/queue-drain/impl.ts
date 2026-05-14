// SPDX-License-Identifier: MIT
//
// @decision DEC-V0-B4-SEED-queue-drain-001
// @title queue-drain: BFS drain primitive for Kahn's topological sort
// @status accepted
// @rationale
//   The dependency-resolver B4 task requires a topological sort as its core
//   algorithm. Kahn's algorithm (1962) is the standard BFS-based approach:
//   maintain a queue of zero-in-degree nodes, drain it while decrementing
//   successor in-degrees, enqueue newly-zero successors. This atom is the
//   inner drain loop, extracted so the caller handles initialisation (computing
//   initial in-degrees and seeding the queue with zero-in-degree nodes).
//
//   Design decisions:
//   (A) MUTATION CONTRACT: queue, inDegree are mutated in-place. The caller
//       owns these data structures and passes them in. This avoids allocating
//       a copy of potentially large structures inside the atom, keeping the
//       space complexity O(1) additional beyond what the caller already holds.
//
//   (B) CALLBACK VISITOR: onVisit is a callback rather than accumulating a
//       result array. This lets callers choose their own output structure
//       (array push, string concat, direct emit) without forcing an allocation
//       inside the atom. It also makes the atom composable with streaming
//       consumers.
//
//   (C) VISIT COUNT RETURN: Returning visitCount rather than a boolean lets the
//       caller determine whether a cycle exists (visitCount < |V|) AND how many
//       nodes were processed, both of which may be useful.
//
//   (D) ADJACENCY MAP OPTIONAL LOOKUP: adjacency.get(node) may return undefined
//       if the node has no outgoing edges. The guard `?? []` handles this
//       without requiring every leaf node to have an explicit empty-array entry.
//
//   Reference: Kahn, A.B. (1962). "Topological sorting of large networks."
//   Communications of the ACM, 5(11), 558-562.

/**
 * Drain a BFS queue using Kahn's topological sort algorithm.
 *
 * Processes every node currently in queue and any nodes whose in-degree drops
 * to zero as a result. Mutates both queue and inDegree in-place.
 *
 * @param queue     - Initial zero-in-degree nodes. Consumed and extended in-place.
 * @param inDegree  - In-degree for every node. Decremented as predecessors are visited.
 * @param adjacency - Outgoing neighbour lists. Missing entries treated as empty.
 * @param onVisit   - Called once per visited node in topological order.
 * @returns Number of nodes visited. Less than |V| iff the graph has a cycle.
 */
export function queueDrain(
  queue: string[],
  inDegree: Map<string, number>,
  adjacency: Map<string, string[]>,
  onVisit: (node: string) => void,
): number {
  let visitCount = 0;

  while (queue.length > 0) {
    // shift() removes from the front -- FIFO BFS order
    const node = queue.shift() as string;
    onVisit(node);
    visitCount++;

    const neighbours = adjacency.get(node) ?? [];
    for (const v of neighbours) {
      const deg = (inDegree.get(v) ?? 0) - 1;
      inDegree.set(v, deg);
      if (deg === 0) {
        queue.push(v);
      }
    }
  }

  return visitCount;
}
