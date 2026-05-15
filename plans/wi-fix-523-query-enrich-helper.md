# Plan: shared `queryIntentCardFromSource` helper + hook awareness + call-site migration (#523)

**Workflow:** `fix-523-query-enrich-helper`
**Goal:** `g-fix-523`
**Work item:** `wi-fix-523-plan`
**Branch:** `feature/fix-523-query-enrich-helper`
**Status:** plan-only WI (planner). Implementation lands as separate per-slice PRs.

**Closes:** #523 (residual of #444; companion to #502)
**Cross-refs:** PR #524 (canonicalizeQueryText wiring), `DEC-VECTOR-RETRIEVAL-002` (text-asymmetry origin), `DEC-V3-DISCOVERY-D2-001` (QueryIntentCard surface), `DEC-V3-IMPL-QUERY-001` (canonicalizeQueryText projection rules), `DEC-V3-INITIATIVE-002` (multi-dim forward-compat), `DEC-V3-DISCOVERY-CALIBRATION-FIX-002` (#500 distance→confidence formula), `DEC-HOOK-PHASE-2-001` (substitution wrapper), `DEC-HOOK-ATOM-CAPTURE-001` (atomize-on-emission).

---

## 1. Desired End State

A demonstrable, evidence-backed close-out of #523 with **no store-side changes**:

- `bench/v0-release-smoke/smoke.mjs` **Step 9 PASS** — the BMR atomized in Step 8b reappears in the top-K of a same-session enriched query, deterministic across reruns.
- `bench/B7-commit/harness/run.mjs` round-trip slice: **zero acceptance violations** under the existing thresholds (currently 22/32 BMR-not-in-top-K → 0/32), and the novelty/collision slice continues to pass.
- `bench/B4-tokens` matrix shows a measurable token/quality lift attributable to the hook teaching LLMs the richer atom-lookup parameter surface (before/after numbers captured as P4 evidence).
- Every code path that constructs a `findCandidatesByQuery(...)` argument from TypeScript source goes through **one** function, `queryIntentCardFromSource`, exported from `@yakcc/contracts`. No call site re-derives the QueryIntentCard fields from source inline.
- A new DEC (`DEC-EMBED-QUERY-ENRICH-HELPER-001`) records the principle: the embedding asymmetry (#444 / #502 / #523) is resolved on the consumer (hook/query) side by enriching queries to match stored ContractSpecs, never by collapsing the store.

**Out-of-scope demonstrations:** the open-ended CLI `yakcc query "<free text>"` case stays fuzzy/behavior-only by design (no source context to enrich from). No re-bootstrap. No new fields on `QueryIntentCard`. No edits to `canonicalizeQueryText` projection rules.

---

## 2. Problem Decomposition

### What survived PR #524

PR #524 wired `findCandidatesByQuery` + `canonicalizeQueryText` so that **the canonicalization path is symmetric**: both store-side (`storeBlock`) and query-side embed canonical-JSON text from the same encoder (`canonicalizeText`). Three round-trip call sites already use `findCandidatesByQuery`:

- `bench/v0-release-smoke/smoke.mjs` Step 7 (seed query) and Step 9 (BMR-in-top-K).
- `bench/B7-commit/harness/run.mjs` (collision/novelty slice) and `run-utility.mjs` (round-trip rep loop).

### What did NOT survive

The **field-coverage asymmetry** survives. `storeBlock` embeds the full canonical JSON of a `SpecYak`/`ContractSpec` carrying every populated field (`inputs`, `outputs`, `behavior`, `guarantees`, `errorConditions`, `nonFunctional`, `propertyTests`). The four query call sites listed above all pass `{ behavior: "<text>", topK: K }` — a one-key projection. `canonicalizeQueryText` faithfully encodes that one-key projection, then embeds it. The embedding model sees a behavior-only string on the query side and a full multi-key JSON object on the store side. Cosine ranking suffers.

This is what #444's "v0 vector retrieval failures" actually were after the canonicalization rule was unified: not a text-format bug, but a **field-coverage** bug. PR #524 fixed format symmetry; #523 is the remaining field-coverage symmetry.

### Why Option C, not Option A

The operator already decided. The plan records the rationale for successors:

- **Option A (collapse store to behavior-only)** would discard the structural signal (`inputs`/`outputs`/`guarantees`) that D3's Stage 2 structural filter and the multi-dim discriminator depend on. It also requires re-bootstrap and threshold re-calibration; both have proven painful (`DEC-V3-INITIATIVE-002` already documents the cost). And it forecloses the multi-dim discovery story.
- **Option C (enrich queries to match the store)** preserves all of that. The cost is a single helper that derives QueryIntentCard fields from TS source, plus a hook prompt update that teaches LLMs to use the richer API.

### Why one shared helper

The operator's second hard requirement. Multiple call sites today already extract `intent` from source heuristically (atom JSDoc text, function-name heuristics, B7's `entry.intent` field). If every call site grows its own extractor for `inputs/outputs/guarantees/...`, we will rebuild the #444 asymmetry **between callers** within six months. One helper, one extractor, one DEC. Drift becomes mechanically harder.

### What we accept as residual

- **Atomize-side may synthesize fields the query-side extractor cannot.** Today `specFromIntent` (in `@yakcc/shave/persist/spec-from-intent.ts`) produces `SpecYak` with empty `invariants`/`effects` and forwards `preconditions`/`postconditions` from `IntentCard`. The query helper will produce **only what the same source path actually yields**. If the two diverge in the future (e.g., atomize starts inferring `nonFunctional.purity` from a static analysis pass that the query helper doesn't share), the asymmetry returns on those fields. **Mitigation: the helper and the atomize-side extractor must share extraction code (see §3 OD-2).**
- **Open-ended free-text CLI / chat queries** (`yakcc query "debounce a function call"`) stay behavior-only by construction — no source to enrich from. This is intentional and documented in DEC-EMBED-QUERY-ENRICH-HELPER-001 §non-goals.

---

## 3. Architecture Design — Helper Surface and State Authority Map

### 3.1 State authorities (load-bearing)

| Authority | Owner | Notes |
|---|---|---|
| Canonical JSON encoding rules | `packages/contracts/src/canonicalize.ts:encodeValue` | DO NOT MODIFY. Both store and query depend on byte-identical output. |
| QueryIntentCard → canonical text projection | `canonicalizeQueryText` in same file (DEC-V3-IMPL-QUERY-001) | DO NOT MODIFY projection rules; this WI only **populates** more fields of the QueryIntentCard before it is passed in. |
| Store-side embedding text | `Registry.storeBlock` → `JSON.parse(specCanonicalBytes)` → `generateEmbedding(spec, …)` | DO NOT MODIFY. |
| Source→IntentCard extractor (atomize) | `packages/shave/src/intent/static-extract.ts:staticExtract` | Existing path; produces `behavior`, `inputs`, `outputs` from TS source via ts-morph + JSDoc. Plan reuses this. |
| IntentCard → SpecYak mapping (atomize) | `packages/shave/src/persist/spec-from-intent.ts:specFromIntent` | Produces `SpecYak` (the L0 stored shape). Plan does NOT modify this. |
| QueryIntentCard schema | `packages/contracts/src/canonicalize.ts:QueryIntentCard` | DO NOT MODIFY; all required fields already exist (DEC-V3-DISCOVERY-D2-001). |
| Hook query construction | `@yakcc/hooks-base:buildIntentCardQuery` + `executeRegistryQueryWithSubstitution` | Currently builds `{ behavior, inputs: [], outputs: [] }`. **This WI extends construction to use the helper when source is available.** |
| MCP atom-lookup tool schema | `bench/B4-tokens/harness/mcp-server.mjs:ATOM_LOOKUP_TOOL.inputSchema` | One-field today (`intent`). **This WI extends it.** |
| B4 system prompt | `bench/B4-tokens/harness/run.mjs:PROMPT_*` constants | Today teaches: "call atom-lookup with intent". **This WI extends it to teach the richer surface.** |

### 3.2 Helper signature (proposed)

```ts
// packages/contracts/src/query-from-source.ts (proposed)
import type { QueryIntentCard } from "./canonicalize.js";

export interface QueryFromSourceOptions {
  /**
   * Optional entry-symbol selector. When the source declares multiple top-level
   * functions/classes, pick this one. Defaults to the first exported declaration.
   * Matches the existing staticExtract entry-point picker.
   */
  readonly entryFunction?: string;
  /**
   * Optional retrieval controls; passed through to the produced QueryIntentCard.
   * Defaults: topK omitted (caller-chosen), minScore omitted, weights omitted.
   */
  readonly topK?: number;
  readonly minScore?: number;
}

/**
 * Derive a QueryIntentCard from TypeScript/JavaScript source.
 *
 * The helper reuses the SAME extraction primitives as the atomize/storeBlock
 * path (DEC-EMBED-QUERY-ENRICH-HELPER-001): given identical source, the
 * (behavior, inputs, outputs) populated here are byte-identical to what
 * specFromIntent() would store. Fields the static extractor cannot currently
 * derive (guarantees, errorConditions, nonFunctional, propertyTests) are
 * omitted, matching the D1 absent-dimension rule.
 *
 * Pure, deterministic, no I/O. Throws TypeError if source fails to parse.
 */
export function queryIntentCardFromSource(
  source: string,
  options?: QueryFromSourceOptions,
): QueryIntentCard;
```

**Output mapping (P0 baseline — what the static extractor can do today):**

| QueryIntentCard field | Populated from | Source-of-truth (existing code) |
|---|---|---|
| `behavior` | JSDoc summary → signature string → fragment fallback | `static-extract.ts:extractJsDocFromNode` + `buildSignatureString` |
| `signature.inputs` | TS parameter list (`name?: string`, `type: string`) | `static-extract.ts:extractParams` |
| `signature.outputs` | TS return type (`name: "result"`, `type: <returnType>`) | `static-extract.ts:extractReturnType` |
| `errorConditions` | JSDoc `@throws` tags when present (best-effort, optional in P0) | `extractJsDocFromNode` extension (small) |
| `guarantees` | Omitted in P0 (no current extractor); reserved for future enrichment | — |
| `nonFunctional` | Omitted in P0 (no current static analysis path); reserved | — |
| `propertyTests` | Omitted in P0; reserved | — |

**Note on naming convergence:** today's `IntentCard.inputs/outputs` (shave) and `QueryIntentCard.signature.inputs/outputs` (contracts) are structurally similar but typed differently. The helper produces the **contracts** shape (the discovery query surface), not the shave shape. The mapping is internal.

### 3.3 OD-1 — helper home package (operator decision)

| Option | Pros | Cons | Recommendation |
|---|---|---|---|
| **A. `@yakcc/contracts`** | (1) Already depends on `ts-morph`; (2) co-located with `QueryIntentCard` and `canonicalizeQueryText` — one package owns the entire query surface; (3) lowest-dep package, so every consumer (registry, hooks-base, cli, bench) can import without dependency-direction issues; (4) DEC-V3-IMPL-QUERY-001 already lives here. | A pure type/encoder package starts hosting source-walking logic. Acceptable: the package already imports ts-morph for `canonical-ast.ts`. | **Recommended default.** |
| **B. `@yakcc/shave`** | Co-located with `static-extract.ts` — direct reuse without re-export. | (1) Hooks-base does not depend on shave today (it depends on contracts + registry); adding it pulls in the Anthropic-client transitive surface; (2) registry/cli would have to depend on shave for query construction; (3) wrong direction in the dep graph. | Reject — creates dep-graph upside-down. |
| **C. `@yakcc/registry`** | Co-located with storage and the symmetric API. | Registry should remain a storage authority, not a source-parser. Pulls ts-morph into a package that doesn't use it today. | Reject. |
| **D. New `@yakcc/discovery` package** | Cleanest separation. | One new package for one helper is over-engineered. | Reject for now; revisit if the helper grows to multiple modules. |

**Default decision (record in DEC):** Option A — land the helper in `@yakcc/contracts/src/query-from-source.ts`, re-exported from the package barrel. Re-export the shared extraction primitive from `@yakcc/shave/src/intent/static-extract.ts` into `@yakcc/contracts` only if needed; or factor the primitive into a `@yakcc/contracts` internal and re-import from shave (see OD-2).

### 3.4 OD-2 — extraction-primitive ownership (operator decision)

The helper must produce **byte-identical** `behavior` / `signature.inputs` / `signature.outputs` to what `specFromIntent` would store for the same source. Two ways to achieve this:

| Option | What changes | Tradeoff |
|---|---|---|
| **A. Move the primitive into contracts; shave imports it.** Extract `extractParams`, `extractReturnType`, `buildSignatureString`, `extractJsDocFromNode` from `packages/shave/src/intent/static-extract.ts` into a new `packages/contracts/src/source-extract.ts`. `staticExtract` re-imports from contracts. | Contracts grows; shave shrinks. Dep direction is fine (shave already depends on contracts). | One source of truth. **Recommended.** |
| **B. Leave the primitive in shave; contracts duplicates the extraction.** | Drift risk. Future #523-class bug. | Rejected — violates §1. |
| **C. Re-export from shave through contracts.** | Inverts the dep graph (contracts → shave). | Rejected — circular. |

**Default decision:** Option A. The factoring is a single-file mechanical move; tests in shave (`static-extract.test.ts`, `static-extract.props.test.ts`, `static-extract.integration.test.ts`) continue to exercise the primitive at the same callable boundary (re-imported), guaranteeing no behavior change.

### 3.5 OD-3 — atom-lookup tool field naming (operator decision)

The MCP tool schema today exposes `intent: string` as the only behavioral input. Two options for richer fields:

| Option | Surface | Tradeoff |
|---|---|---|
| **A. Keep `intent`, add new fields alongside.** `{ intent, inputs?, outputs?, guarantees?, errorConditions?, nonFunctional? }`. The harness internally maps `intent → behavior` for the QueryIntentCard. | Backward-compatible. Slight model confusion (intent vs behavior). | Lowest risk. |
| **B. Rename `intent` → `behavior` and add the rest.** `{ behavior, inputs?, outputs?, guarantees?, errorConditions?, nonFunctional? }`. Names match `QueryIntentCard` exactly. | Cleaner. Breaks the H1 prompt-variant matrix that ran with `intent`. | Better long-term. |
| **C. Keep `intent`, add only `inputs/outputs` (signature subset).** Minimal change. | Lower B4 impact (LLM can't pass `errorConditions` etc.). | Suboptimal for the value-prop slice. |

**Default decision:** Option B (rename to `behavior` and add full surface). The B4 matrix is a measurement harness, not a frozen production contract; renaming costs one round of prompt-variant regeneration and produces a cleaner long-lived surface. The hook prompt MUST be updated in lockstep (§3.6).

### 3.6 OD-4 — `findCandidatesByIntent` deprecation (operator decision)

`findCandidatesByIntent` is the asymmetric legacy (embeds `behavior + "\n" + params`). Three options:

| Option | Action | Tradeoff |
|---|---|---|
| **A. Migrate all round-trip callers to `findCandidatesByQuery`; deprecate `findCandidatesByIntent`.** | Add `@deprecated` JSDoc tag; route `executeRegistryQueryInternal` + B4 MCP harness through `findCandidatesByQuery`. CLI `yakcc query <intent>` keeps its fuzzy semantics by calling `findCandidatesByQuery({behavior: intent})` directly. | Single-API surface. Slight migration cost. | **Recommended.** |
| **B. Keep both APIs; document `findCandidatesByQuery` as the preferred path.** | No code change in B4 / hooks-base internals; only doc text. | Two APIs coexist — exactly the parallel-mechanism trap. | Reject. |
| **C. Aggressively delete `findCandidatesByIntent`.** | Mass-rename + remove. | Higher blast radius; out of scope for #523. | Defer to a follow-up WI. |

**Default decision:** Option A — migrate the four hot round-trip callers (hooks-base, B4 MCP, B7, smoke), mark `findCandidatesByIntent` `@deprecated` (no removal yet), and file a follow-up issue (`gh issue create`) tracking the full removal as a future WI.

---

## 4. Hook Awareness — The Value-Prop Slice (P2)

The operator was emphatic: hooks are the load-bearing consumers. The B4 numbers move when the LLM is taught the richer surface and uses it. This section is the most important code-effecting work in the plan.

### 4.1 `@yakcc/hooks-base` extension

**Current state** (`packages/hooks-base/src/index.ts`):
- `buildIntentCardQuery(ctx: EmissionContext): IntentCardQuery` returns `{ behavior, inputs: [], outputs: [] }` — empty inputs/outputs.
- `_executeRegistryQueryInternal` calls `registry.findCandidatesByIntent(query, ...)` — the asymmetric API.

**Target state (P1):**
- Add a new helper `buildQueryCardFromEmission(ctx: EmissionContext, originalCode?: string): QueryIntentCard` that (a) builds a `behavior` from `ctx.intent` + optional `ctx.sourceContext`, (b) when `originalCode` is non-empty, calls `queryIntentCardFromSource(originalCode)` and merges its `signature` / `errorConditions` into the result (the explicit `behavior` from `ctx.intent` wins over the JSDoc-derived one — the agent's natural-language intent is the canonical query text, the helper supplies the structural fields).
- `executeRegistryQueryWithSubstitution` accepts `originalCode` (already does, for substitution + atomize). The internal path threads `originalCode` into the new query-card builder. Net effect: a hook call that already has the agent's emitted code uses it to enrich the query, transparently.
- `_executeRegistryQueryInternal` calls `registry.findCandidatesByQuery(card, { k: 2, rerank: "structural" })` instead of `findCandidatesByIntent`. The candidate-conversion logic and threshold semantics are unchanged (candidates carry the same `block` + `cosineDistance` shape from `findCandidatesByQuery`'s `QueryResult.candidates`).
- `findCandidatesByIntent` continues to exist (OD-4 Option A); hooks-base no longer uses it. The two other prod consumers — `packages/cli/src/commands/query.ts` and `packages/hooks-claude-code/src/index.ts` README/docs only — are not in this WI's scope but become deprecation follow-ups.

### 4.2 MCP atom-lookup tool — schema + prompt

**File:** `bench/B4-tokens/harness/mcp-server.mjs`

**Schema change (OD-3 default = rename intent → behavior, add full surface):**

```js
const ATOM_LOOKUP_TOOL = {
  name: TOOL_NAME,
  description:
    "Query the yakcc atom registry for candidates matching a behavioral query. " +
    "Pass `behavior` as a short natural-language description; optionally pass " +
    "`inputs` / `outputs` (parameter types you're targeting), `errorConditions`, " +
    "`guarantees`, and `nonFunctional` (e.g. {time:'O(n)', purity:'pure'}) to " +
    "narrow the match. Richer queries produce higher-confidence matches because " +
    "the registry indexes all of these dimensions. Returns { atoms: [] } when no " +
    "candidates clear the threshold; in that case, generate the implementation directly.",
  inputSchema: {
    type: "object",
    properties: {
      behavior: { type: "string", description: "Behavioral description (required)." },
      inputs:  { type: "array", items: { type: "object",
        properties: { name: {type:"string"}, type: {type:"string"} },
        required: ["type"] }, description: "Input parameter types (optional)." },
      outputs: { type: "array", items: { type: "object",
        properties: { name: {type:"string"}, type: {type:"string"} },
        required: ["type"] }, description: "Output parameter types (optional)." },
      guarantees:      { type: "array", items: { type: "string" }, description: "Guarantee descriptions (optional)." },
      errorConditions: { type: "array", items: { type: "string" }, description: "Error-condition descriptions (optional)." },
      nonFunctional: { type: "object", properties: {
        time: { type: "string" }, space: { type: "string" },
        purity: { type: "string", enum: ["pure","read","write","io"] },
        threadSafety: { type: "string", enum: ["safe","unsafe","sequential"] } },
        description: "Non-functional properties (optional)." },
      atom_grain: { /* unchanged */ },
      confidence_threshold: { /* unchanged */ },
      substitution_aggressiveness: { /* unchanged */ },
    },
    required: ["behavior"],
  },
};
```

**Backend change:** `atomLookup(input)` reads `input.behavior` (was `input.intent`), constructs a `QueryIntentCard` via the helper-compatible path:

```js
const queryCard = {
  behavior: input.behavior,
  ...(input.inputs ? { signature: { inputs: input.inputs, outputs: input.outputs ?? [] } } : {}),
  ...(input.outputs && !input.inputs ? { signature: { outputs: input.outputs } } : {}),
  ...(input.guarantees ? { guarantees: input.guarantees } : {}),
  ...(input.errorConditions ? { errorConditions: input.errorConditions } : {}),
  ...(input.nonFunctional ? { nonFunctional: input.nonFunctional } : {}),
  topK: DEFAULT_TOP_K * 5,
};
const queryResult = await reg.findCandidatesByQuery(queryCard);
const candidates = queryResult.candidates;
```

`findCandidatesByIntent` is gone from this file (OD-4).

### 4.3 B4 system prompt update (load-bearing for measurement)

**File:** `bench/B4-tokens/harness/run.mjs` PROMPT constants.

The current prompts teach: "call atom-lookup with an intent." The updated prompts MUST teach: "atom-lookup accepts `behavior` plus optional `inputs`/`outputs`/`errorConditions`/`guarantees`/`nonFunctional`. When you know the function signature you're targeting, **pass `inputs` and `outputs` to narrow the match**. When you know the error conditions you must handle, pass `errorConditions`. Richer queries produce more relevant atoms."

Concretely:
- Add a `prompt-variant=rich-api` row that contains the explicit teaching text above plus an example call:
  ```text
  Example: atom-lookup({ behavior: "compute median of numeric array",
                         inputs: [{type:"number[]"}], outputs: [{type:"number"}] })
  ```
- The H1 baseline / engaged / motivated variants are preserved unchanged so the existing matrix-1 numbers remain comparable.
- Document in the prompt-variant constant block that `rich-api` is the post-#523 default and that future variants build on it.

### 4.4 Why this matters for B4

The B4 phase-2 re-analysis showed: models invoke atom-lookup but the registry returns empty results, and the diagnosis points at retrieval-side mismatch (calibration was one cause; field coverage is the other). Teaching the LLM to pass `inputs/outputs/errorConditions` lets it produce queries that are vectorized against the same dimensions the store indexes — closing the field-coverage gap by **construction at the call site**, not just by helper-based reconstruction. B4 should observe a substitution-rate / match-confidence lift on the rich-api variant. **The acceptance metric is movement, not a specific number** — the plan's P4 phase captures before/after artifacts and the operator decides whether the lift justifies promoting `rich-api` to baseline.

---

## 5. Test-Infra Migration (P3)

### 5.1 `bench/v0-release-smoke/smoke.mjs`

- **Step 7** (seed query): the query has no source context. Keep as `findCandidatesByQuery({ behavior: "parse json int list", topK: 5 })`. Annotate the call site with a comment pointing at DEC-EMBED-QUERY-ENRICH-HELPER-001 §non-goals to record that this is intentionally behavior-only.
- **Step 8b** (`executeRegistryQueryWithSubstitution` of `arrayMedian`): the call already passes `originalCode` (the emitted fixture text). Once §4.1 lands, this call automatically enriches via the helper — **no smoke.mjs edit required**. The migration is transitive through `@yakcc/hooks-base`.
- **Step 9** (BMR-in-top-K assertion): today builds `{ behavior: "Compute the median ... NaN for empty arrays.", topK: 5 }`. Replace with:
  ```js
  const { queryIntentCardFromSource } = await import(pathToImportUrl(contractsDist));
  const flywheelCode = readFileSync(join(__dirname, "fixtures", "novel-glue.ts"), "utf8");
  const queryCard = { ...queryIntentCardFromSource(flywheelCode, { entryFunction: "arrayMedian" }), topK: 5 };
  const queryResult = await registry.findCandidatesByQuery(queryCard);
  ```
  Pass criterion (`bmrFound === true`) is unchanged.

### 5.2 `bench/B7-commit/harness/run.mjs:351-356` (novelty/collision slice)

Today: `{ behavior: entry.intent, topK: 1 }`. The B7 spec entries (`run-utility.mjs` source) carry both `entry.intent` (the JSDoc-derived text) and the raw source for each utility. Update to:
```js
const utilitySource = entry.source ?? readFileSync(entry.path, "utf8");
const queryCard = {
  ...queryIntentCardFromSource(utilitySource, { entryFunction: entry.symbolName }),
  topK: 1,
};
const queryResult = await noveltyRegistry.findCandidatesByQuery(queryCard);
```
If `entry.source` / `entry.path` is unavailable for a row, fall back to `{ behavior: entry.intent, topK: 1 }` and log a `[FALLBACK]` line — the collision slice's primary contract is "near-exact match" detection; behavior-only is acceptable for that contract.

### 5.3 `bench/B7-commit/harness/run-utility.mjs:145-169` (per-rep round-trip)

Today: `{ behavior: intent, topK: TOP_K }`. The rep harness has the emitted code in scope (`emittedCode` parameter). Update to:
```js
const queryCard = {
  ...queryIntentCardFromSource(emittedCode),  // entryFunction defaults to first exported decl
  topK: TOP_K,
};
const queryResult = await registry.findCandidatesByQuery(queryCard);
```
Pass criterion (`bmrInTopK`) is unchanged. **This is the slice that fixes the 22/32 failure.**

### 5.4 Other consumers (NOT migrated in this WI, follow-up tracked)

- `packages/cli/src/commands/query.ts` — CLI `yakcc query <free-text>` keeps fuzzy semantics; will migrate when OD-4 follow-up removes `findCandidatesByIntent`.
- `bench/B8-synthetic/hit-rate-simulator.mjs` — already uses `findCandidatesByQuery`; will benefit from the helper when its query construction migrates (out of #523 scope; track as follow-up).
- `packages/hooks-claude-code` / `packages/hooks-cursor` / `packages/hooks-codex` — wrap `@yakcc/hooks-base`; pick up the change transitively from P1.

---

## 6. Decision Log — `DEC-EMBED-QUERY-ENRICH-HELPER-001`

```
DEC-EMBED-QUERY-ENRICH-HELPER-001
title: Discovery queries enrich to match stored ContractSpec via a shared helper.
status: accepted (planner)
work_item: wi-fix-523-plan
closes: #523 (residual of #444; companion to #502)
cross_refs:
  - DEC-VECTOR-RETRIEVAL-002 (text-asymmetry origin)
  - DEC-V3-DISCOVERY-D2-001 (QueryIntentCard surface; this DEC builds on, does not modify)
  - DEC-V3-IMPL-QUERY-001 (canonicalizeQueryText; this DEC preserves projection rules)
  - DEC-V3-INITIATIVE-002 (multi-dim forward-compat preserved)
  - DEC-V3-DISCOVERY-CALIBRATION-FIX-002 (#500 distance→confidence; unchanged)
  - DEC-HOOK-PHASE-2-001 (substitution wrapper; richer query threads through)
  - DEC-HOOK-ATOM-CAPTURE-001 (atomize-on-emission; storeBlock side unchanged)
  - DEC-CONTINUOUS-SHAVE-022 (IntentCard schema; query-side helper produces a DIFFERENT shape — QueryIntentCard — but reuses the same source-extraction primitives)

rationale:
  The vector retrieval asymmetry that produced #444 / #502 / #523 is a
  field-coverage asymmetry: storeBlock embeds a full ContractSpec/SpecYak
  canonical JSON, while query call sites have historically embedded a
  one-key {behavior: <text>} projection. PR #524 made the canonicalization
  rule itself symmetric (canonicalizeQueryText), which left field coverage
  as the remaining axis.

  This DEC commits to closing the gap on the consumer (query) side, not the
  producer (store) side:

  (1) A single shared helper, queryIntentCardFromSource, lives in
      @yakcc/contracts and derives QueryIntentCard fields from TypeScript
      source via ts-morph + JSDoc. It uses the SAME extraction primitives
      as @yakcc/shave's static-extract / specFromIntent path (atomize). The
      primitive is moved into @yakcc/contracts and re-imported from shave
      so byte-identical extraction is structurally enforced (OD-2 Option A).

  (2) @yakcc/hooks-base threads the helper through
      executeRegistryQueryWithSubstitution (and friends). Hooks call
      findCandidatesByQuery with the enriched card. findCandidatesByIntent
      is deprecated for round-trip callers but kept for the open-ended
      free-text fuzzy case (OD-4 Option A).

  (3) The B4 MCP atom-lookup tool schema grows to accept the QueryIntentCard
      surface (behavior + signature.inputs/outputs + guarantees +
      errorConditions + nonFunctional). The B4 system prompt teaches the
      LLM to populate the richer fields when it knows them. This is the
      value-prop slice — it is the only path that can actually move B4
      numbers, because the LLM is the active query constructor at run
      time, not a post-hoc helper.

  (4) Existing round-trip test infra (v0-smoke Step 9, B7 commit
      round-trip + collision slices) migrates to the helper so their
      emitted-source → query → BMR-in-top-K assertions exercise the same
      enrichment path as production.

why not Option A (collapse store to behavior-only):
  Re-bootstrap cost; threshold re-calibration cost (DEC-V3-INITIATIVE-002
  already records the cost of this kind of move); destroys the structural
  signal D3 Stage 2 + multi-dim discriminator depend on; forecloses the
  multi-dim discovery story.

why one shared helper:
  Without it, every round-trip caller invents its own extraction. The same
  divergence that produced #444 between store and query would reappear
  BETWEEN callers within months. One helper, one DEC, one place to update
  when extraction improves.

non-goals (explicit):
  - No store-side changes. No edits to storeBlock embedding text.
  - No edits to canonicalizeQueryText projection rules.
  - No new fields on QueryIntentCard (DEC-V3-DISCOVERY-D2-001 surface is
    already complete; this WI populates more of it, not extends it).
  - No threshold re-calibration unless empirical data shows a shift; even
    then, scoped to the affected gate only.
  - Open-ended CLI free-text queries stay behavior-only — no source to
    enrich from.

residual asymmetry (accepted):
  The atomize path (specFromIntent) maps IntentCard → SpecYak and currently
  produces empty invariants/effects and forwards preconditions/postconditions
  via fields the QueryIntentCard surface doesn't expose. The query helper
  cannot derive what specFromIntent cannot derive. If a future enrichment
  pass on the atomize side starts populating (e.g.) nonFunctional.purity from
  a static-analysis pass, the helper MUST be extended in lockstep — this is
  what the shared-primitive constraint (OD-2 Option A) enforces.
```

---

## 7. Implementation Phases — per-slice Scope Manifest + Evaluation Contract

Each phase below is a separate provisionable WI. The orchestrator dispatches them sequentially (P0 → P4) under this plan's umbrella; only one is in flight at a time.

### P0 — Shared helper landing in `@yakcc/contracts`

**Scope Manifest**
- Allowed: `packages/contracts/src/query-from-source.ts` (new), `packages/contracts/src/query-from-source.test.ts` (new), `packages/contracts/src/query-from-source.props.ts` + `.props.test.ts` (new), `packages/contracts/src/source-extract.ts` (new — see OD-2), `packages/contracts/src/source-extract.test.ts` (new), `packages/contracts/src/index.ts` (re-export the new helper + types), `packages/contracts/package.json` (no dep changes expected — ts-morph already present), `packages/shave/src/intent/static-extract.ts` (refactor to re-import primitives from contracts; SAME public function name + signature; SAME test results).
- Required: at least `packages/contracts/src/query-from-source.ts` + tests; `packages/contracts/src/index.ts` re-export.
- Forbidden: `packages/registry/**`, `packages/hooks-base/**`, `bench/**`, `MASTER_PLAN.md`, `examples/**`. The `specFromIntent` mapping must not be modified.
- State authorities touched: source-extraction primitive (moved within `@yakcc/contracts` boundary).

**Evaluation Contract**
- **Required tests:**
  - new `query-from-source.test.ts` — at least 6 cases: (a) JSDoc summary → `behavior`; (b) signature with named params → `signature.inputs` matches `extractParams` output exactly; (c) return type → `signature.outputs[0].type`; (d) `entryFunction` option picks the named export over the first export; (e) source with no exports throws TypeError (matches `staticExtract` fallback path); (f) `@throws` JSDoc tag → `errorConditions` entry.
  - existing `packages/shave/src/intent/static-extract.test.ts`, `.props.test.ts`, `.integration.test.ts` — **MUST CONTINUE TO PASS UNCHANGED** after the primitive move (this is the structural guarantee that the move is behavior-preserving).
  - new property test in `query-from-source.props.test.ts`: for any source that `staticExtract` accepts, `queryIntentCardFromSource(source).behavior` equals `staticExtract(source, envelope).behavior` and `signature.inputs.map(p=>p.type)` equals `staticExtract(source, envelope).inputs.map(p=>p.typeHint)` (cross-checks the extraction-equality invariant).
- **Required real-path checks:** `pnpm -F @yakcc/contracts test` AND `pnpm -F @yakcc/shave test` both green in the worktree.
- **Required authority invariants:** `canonicalizeQueryText` projection unmodified; `QueryIntentCard` schema unmodified; `specFromIntent` unmodified.
- **Required integration points:** `packages/contracts/src/index.ts` re-export; `packages/shave/src/intent/static-extract.ts` re-imports primitives — no public-API change in shave.
- **Forbidden shortcuts:** (a) duplicating extraction code in contracts instead of moving it from shave; (b) modifying `canonicalizeQueryText`; (c) adding fields to `QueryIntentCard`; (d) modifying `specFromIntent`; (e) any edit outside the allowed paths.
- **Ready for guardian when:** Both test suites green; coverage of the new helper ≥ existing static-extract coverage; helper exported and re-importable from `@yakcc/contracts`; no diff in any forbidden file.

**Rollback boundary:** `git revert <P0-commit>` restores both contracts and shave to pre-P0 state in one move.

---

### P1 — `@yakcc/hooks-base` migration to enriched queries

**Scope Manifest**
- Allowed: `packages/hooks-base/src/index.ts`, `packages/hooks-base/src/index.props.ts`, `packages/hooks-base/test/**` (existing), new tests as needed.
- Required: `packages/hooks-base/src/index.ts` updated to (a) add `buildQueryCardFromEmission(ctx, originalCode?)`, (b) thread `originalCode` into the internal query-card construction, (c) replace `findCandidatesByIntent` call with `findCandidatesByQuery`.
- Forbidden: any change in `packages/registry/**` (the API is already there), `packages/contracts/**`, `bench/**`, `packages/cli/**`, `packages/hooks-claude-code/**` (transitive consumer; should not need source edits), `packages/hooks-cursor/**`, `packages/hooks-codex/**`.
- State authorities touched: hook query construction.

**Evaluation Contract**
- **Required tests:**
  - existing `packages/hooks-base/test/**` and all property tests pass unchanged.
  - new test cases (in existing test files): (a) `buildQueryCardFromEmission` with no `originalCode` returns `{behavior, topK: 2}`-shaped card; (b) same with `originalCode` returns a card whose `signature` matches `queryIntentCardFromSource(originalCode).signature`; (c) `_executeRegistryQueryInternal` calls `registry.findCandidatesByQuery` (mock asserts) and not `findCandidatesByIntent`.
  - existing `packages/hooks-claude-code/test/**`, `packages/hooks-cursor/test/**`, `packages/hooks-codex/test/**` pass unchanged (transitive consumers).
- **Required real-path checks:** `pnpm -F @yakcc/hooks-base test`; `pnpm -F @yakcc/hooks-claude-code test`; `pnpm build --filter @yakcc/hooks-base` succeeds.
- **Required authority invariants:** `HookResponse` / `HookResponseWithSubstitution` shape unchanged; threshold / `HOOK_LATENCY_BUDGET_MS` constants unchanged; atomize fall-through path unchanged; telemetry event shape unchanged.
- **Required integration points:** import `queryIntentCardFromSource` from `@yakcc/contracts`; call `registry.findCandidatesByQuery` (existing `Registry` interface method).
- **Forbidden shortcuts:** (a) inlining the source-to-card extraction instead of using the helper; (b) bumping the threshold "to compensate"; (c) modifying the `Registry` interface; (d) adding a new wrapper that bypasses the helper.
- **Ready for guardian when:** All hooks-base + claude-code + cursor + codex tests green; build clean; mock-based assertion proves `findCandidatesByQuery` is the path taken.

---

### P2 — B4 MCP tool schema + system prompt update (value-prop)

**Scope Manifest**
- Allowed: `bench/B4-tokens/harness/mcp-server.mjs`, `bench/B4-tokens/harness/run.mjs`, `bench/B4-tokens/harness/*.test.mjs` (if present), `bench/B4-tokens/tasks.json` (only if a SHA-256 drift forces regen — the prompt files are content-hash-pinned).
- Required: `mcp-server.mjs` (schema + backend); `run.mjs` (prompt-variant addition + tool-input construction at call sites).
- Forbidden: any change outside `bench/B4-tokens/**`; any change in `packages/**`.
- State authorities touched: MCP tool schema, B4 prompt-variant text, B4 tool-input construction.

**Evaluation Contract**
- **Required tests:**
  - a smoke run of the B4 harness against the existing fixture set with the new `rich-api` prompt variant on at least one model produces a JSON-RPC trace where ≥ 1 tool call carries `inputs` and/or `outputs` populated. This is the proof that the prompt teaches the surface and the LLM uses it.
  - the existing matrix-1 baseline variants still parse and produce non-empty `atoms[]` results on at least one fixture (regression guard).
- **Required real-path checks:** start `mcp-server.mjs`, send a `tools/call` for `atom-lookup` with `{behavior, inputs: [{type:"number[]"}], outputs: [{type:"number"}]}` — confirm the server constructs the right `findCandidatesByQuery` arg and returns a non-empty `atoms` array against a seeded registry. Save the trace under `tmp/wi-fix-523-evidence/p2-trace.jsonl`.
- **Required authority invariants:** confidence-threshold semantics (default 0.7) unchanged; L²→confidence formula unchanged (`DEC-V3-DISCOVERY-CALIBRATION-FIX-002`); the existing baseline / engaged / motivated prompt variants are byte-identical to pre-P2 (only the new `rich-api` variant is added).
- **Required integration points:** server reads `behavior` (not `intent`); server calls `findCandidatesByQuery`; prompt text teaches the richer surface with at least one worked example.
- **Forbidden shortcuts:** (a) silently mapping `intent` to `behavior` without renaming the field (drift); (b) keeping `findCandidatesByIntent` in this file; (c) editing the existing prompt variants' text; (d) lowering the confidence threshold to manufacture more hits.
- **Ready for guardian when:** MCP smoke trace recorded; existing variants regression-clean; new variant produces a populated tool-input on at least one model.

**Note:** the model-output comparison (rich-api vs baseline matrix-1) is the **P4** evidence collection step. P2 only needs to demonstrate the schema and prompt are wired correctly.

---

### P3 — v0-smoke + B7 round-trip migration

**Scope Manifest**
- Allowed: `bench/v0-release-smoke/smoke.mjs`, `bench/B7-commit/harness/run.mjs`, `bench/B7-commit/harness/run-utility.mjs`.
- Required: smoke.mjs Step 9 migration; B7 run.mjs collision-slice migration; B7 run-utility.mjs per-rep round-trip migration. Step 7 stays behavior-only with a clarifying comment.
- Forbidden: any change outside the three files above; any change in `packages/**`; any threshold edit.
- State authorities touched: bench test-infra query construction.

**Evaluation Contract**
- **Required tests / real-path checks:**
  - `pnpm -F @yakcc/v0-smoke smoke` (or the canonical smoke invocation) — Step 9 PASS with `bmrFound = true` deterministic across 3 reruns. Save the smoke transcript under `tmp/wi-fix-523-evidence/p3-smoke.txt`.
  - `pnpm -F @yakcc/b7 run` (or canonical B7 invocation) — round-trip slice reports 0 BMR-not-in-top-K failures (was 22/32); novelty/collision slice reports the same collision counts as the pre-P3 baseline (or fewer, if the enriched query is more discriminating; document either outcome). Save the B7 metrics JSON under `tmp/wi-fix-523-evidence/p3-b7.json`.
  - Step 7 still passes (seed query is unchanged in shape, just commented).
- **Required authority invariants:** `NOVELTY_COLLISION_THRESHOLD` and `CONFIDENT_THRESHOLD` unchanged; pass criteria unchanged (only the query construction changes); fixtures unchanged.
- **Required integration points:** all three files import `queryIntentCardFromSource` from `@yakcc/contracts` (`packages/contracts/dist/index.js` after build).
- **Forbidden shortcuts:** (a) calling the static extractor directly instead of the helper; (b) duplicating the source→card logic; (c) loosening any threshold; (d) editing fixture source; (e) editing pass criteria.
- **Ready for guardian when:** smoke transcript + B7 metrics show the round-trip slices green; thresholds unmoved; transcripts captured under `tmp/wi-fix-523-evidence/`.

---

### P4 — Capture before/after evidence; commit baselines

**Scope Manifest**
- Allowed: `tmp/wi-fix-523-evidence/**` (artifacts directory — out of the worktree-allowed paths is `plans/**` and `tmp/wi-fix-523-evidence/**`, both already permitted); `plans/wi-fix-523-query-enrich-helper.md` (this plan; appendix updates only — Identity / Architecture / Principles sections are immutable).
- Required: re-run B4 matrix on at least the rich-api variant + the matrix-1 baseline variant for one model; capture token / substitution-rate / match-confidence summary. Re-run v0-smoke and B7 to record post-P3 baselines.
- Forbidden: any code edit in `packages/**` or `bench/**`; any prompt edit in B4 (P2 owns prompts).
- State authorities touched: none (evidence only).

**Evaluation Contract**
- **Required evidence:** `tmp/wi-fix-523-evidence/p4-b4-comparison.md`, `…/p4-smoke-final.txt`, `…/p4-b7-final.json`, and a `…/p4-summary.md` that names the residual risks and confirms the plan's desired-end-state checks (Step 9 PASS, B7 0/N acceptance violations, B4 rich-api movement).
- **Required real-path checks:** each artifact is reproducible from the documented invocation (recorded in `…/p4-summary.md`).
- **Forbidden shortcuts:** (a) reporting a B4 lift without the trace + tokens-per-task accounting; (b) declaring success based on a single rep; (c) cherry-picking variants.
- **Ready for guardian when:** all four evidence artifacts written; summary names any threshold movement (expected: none) and any unexplained residual gap (expected: open-ended-CLI behavior-only, which is intentional).

**This phase produces the close-out artifact for #523.** After Guardian lands P4, the orchestrator may close #523 with a comment linking to `tmp/wi-fix-523-evidence/p4-summary.md`.

---

## 8. Dependency Graph and Order of Operations

```
P0  ── shared helper + extraction-primitive factoring
 │
 ├─► P1  ── hooks-base migration  (parallel-safe with P2)
 ├─► P2  ── B4 schema + prompt    (parallel-safe with P1)
 │
 P1, P2 ──► P3  ── smoke + B7 migration  (depends on P1's findCandidatesByQuery path being in place)
 │
 P3 ──► P4  ── evidence + close-out
```

- **P0 must land first.** It exports the helper everyone else imports.
- **P1 and P2 are parallel-safe** — different files, no shared mutation, and each has an independent test surface. Different implementers may pick them up concurrently if implementer pool allows.
- **P3 depends on P1** (the smoke Step 8b enrichment is transitive through hooks-base) and on P0 (it imports the helper directly for Step 9 and B7).
- **P4 depends on all three** (P1, P2, P3) — it measures their combined effect.
- **Gating signals between phases:** each phase's "ready for guardian" criterion is the gate. The orchestrator dispatches the next phase only after Guardian lands the previous one.

---

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **R1. Extraction-asymmetry residual.** The atomize-side `specFromIntent` may in the future synthesize fields (e.g., `nonFunctional.purity` from an inferred-purity pass) that the query helper cannot derive. The #523 asymmetry returns on those fields. | Medium (future enrichment is on the roadmap) | High (re-opens #444 class) | The shared-primitive constraint (OD-2 Option A) makes this **structurally** harder: any new extraction pass added to atomize must be added to the primitive in `@yakcc/contracts` and picked up by both sides. P0's property test enforces extraction-equality. Document in `DEC-EMBED-QUERY-ENRICH-HELPER-001` §residual. |
| **R2. B4 prompt taught the surface but the LLM doesn't use it.** Models may ignore the richer fields, yielding no B4 movement. | Medium | Medium (no harm; just no value-prop signal) | P2 acceptance requires a trace showing ≥1 tool call with `inputs`/`outputs` populated. P4 captures aggregate population rate. If <5%, file a follow-up to investigate prompt engineering (out of scope for #523). |
| **R3. Per-call-site forgetting.** Future contributors writing a new round-trip caller may bypass the helper and re-derive the card inline. | Medium (depends on culture) | High (reintroduces drift) | (a) JSDoc on `Registry.findCandidatesByQuery` referencing the helper as the canonical caller path; (b) optional lint rule (biome) flagging direct `{behavior:` literals passed to `findCandidatesByQuery` outside a small allowlist; (c) the DEC. |
| **R4. Free-text CLI / chat queries stay fuzzy.** Open-ended `yakcc query "<text>"` and the prompt-driven chat path have no source to enrich from; they remain on behavior-only. | Certain | None | Documented as intentional in DEC §non-goals and §10. |
| **R5. Empirical scores shift outside the threshold band.** If the enriched queries dramatically raise confidence scores, the existing `0.7` / `0.85` thresholds may need adjustment to avoid false positives. | Low–Medium | Medium | P4 records the score distribution. If shift > 0.05 on the matched cases, file a follow-up WI for re-calibration (with scope limited to affected gates — DEC-V3-DISCOVERY-CALIBRATION-FIX-002 stays intact). |
| **R6. ts-morph version drift between contracts (28) and compile (24).** | Low | Low | Out of scope for #523; the helper uses contracts' `^28.0.0` which is the newer pin. File a follow-up for the `@yakcc/compile` upgrade. |
| **R7. Build-graph order: bench scripts import contracts dist.** | Low | Low | Bench scripts already do this for `canonicalize*` helpers (see smoke.mjs Step 8b imports). No new build-order constraint. Document the `pnpm build --filter @yakcc/contracts` precondition in P3's runbook section of `tmp/wi-fix-523-evidence/p3-runbook.md`. |
| **R8. Step 7 stays behavior-only and someone "fixes" it later by adding fake source context.** | Low | Low | The clarifying comment in smoke.mjs Step 7 + a paragraph in DEC §non-goals. |

---

## 10. Operator Decision Boundaries

This plan proposes a sensible default for each. Planner returns `next_work_item` (not `needs_user_decision`) — none of these hard-block. If the operator wants to override any default before dispatch, they can steer at the P0 provisioning stage.

| # | Question | Default | Cost-to-change |
|---|---|---|---|
| OD-1 | Helper home package | `@yakcc/contracts` | Low — moving the helper later is a one-PR mechanical change. |
| OD-2 | Extraction primitive ownership | Move into `@yakcc/contracts`; shave re-imports | Medium — re-factoring later costs the same amount of work but with more deployed callers. |
| OD-3 | atom-lookup `intent` → `behavior` rename | Rename + add full surface | Low — the B4 matrix is a measurement harness; renaming costs one round of variant regeneration. |
| OD-4 | `findCandidatesByIntent` removal | Migrate round-trip callers; deprecate (don't remove); file follow-up | Low — a future WI handles full removal once CLI / chat migrate to a fuzzy-by-construction surface. |

---

## 11. Out of Scope (Explicit)

- Store-side changes (no `storeBlock` edits; no spec schema bump; no re-bootstrap).
- `canonicalizeQueryText` projection rule changes (DEC-V3-IMPL-QUERY-001 preserved).
- `QueryIntentCard` schema additions (DEC-V3-DISCOVERY-D2-001 surface already complete).
- Threshold re-calibration — out of scope unless P4 evidence forces it; if forced, scope-limited follow-up WI.
- Open-ended CLI `yakcc query "<free text>"` migration — stays fuzzy by design.
- `findCandidatesByIntent` removal across non-round-trip callers — follow-up WI.
- B4 prompt-engineering optimization beyond the `rich-api` variant.
- `@yakcc/compile` ts-morph version bump.
- Multi-dimensional weighting tuning (`QueryIntentCard.weights`) — D3 work, not #523.

---

## 12. Cross-References (Issues, PRs, DECs)

**Issues:** #444 (origin), #502 (B7 22/32 failure), #523 (residual; this plan closes it).
**PRs:** #285 (early symmetric-API attempt), #524 (canonicalizeQueryText wiring — predecessor).
**DECs:** `DEC-VECTOR-RETRIEVAL-002`, `DEC-V3-DISCOVERY-D2-001`, `DEC-V3-IMPL-QUERY-001`, `DEC-V3-INITIATIVE-002`, `DEC-V3-DISCOVERY-CALIBRATION-FIX-002` (#500), `DEC-HOOK-PHASE-2-001`, `DEC-HOOK-ATOM-CAPTURE-001`, `DEC-CONTINUOUS-SHAVE-022`, `DEC-EMBED-QUERY-ENRICH-HELPER-001` (new — recorded in §6 above; lands in MASTER_PLAN.md Decision Log at P4 close-out).

---

## 13. Planner Trailer

PLAN_VERDICT: next_work_item
PLAN_SUMMARY: Option C plan written: shared `queryIntentCardFromSource` helper in `@yakcc/contracts` (P0) with extraction primitive moved from `@yakcc/shave`, then hooks-base migration to `findCandidatesByQuery` with enriched cards (P1), then B4 MCP schema rename + prompt teaching the richer surface (P2 — the value-prop slice), then smoke Step 9 + B7 round-trip migration (P3), then before/after evidence capture and #523 close-out (P4). No store-side changes; no threshold edits; OD-1..OD-4 have sensible defaults proposed and do not hard-block. Next action: provision P0 (helper landing in `@yakcc/contracts`).
