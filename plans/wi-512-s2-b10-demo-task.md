# WI-512 Slice 2 — B10 Import-Heavy Bench: Demo Task + First Real Reading

**Issue:** [#512](https://github.com/cneckar/yakcc/issues/512) — "B10 import-heavy bench — measure transitive reachable surface vs natural-import baseline"
**Workflow:** `wi-512-s2-b10-demo`
**Branch / worktree:** `feature/wi-512-s2-b10-demo` @ `C:/src/yakcc/.worktrees/wi-512-s2-b10-demo`
**Fork point:** `f6fdeca` (post-WI-510 S9 merge; `main`)
**Stage:** planner (plan only — no source code in this pass)
**Authored:** 2026-05-16
**Complexity tier:** Tier 2 (Standard) — first import-heavy task on top of an already-landed instrument; bounded touch surface (bench-local + one corpus-spec entry); known operator-decision boundary on live API spend; methodology already settled in `DEC-IRT-B10-METRIC-001`.

This document is the **Slice 2** plan that owns the next slice of [#512](https://github.com/cneckar/yakcc/issues/512). It is subordinate to:
- the parent slice plan `plans/wi-512-b10-import-heavy-bench.md` (§3b.1 — "S2 = triad P2c — first import-heavy task + first real `results-*.json`"),
- the reframed triad coordination plan `plans/import-replacement-triad.md` (§1 desired-end-state artifact; §4 #512 Slice 2).

It does not modify `MASTER_PLAN.md`, does not touch the production registry, and does not change `bench/B9-min-surface/**`.

---

## 1. Problem statement — what S2 delivers that S1 cannot

### 1.1 Recap of what S1 left on the table

S1 (PR #521 / `950afdc`, merged) landed the instrument: the `measure-transitive-surface.mjs` resolver, the harness `run.mjs`, the synthetic-fixture exact-count test suite (T1–T11), and the B9-corpus smoke validation. The committed `smoke-fixture-f0640942ad73.json` proved the resolver handles real .mjs emits and does not explode on stdlib edges (the U4 mitigation).

What S1 deliberately did **not** ship (parent plan §3b.2, NG3, NG4):
- any import-heavy task in `tasks/<task>/`
- any non-empty `corpus-spec.json`
- Arm A driven by a real npm-import-emitting flow
- the headline ≥90% transitive-surface delta reading

S1's smoke run produced `PENDING` verdicts on all six B9 tasks because the B9 corpus is structurally degenerate for the headline claim — those tasks have zero npm imports on Arm B (`JSON.parse`-style builtins) so Arm A has nothing to be measurably smaller than. The instrument is correct; the corpus does not exercise it.

### 1.2 What S2 must deliver

S2 produces yakcc's **first measurable transitive-surface delta** proving the dependency-replacement value-prop. The deliverable is:

1. **One import-heavy demo task** in `bench/B10-import-replacement/tasks/validate-rfc5321-email/` with a corpus-spec entry, sha256-pinned spec, locked Arm B prompt (sha256-pinned), and Arm A reference emit(s).
2. **A dry-run path that runs in CI** (committed `arm-b-response.json` fixture with a canned Anthropic Messages response that emits `import { isEmail } from 'validator'`).
3. **A first real result artifact** committed at `bench/B10-import-replacement/results-<platform>-<date>.json` (from the operator-gated live run) showing Arm B's transitive surface (validator + its closure) versus Arm A's transitive surface (zero npm functions on the B-scope yakcc reference emit), with the ≥90% reduction threshold met on both `reachable_functions` and `reachable_bytes`.

### 1.3 Why "validator / isEmail" is the right first reading

- It is the canonical example in the triad plan §1: the literal `import { isEmail } from 'validator'` is the demonstration string for the value-prop.
- It is `validator`'s smallest-shaped headline binding (4 short atoms per the WI-510 S2 binding test: `isEmail`, `isURL`, `isUUID`, `isAlphanumeric`).
- WI-510 S2 (validator atoms) is the most-validated atom set in the codebase: ~30M weekly downloads, longest-proven in the corpus.
- The demo prompt — "validate an RFC 5321 email address" — is the canonical LLM-emits-import-of-real-npm-package case.
- `validator` has near-zero `node_modules` closure (no transitive runtime deps), so the Arm B transitive surface is concretely measurable and small enough to verify by hand against the resolver output. This protects the first headline reading from "the number is huge — is the resolver right or is `validator` huge?" debates.

### 1.4 Why S2 is the *first reading*, not the headline

S3 is the "≥90% on ≥10 of 12–20 tasks" headline (parent plan §3b.1; triad plan #512 Slice 3). S2 produces **one** reading. One reading is enough to:
- close the loop of the value-prop demonstration (triad plan §1 desired end state),
- pressure-test the resolver on a real npm package (any structural bug in the resolver surfaces here, not in the headline run),
- prove the live-run discipline (cost cap, sha256 prompt locking, fixture vs live split) works end-to-end before S3 scales it across the corpus.

---

## 2. Demo task specification

### 2.1 Choice — `validator` / isEmail (resolves OD-3)

| Decision | Value | Annotation |
|---|---|---|
| Demo library | `validator@13.15.35` (matches the vendored WI-510 fixture at `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/`) | `DEC-BENCH-B10-SLICE2-DEMO-LIBRARY-001` |
| Demo binding | `isEmail` | matches WI-510 S2 (`validator-headline-bindings.test.ts` `describe("validator isEmail …")`) |
| Task ID | `validate-rfc5321-email` | matches triad plan §1 / parent plan §1.4 U5 examples |
| Entry function (Arm A and Arm B) | `validateRfc5321Email` | matches the locked task signature in §2.2 below |

Rationale (per task prompt's pre-resolved default):

(a) **Smallest atom-shaped headline binding in WI-510.** Per the WI-510 S2 test file's section-A assertions, the isEmail subgraph is `moduleCount ∈ [7,12]` with `stubCount=0` — the smallest of the four validator headline bindings has lower bound 1 (isUUID), but isEmail is the most semantically aligned with the parent plan's canonical example and the triad plan §1 demonstration string. It is large enough to produce a non-trivial transitive-surface reading and small enough to verify by hand.

(b) **Most-validated atom set.** WI-510 S2 was the first headline-bindings slice and has accumulated the most reviewer cycles (S2 §F combinedScore quality gate, two-pass determinism, per-entry isolation discipline per `DEC-WI510-S2-PER-ENTRY-SHAVE-001`).

(c) **Canonical demonstration string.** Triad plan §1: "Arm B emits `import { isEmail } from 'validator'`" — that exact import is what the headline reading must measure.

(d) **Hand-verifiable closure.** `validator@13.15.35` has zero runtime `dependencies` in its `package.json` (per the vendored fixture). The transitive closure is `validator/index.js` + the files in `validator/lib/**` actually imported through `isEmail`'s subgraph + the bundled `package.json#exports` resolution. Closed, small, hand-countable. No surprise transitive dep blowups in the first reading.

### 2.2 Locked task spec — `validate-rfc5321-email`

The committed `spec.yak` (under `bench/B10-import-replacement/tasks/validate-rfc5321-email/spec.yak`) follows the B9 task-spec shape (see `bench/B9-min-surface/tasks/parse-coord-pair/spec.yak`):

```jsonc
{
  "name": "validate-rfc5321-email",
  "inputs": [
    { "name": "input", "type": "string",
      "description": "An RFC 5321 (SMTP envelope) email address string." }
  ],
  "outputs": [
    { "name": "result", "type": "boolean",
      "description": "True iff the input is a valid RFC 5321 email address." }
  ],
  "level": "L0",
  "behavior": "Validate whether a string is a valid RFC 5321 email address. Returns true iff the input parses as a single mailbox per RFC 5321 §4.1.2 (local-part '@' domain), with no display name, no UTF-8 local parts, and a TLD required on the domain part.",
  "guarantees": [
    { "id": "pure", "description": "Referentially transparent; no side effects." },
    { "id": "boolean-output", "description": "Returns boolean true/false; never throws on input shape." }
  ],
  "errorConditions": []
}
```

**Spec rationale.** The narrow RFC 5321 constraints (no display name, no UTF-8 local parts, TLD required) match `validator`'s `isEmail` default options. This makes the natural LLM-emitted solution `return validator.isEmail(input)` (with default options) the **same** semantic behavior as the spec — the byte-equivalence oracle (§5.3) can be exercised cleanly. Arm A's atom-composed implementation is a wrapper that calls into the shaved isEmail subgraph and likewise returns boolean.

### 2.3 Locked Arm B prompt

The Arm B prompt re-uses the verbatim system prompt from `DEC-V0-MIN-SURFACE-003` (already cited in `harness/llm-baseline.mjs`'s `@decision DEC-B10-LLM-BASELINE-001`). The user prompt template is rendered from the spec:

```
System: You are an expert TypeScript developer. When given a coding task, implement it in a single TypeScript file. Output only the implementation code in a ```typescript code block. Do not include explanation before or after the code block.

User: Implement a TypeScript function with this signature: function validateRfc5321Email(input: string): boolean

Behavior:
Validate whether a string is a valid RFC 5321 email address. Returns true iff the input parses as a single mailbox per RFC 5321 §4.1.2 (local-part '@' domain), with no display name, no UTF-8 local parts, and a TLD required on the domain part.
```

(No "Error conditions:" / "Throw appropriate Error subclasses…" trailer — `errorConditions: []` in the spec and a boolean return per §2.2 keeps the prompt minimal and lets the natural answer be a single boolean-returning function. The `llm-baseline.mjs::buildUserPrompt()` helper produces exactly this rendering when `errorConditions` is omitted.)

**Prompt sha256 lock.** The corpus-spec entry's `arm_b_prompt.prompt_sha256` is computed at first run by the existing `promptSha256()` helper in `llm-baseline.mjs` over UTF-8 bytes of `SYSTEM_PROMPT + "\n\n" + rendered_user_prompt`, then committed verbatim into `corpus-spec.json`. The harness verifies the sha on every subsequent run and aborts on drift. This is `DEC-V0-MIN-SURFACE-003` discipline mirrored.

**Spec sha256 lock.** Per parent plan C4 and `DEC-BENCH-B7-CORPUS-CANONICAL-LF-001`, the committed `spec.yak` is LF-normalized and its sha256 is computed at first run, committed as `spec_sha256_lf`, and verified on every subsequent run with hard-abort on drift.

### 2.4 Expected Arm A composition

In B-scope (per triad plan OD-1 / `DEC-IRT-RECURSION-SCOPE-001`-equivalent in `wi-510-shadow-npm-corpus.md`), Arm A for `validate-rfc5321-email` is the yakcc atom composition that consumes WI-510 S2's `isEmail` shaved forest. The expected import surface of Arm A's emit:
- **Zero non-builtin imports** — the composition is built from the in-repo shaved atoms (whose merkle roots are content-addressed in the registry seeded by WI-510 S2's `validator-headline-bindings.test.ts §E`).
- Either zero relative imports (single-file inlined composition) or only intra-bench relative imports between Arm A reference modules. No `validator/**` traversal.

**Atom merkle roots.** Arm A is expected to compose from the isEmail subgraph atoms produced by `shavePackage(VALIDATOR_FIXTURE_ROOT, { entryPath: "lib/isEmail.js" })`. WI-510 S2's section A asserts `forest.moduleCount ∈ [7,12]` with `stubCount=0`; the corresponding atom merkle roots are persisted via `maybePersistNovelGlueAtom` in section E. Slice 2 does **not** pin specific merkle root values into the spec (they are content-derived and would constitute a brittle cross-package coupling) — the Arm A emit instead either (a) inlines the byte-equivalent isEmail implementation as in-bench `.mjs` reference modules (the same pattern B9 uses for its arm-a/*.mjs references), or (b) is produced by the live `yakcc compile + import-gate` path (see §3.2 fallback).

### 2.5 Expected Arm B import path

Arm B's expected emit (the literal string the LLM produces for the locked prompt, captured in the dry-run fixture):

```typescript
import validator from 'validator';

function validateRfc5321Email(input: string): boolean {
  return validator.isEmail(input);
}

export { validateRfc5321Email };
export default validateRfc5321Email;
```

Or the named-import variant:

```typescript
import { isEmail } from 'validator';

function validateRfc5321Email(input: string): boolean {
  return isEmail(input);
}

export { validateRfc5321Email };
export default validateRfc5321Email;
```

Either variant is acceptable — both trigger the same `validator` transitive-surface traversal in the resolver. The committed fixture (§4.1) pins ONE specific variant for byte-determinism of the dry-run path.

---

## 3. Arm A specification

### 3.1 Resolution order (mirrors S1's `arm-a-emit.mjs::resolveArmAEmit` discipline)

`resolveArmAEmit('validate-rfc5321-email', 'A-fine')` (and `-medium`, `-coarse`) MUST resolve via the same two-path lookup S1 already implements:
1. **B10 task-specific arm-a (PRIMARY in S2):** `bench/B10-import-replacement/tasks/validate-rfc5321-email/arm-a/{fine,medium,coarse}.mjs` if present.
2. **B9 fallback** — irrelevant for this task ID (no B9 task with this name); the existing `resolveArmAEmit` throws `"Arm A emit not found …"` if path 1 is missing. S2 MUST populate path 1.

The implementer must also add the entry to `TASK_ENTRY_FUNCTIONS` in `arm-a-emit.mjs`:

```js
"validate-rfc5321-email": "validateRfc5321Email",
```

### 3.2 Production path — `yakcc compile + #508 hook + #510 atoms`

The "real" Arm A in the triad plan §4 (#512 Slice 2 row) is "`arm-a-emit` driven by `yakcc compile` + hook + atoms." Concretely:

1. Author a tiny driver script (or stage in `arm-a-emit.mjs`) that loads the registry, seeds WI-510 S2's isEmail forest (running `shavePackage(VALIDATOR_FIXTURE_ROOT, { entryPath: "lib/isEmail.js" })` and persisting atoms with the same `withSemanticIntentCard` discipline as the WI-510 S2 §F test).
2. Invoke `yakcc compile` (or the equivalent programmatic entry from `@yakcc/compile`) against an input module that says `import { isEmail } from 'validator'` plus a one-line `validateRfc5321Email` wrapper.
3. The `#508` `import-intercept` hook + `import-gate` should intercept the unexpanded `validator` import (validator is on `GATE_INTERCEPT_ALLOWLIST` per `packages/compile/src/import-gate.ts` line 18) and surface the atom composition.
4. The emitted `.mjs` is committed as `bench/B10-import-replacement/tasks/validate-rfc5321-email/arm-a/fine.mjs`.

### 3.3 Fallback — hand-authored Arm A reference (B9 precedent)

The triad plan and parent plan both acknowledge this fallback explicitly:

- Parent plan §3b.2: "Arm A in [S1] resolves Arm A emit paths to the **B9 reference `.mjs` files**. The `yakcc compile + #508-hook` path is wired as a *documented TODO branch* activated in S2."
- Triad plan §4 #510 Slice 2: WI-510 S2 produces a shaved isEmail forest via the test path (`shavePackage(...)` in `validator-headline-bindings.test.ts`), not necessarily via the production `yakcc compile` end-to-end CLI pipeline. The connection from "atom forest exists in registry" to "the `yakcc compile` CLI emits an atom-composed Arm A `.mjs`" is a real integration not yet exercised end-to-end in the codebase (the `yakcc compile` CLI exists per `packages/cli/src/commands/compile.ts`, the `import-gate` exists per `packages/compile/src/import-gate.ts`, but no test today drives a yakcc-compile run that consumes a WI-510-seeded registry and emits a `.mjs` Arm A artifact).

**Slice 2 is allowed to use the fallback** if the production path is not wired end-to-end at implementation time. Fallback rules:

- Arm A reference `.mjs` files are **byte-equivalent** to what a successful `yakcc compile + import-gate` run would emit (semantically; the implementer hand-translates the shaved isEmail subgraph into a single `.mjs` per granularity strategy). This preserves the resolver's "Arm A reachable npm surface = 0" invariant.
- A risk note (§9 R-S2-1) is filed in this plan documenting the gap, plus a follow-on GitHub issue for "wire `yakcc compile` end-to-end against a WI-510-seeded registry for B10 Arm A" if the fallback is exercised.
- The committed Arm A `.mjs` carries an `@decision` annotation explicitly disclosing it was produced via the fallback path (see §6 Required tests T-A-2 and §8 `DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001`).

Per **DEC-WI510-S2-PATH-A-CONFIRMED-001** (in `validator-headline-bindings.test.ts`), `shavePackage` is the existing API; using it to produce the Arm A composition keeps Arm A consistent with the rest of the WI-510 work and avoids depending on an end-to-end CLI path that is not proven yet.

### 3.4 Three granularity strategies (mirrors B9 `DEC-V0-MIN-SURFACE-004`)

S1 already wires `A-fine | A-medium | A-coarse` through `resolveArmAEmit`. S2 must populate all three:
- **`A-fine`** — maximally atomic decomposition (one exported function per RFC 5321 sub-rule: local-part validator, domain validator, length check, TLD presence check). Mirrors B9's `parse-coord-pair/arm-a/fine.mjs` pattern (one atom per structural concern). Six to ten small named functions.
- **`A-medium`** — two or three named functions (local-part validator, domain validator, the entry wrapper).
- **`A-coarse`** — a single named function (the entry) inlining the whole validation.

All three strategies MUST produce zero non-builtin imports. The transitive resolver MUST measure `reachable_files == 1` and `reachable_functions ∈ [1,~10]` depending on strategy.

### 3.5 What the resolver should see for each Arm A strategy

| Strategy | Expected `reachable_files` | Expected `reachable_functions` | Expected `unique_non_builtin_imports` |
|---|---|---|---|
| A-fine | 1 | 6–10 (one per atom + entry) | 0 |
| A-medium | 1 | 3–4 | 0 |
| A-coarse | 1 | 1 (the entry alone) | 0 |

These ranges are guidance for the implementer; the Evaluation Contract pins only the load-bearing invariants (`reachable_files == 1`, `unique_non_builtin_imports == 0`) on the smoke result.

---

## 4. Arm B specification

### 4.1 Dry-run path — committed fixture (CI default)

`bench/B10-import-replacement/fixtures/validate-rfc5321-email/arm-b-response.json` is a committed Anthropic Messages API response (the same shape as `bench/B9-min-surface/fixtures/parse-int-list/arm-b-response.json`). The fixture carries:

```jsonc
{
  "_fixture_note":     "Canned Anthropic Messages API response for B10 Slice 2 dry-run. Arm B = LLM baseline (no yakcc hook). Emits the natural `import { isEmail } from 'validator'` solution. Drives the resolver against validator's actual transitive closure.",
  "_fixture_provenance": "Hand-authored representative fixture for the locked prompt; replaced by the captured live-run response committed alongside the headline results artifact (see §6 T-B-2).",
  "_arm":              "B",
  "_task":             "validate-rfc5321-email",
  "_prompt_sha256":    "<computed at first run; pinned into corpus-spec.json>",
  "id":                "msg_dry_validate_rfc5321_email_arm_b_001",
  "type":              "message",
  "role":              "assistant",
  "model":             "claude-sonnet-4-6",
  "stop_reason":       "end_turn",
  "stop_sequence":     null,
  "usage":             { "input_tokens": 0, "output_tokens": 0,
                          "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0 },
  "content": [{
    "type": "text",
    "text": "```typescript\nimport validator from 'validator';\n\nfunction validateRfc5321Email(input: string): boolean {\n  return validator.isEmail(input);\n}\n\nexport { validateRfc5321Email };\nexport default validateRfc5321Email;\n```"
  }]
}
```

This fixture is what `llm-baseline.mjs::loadB9Fixture()` (which already falls through to a `b10FixturePath = join(BENCH_B10_ROOT, "fixtures", taskId, "arm-b-response.json")` check before the B9 fallback — see lines 156–161) returns under `--dry-run`. No code change needed in `llm-baseline.mjs` to make the fixture authoritative for the new task; the lookup already prefers a B10 fixture if present.

**Why hand-authored, not live-captured, for the initial dry-run fixture.** S1's smoke fixture was hand-authored too (the `_fixture_provenance` in the B9 parse-int-list fixture explicitly says so). The hand-authored fixture is the **canonical natural answer** the LLM should give for this prompt; if a live capture differs, that capture replaces the fixture (with provenance updated to `live-captured`) and the dry-run path now reproduces the live answer exactly. This is the same B9 discipline.

**`validator` install for the dry-run path.** The resolver running against the dry-run Arm B emit (which carries `import validator from 'validator'`) needs an installed `validator/` under a `node_modules/` reachable from the emit file. Two options:

| Option | What | Trade-off |
|---|---|---|
| (i) Add `validator` as a `dependency` of `bench/B10-import-replacement/package.json` | `pnpm --dir bench/B10-import-replacement install` brings `validator` into the bench-local `node_modules` | Clean isolation (B10 is NOT in pnpm-workspace.yaml per parent C5); `validator` becomes a bench-local dep next to `@anthropic-ai/sdk`, `ts-morph`, `fast-check`. No production-side coupling. The resolver auto-resolves against the bench-local `node_modules` (S1 resolver finds `nearest node_modules to --emit` by default). |
| (ii) Point the resolver at the WI-510 vendored fixture | Set `--node-modules <path-to-vendored-validator-parent>` so the resolver traverses the vendored `validator-13.15.35/` | Avoids adding an npm dep but couples the bench to the `packages/shave/src/__fixtures__/module-graph/` path layout (a fixture path that exists for a different purpose) and the resolver's bare-package resolver expects a `node_modules/<pkg>/` layout, not an arbitrary vendored dir — would require resolver/test fixture changes. |

**Recommendation: Option (i).** It is the cleaner B-scope analogue of B9's per-bench-local install discipline. The implementer adds `"validator": "^13.15.35"` to `bench/B10-import-replacement/package.json` `dependencies`, runs `pnpm --dir bench/B10-import-replacement install`, and the resolver resolves transparently. The bench-local `node_modules` is gitignored (the bench already excludes its own `node_modules` per S1 discipline). **`DEC-BENCH-B10-SLICE2-VALIDATOR-DEP-001`** captures this.

If the implementer hits an unforeseen blocker with Option (i) (e.g. some sandbox prevents bench-local installs), Option (ii) is acceptable with an in-line `@decision` note explaining the constraint.

### 4.2 Live-run path — Anthropic API ONCE (operator-gated)

The live run is the headline reading. It is operator-gated per parent plan §3b.3 and triad plan §4 #512 Slice 2 Evaluation Contract hint.

**Mechanics (already implemented by S1's `llm-baseline.mjs::callAnthropicApi`):**
- Requires `ANTHROPIC_API_KEY` env var; harness aborts with a clear error if absent (already implemented).
- Cost cap per S2 (see §2.6 below; `DEC-BENCH-B10-SLICE2-COST-001`).
- The locked prompt's sha256 is verified before the API call; if drift, abort.
- The response is extracted via the existing `extractEmitFromResponse` (handles `\`\`\`typescript` and `\`\`\`ts` fences).
- The resolver runs against the extracted emit `.mjs`; the result is included in the artifact.

**Per-run discipline:**
- The artifact written to `bench/B10-import-replacement/results-<platform>-<date>.json` is committed alongside the live-run capture (the captured Anthropic response is also committed under `bench/B10-import-replacement/fixtures/validate-rfc5321-email/arm-b-live-<date>.json` as provenance for the headline number).
- Per parent C3 and B9 discipline, the live run "exits the B6 air-gap by design." The README already documents this.

**The live run is NOT in S2's CI path.** CI runs `--dry-run` only. The live run is the operator's discretionary action that produces the headline numeric reading; both arms must be ready and dry-run-verified before the operator triggers it.

### 2.6 Slice-2 cost cap (resolves OD-4)

| Decision | Value | Annotation |
|---|---|---|
| Slice 2 cost cap | **$25** | `DEC-BENCH-B10-SLICE2-COST-001` |

Rationale:
- Parent plan §3b.3 + Appendix DEC stub already suggested $25 with rationale tied to B4 / B9 precedent.
- B4 has a $25 reserve in `DEC-V0-B4-SLICE2-COST-CEILING-004` for the B10 slot; this consumes that reserve.
- A single live run for one task with N=3 reps at ~$0.01 per rep is ≈ $0.03 — the cap is a safety rail for re-run scenarios (model drift requires re-locking, fixture corruption requires re-capture, etc.).
- The existing `BudgetExceededError` in `run.mjs` already enforces a `COST_CAP_USD = 25` constant; S2 may either retain S1's `DEC-BENCH-B10-SLICE1-COST-001` (which used $25) as-is and add `DEC-BENCH-B10-SLICE2-COST-001` as the new authority for S2, or rename the constant from `COST_CAP_USD` to `SLICE_COST_CAP_USD` and parametrize by `--slice`. The minimal change is to **keep `COST_CAP_USD = 25` and add the S2 DEC reference in the `@decision` block** (the constant value is the same; only the DEC annotation changes). This avoids harness churn for an unchanged value.

If the operator wants a different cap, the value lives in one place (`run.mjs` line 65) and changes via a single edit.

---

## 5. Measurement and expected delta

### 5.1 Apply S1 resolver to both arms

The harness `run.mjs::measureTask` already (S1) runs:
- `measureTransitiveSurface({ emitPath: armA_emit, entryName: 'validateRfc5321Email', audit: true })`
- `measureTransitiveSurface({ emitPath: armB_emit, audit: true })` for each Arm B rep

No new resolver code is required. S2 only adds a new task (corpus-spec entry + arm-a/*.mjs + dry-run fixture + entry in `TASK_ENTRY_FUNCTIONS`).

### 5.2 Expected numeric ranges (informational; not contract-locked beyond §5.3)

| Metric | Arm A (yakcc atom composition) | Arm B (validator natural import) | Expected delta |
|---|---|---|---|
| `reachable_functions` | 1–10 (depending on granularity strategy) | hundreds (validator/lib/isEmail.js + isFQDN.js + isIP.js + util/assertString.js + util/merge.js + util/isString.js + index.js + per WI-510 S2 ranges 7–12 modules; each module has multiple body-bearing functions; rough estimate 50–300 functions) | ≥95% reduction |
| `reachable_bytes` | <5,000 bytes | ~50,000–200,000 bytes | ≥95% reduction |
| `reachable_files` | 1 (single-file emit) | 7–15 (validator's isEmail subgraph closure) | bounded |
| `unique_non_builtin_imports` | 0 | 1 (just `'validator'`) | "no-import" wins |
| `npm_audit.cve_pattern_matches` | 0 | 0 (validator@13.15.35 has no known advisories as of authoring) or whatever the offline DB returns | informational |

These ranges drive expectations; the Evaluation Contract (§6) only requires the **directional** ≥90% reduction on `reachable_functions` AND `reachable_bytes`. The exact numbers will be pinned in the smoke fixture filename's content hash and are reviewable in the committed artifact.

### 5.3 Headline acceptance metric (S2 only — single task)

S2's directional acceptance:
- `reduction(reachable_functions) ≥ 0.90` on the dry-run smoke result, AND
- `reduction(reachable_bytes) ≥ 0.90` on the dry-run smoke result, AND
- `arm_a.unique_non_builtin_imports == 0` AND `arm_b.unique_non_builtin_imports >= 1`, AND
- the classifier returns `verdict: "PASS-DIRECTIONAL"` on dry-run for this task (the existing `classify-arm-b.mjs::REDUCTION_THRESHOLD = 0.90` already implements this comparison — no code change required; only the classifier's handling of dry-run must allow `PASS-DIRECTIONAL` when the dry-run fixture is a real import-heavy emit, not always return `PENDING`).

**Classifier note (potential small `classify-arm-b.mjs` edit).** S1's classifier currently returns `verdict: "PENDING"` whenever `dry_run === true` (line 117–119) with reason "dry-run mode — not a statistically valid measurement." For the dry-run *smoke* path against the B9 corpus (where Arm B fixtures are JSON.parse-style and produce 0 npm imports) PENDING is correct. But for S2's import-heavy dry-run (where the canned fixture is the **deliberate canonical answer**, not a single representative sample), the classifier MUST be able to return PASS-DIRECTIONAL / WARN-DIRECTIONAL based on the actual measurement. The minimal change: replace the unconditional `dryRun` → PENDING short-circuit with a check that only forces PENDING when `bMedianFn === 0` (the "no import surface to measure" case) and otherwise applies the normal threshold comparison. The dry-run flag still flows into the result so the reviewer sees `dry_run: true, single_rep: true` annotations alongside the verdict.

This is a small (~10-line) targeted edit to `classify-arm-b.mjs` that the implementer makes as part of S2. The DEC annotation: `DEC-BENCH-B10-SLICE2-CLASSIFIER-DRYRUN-001` — "dry-run mode is allowed to return PASS-DIRECTIONAL when the canned fixture represents the canonical natural answer for an import-heavy task; PENDING is reserved for missing/zero measurements."

### 5.4 Live-run acceptance metric (additional, operator-gated)

The live run produces a numeric reading from a real Anthropic API capture. The committed `results-<platform>-<date>.json` artifact must show:
- `mode: "live"`,
- `task_results[0].arm_b.reps` length = 3 (N=3 live),
- median `reachable_functions` and `reachable_bytes` for Arm B that are within the §5.2 expected ranges (sanity check — if the live capture returns 5 functions, something is wrong; if it returns 50,000 functions, the resolver mis-traversed and the result is rejected),
- ≥90% reduction held on the live medians,
- the captured response sha256 matches what was committed to `fixtures/validate-rfc5321-email/arm-b-live-<date>.json`.

The live run is a follow-on operator action; CI does not run it. The committed live artifact is the headline reading.

---

## 6. Evaluation Contract — Slice 2 (guardian-bound)

A reviewer declares S2 `ready_for_guardian` **iff every item below is satisfied with pasted evidence** (live command output, not prose).

### 6.1 Required tests (must exist and pass)

**T-CORPUS-1** — `bench/B10-import-replacement/corpus-spec.json` validates against its `$schema: "corpus-spec/v2"` shape and contains exactly one task entry for `validate-rfc5321-email` with all required fields (`id`, `spec_path`, `spec_sha256_lf`, `entry_function`, `arm_a_granularity_strategies`, `arm_b_n_reps`, `arm_b_prompt` with `system_prompt`, `user_prompt_template`, `prompt_sha256`, `dry_run_fixture`, `directional_targets`). The harness loads it on startup without error.

**T-A-1** — `node bench/B10-import-replacement/harness/arm-a-emit.mjs --task validate-rfc5321-email --strategy A-fine --json` resolves to the committed Arm A reference under `bench/B10-import-replacement/tasks/validate-rfc5321-email/arm-a/fine.mjs`, with `entry_function: "validateRfc5321Email"` and `source: "b10-task"`. Same for `--strategy A-medium` and `--strategy A-coarse`.

**T-A-2** — Each of the three Arm A reference `.mjs` files, when measured by `measure-transitive-surface.mjs`, produces: `reachable_files == 1`, `unique_non_builtin_imports == 0`, `builtin_imports + type_only_imports == any` (irrelevant), `reachable_functions ∈ [1, 20]` (loose upper bound; the load-bearing invariant is *no non-builtin imports*). If the implementer used the §3.3 fallback path, each `.mjs` carries an inline `@decision DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001` comment disclosing the provenance.

**T-A-3** — The Arm A reference emit's behavior matches the spec: for a fast-check property test of ≥20 RFC-5321 email inputs (matching valid and invalid emails), the Arm A entry function returns the same boolean as `validator.isEmail(input)` with default options. This is the byte-equivalence oracle in the B9 Axis-3 sense (triad plan §1 desired-end-state item 3), simplified for boolean output: same value, not byte-identical text. Committed as `bench/B10-import-replacement/tasks/validate-rfc5321-email/arm-a/oracle.test.mjs` and runs in CI as part of `pnpm --dir bench/B10-import-replacement test`.

**T-B-1** — `bench/B10-import-replacement/fixtures/validate-rfc5321-email/arm-b-response.json` exists, parses as JSON, has `content[0].text` containing a `\`\`\`typescript` fence with a body that contains the substring `from 'validator'` and a function named `validateRfc5321Email` returning boolean. `llm-baseline.mjs::extractEmitFromResponse` returns non-null when given this fixture.

**T-B-2** — When run live (`node harness/run.mjs --tasks validate-rfc5321-email` with `ANTHROPIC_API_KEY` set), the produced artifact carries `task_results[0].arm_b.reps.length == 3` and each rep's `emit_text` includes `from 'validator'`. The captured response is committed to `bench/B10-import-replacement/fixtures/validate-rfc5321-email/arm-b-live-<date>.json` and a follow-up dry-run picks it up (per the §4.1 fixture-replacement discipline). **T-B-2 is operator-gated** — CI passes T-B-2 only if the captured live fixture has been committed; until then T-B-2 is dispatched explicitly by the operator after running `--live` once.

**T-RESOLVER-DELTA-1** — `node bench/B10-import-replacement/harness/run.mjs --dry-run --tasks validate-rfc5321-email` exits 0 and produces an artifact (written to either `test/smoke-fixture-<sha>.json` if `--smoke` or a `results-<platform>-<date>.json` if `--dry-run` only — see existing `defaultOutputPath` logic) where:
- `task_results[0].arm_a.transitive.reachable_files == 1`,
- `task_results[0].arm_a.transitive.unique_non_builtin_imports == 0`,
- `task_results[0].arm_b.reps[0].reachable_files >= 5` (validator's isEmail closure is multi-file),
- `task_results[0].arm_b.reps[0].unique_non_builtin_imports >= 1`,
- `task_results[0].classification.verdict == "PASS-DIRECTIONAL"`,
- `task_results[0].classification.reason` contains a percentage ≥ 90.0,
- the artifact's `reachable_bytes` numbers also satisfy ≥90% reduction.

**T-CLASSIFIER-1** — `classify-arm-b.mjs` returns `PASS-DIRECTIONAL` for the dry-run import-heavy task per §5.3 (the dry-run-PENDING short-circuit edit). Add a unit test under `bench/B10-import-replacement/test/classify-arm-b.test.mjs` that exercises both:
- the existing B9-corpus PENDING path (zero npm imports under dry-run → PENDING, unchanged behavior),
- the new import-heavy dry-run PASS-DIRECTIONAL path (validator-style fixture with ≥90% reduction → PASS-DIRECTIONAL).

**T-SMOKE-RUN-1** — `node bench/B10-import-replacement/harness/run.mjs --dry-run` (no `--tasks` flag, default = B10 corpus when non-empty per existing logic in `run.mjs` lines 144–151) loads the corpus-spec, finds the one task, runs it, and produces a result artifact. The B9 smoke corpus continues to work via explicit `--tasks parse-int-list,…` invocation (no regression of S1 smoke path).

### 6.2 Required real-path checks (must be run; output pasted in PR)

- `pnpm --dir bench/B10-import-replacement install` succeeds (adds `validator` to bench-local `node_modules`).
- `node --test bench/B10-import-replacement/test/measure-transitive-surface.test.mjs bench/B10-import-replacement/test/run.test.mjs bench/B10-import-replacement/test/classify-arm-b.test.mjs` — all green (S1's tests T1–T11 + S1's S1–S10 smoke + new T-CLASSIFIER-1 — none regressed).
- `node bench/B10-import-replacement/tasks/validate-rfc5321-email/arm-a/oracle.test.mjs` — green (T-A-3 oracle).
- `node bench/B10-import-replacement/harness/run.mjs --dry-run --tasks validate-rfc5321-email` exits 0, prints `verdict: PASS-DIRECTIONAL`, writes the dry-run artifact. Output pasted verbatim.
- **Full-workspace gates** (per durable memory `feedback_eval_contract_match_ci_checks.md` — these are non-negotiable):
  - `pnpm -w lint` — full-workspace green, output pasted verbatim.
  - `pnpm -w typecheck` — full-workspace green, output pasted verbatim.
  - These pass because the bench `.mjs` code is outside the typecheck/lint perimeter for `packages/**` (B10 is not in pnpm-workspace.yaml per parent C5), but the rest of the repo MUST continue to lint and typecheck cleanly. Package-scoped passing (`--filter @yakcc/<pkg>`) is necessary but not sufficient.
- The committed result artifact `bench/B10-import-replacement/results-<platform>-<date>.json` (live run, operator-produced) shows the headline numbers, with the reviewer's eyes-on review of the artifact body's transitive-surface delta and CVE count.

### 6.3 Required authority invariants (must hold)

- `bench/B9-min-surface/**` is byte-unchanged (S1 + S2 forbidden touch point per parent plan §3b SCOPE; triad plan P1 forbidden touch point).
- `packages/**` is byte-unchanged. **No production-code edit.** All Arm A reference `.mjs` files live under `bench/B10-import-replacement/tasks/**`, never in `packages/**`.
- The harness MUST NOT import or call the production registry as a library. The B-scope Arm A produced via fallback hand-translates the shaved isEmail subgraph; the production path (when wired) drives `yakcc compile` as a CLI/programmatic invocation that internally consumes the registry — it does not require the bench harness to embed the registry.
- `pnpm-workspace.yaml` is unchanged. `validator` is a **bench-local** dependency in `bench/B10-import-replacement/package.json`, NOT in the root `package.json`.
- `MASTER_PLAN.md` is unchanged. The triad plan §6 / parent plan §3b SCOPE forbidden touch point still applies.
- `corpus-spec.json` becomes non-empty with exactly one task (the import-heavy demo); the B9 smoke path still works via explicit `--tasks` invocation.
- The committed Arm A reference `.mjs` files carry zero non-builtin imports and (when the fallback was used) an inline `@decision DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001` annotation disclosing provenance.
- The locked Arm B prompt sha256 is committed in `corpus-spec.json::arm_b_prompt.prompt_sha256` (computed at first run); the harness verifies it on every subsequent run.
- The committed `spec.yak` is LF-normalized; its `spec_sha256_lf` is in `corpus-spec.json`; the harness verifies on every run.

### 6.4 Required integration points (must be wired)

- `bench/B10-import-replacement/harness/arm-a-emit.mjs::TASK_ENTRY_FUNCTIONS` adds `"validate-rfc5321-email": "validateRfc5321Email"`.
- `bench/B10-import-replacement/harness/run.mjs::INLINE_SPECS` adds an entry for `validate-rfc5321-email` (signature + behavior matching §2.2) so the harness can drive Arm B against this task without spec-loading machinery (note: a subsequent slice may wire spec loading from `corpus-spec.json` instead of an inline map — that is S3 work, not S2).
- `bench/B10-import-replacement/README.md` Slice Roadmap table updates: S2 row `status` becomes `landed` (dry-run + headline live capture) with a one-line summary referencing this plan and the committed live artifact.
- `bench/B10-import-replacement/package.json` `dependencies` adds `"validator": "^13.15.35"`.

### 6.5 Forbidden shortcuts (reviewer must reject if present)

- Committing the live `results-<platform>-<date>.json` artifact *without* having actually run the live API call (e.g. synthesizing the numbers from the dry-run). The reviewer verifies the committed `fixtures/validate-rfc5321-email/arm-b-live-<date>.json` is a real Anthropic API response with non-zero `usage.input_tokens` and `usage.output_tokens`.
- Hand-tuning the Arm A `.mjs` files to *artificially* reduce function counts (e.g. inlining everything into a single 2-line function that wouldn't pass T-A-3 in a real composition). The byte-equivalence oracle (T-A-3) enforces semantic correctness; the implementer cannot game the function count without breaking the oracle.
- Pretending the fallback (§3.3) is the production path. If the production `yakcc compile + #508 hook` path is not wired end-to-end, the implementer says so in the `DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001` annotation and files the follow-on issue (per §9 R-S2-1). Lying about provenance is a worse outcome than disclosing the fallback.
- Adding `validator` to the root `package.json` instead of the bench-local one (would couple `@yakcc/**` production packages to validator, which is structurally wrong — B-scope per WI-510 explicitly does not vendor npm packages into prod).
- Touching `bench/B9-min-surface/**` (forbidden by parent plan §3b SCOPE).
- Replacing the locked prompt with an "improved" version without re-locking the sha256 and updating `corpus-spec.json` — sha256 drift is a hard-abort by design (`DEC-V0-MIN-SURFACE-003` discipline). Prompt-locking is the central control variable for cross-bench comparability.
- Running CI on `--live` (would burn API budget on every PR). CI is `--dry-run` only.
- Using `cd <worktree>` in any command (per Sacred Practice 3; use `git -C` or subshell `(cd <path> && cmd)`).
- Cross-package relative imports in any source touched (per durable memory `feedback_no_cross_package_imports.md`) — but B10 is `.mjs` outside pnpm-workspace.yaml per parent C5, so this constraint is structural-only here. The implementer confirms in PR that no cross-package import was introduced.

### 6.6 Ready-for-guardian definition

All of the following must hold simultaneously on current HEAD, with output pasted in the PR body verbatim:

1. All Required tests (§6.1) exist and pass.
2. All Required real-path checks (§6.2) run, including full-workspace `pnpm -w lint` and `pnpm -w typecheck`.
3. All Required authority invariants (§6.3) verified (no `packages/**` diff; no `bench/B9-min-surface/**` diff; `pnpm-workspace.yaml` unchanged; `MASTER_PLAN.md` unchanged).
4. All Required integration points (§6.4) wired.
5. No forbidden shortcut (§6.5) present.
6. The dry-run `--tasks validate-rfc5321-email` smoke result is committed (either via the smoke-fixture mechanism or as a CI-published artifact captured in the PR description), showing `PASS-DIRECTIONAL` verdict with ≥90% reduction.
7. The headline live result artifact (`results-<platform>-<date>.json`) and the captured live fixture are committed (this is the operator-gated piece; the reviewer may declare the dry-run portion ready for guardian and the operator runs the live capture as the final step before merge).
8. The PR is opened against `main` (per durable memory `feedback_pr_not_guardian_merge.md` — hand off via PR, not Guardian merge into main).
9. `git fetch origin && git pull --ff-only origin main` was run immediately before `gh pr create` (per durable memory `feedback_fetch_before_pr.md`).

The reviewer may declare `ready_for_guardian` after items 1–6 + 8–9 pass, treating item 7 as an operator-gated follow-up that gates merge but not reviewer readiness. This split (reviewer-ready vs operator-gated landing) is consistent with parent plan §3b.3 landing policy.

---

## 7. Scope Manifest — Slice 2

### 7.1 Allowed files/directories (implementer may touch)

- `bench/B10-import-replacement/corpus-spec.json` — one task entry append.
- `bench/B10-import-replacement/tasks/validate-rfc5321-email/**` — entirely new directory:
  - `spec.yak`
  - `arm-a/fine.mjs`, `arm-a/medium.mjs`, `arm-a/coarse.mjs`
  - `arm-a/oracle.test.mjs` (the T-A-3 byte-equivalence oracle)
- `bench/B10-import-replacement/fixtures/validate-rfc5321-email/**` — entirely new directory:
  - `arm-b-response.json` (dry-run canonical answer)
  - `arm-b-live-<date>.json` (operator-captured live response; appended when live run executes)
- `bench/B10-import-replacement/results-<platform>-<date>.json` — operator-committed headline artifact.
- `bench/B10-import-replacement/harness/run.mjs` — only:
  - update `INLINE_SPECS` to add `validate-rfc5321-email`,
  - update the `@decision` block to add `DEC-BENCH-B10-SLICE2-COST-001` reference (the `COST_CAP_USD = 25` constant value is unchanged).
- `bench/B10-import-replacement/harness/arm-a-emit.mjs` — only: add the entry to `TASK_ENTRY_FUNCTIONS`.
- `bench/B10-import-replacement/harness/classify-arm-b.mjs` — only: the targeted ~10-line dry-run handling change per §5.3 + `DEC-BENCH-B10-SLICE2-CLASSIFIER-DRYRUN-001` `@decision` annotation.
- `bench/B10-import-replacement/test/classify-arm-b.test.mjs` — new file (T-CLASSIFIER-1).
- `bench/B10-import-replacement/package.json` — add `"validator": "^13.15.35"` to `dependencies`.
- `bench/B10-import-replacement/README.md` — update Slice Roadmap row + add a "Slice 2 demo task" subsection summarizing the validate-rfc5321-email task.
- `plans/wi-512-s2-b10-demo-task.md` — this file (implementer may append an `@decision` deviation note if implementation diverges from §3 per "Code is Truth").
- `plans/wi-512-b10-import-heavy-bench.md` — **status update only** to the Slice Map table row for S2 (e.g. mark "landed"); no edits to body sections.
- `tmp/wi-512-s2/**` — scratch artifacts (`tmp/` is the canonical scratchlane per Sacred Practice 3).

### 7.2 Required files/directories (must be created/modified)

- `bench/B10-import-replacement/corpus-spec.json` (must become non-empty with one task entry).
- `bench/B10-import-replacement/tasks/validate-rfc5321-email/spec.yak`.
- `bench/B10-import-replacement/tasks/validate-rfc5321-email/arm-a/fine.mjs`, `medium.mjs`, `coarse.mjs`, `oracle.test.mjs`.
- `bench/B10-import-replacement/fixtures/validate-rfc5321-email/arm-b-response.json`.
- `bench/B10-import-replacement/harness/arm-a-emit.mjs` (TASK_ENTRY_FUNCTIONS entry).
- `bench/B10-import-replacement/harness/run.mjs` (INLINE_SPECS entry + S2 cost-cap DEC reference).
- `bench/B10-import-replacement/harness/classify-arm-b.mjs` (dry-run handling change).
- `bench/B10-import-replacement/test/classify-arm-b.test.mjs` (new T-CLASSIFIER-1).
- `bench/B10-import-replacement/package.json` (validator dep).
- `bench/B10-import-replacement/README.md` (Slice Roadmap row + demo-task summary).

### 7.3 Forbidden touch points (must NOT change without re-approval)

- **`packages/**`** — no production-code changes (parent plan §3b SCOPE; triad plan P1 forbidden touch point).
- **`bench/B9-min-surface/**`** — read-only reference; B10 reads B9 fixtures via `loadB9Fixture()` for the B9 smoke corpus, never edits them.
- **`bench/B1-*`, `B4-*`, `B5-*`, `B6-*`, `B7-*`, `B8-*`, `v0-release-smoke/**`** — other benches untouched.
- **All WI-510 fixtures** under `packages/shave/src/__fixtures__/module-graph/**` — these belong to WI-510; B10 does not modify them. The Arm A fallback hand-translates from the *output* of `shavePackage(VALIDATOR_FIXTURE_ROOT)` (which is observable via the WI-510 S2 tests); it does not edit the vendored validator source.
- **`pnpm-workspace.yaml`** — B10 stays out of the workspace per parent C5.
- **`MASTER_PLAN.md`** — triad plan §6 defers the B10 MASTER_PLAN registration to a separate slice.
- **Root `package.json`** beyond the existing three `bench:import-replacement*` scripts (already landed in S1) — `validator` does NOT go here; the bench-local one is the only authority.

### 7.4 Expected state authorities touched

- **Runtime state authorities:** None. B10 is a measurement tool with no runtime state authority. The harness reads files; it does not write to `state.db` or `evaluation_state` or any cc-policy authority.
- **File-level state writes:** under `bench/B10-import-replacement/**` only — corpus-spec, tasks/, fixtures/, results-*.json, plus the harness/test/README edits enumerated in §7.1.
- **File-level state reads:** `bench/B9-min-surface/**` (B9 fixtures via `loadB9Fixture()` if the smoke path is exercised), `node_modules/**` under the bench-local install (the resolver traverses validator's closure), the Anthropic Messages API (live mode only).
- **Indirect production-code dependency:** the production `yakcc compile + #508 hook + #510 atoms` path is **invoked** (if the implementer uses the production path instead of the §3.3 fallback) but **not edited**. If the production path turns out to have a gap that blocks S2, the gap is filed as an issue against the owning component, not patched in-slice.

---

## 8. Decision Log — new DECs introduced by this plan

| DEC-ID | Decision | Rationale | Lands at |
|---|---|---|---|
| `DEC-BENCH-B10-SLICE2-DEMO-LIBRARY-001` | Demo library = `validator@13.15.35`, demo binding = `isEmail`, task id = `validate-rfc5321-email`. | OD-3 resolution per task prompt's pre-resolved default; smallest atom-shaped headline binding in WI-510; most-validated atom set; canonical demonstration string from triad plan §1; hand-verifiable closure. | `bench/B10-import-replacement/corpus-spec.json` (task entry) + `bench/B10-import-replacement/tasks/validate-rfc5321-email/spec.yak` header comment + this plan §2.1 |
| `DEC-BENCH-B10-SLICE2-COST-001` | Slice 2 cost cap = $25 USD. | OD-4 resolution; matches B4 `DEC-V0-B4-SLICE2-COST-CEILING-004` $25 reserve for B10 slot; matches S1's $25 (no change to constant value, only DEC annotation). | `bench/B10-import-replacement/harness/run.mjs` `@decision` block (append to existing) |
| `DEC-BENCH-B10-SLICE2-VALIDATOR-DEP-001` | `validator@^13.15.35` is a **bench-local** dependency of `bench/B10-import-replacement/package.json`, NOT a root or workspace dep. | Per parent C5 the bench is outside pnpm-workspace.yaml; per triad plan B-scope, validator must not be vendored into production. Resolver auto-resolves against the bench-local `node_modules`. | `bench/B10-import-replacement/package.json` notes block + this plan §4.1 |
| `DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001` | Arm A reference `.mjs` files are produced via the WI-510 `shavePackage()` + hand-translation fallback path when `yakcc compile + #508 hook + #510 atoms` end-to-end is not wired in the codebase at S2 implementation time. The fallback is byte-equivalent to the production-path output. The annotation discloses provenance per-file. | The production end-to-end CLI path (`yakcc compile` CLI consuming a WI-510-seeded registry) is not exercised by any test today (see §3.3 verification); requiring it to work end-to-end before S2 can land couples this slice to integration work that does not belong here. B9 set the same precedent with hand-authored arm-a/*.mjs references. The fallback is honest, reviewer-verifiable, and disclosable. | Each Arm A `.mjs` header comment if fallback was used + this plan §3.3 + a follow-on issue if exercised |
| `DEC-BENCH-B10-SLICE2-CLASSIFIER-DRYRUN-001` | Dry-run mode is allowed to return PASS-DIRECTIONAL / WARN-DIRECTIONAL when the canned fixture represents the canonical natural answer for an import-heavy task; PENDING is reserved for cases where Arm B median `reachable_functions == 0` (i.e. no import surface to measure, e.g. the B9 smoke corpus). | S1's unconditional `dryRun → PENDING` short-circuit was correct for the B9 smoke corpus (zero-import tasks) but blocks S2's headline reading on the import-heavy dry-run path. The narrower invariant (PENDING only when there's nothing to measure) preserves the B9 behavior and unblocks S2. | `bench/B10-import-replacement/harness/classify-arm-b.mjs` `@decision` block + `bench/B10-import-replacement/test/classify-arm-b.test.mjs` |

DECs cited (not introduced) by this plan: `DEC-IRT-B10-METRIC-001`, `DEC-B10-S1-LAYOUT-001`, `DEC-BENCH-B10-SLICE1-COST-001`, `DEC-B10-ARM-A-S1-001`, `DEC-B10-LLM-BASELINE-001`, `DEC-B10-CLASSIFY-ARM-B-001`, `DEC-V0-MIN-SURFACE-003`, `DEC-V0-MIN-SURFACE-004`, `DEC-BENCH-B7-CORPUS-CANONICAL-LF-001`, `DEC-WI510-S2-PER-ENTRY-SHAVE-001`, `DEC-WI510-S2-PATH-A-CONFIRMED-001`, `DEC-WI508-IMPORT-GATE-001`, `DEC-HOOK-PHASE-3-001`, `DEC-V0-B4-SLICE2-COST-CEILING-004`.

---

## 9. Risks

| ID | Risk | Likelihood | Mitigation |
|---|---|---|---|
| **R-S2-1** | `yakcc compile + #508 hook + #510 atoms` end-to-end CLI path is not wired at S2 implementation time (no test today drives it end-to-end against a WI-510-seeded registry). | **High** (no end-to-end test exists today). | Fallback to §3.3 hand-translated Arm A `.mjs` with `DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001` disclosure annotation. File a follow-on issue: "wire `yakcc compile` end-to-end against a WI-510-seeded registry; emit B10 Arm A via the production CLI path." This is the same precedent B9 set with hand-authored arm-a/*.mjs references. The headline reading is correct either way; only provenance changes. |
| **R-S2-2** | Live API cost spike (model error, retry loop, prompt explosion). | Low (N=3 reps × ~$0.01 = ~$0.03 per task; the cap is structural). | Hard-bounded by `DEC-BENCH-B10-SLICE2-COST-001` $25 cap. `BudgetExceededError` is thrown before each API call. Operator triggers the live run manually; not on CI. |
| **R-S2-3** | The transitive-reachability resolver may surface a bug when traversing the real `validator` package (e.g. mishandling validator's `package.json#exports` map or its CommonJS interop). | Medium (S1 tested the resolver against synthetic fixtures; real npm packages have edge cases synthetic fixtures don't capture). | If a bug is minor (~30-line fix in `measure-transitive-surface.mjs`), fix in S2 with a regression test added under `bench/B10-import-replacement/test/measure-transitive-surface.fixtures/` matching the validator-specific edge case. If it's structural (resolver design issue), file an engine-gap issue per the S8 zod precedent (triad plan §3 `engine-reality` honesty) and either (a) ship S2 with the engine gap documented and the headline number qualified, or (b) defer S2 until the engine bug is fixed — operator-decidable based on severity. |
| **R-S2-4** | The dry-run fixture's canonical natural answer differs from what the live API actually emits, causing T-CLASSIFIER-1 PASS in dry-run but PEND/WARN/FAIL in live. | Low (the fixture is the canonical natural answer; any reasonable LLM answer for this prompt produces a `validator` import). | The live capture (per §4.1) **replaces** the dry-run fixture with the captured response and re-locks. The dry-run and live results converge by construction after one live run. If the live capture exposes a meaningfully different solution structure (e.g. the LLM rolls a regex instead of importing validator), that is a corpus-design finding the operator addresses by re-locking the prompt or accepting the new natural answer. |
| **R-S2-5** | Adding `validator` to `bench/B10-import-replacement/package.json` dependencies may be incompatible with the sandbox / install environment (some CI runners restrict bench-local installs). | Low (S1 already installs `@anthropic-ai/sdk`, `ts-morph`, `fast-check` bench-local; precedent is established). | If blocked, fall back to §4.1 Option (ii) (resolver `--node-modules` flag pointing at a different layout) with an in-line `@decision` annotation explaining the environment constraint. |
| **R-S2-6** | The classifier dry-run handling edit (`DEC-BENCH-B10-SLICE2-CLASSIFIER-DRYRUN-001`) might regress the B9 smoke path's PENDING verdict if implemented carelessly. | Low (the change is targeted and the new unit test T-CLASSIFIER-1 covers both paths). | The T-CLASSIFIER-1 unit test asserts both PASS-DIRECTIONAL on the import-heavy dry-run AND PENDING on the zero-import dry-run, so any regression is caught at test time. |

---

## 10. Ready-for-Guardian definition (concrete simultaneous truth conditions on current HEAD)

S2 is `ready_for_guardian` iff all of the following hold simultaneously on the worktree's current HEAD with output pasted verbatim in the PR body:

1. `corpus-spec.json` has exactly one task entry (`validate-rfc5321-email`) with `spec_sha256_lf` and `arm_b_prompt.prompt_sha256` populated.
2. `tasks/validate-rfc5321-email/spec.yak` exists, is LF-normalized, and its sha256 matches `corpus-spec.json`.
3. `tasks/validate-rfc5321-email/arm-a/{fine,medium,coarse}.mjs` exist, each with zero non-builtin imports, each producing `reachable_files == 1` per `measure-transitive-surface.mjs`, each exporting `validateRfc5321Email`, and each (if fallback) carrying `DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001`.
4. `tasks/validate-rfc5321-email/arm-a/oracle.test.mjs` passes with ≥20 fast-check inputs proving boolean-equivalence with `validator.isEmail` defaults.
5. `fixtures/validate-rfc5321-email/arm-b-response.json` exists with a `validator`-importing canonical solution in the `\`\`\`typescript` fence.
6. `harness/arm-a-emit.mjs::TASK_ENTRY_FUNCTIONS` carries the new task entry.
7. `harness/run.mjs::INLINE_SPECS` carries the new task entry; the cost-cap `@decision` block references `DEC-BENCH-B10-SLICE2-COST-001`.
8. `harness/classify-arm-b.mjs` implements the §5.3 dry-run handling per `DEC-BENCH-B10-SLICE2-CLASSIFIER-DRYRUN-001`.
9. `test/classify-arm-b.test.mjs` exists and passes both PENDING-on-zero-imports and PASS-DIRECTIONAL-on-import-heavy assertions.
10. `package.json` includes `"validator": "^13.15.35"` in `dependencies`.
11. `README.md`'s Slice Roadmap row for S2 is updated.
12. `node --test bench/B10-import-replacement/test/*.test.mjs` is all green (S1 T1–T11 + S1–S10 smoke unchanged + new T-CLASSIFIER-1) — output pasted.
13. `node bench/B10-import-replacement/harness/run.mjs --dry-run --tasks validate-rfc5321-email` exits 0 with `verdict: PASS-DIRECTIONAL`, ≥90% reduction on both `reachable_functions` and `reachable_bytes` — output pasted.
14. `pnpm -w lint` green, full output pasted verbatim.
15. `pnpm -w typecheck` green, full output pasted verbatim.
16. `packages/**` diff is empty (`git diff main -- packages/` shows nothing).
17. `bench/B9-min-surface/**` diff is empty.
18. `pnpm-workspace.yaml` diff is empty; `MASTER_PLAN.md` diff is empty.
19. No forbidden-shortcut per §6.5 is present.
20. (Operator-gated step, after items 1–19) The live run produced `bench/B10-import-replacement/results-<platform>-<date>.json` and `bench/B10-import-replacement/fixtures/validate-rfc5321-email/arm-b-live-<date>.json` both committed; the captured live response has non-zero `usage.input_tokens` and `usage.output_tokens`; the headline reading meets `reduction ≥ 0.90` on both axes.

Reviewer may declare readiness for guardian after items 1–19 are satisfied; item 20 gates the merge but is the operator's responsibility (one explicit `--live` invocation; cost-bounded by `DEC-BENCH-B10-SLICE2-COST-001`).

---

## 11. Drafted PR body (skeleton for the implementer)

```markdown
## WI-512 Slice 2 — B10 import-heavy bench: first import-heavy task + first real reading (validate-rfc5321-email)

Closes part of #512 (Slice 2 of 3). Builds on PR #521 (S1 harness, `950afdc`). Triad plan §1 desired-end-state artifact achieved.

### Summary

- New import-heavy demo task `validate-rfc5321-email` in `bench/B10-import-replacement/tasks/`.
- Dry-run Arm B fixture committed under `fixtures/validate-rfc5321-email/arm-b-response.json` (canonical `import { isEmail } from 'validator'` solution).
- Three Arm A reference granularity strategies committed (fine/medium/coarse), each producing zero non-builtin imports.
- Byte-equivalence oracle (≥20 fast-check inputs against `validator.isEmail` defaults) passes.
- Classifier dry-run handling refined per `DEC-BENCH-B10-SLICE2-CLASSIFIER-DRYRUN-001`: PENDING reserved for zero-import tasks; import-heavy dry-run reports PASS-DIRECTIONAL when the threshold is met.
- `validator` added as a **bench-local** dependency (NOT in root `package.json` or pnpm-workspace — per parent plan C5 and `DEC-BENCH-B10-SLICE2-VALIDATOR-DEP-001`).
- Headline live run committed: `results-<platform>-<date>.json` + captured live fixture.

### Operator-decision resolutions

- **OD-3** demo library: `validator` / isEmail per `DEC-BENCH-B10-SLICE2-DEMO-LIBRARY-001`.
- **OD-4** Slice 2 cost cap: $25 per `DEC-BENCH-B10-SLICE2-COST-001` (matches B4 reserve; unchanged from S1 constant value).

### Arm A provenance

[ ] Production path (`yakcc compile + #508 hook + #510 atoms`) — N/A end-to-end CLI path not yet wired.
[X] Fallback path (`shavePackage` + hand-translation) per `DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001`. Follow-on issue filed: <link>.

### Headline reading (live run)

| Arm | reachable_functions | reachable_bytes | reachable_files | unique_non_builtin_imports |
|---|---|---|---|---|
| Arm A (yakcc) | <fill in> | <fill in> | 1 | 0 |
| Arm B (validator) | <fill in> | <fill in> | <fill in> | 1 |
| **Reduction** | **<fill in>%** | **<fill in>%** | — | — |

Both ≥90% — value-prop demonstrated for one task / one library.

### Evidence

#### Tests

```
$ node --test bench/B10-import-replacement/test/*.test.mjs
<paste verbatim output — should include T1–T11 + S1–S10 + T-CLASSIFIER-1 all green>
```

#### Dry-run smoke

```
$ node bench/B10-import-replacement/harness/run.mjs --dry-run --tasks validate-rfc5321-email
<paste verbatim output ending with `verdict: PASS-DIRECTIONAL`>
```

#### Oracle

```
$ node bench/B10-import-replacement/tasks/validate-rfc5321-email/arm-a/oracle.test.mjs
<paste verbatim output>
```

#### Full-workspace gates (per durable memory `feedback_eval_contract_match_ci_checks.md`)

```
$ pnpm -w lint
<paste verbatim output — full workspace green>

$ pnpm -w typecheck
<paste verbatim output — full workspace green>
```

#### Authority invariants

```
$ git diff main -- packages/                   # empty
$ git diff main -- bench/B9-min-surface/       # empty
$ git diff main -- pnpm-workspace.yaml         # empty
$ git diff main -- MASTER_PLAN.md              # empty
```

### Plan

`plans/wi-512-s2-b10-demo-task.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Internal Quality Gate (self-check before emitting trailer)

- ✅ Dependencies & state mapped: §2 deps on WI-510 S2 / #508 components / S1 harness; §3.2/§3.3 production vs fallback path explicit; §7.4 file-level state authorities enumerated.
- ✅ Every guardian-bound work item has an Evaluation Contract with *executable* acceptance criteria: §6.1 has 8 named tests (T-CORPUS-1 + T-A-1/2/3 + T-B-1/2 + T-RESOLVER-DELTA-1 + T-CLASSIFIER-1 + T-SMOKE-RUN-1); §6.2 has 6 real-path checks; §6.6 has 9 concurrent ready conditions; §10 has 20 concurrent truth conditions for guardian readiness.
- ✅ Every guardian-bound work item has a Scope Manifest with explicit file boundaries: §7 enumerates allowed (15+ specific paths), required (10+ specific paths), forbidden (7+ specific glob patterns).
- ✅ No work item relies on narrative completion language: each test names a verifiable invariant or pasted-output requirement; §10 names byte-level / numeric truth conditions; §6.5 names specific forbidden shortcuts with reviewer detection criteria.
- ✅ Eval Contract uses **full-workspace** lint+typecheck (per durable memory): §6.2 says `pnpm -w lint` and `pnpm -w typecheck`, full output pasted — explicitly NOT `--filter <pkg>` scoped.
- ✅ Land via PR (per durable memory): §6.6 item 8 and §11 PR-body skeleton.
- ✅ Fetch+pull before PR (per durable memory): §6.6 item 9.
- ✅ Operator-decision boundary surfaced ONLY where genuinely needed: the live Anthropic API run (§6.6 item 7, §10 item 20) — and that boundary is the only one. OD-3 and OD-4 are pre-resolved with documented defaults; no questions back to the user.

---

## Cross-references

- **Parent slice plan:** `plans/wi-512-b10-import-heavy-bench.md` (§3b.1 — "S2 = triad P2c").
- **Triad coordination plan:** `plans/import-replacement-triad.md` (§1 desired-end-state artifact; §4 #512 Slice 2; §5 OD-3/OD-4).
- **S1 landed harness:** `bench/B10-import-replacement/harness/{run.mjs,measure-transitive-surface.mjs,arm-a-emit.mjs,llm-baseline.mjs,classify-arm-b.mjs,measure-axis1.mjs}`; `bench/B10-import-replacement/{corpus-spec.json,package.json,README.md}`; `bench/B10-import-replacement/test/*.test.mjs`. Merged via PR #521 (`950afdc`).
- **WI-510 S2 demo binding source:** `packages/shave/src/universalize/validator-headline-bindings.test.ts` (the canonical `isEmail` shave + persist path).
- **WI-510 corpus entry:** `packages/registry/test/discovery-benchmark/corpus.json` `cat1-validator-is-email-001` etc.
- **#508 components consumed:** `packages/hooks-base/src/import-intercept.ts`, `packages/hooks-base/src/import-classifier.ts`, `packages/compile/src/import-gate.ts` (`GATE_INTERCEPT_ALLOWLIST` includes `"validator"`), `packages/cli/src/commands/compile.ts`.
- **B9 structural template:** `bench/B9-min-surface/tasks/parse-coord-pair/{spec.yak,arm-a/{fine,medium,coarse}.mjs}` for shape; `bench/B9-min-surface/fixtures/parse-int-list/arm-b-response.json` for the Anthropic-response fixture shape.
- **Vendored validator fixture (read-only):** `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/` — the source the Arm A fallback hand-translates from.
- **Bench-discipline DECs reused:** `DEC-V0-MIN-SURFACE-003` (locked Arm B prompt + sha256), `DEC-V0-MIN-SURFACE-004` (granularity sweep), `DEC-BENCH-B7-CORPUS-CANONICAL-LF-001` (LF-normalized sha256), `DEC-V0-B4-SLICE2-COST-CEILING-004` (B4 $150 suite cap incl. $25 B10 reserve).

*End of plan.*
