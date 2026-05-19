# WI 682-license-gate-remove — Remove shave license gate per operator DEC

**Workflow ID:** `682-license-gate-remove`
**Branch:** `feature/682-license-gate-remove`
**Worktree:** `c:/src/yakcc/.worktrees/feature-682-license-gate-remove`
**Branch base:** `main @ 8ce865e`
**Closes:** #682
**Initiative:** shave-policy-simplification (new; first WI)
**Supersedes:** `DEC-LICENSE-GATE-001`, `DEC-LICENSE-WIRING-002` (#642-adjacent bench unblock at `bench/B4-tokens-v3/harness/atom-sync.mjs` `ensureSpdxHeader`)

---

## 1. Problem (verbatim operator DEC, 2026-05-17)

> Let's get rid of the license checks entirely we are not copying code, we are reimplementing behavior so we don't need to stop on copy left, and def not on no license

## 2. Product framing

yakcc's product story is **behavioral reimplementation**, not source redistribution. Atoms in the registry are content-addressed derivations of *behavior* (`canonical_ast_hash` + `IntentCard` + sliced glue), not byte-for-byte copies of source. Ingest-side copyleft / missing-license refusal is misapplied defense-in-depth — it does not protect against any real risk yakcc faces, and it adds friction to every consumer that has to monkey-prepend SPDX to dodge it.

Today the gate is already vestigial in production: `packages/hooks-base/src/atomize.ts:347-353` auto-prepends `// SPDX-License-Identifier: MIT` when absent so that `licenseGate` accepts the source unconditionally. The gate only fires for paths that *bypass* that auto-prepend — most recently the B4-v3 bench harness, which received a `ensureSpdxHeader` workaround on 2026-05-17 explicitly as a stopgap pending this WI.

## 3. Root cause analysis

There is no defect to "fix" here. The license gate is policy code that is no longer aligned with the product. The remediation is **subtractive**: delete the gate, delete every consumer reference, and delete every test/fixture that exists only to exercise the gate.

The gate's wire-points and surface area are:

| Layer | File(s) | Behavior |
|---|---|---|
| Gate module | `packages/shave/src/license/{gate,detector,types,*.props,*.props.test,*.test}.ts` | Detects SPDX identifiers in source; refuses copyleft prefixes (GPL/AGPL/LGPL/BUSL) and proprietary; refuses unidentifiable. |
| `universalize()` step 1 | `packages/shave/src/index.ts:467-474` | Calls `licenseGate(detectLicense(source))`; throws `LicenseRefusedError` on refusal. |
| Error class | `packages/shave/src/errors.ts:61-77` | `LicenseRefusedError extends Error`; carries `LicenseDetection`. |
| Production hook | `packages/hooks-base/src/atomize.ts:347-368` | Auto-prepends MIT SPDX when absent, then runs `licenseGate` again as a pre-check before `universalize()`. |
| Bench workaround | `bench/B4-tokens-v3/harness/atom-sync.mjs:36-42, 62` | `ensureSpdxHeader()` prepends MIT to dodge the gate; introduced 2026-05-17 explicitly as a stopgap. |
| Public surface tests | `packages/shave/src/shave-pipeline.test.ts:30-35`, `packages/shave/src/errors.props.ts:226-285`, `packages/shave/src/errors.props.test.ts:34-44` | Assert error class shape + that `shave()` throws on GPL source. |
| Compile integration tests | `packages/compile/src/assemble-candidate.{ts:204-205,27-28},test.ts:215-258` | Doc-comment promises "license gate guarantees only permissive sources reach the resolver path"; two tests (`describe("assembleCandidate — license-refused candidate", …)`) assert `LicenseRefusedError` propagates unwrapped and no rows are written. |
| Bootstrap integration | `packages/cli/src/commands/bootstrap.ts:86-107`, `packages/cli/src/bootstrap.test.ts:509-720` | `ExpectedFailureEntry.errorClass` schema explicitly cites `"LicenseRefusedError"` as the canonical case; tests assert bootstrap reclassifies it as expected-failure (exit 0). |
| Expected-failures data | `bootstrap/expected-failures.json` | One entry pinning the GPL fixture. |
| GPL fixture | `examples/v0.7-mri-demo/src/gpl-fixture.ts` | The whole-file purpose is to exercise the gate. |
| MRI demo acceptance | `examples/v0.7-mri-demo/test/acceptance.test.ts:16-23, 36-78, 156-179`, `examples/v0.7-mri-demo/README.md:38, 44-58` | Test A is wholly "license refusal"; Test C asserts `detectLicense`/`licenseGate`/`LicenseRefusedError` are exported. |
| Federation demo acceptance | `examples/v1-federation-demo/test/acceptance.test.ts:54, 656-720` (`describe("demo: GPL-prepared input is refused at registryA's shave path; registryB never sees the refused source")`) | One whole `describe()` block proves "refused source does not propagate via federation"; relies on the gate to fire. |
| Audit script | `scripts/audit-property-tests.mjs:1067-1070, 1262-1269` | Markdown summary templating special-cases `LicenseRefusedError` as "expected (GPL fixture)". |
| ADR | `docs/archive/developer/adr/hook-layer-architecture.md:261` | One bullet `→ detectLicense + licenseGate (accept/refuse)`. |
| DESIGN.md | `DESIGN.md:238-242, 556-559` | Two paragraphs describing the gate's policy. |
| README (shave package) | `packages/shave/README.md:10-12, 36, 56-60, 87, 147-151` | Pipeline-stages bullet, API table, error table, plus a whole "License gate locality" section. |
| MASTER_PLAN.md | `MASTER_PLAN.md:1147, 1155, 1171, 1220, 1328-1337, 1386, 2210, 2273-2311, 2384-2418` | Plan-history milestones + Decision Log + v0.7 WI descriptions. Historical record — kept, with a forward-pointer to the supersession DEC. |
| Historical plan | `docs/plans/wi-373-universalize-persist.md:83, 168, 225-230` | Already in `docs/plans/`; frozen historical artifact. Do NOT edit. |
| Frozen demo state | `examples/v1-wave-3-wasm-lower-demo/test/{shave-cache,pending-atoms-as}.json` | JSON test fixtures containing historical `licenseGate` token strings. Do NOT edit. |

The brief enumerated ~12 of these touch-points; the full list (above) is 18 touch-points. Several were missed in the brief and must not be skipped — most importantly the `@yakcc/compile` `assemble-candidate.{ts,test.ts}` doc-comment + tests, the bootstrap `expected-failures` schema and tests, and the federation-demo `describe()` block.

## 4. Acceptance plan (file-by-file)

The implementer must do every action below. Each entry is a discrete, mechanically-verifiable mutation.

### 4.1 Gate module — delete entirely

- **DELETE** `packages/shave/src/license/` directory and every file under it:
  - `gate.ts`
  - `gate.test.ts`
  - `gate.props.ts`
  - `gate.props.test.ts`
  - `detector.ts`
  - `detector.props.ts`
  - `detector.props.test.ts`
  - `detector.test.ts`
  - `wire.test.ts`
  - `types.ts`
  - `types.props.ts`
  - `types.props.test.ts`

After the delete, `ls packages/shave/src/license/` must report "No such file or directory" or empty.

### 4.2 `packages/shave/src/index.ts`

- Remove the re-export block at L286-296:
  - `export { detectLicense } from "./license/detector.js";`
  - `export { licenseGate } from "./license/gate.js";`
  - `export type { AcceptedLicense, LicenseDetection, LicenseGateResult } from "./license/types.js";`
- Remove the import block at L379-380:
  - `import { detectLicense } from "./license/detector.js";`
  - `import { licenseGate } from "./license/gate.js";`
- Remove the `universalize()` gate block at L467-474 (Step 1):
  - The four lines that compute `detection`, run `licenseGate`, and `throw new LicenseRefusedError(...)`.
- Update doc-comment at L420-450 to delete every mention of license-gate / `LicenseRefusedError` / `DEC-LICENSE-WIRING-002`. Add a short forward-pointer to the new supersession DEC (`DEC-LICENSE-GATE-REMOVE-001`).
- Renumber pipeline steps if the existing comments call out "Step 1 / Step 2" (extract intent is now step 1, etc.).

### 4.3 `packages/shave/src/errors.ts`

- Remove the `import type { LicenseDetection } from "./license/types.js";` at L61.
- Remove the `export class LicenseRefusedError` block (L62-77) entirely.
- Remove the "WI-013-02: LicenseRefusedError added as the fourth error class" sentence from the file-level header comment (L11-12).

### 4.4 `packages/shave/src/shave-pipeline.test.ts`

- Remove `LicenseRefusedError` from the `from "./index.js"` import (L6).
- Delete the test `it("throws LicenseRefusedError for GPL-licensed source before reaching Anthropic", …)` (L30-35).

### 4.5 `packages/shave/src/errors.props.ts`

- Delete the `LicenseRefusedError` import at L34 (keep the other three imports).
- Delete the `import type { LicenseDetection } from "./license/types.js";` at L37.
- Delete the three `prop_LicenseRefusedError_*` exports (L213-285):
  - `prop_LicenseRefusedError_message_contains_reason`
  - `prop_LicenseRefusedError_detection_field_matches_arg`
  - `prop_LicenseRefusedError_name_and_instanceof`
- Delete the `licenseDetectionArb` arbitrary if it is used **only** by the LR1.1 props (verify with rg before deleting).
- Update the file-level header comment (L11-23) to remove the LR1.1 lines (drop from "LR1.1 — …" through the matching "LR1.1" property summary line).

### 4.6 `packages/shave/src/errors.props.test.ts`

- Delete the three `it("property: LicenseRefusedError — …", …)` blocks (L34-44).

### 4.7 `packages/hooks-base/src/atomize.ts`

- Delete the SPDX header injection block (L347-353):
  - The `hasSpdx` check.
  - The `codeForShave` const.
- Update the `await import("@yakcc/shave")` destructure (L360-361) to drop `detectLicense`, `licenseGate`, `LicenseRefusedError` — keep `universalize` and `DidNotReachAtomError`.
- Delete the "License pre-check" block (L363-368) entirely.
- Replace `codeForShave` with `emittedCode` at every subsequent call site (the variable rename — verify with rg).
- Update the `@decision DEC-HOOK-ATOM-CAPTURE-001` annotation block to record the supersession: append a "Superseded by `DEC-LICENSE-GATE-REMOVE-001` (#682, 2026-05-17): license-default-MIT injection no longer needed because shave no longer gates on license." note.

### 4.8 `bench/B4-tokens-v3/harness/atom-sync.mjs`

- Delete the `readFileSync, writeFileSync` from the `node:fs` import at L28 — keep `mkdirSync`.
- Delete the `ensureSpdxHeader()` function (L31-42) entirely (including its comment block).
- Delete the `ensureSpdxHeader(implFile);` call at L62 and the immediately-preceding comment at L61.

### 4.9 `packages/compile/src/assemble-candidate.ts`

- Update the file-level doc-comment (L25-28) to delete the "license gate in `universalize()` guarantees only permissive sources reach the resolver path; `LicenseRefusedError` propagates unwrapped to the caller" lines.
- Update the `assembleCandidate()` JSDoc (L201-205) to delete the `@throws LicenseRefusedError` line. Renumber subsequent `@throws` if there is a list ordering.

### 4.10 `packages/compile/src/assemble-candidate.test.ts`

- Delete the `LicenseRefusedError` from the `from "@yakcc/shave"` import (L66).
- Delete the whole `describe("assembleCandidate — license-refused candidate", …)` block (L215-258). This removes Test 1 (`LicenseRefusedError propagates`) and the T3 ("license-refused source — no rows written") test. T3 covers a behavior (no row written on refusal) that simply no longer exists; deleting it is correct.
- Renumber subsequent test comment-headers (`Test 2`, `Test 3`, …) if they exist.

### 4.11 `packages/cli/src/commands/bootstrap.ts`

- Update the `@decision DEC-V2-BOOT-EXPECTED-FAILURES-001` block (L86-107):
  - Replace the `LicenseRefusedError` example with a more general framing — the schema still exists and is still useful for other intentional-failure cases (e.g., a deliberately malformed fixture).
  - Update the docstring on `ExpectedFailureEntry.errorClass` (L105) — remove the `"LicenseRefusedError"` example; replace with a neutral example (e.g., `"DidNotReachAtomError"`).
  - **Do not** remove the `expected-failures.json` mechanism itself — it is general-purpose infrastructure for any intentional-failure case the bootstrap encounters. Only remove the `LicenseRefusedError` framing.

### 4.12 `packages/cli/src/bootstrap.test.ts`

- Delete the test `it("reclassifies a LicenseRefusedError failure as expected-failure and exits 0", …)` (around L509-700). This test's whole purpose was to demonstrate the `LicenseRefusedError`-reclassification path. With the gate gone, the fixture cannot trigger that error.
  - If the test scaffolding (`makeFixtureProject`, `makeExpectedFailuresFile`) is used by other tests, leave the helpers in place.
- Delete or update the test `it("…", …)` that references `LicenseRefusedError` in `errorClass: "LicenseRefusedError"` (around L706-712 in the `ef-untriggered.json` fixture). Replace the fixture entry with a different `errorClass` string that genuinely cannot fire in the mini-project — keeping the "untriggered expected-failure" test alive but un-coupled from the (removed) gate.

### 4.13 `bootstrap/expected-failures.json`

- Delete the GPL-fixture entry (lines 4-8). If that was the only entry, the `entries` array becomes `[]`.
- The schema and the empty file remain valid (the consumer in `bootstrap.ts` handles an empty entries list).

### 4.14 `examples/v0.7-mri-demo/src/gpl-fixture.ts`

- **DELETE** the file. Its sole purpose was to exercise the (now-removed) gate.
- Verify nothing else imports it (`rg "gpl-fixture"` outside `examples/v1-wave-3-wasm-lower-demo/test/*.json` frozen fixtures and `docs/plans/wi-373-…md` historical plan).

### 4.15 `examples/v0.7-mri-demo/test/acceptance.test.ts`

- Remove `LicenseRefusedError`, `detectLicense`, `licenseGate` from the `from "@yakcc/shave"` import (L16-23). Keep `AnthropicApiKeyMissingError`, `shave`, `universalize`.
- Delete the whole `describe("Test A: license refusal", …)` block (L41-78).
- Delete the three Test C `it()` blocks that exercise the gate exports (L156-179):
  - `it("LicenseRefusedError is a class", …)`
  - `it("detectLicense is a function", …)`
  - `it("licenseGate is a function", …)`
- Update the file-level header comment (L7) to drop the "Test A — License refusal" line. Renumber if appropriate ("Test A" becomes the previous Test B, etc., OR leave gaps and rename the remaining tests for clarity — implementer's call).

### 4.16 `examples/v0.7-mri-demo/README.md`

- Update the pipeline-stages description (L4): drop "license gate → " so it reads "the universalize pipeline (intent extraction → decompose → slice) end-to-end".
- Update the v0.7 acceptance criteria table (L36-46) — delete row (d) entirely ("GPL-prepared input refused with clear error"). Adjust the table header/numbering as needed.
- Delete the "Test A — License refusal" paragraph (L44-46).
- Update the "Test B" paragraph (L48-53) — remove the "proving the pipeline passed the license gate" framing.
- Update the "Test C" paragraph (L55-58) — drop `LicenseRefusedError`, `detectLicense`, `licenseGate` from the listed public-surface symbols.

### 4.17 `examples/v1-federation-demo/test/acceptance.test.ts`

- Remove `LicenseRefusedError` from the `from "@yakcc/shave"` import (L54). Keep `shave as shaveImpl`.
- Delete the whole `describe("demo: GPL-prepared input is refused at registryA's shave path; …", …)` block (L657-720). This removes the entire GPL-refusal demo from the federation acceptance suite.
- Update the file-level header comment (L33) — drop the "GPL-fixture shave produces a typed `LicenseRefusedError`" bullet from the federation-properties summary.

### 4.18 `scripts/audit-property-tests.mjs`

- Update L1067-1070 template literal: replace the `f.error_class === "LicenseRefusedError" ? "expected (GPL fixture)" : "**UNEXPECTED — file backlog issue**"` ternary with `"**UNEXPECTED — file backlog issue**"` unconditionally. No expected-failure case is `LicenseRefusedError` anymore.
- Update L1262-1269 similarly.
- Update the trailing line at L1269 — remove `(gpl-fixture.ts LicenseRefusedError)` reference.

### 4.19 `packages/shave/README.md`

- Update the pipeline-stages bullet (L8-12) — drop step 1 ("License gate"), renumber.
- Update the public API table (L34-37) — strip the "license gate → " phrasing from the `universalize()` description.
- Delete the "Public API — License gate" sub-section (L52-60) entirely.
- Delete the `LicenseRefusedError` row from the error-classes table (L87).
- Delete the "License gate locality" section (L147-151+).

### 4.20 `docs/archive/developer/adr/hook-layer-architecture.md`

- Update L259-263: delete the `→ detectLicense + licenseGate (accept/refuse)` line under the `shave.universalize` step.

### 4.21 `DESIGN.md`

- Update L238-242: rewrite the paragraph that describes "permissive licenses are accepted at the ingestion boundary … copyleft and proprietary licenses are refused with a clear error" to describe the new posture: yakcc reimplements behavior; license-of-origin is not gated at ingestion. Upstream license is still recorded as metadata if the source declares one. A short forward-pointer to `DEC-LICENSE-GATE-REMOVE-001` belongs at the end of the paragraph.
- Update L556-559: similar rewrite — delete the "Accepted: Unlicense, MIT, BSD-…  Refused with a clear error: GPL/AGPL/LGPL/copyleft, proprietary, unidentifiable." policy statement and replace with the new framing (or remove the paragraph if it loses coherence).

### 4.22 `MASTER_PLAN.md`

- Append the new initiative section under `## Active Initiatives` (full text in §6 below).
- Append the new `DEC-LICENSE-GATE-REMOVE-001` row under `## Decision Log` (full text in §6 below).
- Do **not** delete or edit any pre-existing license-gate references in plan-history milestones or older DEC rows — those are historical record. The new DEC supersedes them by reference.

### 4.23 New regression-net test — `packages/shave/src/universalize-no-license-gate.test.ts` (new file)

A minimal test that asserts `universalize()` accepts SPDX-free source without throwing. Skeleton:

```ts
// SPDX-License-Identifier: MIT
// Regression net for WI 682-license-gate-remove (DEC-LICENSE-GATE-REMOVE-001):
// universalize() must NOT gate on license. If a future change re-introduces any
// SPDX/copyleft refusal in the ingestion path, this test fails first.

import { describe, expect, it } from "vitest";
import { universalize } from "./index.js";
import type { ShaveRegistryView } from "./types.js";

const mockRegistry: ShaveRegistryView = {
  findByCanonicalAstHash: async () => undefined,
};

describe("universalize() — license-gate-removed (DEC-LICENSE-GATE-REMOVE-001)", () => {
  it("accepts SPDX-free source without throwing a license-related error", async () => {
    const source = `export function foo(n: number): number { return n + 1; }`;
    // intentStrategy: "static" keeps the test offline / no-API-key.
    // Must not throw any *License*Error class; CanonicalAstParseError / etc.
    // would be a separate (unrelated) failure mode.
    await expect(
      universalize({ source }, mockRegistry, { intentStrategy: "static" }),
    ).resolves.toBeDefined();
  });

  it("accepts source declaring GPL SPDX (gate is gone — license metadata no longer policy)", async () => {
    const source = [
      "// SPDX-License-Identifier: GPL-3.0-or-later",
      "export function bar(n: number): number { return n + 2; }",
    ].join("\n");
    await expect(
      universalize({ source }, mockRegistry, { intentStrategy: "static" }),
    ).resolves.toBeDefined();
  });
});
```

The exact `universalize()` call signature and `intentStrategy` option are mirrored from `examples/v0.7-mri-demo/test/acceptance.test.ts:124` Test B (still in use after edit) so the implementer has a working precedent.

---

## 5. Evaluation Contract (the 10 gates)

The reviewer must verify each gate explicitly and name it in `REVIEW_VERDICT`.

| # | Gate | Verification |
|---|---|---|
| 1 | License directory gone | `ls packages/shave/src/license/` → "No such file or directory" |
| 2 | No license imports anywhere in source | `rg "licenseGate\|detectLicense\|LicenseRefusedError" packages/ bench/ docs/archive/developer/adr/ examples/v0.7-mri-demo/ examples/v1-federation-demo/ scripts/ DESIGN.md MASTER_PLAN.md` returns **zero** matches. (Exclude `examples/v1-wave-3-wasm-lower-demo/test/*.json` frozen fixtures and `docs/plans/wi-373-universalize-persist.md` historical plan from the search.) |
| 3 | Regression-net test passes | New `packages/shave/src/universalize-no-license-gate.test.ts` runs green; both `it()` blocks pass. |
| 4 | Full shave suite green | `pnpm -F @yakcc/shave test` — all tests pass; deleted gate tests are **gone** (not skipped). |
| 5 | Full hooks-base suite green | `pnpm -F @yakcc/hooks-base test` — all tests pass after removing the atomize SPDX/license block. |
| 6a | Workspace lint green | `pnpm -w lint` — **NEVER** `--filter`. |
| 6b | Workspace typecheck green | `pnpm -w typecheck` — **NEVER** `--filter`. Catches any remaining `licenseGate`/`detectLicense`/`LicenseRefusedError` import in a non-deleted file. |
| 6c | Workspace build green | `pnpm -w build` — **NEVER** `--filter`. |
| 7 | New DEC present at touch site | `DEC-LICENSE-GATE-REMOVE-001` annotation present in `packages/shave/src/index.ts` (or `errors.ts`) with: `title`, `status: accepted`, `rationale` (operator quote verbatim, 2026-05-17), `consequences`, `supersedes: DEC-LICENSE-GATE-001, DEC-LICENSE-WIRING-002`, `closes #682`. |
| 8 | DEC-LICENSE-GATE-001 + DEC-LICENSE-WIRING-002 historical references preserved | The plan-history milestones and pre-existing Decision Log rows in `MASTER_PLAN.md` are **unchanged** (historical traceability); a comment-only `superseded by DEC-LICENSE-GATE-REMOVE-001` may be added to the row, but the original text stands. |
| 9 | Bench atom-sync clean | `bench/B4-tokens-v3/harness/atom-sync.mjs` no longer contains `ensureSpdxHeader`, `readFileSync`, or `writeFileSync` (verify with `rg`). |
| 10 | PR landing (CI 2-pass auto-merge) | Branch pushed; PR opened with `closes #682`. Do **NOT** request Guardian local merge. CI's 2-pass bootstrap runs and auto-merges. Push is straightforward to the established upstream; no force-push, no history rewrite. |

### Forbidden shortcuts

- Do **NOT** keep `licenseGate` / `detectLicense` / `LicenseRefusedError` as no-op wrappers "for backwards compat." Delete them. Consumers get a clean type error and the fix is obvious.
- Do **NOT** skip gate-related tests via `it.skip` / `describe.skip` — delete them along with the gate they exercise.
- Do **NOT** touch `examples/v1-wave-3-wasm-lower-demo/test/*.json` — frozen historical state for the v1-wave-3 demo regression suite.
- Do **NOT** touch `docs/plans/wi-373-universalize-persist.md` — frozen historical plan; references to license gate are accurate-for-its-time.
- Do **NOT** touch `packages/contracts/` — license gate lives in `shave/`, not `contracts/`.
- Do **NOT** delete the `bootstrap/expected-failures.json` *mechanism* — only the GPL-fixture entry. The mechanism is general-purpose infrastructure.

### Ready-for-Guardian definition

The reviewer emits `REVIEW_VERDICT=ready_for_guardian` only when **all 10 gates** above are green and each is named in the verdict body. Anything less is `needs_changes`.

---

## 6. MASTER_PLAN.md amendments

### 6.1 New initiative section (append under `## Active Initiatives`)

```markdown
### Initiative: Shave policy simplification (license gate removal)

Status: **active 2026-05-17.** Issue #682. Workflow id: `682-license-gate-remove`. Goal id: `g-682-license-gate-remove`. Operator DEC (2026-05-17) directs that shave's license gate be removed entirely; yakcc reimplements behavior, it does not redistribute source, so copyleft / missing-license ingest-side gating is misapplied defense-in-depth and adds friction (most recently surfaced as a B4-v3 bench workaround on 2026-05-17). This initiative is subtractive: delete the gate, every consumer reference, every test/fixture that exists only to exercise the gate.

| ID | Title | Description | Deps | Gate | State |
|---|---|---|---|---|---|
| WI-682-license-gate-remove | Remove shave license gate per operator DEC | Delete `packages/shave/src/license/` directory; remove every `licenseGate` / `detectLicense` / `LicenseRefusedError` import and call across `packages/shave/`, `packages/hooks-base/`, `packages/compile/`, `packages/cli/`, `bench/B4-tokens-v3/harness/`, `examples/v0.7-mri-demo/`, `examples/v1-federation-demo/`, `scripts/audit-property-tests.mjs`; delete GPL fixture `examples/v0.7-mri-demo/src/gpl-fixture.ts` and the GPL-fixture entry in `bootstrap/expected-failures.json`; update docs `DESIGN.md`, `docs/archive/developer/adr/hook-layer-architecture.md`, `packages/shave/README.md`, `examples/v0.7-mri-demo/README.md`; add `DEC-LICENSE-GATE-REMOVE-001` annotation at touch site with operator quote verbatim; add regression-net test `packages/shave/src/universalize-no-license-gate.test.ts` asserting `universalize()` accepts SPDX-free source. Full workspace `pnpm -w lint` + `pnpm -w typecheck` + `pnpm -w build` green; full shave + hooks-base suites green. Land via PR. | — | reviewer (read-only) → PR | active 2026-05-17 |

Dependency waves: single WI; no parallelism. Critical path = WI-682-license-gate-remove.

#### Evaluation Contract and Scope Manifest

See `plans/wi-682-license-gate-remove.md` for the 10-gate Evaluation Contract and full file-by-file action plan. Scope manifest at `tmp/scope-682-license-gate-remove.json`.
```

### 6.2 New Decision Log row (append under `## Decision Log`)

```markdown
| DEC-LICENSE-GATE-REMOVE-001 | **Remove shave's license gate.** `packages/shave/src/license/` is deleted; `universalize()` no longer detects or gates on license-of-origin; `LicenseRefusedError` is removed from the public surface; the production hook (`packages/hooks-base/src/atomize.ts:347-368` SPDX auto-prepend + license pre-check) and bench workaround (`bench/B4-tokens-v3/harness/atom-sync.mjs` `ensureSpdxHeader`) introduced to dodge the gate are deleted alongside it. The `expected-failures.json` *mechanism* in `packages/cli/src/commands/bootstrap.ts` is preserved (general-purpose intentional-failure infrastructure); only the `LicenseRefusedError`-specific entry and framing are removed. **Supersedes:** `DEC-LICENSE-GATE-001` (`packages/shave/src/license/gate.ts:2-18`), `DEC-LICENSE-WIRING-002` (`packages/shave/src/index.ts:425-438`). Plan-history milestones and superseded DEC rows are **not** edited — historical traceability is preserved. **Closes:** #682. | Operator DEC verbatim (2026-05-17): *"Let's get rid of the license checks entirely we are not copying code, we are reimplementing behavior so we don't need to stop on copy left, and def not on no license."* yakcc's product story is **behavioral reimplementation**, not source redistribution. Atoms in the registry are content-addressed derivations of *behavior* (`canonical_ast_hash` + `IntentCard` + sliced glue), not byte-for-byte copies of source. Ingest-side copyleft / missing-license refusal does not protect against any real risk yakcc faces. The gate was already vestigial in production (hook auto-prepends MIT SPDX to bypass) and the most recent live encounter (B4-v3 bench, 2026-05-17) required a workaround that was itself flagged as stopgap pending this WI. Removal is subtractive and load-bearing (Sacred Practice #12: no parallel mechanisms — the gate cannot be kept as a no-op wrapper). |
```

---

## 7. Integration Surface Context (for implementer dispatch)

### State domains touched

- **Shave universalize() ingestion pipeline** — removes the first stage (license gate). The pipeline is now: extract intent → decompose → slice. No stage reorder side-effects; the gate was a pure pre-filter.
- **Hooks-base atomize() ingestion pipeline** — removes a pre-process step (SPDX injection) and a pre-check (license gate call). The shave call that follows is unchanged.
- **B4-v3 bench harness apparatus** — removes a stopgap (`ensureSpdxHeader`). The shave call that follows is unchanged.
- **Public type surface of `@yakcc/shave`** — removes `LicenseRefusedError`, `detectLicense`, `licenseGate`, `AcceptedLicense`, `LicenseDetection`, `LicenseGateResult`. Downstream consumers (the compile package, the v0.7-mri-demo, the v1-federation-demo, hooks-base) all need their imports updated.
- **Bootstrap expected-failures schema (`packages/cli/src/commands/bootstrap.ts`)** — the *mechanism* is preserved (general-purpose); the `LicenseRefusedError`-specific framing in docs and the GPL-fixture data row are removed.
- **No DB / SQLite schema changes. No registry / contracts / IR changes.**

### Adjacent components / prior art

This is a SUBTRACTIVE refactor — there's no exact precedent at this scale of consumer-facing-symbol deletion in yakcc's recent history. Closest analogs:

- **`DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-FIX-FLIP-001`** (PR #695) — supersedes 2 prior DECs and records the explicit supersession chain. Follow that pattern for the `supersedes:` field on the new DEC.
- **Sacred Practice #12** ("No parallel mechanisms"): the implementer must NOT keep `licenseGate` as a no-op wrapper "for backwards compat." Delete it. Type errors at consumer sites are the *correct* migration signal.

### Canonical authority

The license gate's authority lives entirely in `packages/shave/src/license/`. After this WI, no module exists. Consumers who imported `licenseGate` / `detectLicense` / `LicenseRefusedError` / `LicenseDetection` get clean TypeScript errors and must remove their usage. This is the intended migration path.

### Removal targets (the supersession set)

- `packages/shave/src/license/` (entire directory)
- `packages/hooks-base/src/atomize.ts:347-368` (SPDX auto-prepend + license pre-check)
- `bench/B4-tokens-v3/harness/atom-sync.mjs` (`ensureSpdxHeader` function + call site + `readFileSync`/`writeFileSync` imports)
- `examples/v0.7-mri-demo/src/gpl-fixture.ts` (the GPL fixture file itself)
- `bootstrap/expected-failures.json` GPL-fixture entry
- All `LicenseRefusedError` test cases in shave / compile / cli / examples
- All README / MASTER_PLAN / ADR / DESIGN references (except historical plan-history milestones and superseded DEC rows, which are preserved as historical record)

---

## 8. Scope Manifest

Authority-written via `cc-policy workflow scope-sync` against `tmp/scope-682-license-gate-remove.json` (see §9 for the canonical JSON).

**Allowed paths** (the implementer may touch):

- `packages/shave/src/**`
- `packages/hooks-base/src/atomize.ts`
- `packages/compile/src/assemble-candidate.ts`
- `packages/compile/src/assemble-candidate.test.ts`
- `packages/cli/src/commands/bootstrap.ts`
- `packages/cli/src/bootstrap.test.ts`
- `bench/B4-tokens-v3/harness/atom-sync.mjs`
- `bootstrap/expected-failures.json`
- `examples/v0.7-mri-demo/src/gpl-fixture.ts` (delete only)
- `examples/v0.7-mri-demo/test/acceptance.test.ts`
- `examples/v0.7-mri-demo/README.md`
- `examples/v1-federation-demo/test/acceptance.test.ts`
- `scripts/audit-property-tests.mjs`
- `docs/archive/developer/adr/hook-layer-architecture.md`
- `DESIGN.md`
- `MASTER_PLAN.md`
- `packages/shave/README.md`
- `plans/wi-682-license-gate-remove.md` (this file — implementer may add notes if needed)

**Required paths** (must be modified):

- `packages/shave/src/index.ts`
- `packages/shave/src/errors.ts`
- `packages/hooks-base/src/atomize.ts`
- `bench/B4-tokens-v3/harness/atom-sync.mjs`
- `packages/shave/src/universalize-no-license-gate.test.ts` (new file)
- `MASTER_PLAN.md`

**Forbidden paths** (do NOT touch unless re-approved):

- `examples/v1-wave-3-wasm-lower-demo/**` (frozen historical demo state)
- `docs/plans/wi-373-universalize-persist.md` (frozen historical plan)
- `packages/contracts/**`
- `packages/registry/**`
- `packages/ir/**`
- `packages/seeds/**`
- `packages/federation/**`
- `packages/variance/**`
- `packages/hooks-classifier/**`
- `VERIFICATION.md`
- `FEDERATION.md`
- `MANIFESTO.md`
- `AGENTS.md`
- `bootstrap/expected-roots.json` (not part of this change; modifying it would require a regenerate that this WI does not own)
- `.github/workflows/**`
- `bootstrap/CORPUS_STATS.md`

**State / authority domains touched:**

- `shave-universalize-pipeline` — license gate removed; pipeline becomes `extract intent → decompose → slice`. Touch authority: `packages/shave/src/index.ts:universalize()`.
- `shave-public-surface` — `LicenseRefusedError`, `detectLicense`, `licenseGate`, `AcceptedLicense`, `LicenseDetection`, `LicenseGateResult` are removed from `@yakcc/shave`. Touch authority: `packages/shave/src/index.ts`.
- `hooks-base-atomize` — SPDX auto-prepend + license pre-check removed. Touch authority: `packages/hooks-base/src/atomize.ts`.
- `bench-b4v3-harness` — `ensureSpdxHeader` workaround removed. Touch authority: `bench/B4-tokens-v3/harness/atom-sync.mjs`.
- `bootstrap-expected-failures-data` — GPL-fixture entry removed; schema preserved. Touch authority: `bootstrap/expected-failures.json` + `packages/cli/src/commands/bootstrap.ts` (doc/example update only).

---

## 9. Implementer hand-off

**Workflow ID:** `682-license-gate-remove`
**Branch:** `feature/682-license-gate-remove` (HEAD `8ce865e`, clean)
**Worktree:** `c:/src/yakcc/.worktrees/feature-682-license-gate-remove` — operate here exclusively (use `git -C`).
**Scope:** `tmp/scope-682-license-gate-remove.json` (authority-written via `cc-policy workflow scope-sync`)
**Evaluation Contract:** §5 above — 10 gates.

**Recommended order of operations:**

1. Delete `packages/shave/src/license/` first — every downstream type error then directs you to the next consumer.
2. Update `packages/shave/src/index.ts` (remove imports/exports/gate-call block) — workspace `pnpm -w typecheck` after this surfaces every remaining consumer.
3. Update `packages/shave/src/errors.ts` (remove `LicenseRefusedError` class).
4. Update each downstream consumer as the typechecker flags it: shave's own test files first, then hooks-base, compile, cli, examples, scripts, bench harness.
5. Delete `examples/v0.7-mri-demo/src/gpl-fixture.ts` and update `bootstrap/expected-failures.json`.
6. Update all docs (README, ADR, DESIGN, MASTER_PLAN).
7. Add the new regression-net test file last (so the green-test gate proves both the deletion and the positive new contract).
8. Annotate `DEC-LICENSE-GATE-REMOVE-001` at the touch site in `packages/shave/src/index.ts` (or `errors.ts`).
9. Run the full Evaluation Contract gates locally before pushing.
10. Push the branch and open the PR with `closes #682`. Do NOT request Guardian local merge — CI 2-pass auto-merge handles it.

**Standing rules (durable):**

- Land via PR, NOT Guardian-merge.
- Full-workspace `pnpm -w lint` AND `pnpm -w typecheck` AND `pnpm -w build` — NEVER `--filter <pkg>`. Package-scoped passing is necessary but not sufficient (per memory: `feedback_eval_contract_match_ci_checks.md`).
- Cross-package imports via `@yakcc/*` workspace aliases (per memory: `feedback_no_cross_package_imports.md`).
- Fetch + ff-pull `origin/main` immediately before `gh pr create` (per memory: `feedback_fetch_before_pr.md`).
- The two `git status` modified files in the repo (`examples/v1-wave-3-wasm-lower-demo/test/*.json`) and the two untracked tmp fixture directories under `packages/ir/src/__fixtures__/` are pre-existing repo state, NOT part of this WI. Do not stage or commit them.
