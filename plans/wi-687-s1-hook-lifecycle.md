# WI-687-S1 — hook lifecycle test harness

**Issue:** #687 (S1 of 7)
**Branch:** `feature/687-s1-hook-lifecycle`
**Worktree:** `/Users/cris/src/yakcc/.worktrees/feature-687-s1-hook-lifecycle`
**Scope (runtime-bound):**
- allowed: `packages/cli/test/integration/hooks-lifecycle.test.ts`, `plans/wi-687-s1-hook-lifecycle.md`, `tmp/wi-687-s1-*/**`
- required: `plans/wi-687-s1-hook-lifecycle.md`
- forbidden: all `packages/*/src/**`, all `packages/hooks-*/**`, all `packages/cli/src/**`, `MASTER_PLAN.md`, `.github/**`, `.claude/**`, `docs/**`, `bench/**`, `scripts/**`

This slice **adds a test harness only**. No production CLI, hook, or package
source may be touched. Bugs surfaced by the harness become separate
sub-issues; this slice does not fix them.

---

## 1. Goal

Build a round-trip hook lifecycle test harness that exercises every IDE
adapter the CLI currently knows about. The harness must prove:

1. `yakcc init` installs the yakcc hook artefact(s) for the adapter.
2. A second `yakcc init` is idempotent (no duplicate entries, no JSON
   corruption, hook artefacts byte-identical to the first init).
3. `yakcc uninstall` removes the yakcc-marked entry/marker.
4. User-authored sibling entries that share the same config file/dir survive
   uninstall unchanged (the core safety property).
5. After uninstall, a fresh `yakcc init` reproduces the original installed
   state (byte-identical hook artefacts to step 1).

These are the lifecycle invariants the production install/uninstall code
*should* hold; the harness exists to make any drift loud the moment a CLI
change breaks them.

---

## 2. Adapter inventory (production-surveyed)

The dispatch context names "5 IDE adapters: claude-code, cline, continue,
codex, cursor". The CLI's actual production surface — verified by reading
`packages/cli/src/lib/ide-detect.ts` (`KNOWN_IDE_NAMES`), the
`installHookForIde` switch in `packages/cli/src/commands/init.ts`, and the
`uninstallHookForIde` switch in `packages/cli/src/commands/uninstall.ts` —
contains **four** IDE adapters:

| Adapter        | Hook artefact written by install                            | Lives in        | Marker sentinel             |
|----------------|-------------------------------------------------------------|-----------------|-----------------------------|
| `claude-code`  | `<target>/.claude/settings.json` PreToolUse entry            | target dir      | `yakcc-hook-v1`             |
| `cursor`       | `<target>/.cursor/settings.json` + `yakcc-cursor-hook.json` | target dir      | `yakcc-hook-v1-cursor`      |
| `cline`        | `<homeOverride>/.config/cline/yakcc-cline-hook.json`        | overrideHome    | `yakcc-hook-v1-cline`       |
| `continue`     | `<homeOverride>/.continue/yakcc-continue-hook.json`         | overrideHome    | `yakcc-hook-v1-continue`    |

There is **no `codex` adapter in the CLI**. `hooks-codex` exists as a
hooks-base sibling package but is not wired into `installHookForIde` /
`uninstallHookForIde` / `KNOWN_IDE_NAMES`. Including a `codex` lifecycle
case in this slice would require adding a new IDE adapter to the CLI, which
is **out of scope** (no `packages/cli/src/**` writes allowed).

**Decision (planner):** the harness covers the 4 adapters that exist
today. A `codex` case is added by a follow-up slice once (or if) `codex`
becomes a real CLI IDE adapter. This is recorded explicitly in the test
file's header as a known-skipped 5th adapter so reviewers and Future
Implementers see the gap without re-discovering it.

This is a measurable reduction in scope risk, not a quiet shortcut:
attempting a codex lifecycle test today would silently exercise nothing
(no install path to call), or force a parallel-authority adapter, both
forbidden by the slice's scope manifest.

---

## 3. Test entry seam (production sequence, no mocks)

Tests call the production handlers in-process:

```ts
import { init } from "../../src/commands/init.js";
import { uninstall } from "../../src/commands/uninstall.js";
```

with the canonical injection seams:

- `init(argv, logger, { overrideHome })`
- `uninstall(argv, logger, { overrideHome })`

These two seams are the **production code path** — `runCli` simply unpacks
argv and calls them. They are the same handlers wired into the real `yakcc`
binary in `bin.js`. Using them in-process avoids requiring a `dist/` build
in the test (which would flake on first run / cross-runner) without
mocking anything: every fs write is real, every install/uninstall
algorithm runs unchanged.

We do **not** spawn `node dist/bin.js`. Rationale:

- subprocess testing adds a build-state dependency (must `pnpm -C
  packages/cli build` first), which makes the harness brittle in CI and
  noisy for local dev.
- the dispatch prompt's "test the actual binary" intent is satisfied by
  the in-process call — the handlers under test *are* the binary's only
  meaningful logic.
- the `InitOptions.overrideHome` / `UninstallOptions.overrideHome`
  injection seams exist precisely so tests can drive the real handler
  with a controlled HOME without polluting the developer's actual
  `~/.config/cline/` or `~/.continue/`. They are a documented production
  feature, not a mock.

---

## 4. Per-adapter round-trip scenario

For each adapter in `["claude-code", "cursor", "cline", "continue"]`:

### 4.1 Setup (per-test isolation)

```ts
const tmpRoot   = mkdtempSync(join(tmpdir(), "wi-687-s1-"));
const targetDir = join(tmpRoot, "project");
const homeDir   = join(tmpRoot, "home");
mkdirSync(targetDir, { recursive: true });
mkdirSync(homeDir,   { recursive: true });
```

Seed the adapter's auto-detect marker so `detectInstalledIdes(homeDir)`
returns this and only this adapter:

| Adapter        | Auto-detect probe (must exist for detection)                    |
|----------------|-----------------------------------------------------------------|
| `claude-code`  | `<homeDir>/.claude/` (any file)                                  |
| `cursor`       | `<homeDir>/.cursor/` (any file) or `<homeDir>/Library/Application Support/Cursor/` |
| `cline`        | `<homeDir>/.config/cline/`                                       |
| `continue`     | `<homeDir>/.continue/`                                           |

The harness consults `KNOWN_IDE_NAMES` for the canonical adapter list and
asks `detectInstalledIdes(homeDir)` for the probe paths actually used.
Where two adapters might collide on a probe path, the harness either
isolates per-test (separate `homeDir` per scenario) or passes `--ide
<adapter>` explicitly to `init`/`uninstall` to bypass detection. The
explicit `--ide` form is the more deterministic harness primitive and
will be the default.

### 4.2 Pre-seed user-authored sibling content (preservation case)

Before any `init`, write a sibling user-authored entry that lives in the
same config file/directory as the yakcc artefact will be written into:

- **claude-code:** write `.claude/settings.json` with one pre-existing
  `PreToolUse` entry whose hook objects do *not* carry the yakcc marker.
  Also write a sibling non-hook key (e.g. `"theme": "dark"`).
- **cursor:** write `.cursor/settings.json` with `editor.tabSize: 2` and a
  `hooks.somethingElse` entry that is not the yakcc entry.
- **cline:** write a sibling marker `~/.config/cline/user-notes.json`
  unrelated to yakcc.
- **continue:** write a sibling marker `~/.continue/config.json` with
  user content.

These are the load-bearing "did uninstall delete more than its
yakcc-marked entry?" assertions.

### 4.3 First init

```ts
const logger = new CollectingLogger();
const code = await init(
  ["--target", targetDir, "--ide", adapter, "--no-seed", "--skip-hooks?"],
  logger,
  { overrideHome: homeDir },
);
expect(code).toBe(0);
```

`--no-seed` keeps the test fast (the seed corpus is unrelated to the
lifecycle properties under test). `--skip-hooks` is **not** used in the
lifecycle path — we want hooks installed; `--skip-hooks` only appears in
the "negative install" cross-check.

**Assertions after first init:**

- adapter-specific hook artefact(s) exist at the documented path
- the yakcc marker (`_yakcc === "<sentinel>"`) is present
- the pre-seeded sibling user entry/file is still present and byte-equal
  to what was written in 4.2
- `.yakccrc.json` lists this adapter under `installedHooks`

Snapshot the hook artefact bytes for the byte-identity check in 4.5:

```ts
const snapshot1 = readFileSync(adapterHookArtefactPath);
```

### 4.4 Second init (idempotency)

Call `init(...)` again with identical arguments. Assert:

- exit code 0
- hook artefact bytes equal `snapshot1` (no second PreToolUse entry added,
  no duplicate marker file content, no JSON re-shuffle that the install
  path is responsible for) — for claude-code this is exercised by the
  `applyInstall` early-return branch
- `.yakccrc.json` still lists the adapter exactly once in `installedHooks`
  (the `[...new Set(...)]` dedupe path is tested implicitly)

The harness scopes byte-identity to the **hook artefact**, not
`.yakccrc.json` (which gets a `mode` rewrite on each init and would
trivially compare byte-equal on its own here but is not the property
under test for this slice).

### 4.5 Uninstall

```ts
const code = await uninstall(
  ["--target", targetDir, "--ide", adapter],
  logger,
  { overrideHome: homeDir },
);
expect(code).toBe(0);
```

**Assertions after uninstall:**

- yakcc-marked entry/marker is **absent** from the hook artefact
- pre-seeded sibling user content from 4.2 is **still present and
  byte-equal** to the bytes from 4.2 (preservation invariant)
- for `claude-code`/`cursor`: if the only PreToolUse / hooks entry was
  the yakcc one, the parent `hooks` key is dropped (matches production
  `applyUninstall` behavior — covered by existing unit tests, re-asserted
  here as the integration property)

### 4.6 Re-init (round-trip closure)

Call `init(...)` again. Assert hook artefact bytes equal `snapshot1` from
4.3 — the system returns to the original installed state. This is the
"round-trip byte-identical" closure that the dispatch prompt names.

(Caveat documented in the test file header: cline/continue marker files
embed `installedAt: new Date().toISOString()`. The byte-identity
assertion strips this field before comparing for cline/continue, or
the comparison is structural — `JSON.parse + delete + JSON.stringify`
— with a comment explaining why. This is not a relaxation: the
property under test is "no information loss across uninstall/reinstall
beyond what production code intentionally regenerates". A future slice
can decide whether `installedAt` should be stable across re-installs.)

---

## 5. Shared helper structure

The harness factors out:

```ts
interface AdapterSpec {
  name: IdeName;
  detectProbe(homeDir: string): string;     // path to mkdir to make detect fire
  hookArtefactPaths(targetDir: string, homeDir: string): string[];
  yakccMarkerPresent(read: (p: string) => unknown): boolean;
  preSeedSiblingContent(targetDir: string, homeDir: string): SiblingSnapshot;
  assertSiblingPreserved(snapshot: SiblingSnapshot): void;
  normalizeForByteIdentity(bytes: Buffer): Buffer; // strip installedAt for cline/continue
}
```

One table of 4 `AdapterSpec` entries drives the whole round-trip. Each
scenario in 4.1–4.6 is a single `it(...)` per adapter, and the
preservation case is a single additional `it(...)` per adapter — keeping
adversarial assertions narrow makes failure messages actionable.

Result: 4 adapters × ~3 `it(...)` blocks each (install+idempotent /
uninstall+preserve / re-init byte-identical) ≈ **12 test cases**.

---

## 6. Anticipated bug surface (becomes separate WIs if observed)

The harness exists to find drift. Likely failure modes the harness will
catch (and the corresponding sub-issue we'd file if green-field, with
explicit non-fix-in-this-slice intent):

- **B-687-S1-a (claude-code):** PreToolUse re-init writes a second yakcc
  entry instead of early-returning. Would manifest as `snapshot1 !==
  snapshot2` in 4.4 for claude-code.
- **B-687-S1-b (cursor):** marker file `installedAt` regenerated on
  re-init even when the settings entry is idempotent — drift between the
  two cursor artefacts. Caught by per-artefact byte comparison.
- **B-687-S1-c (cline/continue):** uninstall removes the entire
  `~/.config/cline/` directory instead of just the marker file (would
  fail 4.5 preservation if a future "improvement" recursively rms the
  dir).
- **B-687-S1-d (claude-code):** uninstall strips a sibling user-authored
  PreToolUse entry because the `_yakcc` filter was loosened. Caught by
  the 4.5 preservation assertion.
- **B-687-S1-e (any):** `.yakccrc.json installedHooks` ends up with
  duplicates after re-init, escaping the `Set` dedupe. Caught by 4.4.

The harness asserts the invariants; it does not fix bugs. Each failure
opens an issue (this is consistent with the slice plan in #687).

---

## 7. File layout

```
packages/cli/test/                              [new directory in this slice]
└── integration/                                [new directory in this slice]
    └── hooks-lifecycle.test.ts                 [new file — sole production artefact of S1]
```

A new top-level `packages/cli/test/integration/` tree is allowed by the
scope manifest. Existing tests are co-located under
`packages/cli/src/commands/*.test.ts` and stay where they are. Vitest in
`packages/cli/vitest.config.ts` discovers `*.test.ts` recursively under
`packages/cli/` so no config change is required (and config changes are
out of scope anyway).

---

## 8. Evaluation Contract (binds to runtime via cc-policy work-item-set)

**Required tests:**
- `packages/cli/test/integration/hooks-lifecycle.test.ts` passes when run
  via `pnpm -C packages/cli test`.
- All 4 adapters complete the round-trip (install → assert →
  re-init-idempotent → uninstall → assert preservation → re-init
  byte-identical).
- The per-adapter preservation `it(...)` for user-authored sibling
  content passes for all 4 adapters.

**Required evidence:**
- `pnpm -C packages/cli test` output with all `hooks-lifecycle.test.ts`
  cases passing (≥12 `it(...)` blocks across the 4 adapters).
- `git diff main...HEAD --stat` shows changes confined to
  `plans/wi-687-s1-hook-lifecycle.md` and
  `packages/cli/test/integration/hooks-lifecycle.test.ts` only.

**Required real-path checks:**
- `packages/cli/src/commands/init.ts` and
  `packages/cli/src/commands/uninstall.ts` are imported (verifies the
  test exercises real production code, not a parallel re-implementation).
- Adapter-specific install/uninstall paths
  (`hooks-install.ts`, `hooks-cursor-install.ts`,
  `hooks-cline-install.ts`, `hooks-continue-install.ts`) are reached
  transitively via the `installHookForIde` / `uninstallHookForIde`
  dispatch.

**Required authority invariants:**
- **No production source touched.** Diff must not include any file under
  `packages/cli/src/`, `packages/hooks-*/`, `packages/compile/`,
  `packages/contracts/`, etc. (forbidden_paths enforced by hooks).
- **No writes to real HOME.** Tests must pass `overrideHome` to *every*
  `init`/`uninstall` call. The harness asserts at fixture-setup time
  that `process.env.HOME` is not modified.
- **No writes to `~/.claude/`, `~/.cursor/`, `~/.config/cline/`,
  `~/.continue/`.** Pre-test sentinel: snapshot the existence/mtime of
  these dirs (if present) before the suite and re-check at suite end;
  fail loudly on any change.

**Required integration points:**
- Cross-platform path handling: `mkdtempSync(join(tmpdir(), ...))`
  exclusively. No hard-coded `/tmp/...` strings.
- `JSON.parse(readFileSync(..., "utf-8"))` for all artefact reads —
  matches production handler style and keeps the test deterministic
  about JSON normalization.

**Forbidden shortcuts:**
- **No mocking the CLI handlers.** Direct in-process call to the real
  `init` / `uninstall` exports is required.
- **No skipping the user-entry-preservation case.** It is the core
  safety property of this harness.
- **No "make it pass" production edits.** If the harness fails for a
  real bug, the bug becomes its own WI; this slice does not absorb the
  fix.
- **No deletion or relaxation of existing tests** under
  `packages/cli/src/commands/*.test.ts`. Out of scope.

**Rollback boundary:**
A single `git revert` of the slice's only commit removes the test file
and the plan. Production behavior is unchanged because no production
source was modified.

**Acceptance notes:**
S1 of 7 per #687. The harness is the foundation for S2–S7 (which can
extend it as more IDE adapters or hook semantics land). Any bug surfaced
by the harness is filed as a separate issue with `Refs #687`. The 5th
adapter (`codex`) is explicitly skipped with a recorded reason; whether
to add a codex IDE adapter to the CLI is a separate planner decision.

**Ready for guardian when:**
- All hooks-lifecycle.test.ts cases pass locally and via `pnpm -C
  packages/cli test`.
- No diff outside `plans/wi-687-s1-hook-lifecycle.md` and
  `packages/cli/test/integration/hooks-lifecycle.test.ts`.
- PR body includes `Refs #687 (S1/7)` and a one-paragraph summary of any
  bugs the harness uncovered (with sub-issue links if filed).

---

## 9. Decision log entries for this slice

- **DEC-687-S1-ADAPTER-COUNT:** Harness covers 4 production-wired
  adapters; `codex` deferred because no IDE adapter for `codex` exists
  in the CLI. Recording the gap explicitly so future planners do not
  silently rediscover it.
- **DEC-687-S1-ENTRY-SEAM:** Tests call `init(argv, logger,
  {overrideHome})` and `uninstall(argv, logger, {overrideHome})`
  in-process rather than spawning `node dist/bin.js`. The handlers
  *are* the binary's logic; the in-process call is the production
  sequence with no mocks, and the `overrideHome` seam is a documented
  injection point in `InitOptions`/`UninstallOptions`.
- **DEC-687-S1-BYTE-IDENTITY-SCOPE:** Round-trip byte-identity is
  asserted on hook artefacts, not `.yakccrc.json` (which is rewritten
  every init for `mode` reasons). The cline/continue marker
  `installedAt` field is stripped before byte-identity comparison, with
  an in-file note that "stable marker bytes across re-install" can be
  promoted to a real invariant in a follow-up slice.
