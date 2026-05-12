# B4-tokens: Token-Expenditure A/B Benchmark

**Parent issue:** [#188](https://github.com/cneckar/yakcc/issues/188) — WI-BENCHMARK-B4: ≥70% LLM output-token reduction
**This slice:** [#402](https://github.com/cneckar/yakcc/issues/402) — WI-B4-SLICE-1: harness MVP + 3-task seed suite

The B4 benchmark measures whether the yakcc hook layer reduces LLM output-token expenditure
while preserving semantic correctness. Arm A = hook-enabled; Arm B = vanilla Claude.
The headline claim is ≥70% output-token reduction with ≥90% semantic equivalence maintained.

---

## Quick Start

### Dry-run (no API key required — validates harness end-to-end)

```bash
pnpm bench:tokens --dry-run
```

Uses canned response fixtures from `bench/B4-tokens/fixtures/` instead of real API calls.
Exercises telemetry capture, oracle invocation, and aggregate logic on fixture data.
Exits 0 on success. Safe to run in CI without API budget.

### Real-run (requires ANTHROPIC_API_KEY)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm bench:tokens
```

Makes real Anthropic API calls (18+ calls at claude-sonnet-4-5 pricing for N=3 reps × 3 tasks × 2 arms).
**This is the one benchmark in the suite that exits the B6 air-gap.** See §Air-Gap Caveat below.

### Oracle tests only (validate reference implementations)

```bash
# Run all three oracle test suites
cd bench/B4-tokens && pnpm test:oracles

# Or individually
cd bench/B4-tokens && pnpm test:oracle:lru
cd bench/B4-tokens && pnpm test:oracle:csv
cd bench/B4-tokens && pnpm test:oracle:debounce
```

Note: vitest is not installed at workspace root. Oracle tests run via `packages/shave`'s
vitest. The oracle-runner.mjs handles this automatically.

---

## Directory Structure

```
bench/B4-tokens/
├── README.md                          # This file
├── TASKS_RATIONALE.md                 # @DEC-BENCH-B4-CORPUS-001: adversarial framing
├── tasks.json                         # Frozen task manifest with SHA-256 per prompt
├── package.json                       # Bench-local deps (@anthropic-ai/sdk, vitest)
├── vitest.config.mjs                  # Oracle test runner config
├── fixtures/                          # Canned API response fixtures for dry-run
│   ├── lru-cache-with-ttl/
│   │   ├── arm-a-response.json        # Hook-enabled fixture (low token count)
│   │   └── arm-b-response.json        # Vanilla fixture (high token count)
│   ├── csv-parser-quoted/
│   │   ├── arm-a-response.json
│   │   └── arm-b-response.json
│   └── debounce-with-cancel/
│       ├── arm-a-response.json
│       └── arm-b-response.json
├── harness/
│   ├── run.mjs                        # A/B orchestrator (@DEC-BENCH-B4-HARNESS-001)
│   └── oracle-runner.mjs              # Code extraction + vitest invocation
└── tasks/
    ├── lru-cache-with-ttl/
    │   ├── prompt.md                  # Frozen task prompt (SHA-256 verified)
    │   ├── reference-impl.ts          # Hand-written reference (proves oracle correctness)
    │   └── oracle.test.ts             # Exhaustive oracle: 25 tests
    ├── csv-parser-quoted/
    │   ├── prompt.md
    │   ├── reference-impl.ts
    │   └── oracle.test.ts             # RFC 4180 corner cases: 39 tests
    └── debounce-with-cancel/
        ├── prompt.md
        ├── reference-impl.ts
        └── oracle.test.ts             # Fake-timer oracle: 27 tests
```

---

## Methodology

### A/B Protocol

For each of 3 tasks × 2 arms × N reps:

**Arm A — hook-enabled:**
1. Construct Claude API request with task prompt + yakccResolve MCP tool enabled.
   System prompt includes hook integration text informing the model to use yakccResolve.
2. Capture: `output_tokens`, `input_tokens`, `inference_passes`, `wall_ms`.
3. Extract generated TypeScript from fenced code block in response.
4. Write to temp file; run `oracle.test.ts` against it → `semantic_equivalent: boolean`.

**Arm B — hook-disabled:**
1. Same prompt, same model, same temperature, same context window.
   System prompt is vanilla (no hook integration text, no MCP tools).
2. Same capture + oracle.

**Integration-text diff (Arm A vs B):** Arm A appends to the system prompt:
> *"You have access to the yakccResolve MCP tool. When implementing code that uses common
> patterns (data structures, algorithms, parsing primitives), you SHOULD use this tool to
> retrieve relevant atomic implementations from the yakcc registry and compose them into
> your solution..."*

No other difference between arms. Same model, same `temperature=1.0`, same `max_tokens`.

### Capture Points

| Field | Source | Notes |
|---|---|---|
| `output_tokens` | `response.usage.output_tokens` | Primary metric for reduction claim |
| `input_tokens` | `response.usage.input_tokens` | Context accounting |
| `inference_passes` | Always 1 | Single-turn, no retries in Slice 1 |
| `wall_ms` | `Date.now()` delta | Full API round-trip including network |

### Oracle Methodology

Oracles execute real generated code. No mocking.

1. `extractCode()` finds the first TypeScript fenced block in the response text.
2. Code is written to `tmp/B4-tokens/oracle-scratch/<task>-<hash>.ts`.
3. `vitest run` is spawned as a subprocess with `IMPL_PATH=<temp file>`.
   The oracle test file loads the implementation via dynamic `import(IMPL_PATH)`.
4. `semantic_equivalent = (vitest exit code 0)`.

Each oracle run is a fresh subprocess — vitest module cache and fake timers are isolated.

### Verdict Gates (from #188)

| Condition | Verdict |
|---|---|
| reduction ≥ 80% AND semantic_eq_A ≥ 90% | PASS-stretch |
| reduction ≥ 70% AND semantic_eq_A ≥ 90% | PASS |
| reduction 40–70% AND semantic_eq_A ≥ 90% | WARN |
| reduction < 40% OR semantic_eq_A < 90% | KILL |

### Aggregate Shape

```json
{
  "per_task": [
    {
      "task_id": "lru-cache-with-ttl",
      "arm_A": { "mean_output_tokens": 312, "std_output_tokens": 18.4, "mean_semantic_eq_rate": 1.0, "mean_wall_ms": 1250 },
      "arm_B": { "mean_output_tokens": 987, "std_output_tokens": 42.1, "mean_semantic_eq_rate": 1.0, "mean_wall_ms": 2850 },
      "reduction_pct": 0.684
    }
  ],
  "aggregate": {
    "mean_reduction_pct": 0.70,
    "mean_semantic_eq_A": 1.0,
    "mean_semantic_eq_B": 1.0,
    "verdict": "PASS"
  }
}
```

---

## Dry-Run vs Real-Run

| Aspect | Dry-run (`--dry-run`) | Real-run |
|---|---|---|
| API calls | None (canned fixtures) | 18+ calls (N=3 × 3 tasks × 2 arms) |
| API key required | No | Yes (`ANTHROPIC_API_KEY`) |
| Oracle execution | Real (against fixture code) | Real (against LLM-generated code) |
| Token counts | From fixture JSON | From real `response.usage` |
| Verdict | Illustrative | Empirical |
| Cost | $0 | ~$0.10–$0.50 per run (Sonnet-4-5) |
| Purpose | Validate harness pipeline | Measure actual A/B difference |

Dry-run proves:
- SHA-256 task verification runs correctly
- Fixture loading works
- Code extraction from response text works
- Oracle execution produces `semantic_equivalent` boolean
- Aggregate + verdict computation produces the correct shape

---

## Air-Gap Caveat (B6 Non-Regression)

**B4 is the one networked exception in the benchmark suite.**

The [B6-airgap](../B6-airgap/) benchmark enforces that the yakcc core (`atomizeEmission`,
registry operations, hook processing) works entirely offline — no outbound network calls.
B4 does NOT regress the B6 air-gap gate because:

1. **B4 uses the Anthropic API directly** — it is not measuring the yakcc offline pipeline.
   B4's Arm A uses the Anthropic API + MCP tool declaration. This is intentional: B4
   measures LLM output-token reduction with hook context, not registry round-trip latency.

2. **B4 is never run in CI without operator opt-in** — there is no CI workflow for
   `bench:tokens`. Running it requires explicit operator invocation with `ANTHROPIC_API_KEY`.
   B6's CI gate (`bench:airgap`) is not touched by B4 in any way.

3. **B4's dry-run mode is air-gapped** — `pnpm bench:tokens --dry-run` makes no outbound
   calls. If B4 were ever added to CI, it would run in dry-run mode only.

4. **B6 is unmodified by this PR** — `bench/B6-airgap/` is read-only from B4's perspective.

The air-gap property being tested by B6 is: "does yakcc's hook layer call any external APIs
during normal operation?" B4 does not test this property and does not touch the code under B6's test.

---

## Slice Sequencing

| Slice | Status | Description |
|---|---|---|
| Slice 1 (this PR) | COMPLETE | Harness MVP + 3-task seed + dry-run verified |
| Slice 2 | Planned | Operator provides API key; real A/B runs; empirical verdict against 70% bar |

Slice 2 will scale to 5–10 tasks per [#188](https://github.com/cneckar/yakcc/issues/188).

---

## Dependencies

Bench-local deps (install with `pnpm --dir bench/B4-tokens install`):
- `@anthropic-ai/sdk` — Anthropic API client (real-run only)
- `vitest` — oracle test runner
- `tsx` — TypeScript execution for reference impls

These are NOT in the workspace `pnpm-workspace.yaml` and MUST NOT appear in root `package.json`.
