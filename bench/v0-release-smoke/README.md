# v0-release-smoke — End-to-end fresh-project walkthrough

**Issue:** [#360](https://github.com/cneckar/yakcc/issues/360)
**Track:** v0 release — load-bearing UX validation gate

## Why this exists

Every component (hook, discovery, substitution, atomize) has unit tests. This bench
verifies they **compose** for a real fresh-project user who is not running code inside
the yakcc monorepo. Without this, v0 ships with an unverified integration assumption.

## Ubuntu-only (CI-authoritative) note

**The canonical pass/fail verdict runs on `ubuntu-latest` via GitHub Actions.**

Steps 2 and 3 invoke `node packages/cli/dist/bin.js` — the CLI binary. On Windows,
`import.meta.url` path resolution in the bin entry-point is broken ([#274](https://github.com/cneckar/yakcc/issues/274)).
Those steps are skipped-with-WARN on `process.platform === "win32"`. Steps 5-9
(in-process `@yakcc/hooks-base` path) work on all platforms.

Do not use a Windows-local run to make a v0 release decision.

## 10-step methodology

| Step | Name | What it checks |
|------|------|----------------|
| 1 | Scratch project setup | Fresh `package.json + tsconfig.json + src/index.ts` created in `tmp/v0-release-smoke/scratch-<id>/` |
| 2 | `yakcc init --target <scratch>` | `.yakcc/registry.sqlite` + `.yakccrc.json` created; idempotent re-run |
| 3 | `yakcc hooks claude-code install` | `.claude/settings.json` written with yakcc PreToolUse entry |
| 4 | Verify hook installed | Parse `.claude/settings.json`; confirm `hook-intercept` command present |
| 5 | Substitution simulation (known-match) | `executeRegistryQueryWithSubstitution` returns valid response for `parseIntList`-like code |
| 6 | `yakcc_resolve` MCP tool surface | Absent hash → `no_match`; intent query → valid envelope |
| 7 | `yakcc query` returns seed atoms | After seeding scratch registry, top-K query returns recognizable atoms |
| 8 | Atomize-on-emission simulation (novel-glue) | Novel `chunkArray` code: substituted=false, atomize fires or shape-filter graceful skip |
| 9 | Round-trip flywheel | Registry query for novel intent returns candidates after step 8 atomization |
| 10 | Cleanup | Scratch dir removed (unless `--keep-scratch`) |

## Simulated Claude Code session

A real Claude Code session is operator-driven and cannot be automated in CI. This bench
uses `executeRegistryQueryWithSubstitution` from `@yakcc/hooks-base` directly to emulate
the hook subprocess path. This tests the same code path the production hook calls.

## Specific failure modes watched

Per issue #360:
- **Substitution gating** (Steps 5, 8): `decideToSubstitute` not firing in the real path
- **Windows bin.js bug** (#274, Steps 2-3): `import.meta.url` resolution broken on Windows — skipped-with-WARN
- **License gate** (Step 8): fixture code has SPDX header; atomize should not fail on license

## How to reproduce

### Prerequisites

```bash
# From repo root
pnpm install

# Build required packages
pnpm --filter @yakcc/contracts --filter @yakcc/registry --filter @yakcc/hooks-base \
     --filter @yakcc/hooks-claude-code --filter @yakcc/cli --filter @yakcc/seeds build
```

### Run the smoke walkthrough

```bash
pnpm bench:v0-smoke
```

Or directly:

```bash
node bench/v0-release-smoke/smoke.mjs
```

To keep the scratch directory after the run (for debugging):

```bash
node bench/v0-release-smoke/smoke.mjs --keep-scratch
```

### Local manual walkthrough (for operators running a real Claude Code session)

1. Run `node bench/v0-release-smoke/smoke.mjs --keep-scratch` — note the scratch dir path in output
2. Open Claude Code inside the scratch project directory
3. Verify the hook fires on a `Write` tool call (look for telemetry events in `.yakcc/telemetry/`)
4. Ask Claude to write a function that "parses a JSON array of integers" — verify substitution
5. Ask Claude to write a novel utility function — verify atomize fires (`@atom-new` comment)
6. Run `yakcc query "chunk array into sub-arrays" --top 3` — verify the new atom appears

## Artifact format

Written to `tmp/v0-release-smoke/<timestamp>.json`:

```json
{
  "runId": "...",
  "timestamp": "...",
  "platform": "linux",
  "node": "v22.x.x",
  "repoRoot": "...",
  "keepScratch": false,
  "steps": [
    {
      "step": 1,
      "name": "Scratch project setup",
      "expected": "...",
      "actual": "...",
      "pass": true,
      "warn": false,
      "errorExcerpt": null
    }
  ],
  "summary": {
    "passed": 10,
    "warned": 0,
    "failed": 0,
    "allPass": true
  }
}
```

## CI integration

`.github/workflows/v0-release-smoke.yml` runs daily at 10:00 UTC (after B1 nightly at 09:00 UTC)
and on every push to `main`.

Results are posted as comments on issue #360. If all 10 steps pass and `warned === 0`,
the script auto-closes #360 with a certification comment.

## Decision reference

| Decision ID | File | Description |
|-------------|------|-------------|
| `DEC-V0-RELEASE-SMOKE-001` | `smoke.mjs` | 10-step methodology, simulated-session approach, ubuntu-only scope |
| `DEC-V0-RELEASE-SMOKE-CI-001` | `.github/workflows/v0-release-smoke.yml`, `post-smoke-comment.mjs` | CI schedule, auto-close policy, non-fatal comment design |
