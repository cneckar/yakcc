# wi-687-s2-cline — @yakcc/hooks-cline adapter package

**Workflow:** `wi-687-s2-cline`
**Goal:** `g-687-s2-cline` (#687 S2 Cline adapter)
**Branch:** `feature/687-s2-cline-adapter`
**Worktree:** `/Users/cris/src/yakcc/.worktrees/feature-687-s2-cline-adapter`
**Base:** `main` @ `5663395` (post-#719 B4-v3 dossier merge)
**Status:** in_progress
**Owner agents:** planner → implementer → reviewer → guardian (land)

---

## Identity

Cline is the VS Code extension `saoudrizwan.claude-dev`. The yakcc CLI surface
(KNOWN_IDE_NAMES, ide-detect probe, init/uninstall dispatch, lifecycle test
harness, marker-file CLI installer) for `cline` already landed in S1 (#687 S1
WI-656). What is **missing** is the runtime adapter package
`@yakcc/hooks-cline` itself — the in-process library that a future Cline
extension or hook subprocess would import to call `executeRegistryQueryWithSubstitution()`
and `yakccResolve()` with cline-prefixed telemetry. This slice ships that package.

The structural twin is `@yakcc/hooks-cursor`: a marker-file-style adapter built
on `@yakcc/hooks-base`, with IDE-specific:
  * marker filename (`yakcc-cline-command.json`)
  * default markerDir (`~/.config/cline`)
  * session env var (`CLINE_SESSION_ID`) → telemetry prefix (`cline-<id>`)

S2 is parallel-safe with S3 Windsurf (separate package, separate scope, no
shared writes).

---

## Problem Decomposition

### Problem statement
After S1, the CLI advertises `cline` as a supported IDE and installs the
marker file at `~/.config/cline/yakcc-cline-hook.json`, but there is no
`@yakcc/hooks-cline` workspace package. A caller that imports
`@yakcc/hooks-cline` (analog to existing `@yakcc/hooks-cursor`) gets a module
resolution error. The adapter surface (CursorHook ↔ ClineHook,
registerCommand, onCodeEmissionIntent, createYakccResolveTool) does not exist
for cline.

### Goals
1. New workspace package `@yakcc/hooks-cline` with parity to
   `@yakcc/hooks-cursor`.
2. Cline-specific identity: `CLINE_SESSION_ID` env var, `cline-<id>` telemetry
   prefix, `~/.config/cline` default markerDir, `yakcc-cline-command.json`
   marker filename, `yakcc-cline-resolve-tool.json` resolve-tool marker.
3. Test parity: vitest test suites mirror cursor's
   (`index.test.ts`, `adapter-telemetry.test.ts`, `yakcc-resolve-tool.test.ts`),
   plus `index.props.ts` + `index.props.test.ts` property tests.
4. The existing `packages/cli/test/integration/hooks-lifecycle.test.ts`
   continues to pass for the `cline` row — this slice MUST NOT regress that
   harness. (S2 does not modify the CLI install command; that already ships
   from S1.)

### Non-goals
* Do **NOT** create `@yakcc/hooks-continue` (out of scope; S1 left the same
  gap for continue, but #687 S2 is cline only).
* Do **NOT** modify `packages/hooks-cursor`, `packages/hooks-claude-code`,
  `packages/hooks-base`, `packages/registry`, or any other adapter.
* Do **NOT** activate real Cline VS Code extension interception — the Cline
  extension API for synchronous tool-call interception is not yet stable
  (mirrors the cursor constraint documented in DEC-CLI-HOOKS-CURSOR-INSTALL-001).
* Do **NOT** modify the CLI install command, init/uninstall switches, or
  ide-detect.ts — they were finalised in S1.
* Do **NOT** add new entries to the lifecycle test matrix; the cline row is
  already there.

### Discovered S1 surface state (read first; do not duplicate)

S1 already shipped the following — this slice MUST NOT re-author them:

| Surface | File | State at base 5663395 |
| --- | --- | --- |
| CLI install command | `packages/cli/src/commands/hooks-cline-install.ts` | Present (185 LOC). Idempotent install/uninstall via `--uninstall` flag. Writes/removes `~/.config/cline/yakcc-cline-hook.json` with `_yakcc: "yakcc-hook-v1-cline"` sentinel. |
| CLI install test | `packages/cli/src/commands/hooks-cline-install.test.ts` | Present. |
| init switch | `packages/cli/src/commands/init.ts` | `case "cline":` calls `hooksClineInstall([], logger, ~/.config/cline)`. |
| uninstall switch | `packages/cli/src/commands/uninstall.ts` | `case "cline":` calls `hooksClineInstall(["--uninstall"], …)`. |
| ide-detect | `packages/cli/src/lib/ide-detect.ts` | `"cline"` in `KNOWN_IDE_NAMES`; primary probe `~/.config/cline`, secondary VS Code extension dir. |
| Lifecycle test | `packages/cli/test/integration/hooks-lifecycle.test.ts` | `cline` is in `ADAPTERS = ["claude-code", "cursor", "cline", "continue"]`. Sentinel `yakcc-hook-v1-cline`. Marker path `~/.config/cline/yakcc-cline-hook.json`. 6 cases × 4 adapters = 24 PASS today. |

Operator's original prompt mentioned "30 PASS (6×5)" — that count is **wrong**
for this slice. The matrix today is 6×4 = 24; this slice does NOT add a row.
S1 wired all four adapters into the harness. No "row to extend".

### Unknowns / clarifications
* The Cline extension API surface stability is the same constraint as cursor:
  no Node-callable synchronous interception. The adapter ships with the same
  marker-file stub semantics; no API behaviour gates this slice.
* No upstream Cline contract; we follow the cursor adapter as the structural
  authority.

### Dominant constraints
* Scope is fenced. Plan file plus everything under
  `packages/hooks-cline/**` is the **only** write surface (the CLI
  surface is forbidden by scope; lifecycle test already covers cline).
* Must build under the existing pnpm workspace + tsconfig refs pattern.
* Property tests (`index.props.ts`) follow the two-file pattern from
  hooks-cursor; no fast-check, hand-authored corpus.
* `vitest.config.ts` aliases workspace packages to `src/index.ts` (same as
  cursor); `YAKCC_HOOK_DISABLE_INTENT_GATE: "1"` env entry required.

---

## Architecture Design

### Authority map

| Domain | Canonical authority | Notes |
| --- | --- | --- |
| Cline session ID resolution | `packages/hooks-cline/src/index.ts::resolveClineSessionId()` | Reads `CLINE_SESSION_ID`; falls back to a process-local UUID. Prefixes with `"cline-"`. |
| Cline marker filename | `packages/hooks-cline/src/index.ts::CLINE_COMMAND_MARKER_FILENAME` | `"yakcc-cline-command.json"`. |
| Cline default markerDir | `packages/hooks-cline/src/index.ts::createHook` default | `join(homedir(), ".config", "cline")`. Matches `ide-detect.ts` primary probe. |
| Cline resolve-tool marker | `packages/hooks-cline/src/yakcc-resolve-tool.ts::RESOLVE_TOOL_MARKER_FILENAME` | `"yakcc-cline-resolve-tool.json"`. |
| Registry query + substitution + telemetry | `@yakcc/hooks-base::executeRegistryQueryWithSubstitution` | Re-used; not re-implemented. |
| YakccResolve evidence projection | `@yakcc/hooks-base::yakccResolve` | Re-used. |
| Marker file write | `@yakcc/hooks-base::writeMarkerCommand` | Re-used. |
| Registry open (resolve-tool) | `@yakcc/registry::openRegistry` | Re-used; lazy. |

The CLI install marker (`yakcc-cline-hook.json`, sentinel
`yakcc-hook-v1-cline`) is owned by `hooks-cline-install.ts` (CLI side) and
written/removed during install/uninstall. The adapter's `registerCommand()`
writes a **separate** marker (`yakcc-cline-command.json`, no sentinel; this
is the runtime-side stub). These two marker files coexist in
`~/.config/cline/` without collision — same pattern as cursor:

  * CLI install side: `.cursor/yakcc-cursor-hook.json` (sentinel
    `yakcc-hook-v1-cursor`) — managed by `hooks-cursor-install.ts`.
  * Adapter side: `.cursor/yakcc-cursor-command.json` — managed by
    `createHook(...).registerCommand()`.

That cohabitation is established prior art and is not a state-authority
collision.

### Alternatives considered

* **Alternative A: re-use the same marker file for both CLI install and
  adapter registerCommand.** Rejected. Cursor already runs the two-marker
  pattern; collapsing them would create cross-package coupling between the CLI
  install path and the runtime adapter (Sacred Practice #12 — two writers of
  the same domain). Stick to the cursor pattern verbatim.
* **Alternative B: skip property tests this slice.** Rejected. The cursor
  adapter ships them; lacking parity here would be a quiet quality regression
  flagged on review. Implementing them is cheap (mechanical copy with
  rename).
* **Alternative C: skip yakcc-resolve-tool.ts.** Rejected. Cursor ships it;
  full parity is the desired end state per goal G1.

No Alternatives Gate required — all options collapse to "mirror cursor."

### Research

Source-of-truth review was performed by reading:
* `packages/hooks-cursor/src/index.ts` (271 LOC) — adapter shape, factory,
  re-exports.
* `packages/hooks-cursor/src/yakcc-resolve-tool.ts` (209 LOC) — resolve-tool
  factory + marker.
* `packages/hooks-cursor/src/index.props.ts` (330 LOC) + `.props.test.ts` (60+
  LOC) — property-test corpus shape.
* `packages/hooks-cursor/package.json`, `tsconfig.json`,
  `tsconfig.typecheck.json`, `vitest.config.ts` — build skeleton.
* `packages/hooks-cursor/test/{index.test.ts,adapter-telemetry.test.ts,yakcc-resolve-tool.test.ts}`
  — vitest suites (963 LOC total).
* `packages/cli/src/commands/hooks-cline-install.ts` — S1's install marker
  conventions (`yakcc-cline-hook.json`, sentinel `yakcc-hook-v1-cline`,
  env var `CLINE_SESSION_ID`, telemetry prefix `cline`).
* `packages/cli/src/lib/ide-detect.ts` — `~/.config/cline` default probe.
* `packages/cli/test/integration/hooks-lifecycle.test.ts` — confirms cline
  row already present and exercised end-to-end.

No external research needed: Cline's VS Code surface stability is the same
unknown as cursor's, and the same marker-file stub strategy applies.

---

## Wave Decomposition

Single-wave slice. Implementer ships all files atomically.

| W-ID | Task | Weight | Gate | Deps |
| --- | --- | --- | --- | --- |
| W-S2-1 | `packages/hooks-cline/` skeleton: `package.json`, `tsconfig.json`, `tsconfig.typecheck.json`, `vitest.config.ts`, `README.md` (optional minimal) | S | none | — |
| W-S2-2 | `src/index.ts`: ClineHook interface, createHook factory, CLINE_COMMAND_MARKER_FILENAME, resolveClineSessionId, ClineHookOptions, re-exports from hooks-base | M | none | W-S2-1 |
| W-S2-3 | `src/yakcc-resolve-tool.ts`: createYakccResolveTool factory, RESOLVE_TOOL_MARKER_FILENAME, lazy registry open | M | none | W-S2-2 |
| W-S2-4 | `src/index.props.ts` + `src/index.props.test.ts` property-test corpus | S | none | W-S2-2 |
| W-S2-5 | `test/index.test.ts`, `test/adapter-telemetry.test.ts`, `test/yakcc-resolve-tool.test.ts` — vitest suites mirroring cursor | L | none | W-S2-2, W-S2-3 |
| W-S2-6 | Verify lifecycle suite still passes (no edit needed; the CLI surface is forbidden) | XS | review | W-S2-1..5 |

Critical path: W-S2-1 → W-S2-2 → (W-S2-3 ∥ W-S2-4) → W-S2-5 → W-S2-6.
Max width: 2.

---

## Evaluation Contract

### Required tests (must all PASS on the implementer's HEAD)

1. `pnpm --filter @yakcc/hooks-cline test`
   * Mirrors cursor's three test files + one property-test file. Test count
     and shape must mirror hooks-cursor (allow ±10% drift only for adapter
     identity assertions e.g. "contains 'cline'" vs "contains 'cursor'").
2. `pnpm --filter @yakcc/hooks-cline typecheck`
3. `pnpm --filter @yakcc/hooks-cline build` — produces `dist/index.js`,
   `dist/index.d.ts`, `dist/yakcc-resolve-tool.js`, `dist/yakcc-resolve-tool.d.ts`.
4. `pnpm --filter @yakcc/cli test` continues to PASS (NO regression in the
   already-passing cline row of `hooks-lifecycle.test.ts`).
5. `pnpm -r typecheck` succeeds at the workspace level (the new package must
   appear in workspace tsbuild without breaking sibling refs).

### Required real-path checks

* Marker filename constant is exactly `"yakcc-cline-command.json"`.
* Default markerDir under `createHook(reg)` (no options) resolves to
  `join(homedir(), ".config", "cline")`.
* `resolveClineSessionId()` with `CLINE_SESSION_ID=test-123` returns
  `"cline-test-123"`; with no env var, returns a string starting with
  `"cline-"`.
* `RESOLVE_TOOL_MARKER_FILENAME === "yakcc-cline-resolve-tool.json"`.
* Re-exported `DEFAULT_REGISTRY_HIT_THRESHOLD === 0.3`.

### Required authority invariants

* `@yakcc/hooks-cline` MUST NOT import from `@yakcc/hooks-cursor`,
  `@yakcc/hooks-claude-code`, `@yakcc/hooks-codex`. Cross-adapter import is a
  parallel-authority violation. (Approved imports: `@yakcc/hooks-base`,
  `@yakcc/registry`, `@yakcc/contracts`, `node:` builtins.)
* `@yakcc/hooks-cline` MUST NOT re-implement `executeRegistryQueryWithSubstitution`,
  `yakccResolve`, `writeMarkerCommand`, or any constant owned by
  `@yakcc/hooks-base`. Re-export only.
* Telemetry prefix `"cline-"` MUST be unique vs cursor's `"cursor-"` and
  claude-code's bare session-id. No silent prefix collision.
* The CLI install marker (`yakcc-cline-hook.json`, sentinel
  `yakcc-hook-v1-cline`) MUST remain owned by `hooks-cline-install.ts`. The
  adapter's `registerCommand()` marker MUST use the distinct filename
  `yakcc-cline-command.json` and MUST NOT carry the `_yakcc` sentinel (that
  is reserved for the CLI install marker so uninstall can locate it).

### Required integration points

* `package.json` lists workspace deps: `@yakcc/contracts`,
  `@yakcc/hooks-base`, `@yakcc/registry` (workspace:*); devDeps:
  `@types/node ^22.0.0`, `vitest ^4.1.5`. Mirrors cursor.
* `tsconfig.json` extends `../../tsconfig.base.json` with composite refs to
  contracts, hooks-base, registry.
* `vitest.config.ts` aliases the three workspace packages to their `src/index.ts`
  with the `YAKCC_HOOK_DISABLE_INTENT_GATE: "1"` env entry.
* Workspace pnpm includes `packages/hooks-cline` via the existing
  `packages/*` glob in `pnpm-workspace.yaml` (no manual add needed; verify
  by `pnpm install --frozen-lockfile`).

### Forbidden shortcuts

* No copy-without-rename of cursor identifiers (`CursorHook`,
  `CURSOR_COMMAND_MARKER_FILENAME`, `resolveCursorSessionId`,
  `CURSOR_FALLBACK_SESSION_ID`). All identifiers must rename to `Cline*`.
* No mocking of `@yakcc/hooks-base` or `@yakcc/registry` in tests beyond
  what cursor's existing suite does (the cursor pattern is a `makeStubRegistry()`
  for property tests and real `openRegistry()` for integration tests).
* No adding `cline` to a separate `KNOWN_IDE_NAMES` (it is already there);
  no edits under `packages/cli/**` — that is out of scope and would be denied
  by scope enforcement.
* No use of `--no-verify`, `--force`, history rewrite. Standard guardian
  landing only.

### Ready-for-guardian definition

The reviewer may declare `REVIEW_VERDICT=ready_for_guardian` when ALL of:

1. All "Required tests" above PASS on the implementer's HEAD with output
   captured.
2. All "Required real-path checks" verified (test assertions OR reviewer
   spot-check).
3. All "Required authority invariants" hold (import-graph audit by reviewer
   via `grep` of `@yakcc/hooks-cursor`, `@yakcc/hooks-claude-code`,
   `@yakcc/hooks-codex` in the new package — must return zero).
4. `pnpm --filter @yakcc/cli test` shows cline lifecycle cases still PASS.
5. `@decision DEC-HOOK-CLINE-001` annotation present at top of
   `src/index.ts` cross-referencing DEC-HOOK-CURSOR-001 and
   DEC-HOOK-BASE-001.

---

## Scope Manifest

### Allowed files/directories

* `plans/wi-687-s2-cline.md` (this file)
* `packages/hooks-cline/**` (new package — full freedom)
* `tmp/wi-687-s2-cline-*/**` (scratch space for implementer/reviewer)

### Required files (must be modified or created)

* `plans/wi-687-s2-cline.md`
* `packages/hooks-cline/package.json`
* `packages/hooks-cline/src/index.ts`
* `packages/hooks-cline/src/yakcc-resolve-tool.ts`
* `packages/hooks-cline/tsconfig.json`
* `packages/hooks-cline/tsconfig.typecheck.json`
* `packages/hooks-cline/vitest.config.ts`
* `packages/hooks-cline/src/index.props.ts`
* `packages/hooks-cline/src/index.props.test.ts`
* `packages/hooks-cline/test/index.test.ts`
* `packages/hooks-cline/test/adapter-telemetry.test.ts`
* `packages/hooks-cline/test/yakcc-resolve-tool.test.ts`

### Forbidden touch points

* `packages/hooks-cursor/**`, `packages/hooks-claude-code/**`,
  `packages/hooks-codex/**`, `packages/hooks-windsurf/**`,
  `packages/hooks-continue/**`, `packages/hooks-base/**`
* `packages/registry/**`, `packages/compile/**`, `packages/shave/**`
* `packages/cli/src/commands/hooks-cline-install.ts` — already shipped by
  S1; **do not edit**.
* `packages/cli/src/commands/init.ts`, `packages/cli/src/commands/uninstall.ts`,
  `packages/cli/src/lib/ide-detect.ts`, `packages/cli/src/index.ts` —
  already wired by S1; **do not edit**.
* `packages/cli/test/integration/hooks-lifecycle.test.ts` — already exercises
  cline; **do not edit**.
* `bench/**`, `.github/**`, `.claude/**`, `MASTER_PLAN.md`, `docs/**`,
  `scripts/**`, `examples/**`.

### Expected state authorities touched

* Authority domain `cline-hook-adapter` (new — owned solely by
  `packages/hooks-cline/`).

---

## Decision Log

| DEC ID | Decision | Rationale |
| --- | --- | --- |
| DEC-HOOK-CLINE-001 | Scaffold `@yakcc/hooks-cline` as a structural twin of `@yakcc/hooks-cursor` with cline-prefixed identity (`CLINE_SESSION_ID` env, `cline-` telemetry prefix, `~/.config/cline` markerDir, `yakcc-cline-command.json` marker). Re-export shared types and helpers from `@yakcc/hooks-base`. | Cursor and cline share the marker-file stub pattern because neither IDE exposes a stable Node-callable extension API for synchronous tool-call interception. Mirroring cursor verbatim minimises adapter divergence (Sacred Practice #12) and lets future hooks-base improvements propagate to both adapters by re-export. The cline-specific tokens (env var, prefix, marker name, markerDir) preserve per-IDE telemetry separability across B3/B4/B5 measurement files. |
| DEC-HOOK-CLINE-MARKER-NAMESPACE | The adapter's `registerCommand()` writes `yakcc-cline-command.json` (no `_yakcc` sentinel); the CLI installer's `hooksClineInstall()` writes `yakcc-cline-hook.json` (with `_yakcc: "yakcc-hook-v1-cline"`). | Two-file cohabitation mirrors cursor's prior art. The CLI install marker's sentinel is load-bearing for idempotent uninstall; the runtime adapter marker is a separate registration stub. Collapsing them would couple the CLI install path to the runtime adapter (parallel-authority violation). |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Test fixture from cursor copied without renaming `cursor` → `cline` in fixture strings, causing semantically wrong assertions to still PASS | M | L | Reviewer greps the new package for `cursor` (case-insensitive); only legitimate cross-reference comments may remain (e.g. "DEC-HOOK-CURSOR-001"). All identifiers, marker filenames, env var names, telemetry prefixes must be cline. |
| pnpm workspace lockfile drift | L | L | `pnpm install` after package add; commit the resulting `pnpm-lock.yaml` change only if scope permits — if not, document the gap and ask reviewer. (Lockfile is under `/` root, not the package; allowed-paths does not list it, so a lockfile change would need scope amendment. Plan: avoid adding new external deps; only workspace:* deps already in lockfile.) |
| Property test corpus omits a cursor-mirror property | L | L | Reviewer compares property function lists between `hooks-cursor/src/index.props.ts` and `hooks-cline/src/index.props.ts`. Function count parity required (with rename). |
| Lifecycle test regression on cline row | L | M | This slice does not modify the lifecycle test or any CLI source path; regression would be unrelated. Reviewer runs `pnpm --filter @yakcc/cli test` to confirm green. |
| Cline VS Code extension API changes during implementation | L | L | Stub-marker pattern is documented in DEC-HOOK-CLINE-001 as a known limitation; no runtime gate on API stability. |

---

## Ready-for-Guardian Checklist

* [ ] `packages/hooks-cline/package.json` written with workspace:* deps.
* [ ] `packages/hooks-cline/src/index.ts` written with `@decision DEC-HOOK-CLINE-001` annotation.
* [ ] `packages/hooks-cline/src/yakcc-resolve-tool.ts` written.
* [ ] `packages/hooks-cline/src/index.props.ts` + `.props.test.ts` written.
* [ ] `packages/hooks-cline/test/{index,adapter-telemetry,yakcc-resolve-tool}.test.ts` written.
* [ ] `packages/hooks-cline/{tsconfig.json,tsconfig.typecheck.json,vitest.config.ts}` written.
* [ ] `pnpm install` succeeds (workspace pickup).
* [ ] `pnpm --filter @yakcc/hooks-cline typecheck` exit 0.
* [ ] `pnpm --filter @yakcc/hooks-cline test` exit 0 with no SKIP/TODO.
* [ ] `pnpm --filter @yakcc/hooks-cline build` produces dist/.
* [ ] `pnpm --filter @yakcc/cli test` exit 0 (cline row green; no regression).
* [ ] Reviewer audit: no imports of `@yakcc/hooks-cursor|claude-code|codex` in new package.
* [ ] Reviewer audit: identifier rename complete (no stray `Cursor` / `cursor` names except DEC cross-refs).

---

## Rollback Boundary

Single-commit slice. Rollback = `git revert <land-sha>`. No data migration,
no schema change, no behaviour change to existing consumers.

---

PLAN_VERDICT: next_work_item
PLAN_SUMMARY: Plan written for #687 S2 @yakcc/hooks-cline adapter package mirroring @yakcc/hooks-cursor with cline-specific identity (CLINE_SESSION_ID, cline- telemetry prefix, ~/.config/cline markerDir, yakcc-cline-command.json marker); scope is hooks-cline/** only, CLI surface already shipped by S1 and is forbidden; ready for implementer dispatch.
