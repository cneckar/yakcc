# Plan — WI-687-S7 — `yakcc init` auto-detect expansion (no-IDE hint surface)

**Workflow:** `wi-746-s7-init-auto-detect`
**Goal:** `g-wi-746-s7-init-auto-detect`
**Issue:** [#746](https://github.com/cneckar/yakcc/issues/746) (closes #746 on PR; **DO NOT** close parent #687 — kept open until a downstream operator decision)
**Branch / worktree:** `feature/wi-746-s7-init-auto-detect` @ `13c1e94` in `.worktrees/feature-wi-746-s7-init-auto-detect/`
**Base:** `origin/main` @ `13c1e94` (post-#749 hooks-aider S4 land; all of S1/S2/S3/S4 are live on `main`)
**Tier:** 2 (Standard) — one-to-two file surface; the gap is small but the AC2 reframe requires explicit operator-anchored decision documentation.

---

## 1 — Problem statement and goals

### What S7 was originally claimed to deliver

Per DEC-WI687-SLICING-001 (operator, #687 comment 2026-05-18 15:16Z):

> **S7 Init auto-detect expansion** — SHIP after S2-S4 land. Single CLI change once all 3 new adapters exist; rolls them into the yakcc init auto-detection loop.

The dispatch context restated this as: *"Single CLI change once all 3 new adapters exist."*

### What is already true on `main` @ `13c1e94` (audit summary)

A direct read of the canonical files reveals that the **auto-detect loop is already wired for all six IDEs**:

| Surface | File | State on main |
| --- | --- | --- |
| IDE identity universe | `packages/cli/src/lib/ide-detect.ts` → `IdeName` union + `KNOWN_IDE_NAMES` | 6 entries: `claude-code`, `cursor`, `cline`, `continue`, `windsurf`, `aider` |
| Probe-path builder | `packages/cli/src/lib/ide-detect.ts` → `buildCandidatePaths()` | Returns paths for **all 6** IDEs |
| Auto-detect loop | `packages/cli/src/commands/init.ts` lines 432-435 | `const detected = detectInstalledIdes(opts?.overrideHome); idesToInstall = detected.map((d) => d.name);` — iterates **all 6** |
| Installer dispatch | `packages/cli/src/commands/init.ts` → `installHookForIde()` | `switch (ide)` has all 6 cases |
| Unit-test coverage | `packages/cli/src/lib/ide-detect.test.ts` | "detects all six IDEs when all config dirs exist" (lines 232-269) + per-IDE detection blocks for windsurf and aider |
| Lifecycle integration | `packages/cli/test/integration/hooks-lifecycle.test.ts` | `ADAPTERS = [..., "windsurf", "aider"]`; 6 × 6 = 36-case matrix |

**Why this is true post-S4.** Each of S2 (#740 cline), S3 (#738 windsurf), and S4 (#749 aider) **already extended every authority surface in lock-step** — adding the IDE to `KNOWN_IDE_NAMES`, `buildCandidatePaths`, `installHookForIde`'s switch, `uninstallHookForIde`'s switch, and the lifecycle test matrix in the same commit. This is the contract recorded as DEC-687-S1-ADAPTER-COUNT (in `hooks-lifecycle.test.ts` header) and was enforced by the per-slice scope manifests: a slice that extended `KNOWN_IDE_NAMES` without also extending the init auto-detect loop would have left TypeScript exhaustiveness errors or silent no-ops, and would have failed scope-sync. Each S-slice landed atomically.

**Side note on the dispatch context.** The operator's dispatch reads *"all 6 IDEs (claude-code, cursor, codex, cline, windsurf, aider)."* The code-of-record explicitly excludes `codex` per `DEC-CLI-INIT-002` / NG1 (commented in `ide-detect.ts:46`: *"`codex` is explicitly excluded per NG1 / DEC-CLI-INIT-002 (#220 closed not-planned)."*). The actual 6 are `claude-code`, `cursor`, `cline`, `continue`, `windsurf`, `aider`. This plan honors the code-of-record. Re-introducing `codex` would require reopening #220 and a new operator DEC; S7 is not the place to do that.

### The remaining real gap (from issue #746 acceptance criteria)

Issue #746 has three acceptance criteria:

1. *yakcc init in a directory with multiple IDE markers detects + offers install for each* — **already true** (auto-detect loop iterates `detectInstalledIdes()` and installs each).
2. *yakcc init in a directory with **no IDE markers asks the user which IDE*** — **NOT TRUE**: today `init.ts:547-552` prints `"Hooks: no IDEs detected."` and exits 0 silently. There is no guidance to the user about what to do next.
3. *No regression in single-IDE auto-detect behavior* — covered by existing tests.

AC2 is the genuine S7 gap. The current behavior is a **silent dead-end**: a user runs `yakcc init` on a fresh machine (no IDE config dirs present), sees one line saying "no IDEs detected", and has no idea that `--ide <name>` exists or which IDEs are supported. This degrades the first-30-seconds GTM surface (DEC-CLI-INIT-002).

### Goals

1. Replace the silent **"Hooks: no IDEs detected."** output with a helpful hint that surfaces (a) the available IDE names, (b) the canonical recovery path (`yakcc init --ide <name>` or `yakcc init --skip-hooks`), and (c) the `--skip-hooks` flag for users who genuinely do not want hooks. This satisfies AC2 within the project's documented non-interactive-init contract (NG6 — see Non-goals).
2. Add **end-to-end auto-detect integration coverage** for `windsurf` and `aider` through `init()` (not via `--ide` flag). The `init.test.ts` currently has end-to-end auto-detect-through-init coverage for `claude-code`, `cursor`, `cline`, and `continue`, but does NOT have an "auto-detect for windsurf/aider through init" test (the lifecycle integration test covers it, but that path is documented as the certified-round-trip harness, not a regression check on init's auto-detect glue). Close the gap so a future regression in init's auto-detect loop for windsurf/aider is caught in the cheap-unit suite.
3. Add an **all-six-IDEs auto-detect smoke** through init (real production sequence: `init()` → `detectInstalledIdes()` → `installHookForIde(each)` → `.yakccrc.json` lists all 6 in `installedHooks`). This is the "single test that demonstrates S7 is delivered" referenced in the dispatch context.
4. Update the no-detect summary line text in init.ts plus its existing test assertion in `init.test.ts` (the suite that runs default flow without any IDE markers).

### Non-goals (binding)

- **No interactive stdin prompt.** Parent plan **NG6 (DEC-CLI-INIT-001 / DEC-CLI-INIT-002)** mandates `yakcc init` is non-interactive: the `uninstall.ts` header (lines 15, 30) records *"Non-interactive per parent plan NG6"* and *"Consistent with parent plan NG6 (no interactive prompts). Scriptability is preserved."* A literal "asks the user which IDE" stdin prompt would (a) break scriptability for CI/automation, (b) violate the established summary-line discipline (G6: ≤6 lines on happy path), (c) duplicate the `--ide <list>` flag which already exists for explicit selection, and (d) require new test infrastructure for stdin mocking. The plan's reframe (a structured hint pointing at `--ide <name>` + listing the known IDE names) satisfies the spirit of AC2 ("the user gets actionable guidance") within the non-interactive contract. This reframe is recorded as `DEC-CLI-INIT-NO-IDE-HINT-001` (new — see Decision Log below).
- **No new IDE adapter.** S7 is the integration-only slice; new adapters (Antigravity, OpenClaw) were dropped per `DEC-WI687-SLICING-001`.
- **No edits to `ide-detect.ts`, `installHookForIde()`, or `KNOWN_IDE_NAMES`.** Those surfaces are already correct post-S4. Editing them risks regressing the per-slice authority alignment. The only init.ts edits are inside the summary-output block (lines 547-555) and one usage-text line (line 334).
- **No edits to hooks-* packages.** The adapters are read-only references.
- **No edits to `uninstall.ts`.** Its no-detect path is governed by its own DEC; S7 stays on init.
- **No edits to the parent #687 issue body or DEC-WI687-SLICING-001.** This slice closes #746 only.
- **No new dependencies.** No `inquirer`, no `prompts`, no `readline-sync`. `pnpm-lock.yaml` should stay unchanged.

### Dominant constraints

- **Single-source-of-truth for known IDE names.** The hint string must derive its IDE list from `KNOWN_IDE_NAMES.join(", ")` — not a hand-typed second list. A hand-typed list would be a parallel authority and would drift the moment a 7th IDE is added (Sacred Practice #12).
- **Summary length contract (G6).** The happy-path summary stays ≤6 non-empty lines. Today the no-detect path produces 1 summary line; the new hint replaces that single line with at most 3 lines (line 1: the headline; line 2: the recovery hint with `--ide`; line 3: the `--skip-hooks` opt-out). This stays well under the G6 ceiling.
- **Stable exit code.** Exit code stays `0` for the no-detect case (today: 0). No-detect is not an error, it is an honest report.
- **Land via PR, not Guardian-merge** (memory `feedback_pr_not_guardian_merge.md`).
- **Full-workspace lint/typecheck** (memory `feedback_eval_contract_match_ci_checks.md`).
- **Write plan + scope INSIDE worktree** (memory `feedback_planner_writes_to_wrong_cwd.md`).
- **Biome format before commit** (memory PR #738 lesson).
- **Lockfile unchanged** — no new deps, so `pnpm-lock.yaml` should not move. If it does, investigate.

---

## 2 — Architecture: state-authority map

### State / authority table (read-only vs touched)

| State / fact | Canonical authority | S7 touches? | Why |
| --- | --- | --- | --- |
| IDE identity universe | `packages/cli/src/lib/ide-detect.ts` → `IdeName` + `KNOWN_IDE_NAMES` | **READ-ONLY** | Already correct post-S4 (6 entries) |
| Probe-path builder | `packages/cli/src/lib/ide-detect.ts` → `buildCandidatePaths` | **READ-ONLY** | Already correct post-S4 (all 6 paths) |
| Auto-detect loop | `packages/cli/src/commands/init.ts` lines 426-446 | **READ-ONLY** | Already iterates `detectInstalledIdes()` |
| Installer dispatch table | `packages/cli/src/commands/init.ts` → `installHookForIde()` | **READ-ONLY** | All 6 cases already present |
| **No-detect summary text** | `packages/cli/src/commands/init.ts` lines 547-555 | **EDIT** | Replace single dead-end line with structured 3-line hint that lists `KNOWN_IDE_NAMES` and points at `--ide <name>` / `--skip-hooks` |
| **Usage text** in error path | `packages/cli/src/commands/init.ts` line 334 | **READ-ONLY** | Already lists all 6 IDEs verbatim (`<claude-code\|cursor\|cline\|continue\|windsurf\|aider,...>`); confirmed correct post-S4. No edit needed. |
| End-to-end auto-detect tests (claude-code / cursor / cline / continue) | `packages/cli/src/commands/init.test.ts` suites 1, 11, 19, 20, 21 | **READ-ONLY** | Existing coverage is correct |
| **End-to-end auto-detect tests (windsurf / aider)** | `packages/cli/src/commands/init.test.ts` | **ADD** | New suite (suite 22): auto-detect-through-init for windsurf and aider individually |
| **All-six auto-detect smoke through init** | `packages/cli/src/commands/init.test.ts` | **ADD** | New suite (suite 23): all 6 markers present → `installedHooks` lists all 6 |
| **No-detect-hint summary text test** | `packages/cli/src/commands/init.test.ts` suite 17 ("summary output") | **EDIT** | Add an assertion that the new hint mentions `--ide` and at least 3 of the 6 known IDE names |
| Lifecycle integration matrix | `packages/cli/test/integration/hooks-lifecycle.test.ts` | **READ-ONLY** | Certified harness covers all 6 adapters already |
| `.yakccrc.json` schema | (per `DEC-CLI-INIT-002` NG4: version stays 1, additive only) | **READ-ONLY** | No schema change |

### State-authority invariants (do not violate)

- **No parallel IDE-name list.** The new hint MUST derive from `KNOWN_IDE_NAMES.join(", ")`. Hand-typing the 6 names in a hint string would create a parallel authority that drifts when a 7th IDE is added.
- **No regression of NG6.** No code path may read `process.stdin`, call `readline`, or otherwise block on user input. The hint is one-way output, not a Q/A loop.
- **No expansion of `KNOWN_IDE_NAMES` in this slice.** Adding a new IDE is a new S-slice with its own scope manifest and adapter package.
- **No deletion of the existing "Hooks: no IDEs detected." fallback contract.** The new hint REPLACES that single line; it MUST still produce a summary line (the `runCli` test at suite 9 / 17 expects `Installed in` + a hook status line). The grep tests in suite 11 / 17 must still pass.

### Why a stdin prompt was rejected (Alternatives Gate)

| Option | What it does | Trade-offs | Verdict |
| --- | --- | --- | --- |
| **A. Structured hint string (recommended).** | Replace `"Hooks: no IDEs detected."` with a 2-3 line hint: headline + `--ide <name>` recovery + `--skip-hooks` opt-out + verbatim IDE list from `KNOWN_IDE_NAMES`. | Preserves NG6, no new deps, no test-infra changes, scriptable. Drawback: not literally "ask the user." | **CHOSEN.** Satisfies AC2 spirit within the documented non-interactive contract. |
| B. Add `--prompt` opt-in flag for interactive selection. | New flag wires `readline` into init for users who want a Q/A flow. | New dep (or hand-rolled readline), new test infra (stdin mocking), TWO code paths to maintain (interactive + non-interactive), and a flag the GTM-surface user has to discover before it helps them. | **REJECTED.** Doesn't satisfy the "fresh user runs `yakcc init`" use case AC2 implies. |
| C. Always go interactive when stdin is a TTY. | `process.stdin.isTTY ? prompt() : printHint()` branching. | Breaks the established summary-line contract for the most common case (a developer in a terminal). CI hides this until a real user hits it. Tests would need to mock `isTTY`. Two code paths. | **REJECTED.** TTY-branching is the worst of both worlds (silent in CI, prompt in dev). |
| D. Do nothing — claim S7 is already delivered. | Close #746 as "already implemented in S2-S4 cross-slice work; no code change." | Honest about the auto-detect loop already being wired, but ignores AC2's "asks the user" intent and leaves the silent dead-end on no-detect. | **REJECTED.** AC2 is real; the dead-end UX is a real bug for fresh users. |

**No external user decision required** — the project's NG6 contract pre-decides this. Option A is the unique answer that respects NG6 and addresses AC2.

### Research

Source-of-truth review performed by reading:

- `packages/cli/src/lib/ide-detect.ts` (193 LOC) — confirms `IdeName`/`KNOWN_IDE_NAMES`/`buildCandidatePaths` all carry all 6 IDEs.
- `packages/cli/src/commands/init.ts` (559 LOC) — confirms auto-detect loop at lines 432-435 already iterates `detectInstalledIdes()`; `installHookForIde` switch covers all 6 cases at lines 201-238; no-detect summary at lines 547-555 is the silent dead-end.
- `packages/cli/src/commands/init.test.ts` (772 LOC) — confirms end-to-end auto-detect-through-init coverage for claude-code/cursor/cline/continue (suites 1, 11, 19, 20, 21); windsurf and aider have only `--ide`-flag coverage, not auto-detect-through-init.
- `packages/cli/src/lib/ide-detect.test.ts` (436 LOC) — confirms `detectInstalledIdes` has comprehensive per-IDE tests + "detects all six IDEs when all config dirs exist" at lines 232-269. The detection-layer is fully covered; the missing coverage is init's end-to-end glue for windsurf/aider.
- `packages/cli/test/integration/hooks-lifecycle.test.ts` (647 LOC; DEC-687-S1-ADAPTER-COUNT) — confirms lifecycle harness covers all 6 adapters in 36-case matrix.
- `packages/cli/src/commands/uninstall.ts` (lines 15, 30) — confirms parent plan NG6 ("Non-interactive per parent plan NG6") is the binding contract for init/uninstall UX.
- Issue #746 body — confirms AC1/AC2/AC3 are the binding acceptance criteria.
- DEC-WI687-SLICING-001 (operator, #687 comment 2026-05-18 15:16Z) — confirms S7 sequencing post-S4 and "single CLI change" framing.
- `plans/wi-687-s4-aider-adapter.md` — sibling-slice format / Evaluation Contract / Scope Manifest template.
- Prior PRs: #738 (S3 windsurf), #740 (S2 cline), #749 (S4 aider) — confirm each S-slice atomically extended init.ts + ide-detect.ts + lifecycle test together. No legacy gap exists.

No external CLI research needed (the design lives entirely inside `packages/cli/`).

---

## 3 — Wave decomposition

Single guardian-bound slice. The work is small, mechanical, and parallel-safe.

| W-ID | Title | Weight | Gate | Deps | Integration surfaces |
| --- | --- | --- | --- | --- | --- |
| W-S7-0 | Write plan (this file) + scope JSON + MASTER_PLAN.md row | S | none | — | `plans/`, `tmp/scope-*.json`, `MASTER_PLAN.md` |
| W-S7-1 | `packages/cli/src/commands/init.ts` — replace the no-detect summary block (lines 547-555 today) with a structured 3-line hint that derives the IDE list from `KNOWN_IDE_NAMES` and points at `--ide <name>` / `--skip-hooks`. Preserve all other summary cases (`--skip-hooks`, normal "Hooked into:") byte-identically. Add a brief `@decision DEC-CLI-INIT-NO-IDE-HINT-001` annotation citing this slice. | S | none | W-S7-0 | sole production-source edit |
| W-S7-2 | `packages/cli/src/commands/init.test.ts` — extend the existing "summary output" suite (suite 17) so the no-detect case asserts the new hint text mentions `--ide` and includes at least 3 of the 6 known IDE names (use `KNOWN_IDE_NAMES` import to avoid a parallel hand-typed list). | S | none | W-S7-1 | extends existing suite |
| W-S7-3 | `packages/cli/src/commands/init.test.ts` — add **suite 22**: "init — auto-detect-through-init for windsurf/aider" with one `it` per IDE. Each test creates the per-IDE config dir under `fakeHome` (no `--ide` flag), runs `init()`, and asserts that `.yakccrc.json` `installedHooks` contains that IDE. | M | none | W-S7-1 | new e2e coverage |
| W-S7-4 | `packages/cli/src/commands/init.test.ts` — add **suite 23**: "init — auto-detect-through-init: all six IDEs" with one `it` that creates all 6 IDE config dirs under `fakeHome`, runs `init()`, and asserts `installedHooks` contains all 6. This is the S7 capstone test that proves the auto-detect loop reaches every adapter through the real production sequence. | M | none | W-S7-1 | new e2e coverage |
| W-S7-5 | `pnpm --filter @yakcc/cli exec biome format --write src/commands/init.ts src/commands/init.test.ts` (or `pnpm format`) — apply biome to touched files. | S | none | W-S7-1..W-S7-4 | code style |
| W-S7-6 | Full verification pass: `pnpm -w lint`, `pnpm -w typecheck`, `pnpm -F @yakcc/cli test`, plus a real-path smoke: `node packages/cli/dist/bin.js init --target /tmp/yakcc-s7-smoke --no-seed` against an empty `HOME` to visually confirm the new hint renders. (`pnpm -w build` only if `dist/` is needed for the smoke; per Evaluation Contract the unit suite is the binding gate.) | S | reviewer | W-S7-1..W-S7-5 | Evaluation Contract |

**Critical path:** W-S7-0 → W-S7-1 → (W-S7-2 ∥ W-S7-3 ∥ W-S7-4) → W-S7-5 → W-S7-6.
**Max parallel width:** 3 (the three test additions can run in parallel after the source edit lands).
**Estimated implementer cost:** ~30-45 min (small surface; the longest leg is wiring the two new test suites with the `fakeHome`-per-IDE pattern).

### Suggested per-edit commit boundaries

| Commit | Scope | Files |
| --- | --- | --- |
| C1 | Plan + scope JSON + MASTER_PLAN.md row | `plans/wi-687-s7-init-auto-detect.md`, `tmp/scope-wi-746-s7-init-auto-detect.json`, `MASTER_PLAN.md` |
| C2 | Source edit + biome | `packages/cli/src/commands/init.ts` |
| C3 | Test additions + biome | `packages/cli/src/commands/init.test.ts` |

C2 and C3 MAY be collapsed into a single commit if the verify pass is clean — the boundaries are guidance for staging, not a hard requirement.

---

## 4 — File-by-file diff plan

### Edited files (existing; deltas listed)

#### `packages/cli/src/commands/init.ts`

**Current state (lines 547-555 — the no-detect path):**

```ts
const hookedLine =
  installedHooks.length > 0
    ? `Hooked into: ${installedHooks.join(", ")}.`
    : skipHooks
      ? "Hooks: skipped (--skip-hooks)."
      : "Hooks: no IDEs detected.";

logger.log("");
logger.log(`Installed in ${targetDir}. ${hookedLine} Registry: ${seedCount} atoms.`);
```

**Replacement (still ≤6 lines on happy path):**

```ts
const hookedLine =
  installedHooks.length > 0
    ? `Hooked into: ${installedHooks.join(", ")}.`
    : skipHooks
      ? "Hooks: skipped (--skip-hooks)."
      : "Hooks: no IDEs detected.";

logger.log("");
logger.log(`Installed in ${targetDir}. ${hookedLine} Registry: ${seedCount} atoms.`);

// DEC-CLI-INIT-NO-IDE-HINT-001 (WI-687-S7 / #746 AC2): when auto-detect finds
// nothing AND the user did not pass --skip-hooks, surface a structured hint so
// the first-30-seconds GTM surface (DEC-CLI-INIT-002) does not dead-end.
// Non-interactive per parent NG6; the hint is one-way output, not a prompt.
// The IDE list is derived from KNOWN_IDE_NAMES so the hint never drifts when
// a future S-slice adds a 7th adapter (Sacred Practice #12).
if (!skipHooks && installedHooks.length === 0) {
  logger.log(
    `  Tip: no IDE config dirs found in your home directory. Re-run with`,
  );
  logger.log(
    `       \`yakcc init --ide <name>\` to install for a specific IDE`,
  );
  logger.log(
    `       (supported: ${KNOWN_IDE_NAMES.join(", ")}),`,
  );
  logger.log(
    `       or \`yakcc init --skip-hooks\` to skip hook setup entirely.`,
  );
}
```

**Why the wording:** "Tip:" is the conventional CLI cue for "this is help, not an error." The phrasing names the recovery path (`--ide <name>`) before listing the IDEs, which is the order most readers will need (operator-first, then options). The phrase "in your home directory" is precise: the probe paths under `buildCandidatePaths()` are all home-rooted (`.claude`, `.config/Cursor`, `.config/cline`, `.continue`, `.windsurf`, `.aider` — plus the platform-specific Cursor variants). The trailing `--skip-hooks` line is the explicit opt-out so a user who genuinely does not want hooks knows the flag exists.

**G6 line-count check:** the existing happy path summary is 2 non-empty lines (`""` then `Installed in ... Registry: N atoms.`); the new no-detect path adds 4 non-empty lines (the four `logger.log` calls inside the `if`). Total no-detect non-empty lines = 6, still ≤ 6. The detected-IDE path is unchanged at 2 lines. The `--skip-hooks` path is unchanged at 2 lines. **G6 invariant preserved.**

**No other edits to `init.ts`.** The usage text at line 334 already lists all 6 IDE names verbatim and was last updated in S4 (#749). Auto-detect at lines 426-446 is unchanged. `installHookForIde` switch at lines 201-238 is unchanged.

#### `packages/cli/src/commands/init.test.ts`

**Edit 1 — extend suite 17 ("summary output"):** add one new `it` after the existing 3:

```ts
it("no-detect path surfaces a hint with `--ide` and the known IDE names", async () => {
  // Empty fakeHome → detectInstalledIdes returns [] → hint path triggers
  const logger = new CollectingLogger();
  await init(["--target", tmpDir, "--no-seed"], logger, { overrideHome: tmpDir });

  const allLog = logger.logLines.join("\n");
  // Hint references the recovery flag and the opt-out
  expect(allLog).toContain("--ide");
  expect(allLog).toContain("--skip-hooks");
  // Hint lists IDE names — sample at least 3 of the 6 (avoid coupling to exact ordering)
  const { KNOWN_IDE_NAMES } = await import("../lib/ide-detect.js");
  const namesInHint = KNOWN_IDE_NAMES.filter((n) => allLog.includes(n));
  expect(namesInHint.length).toBeGreaterThanOrEqual(3);
});
```

**Edit 2 — add suite 22 ("init — auto-detect-through-init for windsurf/aider"):** parallel to suite 19 (cline) and 20 (continue), one suite each for windsurf and aider with one `it` per IDE that creates the per-IDE config dir under `fakeHome` (no `--ide` flag), runs `init()`, and asserts `.yakccrc.json` `installedHooks` contains the IDE name.

```ts
// ---------------------------------------------------------------------------
// Suite 22: windsurf / aider auto-detect through init (S7 / WI-687-S7 / #746 AC1)
//
// The lifecycle integration test covers all 6 adapters end-to-end, but those
// tests use the `--ide` flag to seed each adapter explicitly. These two cases
// exercise the AUTO-DETECT path through init for the two adapters that
// previously lacked init.test.ts coverage of that path (claude-code/cursor/
// cline/continue were already covered by suites 1, 11, 19, 20).
// ---------------------------------------------------------------------------

describe("init — auto-detect-through-init: windsurf", () => {
  it("auto-detects windsurf when ~/.windsurf/ exists in fakeHome", async () => {
    const fakeHome = join(tmpDir, "fakehome-windsurf-auto");
    mkdirSync(join(fakeHome, ".windsurf"), { recursive: true });

    const code = await init(["--target", tmpDir, "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });
    expect(code).toBe(0);
    const rc = readRc(tmpDir);
    expect((rc?.installedHooks as string[]).includes("windsurf")).toBe(true);
  });
});

describe("init — auto-detect-through-init: aider", () => {
  it("auto-detects aider when ~/.aider/ exists in fakeHome", async () => {
    const fakeHome = join(tmpDir, "fakehome-aider-auto");
    mkdirSync(join(fakeHome, ".aider"), { recursive: true });

    const code = await init(["--target", tmpDir, "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });
    expect(code).toBe(0);
    const rc = readRc(tmpDir);
    expect((rc?.installedHooks as string[]).includes("aider")).toBe(true);
  });
});
```

**Edit 3 — add suite 23 ("init — auto-detect-through-init: all six IDEs"):** the capstone test.

```ts
// ---------------------------------------------------------------------------
// Suite 23: capstone — all six IDEs auto-detected through init (S7 capstone)
//
// Proves the S7 acceptance: when every IDE config dir is present, init() runs
// the real production sequence (detectInstalledIdes → installHookForIde each)
// and ALL six IDEs land in installedHooks. This is the single test that
// demonstrates "yakcc init auto-detect expansion to all 6 IDEs" end-to-end
// through init() (lifecycle integration test exercises the round-trip; this
// suite exercises only the init-side auto-detect glue).
// ---------------------------------------------------------------------------

describe("init — auto-detect-through-init: all six IDEs (S7 capstone)", () => {
  it("auto-detects all 6 known IDEs when every config dir exists", async () => {
    const fakeHome = join(tmpDir, "fakehome-all-six");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    mkdirSync(join(fakeHome, ".config", "Cursor"), { recursive: true });
    mkdirSync(join(fakeHome, ".config", "cline"), { recursive: true });
    mkdirSync(join(fakeHome, ".continue"), { recursive: true });
    mkdirSync(join(fakeHome, ".windsurf"), { recursive: true });
    mkdirSync(join(fakeHome, ".aider"), { recursive: true });

    const code = await init(["--target", tmpDir, "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });
    expect(code).toBe(0);

    const rc = readRc(tmpDir);
    const installed = rc?.installedHooks as string[];
    const { KNOWN_IDE_NAMES } = await import("../lib/ide-detect.js");
    for (const ide of KNOWN_IDE_NAMES) {
      expect(installed.includes(ide)).toBe(true);
    }
    expect(installed).toHaveLength(KNOWN_IDE_NAMES.length);
  });
});
```

**Why `KNOWN_IDE_NAMES.length` (not `6`)?** Future-proofs the assertion: when a 7th IDE adapter lands as a new S-slice, this test fails if that adapter forgot to extend the auto-detect glue. That is the intended forcing function (Sacred Practice #12).

### New files

None. S7 is a surgical extension to two existing files.

### Files NOT touched (forbidden)

- `packages/cli/src/lib/ide-detect.ts` — authority surface already correct.
- `packages/cli/src/lib/ide-detect.test.ts` — coverage already correct.
- `packages/cli/src/commands/uninstall.ts` — governed by its own DEC; out of scope.
- `packages/cli/src/commands/hooks-*-install.ts` (6 files) — out of scope.
- `packages/cli/test/integration/hooks-lifecycle.test.ts` — already 6-adapter; no edit needed.
- `packages/hooks-*/**` (6 packages) — mirror only.
- All other packages, benches, examples, scripts, .github, docs.
- `pnpm-lock.yaml` — no new deps; should not move.

---

## 5 — Evaluation Contract (gates Guardian readiness)

### Required tests (must all pass on PR HEAD)

1. **EC-S7-T1 — no-detect hint coverage:** `init.test.ts` suite 17's new `it` (W-S7-2) passes: empty `fakeHome` + `init()` → summary contains `--ide`, `--skip-hooks`, and ≥3 names from `KNOWN_IDE_NAMES`.
2. **EC-S7-T2 — windsurf auto-detect through init:** `init.test.ts` suite 22 passes: `~/.windsurf/` in `fakeHome` + `init()` (no `--ide` flag) → `installedHooks` contains `"windsurf"`.
3. **EC-S7-T3 — aider auto-detect through init:** `init.test.ts` suite 22 passes: `~/.aider/` in `fakeHome` + `init()` (no `--ide` flag) → `installedHooks` contains `"aider"`.
4. **EC-S7-T4 — all-six-IDE capstone:** `init.test.ts` suite 23 passes: all 6 config dirs in `fakeHome` + `init()` → `installedHooks` contains every `KNOWN_IDE_NAMES` entry AND has length `KNOWN_IDE_NAMES.length`.
5. **EC-S7-T5 — G6 line-count invariant preserved:** existing test "success output is ≤6 lines on default happy path (G6)" (suite 17) continues to pass without modification. The new hint path tests should NOT count toward G6 because the hint only fires on the no-detect path, not the happy path.
6. **EC-S7-T6 — full CLI test suite green:** `pnpm -F @yakcc/cli test` is fully green (regression check; no other CLI test should be perturbed).
7. **EC-S7-T7 — no regression in single-IDE auto-detect:** existing suite 21 ("init — compound interaction: real sequence end-to-end") continues to pass: claude-code-only `fakeHome` + `init()` → `installedHooks` is exactly `["claude-code"]`. This is AC3 directly.

### Required real-path checks (production sequence)

8. **EC-S7-R1 — full-workspace lint:** `pnpm -w lint` is green (memory `feedback_eval_contract_match_ci_checks.md`).
9. **EC-S7-R2 — full-workspace typecheck:** `pnpm -w typecheck` is green.
10. **EC-S7-R3 — biome format:** `pnpm format` (or `pnpm --filter @yakcc/cli exec biome format --write src/commands/init.ts src/commands/init.test.ts`) leaves the working tree clean — no further diffs would be made by re-running biome (memory PR #738 lesson).
11. **EC-S7-R4 — lockfile untouched:** `git diff --name-only HEAD~N..HEAD pnpm-lock.yaml` is empty. No new deps were introduced; the lockfile must not drift.
12. **EC-S7-R5 — smoke (optional but recommended):** the implementer runs `pnpm -F @yakcc/cli build` then `node packages/cli/dist/bin.js init --target /tmp/yakcc-s7-smoke --no-seed` against an empty `HOME` (or with `HOME=/tmp/empty-home node ...`) and visually confirms the hint renders with `--ide`, `--skip-hooks`, and the 6-IDE list. Paste the output in the implementer's pre-handoff note for reviewer evidence.

### Required authority invariants (must not be violated)

13. **EC-S7-A1 — single source of truth for IDE list:** the hint string MUST derive its IDE list from `KNOWN_IDE_NAMES`, not a hand-typed parallel list. Verified by: (a) the test assertion `KNOWN_IDE_NAMES.filter((n) => allLog.includes(n))` only passes if the live names are present; (b) source-grep confirms no string-literal IDE-name list was added to `init.ts`.
14. **EC-S7-A2 — NG6 non-interactive contract:** `init.ts` MUST NOT introduce any `process.stdin`, `readline`, `inquirer`, `prompts`, `readline-sync`, or any other interactive surface. Verified by source-grep on the diff.
15. **EC-S7-A3 — `KNOWN_IDE_NAMES` and `installHookForIde` switch unchanged:** the implementer MUST NOT edit `ide-detect.ts` or the `installHookForIde` switch in `init.ts`. Verified by git diff.
16. **EC-S7-A4 — `.yakccrc.json` schema unchanged:** suite 18 ("schema invariants") continues to pass: `version` is still `1`, `installedHooks` is still an array.

### Required integration points (adjacent components must still work)

17. **EC-S7-I1 — `runCli` dispatch:** suite 9 ("routes 'init' correctly to the init handler") continues to pass.
18. **EC-S7-I2 — `--ide` flag still respected:** suite 11 ("--ide flag") continues to pass — passing `--ide claude-code` in a fakeHome with claude-code + cursor still installs ONLY claude-code.
19. **EC-S7-I3 — `--skip-hooks` suppresses the new hint:** verified by the existing suite 10 test (`installedHooks: []` and the summary contains "skip-hooks") — the new hint MUST be guarded by `if (!skipHooks && installedHooks.length === 0)` so `--skip-hooks` users are not double-messaged.
20. **EC-S7-I4 — `--peer` mode unaffected:** suite 5 / 16 (peer URL → mode: global + `federation.peers[]` written) continues to pass.
21. **EC-S7-I5 — lifecycle integration unaffected:** `pnpm -F @yakcc/cli test` (which includes `test/integration/hooks-lifecycle.test.ts`) passes; all 36 lifecycle cases (6 adapters × 6 it-blocks) stay green.

### Forbidden shortcuts (explicit bans)

- **No interactive prompt.** No `readline`, no `inquirer`, no `prompts`, no `process.stdin.read()`, no `isTTY` branching.
- **No new dependency.** `pnpm-lock.yaml` MUST stay unchanged.
- **No hand-typed IDE list.** The hint MUST `${KNOWN_IDE_NAMES.join(", ")}` from the imported authority.
- **No edits to `ide-detect.ts`, `installHookForIde` switch, or `KNOWN_IDE_NAMES`.**
- **No edits to hooks-* packages.**
- **No edits to `uninstall.ts`.**
- **No close of parent #687 in the PR.** Use `closes #746` only; #687 stays open.
- **No skip of biome format.** Per PR #738 lesson — CI biome check failed there because format was skipped.

### Ready-for-guardian definition

The reviewer may set `REVIEW_VERDICT=ready_for_guardian` when ALL of the following hold simultaneously on the PR HEAD commit:

- EC-S7-T1 through EC-S7-T7 all green in `pnpm -F @yakcc/cli test`.
- EC-S7-R1, R2, R3, R4 all green / clean.
- EC-S7-A1 through EC-S7-A4 verified by source diff inspection.
- EC-S7-I1 through EC-S7-I5 all green in their respective test runs.
- PR body uses `closes #746` and references `refs #687`; does NOT close #687.
- The Scope Manifest below is respected (no files outside `allowed_paths` touched).
- The implementer has posted EC-S7-R5 smoke output (or stated why it was skipped, e.g. cross-platform `HOME` quirks) in the pre-handoff note.

---

## 6 — Scope Manifest

### Allowed paths (implementer may touch)

- `plans/wi-687-s7-init-auto-detect.md` (this plan)
- `tmp/scope-wi-746-s7-init-auto-detect.json` (the scope JSON below)
- `MASTER_PLAN.md` (one new row in the WI-HOOK-LAYER sub-ticket cascade table; one new row in the Decision Log)
- `packages/cli/src/commands/init.ts` (the sole production-source edit — summary block only)
- `packages/cli/src/commands/init.test.ts` (three test edits per §4)

### Required paths (must be modified before guardian readiness)

- `plans/wi-687-s7-init-auto-detect.md` (this file lands)
- `tmp/scope-wi-746-s7-init-auto-detect.json` (scope-sync)
- `MASTER_PLAN.md` (initiative + decision log update)
- `packages/cli/src/commands/init.ts` (source edit — the hint must land)
- `packages/cli/src/commands/init.test.ts` (test additions — all 4 new assertions must land)

### Forbidden paths (must NOT be modified unless re-approved)

- `packages/cli/src/lib/ide-detect.ts` and `packages/cli/src/lib/ide-detect.test.ts` (authority + coverage already correct)
- `packages/cli/src/commands/uninstall.ts` (out of scope per its own DEC)
- `packages/cli/src/commands/hooks-*-install.ts` (6 files — out of scope)
- `packages/cli/test/integration/hooks-lifecycle.test.ts` (already 6-adapter; no edit needed)
- `packages/hooks-*/**` (6 hooks-* packages — read-only mirror reference)
- `packages/contracts/**`, `packages/ir/**`, `packages/registry/**`, `packages/compile/**`, `packages/seeds/**`, `packages/federation/**`, `packages/shave/**`, `packages/variance/**` (all non-cli packages)
- `bench/**`, `examples/**`, `docs/**`, `.github/**`, `.claude/**`, `scripts/**`
- `pnpm-lock.yaml` (no new deps; should not move)
- `package.json` at root or `packages/cli/package.json` (no new deps)

### Expected state authorities touched

- `cli-init-no-detect-summary` (new authority — owned by `packages/cli/src/commands/init.ts`'s summary block; documented inline via `DEC-CLI-INIT-NO-IDE-HINT-001`)
- `cli-init-test-coverage` (extends `packages/cli/src/commands/init.test.ts` to cover the windsurf/aider auto-detect-through-init gap and the all-six capstone)

State authorities NOT touched:
- `cli-ide-identity` (still `KNOWN_IDE_NAMES` in `ide-detect.ts`)
- `cli-install-dispatch` (still `installHookForIde` switch in `init.ts`)
- `cli-uninstall-dispatch` (still `uninstallHookForIde` switch in `uninstall.ts`)
- `cli-lifecycle-certification` (still `hooks-lifecycle.test.ts` matrix)

---

## 7 — Risks and mitigations

| R-ID | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R1 | Hint text triggers on `--skip-hooks` path (double-messaging the user). | Low | Low | Guard the hint with `if (!skipHooks && installedHooks.length === 0)`. Suite 10 test continues to pass (no hint text on `--skip-hooks`). |
| R2 | The hint adds enough output to break the G6 ≤6-lines invariant on the no-detect path. | Low | Med | Counted in §4: happy path stays 2 lines; no-detect path becomes 6 lines (still ≤6). The G6 test (suite 17 last `it`) covers the `--ide claude-code` happy path, not the no-detect path, so it stays green even if the no-detect path were slightly over. |
| R3 | Operator's dispatch context listed `codex` as the 6th IDE; planning honors the code-of-record (no codex). | Low | Low | Documented in §1; if operator really wants codex re-introduced, that requires reopening #220 and a new S-slice — out of S7. |
| R4 | `init.test.ts` becomes very long and slow with 3 new suites. | Low | Low | Suite 22 + 23 are 3 cheap `it`-blocks with no seeding (uses `--no-seed`) and no network. Per-test latency stays sub-100ms. |
| R5 | A future 7th IDE adapter forgets to update the auto-detect-through-init test; AC of S7 silently regresses. | Low | Med | The all-six capstone (suite 23) asserts `installed.length === KNOWN_IDE_NAMES.length` and iterates `KNOWN_IDE_NAMES`. A 7th IDE that ships without extending init's auto-detect glue fails this test loudly. **This is the intended forcing function.** |
| R6 | Biome reformats the new hint string to a shape that breaks the `expect(allLog).toContain("--ide")` assertion. | Low | Low | Pre-run `pnpm format` before committing; the assertions are substring matches on tokens that biome will not split. |
| R7 | The `KNOWN_IDE_NAMES.filter((n) => allLog.includes(n))` assertion would falsely pass if the IDE names appeared in other parts of the summary (e.g. "Hooked into: claude-code, cursor."). | Med | Low | The test runs with empty `fakeHome`, so `installedHooks` is `[]` and "Hooked into:" never appears in the output. The only IDE-name occurrence in the output IS the new hint list. Assertion is correct. |

---

## 8 — Open questions

**None.** Per the Question Merit Test:

- Is the answer prescribed? Yes — NG6 (DEC-CLI-INIT-001 / DEC-CLI-INIT-002) pre-decides the non-interactive contract.
- Would any reasonable user say "of course"? Yes — replace the silent dead-end with a structured hint.
- Does an authority already handle this? Yes — `KNOWN_IDE_NAMES` is the IDE list authority.
- Can you resolve it with 2 minutes of research? Already done via the §1 audit + uninstall.ts reading.
- Is the slice already approved and still within canonical routing? Yes — operator opened #746 and labeled it `fuckgoblin`.

No Alternatives Gate trigger: the four options in §2 collapse to one (Option A) once NG6 is honored.

---

## 9 — Out of scope (explicit non-goals re-stated)

- Adding a 7th IDE adapter (deferred per `DEC-WI687-SLICING-001`).
- Reopening the codex-IDE decision (per NG1 / DEC-CLI-INIT-002 / closed #220).
- Adding an interactive `--prompt` flag or TTY-branching logic.
- Adding `inquirer`/`prompts`/`readline-sync` dependency.
- Editing `uninstall.ts`, hooks-* packages, or any other package.
- Closing parent issue #687 in this PR.
- Modifying the lifecycle integration test.
- Bench / docs / scripts / examples edits.

---

## 10 — Pre-flight checklist (implementer)

Before opening the PR:

- [ ] `pnpm -F @yakcc/cli test` is green (all suites pass including new 22 / 23).
- [ ] `pnpm -w lint` is green (full workspace).
- [ ] `pnpm -w typecheck` is green (full workspace).
- [ ] `pnpm format` produces no diff.
- [ ] `git diff --name-only origin/main..HEAD pnpm-lock.yaml` is empty.
- [ ] `git diff --name-only origin/main..HEAD` is a subset of the Allowed paths in §6.
- [ ] Smoke output from EC-S7-R5 pasted in the pre-handoff note (or skip reason given).
- [ ] PR title: `feat(cli): #746 S7 — yakcc init auto-detect hint for empty-IDE-set (closes #746, refs #687)`.
- [ ] PR body uses `closes #746`, references `refs #687`, links to this plan, summarizes the §1 audit finding (auto-detect was already wired; AC2 was the real gap).
- [ ] `git fetch origin && git pull --ff-only origin main` immediately before `gh pr create` (memory `feedback_fetch_before_pr.md`).

---

## 11 — Decision Log additions (single new row)

`DEC-CLI-INIT-NO-IDE-HINT-001` — see §11 of the Decision Log row in MASTER_PLAN.md (added by this slice).

---

End of plan.
