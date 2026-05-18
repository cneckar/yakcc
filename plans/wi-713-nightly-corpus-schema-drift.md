# WI-713 Slice 1 — Nightly CI fix: relax synthetic-tasks `expectedAtomName` assertion in `discovery-eval-full-corpus.test.ts`

**Issue:** [#713](https://github.com/cneckar/yakcc/issues/713)
**Workflow:** `wi-713-nightly-corpus-schema-drift`
**Goal:** `g-wi713-nightly-fix`
**Work item:** `wi-713-s1-1` (single-slice fix)
**Stage:** planner (Slice 1 plan; one source-file edit, no engine touch, no corpus mutation)
**Authored:** 2026-05-18 (Wrath persona)
**Failing run (head):** [actions/runs/26013525563](https://github.com/cneckar/yakcc/actions/runs/26013525563) on commit `7ebc352` (PR #710 merge, 2026-05-18T04:28:09Z)
**Predecessor of record:** PR #678 (closed #624) — established the curator-label convention this test now contradicts.
**Complexity tier:** Tier 1 — one test file, one `it(...)` block, no unknowns, no architectural decision beyond which assertion shape to choose.

This plan does **not** modify `MASTER_PLAN.md`. Per operator directive 2026-05-10 (`master_plan_amend_orchestrator.md`), MASTER_PLAN amendment is an orchestrator-owned post-merge task. The Decision Log entry below is the canonical record for this slice and the orchestrator will mirror it into MASTER_PLAN.md after landing.

---

## Phase 1 — Requirement Analysis

### 1.1 Problem statement

The nightly `discovery-eval-full-corpus` CI suite has been red since 2026-05-18T04:28:09Z on commit `7ebc352` (post-merge of PR #710, the closer-parity seed cache stage). The failure is **not** caused by PR #710 — it is a latent test-vs-data drift introduced earlier by PR #678 that nightly CI is now surfacing.

**Single failing assertion** in `packages/registry/src/discovery-eval-full-corpus.test.ts:858`, inside the corpus-schema-correctness suite:

```
it("synthetic-tasks entries have null expectedAtom and no expectedAtomName", () => {
  const entries = loadCorpus();
  const synthetic = entries.filter((e) => e.source === "synthetic-tasks");
  for (const e of synthetic) {
    expect(e.expectedAtom).toBeNull();
    expect(e.expectedAtomName).toBeUndefined();   // <-- line 858, fails
  }
});
```

**Verified root cause.** PR #678 (closes #624, merged 2026-05-17T22:42:46Z) populated `expectedAtomName` on two `synthetic-tasks` rows in `packages/registry/test/discovery-benchmark/corpus.json` under the curator-label convention established by `DEC-WI624-EXPECTED-ATOM-NAME-CONVENTION-001` (lodash precedent: `<package>-<function>`):

| Row id                          | source           | expectedAtom | expectedAtomName        |
|---------------------------------|------------------|--------------|-------------------------|
| `cat1-bcryptjs-hash-001`        | `synthetic-tasks`| `null`       | `"bcryptjs-hash"`       |
| `cat1-bcryptjs-verify-001`      | `synthetic-tasks`| `null`       | `"bcryptjs-verify"`     |

PR #678's body explicitly notes: "`expectedAtom: null` is retained on both rows (additive, load-bearing — null signals unresolved merkle root vs absent field)." That is, the **load-bearing semantic invariant for synthetic-tasks rows is `expectedAtom === null`**, and `expectedAtomName` was promoted to a discretionary curator label across *all* sources (seed-derived rows already carry it; the assertion at line 869 explicitly allows it: `expect(typeof e.expectedAtomName).toBe("string")`).

The test at line 858 was authored before the convention shifted and was not updated when PR #678 landed. Until WI-624 landed, no `synthetic-tasks` row had `expectedAtomName` set, so the assertion was vacuously true. PR #710 did not change anything in the registry or corpus; nightly simply ran the full corpus-schema suite for the first time after PR #678 against the now-conflicting data.

**Cost.** Nightly CI is red on every commit since 2026-05-18T04:28:09Z. Real regressions in `discovery-eval-full-corpus` (the canonical end-to-end discovery-quality regression net) are masked by this known-false failure. Until the test is fixed, nightly is a no-signal channel.

### 1.2 Goals (measurable)

- **G1.** The `synthetic-tasks` assertion in `discovery-eval-full-corpus.test.ts` accepts the current curator convention (i.e., `expectedAtomName` is a discretionary string label on any source) without re-litigating the load-bearing `expectedAtom === null` invariant for synthetic-tasks.
- **G2.** `pnpm --filter @yakcc/registry test -- src/discovery-eval-full-corpus.test.ts` exits zero on current `main` HEAD.
- **G3.** Full registry test suite (`pnpm --filter @yakcc/registry test`) exits zero — no regression in the seed-derived assertion (line 869) or any neighbor (line 862-871 seed-derived block; line 873-881 category-balance block).
- **G4.** Nightly `discovery-eval-full-corpus` workflow returns to green on the next scheduled run (post-merge of this slice).

### 1.3 Non-goals (explicit exclusions with rationale)

- **NG1.** **Do NOT modify `packages/registry/test/discovery-benchmark/corpus.json`.** The curator-label convention was decided and shipped under DEC-WI624-EXPECTED-ATOM-NAME-CONVENTION-001 via PR #678. Reverting either of the two `expectedAtomName` rows would re-litigate a closed decision and silently regress WI-624's B9-armed quality-gate ground truth. The data is the authority; the test conforms.
- **NG2.** **Do NOT touch any other test file**, including the lodash / bcryptjs headline-bindings tests, the seed-derived corpus assertion (line 862-871), the category-balance assertion (line 873-881), or any other file under `packages/registry/src/`. The fix is local to one `it(...)` block.
- **NG3.** **Do NOT mass-rename or refactor `expectedAtomName` across packages.** No `git grep -l expectedAtomName | xargs sed` runs. The corpus schema in `types.ts` already has `expectedAtomName?: string`; that field's optional semantics are correct as shipped.
- **NG4.** **Do NOT add new corpus rows, new synthetic-tasks fixtures, or new test cases.** This is a one-line semantic adjustment to an existing assertion, not a coverage expansion.
- **NG5.** **Do NOT touch `MASTER_PLAN.md`.** Orchestrator-owned post-merge mirror task.
- **NG6.** **Do NOT change the test's `describe("discovery-eval-full-corpus — corpus schema correctness", ...)` group or any imports.** The change is contained within one `it(...)` call.

### 1.4 Unknowns and ambiguities

None. The fix is mechanical:
- the failing assertion is identified at exact line/column;
- the conflicting data rows are identified at exact line/column;
- the decision authority (DEC-WI624) is referenced verbatim;
- the load-bearing invariant (`expectedAtom === null` for synthetic-tasks) is preserved.

### 1.5 Dominant constraints

- **Scope discipline:** Implementer must edit exactly one file (`discovery-eval-full-corpus.test.ts`) and only the lines comprising the single `it(...)` call at line 853-860. Hook-level scope enforcement via `cc-policy workflow scope-sync` will block any drift.
- **Test scope:** The seed-derived assertion block (line 862-871) and the category-balance block (line 873-881) must remain byte-identical except for any unavoidable whitespace adjacent to the edit. Reviewer will verify via `git diff --stat`.
- **PR landing:** Via PR flow (no local-merge to `main` on yakcc per operator directive). PR title pattern `fix(registry): #713 — ...`. PR body must include `closes #713`.

---

## Phase 2 — Architecture Design & State Authority Map

### 2.1 State authorities touched

| State domain                                | Canonical authority                                                  | This slice's interaction                                        |
|---------------------------------------------|----------------------------------------------------------------------|------------------------------------------------------------------|
| Corpus schema correctness assertions        | `packages/registry/src/discovery-eval-full-corpus.test.ts` (the `corpus schema correctness` `describe` block) | **MUTATE** — relax one assertion to conform to current data convention |
| Corpus data (rows, fields, curator labels)  | `packages/registry/test/discovery-benchmark/corpus.json`             | **READ-ONLY** — referenced as the conformance target; not edited |
| `expectedAtomName` semantic convention      | `DEC-WI624-EXPECTED-ATOM-NAME-CONVENTION-001` (recorded in PR #678 / `plans/wi-624-bcryptjs-corpus.md`) | **CONFORM** — no new decision; the test conforms to the existing decision |
| Synthetic-tasks `expectedAtom: null` invariant | PR #678 body + the existing `expect(e.expectedAtom).toBeNull();` on line 857 | **PRESERVE** — kept verbatim in the new assertion shape |
| Corpus row schema (TypeScript types)        | `packages/registry/src/types.ts` (`expectedAtomName?: string`)       | **READ-ONLY** — already correctly optional; no change needed |
| `MASTER_PLAN.md`                            | Orchestrator-owned                                                   | **UNTOUCHED** — orchestrator mirrors decision log post-merge |

The relationship the planner is locking: **the test conforms to the data authority, not the reverse.** Once a curator convention is shipped to corpus.json (as PR #678 did under DEC-WI624), assertions that contradict that convention are the bug. The data row carries the curator's deliberate intent; the test row was an assumption from an earlier convention.

### 2.2 Decision locked: assertion shape

**Two acceptable shapes were considered:**

- **(a) Drop the assertion entirely; rename the test.** New `it(...)` body keeps only `expect(e.expectedAtom).toBeNull();`. The test name is renamed from `"synthetic-tasks entries have null expectedAtom and no expectedAtomName"` to `"synthetic-tasks entries have null expectedAtom"`. Rationale: `expectedAtomName` is a discretionary curator label across *all* sources per DEC-WI624; the absence-of-label assertion was a stale assumption, not a load-bearing invariant. Semantically clean — the test now asserts exactly what is true (the `expectedAtom === null` invariant) and nothing more.

- **(b) Allow string OR undefined.** Replace the failing assertion with `expect(e.expectedAtomName === undefined || typeof e.expectedAtomName === "string").toBe(true);`. Rationale: preserves a "no rogue values" defense (e.g., a curator accidentally sets a non-string).

**Planner decision: ship (a).** Justification:
1. **Semantic cleanliness.** The "no rogue values" defense in (b) is already covered by TypeScript: `expectedAtomName?: string` in `packages/registry/src/types.ts` makes any non-string value a compile-time failure before tests even run. Adding a runtime `typeof === "string"` check is redundant defense-in-depth that obscures intent.
2. **Symmetry with the seed-derived assertion (line 869).** The seed-derived branch asserts `typeof e.expectedAtomName === "string"` because the curator convention requires the label on seed-derived rows. For synthetic-tasks, the convention does **not** require it — it is optional — so the symmetric assertion is "no constraint on label." Shape (a) expresses that directly.
3. **Future-implementer clarity.** A successor reading shape (a) sees one line and one invariant. Shape (b) reads as a defensive-OR clause that invites the question "why both?" and risks accreting more defensive clauses.

**Decision Log ID:** `DEC-WI713-SYNTHETIC-TASKS-EXPECTED-ATOM-NAME-OPTIONAL-001` (logged in §8 below).

### 2.3 Exact edit shape (for implementer verification)

The implementer applies a single edit to `packages/registry/src/discovery-eval-full-corpus.test.ts` at line 853-860.

**Before:**
```typescript
  it("synthetic-tasks entries have null expectedAtom and no expectedAtomName", () => {
    const entries = loadCorpus();
    const synthetic = entries.filter((e) => e.source === "synthetic-tasks");
    for (const e of synthetic) {
      expect(e.expectedAtom).toBeNull();
      expect(e.expectedAtomName).toBeUndefined();
    }
  });
```

**After:**
```typescript
  it("synthetic-tasks entries have null expectedAtom", () => {
    // expectedAtomName is a discretionary curator label on any source
    // (DEC-WI624-EXPECTED-ATOM-NAME-CONVENTION-001 / PR #678). The load-bearing
    // invariant for synthetic-tasks is expectedAtom === null (PR #678 body:
    // "null signals unresolved merkle root vs absent field"). The label itself
    // is optional and is type-checked at compile time via types.ts.
    const entries = loadCorpus();
    const synthetic = entries.filter((e) => e.source === "synthetic-tasks");
    for (const e of synthetic) {
      expect(e.expectedAtom).toBeNull();
    }
  });
```

No other line in the file changes. The seed-derived assertion (line 862-871) and category-balance assertion (line 873-881) remain byte-identical.

### 2.4 Research gate

Not invoked. The domain is fully known (test framework: Vitest; assertion: `toBeUndefined()` → drop or relax; data file: JSON; decision precedent: explicit in PR #678 body). No new library, no new convention, no unfamiliar codepath. Time-spent on research: zero, by design.

### 2.5 Alternatives gate

Not invoked beyond shape (a) vs (b) above. Both shapes are local-scope and small; the decision is one of style and idiomatic clarity, not architecture. The Question Merit Test passes: a reasonable reviewer would accept either, and (a) is the "obvious right" choice given the type-system overlap argued in §2.2.

---

## Phase 3 — Wave Decomposition

| W-ID         | Description                                                                       | Weight | Gate           | Deps | Integration surfaces                                  |
|--------------|-----------------------------------------------------------------------------------|--------|----------------|------|--------------------------------------------------------|
| `wi-713-s1-1`| Apply the one-test edit per §2.3; verify locally; PR with `closes #713` | S      | review (reviewer verdict + guardian land) | none | Only `packages/registry/src/discovery-eval-full-corpus.test.ts` |

**Dependency graph:** trivial. One node, zero edges. Critical path = `wi-713-s1-1`. Max wave width = 1.

**Wave plan:**
- **Wave 0:** `wi-713-s1-1` (this slice). End-state: PR merged, nightly green on next scheduled run.

No further waves planned in this WI.

---

## Phase 3b — Evaluation Contract and Scope Manifest

### 3b.1 Evaluation Contract for `wi-713-s1-1`

**Required tests** (must all pass on the implementer's worktree HEAD before reviewer dispatch):

- `pnpm --filter @yakcc/registry test -- src/discovery-eval-full-corpus.test.ts` exits zero. The renamed `it("synthetic-tasks entries have null expectedAtom", ...)` block must pass. The neighboring `it("seed-derived entries have null expectedAtom in corpus (resolved at test time)", ...)` block at line 862-871 must continue to pass without modification.
- `pnpm --filter @yakcc/registry test` exits zero (full registry suite — guards against any unintended cross-test regression).
- `pnpm --filter @yakcc/registry typecheck` exits zero (the rename of the test name string and addition of an explanatory comment must not introduce a type error; expected to be trivially true since neither change touches types).

**Required real-path checks:**

- `git diff --stat` on the worktree shows **exactly one file modified**: `packages/registry/src/discovery-eval-full-corpus.test.ts`. Any other file in the diff is an out-of-scope violation.
- `git diff packages/registry/src/discovery-eval-full-corpus.test.ts` shows changes confined to lines 853-860 (with possible adjacent comment-line insertions). No lines outside the target `it(...)` block change.
- `git diff packages/registry/test/discovery-benchmark/corpus.json` is empty (corpus is read-only this slice — NG1).
- `git status` is clean modulo the one allowed file (no stray `tmp/` artifacts, no `node_modules` churn).

**Required authority invariants** (none may be violated):

- **Synthetic-tasks `expectedAtom: null` invariant**: the assertion `expect(e.expectedAtom).toBeNull();` on the synthetic-tasks loop must remain present in the new shape. Removing it would break the load-bearing semantic from PR #678.
- **Seed-derived `expectedAtomName: string` invariant**: `packages/registry/src/discovery-eval-full-corpus.test.ts:869` (`expect(typeof e.expectedAtomName).toBe("string");`) must remain byte-identical.
- **Corpus data immutability**: `packages/registry/test/discovery-benchmark/corpus.json` must be byte-identical pre/post-slice (`git diff` empty).
- **Curator convention conformance**: the new assertion shape must not contradict any future synthetic-tasks row that carries a curator-set `expectedAtomName`. Shape (a) trivially satisfies this since it imposes no constraint on the label.

**Required integration points** (adjacent components that must still work):

- `packages/registry/src/discovery-eval-full-corpus.test.ts` other test blocks (categories check, IDs unique, required-fields, seed-derived, category-balance, seed-root-resolution describe block at line 885+) — all must pass without modification.
- All other test files under `packages/registry/test/` and `packages/registry/src/**/*.test.ts` — full registry suite must remain green.
- `packages/registry/src/types.ts` `CorpusEntry` / `expectedAtomName?: string` type — must remain optional (not asserted by this slice; this slice depends on the type already being optional, which it is).

**Forbidden shortcuts** (explicitly banned implementation approaches):

- **Banned**: editing `packages/registry/test/discovery-benchmark/corpus.json` to revert PR #678's curator labels (NG1).
- **Banned**: deleting the entire `it("synthetic-tasks ...")` block (would erase the load-bearing `expectedAtom === null` assertion).
- **Banned**: replacing `toBeNull()` with `toBeFalsy()` or any weaker check (would let `undefined` / `0` slip through).
- **Banned**: marking the test `.skip` or `.todo` instead of fixing it (would mask future regressions and is not a "fix").
- **Banned**: introducing a per-row allow-list of which synthetic-tasks rows may carry `expectedAtomName` (would couple the test to specific row IDs; the curator convention is row-agnostic).
- **Banned**: touching any file outside `packages/registry/src/discovery-eval-full-corpus.test.ts` (scope manifest enforces this; the hook will deny the write).
- **Banned**: `git stash` during reviewer flight (reviewer must use read-only inspection; see `reviewer_no_git_stash` memory).

**Ready-for-guardian definition** (the exact conditions under which the reviewer may declare `ready_for_guardian`):

1. The one-file diff matches §2.3 (new assertion shape, renamed test, explanatory comment referencing DEC-WI624 + PR #678).
2. `git diff --stat` shows exactly one file changed (the test file).
3. `pnpm --filter @yakcc/registry test` exits zero with the renamed test block visible in the output.
4. `pnpm --filter @yakcc/registry typecheck` exits zero.
5. The implementer's stop output includes the registry-test PASS line and the typecheck PASS line verbatim.
6. The reviewer has independently `git rev-parse HEAD`'d the implementer worktree (not used a 7-char prefix; see `reviewer_sha_hallucination` memory) and recorded the full 40-char SHA in the REVIEW trailer.
7. The reviewer has confirmed via `git diff` (read-only; see `reviewer_no_git_stash` memory) that `packages/registry/test/discovery-benchmark/corpus.json` is unchanged.

### 3b.2 Scope Manifest for `wi-713-s1-1`

**Allowed files/directories** (implementer may write):

- `packages/registry/src/discovery-eval-full-corpus.test.ts` — the one and only source file this slice mutates.
- `tmp/**` — implementer scratch space; not committed.
- `plans/wi-713-nightly-corpus-schema-drift.md` — this plan file (planner already wrote it; implementer may add minor footnotes only if directly required by a finding, otherwise leave untouched).

**Required files/directories** (implementer must modify):

- `packages/registry/src/discovery-eval-full-corpus.test.ts` — the §2.3 edit must land in this file or the slice is incomplete.

**Forbidden touch points** (implementer must not write; reviewer must catch):

- `packages/registry/test/discovery-benchmark/corpus.json` — corpus data is the conformance target, not mutable scope (NG1).
- `MASTER_PLAN.md` — orchestrator-owned (NG5; `master_plan_amend_orchestrator` memory).
- Any other `.test.ts` under `packages/registry/src/` — out of scope (NG2).
- Any file under `packages/registry/src/` that is not the named test file — including engine code, types, runners, fixtures (NG2 + NG3).
- Any file under `packages/contracts/`, `packages/ir/`, `packages/seeds/`, `packages/shave/`, `packages/cli/`, `packages/agent-bench/` — entirely out of scope.
- Any file under `agents/`, `.claude/` — orchestrator/harness surface; not in this slice.

**Expected state authorities touched at runtime** (during test execution):

- `discovery-eval-full-corpus.test.ts` corpus-schema-correctness `describe` block — the assertion authority being relaxed.
- `packages/registry/test/discovery-benchmark/corpus.json` — read by `loadCorpus()` during test execution; not mutated by this slice.

**Scope sync:** the orchestrator must run `cc-policy workflow scope-sync wi-713-nightly-corpus-schema-drift --work-item-id wi-713-s1-1 --scope-file tmp/wi-713-scope.json` before dispatching implementer. The scope file is written by planner at `/home/claude/yakcc/tmp/wi-713-scope.json`. Hook-level scope enforcement will deny any write to a forbidden path.

---

## Phase 4 — Operational notes for the canonical chain

1. **guardian:provision** — provision worktree for `wi-713-nightly-corpus-schema-drift` from current `main` head. Branch name suggestion: `fix/wi-713-corpus-schema-test`.
2. **implementer** — apply the §2.3 edit; run the two required test commands from §3b.1; commit with message starting `fix(registry): #713`.
3. **reviewer** — verify per §3b.1 (read-only inspection only; no `git stash`; full 40-char SHA in trailer); emit `REVIEW_VERDICT=ready_for_guardian` or send back with concrete diff-driven feedback.
4. **guardian:land** — push branch, open PR with title `fix(registry): #713 — relax synthetic-tasks expectedAtomName assertion for curator labels` and body referencing `closes #713` plus the chain (failing run link, PR #678 backref, DEC-WI713 citation). Wait for CI green. Merge.
5. **Post-merge orchestrator tasks** (out of slice scope but required for goal closure):
   - Mirror `DEC-WI713-SYNTHETIC-TASKS-EXPECTED-ATOM-NAME-OPTIONAL-001` into `MASTER_PLAN.md` Decision Log.
   - Watch the next scheduled nightly `discovery-eval-full-corpus` run for green status; report to user.
   - Close issue #713.

---

## Decision Log

| DEC-ID                                                       | Decision                                                                                                                     | Rationale                                                                                                                                                                                                                                                                                       | Slice         | Status   |
|--------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------|----------|
| `DEC-WI713-SYNTHETIC-TASKS-EXPECTED-ATOM-NAME-OPTIONAL-001`   | The `discovery-eval-full-corpus` corpus-schema-correctness test will assert only `expectedAtom === null` for `synthetic-tasks` entries; the `expectedAtomName` field is treated as a discretionary curator label and no longer asserted absent. | PR #678 (`DEC-WI624-EXPECTED-ATOM-NAME-CONVENTION-001`) shipped the `<package>-<function>` curator-label convention for any source where it is curator-useful, including two `synthetic-tasks` bcryptjs rows. The load-bearing semantic for `synthetic-tasks` is `expectedAtom === null` (PR #678 body), not absence of the label. TypeScript types (`expectedAtomName?: string`) already enforce shape; runtime defensive-OR is redundant. Shape (a) preserves the load-bearing invariant, conforms to the existing data convention, and remains symmetric with the seed-derived assertion. | `wi-713-s1-1` | accepted |

---

## Quality Gate (planner self-check before trailer)

- All dependencies and states are logically mapped: yes (single-node graph; state-authority table in §2.1).
- Every guardian-bound work item has an Evaluation Contract with executable acceptance criteria: yes (§3b.1; two `pnpm` commands, two `git diff` checks, six "ready" conditions).
- Every guardian-bound work item has a Scope Manifest with explicit file boundaries: yes (§3b.2; allow/require/forbid lists explicit).
- No work item relies on narrative completion language instead of measurable checks: yes; all conditions are tool-runnable (`pnpm test`, `git diff --stat`, `git rev-parse HEAD`, hook scope enforcement).
- Decision is locked, recorded, and traceable to a prior PR: yes (DEC-WI713 + PR #678 + DEC-WI624 + issue #713).
- Plan does not touch `MASTER_PLAN.md`: confirmed.
- Plan does not touch `corpus.json`: confirmed (NG1; reviewer gate in §3b.1 enforces).
