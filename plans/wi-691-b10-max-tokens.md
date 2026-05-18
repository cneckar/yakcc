# WI-691: B10 max_tokens fix + graceful unclosed-fence fallback

**Issue:** #691
**Workflow:** fix-691-b10-max-tokens
**Worktree:** `.worktrees/feature-691-b10-max-tokens`
**Builds on:** #679 (fence regex loosening + diagnostic dump, landed 03c566e)

## Problem

Live B10 runs on realistic LLM responses (e.g. `validate-rfc5321-email`) truncate at
`max_tokens: 2048`. The model emits a full validator that exceeds the budget mid-stream,
leaving the response with an opening ` ```typescript ` fence but no closing fence.
Current `extractEmitFromResponse` regex requires a closing fence and returns `null`,
producing `extract_failed` for the whole rep — yielding PENDING verdicts and zero axis1
(LOC/bytes) data even when 95% of the implementation arrived intact.

#679 added a diagnostic dump for this case (`tmp/B10-import-replacement/extract-failed-*.txt`),
which now confirms the root cause: every dump for validate-rfc5321-email shows a truncated
response with one opening fence and no closing fence.

## Fix (two parts)

### Part A — Raise max_tokens to 8192

`bench/B10-import-replacement/harness/llm-baseline.mjs:238`:
`max_tokens: 2048` → `max_tokens: 8192`.

Rationale: covers full RFC validators, cron parsers, JWT validators, etc. Cost is paid
per actual output token, not per `max_tokens` ceiling — the increase is essentially free
on tasks that don't need it. The header comment (lines 24-25) must also be updated to
reflect the new value, otherwise the documented "MODEL / SAMPLING" claim drifts from
the live call. Note that this is B10-specific — B9's `max_tokens=2048` remains
unchanged because B9 tasks are deliberately small (digit-sum, kebab-to-camel, etc.) and
prompt-parity with B4 is about prompt text, not sampling ceiling. Document this delta
explicitly in the same header comment so future readers don't "fix" the divergence.

### Part B — Graceful unclosed-fence fallback in `extractEmitFromResponse`

Current primary regex (line 164) — UNCHANGED:
```
/```(?:(?:typescript|ts)[^\n]*)?\n([\s\S]*?)```/
```

Add secondary fallback that runs only when primary returns `null`:
```
/```(?:(?:typescript|ts)[^\n]*)?\n([\s\S]*)$/
```

Anchored at `$` (end of input). Same fence-open rules as primary (requires
` ``` ` + optional `typescript|ts` + optional trailing chars + mandatory `\n`),
so `python` fences still reject and bare ` ``` ` fences still match.

Function signature must change because the caller needs to distinguish
"truncated" from "extracted cleanly":
```js
// Before:  function extractEmitFromResponse(text) -> string | null
// After:   function extractEmitFromResponse(text) -> { text: string, truncated: boolean } | null
```

- Primary match → `{ text, truncated: false }`
- Secondary match → `{ text, truncated: true }`
- No match → `null`

### Part B integration in `runArmBRep`

Line 304 caller updates:
- Destructure `const extracted = extractEmitFromResponse(responseText)`
- `emitText = extracted?.text ?? null` (existing diag-dump / file-write logic keeps working as-is on truthy emit text)
- New result fields: `truncated_emit: extracted?.truncated ?? false`
- Error string when truncated: `"truncated_emit: closing fence missing (max_tokens=8192 exceeded)"`
- Error string when no fence at all: existing `"extract_failed: no \`\`\`typescript fence in response"`
- On truncation, the rep still writes the `.mjs` file so downstream axis1 measurement can run on the partial output.
- The diagnostic dump at lines 327-338 should fire only on true `extract_failed` (no fence), NOT on truncation — gated on `extracted == null && source !== "skipped"`. Truncated reps are already represented by the written `.mjs` file plus the `truncated_emit` flag, so the extra `.txt` dump is redundant evidence.

## Unit tests

New test file: `bench/B10-import-replacement/test/extractEmit.test.mjs` (or equivalent
sibling next to existing B10 tests — implementer to confirm location).

Required cases:
1. **Closed fence (typescript)**: returns `{ text: "...", truncated: false }`
2. **Closed fence (ts)**: returns `{ text: "...", truncated: false }`
3. **Closed bare fence (` ``` `)**: returns `{ text: "...", truncated: false }`
4. **Closed fence with trailing annotation (` ```typescript foo `)**: returns `{ text, truncated: false }` (regression guard for #679)
5. **Unclosed fence (typescript)**: returns `{ text: "...", truncated: true }`
6. **Unclosed bare fence**: returns `{ text, truncated: true }`
7. **python fence**: returns `null` (rejection preserved, both primary and fallback)
8. **No fence at all**: returns `null`
9. **max_tokens constant**: sanity test that the literal in `llm-baseline.mjs` equals `8192` (regex-extract or import)

Optional caller-level test (if scaffolding permits without live API): construct a
truncated-fence response, pass through `runArmBRep` with dry-run shim, assert
`truncated_emit === true` and `error` string contains `"truncated_emit"`.

## Live verification

After unit tests pass, run live B10 on `validate-rfc5321-email`:
```
node bench/B10-import-replacement/harness/run.mjs --task validate-rfc5321-email --reps 1
```

Expected:
- Either PASS-DIRECTIONAL (full emit fit in 8192) or WARN-DIRECTIONAL with `truncated_emit: true` (still hit 8192 ceiling but axis1 has data)
- No PENDING verdict
- `tmp/B10-import-replacement/.../arm-b-rep0.mjs` present and non-empty
- Cost: under $0.15 for one rep at ~8K tokens output

## Authority invariants (must not regress)

- Locked SYSTEM_PROMPT text + sha256 — UNCHANGED (lines 95-98)
- `buildUserPrompt` template — UNCHANGED
- `promptSha256` algorithm — UNCHANGED
- Primary fence regex semantics for CLOSED fences — UNCHANGED (only ADDS unclosed fallback)
- `python` fence rejection — UNCHANGED in both primary and fallback paths

## Scope

**Allowed:**
- `bench/B10-import-replacement/harness/llm-baseline.mjs`
- `bench/B10-import-replacement/test/extractEmit.test.mjs` (new)
- `plans/wi-691-b10-max-tokens.md`
- `tmp/wi-691-*`, `tmp/wi-691-*/**/*`

**Required:**
- `plans/wi-691-b10-max-tokens.md`

**Forbidden:**
- Any other bench dir (B1/B4/B5/B6/B7/B8/B9, v0-release-smoke)
- Other B10 harness files (`run.mjs`, `measure-*.mjs`, `arm-a-emit.mjs`, `classify-arm-b.mjs`)
- B10 `tasks/`, `fixtures/`, existing non-extract `test/` files
- `packages/**`, `.github/**`, `.claude/**`, `docs/**`, `scripts/**`, `MASTER_PLAN.md`

## Rollback boundary

Single commit, single file change in `llm-baseline.mjs` + one new test file.
`git revert <sha>` cleanly reverts both parts.

## Acceptance

- All 9+ unit tests pass
- Live B10 rerun on `validate-rfc5321-email` produces non-PENDING verdict
- PR opened with `Closes #691`
- No regression in #679 fence-regex tests (run B10 test suite)
- Header comment at lines 24-25 reflects `max_tokens=8192` (B10-specific) with explicit
  note that this diverges from B9's `max_tokens=2048` by design
