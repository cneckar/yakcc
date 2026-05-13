# Algorithm Choice: SHA-256 over 100MB Buffer

<!--
@decision DEC-V0-BENCH-SLICE3-RELABEL-001
@title B1 integer-math pass-bars are directional targets only pre-characterisation-data
@status accepted
@rationale Per WI-BENCHMARK-SUITE-CHARACTERISATION-PASS, pass-bars are directional targets only pre-characterisation-data.
-->

> **Note (WI-BENCHMARK-SUITE-CHARACTERISATION-PASS / PR #448):** This bench is part of the `WI-BENCHMARK-SUITE-CHARACTERISATION-PASS` initiative (PR #448). Pass-bars are directional targets only; no measurement triggers a project-level KILL pre-data. Pass-bar revision happens after the characterisation distributions are in.

## Why SHA-256

SHA-256 is chosen as the integer-math kernel for the following reasons:

1. **Pure integer substrate, no floating-point.** SHA-256 operates entirely on 32-bit
   unsigned integer arithmetic: 32-bit rotations, XOR, AND, NOT, ADD mod 2^32.
   This isolates the measurement to the u32/i32 computation substrate — the exact
   capability being tested in the yakcc AS-backend.

2. **Controlled framing with two Rust comparators.** The benchmark uses two Rust binaries:
   - `rust-accelerated`: sha2 with cpufeatures runtime SHA-NI dispatch — the ceiling reference,
     showing how far WASM is from the CPU's peak throughput.
   - `rust-software`: sha2 compiled with `--features force-soft` — the apples-to-apples gate,
     implementing the same pure-software RFC 6234 path as yakcc-as WASM.

   yakcc-as WASM cannot access SHA-NI CPU instructions. The correct verdict gate is therefore
   `rust-software`, not `rust-accelerated`. Comparing WASM against SHA-NI-accelerated native
   code conflates JIT overhead with hardware acceleration gap — two orthogonal questions.

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

## Apples-to-Apples Discipline

The verdict gate is **yakcc-as vs rust-software**, not yakcc-as vs rust-accelerated.

| Path | SHA-NI | Verdict role |
|------|--------|-------------|
| `rust-accelerated` | Yes (cpufeatures runtime dispatch) | Ceiling reference — informational |
| `rust-software` | No (sha2 `force-soft` feature) | Verdict gate — apples-to-apples |
| `ts-node` | Yes (OpenSSL) | Second reference point |
| `yakcc-as` | No (WASM linear memory) | Unit under test |

The 15%/40% bars measure the WASM JIT overhead — the cost of running the same algorithm
in a sandboxed runtime vs native Rust. Hardware acceleration is irrelevant to this question.

## Directional Target Bars (from issue #185)

| Result | Verdict |
|--------|---------|
| yakcc-as degradation vs rust-software ≤ 15% | PASS |
| degradation 15%–40% | WARN |
| degradation > 40% | Directional target (no KILL pre-data) — would prompt re-plan of #143 AS initiative post-characterisation |

Degradation = `(yakcc_mean_ms - rust_software_mean_ms) / rust_software_mean_ms * 100`.
