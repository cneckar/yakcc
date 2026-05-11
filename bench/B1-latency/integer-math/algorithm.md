# Algorithm Choice: SHA-256 over 100MB Buffer

## Why SHA-256

SHA-256 is chosen as the integer-math kernel for the following reasons:

1. **Pure integer substrate, no floating-point.** SHA-256 operates entirely on 32-bit
   unsigned integer arithmetic: 32-bit rotations, XOR, AND, NOT, ADD mod 2^32.
   This isolates the measurement to the u32/i32 computation substrate — the exact
   capability being tested in the yakcc AS-backend.

2. **Adversarial framing for Yakcc.** The Rust comparator uses the `sha2` crate, which
   is hardware-accelerated on x86-64 (SHA-NI extensions via CPU feature detection).
   This makes Rust the strongest possible baseline: yakcc-as WASM must compete against
   hardware-accelerated native code. If WASM can stay within 15% of that bar, the
   AS-backend is viable as a substrate execution path.

3. **No hidden overhead.** SHA-256 has no I/O, no allocations (after initial setup),
   and no branching complexity that varies per input. The per-iteration cost is
   determined entirely by the arithmetic throughput of the execution engine.

4. **Reproducible.** A fixed 100MB input buffer (content-addressed, xorshift32 PRNG)
   produces a deterministic output hash. Any correctness regression is immediately
   visible as a hash mismatch.

5. **Industry-standard measurement.** SHA-256 throughput benchmarks are used by
   cryptographic libraries (OpenSSL, Rust's sha2, mbedTLS) to characterize platform
   performance. Our results are comparable to published benchmarks.

## Memory Layout

- Input: 100MB byte buffer read from `corpus/input-100MB.bin`
- For yakcc-as: buffer copied into WASM linear memory (requires ~1600 × 64KB pages)
- Output: 32-byte hash digest (not verified on every iteration to isolate compute)

## Iteration Discipline

- Warm-up: 100 iterations (discarded)
- Measurement: 1000 iterations
- Per-iteration metric: wall-clock latency in milliseconds
- Statistics reported: p50, p95, p99, mean, throughput_mb_per_sec

## Pass/Kill Bars (from issue #185)

| Result | Verdict |
|--------|---------|
| yakcc-as degradation vs Rust ≤ 15% | PASS |
| degradation 15%–40% | WARN |
| degradation > 40% | KILL (triggers re-plan of #143 AS initiative) |
