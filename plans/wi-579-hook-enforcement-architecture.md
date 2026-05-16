# WI-579 — Hook Enforcement Architecture (6 Layers)

**Workflow:** wi-579-hook-enforcement
**Goal:** g-579-hook-enforcement
**Closes:** GH #579 (only when all 6 layers ship + Layer 6 eval gate green)
**Sibling:** #578 (prompt-level imperative — landed PR #580)
**Status:** Planner pass — first-slice spec (Layer 1 + Layer 6 skeleton) ready for guardian:provision
**Authority domain:** hook-enforcement-layers (this WI is the first writer)

---

## 1. Problem statement

The yakcc value proposition rests on a single behavioral primitive: when an LLM
needs a generic operation, it must descend to the most specific intent,
discover (or compose) the corresponding atom, and substitute. Loose intents
collapse this primitive — they return oversized atoms, pollute the registry,
short-circuit the descent loop, and invalidate every downstream benchmark
(B1/B4/B5/B9/B10).

PR #580 (#578) shipped the prompt-level defense: an imperative
descent-and-compose discipline at `docs/system-prompts/yakcc-discovery.md`.
Prompts alone are insufficient. LLMs ignore prompts when convenient; without
mechanical enforcement, the next regression silently degrades the system back
to lazy lookups and the bench numbers measure noise.

#579 spells out a six-layer mechanical defense. Each layer is independently
testable and independently failable; together they form a defense-in-depth net
that no single failure mode can fully bypass. Layer 6 is the regression gate
that proves Layers 1–5 still enforce.

**Why six and not one big check:** a single monolithic enforcement is a
single point of failure. Six independent gates with overlapping coverage means
a regression in one (heuristic drift, threshold miscalibration, telemetry
silence) is caught by at least one of the others before it ships.

---

## 2. Non-goals for this WI

- **No per-IDE policy.** All enforcement lives in `@yakcc/hooks-base`. IDE
  adapters (`hooks-claude-code`, `hooks-cursor`, `hooks-codex`) remain pure
  consumers. (Sacred Practice 12.)
- **No prompt rewrites.** Layer 0 is #578's prompt; this WI references it but
  does not duplicate or modify it. Changes to the discovery prompt require a
  separate D4 ADR revision (`DEC-V3-DISCOVERY-D4-001`).
- **No new dispatch wiring.** The hook still runs from
  `executeRegistryQueryWithSubstitution` in `index.ts`; we add policy modules
  it calls into.
- **No federation / remote registry behavior.** All enforcement runs locally,
  same as today's hooks-base modules.
- **No retroactive correction of past atoms.** Drift detection (Layer 5)
  reports; it does not rewrite the registry.
- **First slice does not implement all 6 layers.** Slice discipline: S1 = Layer
  1 + Layer 6 skeleton. The remaining 5 layers ship as follow-on WIs filed at
  S1 land time.

---

## 3. State-authority map

Mapping where each piece of state lives so implementers do not build parallel
systems.

| Domain | Authority | Files |
|---|---|---|
| Intent specificity scoring | NEW: `packages/hooks-base/src/intent-specificity.ts` | (new for S1) |
| Result-set size threshold | NEW: `packages/hooks-base/src/result-set-size.ts` (S2) | (new for S2) |
| Atom-size ratio policy | NEW: `packages/hooks-base/src/atom-size-ratio.ts` (S3) | (new for S3) |
| Descent depth tracker | NEW: `packages/hooks-base/src/descent-tracker.ts` (S4) | (new for S4) |
| Telemetry event schema | `packages/hooks-base/src/telemetry.ts` (existing, extend additively per #569/#574) | extend `outcome` enum + add fields |
| Discovery prompt text | `docs/system-prompts/yakcc-discovery.md` (Layer 0, owned by #578) | read-only here |
| Hook integration point | `packages/hooks-base/src/index.ts::executeRegistryQueryWithSubstitution` + `import-intercept.ts::applyImportIntercept` | extended at call sites |
| Registry query surface | `packages/hooks-base/src/yakcc-resolve.ts::yakccResolve` (D4 envelope) | wrapped, not modified |
| Per-binding hit recording | `packages/hooks-base/src/shave-on-miss-state.ts::recordImportHit` (existing) | reused by Layer 4 |
| Eval corpus rows | NEW: `packages/hooks-base/test/enforcement-eval-corpus.test.ts` | (new for S1) |
| Shared enforcement types | NEW: `packages/hooks-base/src/enforcement-types.ts` | (new for S1; envelope shapes shared across layers) |

**Single authority per fact:** every layer's thresholds/heuristics live in
exactly one file under `packages/hooks-base/src/`. Layers consume each other
via typed envelopes (`enforcement-types.ts`) — never via duplicated constants.

---

## 4. Inventory pass — current hook architecture

Read findings (read-only of `packages/hooks-base/src/`):

### 4.1 Hook entry path

`index.ts::executeRegistryQueryWithSubstitution(registry, ctx, originalCode, toolName, options)`
runs the full pipeline:

1. `_executeRegistryQueryInternalWithCandidates` — calls
   `registry.findCandidatesByQuery(queryCard)` and produces
   `{response, candidateCount, topScore, candidates}`.
2. `executeSubstitution(candidates, originalCode)` — Phase 2 substitution
   (D2 auto-accept gate).
3. `atomizeEmission({emittedCode, toolName, registry})` — Phase 3 atom capture
   when no substitution fired.
4. `applyImportIntercept(base, emittedCode, ctx, registry)` — WI-508
   import-intercept path; scans foreign imports, calls `yakccResolve` per
   binding, fires `applyShaveOnMiss` on miss.
5. `captureTelemetry(...)` — single TelemetryEvent appended to
   `~/.yakcc/telemetry/<session-id>.jsonl`.

### 4.2 yakccResolve envelope

`yakcc-resolve.ts::yakccResolve(registry, query, options?)` returns a
`ResolveResult { status, candidates, disambiguation_hint?, tiebreaker_reason? }`
with `status ∈ {"matched", "weak_only", "no_match"}` per D3 4-band thresholds
(STRONG 0.85 / CONFIDENT 0.70 / WEAK 0.50).

Already surfaces a `disambiguation_hint` (kind: `"vague_intent"`) when ≥5
candidates are within ε=0.02 of top score — this is a *partial* Layer 2 signal
already present. Layer 2 (S2) will generalize it into a hard reject envelope.

### 4.3 Telemetry surface

`telemetry.ts::TelemetryEvent.outcome` is the additive enum that #569/#574 use
for shave-on-miss states. Sacred Practice 12 / additive expansion is the
pattern Layers 1, 2, 3, 4, 5 must follow:

```ts
outcome:
  | "registry-hit" | "synthesis-required" | "passthrough" | "atomized"
  | "shave-on-miss-enqueued" | "shave-on-miss-completed" | "shave-on-miss-error"
  // S1 adds:
  | "intent-too-broad"             // Layer 1 reject
  // S2 adds:
  | "result-set-too-large"         // Layer 2 reject
  // S3 adds:
  | "atom-oversized"               // Layer 3 reject
  // S4 adds:
  | "descent-bypass-warning"       // Layer 4 advisory
  // S5 adds:
  | "drift-alert"                  // Layer 5 advisory (per-session aggregate)
```

### 4.4 Plug-in points per layer

| Layer | Plug-in site | Sequence relative to query |
|---|---|---|
| 1 — intent specificity gate | `index.ts::executeRegistryQueryWithSubstitution` + `import-intercept.ts::runImportIntercept` per-candidate **before** `findCandidatesByQuery` / `yakccResolve` | pre-query |
| 2 — result-set size | wraps the `yakccResolve` return inside `import-intercept.ts::runImportIntercept` and `index.ts::_executeRegistryQueryInternalWithCandidates` | post-query, pre-surfacing |
| 3 — atom-size ratio | `substitute.ts::executeSubstitution` — between candidate selection and `renderSubstitution` | substitution-time |
| 4 — compose-vs-substitute | `substitute.ts::executeSubstitution` consumes a descent-depth lookup; `import-intercept.ts::applyImportIntercept` records depth at descent boundaries (reuses `shave-on-miss-state.ts::recordImportHit` infra) | substitution-time |
| 5 — drift detection | runs over `telemetry.ts` aggregate; surfaces synchronously when threshold crossed inside `captureTelemetry` | post-emission |
| 6 — eval gate | `packages/hooks-base/test/enforcement-eval-corpus.test.ts` exercising Layers 1–5 against a labeled corpus | CI |

---

## 5. Per-layer design

Each layer has a single owning module under `packages/hooks-base/src/`. The
shared envelope types live in `enforcement-types.ts` so layers can compose
without circular imports.

### 5.1 Shared enforcement envelopes (`enforcement-types.ts`)

```ts
// packages/hooks-base/src/enforcement-types.ts
//
// @decision DEC-HOOK-ENF-ENVELOPES-001
// Single-source-of-truth envelope shapes for Layers 1–5.
// Layers consume each other via these types — never via duplicated string
// constants or sibling-module reaches.
//
// All envelopes carry a discriminant `layer` so multiplexed telemetry can
// route them in one place.

export type IntentRejectReason =
  | "too_short"
  | "too_long"
  | "stop_word_present"
  | "no_action_verb"
  | "no_io_specifics"
  | "meta_word_present"
  | "single_word";

export interface IntentRejectEnvelope {
  readonly layer: 1;
  readonly status: "intent_too_broad";
  readonly reasons: readonly IntentRejectReason[];
  readonly suggestion: string;  // forcing-function text for the LLM
}

export interface IntentAcceptEnvelope {
  readonly layer: 1;
  readonly status: "ok";
  readonly score: number;       // 0..1 specificity score (telemetry only)
}

export type IntentSpecificityResult = IntentAcceptEnvelope | IntentRejectEnvelope;

// (S2/S3/S4/S5 envelopes added at their respective slices; this S1 file
// stubs the layer-2..layer-5 union members as `never` so adding them is an
// additive edit per Sacred Practice 12 — no breaking shape change.)
```

### 5.2 Layer 1 — intent specificity gate (S1 — this slice)

**Owner:** `packages/hooks-base/src/intent-specificity.ts` (new)
**DEC:** `DEC-HOOK-ENF-LAYER1-INTENT-SPECIFICITY-001`

**Plug-in points (2):**
- `index.ts::executeRegistryQueryWithSubstitution` — gate
  `_executeRegistryQueryInternalWithCandidates` on `ctx.intent` before the
  internal registry query. If reject, short-circuit with a passthrough +
  intent-too-broad telemetry event.
- `import-intercept.ts::runImportIntercept` — gate each candidate's
  `enrichedCard.behavior` before calling `yakccResolve`. On reject, skip the
  registry query for that binding and surface the envelope on
  `ImportInterceptResult` (additive optional field
  `intentSpecificity?: IntentRejectEnvelope`).

**Inputs:** `string` intent text (from `EmissionContext.intent`,
`QueryIntentCard.behavior`, or `import-intercept.ts::buildImportIntentCard`
output).

**Outputs:** `IntentSpecificityResult` (accept or reject envelope).

**Heuristics — exact thresholds locked here (DEC-IDs each):**

| Heuristic | Value | DEC-ID |
|---|---|---|
| Min word count (whitespace-tokenized) | 4 | `DEC-HOOK-ENF-LAYER1-MIN-WORDS-001` |
| Max word count | 20 | `DEC-HOOK-ENF-LAYER1-MAX-WORDS-001` |
| Stop-word list (lowercased substring match on token boundaries) | `things`, `stuff`, `utility`, `helper`, `manager`, `handler`, `service`, `system`, `processor`, `worker` | `DEC-HOOK-ENF-LAYER1-STOP-WORDS-001` |
| Meta-word list (same matcher) | `various`, `general`, `common`, `some`, `any`, `several`, `misc`, `generic` | `DEC-HOOK-ENF-LAYER1-META-WORDS-001` |
| Action-verb requirement | at least one token matches `/^(parse|validate|encode|decode|hash|compare|split|join|filter|map|reduce|sort|find|match|extract|convert|serialize|deserialize|normalize|sanitize|format|render|build|emit|read|write|append|prepend|...)$/` (curated list, ~80 verbs, all lowercase) | `DEC-HOOK-ENF-LAYER1-ACTION-VERBS-001` |
| Single-word reject | always reject if `wordCount === 1` regardless of word | `DEC-HOOK-ENF-LAYER1-SINGLE-WORD-001` |
| I/O specifics signal | at least one of: a `:` followed by a known type token (`string`, `number`, `Uint8Array`, etc.); the substring `from `; the substring `to `; or a parenthesized signature `(…)` | `DEC-HOOK-ENF-LAYER1-IO-HINT-001` (advisory only — does NOT reject on its own; raises the specificity score) |

**Decision algorithm (deterministic, no I/O):**

```text
if wordCount < MIN_WORDS or wordCount > MAX_WORDS    → REJECT (length)
if wordCount == 1                                     → REJECT (single_word)
if any token ∈ STOP_WORDS                             → REJECT (stop_word_present)
if any token ∈ META_WORDS                             → REJECT (meta_word_present)
if no token ∈ ACTION_VERBS                            → REJECT (no_action_verb)
else                                                  → ACCEPT, score = clamp01(
  0.5
  + (0.1 if has_io_hint else 0)
  + (0.1 if wordCount ∈ [6,14] else 0)
  + min(0.3, 0.05 * count_of_specific_tokens)
)
```

The score is **telemetry only** (Layer 5 consumes it). The accept/reject
decision is binary.

**Reject envelope text (forcing function):**

```text
INTENT_TOO_BROAD: <reasons>.
Refusing to query the registry. Per docs/system-prompts/yakcc-discovery.md,
decompose this into specific sub-intents and resubmit each.
Example: "validation" → "isEmail (RFC 5321 subset)", "isUUID v4",
"validateCreditCard (Luhn)".
```

Reject is returned to the caller; for `executeRegistryQueryWithSubstitution`
it surfaces as a passthrough response with `intentRejectEnvelope` attached on
the extended `HookResponseWithSubstitution` union (additive optional field).

**Tests (unit — `intent-specificity.test.ts`):**

| Input | Expected | Reason |
|---|---|---|
| `""` | reject | too_short |
| `"x"` | reject | single_word |
| `"validate"` | reject | single_word |
| `"validation"` | reject | single_word |
| `"utility for stuff"` | reject | stop_word_present + meta_word_present |
| `"helper to process things efficiently"` | reject | stop_word_present |
| `"split string on first ://"` | accept | – |
| `"isEmail RFC 5321 subset"` | accept | – |
| `"validate credit card number using Luhn checksum"` | accept | – |
| 21-word lorem-ipsum | reject | too_long |
| `"do stuff"` | reject | stop_word_present |
| `"common parser"` | reject | meta_word_present |
| `"convert hex pair %XX to single byte"` | accept | (has_io_hint, action verb) |

**Integration tests (`test/intent-specificity-integration.test.ts`):**

- `executeRegistryQueryWithSubstitution` with `ctx.intent = "utility for
  handling things"` returns passthrough; no `registry.findCandidatesByQuery`
  call observed (registry stub assertion); telemetry event has
  `outcome === "intent-too-broad"`.
- `applyImportIntercept` with a binding that synthesizes a 2-word behavior
  (`"validator -- v"`) — Layer 1 rejects the intent, `runImportIntercept`
  returns `intercepted=false` with `intentSpecificity` envelope present, and
  `yakccResolve` is **not** invoked for that binding.

**Dependencies on other layers:** none. Layer 1 is the entrypoint and can
ship before any other layer.

### 5.3 Layer 2 — result-set size enforcement (S2)

**Owner:** `packages/hooks-base/src/result-set-size.ts` (new in S2)
**DEC:** `DEC-HOOK-ENF-LAYER2-RESULT-SET-001`

**Plug-in points:**
- After every `registry.findCandidatesByQuery` / `yakccResolve` call:
  - `index.ts::_executeRegistryQueryInternalWithCandidates` after the
    `findCandidatesByQuery` line.
  - `import-intercept.ts::runImportIntercept` after the `yakccResolve` line.

**Inputs:** the candidate array (with combinedScores), original intent text
(for the reject envelope's diagnostic).

**Outputs:** `ResultSetEnvelope` — either `{ok, surfaced}` or
`{result_set_too_large, matched: N, threshold: 3}`.

**Heuristics:**

| Knob | Default | DEC-ID |
|---|---|---|
| `RESULT_SET_MAX_CONFIDENT` | 3 (candidates with combinedScore ≥ CONFIDENT_THRESHOLD) | `DEC-HOOK-ENF-LAYER2-MAX-CONFIDENT-001` |
| `RESULT_SET_MAX_OVERALL` | 10 (all returned candidates including weak band) | `DEC-HOOK-ENF-LAYER2-MAX-OVERALL-001` |
| Tunability hook | env `YAKCC_RESULT_SET_MAX` overrides confident bound at runtime | `DEC-HOOK-ENF-LAYER2-TUNABLE-001` |

**Subsumption note:** `yakccResolve` already emits `disambiguation_hint` (≥5
candidates within ε=0.02). Layer 2 generalizes that into a hard reject when
`countConfident > RESULT_SET_MAX_CONFIDENT`. The two are complementary, not
duplicative — disambiguation_hint advises; Layer 2 refuses.

**Reject text:** matches issue body verbatim:
```json
{ "result": "intent_too_broad", "matched": 12, "threshold": 3,
  "message": "Your intent matched 12 candidate atoms. Narrow it until <=3 match." }
```

**Tests:** parameterized over candidate-count fixtures (0, 1, 3, 4, 10, 12).
Integration tests assert that `executeRegistryQueryWithSubstitution` returns
passthrough when result-set is too large and emits
`outcome === "result-set-too-large"` telemetry.

**Dependencies:** none on Layer 1 (Layer 2 only runs after the query, which
only runs after Layer 1 accepted — natural composition, no shared state).

### 5.4 Layer 3 — atom-size ratio (S3)

**Owner:** `packages/hooks-base/src/atom-size-ratio.ts` (new in S3)
**DEC:** `DEC-HOOK-ENF-LAYER3-ATOM-SIZE-RATIO-001` (mentioned by name in #579
body)

**Plug-in point:** `substitute.ts::executeSubstitution` between the
auto-accept gate (D2 score/gap check) and the actual `renderSubstitution`
call.

**Inputs (atom side):**
- transitive node count: derived from the atom's `BlockTripletRow`
  (`specCanonicalBytes` → `inputs.length + outputs.length + guarantees.length`
  as a proxy in v1; in v2 swap for the real shaved-IR node count once exposed
  by `@yakcc/registry`).
- exported surface area: number of named exports on the atom's spec.
- transitive dependency count: from the registry's stored provenance row, when
  present; defaults to 0 when not exposed.

**Inputs (need side, from `originalCode` at call-site):**
- bindings used: count of identifiers from the atom's export list referenced
  in `originalCode` (ts-morph scan of the existing call-sites — reuses the
  parser already in `import-intercept.ts`).
- AST complexity of the call sites: statement count under the calling
  function's body containing the binding reference (proxy for "how much do we
  actually need").

**Decision:**

```text
atomComplexity = transitiveNodes + 5 * exportedSurface + 2 * transitiveDeps
needComplexity = max(1, bindingsUsed * statementCount)
ratio = atomComplexity / needComplexity
if ratio > ATOM_OVERSIZED_RATIO_THRESHOLD → REJECT (atom_oversized)
```

| Knob | Default | DEC-ID |
|---|---|---|
| `ATOM_OVERSIZED_RATIO_THRESHOLD` | 10 (matches issue body's "10x") | `DEC-HOOK-ENF-LAYER3-RATIO-THRESHOLD-001` |
| Min absolute floor (skip ratio check below this atomComplexity) | 20 nodes | `DEC-HOOK-ENF-LAYER3-MIN-FLOOR-001` |

**Reject envelope:**
```text
ATOM_OVERSIZED: candidate atom complexity ~<X> vs immediate need ~<Y> (ratio <R>x).
Refusing to substitute. Decompose the immediate need into sub-atoms and
re-query each.
```

**Tests:** unit tests parameterized over (atom_complexity, need_complexity)
pairs. Integration test: substitute lodash-sized atom into a "add two
numbers" emission → Layer 3 rejects → telemetry
`outcome === "atom-oversized"`.

**Dependencies:** none. Layer 3 only runs at substitution-time, after Layers
1+2 already accepted.

### 5.5 Layer 4 — descent-tracking advisory (S4)

**Owner:** `packages/hooks-base/src/descent-tracker.ts` (new in S4)
**DEC:** `DEC-HOOK-ENF-LAYER4-DESCENT-TRACKING-001`

**Plug-in points:**
- `import-intercept.ts::applyImportIntercept` on each miss: record a "descent
  attempt" keyed by `(packageName, binding)` in a per-session in-memory map.
- `substitute.ts::executeSubstitution` before rendering: look up the
  `(packageName, binding)` pair and check `descentDepth`. If `< 2`, attach a
  `descentBypassWarning` envelope to the substitution result (does NOT block
  substitution; emits a warning to the LLM and telemetry).

**State authority:**
- Per-session in-memory `Map<bindingKey, DescentRecord>` (NOT persisted
  to disk; resets per process). Reuses the `makeBindingKey` helper already
  exported from `shave-on-miss-state.ts`.

**Heuristics:**

| Knob | Default | DEC-ID |
|---|---|---|
| `DESCENT_MIN_DEPTH` | 2 (matches issue body: "<2 levels and immediately substituted") | `DEC-HOOK-ENF-LAYER4-MIN-DEPTH-001` |
| Legitimately-shallow allowlist (skip warning for known primitive intents) | small curated list keyed on intent regex; bootstrapped with `add`, `sub`, `mul`, `cmp`, `eq`, `not`, `isString`, `isNumber` | `DEC-HOOK-ENF-LAYER4-SHALLOW-ALLOW-001` |

**Reject envelope (advisory):**
```text
DESCENT_BYPASS_WARNING: substituted <atomName> after <N> descent step(s).
Per descent-and-compose discipline, decompose this intent and re-query each
sub-intent before reaching for a high-level atom. Substitution proceeded;
this warning is non-blocking.
```

**Tests:** simulate descent sequences (n=0, 1, 2, 3) and assert warning
emission per threshold. Integration test: drive `applyImportIntercept` ×N
with miss→narrower→hit sequence and assert no warning; same harness with
miss→immediate-hit asserts warning.

**Dependencies:** uses `shave-on-miss-state.ts::makeBindingKey` (already
exported). No other layer dependency.

### 5.6 Layer 5 — drift detection (S5)

**Owner:** `packages/hooks-base/src/drift-detector.ts` (new in S5)
**DEC:** `DEC-HOOK-ENF-LAYER5-DRIFT-DETECTION-001`

**Plug-in point:** wraps `telemetry.ts::captureTelemetry` — after the JSONL
append, the wrapper updates an in-memory per-session aggregate and surfaces
synchronously when a threshold is crossed. Per-IDE aggregation runs in a CLI
side-tool (deferred from in-hook to keep latency bounded).

**Metrics tracked (per session, in-memory):**

| Metric | Threshold | DEC-ID |
|---|---|---|
| Avg Layer 1 specificity score (rolling N=20) | < 0.55 → drift_alert | `DEC-HOOK-ENF-LAYER5-AVG-SPECIFICITY-001` |
| % of substitutions bypassing descent (rolling N=20) | > 40% → drift_alert | `DEC-HOOK-ENF-LAYER5-DESCENT-BYPASS-PCT-001` |
| Result-set median size (rolling N=20) | > 5 → drift_alert | `DEC-HOOK-ENF-LAYER5-MEDIAN-RESULT-SET-001` |
| Atom-size median ratio (rolling N=20) | > 4 → drift_alert | `DEC-HOOK-ENF-LAYER5-MEDIAN-RATIO-001` |

**Outputs:** `outcome === "drift-alert"` telemetry event with a
`driftMetric` field naming the offending metric. Operator-facing tool
(`packages/cli/src/commands/yakcc-drift-report.ts` — deferred to S5) renders
per-IDE rollups from JSONL files.

**Tests:** seed a synthetic JSONL stream and assert the wrapper fires
`drift-alert` after the Nth event.

**Dependencies:** consumes Layers 1, 2, 3, 4 telemetry events.

### 5.7 Layer 6 — eval gate (S1 skeleton + every subsequent slice)

**Owner:** `packages/hooks-base/test/enforcement-eval-corpus.test.ts` (new
in S1)
**DEC:** `DEC-HOOK-ENF-LAYER6-EVAL-CORPUS-001`

**Shape:** a Vitest test that loads a JSON corpus
(`packages/hooks-base/test/enforcement-eval-corpus.json` — committed) of
`{input, expectedLayer, expectedOutcome, notes?}` rows and asserts the live
hook pipeline produces the expected outcome for every row.

**Slice rule:** **no slice ships without expanding this corpus.** S1 seeds
Layer 1 rows; S2 adds Layer 2 rows; … S5 adds Layer 5 rows. The test is a
hard gate per #579 acceptance — no carve-outs to skip individual layers.

**S1 seed corpus (≥5 rows required by Evaluation Contract; 7 included for
margin):**

```json
[
  { "id": "L1-001", "input": "utility for handling stuff",
    "expectedLayer": 1, "expectedOutcome": "intent-too-broad",
    "notes": "stop_word + meta_word" },
  { "id": "L1-002", "input": "validate input",
    "expectedLayer": 1, "expectedOutcome": "intent-too-broad",
    "notes": "too_short (2 words, below MIN_WORDS=4)" },
  { "id": "L1-003", "input": "helper",
    "expectedLayer": 1, "expectedOutcome": "intent-too-broad",
    "notes": "single_word + stop_word" },
  { "id": "L1-004", "input": "isEmail RFC 5321 subset",
    "expectedLayer": 1, "expectedOutcome": "accept",
    "notes": "specific verb + I/O hint" },
  { "id": "L1-005", "input": "split string on first :// substring",
    "expectedLayer": 1, "expectedOutcome": "accept",
    "notes": "action verb + I/O hint" },
  { "id": "L1-006", "input": "general parser",
    "expectedLayer": 1, "expectedOutcome": "intent-too-broad",
    "notes": "meta_word + too_short" },
  { "id": "L1-007", "input": "convert hex pair %XX to single byte",
    "expectedLayer": 1, "expectedOutcome": "accept",
    "notes": "action verb + I/O specifics" }
]
```

S2 will append L2-001..L2-NNN; S3 will append L3-…; etc. The eval gate
asserts every corpus row triggers exactly its `expectedLayer`'s enforcement
output via a registry stub harness — no live registry I/O. Acceptance
criterion: the eval test must pass on every PR touching `hooks-base/src/`.

---

## 6. Slice ordering — first slice recommendation

**Recommended:** S1 = Layer 1 (intent specificity gate) + Layer 6 skeleton.

**Why Layer 1 first (over Layer 6-only or Layer 3-first):**

1. **Bounds enforcement before any registry query** — Layer 1 is the
   earliest possible defensive position. If Layer 1 holds, Layers 2–4 see
   fewer adversarial inputs and their thresholds can be calibrated against
   real (filtered) traffic.
2. **Minimal coupling** — depends on no other layer; ships as a pure module
   that two call sites import. Reviewer-friendly scope.
3. **Highest catch rate per line of code** — the stop-word / meta-word /
   length heuristics catch the bulk of regression cases (per the issue's own
   adversarial corpus).
4. **Layer 6 alone is insufficient** — a test corpus without an enforcement
   to test is dead code. Layer 6 needs at least one real enforcement layer
   wired in to verify the test harness actually catches regressions. Hence
   S1 carries Layer 6 *skeleton* (the harness + Layer 1 rows) — not
   Layer 6 in isolation.

**Why NOT Layer 6 first:** the harness must exercise live enforcement; an
empty eval test is a green CI signal that proves nothing. Layer 6 + one real
layer is the minimum viable shipping bundle.

**Why NOT Layer 3 first:** Layer 3 (atom-size ratio) requires registry data
shapes (transitive node count, exported surface) that are not currently
surfaced through the `@yakcc/registry` API. Shipping Layer 3 first would
force a registry-API expansion in the same slice — out of scope for this
WI's allowed paths.

---

## 7. First-slice scope (S1) — concrete spec

This is the spec the implementer executes. Scope is bound by the Scope
Manifest in §9.

### 7.1 Files to create

```
packages/hooks-base/src/intent-specificity.ts        # ~180 LOC: heuristic + decision
packages/hooks-base/src/enforcement-types.ts         # ~60 LOC: shared envelopes
packages/hooks-base/src/intent-specificity.test.ts   # ~250 LOC: unit tests
packages/hooks-base/test/intent-specificity-integration.test.ts   # ~200 LOC
packages/hooks-base/test/enforcement-eval-corpus.test.ts          # ~120 LOC: harness
packages/hooks-base/test/enforcement-eval-corpus.json             # 7 rows
packages/hooks-base/test/layer1-vague-intent-gate.test.ts         # ~80 LOC: focused regression test
```

(Other layers' files — `result-set-size.ts`, `atom-size-ratio.ts`,
`descent-tracker.ts`, and their tests — appear in the workflow's allowed
paths so future slices can land in the same authority domain without a
scope-manifest amendment, but **S1 does not create them**.)

### 7.2 Files to modify

```
packages/hooks-base/src/index.ts          # wire Layer 1 gate at 2 call sites
packages/hooks-base/src/import-intercept.ts   # wire Layer 1 gate inside runImportIntercept
packages/hooks-base/src/telemetry.ts      # additive: "intent-too-broad" outcome
packages/hooks-base/src/index.ts          # additive: extend HookResponseWithSubstitution
                                          # with optional intentRejectEnvelope field
```

### 7.3 Function signatures (canonical)

```ts
// intent-specificity.ts
export function scoreIntentSpecificity(intent: string): IntentSpecificityResult;
export function isIntentSpecificEnough(intent: string): boolean;
export const STOP_WORDS: ReadonlySet<string>;
export const META_WORDS: ReadonlySet<string>;
export const ACTION_VERBS: ReadonlySet<string>;
export const MIN_WORDS = 4;
export const MAX_WORDS = 20;
```

### 7.4 Integration with `executeRegistryQueryWithSubstitution`

```ts
// index.ts (additive, inside executeRegistryQueryWithSubstitution near top)
const intentCheck = scoreIntentSpecificity(ctx.intent);
if (intentCheck.status === "intent_too_broad" &&
    process.env.YAKCC_HOOK_DISABLE_INTENT_GATE !== "1") {
  // Telemetry-only side effect; passthrough response.
  try {
    const { captureTelemetry } = await import("./telemetry.js");
    captureTelemetry({
      intent: ctx.intent, toolName, response: { kind: "passthrough" },
      candidateCount: 0, topScore: null, latencyMs: Date.now() - start,
      outcomeOverride: "intent-too-broad" as never,  // additive enum slot
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.telemetryDir !== undefined ? { telemetryDir: options.telemetryDir } : {}),
    });
  } catch { /* telemetry must not affect hook outcome */ }
  return { kind: "passthrough", substituted: false, intentRejectEnvelope: intentCheck };
}
```

The escape hatch (`YAKCC_HOOK_DISABLE_INTENT_GATE=1`) mirrors the existing
`YAKCC_HOOK_DISABLE_SUBSTITUTE` / `YAKCC_HOOK_DISABLE_ATOMIZE` convention
(Sacred Practice 12 — same authority pattern).

### 7.5 Integration with `runImportIntercept` (in `import-intercept.ts`)

```ts
// Inside the for-loop, before yakccResolve call:
const intentCheck = scoreIntentSpecificity(enrichedCard.behavior);
if (intentCheck.status === "intent_too_broad") {
  results.push({
    binding: candidate.binding, intercepted: false,
    address: null, behavior: null, score: null,
    intentSpecificity: intentCheck,
  });
  continue; // skip yakccResolve for this binding
}
// existing yakccResolve call follows...
```

### 7.6 Telemetry additive expansion

`telemetry.ts`:

```ts
readonly outcome:
  | "registry-hit" | "synthesis-required" | "passthrough" | "atomized"
  | "shave-on-miss-enqueued" | "shave-on-miss-completed" | "shave-on-miss-error"
  | "intent-too-broad";                          // S1 additive (DEC-HOOK-ENF-LAYER1-TELEMETRY-001)
```

`outcomeFromResponse` does not need a new branch — the new outcome is
supplied only via `outcomeOverride` from the gate site (mirrors the
`atomized` pattern).

### 7.7 Test corpus rows (S1)

See §5.7 — 7 rows seeded; corpus harness asserts each row produces the
expected outcome by running through `executeRegistryQueryWithSubstitution`
with a registry stub.

### 7.8 Out of scope for S1

- No Layer 2/3/4/5/6-beyond-skeleton work.
- No changes to `yakccResolve` itself (Layer 2 will wrap it in S2).
- No changes to IDE adapter packages (per scope manifest's forbidden paths).
- No changes to `docs/system-prompts/yakcc-discovery.md` (Layer 0, owned by
  #578).
- No new `package.json` deps; the scorer is pure TS + regex.

---

## 8. Follow-up issue bodies (filed at S1 land-time)

The orchestrator files these 5 GH issues after S1 lands. Each is a complete
issue body ready to paste into `gh issue create`.

### 8.1 Issue: WI-579-S2 Layer 2 — result-set size enforcement

```markdown
# WI-579-S2 — Layer 2: result-set size enforcement (post-query)

**Parent:** #579 (Hook enforcement architecture)
**Plan:** plans/wi-579-hook-enforcement-architecture.md §5.3
**Depends on:** S1 (#579-S1, Layer 1 + corpus harness landed)
**DEC:** DEC-HOOK-ENF-LAYER2-RESULT-SET-001 + 3 sub-DECs

## Summary
After every registry query (both `findCandidatesByQuery` in `index.ts` and
`yakccResolve` in `import-intercept.ts`), enforce a hard cap on confident
candidates. When `countConfident > RESULT_SET_MAX_CONFIDENT (=3)`, refuse to
surface results and return a forcing-function envelope.

## Plug-in points
- `packages/hooks-base/src/index.ts::_executeRegistryQueryInternalWithCandidates`
  — after the `findCandidatesByQuery` line.
- `packages/hooks-base/src/import-intercept.ts::runImportIntercept` — after
  the `yakccResolve` line.

## Heuristics (locked thresholds)
- `RESULT_SET_MAX_CONFIDENT = 3` (DEC-HOOK-ENF-LAYER2-MAX-CONFIDENT-001)
- `RESULT_SET_MAX_OVERALL = 10` (DEC-HOOK-ENF-LAYER2-MAX-OVERALL-001)
- Runtime override env `YAKCC_RESULT_SET_MAX` (DEC-HOOK-ENF-LAYER2-TUNABLE-001)

## Eval-corpus additions (Layer 6)
- `L2-001`: registry stub returns 12 confident candidates → expect
  `outcome: "result-set-too-large"` with `matched: 12`.
- `L2-002`: 4 confident candidates → expect reject.
- `L2-003`: 3 confident candidates → expect surface (boundary).
- `L2-004`: 0 confident, 5 weak → expect surface (weak band is informational).
- `L2-005`: env override `YAKCC_RESULT_SET_MAX=5`, 4 confident → expect surface.

## Acceptance
- All Layer 2 corpus rows pass.
- `outcomeFromResponse` does not change shape; `outcome` enum gains
  `"result-set-too-large"` additively.
- No regression on S1 Layer 1 corpus rows.
- pre-push hygiene clean.
```

### 8.2 Issue: WI-579-S3 Layer 3 — atom-size ratio

```markdown
# WI-579-S3 — Layer 3: atom-size enforcement (substitution-time)

**Parent:** #579
**Plan:** plans/wi-579-hook-enforcement-architecture.md §5.4
**Depends on:** S1, S2 (corpus harness present)
**DEC:** DEC-HOOK-ENF-LAYER3-ATOM-SIZE-RATIO-001 (named in #579 body)

## Summary
Before `substitute.ts::renderSubstitution` fires, compare the candidate
atom's complexity to the immediate-need complexity at the call sites. If
`ratio > ATOM_OVERSIZED_RATIO_THRESHOLD (=10)`, refuse the substitution and
emit a forcing envelope.

## Plug-in point
`packages/hooks-base/src/substitute.ts::executeSubstitution` between
auto-accept gate and render.

## Heuristics
- atomComplexity proxy = `transitiveNodes + 5*exportedSurface + 2*transitiveDeps`
  (transitiveNodes derived from spec inputs+outputs+guarantees count in v1).
- needComplexity proxy = `max(1, bindingsUsed * statementCount)` at call site.
- `ATOM_OVERSIZED_RATIO_THRESHOLD = 10` (DEC-HOOK-ENF-LAYER3-RATIO-THRESHOLD-001).
- Min absolute floor 20 nodes (DEC-HOOK-ENF-LAYER3-MIN-FLOOR-001).

## Eval-corpus additions
- `L3-001`: substitute lodash-shaped atom for `(a, b) => a + b` → reject.
- `L3-002`: substitute `joi` schema for "validate string-is-email" → reject.
- `L3-003`: substitute right-sized atom for matching use → accept.
- `L3-004`: atomComplexity below floor → bypass ratio check (boundary).
- `L3-005`: ratio exactly 10 → reject (inclusive boundary).

## Acceptance
- Layer 3 corpus rows pass.
- Existing substitution paths regress to 0 substitution-blocked false-positives
  on the S1 + S2 corpus (smoke-test against current bench fixtures).
- pre-push hygiene clean.
```

### 8.3 Issue: WI-579-S4 Layer 4 — descent tracking advisory

```markdown
# WI-579-S4 — Layer 4: compose-vs-substitute (descent depth tracker)

**Parent:** #579
**Plan:** plans/wi-579-hook-enforcement-architecture.md §5.5
**Depends on:** S1..S3
**DEC:** DEC-HOOK-ENF-LAYER4-DESCENT-TRACKING-001

## Summary
Track per-`(packageName, binding)` descent depth in a per-session in-memory
map. When `executeSubstitution` is about to substitute and `descentDepth < 2`,
attach an advisory `descentBypassWarning` to the result (non-blocking).

## State authority
Per-session `Map<bindingKey, DescentRecord>`; key built via
`shave-on-miss-state.ts::makeBindingKey` (already exported). NOT persisted.

## Heuristics
- `DESCENT_MIN_DEPTH = 2` (DEC-HOOK-ENF-LAYER4-MIN-DEPTH-001).
- Shallow-allow regex list bootstraps with primitives (DEC-HOOK-ENF-LAYER4-SHALLOW-ALLOW-001).

## Eval-corpus additions
- `L4-001`: `applyImportIntercept` × {miss, miss, hit} then substitute →
  no warning (descent=2).
- `L4-002`: immediate hit then substitute → warning (descent=0).
- `L4-003`: intent matches shallow-allow regex → no warning even at descent=0.

## Acceptance
- Layer 4 corpus rows pass.
- pre-push hygiene clean.
```

### 8.4 Issue: WI-579-S5 Layer 5 — drift detection

```markdown
# WI-579-S5 — Layer 5: telemetry-driven drift detection (per-session, per-IDE)

**Parent:** #579
**Plan:** plans/wi-579-hook-enforcement-architecture.md §5.6
**Depends on:** S1..S4 (drift detector consumes all prior layers' events)
**DEC:** DEC-HOOK-ENF-LAYER5-DRIFT-DETECTION-001 + 4 sub-DECs

## Summary
Wrap `captureTelemetry`: maintain a per-session rolling window (N=20) over
Layers 1–4 metrics. When any tracked metric crosses its drift threshold, emit
`outcome: "drift-alert"` with a `driftMetric` discriminant. Per-IDE rollup is
a CLI side-tool reading the JSONL files.

## Metrics + thresholds
| Metric | Drift threshold |
|---|---|
| Avg Layer 1 specificity score | < 0.55 |
| % substitutions bypassing descent | > 40% |
| Result-set median size | > 5 |
| Atom-size median ratio | > 4 |

## Eval-corpus additions
- `L5-001`: 20 events, avg-specificity 0.40 → `drift-alert` fires.
- `L5-002`: 20 events, avg-specificity 0.80 → no alert.
- `L5-003`: descent-bypass 50% → alert.

## Out of scope (next WI)
- Per-IDE rollup CLI tool (`yakcc-drift-report`) — file as separate issue.

## Acceptance
- Layer 5 corpus rows pass.
- Drift wrapper adds ≤ 1ms p99 to `captureTelemetry`.
- pre-push hygiene clean.
```

### 8.5 Issue: WI-579-S6 — end-to-end against #578 prompt; baseline; close #579

```markdown
# WI-579-S6 — End-to-end enforcement + baseline measurement (#579 closer)

**Parent:** #579
**Plan:** plans/wi-579-hook-enforcement-architecture.md §6
**Depends on:** S1..S5 all landed
**DEC:** DEC-HOOK-ENF-CLOSER-001

## Summary
End-to-end exercise of all 6 layers against the #578 imperative prompt
corpus. Establish baseline measurements for B1/B4/B5/B9/B10 against the
enforced hook. Re-run the adversarial corpus on a freshly bulk-shaved local
registry. Close #579.

## Required artifacts
- Eval corpus ≥ 50 rows total across L1..L5 (issue body acceptance).
- Bench baseline JSONL committed to `bench/B*/` directories per existing
  convention; the diff between pre-#579 and post-#579 numbers documented in
  the closer issue body.
- `docs/adr/hook-enforcement-architecture.md` ADR cross-referencing every
  `DEC-HOOK-ENF-*` ID (issue body acceptance: "documented in
  docs/adr/hook-enforcement-architecture.md").

## Acceptance (= #579 closer)
- All 6 layers shipped; Layer 6 corpus ≥ 50 rows passes in CI.
- ADR landed.
- Bench baselines committed.
- #512 S2 unblocked (cross-ref).
- #579 closes.
```

---

## 9. Scope Manifest (S1)

This is the canonical Scope Manifest the implementer is bound by; it matches
the workflow contract's allowed/required/forbidden lists.

### 9.1 Allowed paths (implementer may touch)

```
packages/hooks-base/src/import-intercept.ts        # wire Layer 1 gate
packages/hooks-base/src/yakcc-resolve.ts           # read-only reference
packages/hooks-base/src/atomize.ts                 # read-only reference
packages/hooks-base/src/substitute.ts              # read-only reference
packages/hooks-base/src/telemetry.ts               # additive outcome enum slot
packages/hooks-base/src/system-prompt.ts           # read-only reference
packages/hooks-base/src/index.ts                   # wire Layer 1 gate + envelope export
packages/hooks-base/src/intent-specificity.ts      # NEW
packages/hooks-base/src/intent-specificity.test.ts # NEW
packages/hooks-base/src/result-set-size.ts         # NOT touched in S1 (allowed for S2)
packages/hooks-base/src/result-set-size.test.ts    # NOT touched in S1
packages/hooks-base/src/atom-size-ratio.ts         # NOT touched in S1
packages/hooks-base/src/atom-size-ratio.test.ts    # NOT touched in S1
packages/hooks-base/src/descent-tracker.ts         # NOT touched in S1
packages/hooks-base/src/descent-tracker.test.ts    # NOT touched in S1
packages/hooks-base/src/enforcement-types.ts       # NEW
packages/hooks-base/test/enforcement-eval-corpus.test.ts       # NEW
packages/hooks-base/test/intent-specificity-integration.test.ts # NEW
packages/hooks-base/test/result-set-size-integration.test.ts    # NOT touched in S1
packages/hooks-base/test/atom-size-ratio-integration.test.ts    # NOT touched in S1
packages/hooks-base/test/descent-tracker-integration.test.ts    # NOT touched in S1
packages/hooks-base/test/layer1-vague-intent-gate.test.ts       # NEW
plans/wi-579-hook-enforcement-architecture.md      # THIS doc — planner-only
plans/wi-579-s1-layer1-intent-specificity.md       # the S1 spec — implementer may extend
tmp/wi-579-investigation/**                        # planner+implementer scratch
```

### 9.2 Required paths (must be modified/created in S1)

```
plans/wi-579-hook-enforcement-architecture.md      # this file
packages/hooks-base/src/intent-specificity.ts
packages/hooks-base/src/enforcement-types.ts
packages/hooks-base/test/enforcement-eval-corpus.test.ts
packages/hooks-base/src/index.ts                   # Layer 1 wiring
packages/hooks-base/src/import-intercept.ts        # Layer 1 wiring
packages/hooks-base/src/telemetry.ts               # outcome enum additive expansion
```

### 9.3 Forbidden paths (never touched by S1)

```
packages/compile/**
packages/contracts/**
packages/registry/**
packages/cli/**
packages/federation/**
packages/ir/**
packages/seeds/**
packages/variance/**
packages/shave/**
packages/hooks-claude-code/**
packages/hooks-cursor/**
packages/hooks-codex/**
docs/system-prompts/yakcc-discovery.md           # Layer 0, owned by #578
.github/**
.claude/**
MASTER_PLAN.md
```

### 9.4 State authorities touched

- `hook-enforcement-layers` (this WI is the first writer; sole authority).
- Reads `intent-text` produced by hook callers (no mutation).
- Reads existing telemetry-event-schema authority (`telemetry.ts`) and
  extends it additively per Sacred Practice 12.

---

## 10. Evaluation Contract (S1)

**Required tests (must pass before guardian:land):**

1. `packages/hooks-base/src/intent-specificity.test.ts` — all 13 unit cases
   in §5.2 pass.
2. `packages/hooks-base/test/intent-specificity-integration.test.ts` —
   2 integration tests (executeRegistryQueryWithSubstitution registry-stub
   assertion + runImportIntercept skip-yakccResolve assertion) pass.
3. `packages/hooks-base/test/layer1-vague-intent-gate.test.ts` — focused
   regression test asserting the gate fires for the issue body's
   `"utility for handling stuff"` exemplar.
4. `packages/hooks-base/test/enforcement-eval-corpus.test.ts` — Layer 6
   harness loads `enforcement-eval-corpus.json` (≥ 5 rows; 7 included) and
   asserts each row's `expectedOutcome` matches live pipeline behavior.
5. No existing `packages/hooks-base/test/**` test regresses (full
   `pnpm -F @yakcc/hooks-base test` green).

**Required real-path checks (pre-land sanity):**

- `packages/hooks-base/src/import-intercept.ts` exists (Layer 1 wires here).
- `packages/hooks-base/src/yakcc-resolve.ts` exists.
- `packages/hooks-base/src/telemetry.ts` exists.
- `docs/system-prompts/yakcc-discovery.md` exists and is untouched
  (`git diff` shows no changes — Layer 0 sacred).

**Required authority invariants:**

- `intent-specificity.ts` is the **sole** declarant of MIN_WORDS, MAX_WORDS,
  STOP_WORDS, META_WORDS, ACTION_VERBS. No sibling file may redeclare them.
- IDE adapter packages (`hooks-claude-code`, `hooks-cursor`, `hooks-codex`)
  are not touched — Layer 1 lives entirely in `hooks-base` and IDE adapters
  inherit enforcement automatically (verified by `git diff --stat`).
- `telemetry.ts::TelemetryEvent.outcome` is extended additively — no removed
  or renamed variants (Sacred Practice 12).
- Layer 1 wiring is gated behind `YAKCC_HOOK_DISABLE_INTENT_GATE` env, but
  the default behavior is "enforce" (no opt-in needed for production
  behavior; opt-out only for tests / breakglass).
- Eval corpus harness is wired such that every PR touching
  `packages/hooks-base/src/**` runs it (Vitest test in default suite).

**Required integration points:**

- #578 prompt (`docs/system-prompts/yakcc-discovery.md`) is Layer 0 — its
  text is referenced in Layer 1's reject envelope ("Per …yakcc-discovery.md,
  decompose…"). Not duplicated. Not modified.
- #569/#574 telemetry surface is extended additively — same Sacred-Practice-12
  pattern (verified by enum-additive lint on `outcome` union if present,
  else by code review).
- Existing import-intercept hook path (`applyImportIntercept` →
  `runImportIntercept` → `yakccResolve`) is preserved end-to-end; Layer 1
  short-circuits before `yakccResolve` per binding when intent fails.

**Forbidden shortcuts:**

- Implementing all 6 layers in one slice (reviewer will reject — slice
  discipline).
- Skipping Layer 6 (the corpus harness must be wired in S1).
- Adding per-IDE intent-specificity logic in `hooks-claude-code` /
  `hooks-cursor` / `hooks-codex` packages (forbidden by scope; enforcement
  is in `hooks-base` only).
- Weakening Layer 1 heuristics (e.g. dropping the stop-word list, raising
  MAX_WORDS past 20, or making it an advisory-only warning) to make tests
  pass.
- Reading or modifying `docs/system-prompts/yakcc-discovery.md` (Layer 0 is
  owned by the closed #578 / PR #580 stream).
- Inlining heuristic constants at call sites (`index.ts` /
  `import-intercept.ts`) instead of importing from `intent-specificity.ts`.

**Ready-for-guardian definition:**

- All five required tests above are green on the implementer's branch.
- `git diff --stat` is contained to the allowed paths in §9.1 (and only the
  files in §9.2 changed). No file under §9.3 has any diff.
- Reviewer subagent has emitted `REVIEW_VERDICT=ready_for_guardian` against
  the head SHA after running the Evaluation Contract.
- pre-push hygiene clean (no debug logs, no `console.log`, no TODOs left in
  shipped code beyond the explicit deferral markers tied to S2..S6 DEC-IDs).

**Rollback boundary:** the entire S1 slice is reversible by `git revert` of
the landing commit. Layer 1 module is leaf-imported only by `index.ts` and
`import-intercept.ts`; reverting removes both call sites and the new files
in one step. The eval corpus rows are additive and removable independently.

---

## 11. Decision Log

| DEC-ID | Subject | Rationale (1-line) |
|---|---|---|
| DEC-HOOK-ENF-ENVELOPES-001 | shared envelope module `enforcement-types.ts` | single-source-of-truth shape for Layers 1–5; avoids sibling-module reaches |
| DEC-HOOK-ENF-LAYER1-INTENT-SPECIFICITY-001 | Layer 1 owner module + algorithm | binary accept/reject; score is telemetry only |
| DEC-HOOK-ENF-LAYER1-MIN-WORDS-001 | MIN_WORDS = 4 | matches #579 body lower bound |
| DEC-HOOK-ENF-LAYER1-MAX-WORDS-001 | MAX_WORDS = 20 | matches #579 body upper bound |
| DEC-HOOK-ENF-LAYER1-STOP-WORDS-001 | 10-word stop-word list | #579 body's 8 + `processor`/`worker` for breadth |
| DEC-HOOK-ENF-LAYER1-META-WORDS-001 | 8-word meta-word list | #579 body's 4 + `any`/`several`/`misc`/`generic` |
| DEC-HOOK-ENF-LAYER1-ACTION-VERBS-001 | curated ~80-verb allowlist | positive signal complements negative heuristics |
| DEC-HOOK-ENF-LAYER1-SINGLE-WORD-001 | always reject `wordCount === 1` | single-word intents are categorically too broad |
| DEC-HOOK-ENF-LAYER1-IO-HINT-001 | advisory I/O-hint signal | raises specificity score; not a gating criterion |
| DEC-HOOK-ENF-LAYER1-TELEMETRY-001 | `outcome: "intent-too-broad"` additive | mirrors WI-508-S2 enum-expansion pattern |
| DEC-HOOK-ENF-LAYER1-ESCAPE-HATCH-001 | `YAKCC_HOOK_DISABLE_INTENT_GATE=1` env | breakglass + test-only; default behavior is enforce |
| DEC-HOOK-ENF-LAYER6-EVAL-CORPUS-001 | Layer 6 harness + S1 seed rows | corpus is a hard CI gate; ≥ 5 rows seeded in S1 |
| DEC-HOOK-ENF-LAYER2..5-* | (deferred to S2..S5; see follow-up issue bodies §8) | each layer carries its own DEC-IDs; documented at slice land |

---

## 12. Active Initiatives status

- **S1 (this slice):** Layer 1 + Layer 6 skeleton — **plan complete**, ready
  for `guardian:provision`.
- **S2..S5:** issue bodies drafted in §8 — orchestrator files them at S1 land
  time.
- **S6:** closer slice (e2e + baseline + ADR + close #579) — body drafted in
  §8.5.

---

## 13. Post-landing continuation rule

After S1 lands:
1. Orchestrator files the 4 follow-on issues from §8.1–8.4 (S2..S5) and the
   closer §8.5 via `gh issue create`. URLs recorded in the planner's
   continuation note for S2.
2. Continuation verdict: `next_work_item` targeting S2 (Layer 2) — Scope
   Manifest and Evaluation Contract per §5.3 + §8.1.
3. Goal `g-579-hook-enforcement` does NOT terminate until S6 closes #579.
