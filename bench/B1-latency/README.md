# B1 — Latency / Substrate Throughput Benchmark

**Issue:** [#185](https://github.com/cneckar/yakcc/issues/185)  
**Parent:** WI-BENCHMARK-SUITE (#167)

## 3-Slice Plan

B1 is split into three slices for incremental delivery:

| Slice | Workload | Status |
|-------|----------|--------|
| Slice 1 | Integer math — SHA-256 over 100MB buffer | Shipped (PR #347) |
| Slice 2 | JSON — DFS sum-of-numeric-leaves over ~100MB JSON | **This commit** |
| Slice 3 | HTTP + CI integration | Deferred (follow-up WI) |

This document covers Slices 1 and 2. Each subsequent slice will add a section here.

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

## Pass / Kill Bars (from issue #185)

| Result | Verdict |
|--------|---------|
| yakcc-as degradation vs rust-software **≤ 15%** | **PASS** |
| degradation **15%–40%** | **WARN** — concerning, review AS initiative |
| degradation **> 40%** | **KILL** — triggers re-plan of #143 AS initiative |

Degradation = `(yakcc_mean_ms - rust_software_mean_ms) / rust_software_mean_ms * 100`.

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
2. Builds both Rust binaries with different feature flags (two separate cargo invocations)
3. Runs all four comparators as fresh subprocesses
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
    { "comparator": "rust-accelerated", "p50_ms": ..., "p95_ms": ..., "p99_ms": ..., "mean_ms": ..., "throughput_mb_per_sec": ... },
    { "comparator": "rust-software",    ... },
    { "comparator": "ts-node",          ... },
    { "comparator": "yakcc-as",         ... }
  ],
  "verdict": {
    "primary_comparison": "yakcc-as vs rust-software",
    "yakcc_vs_rust_software_degradation_pct": ...,
    "vs_pass_bar_15pct": "pass" | "warn" | "kill" | "blocker",
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

## Decision Reference (Slice 1)

`@decision DEC-BENCH-B1-INTEGER-001` — see `integer-math/run.mjs` header for full rationale.

This decision captures:
- The 3-slice strategy (B1 split for incremental delivery)
- The dual-comparator discipline (apples-to-apples gate vs ceiling reference)
- The methodology (100 warm-up + 1000 measured, per-process isolation)
- This commit's measurement results and pass/warn/kill verdict

---

## Slice 2 — JSON Tree Traversal

**Workload:** Sum-of-all-numeric-leaves via depth-first traversal over a ~100MB JSON corpus.

**Why not camelCase transform (the original Slice 2 candidate):**
The camelCase key normalization algorithm requires AS managed string operations
(`string` type, GC heap) which are incompatible with `--runtime stub`. The
`--runtime stub` constraint is fundamental to the AS-backend (see
`DEC-AS-JSON-STRATEGY-001` in `as-backend.ts`). The fallback is sum-of-numeric-leaves,
which exercises the same DFS traversal substrate with identical node-visit overhead.

See `json-transformer/algorithm.md` for the full rationale.

| Comparator | Engine | Role |
|------------|--------|------|
| `rust-accelerated` | Native Rust (`serde_json`) | Ceiling reference (same as software for this workload) |
| `rust-software` | Native Rust (`serde_json`) | Apples-to-apples verdict gate |
| `ts-node` | Node.js V8 (`JSON.parse` + recursive DFS) | Second reference point |
| `yakcc-as` | AssemblyScript WASM (flat-memory DFS over binary tree) | Unit under test |

**Pre-parse discipline:** JSON parsing is excluded from all timing loops. Each comparator
times only the DFS traversal over a pre-parsed representation. This is documented and
equivalent across all comparators.

**Correctness gate:** Before timing, all 4 comparators run on a fixed 10KB test input.
Outputs (f64 sums) must be byte-equivalent (relative error < 1e-6). Any mismatch
aborts the timing measurement.

### How to Reproduce (Slice 2)

```bash
# Generate corpus (one-time)
node bench/B1-latency/json-transformer/generate-corpus.mjs

# Run the benchmark
pnpm bench:latency:json
```

### Result Artifact Format (Slice 2)

Written to `tmp/B1-latency/json-transformer-<timestamp>.json`:

```json
{
  "slice": "json-transformer",
  "timestamp": "...",
  "corpus": { "sha256": "...", "size_bytes": ... },
  "algorithm": "sum-of-all-numeric-leaves (DFS); camelCase fallback — see algorithm.md",
  "environment": { ... },
  "correctness_check": { "passed": true, "checksums": [...] },
  "results": [ ... ],
  "verdict": {
    "primary_comparison": "yakcc-as vs rust-software",
    "yakcc_vs_rust_software_degradation_pct": ...,
    "vs_pass_bar_15pct": "pass" | "warn" | "kill" | "blocker"
  }
}
```

## Decision Reference (Slice 2)

`@decision DEC-BENCH-B1-JSON-001` — see `json-transformer/run.mjs` header for full rationale.

This decision captures:
- Algorithm choice: sum-of-numeric-leaves (camelCase blocked by --runtime stub)
- Pre-parse discipline and timing scope equivalence across all 4 comparators
- Correctness verification gate (byte-equivalent output on 10KB test input)
- The methodology (100 warm-up + 1000 measured, per-process isolation)
- This commit's measurement results and pass/warn/kill verdict
