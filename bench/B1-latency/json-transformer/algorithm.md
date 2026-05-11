# Algorithm Choice: Sum-of-All-Numeric-Leaves over ~100MB JSON Corpus

## Algorithm Selected: Sum-of-All-Numeric-Leaves (DFS)

The primary candidate for Slice 2 was a **string-keys-to-camelCase recursive normalization**.
That algorithm was evaluated and rejected for the yakcc-as WASM comparator because:

### Why Not CamelCase Transform

The yakcc-as comparator is compiled via `asc` with `--runtime stub`. This constraint is
documented in `as-backend.ts` under `DEC-AS-JSON-STRATEGY-001`:

> assemblyscript-json and the native AS JSON stdlib both require `--runtime minimal/full`
> (GC heap, managed string type, JSON parsing internals) which are incompatible with
> the `--runtime stub` constraint used by this backend.

CamelCase string transformation requires:
1. AS managed string type (`string` in AS, mapped to GC-managed UTF-16 memory)
2. String slicing, char-by-char inspection, byte-by-byte write to output buffer

Under `--runtime stub`, both managed strings and heap allocation are absent. There is no
safe way to implement camelCase key normalization without those primitives.

### Why Sum-of-All-Numeric-Leaves

Sum-of-all-numeric-leaves is a depth-first traversal that:

1. **Parses the entire JSON tree** (via a pre-pass in JS for the WASM comparator)
2. **Walks every node** in DFS order
3. **Accumulates a double-precision float sum** of all numeric values encountered
4. Returns a single `f64` result

This is:

- **Deterministic**: same input → same sum on every run, across all 4 comparators
- **CPU-bound on tree traversal**: the DFS walk dominates; the actual addition is trivial
- **Verifiable**: a single floating-point number is trivially compared for equivalence
- **Not benefitted by hardware acceleration**: pure-software DFS, no SIMD, no instruction set extensions
- **Compatible with `--runtime stub`**: only `f64` arithmetic and `load<u8>` / `load<f64>`
  flat-memory reads needed. No GC, no managed types.

### Pre-parse Contract (WASM Timing Scope)

Because AS-backend cannot parse JSON strings under `--runtime stub`, the host (run.mjs for
yakcc-as) pre-parses the JSON corpus to a binary tagged-union format before entering
the timing loop. The WASM kernel is timed on the DFS traversal only, not the parse.

For apples-to-apples discipline, the Rust and Node comparators are also split:
- **Rust**: parses JSON (serde_json), pre-converts to a `Vec<f64>` of all leaf numerics,
  then times the summation/traversal loop. This is equivalent work.
- **Node**: JSON.parse once (outside loop), then times recursive DFS accumulation.

This is documented clearly and all comparators time equivalent work. The measurement
is "DFS sum over pre-parsed JSON tree representation" across all 4 comparators.

### Corpus Distribution

~100MB JSON file, mix of types (~30% objects, ~20% arrays, ~15% numbers, ~20% strings,
~10% booleans, ~5% nulls), tree depth 8-12 average (max 20), generated deterministically
with xorshift32 PRNG (seed 0xCAFEF00D, distinct from Slice 1's seed 0xDEADBEEF).

## Iteration Discipline

- Warm-up: 100 iterations (discarded)
- Measurement: 1000 iterations
- Per-iteration metric: wall-clock latency in milliseconds
- Statistics: p50, p95, p99, mean, throughput_mb_per_sec

## Correctness Verification

Before timing, all 4 comparators run on a fixed 10KB test input. Their outputs (the
numeric sum as a serialized float) must be byte-identical. Without this check the
measurement compares different algorithms. Any mismatch is a hard fail in run.mjs.

## Pass/Kill Bars (from issue #185, same as Slice 1)

| Result | Verdict |
|--------|---------|
| yakcc-as degradation vs rust-software ≤ 15% | PASS |
| degradation 15%–40% | WARN |
| degradation > 40% | KILL (triggers re-plan of #143 AS initiative) |

Degradation = `(yakcc_mean_ms - rust_software_mean_ms) / rust_software_mean_ms * 100`.
