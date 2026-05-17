# WI-634: Trim telemetry.ts so its derived IntentCard `behavior` fits ≤200 chars

Closes #634.

## Problem

`yakcc bootstrap` on main @ `cbefa3c` raises `IntentCardSchemaError` while
shaving `packages/hooks-base/src/telemetry.ts`:

```
IntentCard schema violation: field "behavior" must be ≤200 characters, got 222
```

The 200-char rule is enforced at
`packages/shave/src/intent/validate-intent-card.ts:145-146`. That validator
runs against IntentCards produced by the LLM shave step (i.e. the OUTPUT side
of shave, what we cache and serve at runtime). One of the IntentCards
extracted from `telemetry.ts` arrives with a 222-char `behavior` string and
fails validation, breaking bootstrap for this file (and any downstream
benchmark that re-bootstraps).

## Why Option B (fix upstream truncation) is the wrong shape

The issue body asks whether the auto-truncation path in
`packages/contracts/src/source-extract.ts:498-504` (`extractFirstSentence`,
slice to 197 + "...") should have caught this. After investigating, the
answer is **no**, and that path should not be changed for this bug:

- `extractFirstSentence` feeds `extractJsDoc()` (same file, line 178), which
  is consumed by `queryIntentCardFromSource` in
  `packages/contracts/src/query-from-source.ts:138` to produce a
  **QueryIntentCard** (the static, deterministic descriptor used to embed/query
  the registry).
- The 200-char rule that failed bootstrap is in
  `packages/shave/src/intent/validate-intent-card.ts`, which validates the
  **IntentCard** produced by the LLM shave step. That is a different object
  on a different code path (LLM completion → schema validator → cache).
- A QueryIntentCard's `behavior` already gets the 197+"..." truncation. The
  LLM-output IntentCard does NOT — by design, the validator is the contract
  the LLM must satisfy, not a place to silently truncate.

Silently truncating LLM output to 200 chars would mask prompt-quality
regressions and re-introduce the "fallback chain" antipattern Architecture
Preservation forbids. So we do not touch source-extract.ts here.

## Why Option A (trim the JSDoc) is the right shape

The LLM derives `behavior` from the static signals it is shown for the file,
the dominant one being the file/header-block JSDoc summary plus the JSDoc on
the primary declaration. Today, `telemetry.ts` carries a very long
header-comment block on the `TelemetryEvent` type (lines 60-196) where the
`outcome` discriminant is interleaved with seven multi-paragraph `@decision`
blocks that name multiple cross-references. That style is correct for human
readers and for the `@decision` index, but it inflates the descriptive
surface the LLM has to summarize, and it is the most plausible source of a
222-char `behavior` line for the file's primary IntentCard.

The issue body explicitly endorses the smallest fix:
> "if there's an upstream bug, fix it; otherwise just trim the JSDoc."

We have shown there is no upstream bug to fix in this case. So we trim
`telemetry.ts` so the LLM-visible summary fits comfortably under the 200-char
ceiling, while preserving every `@decision` annotation, public export
signature, and runtime behavior.

## Scope

- One source file: `packages/hooks-base/src/telemetry.ts`
- Plan file: `plans/wi-634-telemetry-behavior-trim.md` (this file)
- No other source files touched.
- No tests added or removed — existing telemetry tests must continue to pass
  unchanged.

### What may be edited in telemetry.ts

- The top-of-file JSDoc summary line (currently:
  `"telemetry.ts — Local-only telemetry capture for the yakcc hook layer
  (Phase 1 MVP)."`) may be left as-is; it is already short. It is named here
  only to clarify it is in scope to keep concise.
- The JSDoc descriptions on `TelemetryEvent`, `resolveSessionId`,
  `resolveTelemetryDir`, `hashIntent`, `outcomeFromResponse`,
  `appendTelemetryEvent`, and `captureTelemetry` may be tightened so each
  first sentence stays well below 200 chars and the overall description block
  for any single export is concise. Implementer must keep at least one
  human-readable sentence per export.

### What must NOT change

- Every `@decision` annotation (`DEC-HOOK-PHASE-1-001`,
  `DEC-TELEMETRY-EXPORT-SINK-001`, `DEC-WI508-S2-TELEMETRY-OUTCOME-ADDITIVE-001`,
  `DEC-HOOK-ENF-LAYER1-TELEMETRY-001`, `DEC-HOOK-ENF-LAYER2-TELEMETRY-001`,
  `DEC-HOOK-ENF-LAYER3-TELEMETRY-001`, `DEC-HOOK-ENF-LAYER4-TELEMETRY-001`,
  `DEC-HOOK-ENF-LAYER5-TELEMETRY-001`, `DEC-HOOK-ATOM-CAPTURE-001`,
  `DEC-TELEMETRY-EXPORT-FAIL-SILENT-005`) must remain present, with its
  `@title`/`@status`/`@rationale` body intact. These are load-bearing for
  the decision-id projection and Architecture Preservation invariants.
- Every public export and its signature: `TelemetryEvent` type,
  `resolveSessionId`, `resolveTelemetryDir`, `hashIntent`,
  `outcomeFromResponse`, `appendTelemetryEvent`, `captureTelemetry`,
  `FALLBACK_SESSION_ID` (module-private) — no behavioral changes.
- All control flow, imports, env-var handling, and side effects.
- The 200-char validator rule itself
  (`packages/shave/src/intent/validate-intent-card.ts`).
- `packages/contracts/src/source-extract.ts` — out of scope, see "Why Option
  B is the wrong shape" above.

## Diff sketch

The implementer should:

1. Read the current header JSDoc on `TelemetryEvent` (lines ~54-196) and
   verify that the first sentence of each export's JSDoc would land ≤200
   chars after `collapseWhitespace`.
2. Where a description's first sentence is long, split it into two sentences
   so the first one is short (and so any LLM summary derived from it stays
   short). Keep every `@decision` block separate from the summary sentence
   so the first-sentence extractor sees a clean, short lead.
3. Verify nothing changed below the JSDoc — every executable line must be
   byte-identical (mod whitespace).

## Test plan

1. **Pre-condition reproduction** (verifies the bug actually fires today):
   ```
   pnpm --filter @yakcc/cli build
   # Run bootstrap against telemetry.ts and confirm:
   # IntentCardSchemaError: field "behavior" must be ≤200 characters, got 222
   ```
2. **Post-fix bootstrap** (verifies the bug is gone):
   ```
   # Re-run bootstrap; telemetry.ts must shave without IntentCardSchemaError.
   # Capture the actual behavior length from the produced IntentCard JSON
   # (should be ≤200; ideally well below to leave headroom).
   ```
3. **Regression coverage** — existing unit/property tests must pass with no
   changes:
   ```
   pnpm --filter @yakcc/hooks-base test
   ```
4. **Public API parity** — `pnpm typecheck` (or package-local equivalent)
   passes; no consumer of `telemetry.ts` sees a type change.
5. **Pre-push hygiene** (non-negotiable per session policy):
   `git fetch && git diff --stat origin/main..HEAD`, lint, typecheck before
   pushing.

## Evaluation Contract (mirrored to runtime via cc-policy)

- `required_tests`:
  - `pnpm --filter @yakcc/hooks-base test` passes.
  - Bootstrap re-run on `packages/hooks-base/src/telemetry.ts` produces a
    valid IntentCard (no `IntentCardSchemaError`).
- `required_evidence`:
  - Captured IntentCard JSON for telemetry.ts showing `behavior.length ≤ 200`.
  - `git diff` scoped strictly to `packages/hooks-base/src/telemetry.ts` and
    `plans/wi-634-telemetry-behavior-trim.md`.
- `required_real_path_checks`:
  - `packages/hooks-base/src/telemetry.ts` present and edited.
  - `plans/wi-634-telemetry-behavior-trim.md` present and committed.
- `required_authority_invariants`:
  - `packages/shave/src/intent/validate-intent-card.ts` unchanged
    (200-char rule preserved).
  - `packages/contracts/src/source-extract.ts` unchanged.
  - Every `@decision` block in telemetry.ts preserved verbatim
    (id + title + status + rationale).
  - Public exports of telemetry.ts unchanged (type and runtime).
- `required_integration_points`:
  - Bootstrap report: telemetry.ts moves from 1 failure → 0 failures, no new
    failures introduced for other files.
- `forbidden_shortcuts`:
  - Loosening or removing the 200-char rule in
    `validate-intent-card.ts`.
  - Silently truncating LLM-output IntentCards anywhere.
  - Editing `packages/contracts/src/source-extract.ts` (Option B is out of
    scope per the investigation above).
  - Stripping or relocating any `@decision` annotation.
  - Skipping pre-push hygiene (rebase + lint + typecheck).
- `rollback_boundary`: a single `git revert` of the implementer's commit.
- `ready_for_guardian_definition`:
  - bootstrap re-run is clean for telemetry.ts on the implementer head SHA,
  - `pnpm --filter @yakcc/hooks-base test` passes locally,
  - reviewer issues `REVIEW_VERDICT=ready_for_guardian` on the same head SHA,
  - PR opened with `Closes #634`.

## Decision Log

- **DEC-634-OPTION-A-001** — *Choose Option A (trim JSDoc) over Option B
  (modify source-extract.ts)*. Status: decided. Rationale: the validator
  that fired is on the LLM-output IntentCard path
  (`packages/shave/src/intent/validate-intent-card.ts`), not the static
  QueryIntentCard path (`packages/contracts/src/source-extract.ts`).
  `extractFirstSentence` already truncates QueryIntentCard `behavior` to
  197+"...". Adding a second silent truncation on the LLM-output side would
  mask prompt-quality regressions and create a parallel authority for the
  200-char rule. The minimal, correct fix is to reduce the LLM-visible
  description surface in `telemetry.ts` so the derived `behavior` stays
  under 200 chars.
