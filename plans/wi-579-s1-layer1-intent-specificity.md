# WI-579-S1 — Layer 1: Intent Specificity Gate (Implementation Spec)

**Parent plan:** `plans/wi-579-hook-enforcement-architecture.md` §7
**Workflow:** wi-579-hook-enforcement
**Slice:** S1 (Layer 1 + Layer 6 skeleton)
**Status:** implementation complete; pending guardian:land

---

## 1. What S1 delivers

This slice implements the first layer of the 6-layer hook enforcement
architecture described in the parent plan. It does exactly two things:

1. **Layer 1 — intent specificity gate**: `scoreIntentSpecificity(intent)` is
   called pre-query at two call sites. On reject, the registry is never queried
   and a forcing-function envelope is returned to the LLM.

2. **Layer 6 skeleton**: `enforcement-eval-corpus.test.ts` + corpus JSON seeded
   with 7 Layer 1 rows. This is the hard CI gate that every future slice must
   expand.

Nothing else. S2–S6 are follow-up issues documented in §8 of the parent plan.

---

## 2. Files created

| File | Purpose |
|---|---|
| `packages/hooks-base/src/enforcement-types.ts` | Shared discriminated-union envelope types (Layers 1–5) |
| `packages/hooks-base/src/intent-specificity.ts` | Layer 1 heuristic scorer + enforcer |
| `packages/hooks-base/src/intent-specificity.test.ts` | 13 unit cases per plan §5.2 |
| `packages/hooks-base/test/enforcement-eval-corpus.json` | 7 labeled corpus rows |
| `packages/hooks-base/test/enforcement-eval-corpus.test.ts` | Layer 6 eval harness |
| `packages/hooks-base/test/intent-specificity-integration.test.ts` | Compound-interaction tests |
| `packages/hooks-base/test/layer1-vague-intent-gate.test.ts` | Focused regression gate |
| `plans/wi-579-s1-layer1-intent-specificity.md` | This doc |

---

## 3. Files modified

| File | Change |
|---|---|
| `packages/hooks-base/src/telemetry.ts` | Additive: `"intent-too-broad"` added to `outcome` union; `outcomeFromResponse` + `captureTelemetry.outcomeOverride` expanded accordingly |
| `packages/hooks-base/src/index.ts` | Layer 1 gate wired at top of `executeRegistryQueryWithSubstitution`; `HookResponseWithSubstitution.substituted:false` branch gains optional `intentRejectEnvelope` field |
| `packages/hooks-base/src/import-intercept.ts` | Layer 1 gate wired inside `runImportIntercept` per-binding loop before `yakccResolve`; `ImportInterceptResult` gains optional `intentSpecificity` field |
| `plans/wi-579-hook-enforcement-architecture.md` | Copied from main repo's `plans/` into worktree (content unchanged) |

---

## 4. Deviations from plan

None. All function signatures, thresholds, escape-hatch env var name
(`YAKCC_HOOK_DISABLE_INTENT_GATE`), and corpus rows match the parent plan §7
exactly. The `outcomeFromResponse` return type was expanded additively to
include `"intent-too-broad"` (plan only mentioned expanding `captureTelemetry`;
the function-signature expansion is consistent and non-breaking).

---

## 5. Pre-push hygiene checklist

- [x] ff-merge / rebase to origin/main complete (HEAD = `27eede0`)
- [x] No `console.log` or debug output in shipped code
- [x] No TODOs left in shipped code (S2..S5 stubs use DEC-ID-referenced comment blocks)
- [x] `packages/hooks-base/src/enforcement-types.ts` is the sole declarant of shared envelope types
- [x] `packages/hooks-base/src/intent-specificity.ts` is the sole declarant of MIN_WORDS, MAX_WORDS, STOP_WORDS, META_WORDS, ACTION_VERBS
- [x] No per-IDE-package edits (forbidden by scope manifest)
- [x] `docs/system-prompts/yakcc-discovery.md` untouched (Layer 0, owned by #578)
- [x] `telemetry.ts` outcome enum expanded additively only (no removed/renamed variants)
- [x] Layer 6 corpus has ≥5 rows (7 seeded)
- [x] `pnpm -F @yakcc/hooks-base test` all pass

---

## 6. Rollback boundary

The entire S1 slice is reversible by reverting the implementer's commit.
Layer 1 is leaf-imported only by `index.ts` and `import-intercept.ts`.
The corpus rows are additive. The telemetry enum variant is additive and safe
for old consumers (unknown string passthrough in JSONL).
