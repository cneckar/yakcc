# WI-579-S2: Layer 2 Result-Set Size Enforcement

**Parent plan:** `plans/wi-579-hook-enforcement-architecture.md` §5.3
**GitHub issue:** #590 (WI-579-S2)
**Branch:** `feature/590-s2-layer2`
**Status:** implementation complete — awaiting reviewer

---

## What this slice delivers

1. **Central enforcement config** (`enforcement-config.ts`) — sole source of truth for
   all layer thresholds (DEC-HOOK-ENF-CONFIG-001). Implements loading precedence:
   env var → config file → defaults. Memoized after first call; test override via
   `setConfigOverride()` / `resetConfigOverride()`.

2. **S1 Layer 1 retrofit** (`intent-specificity.ts`) — prior hardcoded constants
   (MIN_WORDS=4, MAX_WORDS=20, STOP_WORDS, META_WORDS, ACTION_VERBS) moved to
   `getEnforcementConfig().layer1` at call time. Exported constants retained as
   snapshot aliases for backward API compatibility. Zero semantic change when no
   config file or env vars are present.

3. **Layer 2 result-set size gate** (`result-set-size.ts`) — runs after
   `findCandidatesByQuery` resolves, before candidates reach the consumer.
   Rejects when `confidentCount > maxConfident` OR `totalCount > maxOverall`.
   `confidentCount` uses the same `combinedScore = 1 - d²/4` formula as
   `yakcc-resolve.ts` (DEC-HOOK-ENF-LAYER2-SCORE-FORMULA-001).

4. **Wiring in `index.ts`** — Layer 2 runs between the registry query and the
   substitution/atomize/intercept branches. Returns
   `{ kind: "passthrough", substituted: false, resultSetRejectEnvelope }` on reject.
   Escape hatch: `YAKCC_HOOK_DISABLE_RESULT_SET_GATE=1`.

5. **Telemetry** (`telemetry.ts`) — additive `"result-set-too-large"` outcome value
   (DEC-HOOK-ENF-LAYER2-TELEMETRY-001). Emitted via `outcomeOverride` at the Layer 2
   gate; `outcomeFromResponse()` unchanged.

6. **Layer 6 corpus extended** — 5 L2-* rows appended to
   `test/enforcement-eval-corpus.json`. Corpus test (`enforcement-eval-corpus.test.ts`)
   extended with `assertLayer2Row()` helper and named test cases for each row.

7. **Reference docs** — `docs/enforcement-config.md` and this plan file.

---

## Architecture decisions

| ID | Title | Scope |
|----|-------|-------|
| DEC-HOOK-ENF-CONFIG-001 | Central enforcement config — sole threshold authority | enforcement-config.ts |
| DEC-HOOK-ENF-LAYER2-RESULT-SET-SIZE-001 | Layer 2 result-set size gate | result-set-size.ts + index.ts |
| DEC-HOOK-ENF-LAYER2-SCORE-FORMULA-001 | combinedScore = 1 - d²/4 matches yakcc-resolve.ts | result-set-size.ts |
| DEC-HOOK-ENF-LAYER2-TELEMETRY-001 | "result-set-too-large" additive telemetry outcome | telemetry.ts |
| DEC-HOOK-ENF-LAYER1-CONSTANTS-RETROFIT-001 | L1 exported constants are default snapshots (S2 retrofit) | intent-specificity.ts |

---

## Config foundation (bonus scope)

The enforcement-config.ts module was added as a config foundation for S3–S6.
All future layers append their `layerN: LayerNConfig` key to `EnforcementConfig`
following the same pattern. S3–S6 must NOT add local constants — they call
`getEnforcementConfig().layerN` at runtime.

See `docs/enforcement-config.md` for the env var mapping, file format, and
tuning guide. See `packages/hooks-base/src/__fixtures__/enforcement-config-sample.json`
for a complete sample config.

---

## Defaults (backward compat guarantee)

Layer 2 defaults:
- `maxConfident`: 3
- `maxOverall`: 10
- `confidentThreshold`: 0.70

These match `CONFIDENT_THRESHOLD` from `yakcc-resolve.ts`. No behavior change
occurs when no config file or env vars are present.

Layer 1 defaults in enforcement-config.ts reproduce the prior hardcoded constants
from intent-specificity.ts exactly (verified by the S1 test suite).

---

## Pre-push hygiene checklist

- [ ] `pnpm -w lint` — expected clean
- [ ] `pnpm -w typecheck` — expected clean
- [ ] `pnpm --filter @yakcc/hooks-base test` — all pass (S1 baseline + new Layer 2 tests)
- [ ] `pnpm --filter @yakcc/hooks-cursor test` — no regression
- [ ] `pnpm --filter @yakcc/hooks-claude-code test` — no regression

---

## Rollback boundary

`git revert` the commits on this branch. The config module can be removed and
layer modules revert to prior constant values. Layer 1 retrofit is fully reversible
(the exported constants still compile without enforcement-config.ts if the hardcoded
values are restored).
