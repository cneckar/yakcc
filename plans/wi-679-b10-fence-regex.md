# WI-679: Loosen B10 fence regex + diagnostic dump on extract_failed

**Issue:** #679
**Workflow:** `fix-679-b10-fence-regex`
**Worktree:** `.worktrees/feature-679-b10-fence-regex`
**Status:** in_progress

## Problem

`bench/B10-import-replacement/harness/llm-baseline.mjs:139` extracts the model's
TypeScript emit with:

```js
const fenceRe = /```(?:typescript|ts)?\s*\n([\s\S]*?)```/;
```

The trailing `\n` after the optional language tag is mandatory. Real
`claude-sonnet-4-6` responses sometimes open the fence with a space (or other
whitespace) before the first content character instead of an explicit newline,
e.g. ``` ```typescript<space>foo```. Under live mode on `validate-rfc5321-email`
(2026-05-17), all 3 reps returned `extract_failed`, burning $0.0938 for zero
Arm-B data and no visible evidence of what the model actually produced.

## Two changes (smallest possible fix)

### 1. Loosen the fence regex

Replace the mandatory newline with permissive whitespace:

```js
const fenceRe = /```(?:typescript|ts)?\s*([\s\S]*?)```/;
```

Semantics:
- `\s*` still consumes the newline after the tag when it exists (preserves
  current behavior for fixtures that have a newline).
- `\s*` also accepts ``` ```typescript foo```, ``` ```ts\tfoo```, ``` ```\nfoo```,
  and ``` ```typescript\r\nfoo``` without further changes.
- The fence open `` ``` `` plus the optional `typescript|ts` language tag are
  still required — random prose without a triple-backtick fence still returns
  null.
- The wrong-language case (e.g. ``` ```python\nfoo```) still returns null,
  because `(?:typescript|ts)?` followed immediately by `\s*` will not match a
  `python` token before the body; the regex anchors on the fence + optional ts
  tag and then non-greedily captures content up to the next `` ``` ``.

This is the minimum loosening that fixes the observed live-mode failure
without becoming a "treat anything as emit" fallback.

### 2. Diagnostic dump on `extract_failed`

When extraction returns null, dump the raw `responseText` to a tmp file so the
next investigator has actual evidence to look at, instead of a $0.10 black box.

Location: inside `runArmBRep` at the call site of `extractEmitFromResponse`
(line ~279). The function-internal `extractEmitFromResponse` stays pure
(string in, string|null out); the side-effect lives with the caller that
already has `taskId`, `rep`, and a writable tmp area.

Path:
```
tmp/B10-import-replacement/extract-failed-<taskId>-rep<rep>-<unix_ts>.txt
```

Behavior:
- Create the parent dir with `mkdirSync(..., { recursive: true })`.
- Resolved relative to `REPO_ROOT` (already in scope).
- Dump only when `emitText == null` AND `source !== "skipped"` (no-network
  path already records `network_required: true` and has no responseText).
- Never throw out of the dump; wrap in try/catch and log a warn line on
  failure so a tmp write error cannot mask the underlying `extract_failed`.
- The dumped path SHOULD also be surfaced on the result object as
  `extract_failed_dump_path` so callers/logs can find it without grepping.

## Scope

**Allowed:**
- `bench/B10-import-replacement/harness/llm-baseline.mjs`
- `plans/wi-679-b10-fence-regex.md`
- `tmp/wi-679-*/**`

**Required:**
- `plans/wi-679-b10-fence-regex.md`

**Forbidden (highlights, full list in runtime scope manifest):**
- All other `bench/*` benchmarks
- All other B10 harness files (`run.mjs`, `measure-*.mjs`, `arm-a-emit.mjs`,
  `classify-arm-b.mjs`)
- `bench/B10-import-replacement/tasks/**`, `fixtures/**`, `test/**`
- `packages/**`, `.github/**`, `.claude/**`, `docs/**`, `scripts/**`
- `MASTER_PLAN.md`

## Evaluation Contract

Authoritative copy lives in runtime (`workflow work-item-set
--evaluation-json`); mirrored here for implementer/reviewer reference.

**required_tests:**
1. New unit tests for `extractEmitFromResponse`:
   - Accepts ``` ```typescript\nfoo``` `` (newline-after-tag, current path).
   - Accepts ``` ```typescript foo``` `` (space-after-tag, new path — root cause).
   - Accepts ``` ```ts\nfoo``` `` (short tag).
   - Accepts ``` ```\nfoo``` `` (no language tag).
   - Returns `null` on ``` ```python\nfoo``` `` (wrong language — no regression).
   - Returns `null` on plain text with no fence at all.
2. Diagnostic dump triggered on the null path: invoke `runArmBRep` against a
   fixture whose response_text has no fence; assert that a file matching
   `tmp/B10-import-replacement/extract-failed-<task>-rep<rep>-*.txt` appears
   and contains the raw responseText.

**required_evidence:**
- Diff scoped only to `llm-baseline.mjs` + this plan.
- Unit test output (pass).
- Optional: live B10 re-run on previously failing
  `validate-rfc5321-email`; if extract still fails, the dumped raw response
  must be present in `tmp/B10-import-replacement/`.

**required_real_path_checks:**
- `bench/B10-import-replacement/harness/llm-baseline.mjs` still exists and is
  importable.

**required_authority_invariants:**
- `SYSTEM_PROMPT` constant (~line 95-98) is byte-identical to current
  `main` — it is locked by DEC-V0-MIN-SURFACE-003 and DEC-BENCH-B4-HARNESS-001
  for cross-benchmark prompt parity.
- No other harness module is modified.
- No other `bench/*` directory is touched.
- `runArmBRep`'s return shape stays backward-compatible: existing keys
  (`task_id`, `rep`, `source`, `prompt_sha256`, `emit_path`, `emit_text`,
  `error`, optional `input_tokens|output_tokens|cost_usd`) are preserved.
  `extract_failed_dump_path` is added as a new optional key only.

**required_integration_points:**
- Caller `runArmBRep` continues to read `extractEmitFromResponse(...)` return
  value as before; the new dump is an additive side-effect, not a contract
  change.
- The CLI/main path (`isMain` block) still prints `error:` line on
  `extract_failed`; if a dump path is present, it SHOULD also be printed so a
  human running the harness directly sees where to look.

**forbidden_shortcuts:**
- Treating the entire response as emit when no fence is found — this would
  silently mask real LLM-format failures and pollute Arm-B measurements.
- Modifying `SYSTEM_PROMPT` to "ask nicer" for newlines — locked authority.
- Removing or renaming the `extract_failed` error string; downstream
  classifiers (`classify-arm-b.mjs`, `measure-transitive-surface.mjs`) may
  key off it.
- Writing diagnostic dumps anywhere outside `tmp/` (no `/tmp/`, no benchmark
  dirs, no repo-root droppings).
- Catching the dump-write failure silently with no warn line.

**rollback_boundary:** `git revert` of the single landing commit fully
restores prior behavior — no migrations, no schema changes, no downstream
consumers touched.

**acceptance_notes:** Smallest possible fix. The extractor must become MORE
permissive about whitespace between the language tag and the body, but must
remain safe (triple-backtick fence start is still mandatory, wrong-language
tags still return null). The diagnostic dump exists so the NEXT failure costs
zero dollars to diagnose.

**ready_for_guardian_definition:**
- All unit tests above pass.
- Diff scope contains only `llm-baseline.mjs` and `plans/wi-679-b10-fence-regex.md`.
- Branch is fast-forward over `origin/main`.
- Commit message references `#679` (e.g. `Closes #679`).
- Reviewer issues `REVIEW_VERDICT=ready_for_guardian`.

## Out of scope

- Touching any other benchmark harness or the B10 task corpus.
- Adding retry/repair logic to `runArmBRep` (separate decision).
- Reshaping the result schema beyond the additive `extract_failed_dump_path`.
- Modifying the locked SYSTEM_PROMPT to coerce model output format.

## Decision Log (this slice)

- **DEC-WI-679-FENCE-LOOSEN-001** — Replace `\s*\n` with `\s*` in `fenceRe`.
  Minimal change that admits whitespace-only separation (the real-world live
  failure mode) without dropping the fence-start requirement that prevents
  false positives.
- **DEC-WI-679-EXTRACT-DUMP-001** — Diagnostic dump lives in the
  `runArmBRep` caller, not inside `extractEmitFromResponse`. Keeps the pure
  function pure; puts the side-effect where `taskId`/`rep`/`REPO_ROOT` are
  already in scope; matches the existing pattern used to write `emit_path`.
