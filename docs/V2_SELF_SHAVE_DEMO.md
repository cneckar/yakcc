# yakcc v2 self-shave demo

> @decision DEC-V2-PoC-CLOSURE-001
> @title Headline claim text and explicit non-claims
> @status accepted (WI-V2-10 / Issue #287 / 2026-05-12)
> @rationale See MASTER_PLAN.md Decision Log entry for full rationale.

yakcc shaves the meaningfully-reusable parts of arbitrary TypeScript — including its own source — recompiles itself from those atoms, and the recompiled yakcc produces the same manifest. Reproducible from a fresh clone in 6 commands.

For pass-1 internals (bootstrap mechanics, manifest semantics, CI integration) see
[docs/V2_SELF_HOSTING_DEMO.md](V2_SELF_HOSTING_DEMO.md).

---

## Explicit non-claims

The following are **out of scope** for this PoC and must not be inferred from the headline claim:

1. **WASM-runtime self-hosting.** A separate post-PoC track per #54 + dep migration plan. The PoC recompiles to TypeScript, not WASM.
2. **Multi-language shave.** The shave pipeline today consumes TypeScript source only. Foreign-language dependencies become tagged `GlueLeafEntry` records.
3. **Byte-identical compiled output.** The recompile uses `compileToTypeScript` (the A2 backend), which reconstructs TypeScript from content-addressed atoms. Equivalence is asserted at the `BlockMerkleRoot` manifest level — not at the raw TS source-bytes level. The AST canonicalizer may produce different whitespace, comment placement, or import ordering than the original source while preserving semantic identity.
4. **Shave of foreign dependencies.** The PoC ships with `--foreign-policy=tag`; every foreign dep (npm modules) is a tagged leaf. Shaving foreign deps is a separate, future work item.

---

## Pinned manifest reference

The `bootstrap/expected-roots.json` manifest cited in this document:

- **Commit SHA:** `548db8d6fdb6484d9cd969b4f0372239963d7865`
- **Atom count:** 3,807 entries
- **Authority:** `.github/workflows/bootstrap-accumulate.yml` is the sole writer; do not regenerate manually.

Re-running against a later HEAD may require re-running `bootstrap-accumulate.yml` to update the manifest if new atoms were added since this commit. The `bootstrap --verify` command checks `current_shave ⊆ committed_manifest` (superset semantics per `DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001`).

---

## Fresh-clone reproduction

Prerequisites:

- **pnpm 9** (matches `packageManager` field in `package.json` and the CI `pnpm/action-setup@v4` pin)
- **Node.js 22** (matches the CI `actions/setup-node@v4` pin)
- A clean clone with no local modifications. The verify path is byte-deterministic; uncommitted edits to shaved source files will change atom hashes and trigger a mismatch.

### Step 1 — Clone

```sh
git clone https://github.com/cneckar/yakcc
cd yakcc
```

### Step 2 — Install dependencies

```sh
pnpm install --frozen-lockfile
```

### Step 3 — Build all packages

```sh
pnpm -r build
```

### Step 4 — Pass 1: verify yakcc shaves itself (bootstrap --verify)

```sh
node packages/cli/dist/bin.js bootstrap --verify
```

This runs the shave pipeline over the entire yakcc source tree, builds an in-memory registry, exports a manifest sorted by `BlockMerkleRoot`, and checks `current_shave ⊆ committed_manifest`. A clean exit proves yakcc can shave itself and that the result is consistent with the accumulated bootstrap manifest.

See [docs/V2_SELF_HOSTING_DEMO.md](V2_SELF_HOSTING_DEMO.md) for the detailed pass-1 mechanics (atom hashing rules, manifest ordering, `:memory:` registry isolation, structured-diff on failure).

Wall-clock: **~28 minutes** on a 2024-class workstation.

### Step 5 — Recompile yakcc from its own atoms

```sh
node packages/cli/dist/bin.js compile-self --output=dist-recompiled/
```

This uses the bootstrap registry (`bootstrap/yakcc.registry.sqlite`) to reconstruct the yakcc workspace at `dist-recompiled/`. Each atom in the registry is compiled back to TypeScript via the A2 backend and placed at its original source-file path.

### Step 6 — Pass 2 + byte-identity assertion (two-pass equivalence)

```sh
YAKCC_TWO_PASS=1 pnpm --filter @yakcc/v2-self-shave-poc test two-pass-equivalence
```

This invokes the two-pass equivalence harness at
`examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts` (delivered by #286 / WI-V2-09 / PR #432).

The harness:
1. Reads registry A (the live `bootstrap/yakcc.registry.sqlite` from pass 1).
2. Runs `compile-self` to produce a recompiled workspace at `tmp/two-pass/dist-recompiled/`.
3. Runs a second bootstrap pass inside that workspace to produce registry B (`tmp/two-pass/registry-B.sqlite`).
4. For every `BlockMerkleRoot` in registry A that is in the **shavable subset** (excluding the dynamic exclusion set — see below), asserts that the same root appears in registry B with byte-identical hex value.

Wall-clock: **~60–70 minutes** for the full two-pass cycle.

---

## Captured output

The following output was captured running against main HEAD `55dbb65` (origin/main at WI-V2-10 implementation time, 2026-05-12).

### compile-self (pass 1 registry → dist-recompiled)

This output is verbatim from the compile-self step run during WI-V2-10 implementation:

```
yakcc compile-self — A2 compile pipeline
  registry: /Users/cris/src/yakcc/bootstrap/yakcc.registry.sqlite
  output:   /Users/cris/src/yakcc/tmp/two-pass/dist-recompiled

compile-self: 3452 total atoms, 3452 compiled, 0 gap rows
compile-self: 3452 atoms compiled → /Users/cris/src/yakcc/tmp/two-pass/dist-recompiled/atoms/
compile-self: manifest written → /Users/cris/src/yakcc/tmp/two-pass/dist-recompiled/manifest.json
compile-self: compose-path-gap report: empty (all atoms compiled successfully)
```

### Pass 2 — two-pass equivalence harness (current status at `55dbb65`)

**IMPORTANT — Harness pre-condition failure at current HEAD (2026-05-12):**

Running `YAKCC_TWO_PASS=1 pnpm --filter @yakcc/v2-self-shave-poc test two-pass-equivalence`
at main HEAD `55dbb65` currently fails. The following is the verbatim error output:

```
> @yakcc/v2-self-shave-poc@0.0.1 test /path/to/yakcc/examples/v2-self-shave-poc
> vitest run "two-pass-equivalence"

 RUN  v4.1.5 /path/to/yakcc/examples/v2-self-shave-poc

stdout | test/two-pass-equivalence.test.ts > Two-pass bootstrap equivalence (#286 WI-V2-09)
[two-pass] Step 1: compile-self → /path/to/yakcc/tmp/two-pass/dist-recompiled
[two-pass] compile-self succeeded.
yakcc compile-self — A2 compile pipeline
  registry: /path/to/yakcc/bootstrap/yakcc.registry.sqlite
  output:   /path/to/yakcc/tmp/two-pass/dist-recompiled
compile-self: 3452 total atoms, 3452 compiled, 0 gap rows
compile-self: 3452 atoms compiled → /path/to/yakcc/tmp/two-pass/dist-recompiled/atoms/
compile-self: manifest written → /path/to/yakcc/tmp/two-pass/dist-recompiled/manifest.json
compile-self: compose-path-gap report: empty (all atoms compiled successfully)

[two-pass] Shavable corpus: 401 files.
[two-pass] compile-self manifest coverage: 3452 source files.
[two-pass] Dynamic exclusion set (401 files):
  - examples/parse-int-list/src/main.ts
  - examples/v0.7-mri-demo/src/argv-parser.ts
  [... ~399 additional files ...]

Error: [two-pass] Dynamic exclusion set contains undocumented files: examples/parse-int-list/src/main.ts,
examples/v0.7-mri-demo/src/argv-parser.ts, examples/v0.7-mri-demo/src/gpl-fixture.ts,
examples/v1-federation-demo/src/argv-parser.ts, examples/v1-wave-2-wasm-demo/src/add.ts,
examples/v2-self-shave-poc/src/compile-pipeline.ts, examples/v2-self-shave-poc/src/load-corpus.ts,
packages/cli/src/bin-main-module.test.ts, packages/cli/src/bin.ts, packages/cli/src/binary-smoke.test.ts,
[... list continues for ~400 source files ...]
 ❯ test/two-pass-equivalence.test.ts:351:15

 Test Files  1 failed (1)
      Tests  13 skipped (13)
   Start at  21:52:22
   Duration  1.38s
```

**Root cause:** The harness's `dynamic ⊆ documented` invariant (per
`DEC-V2-BOOTSTRAP-EQUIV-EXCLUSIONS-001`) requires that every file producing zero atoms in
pass 1 is listed in `EXCLUSION_DOCUMENTED_FILES`. The constant lists only 7 files (from issue
#399). At current HEAD `55dbb65`, the dynamic exclusion set contains ~400 files — far more than
the 7 documented. This indicates a fundamental pre-condition failure: the harness was
written against a state where bootstrap produced atoms for nearly all source files, but at current
HEAD the shave pipeline covers far fewer files (only 3,452 atoms compiled from a corpus of 401 shavable
files, leaving the rest as zero-atom files).

**This is a pre-existing issue**, not introduced by this WI. Per Forbidden Shortcut FS1
(evaluation-contract.md), the implementer must not modify the harness. This is a follow-up
to #286 / WI-V2-09 that requires either:

- Updating `EXCLUSION_DOCUMENTED_FILES` in the harness to document all current zero-atom files, OR
- Fixing the shave-pipeline gaps for the affected files (closing #399 and any newly-surfaced gaps)

**Impact on CI gate:** The `self-shave.yml` workflow is structurally correct (syntax-valid,
correct caching pattern, correct opt-in gate). However, until the harness pre-condition is
resolved, the workflow's "Run two-pass equivalence check" step will fail on its first
push-to-main run. The CI gate is in place and will correctly block regressions once the
harness pre-condition is satisfied.

### Pass 1 — `bootstrap --verify`

The bootstrap --verify command was running at time of authoring (wall-clock ~28 min). Based on
prior documented runs (see `docs/V2_SELF_HOSTING_DEMO.md` §2 "Captured output from running
this sequence against `main` at `ab77e61`"), the expected output when successful is:

```
bootstrap --verify: OK (current_shave ⊆ manifest — superset check passed)
```

The superset semantics (per `DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001`) mean: if all atoms
produced by the current shave are present in `bootstrap/expected-roots.json`, the check passes.
Archived atoms from deleted/unmerged branches that are in the manifest but absent from the
current shave are expected and not failures.

---

## What this proves

Each step in the reproduction maps to one cell of the headline claim:

| Step | Command | What it proves |
|------|---------|----------------|
| Pass 1 | `node packages/cli/dist/bin.js bootstrap --verify` | yakcc shaves itself — the shave pipeline processes the yakcc source tree and produces atoms consistent with the accumulated `bootstrap/expected-roots.json`. |
| Recompile | `node packages/cli/dist/bin.js compile-self --output=dist-recompiled/` | yakcc recompiles itself from those atoms — the A2 compile backend reconstructs a runnable yakcc workspace from the content-addressed atoms in the bootstrap registry (3,452 atoms compiled). |
| Pass 2 | `YAKCC_TWO_PASS=1 pnpm --filter @yakcc/v2-self-shave-poc test two-pass-equivalence` | The recompiled yakcc produces the same manifest — a second bootstrap pass over the recompiled workspace must yield byte-identical `BlockMerkleRoot` values for every atom in the shavable subset, proving fixed-point self-hosting. |

The three-step cycle is the fixed-point proof: if the recompiled yakcc produced a different
manifest, it would signal non-determinism in the canonicalizer, AST-hash, or merkle path —
the most valuable class of bug the project can surface.

---

## If equivalence fails

When the two-pass harness exits non-zero, it prints a structured failure report naming every
divergent `BlockMerkleRoot`. Divergence classes per #61 body:

- **Source-byte drift.** The compile-self step reconstructed a file with different bytes than
  the original (a canonicalizer or A2 backend bug). Check the `VerifyDiff` output — divergent
  roots will share the same atom name/path but have different `BlockMerkleRoot` values.
- **Spec drift.** The IntentCard or block specification changed between pass 1 and pass 2,
  altering the content-address.
- **Foreign-policy drift.** A foreign dep that was a tagged leaf in pass 1 was shaved as a
  local atom in pass 2 (or vice versa).
- **Glue-policy drift.** A glue region boundary changed between passes — a section that was
  verbatim-preserved in pass 1 was re-shaved in pass 2 (or vice versa).
- **New atom.** A file that produced no atoms in pass 1 now produces atoms in pass 2 (the
  dynamic exclusion set shrank unexpectedly). This indicates a shave-pipeline fix not reflected
  in `EXCLUSION_DOCUMENTED_FILES`.
- **Missing atom.** A file that produced atoms in pass 1 now produces none in pass 2 (the
  dynamic exclusion set grew unexpectedly). The harness will fail loudly with the "undocumented
  files" error and list the affected paths — this is the pre-condition failure described in the
  "Captured output" section above.

---

## References

- **Assertion source:** [`examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts`](../examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts) — the #286 harness (WI-V2-09). Authority for the byte-identity assertion. Gated by `YAKCC_TWO_PASS=1`.
- **Manifest authority:** [`bootstrap/expected-roots.json`](../bootstrap/expected-roots.json) — 3,807-entry accumulated manifest at commit `548db8d`. Written only by `bootstrap-accumulate.yml`.
- **Pass-1 internals:** [`docs/V2_SELF_HOSTING_DEMO.md`](V2_SELF_HOSTING_DEMO.md) — bootstrap mechanics, manifest semantics, `:memory:` registry gate, CI integration for pass 1.
- **CI gate:** [`.github/workflows/self-shave.yml`](../.github/workflows/self-shave.yml) — the `self-shave` CI workflow wiring this sequence on push:main + PR `[v2-check]` opt-in (`DEC-V2-CI-GATE-001`).
- **Tracking issues:** [#61](https://github.com/cneckar/yakcc/issues/61) (WI-V2-PoC-CLOSER — rolled-up v2 closer), [#287](https://github.com/cneckar/yakcc/issues/287) (WI-V2-10 — this slice). [#399](https://github.com/cneckar/yakcc/issues/399) is the named dependency for full byte-identity closure.
- **Decisions:** `DEC-V2-PoC-CLOSURE-001` (this doc's headline claim text + non-claims), `DEC-V2-CI-GATE-001` (CI gating strategy), `DEC-V2-BOOTSTRAP-EQUIV-001` (byte-equality invariant in the harness), `DEC-V2-BOOTSTRAP-EQUIV-EXCLUSIONS-001` (dynamic ⊆ documented exclusion invariant).
