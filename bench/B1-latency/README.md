# B1 — Latency / Substrate Throughput Benchmark

<!--
@decision DEC-V0-BENCH-SLICE3-RELABEL-001
@title B1-latency pass-bars are directional targets only pre-characterisation-data
@status accepted
@rationale Per WI-BENCHMARK-SUITE-CHARACTERISATION-PASS, pass-bars are directional targets only pre-characterisation-data.
-->

> **Note (WI-BENCHMARK-SUITE-CHARACTERISATION-PASS / PR #448):** This bench is part of the `WI-BENCHMARK-SUITE-CHARACTERISATION-PASS` initiative (PR #448). Pass-bars are directional targets only; no measurement triggers a project-level KILL pre-data. Pass-bar revision happens after the characterisation distributions are in.

**Issue:** [#185](https://github.com/cneckar/yakcc/issues/185)  
**Parent:** WI-BENCHMARK-SUITE (#167)

## 3-Slice Plan

B1 is split into three slices for incremental delivery:

| Slice | Workload | Status |
|-------|----------|--------|
| Slice 1 | Integer math — SHA-256 over 100MB buffer | Shipped (PR #347) |
| Slice 2 | JSON — DFS sum-of-numeric-leaves over ~100MB JSON | Shipped (PR #349) |
| Slice 3 | HTTP routing trie + Nightly CI | **This commit** |

This document covers all three slices.

## What Slice 1 Measures

SHA-256 throughput over a fixed 100MB corpus — four comparators:

| Comparator | Engine | Role |
|------------|--------|------|
| `rust-accelerated` | Native Rust (`sha2`, cpufeatures SHA-NI dispatch) | Ceiling reference — informational only |
| `rust-software` | Native Rust (`sha2`, `force-soft` feature, pure-Rust) | Apples-to-apples verdict gate |
| `ts-node` | Node.js V8 (`crypto.createHash`, OpenSSL-backed) | Second reference point |
| `yakcc-as` | AssemblyScript WASM | Unit under test |

## Why Two Rust Comparators

Cargo features apply at the whole-crate build level, not per-binary. Both binaries come from
the same `rust-baseline` crate but are compiled with different feature sets via separate cargo
invocations:

- **`rust-baseline-accelerated`** — built with `--no-default-features` (sha2's `cpufeatures`
  crate detects and uses SHA-NI at runtime without assembly files). This is the ceiling reference:
  the fastest possible native SHA-256 on the hardware.

- **`rust-baseline-software`** — built with `--no-default-features --features force-soft`.
  sha2's `force-soft` feature disables the `cpufeatures` SHA-NI dispatch and forces the portable
  pure-Rust implementation path — the same algorithm path that yakcc-as WASM executes.

**The apples-to-apples discipline:** yakcc-as runs pure-software SHA-256 in WASM linear memory
and cannot access SHA-NI CPU instructions. Comparing it against hardware-accelerated Rust
produces a misleading verdict because the hardware acceleration gap is not a property of
the WASM JIT overhead. `rust-software` is the correct gate: same algorithm, same
pure-software implementation path, different runtime.

## Why SHA-256

SHA-256 is a pure integer substrate: 32-bit unsigned arithmetic (addition mod 2^32),
XOR, AND, NOT, and 32-bit bit-rotations. It has no branching complexity that varies
per input, no I/O, and no allocations after initial setup.

**Adversarial framing:** The 15% pass bar measures whether the WASM JIT overhead is within 15%
of a pure-software native baseline running the same algorithm. `rust-accelerated` shows how far
WASM is from the CPU's peak throughput — informational context, not the verdict gate.

See `integer-math/algorithm.md` for full rationale.

## Pass / Directional Target Bars (from issue #185)

| Result | Verdict |
|--------|---------|
| yakcc-as degradation vs rust-software **≤ 15%** | **PASS** |
| degradation **15%–40%** | **WARN** — concerning, review AS initiative |
| degradation **> 40%** | **Directional target (no KILL pre-data)** — would prompt re-plan of #143 AS initiative post-characterisation |

Degradation = `(yakcc_mean_ms - rust_software_mean_ms) / rust_software_mean_ms * 100`.

## Hardware Lock Note

**Reference target:** GitHub Actions `ubuntu-latest` (x86-64).

Results on other platforms are **informational only**:
- Windows development machines: SHA-NI availability varies; Node V8 JIT behavior differs
- macOS (Apple Silicon): ARM SHA extensions, different WASM JIT characteristics
- Cross-architecture results should not be used to make pass-bar verdict decisions

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
2. Builds both Rust binaries with different feature flags (two separate cargo invocations)
3. Runs all four comparators as fresh subprocesses
4. Writes the result artifact to `tmp/B1-latency/integer-math-<timestamp>.json`
5. Prints a human-readable verdict to stdout

### Options

Set `YAKCC_REPO_ROOT` env var to override repository root detection.

#### Per-comparator spawn timeout

Each comparator subprocess is given a **60-minute** per-comparator ceiling (`spawnSync` timeout).
This covers the observed `~2.2×` ubuntu-latest slowdown vs developer machines and the higher
yakcc-as WASM JIT cost on darwin/M1 Pro hardware (see issue #638 and `DEC-BENCH-B1-CI-TIMEOUT-001`).
Runs approaching this cap should be investigated as a perf regression, not a timeout bug.

#### Reducing yakcc-as iteration count for local diagnostic runs

On darwin/M1 Pro, yakcc-as per-iteration cost can reach ~6× the ubuntu-latest measurement,
causing the canonical 1100-iteration run (100 warm-up + 1000 measured) to exceed the 60-min
ceiling. The yakcc-as comparator supports an opt-in iteration override via environment variables:

```bash
# Quick diagnostic run (~10 measured iterations)
YAKCC_AS_WARMUP_ITERS=5 YAKCC_AS_MEASURED_ITERS=10 \
  node bench/B1-latency/integer-math/run.mjs
```

- **`YAKCC_AS_WARMUP_ITERS`** — warm-up iteration count (default: `100`)
- **`YAKCC_AS_MEASURED_ITERS`** — measured iteration count (default: `1000`)

The result JSON emits `"iterations_override": true` when these vars are active, so artifacts
from reduced-iter runs are visually distinguished from canonical CI artifacts.

**Important:** Leave these env vars **unset** for CI runs and any artifact intended as the
verdict-of-record. Reduced-iter runs have higher statistical variance and are for local
PASS/KILL diagnostic use only. The verdict statistic (`mean_ms`) is per-iteration and
iteration-count-invariant, so the gate remains valid for any sample size.

## Result Artifact Format

Written to `tmp/B1-latency/integer-math-<timestamp>.json`:

```json
{
  "slice": "integer-math",
  "timestamp": "...",
  "corpus": { "sha256": "...", "size_bytes": 104857600 },
  "environment": { "platform": "...", "arch": "...", "cpu": "...", "node": "...", "rust": "...", "yakcc_head": "..." },
  "results": [
    { "comparator": "rust-accelerated", "p50_ms": ..., "p95_ms": ..., "p99_ms": ..., "mean_ms": ..., "throughput_mb_per_sec": ... },
    { "comparator": "rust-software",    ... },
    { "comparator": "ts-node",          ... },
    { "comparator": "yakcc-as",         ... }
  ],
  "verdict": {
    "primary_comparison": "yakcc-as vs rust-software",
    "yakcc_vs_rust_software_degradation_pct": ...,
    "vs_pass_bar_15pct": "pass" | "warn" | "kill" | "blocker", // "kill" reserved for post-characterisation; never emitted by Tester pre-data
    "ceiling_reference": {
      "rust_accelerated_throughput_mb_per_sec": ...,
      "speedup_vs_software_pct": ...,
      "note": "SHA-NI hardware acceleration — informational only, not the verdict gate"
    }
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
- The dual-comparator discipline (apples-to-apples gate vs ceiling reference)
- The methodology (100 warm-up + 1000 measured, per-process isolation)
- This commit's measurement results and pass/warn/directional-target verdict

---

## Slice 2 — JSON Transformer (DFS Sum-of-Numeric-Leaves)

**Shipped:** PR #349  
**Algorithm:** `sum-of-all-numeric-leaves` DFS over a pre-parsed ~100MB JSON corpus.  
**Workload class:** Substrate-heavy (DFS traversal over serde_json::Value / WASM flat binary tree).  
**Pass bar:** ≤15% degradation vs rust-software (substrate-heavy bar).

### Why DFS Sum (not camelCase transform)

The original camelCase key transform requires managed string operations incompatible with
`--runtime stub`. The DFS sum fallback exercises the same node-visit substrate (every node
visited, type-tagged, dispatched) while keeping the leaf operation trivial (f64 accumulation
vs string normalization). See `json-transformer/algorithm.md` for full rationale.

### Pre-parse discipline

All four comparators exclude JSON parsing from the timing loop:
- Rust: `serde_json::Value` tree parsed once before timing
- ts-node: `JSON.parse` result cached before timing
- yakcc-as: flat binary tagged-union serialized into WASM memory before timing

### Slice 2 Directional Target Bars

| Result | Verdict |
|--------|---------|
| yakcc-as degradation vs rust-software **≤ 15%** | **PASS** |
| degradation **15%–40%** | **WARN** |
| degradation **> 40%** | **Directional target (no KILL pre-data)** |

### How to Run Slice 2

```bash
pnpm bench:latency:json
# or: node bench/B1-latency/json-transformer/run.mjs
```

---

## Slice 3 — HTTP Routing Trie

**Shipped:** This commit  
**Algorithm:** Trie-based path matching with parameter capture over 10K rules × 100K queries.  
**Workload class:** Glue-heavy (dispatch/branching intensive — relaxed pass bar).  
**Pass bar:** ≤25% degradation vs rust-software (glue-heavy relaxed bar).

### Algorithm Overview

HTTP routing is the canonical glue-heavy benchmark for WASM: it exercises dispatch tables,
indirect branching, and pointer-chasing rather than arithmetic throughput. See
`http-routing/algorithm.md` for full rationale.

**Segment hashing:** All four comparators hash path segments to `u32` outside the timing loop
(djb2 variant). The trie walk is pure `u32`-keyed, making it compatible with AS `--runtime stub`
(no managed strings). This is equivalent workload — documented in `algorithm.md`.

### Corpus

| Component | Size | Generator seed |
|-----------|------|----------------|
| Routing table | 10,000 rules | `0xF00DCAFE` |
| Query set | 100,000 paths | `0xBEEFF00D` |

Rule type distribution: ~50% static, ~30% single-param, ~15% multi-param, ~5% wildcard.  
Query distribution: 70% static hit, 25% param hit, 5% miss.

### Comparators

| Comparator | Engine | Role |
|------------|--------|------|
| `rust-accelerated` | Native Rust (hand-rolled u32-keyed trie) | Ceiling reference (same algo as software) |
| `rust-software` | Native Rust (same trie) | Apples-to-apples verdict gate |
| `ts-node` | Node.js V8 (Map-based u32-keyed trie) | Second reference point |
| `yakcc-as` | AS WASM (flat `Uint32Array` trie in linear memory) | Unit under test |

Note: for HTTP routing, there is no hardware-acceleration analog. Both Rust bins are
structurally identical — the dual-target pattern is kept for consistency with Slices 1+2.

### Slice 3 Directional Target Bars

| Result | Verdict |
|--------|---------|
| yakcc-as degradation vs rust-software **≤ 25%** | **PASS** (glue-heavy relaxed bar) |
| degradation **25%–40%** | **WARN** |
| degradation **> 40%** | **Directional target (no KILL pre-data)** |

The directional target bar is the same across all workload types. The pass bar is relaxed from 15% to 25%
to account for WASM's inherent indirect-call dispatch overhead on branching-heavy workloads.

### How to Run Slice 3

```bash
pnpm bench:latency:http
# or: node bench/B1-latency/http-routing/run.mjs
```

### Run All Three Slices

```bash
pnpm bench:latency:all
```

---

## Nightly CI Integration

**Workflow:** `.github/workflows/bench-b1-latency.yml`

### Schedule

- **Daily at 09:00 UTC** — picks up the prior day's merged commits
- **Manual trigger** via `workflow_dispatch` for ad-hoc runs after large performance changes

### What the Workflow Does

1. Checks out main
2. Installs Node 22 + Rust stable + pnpm 9
3. Builds required packages (skips `@yakcc/shave` — pre-existing broken)
4. Runs all three slice benchmarks in sequence
5. Posts a markdown verdict summary as a comment on issue #185
6. Uploads all artifact JSONs as `b1-latency-<run_number>` (retained 90 days)

### Concurrency

`cancel-in-progress: true` — a newer nightly supersedes the prior run. Safe to cancel because
each run is an independent measurement (no state accumulated across runs).

### Reading Results

Navigate to [issue #185](https://github.com/cneckar/yakcc/issues/185) — each nightly run posts
a comment with the verdict table:

```
| Slice          | Verdict  | yakcc-as | rust-software | Degradation | Pass bar        |
|----------------|----------|----------|---------------|-------------|-----------------|
| integer-math   | ✅ PASS  | 45.2ms   | 106.6ms       | -57.6%      | ≤15%            |
| json-transformer | ✅ PASS | 61.2ms  | 106.6ms       | -43.1%      | ≤15%            |
| http-routing   | ✅ PASS  | 12.3ms   | 14.8ms        | -16.9%      | ≤25% (glue)     |
```

Negative degradation means yakcc-as is **faster** than the Rust baseline.

### Artifact Format

Each slice writes `tmp/B1-latency/<slice>-<timestamp>.json` with:
- `environment`: platform, arch, CPU, Node version, Rust version, yakcc git HEAD
- `correctness_check`: pre-timing verification result
- `results`: array of `{comparator, p50_ms, p95_ms, p99_ms, mean_ms, queries_per_sec, matched_count, total_captures}`
- `verdict`: degradation %, verdict string, pass bar used

---

## Decision Reference

| Decision ID | File | Description |
|-------------|------|-------------|
| `DEC-BENCH-B1-INTEGER-001` | `integer-math/run.mjs` | SHA-256 substrate measurement strategy |
| `DEC-BENCH-B1-JSON-001` | `json-transformer/run.mjs` | DFS sum-of-leaves fallback rationale |
| `DEC-BENCH-B1-HTTP-001` | `http-routing/run.mjs` | HTTP trie, segment hashing, glue-heavy bar |
| `DEC-BENCH-B1-CI-001` | `.github/workflows/bench-b1-latency.yml` | Nightly CI schedule, concurrency, retention |
