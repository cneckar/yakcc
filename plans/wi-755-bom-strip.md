# WI-755 — UTF-8 BOM strip + CI regression guard

**Issue:** [#755](https://github.com/cneckar/yakcc/issues/755) (labels: `cleanup`, `hooks`, `fuckgoblin`)
**Branch:** `feature/wi-755-bom-strip`
**Base:** `main @ 953d49e` (post WI-753 land + DEC migration)
**Parent finding:** F-WI753-001 (reviewer of PR #754 noted BOM-polluted files added by the WI-753 implementer's editor)

---

## §1. Problem statement

The reviewer of PR #754 (WI-753) reported Finding F-WI753-001: six files added or modified in that PR carry a UTF-8 BOM (`EF BB BF`) at byte 0. Investigation in this WI's worktree shows the issue is materially larger than the reviewer's six-file sample.

### Concrete observed state

Scanning the worktree (every `.ts/.tsx/.js/.mjs/.cjs/.json` file outside `node_modules`, `dist`, `.git`, `.turbo`, `.worktrees`, `tmp/`) finds **69 BOM-bearing files**:

| Area | Files | Notes |
|---|---|---|
| `bench/B10-import-replacement/harness/*.mjs` | 3 | Bench harness sources (WI-510 work) |
| `bench/B10-import-replacement/tasks/*/arm-a/*.mjs` | 44 | Bench task arm-A fixtures (4 files × 11 tasks) |
| `bench/B5-coherence/*.{json,mjs}` | 3 | B5 corpus + evaluator |
| `packages/hooks-base/{package.json,src/*.ts,test/*.ts}` | 8 | Includes the `package.json` that triggers `SyntaxError` on naive `JSON.parse` |
| `packages/cli/src/**/*.ts` + `vitest.config.ts` | 5 | Includes the 4 PR #754 files + `commands/hook-intercept.{ts,test.ts}` |
| `packages/compile/src/import-gate.test.ts` | 1 | |
| `packages/shave/src/**` | 4 | `documented-usage.props.ts` + 3 universalize tests |

The full list is enumerated in §6 Scope Manifest (Required paths).

### Why this matters

1. **`packages/hooks-base/package.json` BOM is a correctness defect.** Any consumer that runs `JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))` throws `SyntaxError: Unexpected token '﻿'`. `pnpm` and `node`'s module loader both strip the BOM tolerantly, so the workspace builds — but any tooling that does naive parse (lint plugins, custom scripts, downstream package introspection) breaks. The `package.json` BOM is a latent landmine.
2. **`.ts`/`.mjs`/`.json` BOMs are cosmetic noise.** They produce ugly diffs (most editors render BOM as an invisible character or a stray `?` glyph), confuse `grep` for the first non-whitespace character of a file, and break `head -c` / streaming tools that don't expect the prefix.
3. **The pollution is propagating.** Every time a contributor opens one of these files in an editor that preserves BOM-on-save (Windows Notepad, some VS Code configs, older Codex/Cline output paths), edits, and saves, the BOM survives. The 50 bench files came from WI-510 work; the 19 packages files came from WI-579, WI-578, WI-753, and other hook/shave work — all from the same editor pattern.

There is no legitimate BOM-bearing file in this workspace. Once the bytes are gone, the project policy is **zero BOM, no exceptions** — and we need a mechanical gate so the next editor regression fails CI loudly rather than silently re-polluting.

### Goals

1. Strip the leading `EF BB BF` from every BOM-bearing file in the workspace (69 files).
2. Add a CI regression guard (`scripts/check-no-bom.mjs`) wired into `pnpm -w lint` (or as a sibling workspace task) that exits non-zero when any tracked text file under the workspace root carries a BOM.
3. Prove the guard catches a freshly introduced BOM via a unit test.
4. Keep `pnpm -w lint` and `pnpm -w typecheck` green after the strip.

### Non-goals

- Configuring editors (`.editorconfig`, VS Code settings) to prevent BOM-on-save. That is an operator/contributor onboarding concern, not this WI's scope. The CI gate is sufficient — local editors discover the violation at PR time.
- Auditing or stripping BOM from binary/lockfile/vendor surfaces (`pnpm-lock.yaml`, `patches/**`, `node_modules/**`, `dist/**`, `.git/**`). The lockfile is currently BOM-free; vendor surfaces are explicitly excluded by the walker.
- Refactoring the bench B10 emitter to forbid BOM output. The 50 B10 files are committed sources, not generator output (see §2 Architecture). Stripping them once is sufficient; the CI gate prevents reintroduction.
- Adding `noUtf8Bom`-style Biome rules. Biome 1.9.4 has no first-party BOM rule; rolling our own scanner is the canonical path (see §9 DEC-CI-NO-BOM-GUARD-001).

### Dominant constraints

- **Zero dependency additions.** The guard must be pure `node:fs` / `node:path`. Sacred Practice #5 (solid foundations); no npm-on-PR for a 30-LOC scanner.
- **Bench `.mjs` files are not orchestrator-edited.** The orchestrator-source-guard restricts orchestrator authoring under `bench/` to `.mjs`, but byte-level BOM strip across pre-existing `.mjs` files is a mechanical cleanup, not authoring. The implementer (in worktree, as `implementer` actor) is authorized for those edits.
- **`packages/hooks-base/package.json` must remain valid JSON after the strip.** `sed -i '1s/^\xef\xbb\xbf//'` on a file whose first byte is `EF` strips exactly 3 bytes; on a file with no BOM it is a no-op. The implementer must verify each file with `head -c 3 | xxd -p` post-strip and assert `7b` (`{`), `2f` (`/`), `5b` (`[`), or whitespace.

---

## §2. Architecture

### Where state lives

| State domain | Canonical authority | This WI |
|---|---|---|
| File contents (text files in the workspace) | The files themselves | RE-ENCODE: strip leading 3-byte BOM in place |
| Lint pipeline | `package.json` `scripts.lint` → `turbo run lint` → per-package lint scripts | EXTEND: wire `pnpm -w check-bom` into the gate (see §3 wiring options) |
| Turbo task graph | `turbo.json` | EXTEND if a separate task is preferred; UNCHANGED if `check-bom` runs as a top-level script |
| CI workflow gates | `.github/workflows/pr-ci.yml` | EXTEND: add `check-bom` step OR rely on `pnpm -w lint` invoking it |
| BOM scanner logic (new) | `scripts/check-no-bom.mjs` | NEW: single-file scanner, pure node stdlib |
| BOM scanner test (new) | `scripts/check-no-bom.test.mjs` | NEW: vitest-free node test, see §3.4 |

### Why a custom scanner, not a Biome rule

Biome 1.9.4 has no `noUtf8Bom` / `noByteOrderMark` rule. ESLint has no first-party rule either (`@stylistic/no-bom` exists but adding a new lint plugin for one rule is overkill). A 30-LOC `node:fs` walker is simpler, faster, dependency-free, and easier to debug than dragging in another lint authority. DEC-CI-NO-BOM-GUARD-001 records this decision.

### Why `scripts/check-no-bom.mjs`

- Existing `scripts/` dir convention: `audit-property-tests.mjs`, `build-as-cache-seed.mjs`, `pre-pr-check.sh` are all repo-local one-off tools invoked from `package.json` scripts or CI workflows.
- `.mjs` is canonical for new top-level scripts (the existing `.mjs` siblings prove this); orchestrator-source-guard's `.mjs`-restriction in `bench/` does not apply to `scripts/`.
- Single file, no package, no separate `package.json`, no transitive deps.

### Why we do not configure editors

- `.editorconfig` directives like `insert_final_newline = true` and `charset = utf-8` exist, but no portable directive forbids BOM (different editors interpret `charset = utf-8` as "UTF-8 with no BOM" vs "UTF-8 with BOM" inconsistently).
- VS Code per-workspace settings would force a particular IDE; the project supports any editor.
- The CI gate is the **mechanical authority**. Editor config is advisory only; we don't need it if CI fails loudly.

### Scanner algorithm

```
walk(repoRoot):
  skip dirs matching: node_modules, dist, .git, .turbo, .worktrees, tmp, runtime, .pnpm-store
  for each file with extension in {ts, tsx, js, mjs, cjs, jsx, json, yaml, yml, md}:
    open file, read first 3 bytes
    if first 3 bytes === [0xEF, 0xBB, 0xBF]:
      record the path (relative to repo root)
  if any records: print each on its own line to stderr, exit 1
  else: print "no BOM found in N files (scanned X dirs)" to stdout, exit 0
```

The `yaml`/`yml`/`md` extensions are added defensively — BOM in those is just as wrong even though none currently exist. The walker is bounded by an explicit skip-dir list rather than a `.gitignore` parser to keep the scanner dependency-free (parsing `.gitignore` correctly is non-trivial).

### Wiring options (the orchestrator's prompt requests a choice)

**Option A — Top-level script invoked from `pnpm -w lint`:**
- Add `"check-bom": "node scripts/check-no-bom.mjs"` to root `package.json` scripts.
- Change root `"lint": "turbo run lint"` to `"lint": "turbo run lint && pnpm -w check-bom"` OR keep turbo's lint and add a separate root-level lint hook.
- Run by CI's existing `pnpm lint` step in `.github/workflows/pr-ci.yml` lint job.

**Option B — Separate workspace task `check-bom`, separate CI step:**
- Add `"check-bom": "node scripts/check-no-bom.mjs"` to root `package.json`.
- Add a `check-bom` step to `.github/workflows/pr-ci.yml` that runs `pnpm -w check-bom` after install.

**DECIDED: Option A.** Rationale in DEC-CI-NO-BOM-GUARD-001 §details: fewer surfaces to maintain, one consolidated PR-gate failure path, and the gate is intentionally part of "lint" semantically (BOM is a style/hygiene defect, the same as a lint violation).

The exact wiring shape:

```json
// root package.json scripts (delta)
{
  "scripts": {
    "lint": "turbo run lint && node scripts/check-no-bom.mjs",
    "check-bom": "node scripts/check-no-bom.mjs"
  }
}
```

`turbo run lint` is the per-package Biome pass (existing); the `&&` chain adds the workspace-level BOM check. The `check-bom` script alias lets contributors run it directly (`pnpm check-bom`) for fast feedback without invoking the whole turbo graph.

### Why not also run on `pnpm typecheck`

Typecheck is a TypeScript correctness gate; BOM is a hygiene gate. Conflating them couples failure modes — a BOM regression would mask a typecheck regression in CI logs. Keep them separate.

---

## §3. Implementation plan

### §3.1 Strip BOM from all 69 affected files

Single mechanical pass. The implementer runs (in worktree):

```bash
cd <worktree>
# Generate authoritative list (matches §6 Required paths)
find . -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' \
                  -o -name '*.mjs' -o -name '*.cjs' -o -name '*.jsx' \
                  -o -name '*.json' -o -name '*.yaml' -o -name '*.yml' \
                  -o -name '*.md' \) \
  -not -path '*/node_modules/*' \
  -not -path '*/.git/*' \
  -not -path '*/dist/*' \
  -not -path '*/.turbo/*' \
  -not -path '*/.worktrees/*' \
  -not -path './tmp/*' \
  -not -path './runtime/*' \
  | while read f; do
      first3=$(head -c 3 "$f" 2>/dev/null | xxd -p)
      if [ "$first3" = "efbbbf" ]; then
        # strip leading 3 bytes only if present
        tail -c +4 "$f" > "$f.nobom" && mv "$f.nobom" "$f"
        echo "stripped: $f"
      fi
    done
```

`tail -c +4` is byte-count-portable (vs `sed -i '1s/^\xef\xbb\xbf//'` which has Windows/macOS sed differences). The redirect-to-temp-and-rename pattern is atomic on POSIX. Implementer MUST verify post-strip:

```bash
# Confirm no remaining BOM
node scripts/check-no-bom.mjs  # must exit 0 once scanner is written
# Confirm hooks-base package.json is still valid JSON
node -e "JSON.parse(require('node:fs').readFileSync('packages/hooks-base/package.json','utf8'))"
# Confirm a few sample files have expected first bytes
head -c 3 packages/hooks-base/package.json | xxd -p  # expect: 7b0d0a or 7b0a (= "{\n" or "{\r\n")
head -c 3 packages/cli/src/index.ts | xxd -p          # expect: 696d, 2f2f, etc. (no efbb)
head -c 3 bench/B5-coherence/corpus-spec.json | xxd -p # expect: 7b...
```

### §3.2 Write `scripts/check-no-bom.mjs`

Approximate shape (implementer authors final version):

```js
#!/usr/bin/env node
// @decision DEC-CI-NO-BOM-GUARD-001
// Title: Workspace-wide BOM CI gate — pure node:fs walker, zero deps
// Status: accepted (this WI)
// Rationale: see plans/wi-755-bom-strip.md §2, §9

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = process.cwd();
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".turbo", ".worktrees",
  "tmp", "runtime", ".pnpm-store", ".vscode",
]);
const SCAN_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".yaml", ".yml", ".md",
]);

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

let scannedDirs = 0;
let scannedFiles = 0;
const offenders = [];

function walk(dir) {
  scannedDirs += 1;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;  // unreadable dir — skip silently
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      if (dot < 0) continue;
      const ext = entry.name.slice(dot);
      if (!SCAN_EXTS.has(ext)) continue;
      scannedFiles += 1;
      // Read just the first 3 bytes
      try {
        const fd = readFileSync(full).subarray(0, 3);
        if (fd.length === 3 && fd[0] === 0xef && fd[1] === 0xbb && fd[2] === 0xbf) {
          offenders.push(relative(REPO_ROOT, full));
        }
      } catch {
        // unreadable file — skip
      }
    }
  }
}

walk(REPO_ROOT);

if (offenders.length > 0) {
  console.error(`UTF-8 BOM detected in ${offenders.length} file(s):`);
  for (const f of offenders) console.error(`  ${f}`);
  console.error("");
  console.error("Strip the leading 3 bytes (EF BB BF). One-liner:");
  console.error("  tail -c +4 <file> > <file>.nobom && mv <file>.nobom <file>");
  process.exit(1);
}

console.log(`check-no-bom: no BOM found (${scannedFiles} files, ${scannedDirs} dirs)`);
process.exit(0);
```

Implementer is free to tighten/refactor; the shape above is illustrative. Performance note: `readFileSync(full).subarray(0, 3)` reads the entire file just to look at 3 bytes. For 5–10k workspace files this is still <500ms in practice (Node fs is fast on Windows NTFS), but if reviewer flags it, switch to `open()` + `read()` with a 3-byte buffer. Either path is acceptable.

### §3.3 Wire into root `package.json`

Edit root `package.json` `scripts`:

```diff
-    "lint": "turbo run lint",
+    "lint": "turbo run lint && node scripts/check-no-bom.mjs",
+    "check-bom": "node scripts/check-no-bom.mjs",
```

`turbo.json` is **not modified** — `check-no-bom` is not a per-package task and does not benefit from caching (cost is already sub-second). DEC-CI-NO-BOM-GUARD-001 records this.

`.github/workflows/pr-ci.yml` is **not modified** — the lint job already runs `pnpm lint` (which now chains to the BOM check). No new CI step needed.

### §3.4 Test the scanner

Add `scripts/check-no-bom.test.mjs` (pure node `node:test`, no vitest — avoids dragging the script into the package graph):

```js
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const SCRIPT = new URL("./check-no-bom.mjs", import.meta.url).pathname;

function makeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), "check-no-bom-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

test("exits 0 when no BOM is present", () => {
  const root = makeFixture({ "src/a.ts": "export const x = 1;\n" });
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
});

test("exits 1 when a BOM is present", () => {
  const root = makeFixture({
    "src/clean.ts": "export const x = 1;\n",
    "src/dirty.ts": "﻿export const y = 2;\n",
  });
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
  assert.match(result.stderr, /src[\\/]dirty\.ts/);
});

test("ignores skip dirs", () => {
  const root = makeFixture({
    "node_modules/pkg/index.js": "﻿module.exports = {};\n",
    "src/a.ts": "export const x = 1;\n",
  });
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `expected exit 0 (node_modules skipped), got ${result.status}: ${result.stderr}`);
});
```

Invoke via `node --test scripts/check-no-bom.test.mjs`. Add a `package.json` script:

```diff
+    "check-bom:test": "node --test scripts/check-no-bom.test.mjs",
```

Wire into the root `lint` chain OR keep separate. Recommended: separate (matches existing pattern — `audit-property-tests.mjs` has its own invocation). Reviewer can validate by running both `pnpm check-bom` (must pass on clean tree) and `pnpm check-bom:test` (must pass — the 3-test matrix).

---

## §4. Acceptance criteria

1. Every file listed in §6 Required paths (69 entries) has its leading 3 bytes (`EF BB BF`) removed. Verified by `node scripts/check-no-bom.mjs` exiting 0.
2. `packages/hooks-base/package.json` is parseable by `JSON.parse(readFileSync(..., 'utf8'))` — proven by `node -e "JSON.parse(require('node:fs').readFileSync('packages/hooks-base/package.json','utf8')); console.log('ok')"` printing `ok`.
3. `scripts/check-no-bom.mjs` exists, has the §3.2 algorithm (pure `node:fs` / `node:path`, no external imports), and exits 0 on the post-strip workspace.
4. `scripts/check-no-bom.test.mjs` exists, contains at minimum the 3 test cases in §3.4 (no-BOM clean, BOM detected, skip-dir respected), and `node --test scripts/check-no-bom.test.mjs` reports all tests passing.
5. Root `package.json` `scripts.lint` is amended to chain `node scripts/check-no-bom.mjs` after `turbo run lint`; a top-level `check-bom` script alias is added.
6. **Full-workspace CI gates green** (per `workflow_eval_contract_match_ci_checks`):
   - `pnpm -w lint` clean (includes the new BOM check)
   - `pnpm -w typecheck` clean
   - `pnpm -r build` clean
   - `pnpm -r test` green
7. Land via PR (NOT Guardian-merge) per `workflow_pr_not_guardian_merge` standing rule.
8. Closes #755.

### Explicitly out of scope (do NOT implement in this WI)

- `.editorconfig` charset directives, VS Code `files.encoding` settings, or any other editor-side configuration.
- Refactoring the bench B10 generator to forbid BOM output (the existing B10 files appear to be hand-authored sources, not generator output — see §2; if a regeneration step DOES emit BOM, that's a separate WI).
- Stripping BOM from `.gitignore`d files, `node_modules/**`, `dist/**`, `patches/**`, `pnpm-lock.yaml` (none currently BOM-bearing).
- Adding ESLint/Biome plugins that enforce BOM rules.
- Editing `MASTER_PLAN.md` / `docs/archive/developer/MASTER_PLAN.md` (governance write deferred per established WI-753 / PR #750 pattern).
- Editing `bootstrap/expected-roots.json` (CI-only writer per DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001).

---

## §5. Evaluation Contract

### Required tests (must all pass before reviewer declares `ready_for_guardian`)

1. **`scripts/check-no-bom.test.mjs`** (new file): three tests per §3.4 — all pass when run via `node --test scripts/check-no-bom.test.mjs`.
2. **Workspace BOM scan on post-strip tree:** `node scripts/check-no-bom.mjs` exits 0. Reviewer pastes the literal command output (`check-no-bom: no BOM found (N files, M dirs)`) into the review verdict.
3. **`packages/hooks-base/package.json` parse smoke:** `node -e "JSON.parse(require('node:fs').readFileSync('packages/hooks-base/package.json','utf8')); console.log('ok')"` prints `ok` and exits 0.
4. **All existing tests still pass:** `pnpm -r test` green. The BOM strip changes byte 0 of source files but does not change semantic content — all existing vitest suites must remain green. Reviewer flags any failure as a regression.

### Required real-path checks

- `pnpm -w lint` (full workspace; chains to BOM check)
- `pnpm -w typecheck` (full workspace)
- `pnpm -r build` (every package builds — BOM strip should not affect TS compilation)
- `pnpm -r test` (every package's test suite green)

These are full-workspace gates (NOT `--filter <pkg>`-scoped) per `workflow_eval_contract_match_ci_checks`.

### Required authority invariants

- **Single source of truth (Sacred Practice #12):** the BOM gate's authority lives in `scripts/check-no-bom.mjs` only. No parallel implementation in `package.json` scripts, no inline Biome rule, no per-package check. The CI workflow does NOT add its own duplicate gate — it relies on `pnpm -w lint` invoking the script.
- **No-deps invariant:** `scripts/check-no-bom.mjs` MUST import ONLY from `node:fs`, `node:path`, `node:url`. The implementer adds no entries to `pnpm-lock.yaml`, no entries to root `devDependencies`, no new package directory. Reviewer verifies via `git diff --stat` (only files touched are §6 paths) and `git diff pnpm-lock.yaml` (must be empty).
- **No-CI-duplication invariant:** `.github/workflows/pr-ci.yml` is NOT modified. The BOM gate runs as part of the existing `lint` job (because root `pnpm lint` now chains the BOM check). Reviewer verifies the CI YAML is unchanged.
- **Byte-level invariant:** for every file in §6 Required paths, the post-WI first byte MUST NOT be `0xEF`. Reviewer spot-checks via `head -c 3 <file> | xxd -p` on a sample of 5+ files (must show no `efbbbf` prefix).

### Required integration points

- **Root `package.json`** — `scripts.lint` is appended-to, NOT replaced. The existing `turbo run lint` semantics must continue (per-package Biome). Reviewer reads the diff and confirms `turbo run lint` still leads the chain.
- **`scripts/` directory convention** — new files match existing `.mjs`/`.sh` shape; no new package, no `package.json` for the script.
- **PR CI workflow (`pr-ci.yml`)** — unchanged; the lint job's `pnpm lint` invocation picks up the new chained check transitively.
- **All 69 BOM-bearing files** — only byte 0 changes (3 bytes removed). No semantic edit. Lint/typecheck/test of each affected package must remain green.

### Forbidden shortcuts

- ❌ Adding a new lint dep (`eslint-plugin-no-bom`, `@biomejs/plugin-...`) — Sacred Practice #12 says one authority; pure-node scanner is the canonical choice.
- ❌ Stripping BOM via a `prepare`/`postinstall` hook that mutates files at install time — that hides the problem from CI; the gate is the authority.
- ❌ Selectively stripping only the 6 files listed in F-WI753-001 and leaving the 63 pre-existing BOM files in place — the gate fails CI on every PR from day one if we do this.
- ❌ Adding `.editorconfig` or VS Code settings as a substitute for the CI gate — editor config is advisory only.
- ❌ Skipping `bench/B10/**` from the scanner config to avoid stripping those 50 files — Sacred Practice #12 says one policy, no exemptions; either strip them all or don't enforce.
- ❌ Touching `MASTER_PLAN.md`, `docs/archive/developer/MASTER_PLAN.md`, `bootstrap/expected-roots.json`.
- ❌ Touching `pnpm-lock.yaml`. The lockfile must be byte-identical pre- and post-WI (the scanner has zero deps).
- ❌ Adding `--filter <pkg>`-scoped CI gates in the Evaluation Contract — full-workspace required per `workflow_eval_contract_match_ci_checks`.

### Ready-for-guardian definition

Reviewer may declare `READY_FOR_GUARDIAN` when ALL of the following hold:

1. `node scripts/check-no-bom.mjs` from the worktree root exits 0; reviewer pastes the literal stdout line.
2. `node --test scripts/check-no-bom.test.mjs` reports 3 passing tests, 0 failures; reviewer pastes the node-test summary line.
3. `pnpm -w lint` exits 0 (includes the BOM check transitively).
4. `pnpm -w typecheck` exits 0.
5. `pnpm -r build` exits 0 for every package.
6. `pnpm -r test` exits 0 for every package — no regression vs main.
7. `git diff pnpm-lock.yaml` is empty.
8. `git diff --stat main...HEAD` shows only paths from §6 Allowed/Required (no forbidden-path entries).
9. `head -c 3 packages/hooks-base/package.json | xxd -p` does NOT start with `efbbbf` (spot-check).
10. `node -e "JSON.parse(require('node:fs').readFileSync('packages/hooks-base/package.json','utf8'))"` prints nothing and exits 0 (JSON valid).

---

## §6. Scope Manifest

Canonical scope will be persisted to runtime via `cc-policy workflow scope-sync wi-755-bom-strip --work-item-id wi-755-bom-strip-planner --scope-file tmp/scope-wi-755-bom-strip.json`.

### Required paths (MUST be modified — BOM strip)

**Bench (50 files):**
```
bench/B10-import-replacement/harness/arm-a-emit.mjs
bench/B10-import-replacement/harness/measure-transitive-surface.mjs
bench/B10-import-replacement/harness/run.mjs
bench/B10-import-replacement/tasks/add-business-days/arm-a/coarse.mjs
bench/B10-import-replacement/tasks/add-business-days/arm-a/fine.mjs
bench/B10-import-replacement/tasks/add-business-days/arm-a/medium.mjs
bench/B10-import-replacement/tasks/add-business-days/arm-a/oracle.test.mjs
bench/B10-import-replacement/tasks/bcrypt-verify-constant-time/arm-a/coarse.mjs
bench/B10-import-replacement/tasks/bcrypt-verify-constant-time/arm-a/fine.mjs
bench/B10-import-replacement/tasks/bcrypt-verify-constant-time/arm-a/medium.mjs
bench/B10-import-replacement/tasks/bcrypt-verify-constant-time/arm-a/oracle.test.mjs
bench/B10-import-replacement/tasks/coerce-semver/arm-a/coarse.mjs
bench/B10-import-replacement/tasks/coerce-semver/arm-a/fine.mjs
bench/B10-import-replacement/tasks/coerce-semver/arm-a/medium.mjs
bench/B10-import-replacement/tasks/coerce-semver/arm-a/oracle.test.mjs
bench/B10-import-replacement/tasks/cycle-safe-deep-clone/arm-a/coarse.mjs
bench/B10-import-replacement/tasks/cycle-safe-deep-clone/arm-a/fine.mjs
bench/B10-import-replacement/tasks/cycle-safe-deep-clone/arm-a/medium.mjs
bench/B10-import-replacement/tasks/cycle-safe-deep-clone/arm-a/oracle.test.mjs
bench/B10-import-replacement/tasks/debounce-with-flush-cancel/arm-a/coarse.mjs
bench/B10-import-replacement/tasks/debounce-with-flush-cancel/arm-a/fine.mjs
bench/B10-import-replacement/tasks/debounce-with-flush-cancel/arm-a/medium.mjs
bench/B10-import-replacement/tasks/debounce-with-flush-cancel/arm-a/oracle.test.mjs
bench/B10-import-replacement/tasks/format-iso-date/arm-a/coarse.mjs
bench/B10-import-replacement/tasks/format-iso-date/arm-a/fine.mjs
bench/B10-import-replacement/tasks/format-iso-date/arm-a/medium.mjs
bench/B10-import-replacement/tasks/format-iso-date/arm-a/oracle.test.mjs
bench/B10-import-replacement/tasks/nanoid-generate/arm-a/coarse.mjs
bench/B10-import-replacement/tasks/nanoid-generate/arm-a/fine.mjs
bench/B10-import-replacement/tasks/nanoid-generate/arm-a/medium.mjs
bench/B10-import-replacement/tasks/nanoid-generate/arm-a/oracle.test.mjs
bench/B10-import-replacement/tasks/parse-rfc3339-datetime/arm-a/coarse.mjs
bench/B10-import-replacement/tasks/parse-rfc3339-datetime/arm-a/fine.mjs
bench/B10-import-replacement/tasks/parse-rfc3339-datetime/arm-a/medium.mjs
bench/B10-import-replacement/tasks/parse-rfc3339-datetime/arm-a/oracle.test.mjs
bench/B10-import-replacement/tasks/semver-range-satisfies/arm-a/coarse.mjs
bench/B10-import-replacement/tasks/semver-range-satisfies/arm-a/fine.mjs
bench/B10-import-replacement/tasks/semver-range-satisfies/arm-a/medium.mjs
bench/B10-import-replacement/tasks/semver-range-satisfies/arm-a/oracle.test.mjs
bench/B10-import-replacement/tasks/uuid-v4-generate-validate/arm-a/coarse.mjs
bench/B10-import-replacement/tasks/uuid-v4-generate-validate/arm-a/fine.mjs
bench/B10-import-replacement/tasks/uuid-v4-generate-validate/arm-a/medium.mjs
bench/B10-import-replacement/tasks/uuid-v4-generate-validate/arm-a/oracle.test.mjs
bench/B10-import-replacement/tasks/validate-string-min-max/arm-a/coarse.mjs
bench/B10-import-replacement/tasks/validate-string-min-max/arm-a/fine.mjs
bench/B10-import-replacement/tasks/validate-string-min-max/arm-a/medium.mjs
bench/B10-import-replacement/tasks/validate-string-min-max/arm-a/oracle.test.mjs
bench/B5-coherence/corpus-spec.json
bench/B5-coherence/llm-judge.mjs
bench/B5-coherence/rubric-eval.mjs
```

**Packages (19 files):**
```
packages/cli/src/commands/hook-intercept.test.ts
packages/cli/src/commands/hook-intercept.ts
packages/cli/src/commands/hooks-install.test.ts
packages/cli/src/index.ts
packages/cli/vitest.config.ts
packages/compile/src/import-gate.test.ts
packages/hooks-base/package.json
packages/hooks-base/src/import-intercept.ts
packages/hooks-base/src/index.ts
packages/hooks-base/src/telemetry.ts
packages/hooks-base/test/atomize-delegates.test.ts
packages/hooks-base/test/import-intercept-integration.test.ts
packages/hooks-base/test/import-intercept.test.ts
packages/hooks-base/test/shave-on-miss-integration.test.ts
packages/hooks-base/test/shave-on-miss.test.ts
packages/shave/src/corpus/documented-usage.props.ts
packages/shave/src/universalize/bcryptjs-headline-bindings.test.ts
packages/shave/src/universalize/jsonwebtoken-headline-bindings.test.ts
packages/shave/src/universalize/private-class-field-walk.test.ts
```

**New files (3):**
```
scripts/check-no-bom.mjs            # the BOM scanner (§3.2)
scripts/check-no-bom.test.mjs       # node:test suite (§3.4)
plans/wi-755-bom-strip.md           # this plan
```

**Modified root files (1):**
```
package.json                        # add `check-bom` script alias + chain into `lint`
```

**Plan/scope artifacts (2):**
```
plans/wi-755-bom-strip.md           # this plan (listed above)
tmp/scope-wi-755-bom-strip.json     # synced via cc-policy workflow scope-sync
```

Note: the scanner is also expected to verify itself — `node scripts/check-no-bom.mjs` post-strip is one of the acceptance gates (§4 item 1, §5 Required test 2).

### Allowed paths (MAY be modified if necessary)

| Path | Reason |
|---|---|
| `.gitignore` | Only if the implementer chooses to add `tmp/check-no-bom-test-*` or similar test-fixture residue (UNLIKELY — `mkdtempSync` lands under `os.tmpdir()`, not the repo). |

### Forbidden paths (MUST NOT be modified)

| Path | Reason |
|---|---|
| `pnpm-lock.yaml` | Scanner is zero-dep; the lockfile must not change. |
| `turbo.json` | The BOM check is not a per-package turbo task; no turbo wiring needed. |
| `.github/workflows/**` | The existing `pr-ci.yml` lint job picks up the chained BOM check transitively; no YAML edits required. |
| `biome.json` | Adding a Biome rule (or `files.ignore` entry for the scanner) is out-of-scope; Biome stays unchanged. |
| `MASTER_PLAN.md`, `docs/archive/developer/MASTER_PLAN.md` | Governance write deferred per WI-753 / PR #750 reviewer pattern. |
| `bootstrap/expected-roots.json` | CI-only writer per DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001. |
| `bench/B6-airgap/**`, `bench/B7-commit/**`, `bench/B1-latency/**`, `bench/B2-bloat/**`, `bench/B4-tokens*/**`, `bench/B8-synthetic/**`, `bench/B9-min-surface/**`, `bench/v0-release-smoke/**` | None of these have BOM today; do not touch. |
| `packages/*/src/**` (anything not in §6 Required) | No semantic edits to source — only the 19 enumerated files get their BOM removed. |
| Any `.md` file other than `plans/wi-755-bom-strip.md` | Docs unchanged. |
| `examples/**` | No examples have BOM; do not touch. |
| `docs/**` | Docs unchanged. |
| `.claude/**`, `agents/**`, `runtime/**` | Out of scope. |
| `patches/**` | Vendor patches; do not touch. |

### Expected state authorities touched

| Authority | Operation |
|---|---|
| File bytes (69 source files) | RE-ENCODE: strip leading 3 bytes |
| Lint pipeline (`package.json` `scripts.lint`) | EXTEND: chain BOM check |
| Scripts directory convention | EXTEND: add 2 new scripts (`check-no-bom.mjs`, `.test.mjs`) |

---

## §7. Work breakdown

Single slice; mechanical strip + small scanner. No sub-WI decomposition needed.

### W-S1-A: Author the scanner

1. Write `scripts/check-no-bom.mjs` per §3.2 algorithm.
2. Run `node scripts/check-no-bom.mjs` from worktree root — initial run will REPORT the 69 BOM-bearing files (sanity check that the scanner detects what we already know is there).
3. Write `scripts/check-no-bom.test.mjs` per §3.4 with the 3-test matrix.
4. Run `node --test scripts/check-no-bom.test.mjs` — all 3 tests must pass.

### W-S1-B: Strip BOM from all 69 files

1. Run the strip pipeline from §3.1 (or equivalent per-file pass).
2. Re-run `node scripts/check-no-bom.mjs` — must now exit 0.
3. Re-run `node -e "JSON.parse(require('node:fs').readFileSync('packages/hooks-base/package.json','utf8'))"` — must print nothing and exit 0.

### W-S1-C: Wire into `package.json`

1. Edit root `package.json`:
   - `"lint": "turbo run lint && node scripts/check-no-bom.mjs"`
   - add `"check-bom": "node scripts/check-no-bom.mjs"`
   - add `"check-bom:test": "node --test scripts/check-no-bom.test.mjs"`
2. Run `pnpm -w lint` — must exit 0 (Biome on per-package + BOM scanner).

### W-S1-D: Verification

1. `pnpm -w lint` — must exit 0
2. `pnpm -w typecheck` — must exit 0
3. `pnpm -r build` — must exit 0 for every package
4. `pnpm -r test` — must exit 0 for every package
5. `git diff pnpm-lock.yaml` — must be empty
6. `git diff --stat main...HEAD` — must show only §6-allowed paths

### W-S1-E: PR

1. Commit boundary: prefer single squash commit per §8.
2. Push to origin, open PR titled per §8.
3. Reviewer signs off per §5 ready-for-guardian gate.
4. Land via PR (NOT Guardian-merge).

---

## §8. Commit boundary

Single PR, single branch (`feature/wi-755-bom-strip`), one logical change.

Suggested squash commit:

```
chore(repo): #755 strip UTF-8 BOM + add scripts/check-no-bom.mjs CI gate (closes #755)
```

Body (HEREDOC):

```
Strip the leading EF BB BF from 69 BOM-bearing files (bench B10/B5 + packages/hooks-base, /cli, /compile, /shave) and add scripts/check-no-bom.mjs as a workspace-wide CI gate wired into `pnpm -w lint`.

- The BOM in packages/hooks-base/package.json was a latent SyntaxError landmine for any consumer that does naive JSON.parse on the file.
- The other 68 BOMs are cosmetic but produce diff noise and confuse byte-streaming tools.
- The scanner is zero-dep (pure node:fs / node:path / node:url) per Sacred Practice #12 (single source of truth) and DEC-CI-NO-BOM-GUARD-001.
- Wired into `pnpm -w lint` (chained after `turbo run lint`); no .github/workflows changes — the existing PR CI lint job picks it up transitively.

Closes #755. Refs F-WI753-001 (reviewer finding from PR #754).
```

Co-Authored-By footer per the canonical CLAUDE.md format.

PR title: `chore(repo): #755 strip UTF-8 BOM workspace-wide + add CI gate (closes #755)`

---

## §9. Decisions

### DEC-CI-NO-BOM-GUARD-001 — Workspace-wide BOM CI gate via pure-node scanner chained into `pnpm -w lint`

**Status:** decided (this plan)
**Title:** Strip BOM from all 69 affected files; add `scripts/check-no-bom.mjs` (pure `node:fs` / `node:path` / `node:url`, zero deps); wire into root `package.json` `scripts.lint` after `turbo run lint`; do NOT modify CI workflow YAML or add a Biome rule.

**Options considered:**
- **Option 1 (rejected):** Add a Biome plugin or ESLint rule for BOM detection. Rejected because Biome 1.9.4 has no first-party rule; adding a third-party plugin for a 30-LOC check violates Sacred Practice #12 (one authority) and adds a transitive dep.
- **Option 2 (rejected):** Strip only the 6 files in F-WI753-001 and skip the other 63. Rejected because the gate would fail on every PR from day one — defeats the purpose.
- **Option 3 (rejected):** Add a separate `check-bom` job to `.github/workflows/pr-ci.yml`. Rejected because the lint job already runs `pnpm lint`; chaining the scanner into `pnpm lint` is fewer surfaces.
- **Option 4 (CHOSEN):** Pure-node walker in `scripts/check-no-bom.mjs`, chained into root `pnpm -w lint` via `&& node scripts/check-no-bom.mjs`. No CI YAML changes. No dep changes. Single authority.
- **Option 5 (rejected):** `.editorconfig` + VS Code settings only, no CI gate. Rejected because editor config is advisory; CI gate is the mechanical authority.

**Rationale for Option 4:**
- **Single source of truth (Sacred Practice #12):** one scanner file owns the policy; one wiring point (`pnpm lint`); one failure mode.
- **Zero deps:** node stdlib only. No `pnpm install` churn. No new package directory. No `pnpm-lock.yaml` changes.
- **Minimal CI surface:** `.github/workflows/pr-ci.yml` is unchanged; the existing lint job picks up the new check transitively.
- **Future-proof:** when (not if) someone tries to add a new BOM, CI fails loudly at the first PR build with a list of offending paths and a copy-paste fix command. The next implementer can resolve in seconds.
- **Bench-source impact acceptable:** the 50 B10/B5 bench `.mjs` files are committed sources, not generator output. Stripping BOM does not affect their runtime behavior (Node strips BOM transparently for ES modules anyway), but it removes diff noise. The same files will not regenerate with BOM unless an editor pattern reintroduces it, in which case CI catches the regression.

**Tradeoff acknowledged:** the scanner reads each candidate file fully into memory just to look at 3 bytes. For 5–10k workspace files this is sub-second on NTFS/ext4. If reviewer flags as too slow, switch to `open()` + `read(buf, 0, 3, 0)`; that delta is a one-method swap inside the scanner with no schema or wiring change. Either path is acceptable.

---

## §10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `packages/hooks-base/package.json` BOM strip corrupts the JSON if the file was somehow re-encoded UTF-16 | Very Low | We measured byte 0–2 as `EF BB BF` and bytes 3+ as ASCII `{` and JSON content. `tail -c +4` is a byte operation, not an encoding operation; result must be valid JSON. Implementer verifies with `node -e "JSON.parse(...)"` post-strip per §5 Required test 3. |
| Stripping BOM from `bench/B5-coherence/corpus-spec.json` breaks a benchmark fixture that depended on the BOM (extremely unlikely; B5 is text-comparison) | Very Low | B5 harness reads via Node, which strips BOM transparently. Spot-check: run `pnpm bench:coherence:slice1` after strip; if it diverges, B5 was buggy — file separate WI. Not in §5 required-tests because B5 is not in `pnpm -r test` graph. |
| `pnpm -r test` regression caused by a vitest fixture that hard-asserted byte-equal content of a BOM-bearing file | Low | None of the affected test files are fixtures (they're test sources themselves). If a test fails post-strip, it's likely a snapshot test that captured BOM-prefixed source — implementer regenerates the snapshot. Reviewer flags if not trivially explainable. |
| Implementer accidentally strips BOM from a vendor file or `node_modules` entry | Low | The find pipeline in §3.1 explicitly excludes `node_modules`, `dist`, `.git`, `.turbo`, `.worktrees`, `tmp/`, `runtime/`. Implementer pastes the strip log into PR for reviewer audit. |
| Scanner's `readFileSync` on every candidate is slow on cold disk | Low | Empirically <500ms on this workspace. If reviewer flags, swap to `open()`/`read()` for 3-byte read (still pure stdlib). |
| Scanner false-positive on a legitimately BOM-bearing fixture (e.g., a test that intentionally creates a BOM file as part of its setup) | Low | No such fixture exists today. The scanner's skip-dir list excludes `tmp`, `runtime`, `.turbo` — common test-output paths. If a future test wants to author BOM intentionally, it must do so under `tmp/` or a sub-fixture path the scanner already excludes, OR the scanner gains an explicit allow-list (separate future WI). |
| `pnpm lint` chain fails on Windows due to `&&` interpretation in pnpm script runner | Very Low | `pnpm` invokes scripts via cmd.exe on Windows; `&&` is supported in cmd.exe and POSIX shell. No need for `cross-env`/`run-s` indirection. |
| Reviewer requests adding `bench/**` to the scanner's skip list "for safety" | Low | Counter: that defeats the gate. The 50 bench BOM files prove the editor regression hits bench too. The plan's policy is "no BOM, full stop"; reviewer requests that contradict this require a re-plan, not a scope override. |
| One of the 19 packages files is an integration-test that depends on its own source BOM (e.g., reads itself and asserts byte content) | Very Low | None of the test files in §6 do this. Spot-check by reviewer running `pnpm -r test` and observing each suite passes. |
| Operator wants to add `.editorconfig` charset directive in this WI "while we're at it" | Low | OUT OF SCOPE per §4 explicit non-goal. Operator files a follow-up issue if desired; this WI delivers exactly the strip + gate. |

---

## §11. Inter-WI links

- **Parent finding:** F-WI753-001 (reviewer of PR #754, WI-753) — identified 6 BOM files; this WI confirms the broader 69-file scope.
- **Sister WIs touched in §6 (file overlap, no semantic dependency):**
  - WI-753 (#754, landed): authored 4 of the 19 affected packages files. Strip is byte-only; no WI-753 logic changes.
  - WI-510 (B10/B5 bench work, landed across multiple PRs): authored most of the 50 bench files. Strip is byte-only; no benchmark logic changes.
  - WI-578/579 (hook architecture work, landed): authored a few hooks-base files. Strip is byte-only.
- **Future follow-ups (NOT this WI, file as separate issues if desired):**
  - Editor configuration (`.editorconfig`, VS Code workspace settings) to prevent contributor-side BOM-on-save.
  - Audit bench B10's emit step to ensure regeneration doesn't reintroduce BOM (deferred to whoever next regenerates B10).
  - Extend scanner to cover other hygiene checks (CRLF line endings, trailing whitespace) — separate WI if/when desired.

---

## §12. Post-land follow-ups (orchestrator/operator, NOT this WI)

1. Verify the new gate fires on the next PR that introduces a BOM (will happen organically; no proactive action needed).
2. If operator decides editor config is also desired, file separate issue and link DEC-CI-NO-BOM-GUARD-001 as related authority.
3. Orchestrator may follow up with `CLAUDE_PLAN_MIGRATION=1` if MASTER_PLAN.md governance write is required (per established pattern).
