// SPDX-License-Identifier: MIT
//
// bench/B1-latency/http-routing/yakcc-as/source.ts
//
// @decision DEC-BENCH-B1-HTTP-AS-SOURCE-001
// @title Flat-memory u32-keyed trie in AssemblyScript (--runtime stub), sorted edges + binary search
// @status accepted
// @rationale
//   The AS-backend is constrained to --runtime stub: no GC, no managed strings.
//   HTTP routing requires string matching on path segments, which is incompatible
//   with --runtime stub's no-managed-strings constraint.
//
//   Resolution: all comparators (including this one) hash path segments to u32
//   OUTSIDE the timing loop. The WASM kernel receives a pre-flattened trie
//   (packed Uint32Array) and a pre-hashed query array. The inner loop is
//   pure u32 comparison — no string operations at all.
//
//   Edge layout: edges are SORTED by key (ascending u32). This enables O(log n)
//   binary search instead of O(n) linear scan. The root node has ~5K children
//   (one per unique first-segment hash); linear scan would degrade to O(5000)
//   per root lookup = ~500B operations total = 254ms. Binary search reduces this
//   to O(log 5000) = 13 comparisons per lookup = ~5ms expected.
//
//   PARAM_SENTINEL=1 and WILDCARD_SENTINEL=2 sort before all real segment hashes
//   (which are ≥3 per the hash function). We check for them separately as
//   edge[0] and edge[1] before binary-searching the sorted hash range [2..].
//   This avoids the need to scan-then-fallback.
//
//   Flat trie layout (written by host run.mjs, edges sorted ascending by key):
//
//   NODES_BASE: array of node records, each 8 x u32 = 32 bytes:
//     [0] edge_count      — number of outgoing edges
//     [1] edges_ptr       — index into EDGES array (first edge for this node)
//     [2] handler_id      — 0xFFFFFFFF = no handler; else route handler ID
//     [3] flags           — reserved
//     [4..7]              — reserved / padding
//
//   EDGES_BASE: array of edge records, each 2 x u32 = 8 bytes, SORTED by key:
//     [0] key             — u32 segment hash, sorted ascending
//     [1] target_node_idx — index into NODES array
//
//   QUERIES_BASE: array of query descriptors:
//     Each query: u32 seg_count, then seg_count x u32 hashes
//
//   Memory layout (set by host, AS --runtime stub exports its own memory):
//   [0..65535]         AS runtime page 0 (stack/internal)
//   [NODES_BASE..]    node records (NODES_BASE = 65536)
//   [EDGES_BASE..]    edge records
//   [QUERIES_BASE..]  pre-hashed queries
//
//   Exported functions:
//     matchAll(nodesPtr, nodesCount, edgesPtr, edgesCount, queriesPtr, queryCount):
//       returns packed i64: high 32 bits = matched_count, low 32 bits = total_captures

const PARAM_SENTINEL: u32    = 0x00000001;
const WILDCARD_SENTINEL: u32 = 0x00000002;
const NO_HANDLER: u32        = 0xFFFFFFFF;

// Node record size: 8 u32s = 32 bytes
const NODE_STRIDE: i32 = 8;  // u32 fields per node
// Edge record stride in bytes: 2 u32s = 8 bytes
const EDGE_BYTES: i32 = 8;

// ---------------------------------------------------------------------------
// Binary search: find edge with given key in sorted edge array [edgesBase + start*8 .. + count*8)
// Returns target_node_idx, or -1 if not found.
// ---------------------------------------------------------------------------
@inline
function bsearchEdge(edgesBase: i32, start: i32, count: i32, key: u32): i32 {
  let lo: i32 = start;
  let hi: i32 = start + count - 1;
  while (lo <= hi) {
    const mid: i32 = lo + ((hi - lo) >> 1);
    const edgeOff: i32 = edgesBase + mid * EDGE_BYTES;
    const k: u32 = load<u32>(edgeOff);
    if (k == key) {
      return i32(load<u32>(edgeOff + 4));
    } else if (k < key) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Single query match — iterates over pre-hashed segments
// Returns packed i64: bits[63:32] = matched (0/1), bits[31:0] = captures
// ---------------------------------------------------------------------------
function matchQuery(
  nodesBase: i32,
  edgesBase: i32,
  queryPtr: i32,
  segCount: i32,
): i64 {
  let nodeIdx: i32 = 0;  // start at root
  let captures: i32 = 0;

  for (let s: i32 = 0; s < segCount; s++) {
    const segHash: u32 = load<u32>(queryPtr + s * 4);
    const nodeOff: i32 = nodesBase + nodeIdx * NODE_STRIDE * 4;

    const edgeCount: i32 = i32(load<u32>(nodeOff + 0));
    const edgesStart: i32 = i32(load<u32>(nodeOff + 4));

    // Edges are sorted ascending. PARAM_SENTINEL=1 and WILDCARD_SENTINEL=2
    // sort before all real hashes (≥3). Check them by direct probe at start
    // of the edge list before binary-searching the hash range.
    let paramChild: i32 = -1;
    let wildcardChild: i32 = -1;

    // Check for PARAM_SENTINEL (key=1) at edge[0]
    if (edgeCount > 0) {
      const e0off: i32 = edgesBase + edgesStart * EDGE_BYTES;
      const k0: u32 = load<u32>(e0off);
      if (k0 == PARAM_SENTINEL) {
        paramChild = i32(load<u32>(e0off + 4));
      }
      // Check for WILDCARD_SENTINEL (key=2) at edge[0] or edge[1]
      if (k0 == WILDCARD_SENTINEL) {
        wildcardChild = i32(load<u32>(e0off + 4));
      } else if (edgeCount > 1) {
        const e1off: i32 = edgesBase + (edgesStart + 1) * EDGE_BYTES;
        const k1: u32 = load<u32>(e1off);
        if (k1 == WILDCARD_SENTINEL) {
          wildcardChild = i32(load<u32>(e1off + 4));
        }
      }
    }

    // Binary search for exact segHash in the sorted edge list
    // segHash >= 3 (guaranteed by hash function), so it's never a sentinel
    const exactChild: i32 = segHash >= 3
      ? bsearchEdge(edgesBase, edgesStart, edgeCount, segHash)
      : -1;

    if (exactChild >= 0) {
      nodeIdx = exactChild;
      continue;
    }
    if (paramChild >= 0) {
      captures += 1;
      nodeIdx = paramChild;
      continue;
    }
    if (wildcardChild >= 0) {
      captures += 1;
      // Wildcard consumes remaining segments
      const wcNodeOff: i32 = nodesBase + wildcardChild * NODE_STRIDE * 4;
      const wcHandler: u32 = load<u32>(wcNodeOff + 8);
      const matched: i32 = wcHandler != NO_HANDLER ? 1 : 0;
      return (i64(matched) << 32) | i64(captures);
    }

    // No match
    return i64(captures);  // matched=0, captures as accumulated
  }

  // Consumed all segments — check if current node has a handler
  const finalOff: i32 = nodesBase + nodeIdx * NODE_STRIDE * 4;
  const handler: u32 = load<u32>(finalOff + 8);
  const matched: i32 = handler != NO_HANDLER ? 1 : 0;
  return (i64(matched) << 32) | i64(captures);
}

// ---------------------------------------------------------------------------
// Main exported function: match all queries, return packed result
// ---------------------------------------------------------------------------
//
// Memory layout (all pointers are byte offsets into WASM linear memory):
//   nodesPtr    — base of nodes array (8 x u32 per node)
//   nodesCount  — number of nodes
//   edgesPtr    — base of edges array (2 x u32 per edge, SORTED by key)
//   edgesCount  — number of edges (informational)
//   queriesPtr  — base of query data:
//                   [u32 seg_count, u32 hash0, u32 hash1, ...] per query
//   queryCount  — number of queries
//
// Returns packed i64: high 32 bits = total matched_count, low 32 bits = total_captures
//
export function matchAll(
  nodesPtr: i32,
  _nodesCount: i32,
  edgesPtr: i32,
  _edgesCount: i32,
  queriesPtr: i32,
  queryCount: i32,
): i64 {
  let totalMatched: i32  = 0;
  let totalCaptures: i32 = 0;
  let qPtr: i32 = queriesPtr;

  for (let q: i32 = 0; q < queryCount; q++) {
    const segCount: i32 = i32(load<u32>(qPtr));
    qPtr += 4;
    const segDataPtr: i32 = qPtr;

    const result: i64 = matchQuery(nodesPtr, edgesPtr, segDataPtr, segCount);
    const matched: i32  = i32(result >> 32);
    const captures: i32 = i32(result & 0xFFFFFFFF);

    totalMatched  += matched;
    totalCaptures += captures;
    qPtr += segCount * 4;
  }

  return (i64(totalMatched) << 32) | i64(totalCaptures);
}
