# WI-610 — Hook substitution emits behavior summary inline

**Workflow ID**: `fix-610-behavior-summary-emit`
**Goal ID**: `g-610-behavior-summary`
**Work Item ID**: `wi-610-behavior-summary`
**Branch**: `feature/610-behavior-summary-emit`
**Worktree**: `/Users/cris/src/yakcc/.worktrees/feature-610-behavior-summary-emit`
**Closes**: #610
**Cross-refs**: #189 (closed B5 measurement), #167 (initiative root), DEC-HOOK-PHASE-3-001

---

## 1. Problem (verbatim from #610)

B5-coherence 2026-05-14 N=50:
- Hook-enabled: mean 4.506, **76.3% subsequent-turn coherent** (below 90% bar)
- Hook-disabled: mean 4.494, 75.6%
- Dominant failure mode (both arms): **`opaque-hash` — 36/37 of 156 turns**

The LLM treats `yakcc:<merkle-root>` as a token with no semantic meaning in subsequent turns. WI-578/579 changed the prompt + enforcement but did not change what the hook substitutes into the LLM's view. The substituted text is still a bare content-addressed reference, giving the LLM no anchor for multi-turn reasoning.

The bench dominance of `opaque-hash` is the proof: improving downstream prompts/enforcement does not move the needle while the surface text the LLM sees is hash-anchored rather than behavior-anchored.

## 2. Surface investigation (planner-only read)

### 2.1 Substitute emit site

`packages/hooks-base/src/substitute.ts` exposes the substitution renderer at two layers:

- `renderSubstitution(atomHash, _originalCode, binding, spec?)` (line 326) — the pure formatter. Today produces:
  - **with spec** (Phase 3): three-line fragment
    ```
    // @atom <atomName> (<inputs => out>; <first-guarantee>) — yakcc:<hash[:8]>
    import { <atomName> } from "@yakcc/atoms/<atomName>";
    const <name> = <atomName>(<args>);
    ```
  - **without spec** (Phase 2 backward-compat): two-line fragment (no contract comment).
- `renderContractComment(atomName, atomHash, spec)` (line 270) — single-line comment builder. **Does not currently include `spec.behavior`** even though SpecYak carries the field.

### 2.2 Spec plumbing IS already in scope

`executeSubstitution` (line 413, in `substitute.ts` — in-scope) already recovers `SpecYak` from the winning candidate's `specCanonicalBytes`:

```ts
const { validateSpecYak } = await import("@yakcc/contracts");
const specJson = new TextDecoder().decode(winningBlock.specCanonicalBytes);
spec = validateSpecYak(JSON.parse(specJson));
```

The full `SpecYak` (including `behavior?: string`) reaches `renderSubstitution`. Therefore **scope-path (a)** applies: no thread-through into forbidden packages is required. The behavior field exists in scope; `renderContractComment` just doesn't render it.

### 2.3 SpecYak.behavior shape

`packages/contracts/src/spec-yak.ts` (read-only inspection, not modified):
- `behavior?: string | undefined` — optional natural-language behavioral description (v0 ContractSpec.behavior).
- Already constrained upstream to single line / ≤256 chars by the canonicalization layer (`source-extract.ts` line 25 comment: "buildSignatureString prevents newlines in behavior field").
- Used as a content-addressing input in `contract-id` — changing the field changes the atom identity, so the field is reliably present for any registry-resolved atom that originated from a v0 ContractSpec.

### 2.4 Risk: parser/regex stability

`yakcc:<hash[:8]>` currently appears as a suffix in the contract comment with an em-dash separator. Downstream tooling that detects atom references already tolerates the comment context. Adding a behavior summary `//` block does not alter the `yakcc:<hash>` token shape.

The bare-hash regex match (`/yakcc:[0-9a-f]{8,}/`) continues to match unchanged. We are appending, not restructuring.

## 3. Design decisions

### 3.1 Format choice: **Option A — comment-form, behavior INSIDE the comment**

Chosen format (single line, single comment):
```
// @atom <atomName> (<signature>; <key-guarantee>) — yakcc:<hash[:8]> — <behavior>
import { <atomName> } from "@yakcc/atoms/<atomName>";
const <name> = <atomName>(<args>);
```

**Rationale**:
- **Parser-safe**: The full token `yakcc:<hash[:8]>` remains intact and contiguous, so every existing detector keeps working. We only add trailing text inside the `//` comment.
- **Token-cost**: One short clause appended to a line that already exists. The behavior field is capped (≤80 chars after our truncation) so worst-case overhead is ~20 tokens per substitution. Net token win remains positive (the substitution replaces an entire implementation body).
- **LLM anchor strength**: Behavior is the dominant semantic anchor for multi-turn reasoning (per #610 problem statement). Placing it on the same line as the atom name and hash binds them together as one "card" — the LLM cannot reason about the hash without also seeing the behavior.
- **Rejected Option B (`yakcc:<hash>#<short-signature>` fragment-style)**: Breaks the `yakcc:<hash>` token boundary (regex matchers anchored on `\b` after the hash would now match `#`), and the signature is already in the parenthetical of the existing contract comment. Adding behavior to the comment is strictly more informative.

### 3.2 Truncation + fallback rules

- **Max behavior length**: 80 characters. If `behavior.length > 80`, truncate to 77 chars + `...`.
- **Newline handling**: replace any embedded `\n` or `\r` with a single space before truncation (defense-in-depth; upstream already prevents newlines but we never trust upstream).
- **Whitespace collapse**: collapse runs of whitespace to a single space.
- **Empty/missing behavior**: when `spec.behavior` is `undefined`, empty after trim, or only whitespace, **omit the ` — <behavior>` trailer entirely**. The existing Phase-3 line `// @atom name (sig; guarantee) — yakcc:<hash>` is the fallback. (No `atomName`-as-behavior duplication — atomName is already in the comment.)
- **No-spec path** (Phase 2 backward-compat, two-line fragment, no contract comment): **unchanged**. If we have no spec we have no behavior either; the existing two-line output stands.

### 3.3 Scope path: **(a) use already-in-scope plumbing**

The behavior field is reachable today through `executeSubstitution`'s existing `validateSpecYak` recovery path. No new accessor, no thread-through, no contracts/registry/ir edits. The change is purely **additive rendering** inside `renderContractComment` (and a small wrapper to format the behavior trailer cleanly).

This keeps the diff inside `packages/hooks-base/src/substitute.ts` plus its tests. Zero risk of touching forbidden packages.

## 4. Diff sketch

### 4.1 `packages/hooks-base/src/substitute.ts`

Add one helper and extend `renderContractComment`:

```ts
/**
 * Maximum rendered behavior-summary length, including ellipsis when truncated.
 * Chosen to keep the contract comment under ~200 chars even with long atom names
 * and guarantees — token-cost discipline per DEC-HOOK-PHASE-3-001.
 *
 * @decision DEC-HOOK-BEHAVIOR-SUMMARY-EMIT-001
 */
const MAX_BEHAVIOR_SUMMARY_LENGTH = 80;

/**
 * Normalize and truncate spec.behavior for inline rendering.
 *
 * Returns null when the behavior field is missing, empty after trim, or only
 * whitespace — caller must omit the trailer in that case.
 *
 * @decision DEC-HOOK-BEHAVIOR-SUMMARY-EMIT-001
 */
function normalizeBehaviorForEmit(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const collapsed = raw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= MAX_BEHAVIOR_SUMMARY_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_BEHAVIOR_SUMMARY_LENGTH - 3)}...`;
}
```

Then extend `renderContractComment` (current line 270) to append the trailer when present:

```ts
export function renderContractComment(atomName: string, atomHash: string, spec: SpecYak): string {
  // ... existing inputs/outputs/signature/parenthetical logic unchanged ...
  const shortHash = atomHash.slice(0, 8);
  const base = `// @atom ${atomName} ${parenthetical} — yakcc:${shortHash}`;

  const behavior = normalizeBehaviorForEmit(spec.behavior);
  if (behavior === null) return base;
  return `${base} — ${behavior}`;
}
```

That's the entire production change. No call-site changes, no public API change, no schema change.

### 4.2 `packages/hooks-base/src/index.ts`

If `normalizeBehaviorForEmit` and `MAX_BEHAVIOR_SUMMARY_LENGTH` need to be exported for testing in isolation, add them to the barrel. If the test imports directly from `substitute.ts`, no barrel change is required. **Implementer to pick whichever surface keeps the index.ts diff minimal.**

### 4.3 `packages/hooks-base/src/enforcement-types.ts`

**No changes anticipated.** The output type of `renderContractComment` is still `string`; envelopes are not affected. Implementer should verify and skip if no change is needed.

### 4.4 `packages/hooks-base/test/substitute-behavior-summary.test.ts` (new)

Cases:
1. **Behavior present, short** → trailer rendered verbatim.
2. **Behavior present, length 80** → rendered verbatim (no truncation at boundary).
3. **Behavior present, length 81** → truncated to 77 chars + `...`, total length 80.
4. **Behavior present with embedded newline** → newline replaced with single space.
5. **Behavior present with multiple internal spaces** → collapsed to single spaces.
6. **Behavior undefined** → no trailer (base format preserved).
7. **Behavior empty string** → no trailer.
8. **Behavior whitespace-only** → no trailer.
9. **End-to-end via `executeSubstitution` happy path** → substitutedCode contains the full three-line fragment with the behavior trailer when a candidate's spec carries `behavior`.
10. **Regex stability**: `/yakcc:[0-9a-f]{8}/` still matches the rendered comment with and without the trailer.

### 4.5 `packages/hooks-base/test/enforcement-eval-corpus.json` + `.test.ts`

Add one corpus row that exercises a substitution with a known behavior string and asserts the rendered comment contains both `yakcc:<hash[:8]>` and the truncated behavior trailer. This is the end-to-end safety net — proves the change reaches the substitute renderer through the full pipeline, not just a unit harness.

## 5. Evaluation Contract (mirror to runtime via cc-policy)

- **required_tests**:
  - `packages/hooks-base/test/substitute-behavior-summary.test.ts` exists and all cases (1–10 above) pass.
  - Existing `packages/hooks-base/test/substitute.test.ts`, `substitute.props.test.ts`, `substitution-integration.test.ts` pass unchanged.
  - Existing L1–L5 layer tests (`intent-specificity*.test.ts`, `result-set-size*.test.ts`, `atom-size-ratio*.test.ts`, `descent-tracker*.test.ts`, `drift-detector*.test.ts`) pass unchanged (no regression in layer envelopes).
  - `descent-tracker-key-parity.test.ts` passes unchanged (Layer 4 key canonicalization untouched).
  - `enforcement-eval-corpus.test.ts` passes including the new row.
- **required_evidence**:
  - Diff is scoped to allowed_paths only — no edits in forbidden packages.
  - `plans/wi-610-behavior-summary-emit.md` committed.
  - Test output (pnpm vitest run for hooks-base) attached to reviewer/guardian handoff with explicit pass counts.
- **required_real_path_checks**:
  - `packages/hooks-base/src/substitute.ts` present and continues to export `renderContractComment` and `renderSubstitution`.
  - `executeSubstitution`'s `validateSpecYak` recovery path still produces a `spec` reaching `renderSubstitution`.
- **required_authority_invariants**:
  - `packages/hooks-base/src/enforcement-config.ts` untouched (sole enforcement-threshold authority).
  - All Layer modules (L1 `intent-specificity.ts`, L2 `result-set-size.ts`, L3 `atom-size-ratio.ts`, L4 `descent-tracker.ts`, L5 `drift-detector.ts`) untouched.
  - No IDE-adapter package source touched (`packages/hooks-claude-code/*`, `packages/hooks-cursor/*`, `packages/hooks-codex/*`).
  - No `packages/contracts`, `packages/registry`, `packages/ir`, `packages/cli`, `packages/federation`, `packages/shave`, `packages/variance`, `packages/seeds`, `packages/compile` source touched.
  - Token-detection regexes that match `yakcc:<hash>` still work (parser safety — verified by test case 10).
- **required_integration_points**:
  - The substitute emit format is the integration surface between hooks-base and the LLM. The change is purely additive — comment trailing text — and does not alter import/binding lines.
  - Spec recovery in `executeSubstitution` is the integration surface between the registry candidate block and the renderer. We rely on existing behavior; we do not modify spec recovery.
- **forbidden_shortcuts**:
  - Modifying any Layer module (L1–L5) or `enforcement-config.ts`.
  - Touching `packages/contracts`, `packages/registry`, `packages/ir` (or any forbidden package per the workflow scope).
  - Embedding multi-line strings in the contract comment.
  - Skipping pre-push hygiene (rebase to origin/main + tests + lint + typecheck) per `feedback_pre_push_hygiene.md`.
  - Including a bench re-run in this WI (compute-heavy; explicit follow-up WI).
  - Re-shaping the contract comment in ways that break the existing `// @atom <name> (...) — yakcc:<hash>` prefix; the trailer must be additive.
- **rollback_boundary**: Single-commit git revert. Reverting restores the prior contract comment without behavior trailer. No schema/state migrations.
- **acceptance_notes**:
  - Bench re-run (B5 N=50, target ≥85% subsequent-turn coherence and ≥30% drop in `opaque-hash`) is **explicitly out of scope** here and tracked as a follow-up WI.
  - Pre-push hygiene is non-negotiable per memory note `feedback_pre_push_hygiene.md`.
- **ready_for_guardian_definition**:
  - All required tests pass on the current head.
  - Corpus row added and passing.
  - `plans/wi-610-behavior-summary-emit.md` committed.
  - Reviewer issues `REVIEW_VERDICT=ready_for_guardian` with current head SHA.
  - PR opened on `feature/610-behavior-summary-emit` with `Closes #610`.
  - Follow-up bench WI filed as a GitHub issue (link captured in PR description).

## 6. Scope Manifest (mirror to runtime via cc-policy)

### Allowed files / directories
- `packages/hooks-base/src/substitute.ts`
- `packages/hooks-base/src/enforcement-types.ts`
- `packages/hooks-base/src/index.ts`
- `packages/hooks-base/test/substitute-behavior-summary.test.ts`
- `packages/hooks-base/test/enforcement-eval-corpus.json`
- `packages/hooks-base/test/enforcement-eval-corpus.test.ts`
- `plans/wi-610-behavior-summary-emit.md`
- `tmp/wi-610-*` (and recursive)

### Required files
- `plans/wi-610-behavior-summary-emit.md`
- `packages/hooks-base/src/substitute.ts`
- `packages/hooks-base/test/substitute-behavior-summary.test.ts`

### Forbidden touch points
- `packages/compile/**`, `packages/contracts/**`, `packages/registry/**`, `packages/cli/**`, `packages/federation/**`, `packages/ir/**`, `packages/seeds/**`, `packages/variance/**`, `packages/shave/**`
- `packages/hooks-base/src/intent-specificity.ts`
- `packages/hooks-base/src/result-set-size.ts`
- `packages/hooks-base/src/atom-size-ratio.ts`
- `packages/hooks-base/src/descent-tracker.ts`
- `packages/hooks-base/src/drift-detector.ts`
- `packages/hooks-base/src/enforcement-config.ts`
- `packages/hooks-base/src/telemetry.ts`
- `packages/hooks-base/src/system-prompt.ts`
- `packages/hooks-base/src/import-intercept.ts`
- `packages/hooks-claude-code/**`, `packages/hooks-cursor/**`, `packages/hooks-codex/**`
- `docs/system-prompts/yakcc-discovery.md`
- `.github/**`, `.claude/**`, `MASTER_PLAN.md`, `bench/**`

### State authorities touched
- `hook-substitute-emit` — the rendered text returned by `renderContractComment` / `renderSubstitution`. This is the workflow-bound authority; no other domain is mutated.

## 7. Risk & rollback

| Risk | Mitigation |
|------|------------|
| Behavior summary contains adversarial text that breaks LLM parsing | Truncation + whitespace normalization in `normalizeBehaviorForEmit`. The summary remains inside a `//` comment so the worst-case is a noisy comment line. |
| Increase in per-substitution token cost | Capped at 80 chars + 3-char separator. Net token budget remains positive against the avoided implementation body emission. |
| Bench movement smaller than predicted | This WI is the code change. The bench measurement is the follow-up WI; it has its own pass/fail criteria. If `opaque-hash` does not drop ≥30%, the follow-up WI decides whether to iterate format or to escalate to richer signature emission. |
| Drift between rendered comment and downstream `yakcc:<hash>` matchers | Test case 10 pins the regex behavior. No change to the hash token shape or placement. |

**Rollback**: `git revert <commit>` removes the trailer and restores the prior contract comment. No state migrations.

## 8. Follow-up bench WI shape (out of scope here, file separately)

- **Title**: `bench(B5): re-run N=50 with WI-610 behavior-summary emit`
- **Scope**: `bench/B5-coherence/**`, `tmp/B5-coherence/**`
- **Acceptance**: re-run B5 slice2 corpus with WI-610 landed; compare `failureModeCounts.opaque-hash` and `subsequent-turn coherence`; target ≥30% drop in `opaque-hash` and ≥85% subsequent-turn coherence.
- **Dependency**: WI-610 landed on `main`.
- **Rollback**: pure measurement WI; no code change.

## 9. Decision log

- **DEC-HOOK-BEHAVIOR-SUMMARY-EMIT-001** — Append normalized `spec.behavior` (≤80 chars, whitespace-collapsed, ellipsis-truncated, omitted when empty) as a trailing `— <behavior>` clause on the existing `// @atom ...` contract comment. Rendered only on the Phase-3 with-spec path; the Phase-2 two-line backward-compat output is unchanged. Rationale: parser-safe (preserves `yakcc:<hash>` token boundary), additive (single-commit rollback), uses already-in-scope spec plumbing (no thread-through into forbidden packages), and binds the behavior anchor to the same comment line as the atom name and hash for multi-turn LLM coherence.

---

PLAN_VERDICT: next_work_item
PLAN_SUMMARY: WI-610 ready for implementer — append normalized `spec.behavior` trailer to existing `// @atom ...` contract comment in `renderContractComment` (substitute.ts), using already-in-scope `executeSubstitution` spec recovery; new unit test + corpus row; bench re-run filed as separate follow-up WI.
