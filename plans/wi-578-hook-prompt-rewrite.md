# WI-578 — Hook system prompt: enforce specific-first descent-and-compose

**Workflow ID:** wi-578-hook-prompt-rewrite
**Issue:** #578 (label: `load-bearing`, `claude-todo`)
**Branch:** `feature/578-hook-prompt-rewrite` (worktree to be provisioned)
**Status:** Planner output — implementer scope-bounded slice ready for provision after scope-amendment.

---

## 1. Problem statement (challenged)

GH #578 declares the current hook system prompt "suggests patterns instead of imposing them," and that loose initial intents return oversized atoms that defeat yakcc's value proposition (smaller surface area).

Before accepting the brief verbatim, the planner challenged the framing on three axes:

| Question | Finding | Disposition |
| --- | --- | --- |
| Is the prompt actually duplicated across 3 IDE packages, requiring consolidation first? | No. The prompt text is a single file: `docs/system-prompts/yakcc-discovery.md`. All three IDE adapters reference it via the path constant `SYSTEM_PROMPT_PATH` (which IS duplicated — but the prompt content is not). | **Single source of truth already exists.** Consolidation step from issue is unnecessary. The optional cleanup is folding the path constant into `@yakcc/hooks-base`, but that is a separate, low-value refactor and is **out of scope** for #578. |
| Is import-intercept the LLM-prompt surface — can the runtime force descent? | No. `import-intercept.ts` runs a *deterministic, programmatic* `yakccResolve()` query — it is not the LLM's hook prompt. The LLM consumes the prompt via the IDE tool-surface (Claude Code MCP, Cursor extension, Codex hook), which loads `docs/system-prompts/yakcc-discovery.md`. The LLM owns the decision to recurse. | **Descent enforcement is text-level only.** Runtime cannot mandate descent depth; the prompt must induce it. |
| Does the existing telemetry surface capture descent depth? | No. `TelemetryEvent` (packages/hooks-base/src/telemetry.ts) captures per-call fields (`outcome`, `candidateCount`, `topScore`, `top1Score`, `top1Gap`, `substituted`, etc.) but has no notion of "this is the Nth recursive resolve for the same parent intent." | **Descent-depth assertion requires either (a) a new telemetry field stamped by the LLM in the tool call, or (b) post-hoc grouping by session + intent-hash-prefix sequence.** See §6 telemetry design. |

**Restated problem:** the canonical D4-ADR-governed file `docs/system-prompts/yakcc-discovery.md` reads as a polite invitation to use yakcc when convenient ("first call `yakcc_resolve`", "Reserve hand-written code for…", "If unreachable, fall back…") and offers no explicit instruction for what to do on a miss other than "widen the query." This permits — and in practice produces — loose initial intents. The fix is a **prompt rewrite** of that one file, plus an evaluation contract that proves the rewrite changed observable behavior.

---

## 2. Goals / non-goals

### Goals (in scope)
- G1: Rewrite `docs/system-prompts/yakcc-discovery.md` with imperative ("You MUST") descent-and-compose language including the URL-parser walkthrough, refusal of loose intents, and a self-check step. (Acceptance §1–5 of #578.)
- G2: Bump `INTENT_PROMPT_VERSION` if any related cache contract change is needed (anticipated: no — the cache-keyed prompt is the `shave/intent/prompt.ts` one, not the discovery prompt; verify this in implementation).
- G3: Land a test corpus (`packages/hooks-base/test/system-prompt-integration.test.ts`) of paired loose/tight intents documenting the **expected behavior shift**.
- G4: Land a unit-level prompt assertion (`packages/hooks-base/src/system-prompt.test.ts`) that **grep-style verifies** the rewritten file contains required substrings (imperative tokens, URL-parser walkthrough, self-check) and does NOT contain forbidden ones (soft suggestions, carve-outs).
- G5: Land a negative test scaffold proving a loose-intent prompt produces refusal/self-correction. Because LLM behavior is non-deterministic, this test uses a deterministic stub or a snapshot of an Anthropic transcript (see §5).
- G6: Scaffold a telemetry assertion (instrumented but threshold-deferred until #569 follow-up enables descent-depth capture, OR implement the post-hoc grouping inference described in §6) for: "of next N hook invocations post-rewrite, ≥ X% of misses show recursion depth ≥ 1."
- G7: Update the D4 ADR (`docs/adr/discovery-llm-interaction.md`) with a Q-extension explaining the descent-and-compose addition — required because the prompt file carries the comment "changes to this file require a D4 ADR revision."

### Non-goals (explicit)
- N1: **Do NOT modify `packages/shave/src/intent/prompt.ts`.** That is the intent-extraction prompt sent to Haiku during shave, not the LLM hook prompt. It is forbidden in the workflow scope and is unrelated to #578.
- N2: **Do NOT consolidate the `SYSTEM_PROMPT_PATH` constant** across IDE packages in this WI. The prompt content is already single-source; the path constant duplication is a tangential refactor that risks scope creep.
- N3: **Do NOT add a new IDE adapter or wire `packages/hooks-codex/src/yakcc-resolve-tool.ts`.** That file is listed in the workflow scope but does not exist; it is part of a future Codex parity WI, not #578.
- N4: **Do NOT modify `packages/hooks-base/src/import-intercept.ts` LLM-decision logic.** The intercept is a deterministic registry query and is not a place where prompt-level descent can be enforced. The only allowed change to import-intercept (if any) is **telemetry-emit additions** for the descent-depth signal (G6) — and even that is optional.
- N5: **Do NOT alter the D2/D3/D4 envelope shape, 4-band thresholds, or `ResolveResult` schema.** Behavior changes are prompt-text-only.

---

## 3. Unknowns / decisions deferred

| Unknown | Resolution path |
| --- | --- |
| U1: Does `INTENT_PROMPT_VERSION` (`packages/shave/src/intent/constants.ts`) need bumping? | **No** by inspection — that version governs the SHAVE intent-extraction prompt (`packages/shave/src/intent/prompt.ts`), not the discovery system prompt. Confirm during implementation via grep for `INTENT_PROMPT_VERSION` usages; no rewrite of `shave/intent/prompt.ts` means no bump. |
| U2: How to deterministically prove "loose query produces refusal" in the negative test, given LLM non-determinism? | Three options, ordered by preference: (a) **assertion against the rewritten prompt text** (refusal language is present) + (b) **a recorded-transcript fixture** capturing a real Haiku call where the rewritten prompt induces refusal for one canonical loose query (`"validation"`), checked into `tmp/wi-578-investigation/transcripts/`. Option (c) wiring a runtime stub for the discovery LLM call is out of scope because the LLM call lives in the IDE, not in our code. |
| U3: Should descent-depth telemetry be inferred post-hoc (no runtime change) or stamped explicitly (LLM passes a `parentIntentHash`)? | **Implementation chooses inference path** unless trivial. Post-hoc: group `TelemetryEvent` rows by session ID, sort by `t`, mark consecutive misses where intent-hash B's intent string is a strict sub-phrase / narrower form of A's intent string as `depth >= 1`. This requires no LLM contract change but requires storing intent text temporarily for the analysis (currently only `intentHash` is stored). Approval gate: if inference is infeasible without a privacy-policy change, implementer flags and we defer descent-depth to a follow-up filed against #569. |
| U4: ADR revision requirement — must the D4 ADR be revised in the same commit, or filed as a follow-up? | **Same commit.** The prompt file's header comment makes the ADR the authority; merging a prompt change without a corresponding ADR Q-extension would break the authority invariant. Implementer adds a Q9 (or similarly numbered) section to `docs/adr/discovery-llm-interaction.md` capturing the descent-and-compose addition. — **Note: this requires expanding the allowed-paths scope** (see §10 scope manifest). |

---

## 4. Architecture / state-authority map

| Surface | Authority | Role in #578 |
| --- | --- | --- |
| `docs/system-prompts/yakcc-discovery.md` | governed by D4 ADR `DEC-V3-DISCOVERY-D4-001` | **Primary rewrite target.** Single source of truth for the hook LLM system prompt. Loaded by all IDE adapters via `SYSTEM_PROMPT_PATH`. |
| `docs/adr/discovery-llm-interaction.md` | DEC-V3-DISCOVERY-D4-001 authority itself | Must be updated with a new Q-section (e.g., Q9 "Descent-and-Compose Discipline") documenting the new prompt invariants. |
| `packages/hooks-{claude-code,cursor}/src/yakcc-resolve-tool.ts` | DEC-HOOK-PHASE-3-L3-MCP-001, DEC-HOOK-CURSOR-PHASE4-002 | Read-only consumers of `SYSTEM_PROMPT_PATH`. NOT modified by #578. |
| `packages/hooks-base/src/import-intercept.ts` | DEC-WI508-INTERCEPT-001..006 | Deterministic registry-query path. NOT a prompt surface. Modified ONLY for descent-depth telemetry if §6 inference path is infeasible. |
| `packages/hooks-base/src/telemetry.ts` | DEC-HOOK-PHASE-1-001 | Optional: extend `TelemetryEvent` with a `descendedFromIntentHash?: string` field if approach (b) of U3 is taken. |
| `packages/shave/src/intent/prompt.ts` + `constants.ts` | DEC-CONTINUOUS-SHAVE-022 | **Unrelated.** Intent-extraction (Haiku) prompt for shave pipeline. Listed as candidate by orchestrator dispatch context but inventory disproved relevance. **Not touched.** |
| `packages/hooks-codex/src/yakcc-resolve-tool.ts` | (does not exist) | Future Codex parity WI. **Not created here.** |

### Single-source-of-truth verdict
- The **prompt content** has a single source of truth: `docs/system-prompts/yakcc-discovery.md`. No consolidation required.
- The **path constant** `SYSTEM_PROMPT_PATH = "docs/system-prompts/yakcc-discovery.md"` is duplicated in two IDE packages (hooks-claude-code, hooks-cursor). This is a marker-file/registration constant — its duplication does not cause prompt drift because they all point at the same file. Folding it into hooks-base is a tangential refactor and is **deferred** to a backlog item if motivated by a future change.

---

## 5. The rewrite design (proposed text)

**Implementer will COPY this verbatim into `docs/system-prompts/yakcc-discovery.md`.**

```markdown
# Authority: DEC-V3-DISCOVERY-D4-001 (docs/adr/discovery-llm-interaction.md) — changes to this file require a D4 ADR revision.

You have access to the yakcc discovery system via the `yakcc_resolve` tool. The
rules below are not suggestions. They define the only acceptable way to write
generic operations in this project.

## The rule

You MUST start every search with the most specific intent you can articulate
for the immediate need. A loose initial intent is a defect — it produces
oversized atoms that carry unused capabilities into the project. Unused code is
attack surface, complexity debt, and reasoning load.

You MUST NOT widen an intent to make a search hit. Widening is the failure
mode this prompt exists to prevent. If you catch yourself reaching for a
broader phrasing because "the narrow one missed," stop and apply the descent
rule below.

There are NO carve-outs. "It's just business logic," "this is a one-off," and
"the abstraction would be premature" are not valid reasons to skip discovery.

## Self-check before every `yakcc_resolve` call

Before you submit a query, answer these two questions silently:

  1. Is this intent the most specific I can articulate for what the immediate
     caller needs? If no — narrow it now and re-check.
  2. Could a smaller piece of this intent already exist as its own atom? If
     yes — search for that smaller piece first.

If either answer leaves you submitting a vague query (`"validation"`,
`"parser"`, `"utility"`, `"helper"`, single-word intents in general), refuse
to submit. Write the user a short note explaining why the intent was too broad
and what specific sub-intent you will search for instead.

## Descent on miss — always zoom in, never zoom out

A `no_match` or `weak_only` result is a signal that one of two things is true:

  (A) The atom does not yet exist at this specificity. Correct response:
      decompose the intent into sub-intents and query each.
  (B) The intent is still too broad. Correct response: decompose further.

In both cases the response is the same: **decompose, then query each piece**.

Recurse until each leaf intent either hits the registry at score >= 0.70
(`status === "matched"`) or bottoms out at a primitive operation you must
compose by hand. Then compose upward from the leaves into the larger atom the
original caller needed, and emit a NEW_ATOM_PROPOSAL block describing the
composed atom so the registry's coverage improves and the next consumer with
the same intent gets a direct hit.

## Worked example: building a URL parser

First-time request: "build a URL parser."

  - Initial intent: "URL parser." MISS.
  - Decompose: "split URL into scheme + host + path + query + fragment." MISS.
  - Decompose further:
      * "split string on first `://`" — HIT.
      * "split string on first `/` after position N" — HIT.
      * "split key=value pairs on `&`" — HIT.
      * "percent-decode bytes" — MISS.
          - Decompose: "decode `%XX` hex pair to a single byte" — HIT.
  - Compose upward: assemble the URL parser from those leaf atoms. Persist
    the composed result via NEW_ATOM_PROPOSAL with intent
    "URL parser (RFC 3986 subset, no IDNA)."
  - The first request is expensive. Every subsequent request for "URL parser"
    is one lookup. That asymptotic win is the whole reason this discipline
    exists.

You MUST walk this exact pattern on any miss. The example is not
illustrative — it is the protocol.

## What `yakcc_resolve` returns

The tool takes a `QueryIntentCard` and returns up to topK candidate atoms.
Each candidate carries a `combinedScore` in [0, 1] and a band classification:

  - score >= 0.85 (strong):     reference the atom by BlockMerkleRoot.
  - 0.70 - 0.85   (confident):  reference the atom; note it in your reply.
  - 0.50 - 0.70   (weak):       this is a `weak_only` status — apply the
                                descent rule above. Do NOT use the weak
                                candidate as a substitute for a tight match.
  - score <  0.50 (poor):       `status === "no_match"`. Apply the descent
                                rule above. Do NOT silently write the code.

`auto-accept`: when `combinedScore > 0.85` AND the gap to the second-best
candidate is > 0.15, you MUST insert the BlockMerkleRoot reference into the
project manifest without prompting the user.

## Building the intent card

  - `behavior`: a one-line natural-language description. Specific verbs
                ("split string on first `://`"), not generic ones ("handle
                URLs").
  - `guarantees`: an array of specific properties the code must satisfy.
                "rejects non-integer values" disambiguates from "rejects
                non-numeric values."
  - `signature`: input/output types as { name?, type } pairs.
  - `errorConditions`, `propertyTests`, `nonFunctional`: optional dimensions
                that narrow the search. Use them.
  - `weights`: optional per-dimension floats; omit for equal weighting.

## When the tool is unreachable

If `yakcc_resolve` is unreachable (registry offline, transport error), you may
fall back to writing the code directly, but you MUST emit a
REGISTRY_UNREACHABLE note in your output so the user can audit later. The
fallback path is for outages only — it is not an escape hatch from the
discipline above.
```

**Length:** ~75 lines of prose. Token budget impact: roughly 2.5x the current 49-line prompt. This is acceptable: the prompt is loaded once per IDE session, not per query, and the per-query token cost is unchanged.

**Verifiable invariants** (the unit test will grep for these):
- Contains: `You MUST` (≥ 4 occurrences), `You MUST NOT` (≥ 1), `NO carve-outs`, `URL parser`, `decompose`, `descent`, `self-check`, `refuse`, `NEW_ATOM_PROPOSAL`.
- Does NOT contain: `You SHOULD consider`, `Reserve hand-written code`, `Try to`, `When possible`, `business logic`, `one-off`.

---

## 6. Telemetry & descent-depth assertion design

### Today's surface
`TelemetryEvent` is per-emission with no notion of "this call is a descendant of an earlier call." `intent` is BLAKE3-hashed at write time and the plaintext is not retained.

### Two viable designs

**Design A — post-hoc inference (preferred, no contract change).**
1. Within a single session ID, sort `TelemetryEvent` records by `t`.
2. For each `outcome === "synthesis-required"` or `topScore < 0.70` event, look at the *next* event within a short window (e.g., 30s) in the same session.
3. If the next event's intent hash differs AND a runtime-side counter (kept in `import-intercept` memory for the lifetime of the hook process) recorded that this session emitted ≥ 2 resolve calls back-to-back, mark `depth >= 1`.
4. Assertion: of N misses, ≥ X% have a follow-on resolve within 30s in the same session.

Drawback: the LLM might compose answers across multiple files and the descent signal is heuristic. Acceptable for the assertion because the alternative (instrumenting the LLM contract) is out of reach.

**Design B — explicit (contract change, smaller scope).**
Add a single optional field to `TelemetryEvent`:
```ts
readonly parentIntentHash?: string | null;
```
The LLM can pass this in the tool call args (extend `YakccResolveToolArgs`):
```ts
readonly parentIntent?: string;
```
The tool surface hashes the parent and stamps it into telemetry. The LLM is *prompted* to pass `parentIntent` when its current call is a descent step (the prompt §5 already implies this via the descent rule).

Drawback: requires an additive change to `TelemetryEvent` (additive is fine — DEC-HOOK-PHASE-1-001 explicitly supports additive fields), and requires the LLM to honor the parent-passing convention.

### Recommendation
**Implementer ships Design A (heuristic + session-grouped) as the test scaffold.** Wire the test to assert `≥ 50%` descent-on-miss as a *placeholder threshold*. If real-world traces show the heuristic is too noisy, follow up with Design B in a sister WI. The placeholder threshold is documented as such; if there are fewer than 20 hook invocations in the window when the test runs, the assertion is skipped (telemetry-thin guard).

### Where the assertion lives
`packages/hooks-base/test/system-prompt-integration.test.ts`. The test reads `~/.yakcc/telemetry/<session-id>.jsonl` for a controlled scenario, applies the Design A inference, and asserts the threshold.

---

## 7. Test corpus (paired loose/tight)

Implementer creates `tmp/wi-578-investigation/test-corpus.json` (committed under the allowed `tmp/wi-578-investigation/**` path) capturing pairs of intents where the pre-rewrite prompt would have produced the loose one and the post-rewrite prompt should produce the tight one:

| # | Loose (pre-rewrite) | Tight (post-rewrite expected) |
| --- | --- | --- |
| 1 | `"validation"` | `"validate email per RFC 5322 local-part subset, no display name"` |
| 2 | `"parser"` | `"parse RFC 3986 URL into {scheme, host, path, query, fragment}"` |
| 3 | `"date helper"` | `"format ISO 8601 timestamp to UTC string with millisecond precision"` |
| 4 | `"sanitize input"` | `"strip HTML tags from string, preserve text content, decode &amp; entities"` |
| 5 | `"hash"` | `"BLAKE3-256 hex digest of a UTF-8 string"` |
| 6 | `"compare"` | `"deep structural equality for JSON values (no NaN, no functions)"` |
| 7 | `"retry"` | `"retry async function with exponential backoff: base=100ms, factor=2, max=5 tries"` |
| 8 | `"throttle"` | `"throttle a function: at most one call per N ms, drop intermediate calls"` |
| 9 | `"format"` | `"format number with thousands separator and fixed 2 decimal places"` |
| 10 | `"slug"` | `"convert string to URL slug: lowercase, hyphenate spaces, strip non-ASCII"` |

The unit test (G4) verifies that **each `loose` entry contains zero specific verbs/nouns from a forbidden list (`validate`, `parse`, `format`, `hash`, etc.) AND each `tight` entry contains at least one specific verb plus a noun**. The negative test (G5) records what the LLM does when given the loose intent under the new prompt; the expected outcome per pair is *self-correction or refusal*, not silent execution.

---

## 8. Slice decomposition — recommendation: single slice

Issue suggests P0/P1/P2 split, but inventory shows:
- **P0 audit + consolidation** is unnecessary — single source of truth already exists.
- **P1 rewrite + tests** is the substantive work, ~1.5–2 days.
- **P2 telemetry assertion** can fit inside this slice if Design A (heuristic, no contract change) is chosen.

**Recommendation:** ship as a single WI-578 slice with the following implementer plan:

| Step | Output | Files |
| --- | --- | --- |
| 1 | Rewrite the prompt file with §5 text | `docs/system-prompts/yakcc-discovery.md` |
| 2 | Add ADR Q-section documenting the descent-and-compose addition | `docs/adr/discovery-llm-interaction.md` |
| 3 | Add the unit test that greps the new prompt for required/forbidden substrings | `packages/hooks-base/src/system-prompt.test.ts` (new) |
| 4 | Add a `system-prompt.ts` helper that exports the prompt-file path constant + a `loadDiscoveryPrompt()` reader (the test imports this; this is the optional minor consolidation toward a single path constant — implementer may skip if it expands scope) | `packages/hooks-base/src/system-prompt.ts` (new) |
| 5 | Create the test corpus JSON | `tmp/wi-578-investigation/test-corpus.json` |
| 6 | Add integration test that loads the corpus, optionally exercises a stubbed/recorded LLM transcript fixture | `packages/hooks-base/test/system-prompt-integration.test.ts` (new) |
| 7 | Add the descent-depth telemetry assertion (Design A) inside the integration test | (same file as step 6) |
| 8 | Run `pnpm -w lint typecheck test` to prove green; rebase on `origin/main` first per memory note | n/a |
| 9 | Hand off to reviewer with REVIEW_VERDICT trailer | n/a |

If during implementation step 7 the heuristic descent-depth inference proves infeasible (no real telemetry to inspect under test), implementer is authorized to **scaffold-only** the telemetry assertion (skip the threshold check, leave a `it.todo`) and file a follow-up issue against #569.

---

## 9. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| R1: ADR revision requires expanding the workflow scope to include `docs/adr/discovery-llm-interaction.md`. | **Plan amendment required** (see §10). Reviewer must approve scope-set expansion via `cc-policy workflow scope-sync` before implementer starts. |
| R2: The 75-line prompt is ~2.5x the current 49 lines. Token cost is per-session, not per-query, so impact is negligible — but verify. | Implementer notes pre/post line+token counts in the PR description. |
| R3: Negative test for "loose query produces refusal" is fundamentally LLM-non-deterministic. | Lean on the unit-level grep test (deterministic) + a *recorded* Anthropic transcript fixture for one canonical case. Do NOT make the integration test depend on a live LLM call. |
| R4: Descent-depth heuristic (Design A) might be too noisy or yield zero data in CI. | Test guards with a `skip-if-thin` check (< 20 events ⇒ skip), and the threshold is documented as a placeholder. Real-world tuning is a follow-up against #569. |
| R5: Implementer might try to also rewrite `packages/shave/src/intent/prompt.ts`. | Plan explicitly forbids it (§2 N1); scope manifest forbids `packages/shave/src/intent/extract.ts` and `static-extract.ts`. `prompt.ts` is allowed by the scope but the plan says **do not touch**; reviewer rejects on touch. |
| R6: The "refusal" behavior in the prompt could degrade UX if the LLM refuses too aggressively. | The prompt §5 frames refusal as "write the user a short note explaining why the intent was too broad and what specific sub-intent you will search for instead" — i.e., self-correction with explanation, not a hard error. |

---

## 10. Scope manifest — **REQUIRES AMENDMENT BEFORE PROVISIONING**

The dispatched scope (per the workflow contract block) **does not include** the two files that must be edited:
- `docs/system-prompts/yakcc-discovery.md` (the actual rewrite target)
- `docs/adr/discovery-llm-interaction.md` (the governing ADR that must be updated in the same commit)

The dispatched scope also lists `packages/hooks-codex/src/yakcc-resolve-tool.ts` which **does not exist** and is unrelated.

**Required scope amendment before guardian provisioning:**

### allowed_paths (additions)
```
docs/system-prompts/yakcc-discovery.md
docs/adr/discovery-llm-interaction.md
packages/hooks-base/src/system-prompt.ts
packages/hooks-base/src/system-prompt.test.ts
packages/hooks-base/test/system-prompt-integration.test.ts
tmp/wi-578-investigation/*
tmp/wi-578-investigation/**/*
plans/wi-578-hook-prompt-rewrite.md
```

### required_paths
```
docs/system-prompts/yakcc-discovery.md
docs/adr/discovery-llm-interaction.md
plans/wi-578-hook-prompt-rewrite.md
packages/hooks-base/src/system-prompt.test.ts
packages/hooks-base/test/system-prompt-integration.test.ts
```

### forbidden_paths (carry-over from dispatch + clarifications)
```
packages/shave/src/intent/prompt.ts           # plan-level forbidden (see §2 N1)
packages/shave/src/intent/extract.ts
packages/shave/src/intent/static-extract.ts
packages/shave/src/intent/types.ts
packages/shave/src/intent/anthropic-client.ts
packages/{compile,contracts,registry,cli,federation,ir,seeds,variance}/**
packages/shave/src/cache/**
packages/shave/src/universalize/**
packages/shave/src/errors.ts
packages/hooks-codex/src/yakcc-resolve-tool.ts   # does not exist; do not create
.github/**
.claude/**
MASTER_PLAN.md
```

### authority_domains
```
hook-llm-prompt           (D4 ADR DEC-V3-DISCOVERY-D4-001)
yakcc-resolve-tool-prompt (carry-over)
```

**Action for guardian:provision:** rewrite the scope JSON via `cc-policy workflow scope-sync wi-578-hook-prompt-rewrite --work-item-id wi-578-hook-prompt-rewrite --scope-file tmp/wi-578-scope.json` using the manifest above.

---

## 11. Evaluation contract (for reviewer / guardian readiness)

### Required tests (must pass)
1. `packages/hooks-base/src/system-prompt.test.ts`: unit grep test asserts presence of required imperative tokens and absence of forbidden soft tokens.
2. `packages/hooks-base/test/system-prompt-integration.test.ts`: loads `tmp/wi-578-investigation/test-corpus.json`; asserts each loose entry meets the "loose" definition and each tight entry meets the "tight" definition; runs the descent-depth Design A heuristic on a controlled telemetry fixture and asserts ≥ X% (placeholder X=50) — OR skips with reason "telemetry-thin" if < 20 events.
3. Existing tests: `pnpm -w test --filter @yakcc/hooks-base --filter @yakcc/hooks-claude-code --filter @yakcc/hooks-cursor` all green.

### Required real-path checks
1. `docs/system-prompts/yakcc-discovery.md` exists and contains the §5 text verbatim.
2. `docs/adr/discovery-llm-interaction.md` contains a new Q-section dated post-2026-05-15 documenting the descent-and-compose addition.
3. `packages/hooks-{claude-code,cursor}/src/yakcc-resolve-tool.ts` continue to reference `SYSTEM_PROMPT_PATH = "docs/system-prompts/yakcc-discovery.md"` (regression-style check that the path was not accidentally changed).

### Required authority invariants
1. Imperative language: `grep -c "You MUST" docs/system-prompts/yakcc-discovery.md` ≥ 4.
2. No soft suggestions: `grep -c "You SHOULD consider\|Try to\|When possible" docs/system-prompts/yakcc-discovery.md` == 0.
3. No carve-outs: `grep -ci "business logic\|one-off\|application-specific" docs/system-prompts/yakcc-discovery.md` == 0.
4. URL-parser walkthrough present: `grep -c "URL parser" docs/system-prompts/yakcc-discovery.md` ≥ 1.
5. Self-check present: `grep -c "self-check\|Self-check" docs/system-prompts/yakcc-discovery.md` ≥ 1.
6. Single source of truth preserved: `find packages -name '*.ts' -not -path '*/dist/*' -not -path '*/node_modules/*' -exec grep -l '"SYSTEM_PROMPT_PATH"' {} \;` returns ≤ 2 files (the existing 2 IDE adapters); no new copies.
7. D4 ADR updated: `grep -c "descent-and-compose\|Descent-and-Compose" docs/adr/discovery-llm-interaction.md` ≥ 1.

### Required integration points
1. Telemetry surface (`packages/hooks-base/src/telemetry.ts`) untouched OR additive-only per DEC-HOOK-PHASE-1-001.
2. Import-intercept path (`packages/hooks-base/src/import-intercept.ts`) untouched (observe-don't-mutate per DEC-WI508-INTERCEPT-004).
3. `INTENT_PROMPT_VERSION` (`packages/shave/src/intent/constants.ts`) NOT bumped (validates non-goal N1).

### Forbidden shortcuts
1. **Do NOT soften the imperative language** to make tests pass on first run.
2. **Do NOT skip the URL-parser walkthrough** or replace it with a less concrete example.
3. **Do NOT add carve-outs** for "business logic" / "one-off" / "application-specific" — even with caveats.
4. **Do NOT duplicate the prompt text** in any package source file. The prompt content stays in the one `.md` file.
5. **Do NOT modify `packages/shave/src/intent/prompt.ts`** — it is a different prompt and out of scope.
6. **Do NOT weaken the negative test** by lowering the threshold or removing the assertion to get a green run.

### Ready-for-guardian definition
- All required tests green on the implementer's worktree HEAD.
- All required authority invariants verified by grep on the implementer's worktree HEAD.
- All required real-path checks pass.
- D4 ADR updated; same commit.
- `pnpm -w lint typecheck test` green; rebased on `origin/main` (per persistent memory: branches must track `origin/main` before push, not just at provisioning).
- Reviewer issues `REVIEW_VERDICT: ready_for_guardian`.

### Rollback boundary
`git revert` the landing commit. The prompt reverts to its current 49-line "suggesting" form; behavior reverts to the baseline #578 documents. The ADR Q-section also reverts cleanly because it is additive.

---

## 12. Pre-push hygiene (carry-over per memory note)

Implementer MUST, before declaring ready:
1. `git fetch origin && git rebase origin/main` (memory: branches must track `origin/main` before push, not just at provisioning).
2. `pnpm -w lint` green.
3. `pnpm -w typecheck` green.
4. `pnpm -w test --filter @yakcc/hooks-base --filter @yakcc/hooks-claude-code --filter @yakcc/hooks-cursor` green.
5. `git diff --stat origin/main..HEAD` — sanity-check that the diff does not accidentally include unrelated parallel-sister churn (memory note: PR #45 lost 17k lines from this exact failure mode).

---

## 13. Decision log entry (to be added to MASTER_PLAN.md after landing)

```
| DEC-HOOK-PROMPT-DESCENT-001 | **WI-578 (#578, load-bearing), 2026-05-XX.** Rewrote
docs/system-prompts/yakcc-discovery.md from suggesting tone to imperative descent-and-
compose discipline. Adds (a) explicit refusal of loose initial intents ("validation",
"parser", etc.), (b) a mandatory self-check step before every yakcc_resolve call,
(c) the descent rule for misses (decompose, query each leaf, compose upward,
NEW_ATOM_PROPOSAL), and (d) a verbatim URL-parser walkthrough as the canonical
protocol. D4 ADR docs/adr/discovery-llm-interaction.md gains a Q9 section
documenting the addition. Telemetry surface unchanged (additive-only path
preserved); descent-depth assertion uses Design A heuristic with a documented
placeholder threshold pending #569 follow-up tuning. Single source of truth preserved
(prompt content lives in one .md file; SYSTEM_PROMPT_PATH constant duplication is
unchanged and unrelated). | Source: WI-578. Authority change to D4 ADR text is
captured in the ADR revision. Cross-references: DEC-V3-DISCOVERY-D4-001 (authority),
DEC-HOOK-PHASE-3-L3-MCP-001 (tool surface that loads the prompt),
DEC-HOOK-CURSOR-PHASE4-002 (cursor mirror), DEC-WI508-INTERCEPT-004 (observe-don't-
mutate invariant preserved), DEC-HOOK-PHASE-1-001 (telemetry additive-only contract). |
```

---

## 14. Planner verdict rationale

This is a single implementable slice once the scope manifest is amended (§10).
The amendment is mechanical (`cc-policy workflow scope-sync`) and is the next
canonical action for `guardian:provision`. Implementer can then proceed end-to-
end without a second user-decision boundary.

The scope amendment IS NOT a user-decision boundary — it is provisioning
adjustment. The user already approved this WI by selecting it from the backlog
queue; the planner's job is to define the executable scope, which it has done.

**Next canonical action:** `guardian:provision` with the §10 scope manifest.

---

*end of plan*
