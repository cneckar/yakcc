# WI-759 — Standalone `yakcc hooks <ide> install` must update `.yakccrc.json` installedHooks

**Issue:** [#759](https://github.com/cneckar/yakcc/issues/759) (labels: `fuckgoblin`, `hooks`, `ready`, `v0.5`)
**Branch:** `feature/wi-759-yakccrc-update`
**Base:** `main @ 54a43ca` (post-#758 `@yakcc/cli@0.5.0-alpha.1` bump)
**Discovered by:** alpha tester #1, immediately after `@yakcc/cli@0.5.0-alpha.1` global install (2026-05-19)
**Sister:** fuckgoblin (assigned)

---

## §1. Problem statement

`yakcc init` correctly updates `.yakccrc.json.installedHooks` after installing each IDE hook. The **standalone install command** `yakcc hooks <ide> install` does not. The settings file (`.claude/settings.json` etc.) is written correctly, but the project-level registry of "what hooks does this project know about" stays stale.

### Repro (verbatim from #759)

```sh
mkdir /tmp/yakcc-rc-repro && cd /tmp/yakcc-rc-repro
yakcc init --skip-hooks       # creates .yakcc/ + .yakccrc.json with installedHooks=[]
yakcc hooks claude-code install --target .

cat .yakccrc.json | jq '.installedHooks'
# []   ← wrong; settings.json now has the hook but the rc file says no install happened
jq '.hooks.PreToolUse[0].hooks[0].command' .claude/settings.json
# "yakcc hook-intercept"   ← install actually happened
```

### Confirmed gap shape (state-of-the-art at base `54a43ca`)

Grep for `installedHooks` or `.yakccrc` across the six standalone installer modules returns **zero matches**:

```
$ grep -nE 'installedHooks|\.yakccrc' \
  packages/cli/src/commands/hooks-{install,cursor-install,windsurf-install,aider-install,cline-install,continue-install}.ts
(no matches)
```

The 6 modules (`hooks-install.ts` for claude-code, plus `hooks-{cursor,windsurf,aider,cline,continue}-install.ts`) each:
- read/write only the IDE-specific surface (`.claude/settings.json`, `.cursor/settings.json`, marker file in `~/.config/cline/`, etc.);
- never read `.yakccrc.json`;
- never write `.yakccrc.json`.

Both the **install** path and the **--uninstall** path in those modules have the same gap.

### Why it matters

1. **`.yakccrc.json` is documented as the source-of-truth state file.** `init.ts` calls it "the project config visible at the repo root … the project registry of installed hooks" (DEC-CLI-INIT-001 / DEC-CLI-INIT-002, `init.ts:13-53, 101-111, 500-532`). Having it lie about which hooks are installed silently contradicts that contract.
2. **`uninstall.ts` consumes it** as **Tier 2** of a 3-tier detection chain (DEC-CLI-UNINSTALL-DETECTION-001, `uninstall.ts:17-23, 260-280`). Today Tier 2 returns `[]` and uninstall falls through to Tier 3 filesystem detection. Fragile.
3. **Tier 3 is best-effort.** If a future adapter has a non-probable config dir, the silent-no-op risk re-emerges.
4. **Documentation drift.** Any tooling, dashboard, or future federation feature that reads `.yakccrc.json` to know which IDE adapters are active will be wrong.

### Goals

1. After `yakcc hooks <ide> install [--target <dir>]` on a directory that has any `.yakccrc.json` shape (or none), the rc file's `installedHooks` includes `"<ide>"`.
2. Symmetric: after `yakcc hooks <ide> install --uninstall`, the rc file's `installedHooks` no longer contains `"<ide>"`.
3. Idempotent: running install twice does not duplicate the IDE name; running uninstall when absent leaves the array unchanged.
4. The existing `yakcc init` behavior is preserved unchanged (its current merge logic is the **canonical** pattern that gets extracted).
5. The top-level `yakcc uninstall` behavior is preserved unchanged (it already updates the rc — see `uninstall.ts:304-338`).
6. Full-workspace `pnpm -w lint`, `pnpm -w typecheck`, `pnpm -w build`, `pnpm -w test` stay green.

### Non-goals

- **No schema change to `.yakccrc.json`.** Additive-only contract per EC-S2-I3 (`uninstall.ts:81-69`). `version` stays `1`; no field add/remove.
- **No redesign of the 3-tier uninstall detection.** Tier 2 stays as documented; Tier 3 stays as the safety net.
- **No fix for #760 (telemetry path docs).** That is its own issue.
- **No changes to `init.ts`'s control flow.** Only the `installedHooks` merge logic moves to a shared module that `init.ts` then consumes — the externally observable behavior is byte-identical.
- **No new public CLI flags.** This is a bookkeeping fix, not a feature.
- **No telemetry / event emission on rc mutation.** Out of scope; raise separately if desired.

### Dominant constraints

- **Sacred Practice #12 — single source of truth.** The fix must NOT inline a copy of the merge logic in each of the 6 installers. Extract once; consume from 7 callers (6 install paths + `init.ts`).
- **No cross-package relative imports.** Per `feedback_no_cross_package_imports.md` — but this WI lives entirely inside `packages/cli/`, so all imports are intra-package and use the existing `./lib/` and `./commands/` relative pattern (matches `ide-detect.ts`, `index.ts` precedent).
- **Concurrent-write tolerance.** The same project root may have two `yakcc hooks <ide> install` calls racing (e.g. shell scripting). Read-modify-write is not atomic on POSIX without `O_EXCL`; this WI accepts last-writer-wins because the rc is a config not a ledger, and the same race exists today in `init.ts` and `uninstall.ts`. We do NOT introduce locking. (See §10 Risks for explicit acceptance.)
- **No `MASTER_PLAN.md` edits.** Plan-format follow-up via `CLAUDE_PLAN_MIGRATION=1` if needed.
- **No `bootstrap/expected-roots.json` edits.** Out of scope.
- **Land via PR**, not Guardian-merge. (Per `feedback_pr_not_guardian_merge.md`.)

---

## §2. Architecture

### State-authority map

| State domain | Canonical authority (BEFORE WI-759) | Canonical authority (AFTER WI-759) |
|---|---|---|
| `.yakccrc.json` file existence, shape, version | `init.ts` (creates), `uninstall.ts` (purges) | UNCHANGED — `init.ts` creates; `uninstall.ts` purges |
| `.yakccrc.json.installedHooks` field — **append** on install | `init.ts:519-532` (private `readRc/writeRc` + inline merge) | **NEW module** `packages/cli/src/lib/yakccrc.ts` — public functions `readRc()`, `writeRc()`, `addInstalledHook()`, `removeInstalledHook()`. Consumed by `init.ts` AND all 6 `hooks-*-install.ts` modules. |
| `.yakccrc.json.installedHooks` field — **remove** on uninstall | `uninstall.ts:304-338` (private `readRc` + inline filter) | Same new module — `removeInstalledHook()`. Consumed by `uninstall.ts` (replacing inline) AND all 6 `hooks-*-install.ts --uninstall` paths. |
| `.yakccrc.json.federation.peers` | `init.ts:513-519` (inline merge) | UNCHANGED — out of scope. The new module only owns `installedHooks` mutations; other fields are pass-through (verbatim preservation per EC-S2-I3). |
| Which IDEs are detected on disk | `lib/ide-detect.ts` (`detectInstalledIdes`) | UNCHANGED |
| IDE installer dispatch | `init.ts` `installHookForIde()` + `uninstall.ts` `uninstallHookForIde()` | UNCHANGED |
| Per-IDE settings/marker writing | Each `hooks-*-install.ts` | UNCHANGED, with one new tail step: after IDE-specific write succeeds, call `addInstalledHook(targetDir, ide)` (install) / `removeInstalledHook(targetDir, ide)` (--uninstall). |

### Where state lives — code-anchor table

| File | Lines (base `54a43ca`) | Role today | WI-759 change |
|---|---|---|---|
| `packages/cli/src/commands/init.ts` | 117-133 (private `readRc`/`writeRc`), 424-441 (loop builds `installedHooks[]`), 501-541 (merge + write) | Canonical pattern; private helpers | Replace `readRc/writeRc` with `import { readRc, writeRc, addInstalledHook } from "../lib/yakccrc.js"`. Replace lines 501-541 merge with calls into the new module. Behavior preserved byte-identical (covered by existing `init.test.ts`). |
| `packages/cli/src/commands/uninstall.ts` | 94-103 (private `readRc`), 304-338 (filter + write) | Today's consumer of `installedHooks` (Tier 2) and current authority for "remove on uninstall" | Replace private `readRc` and inline filter with `readRc`, `removeInstalledHook` from new module. Behavior preserved. |
| `packages/cli/src/commands/hooks-install.ts` (claude-code) | 161-230 (handler) | Install + uninstall claude-code only | After successful settings write (install path): call `addInstalledHook(targetDir, "claude-code")`. After successful settings strip (uninstall path): call `removeInstalledHook(targetDir, "claude-code")`. |
| `packages/cli/src/commands/hooks-cursor-install.ts` | full handler | Install + uninstall cursor | Same pattern: tail call to `addInstalledHook` / `removeInstalledHook` with `"cursor"`. |
| `packages/cli/src/commands/hooks-windsurf-install.ts` | full handler | Install + uninstall windsurf | Same pattern with `"windsurf"`. |
| `packages/cli/src/commands/hooks-cline-install.ts` | full handler | Install + uninstall cline (marker-file) | Same pattern with `"cline"`. The `--target` flag is implicit — see §3.2 below for cline/continue/aider semantics. |
| `packages/cli/src/commands/hooks-continue-install.ts` | full handler | Install + uninstall continue (marker-file) | Same pattern with `"continue"`. |
| `packages/cli/src/commands/hooks-aider-install.ts` | full handler | Install + uninstall aider (marker-file) | Same pattern with `"aider"`. |
| `packages/cli/src/lib/yakccrc.ts` **(NEW)** | — | (does not exist) | **NEW** ~120-160 LOC pure module. See §3 for full surface. |
| `packages/cli/src/lib/yakccrc.test.ts` **(NEW)** | — | (does not exist) | **NEW** unit tests against real tmpdirs (Sacred Practice #5). |
| `packages/cli/src/commands/hooks-install.test.ts` | 1-100+ (existing claude-code test suite) | Tests install/uninstall settings.json effect only | EXTEND with assertions on `.yakccrc.json.installedHooks` post-install and post-uninstall. |
| `packages/cli/src/commands/hooks-cline-install.test.ts` | existing | Tests cline marker only | EXTEND with `.yakccrc.json` assertion (when `--target` semantics resolve — see §3.2). |
| `packages/cli/src/commands/hooks-continue-install.test.ts` | existing | Tests continue marker only | EXTEND with `.yakccrc.json` assertion (see §3.2). |
| **NEW** `packages/cli/src/commands/hooks-cursor-install.test.ts` | — | (does not exist today; the cursor installer has no dedicated test file) | **NEW** — minimum: install + uninstall + rc update assertion. Verifies the standalone path that #759 reports as broken. |
| **NEW** `packages/cli/src/commands/hooks-windsurf-install.test.ts` | — | (does not exist today) | **NEW** — install + uninstall + rc update. |
| **NEW** `packages/cli/src/commands/hooks-aider-install.test.ts` | — | (does not exist today) | **NEW** — install + uninstall + rc update. |

### Why a new file `lib/yakccrc.ts` (Option A) — NOT inline (Option B)

The issue body presents two options. Recording the architecture decision:

- **Option A (chosen):** A new shared module `packages/cli/src/lib/yakccrc.ts` owns rc read/write and installedHooks mutation. `init.ts`, `uninstall.ts`, and all 6 `hooks-*-install.ts` consume the same functions. **Single source of truth.**
- **Option B (rejected):** Inline a copy of the merge logic in each of the 6 installers. Six call sites to keep in sync. Violates Sacred Practice #12.

Recorded as `DEC-CLI-YAKCCRC-AUTHORITY-001` in §9.

### Why `lib/yakccrc.ts` and not extend `init.ts`'s helpers in place

`init.ts` is the "first-30-seconds command" — its private helpers are conceptually private to the init handler. Promoting them to `init.ts` `export`s would create a circular import attempt the moment a sibling command imports them (some `hooks-*-install.ts` modules are already imported BY `init.ts` for dispatch). The `lib/` directory is the documented home for shared, dependency-light authorities (`ide-detect.ts` precedent, DEC-CLI-IDE-DETECT-PLACEMENT-001). New module, new placement, no circular-import risk.

### Why install AND uninstall paths in this WI

Issue AC list includes "Symmetric: after the standalone uninstall path, the rc file's `installedHooks` no longer contains the removed IDE name." The standalone uninstall path is `yakcc hooks <ide> install --uninstall`, routed through the same 6 modules. If we fix only install and not uninstall, we ship a half-symmetric bug where re-running `yakcc hooks <ide> install --uninstall` doesn't clean the rc — which is the same class of bug #759 reports.

The top-level `yakcc uninstall` ALREADY updates the rc (`uninstall.ts:304-338`). This WI swaps its inline logic for the new module's `removeInstalledHook` to eliminate the duplicate authority; observable behavior is preserved.

---

## §3. Implementation

### §3.1 New module `packages/cli/src/lib/yakccrc.ts`

```ts
// SPDX-License-Identifier: MIT
//
// yakccrc.ts — single-source-of-truth helper for reading/mutating .yakccrc.json
//
// @decision DEC-CLI-YAKCCRC-AUTHORITY-001
// title: All .yakccrc.json read/write + installedHooks mutation goes through this module.
//        No command may read/write .yakccrc.json directly.
// status: accepted (WI-759)
// rationale:
//   Before WI-759, init.ts owned a private readRc/writeRc + inline merge; uninstall.ts
//   owned a parallel private readRc + inline filter; the 6 hooks-<ide>-install.ts modules
//   wrote nothing to .yakccrc.json at all (issue #759). Six new install/uninstall callers
//   need the same mutation. Sacred Practice #12 demands a single canonical authority for
//   the .yakccrc.json file. This module is that authority.
//
//   Field-preservation contract (EC-S2-I3, inherited from uninstall.ts): readers receive
//   the full parsed object; writers preserve every field they did not explicitly mutate.
//   addInstalledHook only touches `installedHooks`; removeInstalledHook only touches
//   `installedHooks`. version stays 1. mode/federation/registry pass through unchanged.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Config file at project root (DEC-CLI-INIT-001). */
export const RC_FILENAME = ".yakccrc.json";

/**
 * Flexible rc schema — only the fields this module mutates are typed; the rest
 * are preserved verbatim (EC-S2-I3: version stays 1, additive-only, no removal).
 */
export interface YakccRc {
  version: number;
  installedHooks?: string[];
  [key: string]: unknown;
}

/**
 * Read .yakccrc.json from target directory, or return null if absent/corrupt.
 * Parse errors are silently swallowed (matches init.ts and uninstall.ts pre-WI-759 behavior).
 */
export function readRc(targetDir: string): YakccRc | null;

/** Write .yakccrc.json to target directory (pretty-printed, trailing newline). */
export function writeRc(targetDir: string, rc: YakccRc): void;

/**
 * Append `ide` to `.yakccrc.json.installedHooks` at `targetDir`, deduplicated.
 *
 * Semantics:
 *   - If .yakccrc.json does not exist: CREATE a minimal rc with version=1 and
 *     installedHooks=[ide]. (See AC4 in §4.) Other fields (mode, registry,
 *     federation) are left absent so `yakcc init` can populate them on next run.
 *   - If .yakccrc.json exists: read, merge ide into installedHooks (Set-dedup),
 *     write back preserving every other field verbatim.
 *   - If .yakccrc.json is corrupt JSON: treat as absent (matches existing
 *     readRc swallow behavior); CREATE a minimal rc. The corrupt file's old
 *     content is overwritten — matches init.ts's existing behavior at L122-127.
 *
 * Throws on filesystem write failure (the caller decides whether to log+continue
 * or propagate as exit-1).
 */
export function addInstalledHook(targetDir: string, ide: string): void;

/**
 * Remove `ide` from `.yakccrc.json.installedHooks` at `targetDir`.
 *
 * Semantics:
 *   - If .yakccrc.json does not exist: no-op (do not create on uninstall).
 *   - If .yakccrc.json exists and installedHooks is absent or does not contain ide: no-op.
 *   - If .yakccrc.json exists and installedHooks contains ide: filter it out, write back
 *     preserving every other field verbatim.
 *
 * Throws on filesystem write failure.
 */
export function removeInstalledHook(targetDir: string, ide: string): void;
```

The function bodies are mechanical (read JSON, mutate the one field, write JSON back). No new dependencies; pure `node:fs` + `node:path` (matches `ide-detect.ts` ethos).

### §3.2 `--target` semantics for cline / continue / aider

`hooks-cline-install.ts`, `hooks-continue-install.ts`, and `hooks-aider-install.ts` write a marker file to a **home-directory** path (`~/.config/cline/…`, `~/.continue/…`, `~/.aider/…`) — there is no `--target <projectDir>` argument on these three subcommands today. The marker is global per IDE, not per project.

**Decision (encoded in `DEC-CLI-YAKCCRC-HOMEHOOK-TARGET-001` — see §9):** The standalone `yakcc hooks {cline,continue,aider} install` reads the **current working directory** as the project root for the `.yakccrc.json` update. Rationale:
- The user ran the command from inside a yakcc project.
- This matches `yakcc init` default semantics (`targetDir = parsed.values.target ?? "."`).
- We do NOT add a new `--target` flag on these three subcommands. (Out of scope per Non-goals.)
- If `.yakccrc.json` does not exist in cwd, `addInstalledHook` creates a minimal rc — exactly the AC4 contract.
- Tests inject the `cwd` via a new internal-only options seam (mirrors the existing `overrideClineDir` injection pattern). The exported function signature does NOT change; tests construct a sibling helper that takes an explicit cwd. Implementer chooses between two seam shapes (both work):

  - **Seam shape A (preferred):** add an internal-only `overrideCwd?: string` parameter to the existing signature, defaulting to `process.cwd()`. Tests pass an explicit tmpdir. No public API surface change (it is the existing pattern used by `overrideClineDir`).
  - **Seam shape B:** wrap the existing handler in `runInCwd(cwd, handler)` — slightly more disruptive; reject unless A has a hidden blocker.

  The implementer picks A unless it conflicts with another constraint; in either case the externally observable CLI behavior is "rc in cwd gets updated."

### §3.3 `--target` semantics for claude-code / cursor / windsurf

These three already accept `--target <projectDir>` (defaulting to `"."`). The rc update uses that same `targetDir`. Trivially testable — the existing `hooks-install.test.ts` pattern already passes a tmpdir as `--target`.

### §3.4 Per-IDE call-site shape (representative — claude-code)

```ts
// hooks-install.ts (after the existing settings-write block, before return 0):

// --- WI-759: update .yakccrc.json.installedHooks ---
try {
  if (values.uninstall) {
    removeInstalledHook(targetDir, "claude-code");
  } else {
    addInstalledHook(targetDir, "claude-code");
  }
} catch (err) {
  logger.error(`warning: cannot update ${RC_FILENAME}: ${String(err)} — continuing`);
  // Non-fatal: the IDE-side install/uninstall succeeded. The rc-update warning
  // mirrors init.ts's pattern at L442 (per-IDE error is non-fatal).
}
```

Six call sites, one shape each, total ~10 LOC added per file × 6 = ~60 LOC of call-site change.

### §3.5 `init.ts` consolidation

Replace `init.ts:117-133` (private `readRc/writeRc`) and `init.ts:508-541` (inline merge) with a call into `lib/yakccrc.ts`:

```ts
// At top of init.ts (replace existing rc-related imports / private fns):
import {
  readRc,
  writeRc,
  RC_FILENAME,
  type YakccRc,
} from "../lib/yakccrc.js";

// Inside init handler, replace the merge block (L508-541) with a single
// "load → merge non-installedHooks fields → addInstalledHook per ide" idiom.
// installedHooks itself is now appended by each per-IDE installer's tail call;
// init no longer needs to merge it explicitly.
```

This is the **load-bearing** refactor that proves the new module is the SINGLE authority. After WI-759, `installedHooks` mutation lives in exactly one file (`lib/yakccrc.ts`) and is invoked from exactly one place per IDE (the installer's tail call), regardless of whether the installer was invoked via `yakcc init` or via `yakcc hooks <ide> install`.

The existing `init.test.ts` regression-tests the externally observable behavior; if any test fails, the refactor diverged from prior semantics and must be reconciled.

### §3.6 `uninstall.ts` consolidation

Replace `uninstall.ts:94-103` (private `readRc`) and `uninstall.ts:304-338` (inline filter + write) with calls into `lib/yakccrc.ts`. The 3-tier detection chain (DEC-CLI-UNINSTALL-DETECTION-001) is preserved — Tier 2 still reads `rc.installedHooks` via the new shared `readRc`.

The per-IDE uninstall dispatch in `uninstall.ts` calls `hooks-<ide>-install.ts` with `--uninstall`. After this WI, those installers will tail-call `removeInstalledHook`, which means the rc gets updated 6 times (once per IDE) instead of in a single write at the end of `uninstall.ts`. **This is fine**: each `removeInstalledHook` is a small read-modify-write, idempotent, and any of the existing failures gracefully degrade. (Performance: 6 rc rewrites on `yakcc uninstall` is negligible vs. the per-IDE work that just happened.)

`uninstall.ts`'s post-loop rc-write block (today at L304-338) becomes a no-op cleanup pass — or is removed entirely, since the per-IDE installers now own the mutation. Implementer chooses; either way the `--ide <list>` explicit-list path must still produce the same observable outcome. The existing `uninstall.test.ts` regression-tests this.

### §3.7 Testing strategy (real-fs, no mocks — Sacred Practice #5)

| Test file | What it asserts |
|---|---|
| `packages/cli/src/lib/yakccrc.test.ts` **(NEW)** | Unit: `readRc` on absent / corrupt / valid file; `writeRc` round-trip; `addInstalledHook` on absent rc creates minimal rc with `installedHooks: [ide]`; `addInstalledHook` on existing rc appends + dedupes; `addInstalledHook` preserves all other fields verbatim; `removeInstalledHook` no-ops on absent rc; `removeInstalledHook` strips the named ide and preserves siblings. |
| `packages/cli/src/commands/hooks-install.test.ts` **(EXTEND)** | Existing 11 tests stay; add: (a) post-install, `.yakccrc.json.installedHooks` contains `"claude-code"`; (b) post-install when no rc exists, rc is created with `installedHooks: ["claude-code"]`; (c) double-install does not duplicate; (d) `--uninstall` removes `"claude-code"` from `installedHooks`; (e) install preserves other rc fields (mode, registry, federation). |
| `packages/cli/src/commands/hooks-cline-install.test.ts` **(EXTEND)** | Mirror (a-e) for `"cline"`. Test injects cwd via the seam from §3.2. |
| `packages/cli/src/commands/hooks-continue-install.test.ts` **(EXTEND)** | Mirror (a-e) for `"continue"`. |
| `packages/cli/src/commands/hooks-cursor-install.test.ts` **(NEW)** | Full install + uninstall + rc-update suite for `"cursor"`. Bootstrap parity with `hooks-install.test.ts`. |
| `packages/cli/src/commands/hooks-windsurf-install.test.ts` **(NEW)** | Full install + uninstall + rc-update suite for `"windsurf"`. |
| `packages/cli/src/commands/hooks-aider-install.test.ts` **(NEW)** | Full install + uninstall + rc-update suite for `"aider"`. |
| `packages/cli/src/commands/init.test.ts` **(UNCHANGED)** | Regression-tests `yakcc init` behavior end-to-end. Should pass byte-identical post-refactor. If any test changes, the refactor diverged — STOP and reconcile. |
| `packages/cli/src/commands/uninstall.test.ts` **(UNCHANGED)** | Regression-tests `yakcc uninstall` behavior. Should pass byte-identical post-refactor. |

**No mocks.** Every test creates a real tmpdir via `mkdtempSync`, runs the real command function, and asserts the real `.yakccrc.json` contents. Matches the precedent in `hooks-install.test.ts:39-51`.

### §3.8 What does NOT change

- `.yakccrc.json` schema. `version` stays 1. No new fields.
- `yakcc init` external behavior. The merge is now delegated, but the resulting rc bytes are byte-identical to today (covered by existing `init.test.ts`).
- `yakcc uninstall` external behavior. Same.
- Per-IDE settings/marker file shapes.
- IDE auto-detection (`ide-detect.ts`).
- Any CLI flag, command name, exit code, or log line user-visible string (except the new `warning: cannot update .yakccrc.json` line, which only appears on filesystem failure — a strict improvement over silent miss).

---

## §4. Acceptance criteria

| # | AC | How verified |
|---|----|--------------|
| AC1 | After `yakcc init --skip-hooks` then `yakcc hooks claude-code install --target <tmp>`, `<tmp>/.yakccrc.json.installedHooks` includes `"claude-code"`. | New assertion in `hooks-install.test.ts`; also a bin smoke run from issue repro. |
| AC2 | Same as AC1 for each of `cursor`, `cline`, `continue`, `windsurf`, `aider`. | New / extended test per IDE. |
| AC3 | When no `.yakccrc.json` exists at `<tmp>`, `yakcc hooks <ide> install --target <tmp>` CREATES a minimal rc with `version: 1` and `installedHooks: ["<ide>"]`. | New test in `yakccrc.test.ts` (unit-level) and in each `hooks-*-install.test.ts` (integration-level). |
| AC4 | Running `yakcc hooks <ide> install --target <tmp>` twice produces an array with exactly one `"<ide>"` entry (idempotent / deduped). | New test in each `hooks-*-install.test.ts`. |
| AC5 | After `yakcc hooks <ide> install --uninstall --target <tmp>`, `.yakccrc.json.installedHooks` no longer contains `"<ide>"`. | New test in each `hooks-*-install.test.ts`. |
| AC6 | `yakcc hooks <ide> install --uninstall` when `<ide>` is NOT in `installedHooks` leaves the array unchanged (no-op). | New test in `yakccrc.test.ts` + integration smoke. |
| AC7 | `yakcc init` external behavior is unchanged. | Existing `init.test.ts` passes without modification (any failing test means the refactor diverged). |
| AC8 | `yakcc uninstall` external behavior is unchanged. | Existing `uninstall.test.ts` passes without modification. |
| AC9 | `yakcc hooks <ide> install` preserves all `.yakccrc.json` fields other than `installedHooks` byte-identical. | New test in each `hooks-*-install.test.ts` (seed rc with `{version:1, mode:"local", registry:{path:".yakcc/registry.sqlite"}, federation:{peers:["https://example.org"]}}`, install, assert all four fields unchanged + `installedHooks` updated). |
| AC10 | Full-workspace `pnpm -w lint` passes. | CI gate. |
| AC11 | Full-workspace `pnpm -w typecheck` passes. | CI gate. |
| AC12 | Full-workspace `pnpm -w build` passes. | CI gate. |
| AC13 | Full-workspace `pnpm -w test` passes. | CI gate. |
| AC14 | The end-to-end repro from #759 (`yakcc init --skip-hooks` → `yakcc hooks claude-code install --target .` → `cat .yakccrc.json | jq '.installedHooks'`) returns `["claude-code"]`. | Documented in PR body; manual verification step. |

---

## §5. Evaluation Contract

This block is the contract the implementer and reviewer share. Both roles MUST verify each line.

### Required tests (must exist and pass — green at HEAD)

1. `packages/cli/src/lib/yakccrc.test.ts` — new file. Covers `readRc`, `writeRc`, `addInstalledHook` (absent rc, existing rc, dedup, field preservation), `removeInstalledHook` (absent rc no-op, missing ide no-op, present ide strip, field preservation).
2. `packages/cli/src/commands/hooks-install.test.ts` — EXTENDED. Existing 11 tests still green. Add assertions: AC1, AC3, AC4, AC5, AC6, AC9 for `claude-code`.
3. `packages/cli/src/commands/hooks-cline-install.test.ts` — EXTENDED. Add AC2/AC3/AC4/AC5/AC9 for `cline`.
4. `packages/cli/src/commands/hooks-continue-install.test.ts` — EXTENDED. Same for `continue`.
5. `packages/cli/src/commands/hooks-cursor-install.test.ts` — NEW. Full suite for `cursor` (install + uninstall + AC1-AC9 minus AC7/AC8).
6. `packages/cli/src/commands/hooks-windsurf-install.test.ts` — NEW. Full suite for `windsurf`.
7. `packages/cli/src/commands/hooks-aider-install.test.ts` — NEW. Full suite for `aider`.
8. `packages/cli/src/commands/init.test.ts` — UNCHANGED, must remain green.
9. `packages/cli/src/commands/uninstall.test.ts` — UNCHANGED, must remain green.

### Required real-path checks

- Run the issue's verbatim repro in a tmpdir: `mkdir tmp/wi-759-repro && (cd tmp/wi-759-repro && yakcc-bin init --skip-hooks && yakcc-bin hooks claude-code install --target .)` then assert `jq '.installedHooks' tmp/wi-759-repro/.yakccrc.json` outputs `["claude-code"]`. Where `yakcc-bin` is the freshly built `packages/cli/dist/bin.cjs` (or `node packages/cli/dist/bin.cjs`). This is the **canonical proof** that #759 is closed.
- Same repro for each of `cursor`, `cline`, `continue`, `windsurf`, `aider`. (6 total smoke checks; can be one test file or a shell script — implementer chooses.)
- Symmetric repro: install → `cat .yakccrc.json` shows `["claude-code"]` → `yakcc hooks claude-code install --uninstall --target .` → `cat .yakccrc.json` shows `[]` (or absent if the rc was just created — implementer enforces consistent shape).
- Concurrent-race smoke: spawn two `yakcc hooks claude-code install --target .` processes simultaneously; assert at least one of them succeeds and that the final `installedHooks` contains exactly one `"claude-code"` (no duplicate, no missing). This is informational not a hard gate — last-writer-wins is acceptable per §1 Dominant constraints. The smoke proves we did not introduce a regression that produces JSON corruption.

### Required authority invariants

- **AUTH-1 (Sacred Practice #12 single-source-of-truth):** `grep -rn 'installedHooks' packages/cli/src/` after the change MUST show writes ONLY in `lib/yakccrc.ts`. Reads in other files (e.g. `uninstall.ts` Tier 2 detection) are allowed.
  - Exact gate: `git grep -nE '\.installedHooks\s*=|installedHooks\s*[:=]\s*\[' packages/cli/src/ | grep -v lib/yakccrc.ts | grep -v test`  MUST return zero matches. Object-literal initializers in `lib/yakccrc.ts` itself are the only allowed write site.
- **AUTH-2 (field-preservation, EC-S2-I3):** For any rc passed through `addInstalledHook` / `removeInstalledHook`, every field other than `installedHooks` is byte-identical pre/post. Verified by `yakccrc.test.ts` "preserves siblings" cases.
- **AUTH-3 (no schema change):** `.yakccrc.json` `version` field stays `1` in all test outputs. Grep for `version: 2` / `"version": 2` MUST return zero results in code and test fixtures.

### Required integration points

- `init.ts` consumes `lib/yakccrc.ts` (import is present); no private `readRc/writeRc` remains in `init.ts`.
- `uninstall.ts` consumes `lib/yakccrc.ts`; no private `readRc` remains in `uninstall.ts`.
- All 6 `hooks-*-install.ts` import from `../lib/yakccrc.js`.
- The 3-tier uninstall detection (DEC-CLI-UNINSTALL-DETECTION-001) still functions: Tier 1 (--ide list) → Tier 2 (rc.installedHooks) → Tier 3 (detectInstalledIdes()).

### Forbidden shortcuts

- **F-1:** Inlining the merge/filter logic in any installer module. (Violates Sacred Practice #12.)
- **F-2:** Changing the `.yakccrc.json` schema (version bump, new field, field rename).
- **F-3:** Adding a new public CLI flag.
- **F-4:** Mocking `node:fs` in tests. All tests use real tmpdirs.
- **F-5:** Importing across packages via relative paths (`../../../packages/...`). Intra-`packages/cli/` relative imports are fine and follow existing precedent.
- **F-6:** Editing `MASTER_PLAN.md` or `bootstrap/expected-roots.json`.
- **F-7:** Skipping any `hooks-*-install.ts` module. All 6 must be updated (both install and uninstall code paths).
- **F-8:** Using `pnpm --filter` for the lint/typecheck/test acceptance gates. Per `feedback_eval_contract_match_ci_checks.md`, full-workspace runs are required.
- **F-9:** Routing landing through Guardian-merge to `main`. Land via PR (per `feedback_pr_not_guardian_merge.md`).

### Ready-for-guardian definition

Reviewer may emit `REVIEW_VERDICT=ready_for_guardian` ONLY when ALL of the following hold against the current HEAD:

1. All 9 tests in "Required tests" exist and pass.
2. All 8 real-path checks in "Required real-path checks" succeed (output included verbatim in reviewer's findings, not just summarized).
3. All 3 authority invariants pass the literal grep gates.
4. All 4 integration points are verifiable by grep.
5. None of the 9 forbidden shortcuts are present.
6. `pnpm -w lint`, `pnpm -w typecheck`, `pnpm -w build`, `pnpm -w test` all pass at HEAD with full output captured.
7. The Scope Manifest in §6 was respected (no unauthorized file touches).
8. The PR body includes the issue #759 verbatim repro output showing `["claude-code"]` as the rc field value.

---

## §6. Scope Manifest

Single authority for what the implementer may touch.

### Allowed files (read + write)

- `packages/cli/src/lib/yakccrc.ts` **(NEW)**
- `packages/cli/src/lib/yakccrc.test.ts` **(NEW)**
- `packages/cli/src/commands/init.ts` (MODIFY: import + replace private rc helpers + replace inline merge with calls into new module)
- `packages/cli/src/commands/uninstall.ts` (MODIFY: import + replace private rc helper + replace inline filter with calls into new module)
- `packages/cli/src/commands/hooks-install.ts` (MODIFY: add tail call after both install and uninstall paths)
- `packages/cli/src/commands/hooks-install.test.ts` (EXTEND: add rc-assertion tests)
- `packages/cli/src/commands/hooks-cursor-install.ts` (MODIFY: add tail call)
- `packages/cli/src/commands/hooks-cursor-install.test.ts` **(NEW)**
- `packages/cli/src/commands/hooks-windsurf-install.ts` (MODIFY: add tail call)
- `packages/cli/src/commands/hooks-windsurf-install.test.ts` **(NEW)**
- `packages/cli/src/commands/hooks-aider-install.ts` (MODIFY: add tail call)
- `packages/cli/src/commands/hooks-aider-install.test.ts` **(NEW)**
- `packages/cli/src/commands/hooks-cline-install.ts` (MODIFY: add tail call + optional `overrideCwd` seam)
- `packages/cli/src/commands/hooks-cline-install.test.ts` (EXTEND: add rc-assertion tests)
- `packages/cli/src/commands/hooks-continue-install.ts` (MODIFY: add tail call + optional `overrideCwd` seam)
- `packages/cli/src/commands/hooks-continue-install.test.ts` (EXTEND: add rc-assertion tests)
- `plans/wi-759-yakccrc-update.md` (this plan; implementer may amend §11 progress log only)

### Required files (must be modified — not optional)

Every file listed in "Allowed (MODIFY)" above is **required**. Skipping any of the 6 installer modules leaves an active bug.

### Forbidden touch points

- `packages/cli/src/lib/ide-detect.ts` (no detection-logic change is needed)
- `packages/cli/src/index.ts`, `bin.ts` (no CLI dispatch change needed)
- `packages/cli/package.json` (no dep add — pure node stdlib)
- Any file outside `packages/cli/` (this WI is contained)
- `MASTER_PLAN.md` (legacy redirect stub; the canonical archive lives at `docs/archive/developer/MASTER_PLAN.md` and is also out of scope per orchestrator policy)
- `docs/archive/developer/MASTER_PLAN.md`
- `bootstrap/expected-roots.json`
- Any `.yakccrc.json` fixture in `examples/` (not consumed by this change)
- `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`
- Any other `packages/*` (the hooks-base, hooks-claude-code, etc. packages are not touched)
- `.github/workflows/*`
- `scripts/check-no-bom.mjs` and other workspace scripts

### Expected state authorities touched

- **`.yakccrc.json`** at the active project root — now mutated through `lib/yakccrc.ts`.
- **No SQLite state** (the registry sqlite is untouched).
- **No runtime state in `state.db`** (cc-policy / harness state untouched).
- **No git state** beyond the implementer's normal commits in `feature/wi-759-yakccrc-update`.

---

## §7. Work breakdown

Single slice; cohesion is high (one architectural seam, six call-site updates).

| W-ID | Description | Weight | Gate | Deps |
|------|-------------|--------|------|------|
| W-S1-A | Create `packages/cli/src/lib/yakccrc.ts` with `readRc`, `writeRc`, `addInstalledHook`, `removeInstalledHook` (semantics per §3.1). Create `packages/cli/src/lib/yakccrc.test.ts` unit tests (real tmpdir, no mocks). | M | none | — |
| W-S1-B | Refactor `init.ts` to import from `lib/yakccrc.ts`; remove private rc helpers; replace inline merge. Run `pnpm --filter @yakcc/cli test -- init.test.ts` locally to prove no regression. Then run full-workspace `pnpm -w test` for proof. | S | none | W-S1-A |
| W-S1-C | Refactor `uninstall.ts` similarly. Run `init.test.ts` + `uninstall.test.ts` for regression proof. | S | none | W-S1-A |
| W-S1-D | Add tail calls to `hooks-install.ts` (claude-code) install AND uninstall paths. Extend `hooks-install.test.ts` with AC1/AC3/AC4/AC5/AC6/AC9 assertions for `"claude-code"`. | S | none | W-S1-A |
| W-S1-E | Add tail calls + extend tests for `hooks-cursor-install.ts` (NEW test file), `hooks-windsurf-install.ts` (NEW test file), `hooks-aider-install.ts` (NEW test file), `hooks-cline-install.ts` (extend existing test), `hooks-continue-install.ts` (extend existing test). For cline/continue/aider include the `overrideCwd` seam from §3.2. | M | none | W-S1-A |
| W-S1-F | Run full-workspace `pnpm -w lint && pnpm -w typecheck && pnpm -w build && pnpm -w test`. Run the issue verbatim repro on the built `bin.cjs`; capture stdout showing `["claude-code"]`. | S | review | W-S1-B, W-S1-C, W-S1-D, W-S1-E |

Single linear wave; max width 1; critical path = A → (B || C || D || E) → F.

**Recommended commit boundary:** one commit covering A; one commit covering B+C (the consolidation refactor); one commit covering D+E (the call-site additions + tests); a final test/lint cleanup commit if needed. Total: 3-4 commits, all on `feature/wi-759-yakccrc-update`. Reviewer may request squash before merge.

---

## §8. Commit boundary

- Branch: `feature/wi-759-yakccrc-update` (already created).
- Conventional Commit prefix: `fix(cli): #759`.
- Suggested final landed commit titles:
  1. `feat(cli): #759 add lib/yakccrc.ts single-source-of-truth for installedHooks`
  2. `refactor(cli): #759 init+uninstall consume lib/yakccrc.ts`
  3. `fix(cli): #759 standalone hooks <ide> install/uninstall updates installedHooks`
  4. (optional) `test(cli): #759 add per-IDE rc-update integration suites`
- Each commit must build and test green in isolation (W-S1-A produces a green module; W-S1-B produces green init; etc.) — bisectability matters because this WI touches `init.ts`.
- Land via PR (`feedback_pr_not_guardian_merge.md`): `gh pr create --title "fix(cli): #759 standalone yakcc hooks <ide> install updates .yakccrc.json installedHooks (closes #759)"`.
- Before opening PR: `git fetch origin && git pull --ff-only origin main` per `feedback_fetch_before_pr.md`.

---

## §9. Decision Log

| DEC-ID | Title | Status | Rationale |
|--------|-------|--------|-----------|
| `DEC-CLI-YAKCCRC-AUTHORITY-001` | `.yakccrc.json` read/write + `installedHooks` mutation is owned by a single module `packages/cli/src/lib/yakccrc.ts`. All 8 callers (init, uninstall, 6 installers) consume it. No command may inline rc I/O. | accepted (WI-759) | Sacred Practice #12 (single source of truth). Before WI-759, 3 separate authorities (init private helpers, uninstall private helper, six installers with NO rc write at all) caused issue #759. Centralizing eliminates the entire class of bug. Option B (inline copies in 6 installers) was rejected as a Sacred-Practice-#12 violation. |
| `DEC-CLI-YAKCCRC-HOMEHOOK-TARGET-001` | For `hooks-{cline,continue,aider}-install`, the project root for `.yakccrc.json` updates is `process.cwd()` (no new `--target` flag is added). Tests inject via an internal `overrideCwd?: string` parameter mirroring the existing `overrideClineDir`/`overrideContinueDir`/`overrideAiderDir` patterns. | accepted (WI-759) | These three IDEs use home-directory marker files; the per-project rc update needs a project anchor. `cwd` matches `yakcc init`'s default (`targetDir = parsed.values.target ?? "."`) and avoids a public CLI surface change (out of WI-759 scope). The internal injection seam matches the precedent already in those three modules. |
| `DEC-CLI-YAKCCRC-CREATE-ON-INSTALL-001` | If `.yakccrc.json` does not exist when `addInstalledHook` is called, the module CREATES a minimal rc with `version: 1` and `installedHooks: [ide]`. Other fields are left absent (populated on the next `yakcc init` run). | accepted (WI-759) | Issue #759 AC3 explicitly requires "After `yakcc hooks <ide> install` on a dir with NO `.yakccrc.json`, the rc file is created (mirror what init does on first install) with `installedHooks: ["<ide>"]`." Alternative — refuse to create on standalone install and require `yakcc init` first — was rejected because it would require the user to run a second command for the obvious case, and contradicts the AC. |
| `DEC-CLI-YAKCCRC-PARSEFAIL-PASSTHROUGH-001` | A corrupt `.yakccrc.json` (invalid JSON) is treated as absent: `readRc` returns null; `addInstalledHook` overwrites it with a fresh minimal rc. | accepted (WI-759) | This matches the existing pre-WI-759 behavior in both `init.ts:122-127` and `uninstall.ts:99-103` (catch+null). Preserving the same swallow-and-overwrite semantics keeps the refactor regression-free. The alternative (refuse to write / throw) would change observable behavior for users with hand-edited rc files. |

---

## §10. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **R1.** Concurrent writes to `.yakccrc.json` from two `yakcc hooks <ide> install` processes (or one install + one init) race and one mutation is lost. | Low (alpha users rarely script parallel installs) | Low (last-writer-wins; user re-runs to recover; no data loss beyond what they were trying to add) | EXPLICITLY ACCEPTED. The same race exists in init.ts and uninstall.ts today. No locking introduced. Documented in plan; informational concurrent-race smoke check in eval contract. |
| **R2.** `init.ts` refactor accidentally changes externally observable behavior (e.g., field ordering, peer-merge edge case). | Medium | Medium | Existing `init.test.ts` is the regression gate. ANY test change is a red flag and the implementer must reconcile before proceeding. Reviewer verifies `init.test.ts` was not modified to make a failing test pass. |
| **R3.** Cline/continue/aider `overrideCwd` injection seam clashes with the existing `overrideClineDir`-style seam (two args to test). | Low | Low | Use named-parameter / options-object pattern if clash is real; otherwise keep two positional args. Implementer chooses the cleaner shape; reviewer verifies signature is documented. |
| **R4.** A future PR adds a 7th IDE installer module and forgets the rc tail call. | Medium | Low | The new module's existence is documented; KNOWN_IDE_NAMES is the source of truth for IDE name list. A defensive (non-required) addition: implementer MAY add a lint check that grep-asserts `addInstalledHook(` appears in any new `hooks-*-install.ts`. Out of scope for this WI; track as backlog if desired. |
| **R5.** Two installers running in the same process call `addInstalledHook` for two different IDEs and the second read misses the first write (in-process race). | Very low (the per-IDE installers are async-awaited in series by init.ts L437-446) | Low | The existing init.ts sequential await loop precludes this; no parallelism is introduced. Documented; no mitigation needed. |
| **R6.** Implementer leaves the inline rc write in `uninstall.ts:304-338` AND adds per-IDE tail calls, resulting in double-write. | Medium (refactor oversight) | Low (idempotent operations; final state is correct) | Eval contract AUTH-1 grep gate catches this: writes to `installedHooks` outside `lib/yakccrc.ts` are flagged. Reviewer must run that grep. |
| **R7.** A test fixture relies on `.yakccrc.json` having `installedHooks: []` after a standalone install (current broken behavior). | Very low (the broken behavior is the bug we are fixing) | Low | Grep for `installedHooks": [\s*]` in test fixtures; expect zero hits in test files relying on the broken state. Implementer fixes any such fixture in the same commit that fixes the bug. |
| **R8.** PR diverges from `main` during landing (other PRs land first). | Medium (active monorepo) | Low | Per `feedback_fetch_before_pr.md`: `git fetch origin && git pull --ff-only origin main` immediately before `gh pr create`. Repeat if CI rebases the branch. |

---

## §11. Progress log

| Date | Phase | Note |
|------|-------|------|
| 2026-05-19 | Plan | Plan authored by `planner` subagent at base `54a43ca`. Issue #759 confirmed open. Worktree `.worktrees/feature-wi-759-yakccrc-update` on branch `feature/wi-759-yakccrc-update` (clean). Scope manifest synced via `cc-policy workflow scope-sync`. |
| — | Implement | (pending guardian:provision → implementer) |
| — | Review | (pending) |
| — | Land | (pending — via PR, not Guardian-merge to main) |
