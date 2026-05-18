# Plan — WI-687-S4 — `@yakcc/hooks-aider` adapter (6th IDE adapter)

**Workflow:** `wi-687-s4-aider-adapter`
**Goal:** `g-wi-687-s4-aider-adapter`
**Issue:** [#687](https://github.com/cneckar/yakcc/issues/687) (S4 slice — DO NOT close on this PR; S7 still pending)
**Branch / worktree:** `feature/wi-687-s4-aider-adapter` @ `aa1a48e` in `.worktrees/feature-wi-687-s4-aider-adapter/`
**Base:** `origin/main` @ `aa1a48e` (post-#738 hooks-windsurf land, post-#740 hooks-cline land)
**Tier:** 2 (Standard) — multi-file additive scaffold. Pattern is established by `hooks-cursor`/`hooks-cline`/`hooks-windsurf`. Aider's CLI-tool paradigm requires a distinct install-semantics design pass (operator's S4 callout: *"different paradigm; needs design"*).

---

## 1 — Problem statement and goals

### Problem statement

Per DEC-WI687-SLICING-001 (operator, #687 comment 2026-05-18 15:16Z), the active sequence is `S1 → S2+S3 → S4 → S7`. S1 (lifecycle harness), S2 (hooks-cline, PR #740), and S3 (hooks-windsurf, PR #738) have all landed on `main`. The CLI's IDE-identity universe (`KNOWN_IDE_NAMES`) currently lists five adapters: `claude-code`, `cursor`, `cline`, `continue`, `windsurf`. **Aider (https://aider.chat) is missing**, even though it is one of the most-used AI coding tools and was named explicitly in the parent issue body (Track B #2).

Aider is materially different from every adapter shipped so far:

- It is a **CLI tool**, not a VS Code (or VS Code-derived) extension. There is no `~/.aider/settings.json` and no extension-host registration surface.
- Its configuration lives in `.aider.conf.yml` (YAML) at the project root or `~/.aider.conf.yml` in the user's home.
- It exposes hook surfaces via CLI flags: `--lint-cmd "<cmd>"` and `--test-cmd "<cmd>"`. These are the closest analog to a "tool-call interception" surface — they fire after an edit, before the next chat turn.
- Aider auto-creates `~/.aider/` at runtime to store chat history and cache. Its existence is the cleanest IDE-detect signal.

Without a `@yakcc/hooks-aider` package + CLI wiring, a yakcc user on Aider cannot install the hook with `yakcc init --ide aider`, and the certified lifecycle matrix in `hooks-lifecycle.test.ts` has no row for Aider.

### Goals

1. Create `@yakcc/hooks-aider` package as a **structural mirror of `@yakcc/hooks-cline`** (the closest analog: marker-file-only adapter, no extension-host settings.json wiring). Cline and Aider both ship marker-file-style adapters because neither IDE exposes synchronous Node-callable interception.
2. Wire Aider into the CLI's three authority surfaces: `lib/ide-detect.ts` (the canonical IDE registry — extend `IdeName` union + `KNOWN_IDE_NAMES` + `buildCandidatePaths`), `commands/init.ts` (installer dispatch switch), `commands/uninstall.ts` (uninstaller dispatch switch).
3. Extend the S1 hook-lifecycle harness (`packages/cli/test/integration/hooks-lifecycle.test.ts`) so its `ADAPTERS` matrix grows from **5 → 6** adapters. 6 it-blocks per adapter × 6 adapters = **36 lifecycle cases** (was 30 after S3 landed).
4. Regenerate `pnpm-lock.yaml` so the new workspace package resolves (lesson from PR #738 lockfile fix).
5. Apply `pnpm --filter @yakcc/cli exec biome format --write src/` to all touched CLI source files (lesson from PR #738 format failure).

### Non-goals

- No new shared logic in `@yakcc/hooks-base`. Re-export only, as cline/windsurf do.
- No edits to sibling adapter packages (`hooks-cursor`, `hooks-cline`, `hooks-windsurf`, `hooks-claude-code`, `hooks-codex`). They are read-only references.
- No live `--lint-cmd` / `--test-cmd` activation in Aider this slice. The marker file documents the intent (parallel to cline's `DEC-CLI-HOOKS-CLINE-INSTALL-001` rationale); a follow-up WI can activate real wiring when we decide the YAML-mutation contract.
- No `.aider.conf.yml` parsing/mutation. The risk of YAML byte-identity violation under round-trip is real, and avoiding it keeps S4 in the same shape as S2/S3.
- No edits to `init.test.ts` or `uninstall.test.ts` — they only have hard-coded 4-IDE assertions if any, and the established pattern (per S3) is to extend the lifecycle test, not the unit tests.
- No closing of #687 in the PR description. Use `refs #687`. S7 (init auto-detect integration) is the slice that closes it.
- No bench/docs/.github/MASTER_PLAN.md edits beyond the one MASTER_PLAN.md row addition this plan owns.
- No S5 (Antigravity) or S6 (OpenClaw) work — dropped per DEC-WI687-SLICING-001.

### Dominant constraints

- **Aider paradigm differs.** Mirror the CLINE shape, not the windsurf shape. Cline writes a marker file to a homedir-relative path (`~/.config/cline/yakcc-cline-hook.json`); Aider writes a marker file to `~/.aider/yakcc-aider-hook.json`. There is no `.aider/settings.json` to mutate, no `_yakcc` sentinel injected into a settings hooks-object.
- **`KNOWN_IDE_NAMES` is the SINGLE SOURCE OF TRUTH** for IDE identity (DEC-687-S1-ADAPTER-COUNT). Adding `"aider"` requires atomically updating the union type, the const array, `buildCandidatePaths`, the init switch, the uninstall switch, and the lifecycle test matrix.
- **Land via PR, not Guardian-merge** (memory `feedback_pr_not_guardian_merge.md`).
- **Full-workspace lint/typecheck**, never `--filter`-scoped (memory `feedback_eval_contract_match_ci_checks.md`).
- **Write plan + scope INSIDE worktree** (memory `feedback_planner_writes_to_wrong_cwd.md`).
- **Biome format before commit** (memory: PR #738 lesson — biome failed CI; PR #740 had the same risk).
- **Lockfile commit is required** when adding a new workspace package (memory: PRs #738/#740 lockfile fixes).

---

## 2 — Architecture: state-authority map

### State / authority table

| State / fact | Canonical authority | New row for aider |
| --- | --- | --- |
| IDE identity universe | `packages/cli/src/lib/ide-detect.ts` → `IdeName` union + `KNOWN_IDE_NAMES` const | append `"aider"` (6th entry) to BOTH; preserve stable order |
| IDE detection probe paths | `packages/cli/src/lib/ide-detect.ts` → `buildCandidatePaths()` returned record | add `aider: [join(home, ".aider")]` (Aider auto-creates `~/.aider/` on first run) |
| Install dispatch | `packages/cli/src/commands/init.ts` → `installHookForIde()` switch | add `case "aider":` calling `hooksAiderInstall([], logger, join(home, ".aider"))` — mirrors cline pattern (passes homedir-derived dir, not `--target <targetDir>`) |
| Uninstall dispatch | `packages/cli/src/commands/uninstall.ts` → `uninstallHookForIde()` switch | add `case "aider":` calling `hooksAiderInstall(["--uninstall"], logger, join(home, ".aider"))` |
| Per-IDE CLI installer | `packages/cli/src/commands/hooks-<ide>-install.ts` | new `hooks-aider-install.ts` — **mirror `hooks-cline-install.ts` verbatim** with aider brand-swap |
| Adapter runtime package | `@yakcc/hooks-<ide>` package | new `packages/hooks-aider/` — **mirror `packages/hooks-cline/`** with aider brand-swap |
| Lifecycle test matrix | `packages/cli/test/integration/hooks-lifecycle.test.ts` → `SENTINELS`, `ADAPTERS`, `HOME_SENTINEL_PATHS`, switches in `seedDetectProbe` / `hookArtefactPath` / `isYakccMarkerPresent` / `normalizeForByteIdentity` / `preSeedSiblingContent` | append `aider` row to every switch and every const |
| Telemetry filename prefix | per-adapter `resolveAiderSessionId()` in `packages/hooks-aider/src/index.ts` | `aider-<id>` |
| CLI install marker sentinel | per-installer `YAKCC_<IDE>_MARKER` constant in `hooks-<ide>-install.ts` | `"yakcc-hook-v1-aider"` |
| Workspace lockfile | `pnpm-lock.yaml` at repo root | regenerated by `pnpm install` after new package is created |

### State-authority invariants (do not violate)

- Adding a new IDE without updating `KNOWN_IDE_NAMES` would create a parallel identity registry — denied.
- Adding a new IDE without updating BOTH `installHookForIde` AND `uninstallHookForIde` switches would leave init silently no-op on `--ide aider` (TypeScript exhaustiveness would also catch this) and break the symmetric off-switch contract — denied.
- Adding a new IDE without extending the S1 lifecycle harness would mean the certified round-trip claim "all installed adapters round-trip cleanly" stops being true — denied. The harness's `ADAPTERS` const IS the certification scope.
- The CLI install marker (`yakcc-aider-hook.json`, sentinel `yakcc-hook-v1-aider`) MUST be owned by `hooks-aider-install.ts` (CLI side). The adapter's `registerCommand()` writes a SEPARATE marker (`yakcc-aider-command.json`, no `_yakcc` sentinel) — mirrors the cline two-marker cohabitation contract (`DEC-HOOK-CLINE-MARKER-NAMESPACE`).
- No cross-adapter import: `@yakcc/hooks-aider` MUST NOT import from `@yakcc/hooks-cursor`, `@yakcc/hooks-cline`, `@yakcc/hooks-windsurf`, `@yakcc/hooks-claude-code`, `@yakcc/hooks-codex`. Only `@yakcc/hooks-base`, `@yakcc/registry`, `@yakcc/contracts`, and `node:*` builtins are allowed.

### Aider-specific defaults (single source: `hooks-aider` package + `hooks-aider-install`)

| Constant | Value | Rationale |
| --- | --- | --- |
| `AIDER_COMMAND_MARKER_FILENAME` (runtime adapter) | `"yakcc-aider-command.json"` | Matches cline pattern; runtime-side stub, no sentinel |
| `AIDER_HOOK_MARKER_FILENAME` (CLI installer) | `"yakcc-aider-hook.json"` | Matches cline pattern; CLI install marker, carries sentinel |
| `YAKCC_AIDER_MARKER` (sentinel) | `"yakcc-hook-v1-aider"` | Matches cline pattern (`yakcc-hook-v1-<ide>`) |
| Default `markerDir` | `join(homedir(), ".aider")` | Aider auto-creates `~/.aider/` to store chat history; cross-platform (Linux/macOS/Windows under `%USERPROFILE%`) per Aider's docs |
| Session env var | `AIDER_SESSION_ID` | Aider doesn't expose a session id today; reserved env name follows the cline `CLINE_SESSION_ID` convention for future activation |
| Session prefix | `"aider-"` | Telemetry file `aider-<id>.jsonl` distinguishes from cursor/cline/continue/windsurf/claude-code in shared `~/.yakcc/telemetry/` |
| IDE-detect probe path | `[join(home, ".aider")]` | Single probe; Aider's `~/.aider/` is the canonical config/history dir |
| `RESOLVE_TOOL_MARKER_FILENAME` | `"yakcc-aider-resolve-tool.json"` | Matches cline `"yakcc-cline-resolve-tool.json"` pattern |
| Hook subprocess command | `"yakcc hook-intercept"` | Same as every adapter — single shared subprocess command |
| Aider-side marker `note` field | "Aider (CLI tool) exposes hook surfaces via `--lint-cmd` and `--test-cmd` flags on `.aider.conf.yml`. This marker documents the intended wiring (DEC-CLI-HOOKS-AIDER-INSTALL-001). Direct YAML mutation of `.aider.conf.yml` is deferred to a follow-up WI to preserve byte-identity round-trip semantics. When the wiring is activated, hook activation requires no reinstall." | Documents the Aider-specific paradigm and the YAML deferral |

### Why mirror cline (NOT windsurf)

Windsurf is VS Code-derived: it has an extension-host settings.json file (`.windsurf/settings.json`) that yakcc can write a hooks-object into. Aider has no such file. The cline adapter is the closer analog because:

1. **No extension settings.json** — Aider writes nothing of its own to `.aider/settings.json`. The cline installer doesn't either; both write a homedir-relative marker file in `~/.config/cline/` / `~/.aider/`.
2. **Hook artefact lives in homedir, not target dir** — Aider's `~/.aider/` is where chat history and cache go; the marker file co-locates with that. In the lifecycle test, `hookArtefactPath("aider", ...)` returns `join(homeDir, ".aider", "yakcc-aider-hook.json")` — mirroring cline's `join(homeDir, ".config", "cline", "yakcc-cline-hook.json")`.
3. **`normalizeForByteIdentity` treats aider like cline/continue** — strips `installedAt` from the JSON marker before comparison. Windsurf treats settings.json as deterministic (no installedAt field).
4. **Init dispatch passes homedir-derived dir, not `--target`** — `case "aider":` in `installHookForIde` follows cline/continue pattern: `hooksAiderInstall([], logger, join(home, ".aider"))`. Windsurf, by contrast, passes `["--target", targetDir]`.

### Alternatives considered

- **Alternative A: mirror windsurf (write `.aider/settings.json` hooks-object into a target-dir tree).** Rejected. Aider is a CLI tool, not an extension host. There is no `.aider/` directory inside a target project (only in homedir, and only after Aider runs there). Writing a settings.json into a target project dir would be a yakcc invention with no production consumer; the marker-file pattern (cline/continue) is faithful to Aider's actual surface.
- **Alternative B: mutate `.aider.conf.yml` to add `lint-cmd: yakcc hook-intercept`.** Rejected for this slice. YAML byte-identity under round-trip is fragile (key ordering, comments, anchors). The cline/continue pattern (marker file + `installedAt` strip in `normalizeForByteIdentity`) is well-established and avoids the YAML round-trip problem. A follow-up WI can add YAML mutation behind a feature flag once the byte-identity contract is designed.
- **Alternative C: skip property tests for this slice.** Rejected. Cline ships them (`index.props.ts` + `index.props.test.ts`); parity is non-negotiable per the established pattern.

No Alternatives Gate required for user — all alternatives collapse to "mirror cline."

### Research

Source-of-truth review performed by reading:

- `packages/hooks-cline/{package.json,tsconfig.json,tsconfig.typecheck.json,vitest.config.ts,src/index.ts,src/yakcc-resolve-tool.ts,src/index.props.ts}` — full adapter shape (mirror target).
- `packages/hooks-cline/test/{index.test.ts,adapter-telemetry.test.ts,yakcc-resolve-tool.test.ts}` — test parity targets (read first 30 lines of `index.test.ts` for shape; full files reviewed during implementation).
- `packages/hooks-windsurf/` — confirmed it's the same shape but with windsurf-specific brand swap and settings.json-based install (not the cline marker pattern). Confirms cline is the closer mirror for aider.
- `packages/cli/src/commands/hooks-cline-install.ts` (185 LOC) — CLI installer mirror target.
- `packages/cli/src/commands/hooks-continue-install.ts` (183 LOC) — confirms the marker-only pattern for CLI-tool adapters.
- `packages/cli/src/lib/ide-detect.ts` — current IDE registry post-S3 (5 adapters; `windsurf` is appended).
- `packages/cli/src/commands/init.ts` — current `installHookForIde` switch (5 cases post-S3).
- `packages/cli/src/commands/uninstall.ts` — current `uninstallHookForIde` switch (5 cases post-S3).
- `packages/cli/test/integration/hooks-lifecycle.test.ts` (597 LOC) — confirms current matrix is 5 adapters × 6 it-blocks = **30 cases today** (the dispatch context's "5 × 6 = 30" was correct as a pre-aider count; post-aider becomes 6 × 6 = **36**).
- `plans/wi-687-s2-cline.md` and `plans/wi-687-s3-windsurf.md` — prior plan shape and Evaluation Contract patterns.
- Issue #687 body + DEC-WI687-SLICING-001 comment + the orchestrator audit comment chain — verified S4 is next per operator authorization.

No external CLI research needed (Aider's `.aider.conf.yml`/`--lint-cmd`/`--test-cmd` surface is public and documented at https://aider.chat). The marker-file-stub strategy mirrors cline/continue and is the chosen path per the Alternatives section above.

---

## 3 — Wave decomposition

Single guardian-bound slice. The work is mechanical (mirror + brand-swap) once the design decisions in §2 are accepted.

| W-ID | Title | Weight | Gate | Deps | Integration surfaces |
| --- | --- | --- | --- | --- | --- |
| W-S4-0 | Write plan (this file) + scope JSON + MASTER_PLAN.md row | S | none | — | `plans/`, `tmp/scope-*.json`, `MASTER_PLAN.md` |
| W-S4-1 | `packages/hooks-aider/` skeleton: `package.json`, `tsconfig.json`, `tsconfig.typecheck.json`, `vitest.config.ts`, optional `README.md` | S | none | W-S4-0 | new dir; pnpm workspace globs `packages/*` auto-picks |
| W-S4-2 | `packages/hooks-aider/src/index.ts` — mirror `hooks-cline/src/index.ts` (252 LOC); brand-swap `cline → aider`, `Cline → Aider`, `CLINE_ → AIDER_`, `.config/cline → .aider`, `cline- → aider-`, `CLINE_SESSION_ID → AIDER_SESSION_ID`, `DEC-HOOK-CLINE-001 → DEC-HOOK-AIDER-001` | M | none | W-S4-1 | imports `@yakcc/hooks-base` |
| W-S4-3 | `packages/hooks-aider/src/yakcc-resolve-tool.ts` — mirror `hooks-cline/src/yakcc-resolve-tool.ts`; brand-swap | S | none | W-S4-1 | imports `@yakcc/hooks-base` + `@yakcc/registry` |
| W-S4-4 | `packages/hooks-aider/src/index.props.ts` + `index.props.test.ts` — mirror `hooks-cline/src/index.props.*`; brand-swap; rename property functions `prop_cline*` → `prop_aider*`, swap marker filename assertions to `"yakcc-aider-command.json"` and `"aider"` substring assertion | M | none | W-S4-2 | none |
| W-S4-5 | `packages/cli/src/commands/hooks-aider-install.ts` — mirror `hooks-cline-install.ts` (185 LOC); brand-swap `cline → aider`, sentinel `yakcc-hook-v1-cline → yakcc-hook-v1-aider`, env var `CLINE_SESSION_ID → AIDER_SESSION_ID`, default dir `~/.config/cline → ~/.aider`, marker filename `yakcc-cline-hook.json → yakcc-aider-hook.json`, note text per §2 (Aider CLI paradigm), `DEC-CLI-HOOKS-CLINE-INSTALL-001 → DEC-CLI-HOOKS-AIDER-INSTALL-001` | M | none | — | imports `Logger` from `../index.js` |
| W-S4-6 | `packages/cli/src/lib/ide-detect.ts` — extend `IdeName` union (append `\| "aider"`), extend `KNOWN_IDE_NAMES` const (append `"aider"`), extend `buildCandidatePaths` return object (add `aider: [join(home, ".aider")]`), update header `@decision` comment to include aider | S | none | — | sole IDE identity registry |
| W-S4-7 | `packages/cli/src/commands/init.ts` — add `import { hooksAiderInstall } from "./hooks-aider-install.js";`, add `case "aider":` switch arm in `installHookForIde()` (mirror cline pattern — pass `join(home, ".aider")` as the override dir), update usage text `--ide <claude-code\|cursor\|cline\|continue\|windsurf\|aider,...>` | S | none | W-S4-5, W-S4-6 | dispatch table extension |
| W-S4-8 | `packages/cli/src/commands/uninstall.ts` — add `import { hooksAiderInstall } from "./hooks-aider-install.js";`, add `case "aider":` switch arm in `uninstallHookForIde()` (pass `["--uninstall"]` + `join(home, ".aider")`), update usage text | S | none | W-S4-5, W-S4-6 | dispatch table extension |
| W-S4-8b | `packages/cli/src/index.ts` — add `import { hooksAiderInstall } from "./commands/hooks-aider-install.js";`; add `if (subcommand === "aider") { const [hooksSub, ...hooksRest] = rest; if (hooksSub === "install") { return hooksAiderInstall(hooksRest, logger); } ...error... }` to the `case "hooks":` block; extend the trailing fallback error message to include `aider` (matches windsurf precedent — verified at planning time, see Risk R4) | S | none | W-S4-5 | top-level CLI verb dispatch |
| W-S4-9 | `packages/cli/test/integration/hooks-lifecycle.test.ts` — extend `SENTINELS` (add `aider: "yakcc-hook-v1-aider"`), extend `ADAPTERS` (append `"aider"`), extend `HOME_SENTINEL_PATHS` (add `join(REAL_HOME, ".aider")`), extend `seedDetectProbe` switch (mkdir `homeDir/.aider`), extend `hookArtefactPath` switch (return `join(homeDir, ".aider", "yakcc-aider-hook.json")`), extend `isYakccMarkerPresent` switch (aider falls into the `cline\|continue` branch — `obj._yakcc === sentinel`), confirm `normalizeForByteIdentity` covers aider in the cline/continue branch (add `aider` to the `if (adapter === "cline" || adapter === "continue" \|\| adapter === "aider")` condition), extend `preSeedSiblingContent` switch (mirror cline's pattern: write `homeDir/.aider/user-notes.json`), update `DEC-687-S1-ADAPTER-COUNT` header to reflect 6 adapters | M | none | W-S4-5..W-S4-8 | certification authority |
| W-S4-10 | `pnpm install` from worktree root — regenerate `pnpm-lock.yaml`; commit the lockfile delta | S | none | W-S4-1..W-S4-2 | workspace state |
| W-S4-11 | `pnpm --filter @yakcc/cli exec biome format --write src/` (or `pnpm format`) — apply biome to all touched CLI source files | S | none | W-S4-5..W-S4-8 | code-style normalization (per #738 lesson) |
| W-S4-12 | Full verification pass: `pnpm -w lint`, `pnpm -w typecheck`, `pnpm -F @yakcc/cli test`, `pnpm -F @yakcc/hooks-aider test`, `pnpm -w build`, real-path smoke (`yakcc init --ide aider` → marker exists → `yakcc uninstall --ide aider` → marker gone) | S | reviewer | W-S4-1..W-S4-11 | Evaluation Contract |

**Critical path:** W-S4-0 → W-S4-1 → (W-S4-2 ∥ W-S4-5 ∥ W-S4-6) → (W-S4-3 ∥ W-S4-4 ∥ W-S4-7 ∥ W-S4-8) → W-S4-9 → W-S4-10 → W-S4-11 → W-S4-12.
**Max parallel width:** 4.
**Estimated implementer cost:** ~90–120 min (mostly mechanical mirror + brand-swap; 1 substantive harness extension; 1 lockfile regen; 1 biome pass; 1 verify pass).

### Suggested per-edit commit boundaries

| Commit | Scope | Files |
| --- | --- | --- |
| C1 | Plan + scope JSON + MASTER_PLAN.md row | `plans/wi-687-s4-aider-adapter.md`, `tmp/scope-wi-687-s4-aider-adapter.json`, `MASTER_PLAN.md` |
| C2 | Adapter package scaffold | `packages/hooks-aider/{package.json,tsconfig.json,tsconfig.typecheck.json,vitest.config.ts,src/index.ts,src/yakcc-resolve-tool.ts,src/index.props.ts,src/index.props.test.ts}` |
| C3 | CLI wiring | `packages/cli/src/commands/hooks-aider-install.ts`, `packages/cli/src/lib/ide-detect.ts`, `packages/cli/src/commands/init.ts`, `packages/cli/src/commands/uninstall.ts` |
| C4 | Test extension + lockfile + biome format | `packages/cli/test/integration/hooks-lifecycle.test.ts`, `pnpm-lock.yaml`, any biome-formatted source files |

The implementer MAY collapse C2+C3+C4 into a single commit if the verify pass is clean — the boundaries are guidance for staging, not a hard requirement.

---

## 4 — File-by-file diff plan

### New files (created, no prior content)

```
packages/hooks-aider/
  package.json                              ← copy hooks-cline/package.json; swap "@yakcc/hooks-cline" → "@yakcc/hooks-aider"
  tsconfig.json                             ← byte-identical to hooks-cline/tsconfig.json (refs contracts/hooks-base/registry)
  tsconfig.typecheck.json                   ← byte-identical to hooks-cline/tsconfig.typecheck.json
  vitest.config.ts                          ← byte-identical to hooks-cline/vitest.config.ts (workspace aliases + YAKCC_HOOK_DISABLE_INTENT_GATE=1)
  src/
    index.ts                                ← mirror hooks-cline/src/index.ts (252 LOC); brand-swap per §3 W-S4-2 row; `@decision DEC-HOOK-AIDER-001` at top
    yakcc-resolve-tool.ts                   ← mirror hooks-cline/src/yakcc-resolve-tool.ts; brand-swap; `@decision DEC-HOOK-AIDER-002` at top
    index.props.ts                          ← mirror hooks-cline/src/index.props.ts (292 LOC); rename `prop_cline*` → `prop_aider*`, swap marker filename + "aider" substring assertion
    index.props.test.ts                     ← mirror hooks-cline/src/index.props.test.ts (vitest harness)
  README.md                                 ← (optional) short stub naming the adapter and referencing DEC-HOOK-AIDER-001

packages/cli/src/commands/hooks-aider-install.ts
                                            ← mirror packages/cli/src/commands/hooks-cline-install.ts (185 LOC);
                                              brand-swap: cline→aider in every identifier, sentinel→yakcc-hook-v1-aider,
                                              env var→AIDER_SESSION_ID, default dir→~/.aider,
                                              marker filename→yakcc-aider-hook.json,
                                              `note` text per §2 (Aider CLI tool paradigm),
                                              `@decision DEC-CLI-HOOKS-AIDER-INSTALL-001`
```

### Edited files (existing; deltas listed)

```
packages/cli/src/lib/ide-detect.ts
  - Line 47: extend IdeName union → "claude-code" | "cursor" | "cline" | "continue" | "windsurf" | "aider"
  - Update docstring above IdeName (line 36-46): add "aider": "Aider CLI tool (https://aider.chat)"
  - Lines 116-118: insert aiderCandidates block:
      // Aider (https://aider.chat): `~/.aider/` on all platforms. Aider is a CLI tool that
      // auto-creates this directory on first run to store chat history and cache.
      const aiderCandidates: string[] = [join(home, ".aider")];
  - Line 120-126: add `aider: aiderCandidates,` to the returned object
  - Line 179-185: append `"aider",` as the 6th entry of KNOWN_IDE_NAMES
  - Line 152-153 docstring (`Order is stable: claude-code, cursor, cline, continue.`): update to include "windsurf, aider"

packages/cli/src/commands/init.ts
  - Line ~65 (after hooksWindsurfInstall import): add
      import { hooksAiderInstall } from "./hooks-aider-install.js";
  - installHookForIde() switch (after windsurf case at line 225-229): add
      case "aider": {
        const { join } = await import("node:path");
        const aiderDir = join(home, ".aider");
        const code = await hooksAiderInstall([], logger, aiderDir);
        if (code !== 0) throw new Error(`aider hook install failed (exit ${code})`);
        break;
      }
  - Line 326 usage text in catch block (error message): update --ide list to
      "[--ide <claude-code|cursor|cline|continue|windsurf|aider,...>] [--no-seed]"

packages/cli/src/commands/uninstall.ts
  - Line ~44 (after hooksWindsurfInstall import): add
      import { hooksAiderInstall } from "./hooks-aider-install.js";
  - uninstallHookForIde() switch (after windsurf case at line 158-159): add
      case "aider":
        return hooksAiderInstall(["--uninstall"], logger, join(home, ".aider"));
  - Line 227 usage text (error message): update --ide list to
      "[--ide <claude-code|cursor|cline|continue|windsurf|aider,...>]"

packages/cli/src/index.ts
  - Line ~43 (after hooksWindsurfInstall import): add
      import { hooksAiderInstall } from "./commands/hooks-aider-install.js";
  - Inside `case "hooks":` block (after windsurf at line 321-330): add
      if (subcommand === "aider") {
        const [hooksSub, ...hooksRest] = rest;
        if (hooksSub === "install") {
          return hooksAiderInstall(hooksRest, logger);
        }
        logger.error(
          `error: unknown hooks aider subcommand: ${hooksSub ?? "(none)"}. Did you mean 'hooks aider install'?`,
        );
        return 1;
      }
  - Trailing error message at line 332: extend to mention `'hooks aider install'`
  - Optional: update `printUsage` text near line 161-168 to include `yakcc hooks aider install` row.

packages/cli/test/integration/hooks-lifecycle.test.ts
  - SENTINELS const (line 57-63): add `aider: "yakcc-hook-v1-aider",` as the 6th entry
  - ADAPTERS const (line 66): append `"aider"` — becomes `["claude-code", "cursor", "cline", "continue", "windsurf", "aider"] as const`
  - HOME_SENTINEL_PATHS (line 83-89): append `join(REAL_HOME, ".aider"),`
  - seedDetectProbe switch (line 172-191): add
      case "aider":
        mkdirSync(join(homeDir, ".aider"), { recursive: true });
        break;
  - hookArtefactPath switch (line 198-211): add
      case "aider":
        return join(homeDir, ".aider", "yakcc-aider-hook.json");
  - isYakccMarkerPresent switch (line 234-261): add `aider` to the `case "cline": case "continue":` arm so it shares the `obj._yakcc === sentinel` branch (becomes `case "cline": case "continue": case "aider":`)
  - normalizeForByteIdentity (line 270-280): update the `if (adapter === "cline" || adapter === "continue")` condition to include aider:
      if (adapter === "cline" || adapter === "continue" || adapter === "aider") {
    Update the closing comment (line 276-279) to mention aider.
  - preSeedSiblingContent switch (line 296-384): add
      case "aider": {
        const aiderDir = join(homeDir, ".aider");
        mkdirSync(aiderDir, { recursive: true });
        const notesPath = join(aiderDir, "user-notes.json");
        writeFileSync(notesPath, `${JSON.stringify({ note: "aider user notes" }, null, 2)}\n`, "utf-8");
        return {
          paths: [notesPath],
          capture: () => ({ notes: readFileSync(notesPath, "utf-8") }),
        };
      }
  - Update @decision header DEC-687-S1-ADAPTER-COUNT (line 5-19): add aider to the adapter list and bump count from 5 → 6; preserve historical "amended (WI-687-S3)" line and add "amended (WI-687-S4 adds aider)"

pnpm-lock.yaml
  - Regenerated by `pnpm install` from worktree root after packages/hooks-aider/ exists. Will add the new workspace package entry and update internal workspace links. Commit the delta as part of C4.

MASTER_PLAN.md
  - Append one new initiative row under `## Active Initiatives` (after WI-703 block at line 2214-2236) describing this slice; one Decision Log row for DEC-HOOK-AIDER-001 / DEC-CLI-HOOKS-AIDER-INSTALL-001 / DEC-687-S4-LIFECYCLE-MATRIX-EXPANSION (see §7).
```

### Files explicitly NOT touched (forbidden per Scope Manifest)

```
packages/hooks-base/**                     ← consumed as-is; new shared logic is out of scope
packages/hooks-cursor/**                   ← reference; copy from, do not edit
packages/hooks-cline/**                    ← reference; copy from, do not edit
packages/hooks-windsurf/**                 ← reference; copy from, do not edit
packages/hooks-claude-code/**              ← sibling; do not edit
packages/hooks-codex/**                    ← unused IDE adapter; out of scope
packages/cli/src/commands/hooks-cursor-install.ts        ← reference
packages/cli/src/commands/hooks-cline-install.ts         ← reference (mirror target)
packages/cli/src/commands/hooks-continue-install.ts      ← reference
packages/cli/src/commands/hooks-windsurf-install.ts      ← reference
packages/cli/src/commands/hooks-install.ts               ← claude-code installer; do not edit
packages/cli/src/commands/init.test.ts                   ← unless an aider-uncovered case triggers a hard test failure (see Risk R3)
packages/cli/src/commands/uninstall.test.ts              ← same as above
packages/cli/src/lib/ide-detect.test.ts                  ← may need a 1-line `KNOWN_IDE_NAMES.length === 6` assertion bump IF such an assertion exists; verify before editing. The Scope Manifest lists this as allowed (necessary defensive widening) but only edit if a test fails.
packages/cli/src/index.ts                                ← unless a new `yakcc hooks aider install` verb is wired (the dispatch context lists it; verify if it's truly required for the lifecycle test to pass — see Risk R4)
packages/contracts/**, packages/registry/**, packages/compile/**, packages/shave/**, packages/ir/**, packages/federation/**, packages/seeds/**, packages/variance/**
bench/**, docs/**, .github/**, examples/**, scripts/**, bootstrap/**
pnpm-workspace.yaml                                       ← already globs packages/*; no edit needed
```

---

## 5 — Brand-swap delta sheet (hooks-cline → hooks-aider)

This is the EXACT list of substitutions the implementer applies when mirroring `hooks-cline` files. No other shape changes are permitted.

| Token (cline) | Token (aider) |
| --- | --- |
| `@yakcc/hooks-cline` | `@yakcc/hooks-aider` |
| `ClineHook` (interface name) | `AiderHook` |
| `ClineHookOptions` | `AiderHookOptions` |
| `CLINE_COMMAND_MARKER_FILENAME` | `AIDER_COMMAND_MARKER_FILENAME` |
| `"yakcc-cline-command.json"` | `"yakcc-aider-command.json"` |
| `CLINE_FALLBACK_SESSION_ID` | `AIDER_FALLBACK_SESSION_ID` |
| `resolveClineSessionId` | `resolveAiderSessionId` |
| `CLINE_SESSION_ID` (env var) | `AIDER_SESSION_ID` |
| `"cline-"` (telemetry prefix) | `"aider-"` |
| `join(homedir(), ".config", "cline")` | `join(homedir(), ".aider")` |
| `~/.config/cline` (in comments/docs) | `~/.aider` |
| `RESOLVE_TOOL_MARKER_FILENAME = "yakcc-cline-resolve-tool.json"` | `= "yakcc-aider-resolve-tool.json"` |
| `Cline` (in human-readable strings) | `Aider` |
| `cline` (in lowercase identifiers and switches) | `aider` |
| `saoudrizwan.claude-dev` (in comments) | `aider CLI tool (https://aider.chat)` |
| `DEC-HOOK-CLINE-001` | `DEC-HOOK-AIDER-001` |
| `DEC-HOOK-CLINE-002` | `DEC-HOOK-AIDER-002` |
| `DEC-HOOKS-CLINE-PROPTEST-INDEX-001` | `DEC-HOOKS-AIDER-PROPTEST-INDEX-001` |
| `DEC-CLI-HOOKS-CLINE-INSTALL-001` | `DEC-CLI-HOOKS-AIDER-INSTALL-001` |
| `DEC-HOOK-CLINE-MARKER-NAMESPACE` | `DEC-HOOK-AIDER-MARKER-NAMESPACE` |
| `YAKCC_CLINE_MARKER = "yakcc-hook-v1-cline"` | `YAKCC_AIDER_MARKER = "yakcc-hook-v1-aider"` |
| `CLINE_HOOK_MARKER_FILENAME = "yakcc-cline-hook.json"` | `AIDER_HOOK_MARKER_FILENAME = "yakcc-aider-hook.json"` |
| `overrideClineDir` (function param) | `overrideAiderDir` |
| `clineDir` (local variable) | `aiderDir` |
| Note text in installer marker: "Cline (saoudrizwan.claude-dev) does not yet expose synchronous tool-call interception via a stable Node.js API. This marker documents the intended wiring (DEC-CLI-HOOKS-CLINE-INSTALL-001). When the Cline extension API stabilises, hook activation requires no reinstall." | "Aider (https://aider.chat) is a CLI tool that exposes hook surfaces via `--lint-cmd` and `--test-cmd` flags on `.aider.conf.yml`. This marker documents the intended wiring (DEC-CLI-HOOKS-AIDER-INSTALL-001). Direct YAML mutation of `.aider.conf.yml` is deferred to a follow-up WI to preserve byte-identity round-trip. When the wiring is activated, hook activation requires no reinstall." |
| Property function names: `prop_cline*` (M1-M4, F1-F6) | `prop_aider*` |
| Property test assertions: `CLINE_COMMAND_MARKER_FILENAME === "yakcc-cline-command.json"` | `AIDER_COMMAND_MARKER_FILENAME === "yakcc-aider-command.json"` |
| Property test assertion: `CLINE_COMMAND_MARKER_FILENAME.includes("cline")` | `AIDER_COMMAND_MARKER_FILENAME.includes("aider")` |
| Existing factory export `createHook` | **keep as `createHook`** — matches cline/cursor/windsurf shape (NOT renamed to `createAiderHook`) |
| `toolName: "Edit" \| "Write" \| "MultiEdit"` typing | **unchanged** — same tool taxonomy (Aider edits map to these primitives for telemetry consistency) |

---

## 6 — Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R1 | `pnpm install` not run before tests — new package won't resolve from CLI imports | M | H | Implementer MUST `pnpm install` from worktree root after creating the package and BEFORE running any test filter. Verify with `ls packages/hooks-aider/node_modules/@yakcc/hooks-base` (symlink to workspace pkg). Acceptance gate in EC. |
| R2 | `KNOWN_IDE_NAMES` stable-order assertion in `ide-detect.test.ts` (if it exists) breaks because aider is appended as 6th | L | L | Append aider as 6th — preserves existing 5-tuple order. If `ide-detect.test.ts` enumerates `["claude-code","cursor","cline","continue","windsurf"]` exhaustively, update to include `"aider"`. Scope Manifest allows this file as a defensive widen. |
| R3 | `init.test.ts` / `uninstall.test.ts` may have a `--ide` parse test that enumerates the 5 known IDEs and will reject `aider` if frozen | L | M | Search for hard-coded 5-IDE lists in those tests during implementation. If a test enumerates the union exhaustively and fails, file as a Scope Manifest expansion request and halt — the current scope FORBIDS edits to those files. |
| R4 | The dispatch context lists `packages/cli/src/index.ts` (export) as a required edit. **Planning-time grep verified inconsistent precedent**: `index.ts` has `yakcc hooks <ide> install` verbs for `claude-code`, `cursor`, and `windsurf` (lines 299, 310, 321) but NOT for `cline` or `continue`. Cline (most recent marker-file adapter) skipped the verb; windsurf (most recent settings.json adapter) added it. | M | L | **DECISION: match the windsurf precedent and ADD `yakcc hooks aider install` verb** to `packages/cli/src/index.ts` — windsurf is the most recent slice and the trajectory is toward verb-per-adapter. Add `if (subcommand === "aider") { ... return hooksAiderInstall(hooksRest, logger); ... }` to the `case "hooks"` block, and extend the error message at the end to include `aider`. Also import `hooksAiderInstall` at the top. This is now a required edit, not optional. |
| R5 | Lockfile churn — `pnpm install` regenerates `pnpm-lock.yaml` with potentially unrelated transitive bumps | M | M | Use `pnpm install --no-frozen-lockfile` and inspect the diff. The expected change is: one new workspace pkg entry + workspace links. If unrelated transitive bumps appear, run `pnpm install --frozen-lockfile=false --prefer-offline` to minimize drift, or `git checkout pnpm-lock.yaml` + targeted re-add. |
| R6 | Aider's `~/.aider/` may not exist on a fresh install before the user runs `aider` once. IDE detection probe would miss it | L | L | Same as cline (`~/.config/cline/` may not exist until Cline VS Code panel opened). The probe is config-dir existence per DEC-CLI-IDE-DETECT-SEMANTICS-001; false-negative is acceptable. User can `aider --help` once to populate, or pass `--ide aider` explicitly. Documented in installer note. |
| R7 | Biome formatter applies to .ts files and may reformat the cline/windsurf mirror in unintended ways | L | M | Run biome ONCE on the touched CLI source files (`hooks-aider-install.ts`, `init.ts`, `uninstall.ts`, `ide-detect.ts`) after the brand-swap edits. Inspect the diff; if reformat changes are extensive on existing files, scope-narrow the format command to the new file only and let pre-existing files keep their format (Risk #738 was format on a new file with wrong style). |
| R8 | `normalizeForByteIdentity` extension is subtle — adding aider to the cline/continue branch must strip `installedAt` correctly | L | M | Property test M-equivalent in hooks-aider's `index.props.ts` verifies the marker filename. Lifecycle test's idempotency case (it-block 3 "second init is idempotent") will fail if normalization is wrong — early signal. Reviewer to spot-check the boolean condition update. |
| R9 | Aider has a `.aider.conf.yml` that yakcc explicitly ignores in this slice; users may expect `yakcc init --ide aider` to actually wire `--lint-cmd` | L | L | Marker file `note` field documents the deferral verbatim per §2. Follow-up WI tracked here as a future scope; not promised in this slice. |
| R10 | `MASTER_PLAN.md` lives inside the worktree; edits here must not duplicate the row if a parallel session also writes one | L | M | Append in a single atomic commit; reviewer verifies no duplicate row before guardian. |

---

## 7 — Decision log additions

| DEC-ID | Title | Rationale |
| --- | --- | --- |
| `DEC-HOOK-AIDER-001` | Scaffold `@yakcc/hooks-aider` — structural mirror of `@yakcc/hooks-cline` with aider-specific identity (AIDER_SESSION_ID, aider- telemetry prefix, `~/.aider` markerDir, `yakcc-aider-command.json` marker). | Aider is a CLI tool (not a VS Code extension); the cline marker-file pattern is the closer analog than the cursor/windsurf settings.json pattern. Both Aider and Cline lack a Node-callable synchronous interception surface today; both ship a homedir-relative marker file as a stub for future activation. Re-exporting from `@yakcc/hooks-base` preserves cross-adapter consistency for thresholds, registry-query helpers, and telemetry. The aider-specific tokens (env var, prefix, marker name, markerDir) keep per-IDE telemetry separable across B3/B4/B5 measurement files. Annotate at the top of `packages/hooks-aider/src/index.ts`. |
| `DEC-HOOK-AIDER-002` | `yakcc_resolve` tool adapter for Aider: embedded library call, marker-file stub at `~/.aider/yakcc-aider-resolve-tool.json` | Identical pattern to DEC-HOOK-CLINE-002 / DEC-HOOK-CURSOR-PHASE4-002. Aider's CLI surface does not expose a Node-callable tool registration API; the marker file is the stub registration. `openRegistry()` from `@yakcc/registry` is called lazily on first invocation, identical to cline. Annotate at the top of `packages/hooks-aider/src/yakcc-resolve-tool.ts`. |
| `DEC-HOOK-AIDER-MARKER-NAMESPACE` | Two-marker cohabitation: `yakcc-aider-hook.json` (CLI install, with `_yakcc` sentinel) and `yakcc-aider-command.json` (runtime adapter, no sentinel) | Mirrors `DEC-HOOK-CLINE-MARKER-NAMESPACE`. The CLI install marker's sentinel is load-bearing for idempotent uninstall; the runtime adapter marker is a separate registration stub. Collapsing them would couple the CLI install path to the runtime adapter (parallel-authority violation per Sacred Practice #12). |
| `DEC-CLI-HOOKS-AIDER-INSTALL-001` | `yakcc init --ide aider` writes a marker file to `~/.aider/yakcc-aider-hook.json`; no live `--lint-cmd` / `--test-cmd` wiring yet | Aider is a CLI tool; its hook surface is `--lint-cmd` and `--test-cmd` flags on `.aider.conf.yml` (YAML). Direct YAML mutation introduces byte-identity round-trip risk (key ordering, comments, anchors); the cline marker-only pattern is the canonical S2/S4 design. The marker file documents the intended wiring; a follow-up WI can add YAML mutation behind a feature flag once the byte-identity contract is designed. Annotate at the top of `packages/cli/src/commands/hooks-aider-install.ts`. |
| `DEC-687-S4-LIFECYCLE-MATRIX-EXPANSION` | hooks-lifecycle.test.ts adapter matrix grows 5 → 6 with aider; total cases 30 → 36 (6 it-blocks × 6 adapters) | Per `DEC-687-S1-ADAPTER-COUNT`, the harness's `ADAPTERS` const IS the certification scope. Expanding to 6 keeps the certification claim true. Update the `DEC-687-S1-ADAPTER-COUNT` header in `hooks-lifecycle.test.ts` to list 6 adapters and add a line "amended (WI-687-S4 adds aider)". |

---

## 8 — Evaluation Contract (executable acceptance — Guardian readiness gate)

A guardian-land decision MUST be backed by ALL of the following, evidenced in the implementer/reviewer trailer with captured output.

### Required test gates (must all PASS on the implementer's HEAD)

1. **Workspace lockfile resolves**: `pnpm install` from worktree root — exits 0, links `@yakcc/hooks-aider` into the workspace. `ls packages/hooks-aider/node_modules/@yakcc/hooks-base` resolves to a symlink. `pnpm-lock.yaml` delta committed.
2. **Full-workspace lint (per CI parity)**: `pnpm -w lint` — exits 0. **MUST use `-w`, not `--filter`** (memory `feedback_eval_contract_match_ci_checks.md`).
3. **Full-workspace typecheck (per CI parity)**: `pnpm -w typecheck` — exits 0. **MUST use `-w`, not `--filter`**.
4. **Adapter package tests pass**: `pnpm --filter @yakcc/hooks-aider test` — exits 0; all property tests + integration tests pass. Test count parity with `hooks-cline` (allow ±10% drift only for adapter-identity assertions, e.g. "contains 'aider'" vs "contains 'cline'").
5. **Adapter package typecheck passes**: `pnpm --filter @yakcc/hooks-aider typecheck` — exits 0.
6. **Adapter package builds**: `pnpm --filter @yakcc/hooks-aider build` — produces `dist/index.js`, `dist/index.d.ts`, `dist/yakcc-resolve-tool.js`, `dist/yakcc-resolve-tool.d.ts`.
7. **CLI integration tests pass**: `pnpm --filter @yakcc/cli test` — exits 0; integration test reports 6 adapters × 6 it-blocks = **36 lifecycle cases**, all pass. The `ADAPTERS` const includes `"aider"`.
8. **Workspace build**: `pnpm -w build` — exits 0.

### Required real-path checks (smoke tests; reviewer captures output)

9. `node -e 'import("@yakcc/hooks-aider").then(m => console.log(Object.keys(m).sort()))'` from worktree root (after build) lists AT LEAST: `createHook`, `AIDER_COMMAND_MARKER_FILENAME`, `DEFAULT_REGISTRY_HIT_THRESHOLD`, `resolveAiderSessionId`, `createYakccResolveTool`, `RESOLVE_TOOL_MARKER_FILENAME`.
10. Smoke install: `pnpm --filter @yakcc/cli exec yakcc init --target tmp/wi687s4-smoke --ide aider --no-seed --skip-hooks=false` (or scripted equivalent that overrides `HOME` to `tmp/wi687s4-smoke-home`) writes `<smoke-home>/.aider/yakcc-aider-hook.json` containing `"_yakcc": "yakcc-hook-v1-aider"`. Cleanup after capture.
11. Smoke uninstall: `pnpm --filter @yakcc/cli exec yakcc uninstall --target tmp/wi687s4-smoke --ide aider` removes the marker; if a sibling `user-notes.json` was seeded, it is preserved byte-for-byte.

### Required authority invariants (mechanical grep checks)

12. `grep -n "aider" packages/cli/src/lib/ide-detect.ts` shows: `IdeName` union extended, `KNOWN_IDE_NAMES` includes it, `buildCandidatePaths` returns an `aider` entry with `~/.aider`.
13. `grep -c "aider" packages/cli/src/commands/init.ts` ≥ 3 (import, switch case, usage text).
14. `grep -c "aider" packages/cli/src/commands/uninstall.ts` ≥ 3 (import, switch case, usage text).
15. `grep -c "aider" packages/cli/src/index.ts` ≥ 3 (import, subcommand branch, trailing error message). Matches the windsurf precedent.
16. `grep -n "aider" packages/cli/test/integration/hooks-lifecycle.test.ts` shows: SENTINELS entry, ADAPTERS member, HOME_SENTINEL_PATHS entry, switches in seedDetectProbe / hookArtefactPath / isYakccMarkerPresent / normalizeForByteIdentity / preSeedSiblingContent.
17. `grep -r "from \"@yakcc/hooks-cursor\"\|from \"@yakcc/hooks-cline\"\|from \"@yakcc/hooks-windsurf\"\|from \"@yakcc/hooks-claude-code\"\|from \"@yakcc/hooks-codex\"" packages/hooks-aider/src/` returns ZERO matches (no cross-adapter imports).

### Required integration points

18. **HOME sentinel guard does NOT trip**: the lifecycle test's `afterAll` block confirms `~/.aider` existence and mtime are unchanged by the test run. If it trips, the test seam (overrideHome) was wired wrong — fix before guardian.
19. **`ide-detect.test.ts` passes** (if it has `KNOWN_IDE_NAMES.length` or order assertions): `pnpm --filter @yakcc/cli test --run lib/ide-detect.test.ts` exits 0. Reviewer verifies the assertion update is the minimal additive change.
20. **Biome format is clean**: `pnpm --filter @yakcc/cli exec biome check src/` exits 0 (or `pnpm format:check` if the workspace has such a script). No format violations on the touched files. (Lesson from PR #738.)

### Forbidden shortcuts

- Do NOT `cp -r packages/hooks-cline packages/hooks-aider` then `sed -i 's/cline/aider/g'` — the implementer MUST author each new file with the brand-swap delta sheet applied, so DEC headers, references, and the Aider-paradigm note text are correct from the first commit.
- Do NOT modify ANY sibling adapter package (`hooks-cursor`, `hooks-cline`, `hooks-windsurf`, `hooks-claude-code`, `hooks-codex`) — they are read-only references.
- Do NOT add `aider` via a wildcard "aider-or-cline" branch in any switch — each IDE gets its own explicit case, consistent with the established 5-adapter pattern.
- Do NOT introduce new shared logic into `@yakcc/hooks-base` in this slice. If a real shared opportunity surfaces, file a follow-up issue and proceed without it.
- Do NOT close #687 in the PR description. Use `refs #687`. S7 closes it.
- Do NOT use `--no-verify`, `--force`, or any history-rewrite operation.
- Do NOT mutate `.aider.conf.yml` in any code path this slice introduces (deferred per DEC-CLI-HOOKS-AIDER-INSTALL-001).
- Do NOT edit `init.test.ts` or `uninstall.test.ts` unless a real test failure forces it — and if so, halt and request a Scope Manifest expansion via planner.
- Verified at planning time (Risk R4): `packages/cli/src/index.ts` has `yakcc hooks <ide> install` verbs for `claude-code`, `cursor`, `windsurf` but NOT `cline`/`continue`. The plan MATCHES the windsurf precedent and ADDS the `yakcc hooks aider install` verb (required edit). Do NOT skip this edit.
- Do NOT skip the biome format step (lesson from PR #738).
- Do NOT use `--filter`-scoped lint/typecheck as evidence — CI runs `-w`, and `--filter` passing is necessary but not sufficient (memory `feedback_eval_contract_match_ci_checks.md`).
- Do NOT run `pnpm -r build` and expect AS-WASM cold compile to succeed (per WI-485 history; should be a non-issue since `hooks-aider` has no `@yakcc/*` deps that trigger AS-WASM, but worth stating).

### Ready-for-guardian definition

Reviewer may emit `REVIEW_VERDICT=ready_for_guardian` ONLY when:

- All test gates (1–8) and real-path checks (9–11) execute green on the current HEAD with captured output;
- All authority invariants (12–16) hold (grep audits run by reviewer);
- All integration points (17–19) verified;
- No forbidden shortcuts (per above) detected;
- DEC-IDs (`DEC-HOOK-AIDER-001`, `DEC-HOOK-AIDER-002`, `DEC-HOOK-AIDER-MARKER-NAMESPACE`, `DEC-CLI-HOOKS-AIDER-INSTALL-001`, `DEC-687-S4-LIFECYCLE-MATRIX-EXPANSION`) annotated at the correct source files;
- `git diff --stat origin/main..HEAD` shows ONLY the files enumerated in the Scope Manifest (no scope creep);
- `git fetch origin && git log --oneline origin/main..HEAD` shows a clean linear history ready for squash merge / PR land;
- `pnpm-lock.yaml` delta is minimal (1 new workspace pkg + workspace links; no unrelated transitive bumps) and committed.

---

## 9 — Scope Manifest (mechanical boundary for implementer + reviewer)

### Allowed files / directories (write)

- `plans/wi-687-s4-aider-adapter.md` (this file)
- `tmp/scope-wi-687-s4-aider-adapter.json` (canonical 5-key scope file)
- `MASTER_PLAN.md` (single row append under Active Initiatives + Decision Log row)
- `packages/hooks-aider/**` (all new files — full freedom within this subtree)
- `packages/cli/src/commands/hooks-aider-install.ts` (new)
- `packages/cli/src/commands/init.ts` (delta: import + switch case + usage text)
- `packages/cli/src/commands/uninstall.ts` (delta: import + switch case + usage text)
- `packages/cli/src/lib/ide-detect.ts` (delta: IdeName union + KNOWN_IDE_NAMES + buildCandidatePaths)
- `packages/cli/src/lib/ide-detect.test.ts` (delta: defensive widen IF an exhaustive 5-IDE assertion exists; otherwise no edit needed)
- `packages/cli/src/index.ts` (delta: REQUIRED — add `import { hooksAiderInstall } from "./commands/hooks-aider-install.js";` at top; add `if (subcommand === "aider") { ... return hooksAiderInstall(hooksRest, logger); }` to the `case "hooks":` block; extend the trailing error message to include `aider`. Matches windsurf precedent — verified at planning time, see Risk R4.)
- `packages/cli/test/integration/hooks-lifecycle.test.ts` (delta: matrix expansion per §4)
- `pnpm-lock.yaml` (regenerated by `pnpm install`)

### Required files (must be modified or created — implementer cannot skip)

- `plans/wi-687-s4-aider-adapter.md`
- `tmp/scope-wi-687-s4-aider-adapter.json`
- `packages/hooks-aider/package.json`
- `packages/hooks-aider/tsconfig.json`
- `packages/hooks-aider/tsconfig.typecheck.json`
- `packages/hooks-aider/vitest.config.ts`
- `packages/hooks-aider/src/index.ts`
- `packages/hooks-aider/src/yakcc-resolve-tool.ts`
- `packages/hooks-aider/src/index.props.ts`
- `packages/hooks-aider/src/index.props.test.ts`
- `packages/cli/src/commands/hooks-aider-install.ts`
- `packages/cli/src/commands/init.ts`
- `packages/cli/src/commands/uninstall.ts`
- `packages/cli/src/lib/ide-detect.ts`
- `packages/cli/src/index.ts`
- `packages/cli/test/integration/hooks-lifecycle.test.ts`
- `pnpm-lock.yaml`
- `MASTER_PLAN.md`

### Forbidden touch points (must NOT be changed without re-approval)

- `packages/hooks-base/**` — consumed as-is; re-export only.
- `packages/hooks-cursor/**`, `packages/hooks-cline/**`, `packages/hooks-windsurf/**`, `packages/hooks-claude-code/**`, `packages/hooks-codex/**` — sibling adapters; reference only.
- `packages/cli/src/commands/hooks-cursor-install.ts`, `hooks-cline-install.ts`, `hooks-continue-install.ts`, `hooks-windsurf-install.ts`, `hooks-install.ts` — sibling installers; reference only.
- `packages/cli/src/commands/init.test.ts`, `uninstall.test.ts` — unless R3 forces and Scope is re-amended via a planner dispatch.
- All other packages: `packages/compile/**`, `packages/contracts/**`, `packages/federation/**`, `packages/ir/**`, `packages/registry/**`, `packages/seeds/**`, `packages/shave/**`, `packages/variance/**`
- `bench/**`, `docs/**`, `.github/**`, `examples/**`, `scripts/**`, `bootstrap/**`
- `pnpm-workspace.yaml` (already globs `packages/*`; no edit needed)
- `.claude/**`, `.cursor/**`, any other agent/IDE-config dirs in the repo

### Expected state authorities touched

- `ide-identity-registry` (`KNOWN_IDE_NAMES` + `IdeName` union) — extended additively
- `cli-init-installer-dispatch` (`installHookForIde` switch) — extended additively
- `cli-uninstall-installer-dispatch` (`uninstallHookForIde` switch) — extended additively
- `hook-lifecycle-test-matrix` (`ADAPTERS` const + all per-adapter switches) — extended additively
- `hooks-aider-adapter-package` (new — owned solely by `packages/hooks-aider/`)
- `hooks-aider-cli-installer` (new — owned solely by `packages/cli/src/commands/hooks-aider-install.ts`)
- `workspace-lockfile` (`pnpm-lock.yaml`) — regenerated by `pnpm install`

---

## 10 — Ready-for-Guardian checklist (reviewer must verify)

- [ ] `plans/wi-687-s4-aider-adapter.md` exists in worktree with all sections.
- [ ] `tmp/scope-wi-687-s4-aider-adapter.json` exists with the 5 canonical keys (`allowed_paths`, `required_paths`, `forbidden_paths`, `state_authorities` — and the manifest format used by `cc-policy workflow scope-sync`).
- [ ] `MASTER_PLAN.md` has ONE new row under Active Initiatives for this WI and ONE new Decision Log row covering all DEC-IDs.
- [ ] `packages/hooks-aider/package.json` written with workspace:* deps (`@yakcc/contracts`, `@yakcc/hooks-base`, `@yakcc/registry`); devDeps (`@types/node ^22.0.0`, `vitest ^4.1.5`).
- [ ] `packages/hooks-aider/src/index.ts` written with `@decision DEC-HOOK-AIDER-001` annotation; brand-swap from cline complete; no stray "cline"/"Cline" tokens except DEC cross-refs.
- [ ] `packages/hooks-aider/src/yakcc-resolve-tool.ts` written with `@decision DEC-HOOK-AIDER-002`.
- [ ] `packages/hooks-aider/src/index.props.ts` + `.props.test.ts` written; property functions renamed `prop_aider*`.
- [ ] `packages/hooks-aider/{tsconfig.json,tsconfig.typecheck.json,vitest.config.ts}` written, byte-mirror of cline's versions modulo workspace path refs.
- [ ] `packages/cli/src/commands/hooks-aider-install.ts` written with `@decision DEC-CLI-HOOKS-AIDER-INSTALL-001`; brand-swap from cline complete; note text reflects Aider CLI paradigm.
- [ ] `packages/cli/src/lib/ide-detect.ts` extended: `IdeName` union has `"aider"`; `KNOWN_IDE_NAMES` includes it as 6th; `buildCandidatePaths` returns aider entry.
- [ ] `packages/cli/src/commands/init.ts` extended: import added, `case "aider":` in switch, usage text updated.
- [ ] `packages/cli/src/commands/uninstall.ts` extended: same shape as init.
- [ ] `packages/cli/src/index.ts` extended: import added, `if (subcommand === "aider")` arm inside `case "hooks":`, trailing error message includes `aider` (matches windsurf precedent).
- [ ] `packages/cli/test/integration/hooks-lifecycle.test.ts` extended: SENTINELS, ADAPTERS, HOME_SENTINEL_PATHS, seedDetectProbe, hookArtefactPath, isYakccMarkerPresent (adder to cline/continue arm), normalizeForByteIdentity (add aider to condition), preSeedSiblingContent, DEC header updated.
- [ ] `pnpm install` ran cleanly from worktree root after files landed; `pnpm-lock.yaml` updated and committed; delta is minimal (new workspace pkg + links only).
- [ ] Biome format applied to touched CLI source files (per #738 lesson).
- [ ] `pnpm -w lint` green (full workspace, NOT `--filter`).
- [ ] `pnpm -w typecheck` green (full workspace).
- [ ] `pnpm --filter @yakcc/hooks-aider typecheck` green.
- [ ] `pnpm --filter @yakcc/hooks-aider test` green; test count parity with hooks-cline.
- [ ] `pnpm --filter @yakcc/hooks-aider build` produces `dist/`.
- [ ] `pnpm --filter @yakcc/cli typecheck` green.
- [ ] `pnpm --filter @yakcc/cli test` green; hooks-lifecycle.test.ts reports **36 cases** (6 × 6), all pass.
- [ ] `pnpm -w build` green.
- [ ] Smoke install/uninstall under a scratch HOME directory works end-to-end (real-path checks 10 + 11).
- [ ] All 5 DEC-IDs annotated at their source files.
- [ ] `git diff --stat origin/main..HEAD` shows only allowed files; no forbidden touches.
- [ ] No edits to sibling hook packages, no edits to bench/docs/.github/examples/scripts/bootstrap.
- [ ] HOME sentinel guard in hooks-lifecycle.test.ts does NOT trip (no writes to real `~/.aider`).
- [ ] Linear history on branch ready for squash merge via PR.
- [ ] PR body uses `refs #687`, NOT `closes #687`. S7 closes the issue.

---

## 11 — Bootstrap / workflow note

Scope manifest must be synced to runtime BEFORE implementer dispatch:

```bash
cc-policy workflow scope-sync wi-687-s4-aider-adapter \
  --work-item-id wi-687-s4-aider-adapter-implementer \
  --scope-file tmp/scope-wi-687-s4-aider-adapter.json
```

(If runtime already has a stale scope row from a prior dispatch attempt, sync overwrites it.)

The orchestrator should then dispatch implementer via the canonical stage-packet path:

```bash
cc-policy workflow stage-packet wi-687-s4-aider-adapter --stage-id implementer
```

---

## 12 — Rollback boundary

Single-PR slice. Rollback = `git revert <land-sha>`. No data migration, no schema change, no behaviour change to existing consumers. The `KNOWN_IDE_NAMES` rollback drops aider out of the IDE-detect probe, the init/uninstall switches lose their `aider` arm, the lifecycle test matrix returns to 5 × 6 = 30 cases, and the `hooks-aider` package + installer are removed atomically.

---

PLAN_VERDICT: next_work_item
PLAN_SUMMARY: Plan written for WI-687-S4 @yakcc/hooks-aider adapter — structural mirror of hooks-cline (NOT windsurf) because Aider is a CLI tool with no settings.json wiring; marker-file pattern in ~/.aider/; CLI surface extends ide-detect/init/uninstall/lifecycle-test for 6th adapter; lockfile + biome format required; land via PR with `refs #687` (S7 closes the issue). Ready for guardian provision → implementer dispatch.
