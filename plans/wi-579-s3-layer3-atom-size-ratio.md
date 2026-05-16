# WI-579-S3: Layer 3 — Atom-Size Ratio Enforcement

**Issue:** #591 | **Slice:** S3 of 6 | **Status:** complete (wi-591-s3-layer3)

## Problem

An LLM-invoked substitution can replace a call site with a lodash-shaped atom —
one that exports dozens of functions and carries hundreds of transitive dependencies —
when the immediate need is a single, narrow operation. The caller pays the full
complexity cost of the atom even though it uses ~1% of its surface.

## Decision

**Single plug point:** `substitute.ts::executeSubstitution`, between the D2 auto-accept
gate and `renderSubstitution`. This is the ONLY place Layer 3 runs.

**Complexity proxy (v1):**

```
atomComplexity = transitiveNodes + 5 * exportedSurface + 2 * transitiveDeps
  where transitiveNodes = spec.inputs.length + spec.outputs.length + spec.guarantees.length
        exportedSurface = spec.outputs.length (v1 proxy; v2 uses real export count)
        transitiveDeps  = 0 (v1; not yet exposed by @yakcc/registry)

needComplexity = max(1, bindingsUsed * statementCount)
  where bindingsUsed  = 1 (v1: caller uses the atom)
        statementCount = semicolon count in originalCode (rough proxy; v2 uses ts-morph AST)

ratio = atomComplexity / needComplexity
```

**Gate logic:**

- If `atomComplexity < minFloor` → bypass (micro-atom, no false positives).
- If `ratio > ratioThreshold` → reject with status `atom-size-too-large`.
- Otherwise → accept.

## §5.4 Spec Compliance

| Parameter | Default | Config key | Env var |
|-----------|---------|-----------|---------|
| `ratioThreshold` | 10 | `layer3.ratioThreshold` | `YAKCC_ATOM_OVERSIZED_RATIO` |
| `minFloor` | 20 | `layer3.minFloor` | (none; file config only) |
| `disableGate` | false | `layer3.disableGate` | `YAKCC_HOOK_DISABLE_ATOM_SIZE_GATE=1` |

All thresholds are read from `getEnforcementConfig().layer3` at call time per
DEC-HOOK-ENF-CONFIG-001. Nothing is hardcoded in `substitute.ts` or `atom-size-ratio.ts`.

## Files Changed

| File | Role |
|------|------|
| `src/atom-size-ratio.ts` | Layer 3 module — `AtomLike`, `CallSiteAnalysis`, `computeAtomComplexity`, `computeNeedComplexity`, `enforceAtomSizeRatio`, `isAtomSizeOk` |
| `src/substitute.ts` | Single plug point — Layer 3 gate wired between D2 accept and `renderSubstitution` |
| `src/enforcement-config.ts` | `Layer3Config` interface + `layer3` defaults (ratioThreshold=10, minFloor=20) + env var overrides |
| `src/enforcement-types.ts` | `AtomSizeAcceptEnvelope`, `AtomSizeRejectEnvelope`, `AtomSizeRatioResult` (additive) |
| `src/telemetry.ts` | `atom-size-too-large` outcome (additive) |
| `src/atom-size-ratio.test.ts` | Unit tests — 30 cases across computeAtomComplexity, computeNeedComplexity, enforceAtomSizeRatio, isAtomSizeOk, edge cases |
| `test/atom-size-ratio-integration.test.ts` | Integration tests — Layer 3 through executeSubstitution pipeline |
| `test/enforcement-eval-corpus.json` | +5 L3-* rows (12 → 17 total) |
| `test/enforcement-eval-corpus.test.ts` | Layer 3 named cases + structural invariants |

## Authority Invariants

- `enforcement-config.ts` is the SOLE source of truth for Layer 3 thresholds.
- `substitute.ts` contains the ONLY plug point for Layer 3.
- S1 (`intent-specificity.ts`) and S2 (`result-set-size.ts`) are untouched.
- Telemetry is additive only (`atom-size-too-large` joins the outcome union).

## Rollback

`git revert` of this slice is independent of S1/S2. Layer 3 adds a new module
(`atom-size-ratio.ts`) and a new gate call in `substitute.ts`. Reverting removes
both without affecting existing enforcement layers.

## Next Slice

S4: Descent tracking (Layer 4) — detects when the LLM skips the descent-and-compose
discipline by substituting at the wrong level. Implements `DescentTrackingEnvelope`
(ok | descent_bypass_warning) defined in `enforcement-types.ts` §Layers 4–5 placeholder.
