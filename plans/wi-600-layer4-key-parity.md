# WI-600 — Layer 4 descent-tracker key parity

**Workflow:** `fix-600-layer4-key-parity`
**Issue:** [#600](https://github.com/yakcc/yakcc/issues/600) — Layer 4 descent-tracker key mismatch
**Branch:** `feature/600-layer4-key-parity`
**Worktree:** `/Users/cris/src/yakcc/.worktrees/feature-600-layer4-key-parity`
**Cross-refs:** #592 (S4 land, commit b2c140a), #593 (S5 drift detection), #594 (S6 closer), #579 (architecture)
**Status:** planned

---

## 1. Problem (verbatim from #600)

`substitute.ts` line 502 calls:

```ts
const packageName = binding.atomName; // v1 best-effort proxy
descentBypassWarning = getAdvisoryWarning(packageName, binding.atomName, originalCode, l4cfg);
```

→ key: `isEmail::isEmail`

`import-intercept.ts` lines 401-405 calls:

```ts
l4RecordHit(candidate.binding.moduleSpecifier, bindingName);
```

→ key: `validator::isEmail`

Keys never match in production. Layer 4 warning is effectively always-on for any non-shallow-allowed binding.

### Why it didn't block S4 landing

Layer 4 is advisory (non-blocking). Substitutions proceed regardless. Unit and integration tests pass because they use consistent keys within each test. Reviewer accepted as concern severity, not blocking.

### Why fixing it matters now (gating reason)

- **#593 drift detector consumes Layer 4 depth counts.** A perpetually-on advisory layer poisons the drift signal — every binding looks like a "first-attempt substitution" with depth 0.
- **#594 (S6 closer) requires Layer 4 to be operationally accurate** before the architecture closure.
- Today the on-disk telemetry blob (`descentBypassWarning`) is produced for ~100% of non-shallow-allowed substitutions, which is observably wrong but invisible to the implementer because the unit tests never exercise the production key crossover.

---

## 2. Decision: Option 2 — key on `(moduleSpecifier, bindingName)` semantics, threaded into descent-tracker via canonical input from import-intercept; substitute.ts updated to use the same canonical key

**Reframe.** The issue body offered Options 1 and 2 as binary. Reading the actual call sites shows the cheapest correct fix is closer to Option 2 *operationalized* — keep `descent-tracker.ts`'s API stable (key is `makeBindingKey(packageName, binding)`), and **fix the caller in `substitute.ts`** so the `packageName` it passes matches what `import-intercept.ts` recorded.

### What `substitute.ts` actually has at the L4 call site

Inside `executeSubstitution(originalCode, registry)`:

- `binding` comes from `extractBindingShape(originalCode)` and exposes only `name`, `args`, `atomName` (the call expression's function name — same as the import's local name after resolution).
- `decision` comes from `decideToSubstitute(candidates)` where `candidates: readonly CandidateMatch[]` are the registry matches.
- `winningBlock = candidates[0]?.block` is consulted in Step 5 to recover `SpecYak`.
- **No `moduleSpecifier` is available at this point** — substitute.ts does not see the source import statement.

### What `import-intercept.ts` actually records

```ts
const bindingName =
  candidate.binding.namedImports[0] ??
  candidate.binding.defaultImport ??
  candidate.binding.moduleSpecifier;
l4RecordHit(candidate.binding.moduleSpecifier, bindingName);
```

So records are keyed by `(moduleSpecifier, namedImport-or-defaultImport-or-moduleSpecifier)` — e.g. `validator::isEmail`, `lodash::lodash` (if default import without named), `uuid::uuid` (if namespace import).

### Why Option 2 (canonical-atom keying) is the right operational call

1. **Layer 4's semantic question is atom-shaped, not import-shaped.** "Has the LLM agent tried this atom and missed before substituting?" The atom is the unit of substitution decision; the descent depth is a per-atom signal in the session.
2. **`atomName` is globally meaningful within yakcc's atom registry** (`@yakcc/atoms/<atomName>` is the canonical import path per `renderSubstitution` in `substitute.ts` line 332-336). Two different source imports that both resolve to the same yakcc atom *should* share descent state — they are descents toward the same target.
3. **Drift detector (#593) signal is strengthened by atom-keying**: misses against `isEmail` from any package boost the same descent counter, surfacing genuine cross-package retry patterns rather than splitting them by import path.
4. **Smaller blast radius**: no `BindingShape` extension, no new parameter on `executeSubstitution`, no plumbing through the upstream caller chain. The diff is confined to `descent-tracker.ts` (canonical key derivation) and the two call sites.
5. **Future Implementer cost**: Option 1 (thread `moduleSpecifier` into `substitute.ts`) requires either (a) extending `BindingShape` with a `moduleSpecifier` field that `extractBindingShape` cannot supply without scanning the surrounding file's imports — out of scope of a code-fragment substitution — or (b) extending `executeSubstitution(originalCode, registry)` with a `moduleSpecifier` parameter, requiring every caller upstream to discover and pass it. Both are real API expansion.

### The fix shape (concrete)

Introduce a single canonical key derivation in `descent-tracker.ts`:

```ts
// descent-tracker.ts
// Canonical key for Layer 4 records: atomName-only.
// Rationale: Layer 4 measures per-atom descent depth in the session, not per-import-path.
// Two source imports targeting the same atomName share descent state by design.
// See DEC-HOOK-ENF-LAYER4-KEY-CANONICAL-001 (WI-600).
function canonicalKey(_packageName: string, binding: string): string {
  return makeBindingKey(binding, binding); // atomName-only — packageName argument retained for API stability
}
```

Then replace `makeBindingKey(packageName, binding)` with `canonicalKey(packageName, binding)` in the four sites inside `descent-tracker.ts`: `recordMiss`, `recordHit`, `getDescentDepth`, `getDescentRecord`, **and** the `bindingKey` field in the returned `DescentBypassWarning` from `getAdvisoryWarning` (so the warning payload reflects the canonical key).

Caller sites in `substitute.ts` and `import-intercept.ts` keep their existing signatures and remain untouched at the boundary — the canonicalization is internal to `descent-tracker.ts`. This isolates the change and preserves the public API.

**Alternative considered and rejected:** changing only the `substitute.ts` call site to pass `(binding.atomName, binding.atomName)` while leaving `import-intercept.ts` keyed on `moduleSpecifier`. Rejected because it would *still* never match — `import-intercept.ts` records keyed by `validator::isEmail` while substitute would now ask for `isEmail::isEmail`. The fix has to be inside `descent-tracker.ts` to canonicalize both sides.

### What we accept (trade-offs)

- Distinct source imports of identically-named atoms across different packages collapse into one descent record. For yakcc's atom registry where `atomName` is the canonical identifier, this is the intended semantic. If a future world introduces non-unique atom names across packages, revisit via a follow-up issue.
- The `packageName` argument is retained in the `descent-tracker.ts` public API for source compatibility with both call sites, but is now ignored in the canonical key. A `@decision` annotation will document this.

---

## 3. Diff sketch

### `packages/hooks-base/src/descent-tracker.ts` (modified)

Add `canonicalKey` derivation; replace 5 occurrences of `makeBindingKey(packageName, binding)` with `canonicalKey(packageName, binding)`. Update the file-level `@decision` block to add `DEC-HOOK-ENF-LAYER4-KEY-CANONICAL-001` rationale alongside the existing `DEC-HOOK-ENF-LAYER4-DESCENT-TRACKING-001`. Update the `bindingKey` field in the JSDoc to note it is atom-canonical.

Lines touched (approximate): 36-78 (decision block header), 98 (recordMiss), 123 (recordHit), 150 (getDescentDepth), 163 (getDescentRecord), 243 (getAdvisoryWarning bindingKey).

### `packages/hooks-base/src/substitute.ts` (touched only in the L4 step block)

Update the misleading inline comment block at lines 486-495 to describe the new canonical-key semantics (the `packageName` proxy is no longer "best-effort" — it is canonically ignored). No behavior change at this call site.

### `packages/hooks-base/src/import-intercept.ts` (untouched in behavior; comment-only)

Update the Layer 4 inline comment block (around lines 388-393) to note the canonical-key contract so a future implementer doesn't re-introduce a key-mismatch by reading the comment in isolation.

### `packages/hooks-base/src/enforcement-types.ts` (potentially untouched)

`DescentBypassWarning.bindingKey` field type stays `string` — only the production *content* changes. JSDoc updated to note canonical-atom semantics.

### `packages/hooks-base/src/index.ts` (untouched)

No public surface change.

### `packages/hooks-base/test/descent-tracker-key-parity.test.ts` (NEW)

End-to-end key parity test (see §4).

### `packages/hooks-base/test/enforcement-eval-corpus.json` and `enforcement-eval-corpus.test.ts` (review-only)

Verify corpus does not assert on the buggy old keys (e.g. `isEmail::isEmail`). If it does, update fixture expectations to canonical keys (e.g. `isEmail::isEmail` is in fact what canonicalKey produces, so most existing assertions remain valid). The implementer must run the corpus test and adjust only if it fails.

---

## 4. Integration test plan

### New: `packages/hooks-base/test/descent-tracker-key-parity.test.ts`

Asserts the production crossover semantics:

1. **Same logical binding produces identical keys across producer and consumer.**
   - Call `recordMiss("validator", "isEmail")` 3 times (simulating import-intercept's recording path).
   - Call `getAdvisoryWarning("isEmail", "isEmail", "const foo = isEmail(x);", l4cfg)` (simulating substitute.ts's reading path with the v1 atomName-proxy `packageName`).
   - Assert: the returned `warning.observedDepth === 3` (proves the keys converged).
   - Assert: `warning.bindingKey === "isEmail::isEmail"` (proves canonical key shape).

2. **Layer 4 warning is correctly suppressed once `minDepth` is reached.**
   - Use `l4cfg = { minDepth: 2, shallowAllowPatterns: [], disableTracking: false }`.
   - Record 1 miss → `getAdvisoryWarning(...)` returns a warning (depth 1 < minDepth 2).
   - Record another miss → `getAdvisoryWarning(...)` returns `null` (depth 2 ≥ minDepth 2).
   - This proves the "warning fires only when descent < minDepth" acceptance from the issue.

3. **Cross-import atom-collision behavior is documented (positive test).**
   - Call `recordMiss("validator", "isEmail")` and `recordMiss("is-email-validator", "isEmail")`.
   - Assert: `getDescentDepth("isEmail", "isEmail") === 2` (proves canonical merging is the intended semantic, not a regression).

4. **Shallow-allow bypass still suppresses warnings independent of key shape.**
   - With `shallowAllowPatterns: ["^isEmail$"]`, record any number of misses, and assert `getAdvisoryWarning` returns `null`.

### Existing tests that must remain green

- `pnpm -F @yakcc/hooks-base test` — full hooks-base suite (descent-tracker, substitute pipeline, import-intercept pipeline, L1-L5 corpus).
- `pnpm -F @yakcc/hooks-base lint`
- `pnpm -F @yakcc/hooks-base typecheck`

Specific test files that exercise descent-tracker indirectly:
- `test/descent-tracker.test.ts` (if it exists — implementer to confirm) — should remain green; key-shape change is internal.
- `test/enforcement-eval-corpus.test.ts` — full corpus pass.
- Any substitute.ts or import-intercept.ts integration tests asserting on the `descentBypassWarning` field shape.

---

## 5. Evaluation Contract

### Required tests

- `packages/hooks-base/test/descent-tracker-key-parity.test.ts` exists and proves substitute.ts ↔ import-intercept.ts produce identical bindingKeys for the same logical binding via the production crossover (record on one side, read on the other).
- All existing hooks-base tests pass (no regression on L1-L5 corpus, substitute pipeline, import-intercept pipeline).
- Layer 4 advisory warning fires ONLY when `descent < minDepth` — provable via the multi-descent test above.

### Required evidence

- Diff scoped to `allowed_paths` only (per Scope Manifest below).
- `plans/wi-600-layer4-key-parity.md` committed.
- `pnpm -F @yakcc/hooks-base test && pnpm -F @yakcc/hooks-base lint && pnpm -F @yakcc/hooks-base typecheck` all clean, output pasted in PR.
- Pre-push hygiene executed: `git fetch origin && git diff --stat origin/main..HEAD` confirms clean rebase relationship to `origin/main`; full lint and typecheck run BEFORE push (per `feedback_pre_push_hygiene.md`, non-negotiable).

### Required real-path checks

- `packages/hooks-base/src/substitute.ts` present.
- `packages/hooks-base/src/import-intercept.ts` present.
- `packages/hooks-base/src/descent-tracker.ts` present.

### Required authority invariants

- `enforcement-config.ts` remains the SOLE source of truth for Layer 4 thresholds (file untouched here).
- Layer 4 remains advisory non-blocking (substitution outcomes unchanged regardless of warning state).
- S1, S2, S3, S5 layer modules untouched (`intent-specificity.ts`, `result-set-size.ts`, `atom-size-ratio.ts`, `drift-detector.ts`).
- Telemetry semantics unchanged — no new outcomes, no new fields beyond comment updates.
- No IDE-package source touched (`hooks-claude-code`, `hooks-cursor`, `hooks-codex`).
- `DEC-HOOK-ENF-LAYER4-DESCENT-TRACKING-001` semantics preserved (per-session in-memory, advisory-only, shallow-allow bypass).

### Required integration points

- `substitute.ts` L4 call site and `import-intercept.ts` L4 call sites converge on the same descent record via the canonical key.
- `descent-tracker.ts` public API surface (`recordMiss`, `recordHit`, `getDescentDepth`, `getDescentRecord`, `getAdvisoryWarning`, `shouldWarn`, `isShallowAllowed`, `resetSession`) preserved in signature.
- `DescentBypassWarning.bindingKey` field type unchanged (`string`); content now canonical-atom-shaped.

### Forbidden shortcuts

- Hardcoding fallback keys in either call site.
- Making Layer 4 blocking (it is and must remain advisory).
- Modifying S1, S2, S3, S5 layer modules to "compensate".
- Disabling Layer 4 by default in config (the test must prove correct behavior with tracking enabled).
- Skipping pre-push hygiene (rebase to `origin/main` + lint + typecheck BEFORE push — per `feedback_pre_push_hygiene.md`, non-negotiable per user 2026-05-15).
- Pushing to main directly (per `feedback_no_main_branch_commits.md` — worktree+feature branch only).

### Rollback boundary

`git revert` the single commit. Layer 4 returns to v1 buggy-key state (advisory only; no production impact beyond restored noisy warnings). Drift detector (#593) returns to consuming a saturated Layer 4 signal but does not break — drift detector handles the always-on case gracefully (verified during #593 land).

### Acceptance notes

- Follow-up to #594 closer (#579 architecture).
- Single-PR fix, single commit preferred.
- Pre-push hygiene non-negotiable.
- Closes #600 in the PR body.
- Add `@decision DEC-HOOK-ENF-LAYER4-KEY-CANONICAL-001` annotation to `descent-tracker.ts` recording the canonical-key rationale.
- Claim issue with `serenity` label before starting implementation (per `feedback_serenity_claim_label.md`).

### Ready-for-guardian definition

All of the following must hold simultaneously, with evidence in the PR body:

1. `descent-tracker-key-parity.test.ts` exists, asserts the four cases in §4, and passes.
2. `pnpm -F @yakcc/hooks-base test` exit 0 with full output captured.
3. `pnpm -F @yakcc/hooks-base lint` exit 0.
4. `pnpm -F @yakcc/hooks-base typecheck` exit 0.
5. `git diff --stat origin/main..HEAD` shows only files within Scope Manifest allowed_paths.
6. PR opened against `main` with body containing `Closes #600` and pasted test output.
7. Reviewer issues `REVIEW_VERDICT=ready_for_guardian` with parity test cited.

---

## 6. Scope Manifest

### Allowed paths

- `packages/hooks-base/src/substitute.ts` (comment update at L4 step block only)
- `packages/hooks-base/src/import-intercept.ts` (comment update at L4 block only)
- `packages/hooks-base/src/descent-tracker.ts` (canonical-key fix + @decision annotation)
- `packages/hooks-base/src/enforcement-types.ts` (JSDoc on `DescentBypassWarning.bindingKey` only if needed)
- `packages/hooks-base/src/index.ts` (no expected change; touch only if a new export is required, which it should not be)
- `packages/hooks-base/test/descent-tracker-key-parity.test.ts` (NEW)
- `packages/hooks-base/test/enforcement-eval-corpus.json` (review-only; update only if corpus fixture breaks)
- `packages/hooks-base/test/enforcement-eval-corpus.test.ts` (review-only; update only if assertions break)
- `plans/wi-600-layer4-key-parity.md` (this file)
- `tmp/wi-600-*` and `tmp/wi-600-*/**/*` (scratch space)

### Required paths

- `plans/wi-600-layer4-key-parity.md` (this file — must be committed)
- `packages/hooks-base/src/descent-tracker.ts` (the canonical-key fix lives here)
- `packages/hooks-base/test/descent-tracker-key-parity.test.ts` (the parity test lives here)

### Forbidden paths

- `packages/compile/**`, `packages/contracts/**`, `packages/registry/**`, `packages/cli/**`, `packages/federation/**`, `packages/ir/**`, `packages/seeds/**`, `packages/variance/**`, `packages/shave/**`
- `packages/hooks-base/src/intent-specificity.ts` (S1)
- `packages/hooks-base/src/result-set-size.ts` (S2)
- `packages/hooks-base/src/atom-size-ratio.ts` (S3)
- `packages/hooks-base/src/drift-detector.ts` (S5)
- `packages/hooks-base/src/enforcement-config.ts` (threshold authority — untouched)
- `packages/hooks-base/src/telemetry.ts`
- `packages/hooks-base/src/system-prompt.ts`
- `packages/hooks-claude-code/**`, `packages/hooks-cursor/**`, `packages/hooks-codex/**`
- `docs/system-prompts/yakcc-discovery.md`
- `.github/**`, `.claude/**`
- `MASTER_PLAN.md`

### Authority domains touched

- `hook-enforcement-layer-4` (sole runtime domain for this WI)

---

## 7. Decision Log

| DEC-ID | Title | Rationale (one-line) |
|---|---|---|
| `DEC-HOOK-ENF-LAYER4-KEY-CANONICAL-001` | Layer 4 descent-tracker keys canonically derived from atomName | Resolves #600 key-mismatch by canonicalizing inside `descent-tracker.ts`; preserves public API and produces a stronger atom-shaped drift signal for #593. Trade-off: same-atom cross-package descents merge, which is the intended Layer 4 semantic. |

Cross-references:
- `DEC-HOOK-ENF-LAYER4-DESCENT-TRACKING-001` (per-session in-memory, advisory)
- `DEC-HOOK-ENF-LAYER4-MIN-DEPTH-001`
- `DEC-HOOK-ENF-LAYER4-SHALLOW-ALLOW-001`
- `DEC-WI508-S3-KEY-FORMAT-001` (makeBindingKey shape)

---

## 8. Implementer dispatch packet (handoff)

- **Work item:** `wi-600-key-parity`
- **Scope manifest:** §6 above; sync via `cc-policy workflow scope-sync fix-600-layer4-key-parity --work-item-id wi-600-key-parity --scope-file tmp/wi-600-scope.json` BEFORE implementer dispatch.
- **Evaluation contract:** §5 above; written into runtime via `cc-policy` before implementer dispatch.
- **Branch:** `feature/600-layer4-key-parity` already provisioned on `772b0c2`.
- **First action for implementer:** claim #600 with `gh issue edit 600 --add-label serenity` (per `feedback_serenity_claim_label.md`), then implement the canonical-key fix per §3 + write the parity test per §4.
- **Pre-push checklist:** `git fetch origin && git diff --stat origin/main..HEAD` + lint + typecheck BEFORE push (non-negotiable).
