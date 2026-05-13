# B9 — Attack-Surface Proof Benchmark

**Status:** Slice 1 (single task, Axes 1-3; Axis 4 deferred to Slice 2)
**Issue:** [#446](https://github.com/cneckar/yakcc/issues/446)

## The claim being measured

yakcc's atomic emission for `parse-int-list` ships strictly **smaller** and **less-attackable** surface than a baseline claude-sonnet-4-5 emit on the same task. This benchmark measures that claim across three axes.

## 4-Axis Design

| Axis | Name | Measurement | Pass Bar |
|------|------|-------------|----------|
| 1 | Structural minimality | LOC, bytes, transitive imports, statically-reachable functions (ts-morph) | ≥90% fn-reduction, ≥75% LOC-reduction |
| 2 | Adversarial-input refusal | REFUSED-EARLY rate across 8 attack classes (43 inputs) | ≥95% refused-early, 0 shape-escapes |
| 3 | In-shape equivalence | Byte-identical output on 20+ fast-check-derived valid inputs | 100% equivalence, ≥20 inputs |
| 4 | Known-CVE replay | Reachable functions matching npm audit DB CVE patterns | **Deferred to Slice 2** |

## Arms

- **Arm A** — yakcc atomic composition: `examples/parse-int-list/dist/module.ts` (emitted by `yakcc compile`, composed from atoms in the registry).
- **Arm B** — LLM baseline: claude-sonnet-4-5 with the locked Arm B prompt (DEC-V0-MIN-SURFACE-003). The model's typical response uses `JSON.parse`, which carries the full JSON-parser attack surface.

## Slice 1 Headline Metrics (pending Tester — W-B9-S1-9)

| Metric | Arm A | Arm B | Reduction |
|--------|-------|-------|-----------|
| LOC | 440 | _live_ | _pending_ |
| Bytes | _measured_ | _live_ | _pending_ |
| Reachable functions | _measured_ | _live_ | _pending_ |
| REFUSED-EARLY rate | _measured_ | — | _pending_ |
| In-shape equivalence | _measured_ | — | _pending_ |

_See `results-windows-<date>.json` after live run for filled numbers._

## Directory Structure

```
bench/B9-min-surface/
├── README.md                              # This file
├── corpus-spec.json                       # Task manifest + sha256 fingerprints
├── package.json                           # Bench-local deps (ts-morph, fast-check, @anthropic-ai/sdk)
├── harness/
│   ├── run.mjs                            # Main orchestrator (all 3 axes for Slice 1)
│   ├── measure-axis1.mjs                  # LOC + bytes + import-count + reachable-fn (ts-morph)
│   ├── measure-axis2.mjs                  # Adversarial fuzz + REFUSED-EARLY classifier
│   ├── measure-axis3.mjs                  # In-shape byte-equivalence (fast-check)
│   └── llm-baseline.mjs                   # Arm B: Anthropic API or dry-run fixture
├── attack-classes/
│   ├── prototype-pollution.json           # 5 inputs
│   ├── deep-nesting.json                  # 4 inputs
│   ├── nan-infinity.json                  # 7 inputs
│   ├── integer-overflow.json              # 5 inputs
│   ├── reviver-abuse.json                 # 5 inputs
│   ├── escape-abuse.json                  # 6 inputs
│   ├── circular-ref.json                  # 5 inputs
│   └── large-string.json                  # 5 inputs (42 total)
├── fixtures/
│   └── parse-int-list/
│       └── arm-b-response.json            # Dry-run fixture (representative LLM response)
└── test/
    ├── measure-axis1.test.mjs             # Axis 1 smoke tests
    ├── measure-axis2.test.mjs             # Axis 2 smoke tests
    └── measure-axis3.test.mjs             # Axis 3 smoke tests
```

## How to Run

### Dry-run (no API key needed)

```bash
pnpm bench:min-surface
# or equivalently:
node bench/B9-min-surface/harness/run.mjs --dry-run
```

Uses the canned fixture at `bench/B9-min-surface/fixtures/parse-int-list/arm-b-response.json`.
Arm B measurements are from the fixture, not a live API call.
Verdict will be `pending-tester`.

### Live run (requires ANTHROPIC_API_KEY)

```bash
ANTHROPIC_API_KEY=<your-key> pnpm bench:min-surface:live
# or equivalently:
ANTHROPIC_API_KEY=<your-key> node bench/B9-min-surface/harness/run.mjs
```

**API Key:** Never write the API key to disk or commit it. Inject via environment variable only:
```bash
# Inline injection (bash/zsh):
ANTHROPIC_API_KEY=sk-ant-... pnpm bench:min-surface:live

# Or export for session:
export ANTHROPIC_API_KEY=sk-ant-...
pnpm bench:min-surface:live
```

### Smoke tests

```bash
node --test bench/B9-min-surface/test/measure-axis1.test.mjs
node --test bench/B9-min-surface/test/measure-axis2.test.mjs
node --test bench/B9-min-surface/test/measure-axis3.test.mjs
```

### Individual axis measurers (standalone)

```bash
# Axis 1: structural minimality
node bench/B9-min-surface/harness/measure-axis1.mjs \
  --emit examples/parse-int-list/dist/module.ts \
  --entry listOfInts

# Axis 2: adversarial refusal
node bench/B9-min-surface/harness/measure-axis2.mjs \
  --emit <path-to-transpiled-mjs> \
  --attack-classes bench/B9-min-surface/attack-classes

# Axis 3: in-shape equivalence
node bench/B9-min-surface/harness/measure-axis3.mjs \
  --emit-a <arm-a-mjs> \
  --emit-b <arm-b-mjs>
```

## Prerequisites

1. Workspace built: `pnpm -r build`
2. For live Arm B run: `pnpm --dir bench/B9-min-surface install` (installs `@anthropic-ai/sdk`)
3. For Axis 1 reachability: `pnpm --dir bench/B9-min-surface install` (installs `ts-morph`)
4. For Axis 3 with fast-check generation: `pnpm --dir bench/B9-min-surface install` (installs `fast-check`)

Dry-run mode works without installing bench deps (no API calls, no ts-morph).

## Air-Gap Note

**Arm A** (yakcc compile pipeline): fully offline. No outbound network calls.

**Arm B** (live mode): **exits the B6 air-gap by design.** The Anthropic API call sends the locked prompt to an external endpoint. This is intentional and documented here (mirrors B4's air-gap caveat). The default `pnpm bench:min-surface` script uses `--dry-run` so CI can run offline.

## Locked Decisions

| ID | Title | Location |
|----|-------|----------|
| `DEC-V0-MIN-SURFACE-001` | REFUSED-EARLY classifier | `harness/measure-axis2.mjs` |
| `DEC-V0-MIN-SURFACE-002` | Reachability via ts-morph | `harness/measure-axis1.mjs` |
| `DEC-V0-MIN-SURFACE-003` | Arm B prompt (verbatim + sha256) | `harness/llm-baseline.mjs` |
| `DEC-BENCH-B9-SLICE1-001` | Slice 1 verdict computation | `harness/run.mjs` |

## Honesty Clause

If any axis falls below its pass bar, the Tester records `WARN` or `KILL` in `DEC-BENCH-B9-SLICE1-001` verbatim. `KILL` is filed as a follow-up WI against the atomization pipeline (e.g., `WI-V0-ATOM-REFUSAL-GAP`) — not as a benchmark failure. Finding a KILL IS the value of running this benchmark.

## Out of Scope (Slice 1)

- Axis 4 (known-CVE replay) — Slice 2
- CI workflow — Slice 2
- Broader corpus (5-10 tasks) — Slice 2
- Arm C (idiomatic Rust via serde_json) — Slice 2
- Mutation testing of atoms — Slice 3
