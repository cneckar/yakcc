# WI-FIX-551 — Two-pass T3 byte-identity: imperfect compile-self reconstruction (82 divergent roots)

- **Workflow ID:** `wi-fix-551-twopass-compile-self-reconstruction`
- **Goal ID:** `g-fix-551-compile-self`
- **GitHub issue:** [#551](https://github.com/cneckar/yakcc/issues/551)
- **Branch (proposed):** `feature/wi-fix-551-twopass-compile-self-reconstruction`
- **Base:** `main`
- **Cross-references:** #494 (origin), #545 (props-files class, CLOSED via #552), #543 (BOM strip, CLOSED via #556), #355 (block_occurrences schema v9), #333 (glue capture).

## 1. Origin and Context

This is the **third regression** in the campaign to bring the two-pass T3 byte-identity test green:

| Class | Roots | Status |
|---|---|---|
| `*.props.ts` plumbing globs | 45-46 | CLOSED (#552, Fix E) |
| `import-intercept.ts` UTF-8 BOM strip | 1 file / 1057 informational gap rows | CLOSED (#556, `TextDecoder ignoreBOM:true`) |
| **Imperfect compile-self reconstruction** | **82 roots in 10 files** | **THIS** |

After this lands, the two-pass T3 byte-identity test (`examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts`) should report `divergent=0`.

## 2. Investigation Findings (Planner-side, evidence-backed)

The issue body hypothesizes "AST round-trip lost trivia (comments, formatting), restructured certain expressions, or substituted decoration." Planner-side investigation against the cached two-pass artifacts in `.worktrees/wi-fix-545-twopass-validator/tmp/two-pass/` partially contradicts that hypothesis. Findings:

### 2.1 Cached pass-2 artifacts are available

Cached pass-2 artifacts exist at:

- `tmp/two-pass/registry-B.sqlite` — pass-2 registry
- `tmp/two-pass/report-B.json` — pass-2 per-file outcomes
- `tmp/two-pass/dist-recompiled/` — reconstructed workspace from compile-self
- `tmp/two-pass/expected-roots-B.json` — pass-2 manifest

These let the implementer characterize the divergence without re-running a fresh 60-min two-pass bootstrap. **Use them first** before regenerating.

### 2.2 The "reconstruction gap" is not a single-class mechanism

| Source file | #551 roots | Bytes canon | Bytes recon | CRLF canon → LF recon? | Byte-identical? |
|---|---|---|---|---|---|
| `packages/registry/src/index.ts` | 29 | 52143 | 51009 | Yes (diff=1134 lines) | No |
| `packages/registry/src/storage.ts` | 17 | 92856 | 92856 | n/a | **Yes** |
| `packages/shave/src/intent/static-extract.ts` | 13 | 7822 | 7822 | n/a | **Yes** |
| `packages/shave/src/errors.ts` | 6 | 5462 | 5462 | n/a | **Yes** |
| `packages/contracts/src/source-extract.ts` | 6 | 18629 | 18629 | n/a | **Yes** |
| `packages/cli/src/commands/compile.ts` | NOT in 82 | 6532 | 6363 | Yes (diff=169 lines) | No |
| `packages/contracts/src/canonicalize.ts` | NOT in 82 | 16395 | 16003 | Yes (diff=392 lines) | No |

Two surprising observations from the cached artifacts:

1. **Several "divergent" files reconstruct byte-identically** (`storage.ts`, `errors.ts`, `static-extract.ts`, `source-extract.ts`). The 82 divergent roots in those files therefore are **not** caused by compile-self emitting different bytes — they're caused by the **shave pipeline producing different `BlockMerkleRoot`s for byte-identical input** in pass 2 vs pass 1, *or* by an upstream divergence in plumbing/environment (e.g., `tsconfig.json` resolution from the recompiled workspace).
2. **`registry/src/index.ts` reconstructs with line endings stripped** (CRLF canonical → LF recon). The same is true of `compile.ts` and `canonicalize.ts`, which are **not** in the 82-root list. So CRLF→LF normalization happens broadly during reconstruction (probably in `bootstrap.captureSourceFileGlue` reading the file with Node's text-mode `readFile(p, "utf-8")` which on Windows preserves CRLF byte-for-byte, but the shave atom-extraction may be normalizing line endings in `implSource`), yet it only triggers atom-merkle divergence on a subset.

Therefore the issue's framing — "imperfect compile-self reconstruction" — is partially wrong. The 82 divergent roots are a **superposition** of at least two mechanisms:

- **Mechanism α — Line-ending or trivia normalization disagreement:** Some atom subset produces different `canonicalAstHash` / `blockMerkleRoot` because the AST canonicalizer (or pre-AST text normalization) sees a different normalized form on pass 2 than on pass 1. Files where canonical was CRLF and recompiled is LF (or vice versa) trigger this if the canonicalizer is not line-ending-stable. This explains `registry/src/index.ts`'s 29 divergent roots.
- **Mechanism β — Pass-2 environment difference for byte-identical files:** Files that reconstruct byte-identically yet produce divergent atoms must be diverging because of something *outside the reconstructed file*. Candidates: differing `tsconfig.json` / `package.json` plumbing in `dist-recompiled/`, different working-directory paths affecting import-spec resolution, missing sidecar files the shave pipeline cross-references, or different intent-card aggregation due to which adjacent files were emitted into the recompiled workspace.

### 2.3 The committed `bootstrap/yakcc.registry.sqlite` is pre-v9 / unpopulated

Direct registry inspection shows `block_occurrences=0`, `source_file_glue=0`, `blocks.source_file IS NULL` for all 2132 atoms. **The committed registry cannot drive a successful compile-self today** — it produces 2132 null-provenance gap rows. The implementer MUST run a fresh `yakcc bootstrap` before they can run compile-self locally. The cached pass-1 outcomes are in `bootstrap/report.json` (which DOES exist and is current).

## 3. Required Investigation by the Implementer (Phase 1)

Before writing any code, the implementer must answer these questions with measured evidence:

1. **Re-run a fresh `yakcc bootstrap`** into a scratch registry under `tmp/wi-551/` to populate provenance. (Required because the committed registry is unpopulated. Wall-time: ~5-15 min.)
2. **Re-run `compile-self`** against the fresh registry. Diff `dist-recompiled/packages/registry/src/index.ts` vs canonical with `cmp -l` to identify the exact divergence bytes for the CRLF case.
3. **Re-run the second bootstrap pass** (or reuse `.worktrees/wi-fix-545-twopass-validator/tmp/two-pass/registry-B.sqlite` if its schema is current) to get registry B.
4. **Compute `rootsA \ rootsB`** and verify the count is 82 (the issue's claim) on current main. If the count differs, recharacterize the cohort before proceeding.
5. **Bucket the 82 divergent roots by mechanism:**
   - α-class: source files where canonical and recon differ in bytes (line endings or otherwise). Count and list.
   - β-class: source files where canonical and recon are byte-identical yet atoms diverge. Count and list.
   - Other: any unanticipated cohort.
6. **For α-class**, identify the source of the line-ending mismatch:
   - Does `bootstrap.captureSourceFileGlue` read the file in a way that preserves CRLF byte sequences? (It uses `readFileSync(path, "utf-8")`, which preserves bytes; LF-normalization would only happen if the shave pipeline re-reads via a different path or if `TextEncoder.encode(string).join` is applied to a stripped string.)
   - Where does the CR strip actually occur? Bisect: (a) the file the shave pipeline reads on pass 1, (b) what gets stored as `implSource` and glue, (c) what compile-self emits, (d) what pass-2 shave reads.
7. **For β-class**, identify the upstream divergence:
   - Compare the `dist-recompiled/` workspace's `tsconfig.json` / `package.json` resolution against canonical for one β-class file.
   - Compare the surrounding files in `dist-recompiled/` to canonical (a missing or different sibling file can cascade into different intent-card aggregation).
   - Check whether `plumbing` capture missed a file that participates in the atom's spec.
8. **Decide the fix locus based on the cohort sizes:**
   - If α dominates (e.g., >70% of 82 roots): fix is line-ending normalization. Two options:
     - (a-1) Make the AST canonicalizer / merkle path line-ending-agnostic (canonicalize all `\r\n` → `\n` before AST hash).
     - (a-2) Make compile-self preserve the original line-ending style per file (capture line-ending style at bootstrap time, replay at compile-self time).
     - Option (a-1) is structurally cheaper (one-time normalization at hash time) and matches typical TS toolchains. Option (a-2) requires schema change.
   - If β dominates: fix is in the shave pipeline's environment-handling or in compile-self plumbing completeness. Surface this to the operator before proceeding — it may be a deeper bug requiring its own slice.
   - If split: address α in this slice and **file a follow-up issue** for β. Operator-visible decision required for split.

## 4. Decision Log

### Proposed DEC-WI551-001 — Investigate-then-decide-fix-locus (planner-set)

```
@decision DEC-WI551-001
@title Investigate the 82-root divergence cohort empirically before choosing the fix locus
@status proposed (planner emission; implementer confirms or refutes during Phase 1)
@rationale
  Issue #551's hypothesis ("imperfect compile-self reconstruction") is incomplete.
  Evidence from cached two-pass artifacts shows that 4+ of the 10 affected source
  files reconstruct byte-identically, which means compile-self emission is not the
  divergence locus for those files. The fix locus is therefore EITHER:
    (a) AST canonicalizer / merkle path normalization (treat α-class as the root)
    (b) shave-pipeline environment handling (treat β-class as the root)
    (c) both — split into separate slices
  The implementer must measure the α/β cohort split in Phase 1 and propose the
  fix locus before writing any code. The operator approves the split-or-single
  fix decision via the implementer's Phase 1 evidence report.
@evidence-required
  - Bucket count of α (byte-diverging) vs β (byte-identical) roots over the 82-root cohort
  - First-differing-byte localization for at least 3 α-class files
  - sibling-file diff for at least 2 β-class files
@routing
  After Phase 1 evidence is collected, implementer either:
    - proceeds to fix the dominant class (α or β) in this slice; or
    - sets REVIEW_VERDICT=blocked_by_plan with the Phase 1 evidence and routes
      back to planner for a split-slice decision.
```

### Proposed DEC-WI551-002 — Strict T3 acceptance (no carve-out)

```
@decision DEC-WI551-002
@title Acceptance bar is divergent=0 on the strict T3 invariant; no narrow carve-out
@status proposed (planner emission)
@rationale
  Operator preference (memory feedback_pr_not_guardian_merge, feedback_eval_contract_match_ci_checks)
  consistently favors fidelity over carve-outs. The strict S1≡S3 byte-identity
  invariant is load-bearing for the two-pass crown-jewel proof and any tolerance
  widening here weakens that proof.
  Option (c) from #551's investigation paths ("exclude these files from T3 byte-identity")
  is REJECTED at the planner level. If the implementer's Phase 1 evidence shows
  that fidelity is unreachable in this slice, the implementer must escalate to the
  operator with that finding rather than carve out.
```

## 5. Wave Decomposition

| W-ID | Item | Weight | Gate | Deps | Integration |
|---|---|---|---|---|---|
| W1 | Phase 1 investigation: bootstrap fresh registry, run compile-self, bucket α/β cohort, produce evidence brief | M | review | none | `tmp/wi-551/` scratch artifacts |
| W2 | Implement fix for dominant cohort (α or β) | M-L | review | W1 | Determined by W1 (one of: `packages/contracts/src/canonical-ast.ts`, `packages/contracts/src/canonicalize.ts`, `packages/shave/src/`, `packages/cli/src/commands/compile-self.ts`, `packages/cli/src/commands/bootstrap.ts`) |
| W3 | Regression unit tests proving the fix | S | review | W2 | Co-located with W2's primary file |
| W4 | Run full two-pass T3 cycle (`YAKCC_TWO_PASS=1`); confirm `divergent=0` | M (60-70 min wall-time) | review | W2, W3 | `examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts` |
| W5 | Workspace-scope `pnpm lint` + `pnpm typecheck` (NOT package-scoped) | S | review | W2 | n/a |
| W6 | PR open, CI green, Guardian land | S | approve | W4, W5 | n/a |

**Critical path:** W1 → W2 → W3 → W4 → W5 → W6. No parallelism is safe before W1 names the locus.

## 6. State-Authority Map

| Domain | Canonical authority | Touched by this WI? |
|---|---|---|
| Atom merkle root identity | `packages/contracts/src/merkle.ts` (`blockMerkleRoot()`) | Possibly (α-class fix) |
| Canonical AST hash | `packages/contracts/src/canonical-ast.ts` (`canonicalAstHash()`) | Possibly (α-class fix) |
| Source-text canonicalization | `packages/contracts/src/canonicalize.ts` | Possibly (α-class fix) |
| Source-file glue capture | `packages/cli/src/commands/bootstrap.ts:captureSourceFileGlue` + `computeGlueBlob` | Possibly (line-ending preservation fix) |
| Compile-self reconstruction emit | `packages/cli/src/commands/compile-self.ts:_runPipeline` (writeFileSync output path) | Possibly (line-ending fix) |
| Shave atom extraction | `packages/shave/src/` (extracts atoms from .ts source) | Possibly (β-class fix) |
| Workspace plumbing glob authority | `packages/cli/src/commands/plumbing-globs.ts` (DEC-V2-WORKSPACE-PLUMBING-PROPS-CORPUS-001) | Possibly (if β-class needs a missing-file plumbing addition) |
| Two-pass test harness | `examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts` | NO (do not modify the harness; it is the acceptance authority) |
| Block_occurrences schema | `packages/registry/src/storage.ts` (schema v9) | NO |

## 7. Forbidden Shortcuts (planner-enforced; reviewer must check)

- **FS1:** Do NOT widen the T3 byte-identity tolerance, comment-out divergent-root assertions, or weaken `expect(divergentRoots).toHaveLength(0)`.
- **FS2:** Do NOT add a documented carve-out for the 10 affected files unless the operator explicitly authorizes it after seeing the Phase 1 evidence brief (DEC-WI551-002).
- **FS3:** Do NOT introduce a parallel reconstruction code path (e.g., "old compile-self + new compile-self"). Single-source-of-truth replacement only (Sacred Practice #12).
- **FS4:** Do NOT shortcut the second bootstrap pass; the acceptance proof is the full two-pass T3 run.
- **FS5:** Do NOT modify `examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts` or any of `bootstrap/report.json`, `bootstrap/expected-roots.json`, `bootstrap/yakcc.registry.sqlite`.
- **FS6:** Do NOT scope `pnpm lint` / `pnpm typecheck` to a single package — must be workspace-wide (memory: `feedback_eval_contract_match_ci_checks`).
- **FS7:** Do NOT silently regenerate `bootstrap/yakcc.registry.sqlite` as part of this slice. The committed registry is a documented input; regeneration is out of scope.

## 8. Evaluation Contract

### Required tests

1. `YAKCC_TWO_PASS=1 pnpm --filter v2-self-shave-poc test two-pass-equivalence` reports the summary line `[two-pass] BYTE-IDENTITY: PASS | S1=<n> S3=<n> included=<m> excluded=<k> | divergent=0` on the implementer's HEAD.
2. The included-roots count `m` must be at least the post-#556 baseline (the implementer captures this in W1 and locks it as the floor — i.e., the fix must not exclude additional files to reach divergent=0).
3. Workspace-wide `pnpm lint` (no `--filter`) exits 0.
4. Workspace-wide `pnpm typecheck` (no `--filter`) exits 0.
5. Whatever unit/integration tests exercise the modified module(s) must pass. At minimum: `pnpm --filter @yakcc/cli test compile-self`, `pnpm --filter @yakcc/contracts test`, and any tests under `packages/shave/` that touch atom extraction.
6. Regression unit test(s) proving the chosen fix: e.g., an AST-canonicalizer test asserting CRLF and LF input produce the same `canonicalAstHash` (if α-class fix chosen); or a compile-self test asserting reconstructed line endings match canonical (if line-ending-preservation fix chosen); or a shave-pipeline test asserting byte-identical input from two workspace roots produces identical atom merkle roots (if β-class fix chosen).

### Required evidence

- **Before-fix metric** (captured in W1): `divergent=82` (or whatever the current value is on current main; the implementer must measure it, not assume 82). The Phase 1 evidence brief includes the α/β cohort split.
- **After-fix metric** (captured in W4): `divergent=0` in the T3 summary line; full T3 line pasted verbatim into the PR description.
- **Two-pass wall-time:** report the actual wall-time of the full T3 run in the PR description (expected ~60-70 min).
- **First-differing-byte localization** for ≥3 α-class files (captured in W1) appears in the PR description.
- **Sibling-file diff** for ≥2 β-class files (captured in W1) appears in the PR description.

### Required real-path checks

- After the fix, for every file in the original 10-file affected set, the `dist-recompiled/<file>` either:
  - byte-matches canonical (preferred), OR
  - is documented as intentionally normalized AND the canonicalizer is line-ending-stable, AND the file's atoms appear byte-identically in registry B (i.e., merkle roots match).
- `manifest.json` in `dist-recompiled/` contains entries for all 10 affected files.

### Required authority invariants

- The compile-self reconstruction pipeline has exactly one canonical authority (no parallel "old + new" paths shipped together) — Sacred Practice #12.
- The AST canonicalizer / merkle path remains the single authority for atom identity; no shadow normalization paths.
- No new state authority is introduced (no new SQLite table, no new flat-file index, no new env-var override).

### Required integration points

- Atom extraction (shave) and compile-self emit must agree on line-ending handling: either both preserve, or both normalize. Mixed semantics are a bug.
- `block_occurrences` rows produced on pass 1 must match (`block_merkle_root`-wise) the rows produced on pass 2 for every file the implementer's fix touches.
- The `bootstrap/report.json` schema is unchanged.

### Forbidden shortcuts

See §7 above (FS1-FS7); reviewer must verify each.

### Rollback boundary

The PR is a single logical change reversible by reverting the merge commit. No DB migrations, no new schema versions, no in-place edits to `bootstrap/yakcc.registry.sqlite` are allowed.

### Acceptance notes

- The chosen fix locus is annotated as a `@decision DEC-WI551-NNN` at the implementation site with cross-reference to issue #551.
- The implementer's Phase 1 evidence brief is captured in the PR description (not in a separate scratch file that will be lost).
- DEC-WI551-001 transitions from "proposed" to "accepted (option α / β / α+β-split)" with rationale.

### Ready-for-Guardian definition

- All required tests pass on HEAD.
- The PR description contains the T3 summary line showing `divergent=0`.
- The Phase 1 cohort-split evidence is in the PR description.
- The chosen fix locus is annotated at the implementation site.
- Reviewer issues `REVIEW_VERDICT=ready_for_guardian` after verifying §7 forbidden shortcuts and §8 evaluation contract.

## 9. Scope Manifest

### Allowed paths

The implementer may modify files under any of:

- `packages/contracts/src/canonical-ast.ts`
- `packages/contracts/src/canonicalize.ts`
- `packages/contracts/src/merkle.ts`
- `packages/contracts/src/source-extract.ts`
- `packages/shave/src/` (atom extraction code, excluding tests)
- `packages/cli/src/commands/compile-self.ts`
- `packages/cli/src/commands/bootstrap.ts` (only `captureSourceFileGlue`, `computeGlueBlob`, or sibling helpers)
- `packages/cli/src/commands/plumbing-globs.ts` (only if β-class evidence requires a plumbing glob addition)
- Co-located test files under `packages/*/src/` and `packages/*/test/`
- This plan file: `plans/wi-fix-551-twopass-compile-self-reconstruction.md`
- Scratchlane: `tmp/wi-551/**` (investigation artifacts, not committed)

### Required paths

At minimum, the implementer must touch:

- The implementation file selected by Phase 1 evidence (one of the allowed paths above)
- A co-located regression test file (new or amended)
- This plan file's Decision Log (transitions DEC-WI551-001 from "proposed" to "accepted (...)" with rationale)

### Forbidden paths

- `MASTER_PLAN.md` — governance file; planner-context edits historically blocked by hooks; out of scope.
- `bootstrap/yakcc.registry.sqlite` — input artifact, regenerating it is out of scope.
- `bootstrap/expected-roots.json` — monotonic accumulator; out of scope.
- `bootstrap/report.json` — pass-1 outcome record; do not regenerate as part of this slice.
- `examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts` — acceptance authority; do not weaken.
- Any file under `examples/v1-*` (unrelated).
- Any file under `bench/` (unrelated).
- Any other `plans/wi-*.md` file.
- Any `.worktrees/` content (those are other workflows' working trees).

### State authorities touched (expected; refine in W1)

- Possibly: atom merkle root identity (via canonicalizer change)
- Possibly: compile-self reconstruction (via line-ending preservation change)
- Possibly: shave atom extraction (via environment-handling change)
- Definitely NOT: registry schema, plumbing schema, two-pass test harness, evaluation runtime.

## 10. Dispatch / Continuation

After this plan is approved, the next canonical stage is `guardian:provision` to create `feature/wi-fix-551-twopass-compile-self-reconstruction` worktree from `main`. The implementer is then dispatched with this Evaluation Contract and Scope Manifest as the dispatch contract.

The implementer must produce a Phase 1 evidence brief before writing the fix. If Phase 1 evidence reveals a fix locus the operator must adjudicate (e.g., α+β-split, or a missing schema change), the implementer routes back to planner with `REVIEW_VERDICT=blocked_by_plan`.

## Appendix A — Quick Reference Commands

```bash
# Fresh bootstrap for investigation (run inside the implementer worktree)
node packages/cli/dist/bin.js bootstrap \
  --registry tmp/wi-551/registry-A.sqlite \
  --manifest tmp/wi-551/expected-roots-A.json \
  --report tmp/wi-551/report-A.json

# Recompile from the fresh registry
mkdir -p tmp/wi-551/dist-recompiled
node packages/cli/dist/bin.js compile-self \
  --registry tmp/wi-551/registry-A.sqlite \
  --output tmp/wi-551/dist-recompiled

# Compare canonical vs reconstructed for one divergent file (CRLF check)
cmp -l packages/registry/src/index.ts tmp/wi-551/dist-recompiled/packages/registry/src/index.ts | head -20

# Run the full two-pass acceptance harness (60-70 min)
YAKCC_TWO_PASS=1 pnpm --filter v2-self-shave-poc test two-pass-equivalence

# Workspace-wide gates (after the fix)
pnpm lint
pnpm typecheck
```

## Appendix B — Planner Investigation Evidence (already collected)

- `tmp/two-pass/dist-recompiled/packages/registry/src/index.ts` from cached `wi-fix-545-twopass-validator` worktree: 51009 bytes, LF line endings. Canonical: 52143 bytes, CRLF. Difference: 1134 bytes == 1134 lines == 1 stripped CR per line.
- `tmp/two-pass/dist-recompiled/packages/registry/src/storage.ts`: 92856 bytes, byte-identical to canonical. Yet `storage.ts` is listed as having 17 divergent atoms in #551. **Mechanism for these atoms is NOT compile-self emission.**
- `bootstrap/yakcc.registry.sqlite` (committed): schema v10, 2132 blocks, but `block_occurrences=0` and all `blocks.source_file IS NULL`. **A fresh `yakcc bootstrap` run is required before compile-self can produce non-null-provenance output.** The implementer's W1 must do this.
