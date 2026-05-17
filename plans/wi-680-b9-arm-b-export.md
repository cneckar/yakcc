# WI-680 — B9 arm-b LLM-emit export prefix fixup

**Issue:** [#680](https://github.com/yakcc/yakcc/issues/680)
**Workflow:** `fix-680-b9-arm-b-export`
**Branch:** `feature/680-b9-arm-b-export`
**Worktree:** `/Users/cris/src/yakcc/.worktrees/feature-680-b9-arm-b-export`
**Status:** active

## Problem

Live B9 runs fail in arm-B classify with:

```
Entry function 'listOfInts' not found in <emit-path>. Available:
```

Empirical root cause (orchestrator-verified): the LLM honors the locked B9 prompt
verbatim — "Implement a TypeScript function with this signature:
`function listOfInts(input: string): readonly number[]`" — and emits a bare
top-level `function listOfInts(input) { ... }` with **no `export` keyword**.
When `bench/B9-min-surface/harness/classify-arm-b.mjs:137` does
`mod[entryFuncName]`, the dynamic ESM `import(...)` exposes no bindings, so
`entryFn` is `undefined` and the harness throws. Same failure mode hits
`measure-axis2.mjs:197` and `measure-axis3.mjs:218`.

This affects all 6 arm-B tasks and blocks single-run full-axis data collection.

## Constraint envelope (do NOT touch)

- `SYSTEM_PROMPT` (line 100) — locked verbatim per DEC-V0-MIN-SURFACE-003
- `TASK_PROMPTS` (lines 104-164) — locked; signatures + behavior + error_conditions
- `EXPECTED_PROMPT_SHA256` (line 182) — `75137b6a18...ffc0d5`
- `verifyPromptSha256` (lines 184-198) — must continue to pass
- `extractCode` (lines 204-210) regex — unchanged; we add a separate post-processor
- All other harness files (`run.mjs`, `measure-axis*.mjs`, `arm-a-emit.mjs`,
  `classify-arm-b.mjs`) — forbidden by Scope Manifest
- Fixtures, tasks, attack-classes, test/ — forbidden by Scope Manifest
- Sibling bench dirs (B1/B4/B5/B6/B7/B8/B10) — forbidden by Scope Manifest

## Fix

Add a single helper `ensureExport(code, entryName)` in
`bench/B9-min-surface/harness/llm-baseline.mjs` and call it on `emittedCode`
**after** `extractCode` returns (lines 319-320), before `writeFileSync`
(line 328). The helper:

1. Returns `code` unchanged if `entryName` is falsy.
2. Returns `code` unchanged if `code` already contains
   `export (default )?function <entryName>` at line-start.
3. Returns `code` unchanged if `code` exports via a named-export object:
   `export { <entryName>` at line-start.
4. Otherwise locates the first bare `function <entryName>(` at line-start
   (multiline anchor) and rewrites it to `export function <entryName>(`,
   preserving leading whitespace.
5. If no match found, returns `code` unchanged (let downstream throw with its
   informative error — we never silently rename or invent).

`entryName` is derived from `TASK_PROMPTS[_taskId].signature` by matching
`/function\s+(\w+)\s*\(/`. This authority is local to `llm-baseline.mjs` and
already drives the locked prompt — no new state source introduced.

### Diff sketch

```js
// New helper, placed below extractCode (after line 210):
function extractEntryNameFromSignature(signature) {
  const m = signature?.match(/function\s+(\w+)\s*\(/);
  return m ? m[1] : null;
}

function ensureExport(code, entryName) {
  if (!entryName) return code;
  if (new RegExp(`(^|\\n)\\s*export\\s+(?:default\\s+)?function\\s+${entryName}\\b`).test(code)) return code;
  if (new RegExp(`(^|\\n)\\s*export\\s+\\{[^}]*\\b${entryName}\\b`).test(code)) return code;
  const bareFn = new RegExp(`(^|\\n)(\\s*)function\\s+${entryName}\\s*\\(`);
  return bareFn.test(code)
    ? code.replace(bareFn, `$1$2export function ${entryName}(`)
    : code;
}

// Inside getLlmBaselineRep, replace lines 319-320:
const emittedCodeRaw = extractCode(responseText);
const def = TASK_PROMPTS[_taskId];
const entryName = def ? extractEntryNameFromSignature(def.signature) : null;
const emittedCode = ensureExport(emittedCodeRaw, entryName);
```

## What this preserves

- Prompt sha256 (we don't touch SYSTEM_PROMPT, TASK_PROMPTS, or the verifier)
- `extractCode` semantics (the code-fence extraction is untouched)
- LLM's actual code body (only the `function` keyword is prefixed, no body edits)
- Idempotency on already-exported emits (fixtures pre-shaped this way are no-op)
- Downstream contract with `classifyArmBEmit`, `measureAxis2`, `measureAxis3`
  (they continue to use `mod[entryFuncName]`; now the export exists)
- Loud failure semantics (if signature parse fails or no bare function found,
  the downstream "Entry function not found" error still fires — we never invent
  a missing entry)

## What this does NOT do

- Does NOT modify the LLM prompt
- Does NOT modify `classify-arm-b.mjs` or any axis measurer
- Does NOT touch fixtures (they are already pre-shaped with exports; fix is a
  no-op on the dry-run path — verified by idempotency check)
- Does NOT add a fallback that picks "any function" — entry name is exact

## Evaluation Contract

### required_tests
- Unit: `ensureExport(codeWithExport, "listOfInts")` returns input unchanged (idempotent)
- Unit: `ensureExport("function listOfInts(x){}", "listOfInts")` returns `"export function listOfInts(x){}"`
- Unit: `ensureExport(codeWithNamedExportObject, "listOfInts")` returns input unchanged
- Unit: `ensureExport("function other(x){}", "listOfInts")` returns input unchanged (no match → no rewrite)
- Unit: `extractEntryNameFromSignature("function listOfInts(input: string): readonly number[]")` returns `"listOfInts"`
- Invariant: prompt sha256 `verifyPromptSha256(SYSTEM_PROMPT, buildUserPrompt("parse-int-list"))` returns `EXPECTED_PROMPT_SHA256`
- Existing B9 dry-run path (`node bench/B9-min-surface/harness/llm-baseline.mjs --dry-run --task parse-int-list`) emits a file that classify-arm-b accepts (no-op on already-exported fixture)

### required_evidence
- Git diff: changes scoped to `bench/B9-min-surface/harness/llm-baseline.mjs` and the plan file only
- Live B9 single-task re-run output (budget ~$0.03) showing arm-b axis2 succeeds with no "Entry function not found" warning on ≥1 of 3 reps. Acceptable: at least 1 of 3 reps per task produces a usable emit; the harness must no longer fail the run with the export-missing error.
- Unit test output (paste of `node --test` or equivalent for the new helper)

### required_real_path_checks
- `bench/B9-min-surface/harness/llm-baseline.mjs` exists and is the only source file modified

### required_authority_invariants
- `SYSTEM_PROMPT` byte-identical
- `TASK_PROMPTS` byte-identical
- `EXPECTED_PROMPT_SHA256` byte-identical
- `extractCode` regex byte-identical
- `verifyPromptSha256` body unchanged

### required_integration_points
- `classifyArmBEmit` (`classify-arm-b.mjs:132`) continues to find `mod[entryFuncName]`
- `measureAxis2` (`measure-axis2.mjs:165`) continues to find `mod[entryFuncName]`
- `measureAxis3` (`measure-axis3.mjs:203`) continues to find `mod[entryFuncName]`

### forbidden_shortcuts
- Modifying the locked prompt or its sha256
- Modifying `classify-arm-b.mjs` to be more lenient (the harness should reject bad emits)
- Falling back to "any function" or `Object.keys(mod)[0]` when the named export is missing
- Inventing a synthetic `export` for an entry name that wasn't declared in the LLM's emit
- Editing `extractCode` to mix prefixing into fence extraction (keep concerns separated)
- Touching forbidden paths under sibling bench dirs or harness/ files other than `llm-baseline.mjs`

### rollback_boundary
Single commit; `git revert <sha>` restores prior state. The helper returns
input unchanged in the trivial paths, so reverting is safe and idempotent.

### acceptance_notes
Smallest possible fix. The LLM's response shape — driven by the locked prompt —
omits `export`; the harness compensates post-extraction without altering the
input contract. The fix is local to `llm-baseline.mjs`. All downstream readers
(`classify-arm-b`, `axis2`, `axis3`) continue to use `mod[entryFuncName]`
unchanged.

### ready_for_guardian_definition
- Diff scoped per Scope Manifest (only `llm-baseline.mjs` + this plan)
- Unit tests pass for `ensureExport` (4 cases above) and `extractEntryNameFromSignature` (1 case)
- Locked prompt sha256 invariant still passes
- Live B9 single-task re-run shows arm-b axis2 succeeds for at least 1 rep of the
  re-run task, with zero "Entry function not found" errors on properly-emitted reps
- PR opened with `Closes #680`

## Scope Manifest

### allowed_paths
- `bench/B9-min-surface/harness/llm-baseline.mjs`
- `plans/wi-680-b9-arm-b-export.md`
- `tmp/wi-680-*` (test artifacts, scratch)

### required_paths
- `plans/wi-680-b9-arm-b-export.md`
- `bench/B9-min-surface/harness/llm-baseline.mjs`

### forbidden_paths
- `bench/B9-min-surface/harness/run.mjs`
- `bench/B9-min-surface/harness/measure-axis*.mjs`
- `bench/B9-min-surface/harness/arm-a-emit.mjs`
- `bench/B9-min-surface/harness/classify-arm-b.mjs`
- `bench/B9-min-surface/fixtures/**`
- `bench/B9-min-surface/tasks/**`
- `bench/B9-min-surface/test/**`
- `bench/B9-min-surface/attack-classes/**`
- All sibling bench dirs (`B1/B4/B5/B6/B7/B8/B10/v0-release-smoke`)
- `packages/**`
- `.github/**`, `.claude/**`, `MASTER_PLAN.md`, `docs/**`, `scripts/**`

### authority_domains_touched
- `b9-arm-b-export-fixup` (post-extract emit normalization within llm-baseline.mjs)

No other state authorities affected. No new authority introduced — entry-name
parsing reads from `TASK_PROMPTS.signature` which is already the local
authority for the locked prompt.
