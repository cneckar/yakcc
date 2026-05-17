# WI-512 Slice 3 — B10 Import-Heavy Bench: BROADEN + Headline + CLOSE #512

**Issue:** [#512](https://github.com/cneckar/yakcc/issues/512) — "B10 import-heavy bench — measure transitive reachable surface vs natural-import baseline"
**Workflow:** `wi-512-s3-b10-broaden`
**Branch / worktree:** `feature/wi-512-s3-b10-broaden` @ `C:/src/yakcc/.worktrees/wi-512-s3-b10-broaden`
**Fork point:** `e6b0a34` (post-#626 S2 merge; `main`)
**Stage:** planner (plan only — no source code in this pass)
**Authored:** 2026-05-16
**Complexity tier:** Tier 2 (Standard) — broadening an already-proven instrument across an already-proven corpus; bounded touch surface (bench-local + per-task additions); per-task selection rationale; one new measurement axis (CVE fold-in) plus the headline acceptance table.

This document is the **Slice 3** plan that owns the FINAL slice of [#512](https://github.com/cneckar/yakcc/issues/512). On merge, S3 closes #512 and the entire import-replacement triad (#508 + #510 + #512) is complete. It is subordinate to:

- the parent slice plan `plans/wi-512-b10-import-heavy-bench.md` (§3b.1 — "S3 = triad P5 — broaden + CVE fold-in + headline ≥90% on ≥10 tasks");
- the reframed triad coordination plan `plans/import-replacement-triad.md` (§4 #512 Slice 3 — broadening; §1 desired-end-state artifact already proven by S2);
- the S2 plan `plans/wi-512-s2-b10-demo-task.md` as the per-task template (S3 mirrors its task-layout pattern N times, not 1).

It does not modify `MASTER_PLAN.md`, does not touch the production registry, does not change `bench/B9-min-surface/**`, and does not touch the already-landed `validate-rfc5321-email` task (READ-ONLY for S3).

---

## 1. Problem statement — what S3 delivers that S1+S2 cannot

### 1.1 Recap — what S1 and S2 left on the table

S1 (PR #521 / `950afdc`) landed the instrument: `measure-transitive-surface.mjs` resolver, harness, synthetic-fixture exact-count test suite (T1–T11), B9-corpus smoke fixture.

S2 (PR #626 / `e6b0a34`) landed the first import-heavy reading: `validate-rfc5321-email` with the canonical `import validator from 'validator'` baseline. The S2 dry-run artifact (`bench/B10-import-replacement/results-win32-2026-05-17.json`) shows:

| Arm | reachable_functions | reachable_bytes | reachable_files | unique_non_builtin_imports |
|---|---|---|---|---|
| Arm A (yakcc) | 6 | 5,301 | 1 | 0 |
| Arm B (validator) | 511 | 260,056 | 114 | 1 |
| **Reduction** | **98.8%** | **98.0%** | — | — |

That is **one** reading — far above ≥90% threshold but **one** is not the issue's acceptance bar. Issue #512 acceptance: **"On ≥10 of the 12–20 tasks, Arm A reachable surface is at least 90% smaller than Arm B by both function count and total bytes."** S3 produces that distribution.

S2 also did NOT deliver the issue's secondary metric "npm-audit CVE pattern matches over the traversed set" as a per-PR headline reporting axis. The S1 resolver already wires `--audit` and emits `npm_audit.cve_pattern_matches`, but the harness's per-task report and the PR-body table do not yet treat CVE matches as a headline axis. S3 folds this in per the issue's "Secondary metrics" stanza and per `plans/wi-512-b10-import-heavy-bench.md` §3.6 / triad plan §6.

### 1.2 What S3 must deliver

S3 turns the proven instrument into the proven headline:

1. **A broadened import-heavy task corpus** — 15 tasks total (14 new + the S2 task), each consuming a WI-510 atom set as Arm A and a real npm import as Arm B.
2. **B9-Axis-4 (CVE) fold-in** into the per-task report and the suite summary, surfaced as a third axis in the headline PR-body table alongside `reachable_functions` and `reachable_bytes`.
3. **A headline `results-<platform>-<date>.json` artifact** showing that ≥10 of the 15 tasks meet `verdict: PASS-DIRECTIONAL` on BOTH `reachable_functions` and `reachable_bytes` (≥90% reduction).
4. **#512 closer:** PR uses `Closes #512` in the body; on merge, this PR retires #512 and completes the import-replacement triad (#508 + #510 + #512 all closed).

### 1.3 Why "15 tasks" and not "12" or "20"

The parent issue body says "12–20 tasks." S2 already landed `validate-rfc5321-email` (1 of N). The triad plan §1 desired-end-state was a *single* demo task; the broader number is the headline-confidence number.

**Why 14 new (15 total):**
- The 11 npm packages WI-510 covered (per #510 issue body) have 20 distinct candidate headline bindings (enumerated in §2 below).
- ≥10 PASS-DIRECTIONAL is the issue's bar. To survive 1–2 task drops to engine-gap-disclosed PENDING/SKIP without re-planning, the corpus needs ≥12 actionable tasks. 15 provides comfortable margin (3 tasks could drop and the ≥10 bar still holds).
- Each additional task above 15 multiplies implementer cost (per-task: spec.yak + 3 arm-a files + oracle + fixture + ~5 test cases + entry-function wiring + INLINE_SPECS entry + corpus-spec entry + prompt sha256 lock). 15 is the natural balance point.
- 20 is achievable as an S3-extension (a follow-on slice) if the operator wants the full enumeration. Slice 3 ships 15 and reserves the 5 remaining as a backlog candidate (§6).

**`DEC-BENCH-B10-SLICE3-TASK-CORPUS-SIZE-001`** captures this: target = 14 new tasks (15 total), with a soft floor of 12 actionable PASS-DIRECTIONAL tasks for the ≥10 bar after engine-gap attrition.

---

## 2. Task corpus selection

### 2.1 Candidate enumeration (the universe of 20)

From the parent issue body, mapped to WI-510 atoms shipped via S2–S9 (PRs #544 / #570 / #573 / #584 / #586 / #598 / #616 / #623):

| # | Task ID | LLM-natural Arm B import | WI-510 source | Atom availability |
|---|---|---|---|---|
| 1 | `validate-rfc5321-email` | `validator` `isEmail` | S2 (#544) | **LANDED IN S2** — READ-ONLY |
| 2 | `validate-uuid-format` | `validator` `isUUID` | S2 (#544) | available |
| 3 | `validate-url-format` | `validator` `isURL` | S2 (#544) | available |
| 4 | `semver-range-satisfies` | `semver` `satisfies` | S3 (#570/#571) | available |
| 5 | `coerce-semver` | `semver` `coerce` | S3 (#570/#571) | available |
| 6 | `uuid-v4-generate-validate` | `uuid` `v4` + `validate` | S4 (#573) | available |
| 7 | `nanoid-generate` | `nanoid` | S4 (#573) | available |
| 8 | `parse-rfc3339-datetime` | `date-fns` `parseISO` | S5 (#584) | available |
| 9 | `format-iso-date` | `date-fns` `formatISO` | S5 (#584) | available |
| 10 | `add-business-days` | `date-fns` `addDays` | S5 (#584) | available |
| 11 | `verify-jwt-hs256` | `jsonwebtoken` `verify` | S6 (#586) | available |
| 12 | `decode-jwt-header-claims` | `jsonwebtoken` `decode` | S6 (#586) | available |
| 13 | `bcrypt-verify-constant-time` | `bcryptjs` `compare` | S6 (#586) | **engine-gap-disclosed** (issue #585 OPEN; `dist/bcrypt.js` UMD IIFE stubbed; atom = stub) |
| 14 | `cycle-safe-deep-clone` | `lodash` `cloneDeep` | S7 (#598) | available |
| 15 | `debounce-with-flush-cancel` | `lodash` `debounce` | S7 (#598) | available |
| 16 | `throttle-trailing-edge` | `lodash` `throttle` | S7 (#598) | available |
| 17 | `lodash-deep-merge` | `lodash` `merge` | S7 (#598) | available |
| 18 | `validate-string-min-max` | `zod` `string().min().max()` | S8 (#616) | **engine-gap-disclosed** (issues #576/#619 OPEN; mapped via helper-file pattern per `DEC-WI510-S8-HELPER-FILE-MAPPING-001`) |
| 19 | `rate-limit-sliding-window` | `p-throttle` or `p-limit` | S9 (#623) | available (S9 was the FINAL WI-510 slice; clean ESM atoms) |
| 20 | `format-ms-duration` | `ms` | S1 (#526) | available (`ms` was the gentle Slice 1 fixture) |

### 2.2 Selection — 14 new tasks (15 total with the S2 task)

**`DEC-BENCH-B10-SLICE3-TASK-CORPUS-SELECTION-001`** — The 14 new S3 tasks (alphabetical, S2 already done):

| Task ID | Library | Binding | Rationale for inclusion |
|---|---|---|---|
| `add-business-days` | date-fns | addDays | Diversifies date-fns axis; small atom set (4 modules per WI-510 S5); clean closure. |
| `bcrypt-verify-constant-time` | bcryptjs | compare | **Ship as PENDING-disclosed.** Engine gap #585 OPEN — `bcryptjs/dist/bcrypt.js` UMD IIFE stubbed. Arm A is a hand-translated constant-time-compare reference; corpus entry includes `engine_gap_disclosure: "#585"`. Provides honesty signal in the headline. |
| `coerce-semver` | semver | coerce | Diversifies semver axis; smaller subgraph (~8 modules) than satisfies (~18). |
| `cycle-safe-deep-clone` | lodash | cloneDeep | The canonical lodash whale — cloneDeep pulls a large transitive surface (lodash@4 has 200+ files); this task drives the largest expected delta in the corpus. |
| `debounce-with-flush-cancel` | lodash | debounce | Most-imported lodash function (per npm download stats) — high-impact demonstration. |
| `decode-jwt-header-claims` | jsonwebtoken | decode | Smallest jsonwebtoken binding (1 module per WI-510 S6); proves the bench measures even thin import-heavy tasks. |
| `format-iso-date` | date-fns | formatISO | Subdirectory traversal (`_lib/addLeadingZeros`) — exercises the resolver on real subdirectory edges. |
| `format-ms-duration` | ms | (default export) | Smallest npm package in the corpus; single-file (`ms/index.js`); proves the bench works at the small end too. |
| `lodash-deep-merge` | lodash | merge | Large transitive surface, complementary to cloneDeep on a different lodash entry. |
| `nanoid-generate` | nanoid | (default export) | Small package with a `crypto` Node-builtin foreign leaf (DEC-WI510-S4-NODE-BUILTIN-FOREIGN-LEAF-001) — proves builtin exclusion still works correctly when traversed transitively. |
| `parse-rfc3339-datetime` | date-fns | parseISO | Most-cited date-fns binding for the LLM-natural "parse an ISO date" prompt. |
| `rate-limit-sliding-window` | p-throttle | (default export) | Pure-ESM package (Sindre Sorhus); proves the resolver handles pure-ESM cleanly. (Per WI-510 S9 — atom is the package's single-file index.js entry; zero external deps as of p-throttle@8.) |
| `semver-range-satisfies` | semver | satisfies | Largest semver subgraph (~18 modules) — diverse transitive shape. |
| `throttle-trailing-edge` | lodash | throttle | Companion to debounce; both share lodash root surface. |
| `uuid-v4-generate-validate` | uuid | v4 + validate | Combines TWO bindings in one task (the natural LLM solution is `import { v4, validate } from 'uuid'`); exercises multi-import resolution. |
| `validate-string-min-max` | zod | `z.string().min(...).max(...)` | **Ship as PENDING-disclosed if engine-gap-blocks.** Engine gap #576/#619 OPEN — zod helper-file mapping (`DEC-WI510-S8-HELPER-FILE-MAPPING-001`) means the Arm A reference is the working helper module the binding semantically depends on (`util.cjs`/`parseUtil.cjs`), NOT the binding-bearing source. Disclosed per WI-510 S8 precedent. |
| `validate-url-format` | validator | isURL | Already-validated validator atom set; diversifies away from email. |
| `validate-uuid-format` | validator | isUUID | Smallest validator binding (~7 modules per WI-510 S2 lower bound); proves the bench measures small-closure tasks too. |
| `verify-jwt-hs256` | jsonwebtoken | verify | Largest jsonwebtoken binding; multi-element npm externalSpecifiers per `DEC-WI510-S6-NPM-EXTERNAL-FAN-OUT-001` (jws, crypto, ms, semver) — large transitive surface guaranteed. |

That is 14 new + 1 S2 = **15 total**.

**Deferred (S3-extension candidate, NOT in S3 scope):**
- The remaining 5 candidates from §2.1 row 1: any second-binding-per-library combinations not chosen above (e.g. a third validator binding, a fourth lodash binding). Filed as a backlog item per §6.

### 2.3 Selection criteria applied

1. **Diversity across libraries** — at least one task per WI-510 library that has shipped atoms (validator ×3, semver ×2, uuid ×1, nanoid ×1, date-fns ×3, jsonwebtoken ×2, bcryptjs ×1, lodash ×4, zod ×1, p-throttle ×1, ms ×1). Total = 18 atoms / 11 libraries — but corpus has only 15 tasks because some libraries contribute 1 (uuid, nanoid, bcryptjs, zod, p-throttle, ms) and the larger ones contribute 2–4 to surface different shapes.

   *Reconciliation:* the count above is *atom-references*; one task can pin one binding. The corpus has 15 distinct tasks covering 11 libraries (validator ×3, semver ×2, date-fns ×3, jsonwebtoken ×2, lodash ×4, uuid ×1, nanoid ×1, bcryptjs ×1 [disclosed], zod ×1 [disclosed], p-throttle ×1, ms ×1) — every WI-510-covered library has at least one task.

2. **Atom maturity** — every selected task's underlying atoms were already shaved + reviewer-validated in WI-510 S2–S9, with `combinedScore >= 0.55` (uuid S4) / `>= 0.70` (most others) gated in the corresponding `*-headline-bindings.test.ts`. No new shaving work in S3.

3. **Expected delta magnitude** — the corpus spans the surface-size spectrum: ms (tiny), validator (medium), lodash (huge). This stress-tests the ≥90% threshold across orders of magnitude.

4. **Engine-gap honesty** — bcryptjs (#585) and zod (#619/#576) are explicitly included AS engine-gap-disclosed entries so the headline number reflects the honest truth, not a cherry-picked subset. This is the same WI-510 S8 / S6 honesty discipline.

5. **Implementer cost bounded** — 14 new tasks × ~120 LOC of arm-a per task (3 strategies × ~40 LOC) + ~80 LOC oracle + ~5 small test cases + 1 fixture + 1 spec.yak + corpus-spec entry ≈ ~3,000 LOC of bench-local `.mjs` work, plus 1 small classifier change (CVE inclusion). One implementer can complete this in a single slice (each task is independently scriptable; the pattern is fixed by S2).

### 2.4 Engine-gap disclosure pattern (for #585 and #619/#576)

For `bcrypt-verify-constant-time` and `validate-string-min-max`, the corpus-spec entry MUST carry:

```jsonc
{
  "id": "bcrypt-verify-constant-time",
  // ... usual fields ...
  "engine_gap_disclosure": {
    "issue": "#585",
    "summary": "bcryptjs/dist/bcrypt.js is a UMD IIFE; shave decompose() emits stub (moduleCount=0, stubCount=1) per DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001.",
    "impact": "Arm A is a hand-authored constant-time-compare reference, not a real atom composition. The transitive-surface delta is still measured and reported, but Arm A's provenance differs from the unblocked tasks. Headline table marks this row [GAP] in the verdict column.",
    "tracking_pr": "(filled in S3 PR)"
  }
}
```

Same pattern for the zod row, citing #619 (TS-compiled CJS prelude) and #576 (ArrowFunction in class body) per `DEC-WI510-S8-HELPER-FILE-MAPPING-001`.

The classifier (§3.4 below) treats these tasks as **counted** in the PASS-DIRECTIONAL set if their numeric delta meets ≥90%, but the PR-body table flags them with `[GAP]` next to the verdict so the reader sees the honesty signal. This matches WI-510 S8's "engine-gap-mapped" honesty rather than hiding the disclosure.

---

## 3. Per-task layout pattern (mirrors S2 template, N=14 times)

### 3.1 Directory structure per task

For each of the 14 new tasks, identical layout to S2's `validate-rfc5321-email`:

```
bench/B10-import-replacement/
├── tasks/<task-id>/
│   ├── spec.yak                          # LF-normalized, sha256-locked
│   ├── arm-a/
│   │   ├── fine.mjs                      # @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001 (or -CLEAN- if production path used)
│   │   ├── medium.mjs                    # 2-3 named functions
│   │   ├── coarse.mjs                    # single entry function
│   │   └── oracle.test.mjs               # byte-equivalence vs the real npm import on ≥20 fast-check inputs
├── fixtures/<task-id>/
│   └── arm-b-response.json               # canned Anthropic Messages API response, prompt-sha256-locked
└── test/<task-id>.test.mjs               # T-CORPUS-1 / T-A-1 / T-A-2 / T-B-1 / T-RESOLVER-DELTA-1 / T-SMOKE-RUN-1 (same shape as S2's validate-rfc5321-email.test.mjs)
```

### 3.2 Spec.yak shape

Same structure as the S2 spec, with `errorConditions: []` to keep the LLM prompt clean (the natural Arm B answer should be a single thin wrapper around the npm import). Each spec carries the demo-library `@comment` annotation:

```jsonc
{
  "$comment": "DEC-BENCH-B10-SLICE3-TASK-CORPUS-SELECTION-001 — <library>@<version> / <binding> / task: <task-id>",
  "name": "<task-id>",
  "inputs": [ ... ],
  "outputs": [ ... ],
  "level": "L0",
  "behavior": "<one-paragraph behavior matching the binding's default semantics>",
  "guarantees": [ ... ],
  "errorConditions": []
}
```

### 3.3 Locked Arm B prompt — same template as S2

Reuses the verbatim system prompt from `DEC-V0-MIN-SURFACE-003` (already in `harness/llm-baseline.mjs`). The user prompt is rendered from the spec via the existing `llm-baseline.mjs::buildUserPrompt()` helper. Per-task sha256 lock follows the S2 pattern (`promptSha256()` over `SYSTEM_PROMPT + "\n\n" + rendered_user_prompt`, committed into the task's `corpus-spec.json` entry as `arm_b_prompt.prompt_sha256`).

**Pre-stage discipline.** Per durable memory and S2 §2.3, the implementer:
1. Hand-types each task's user_prompt_template into `corpus-spec.json` first;
2. Runs the harness ONCE on each task to compute the sha256;
3. Commits the computed sha back into `corpus-spec.json` (this is the lock);
4. CI verifies the sha on every subsequent run; drift hard-aborts.

### 3.4 Arm A provenance per task

**Default fallback** — `DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001` from S2 applies unchanged here, renamed in `@decision` block to `DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001` (same rationale: end-to-end `yakcc compile + #508 hook + WI-510 atom registry` path is not yet wired end-to-end at S3 implementation time per S2 R-S2-1). Arm A `.mjs` files are hand-translated from the shaved subgraph (WI-510 fixture root for that package) into zero-npm-import references, byte-equivalent to what the production path would emit.

Each task's three Arm A files carry an `@decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001` annotation in the header comment disclosing provenance.

**Engine-gap tasks** (`bcrypt-verify-constant-time`, `validate-string-min-max`) — instead of the FALLBACK annotation, they carry `@decision DEC-BENCH-B10-SLICE3-ARMA-ENGINE-GAP-DISCLOSED-001` referencing the specific open issue (#585 or #619/#576) per §2.4. The hand-translation is still byte-equivalent to the real binding semantics; only the provenance annotation differs.

### 3.5 Granularity strategies — same A-fine / A-medium / A-coarse as S2

| Strategy | Function count target | Pattern |
|---|---|---|
| **A-fine** | 5–10 named functions per task | one per atom / structural concern |
| **A-medium** | 2–4 named functions | major sub-rules grouped |
| **A-coarse** | 1 (the entry alone) | inlined entry function |

All three strategies MUST produce zero non-builtin imports. The resolver MUST measure `reachable_files == 1` for each Arm A emit (proven by T-A-2).

### 3.6 Per-task test file shape

Each `test/<task-id>.test.mjs` is a clone of `test/validate-rfc5321-email.test.mjs` with these substitutions:
- `TASK_ID` → the new task id
- `validator` → the new library name (for T-B-1 fixture text check)
- `validateRfc5321Email` → the new entry function name

The test cases (T-CORPUS-1, T-A-1, T-A-2, T-B-1, T-RESOLVER-DELTA-1, T-SMOKE-RUN-1) are identical structure. T-A-2 also asserts each arm-a file contains the appropriate ARMA-FALLBACK or ARMA-ENGINE-GAP-DISCLOSED annotation.

The implementer may script the test-file generation from a template if desired (the 14 test files are structurally identical). This is bench-local boilerplate, not novel test design.

---

## 4. Arm A provenance per task — table

| Task ID | Library | Provenance | DEC |
|---|---|---|---|
| add-business-days | date-fns | fallback (hand-translate from `date-fns/addDays.cjs` WI-510 S5 subgraph) | -SLICE3-ARMA-FALLBACK-001 |
| bcrypt-verify-constant-time | bcryptjs | **engine-gap-disclosed (#585)** — hand-translate from RFC 4949 constant-time compare semantics; Arm A is a faithful reference, not a real atom composition | -SLICE3-ARMA-ENGINE-GAP-DISCLOSED-001 |
| coerce-semver | semver | fallback (hand-translate from `semver/functions/coerce.js` WI-510 S3 subgraph; ~8 modules) | -SLICE3-ARMA-FALLBACK-001 |
| cycle-safe-deep-clone | lodash | fallback (hand-translate from `lodash/cloneDeep.js` WI-510 S7 subgraph) | -SLICE3-ARMA-FALLBACK-001 |
| debounce-with-flush-cancel | lodash | fallback (hand-translate from `lodash/debounce.js` WI-510 S7 subgraph) | -SLICE3-ARMA-FALLBACK-001 |
| decode-jwt-header-claims | jsonwebtoken | fallback (hand-translate from `jsonwebtoken/decode.js` WI-510 S6 — 1 module) | -SLICE3-ARMA-FALLBACK-001 |
| format-iso-date | date-fns | fallback (hand-translate from `date-fns/formatISO.cjs` WI-510 S5 subgraph; exercises `_lib/addLeadingZeros`) | -SLICE3-ARMA-FALLBACK-001 |
| format-ms-duration | ms | fallback (hand-translate from `ms/index.js` WI-510 S1 — single file) | -SLICE3-ARMA-FALLBACK-001 |
| lodash-deep-merge | lodash | fallback (hand-translate from `lodash/merge.js` WI-510 S7 subgraph) | -SLICE3-ARMA-FALLBACK-001 |
| nanoid-generate | nanoid | fallback (hand-translate from `nanoid/index.cjs` WI-510 S4; uses `crypto` builtin foreign leaf — Arm A uses `node:crypto.getRandomValues` directly) | -SLICE3-ARMA-FALLBACK-001 |
| parse-rfc3339-datetime | date-fns | fallback (hand-translate from `date-fns/parseISO.cjs` WI-510 S5 subgraph) | -SLICE3-ARMA-FALLBACK-001 |
| rate-limit-sliding-window | p-throttle | fallback (hand-translate from `p-throttle/index.js` WI-510 S9 — pure ESM, single-file) | -SLICE3-ARMA-FALLBACK-001 |
| semver-range-satisfies | semver | fallback (hand-translate from `semver/functions/satisfies.js` WI-510 S3 subgraph; ~18 modules) | -SLICE3-ARMA-FALLBACK-001 |
| throttle-trailing-edge | lodash | fallback (hand-translate from `lodash/throttle.js` WI-510 S7 subgraph) | -SLICE3-ARMA-FALLBACK-001 |
| uuid-v4-generate-validate | uuid | fallback (hand-translate from `uuid/dist/cjs/v4.js` + `validate.js` WI-510 S4 — uses `crypto` builtin) | -SLICE3-ARMA-FALLBACK-001 |
| validate-string-min-max | zod | **engine-gap-disclosed (#619 + #576)** — hand-translate from RFC string-length semantics; Arm A is a faithful reference, not a real atom composition | -SLICE3-ARMA-ENGINE-GAP-DISCLOSED-001 |
| validate-url-format | validator | fallback (hand-translate from `validator/lib/isURL.js` WI-510 S2 subgraph) | -SLICE3-ARMA-FALLBACK-001 |
| validate-uuid-format | validator | fallback (hand-translate from `validator/lib/isUUID.js` WI-510 S2 subgraph; ~7 modules — small) | -SLICE3-ARMA-FALLBACK-001 |
| verify-jwt-hs256 | jsonwebtoken | fallback (hand-translate from `jsonwebtoken/verify.js` WI-510 S6 subgraph; HS256 path only — uses `crypto` HMAC builtin) | -SLICE3-ARMA-FALLBACK-001 |

**Net:** 12 tasks via FALLBACK, 2 tasks via ENGINE-GAP-DISCLOSED, 1 task (S2) already landed and untouched.

---

## 5. Arm B fixtures

### 5.1 Dry-run path — committed canonical fixtures (CI default)

For each of the 14 new tasks: `fixtures/<task-id>/arm-b-response.json` is a hand-authored Anthropic Messages API response (same shape as the S2 fixture and B9 fixtures) containing the canonical natural LLM solution — the `` ```typescript ``-fenced code block that emits `import X from 'Y'` or `import { X } from 'Y'`.

Each fixture carries the same metadata as S2's:
- `_fixture_note`: human-readable provenance note
- `_fixture_provenance`: `"Hand-authored representative fixture for the locked prompt; replaced by the captured live-run response committed alongside the headline results artifact."`
- `_arm`: `"B"`
- `_task`: the task id
- `_prompt_sha256`: matches the per-task locked sha in `corpus-spec.json`
- `id`, `type`, `role`, `model`, `stop_reason`, `stop_sequence`, `usage`, `content[0].text`

The implementer hand-types each fixture's `content[0].text` from the natural-LLM-answer expectation for each task (e.g. for `verify-jwt-hs256`: `import jwt from 'jsonwebtoken';\n\nfunction verifyJwtHs256(token: string, secret: string): unknown {\n  return jwt.verify(token, secret, { algorithms: ['HS256'] });\n}\n\nexport { verifyJwtHs256 };`).

The harness's existing `llm-baseline.mjs::loadB9Fixture()` already preferentially loads B10 fixtures from `bench/B10-import-replacement/fixtures/<task>/arm-b-response.json` before the B9 fallback (S2 confirmed this works), so no harness code change is needed for the new fixtures to be discovered.

### 5.2 Live-run path — Anthropic API once (operator-gated)

The live headline run is gated identically to S2 (per `DEC-BENCH-B10-SLICE2-COST-001` / `DEC-BENCH-B10-SLICE3-COST-001`):

- Requires `ANTHROPIC_API_KEY` env var.
- N=3 reps per task × 15 tasks × ~$0.01/rep ≈ **$0.45 total**. The $25 cost-cap (`COST_CAP_USD = 25` in `harness/run.mjs`, unchanged value) is comfortable; reservation for re-runs included.
- Per-task captured live response committed to `fixtures/<task-id>/arm-b-live-<date>.json` for provenance.
- Headline live artifact committed at `bench/B10-import-replacement/results-<platform>-<date>.json`.

**`DEC-BENCH-B10-SLICE3-COST-001`** — Slice 3 cost cap = **$25 USD** (unchanged constant value; only the DEC annotation reference is added to the existing `@decision` block in `harness/run.mjs`).

**The live run is NOT in S3's CI path.** CI runs `--dry-run` only. The live run is the operator's discretionary final step before merge. The PR may be opened with the dry-run headline table; the operator triggers the live run and amends the PR with the live-run artifact before merge (same split as S2 per `feedback_pr_not_guardian_merge.md`).

### 5.3 Prompt sha256 plan (pre-stage discipline)

Per §3.3, each task's prompt sha256 is computed on first harness run and committed back to `corpus-spec.json`. The implementer's workflow per task:
1. Author `spec.yak`, render the user_prompt_template in `corpus-spec.json` (placeholder sha256 = `"PENDING"`).
2. Run `node harness/run.mjs --dry-run --tasks=<task-id>` once. The harness fails with "prompt sha256 drift: expected PENDING, got <hex>".
3. Replace `PENDING` with the computed `<hex>` in `corpus-spec.json`; re-run; passes.
4. Commit `corpus-spec.json` with the locked sha256.

This matches the WI-510 S2 prompt-locking discipline and the S2 `validate-rfc5321-email` workflow. **Note:** the implementer may need a tiny one-shot helper script in `tmp/wi-512-s3/` to batch-compute the 14 sha256s if running them one-at-a-time is too slow; that scratchlane work is allowed.

---

## 6. B9 Axis-4 fold-in (npm-audit CVE pattern-match metric)

### 6.1 What S1 already provides

S1's resolver already wires `--audit` and emits `npm_audit.cve_pattern_matches` in every measurement result. The classifier already medians CVE values across Arm B reps. The suite summary already totals them as `total_cve_matches`. The harness already passes `audit: DO_AUDIT` (default `true`) to every measurement.

### 6.2 What S3 adds

**`DEC-BENCH-B10-SLICE3-CVE-METRIC-001`** — Promote the CVE pattern-match count to a headline reporting axis per the parent issue's "Secondary metrics" stanza.

S3 adds the following per the parent plan §3.6 / triad plan §6 commitments:

1. **A real (small) offline pinned advisory DB** populated under `bench/B10-import-replacement/fixtures/npm-audit-db/advisories.json` with the actual known advisories for the tasks' transitive surfaces (currently `validator`, `semver`, `uuid`, `nanoid`, `date-fns`, `jsonwebtoken`, `bcryptjs`, `lodash`, `zod`, `p-throttle`, `ms`). The S1 fixture is a synthetic 2-row placeholder; S3 replaces it with the real advisory snapshot pinned at a specific date.

   The advisory snapshot is sourced from `npm audit --json` run ONCE against a temporary `package.json` containing only those 11 packages at their WI-510 fixture versions, then committed under the fixtures dir. The DB is regenerated only when the operator decides to refresh (NOT auto-refreshed in CI — determinism is the point).

   `DEC-BENCH-B10-SLICE3-CVE-DB-PROVENANCE-001` captures: advisory DB is pinned at the S3-implementation date; regenerated only by explicit operator action (not by CI); `audit_source: "offline-db"` in every result; the regeneration command is documented in the README.

2. **Per-task headline reporting** — the classifier's per-task summary already includes `arm_b.median_cve_matches`; S3 surfaces this in the PR-body table as a third column alongside reachable_functions and reachable_bytes. Arm A's CVE count is structurally `0` (Arm A has zero non-builtin imports — nothing to audit), so the table reports the Arm B CVE count as a standalone column representing "the CVE exposure yakcc eliminated by replacing the import."

3. **Suite summary headline** — `summarizeSuite` already computes `total_cve_matches`. The PR-body summary calls this out explicitly: "Across all 15 tasks, replacing the natural npm import with yakcc atom composition eliminates `<N>` known CVE pattern matches in the transitive surface."

### 6.3 No new resolver/classifier code

The resolver's `--audit` flag, the classifier's per-task `arm_b.median_cve_matches`, and the suite's `total_cve_matches` are all already implemented (S1 + S2). S3's CVE work is:

- **Replace** the synthetic 2-row `advisories.json` with the real pinned snapshot;
- **Update** the README to document the CVE axis as headline-relevant in S3+ (was secondary in S1);
- **Add** CVE reporting to the PR-body headline table template (§7.2).

No new harness `.mjs` is required for the CVE axis. This is a content/reporting change, not a code change.

---

## 7. Headline acceptance

### 7.1 Per-task acceptance (unchanged from S2)

For each task: `verdict == "PASS-DIRECTIONAL"` (per `classify-arm-b.mjs`) iff:
- `reduction(reachable_functions) >= 0.90`, AND
- `arm_a.unique_non_builtin_imports == 0`, AND
- `arm_b.unique_non_builtin_imports >= 1`.

The classifier also checks `reduction(reachable_bytes)` informationally but the load-bearing verdict gate is `reachable_functions` reduction. S3 PR-body table includes BOTH the functions reduction and the bytes reduction so the reader sees both.

### 7.2 Suite-level acceptance — THIS IS THE #512 HEADLINE

**`DEC-BENCH-B10-SLICE3-HEADLINE-ACCEPTANCE-001`** — Slice 3 is acceptable iff, on the LIVE run with N=3 reps per task:

> **At least 10 of the 15 tasks have `verdict: PASS-DIRECTIONAL` on BOTH `reachable_functions` and `reachable_bytes`, where the median over the 3 live reps shows ≥90% reduction on each axis.**

This is the parent issue body's literal acceptance bar. Engine-gap-disclosed tasks (bcryptjs + zod) ARE counted toward the ≥10 if their numeric delta meets the threshold (because the headline is about transitive-surface reduction, which the gap doesn't invalidate — only the Arm A provenance is qualified).

### 7.3 PR-body headline table template

Mandatory structure for the PR body (to be filled in by the implementer after the live run completes):

```markdown
## Headline table — WI-512 #512 closing reading

Live run mode | platform | date | total_cost_usd: $<x.xx>

| Task | Arm A fns | Arm B fns (median) | fns reduction | Arm A bytes | Arm B bytes (median) | bytes reduction | CVE matches (Arm B) | Verdict |
|---|--:|--:|--:|--:|--:|--:|--:|---|
| validate-rfc5321-email | <n> | <n> | <pct>% | <n> | <n> | <pct>% | <n> | PASS-DIRECTIONAL |
| validate-uuid-format   | <n> | <n> | <pct>% | <n> | <n> | <pct>% | <n> | PASS-DIRECTIONAL |
| ... (15 rows total) ... |     |     |       |     |     |       |     |       |
| bcrypt-verify-constant-time | <n> | <n> | <pct>% | <n> | <n> | <pct>% | <n> | PASS-DIRECTIONAL [GAP #585] |
| validate-string-min-max | <n> | <n> | <pct>% | <n> | <n> | <pct>% | <n> | PASS-DIRECTIONAL [GAP #619+#576] |

**Suite verdict:** PASS-DIRECTIONAL on <N>/15 tasks (target ≥10).
**Total CVE pattern matches eliminated:** <N> (sum of Arm B CVE medians across all tasks).
```

---

## 8. Evaluation Contract — Slice 3 (guardian-bound)

A reviewer declares S3 `ready_for_guardian` **iff every item below is satisfied with pasted evidence** (live command output, not prose).

### 8.1 Required tests (must exist and pass)

For EACH of the 14 new tasks:

- **T-CORPUS-1-<task>** — `corpus-spec.json` entry exists with all required fields (per S2's T-CORPUS-1 shape: id, spec_path, spec_sha256_lf, entry_function, arm_a_granularity_strategies, arm_b_n_reps, arm_b_prompt with locked prompt_sha256, dry_run_fixture, directional_targets). For the 2 engine-gap-disclosed entries, also `engine_gap_disclosure.issue` is set.
- **T-A-1-<task>** — `arm-a-emit.mjs::TASK_ENTRY_FUNCTIONS` maps the task to its entry function name. All three `tasks/<task>/arm-a/{fine,medium,coarse}.mjs` exist and are non-empty.
- **T-A-2-<task>** — Each arm-a `.mjs` has zero non-builtin imports AND carries the appropriate `DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001` or `DEC-BENCH-B10-SLICE3-ARMA-ENGINE-GAP-DISCLOSED-001` annotation.
- **T-A-3-<task>** (oracle) — `tasks/<task>/arm-a/oracle.test.mjs` exists; runs ≥20 fast-check inputs; Arm A's entry function produces semantically-equivalent output to the real npm binding (with default options). For tasks where the natural binding output is `boolean` (most), this is value-equality. For tasks where output is `Date`/`object`/`Array`, this is `deepStrictEqual` or `getTime()` equality as appropriate. For engine-gap-disclosed tasks, the oracle still passes against the real npm package (the disclosure is about atom provenance, not behavior).
- **T-B-1-<task>** — `fixtures/<task>/arm-b-response.json` exists; parses; has Anthropic Messages API shape; text content references the library name and defines the entry function.
- **T-RESOLVER-DELTA-1-<task>** — `node harness/run.mjs --dry-run --tasks=<task>` exits 0; stdout contains `PASS-DIRECTIONAL`; stdout does not contain `NaN`; resolver returns valid numbers.

PLUS:

- **T-CORPUS-COUNT-1** — `corpus-spec.json` has exactly 15 task entries (the S2 task + the 14 new).
- **T-SMOKE-FULL-1** — `node harness/run.mjs --dry-run` (no `--tasks` flag) runs all 15 B10 corpus tasks, exits 0, suite_verdict is PASS-DIRECTIONAL with at least 10 PASS-DIRECTIONAL per-task verdicts on dry-run inputs.
- **T-CVE-DB-1** — `fixtures/npm-audit-db/advisories.json` is the real pinned snapshot (NOT the S1 2-row synthetic placeholder); contains entries for the 11 covered packages OR `cve_pattern_matches == 0` is independently verifiable from `npm audit` against those package versions. Reviewer eyeballs the diff to confirm the DB was regenerated, not stub-edited.
- **T-CLASSIFIER-CVE-1** — Add a unit test under `test/classify-arm-b.test.mjs` asserting `summarizeSuite` returns `total_cve_matches` correctly summed across a synthetic 3-task input (S1+S2 already tested classifier behavior; this just locks the suite-level CVE sum).
- **T-DETERMINISTIC-DRYRUN-1** — Re-running `--dry-run` twice produces byte-identical `results-*.json` (modulo `measured_at`/`artifact_sha256`-affected timestamps redacted by the existing `stripMeasuredAt` mechanism). S2 added this; S3 verifies it still holds across the broader 15-task corpus.

### 8.2 Required real-path checks (must be run; output pasted in PR)

- `pnpm --dir bench/B10-import-replacement install` succeeds (adds the new npm dependencies — see §8.3 below).
- `node --test bench/B10-import-replacement/test/*.test.mjs` — ALL green (S1 T1–T11 + S1 smoke + S2 validate-rfc5321-email tests UNCHANGED + 14 new per-task test files + T-CVE-DB-1 + T-CLASSIFIER-CVE-1 + T-DETERMINISTIC-DRYRUN-1). Output pasted.
- `node bench/B10-import-replacement/harness/run.mjs --dry-run` exits 0, suite_verdict PASS-DIRECTIONAL, ≥10/15 PASS-DIRECTIONAL. Output pasted verbatim (truncate per-task verbose; keep the headline summary).
- Per-task oracle runs:
  ```
  for task in <each new task id>; do
    node bench/B10-import-replacement/tasks/$task/arm-a/oracle.test.mjs
  done
  ```
  All green. Output pasted (summary acceptable; one block per task).
- **Full-workspace gates** (NON-NEGOTIABLE per durable memory `feedback_eval_contract_match_ci_checks.md`):
  - `pnpm -w lint` — full-workspace green, output pasted verbatim.
  - `pnpm -w typecheck` — full-workspace green, output pasted verbatim.
  - NOT `--filter <pkg>` scoped. Package-scoped passing is necessary but not sufficient.
- The committed `results-<platform>-<date>.json` artifact (LIVE run, operator-produced before merge) shows the headline table with `tasks_passing >= 10`.

### 8.3 Required authority invariants (must hold)

- `bench/B9-min-surface/**` is byte-unchanged (forbidden touch point).
- `packages/**` is byte-unchanged. **No production-code edit.**
- The harness MUST NOT import or call the production registry as a library.
- `pnpm-workspace.yaml` is unchanged.
- `MASTER_PLAN.md` is unchanged.
- `bench/B10-import-replacement/tasks/validate-rfc5321-email/**` is **byte-unchanged** (S2 task is READ-ONLY for S3; reviewer verifies `git diff main -- bench/B10-import-replacement/tasks/validate-rfc5321-email/` is empty).
- Root `package.json` is **unchanged** (no new bench:* scripts; the existing S1 `bench:import-replacement*` scripts already cover S3's harness invocations).
- The new npm dependencies added in `bench/B10-import-replacement/package.json` are ONLY bench-local (NOT in root). New deps expected (one per library covered by the new tasks): `semver`, `uuid`, `nanoid`, `date-fns`, `jsonwebtoken`, `bcryptjs`, `lodash`, `zod`, `p-throttle`, `ms`. `validator` already added in S2. The implementer pins each to the exact WI-510 fixture version (per the version pinning in `packages/shave/src/__fixtures__/module-graph/`):
  - `semver@7.8.0`
  - `uuid@11.1.1`
  - `nanoid@3.3.12`
  - `date-fns@4.1.0`
  - `jsonwebtoken@9.0.2`
  - `bcryptjs@2.4.3`
  - `lodash@4.17.21`
  - `zod@3.25.76`
  - `p-throttle@8.1.0`
  - `ms@2.1.3`
- Each new arm-a `.mjs` carries the appropriate `DEC-BENCH-B10-SLICE3-ARMA-{FALLBACK|ENGINE-GAP-DISCLOSED}-001` annotation.
- Each new corpus-spec entry has its `arm_b_prompt.prompt_sha256` populated (non-`PENDING`); the harness verifies on every run; drift hard-aborts.
- The `bench/B10-import-replacement/fixtures/npm-audit-db/advisories.json` is the real pinned snapshot (T-CVE-DB-1).

### 8.4 Required integration points (must be wired)

- `bench/B10-import-replacement/harness/arm-a-emit.mjs::TASK_ENTRY_FUNCTIONS` adds 14 new entries (one per new task) mapping task id → entry function name.
- `bench/B10-import-replacement/harness/run.mjs::INLINE_SPECS` adds 14 new entries (signature + behavior per task). NOTE: a subsequent slice may wire spec loading from `corpus-spec.json` instead of this inline map (an S3-extension follow-up); S3 does NOT refactor `INLINE_SPECS` away.
- `bench/B10-import-replacement/harness/run.mjs` `@decision` block: append `DEC-BENCH-B10-SLICE3-COST-001` reference (value unchanged; annotation only).
- `bench/B10-import-replacement/harness/measure-transitive-surface.mjs`: extend `@decision` block to reference `DEC-BENCH-B10-SLICE3-CVE-METRIC-001` (folds the CVE axis into the headline metric set per parent §3.6). NO new resolver code; just the annotation pointing at the now-real DB.
- `bench/B10-import-replacement/README.md`:
  - Slice Roadmap row for S3 marked `landed` with one-line summary referencing this plan and the committed live artifact.
  - "Headline acceptance" subsection added documenting the ≥10/15 PASS-DIRECTIONAL bar and the CVE axis.
  - "Regenerating the CVE advisory DB" subsection added (the operator-only command + `DEC-BENCH-B10-SLICE3-CVE-DB-PROVENANCE-001`).

### 8.5 Forbidden shortcuts (reviewer must reject if present)

- **Touching the S2 `validate-rfc5321-email` task.** READ-ONLY for S3 per §9. Any diff under `bench/B10-import-replacement/tasks/validate-rfc5321-email/**` (other than perhaps an `arm-b-live-<date>.json` if the live run captures one — which is in `fixtures/`, NOT in `tasks/`) is a scope violation.
- **Modifying production code.** `packages/**` diff is empty (`git diff main -- packages/` shows nothing). No exceptions.
- **Touching B9.** `bench/B9-min-surface/**` diff is empty.
- **Touching `pnpm-workspace.yaml` or `MASTER_PLAN.md`.**
- **Hand-tuning arm-a function counts to game the verdict.** The oracle (T-A-3-<task>) enforces semantic correctness; the implementer cannot reduce function count below what the spec semantics require. If a task's arm-a is reduced to a one-liner that fails the oracle, that is a reject. The honest path is: the spec naturally decomposes into N functions; the resolver counts N; the delta vs Arm B is whatever it is. ≥90% is set by transitive npm surface, not by Arm A's structure.
- **Committing the LIVE `results-*.json` without actually running the live API.** Reviewer verifies the captured `fixtures/<task>/arm-b-live-<date>.json` files have non-zero `usage.input_tokens` and `usage.output_tokens` from real Anthropic responses. Synthesizing live numbers from dry-run is fraud and is forbidden.
- **Replacing the locked prompt without re-locking sha256.** Prompt sha256 drift hard-aborts; the corpus-spec entry's sha256 IS the lock. Updating the prompt and updating the sha simultaneously is fine; updating only one is not.
- **Adding any npm dep to the root `package.json` or `pnpm-workspace.yaml`.** ALL new deps go in `bench/B10-import-replacement/package.json` only (B10 is outside the workspace per parent C5).
- **Touching `bench/B10-import-replacement/harness/measure-transitive-surface.mjs` in a load-bearing way.** The resolver is FROZEN after S1; S3 may only append a DEC reference to its header `@decision` block (per §8.4). Any algorithm/exclusion-list/counting-unit change is OUT OF SCOPE for S3 and requires its own slice plan.
- **Running CI on `--live`.** CI is `--dry-run` only. The live run is operator-discretionary.
- **Using `cd <worktree>` in any command.** Per Sacred Practice 3 use `git -C <path>` or subshell `(cd <path> && cmd)`.
- **Cross-package relative imports.** All B10 code is `.mjs` outside the pnpm workspace (parent C5), so this is structural-only here. The implementer confirms in PR that no cross-package import was introduced.
- **Modifying `bench/B10-import-replacement/test/measure-transitive-surface.test.mjs` or `test/run.test.mjs` or `test/classify-arm-b.test.mjs` beyond adding the new T-CVE-DB-1 / T-CLASSIFIER-CVE-1 / T-DETERMINISTIC-DRYRUN-1 cases.** The S1+S2 invariants must continue to hold; no regression of T1–T11 or the S1 smoke fixture.

### 8.6 Ready-for-guardian definition

S3 is `ready_for_guardian` iff all of the following hold simultaneously on the worktree's current HEAD with output pasted verbatim in the PR body:

1. `corpus-spec.json` has exactly 15 task entries (S2's + 14 new); each new entry has all required fields and a non-`PENDING` `arm_b_prompt.prompt_sha256`; each engine-gap-disclosed entry has `engine_gap_disclosure.issue` set.
2. For each of the 14 new tasks: `tasks/<task>/spec.yak` + `arm-a/{fine,medium,coarse}.mjs` + `arm-a/oracle.test.mjs` + `fixtures/<task>/arm-b-response.json` + `test/<task>.test.mjs` all exist; each arm-a carries the appropriate ARMA-FALLBACK or ARMA-ENGINE-GAP-DISCLOSED annotation; each oracle is green; each per-task test file is green.
3. `harness/arm-a-emit.mjs::TASK_ENTRY_FUNCTIONS` carries 14 new entries.
4. `harness/run.mjs::INLINE_SPECS` carries 14 new entries; `@decision` block references `DEC-BENCH-B10-SLICE3-COST-001`.
5. `harness/measure-transitive-surface.mjs` `@decision` block references `DEC-BENCH-B10-SLICE3-CVE-METRIC-001`.
6. `fixtures/npm-audit-db/advisories.json` is the real pinned snapshot for the 11 covered packages.
7. `package.json` (bench-local) includes the 10 new npm deps at WI-510 fixture versions; root `package.json` is unchanged.
8. `README.md` Slice Roadmap row for S3 is updated; CVE-DB regeneration subsection added; headline acceptance subsection added.
9. `node --test bench/B10-import-replacement/test/*.test.mjs` — all green (S1+S2 unchanged + 14 new per-task + 3 new general tests). Output pasted.
10. `node bench/B10-import-replacement/harness/run.mjs --dry-run` exits 0, suite_verdict PASS-DIRECTIONAL, ≥10/15 PASS-DIRECTIONAL on dry-run inputs. Output pasted.
11. `pnpm -w lint` green, full output pasted verbatim.
12. `pnpm -w typecheck` green, full output pasted verbatim.
13. `git diff main -- packages/` is empty.
14. `git diff main -- bench/B9-min-surface/` is empty.
15. `git diff main -- bench/B10-import-replacement/tasks/validate-rfc5321-email/` is empty.
16. `git diff main -- pnpm-workspace.yaml MASTER_PLAN.md` is empty.
17. `git diff main -- package.json` is empty (root package.json unchanged).
18. No forbidden-shortcut per §8.5 is present.
19. The PR is opened against `main` with `Closes #512` in the body (per `feedback_pr_not_guardian_merge.md` AND because S3 is the issue closer).
20. `git fetch origin && git pull --ff-only origin main` was run immediately before `gh pr create` (per `feedback_fetch_before_pr.md`).
21. (Operator-gated step, after items 1–20) The LIVE run produced `bench/B10-import-replacement/results-<platform>-<date>.json` AND per-task `fixtures/<task>/arm-b-live-<date>.json` files for each of the 15 tasks; each captured live response has non-zero `usage.input_tokens` and `usage.output_tokens`; the headline reading meets `tasks_passing >= 10` on BOTH `reachable_functions` and `reachable_bytes` per `DEC-BENCH-B10-SLICE3-HEADLINE-ACCEPTANCE-001`.

Reviewer may declare `ready_for_guardian` after items 1–20 are satisfied; item 21 gates the merge but is the operator's responsibility (one explicit `--live` invocation; cost-bounded by `DEC-BENCH-B10-SLICE3-COST-001` $25).

---

## 9. Scope Manifest — Slice 3

### 9.1 Allowed files/directories (implementer may touch)

- `bench/B10-import-replacement/corpus-spec.json` — append 14 task entries.
- `bench/B10-import-replacement/tasks/<task-id>/**` for each of the 14 NEW tasks (entirely new directories):
  - `spec.yak`
  - `arm-a/fine.mjs`, `arm-a/medium.mjs`, `arm-a/coarse.mjs`
  - `arm-a/oracle.test.mjs`
- `bench/B10-import-replacement/fixtures/<task-id>/**` for each of the 14 NEW tasks (entirely new directories):
  - `arm-b-response.json` (dry-run canonical fixture)
  - `arm-b-live-<date>.json` (operator-captured live response; appended when live run executes)
- `bench/B10-import-replacement/fixtures/npm-audit-db/advisories.json` — **replace** the synthetic 2-row S1 placeholder with the real pinned snapshot.
- `bench/B10-import-replacement/results-<platform>-<date>.json` — operator-committed headline artifact.
- `bench/B10-import-replacement/harness/run.mjs` — ONLY:
  - update `INLINE_SPECS` to add 14 new entries,
  - append `DEC-BENCH-B10-SLICE3-COST-001` reference to the existing cost-cap `@decision` block (COST_CAP_USD value unchanged).
- `bench/B10-import-replacement/harness/arm-a-emit.mjs` — ONLY: add 14 new entries to `TASK_ENTRY_FUNCTIONS`.
- `bench/B10-import-replacement/harness/measure-transitive-surface.mjs` — ONLY: append `DEC-BENCH-B10-SLICE3-CVE-METRIC-001` to the existing header `@decision` block (no algorithm change).
- `bench/B10-import-replacement/test/<task-id>.test.mjs` — new file per new task (14 total).
- `bench/B10-import-replacement/test/classify-arm-b.test.mjs` — append T-CLASSIFIER-CVE-1 case.
- `bench/B10-import-replacement/test/run.test.mjs` — append T-DETERMINISTIC-DRYRUN-1 case (if not already there).
- `bench/B10-import-replacement/test/measure-transitive-surface.test.mjs` — append T-CVE-DB-1 (real-DB sanity test). NO change to T1–T11.
- `bench/B10-import-replacement/test/smoke-fixture-*.json` — the existing S1 smoke fixture stays unchanged. NEW S3 smoke fixture may be added if the smoke corpus changes (it does not; B9 corpus is still the smoke; B10 corpus is the headline). Reviewer verifies S1 smoke fixture is unchanged.
- `bench/B10-import-replacement/package.json` — add 10 new npm dependencies at pinned versions.
- `bench/B10-import-replacement/package-lock.json` — regenerated by `pnpm install` (committed).
- `bench/B10-import-replacement/README.md` — Slice Roadmap row + new subsections per §8.4.
- `plans/wi-512-s3-b10-broaden.md` — this file (implementer may append `@decision` deviation notes per "Code is Truth").
- `plans/wi-512-b10-import-heavy-bench.md` — **status update only** to the Slice Map table row for S3 (mark "landed"); NO edits to body sections.
- `tmp/wi-512-s3/**` — scratch artifacts (`tmp/` is the canonical scratchlane per Sacred Practice 3); includes the one-shot prompt-sha256 batch helper if used.

### 9.2 Required files/directories (must be created/modified)

- `bench/B10-import-replacement/corpus-spec.json` (must become 15 task entries).
- 14 × `bench/B10-import-replacement/tasks/<task-id>/spec.yak`.
- 14 × `bench/B10-import-replacement/tasks/<task-id>/arm-a/{fine.mjs, medium.mjs, coarse.mjs, oracle.test.mjs}` (56 files).
- 14 × `bench/B10-import-replacement/fixtures/<task-id>/arm-b-response.json`.
- `bench/B10-import-replacement/fixtures/npm-audit-db/advisories.json` (replace synthetic with real pinned snapshot).
- `bench/B10-import-replacement/harness/arm-a-emit.mjs` (TASK_ENTRY_FUNCTIONS).
- `bench/B10-import-replacement/harness/run.mjs` (INLINE_SPECS + DEC ref).
- `bench/B10-import-replacement/harness/measure-transitive-surface.mjs` (DEC ref only).
- 14 × `bench/B10-import-replacement/test/<task-id>.test.mjs`.
- `bench/B10-import-replacement/test/classify-arm-b.test.mjs` (append T-CLASSIFIER-CVE-1).
- `bench/B10-import-replacement/test/measure-transitive-surface.test.mjs` (append T-CVE-DB-1).
- `bench/B10-import-replacement/test/run.test.mjs` (append T-DETERMINISTIC-DRYRUN-1 if absent).
- `bench/B10-import-replacement/package.json` (10 new deps).
- `bench/B10-import-replacement/package-lock.json` (regenerated).
- `bench/B10-import-replacement/README.md` (status + CVE-DB section + headline section).

### 9.3 Forbidden touch points (must NOT change without re-approval)

- **`packages/**`** — no production-code changes (parent §3b SCOPE; triad §6 forbidden touch).
- **`bench/B9-min-surface/**`** — read-only reference; B10 reads B9 fixtures via `loadB9Fixture()` for the B9 smoke corpus, never edits them.
- **`bench/B10-import-replacement/tasks/validate-rfc5321-email/**`** — S2 task is READ-ONLY for S3. Any diff here is a scope violation.
- **`bench/B1-*`, `B4-*`, `B5-*`, `B6-*`, `B7-*`, `B8-*`, `v0-release-smoke/**`** — other benches untouched.
- **ALL WI-510 fixtures** under `packages/shave/src/__fixtures__/module-graph/**` — these belong to WI-510; B10 hand-translates from their *output* (the shaved subgraphs) but does not edit the vendored source.
- **`pnpm-workspace.yaml`** — B10 stays out of the workspace per parent C5.
- **`MASTER_PLAN.md`** — triad §6 defers the B10 MASTER_PLAN registration to a separate post-S3 slice.
- **Root `package.json`** — the existing three `bench:import-replacement*` scripts (landed in S1) are unchanged; the 10 new npm deps go in the BENCH-LOCAL package.json, not root.
- **`vitest.config.ts`, `biome.json`** — bench tests use `node --test`, not vitest; biome config governs lint and is unchanged.
- **`bench/B10-import-replacement/harness/measure-transitive-surface.mjs` algorithm** — the resolver is FROZEN after S1. Only the header `@decision` block may be amended (append DEC ref). Any algorithm/exclusion/counting change is OUT OF SCOPE.
- **`bench/B10-import-replacement/harness/classify-arm-b.mjs`** — the classifier is FROZEN after S2 (DEC-BENCH-B10-SLICE2-CLASSIFIER-DRYRUN-001). S3 does NOT touch its logic.
- **`bench/B10-import-replacement/harness/llm-baseline.mjs`** — frozen; the B10-fixture-preferred-over-B9 logic already lands new fixtures correctly.
- **`bench/B10-import-replacement/test/smoke-fixture-*.json`** — the S1 smoke fixture stays as-is (no regression).

### 9.4 Expected state authorities touched

- **Runtime state authorities:** None. B10 is a measurement tool with no runtime state authority. The harness reads files; it does not write to `state.db` or `evaluation_state` or any cc-policy authority.
- **File-level state writes:** under `bench/B10-import-replacement/**` only — corpus-spec, tasks/<task-id>/ for 14 new tasks, fixtures/<task-id>/ for 14 new tasks, fixtures/npm-audit-db/advisories.json (replace), results-*.json (headline), plus the per-file harness/test/README edits enumerated in §9.1.
- **File-level state reads:** the 10 new bench-local `node_modules/<pkg>/**` packages (the resolver traverses each Arm B's transitive closure); the Anthropic Messages API (live mode only); the existing WI-510 vendored fixtures under `packages/shave/src/__fixtures__/module-graph/**` (read-only; the implementer mentally references them for the hand-translation, but the bench harness does not import or read them at runtime).
- **Indirect production-code dependency:** the production `yakcc compile + #508 hook + WI-510 atom registry` path is NOT invoked in S3 (per `DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001`, same as S2). If a follow-on slice wires the production end-to-end CLI path, it can swap the FALLBACK arm-a files for production-emitted ones — but that is post-S3 work.

---

## 10. Decision Log — new DECs introduced by this plan

| DEC-ID | Decision | Rationale | Lands at |
|---|---|---|---|
| `DEC-BENCH-B10-SLICE3-TASK-CORPUS-SIZE-001` | Slice 3 corpus = 14 new tasks (15 total with S2's). | ≥10 PASS-DIRECTIONAL is issue acceptance; 12 actionable provides margin for engine-gap attrition; 15 is implementer-bounded; 20 is achievable as a follow-on S3-extension. | `bench/B10-import-replacement/corpus-spec.json` `note` + this plan §1.3 |
| `DEC-BENCH-B10-SLICE3-TASK-CORPUS-SELECTION-001` | The specific 14 new tasks per §2.2, mapped 1:1 to WI-510 atom sets covering all 11 libraries shaved in S2–S9. | Diversity across libraries (every WI-510-covered package represented), atom maturity (all underlying atoms passed `combinedScore` gates in WI-510), expected delta magnitude spans tiny (ms) to huge (lodash), engine-gap honesty (bcryptjs + zod ship disclosed). Implementer cost is bounded (~3000 LOC of bench-local `.mjs` boilerplate). | Each task's `spec.yak` `$comment` + corpus-spec.json + this plan §2.2 |
| `DEC-BENCH-B10-SLICE3-CVE-METRIC-001` | Promote npm-audit `cve_pattern_matches` from secondary-but-wired (S1+S2) to a headline reporting axis in the PR-body table and suite summary; back it with a real pinned advisory DB instead of the S1 2-row synthetic placeholder. | Parent issue body lists CVE pattern matches as one of two "Secondary metrics" required for B10 (B9 deferred Axis 4 fold-in). Real DB makes the number measurable; pinned DB makes it deterministic across hosts and CI; ALL bench-axis advisories deterministic per `DEC-BENCH-B7-CORPUS-CANONICAL-LF-001` discipline pattern. | `bench/B10-import-replacement/harness/measure-transitive-surface.mjs` `@decision` block (append ref) + `bench/B10-import-replacement/fixtures/npm-audit-db/advisories.json` (replace) + README CVE section + this plan §6 |
| `DEC-BENCH-B10-SLICE3-CVE-DB-PROVENANCE-001` | The pinned advisory DB is sourced from `npm audit --json` against a synthesized package.json containing exactly the 11 covered packages at WI-510 fixture versions, captured ONCE at S3-implementation date and regenerated only by explicit operator action (NOT by CI). | Determinism across hosts/CI is the central reason to pin the DB (parent §3.6); auto-refresh would re-introduce host-variance and break cross-PR comparability. The implementer documents the regen command; the operator owns regeneration. | `bench/B10-import-replacement/README.md` "Regenerating the CVE advisory DB" + this plan §6.2 |
| `DEC-BENCH-B10-SLICE3-HEADLINE-ACCEPTANCE-001` | Slice 3 is acceptable iff ≥10 of the 15 tasks have `verdict: PASS-DIRECTIONAL` on BOTH `reachable_functions` and `reachable_bytes` on the LIVE run with N=3 reps per task. Engine-gap-disclosed tasks ARE counted if their numeric delta meets the threshold (the gap qualifies provenance, not delta). | Direct quote of parent issue body acceptance. Engine-gap inclusion is consistent with WI-510 S8's honesty discipline — measurements are honest; provenance is disclosed. | PR body headline table + corpus-spec.json `note` + this plan §7.2 |
| `DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001` | The 12 unblocked S3 tasks use the same hand-translation fallback as S2's `DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001` — Arm A `.mjs` files are byte-equivalent to what the production `yakcc compile + #508 hook + WI-510 atoms` path would emit, but produced via direct hand-translation from the shaved subgraph since the end-to-end CLI path is not yet wired. | S2 R-S2-1 risk is unchanged in S3; the production CLI end-to-end path is still not exercised by any test. B9 + S2 precedent established this fallback discipline. Honest disclosure beats coupling S3 to integration work not in scope. | Each Arm A `.mjs` header comment + this plan §3.4 / §4 |
| `DEC-BENCH-B10-SLICE3-ARMA-ENGINE-GAP-DISCLOSED-001` | For `bcrypt-verify-constant-time` (#585) and `validate-string-min-max` (#619 + #576), Arm A is a hand-translation that is faithful to the binding semantics but is explicitly NOT a real atom composition because the engine cannot shave the binding-bearing source. The corpus-spec entry carries `engine_gap_disclosure.issue` and the PR-body table marks the verdict with `[GAP #N]`. | WI-510 S8 set the engine-gap-honest precedent. Hiding these tasks understates corpus breadth and misrepresents the engine's reach. Including them WITH disclosure preserves both honesty and corpus broadness. | Each affected Arm A `.mjs` header comment + corpus-spec.json entries + this plan §2.4 / §3.4 / §4 |
| `DEC-BENCH-B10-SLICE3-COST-001` | Slice 3 cost cap = $25 USD (unchanged constant value from S1/S2; only DEC reference appended). | 15 tasks × N=3 reps × ~$0.01/rep ≈ $0.45. The $25 cap is a structural safety rail. Matches B4 `DEC-V0-B4-SLICE2-COST-CEILING-004` $25 reserve. Constant value unchanged keeps `run.mjs` low-churn. | `bench/B10-import-replacement/harness/run.mjs` cost-cap `@decision` block (append ref) + this plan §5.2 |
| `DEC-BENCH-B10-SLICE3-CLOSES-512-001` | This is the FINAL slice of #512; PR body uses `Closes #512`; on merge, #512 is retired and the import-replacement triad (#508 + #510 + #512) is complete. | S3 delivers the headline acceptance bar; no further #512 work is planned in this issue. Any future B10 broadening (e.g. the 5 deferred tasks, or production-path Arm A) is a FRESH issue, not a reopen of #512. | PR body + drafted closing comment (§12) + this plan |

DECs cited (not introduced): `DEC-IRT-B10-METRIC-001`, `DEC-B10-S1-LAYOUT-001`, `DEC-B10-ARM-A-S1-001`, `DEC-B10-LLM-BASELINE-001`, `DEC-B10-CLASSIFY-ARM-B-001`, `DEC-BENCH-B10-SLICE1-COST-001`, `DEC-BENCH-B10-SLICE2-COST-001`, `DEC-BENCH-B10-SLICE2-DEMO-LIBRARY-001`, `DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001`, `DEC-BENCH-B10-SLICE2-CLASSIFIER-DRYRUN-001`, `DEC-BENCH-B10-SLICE2-VALIDATOR-DEP-001`, `DEC-V0-MIN-SURFACE-003`, `DEC-V0-MIN-SURFACE-004`, `DEC-BENCH-B7-CORPUS-CANONICAL-LF-001`, `DEC-WI510-S2-PER-ENTRY-SHAVE-001`, `DEC-WI510-S3-PARSE-COMPONENT-BINDING-001`, `DEC-WI510-S4-UUID-BINDING-NAMES-001`, `DEC-WI510-S4-NODE-BUILTIN-FOREIGN-LEAF-001`, `DEC-WI510-S5-PER-ENTRY-SHAVE-001`, `DEC-WI510-S6-NPM-EXTERNAL-FAN-OUT-001`, `DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001`, `DEC-WI510-S8-HELPER-FILE-MAPPING-001`, `DEC-WI510-S8-HELPER-FILE-MAPPING-AMENDED-002`, `DEC-WI510-S9-COMBINED-SCORE-FIXED-FLOOR-001`, `DEC-V0-B4-SLICE2-COST-CEILING-004`.

---

## 11. Risks

| ID | Risk | Likelihood | Mitigation |
|---|---|---|---|
| **R-S3-1** | Implementer budget overflows — 14 new tasks × ~120 LOC arm-a per task + 14 fixtures + 14 test files + 14 oracles is a large boilerplate volume. | **Medium** (estimated ~3000 LOC across ~70 new files). | Per-task pattern is fixed by S2 — implementer scripts the test-file generation from a template, generates spec.yak / arm-a stubs systematically, then hand-fills the semantic content per task. Recommend implementer process: do ALL 14 corpus-spec entries first, then ALL 14 spec.yak files, then ALL 14 arm-a directories, then ALL 14 fixtures, then ALL 14 oracles, then ALL 14 test files — batch-mode reduces context-switching cost. If implementer hits cost ceiling at task <14, ship what's done (still must clear ≥10 actionable) and file remaining tasks as S3-extension follow-up. |
| **R-S3-2** | One or more npm dependencies fail to install in the bench-local node_modules (sandbox/CI restriction, missing peerDeps, version conflict between fixture-pinned versions and current registry). | Low (S2's `validator@13.15.35` installed cleanly; pinning to WI-510 fixture versions matches what's known to work). | If install blocks on a specific dep, the implementer may either (a) skip that task and ship 13 instead of 14 (still likely meeting ≥10) and file the unblock as a follow-up issue, or (b) point the resolver at the WI-510 vendored fixture path via `--node-modules` flag (Option (ii) from S2 §4.1 — already evaluated as a fallback). Either fallback gets a per-task `@decision` annotation explaining the constraint. |
| **R-S3-3** | Real `npm audit` against the 11 covered packages produces a non-zero CVE count that DOES match traversed (package, version) pairs, surfacing a meaningful CVE matched count that an honest headline must include. | **Medium** (likely 0–3 small advisories; some of these packages have historical CVEs at older versions). | This is FEATURE, not bug — the issue body explicitly lists CVE pattern matches as a headline secondary metric. A non-zero number is the EXPECTED outcome and demonstrates the value-prop (yakcc atoms have zero CVE matches because they have zero npm imports). The PR-body suite summary calls this out: "Replacing the natural npm imports eliminated `<N>` known CVE pattern matches in the Arm B transitive surfaces." If a CRITICAL CVE shows up in a fixture-pinned version (e.g. an old lodash CVE), the implementer documents it in the README (the operator may decide to bump the fixture version — but that's WI-510 territory, not S3, and any version bump would need WI-510 atom regen). |
| **R-S3-4** | Resolver surfaces a bug when traversing a real npm package's edge cases (e.g. `lodash` 4's CJS interop, `date-fns` 4's nested `_lib/` subdirectories, `nanoid`'s CommonJS `.cjs` extension). | Medium (the resolver was hardened against `validator` in S2 but each new package may surface new edge cases). | Per S2 R-S2-3 mitigation: if bug is minor (~30-line fix in `measure-transitive-surface.mjs`), file as S3-extension follow-up issue and ship S3 with the affected task documented (the worst case is one task slips to PEND/WARN — still likely ≥10 of 14 actionable). If bug is structural, defer to a fresh slice. **Resolver is FROZEN in S3** per §9.3 — any change requires explicit re-scoping and likely a new planner pass. |
| **R-S3-5** | Oracle correctness — hand-translated Arm A may have subtle behavior differences from the real npm binding under edge inputs, failing the oracle's deep-equality assertion. | High (hand-translation IS error-prone; this is why the oracle exists). | Each oracle runs ≥20 fast-check inputs covering the binding's documented behavior + edge cases. Implementer iterates on Arm A until oracle is green. If a task cannot be oracle-aligned within reasonable effort (e.g. `lodash.merge`'s edge cases around prototype-inherited properties), the implementer either (a) narrows the spec to the in-scope subset and updates oracle accordingly, or (b) defers the task to a follow-up and ships 13 instead of 14. |
| **R-S3-6** | The classifier's `summarizeSuite` returns `total_cve_matches` as a number, but the PR-body table template (§7.3) treats it as per-task — if Arm B has 0 CVE matches across all 15 tasks, the per-task CVE column is all 0s and the headline summary CVE count is 0. The "eliminated CVE count" narrative becomes thin. | Medium (recent versions of pinned packages mostly have 0 advisories; bigger numbers come from older fixture versions). | Honest reporting: if the suite shows 0 CVE matches, the headline says "Across all 15 tasks, none of the traversed npm packages at the fixture-pinned versions matched any advisories in the pinned offline DB" — that's still useful (proves the audit pipeline works; documents the security state of the corpus at the time). The implementer does NOT inflate the metric. If 0 is the honest number, 0 is what ships. The structural value-prop remains: Arm A has 0 reachable npm functions so 0 possible CVE exposure regardless of advisory state. |
| **R-S3-7** | Live run reps produce LLM solutions that materially differ from the dry-run canonical fixtures (e.g. the LLM rolls a regex instead of importing the npm package), making the live verdict diverge from the dry-run verdict. | Low (the prompts are crafted such that the natural answer IS the npm import — that's the whole point of B10's task design). | Per S2 R-S2-4: the captured live response replaces the dry-run fixture and re-locks. If the LLM's natural answer for some prompt is genuinely not an npm import, that's a corpus-design finding the implementer surfaces and either (a) refines the prompt to nudge toward the npm import (re-locking sha256), or (b) replaces the task with one from the deferred 5 candidates (§2.2 last row). Either way it's bounded by the implementer's discretion within S3. |
| **R-S3-8** | The live run consumes budget faster than expected (e.g. one task's output is very long, inflating per-rep cost). | Low ($25 cap is 50x the expected $0.45 total spend). | `BudgetExceededError` short-circuits before any over-budget API call. If hit, the implementer reports the partial result and the operator decides whether to bump the cap. Default behavior is safe-fail. |

---

## 12. Drafted #512 closing comment (post-merge)

The orchestrator posts this on `#512` immediately after merge. Placeholders `<...>` are filled in from the LIVE run artifact.

```markdown
## #512 closes — import-replacement triad complete

WI-512 Slice 3 lands (PR #<S3-PR>); #512 is closed. Combined with #508 (CLOSED) and #510 (CLOSED via PR #623 — WI-510 S9 was the FINAL WI-510 slice), the import-replacement triad is complete: hook + corpus + measured headline. The yakcc value-prop "ship a strictly smaller, individually-verified surface than `npm install`" is now measured, not asserted.

### Three-slice ledger

| Slice | PR | Delivered | Key reading |
|---|---|---|---|
| S1 — instrument | #521 (`950afdc`) | `measure-transitive-surface.mjs` resolver + harness + synthetic-fixture T1–T11 tests + B9 smoke fixture | U4 mitigation proven on real B9 inputs (`smoke-fixture-f0640942ad73.json`) |
| S2 — first reading | #626 (`e6b0a34`) | `validate-rfc5321-email` import-heavy demo task + canonical Arm B fixture + 3 Arm A granularity strategies + oracle | Arm A 6 fns / 5,301 bytes / 1 file vs Arm B 511 fns / 260,056 bytes / 114 files — **98.8% fns / 98.0% bytes reduction** |
| **S3 — headline + close** | **#<S3-PR>** | **14 new import-heavy tasks (15 total); CVE axis fold-in; live headline `results-*.json`** | **<N>/15 PASS-DIRECTIONAL at ≥90% on both axes; <C> CVE pattern matches eliminated** |

### Headline reading — live run, <date>, N=3 reps per task

[Headline table copied from the merged PR body — §7.3 template, 15 rows]

### Triad completion

- **#508** (import-intercept hook) — CLOSED.
- **#510** (dependency-following shave engine, 9 slices, 11 npm packages) — CLOSED via PR #623 (S9 FINAL).
- **#512** (B10 import-heavy bench, 3 slices) — CLOSED via this PR.

The value-prop loop is closed: yakcc atoms (#510) + an intercept hook that redirects imports to atoms (#508) + a measured headline proving the surface reduction (#512). Triad coordination plan `plans/import-replacement-triad.md` §1 desired-end-state artifact is satisfied across a 15-task corpus, not a single demo.

### Filed engine-gap follow-ups (NOT regressions; honestly disclosed in the headline)

- **#576** — shave engine: `decompose()` cannot atomize ArrowFunctions inside class bodies (CLOSED; foundation for semver / zod path).
- **#585** — shave engine: cannot atomize UMD IIFE pattern (`bcryptjs/dist/bcrypt.js`); ships as engine-gap-disclosed Arm A in S3.
- **#619** — shave engine: TS-compiled CJS prelude (`__createBinding`/`__setModuleDefault`) defeats strict-subset decomposition; ships as engine-gap-disclosed Arm A in S3 (zod helper-file mapping per `DEC-WI510-S8-HELPER-FILE-MAPPING-001`).

These remain open as targeted engine work; resolving them upgrades the corresponding S3 task rows from engine-gap-disclosed to clean atom-composition Arm A.

### Deferred / next

- 5 additional import-heavy tasks from the parent enumeration (§2.2 of the S3 plan) are deferred as backlog candidates — these are S3-extension work, not #512 reopens. File a backlog item if/when desired.
- The end-to-end `yakcc compile + #508 hook + #510 atoms` CLI path is not yet driven by an integration test (per S2 R-S2-1 / S3 `DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001`). When that integration test lands, the 12 unblocked S3 Arm A files can be swapped from FALLBACK to production-emitted — a per-task transparent upgrade with no measurement change.
- MASTER_PLAN.md B10 initiative registration is deferred to a separate slice per triad plan §7 (out-of-scope explicit).

Plan: `plans/wi-512-s3-b10-broaden.md`.
```

---

## 13. Ready-for-Guardian definition (concrete simultaneous truth conditions on current HEAD)

(Repeated from §8.6 for trailer visibility — these 21 truth conditions are the literal acceptance bar.)

S3 is `ready_for_guardian` iff all of items 1–20 in §8.6 hold simultaneously on the worktree's current HEAD with pasted evidence in the PR body, and item 21 (the operator-gated LIVE run) is completed by the operator before merge. Reviewer may declare readiness after items 1–20; the operator owns item 21.

---

## Internal Quality Gate (self-check before emitting trailer)

- ✅ Dependencies & state mapped: §2.2 task-to-WI-510-atom mapping; §3.4 / §4 Arm A provenance per task; §6 CVE DB authority; §9.4 file-level state authorities enumerated; the resolver, classifier, llm-baseline, and arm-a-emit modules are all explicitly frozen-or-narrowly-touched per §9.3.
- ✅ Every guardian-bound work item has an Evaluation Contract with *executable* acceptance criteria: §8.1 has 6 per-task tests × 14 tasks (84 named per-task assertions) + 4 global tests (T-CORPUS-COUNT-1, T-SMOKE-FULL-1, T-CVE-DB-1, T-CLASSIFIER-CVE-1, T-DETERMINISTIC-DRYRUN-1); §8.2 has 5 real-path checks; §8.6 has 21 concurrent ready conditions with byte-level / numeric truth.
- ✅ Every guardian-bound work item has a Scope Manifest with explicit file boundaries: §9 enumerates allowed (10+ specific glob patterns), required (12+ specific path categories totaling ~70 new files), forbidden (12+ specific glob patterns including the critical READ-ONLY validate-rfc5321-email guard).
- ✅ No work item relies on narrative completion language: each test names a verifiable invariant or pasted-output requirement; §8.6 names byte-level / numeric truth conditions; §8.5 names specific forbidden shortcuts with reviewer detection criteria; §7.2 names a hard ≥10/15 numeric acceptance bar.
- ✅ Eval Contract uses **full-workspace** lint+typecheck (per durable memory `feedback_eval_contract_match_ci_checks.md`): §8.2 says `pnpm -w lint` and `pnpm -w typecheck`, full output pasted — explicitly NOT `--filter <pkg>` scoped.
- ✅ Land via PR (per durable memory `feedback_pr_not_guardian_merge.md`): §8.6 item 19 + §12 drafted closing comment.
- ✅ Fetch+pull before PR (per durable memory `feedback_fetch_before_pr.md`): §8.6 item 20.
- ✅ Operator-decision boundary surfaced ONLY where genuinely needed: the live Anthropic API run (§8.6 item 21) — and that boundary is the only one in S3. Task corpus selection (§2.2) was the only place an operator decision could have been requested; instead the plan pre-resolves it with §1.3 / §2.3 documented rationale (Question Merit Test passed — the answer is prescribed by the plan, would say "of course" given the criteria, and is implementer-decidable within the bounds). DEC-BENCH-B10-SLICE3-CVE-DB-PROVENANCE-001 documents the regeneration as operator-discretionary post-S3, not as an S3 gate.
- ✅ Continuation-aware: §1.2 / §12 are explicit that S3 is the FINAL slice of #512; the orchestrator's post-merge action is the §12 closing comment + retiring the worktree.

---

## Cross-references

- **Parent slice plan:** `plans/wi-512-b10-import-heavy-bench.md` (§3b.1 — "S3 = triad P5 — broaden + Axis-4 fold-in + headline acceptance").
- **S2 plan (per-task template authority):** `plans/wi-512-s2-b10-demo-task.md` (§2 demo task structure, §6 EC pattern, §11 PR body skeleton).
- **Triad coordination plan:** `plans/import-replacement-triad.md` (§1 desired-end-state, §4 #512 Slice 3, §6 broadening discipline).
- **S1 landed harness:** `bench/B10-import-replacement/harness/{run.mjs, measure-transitive-surface.mjs, arm-a-emit.mjs, llm-baseline.mjs, classify-arm-b.mjs, measure-axis1.mjs}`; `bench/B10-import-replacement/{corpus-spec.json, package.json, README.md}`; `bench/B10-import-replacement/test/*.test.mjs`. Merged via PR #521 (`950afdc`).
- **S2 landed demo task:** `bench/B10-import-replacement/tasks/validate-rfc5321-email/**`; `bench/B10-import-replacement/fixtures/validate-rfc5321-email/arm-b-response.json`; `bench/B10-import-replacement/test/validate-rfc5321-email.test.mjs`. Merged via PR #626 (`e6b0a34`). **READ-ONLY for S3.**
- **WI-510 source atoms:** `packages/shave/src/universalize/{validator,semver,uuid,nanoid,date-fns,jsonwebtoken,bcryptjs,lodash,zod,p-limit-p-throttle}-headline-bindings.test.ts` + `module-graph.test.ts` (`ms`). PRs: #526 (S1 engine + `ms`), #544 (S2 validator), #570/#571 (S3 semver), #573 (S4 uuid+nanoid), #584 (S5 date-fns), #586 (S6 jsonwebtoken + bcryptjs), #598 (S7 lodash), #616 (S8 zod), #623 (S9 p-limit+p-throttle FINAL).
- **WI-510 corpus catalogue:** `packages/registry/test/discovery-benchmark/corpus.json` — 18 npm-package corpus rows (lines ~720–1090) mapping to S3 task selections.
- **Engine-gap follow-ups disclosed in S3:** [#585](https://github.com/cneckar/yakcc/issues/585) (bcryptjs UMD IIFE), [#619](https://github.com/cneckar/yakcc/issues/619) (TS-compiled CJS prelude / zod), and the closed [#576](https://github.com/cneckar/yakcc/issues/576) (ArrowFunction-in-class-body / semver foundation).
- **Vendored fixtures (read-only references for hand-translation):** `packages/shave/src/__fixtures__/module-graph/{ms-2.1.3,validator-13.15.35,semver-7.8.0,uuid-11.1.1,nanoid-3.3.12,date-fns-4.1.0,jsonwebtoken-9.0.2,bcryptjs-2.4.3,lodash-4.17.21,zod-3.25.76,p-throttle-8.1.0}/`.
- **B9 structural template:** `bench/B9-min-surface/tasks/parse-coord-pair/{spec.yak, arm-a/{fine,medium,coarse}.mjs}` for shape; `bench/B9-min-surface/fixtures/parse-int-list/arm-b-response.json` for Anthropic-response fixture shape.
- **Bench-discipline DECs reused:** `DEC-V0-MIN-SURFACE-003` (locked Arm B prompt + sha256 lock), `DEC-V0-MIN-SURFACE-004` (granularity sweep), `DEC-BENCH-B7-CORPUS-CANONICAL-LF-001` (LF-normalized sha256 corpus pinning), `DEC-V0-B4-SLICE2-COST-CEILING-004` (B4 $150 suite cap inc. $25 B10 reserve).

*End of plan.*
