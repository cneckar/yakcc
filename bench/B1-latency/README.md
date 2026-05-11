# B1 — Latency / Substrate Throughput Benchmark

**Issue:** [#185](https://github.com/cneckar/yakcc/issues/185)  
**Parent:** WI-BENCHMARK-SUITE (#167)

## 3-Slice Plan

B1 is split into three slices for incremental delivery:

| Slice | Workload | Status |
|-------|----------|--------|
| Slice 1 | Integer math — SHA-256 over 100MB buffer | **This commit** |
| Slice 2 | JSON — parse + serialize integer arrays | Deferred (follow-up WI) |
| Slice 3 | HTTP + CI integration | Deferred (follow-up WI) |

This document covers Slice 1. Each subsequent slice will add a section here.

## What Slice 1 Measures

SHA-256 throughput over a fixed 100MB corpus — three comparators:

| Comparator | Engine | Notes |
|------------|--------|-------|
| `rust` | Native Rust (`sha2` crate) | Hardware-accelerated (SHA-NI on x86-64) |
| `ts-node` | Node.js V8 (`crypto.createHash`) | OpenSSL-backed, also hardware-accelerated |
| `yakcc-as` | AssemblyScript WASM | Pure-software SHA-256, flat-memory substrate |

## Why SHA-256

SHA-256 is a pure integer substrate: 32-bit unsigned arithmetic (addition mod 2^32),
XOR, AND, NOT, and 32-bit bit-rotations. It has no branching complexity that varies
per input, no I/O, and no allocations after initial setup.

**Adversarial framing:** Rust uses SHA-NI hardware instructions where available,
making it the strongest possible native baseline. WASM has no access to SHA-NI —
it runs a pure-software implementation. The 15% pass bar is asking whether the WASM
JIT overhead is within 15% of hardware-accelerated native. This is a strict bar.

See `integer-math/algorithm.md` for full rationale.

## Pass / Kill Bars (from issue #185)

| Result | Verdict |
|--------|---------|
| yakcc-as degradation vs Rust **≤ 15%** | **PASS** |
| degradation **15%–40%** | **WARN** — concerning, review AS initiative |
| degradation **> 40%** | **KILL** — triggers re-plan of #143 AS initiative |

Degradation = `(yakcc_mean_ms - rust_mean_ms) / rust_mean_ms * 100`.

## Hardware Lock Note

**Reference target:** GitHub Actions `ubuntu-latest` (x86-64).

Results on other platforms are **informational only**:
- Windows development machines: SHA-NI availability varies; Node V8 JIT behavior differs
- macOS (Apple Silicon): ARM SHA extensions, different WASM JIT characteristics
- Cross-architecture results should not be used to make pass/kill decisions

The result JSON includes an `environment` block (platform, arch, CPU model, Node version,
Rust version, yakcc git HEAD) so results can be correlated with hardware context.

## How to Reproduce

### Prerequisites

```bash
# From repo root
pnpm install

# Rust toolchain (for native baseline)
rustup toolchain install stable
```

### Generate corpus (one-time)

```bash
node bench/B1-latency/integer-math/generate-corpus.mjs
```

This creates `bench/B1-latency/integer-math/corpus/input-100MB.bin` (gitignored).
The script verifies SHA-256 against `corpus-spec.json` on every run — mismatch is a hard error.

### Run the benchmark

```bash
pnpm bench:latency:integer-math
```

Or directly:

```bash
node bench/B1-latency/integer-math/run.mjs
```

The orchestrator:
1. Verifies or regenerates the corpus
2. Builds the Rust baseline (`cargo build --release`)
3. Runs all three comparators as fresh subprocesses
4. Writes the result artifact to `tmp/B1-latency/integer-math-<timestamp>.json`
5. Prints a human-readable verdict to stdout

### Options

The orchestrator has no flags. Set `YAKCC_REPO_ROOT` env var to override repository root detection.

## Result Artifact Format

Written to `tmp/B1-latency/integer-math-<timestamp>.json`:

```json
{
  "slice": "integer-math",
  "timestamp": "...",
  "corpus": { "sha256": "...", "size_bytes": 104857600 },
  "environment": { "platform": "...", "arch": "...", "cpu": "...", "node": "...", "rust": "...", "yakcc_head": "..." },
  "results": [
    { "comparator": "rust",     "p50_ms": ..., "p95_ms": ..., "p99_ms": ..., "mean_ms": ..., "throughput_mb_per_sec": ... },
    { "comparator": "ts-node",  ... },
    { "comparator": "yakcc-as", ... }
  ],
  "verdict": {
    "yakcc_vs_rust_degradation_pct": ...,
    "vs_pass_bar_15pct": "pass" | "warn" | "kill" | "blocker"
  }
}
```

The result JSON **is committed** as the operator decision input for issue #185.
The corpus binary (`corpus/input-100MB.bin`) is **not committed** — it is content-addressed
and regenerated on demand.

## Decision Reference

`@decision DEC-BENCH-B1-INTEGER-001` — see `integer-math/run.mjs` header for full rationale.

This decision captures:
- The 3-slice strategy (B1 split for incremental delivery)
- The adversarial framing (hardware-accelerated Rust vs pure-software WASM)
- The methodology (100 warm-up + 1000 measured, per-process isolation)
- This commit's measurement results and pass/warn/kill verdict
