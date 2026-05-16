# WI-579-S4: Layer 4 — Descent-Depth Tracker (Advisory Warning)

**Issue:** #592 | **Slice:** S4 of 6 | **Status:** complete (wi-592-s4-layer4)

## Problem

An LLM agent may call `substitute` (or `yakcc_compose`) after zero or very few
prior registry misses for a binding. This "shallow substitution" pattern bypasses
the descent-and-compose discipline (docs/system-prompts/yakcc-discovery.md): the
agent should miss enough times to accumulate evidence that the binding truly exists
in the registry before committing to an atom-based substitution.

There was no signal in the hook path to detect or measure this pattern.

## Decision

Layer 4 is an **advisory, non-blocking** layer. It attaches a `DescentBypassWarning`
to `SubstitutionResult` when a substitution is attempted with fewer prior miss events
than `minDepth` for the same `(packageName, binding)` pair, and the binding name
does not match any `shallowAllowPattern`.

The substitution **proceeds regardless** of the warning. Layer 4 is observability
infrastructure, not an enforcement gate.

## §5.5 Spec Compliance

| Parameter | Default | Config key | Env var |
|-----------|---------|-----------|---------|
| `minDepth` | 2 | `layer4.minDepth` | `YAKCC_DESCENT_MIN_DEPTH` |
| `shallowAllowPatterns` | `["^add$","^sub$","^mul$","^div$","^mod$","^abs$","^min$","^max$","^clamp$","^lerp$"]` | `layer4.shallowAllowPatterns` | (file config only) |
| `disableTracking` | false | `layer4.disableTracking` | `YAKCC_HOOK_DISABLE_DESCENT_TRACKING=1` |

All thresholds are read from `getEnforcementConfig().layer4` at call time per
DEC-HOOK-ENF-CONFIG-001. Nothing is hardcoded in `descent-tracker.ts` or `substitute.ts`.

## Architecture

**Session Map:** An in-memory `Map<string, DescentRecord>` scoped to the process
lifetime (= one session). Never persisted to disk. Cleared via `resetSession()` in tests.

**Binding key:** Reuses `makeBindingKey(packageName, binding)` = `"packageName::binding"`
from `shave-on-miss-state.ts` (DEC-WI508-S3-KEY-FORMAT-001).

**Two pipeline integration points:**

1. `import-intercept.ts::runImportIntercept` — records `recordMiss` / `recordHit`
   per binding at query time (before substitution is attempted).

2. `substitute.ts::executeSubstitution` — calls `getAdvisoryWarning` at Layer 4
   position (after Layer 3, before rendering). Attaches `descentBypassWarning` to
   `SubstitutionResult` when the advisory fires.

**Shallow-allow bypass:** Primitives (`add`, `sub`, etc.) are inherently unambiguous;
no descent exploration is needed. `isShallowAllowed(binding, patterns)` short-circuits
the warning for these bindings.

**Telemetry:** `descent-bypass-warning` added to the `TelemetryEvent.outcome` union
(additive, DEC-HOOK-ENF-LAYER4-TELEMETRY-001).

## Key Decisions

| ID | Title |
|----|-------|
| DEC-HOOK-ENF-LAYER4-DESCENT-TRACKING-001 | Per-session in-memory session Map; advisory only; binding key reuse |
| DEC-HOOK-ENF-LAYER4-MIN-DEPTH-001 | minDepth default 2 — calibration-pending on B4/B9 sweep data |
| DEC-HOOK-ENF-LAYER4-SHALLOW-ALLOW-001 | shallowAllowPatterns bootstrap with 10 arithmetic primitives |

## Files Changed

| File | Role |
|------|------|
| `src/descent-tracker.ts` | Layer 4 module — `recordMiss`, `recordHit`, `getDescentDepth`, `getDescentRecord`, `isShallowAllowed`, `shouldWarn`, `getAdvisoryWarning`, `resetSession` |
| `src/enforcement-config.ts` | `Layer4Config` interface + `layer4` defaults + env var overrides |
| `src/enforcement-types.ts` | `DescentBypassWarning` (additive) |
| `src/substitute.ts` | Layer 4 plug point — after Layer 3, before rendering; `descentBypassWarning` on `SubstitutionResult` |
| `src/import-intercept.ts` | `recordMiss` / `recordHit` wired in `runImportIntercept` miss/hit branches |
| `src/telemetry.ts` | `descent-bypass-warning` outcome (additive) |
| `src/descent-tracker.test.ts` | Unit tests — 35+ cases across recordMiss/recordHit, isShallowAllowed, shouldWarn, getAdvisoryWarning, resetSession |
| `test/descent-tracker-integration.test.ts` | Integration tests — 3 flows (zero-miss, sufficient-miss, shallow-allow) + compound interaction tests |
| `test/enforcement-eval-corpus.json` | +3 L4-* rows (17 → 20 total) |
| `test/enforcement-eval-corpus.test.ts` | Layer 4 assertion helper + eval gate + structural invariants |

## Rollback

`git revert` the S4 commit. Layer 4 is independent of S1/S2/S3: the only integrations
are additive fields (`descentBypassWarning` on `SubstitutionResult`, `descent-bypass-warning`
in `TelemetryEvent.outcome`). Callers that do not read `descentBypassWarning` are unaffected.
