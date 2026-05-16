# DEC-BENCHMARK-SUITE-001 — Quantitative validation harness

**Status:** Accepted (Phase 0 design pass; implementation tracked across sub-tickets #185–#193)
**Date:** 2026-05-10
**Issue:** https://github.com/cneckar/yakcc/issues/167
**Initiative:** WI-BENCHMARK-SUITE (quantitative validation of yakcc viability claims)

---

## Context

Yakcc's viability rests on quantitative claims that today live in `MASTER_PLAN.md`, `DESIGN.md`, the v3 discovery design ADRs, and the WI-HOOK-LAYER ADR. None have been measured against an adversarial benchmark harness. Before yakcc enters investor / enterprise conversations where these numbers will be challenged, the project needs:

1. A defensible methodology per benchmark (not whitepaper estimates).
2. An adversarial framing — benchmarks designed to *try to fail*, not to pass.
3. Explicit kill-criteria per benchmark — every numeric claim has a falsification point recorded.
4. Sequenced delivery against the implementation roadmap (most benchmarks gate on initiatives still in flight).

This ADR is the design pass. The implementation of each benchmark is owned by a corresponding sub-ticket (#185 B1, #186 B2, #187 B3, #188 B4, #189 B5, #190 B6, #191 B7, #192 B8-SYNTHETIC, #193 B8-CURVE). Sub-tickets cite this ADR's decisions in their pre-assigned-decision sections.

The B8 scaling-curve study was added via comment on #167 (2026-05-08) and now has its own sub-tickets (#192 synthetic prototype, #193 production curve). DQ-6 through DQ-9 below resolve the open questions from that addition.

## Cornerstone alignment check

Reviewed against `AGENTS.md`:

- ✅ Content-addressed: benchmarks measure the existing identity model; nothing introduced.
- ✅ No versioning: benchmark suite is itself monotonic — add benchmarks, never delete or rename. Numeric thresholds may tighten over time; the methodology and IDs are stable.
- ✅ No ownership: every benchmark is reproducible from the public repo + a frozen corpus reference.
- ✅ Composition from minimal blocks: each benchmark is a separate sub-ticket with its own scope; the suite is a list, not a monolith.
- ✅ B6 (air-gapped) is the cornerstone-#2-aligned recasting of "Scale 2 enterprise" — the project-internal framing.

---

## Decision

### DQ-1: Canonical CLI tool for B2 — JSON Schema validator (Draft 2020-12)

**Decision:** B2's bloat-reduction comparison rewrites a JSON Schema validator targeting **JSON Schema Draft 2020-12** (the current reference standard) and compares the resulting yakcc-compiled binary against the **Ajv** NPM package (the de facto JS reference implementation).

**Rationale.** Three options were considered:

- **(a) JSON Schema validator** *(chosen)*. Spec is small, stable, well-defined. Ajv is a known reference (~50K SLOC, ~20 transitive deps, ~150KB minified). Validator decomposes naturally into reusable atoms (one per schema construct: `type`, `properties`, `required`, `format`, `pattern`, etc. — ~40-100 atoms estimated). Output is testable for semantic equivalence (validate same JSON → same true/false + same error path).
- **(b) Linter (ESLint subset).** Rejected. ESLint is ~300K SLOC plus ~40 transitive deps; rewriting even a subset is multi-year work. The bloat-reduction comparison would be valid but the engineering investment is wrong.
- **(c) CSV transformer.** Rejected. Too small to demonstrate the >90% bloat reduction claim meaningfully — the comparator NPM bundle (e.g., `csv-parse`) is already small (~30KB), so the absolute reduction would be modest.

JSON Schema validator is locked. The cornerstone "no versioning" applies — the choice is permanent for the benchmark, regardless of future schema-spec version drift. If JSON Schema 2030-XX supersedes 2020-12, B2's comparator updates to whatever the corresponding reference NPM impl is, but the methodology stays.

### DQ-2: Synthetic-transcript harness pre-hook — SHIP IT

**Decision:** Implement and ship `WI-BENCHMARK-B8-SYNTHETIC` (#192) as soon as `WI-V3-DISCOVERY-D1` (#151) lands. Do **not** wait for the production hook layer (`WI-HOOK-LAYER`, #194) to ship before producing scaling-curve data.

**Rationale.** B8-SYNTHETIC replays captured LLM transcripts through a simulated hook (the simulator wraps `executeRegistryQuery` and substitutes atom references in the transcript) to produce a preliminary scaling curve months before the production hook ships. The cost is bounded (~2-3 weeks of work post-D1) and the data informs:

- Calibration of D-HOOK-3's 200ms latency budget (synthetic can measure discovery latency without full hook overhead).
- Calibration of D2's auto-accept threshold (0.85 + 0.15 gap) against real-world transcript distributions.
- Provisional answers to B8-CURVE's curve-shape questions (breakeven, slope, asymptote) — useful for investor conversations even if labeled "preliminary, pre-hook."
- Validation that the production hook (Phase 2 substitution) is targeted at the right end of the curve.

The risk: synthetic numbers may not match real-hook numbers due to (a) interception artifacts the simulator doesn't model, (b) developer behavioral changes when substitutions are visible vs invisible, (c) calibration drift between simulator and production code. Mitigation: cross-validate B8-SYNTHETIC against B8-CURVE once both are available; report both sets of numbers; treat divergence as a measurement artifact to investigate, not as one set being "wrong."

The synthetic harness is **not** a replacement for B8-CURVE. It is an early-availability bridge.

### DQ-3: B7 ≤3s warm bar — achievable with current infrastructure

**Decision:** The B7 ≤3s warm-cache bar is **achievable with current property-test infrastructure** (vitest + fast-check + ts-morph). No new fast-path verifier needed pre-emptively. If B7 measurement shows the bar is unmet, file a fast-path-verifier WI as a follow-up; do not pre-build.

**Rationale.** Per-atom verification cost breakdown (warm cache, typical 20-line utility):

| Stage | Estimated cost |
|---|---|
| `ts-morph` parse + AST analysis | ~50-100ms |
| Spec canonicalization + BLAKE3 hashing | ~10ms |
| Property-test execution (100 numRuns via fast-check) | ~100-200ms |
| Contract structural validation | ~10ms |
| Atom registration in SQLite registry | ~10-30ms |
| **Total (warm)** | **~180-350ms** |

The 3s bar is ~10× the expected warm-path latency. The 10s hard cap is ~30× — both have substantial headroom. Cold-cache execution (first invocation, no JIT warmup, no SQLite page cache) may push toward 1-2s; still within bar.

Documented falsification: if B7 measurement shows median warm-cache wall-clock >3s, the assumption is wrong and a fast-path verifier (e.g., precomputed property-test manifests, JIT-warmed worker pool) becomes a real WI. Until measurement says otherwise, the existing stack is the verifier.

### DQ-4: B6 embedding provider — measure both modes

**Decision:** B6 measures the air-gapped guarantee against **both** the offline embedding provider (BLAKE3-based, default) AND the networked provider (Xenova/Transformers ONNX). The benchmark asserts:

1. **Default config (offline provider)**: zero outbound packets during a complete developer session (write code → shave → register glue → compile → execute). Hard requirement.
2. **Networked config (Xenova)**: outbound traffic is limited to the documented embedding-model hosting endpoint (HuggingFace model registry), exclusively for first-time model download. Operator-explicit; documented; cacheable for true air-gap mode.

**Rationale.** The embedding provider is the highest-leakage candidate in the yakcc stack — embeddings get computed for every novel atom and every query. If the provider has any implicit network behavior, the air-gapped claim fails silently.

The two-mode measurement isolates:

- **Offline mode**: validates that yakcc's default config (per `DEC-CI-OFFLINE-001`) actually produces zero outbound packets. This is the regulated-industry / air-gapped-VPC story.
- **Networked mode**: validates that operator-explicit network use is bounded — only the embedding model download, not telemetry / not analytics / not "phone home."

A leak in networked mode (e.g., Xenova making analytics calls) is a real bug, even though networked mode is opt-in. B6's coverage matrix catches this.

### DQ-5: Kill-criteria per benchmark — explicit table

**Decision:** Every benchmark has a documented kill-criterion. If the criterion fires on a real measurement, the corresponding architectural decision is reopened. The kill is the answer to "what would falsify the project's claim that this is a good idea?"

| Benchmark | Pass bar | Stretch | **Kill criterion** | What it kills |
|---|---|---|---|---|
| **B1** Latency vs native | ≤15% degradation (substrate); ≤25% (glue) | ≤10% / ≤15% | **>50% degradation on substrate-heavy workloads** | The AS-backend pivot (`DEC-AS-BACKEND-PIVOT-001`); triggers reconsideration of native-Rust target |
| **B2** Bloat reduction | ≥90% transitive weight cut | ≥95% | **<50% reduction on the JSON Schema validator rewrite** | The headline composition claim; the pitch's central numeric promise |
| **B3** Cache hit rate (boilerplate today) | ≥60% on boilerplate-classifiable | ≥75% | **<30% at corpus saturation on real workloads** | The hook-layer GTM thesis (`DEC-HOOK-LAYER-001`); discovery v3's `DEC-V3-INITIATIVE-001` measurement-first guardrail kicks in |
| **B4** Token expenditure | ≥70% reduction | ≥80% | **<40% reduction on identical task suite** | The cost-savings pitch (the "$Z/year per 1000 developers" slide) |
| **B5** Coherence (multi-turn) | ≥90% subsequent-turn coherence | ≥95% | **<80% coherence rate** | D-HOOK-4 contract-surfacing format; possibly D-HOOK-2 interception layer |
| **B6** Air-gapped | Zero outbound packets in default config | Zero in networked mode except documented endpoint | **ANY outbound packets in default config** | The air-gapped enterprise story; it's a regression, not a measurement |
| **B7** Time-to-commit (warm) | ≤3s median | ≤1s | **Median >10s warm** | The dev-flow story; B7's hard cap is the floor |
| **B8** Scaling curve | Breakeven ≤10% hit; asymptote ≥80% | ≤5% / ≥90% | **Breakeven >25% OR asymptote <50% OR semantic equivalence <90% OR non-monotonic curve** | The token-savings curve thesis as a whole; one fires → the paradigm has a real gap to address |

The kill-criteria are deliberately stricter than the pass bars. A benchmark that lands between the kill-criterion and the pass bar is "underperforming but not thesis-killing"; it triggers a calibration WI, not an architectural reconsideration.

### DQ-6: B8 corpus-stratification scheme — importance-weighted primary, uniform secondary

**Decision:** B8 Method A's corpus-subset sampling uses **importance-weighted stratification** as the primary scheme, with **uniform-random** sampling reported as a secondary sanity-check curve.

Importance weights derive from atom resolution-frequency in the benchmark task suite (B8 Method A's fixed N=50 task set). For each subset fraction `f`, the sample preserves the relative proportions of atoms-by-resolution-frequency. Atoms used in many tasks appear in early (low-`f`) subsets at higher probability; atoms used in few tasks appear later.

**Rationale.** Three options were considered:

- **(a) Uniform random.** Simplest but biased: a 10% random subset systematically under-represents high-frequency atoms, producing artificially low hit rates at low `f` and a curve that doesn't match real-world corpus growth (which biases toward useful atoms first).
- **(b) Importance-weighted by task-frequency** *(chosen primary)*. Models how a developer's local registry actually grows: useful atoms are added first (high importance weight), niche atoms added later. Produces a curve that approximates real-world saturation behavior.
- **(c) Manually curated subsets.** Author-specified subsets at each `f` (e.g., "the 10% most-useful atoms"). Highest fidelity but requires expert judgment per subset; introduces author bias; doesn't scale beyond the benchmark.

Reporting both importance-weighted (primary) and uniform-random (secondary) lets readers assess whether the curve shape is sensitive to stratification choice. If they disagree dramatically, the benchmark task suite has a frequency-bias issue worth investigating.

### DQ-7: B8 classical baseline includes Yakcc-aware prompting condition — YES

**Decision:** B8's comparator set includes **three** conditions, not two:

1. **Stock baseline**: LLM with no hook, no atom awareness. The "what users do today" condition.
2. **Yakcc-aware prompted**: LLM is told atoms exist, given examples and the registry's API surface, but no hook intercepts. Prompt-engineering only.
3. **Hooked**: Full WI-HOOK-LAYER Phase 2+ active. Substitution + contract surfacing.

**Rationale.** Without the middle condition, you cannot isolate the value of prompt engineering from the value of the interception mechanism. The relevant deltas:

- (Stock → Yakcc-aware prompted) = **value of the prompt-engineering insight alone**. May be substantial: telling an LLM "atoms exist, here's how to reference them" might recover 30%+ of the savings without any hook code.
- (Yakcc-aware prompted → Hooked) = **value of the hook mechanism beyond what prompting alone delivers**. This is the engineering ROI on building the hook layer.

If (Yakcc-aware prompted → Hooked) is small, the hook layer's engineering investment is questionable — maybe just shipping a prompt template would have been enough. If it's large, the hook layer is doing real work that prompts can't replicate.

This is honest measurement; it might surface that the hook layer is less valuable than expected. That's a benchmark working correctly.

### DQ-8: B8 agent lock — Claude Code in v3.0; cross-agent in v3.1

**Decision:** v3.0 of B8 measures against **Claude Code only**. Cross-agent generalization (Cursor, Codex, custom agents) is a v3.1 follow-up study with the same methodology.

**Rationale.** Cursor and Claude Code have different planning policies, different tool-call patterns, different turn counts on the same task. Locking the agent in v3.0:

- Produces clean curve data with a single source of variance (corpus subset, not agent variance).
- Publishes a defensible number sooner — the curve is "the curve under Claude Code."
- Simplifies the benchmark harness (one agent integration, not three).

v3.1 cross-agent measurement uses the same methodology (Method A + Method B), with each agent producing its own curve. Divergence between agent curves is itself a finding (e.g., "the curve generalizes" or "the curve depends on Claude-Code-specific behavior").

Sequencing: v3.0 ships when WI-HOOK-LAYER Phase 2 + WI-V3-DISCOVERY-IMPL-QUERY both land. v3.1 triggers if external pressure surfaces ("does this work for Cursor users?") or if an agent-divergence regression appears in v3.0 numbers across IDE versions.

### DQ-9: B8 zero-hit-by-construction tasks — report both curves

**Decision:** B8 reports **two curves**, distinguishable in published numbers:

1. **Curve A (all tasks)**: includes tasks where the corpus has no relevant atom regardless of saturation — these will always be 0% hit. Honest worst-case; the curve customers should plan against.
2. **Curve B (filtered to coverable tasks)**: limited to tasks where the corpus contains a relevant atom at full saturation. Honest best-case; the curve customers see in domains the corpus covers well.

Real-world performance lives between A and B. Publishing both prevents both over-promising (B alone) and under-promising (A alone).

**Rationale.** Excluding 0%-hit-by-construction tasks inflates the curve in a way that's invisible to the reader unless we publish the unfiltered version too. Including them flattens the curve in a way that's invisible to the reader unless we publish the filtered version too. Both presentations are necessary for the curve to be a fair representation.

The benchmark task suite (N=50) is documented with per-task atom-availability annotations: "task X is coverable by atom Y at full saturation" or "task Z has no atom in the corpus by construction." This metadata is what allows the curve A / curve B split.

---

## Cross-cutting commitments

**Reproducibility.** Every benchmark must run as `pnpm bench:<name>` from a clean clone with no manual setup beyond `pnpm install`. Sub-tickets implementing each benchmark add the corresponding script to root `package.json`. Benchmarks that require human-in-the-loop (B3, B5, B8 with real LLM sessions) document the manual steps in their per-benchmark README.

**Fixed corpora.** Each benchmark references a frozen input corpus, content-addressed. The corpus reference is part of the benchmark's identity; if the corpus hash changes, historical comparisons invalidate. This is the cornerstone "content-addressed" applied to benchmark inputs.

**CI integration.** B1, B2, B6 run nightly (via Tier 2 of `WI-CI-FAST-PATH`, #196). B3, B4, B5 run weekly or pre-release (human-in-the-loop). B7 nightly. B8-SYNTHETIC nightly once #192 lands; B8-CURVE manual / pre-release. Regressions on any nightly benchmark file an automatic GitHub issue (per `WI-CI-FAST-PATH` Phase 3).

**Connection to MASTER_PLAN exit criteria.** Each benchmark ID is the link target. When MASTER_PLAN has a numeric exit criterion ("yakcc-compiled WASM is ≤15% slower than native Rust"), it cites the benchmark ID (`see B1 / #185`) and is updated with the measured value when the benchmark first lands. Currently MASTER_PLAN's exit criteria are mostly qualitative; this commitment locks in the link convention so future numeric criteria default to benchmark-cited rather than handwave.

---

## Alternatives considered (cross-cutting)

### Alternative A: Single end-to-end benchmark instead of B1–B8

A combined benchmark that exercises everything (compile a real CLI, measure latency, measure tokens used by an agent, etc.) is conceptually simpler. Rejected because:

1. Failures are unattributable. A combined-benchmark regression doesn't tell you whether discovery, hook, compiler, or registry is the regression source.
2. Different benchmarks have different cadences. B6 wants per-PR; B8 wants pre-release. Combining forces the slowest cadence on all.
3. Different benchmarks have different audiences. B6 is for CISOs; B8 is for CFOs. Merging dilutes both pitches.

### Alternative B: External benchmark contractor / third-party validation

Pay an external party to run the benchmarks for independence. Useful for the investor narrative; not a substitute for an internal harness. The internal harness is what catches regressions in development; external validation ratifies a snapshot. Both have a role; this ADR designs the internal harness. External validation is a separate operations decision.

### Alternative C: Skip kill-criteria; just track pass bars

Common in ML benchmarking. Rejected because kill-criteria are exactly what makes the suite credible — without them, the benchmarks are "we tested, it passed" instead of "we tested with adversarial framing, here's what would have falsified each claim, none did." The credibility cost of skipping them is high.

---

## When to revisit

This ADR should be re-opened if any of the following occur:

- **A kill-criterion fires** on a real measurement. The corresponding architectural decision is reopened immediately. The benchmark methodology may also need revision if the criterion was wrong (too strict, too lenient).
- **A new benchmark is needed.** Adding benchmarks is monotonic — file a sub-ticket, append to this ADR, no version bump. Removing or renaming benchmarks is forbidden by the "no versioning" cornerstone applied to the suite itself.
- **A canonical CLI tool change** for B2. Locking JSON Schema 2020-12 is for B2's lifetime; if the spec is superseded and Ajv migrates accordingly, the comparator updates but the choice of "JSON Schema validator" stays.
- **A measurement-vs-design conflict.** If discovery quality (D5 measurements) shows the multi-dim schema's storage cost isn't justified, B3/B4 may need different infrastructure. The ADR's decisions are bounded by what infrastructure exists; if infrastructure shifts, decisions shift accordingly.
- **B8-SYNTHETIC and B8-CURVE produce divergent numbers.** Triggers investigation of the simulator's interception fidelity. Both curves stay published; the divergence is itself a finding.

---

## Implementation phase boundary

Phase 0 (this ADR) ships:

- This document at `docs/adr/benchmark-suite-methodology.md`
- `DEC-BENCHMARK-SUITE-001` row in MASTER_PLAN's Decision Log
- Sub-tickets #185–#193 are referenced; their pre-assigned-decision sections cite this ADR

Sub-ticket implementation (each is its own WI):

| Phase / Bench | WI | Issue | State | Cadence | Gates on |
|---|---|---|---|---|---|
| B6 | WI-BENCHMARK-B6 — air-gapped CI gate | #190 | unblocked NOW | Per-PR (Tier 1) | None — runnable today |
| B8-SYNTHETIC | WI-BENCHMARK-B8-SYNTHETIC — transcript replay scaling curve | #192 | gated on #151 (D1 only) | Nightly post-impl | WI-V3-DISCOVERY-D1 |
| B7 | WI-BENCHMARK-B7 — time-to-commit | #191 | unblocked (current verification path; per DQ-3) | Nightly post-impl | None — DQ-3 says current infra works |
| B1 | WI-BENCHMARK-B1 — latency vs native | #185 | gated on AS Phase 1 | Nightly post-impl | #145 (AS Phase 1 MVP) |
| B2 | WI-BENCHMARK-B2 — JSON-schema validator rewrite + bloat measurement | #186 | gated on corpus saturation | Nightly post-impl | #61 (PoC closer) + wave-4 atoms |
| B3 | WI-BENCHMARK-B3 — cache hit rate (3-day sprint) | #187 | gated on hook + discovery v3 | Pre-release | WI-HOOK-LAYER Phase 2 (#217), WI-V3-DISCOVERY-IMPL-QUERY |
| B4 | WI-BENCHMARK-B4 — token expenditure A/B | #188 | gated on hook + discovery v3 | Pre-release | Same as B3 |
| B5 | WI-BENCHMARK-B5 — multi-turn coherence | #189 | gated on hook contract surfacing | Pre-release | WI-HOOK-LAYER Phase 3 (#218) |
| B8-CURVE | WI-BENCHMARK-B8-CURVE — production scaling curve | #193 | gated on hook + discovery v3 | Pre-release | Same as B3 |

**Priority recommendation for sub-ticket dispatch:**

1. **B6 first** — runnable today, no prereq, becomes a CI Tier 1 gate per `WI-CI-FAST-PATH` Phase 1, gives us the air-gapped enterprise story immediately.
2. **B8-SYNTHETIC second** (when D1 lands) — earliest path to scaling-curve data, ~2-3 weeks of work, produces the "preliminary" version of the slide that closes the round.
3. **B7 third** (any time) — small effort, small dependencies, gives the "developer flow is preserved" story.
4. **B1 fourth** (when AS Phase 1 lands) — unblocks the latency story for substrate-heavy workloads.
5. **Remaining (B2, B3, B4, B5, B8-CURVE)** — gate on respective initiatives; not on critical path for v0.5 GTM but required for the full investor narrative.

---

## References

- Issue: https://github.com/cneckar/yakcc/issues/167
- B8 addition comment: https://github.com/cneckar/yakcc/issues/167#issuecomment-4407371810
- Sub-tickets: #185 (B1), #186 (B2), #187 (B3), #188 (B4), #189 (B5), #190 (B6), #191 (B7), #192 (B8-SYNTHETIC), #193 (B8-CURVE)
- Cornerstones: `AGENTS.md`
- Related decisions:
  - `DEC-HOOK-LAYER-001` (`docs/adr/hook-layer-architecture.md`) — gates B3/B4/B5/B7/B8
  - `DEC-AS-BACKEND-PIVOT-001` — gates B1
  - `DEC-V3-INITIATIVE-001` — measurement-first guardrail; coordinates with B3/B4/B8 timing
  - `DEC-CI-FAST-PATH-001/002/003` (#196 ADR, TBD) — B6 lands as Tier 1 CI gate
  - `DEC-CI-OFFLINE-001` — B6's offline-default guarantee
  - All six v3 discovery ADRs (D1–D6) — B3/B4/B5/B7/B8 all integrate with discovery
- Related initiatives:
  - WI-HOOK-LAYER (#194)
  - WI-CI-FAST-PATH (#196)
  - WI-V3-DISCOVERY-SYSTEM (#150)
  - WI-AS-BACKEND-INTEGRATION (#143)

---

## DEC-BENCH-COVERAGE-SHAVE-FIRST-001 — Coverage gaps fill via shave, not hand-written seeds

**Status:** Accepted (2026-05-16)
**Issue:** [#607](https://github.com/cneckar/yakcc/issues/607)
**Parent:** DEC-BENCHMARK-SUITE-001 (this ADR's root decision)
**Supersedes (in part):** the implicit "GAP → file seed-writing issue" pipeline of the 2026-05-13 B4 scan (#465 / #467 / #468 / #469)

### Context

The B4-tokens registry-coverage scan (`bench/B4-tokens/REGISTRY_COVERAGE.md`, generated 2026-05-13) flagged gaps with the recommendation "file a seed-writing issue." This was the bootstrap-era model. Since then:
- **WI-510 cascade** shipped headline bindings shaved from real npm packages: lodash, date-fns, uuid, nanoid, jsonwebtoken, bcryptjs (PRs #573, #584, #586, #598). Shave is the production fill-mechanism for real-world coverage.
- **WI-508 Slice 2** (import-intercept hook with shave-on-miss) makes shave run automatically when consumers hit registry misses. The corpus grows from real usage.
- **Seeds are L0 primitives only** (`level: "L0"` in `spec.yak`). They are parsing building blocks (ascii-char, bracket, comma, digit, peek-char, position-step, etc.) — not feature-level atoms.

Adding feature functions (json-pointer-token-splitter, base64-alphabet, semver-component-parser, memoize) to L0 seeds is a categorical mismatch — those belong in the shaved-corpus tier.

### Decision

Coverage scans MUST classify gaps shave-first:
- **L0-seed-gap** — true parsing primitive; no real-package equivalent; needed for bootstrap composition. Action: narrow seed-writing issue. Expected rare (<5/scan typical).
- **shave-queue** — npm package-shaped gap; names candidate package(s). Action: feed WI-510-style shave-corpus expansion target list. NO seed-writing issue.
- **shave-on-miss-eligible** — will fill automatically via WI-508 import-intercept hook when consumed. Action: none.

Plus the existing FULL / PARTIAL bands (kept for confidence-threshold cases).

### Audit (other benchmarks, 2026-05-16)

- **B5-coherence** — measures LLM behavior across multi-turn conversations; not a coverage-gap benchmark. No reshape.
- **B8-synthetic** — measures hit-rate via simulation; not a coverage-gap benchmark. No reshape.
- **B10-import-replacement** — already shave-aligned by construction (designed around import-replacement, not seeds). No reshape.
- **B1 / B6 / B7 / B9** — perf / correctness benchmarks. Orthogonal.
- **Only B4 was misaligned** and is reshaped per this decision.

### Consequences

- The B4 scan recommendation pipeline produces shave-queue entries (with named npm candidates) instead of seed-writing issues.
- Existing seed-gap issues #465 (memoize), #467 (json-pointer-token-splitter; already closed), #468 (base64-alphabet), #469 (semver-component-parser) are superseded; closed with shave-queue redirects post-merge of this decision.
- The B4 harness (`bench/B4-tokens/harness/`) may need an update to produce shave-queue entries in machine-readable form; deferred to a future slice (this decision is methodology-only).
- The 26 hand-written L0 seeds in `packages/seeds/src/blocks/` remain the bootstrap floor; new seeds are added only when a true L0 primitive is missing and no package equivalent exists.

### Out of scope

- Actually shaving the named npm candidates — downstream WI-510-cascade work, NOT this decision.
- B4 harness machine-readable output update — future slice.
- Changes to the shave engine — out of scope.
