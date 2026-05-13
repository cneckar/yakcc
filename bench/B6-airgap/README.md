# B6 — Air-Gapped / Network-Locality Benchmark

<!--
@decision DEC-V0-BENCH-SLICE3-RELABEL-001
@title B6-airgap pass-bars are directional targets only pre-characterisation-data
@status accepted
@rationale Per WI-BENCHMARK-SUITE-CHARACTERISATION-PASS, pass-bars are directional targets only pre-characterisation-data.
-->

> **Note (WI-BENCHMARK-SUITE-CHARACTERISATION-PASS / PR #448):** This bench is part of the `WI-BENCHMARK-SUITE-CHARACTERISATION-PASS` initiative (PR #448). Pass-bars are directional targets only; no measurement triggers a project-level KILL pre-data. Pass-bar revision happens after the characterisation distributions are in.

**Issue:** [#190](https://github.com/cneckar/yakcc/issues/190)  
**Parent:** WI-BENCHMARK-SUITE (#167)

## What it measures

Two sub-benchmarks:

| Sub-benchmark | Mode | Bar | Description |
|---|---|---|---|
| B6a | Offline (air-gapped) | **ZERO outbound connections** | Full 7-step developer flow with `createOfflineEmbeddingProvider()` (BLAKE3-based, no network). Any outbound connection is a directional-target failure (no KILL pre-data) — cannot claim air-gapped viability. |
| B6b | Networked | Only allowlisted destinations | Same flow with live Anthropic API embeddings. Every outbound destination must appear in `allowlist.json`. Any unlisted destination is a directional-target failure (no KILL pre-data). |

## How to run

### Prerequisites

```bash
pnpm install
pnpm build
```

### B6a (offline — default)

```bash
pnpm bench:airgap
```

Or directly:

```bash
node bench/B6-airgap/run.mjs
```

### B6b (networked)

Requires `ANTHROPIC_API_KEY`:

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm bench:airgap -- --mode b6b
```

Or directly:

```bash
ANTHROPIC_API_KEY=sk-ant-... node bench/B6-airgap/run.mjs --mode b6b
```

### Run both modes

```bash
ANTHROPIC_API_KEY=sk-ant-... node bench/B6-airgap/run.mjs --mode all
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--mode b6a\|b6b\|all` | `b6a` | Which sub-benchmark(s) to run |
| `--keep-tmp` | `false` | Keep the temp workdir after the run (for debugging) |
| `--help, -h` | | Print usage |

## The 7-step workload

| # | Step | Expected outcome |
|---|---|---|
| 1 | `yakcc init --target <tmpdir>` | `.yakcc/` created, `registry.sqlite` initialized, Claude Code hooks wired |
| 2 | Write `src/example.ts` | File written with substrate-able + novel-glue TypeScript |
| 3 | `yakcc shave src/example.ts --offline` | Atom triplets produced, written to registry |
| 4 | Verify registry populated | `registry.sqlite` exists and is non-empty |
| 5 | `yakcc compile src/example.ts --out dist` | `dist/module.ts` + `dist/manifest.json` emitted |
| 6 | Execute compiled output | Compiled artifact present and non-empty |
| 7 | `yakcc query add` (registry read-back) | Query returns exit 0 |

**Note on Step 7:** The issue spec mentions `yakcc registry list`, but that subcommand does not exist in the current CLI surface (only `registry init` is implemented). Step 7 uses `yakcc query` for registry read-back instead. This is not a B6 failure — it accurately reflects the current CLI.

## Cross-platform strategy

**Decision:** `@decision DEC-BENCH-B6-001` — Option (a): pure-JS network interceptor

The harness uses a `--require` hook (`network-interceptor.cjs`) that patches `node:net.Socket.prototype.connect` and `node:tls.connect` before the ESM entry point loads. This intercepts all Node-level outbound connection attempts and records them to a JSON file read by the harness after each step.

**Why not `tcpdump`/`pktap`:**

1. Windows is the primary development environment ([#274](https://github.com/cneckar/yakcc/issues/274) shows `bin.js` is already broken on Windows). `tcpdump` is not natively available on Windows.
2. `tcpdump` requires `sudo` or `CAP_NET_RAW` on Linux — this adds CI complexity.
3. yakcc has no native binary subprocesses that initiate network I/O outside Node's `net`/`tls` stack, so Node-level interception catches all expected vectors.

**Known trade-off:** A native binary subprocess could bypass the JS interceptor. yakcc has no such dependencies today. If any are added, this benchmark must be augmented with OS-level packet capture (`tcpdump`/`pktap`/ETW) or a separate canary test.

**Windows bin.js bug (#274):** The compiled `dist/bin.js` uses an `import.meta.url` guard that breaks on Windows (`file:///C:/` vs `file://C:\`). This harness avoids the bug entirely by importing `runCli()` programmatically via a thin ESM wrapper passed to `--input-type=module`, bypassing the binary entry point.

### Platform-specific notes

| Platform | B6a status | Notes |
|---|---|---|
| Linux (CI) | Full | All 7 steps + packet capture via JS interceptor |
| macOS | Full | Same as Linux |
| Windows | Full (JS interceptor) | bin.js guard bug worked around; interceptor works on Windows |

## Allowlist (B6b)

Documented in [`allowlist.json`](./allowlist.json).

Expected outbound destinations when `YAKCC_EMBEDDING_PROVIDER=networked`:

- `api.anthropic.com:443` — Anthropic embeddings API

No other external destinations are expected at runtime. npm/pnpm registry traffic occurs at install time, not at runtime.

## Results files

After a run, results are written to `bench/B6-airgap/results-b6a-YYYY-MM-DD.json` (and `results-b6b-...json` for B6b). These are `.gitignore`d from the main repo but committed as part of a benchmark run PR.

Example B6a result structure:

```json
{
  "benchmark": "B6a",
  "runAt": "2025-05-03T...",
  "wallMs": 12345,
  "stepsFailed": 0,
  "outboundConnections": [],
  "outboundCount": 0,
  "pass": true,
  "b6aPass": true,
  "notes": ["platform: linux", "node: v22.x.x"]
}
```

## CI integration

B6a runs on every PR as a GitHub Actions job (`airgap-bench` in `.github/workflows/pr-ci.yml`).

- Runs on: `ubuntu-latest`
- Windows: **skipped with explicit message** — the JS interceptor works on Windows but the CI workflow uses Linux runners for the gate
- Required check: yes (gates PRs)
- Timeout: 15 minutes

Any PR that introduces an outbound network call (in B6a mode with the offline provider) causes this job to fail, blocking the PR.
