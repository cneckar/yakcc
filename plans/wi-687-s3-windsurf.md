# Plan — WI-687-S3 — `@yakcc/hooks-windsurf` adapter (5th IDE adapter)

**Workflow**: `wi-687-s3-windsurf`
**Work item**: `wi-687-s3-windsurf`
**Issue**: #687 (S3 slice)
**Branch / worktree**: `feature-687-s3-windsurf-adapter` @ `8aee0ec`
**Base**: `origin/main` @ `5708ad6` (1 squash-merge ahead of this worktree; merges cleanly per DEC-GUARD-WT-002)
**Tier**: 2 (Standard) — multi-file additive scaffold; pattern is fully established by hooks-cursor (S1 sibling).

---

## 1 — Problem statement and goals

**Problem**: yakcc ships hook adapters for `claude-code`, `cursor`, `cline`, and `continue`
(the 4 IDEs in `KNOWN_IDE_NAMES`). Windsurf (Codeium's VS-Code-fork IDE) is a
real user environment and the next obvious adapter, but no `@yakcc/hooks-windsurf`
package or CLI surface exists. Without it, yakcc users on Windsurf cannot install
the hook with `yakcc init --ide windsurf`, and the S1 lifecycle harness has
nothing to certify for Windsurf.

**Goal**: ship the 5th production-wired IDE adapter end-to-end.

1. Create `@yakcc/hooks-windsurf` package, byte-for-byte structural mirror of
   `@yakcc/hooks-cursor` (the closest analog — both are VS Code forks with
   marker-file stub registration).
2. Wire Windsurf into the CLI's three authority surfaces:
   `lib/ide-detect.ts` (the canonical IDE registry), `commands/init.ts`
   (installer dispatch), `commands/uninstall.ts` (uninstaller dispatch).
3. Extend the S1 hook lifecycle harness
   (`packages/cli/test/integration/hooks-lifecycle.test.ts`) so its 6 cases ×
   N-adapters matrix grows from 4 → 5 adapters.

**Non-goals**:
- No new shared logic in `@yakcc/hooks-base`. The base is consumed as-is.
- No edits to sibling adapter packages (`hooks-cursor`, `hooks-cline`,
  `hooks-continue`, `hooks-claude-code`, `hooks-codex`).
- No changes to the `hook-intercept` shared subprocess command.
- No Windsurf-specific telemetry schema fields — sessionPrefix `windsurf-`
  follows the established convention but no new event types.
- No bench/, docs/, .github/, MASTER_PLAN.md edits.

**Constraints**:
- Pattern parity with `hooks-cursor` is non-negotiable — the whole point of S3
  is that adding a 5th adapter requires zero new shape, only brand swaps.
- `KNOWN_IDE_NAMES` is the SINGLE SOURCE OF TRUTH for IDE identity
  (DEC-687-S1-ADAPTER-COUNT). Every consumer (init validator, uninstall
  validator, ide-detect.test, hooks-lifecycle.test) must be updated atomically.

---

## 2 — Architecture: state-authority map

| State / fact | Canonical authority | New row for windsurf |
| --- | --- | --- |
| IDE identity universe | `packages/cli/src/lib/ide-detect.ts` → `IdeName` union + `KNOWN_IDE_NAMES` const | add `"windsurf"` to both |
| IDE detection probe paths | `packages/cli/src/lib/ide-detect.ts` → `buildCandidatePaths()` switch | add `windsurf` case: `~/.windsurf` (Linux/macOS) and Win equivalent if pattern requires |
| Install dispatch | `packages/cli/src/commands/init.ts` → `installHookForIde()` switch | add `windsurf` case calling new installer |
| Uninstall dispatch | `packages/cli/src/commands/uninstall.ts` → `uninstallHookForIde()` switch | add `windsurf` case |
| Per-IDE installer | `packages/cli/src/commands/hooks-<ide>-install.ts` | new `hooks-windsurf-install.ts` (mirrors `hooks-cursor-install.ts` exactly) |
| Adapter logic (registry-query, telemetry, marker writes) | `@yakcc/hooks-<ide>` package | new `packages/hooks-windsurf/` (mirrors `packages/hooks-cursor/`) |
| Lifecycle test matrix | `packages/cli/test/integration/hooks-lifecycle.test.ts` → `SENTINELS`, `ADAPTERS`, switches in `seedDetectProbe` / `hookArtefactPath` / `isYakccMarkerPresent` / `preSeedSiblingContent` | add `windsurf` row everywhere |
| Telemetry filename prefix | per-adapter `resolveXxxSessionId()` (e.g. `cursor-<id>`) | new `resolveWindsurfSessionId()` → `windsurf-<id>` |
| Tool-name → schema map | per-adapter `onCodeEmissionIntent(ctx, toolName, originalCode)` typed `"Edit" \| "Write" \| "MultiEdit"` | same shape — Windsurf is VS Code-derived |

**State-authority invariants (do not violate)**:
- Adding a new IDE WITHOUT updating `KNOWN_IDE_NAMES` would create a parallel
  identity registry — denied.
- Adding a new IDE WITHOUT updating `installHookForIde` AND `uninstallHookForIde`
  switches would leave init silently no-op on `--ide windsurf` and uninstall
  unable to remove it — denied.
- Adding a new IDE WITHOUT extending the S1 lifecycle harness would mean the
  certified round-trip claim "all installed adapters round-trip cleanly" stops
  being true — denied. The harness's `ADAPTERS` const IS the certification.

**Windsurf-specific defaults (single source: `hooks-windsurf` package)**:
- `WINDSURF_HOOK_MARKER_FILENAME` = `"yakcc-windsurf-command.json"`
- Default `markerDir` = `~/.windsurf/` (matches `~/.cursor` / `~/.continue` pattern; `homedir()` + `.windsurf`)
- Session env var = `WINDSURF_SESSION_ID`
- Session prefix = `"windsurf-"` → telemetry file `windsurf-<id>.jsonl`
- CLI install marker = `.windsurf/yakcc-windsurf-hook.json`
- Settings file = `.windsurf/settings.json` (VS-Code-style, mirroring `.cursor/settings.json`)
- Sentinel = `"yakcc-hook-v1-windsurf"`
- IDE detect probe path = `~/.windsurf` (Linux/macOS canonical; matches Continue's pattern more than Cursor's macOS-specific `Library/Application Support` path because Windsurf's user config dir is `~/.windsurf` cross-platform per Codeium docs)

---

## 3 — Wave decomposition

| WID | Title | Weight | Gate | Deps | Integration surfaces |
| --- | --- | --- | --- | --- | --- |
| W1 | Create `packages/hooks-windsurf/` package (package.json, tsconfig × 2, vitest.config.ts, README) | S | none | — | none (new dir) |
| W2 | `packages/hooks-windsurf/src/index.ts` — mirror of hooks-cursor index.ts; brand swap | M | none | W1 | imports from `@yakcc/hooks-base` |
| W3 | `packages/hooks-windsurf/src/yakcc-resolve-tool.ts` — mirror of hooks-cursor counterpart | S | none | W1 | imports from `@yakcc/hooks-base` + `@yakcc/registry` |
| W4 | `packages/hooks-windsurf/src/index.props.ts` + `index.props.test.ts` — mirror of hooks-cursor props (6 marker + 3 threshold + 6 factory properties) | M | none | W2 | none |
| W5 | `packages/hooks-windsurf/test/index.test.ts` + `yakcc-resolve-tool.test.ts` + `adapter-telemetry.test.ts` — mirror of hooks-cursor integration tests | M | none | W2, W3 | reads `@yakcc/hooks-base` test seam |
| W6 | `packages/cli/src/commands/hooks-windsurf-install.ts` — mirror of `hooks-cursor-install.ts`; brand swap (`.windsurf/`, `WINDSURF_SESSION_ID`, sentinel `yakcc-hook-v1-windsurf`) | M | none | W2 | imports from `../index.js` Logger |
| W7 | `packages/cli/src/lib/ide-detect.ts` — extend `IdeName` union, `KNOWN_IDE_NAMES`, `buildCandidatePaths` switch | S | none | — | sole IDE identity registry |
| W8 | `packages/cli/src/lib/ide-detect.test.ts` — update `KNOWN_IDE_NAMES` assertion (4→5 entries), update result-order assertion to include windsurf, add windsurf-positive probe test | S | none | W7 | — |
| W9 | `packages/cli/src/commands/init.ts` — import installer, add `windsurf` switch case, update usage text | S | none | W6, W7 | calls `hooksWindsurfInstall` |
| W10 | `packages/cli/src/commands/uninstall.ts` — import installer, add `windsurf` switch case, update usage text | S | none | W6, W7 | calls `hooksWindsurfInstall(["--uninstall"], ...)` |
| W11 | `packages/cli/test/integration/hooks-lifecycle.test.ts` — extend `SENTINELS`, `ADAPTERS`, `HOME_SENTINEL_PATHS`, `seedDetectProbe`, `hookArtefactPath`, `isYakccMarkerPresent`, `preSeedSiblingContent` | M | none | W6, W7, W9, W10 | the certification authority |
| W12 | Build + test verification (`pnpm install`, then per-filter tests in order) | S | review | W1-W11 | Evaluation Contract |

**Critical path**: W1 → W2 → (W3, W4, W5, W6) → W7 → W8 → W9 → W10 → W11 → W12.
**Max parallel width**: 4 (after W2: W3, W4, W5, W6 can proceed independently).
**Estimated implementer cost**: ~120 min (10 mirror-edits + 1 substantive harness extension + 1 verify pass).

---

## 4 — File-by-file diff plan

### New files (created, no prior content)

```
packages/hooks-windsurf/
  package.json                              ← copy hooks-cursor/package.json, swap name to @yakcc/hooks-windsurf
  README.md                                 ← short stub naming the adapter and referencing DEC-HOOK-WINDSURF-001
  tsconfig.json                             ← byte-identical to hooks-cursor/tsconfig.json (references contracts/hooks-base/registry)
  tsconfig.typecheck.json                   ← byte-identical (check hooks-cursor for shape; same pattern)
  vitest.config.ts                          ← byte-identical to hooks-cursor (workspace-source aliases, YAKCC_HOOK_DISABLE_INTENT_GATE=1)
  src/
    index.ts                                ← mirror hooks-cursor/src/index.ts (~272 lines); see §5 deltas
    index.props.ts                          ← mirror hooks-cursor/src/index.props.ts (~330 lines)
    index.props.test.ts                     ← mirror hooks-cursor/src/index.props.test.ts
    yakcc-resolve-tool.ts                   ← mirror hooks-cursor/src/yakcc-resolve-tool.ts (~210 lines)
  test/
    index.test.ts                           ← mirror hooks-cursor/test/index.test.ts
    yakcc-resolve-tool.test.ts              ← mirror hooks-cursor/test/yakcc-resolve-tool.test.ts
    adapter-telemetry.test.ts               ← mirror hooks-cursor/test/adapter-telemetry.test.ts

packages/cli/src/commands/hooks-windsurf-install.ts
                                            ← mirror packages/cli/src/commands/hooks-cursor-install.ts (~223 lines);
                                              brand-swap: .cursor→.windsurf, CURSOR_SESSION_ID→WINDSURF_SESSION_ID,
                                              yakcc-hook-v1-cursor→yakcc-hook-v1-windsurf,
                                              "Cursor"→"Windsurf" in human strings,
                                              DEC tag → DEC-CLI-HOOKS-WINDSURF-INSTALL-001
```

### Edited files (existing; deltas listed)

```
packages/cli/src/lib/ide-detect.ts
  - Line 46: extend IdeName union → "claude-code" | "cursor" | "cline" | "continue" | "windsurf"
  - Line 173: KNOWN_IDE_NAMES const → add "windsurf" as 5th entry
  - buildCandidatePaths() switch: add case "windsurf": return [join(home, ".windsurf")]
  - Update @decision header for the additive change (DEC-HOOK-WINDSURF-002)

packages/cli/src/lib/ide-detect.test.ts
  - KNOWN_IDE_NAMES assertion: ["claude-code", "cursor", "cline", "continue"] → +"windsurf"
  - Stable-order assertion (line 219): include "windsurf" as 5th in expected array
  - Codex-negative assertion: leave as-is (windsurf is now in, codex still out)
  - Add positive-detection test mirroring cursor/continue probe assertions

packages/cli/src/commands/init.ts
  - Line ~61: add `import { hooksWindsurfInstall } from "./hooks-windsurf-install.js";`
  - installHookForIde() switch: add case "windsurf": call hooksWindsurfInstall(["--target", targetDir], logger)
  - Line 320 usage text: --ide <claude-code|cursor|cline|continue|windsurf,...>

packages/cli/src/commands/uninstall.ts
  - Line ~42: add `import { hooksWindsurfInstall } from "./hooks-windsurf-install.js";`
  - uninstallHookForIde() switch: add case "windsurf": return hooksWindsurfInstall(["--uninstall", "--target", targetDir], logger)
  - Line 224 usage text: same as init

packages/cli/test/integration/hooks-lifecycle.test.ts
  - SENTINELS const (line 57-62): add windsurf: "yakcc-hook-v1-windsurf"
  - ADAPTERS const (line 65): append "windsurf"
  - HOME_SENTINEL_PATHS (line 82-87): add join(REAL_HOME, ".windsurf")
  - seedDetectProbe switch (line 170-186): add case "windsurf": mkdirSync(join(homeDir, ".windsurf"), { recursive: true })
  - hookArtefactPath switch (line 193-204): add case "windsurf": return join(targetDir, ".windsurf", "settings.json")
  - isYakccMarkerPresent switch (line 227-253): add case "windsurf" — same shape as cursor (hooks.yakcc._yakcc on settings.json)
  - preSeedSiblingContent switch (line 288-358): add case "windsurf" — same shape as cursor (settings + user-notes sibling)
  - normalizeForByteIdentity: windsurf falls into the cursor/claude-code branch (settings.json is deterministic) — no extra logic needed
  - cursorMarkerPath sibling: optionally add windsurfMarkerPath helper IF integration test asserts on the secondary marker; matches cursor exactly otherwise
```

### Files explicitly NOT touched (forbidden per Scope Manifest)

```
packages/hooks-base/**                   ← consumed as-is; new shared logic is out of scope
packages/hooks-claude-code/**            ← sibling adapter; do not modify
packages/hooks-cline/** (if it exists, /hooks-cline-install lives in cli only)
packages/hooks-continue/** (same — cli-only)
packages/hooks-cursor/**                 ← reference; copy from, do not edit
packages/hooks-codex/**                  ← unused IDE adapter; out of scope
packages/cli/src/commands/hooks-cursor-install.ts        ← reference for hooks-windsurf-install
packages/cli/src/commands/hooks-cline-install.ts         ← do not modify
packages/cli/src/commands/hooks-continue-install.ts      ← do not modify
packages/cli/src/commands/init.test.ts                   ← unless windsurf path uncovered triggers a test gap (see Risk R4)
packages/cli/src/commands/uninstall.test.ts              ← same as above
bench/**, docs/**, .github/**, MASTER_PLAN.md            ← out of scope
pnpm-workspace.yaml                                       ← already globs packages/*; no edit needed
```

---

## 5 — Brand-swap delta sheet (hooks-cursor → hooks-windsurf)

This is the EXACT list of substitutions the implementer applies when mirroring
`hooks-cursor` files. No other shape changes are permitted.

| Token (cursor) | Token (windsurf) |
| --- | --- |
| `@yakcc/hooks-cursor` | `@yakcc/hooks-windsurf` |
| `CursorHook` (interface name) | `WindsurfHook` |
| `CursorHookOptions` | `WindsurfHookOptions` |
| `CURSOR_COMMAND_MARKER_FILENAME` | `WINDSURF_COMMAND_MARKER_FILENAME` |
| `"yakcc-cursor-command.json"` | `"yakcc-windsurf-command.json"` |
| `CURSOR_FALLBACK_SESSION_ID` | `WINDSURF_FALLBACK_SESSION_ID` |
| `resolveCursorSessionId` | `resolveWindsurfSessionId` |
| `CURSOR_SESSION_ID` (env var) | `WINDSURF_SESSION_ID` |
| `"cursor-"` (telemetry prefix) | `"windsurf-"` |
| `.cursor` (path segment) | `.windsurf` |
| `~/.cursor` (default markerDir) | `~/.windsurf` |
| `RESOLVE_TOOL_MARKER_FILENAME = "yakcc-cursor-resolve-tool.json"` | `= "yakcc-windsurf-resolve-tool.json"` |
| `Cursor` (in human-readable strings) | `Windsurf` |
| `cursor` (in lowercase identifiers) | `windsurf` |
| `DEC-HOOK-CURSOR-001` | `DEC-HOOK-WINDSURF-001` |
| `DEC-HOOK-CURSOR-PHASE4-001` | `DEC-HOOK-WINDSURF-001-B` (single bundled decision; see §7) |
| `DEC-HOOK-CURSOR-PHASE4-002` | `DEC-HOOK-WINDSURF-001-C` |
| `DEC-CLI-HOOKS-CURSOR-INSTALL-001` | `DEC-CLI-HOOKS-WINDSURF-INSTALL-001` |
| Existing factory export `createHook` | **keep as `createHook`** — matches hooks-cursor naming exactly. (The dispatch context said `createWindsurfHook`; the reference is `createHook`. Sticking to the established convention preserves cross-adapter shape.) |

The `toolName` parameter typing `"Edit" \| "Write" \| "MultiEdit"` is unchanged
— Windsurf is VS Code-derived and uses the same operation taxonomy.

---

## 6 — Risk register

| ID | Risk | Mitigation |
| --- | --- | --- |
| R1 | `pnpm install` not run before tests — new package won't resolve from CLI | Implementer must `pnpm install` from worktree root BEFORE running any test filter. Acceptance Step 0 in EC. |
| R2 | `KNOWN_IDE_NAMES` order changes break the stable-order test in `ide-detect.test.ts` line 219 | Append windsurf as 5th — preserves existing order. Update assertion to match. |
| R3 | Hooks-lifecycle harness was 4×6=24 cases; becomes 5×6=30. Some pre/post snapshot logic may rely on adapter count implicitly | Re-read every switch in the harness; the harness already iterates `for (const adapter of ADAPTERS)` so adding a row is structurally safe. Verify no hardcoded `length === 4` assertions. (Spot check: none in current file.) |
| R4 | `init.test.ts` / `uninstall.test.ts` may have an `--ide` parse test that enumerates the 4 known IDEs and will reject `windsurf` if frozen | Search for hard-coded 4-IDE lists in those tests during implementation. If a test enumerates the union exhaustively and fails, file as a Scope Manifest expansion request before editing. The current scope FORBIDS edits to those files unless a verified gap appears. |
| R5 | `~/.windsurf` may not be the canonical Windsurf user config dir on macOS (Cursor uses `Library/Application Support/Cursor`) | Codeium's public docs and the Windsurf binary place user config at `~/.windsurf` across Linux/macOS/Windows (under `%USERPROFILE%`). If implementer discovers otherwise during verification, document in DEC-HOOK-WINDSURF-002 and adjust before guardian land. |
| R6 | Settings.json shape for Windsurf may not be VS-Code-identical (the install writes hooks.yakcc.command) | Mirror cursor's stub-marker pattern exactly. DEC-CLI-HOOKS-WINDSURF-INSTALL-001 acknowledges (per cursor analog) that Windsurf's tool-call interception API stability is the limiting factor, not our serialization. |
| R7 | Workspace dependency hoisting: hooks-windsurf depends on `@yakcc/hooks-base` workspace:* and that link must resolve | `pnpm install` from root after creating the new package handles this. Verify by `ls packages/hooks-windsurf/node_modules/@yakcc/hooks-base`. |

---

## 7 — Decision log additions

| DEC-ID | Title | Rationale |
| --- | --- | --- |
| `DEC-HOOK-WINDSURF-001` | Scaffold `@yakcc/hooks-windsurf` — full structural mirror of `@yakcc/hooks-cursor` with brand-swapped defaults | (a) Windsurf is a VS-Code-derived IDE with the same extension-host registration constraint as Cursor — the same marker-file stub pattern applies. (b) Tool-call taxonomy `"Edit" \| "Write" \| "MultiEdit"` is shared. (c) Default `markerDir` is `~/.windsurf` matching the cross-platform user config dir Codeium publishes. (d) Telemetry prefix `windsurf-` distinguishes Windsurf JSONL files from `cursor-`, `claude-code-`, etc. in shared `~/.yakcc/telemetry/`. (e) Cross-IDE threshold consistency — same `DEFAULT_REGISTRY_HIT_THRESHOLD = 0.30`. Annotate at the top of `packages/hooks-windsurf/src/index.ts`. |
| `DEC-HOOK-WINDSURF-002` | Add `"windsurf"` to `KNOWN_IDE_NAMES` and extend `IdeName` union | Single source of truth for IDE identity (DEC-687-S1-ADAPTER-COUNT). Append (not prepend) to preserve the stable-order contract `["claude-code", "cursor", "cline", "continue", "windsurf"]`. Probe path `~/.windsurf` matches Continue's home-dir pattern. Annotate at top of `packages/cli/src/lib/ide-detect.ts` (additive to existing decisions). |
| `DEC-CLI-HOOKS-WINDSURF-INSTALL-001` | `yakcc hooks windsurf install` writes `.windsurf/settings.json` hook entry + `.windsurf/yakcc-windsurf-hook.json` marker | Identical rationale to DEC-CLI-HOOKS-CURSOR-INSTALL-001: Windsurf's extension API does not expose synchronous tool-call interception via a stable Node.js API as of v1, so we write the intended wiring + a marker stub. When the API stabilises, hook activation requires no reinstall. Annotate at top of `packages/cli/src/commands/hooks-windsurf-install.ts`. |
| `DEC-687-S3-LIFECYCLE-MATRIX-EXPANSION` | hooks-lifecycle.test.ts adapter matrix grows 4 → 5 with windsurf | Per DEC-687-S1-ADAPTER-COUNT, the harness's `ADAPTERS` const IS the certification scope. Expanding to 5 keeps the certification claim true. Annotate near the existing decisions at the top of `hooks-lifecycle.test.ts`. |

---

## 8 — Evaluation Contract (executable acceptance — Guardian land gate)

A guardian-land decision MUST be backed by ALL of the following, evidenced in the
implementer/reviewer trailer.

### Required test gates (all green)

1. `cd /Users/cris/src/yakcc/.worktrees/feature-687-s3-windsurf-adapter && pnpm install` — exits 0, links `@yakcc/hooks-windsurf` into the workspace.
2. `pnpm --filter @yakcc/hooks-windsurf typecheck` — exits 0.
3. `pnpm --filter @yakcc/hooks-windsurf test` — exits 0; all property tests + integration tests pass. Expected count parity with hooks-cursor (≥15 props + the 3 integration test files).
4. `pnpm --filter @yakcc/cli typecheck` — exits 0 (catches missing import, broken IdeName union, missing switch case).
5. `pnpm --filter @yakcc/cli test` — exits 0; integration test now reports 5 adapters × 6 cases = **30 hook-lifecycle cases**, all pass. The line count of `ADAPTERS` is 5, including `"windsurf"`.
6. `pnpm -w build` — exits 0 (the workspace builds with the new package).

### Required real-path checks

7. `node -e 'import("@yakcc/hooks-windsurf").then(m => console.log(Object.keys(m)))'` from the worktree root (after build) lists at minimum: `createHook`, `WINDSURF_COMMAND_MARKER_FILENAME`, `DEFAULT_REGISTRY_HIT_THRESHOLD`, `resolveWindsurfSessionId`, `createYakccResolveTool`, `RESOLVE_TOOL_MARKER_FILENAME`.
8. `pnpm --filter @yakcc/cli exec yakcc init --target tmp/wi687s3-smoke --ide windsurf --no-seed --skip-hooks=false` (or equivalent) writes `tmp/wi687s3-smoke/.windsurf/settings.json` containing `"_yakcc": "yakcc-hook-v1-windsurf"`. Cleanup after capture.
9. `pnpm --filter @yakcc/cli exec yakcc uninstall --target tmp/wi687s3-smoke --ide windsurf` removes the marker; sibling user content (if seeded) is preserved.

### Required authority invariants

10. `grep -n "windsurf" packages/cli/src/lib/ide-detect.ts` shows `IdeName` union extended AND `KNOWN_IDE_NAMES` array includes it.
11. `grep -c "windsurf" packages/cli/src/commands/init.ts` ≥ 3 (import, switch case, usage text).
12. `grep -c "windsurf" packages/cli/src/commands/uninstall.ts` ≥ 3 (import, switch case, usage text).
13. `grep -n "windsurf" packages/cli/test/integration/hooks-lifecycle.test.ts` shows: SENTINELS entry, ADAPTERS member, HOME_SENTINEL_PATHS entry, switches in seedDetectProbe / hookArtefactPath / isYakccMarkerPresent / preSeedSiblingContent.

### Required integration points

14. The S1 hook lifecycle harness HOME sentinel guard does NOT trip (no writes to real `~/.windsurf`). If it does, the test seam was wired wrong — fix before guardian.
15. `pnpm --filter @yakcc/cli test --run lib/ide-detect.test.ts` passes — the KNOWN_IDE_NAMES + stable-order assertions are updated and green.

### Forbidden shortcuts

- Do NOT copy hooks-cursor files via `cp -r` then sed — the implementer MUST author each new file with the brand-swap delta sheet applied, so the DEC headers and references are correct from the first commit.
- Do NOT add a wildcard "windsurf-or-cursor" branch in any switch — each IDE gets its own explicit case (consistent with the established 4-adapter pattern).
- Do NOT introduce new shared logic into `@yakcc/hooks-base` in this slice. If a real shared opportunity surfaces, file a follow-up issue and proceed without it.
- Do NOT edit `init.test.ts` or `uninstall.test.ts` unless a real test failure forces it — and if so, halt and request a Scope Manifest expansion via planner.

### Ready-for-guardian definition

Reviewer may emit `REVIEW_VERDICT=ready_for_guardian` ONLY when:
- All test gates (1-6) and real-path checks (7-9) execute green on the current HEAD;
- All authority invariants (10-13) hold;
- All integration points (14-15) verified;
- No forbidden shortcuts (per above) detected;
- DEC-IDs (DEC-HOOK-WINDSURF-001, DEC-HOOK-WINDSURF-002, DEC-CLI-HOOKS-WINDSURF-INSTALL-001, DEC-687-S3-LIFECYCLE-MATRIX-EXPANSION) annotated at the correct source files;
- `git -C /Users/cris/src/yakcc/.worktrees/feature-687-s3-windsurf-adapter diff --stat origin/main..HEAD` shows ONLY the files enumerated in the Scope Manifest (no scope creep);
- `git -C /Users/cris/src/yakcc/.worktrees/feature-687-s3-windsurf-adapter fetch origin && git -C ... log --oneline origin/main..HEAD` shows a clean linear history ready for squash merge.

---

## 9 — Scope Manifest (mechanical boundary for implementer + reviewer)

**Allowed (write):**
- `packages/hooks-windsurf/**` (all new files)
- `packages/cli/src/commands/hooks-windsurf-install.ts` (new)
- `packages/cli/src/commands/init.ts` (delta: import + switch case + usage text)
- `packages/cli/src/commands/uninstall.ts` (delta: import + switch case + usage text)
- `packages/cli/src/lib/ide-detect.ts` (delta: IdeName + KNOWN_IDE_NAMES + buildCandidatePaths)
- `packages/cli/src/lib/ide-detect.test.ts` (delta: assertions updated)
- `packages/cli/test/integration/hooks-lifecycle.test.ts` (delta: matrix expansion)
- `plans/wi-687-s3-windsurf.md` (this plan file)
- `tmp/**` (transient scratch only; not committed unless explicitly part of the plan)

**Required (must be modified — implementer cannot skip):**
- All 7 source files listed in "Allowed (write)" except this plan and tmp/.
- The plan file (this file) must be committed as part of the slice.

**Forbidden (must not be touched without re-approval):**
- `packages/hooks-base/**`
- `packages/hooks-cursor/**`, `packages/hooks-claude-code/**`, `packages/hooks-codex/**`
- `packages/cli/src/commands/hooks-cursor-install.ts`, `hooks-cline-install.ts`, `hooks-continue-install.ts`, `hooks-claude-code-install.ts`
- `packages/cli/src/commands/init.test.ts`, `uninstall.test.ts` (unless R4 forces and Scope is re-amended)
- All other packages: `packages/compile/**`, `packages/contracts/**`, `packages/federation/**`, `packages/ir/**`, `packages/registry/**`, `packages/seeds/**`, `packages/shave/**`, `packages/variance/**`
- `bench/**`, `docs/**`, `.github/**`, `examples/**`, `scripts/**`, `bootstrap/**`
- `MASTER_PLAN.md` (top-level)
- `pnpm-workspace.yaml` (already globs packages/*; no edit needed)
- `pnpm-lock.yaml` may be regenerated by `pnpm install` — that is expected; commit it as part of the slice.

**Expected state authorities touched:**
- IDE identity registry (`KNOWN_IDE_NAMES`) — extended additively
- CLI install/uninstall dispatch — extended additively
- S1 lifecycle test matrix — extended additively
- New package state (hooks-windsurf) — created
- Workspace lockfile — regenerated by pnpm install

---

## 10 — Ready-for-guardian checklist (reviewer must verify)

- [ ] `pnpm install` ran cleanly from worktree root after files landed; `pnpm-lock.yaml` updated and committed.
- [ ] `pnpm --filter @yakcc/hooks-windsurf typecheck` green.
- [ ] `pnpm --filter @yakcc/hooks-windsurf test` green; test count parity with hooks-cursor.
- [ ] `pnpm --filter @yakcc/cli typecheck` green.
- [ ] `pnpm --filter @yakcc/cli test` green; hooks-lifecycle.test.ts now reports 30 cases (5 × 6).
- [ ] `pnpm -w build` green.
- [ ] Smoke test (real-path check 8 + 9) writes/removes `.windsurf/settings.json` correctly under a tmp target.
- [ ] All 4 DEC-IDs annotated at their source files.
- [ ] `git diff --stat origin/main..HEAD` shows only allowed files; no forbidden touches.
- [ ] No edits to sibling hook packages, no edits to bench/docs/.github/MASTER_PLAN.md.
- [ ] HOME sentinel guard in hooks-lifecycle.test.ts does NOT trip (no writes to real `~/.windsurf`).
- [ ] Linear history on branch ready for squash merge.

---

## 11 — Bootstrap / workflow note

Scope manifest needs to be synced to runtime before implementer dispatch:

```
cc-policy workflow scope-sync wi-687-s3-windsurf \
  --work-item-id wi-687-s3-windsurf \
  --scope-file <(jq -n '<derived from §9>')
```

(If runtime already has a stale scope row from a prior dispatch attempt, sync
overwrites it.)

---

PLAN_VERDICT: next_work_item
PLAN_SUMMARY: Plan written for WI-687-S3 (@yakcc/hooks-windsurf). Single guardian-bound work item ready; AUTO_DISPATCH implementer next per planner trailer below.
