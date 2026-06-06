# WI-1031 — Bootstrap-shave breakage post-#1013/#1017: investigation + plan

**Status:** planning-only (no source edits)
**Issue:** [#1031](https://github.com/yakcc/yakcc/issues/1031)
**Predecessors:** #1013 (re-embed bootstrap registry), #1017 (PR that re-embedded it)
**Author:** planner (Serenity)
**Date:** 2026-06-06

---

## 0. TL;DR

The issue title says "self-shave broken on every push" but **that turns out to be a misdiagnosis on the surface symptom.** Self-shave CI's pass-1 step explicitly deletes `bootstrap/yakcc.registry.sqlite` before running `yakcc bootstrap`, so it never hits the model-mismatch gate. Self-shave on `main` is currently red, but the actual failure on the latest red push (`databaseId=27071682688`) is an `IntentCardSchemaError` on `packages/mcp-registry/src/tools/resolve.ts` (`behavior` field 257 chars > 200) — orthogonal to the embedding issue.

The model-mismatch gate IS firing — but on **bootstrap-accumulate** and on **`yakcc init` seed** paths, both of which are silently swallowing it:
- `bootstrap-accumulate.yml` step 5 is fenced by `continue-on-error: true` and step 6 short-circuits on `git diff --quiet`. Net result: the manifest accumulator has been silently dead since 2026-05-31. Atoms from PRs are not being recorded.
- `yakcc init` (default) runs `seedYakccCorpus` which opens the shipped bge registry with the null-zero provider → `embedding_model_mismatch` thrown → caught as "warning: seed failed: … — continuing" in `init.ts:640`. End-users get a silent zero-atom registry.

Recommendation: **Option 1 (init runs rebuild) + bootstrap reads the shipped bge sqlite without a model claim** is *not enough*. The actual fix is **Option 3 (bootstrap uses local provider)** because it is the only single-authority resolution that does not leave the bootstrap sqlite in a state where its declared model and its on-disk vectors disagree. Option 3 is safe because embeddings are write-only during bootstrap (no `findCandidatesByQuery` call), BMR is BLAKE3 over `(spec || impl || proof_root)` and does not include the embedding, and the CI matrix is `ubuntu-latest` only — so the load-bearing two-pass byte-identity claim (S1 ≡ S3) is unaffected by switching providers.

The verifiable acceptance is: (a) `yakcc bootstrap` against the shipped sqlite opens cleanly, (b) `yakcc init` followed by a real `yakcc resolve` returns top-1 the matching atom (not a dead silent skip), (c) self-shave's two-pass equivalence still passes, (d) the bootstrap-accumulate manifest delta on the next push to main is non-zero again.

---

## 1. Identity

This plan covers the WI-1031 fix only. It does NOT modify MASTER_PLAN.md authority sections.

---

## 2. Facts established

All citations are file:line in this worktree.

### 2.1 The bootstrap embedding hard-code
- `packages/cli/src/commands/bootstrap.ts:264-270` declares
  ```ts
  const BOOTSTRAP_EMBEDDING_OPTS: Pick<RegistryOptions, "embeddings"> = {
    embeddings: {
      dimension: 384,
      modelId: "bootstrap/null-zero",
      embed: async (_text: string): Promise<Float32Array> => new Float32Array(384),
    },
  };
  ```
- Used in two places in this file: `runVerify` (line 442, opens `:memory:`) and the main bootstrap path (line 1023, opens the on-disk registry).
- Rationale documented at `bootstrap.ts:248-262` (DEC-V2-BOOTSTRAP-EMBEDDING-001): the network-free zero provider was correct when bootstrap was the sole writer and exportManifest() was the sole reader. Both invariants are still true.

### 2.2 The cross-provider gate (storage.ts)
- `packages/registry/src/storage.ts:2337-2369` is the **open-time** gate (DEC-EMBED-REGISTRY-META-001 + 002).
- Logic: read `registry_meta.embedding_model_id`. If it differs from the provider passed to `openRegistry()`, AND `embCount > 0`, AND `!autoRebuild`, AND `callerSetExplicitProvider`, throw `embedding_model_mismatch`.
- `callerSetExplicitProvider` = `options?.embeddings !== undefined || process.env.YAKCC_EMBEDDING_PROVIDER !== undefined` (line 2315-2316). `BOOTSTRAP_EMBEDDING_OPTS.embeddings !== undefined`, so calls from `bootstrap.ts` always trip this branch.
- There is a *second* gate at `storage.ts:817-851` — the **query-time** gate inside `findCandidatesByQuery`. This one is dormant for both bootstrap and seed paths because neither calls `findCandidatesByQuery`.

### 2.3 What the bootstrap sqlite actually contains
- `sqlite3 bootstrap/yakcc.registry.sqlite "SELECT key, value FROM registry_meta WHERE key LIKE '%model%' OR key LIKE '%dim%';"` returns:
  ```
  embedding_model_id|Xenova/bge-small-en-v1.5
  embedding_dimension|384
  ```
- Confirmed in the commit log: `9fa6a2d chore(bootstrap): #1013 — re-embed shipped registry with Xenova/bge-small-en-v1.5 (#1017)`.

### 2.4 BMR and the role of embeddings
- `packages/contracts/src/merkle.ts:43`: "The content-address of a Block triplet (spec.yak, impl.ts, proof/)." BMR = BLAKE3 over the canonical triplet. Embeddings are not in the hash domain.
- Confirmed by DEC-V2-BOOTSTRAP-EMBEDDING-001 (`bootstrap.ts:248-262`): "exportManifest() does not read the embeddings table — the manifest only contains content-addressed fields (blockMerkleRoot, specHash, etc)."

### 2.5 Determinism guarantee on the local provider
- `packages/contracts/src/embeddings.ts:22-24`:
  > Implementations must be deterministic: identical inputs must produce byte-identical Float32Array outputs (modulo platform floating-point, but transformers.js with the same ONNX model and same backend is deterministic).
- The "modulo platform floating-point" caveat is the open boundary for Option 3. Inside a single-platform CI matrix (ubuntu-latest), bge-small-en-v1.5 via `@xenova/transformers` + onnxruntime-node is treated as bit-deterministic; that is the only platform where we ship the committed sqlite.

### 2.6 CI matrix that touches the bootstrap sqlite
- `.github/workflows/self-shave.yml:35`: `runs-on: ubuntu-latest`.
- `.github/workflows/bootstrap.yml:18`: `runs-on: ubuntu-latest`.
- `.github/workflows/bootstrap-accumulate.yml:44`: `runs-on: ubuntu-latest`.
- `.github/workflows/release.yml:74` (publish job): `ubuntu-latest`.
- No macOS or Windows runner ever writes `bootstrap/yakcc.registry.sqlite`. Cross-OS byte-identity of the embedding column is therefore not a release-pipeline requirement.

### 2.7 What `yakcc init` does after seed
- `packages/cli/src/commands/init.ts:619-649`: `init` opens the user's local registry at `.yakcc/registry.sqlite` (NOT the shipped bootstrap one) with the resolved provider (env or local-BGE default), then calls `seedYakccCorpus(registry, ...)`.
- `seedYakccCorpus` (`packages/cli/src/commands/seed-yakcc.ts:182-184`) opens the source `bootstrap/yakcc.registry.sqlite` with `makeZeroEmbeddingProvider()` (null-zero). Since the shipped sqlite is bge and contains embeddings, this throws `embedding_model_mismatch`. The throw is caught at `init.ts:640` as a non-fatal warning. **End users get a silent zero-atom registry on first install.**
- The release workflow (`.github/workflows/release.yml:94-95`) `touch`es the committed sqlite to bypass `ensure-bootstrap-corpus.mjs`'s mtime check, so the npm tarball ships the bge-embedded sqlite verbatim.

### 2.8 What self-shave CI actually does
- `self-shave.yml:194-198` explicitly `rm -f bootstrap/yakcc.registry.sqlite` before pass-1. Pass-1 therefore writes the sqlite **fresh** with whatever provider `bootstrap.ts` declares. With the current null-zero declaration the sqlite is recreated with `embedding_model_id = bootstrap/null-zero`. There is no pre-existing model_id to mismatch against on a fresh write, so storage.ts:2342 takes the `embCount === 0` branch and just stores the new value.
- Therefore self-shave CI is **not** failing because of the embedding gate. The currently-red main self-shave run is failing on `IntentCardSchemaError` on `packages/mcp-registry/src/tools/resolve.ts:behavior` (>200 chars). That is a separate bug.
- The two-pass test harness (`examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts:228-234`) declares its own `NULL_EMBEDDING_OPTS` with `modelId: "two-pass/null-zero"` and opens registry A and B with it. Pass-1's sqlite carries `bootstrap/null-zero`, so this *would* mismatch too (different model ids, both writers) — except again `bootstrap/yakcc.registry.sqlite` was deleted and freshly created with whatever `bootstrap.ts` declared. The harness opens registry A *after* pass-1 wrote it; it sees model `bootstrap/null-zero` (caller passes `two-pass/null-zero`) — those are different strings but both have `embed: zeros`, both produce zero vectors, and at registry-A open time `callerSetExplicitProvider=true`. Today this *does* trip the open-time gate. **However**, in practice it does not surface because pass-1 itself currently fails earlier on the IntentCardSchemaError, so the harness `beforeAll` never reaches registry A. Once #1031 forces a refactor here, the harness must also be aligned to the new authority.

### 2.9 What bootstrap-accumulate actually does
- `bootstrap-accumulate.yml:96` runs `node packages/cli/dist/bin.js bootstrap` against the committed bge sqlite without deleting it first.
- The latest push-to-main accumulator run (`databaseId=27073240395`, 2026-06-06 20:38) logs:
  ```
  error: failed to open registry at /home/runner/work/yakcc/yakcc/bootstrap/yakcc.registry.sqlite:
  Registry was embedded with model "Xenova/bge-small-en-v1.5", but the current provider uses
  "bootstrap/null-zero". Run `yakcc registry rebuild` to re-embed with the current provider...
  ```
- The job reports `success` because step 5 carries `continue-on-error: true` and step 6 `if: git diff --quiet bootstrap/expected-roots.json && exit 0` exits 0 (no diff produced because bootstrap never ran).
- Net consequence: **the monotonic accumulator has been silently dead since #1017 merged.** Atoms from every PR since 2026-05-31 are not being recorded into `bootstrap/expected-roots.json`. This is a real correctness regression hidden behind the `continue-on-error` valve.

### 2.10 What ensure-bootstrap-corpus.mjs does at publish time
- `packages/cli/scripts/ensure-bootstrap-corpus.mjs` regenerates the sqlite via `yakcc bootstrap` if the source tree is newer (line 64-77). On the release path the workflow `touch`es the file (line 94-95 of release.yml) to skip the regeneration path entirely. The committed bge sqlite is shipped verbatim.
- If anyone ever ran the publish script locally without the `touch` bypass, they would hit the same gate (bge stored / null-zero requested). The `touch` bypass is therefore load-bearing for the current pipeline.

---

## 3. Comparing the three options against the facts

### Option 1 — `yakcc init` runs `registry rebuild --embedding-provider local`
**Cost:** Cheap to add. `registry rebuild` already exists (`registry-rebuild.ts`) and already calls `openRegistry` with `autoRebuild: true` to bypass the gate.

**What it fixes:** End-user `yakcc init` produces a registry whose vectors and meta match the local provider. The MCP `yakcc_resolve` path works on a default install.

**What it does NOT fix:**
- `yakcc bootstrap` (CLI) still cannot open the shipped sqlite without first deleting it. Anyone running it locally hits the gate. The accumulator-style CI workflow that doesn't delete the sqlite (`bootstrap-accumulate.yml`) stays silently broken.
- The shipped sqlite still declares bge but `bootstrap.ts` declares null-zero — the dual-authority problem persists by construction.
- `seedYakccCorpus` still opens the source sqlite with null-zero opts → still throws → still silently fails → init still seeds zero atoms.

**Verdict:** Insufficient on its own. Would have to be paired with a fix to `seedYakccCorpus` and a deletion step prepended to every other bootstrap-invoking workflow. That's three patches to mask one dual-authority issue, plus the dual-authority remains. Rejected as a primary fix; salvageable as a defense-in-depth follow-up if Option 3 is too costly.

### Option 2 — Ship two registries (null-zero bootstrap + semantic for users)
**Cost:** Build-pipeline complexity. Two artifacts to keep in sync. Doubles the binary footprint of the npm tarball (~25 MB → ~50 MB) and the git repo.

**What it fixes:** Bootstrap-side stays simple; the user-facing artifact is semantically embedded.

**What it does NOT fix / what it adds:**
- Drift risk: `bootstrap/yakcc.registry.semantic.sqlite` is derived from the null-zero one via `registry rebuild`; any out-of-band edit to one and not the other introduces silent rot. Two authorities for the same atom set.
- Storage gate semantics don't change: `seedYakccCorpus` still mismatches the source registry's model unless it's pointed at the semantic one with the matching provider. So we still have to fix seed.
- Doubles CI cycle: `bootstrap-accumulate` would need to produce both files and push both. The race conditions in the accumulate workflow get harder.

**Verdict:** This is a workaround that papers over the dual-authority bug by formalizing it as two artifacts. Rejected as fundamentally drift-prone.

### Option 3 — Bootstrap uses `createLocalEmbeddingProvider`
**Cost:**
- Wall-clock: bge-small-en-v1.5 inference on ~3-6k atoms adds 5-10 min to `yakcc bootstrap`. self-shave's `verified-cache` already shields cold-path runs (DEC-V2-CI-GATE-FINAL-001); only cache-miss pays the cost. bootstrap-accumulate runs already budget 120 min.
- Module load: `@xenova/transformers` + ONNX runtime cold-start (~3-5s) adds to every `yakcc bootstrap` invocation. Acceptable.
- Verify path: `yakcc bootstrap --verify` uses `:memory:` and currently runs a full shave (`bootstrap.ts:430-477`). With bge, every verify also pays the embedding cost. CI verify is `continue-on-error: true` and ungated (advisory only per DEC-VERIFY-CI-ADVISORY-001), so this is tolerable; local pre-commit verify gets slower.

**What it fixes:**
- Single authority: bootstrap is the writer; the shipped sqlite declares bge; on-disk vectors match the declaration. No dual-authority.
- `yakcc bootstrap` (CLI) opens the shipped sqlite cleanly. bootstrap-accumulate stops being silently dead.
- `seedYakccCorpus` opens the source sqlite with… the same local provider. The gate no longer fires.
- `yakcc init` seed path now works (no caught warning, no silent zero-atom registry).
- The semantic content shipped with the alpha release is real, not stub. `yakcc_resolve` returns top-1 the matching atom on a default install — closing the loop on #1006 / #1013 that #1017 only half-fixed.

**Risks and how the facts neutralize them:**
- *Bit-identity of embedding floats across platforms.* The deterministic contract guarantees byte-identity given fixed model + backend. CI is ubuntu-latest only; we never ship a sqlite produced on macOS or Windows. End users who run `yakcc bootstrap` locally on different OSes get a locally-valid sqlite — but BMR doesn't include the embedding, so the manifest (the only cross-host-shared content-addressed surface) is unaffected. **Not a real risk** within the documented platform contract.
- *Two-pass S1 ≡ S3 equivalence.* The test compares blockMerkleRoots, not embeddings. BMR is BLAKE3 over (spec || impl || proof_root). Changing the embedding provider cannot move the BMR. The harness opens registry A and B with its own `NULL_EMBEDDING_OPTS` (`two-pass-equivalence.test.ts:228`) which today would mismatch the new bge sqlite — the harness must be updated to use the same local provider too. This is a single coordinated change.
- *bootstrap-accumulate retry-with-rebase race.* The push step (`bootstrap-accumulate.yml:130-149`) retries up to 5 times with `git pull --rebase`. Since the accumulator has been dead for a week and is starting from a stale baseline once revived, the first successful run will produce a large manifest delta. The retry logic already handles concurrent main updates correctly (additive merge per DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001). Manageable.
- *--verify wall-time on local pre-commit.* Local hooks that call `bootstrap --verify` now pay ~5-10 min. Mitigation: --verify uses `:memory:` and only opens-and-closes per file; we can either keep this cost or short-circuit `--verify` to keep using null-zero on the `:memory:` path (it's never persisted). The `:memory:` registry's model id is not load-bearing because nothing reads it after the test exits. This is a targeted carve-out, NOT a parallel authority, because the file-backed path is what ships.

**Verdict:** Single-authority resolution. Preferred.

### Option 4 (planner-added) — Hybrid: bge for the disk path, null-zero for `--verify`'s `:memory:` path
This is Option 3 with one carve-out: `runVerify` (`bootstrap.ts:416-543`) keeps using a zero provider because it opens `:memory:` and never persists. The carve-out is a performance optimization for an ephemeral artifact, not a parallel authority. The only thing the carve-out costs is the shape of the inner zero provider — `runVerify` reads back via `exportManifest()` which doesn't touch embeddings, identical to the current behavior.

This is the **recommended shape** for Option 3 implementation: production path = local provider; verify-only `:memory:` path = zero provider (because nothing downstream reads its vectors).

---

## 4. Recommendation

**Adopt Option 3 with the Option-4 verify carve-out.** Replace `BOOTSTRAP_EMBEDDING_OPTS` with a function that returns the local provider for the on-disk path and the zero provider for the `:memory:` verify path. Update the two-pass harness to match. Remove the model-mismatch landmine from `seedYakccCorpus` (it opens the bootstrap sqlite read-only; it does not need to declare a provider — let `openRegistry` resolve from `embedding_model_id`).

**Decision implications:**
- `DEC-V2-BOOTSTRAP-EMBEDDING-001` (`bootstrap.ts:248-262`) is **superseded**. New decision needed: `DEC-V2-BOOTSTRAP-EMBEDDING-002` titled "Bootstrap uses the local BGE provider on disk; zero provider only on `:memory:` verify."
- Rationale recorded: embeddings never enter the BMR hash; production CI is single-platform; the dual-authority bug between bootstrap and the shipped sqlite is irreducible under any null-zero variant.
- `DEC-V2-BOOTSTRAP-EMBEDDING-001`'s "deterministic zero vector is correct for bootstrap" claim is narrowed to the verify `:memory:` path only.

---

## 5. Slice plan

Two slices. Slice A is the load-bearing fix. Slice B closes the silent-failure path in `seedYakccCorpus` so end-user `yakcc init` actually works without a separate post-init rebuild.

### Slice A — `yakcc bootstrap` uses the local provider on disk

**Files to change:**
- `packages/cli/src/commands/bootstrap.ts` — replace `BOOTSTRAP_EMBEDDING_OPTS` constant with two factory helpers: `getBootstrapEmbeddingOpts()` for the on-disk path (returns `{ embeddings: createLocalEmbeddingProvider() }`), and `getVerifyEmbeddingOpts()` for the `:memory:` path (current zero provider). Update both call sites (`bootstrap.ts:442` and `bootstrap.ts:1023`). Replace the DEC block at lines 248-270 with the new DEC-V2-BOOTSTRAP-EMBEDDING-002 annotation.
- `examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts` — replace `NULL_EMBEDDING_OPTS` at line 228-234 with an opts factory that uses `createLocalEmbeddingProvider()` (so the harness can open both registries without tripping the gate). The harness reads only block triplets and merkle roots; embeddings are irrelevant to its assertion.
- `packages/cli/scripts/ensure-bootstrap-corpus.mjs` — no change required (it shells out to `yakcc bootstrap` which already inherits the new provider).
- `.github/workflows/self-shave.yml` lines 188-198 — re-evaluate: the explicit `rm -f bootstrap/yakcc.registry.sqlite` is now load-bearing for *clean pass-1* not for *provider equivalence*. Keep the rm but update the explanatory comment.

**Tests to add:**
1. `packages/cli/src/commands/bootstrap.bge-roundtrip.test.ts` (new):
   - Run `yakcc bootstrap` against a tiny synthetic source directory; assert the resulting sqlite has `registry_meta.embedding_model_id = "Xenova/bge-small-en-v1.5"` and `embedding_dimension = 384`.
   - Re-open the produced sqlite with `openRegistry(path)` (no provider override) — must not throw.
   - Assert `findCandidatesByQuery({ behavior: "..." })` returns a non-empty result when the behavior matches a stored atom (proves end-to-end embedding semantics).
2. `packages/cli/src/commands/bootstrap.verify-memory.test.ts` (new):
   - Run `yakcc bootstrap --verify` against the same fixture. Assert it does NOT load the BGE model (mock or detect via a module-load probe), to prove the `:memory:` carve-out is in effect.
3. `examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts` — no new test, but the existing assertion must still pass with the new provider. Add a comment recording why the harness is now provider-agnostic.

**Evaluation Contract:**
- Required tests passing: the two new tests above; the existing `packages/cli/src/commands/bootstrap.test.ts` suite; `packages/registry/**.test.ts` (all 345+ tests); `examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts` under `YAKCC_TWO_PASS=1` (the load-bearing harness).
- Required real-path checks:
  1. After local `yakcc bootstrap`, `sqlite3 bootstrap/yakcc.registry.sqlite "SELECT value FROM registry_meta WHERE key='embedding_model_id';"` returns `Xenova/bge-small-en-v1.5`.
  2. Re-running `yakcc bootstrap` against the produced sqlite (no delete) does NOT throw `embedding_model_mismatch` — proves the dual-authority bug is gone.
  3. The next push-to-main bootstrap-accumulate run produces a non-empty `git diff bootstrap/expected-roots.json` and the push step actually pushes (not the silent no-op of the last week).
- Required authority invariants:
  - DEC-V2-BOOTSTRAP-EMBEDDING-002 is recorded in `bootstrap.ts` with `@status accepted` and supersedes -001.
  - DEC-V2-BOOTSTRAP-EMBEDDING-001's superseded status is annotated in the same DEC block.
- Required integration points: the two-pass harness must continue to assert S1 ≡ S3 byte-identity on every BMR in the included subset. BMR is independent of embedding provider, so this is automatic — but the test must be observed green to prove it.
- Forbidden shortcuts:
  - DO NOT introduce a `bootstrap/yakcc.registry.semantic.sqlite` second artifact (rejected Option 2).
  - DO NOT add `continue-on-error: true` anywhere new to mask new failures.
  - DO NOT bypass the gate via `autoRebuild: true` in bootstrap (that flag exists for the `registry rebuild` command, not for ordinary write paths).
  - DO NOT keep the null-zero provider as a "fallback option" on the on-disk path (parallel authority).
- Ready-for-guardian definition: all tests above green on the current HEAD; bge model loads exactly once per `yakcc bootstrap` invocation (cold-start ≤5s); committed sqlite produced locally opens without provider override; harness equivalence test passes.

**Scope Manifest:**
- Allowed files/directories:
  - `packages/cli/src/commands/bootstrap.ts`
  - `packages/cli/src/commands/bootstrap.bge-roundtrip.test.ts`
  - `packages/cli/src/commands/bootstrap.verify-memory.test.ts`
  - `examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts`
  - `.github/workflows/self-shave.yml` (comment-only edit at the `rm -f` block)
  - `bootstrap/yakcc.registry.sqlite` (regenerated as the artifact of the change; not hand-edited)
- Required files/directories: the four `.ts`/`.test.ts` files above.
- Forbidden touch points:
  - `packages/registry/src/storage.ts` — the gate is correct as written; do not weaken it.
  - `packages/registry/src/rebuild.ts` — irrelevant to this slice.
  - `packages/cli/src/commands/seed-yakcc.ts` — Slice B owns this.
  - `packages/cli/src/commands/registry-rebuild.ts` — irrelevant; the user-facing rebuild command stays as is.
  - `.github/workflows/bootstrap.yml`, `bootstrap-accumulate.yml`, `release.yml` — no changes required for Slice A; the workflows will work as soon as the gate stops firing.
  - `MASTER_PLAN.md` permanent sections.
- Expected state authorities touched:
  - Bootstrap-time embedding provider (CLI side, single authority now).
  - `registry_meta.embedding_model_id` row in the shipped sqlite (now `Xenova/bge-small-en-v1.5`, matching what's already there post-#1017).

### Slice B — `seedYakccCorpus` stops declaring an explicit provider

**Files to change:**
- `packages/cli/src/commands/seed-yakcc.ts:128-133` (the `makeZeroEmbeddingProvider` helper) — delete.
- `packages/cli/src/commands/seed-yakcc.ts:177-189` (`openRegistry(sqlitePath, { embeddings: makeZeroEmbeddingProvider() })`) — change to `openRegistry(sqlitePath)` with no embeddings option. Per DEC-EMBED-REGISTRY-META-002 (`storage.ts:2330-2336`), when the caller does not set an explicit provider, `openRegistry` accepts the stored model without firing the mismatch throw. This is the canonical "I am not embedding anything; I just need the file open" code path.
- Update the DEC block at `seed-yakcc.ts:120-127` to reflect the new authority: seed is read-only with respect to embeddings; it must not declare a provider.

**Tests to add:**
1. `packages/cli/src/commands/seed-yakcc.bge-source.test.ts` (new):
   - Build a tiny fixture sqlite via `openRegistry(path, { embeddings: <real-or-stub-bge> })` and store one block.
   - Call `seedYakccCorpus(targetRegistry, { corpusPath: fixturePath })` — must succeed without throwing.
   - Assert the target registry now contains the imported block (`exportManifest().length === 1`).
2. Adjust `packages/cli/src/commands/seed-yakcc.test.ts` (existing) to remove any null-zero opts assertions; assert that `openRegistry` is called without an embeddings option.

**Evaluation Contract:**
- Required tests passing: `seed-yakcc.bge-source.test.ts` (new), updated `seed-yakcc.test.ts`, and the broader `packages/cli/**.test.ts` suite. Add an end-to-end `init.test.ts` assertion that running `yakcc init --no-peer` against the shipped (post-Slice-A) bge sqlite produces a non-zero `seedCount`.
- Required real-path checks: after `yakcc init` on a clean tmpdir, `sqlite3 .yakcc/registry.sqlite "SELECT COUNT(*) FROM blocks;"` returns the same count as the source bootstrap sqlite (modulo the seed contract's expected drops).
- Required authority invariants: `seedYakccCorpus` calls `openRegistry(path)` with no `embeddings` field. The single authority on which provider to use for an existing on-disk sqlite is `registry_meta.embedding_model_id` (DEC-EMBED-REGISTRY-META-002), read by `openRegistry` itself.
- Forbidden shortcuts:
  - DO NOT pass `autoRebuild: true` from seed (it would rewrite vectors that don't need rewriting).
  - DO NOT add a fallback to the null-zero provider on mismatch (parallel authority).
- Ready-for-guardian definition: `yakcc init` (default flags) against a clean tmpdir produces a populated registry with the same atom count as the shipped corpus, and `yakcc resolve "<known-behavior>"` returns top-1 the expected merkle root.

**Scope Manifest:**
- Allowed files/directories:
  - `packages/cli/src/commands/seed-yakcc.ts`
  - `packages/cli/src/commands/seed-yakcc.bge-source.test.ts`
  - `packages/cli/src/commands/seed-yakcc.test.ts`
  - `packages/cli/src/commands/init.test.ts` (assertion addition only)
- Required files/directories: the four files above.
- Forbidden touch points:
  - All Slice A files (Slice B depends on Slice A landing first; do not double-edit).
  - `packages/registry/src/**`
  - `packages/cli/src/commands/init.ts` (no code change needed; the seed warning at line 640 keeps its place but should no longer fire on the happy path).
- Expected state authorities touched:
  - User-side `.yakcc/registry.sqlite` (now actually populated).
  - Seed-path embedding provider authority (now deferred to the source registry's stored metadata, not declared by the caller).

### Slice ordering and dependency

Slice A lands first. Slice B depends on Slice A because:
1. Until bootstrap writes the sqlite with bge, the source registry that `seedYakccCorpus` opens is a mixture of the bge sqlite (committed) and any locally-rebuilt one. With Slice A in place, every regeneration produces a bge sqlite, so Slice B's "no provider declared at seed time" path is the steady state.
2. Slice B's `init.test.ts` end-to-end assertion needs Slice A's `bootstrap` to be the canonical builder.

After both slices land, the next push-to-main triggers a real bootstrap-accumulate run that produces a non-trivial diff to `expected-roots.json` (recovering the week of missed atoms). Reviewer/guardian should expect that diff and not flag it as scope creep.

---

## 6. Out-of-scope items (file as separate issues)

These were discovered during this investigation but do not belong inside the WI-1031 fix:

1. **The IntentCardSchemaError on `packages/mcp-registry/src/tools/resolve.ts`** — the actual cause of the current red self-shave runs. The `behavior` field is 257 chars; the schema caps it at 200. This is an orthogonal bug introduced by a recent edit to that file. Separate issue.
2. **`bootstrap-accumulate.yml`'s `continue-on-error: true` masking a complete failure** — the workflow reports success while doing nothing. This is the load-bearing reason the team didn't notice the gate firing for a week. Consider either (a) removing `continue-on-error` and accepting a hard fail signal on retry-exhaust, or (b) emitting a clear "no atoms recorded" log line that the dashboard can alert on. Out of scope for WI-1031 but worth a follow-up.
3. **`yakcc init` silently swallowing `seedYakccCorpus` throws as warnings** (`init.ts:638-641`) — the warning is correct as a fallback but hides correctness failures. Consider promoting this to a non-zero exit if the seed actually had source data to import. Out of scope.

---

## 7. Decision Log additions (for the implementer to author)

- **DEC-V2-BOOTSTRAP-EMBEDDING-002** — Bootstrap uses the local BGE provider on disk; zero provider only on `:memory:` verify. Supersedes -001. Rationale: dual-authority elimination; embeddings never enter BMR; CI is single-platform.
- Annotate **DEC-V2-BOOTSTRAP-EMBEDDING-001** with `@status superseded-by DEC-V2-BOOTSTRAP-EMBEDDING-002` and preserve its rationale block as historical record.
- **DEC-CLI-SEED-NO-PROVIDER-001** — `seedYakccCorpus` opens the source bootstrap registry without declaring an embedding provider. Reads `embedding_model_id` from `registry_meta`. Rationale: seed is read-only w.r.t. embeddings; declaring a provider creates a false dual-authority claim.

---

PLAN_VERDICT: ready_for_implementer
RECOMMENDED_OPTION: 3
PRIMARY_RATIONALE: Embeddings never enter BMR and CI is single-platform, so bootstrap can safely use the local BGE provider, collapsing the dual-authority bug between the shipped sqlite and the bootstrap declaration.
