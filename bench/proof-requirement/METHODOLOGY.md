<!-- SPDX-License-Identifier: MIT -->
<!--
  @decision DEC-BENCH-PROOF-REQ-METHODOLOGY-001
  @title proof-requirement benchmark methodology — measurement authority for wi-1089
  @status accepted
  @rationale
    Governance and methodology authority for the proof-requirement benchmark.
    Authored before implementation per Core Dogma (No Implementation Without Plan).
    The harness (harness.mjs) must conform to this document; it does not redefine
    methodology. Changes to metric definitions, seeding requirements, or cost gates
    require a DEC amendment here.
-->

# proof-requirement benchmark — Methodology (wi-1089)

> Authority: this METHODOLOGY.md is the measurement authority for the
> proof-requirement benchmark. All metric definitions, seeding requirements,
> cost gates, and interpretation guidelines are owned here.
> `harness.mjs` is the runnable implementation; it must stay aligned with this doc.
> Deviations require a `DEC-BENCH-PROOF-REQ-NNN` amendment.

## 0. What this benchmark measures

Issue #1088 adds a `proof_requirement` query parameter to `yakcc_resolve` with
four modes (required / preferred / ignored / per_block). The parameter controls
how the resolver weights atoms that carry accepted L3 proofs vs. unproven atoms.

This benchmark answers four questions:

| # | Question | Metric |
|---|---|---|
| Q1 | Does `required` mode eliminate hedging for seeded tasks? | substitution_rate per mode (seeded tasks only) |
| Q2 | Does `preferred` mode increase substitution vs. `ignored`? | substitution_rate delta: preferred − ignored |
| Q3 | Do sophisticated agents use `per_block` for compound tasks? | per_block_adoption on compound tasks |
| Q4 | What is the token-cost delta when proof modes change behaviour? | output_token_reduction vs. `ignored` baseline |

The hypothesis (from #1089) is:

- `required` → highest substitution rate for seeded tasks, 0% for unseeded tasks
- `preferred` → higher substitution rate than `ignored` for seeded tasks
- `ignored` → baseline (no proof-aware behaviour)
- `per_block` → compound tasks show higher substitution than simple tasks in
  `ignored` mode, because the agent resolves sub-intents separately

## 1. Architecture

The benchmark is **simulation-first** (scaffold phase) and **live-ready** (paid run phase).

```
harness.mjs
  |
  +-- simulateResolve() [dry-run]     -- offline; no registry, no API key
  +-- liveResolve()     [live run]    -- requires production wiring (see §5)
  |
  +-- per-rep records --> results/<run-id>.jsonl   (raw trace)
  +-- aggregateMetrics() --> results/<run-id>.summary.json
```

The harness is intentionally stateless across reps: each rep is an independent
record. The JSONL trace is the primary artifact; the summary JSON is derived from it.

## 2. Corpus (tasks.json)

### 2.1 Task selection

12 tasks; see `tasks.json` for full definitions.

| Task | Domain | Reuses B4-v5 | Proof-sensitivity | Seeding target |
|---|---|---|---|---|
| crc32c | checksum_algorithm | yes | high | yes |
| utf8-codec | encoding_codec | yes | medium | no |
| base32-rfc4648 | encoding_codec | yes | medium | no |
| lru-ttl-cache | stateful_fsm | yes | low | no |
| semver-range | range_algebra | yes | low | no |
| ring-buffer | data_structure | yes | low | no |
| base64-encode | encoding_codec | no | high | yes |
| blake3-hash | checksum_algorithm | no | high | yes |
| hmac-sha256 | checksum_algorithm | no | high | yes |
| url-parse-strict | parsing | no | medium | no |
| json-schema-validate | validation | no | medium | no |
| per-block-hash-and-encode | compound | no | high | no (per_block demo) |

### 2.2 Corpus atom registry

B4-v5 tasks reuse the committed `bench/B4-tokens-v5/corpus/registry.sqlite`
(the Opus-built corpus from #1066). No re-shave is needed; the B4-v5 registry
already has atom candidates for the 6 reused tasks.

New tasks (base64-encode, blake3-hash, hmac-sha256, url-parse-strict,
json-schema-validate, per-block-hash-and-encode) require fresh atom entries.
For the live run, run a Phase 1 shave against the new task prompts before
executing the paid matrix.

### 2.3 Prerequisite seeding

**The live run requires L3-accepted proofs for the seeding-target tasks before
the `required` and `preferred` modes produce interesting results.**

| Atom | Why seed | Proof type | Effort |
|---|---|---|---|
| crc32c | Checksum correctness; L3 proof via test-vector fast-check props | fast-check property suite | low |
| base64-encode | Well-specified RFC; no edge-case ambiguity | fast-check property suite | low |
| blake3-hash | High-complexity hash; LLM error rate is non-trivial; seeding makes the point | fast-check against official test vectors | medium |
| hmac-sha256 | Security-critical; RFC test vectors are authoritative | fast-check with RFC 4231 vectors | low |

Seeding procedure:
1. Author a `proof/tests.fast-check.ts` for each target atom.
2. Submit via `yakcc emit-atom` with an existing atom or new triplet.
3. Run `yakcc verify --level=L3` to confirm acceptance.
4. Confirm `proof_status: accepted` appears in `yakcc_resolve` envelope for the atom.

Until seeding is complete, the `--dry-run` simulation uses `seeding_target=true`
as a proxy (tasks with `seeding_target=true` get a synthetic L3 proof in the
simulation). This means dry-run results show optimistic behavior for the
`required` mode; the live run will reflect actual seeding state.

## 3. Metrics

All metrics are computed per mode across all reps. The JSONL trace is the
primary record; the summary JSON is derived offline.

### 3.1 Substitution rate (Q1, Q2)

```
substitution_rate[mode] = count(reps where substituted=true) / total reps
```

**Interpretation:**
- `required` on seeded tasks: expected 100% (hard filter means only proven
  atoms are returned; if auto_accept, model substitutes).
- `required` on unseeded tasks: expected 0% (no_candidates returned; model
  must author).
- `preferred` > `ignored` for seeded tasks: the proof bonus raises effective
  score above the auto_accept threshold for atoms that would otherwise be
  candidate_list.
- `ignored` is the unproven baseline.

### 3.2 Output token reduction vs. `ignored` baseline (Q4)

```
output_token_reduction[mode] = (avg_output_tokens[ignored] - avg_output_tokens[mode])
                               / avg_output_tokens[ignored] * 100
```

A positive value means fewer output tokens than the ignored baseline.
Substituted reps emit ~14 tokens (reference-emit import line per
DEC-COMPOSE-BY-REF-REFERENCE-APPLY-001); unsubstituted reps emit 900–2000
tokens (full implementation).

### 3.3 Per-block adoption (Q3)

```
per_block_adoption = count(per_block reps where flow_class in {hot_hit, warm_candidate_list})
                     / total per_block reps
```

Applies only to `per_block` mode reps. For non-compound tasks this measures
whether the agent queries the sub-intent separately (desired) vs. authoring
the whole compound in one pass (undesired). For compound tasks
(`per-block-hash-and-encode`) this measures whether the two sub-intents are
resolved independently with their respective dimension modes.

### 3.4 Token-cost delta

```
cost_delta[mode] = avg_cost_usd[mode] - avg_cost_usd[ignored]
```

A negative value means the mode costs less than the unproven baseline.

## 4. Matrix

| Dimension | Values |
|---|---|
| Modes | required, preferred, ignored, per_block |
| Tasks | 12 (see §2.1) |
| Reps | 3 per task × mode |
| Model | claude-sonnet-4-6 (default); extend to claude-opus-4-7 for Q3 (per_block uses sophisticated agents) |
| Budget cap | $30 (hard; harness aborts mid-run if exceeded) |

**Rationale for single-model default:** B4-v5 showed that the proof-aware
measurement is most interesting on Sonnet (the hedging rate is non-trivial
but not dominant). Haiku almost never substitutes; Opus almost always does.
Sonnet is the discriminating tier.

**Per_block extension:** For Q3, add an Opus cell for the compound task
(`per-block-hash-and-encode`). Opus is most likely to decompose the compound
intent and use `per_block` mode spontaneously (without explicit instruction).
This is the acid test for whether `per_block` is a user-controlled override or
a model-driven optimization.

## 5. Live run wiring

The scaffold (`--dry-run`) is fully exercisable without API keys. For the paid
live run, the following production wiring must be added to `harness.mjs`:

### 5.1 Registry wiring

Spawn `@yakcc/mcp-registry` server (same as B4-v5 `phase2-v5.mjs §1.1`):

```js
import { spawn } from "node:child_process";
const MCP_BINARY = join(REPO_ROOT, "packages/mcp-registry/dist/index.js");
const server = spawn("node", [MCP_BINARY], {
  env: { ...process.env, YAKCC_REGISTRY_PATH: REGISTRY_PATH, YAKCC_AIRGAPPED: "1" },
  stdio: ["pipe", "pipe", "inherit"],
});
```

Set `YAKCC_REGISTRY_PATH` to the combined registry (B4-v5 corpus + new task atoms).

### 5.2 IntentCard construction with proof_requirement

Build the IntentCard from the task prompt and inject `proof_requirement`:

```js
const intentCard = {
  title: task.description,
  behavior: task.description,
  proof_requirement: mode,  // "required" | "preferred" | "ignored" | per_block object
};
```

For `per_block` mode on compound tasks, pass the dimension map:

```js
const intentCard = {
  // ...
  proof_requirement: { per_block: task.per_block_dims },
};
```

### 5.3 LLM API calls

Wire the Anthropic SDK (same dependency as B4-v5's `@anthropic-ai/sdk`).
Inject the real `yakcc-discovery.md` system prompt.
Run the tool loop until stop_reason !== "tool_use".
Record per-turn usage (REQ-TOKENS from B4-v5 §2).

### 5.4 Oracle

For substituted reps: materialize atom source via `@yakcc/compile assemble()`
(same oracle as B4-v5 `DEC-BENCH-B4-V5-REFEMIT-ARM-001`).
For non-substituted reps: run the task oracle on model-generated code.

## 6. Cost gate

No paid run until:
1. `node harness.mjs --dry-run` completes cleanly (all 12 tasks × 4 modes × 3 reps).
2. Projected cost printed by `--dry-run` is reviewed and approved by the operator.
3. Seeding is confirmed for the 4 seeding-target atoms.
4. `liveResolve()` in `harness.mjs` is implemented (see §5).

**Budget cap: $30.** The harness aborts mid-run if exceeded.
Pass `--cap-usd=N` to override for smaller test slices.

## 7. Proposed default values

These defaults are what the benchmark is designed to validate
(from #1088 G.4):

| Parameter | Default | Env override |
|---|---|---|
| `YAKCC_PROOF_BONUS` | +0.10 | `YAKCC_PROOF_BONUS=0.15` |
| `YAKCC_RETRACTION_PENALTY` | -0.20 | `YAKCC_RETRACTION_PENALTY=0.30` |

**Validation questions:**
- Is +0.10 proof bonus sufficient to push a 0.80-scoring atom into auto_accept territory?
  (0.80 + 0.10 = 0.90 > 0.85 threshold — yes, marginally.)
- Is -0.20 retraction penalty sufficient to drop a previously-auto_accept atom to
  candidate_list? (0.91 - 0.20 = 0.71 — yes, into the weak-confident band.)
- If the live run shows these thresholds are too weak or too strong, file a follow-up
  PR per the #1088 decision contract: "Proof bonus / retraction penalty env-tunable;
  B4 measurement (separate issue) sets defaults."

## 8. Dossier

After the paid run, write `PROOF_REQUIREMENT_REPORT.md` (see report skeleton in this
directory) with:
- Raw metric tables per mode
- Flow-class distribution
- Comparison to `ignored` baseline (token cost delta)
- per_block adoption rates for compound tasks
- Tuning recommendation for `YAKCC_PROOF_BONUS` / `YAKCC_RETRACTION_PENALTY`
- Conclusion: does proof-aware discovery measurably improve agent behaviour?

## 9. Cross-references

| Source | Relationship |
|---|---|
| `gh issue #1088` | Defines the four proof_requirement modes and the resolver spec this benchmark exercises |
| `gh issue #1089` | This benchmark's issue |
| `packages/mcp-registry/src/tools/resolve.ts` | Production yakcc_resolve; proof_requirement applied in G.4 |
| `bench/B4-tokens-v5/PROTOCOL.md` | Ancestor methodology; B4-v5 patterns inherited here |
| `bench/B4-tokens-v5/harness/phase2-v5.mjs` | Ancestor harness; wiring patterns for live run |
| `docs/system-prompts/yakcc-discovery.md` | Discovery system prompt; Section A (reference-emit) is the substitution path |
| `docs/proof-incentive-economics.md` | Proof market economics; proof_bonus defaults are validated here |

## Decision log

| DEC | Statement |
|---|---|
| DEC-BENCH-PROOF-REQ-METHODOLOGY-001 | This document is the measurement authority for the proof-requirement benchmark (wi-1089). The harness conforms to it; it does not redefine methodology. Status: accepted. |
| DEC-BENCH-PROOF-REQ-CORPUS-001 | 12-task corpus: 6 reused from B4-v5 (pre-existing corpus atoms), 6 new tasks. 4 seeding targets (crc32c, base64-encode, blake3-hash, hmac-sha256) must have L3-accepted proofs before the live run. Status: accepted. |
| DEC-BENCH-PROOF-REQ-HARNESS-001 | Simulation-first scaffold: dry-run mode is fully exercisable without API keys. liveResolve() is a stub that throws until production wiring is added, preventing accidental paid calls. Status: accepted. |
| DEC-BENCH-PROOF-REQ-MODES-001 | Four modes from #1088 G.2 (required / preferred / ignored / per_block) are exercised per rep. Mode is injected into the IntentCard as proof_requirement. Status: accepted. |
| DEC-BENCH-PROOF-REQ-BUDGET-001 | Budget cap $30 (hard abort). No paid run until: dry-run passes, projected cost approved, seeding confirmed, liveResolve() wired. Status: accepted. |
