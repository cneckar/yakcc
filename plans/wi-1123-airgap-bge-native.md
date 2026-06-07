# WI-1123 — B6a air-gap regression: complete bge-native fix (zero outbound)

Workflow: `1123-airgap-seed` · Issue #1123 · Branch `feature/1123-airgap-fix2`
Direction A (bge-native air-gap) — the decided #1017/#1031 direction.

## Problem statement

B6a (`bench/B6-airgap/run.mjs`) is RED on main and blocks every PR. The
benchmark asserts **zero outbound network connections** during a 7-step
air-gapped yakcc workflow; any non-zero count is an immediate KILL.

A prior selection-only fix (#1124 attempt) made all 7 steps pass locally but
produced **12 outbound connections to huggingface.co in CI**: with bge-small as
the embedding provider, the air-gap flow loads the bge ONNX model, and in CI
that model is **not cached**, so `@xenova/transformers` silently fetches it from
HuggingFace. The offline guarantee (`env.allowRemoteModels = false`) exists on
the MCP resolve path but is **missing from the shared embedder**.

Cost: every PR is blocked behind a red required check. Frequency: continuous.

## Root-cause map (three layers, all verified in-tree)

**Layer 1 — provider mismatch on the bootstrap read (the seed failure).**
- Committed bootstrap `bootstrap/yakcc.registry.sqlite` stores
  `registry_meta.embedding_model_id = 'Xenova/bge-small-en-v1.5'`,
  `embedding_dimension = 384`, with `contract_embeddings` populated
  (embCount > 0). Verified by direct sqlite read. This is the #1017 state.
- `seedYakccCorpus` (`packages/cli/src/commands/seed-yakcc.ts:182`) opens that
  bootstrap with `makeZeroEmbeddingProvider()` (modelId `bootstrap/null-zero`).
  The doc comment there is **stale** — it predates #1017 when the bootstrap was
  null-zero.
- `openRegistry` (`packages/registry/src/storage.ts:2342`) runs the
  `DEC-EMBED-REGISTRY-META-001/002` guard: storedModelId
  (`Xenova/bge-small-en-v1.5`) != provider.modelId (`bootstrap/null-zero`),
  embCount > 0, callerSetExplicitProvider == true → **throws
  `embedding_model_mismatch`**. That is the seed-path failure.
- Fix: open the bootstrap with a provider whose `modelId` is
  `Xenova/bge-small-en-v1.5` (the real local bge provider), so the guard passes.
  Keep null-zero ONLY for `:memory:`/verify paths where no real embeddings are
  read.

**Layer 2 — the missing offline pin (the 12 outbound).**
- `packages/contracts/src/embeddings.ts` `makePipelineLoader` does a bare
  `import("@xenova/transformers").then(mod => mod.pipeline(...))` with **no
  `env.*` configuration**. There is no `allowRemoteModels` pin anywhere in the
  shared embedder. (`grep` confirms the only `allowRemoteModels = false` in the
  repo is `packages/mcp-registry/src/tools/resolve.ts:1145`,
  `DEC-MCP-RESOLVE-OFFLINE-GUARANTEE-001`.)
- The resolve path pins **unconditionally** because the MCP server is
  offline-by-design. The shared embedder is used by both online dev (legitimate
  first-run fetch) and air-gap, so it needs a **conditional** pin.

**Layer 3 — cold model cache in CI (why the fetch happens at all).**
- transformers.js v2.17.2 defaults `env.cacheDir` to
  `<install_dir>/.cache/` — for pnpm that is
  `node_modules/.pnpm/@xenova+transformers@2.17.2/node_modules/@xenova/transformers/.cache/`.
  Verified locally: `env.cacheDir` resolves there and `bge-small-en-v1.5/onnx/model_quantized.onnx`
  is present (that is why local B6a passes — warm cache).
- B6a spawns CLI children via `process.execPath`; with pnpm dedup all children
  resolve the **same** `@xenova/transformers` install → **same `cacheDir`**.
  So a warm performed once by the harness process is visible to every child.
- In CI the cache is **cold** → uncached → fetch. The bge model is **not
  vendored/committed** anywhere (`git ls-files` shows no `*.onnx`,
  no `bge-small`), so it is always downloaded on a fresh machine.

## Goals (measurable)

1. B6a passes in CI: 7/7 steps green, **zero** intercepted outbound
   connections.
2. The bge model is **not fetched** during the monitored region — proven two
   ways: (a) the conditional pin makes a cache miss throw LOUD rather than
   download; (b) the harness warms the cache before interception so the steps
   succeed offline.
3. The conditional pin does **not** break normal dev/online first-run (which
   legitimately downloads bge on first use).
4. Full workspace `pnpm -r build` + lint + typecheck green; whole fix lands in
   **one** PR.

## Non-goals

- Re-embedding or regenerating the committed bootstrap (`bootstrap/**`
   forbidden — it is already bge-small; nothing to change). Rationale: DEC #1017
   already committed the bge-embedded corpus.
- Touching the registry mismatch guard (`packages/registry/**` forbidden).
   Rationale: the guard is correct; the bug is the caller passing the wrong
   provider, not the guard.
- Vendoring the ONNX model into git. Rationale: ~25 MB binary in git is a
   separate decision (#361 binary-distribution follow-up); out of scope here.
- Changing the MCP resolve unconditional pin
   (`packages/mcp-registry/src/tools/resolve.ts` forbidden). We mirror its
   pattern behind a conditional seam in the shared embedder; we do not move or
   weaken it.

## Decisions

### DEC-1123-CONDITIONAL-OFFLINE-PIN-001 — conditional `allowRemoteModels=false` in the shared embedder
The load-bearing decision. `createLocalEmbeddingProvider` must pin
`@xenova/transformers` `env.allowRemoteModels = false` (and assert
`env.allowLocalModels = true`) **only in air-gap/offline mode**, never globally.

**Trigger seam (decided): a single env var `YAKCC_AIRGAPPED` read inside the
provider, plus an explicit provider option for programmatic callers.**

Rationale and trade-offs of the candidate triggers:

- (A) `YAKCC_AIRGAPPED=1` env var — chosen. It is already an established
  air-gap signal: `resolve.ts:814` reads `process.env.YAKCC_AIRGAPPED === "1"`.
  Env vars **propagate to child CLI processes** (B6a spawns children with
  `{ ...process.env, ...env }`), which is exactly the propagation path we need.
  The pin reads it lazily at pipeline-load time so tests can set/restore it.
- (B) thread a boolean option from the `--airgapped` flag through
  `runCli → seed → seedYakccCorpus → createLocalEmbeddingProvider` — rejected as
  the *primary* trigger: `--airgapped` only flows through `init`, and the rc
  `mode: "airgapped"` is read by `seed.ts` for commons-binding but is **not**
  propagated as an env to the spawned embedding processes, and `shave`/`query`
  steps never see it. An env var covers every step uniformly. We still expose an
  explicit provider option (below) for in-process callers that want the pin
  without setting global env.
- (C) global unconditional pin (like resolve.ts) — rejected: breaks dev/online
  first-run, which legitimately downloads bge on first use. The cornerstone is
  "no network without explicit intent", and online dev has implicit intent.

**Concrete shape (for the implementer, not prescriptive on style):**
- Add a module-local helper, e.g. `isAirgapMode(): boolean` returning
  `typeof process !== "undefined" && process.env.YAKCC_AIRGAPPED === "1"`.
- Extend `createLocalEmbeddingProvider(modelId?, dimension?, options?)` with an
  optional `{ airgapped?: boolean }` so programmatic callers (seed-yakcc, the
  bench warm) can force the mode without env. Effective mode =
  `options?.airgapped ?? isAirgapMode()`.
- Inside `makePipelineLoader` (or a thin wrapper it calls), when effective mode
  is air-gap, set on the imported `env`: `env.allowRemoteModels = false;` and
  assert `env.allowLocalModels = true;` **before** `mod.pipeline(...)`. This
  mirrors `DEC-MCP-RESOLVE-OFFLINE-GUARANTEE-001` exactly but conditionally.
- Fail-loud message contract: when the model is absent under the pin,
  `@xenova` throws; wrap/annotate so the surfaced error reads (substring-stable
  for the test): **"bge model not cached; provision it for air-gap"**. Never a
  silent fetch, never a zero-vector fallback.
- Singleton caveat: the default-model pipeline is a module-level singleton
  (`getPipeline`, DEC-EMBED-SINGLETON-CLOSURE-001). The pin sets process-global
  `env` state, so once air-gap mode loads the pipeline the env stays pinned for
  the process — which is correct for an air-gap run. For mixed in-process tests,
  the explicit `airgapped` option + per-instance loader for the test avoids
  cross-contamination; document this in the test.

@status proposed (planner) — implementer confirms exact seam at edit time;
code is truth for HOW.

### DEC-1123-CACHE-WARM-IN-HARNESS-001 — warm the model in run.mjs before interception
Warm the bge cache **inside `bench/B6-airgap/run.mjs`** with a one-time
`createLocalEmbeddingProvider().embed("warm")` (online mode, pin OFF) executed
**before** the network interceptor is installed and before any child is
spawned. Chosen over a CI workflow step because:
- It is self-contained (the bench proves its own precondition) and represents
  an air-gap user having provisioned the model once.
- The warm runs in the **harness process**, outside the monitored region — the
  interceptor is loaded per-child via `--require` only when each step spawns;
  the harness's own connect calls are never recorded. So warming is **not** an
  outbound violation.
- The cache path is **shared**: warm writes to the deduped
  `@xenova/transformers/.cache/`, which every spawned child resolves to (Layer 3
  evidence). Verified `cacheDir` is the pnpm-deduped install path.

Real-air-gap-user implication (documented, not a code path): a genuinely
air-gapped user must provision the bge model offline once before running yakcc;
the conditional pin then guarantees no runtime fetch. The harness warm models
that provisioning step.

@status proposed (planner).

### DEC-1123-SEED-BGE-NATIVE-001 — open bootstrap with the matching bge provider
`seedYakccCorpus` opens the bootstrap read-source with a provider whose
`modelId === 'Xenova/bge-small-en-v1.5'` (real local bge, air-gap pin ON in
air-gap mode), so the `embedding_model_mismatch` guard passes. Retain
`makeZeroEmbeddingProvider()` ONLY for `:memory:`/verify (no real embeddings
read). Update the stale doc comment to reflect the #1017 bge bootstrap. The
B6a harness stops injecting `createOfflineEmbeddingProvider()` and relies on the
default bge provider (now pinned + warmed).

@status proposed (planner).

## Architecture / state-authority map

- **Embedding-provider construction** — authority:
  `packages/contracts/src/embeddings.ts` (`createLocalEmbeddingProvider`,
  `makePipelineLoader`). Single owner of the `@xenova/transformers` `env` knobs
  for the shared embedder. The pin lives here and nowhere else.
- **Offline air-gap signal** — authority: `process.env.YAKCC_AIRGAPPED`
  (existing; read by `resolve.ts`). We add a second reader (the embedder). No
  new env var introduced.
- **Registry embedding model identity** — authority:
  `registry_meta.embedding_model_id` (READ-ONLY here). The guard in
  `packages/registry/src/storage.ts` is the consistency authority; we satisfy
  it by passing the correct provider, never by editing it.
- **transformers.js model cache** — authority: the deduped
  `@xenova/transformers/.cache/` dir. Warmed by the harness, read by children.

## Wave decomposition (single PR, ordered edits)

All edits land in one PR (W-1123). Ordered so each step is independently
checkable:

1. **W-1123a (M) — contracts pin.** `packages/contracts/src/embeddings.ts`:
   add `isAirgapMode()` + optional `airgapped` option to
   `createLocalEmbeddingProvider`; conditional `env.allowRemoteModels=false` /
   assert `allowLocalModels=true` before `pipeline(...)`; fail-loud wrap.
   Tests: `packages/contracts/src/embeddings.test.ts`.
2. **W-1123b (S) — seed selection fix.**
   `packages/cli/src/commands/seed-yakcc.ts`: open bootstrap with bge provider
   matching stored modelId; null-zero only for `:memory:`/verify; refresh stale
   comment. `seed.ts`: pass air-gap intent through where applicable. Tests:
   `seed-yakcc.test.ts`, `seed.test.ts`.
3. **W-1123c (M) — bench harness.** `bench/B6-airgap/run.mjs`: (a) warm bge
   before interceptor install; (b) stop injecting
   `createOfflineEmbeddingProvider()` so the default bge path is exercised; (c)
   set `YAKCC_AIRGAPPED=1` in `spawnEnv` so children run pinned.
4. **W-1123d (S, optional) — CI guard.** Confirm the B6a CI job runs after
   `pnpm -r build` so dist exists; no separate warm step needed (harness warms).
   Only touch a workflow file if the job ordering requires it.

Deps: W-1123a → W-1123b, W-1123c (both need the pin/option). W-1123d depends on
W-1123c. Critical path: a → c → (CI). Max width 2 (b ∥ c after a).

## Evaluation Contract (guardian-bound)

**Required tests**
- `packages/contracts/src/embeddings.test.ts`:
  - NEW: with `airgapped:true` (or `YAKCC_AIRGAPPED=1`) AND the model absent
    from a temp/cleared `env.cacheDir`, `embed()` **throws** with a message
    containing **"bge model not cached"** (or the exact chosen substring) —
    proves the pin blocks fetch (no network, deterministic).
  - NEW: with `airgapped:false`/unset, the default/online path still constructs
    a working provider and `generateEmbedding` returns a 384-vector (uses the
    existing offline/warm-tolerant pattern; gated like the existing
    `YAKCC_NETWORK_TESTS` tests where a real download would otherwise be
    needed). Proves the pin does NOT break non-airgap use.
- `packages/cli/src/commands/seed-yakcc.test.ts`: opening the real bootstrap via
  `corpusPath` with the bge-native provider does **not** throw
  `embedding_model_mismatch` (it currently would with null-zero); `:memory:`
  path still uses null-zero.
- `pnpm -r build` (composite tsc — CI authority), `pnpm -r lint`,
  `pnpm -r typecheck` all green.

**Required real-path checks**
- `node bench/B6-airgap/run.mjs --mode b6a` → BENCH RESULT: PASS, 7/7 steps,
  `outboundCount === 0`. (Local passes on warm cache; the load-bearing proof is
  the CI run on a cold machine.)
- CI: the B6a job is green with zero outbound (the regression's actual surface).

**Required authority invariants**
- `env.allowRemoteModels` is set false **only** under air-gap mode; a test or
  assertion confirms the online/default path leaves it at the transformers
  default (true). No second authority for the offline signal beyond
  `YAKCC_AIRGAPPED` + the explicit option.
- `registry_meta.embedding_model_id` and the storage guard are unmodified;
  `git diff --stat` shows no change under `packages/registry/**` or
  `bootstrap/**`.

**Required integration points**
- `runCli` embeddings injection seam unchanged in shape (DEC-CI-OFFLINE-006).
- `resolve.ts` MCP pin unchanged; the new shared-embedder pin does not
  double-pin or conflict (resolve still works air-gapped).

**Forbidden shortcuts**
- No global/unconditional pin in the shared embedder.
- No vendoring the ONNX model to make B6a pass.
- No silent zero-vector fallback on cache miss; no swallowing the @xenova error.
- No editing the registry mismatch guard or re-embedding the bootstrap to dodge
  the mismatch.
- No making B6a green by re-injecting `createOfflineEmbeddingProvider()` (that
  hides the real bge path and re-masks the regression).

**Ready-for-guardian when**
- All required tests pass; `node bench/B6-airgap/run.mjs --mode b6a` is PASS
  with `outboundCount===0` locally; full-workspace build/lint/typecheck green;
  `git diff --stat` shows zero changes under forbidden paths; and the reviewer
  has confirmed the pin is conditional (online path proven intact) on the
  current HEAD SHA.

## Scope Manifest

Authored to `tmp/1123-full-scope.json` in the worktree (triad below). Sync to
runtime before implementer dispatch via
`cc-policy workflow scope-sync 1123-airgap-seed --work-item-id wi-1123 --scope-file tmp/1123-full-scope.json`.

- **Allowed**: `packages/contracts/src/embeddings.ts` (+ `.test.ts`),
  `bench/B6-airgap/run.mjs`, `packages/cli/src/commands/{seed-yakcc,seed,init}.ts`
  (+ their `.test.ts`), `.github/workflows/*.{yml,yaml}`, `MASTER_PLAN.md`,
  `plans/wi-1123-airgap-bge-native.md`, `tmp/**`.
- **Required**: `packages/contracts/src/embeddings.ts` (+ test),
  `bench/B6-airgap/run.mjs`, `packages/cli/src/commands/seed-yakcc.ts`.
- **Forbidden**: `bootstrap/**`, `packages/registry/**`, `packages/seeds/**`,
  `packages/mcp-registry/src/tools/resolve.ts`.
- **State authorities touched**: embedding-provider construction (write);
  registry embedding_model_id consistency (read-only); transformers.js model
  cache (warm-write by harness, read by children).

## Risks

1. **Global-vs-conditional pin breaking dev.** If the implementer pins globally
   (copying resolve.ts verbatim), online first-run breaks. Mitigation: the
   conditional seam + the explicit online-path test in the Evaluation Contract.
2. **Cache-path mismatch making B6a fail-loud in CI.** If the warm process and
   the spawned children resolve **different** `@xenova/transformers` installs
   (e.g. a non-deduped nested copy), the warm won't be seen and the pin throws.
   Mitigation: verified pnpm dedup makes `cacheDir` identical; the implementer
   should add a one-line assertion/log of `env.cacheDir` in the warm step and in
   a child to confirm equality in the CI log. If CI uses a non-pnpm layout, pin
   `env.cacheDir` explicitly to a shared absolute path in both warm and children.
3. **Warm counted as outbound.** If the warm is placed after the interceptor is
   installed, or the interceptor is loaded process-wide rather than per-child,
   the warm download (cold CI) registers as outbound → KILL. Mitigation: warm
   strictly before any `--require` interceptor child spawn, in online mode, and
   keep the interceptor per-child via `--require` (current design).
4. **Real-air-gap-user model provisioning.** A true air-gap user must provision
   bge offline once; the pin then guarantees no fetch. This is an inherent
   property of Direction A (no vendored model). Documented; not a code defect.
   Follow-up candidate: vendor/ship the model (#361) — out of scope here.
5. **Singleton env bleed in mixed in-process tests.** The pin mutates
   process-global `env`. Mitigation: per-instance loader + explicit `airgapped`
   option in the failing-pin test; restore env in afterEach (mirror existing
   `YAKCC_EMBEDDING_PROVIDER` save/restore pattern in embeddings.test.ts).

## Ordered edit list (implementer)

1. `packages/contracts/src/embeddings.ts` — conditional pin + option + fail-loud
   (DEC-1123-CONDITIONAL-OFFLINE-PIN-001).
2. `packages/contracts/src/embeddings.test.ts` — pin-blocks-fetch test +
   online-path-intact test.
3. `packages/cli/src/commands/seed-yakcc.ts` — bge-native bootstrap open;
   null-zero only for `:memory:`/verify; refresh comment
   (DEC-1123-SEED-BGE-NATIVE-001).
4. `packages/cli/src/commands/seed.ts` (+ tests as needed) — thread air-gap
   intent where the seed-yakcc path runs.
5. `bench/B6-airgap/run.mjs` — warm-before-intercept; stop injecting offline
   provider; set `YAKCC_AIRGAPPED=1` in `spawnEnv`
   (DEC-1123-CACHE-WARM-IN-HARNESS-001).
6. CI workflow (only if job ordering requires) — ensure B6a runs after
   `pnpm -r build`.
7. Run the Evaluation Contract; hand off to reviewer on green HEAD.
