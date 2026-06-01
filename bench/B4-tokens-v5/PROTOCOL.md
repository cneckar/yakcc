<!-- SPDX-License-Identifier: MIT -->
<!--
  @decision DEC-BENCH-B4-V5-PROTOCOL-001
  @title B4-v5 protocol — production-path instrumented re-measurement of the token-expenditure hypothesis
  @status proposed (planner; #952)
  @rationale Governance/methodology authority for the B4-v5 run. Authored by the planner
    before implementation per Core Dogma (No Implementation Without Plan). The implementer
    builds the harness to satisfy THIS document + the Evaluation Contract below; it does
    not redefine methodology.
-->

# B4-v5 — Production-Path Instrumented Re-Measurement (yakcc#952)

> Authority: this PROTOCOL.md is the methodology of record for B4-v5. The harness
> (`bench/B4-tokens-v5/harness/**`) must conform to it. Headline economics and the
> hypothesis verdict are settled only by `results/DEC-BENCH-B4-V5-001.md`, cross-referenced
> to v3/v4. Changes to the matrix, telemetry schema, or cost gate require a DEC amendment here.

## 0. Architecture-correction note (the finding that motivates v5)

**#952 is partly wrong about v4.** #952 claims v3/v4 measured a "reactive PreToolUse"
architecture. They did not. The v4 Phase-2 runner
(`bench/B4-tokens-v4/harness/phase2-v4.mjs:301-318`) already drives a **proactive,
model-driven, query-before-generate tool loop**: the model is given the `atom-lookup`
tool, the harness runs a `while (stop_reason === 'tool_use')` loop, executes each tool
call against the **real yakcc registry** via `mcp-server.mjs` (offline embedding provider,
real SQLite registry), feeds the results back, and lets the model decide whether to
substitute. A naive rerun of v4 therefore reproduces v4's result (rescue F=20%, ambiguous)
— it does NOT measure a different architecture.

v5's job is therefore not "switch reactive→proactive" (already proactive). v5's job is:

1. **Upgrade the proactive path from a hand-rolled bench surface to the genuine PRODUCTION
   surface** — the real `yakcc_resolve` confidence-tier contract, the real discovery system
   prompt, the real #954 triplet miss-path, and an honest substitution oracle.
2. **Make the run diagnostic, not just scalar** — capture a full raw per-rep transcript and
   derive flow-adherence, per-stage token economics, hot/cold path classification, tier
   behaviour, hit-rate, and a failure taxonomy. Answer *why*, not only *what*.
3. **Fix a load-bearing measurement bug in v4** (see §2) before spending a single paid token.

The v5 dossier MUST carry this correction note so the historical record is honest about
what v3/v4 actually measured.

## 1. Production-path upgrades (what changes vs v4)

| # | v4 (bench surface) | v5 (production surface) | Source of truth read |
|---|---|---|---|
| U1 | `atom-lookup` tool: hand-written description, returns `{ atoms: [{atom_id, atom_signature, match_confidence, atom_body_sha256}] }` | `yakcc_resolve` tool: production description + envelope `{confidence_tier, source, candidates:[{atom_id,score,summary,source,evidence}], airgapped}` | `packages/mcp-registry/src/tools/resolve.ts` |
| U2 | hooked system prompt = `SYSTEM_PROMPT_VANILLA + hand-written suffix` (`phase2-v4.mjs:88-93`) | hooked system prompt = the **real** `docs/system-prompts/yakcc-discovery.md` verbatim | `docs/system-prompts/yakcc-discovery.md` |
| U3 | no miss path — `{atoms:[]}` just lets the model author its own impl | on `no_candidates` the model emits a #954 **triplet** (`spec.yak`/`impl.ts`/`proof/{manifest.json,tests.fast-check.ts}`); harness runs it through real emit validation, records well-formedness + emit exit code | `packages/cli/src/commands/emit-atom.ts`, discovery doc §"LLM atom-triplet emission format" |
| U4 | oracle runs only on model-authored code | **honest substitution oracle**: on `auto_accept` the model emits `yakcc compile <atom_id>`; harness compiles that atom and runs the property/oracle tests on the **substituted** code. "Fewer tokens" is credited only when the substituted solution actually passes. | `oracle-runner.mjs` (extend), emit/compile path |
| U5 | per-run registry built by phase1-v4 | **reuse** the v4 Opus-built corpus/registry (no re-shave; same registry per #952 acceptance) | `tmp/B4-tokens-v4/phase1-2026-05-18T17-18-16/registry.sqlite` |

### 1.1 Resolve-server wiring (DEC-BENCH-B4-V5-RESOLVE-SERVER-001)

**Decision: spawn the built `@yakcc/mcp-registry` stdio server**, pointed at the reused v4
registry via `YAKCC_REGISTRY_PATH`, rather than making the bench server emit a hand-faked
production envelope.

Rationale (grounded in what was read):
- `packages/mcp-registry/package.json` exposes `bin: { "yakcc-mcp-registry": "./dist/index.js" }`
  and `main: ./dist/index.js`. The server is a real, buildable, spawnable stdio binary.
- `resolve.ts:551-562` (`defaultOpenRegistry`) opens the registry from
  `YAKCC_REGISTRY_PATH` (or `.yakcc/registry.sqlite`) with `createOfflineEmbeddingProvider()`
  — exactly the env-driven path the bench needs, and offline (no network, deterministic).
- `resolveTool` is the production envelope authority. Spawning it means v5 measures the
  **real** tier-derivation logic (`deriveConfidenceTier`, thresholds 0.92/0.15), not a bench
  re-implementation that could silently drift (Sacred Practice #12 — single source of truth).
- Air-gap: set `YAKCC_AIRGAPPED=1` so the run is local-only and deterministic (no global
  `/v1/blocks` cascade, no network variance). The dossier records this as a controlled
  condition; a future WI may measure the global cascade.

Fallback (only if spawning proves impractical at build time — e.g. a dist/build blocker that
cannot be resolved within scope): the bench server may import `createResolveTool` from the
built `@yakcc/mcp-registry` **library** and call its handler directly (embedded-library-call,
not a re-implementation). Re-implementing the envelope by hand is **forbidden** — that would
reintroduce the v4 drift the upgrade exists to remove. Whichever path is used MUST be recorded
in the dossier with the resolved `tool_schema_version`.

Worktree note (from v4 dossier §7): `mcp-server`'s `findRepoRootSync` treats `.git` as a
directory, but worktrees have a `.git` **file**. The harness MUST set `YAKCC_REPO_ROOT` to the
real repo root and pass `YAKCC_REGISTRY_PATH` explicitly so the spawned production server
resolves `packages/*/dist` and the registry correctly from inside the worktree.

## 2. The v4 token-undercount bug (load-bearing — fix first)

`phase2-v4.mjs` logs only the **final** turn's usage:

```
328  const inputTokens  = response.usage?.input_tokens  ?? 0;
329  const outputTokens = response.usage?.output_tokens ?? 0;
```

But the hooked tool-loop **reassigns** `response` on every cycle
(`phase2-v4.mjs:316 response = await client.messages.create(...)`). Every intermediate
turn's `usage` — including the output tokens spent emitting the tool-call turns — is
**discarded**. In the hooked arm the model may spend several turns (IntentCard emission,
tool calls, re-reads of tool results) before the final answer; v4 counts none of that output.

Since the entire hypothesis is about **token expenditure**, this undercounts exactly the arm
(hooked) whose cost we are trying to measure, biasing the comparison in the hook's favour.

**v5 requirement (REQ-TOKENS):** sum `usage` across **every** turn of the conversation
(initial + each tool cycle + final). Persist per-turn usage in the raw trace and a derived
`tokens_total_output = Σ turn.output_tokens` (and likewise input, cache_read, cache_creation).
A regression unit test MUST assert that a canned multi-turn fixture sums correctly and that
the v4-style "last-turn-only" reading is strictly less than the v5 sum (proves the bug is
fixed, not merely re-described).

## 3. Telemetry — RAW TRACE FIRST, derive offline (REQ-TELEMETRY)

**Principle:** persist the complete per-rep transcript to JSONL **before** deriving anything.
Derived metrics are computed offline from the raw trace, so unforeseen questions are
answerable without re-spending API budget.

### 3.1 Raw trace schema (`results/<run-id>.trace.jsonl`, one line per turn)

Each line:
```
{
  run_id, task_id, cell_id, model_id, arm, rep, turn_index,
  request: { system_prompt_hash, tools_present: bool, max_tokens, temperature, messages_digest },
  response: {
    stop_reason,
    content_blocks: [ { type, ... } ],   // text | tool_use(input) | thinking — verbatim
    usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
  },
  tool_results: [ { tool_use_id, intent, envelope } ],  // verbatim yakcc_resolve envelope
  wall_ms, ts
}
```
Plus one `rep_meta` line per rep capturing run-level facts (see §3.4).

### 3.2 Derived metrics (computed offline from the trace; `results/<run-id>.derived.json`)

**Flow adherence**
- `flow_class` ∈ { `followed`, `ignored_tool` (hooked but never resolved),
  `resolved_then_ignored` (usable candidate returned but model authored its own impl),
  `cold_miss_authored`, `malformed` }
- `resolve_before_any_code: bool` — did a `yakcc_resolve` call precede the first code/Edit emission?

**Per-stage tokens (fixes §2)**
- per-turn `{ input, output, cache_read, cache_creation, stop_reason, had_tool_use }`
- `tokens_resolve_phase` vs `tokens_emission_phase`
- `intent_card_tokens`, `tool_result_tokens`
- `tokens_total_output = Σ output` (TRUE total — the v4 fix)
- `thinking_tokens` if extended-thinking blocks present
- `max_tokens_truncated: bool` (stop_reason === 'max_tokens')

**Hot vs cold**
- `path_class` ∈ { `hot_hit`, `warm_candidate_list`, `cold_miss`, `cold_unhooked` }
- per-task paired `tokens_saved_vs_cold` (paired against the same task's cold/unhooked rep)

**Tier behaviour**
- `tier_returned`, `top_score`, `gap_to_2nd`, `n_candidates`
- `model_action_given_tier` ∈ { `accepted_auto`, `picked_from_list`, `authored_despite_candidate` }

**Hit-rate diagnostics**
- per-task `registry_top1_score`, `tier`, `n_above_threshold` — captured both by a **$0 probe**
  (direct registry/resolve query during build/validation) and from the **live** run.

**Substitution + correctness**
- `substituted: bool`, `substituted_atom_id`, `substitution_oracle_passed: bool`
- on miss: `triplet_wellformed: bool`, `triplet_emit_exit_code` (0–6 per emit-atom),
  `triplet_oracle_passed: bool`

**Failure taxonomy**
- `failure_class` ∈ { `no_candidate`, `below_threshold`, `model_ignored_candidate`,
  `substituted_but_failed`, `triplet_malformed`, `none` }

### 3.3 Cost / latency / cache
- per-turn `cost_usd` and `wall_ms`.
- Pricing: extend `billing.mjs` — it currently prices `input`/`output` only
  (`billing.mjs:24-28`). v5 MUST add `cache_read` and `cache_creation` price columns per model
  so cached-system-prompt economics are credited honestly.
- `prompt_cache_read_total`, `prompt_cache_creation_total` per rep.

### 3.4 Repro fields (`rep_meta`)
`prompt_version_hash` (sha256 of the discovery prompt actually sent), `registry_atom_count`,
`registry_path`, `model_id`, `tool_schema_version` (resolve tool name+inputSchema hash),
`temperature`, `max_tokens`, `airgapped`, `prompt_caching_enabled`, harness git SHA.

## 4. Prompt-caching condition (DEC-BENCH-B4-V5-PROMPT-CACHE-001)

The discovery prompt is ~12.5KB; whether it is prompt-cached materially changes the real
economics of the hooked arm. **Decision: measure BOTH.** Run the hooked cells in two
sub-conditions — `cache_off` and `cache_on` (system prompt marked with
`cache_control: { type: 'ephemeral' }`) — and report cached vs uncached input-token cost
side by side. The unhooked arm has a trivial system prompt and is run `cache_off` only.
This isolates "is the hook expensive intrinsically, or only on a cold cache?" — a question
v4 could not answer.

(If the operator wants to cap spend, the cache sub-condition is the first dimension to drop;
default plan is to run both. See §6 cost gate.)

## 5. Matrix (unchanged cell topology; DEC-BENCH-B4-V5-MATRIX-001)

Same 6-cell topology as v4 (inherits `matrix-v4.mjs`): 3 models × 2 arms × 6 tasks × 3 reps.

| Cell | Model | Arm |
|---|---|---|
| A | opus-4-7 | unhooked |
| B | opus-4-7 | hooked |
| C | sonnet-4-6 | unhooked |
| D | sonnet-4-6 | hooked |
| E | haiku-4-5 | unhooked |
| F | haiku-4-5 | hooked |

Tasks (reused from v4): `crc32c`, `utf8-codec`, `base32-rfc4648`, `lru-ttl-cache`,
`semver-range`, `ring-buffer`. Model IDs and prices inherited from `matrix-v4.mjs` /
`billing.mjs` — do not change without a DEC.

Per §4, the hooked cells (B, D, F) run under both `cache_off` and `cache_on`, so the live
matrix is `(3 unhooked reps) + (3 hooked × 2 cache conditions)` per task per rep-count.

## 6. Validation plan + cost gate

### 6.1 $0 validation (REQ-VALIDATION — no API spend)
Extend v4's fixture approach with **canned-response scenarios** covering at least:
`hot_hit`, `cold_miss`, `ignored_tool`, `resolved_then_ignored`. Unit tests assert that the
offline derivation classifies each `flow_class`/`path_class`/`failure_class` correctly AND
sums tokens correctly (including the §2 multi-turn regression). **ZERO API calls** until the
telemetry derivation is proven green on fixtures. The harness MUST support a `--dry-run` /
canned mode that exercises the full pipeline without `ANTHROPIC_API_KEY`.

Also run a **$0 hit-rate probe**: query the reused registry directly (or via the resolve
library handler) for each task's intent and record `top1_score`/`tier`/`n_above_threshold`,
so the live hit-rate can be compared against the offline expectation.

### 6.2 Cost gate (DEC-BENCH-B4-V5-COST-GATE-001)
No paid run until the operator confirms the projected $ from a dry-run cost estimate.
Budget envelope from #952: **$20–30** (v4 actual was $8.74; v5 adds the cache sub-condition
on hooked cells and possible N extension). The harness MUST print a projected-cost table
(per cell, per cache condition) in `--dry-run` and enforce a hard `cap_usd` (reuse v4's
`BudgetTracker`) that aborts mid-run if exceeded.

### 6.3 Dossier
`results/DEC-BENCH-B4-V5-001.md` — diagnostic tables (flow-adherence, per-stage tokens incl.
cache, hot/cold, tier behaviour, hit-rate, failure taxonomy), cross-ref to v3/v4, and the §0
architecture-correction note (v4 was already proactive).

## 7. Open decisions resolved as DECs

| DEC | Question | Resolution |
|---|---|---|
| DEC-BENCH-B4-V5-RESOLVE-SERVER-001 | spawn real `@yakcc/mcp-registry` vs bench emits prod envelope | **Spawn the built server** (or, fallback, call its library `createResolveTool` handler). Hand-faking the envelope is forbidden. §1.1 |
| DEC-BENCH-B4-V5-THRESHOLD-001 | auto-accept 0.85 (discovery doc) vs 0.92 + gap 0.15 (resolve.ts) | **0.92 + gap 0.15 governs the run** (resolve.ts is the executable authority the production tool actually applies). **Capture both**: record `top_score`/`gap_to_2nd` and also flag whether each candidate would have auto-accepted under the doc's 0.85 rule, so the discrepancy is quantified. File a follow-up issue to reconcile doc↔code. §3.2 |
| DEC-BENCH-B4-V5-PROMPT-CACHE-001 | prompt caching on/off | **Measure both** on hooked cells; report cached vs uncached. §4 |
| DEC-BENCH-B4-V5-CORPUS-001 | reuse v4 corpus vs rebuild | **Reuse** the v4 Opus-built registry (#952 acceptance: "no need to re-shave; same registry"). §1 U5 |
| DEC-BENCH-B4-V5-REFEMIT-ARM-001 | auto_accept hooked arm: verbatim-compile-emit vs reference-emit | **Reference-emit** (compose-by-reference path). The hooked arm exposes `yakcc_reference` alongside `yakcc_resolve` and writes a `.yakcc/manifest.json` into a per-rep temp dir (manifest-present precondition for the discovery prompt's Section A). After `yakcc_resolve` returns `auto_accept`, the model calls `yakcc_reference` (apply-mode, passes `project_root`) and **writes only the ~14-token import line** — the system prompt (real `yakcc-discovery.md`) governs this; the old conflicting "emit `yakcc compile <atom_id>`" instruction in the `YAKCC_RESOLVE_TOOL_DEF` description was removed. **Oracle**: the harness materializes the resolved atom via `@yakcc/compile assemble(candidates[0].root, registry)` — the same DFS path as `yakcc build` — and runs the task oracle on the materialized source. Substitution correctness is determined by the materialized atom, independent of what the model emits. **Economics**: reference-emit collapses hooked-arm output to ~14 tokens per rep (vs ~2000 for verbatim compile-emit), cutting the projected grand-total cost from ~$21 to **$5.41** for the full 162-run matrix. **Corpus**: `bench/B4-tokens-v5/corpus/registry.sqlite` (committed, #1066), probing `auto_accept` for all 6 B4-v5 tasks. **Supersedes**: the verbatim-compile-emit measurement for the `auto_accept` arm; the verbatim path remains present in the unhooked cells for comparison. |

## 8. Implementer sequencing

1. **Scaffold** `bench/B4-tokens-v5/` (fork from v4: `matrix`, `billing`, `budget`,
   `oracle-runner`, `verify`, `tasks.json`, the 6 task prompts). Wire bench-local deps
   (`pnpm install --ignore-workspace` in the bench dir — v4 dossier §7).
2. **Telemetry core first** (raw-trace writer + offline derivation lib) + **$0 fixtures/unit
   tests** including the §2 token-sum regression. Prove green with **no API key**.
3. **Production wiring**: spawn `@yakcc/mcp-registry` against the reused v4 registry; swap the
   hooked system prompt to the real discovery doc; add the #954 triplet miss-path + honest
   substitution oracle (emit/compile). Re-prove fixtures green.
4. **Dry-run cost projection** → hand to operator for the §6.2 cost gate. **STOP. No paid call.**
5. (Post-gate, separate WI/run) execute the matrix; write `DEC-BENCH-B4-V5-001.md`.

**Dependency:** the reused registry artifact
`tmp/B4-tokens-v4/phase1-2026-05-18T17-18-16/registry.sqlite` must be present (or rebuilt via
phase1-v4 — a $0/low-cost Opus corpus build) before the live run. The build/validation phase
(steps 1–4) does NOT require it for the canned-fixture tests, but the $0 hit-rate probe and the
live run do.

## 9. Cross-references
- v4 dossier: `bench/B4-tokens-v4/results/DEC-BENCH-B4-V4-001.md`
- v4 runner (forked): `bench/B4-tokens-v4/harness/phase2-v4.mjs`
- Production resolve: `packages/mcp-registry/src/tools/resolve.ts`
- Discovery prompt: `docs/system-prompts/yakcc-discovery.md`
- Triplet emit: `packages/cli/src/commands/emit-atom.ts` (#954)
- Issue: yakcc#952
