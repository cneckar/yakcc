# Task: Topological Sort (Kahn's Algorithm)

Implement a TypeScript function `topologicalSort` that performs a topological sort of a directed acyclic graph using Kahn's algorithm:

```typescript
function topologicalSort(graph: Map<number, number[]>): number[] | null;
```

## Requirements

1. **Input format**: The graph is an adjacency list represented as a `Map<number, number[]>`. Keys are node IDs; values are arrays of nodes that the key node has directed edges TO (i.e., dependencies of the key). Every node in the graph MUST appear as a key, even if it has no outgoing edges (empty array `[]`).
2. **Output**: Return a valid topological ordering of all nodes as an array. If the graph has a cycle, return `null`.
3. **Kahn's algorithm**: The implementation MUST use Kahn's algorithm (in-degree counting + queue drain), NOT DFS-based sorting. This is enforced because the oracle tests the intermediate state of the algorithm.
4. **In-degree computation**: Before queue processing, compute in-degree for every node in the graph.
5. **Queue initialization**: Add all nodes with in-degree 0 to the queue. Process in ascending numeric order (sort the initial zero-in-degree nodes before enqueuing to ensure determinism).
6. **Queue drain**: Repeatedly dequeue a node (take from front), add it to result, and for each neighbor: decrement in-degree; if in-degree becomes 0, enqueue it (maintain ascending order in queue for determinism).
7. **Cycle detection**: If the result length < number of nodes in graph, a cycle exists — return `null`.
8. **Empty graph**: `topologicalSort(new Map())` → `[]`.

## Export

Export the function as a named export:

```typescript
export { topologicalSort };
```

## Notes

- Do not use external libraries. Pure TypeScript, no dependencies.
- The implementation must be a single `.ts` file.
- Node IDs are non-negative integers.
- The queue must process nodes in ascending numeric order for deterministic output — sort the initial zero-in-degree nodes ascending, and insert newly-zero nodes in sorted position.
