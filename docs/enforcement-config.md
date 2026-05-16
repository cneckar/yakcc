# Enforcement Config

Central configuration module for the yakcc hook enforcement stack. All tunable
thresholds across all enforcement layers (L1–L6 and beyond) are owned exclusively
by `packages/hooks-base/src/enforcement-config.ts` (DEC-HOOK-ENF-CONFIG-001).

No layer module may hardcode a threshold. Layer modules call
`getEnforcementConfig().layerN` at runtime.

---

## Loading precedence

Highest wins:

1. `setConfigOverride()` — test hook (in-process only)
2. Env vars (see mapping below)
3. Config file (`.yakcc/enforcement.json` or `YAKCC_ENFORCEMENT_CONFIG_PATH`)
4. Compiled defaults (match prior hardcoded constants — no behavior change on fresh install)

---

## Env var mapping

| Env var                              | Config key                  | Type    | Default |
|--------------------------------------|-----------------------------|---------|---------|
| `YAKCC_HOOK_DISABLE_INTENT_GATE`     | `layer1.disableGate`        | `"1"`   | `false` |
| `YAKCC_L1_MIN_WORDS`                 | `layer1.minWords`           | integer | `4`     |
| `YAKCC_L1_MAX_WORDS`                 | `layer1.maxWords`           | integer | `20`    |
| `YAKCC_RESULT_SET_MAX`               | `layer2.maxConfident`       | integer | `3`     |
| `YAKCC_RESULT_SET_MAX_OVERALL`       | `layer2.maxOverall`         | integer | `10`    |
| `YAKCC_RESULT_CONFIDENT_THRESHOLD`   | `layer2.confidentThreshold` | float   | `0.70`  |
| `YAKCC_HOOK_DISABLE_RESULT_SET_GATE` | (escape hatch — checked at call site in index.ts) | `"1"` | unset |
| `YAKCC_ENFORCEMENT_CONFIG_PATH`      | (file path override)        | string  | unset   |

Env vars always override the config file. Invalid values (non-numeric, out-of-range)
are silently ignored and the file/default value is used.

---

## Config file format

Place at `.yakcc/enforcement.json` in the repo root, or point to it with
`YAKCC_ENFORCEMENT_CONFIG_PATH`.

All fields are optional. Unspecified fields fall back to defaults.

```json
{
  "layer1": {
    "minWords": 4,
    "maxWords": 20,
    "stopWords": ["things", "stuff", "utility", "helper", "manager",
                  "handler", "service", "system", "processor", "worker"],
    "metaWords": ["various", "general", "common", "some", "any",
                  "several", "misc", "generic"],
    "actionVerbs": ["parse", "validate", "encode", "decode", "hash",
                    "compare", "split", "join", "filter", "map"],
    "disableGate": false
  },
  "layer2": {
    "maxConfident": 3,
    "maxOverall": 10,
    "confidentThreshold": 0.70
  }
}
```

Validation: non-object values, wrong types, or `confidentThreshold` outside `[0, 1]`
throw with a descriptive message at load time (not silently ignored).

---

## Layer 1 thresholds (intent-specificity gate)

| Field         | Default   | Meaning                                             |
|---------------|-----------|-----------------------------------------------------|
| `minWords`    | `4`       | Minimum whitespace-tokenized word count             |
| `maxWords`    | `20`      | Maximum whitespace-tokenized word count             |
| `stopWords`   | 10 words  | Tokens that signal a generic noun (reject)          |
| `metaWords`   | 8 words   | Tokens that signal vague framing (reject)           |
| `actionVerbs` | ~90 verbs | Allowlist — intent must contain at least one        |
| `disableGate` | `false`   | `true` bypasses Layer 1 entirely (breakglass only)  |

Layer 1 rejects if: `wordCount < minWords`, `wordCount > maxWords`, any token is in
`stopWords`, any token is in `metaWords`, or no token is in `actionVerbs` (and no
`is`/`has`/`can` predicate prefix is present).

---

## Layer 2 thresholds (result-set size gate)

| Field                | Default | Meaning                                                           |
|----------------------|---------|-------------------------------------------------------------------|
| `maxConfident`       | `3`     | Max candidates with `combinedScore >= confidentThreshold` allowed |
| `maxOverall`         | `10`    | Max total candidates allowed (backstop for dense embedding spaces)|
| `confidentThreshold` | `0.70`  | Score cutoff: matches `CONFIDENT_THRESHOLD` in `yakcc-resolve.ts`|

Layer 2 rejects when `confidentCount > maxConfident` OR `totalCount > maxOverall`.

Score formula: `combinedScore = 1 - cosineDistance² / 4` (identical to `yakcc-resolve.ts`).

---

## Tuning guide

**Too many false rejections (Layer 2 fires on legitimate queries):**
- Raise `maxConfident` (e.g. to `5`) and observe bench/B5-coherence impact.
- Raise `maxOverall` if the registry embedding space is legitimately dense for a domain.

**Too many ambiguous results slipping through:**
- Lower `maxConfident` (e.g. to `2`).
- Lower `confidentThreshold` to 0.65 to expand the "confident" band.

**Layer 1 blocking valid intents:**
- Extend `actionVerbs` in the config file — no code change needed.
- Use `YAKCC_L1_MIN_WORDS=3` if your registry has 3-word precision intents.

**Emergency bypass:**
- `YAKCC_HOOK_DISABLE_INTENT_GATE=1` disables Layer 1.
- `YAKCC_HOOK_DISABLE_RESULT_SET_GATE=1` disables Layer 2.
- These are breakglass only. Do not leave set in production.

---

## S3-S6 extension protocol

When implementing Layer 3 (atom-size enforcement) and beyond:

1. Add `layer3: Layer3Config` to `EnforcementConfig` in `enforcement-config.ts`.
2. Add defaults to `getDefaults()` (must preserve prior defaults exactly).
3. Add env-var mapping to `applyEnvOverrides()`.
4. Add schema validation to `validateConfigFile()`.
5. Layer module imports `getEnforcementConfig().layer3` — no local constants.
6. Update this doc with the new layer's env vars and config fields.

Cross-reference: `packages/hooks-base/src/enforcement-config.ts` (DEC-HOOK-ENF-CONFIG-001),
`plans/wi-579-s2-layer2-result-set-size.md`.
