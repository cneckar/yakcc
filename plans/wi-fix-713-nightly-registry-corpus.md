# wi-fix-713-nightly-registry-corpus

**Issue:** [#713 — Nightly CI failure — 2026-05-18](https://github.com/cneckar/yakcc/issues/713)
**Workflow id:** `fix-713-nightly-registry-corpus`
**Goal id:** `g-fix-713-nightly-registry-corpus`
**Work item id:** `fix-713-nightly-registry-corpus-impl`
**Branch:** `feature/fix-713-nightly-registry-corpus` (off `main` at `39c1c75`)
**Status:** planner-emitted, awaiting implementer dispatch.

---

## 1. Problem statement (concrete, file:line)

Nightly CI run `26013525563` (2026-05-18, the 5th consecutive nightly red — 5/14 → 5/18) failed in the `pnpm -r test` job at:

```
packages/registry/src/discovery-eval-full-corpus.test.ts:858:34
  src/discovery-eval-full-corpus.test.ts > discovery-eval-full-corpus —
  corpus schema correctness >
  synthetic-tasks entries have null expectedAtom and no expectedAtomName
AssertionError: expected 'bcryptjs-hash' to be undefined
  - Expected: undefined
  + Received: "bcryptjs-hash"
```

The asserting test (lines 853–860 of `packages/registry/src/discovery-eval-full-corpus.test.ts`):

```ts
it("synthetic-tasks entries have null expectedAtom and no expectedAtomName", () => {
  const entries = loadCorpus();
  const synthetic = entries.filter((e) => e.source === "synthetic-tasks");
  for (const e of synthetic) {
    expect(e.expectedAtom).toBeNull();
    expect(e.expectedAtomName).toBeUndefined();  // ← line 858, failing
  }
});
```

## 2. Root cause

The data source is `packages/registry/test/discovery-benchmark/corpus.json`. Of 33 `synthetic-tasks` entries, exactly **two** violate the invariant:

| Entry id (corpus.json line) | `source` | `expectedAtom` | `expectedAtomName` (offending) |
|---|---|---|---|
| `cat1-bcryptjs-hash-001` (line 930) | `synthetic-tasks` | `null` | `"bcryptjs-hash"` |
| `cat1-bcryptjs-verify-001` (line 941) | `synthetic-tasks` | `null` | `"bcryptjs-verify"` |

Both entries were appended by **WI-510 Slice 6** (PR landed at commit listed in `plans/wi-510-s6-jsonwebtoken-bcrypt.md`). The slice's plan explicitly states the intent:

- `plans/wi-510-s6-jsonwebtoken-bcrypt.md` line 364: *"Slice 6 appends **five** new `synthetic-tasks` entries"*
- Same file line 419: *"`corpus.json` carries exactly the five appended `synthetic-tasks` entries (`expectedAtom: null`)"*
- Each offending entry's own `rationale` text ends with: *"synthetic-tasks, expectedAtom:null, combinedScore >= 0.70 gated in bcryptjs-headline-bindings.test.ts section F."*

The same slice appended three jsonwebtoken entries (`cat1-jsonwebtoken-verify-001`, `cat1-jsonwebtoken-decode-base64url-001`, `cat1-jsonwebtoken-parse-jose-header-001`) that correctly carry **no** `expectedAtomName` field. The two bcryptjs entries were authored from a `seed-derived` template (e.g. the immediately-following `cat1-lodash-cloneDeep-001` at line 952) and the author failed to strip `expectedAtomName` — a slice-authoring oversight that the test caught, exactly as designed.

### Authority for the invariant

The schema is canonical and documented in two places:

1. `packages/registry/test/discovery-benchmark/README.md` § "Entry Shape" (lines 52–63): *"`expectedAtomName` (optional): seed atom name, resolved at test time to a `BlockMerkleRoot` ... `expectedAtom`: always `null` in the committed file; filled in at test runtime for entries with `expectedAtomName`."*
2. `packages/registry/src/discovery-eval-full-corpus.test.ts` § `StratifiedEntry` doc (lines 169–174): *"Seed block directory name (e.g. \"ascii-char\"). ... **Absent for synthetic-tasks entries (expectedAtom remains null)**."*

Synthetic-tasks entries deliberately probe the no-match path (README lines 78–84) — they target functions **not** in the seed registry. No seed block exists at `packages/seeds/src/blocks/bcryptjs-hash/` or `bcryptjs-verify/`; the field is structurally meaningless on these rows.

### Secondary effect that goes away with this fix

`packages/registry/src/discovery-eval-full-corpus.test.ts` at lines 401 and 791 builds the set of `expectedAtomName` values and (a) tries to `computeSeedBlockRoot()` each and (b) tries to load the resulting seed block into the registry. With the offender entries present, the test issues two `console.warn("[full-corpus] Could not compute root for seed block 'bcryptjs-hash': ENOENT ...")` lines (and the same for `bcryptjs-verify`) and pointlessly attempts to load nonexistent seed blocks. Removing the field eliminates both spurious side effects — bonus correctness, no regression.

## 3. Chosen path (Path A — data fix)

### Path enumeration

| Path | Description | Verdict |
|---|---|---|
| **A. Data fix** | Remove the `expectedAtomName` field from the two offending corpus entries; the entries remain `synthetic-tasks` with `expectedAtom: null`. Single-file, two-edit data correction. | **SELECTED.** |
| B. Reclassification | Move the two entries from `synthetic-tasks` → `seed-derived` and add real `packages/seeds/src/blocks/bcryptjs-hash/` + `bcryptjs-verify/` triplets. | Rejected — fabricates seed-block authority for atoms that don't exist in the seed registry; contradicts WI-510-S6's stated intent that bcryptjs is a fixture (vendored under `packages/shave/src/__fixtures__/`), not a seed. |
| C. Invariant change | Loosen the test invariant to allow `expectedAtomName` on synthetic entries. | Rejected — the invariant matches the README's documented schema; loosening it requires a DEC that contradicts the corpus authoring methodology and silently weakens the negative-space test signal. |

### @decision rationale (in-file annotation will be the commit message; no `@decision` block required because this is a data correction that re-establishes — not redefines — the existing invariant)

> **Path A — data correction.** WI-510-S6's plan (`plans/wi-510-s6-jsonwebtoken-bcrypt.md` lines 364, 419) and per-entry rationale text both confirm bcryptjs entries are intended as `synthetic-tasks` with `expectedAtom: null`. The README schema (`packages/registry/test/discovery-benchmark/README.md` § "Entry Shape") and the test-file `StratifiedEntry` doc (lines 169–174) both prohibit `expectedAtomName` on synthetic entries. No seed block exists for `bcryptjs-hash` or `bcryptjs-verify` (`packages/seeds/src/blocks/` has no `bcrypt*` directory). The field is a slice-authoring oversight; removal restores invariant compliance without changing any documented contract.

## 4. Implementer task list (ordered, per-edit commit boundaries)

### Task 1 — single corpus.json edit (one commit)

Edit `packages/registry/test/discovery-benchmark/corpus.json` to remove the `"expectedAtomName": "..."` line from exactly these two entries:

1. **`cat1-bcryptjs-hash-001`** (currently at line 930). Before:
   ```json
   {
     "id": "cat1-bcryptjs-hash-001",
     "source": "synthetic-tasks",
     "category": "behavior-only",
     "query": {
       "behavior": "Compute a bcrypt password hash with a configurable cost factor producing a salted one-way hash for credential storage"
     },
     "expectedAtom": null,
     "expectedAtomName": "bcryptjs-hash",      // ← DELETE this line
     "rationale": "..."
   }
   ```
2. **`cat1-bcryptjs-verify-001`** (currently at line 941). Before:
   ```json
   {
     "id": "cat1-bcryptjs-verify-001",
     "source": "synthetic-tasks",
     "category": "behavior-only",
     "query": { ... },
     "expectedAtom": null,
     "expectedAtomName": "bcryptjs-verify",    // ← DELETE this line
     "rationale": "..."
   }
   ```

Do NOT modify the `rationale` text on either entry (it already correctly describes synthetic-tasks intent and is monotonic per README "Corpus Integrity"). Do NOT modify the trailing comma on the preceding `expectedAtom: null` line — remove only the offender line and any trailing comma that breaks JSON parseability.

### Task 2 — verify the fix locally (no commit, evidence only)

Run, paste the trailing PASS line of each command into the PR description:

1. `pnpm -F @yakcc/registry test -- src/discovery-eval-full-corpus.test.ts` — the specific test "synthetic-tasks entries have null expectedAtom and no expectedAtomName" must show PASS. All other 15+ tests in the file must show PASS.
2. `pnpm -F @yakcc/registry test` — full registry package suite must be green.
3. `pnpm -w lint` — full workspace lint must be green (NOT `--filter`; per memory `feedback_eval_contract_match_ci_checks.md`).
4. `pnpm -w typecheck` — full workspace typecheck must be green (NOT `--filter`).

### Task 3 — open PR

Per memory `feedback_pr_not_guardian_merge.md`: do NOT dispatch Guardian to merge into main. Push branch and open a PR. Per `feedback_fetch_before_pr.md`: `git fetch origin && git pull --ff-only origin main` immediately before `gh pr create`.

PR title: `fix(registry): #713 — strip stray expectedAtomName from bcryptjs synthetic-tasks corpus entries`
PR body must include the four PASS captures from Task 2, link issue #713, and reference WI-510-S6 as the origin of the typo.

## 5. Evaluation Contract (verbatim — reviewer enforces every line)

**Required tests (must run and pass):**
- `packages/registry/src/discovery-eval-full-corpus.test.ts` § *"corpus schema correctness > synthetic-tasks entries have null expectedAtom and no expectedAtomName"* — PASS (no SKIP, no `it.only`, no test-file edits).
- `packages/registry/src/discovery-eval-full-corpus.test.ts` full file — every previously passing test still passes (15+ tests in `corpus schema correctness` and `seed root resolution` describes); reviewer pastes the vitest tail showing `Tests N passed (N)` for the file.
- `pnpm -F @yakcc/registry test` — full registry package suite green; reviewer pastes the vitest summary.

**Required real-path checks (full-workspace, must pass):**
- `pnpm -w lint` — green across **all** packages (NOT `--filter`).
- `pnpm -w typecheck` — green across **all** packages (NOT `--filter`).
- `pnpm -F @yakcc/registry build` — green (the data file is JSON-loaded at runtime; a successful registry build proves nothing else regressed structurally).

**Required authority invariants:**
- `packages/registry/test/discovery-benchmark/corpus.json` remains the single canonical authority for the stratified benchmark corpus (no parallel corpus introduced).
- The `StratifiedEntry` schema as documented at `packages/registry/src/discovery-eval-full-corpus.test.ts:169–174` and `packages/registry/test/discovery-benchmark/README.md:52–63` is **unchanged** (data restored to schema; schema not redefined).
- No new `@decision` annotation introduced anywhere — this is a data correction, not a decision change.

**Required integration points:**
- Consumers of `expectedAtomName` (the two builder functions at `discovery-eval-full-corpus.test.ts:401` and `:791`) continue to operate correctly on the reduced set of `expectedAtomName` values (they iterate a `Set`; removing two entries simply makes the iterations smaller and stops the futile `bcryptjs-*` lookups).
- The corpus-integrity rule (README § "Corpus Integrity": *"Entries are monotonic: add never delete. Retired entries move to `retired/` with rationale."*) is observed — this edit removes a **field** from an entry, not the entry itself; entry IDs `cat1-bcryptjs-hash-001` and `cat1-bcryptjs-verify-001` remain in the corpus.

**Forbidden shortcuts:**
- Do NOT `it.skip` or `it.todo` the failing test. The whole point is the invariant test catches real schema violations.
- Do NOT bump the test timeout or wrap the assertion in `try/catch`.
- Do NOT touch `packages/registry/src/discovery-eval-full-corpus.test.ts` at all (Path A leaves the test file untouched; the only allowed test-file edit would be under Path C, which this plan rejected).
- Do NOT touch `packages/registry/test/discovery-benchmark/README.md` (the README already documents the correct schema).
- Do NOT add new seed blocks under `packages/seeds/src/blocks/bcryptjs-*` (Path B, rejected).
- Do NOT remove the `cat1-bcryptjs-hash-001` or `cat1-bcryptjs-verify-001` **entries** — only the `expectedAtomName` **field** within them.
- Do NOT modify any other entry's `expectedAtomName`, `expectedAtom`, `source`, `category`, `query`, or `rationale`.
- Do NOT broaden the implementer scope to "audit all WI-510 slices' corpus entries" — that is a separate, larger investigation and will not run under this work item.

**Ready-for-guardian (the exact conditions under which the reviewer may declare readiness):**
- The two named field removals are present in `packages/registry/test/discovery-benchmark/corpus.json` and nothing else is changed in that file.
- No file outside the Scope Manifest "allowed" list is modified.
- All four required real-path checks are green (vitest, registry suite, `pnpm -w lint`, `pnpm -w typecheck`).
- The PR description carries the four PASS captures from Task 2.

## 6. Scope Manifest (verbatim — hooks enforce)

**Allowed (touch points):**
- `packages/registry/test/discovery-benchmark/corpus.json`
- `plans/wi-fix-713-nightly-registry-corpus.md` (this plan; planner-owned)
- `tmp/scope-fix-713-nightly-registry-corpus.json` (planner-owned)
- `MASTER_PLAN.md` (initiative row appended; planner-owned)

**Required (must be modified by the implementer):**
- `packages/registry/test/discovery-benchmark/corpus.json` — remove `expectedAtomName` field from `cat1-bcryptjs-hash-001` and `cat1-bcryptjs-verify-001`.

**Forbidden touch points:**
- `packages/registry/src/**` (no source edits; no test-file edits — Path C rejected).
- `packages/registry/test/discovery-benchmark/README.md` (schema authority; unchanged).
- `packages/seeds/**` (no seed block additions — Path B rejected).
- `packages/shave/**`, `packages/hooks-base/**`, `packages/contracts/**`, `packages/ir/**`, `packages/compile/**`, `packages/cli/**`, `packages/hooks-claude-code/**`.
- `bench/**`, `examples/**`.
- `.github/workflows/**` (no CI workflow edits).
- `bootstrap/**` (no manifest changes).
- Any other top-level path not listed under Allowed.

**Expected state authorities touched:**
- `registry-stratified-benchmark-corpus-data` (the JSON corpus is the canonical authority; this fix restores compliance with the existing documented schema rather than redefining the schema).

## 7. Decision Log entries

None. This is a data correction restoring compliance with the existing documented schema; no DEC required. (The originating decisions are already recorded — `DEC-V3-DISCOVERY-D5-CORPUS-SEED-001` and `DEC-V3-DISCOVERY-D5-001` for the schema; the WI-510-S6 slice plan for the bcryptjs corpus intent.)

## 8. Standing memory rules honored

- Land via PR, not Guardian-merge (`feedback_pr_not_guardian_merge.md`).
- Cross-package imports via `@yakcc/*` workspace aliases — not applicable (no TS edits).
- Full-workspace `pnpm -w lint` AND `pnpm -w typecheck` in Evaluation Contract, never `--filter` (`feedback_eval_contract_match_ci_checks.md`).
- Plan artifacts written inside the worktree at `C:/src/yakcc/.worktrees/feature-fix-713-nightly-registry-corpus/` (`feedback_planner_writes_to_wrong_cwd.md`).
- `git fetch origin && git pull --ff-only origin main` before opening PR (`feedback_fetch_before_pr.md`).

## 9. Runtime scope-sync command (orchestrator runs at implementer-dispatch time)

```bash
cc-policy workflow scope-sync fix-713-nightly-registry-corpus \
  --work-item-id fix-713-nightly-registry-corpus-impl \
  --scope-file tmp/scope-fix-713-nightly-registry-corpus.json
```
