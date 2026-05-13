# B1 Slice 3 — HTTP Routing Algorithm

<!--
@decision DEC-V0-BENCH-SLICE3-RELABEL-001
@title B1 HTTP routing pass-bars are directional targets only pre-characterisation-data
@status accepted
@rationale Per WI-BENCHMARK-SUITE-CHARACTERISATION-PASS, pass-bars are directional targets only pre-characterisation-data.
-->

> **Note (WI-BENCHMARK-SUITE-CHARACTERISATION-PASS / PR #448):** This bench is part of the `WI-BENCHMARK-SUITE-CHARACTERISATION-PASS` initiative (PR #448). Pass-bars are directional targets only; no measurement triggers a project-level KILL pre-data. Pass-bar revision happens after the characterisation distributions are in.

**Issue:** [#185](https://github.com/cneckar/yakcc/issues/185)  
**Workload class:** Glue-heavy (dispatch/branching intensive, low arithmetic depth)

## Algorithm: Trie-Based Path Matching with Parameter Capture

### Why a Trie

HTTP routing is the canonical glue-heavy benchmark for WASM: it exercises dispatch tables,
indirect branching, string comparison, and pointer-chasing rather than arithmetic throughput.
A trie (prefix tree) over URL path segments is the standard production implementation pattern
(used by httprouter, Express, Actix-web's matchit, etc.).

The routing trie is built ONCE from 10,000 rules outside the timing loop. The timing loop
measures the 100,000-query match phase — the production hot path.

### Segment Hashing for WASM Compatibility

String operations are a blocker in the AS-backend (`--runtime stub` has no managed strings).
**All four comparators** hash path segments to `u32` outside the timing loop, so the inner
trie walk is `u32`-keyed rather than string-keyed.

This is equivalent workload across all comparators because:
1. The segment hash is computed identically by all four (same xorshift32-based djb2 variant)
2. The trie structure and traversal logic are identical
3. The hot path (trie walk with parameter capture) is not changed — parameter slots still
   exist; the "value captured" is the segment's u32 hash rather than a string reference

Documented equivalence: the u32 hash is a surjective map from string segments to integers.
The trie stores `u32` keys at each node. A match is a successful `u32` comparison chain.
Parameter nodes store a sentinel `PARAM_SENTINEL = 0x00000001` — any u32 matches a param node.

### Route Rule Types

- **Static paths**: `/api/v1/users` — every segment is a fixed u32 hash
- **Single-param**: `/users/:id` — one segment is a PARAM_SENTINEL node  
- **Multi-param**: `/orgs/:org/users/:id` — two PARAM_SENTINEL nodes
- **Wildcard tail**: `/files/*path` — terminal `WILDCARD_SENTINEL = 0x00000002` node that
  matches any remaining segments

### Corpus Distribution (10,000 rules)

| Type | Count | Share |
|------|-------|-------|
| Static | ~5,000 | 50% |
| Single-param | ~3,000 | 30% |
| Multi-param | ~1,500 | 15% |
| Wildcard tail | ~500 | 5% |

Depth: 2–6 segments. Generated deterministically by `generate-corpus.mjs` (seed `0xF00DCAFE`).

### Query Set (100,000 paths)

| Type | Share | Description |
|------|-------|-------------|
| Static hit | 70% | Path that matches a static rule exactly |
| Parametric hit | 25% | Path that matches via param capture |
| Miss | 5% | Path with no matching rule |

Generated deterministically (xorshift32 seed `0xBEEFF00D`).

### Pre-Flattening for yakcc-as

The yakcc-as comparator pre-flattens the trie to a packed `Uint32Array` outside the timing
loop, then times the WASM trie walk. The flat format:

```
Node record (8 x u32 = 32 bytes):
  [0] child_count    — number of child edges (0 = leaf)
  [1] edge_keys_ptr  — offset into keys array (u32[])
  [2] edge_nodes_ptr — offset into nodes array (u32[] → node indices)
  [3] handler_id     — 0xFFFFFFFF = no route; ≥0 = route handler ID
  [4] is_wildcard    — 1 = this node is a wildcard terminal
  [5] is_param       — 1 = this node is a parameter slot (matches any segment)
  [6..7] reserved
```

All comparators (including TS and Rust) use the equivalent in-memory data structure;
the WASM flat encoding is equivalent to what Rust lays out in memory for a Vec<Node>.

### Timing Discipline

- Build trie from 10,000 rules: EXCLUDED from timing loop
- Pre-hash all query segments: EXCLUDED from timing loop
- For yakcc-as: pre-flatten trie + pre-hash: EXCLUDED from timing loop
- Inner loop: 100,000-query match phase, 100 warm-up + 1,000 measured iterations

### Directional Target Bars for Glue-Heavy Workload

Per issue #185: glue-heavy workloads have a relaxed bar because WASM's indirect branching
overhead is inherent and not an AS-backend-specific deficiency.

| Verdict | Threshold |
|---------|-----------|
| PASS | yakcc-as degradation vs rust-software ≤ 25% |
| WARN | degradation 25%–40% |
| Directional target (no KILL pre-data) | degradation > 40% |

The directional target bar is the same across all workload types (>40% would prompt re-plan of AS initiative post-characterisation).
The pass bar is relaxed from 15% (substrate-heavy) to 25% (glue-heavy) to account for
the inherent WASM dispatch overhead that is not present in native code.

### Correctness Gate

Before timing, all 4 comparators run on a 100-query test set and produce a
`{matched_count, total_captures}` summary. All four must match exactly (integer equality).
Mismatch = hard fail, benchmark aborts.

`matched_count` = number of queries that matched any rule  
`total_captures` = total number of parameter slots captured across all matching queries

### Measurement Output

`{matched_count, total_captures}` per full 100K query corpus pass — compact and easy to
cross-verify. Throughput expressed as queries/second alongside latency per iteration.
