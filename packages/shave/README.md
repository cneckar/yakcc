# @yakcc/shave

The universalizer pipeline: decompose a permissively-licensed TypeScript/JavaScript
source file into content-addressed registry atoms.

## What this package provides

The pipeline runs in five stages for each candidate block:

1. **License gate** (`licenseGate` + `detectLicense`) — cheap, pure, fail-fast.
   Copyleft or refused-license source is rejected before any I/O or API calls.
   The license check is local; federation peers never see refused source.
2. **Intent extraction** (`extractIntent`, internal) — extracts a behavioral
   `IntentCard` describing inputs, outputs, and behavior. Default strategy is
   `"static"` (TypeScript Compiler API + JSDoc parser, no API key required,
   fully offline). The `"llm"` strategy is available for AI-derived corpus
   fallback (WI-016) but is not the default.
3. **Decomposition** (`decompose`) — recursively reduces the source AST into a
   `RecursionTree` of `AtomLeaf` (irreducible) and `BranchNode` (compound)
   nodes, using the registry's `findByCanonicalAstHash` to detect known
   primitives.
4. **Slicing** (`slice`) — converts the `RecursionTree` into a flat `SlicePlan`:
   a sequence of `NovelGlueEntry` (new atoms to register) and `PointerEntry`
   (existing registry blocks) in DFS order (leaves before root).
5. **Persist** (`maybePersistNovelGlueAtom`, internal) — `shave()` walks the
   `SlicePlan` sequentially, persisting novel atoms and threading
   `parent_block_root` lineage (WI-017, `DEC-REGISTRY-PARENT-BLOCK-004`).

## Public API

### Top-level entry points

| Export | Description |
|--------|-------------|
| `shave(sourcePath, registry, options?)` | One-shot file ingestion. Reads `sourcePath`, wraps it as a `CandidateBlock`, runs the full pipeline, and returns a `ShaveResult` with per-atom stubs and intent cards. |
| `universalize(candidate, registry, options?)` | Single-block pipeline. Takes a `CandidateBlock` in memory, runs license gate → intent extraction → decompose → slice, and returns a `UniversalizeResult`. `shave()` delegates to this. |
| `createIntentExtractionHook(options?)` | Factory for an `IntentExtractionHook` whose `intercept` method delegates to `universalize()`. Used by hook integrations. |

### Decomposition

| Export | Description |
|--------|-------------|
| `decompose(source, registry, options?)` | Recursively reduce source text into a `RecursionTree`. Throws `DidNotReachAtomError` or `RecursionDepthExceededError` on failure. |
| `isAtom(source, options?)` | Predicate — returns `AtomTestResult` indicating whether `source` is irreducible under the atom test rules. |
| `DidNotReachAtomError` | Thrown when decomposition cannot reach atomic leaves. |
| `RecursionDepthExceededError` | Thrown when the source AST exceeds `maxDepth`. |

### Slicing

| Export | Description |
|--------|-------------|
| `slice(tree, registry)` | Convert a `RecursionTree` into a `SlicePlan`. |

### License gate

| Export | Description |
|--------|-------------|
| `detectLicense(source)` | Scan source text for a license declaration. Returns a `LicenseDetection`. |
| `licenseGate(detection)` | Apply the license policy. Returns `LicenseGateResult` with `accepted: boolean`. |
| `LicenseRefusedError` | Thrown by `universalize()` when the license gate rejects source. Carries the `LicenseDetection`. |

### Property-test corpus (WI-016)

| Export | Description |
|--------|-------------|
| `extractCorpus(options?)` | Primary API for property-test corpus extraction. Implements a three-source priority chain: upstream-test > documented-usage > AI-derived (cache-only offline). Returns a `CorpusResult`. |
| `seedCorpusCache(spec, corpus)` | Test-helper: pre-populate the AI-derived corpus cache for offline tests. |
| `CORPUS_SCHEMA_VERSION` | Cache-keying constant for the corpus schema. |
| `CORPUS_DEFAULT_MODEL` | Default Anthropic model tag used for AI-derived corpus. |
| `CORPUS_PROMPT_VERSION` | Prompt version tag for corpus extraction. |

### Offline test helpers (WI-018)

| Export | Description |
|--------|-------------|
| `seedIntentCache(spec, card)` | Write an `IntentCard` into the file-system intent cache under the exact key that `extractIntent()` would produce for the same inputs. Test-only — do not call from production code. |
| `SeedIntentSpec` | Input type for `seedIntentCache`. Fields: `source`, `cacheDir`, optional `model`, `promptVersion`, `strategy`. |
| `validateIntentCard(card)` | Validate an externally-received `IntentCard` against the current schema. |
| `sourceHash(source)` | Compute the BLAKE3 hash of normalized source text (the first component of the intent cache key). Exported so external tests can populate `IntentCard.sourceHash` without cross-package relative imports. |

### Error classes

| Export | Description |
|--------|-------------|
| `AnthropicApiKeyMissingError` | Thrown by `universalize()` when `ANTHROPIC_API_KEY` is absent and the `"llm"` strategy is active without a cache hit. |
| `IntentCardSchemaError` | Thrown when a received `IntentCard` fails schema validation. |
| `LicenseRefusedError` | Thrown when the license gate rejects source. |
| `OfflineCacheMissError` | Thrown when `offline: true` is set and no cache entry exists for the requested source. |

### Version constants

| Export | Description |
|--------|-------------|
| `DEFAULT_MODEL` | Default Anthropic model tag for LLM intent extraction. |
| `INTENT_PROMPT_VERSION` | Prompt version tag for LLM intent extraction. |
| `INTENT_SCHEMA_VERSION` | Schema version for intent cache keying. |
| `STATIC_MODEL_TAG` | Model tag used when `strategy: "static"`. |
| `STATIC_PROMPT_VERSION` | Prompt version tag used when `strategy: "static"`. |

### Public types

`ShaveResult`, `ShaveOptions`, `ShaveRegistryView`, `ShaveDiagnostics`,
`ShavedAtomStub`, `CandidateBlock`, `UniversalizeResult`, `UniversalizeSlicePlanEntry`,
`IntentCard`, `IntentParam`, `AtomTestOptions`, `AtomTestResult`, `AtomTestReason`,
`RecursionNode`, `AtomLeaf`, `BranchNode`, `RecursionTree`, `RecursionOptions`,
`SlicePlan`, `SlicePlanEntry`, `PointerEntry`, `NovelGlueEntry`,
`AcceptedLicense`, `LicenseDetection`, `LicenseGateResult`,
`CorpusResult`, `CorpusSource`, `CorpusAtomSpec`, `CorpusExtractionOptions`.

## The `intentStrategy` axis

`ShaveOptions.intentStrategy` controls the intent extraction backend:

- `"static"` (default since WI-023, `DEC-INTENT-STRATEGY-001`): uses the
  TypeScript Compiler API and JSDoc parser. No `ANTHROPIC_API_KEY` required.
  Fully offline and deterministic. The static path uses `STATIC_MODEL_TAG` and
  `STATIC_PROMPT_VERSION` for cache keying so static and LLM cache entries never
  collide.
- `"llm"`: uses the Anthropic API (Claude) to derive behavioral `IntentCard`
  fields. Requires `ANTHROPIC_API_KEY` or a pre-seeded cache entry. Preserved for
  WI-016's AI-derived property-test corpus fallback.

`seedIntentCache` accepts a `strategy` field so tests can pre-seed the correct
cache slot for whichever strategy their test exercises.

## Multi-leaf wiring (WI-031)

`universalize()` now calls `extractIntent` per `NovelGlueEntry` in multi-leaf
slice plans, producing a semantically faithful `intentCard` on each novel atom
(`DEC-UNIVERSALIZE-MULTI-LEAF-INTENT-001`). The static path makes per-leaf calls
cheap (no API, no network). `shave()`'s postorder lineage-threading loop then
persists each atom with the correct `parent_block_root` derived from the
immediately preceding novel-glue entry's merkle root.

## Offline-tolerance contract

The complete pipeline (`shave`, `universalize`, `decompose`, `slice`,
`extractCorpus`) works without `ANTHROPIC_API_KEY` when either:
- `strategy: "static"` is active (the default), OR
- `offline: true` is set and the intent cache is pre-populated via
  `seedIntentCache`.

Tests use `openRegistry(":memory:")` for real SQLite persistence and
`seedIntentCache` for offline determinism. This discipline is enforced at every
test boundary — no test calls a live API.

## License gate locality

The license gate (`licenseGate(detectLicense(source))`) runs as the first step in
`universalize()`, before any I/O or API calls. A single check on the full source
string covers all decomposed leaves because every leaf derives from the same
source text. Refused source is never stored in the registry and is never transmitted
to federation peers.

## Example

```ts
import { shave, seedIntentCache } from "@yakcc/shave";
import { openRegistry } from "@yakcc/registry";

const registry = await openRegistry(".yakcc/registry.db");

// Pre-seed intent cache for offline testing (test environments only)
// await seedIntentCache({ source, cacheDir: ".yakcc/shave-cache/intent", strategy: "static" }, card);

const result = await shave("src/parse-int.ts", registry, {
  intentStrategy: "static", // default — no API key required
  offline: false,
});

console.log(`atoms: ${result.atoms.length}`);
for (const atom of result.atoms) {
  console.log(atom.placeholderId, atom.merkleRoot);
}

await registry.close();
```

## Cross-references

- `@yakcc/registry` — `ShaveRegistryView` is a structural subset of `Registry`
- `@yakcc/contracts` — `BlockMerkleRoot`, `SpecHash`, `CanonicalAstHash`
- `DEC-CONTINUOUS-SHAVE-022` — public API entry-point design decisions
- `DEC-INTENT-STRATEGY-001` — static vs LLM strategy axis
- `DEC-UNIVERSALIZE-MULTI-LEAF-INTENT-001` — per-leaf extractIntent for multi-leaf trees (WI-031)
- `DEC-REGISTRY-PARENT-BLOCK-004` — postorder lineage threading in `shave()`
- `DEC-SHAVE-SEED-001` — `seedIntentCache` design constraints

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
