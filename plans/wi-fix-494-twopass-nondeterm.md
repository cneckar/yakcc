# WI-FIX-494-TWOPASS-NONDETERM — Two-pass equivalence: proof-manifest non-determinism

**Status:** plan v3 (corrected — fixes the glob-pattern bug in v2's Fix E)
**Issue:** #494
**Branch (in-progress fix):** `feature/wi-fix-494-twopass-nondeterm` (worktree `.worktrees/wi-fix-494`)
**This plan written in:** worktree `.worktrees/wi-fix-494` (same branch — orchestrator instruction)

---

## 0. What changed v2 → v3 (read this first)

v2 correctly identified the root cause (proof-manifest artifact-path non-determinism
from un-reconstructed `*.props.ts` siblings). **But v2's Fix E proposed the glob
`"packages/*/src/**/*.props.ts"` — that pattern does not work.** The plumbing-glob
matcher (`bootstrap.ts:expandPlumbingGlob`, lines 561-615) supports **single-segment
`*` wildcards only** — each `*` compiles to the regex `[^/]*`. There is no `**`
recursive support. A `**` segment compiles to `[^/]*` and matches a literal directory
named `**`, which does not exist, so the glob expands to **zero files** and the fix
silently does nothing.

v3 corrects Fix E to use two literal-depth single-segment patterns. Everything else
in v2 (root cause, Fixes A-D disposition, eval contract) was correct and is carried
forward, re-verified below.

---

## 1. Root cause (H2 — confirmed by direct registry byte-diff)

**The 45 divergent block-merkle-roots are ordinary `L0` functions shaved from yakcc's
own source whose `proof_manifest_json.artifacts[].path` depends on the filesystem
presence of a sibling `*.props.ts` file. `compile-self` does not materialise those
sibling files into the recompiled workspace, so pass-2 produces a different proof
manifest, a different proof root, and a different block merkle root.**

`block_merkle_root = hash(spec_hash ‖ impl_hash ‖ proof_root)`. spec + impl are
byte-identical between passes; the entire divergence is the proof manifest's artifact
`path` field.

### Evidence (direct byte-diff of the two registries — re-verified for v3)

Registries: `bootstrap/yakcc.registry.sqlite` (pass 1, registry A) and
`tmp/two-pass/registry-B.sqlite` (pass 2, registry B). Joined on `canonical_ast_hash`.

```
blocks A: 2889  B: 2887  common: 2887  divergent merkle: 45
divergent by source_pkg: shave×12, contracts×11, federation×8,
                         variance×4, registry×4, ir×3, compile×3
divergent by level: L0×45  (zero seed atoms)
```

For all 3 sampled divergent atoms (`registry/src/discovery-eval-helpers.ts`,
`contracts/src/merkle.ts`, `federation/src/pull.ts`):

| field | pass 1 vs pass 2 |
|---|---|
| `spec_hash` | **same** |
| `spec_canonical_bytes` | **same** (byte-identical) |
| `impl_source` | **same** (byte-identical) |
| `proof_manifest_json` | **DIFFERS** |

The single differing field:
- Pass 1: `{"artifacts":[{"kind":"property_tests","path":"blockMerkleRoot.props.ts"}]}`
- Pass 2: `{"artifacts":[{"kind":"property_tests","path":"property-tests.fast-check.ts"}]}`

Pass 1 derives a bespoke `<fnName>.props.ts` path because the sibling props file is on
disk; pass 2 falls through to the generic `property-tests.fast-check.ts` corpus path
because the sibling props file is absent.

### Mechanism (confirmed)

1. yakcc source ships **73** hand-authored sibling `*.props.ts` files next to source
   files, all under `packages/*/src/` at exactly two depths:
   - depth 0: `packages/*/src/*.props.ts` (e.g. `contracts/src/merkle.props.ts`)
   - depth 1: `packages/*/src/*/*.props.ts` (e.g. `shave/src/cache/key.props.ts`)
   No `*.props.ts` file lives outside `src/` or deeper than depth 1.
   (Verified: `find packages -name '*.props.ts'` — 73 files, all matching the above.)
2. `packages/cli/src/commands/bootstrap.ts:200` **explicitly skips** `*.props.ts` from
   shaving: *"hand-authored property-test corpus files … consumed as corpus by the
   shave pipeline when processing the sibling source file; they must not be shaved
   themselves."* So props files are never atoms — they are corpus inputs.
3. `packages/shave/src/corpus/index.ts` documents them as the highest-priority
   optional corpus source (`Source (0): props-file`).
4. **Pass 1** shaves the original workspace → `merkle.props.ts` sits next to
   `merkle.ts` → the props-file corpus extractor sets the proof artifact `path` to the
   real sibling filename.
5. **Pass 2** shaves the recompiled workspace (`compile-self` output at
   `tmp/two-pass/dist-recompiled/`) → the `*.props.ts` siblings were **never
   reconstructed** there → the corpus chain falls through to a generic source → generic
   path `property-tests.fast-check.ts`.
   (Verified: `find tmp/two-pass/dist-recompiled/packages -name '*.props.ts'` → EMPTY.)
6. Different path → different proof_root → different merkle root → 45 divergent atoms.

The `5×9≈45` cardinality coincidence that drove v1's H1 (seed-atom sidecars) is just
that — a coincidence. None of the 45 divergent atoms is a seed atom.

---

## 2. Why the prior Fix A did not move the needle

Fix A (in the in-progress branch) added to `PLUMBING_INCLUDE_GLOBS`:
- `packages/*/src/blocks/*/spec.yak`
- `packages/*/src/blocks/*/proof/manifest.json`
- `packages/*/src/blocks/*/proof/tests.fast-check.ts`

`packages/*/src/blocks/*/` matches only `packages/seeds/src/blocks/` today. None of
those globs match `packages/contracts/src/merkle.props.ts`. The seed-atom triplet
sidecars Fix A added **are** now correctly reconstructed (verified: `lru-node`'s
`spec.yak` / `impl.ts` / `proof/manifest.json` are byte-identical between original and
recompiled). But that file class was never the cause. `divergent` stayed at exactly 45
because Fix A did not touch the file class that matters: `*.props.ts` siblings.

---

## 3. The corrected fix (v3)

### Approach: capture `*.props.ts` as workspace plumbing

Smallest blast radius; mirrors the proven Fix A mechanism; preserves the richer
per-file proof corpus. (The rejected alternative — making the props-file corpus
extractor's artifact path filesystem-independent — would change *every* corpus root
and needs its own plan. Documented in §6 as the rollback escalation.)

### Fix E — primary — `packages/cli/src/commands/plumbing-globs.ts`

Add to `PLUMBING_INCLUDE_GLOBS` **two single-segment glob patterns** (NOT a `**`
pattern — the matcher does not support `**`; see §0):

```ts
// *.props.ts hand-authored property-test corpus files (two literal depths).
"packages/*/src/*.props.ts",
"packages/*/src/*/*.props.ts",
```

These two patterns cover all 73 props files (depth 0 and depth 1 under `src/`).
Add a new `@decision DEC-V2-WORKSPACE-PLUMBING-PROPS-CORPUS-001` amending
`DEC-V2-WORKSPACE-PLUMBING-CAPTURE-001`. The rationale block must state:

- props files are **corpus inputs** to the shave pipeline's props-file extractor, not
  atoms — `bootstrap.ts:200` explicitly skips them from shaving, so capturing them as
  plumbing never conflicts with atom reconstruction (`compile-self`'s "TS source wins"
  rule never triggers because props files are never shaved).
- **Why two patterns, not `**`:** `expandPlumbingGlob` (`bootstrap.ts:561-615`)
  supports single-segment `*` only (each `*` → regex `[^/]*`). A `**` segment would
  match a literal directory named `**` and expand to zero files. All 73 `*.props.ts`
  files live at exactly two depths under `packages/*/src/`, so two literal-depth
  patterns are exhaustive. **If a future `*.props.ts` is added at depth ≥ 2, a third
  pattern must be added** — the T3c regression guard (Fix F) will catch this.

### Fix F — regression guard — `examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts`

Add `it("T3c: recompiled workspace contains every *.props.ts corpus file")` next to
the existing T3b. Recursively enumerate `*.props.ts` under `packages/*/src/` in
`REPO_ROOT`; for each, assert the same relative path exists under `DIST_RECOMPILED_DIR`.
Use the **recursive** walk for enumeration (so it catches a depth-2 props file that the
two glob patterns would miss — this is the guard for the "future depth" risk above).
New `@decision DEC-V2-HARNESS-PROPS-CORPUS-CHECK-001`. Same hard-fail precondition
pattern as T3b (throw on missing `registryAAvailable / reportAAvailable /
cliBinAvailable`).

Note: v2's plan said "extend Fix D / T3b". v3 keeps T3b unchanged (it correctly guards
the *seed-sidecar* invariant from Fix A) and adds a **separate** T3c for the props
corpus — they guard two distinct file classes and conflating them would muddy
diagnosis.

### Fix G — bootstrap regen — `bootstrap/{expected-roots.json,yakcc.registry.sqlite,report.json}`

Regenerate after Fix E lands. **Ordering is contract-critical:**

1. Edit `plumbing-globs.ts` (Fix E).
2. `pnpm -r build` — then verify `packages/cli/dist/commands/plumbing-globs.js` mtime
   advances past the source edit. Stale `dist/` is the exact trap that made the prior
   attempt unverifiable; the `.ts` edit MUST reach the compiled CLI.
3. `yakcc bootstrap` — regen `bootstrap/` artifacts. Expected: ~73 new
   `workspace_plumbing` rows; the 45 bespoke proof paths now reproduce in pass 2.
4. Add the T3c test (Fix F).
5. Run the eval contract (§5).

**Do NOT** touch `packages/seeds/`, `packages/shave/src/corpus/`, or any atom source.
The fix is confined to one glob list + one test + regenerated `bootstrap/` artifacts.

---

## 4. Disposition of prior Fixes A–D

| Fix | File | Disposition | Reason |
|---|---|---|---|
| **A** — seed-triplet sidecar globs | `plumbing-globs.ts` | **KEEP** | Harmless and arguably still correct — seed sidecars genuinely belong in plumbing, and they ARE now reconstructed byte-identically. Just was never *this* bug. |
| **B** — sort `readdir` in `expandPlumbingGlob` | `bootstrap.ts` | **KEEP** | Harmless defensive determinism hardening; aligns with the codebase's "sort before iterate" convention. |
| **C** — sort `readdir` in `copy-triplets.mjs` | `copy-triplets.mjs` | **KEEP** | Harmless defensive. |
| **D** — T3b seed-sidecar-presence test | `two-pass-equivalence.test.ts` | **KEEP (do NOT extend)** | T3b correctly guards the seed-sidecar invariant from Fix A and currently passes. v3 does **not** extend it — instead adds a **separate** T3c (Fix F) for the props-corpus file class. Two distinct invariants, two distinct tests, clearer diagnosis. |
| `bootstrap/expected-roots.json` regen (+7800 lines) | — | **RE-REGEN** | The in-progress regen captured Fix A's seed sidecars (not wasted). Must regen again after Fix E adds the `*.props.ts` plumbing rows. |

**Nothing is reverted.** The prior implementer's commit can be **amended** (or a fresh
commit stacked on top) — the corrected fix is purely additive: two corrected glob
lines + one new test + a re-regenerated `bootstrap/`.

The only correction to prior work is replacing v2's non-functional
`"packages/*/src/**/*.props.ts"` proposal with the two working single-segment patterns.

---

## 5. Scope manifest

**Files modified by this fix (additive on top of the in-progress branch):**
- `packages/cli/src/commands/plumbing-globs.ts` — 2 glob entries + 1 `@decision` block
- `examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts` — 1 new `it()` (T3c, ~60 lines)
- `bootstrap/expected-roots.json` — regenerated (grows ~73 plumbing-derived entries)
- `bootstrap/yakcc.registry.sqlite` — regenerated
- `bootstrap/report.json` — regenerated

**Files explicitly NOT touched:** anything under `packages/seeds/`, `packages/shave/`,
`packages/contracts/`, `packages/compile/`, `packages/registry/`, `packages/ir/`,
`packages/variance/`, `packages/federation/`; `compile-self.ts`; the in-progress
Fixes A/B/C/D source (kept as-is).

**Integration points verified independently by implementer / tester / guardian:**
- `PLUMBING_INCLUDE_GLOBS` → consumed by `bootstrap.ts:expandPlumbingGlob` → after
  regen, `workspace_plumbing` must contain ~73 `*.props.ts` rows. (Dry-run: log the
  expansion of the two new globs before regen — must be 73 paths, not 0.)
- `compile-self` materialises every `workspace_plumbing` row → `dist-recompiled/` must
  then contain the `.props.ts` files.
- `shave/src/corpus` props-file extractor reads them during pass-2 → pass-2
  `proof_manifest_json` must match pass-1 for the 45 blocks.

---

## 6. Evaluation contract

**Primary (pass/fail gate):**
```
YAKCC_TWO_PASS=1 pnpm --filter @yakcc/v2-self-shave-poc test
```
must print:
```
[two-pass] BYTE-IDENTITY: PASS | S1=N S3=N included=N excluded=0..2 | divergent=0
✓ T3: every included blockMerkleRoot from S1 exists byte-identically in S3
```
- **`divergent=0` is the hard gate** — honours `DEC-V2-HARNESS-STRICT-EQUALITY-001`;
  the invariant is NOT relaxed.
- `S1 === S3` expected once the props files are captured and pass-2 regenerates them.
  Any small residual asymmetry must be fully inside the `excluded` failure-set, never
  in `divergent`.

**Secondary (faster diagnosis):**
- `T3c` passes: every `*.props.ts` present in `dist-recompiled/`.
- `T3b` still passes (seed sidecars — Fix A regression guard, unchanged).

**Forbidden shortcuts:**
- FS-1: NEVER relax the `divergent` assertion threshold above 0.
- FS-2: NEVER add `*.props.ts` paths to the test's exclusion set to mask divergence.
- FS-3: NEVER edit the props-file corpus extractor to hardcode the generic path just
  to make passes agree (out of scope — would change every corpus root).
- FS-4: NEVER skip the `pnpm -r build` before `yakcc bootstrap` — stale `dist/` is the
  exact trap that made the prior attempt unverifiable.
- FS-5: NEVER use a `**` segment in a `PLUMBING_INCLUDE_GLOBS` pattern — the matcher
  silently expands it to zero files. Single-segment `*` only.

---

## 7. Risk / rollback

| Risk | Likelihood | Mitigation |
|---|---|---|
| **`**` glob silently no-ops** (the v2 bug) | — | **Fixed in v3:** two single-segment patterns, FS-5 forbids `**`, and the dry-run expansion check (§5) catches a zero-match glob before regen. |
| `*.props.ts` glob also matches `*.props.test.ts` | None | No `*.props.test.ts` files exist; and the regex `^…\.props\.ts$` is anchored — `foo.props.test.ts` does not end in `.props.ts`. |
| A future `*.props.ts` added at depth ≥ 2 under `src/` | Low | The two patterns would miss it. T3c (Fix F) uses a **recursive** enumeration and would fail loudly, naming the missed file. Mitigation documented in Fix E's `@decision`. |
| Props files reference helper imports absent in recompiled workspace | None | Props files are corpus **bytes**, hashed verbatim; never compiled during shave. Only their content hash feeds the merkle root. |
| Bootstrap regen produces a *different* set of divergent roots (a second axis) | Low | If `divergent` → 0, done. If it drops but is non-zero, the residual is a new axis → new WI, not this one. |
| **Blast radius on main:** does adding `*.props.ts` to plumbing change any existing merkle roots on `main`? | Low — call out | It should **not** change pass-1: the original workspace already has every `*.props.ts` on disk, so pass-1 `proof_manifest_json` values are unchanged. It changes only pass-2 reconstruction (the recompiled workspace gains the 73 files it was missing). The `bootstrap/` regen adds ~73 `workspace_plumbing` rows but should not alter any existing `blocks`-table `block_merkle_root`. **The implementer must verify this explicitly:** after regen, diff the `blocks` table of the new `bootstrap/yakcc.registry.sqlite` against the pre-fix one — only `workspace_plumbing` rows should differ; zero `block_merkle_root` changes. If any merkle root changes, STOP and escalate. |
| Stale `dist/` makes the regen use old globs | Medium | FS-4 forbids it; §3 step 2 mandates an mtime check on `plumbing-globs.js`. |

**Rollback boundary:** revert Fix E's 2 glob lines + Fix F's `it()` + restore the
`bootstrap/` artifacts from the prior commit. The in-progress Fixes A–D are independent
and stay. If capture-as-plumbing proves insufficient, escalate to the
filesystem-independent corpus-path approach as a new planner cycle — that path changes
every corpus root and needs its own plan + full `expected-roots` regen.

**Decisions emitted:** `DEC-V2-WORKSPACE-PLUMBING-PROPS-CORPUS-001`,
`DEC-V2-HARNESS-PROPS-CORPUS-CHECK-001`. (The in-progress branch's
`DEC-V2-WORKSPACE-PLUMBING-SEED-TRIPLETS-001`,
`DEC-V2-PLUMBING-WALK-DETERMINISM-001`,
`DEC-V2-HARNESS-SEED-SIDECAR-CHECK-001` remain valid — Fixes A/B/D are kept.)

---

## 8. Open questions for implementer

- **Q1 (RESOLVED):** Does bootstrap shave `*.props.ts` as atoms? **No** —
  `bootstrap.ts:200` explicitly skips them. Capturing as plumbing is safe.
- **Q2 (RESOLVED for this fix):** Are all `*.props.ts` files within the two literal
  depths the patterns cover? **Yes** — all 73 are at `packages/*/src/*.props.ts` or
  `packages/*/src/*/*.props.ts`. T3c's recursive walk guards against future drift.
- **Q3 (OPEN — follow-up only):** Do other corpus extractors
  (`upstream-test`, `documented-usage`, `ai-derived`) also emit filesystem-presence-
  dependent artifact paths? If so, their input sidecars are latent twin bugs. Grep
  before declaring done; file a **follow-up WI** if found — do **not** expand this
  fix's scope.
