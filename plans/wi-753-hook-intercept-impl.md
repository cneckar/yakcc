# WI-753 — `yakcc hook-intercept` Phase-1 implementation + Cline/Continue dispatch wiring

**Issue:** [#753](https://github.com/cneckar/yakcc/issues/753) (labels: `fuckgoblin`, `alpha-blocker`, `ready`, `hooks`, `v0.5`)
**Branch:** `feature/wi-753-hook-intercept-impl`
**Base:** `main @ 3d7296d`
**Parent:** #216 (`WI-HOOK-PHASE-1-MVP`, closed-but-undelivered)
**Phase-2 follow-up (NOT this WI):** `WI-HOOK-PHASE-2-SUBSTITUTION`

---

## §1. Problem statement

Two compounding alpha-blocker defects discovered by alpha tester #1 on `@yakcc/cli@0.5.0-alpha.0` (npm):

### Defect A (primary, alpha-blocker)
Every IDE hook installer hard-codes `const HOOK_COMMAND = "yakcc hook-intercept"` and writes it to the IDE's settings/marker file. **The `hook-intercept` subcommand does not exist** in `packages/cli/src/index.ts`. In every project where `yakcc init` ran, Claude Code's PreToolUse hook fires `yakcc hook-intercept`, the CLI dispatcher hits the `default:` arm, returns `error: unknown command: hook-intercept`, and exits 1 — which Claude Code interprets as "block this tool call". **Every `Edit`/`Write`/`MultiEdit` in Claude Code fails until the user runs `yakcc uninstall` or hand-edits `.claude/settings.json`.** The published alpha is functionally broken.

Parent issue #216 was closed as completed 2026-05-10 with the "write side" (installer code) shipped, but the "read side" (the stdin-reading subprocess) was never wired.

### Defect B (secondary, low-visibility but documented surface broken)
`hooksClineInstall` and `hooksContinueInstall` exist as command modules and are imported by `init.ts`, but **not by `packages/cli/src/index.ts`**. The standalone surfaces `yakcc hooks cline install` and `yakcc hooks continue install` fail with `unknown hooks subcommand`. (They work from `yakcc init` because init calls the installer functions directly — masking the gap.)

### Defect C (architectural, smallest-fix question)
There is no `packages/hooks-continue/` package. `packages/hooks-cline/` exists as a substantial 250-line library with MCP tool, registerCommand marker, and Phase-2-ready substitution handler. Continue.dev currently has only an installer and no hook-package counterpart — asymmetric vs the other five IDEs. The issue calls out two options; we pick one and document.

---

## §2. Architecture

### Where `hook-intercept` sits in the dispatch flow

```
Claude Code PreToolUse event fires
  └─ spawns `yakcc hook-intercept` subprocess
      └─ writes tool-call JSON to subprocess stdin, closes stdin
          └─ subprocess reads stdin → EOF
              └─ best-effort JSON.parse
                  └─ extract tool_name, tool_input.file_path, tool_input.content|new_string
                      └─ buildTelemetryEvent({ toolName, intentHash:hashIntent(intentText), outcome:"passthrough", latencyMs })
                          └─ appendTelemetryEvent(event, sessionId, telemetryDir)   ← existing seam
                              └─ ~/.yakcc/telemetry/<session-id>.jsonl  (one JSONL line)
          └─ exit 0, empty stdout                                    ← Claude Code allows tool call unchanged
```

ANY exception inside the loop (stdin read, JSON parse, telemetry write, anything) → swallowed → exit 0, empty stdout. The hook **must not block** the user's tool call.

### State authorities (one each, no parallel mechanisms)

| State domain | Canonical authority | This WI touches? |
|---|---|---|
| CLI command dispatch | `packages/cli/src/index.ts` `runCli()` switch statement | YES — add `case "hook-intercept"`, add `cline`/`continue` `case` arms |
| Phase-1 telemetry write | `appendTelemetryEvent()` in `packages/hooks-base/src/telemetry.ts` | NO — reuse, do not duplicate |
| BLAKE3 intent hashing | `hashIntent()` in `packages/hooks-base/src/telemetry.ts` | NO — reuse |
| Session ID resolution | `resolveSessionId()` in `packages/hooks-base/src/telemetry.ts` | NO — reuse (but override via `--session-id`/payload if present) |
| Telemetry dir resolution | `resolveTelemetryDir()` in `packages/hooks-base/src/telemetry.ts` | NO — reuse (respects `YAKCC_TELEMETRY_DIR`) |
| Cline hook library | `packages/hooks-cline/src/index.ts` | NO (already exists, Phase-2-ready) |
| Continue hook library | (none today) | YES — create thin re-export package per DEC-CLI-HOOK-INTERCEPT-CONTINUE-PKG-001 |
| Claude Code PreToolUse JSON payload schema | external (Anthropic's Claude Code product) | Treat as untyped JSON; best-effort field extraction |

### Reuse of existing hooks-base seam

The Phase-1 contract maps cleanly to functions that already exist in `@yakcc/hooks-base`:
- `hashIntent(intentText)` → BLAKE3 hex (D-HOOK-5 schema field `intentHash`)
- `resolveSessionId()` → reads `CLAUDE_SESSION_ID` env (Claude Code sets this in subprocess env) or process-scoped UUID fallback
- `resolveTelemetryDir()` → reads `YAKCC_TELEMETRY_DIR` or `~/.yakcc/telemetry/`
- `appendTelemetryEvent(event, sessionId, dir)` → mkdir + appendFileSync of one JSONL line

We do NOT introduce a parallel writer. Sacred Practice #12: single source of truth.

### Why session ID resolution is delicate

Claude Code passes `session_id` IN THE STDIN JSON PAYLOAD (per its PreToolUse contract), not necessarily as `CLAUDE_SESSION_ID` env var. The implementer MUST prefer the payload's `session_id` field over `resolveSessionId()`'s env-var lookup, with the env-var/fallback as the secondary. This matches the issue's acceptance test which pipes `"session_id":"test"` and expects `~/.yakcc/telemetry/test.jsonl`.

---

## §3. Phase-1 contract (verbatim, from #216 / #753 / `docs/archive/developer/adr/hook-layer-architecture.md`)

> - Read `process.stdin` to EOF; best-effort JSON parse.
> - Extract `tool_name`, `tool_input.file_path`, `tool_input.content` / `new_string`.
> - Append one JSONL line to `~/.yakcc/telemetry/<session-id>.jsonl` with `{ts, tool, event, sessionId, intentHash (BLAKE3), latencyMs, outcome:"passthrough-phase-1"}`.
> - Exit 0 with empty stdout (Claude Code interprets as "allow tool unchanged" → matches #216 acceptance: *"Code emitted by the agent lands UNCHANGED on disk regardless of `outcome`"*).
> - ANY failure inside the handler → silent exit 0 (the hook must never block the user's tool call; per D-HOOK-3 telemetry write failure must not affect outcome).

### Concrete D-HOOK-5 schema mapping (TelemetryEvent shape from `packages/hooks-base/src/telemetry.ts:60`)

The implementer MUST emit a `TelemetryEvent` that conforms to the existing exported `TelemetryEvent` type (do NOT invent a parallel schema):

```ts
{
  t: number,                  // Date.now() at intercept-end
  intentHash: string,         // hashIntent(intentText)  — see §3.2
  toolName: "Edit"|"Write"|"MultiEdit",
  candidateCount: 0,          // Phase 1: no registry query
  topScore: null,             // Phase 1: no registry query
  substituted: false,         // Phase 1: never substitutes
  substitutedAtomHash: null,  // Phase 1: never substitutes
  latencyMs: number,          // end - start (Date.now() delta)
  outcome: "passthrough"      // existing enum value; "passthrough-phase-1" in the issue prose maps to this canonical value
}
```

**Outcome value resolution:** The issue body uses the prose label `"passthrough-phase-1"`, but the existing `TelemetryEvent.outcome` union in `telemetry.ts:89-94` already has `"passthrough"` as a canonical value. The implementer MUST use `"passthrough"` (no new enum variant). The DEC-HOOK-PHASE-1-001 schema is authoritative; adding a new union value is out of scope and would force schema migration of every existing telemetry consumer.

### §3.2 Intent text derivation (D-HOOK-5 + #753 acceptance)

When the stdin payload is `{"tool_name":"Edit","tool_input":{"file_path":"/tmp/x","new_string":"y"},...}`:
- `intentText` = `tool_input.new_string` if present
- else `intentText` = `tool_input.content` if present
- else `intentText` = `""` (empty intent — hash will still produce a deterministic 64-char hex; this is fine)

Tool-name mapping: tool_name comes through as one of `"Edit"`, `"Write"`, `"MultiEdit"`. If the tool_name is anything else (e.g., `"Bash"`, `"Read"`), this hook was mis-configured upstream — but the contract says **silent exit 0**; we drop the event rather than throwing. The implementer SHOULD log nothing to stderr in that case (loud-fail would block the tool).

### §3.3 What "silent fail" means precisely

Per DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001 below: the implementer MUST wrap the entire intercept body in a top-level `try { ... } catch { /* swallow */ }` block. Specifically:
- stdin read error (e.g., pipe closed early) → swallow
- `JSON.parse` throws → swallow
- `tool_name` missing or wrong type → swallow + skip telemetry write
- `appendTelemetryEvent` throws (disk full, perm denied, ENOSPC, EROFS) → swallow
- `hashIntent` throws (unlikely, but blake3 could theoretically OOM) → swallow
- Any other exception → swallow

In ALL silent-fail paths the process MUST still exit 0 with empty stdout.

**This is in tension with Sacred Practice #5 (fail loudly).** The override is encoded in DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001 below with explicit rationale: blocking the user's tool call is a worse failure mode than losing one telemetry line.

---

## §4. Acceptance criteria

(Verbatim from issue #753 plus this plan's elaboration.)

1. `yakcc hook-intercept` subcommand implemented in `packages/cli/src/index.ts` per the Phase-1 contract above.
2. **Integration test** in `packages/cli/src/commands/hook-intercept.test.ts`: pipe `{"tool_name":"Edit","tool_input":{"file_path":"/tmp/x","new_string":"y"},"hook_event_name":"PreToolUse","session_id":"test"}` into `hookIntercept(stdin, logger, options)` (NOT a spawned subprocess — use the in-process handler with an injected `stdin` Readable + `telemetryDir` override pointing at a `mkdtempSync` tmpdir); assert:
   - exit code 0
   - empty stdout (CollectingLogger.logLines.length === 0)
   - exactly one line in `<tmpdir>/test.jsonl`
   - that line parses as a valid `TelemetryEvent` with `outcome === "passthrough"`, `substituted === false`, `toolName === "Edit"`, `candidateCount === 0`, `topScore === null`, `intentHash` matches `hashIntent("y")`
3. **Failure-mode tests** (`hook-intercept.test.ts`):
   - malformed JSON stdin → exit 0, empty stdout, no JSONL file created (or zero new lines if dir pre-existed)
   - empty stdin → exit 0, empty stdout, no JSONL line written
   - `tool_name` is `"Bash"` (not Edit/Write/MultiEdit) → exit 0, empty stdout, no JSONL line
   - missing `session_id` → exit 0, empty stdout, JSONL line written to `<resolveSessionId()-output>.jsonl` (fallback path exercised)
   - `appendTelemetryEvent` injected to throw → exit 0, empty stdout (silent-fail proven, not narrated)
4. **Spawned-subprocess smoke test** in `packages/cli/src/commands/hook-intercept.test.ts` (separate `describe` block, MUST run after `pnpm -w build` makes `dist/bin.js` real — gate with `existsSync(distBin)` and skip if missing, but assert pass when present): use `child_process.spawnSync(process.execPath, [distBin, "hook-intercept"], { input: '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/x","new_string":"y"},"session_id":"smoke-test"}', env: { ...process.env, YAKCC_TELEMETRY_DIR: <tmp> }, encoding: "utf-8" })`; assert exit 0, empty stdout, exactly one line in `<tmp>/smoke-test.jsonl`. **This is the real-stdin proof per Sacred Practice #1** — it must not be replaced by a mock.
5. `hooksClineInstall` and `hooksContinueInstall` imported and dispatched from `packages/cli/src/index.ts` `hooks` subcommand block.
6. `yakcc hooks cline install --target <dir>` and `yakcc hooks continue install --target <dir>` exit 0 and write the expected marker file.
7. Continue hook-package decision documented per DEC-CLI-HOOK-INTERCEPT-CONTINUE-PKG-001 (this plan picks Option 2 — thin re-export package; see §9).
8. `printUsage()` updated to advertise: `hook-intercept` (one-line internal-use note ok), `hooks cline install`, `hooks continue install`.
9. B6 (#190) packet-capture cornerstone preserved: `hook-intercept` produces **zero outbound bytes** in default configuration (purely local fs writes — `appendTelemetryEvent` calls `mkdirSync` + `appendFileSync` only; no network).
10. D-HOOK-3 latency budget preserved: p95 hook latency under load <200ms (Phase-1 has no registry I/O and reads <8KB stdin → trivially clears 200ms; do NOT add a separate benchmark — covered by integration test wall-clock assertion `latencyMs < 100ms` per recorded event).
11. **Full-workspace CI gates green** (per `workflow_eval_contract_match_ci_checks`):
    - `pnpm -w lint` clean (Biome on changed files)
    - `pnpm -w typecheck` clean
    - `pnpm -r build` clean
    - `pnpm -r test` green
12. Land via PR (NOT Guardian-merge) per `workflow_pr_not_guardian_merge` standing rule.

### Explicitly out of scope (do NOT implement in this WI)

- Phase-2 registry-query / substitution (filed as `WI-HOOK-PHASE-2-SUBSTITUTION`)
- Cursor/Windsurf/Cline/Continue/Aider live-API wiring
- Re-publishing `0.5.0-alpha.0` (publish `0.5.0-alpha.1` is operator-driven post-land)
- Manual repro on Mac Claude Code session (operator post-land action)
- Edits to `bootstrap/expected-roots.json` (CI-only writer per DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001)
- Editing `MASTER_PLAN.md` or `docs/archive/developer/MASTER_PLAN.md` (governance write deferred per PR #750 reviewer feedback; orchestrator will follow up with `CLAUDE_PLAN_MIGRATION=1` if needed)

---

## §5. Evaluation Contract

### Required tests (must all pass before reviewer declares `ready_for_guardian`)

1. **`packages/cli/src/commands/hook-intercept.test.ts`** (new file):
   - happy path: Edit tool → JSONL line matches D-HOOK-5 schema (see Acceptance #2)
   - happy path: Write tool with `content` field → JSONL line, intent hash matches `hashIntent(content)`
   - happy path: MultiEdit tool → JSONL line, toolName === "MultiEdit"
   - malformed-JSON stdin → exit 0, no JSONL line
   - empty stdin → exit 0, no JSONL line
   - non-Edit/Write/MultiEdit tool_name → exit 0, no JSONL line
   - missing session_id → exit 0, fallback session ID file written
   - `appendTelemetryEvent` injection throws → exit 0, no narration (silent-fail proven)
   - **spawned-subprocess smoke** (real stdin via `child_process.spawnSync`, gated on `dist/bin.js` existing)
2. **`packages/cli/src/commands/hooks-cline-install.test.ts`** — must still pass (existing tests unchanged)
3. **`packages/cli/src/commands/hooks-continue-install.test.ts`** — must still pass (existing tests unchanged)
4. **`packages/cli/src/commands/hooks-install.test.ts`** — extend with: parameterized `runCli(["hooks","cline","install","--target",tmpDir])` and `runCli(["hooks","continue","install","--target",tmpDir])` end-to-end calls that prove the dispatcher resolves cleanly (this is the integration test for Defect B). The existing tests already cover the installer outputs; we add the dispatcher route.
5. **`packages/hooks-continue/src/index.test.ts`** (new, if Option-2 re-export package is created) — one-liner asserting `import { createHook } from "@yakcc/hooks-continue"` resolves to the same symbol as `import { createHook } from "@yakcc/hooks-cline"`.

### Required real-path checks

- `pnpm -w lint` (full-workspace Biome) — NOT `--filter @yakcc/cli`
- `pnpm -w typecheck` (full-workspace tsc) — NOT `--filter @yakcc/cli`
- `pnpm -r build` (every package builds) — `@yakcc/hooks-continue` must build if Option-2 created
- `pnpm -r test` (every package's vitest suite green)
- The spawned-subprocess smoke test in `hook-intercept.test.ts` MUST be exercised at least once with a freshly-built `dist/bin.js` before reviewer signoff (this is the real-stdin proof per Sacred Practice #1).

### Required authority invariants

- **D-HOOK-3** (≤200ms p95) — proven by integration-test wall-clock assertion `latencyMs < 100ms` in recorded telemetry event.
- **D-HOOK-5** (telemetry local-only, BLAKE3-hashed intent, no PII) — proven by:
  - JSONL line contains `intentHash` (64 hex chars), not `intent`/`new_string`/`content` raw text
  - no outbound network calls (no `fetch`, no `node:net`, no `node:https` imports in `hook-intercept.ts` — Biome lint enforces import discipline)
- **B6 packet-capture cornerstone** (#190) — proven by import-set audit: `hook-intercept.ts` must import ONLY from `node:fs`, `node:os`, `node:path`, `node:util`, and `@yakcc/hooks-base`. The reviewer MUST grep `hook-intercept.ts` for `node:net`, `node:https`, `node:http`, `fetch(`, `XMLHttpRequest`, `WebSocket` and confirm zero matches.
- **Sacred Practice #12 (single source of truth)** — `hook-intercept.ts` MUST call `appendTelemetryEvent`, `hashIntent`, `resolveSessionId`, `resolveTelemetryDir` from `@yakcc/hooks-base`. It MUST NOT reimplement BLAKE3 hashing, JSONL append, or session-ID resolution locally.

### Required integration points

- `packages/cli/src/index.ts`: existing `runCli` dispatch table — adds `case "hook-intercept"` arm and adds `cline`/`continue` sub-arms inside the existing `case "hooks"` block. Existing arms (claude-code, cursor, windsurf, aider) must continue to dispatch correctly (verified by existing tests in `hooks-install.test.ts`).
- `packages/cli/src/index.ts`: existing `printUsage` function — gets two new IDE entries + an internal-use note for `hook-intercept`.
- `packages/hooks-base`: read-only API consumption (no edits).
- `packages/hooks-cline`: read-only API consumption (no edits).
- `packages/hooks-continue/` (new, Option-2): consumes `@yakcc/hooks-cline` via workspace alias; must appear in `pnpm-workspace.yaml`'s glob (already-covered by `packages/*`).
- `pnpm-lock.yaml` will receive new workspace-link entries — implementer runs `pnpm install` and commits the lockfile changes (lockfile-only is in scope).

### Forbidden shortcuts

- ❌ Inventing a new telemetry-writer or BLAKE3-hasher inside `hook-intercept.ts` (Sacred Practice #12 violation).
- ❌ Spawning `yakcc` as a subprocess from inside the test to "verify the dispatch" without also doing the in-process injected-stdin test (the in-process test is faster and more deterministic; subprocess is the real-stdin proof, not a replacement).
- ❌ Adding `--filter <pkg>` scoped CI gates in the Evaluation Contract — per `workflow_eval_contract_match_ci_checks`, full-workspace required.
- ❌ Loud-fail on telemetry write error (must be silent per DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001).
- ❌ Implementing Phase-2 substitution opportunistically because "the code is right there" — out of scope; belongs to `WI-HOOK-PHASE-2-SUBSTITUTION`.
- ❌ Creating a full 250-line `packages/hooks-continue/` mirror of `packages/hooks-cline/` (Option-1 in the issue) — see DEC-CLI-HOOK-INTERCEPT-CONTINUE-PKG-001 for the rejected-option rationale.
- ❌ Touching `bootstrap/expected-roots.json`.
- ❌ Touching `MASTER_PLAN.md` (governance deferral).

### Ready-for-guardian definition

Reviewer may declare `READY_FOR_GUARDIAN` when ALL of the following hold:
1. All tests in §5 "Required tests" green when run via `pnpm -w test` (full workspace).
2. `pnpm -w lint` + `pnpm -w typecheck` + `pnpm -r build` all clean.
3. Spawned-subprocess smoke test exercised at least once on the worktree against freshly-built `dist/bin.js` (reviewer pastes raw output proving real stdin → JSONL line).
4. Import-set audit of `hook-intercept.ts` shows zero network imports (reviewer pastes the Grep output).
5. Scope manifest compliance verified: only the 7 files in §6 Required Paths + at most a handful of Allowed Paths touched. (`git diff --stat main...HEAD` reviewed.)
6. No edits to forbidden paths (Bootstrap, MASTER_PLAN.md, any other package outside Scope Manifest).

---

## §6. Scope Manifest

Canonical scope persisted to runtime via `cc-policy workflow scope-sync wi-753-hook-intercept-impl --work-item-id wi-753-hook-intercept-impl-planner --scope-file tmp/scope-wi-753-hook-intercept-impl.json`.

### Required paths (MUST be modified)

| Path | Reason |
|---|---|
| `packages/cli/src/commands/hook-intercept.ts` | new file — the Phase-1 handler (§3 contract) |
| `packages/cli/src/commands/hook-intercept.test.ts` | new file — integration + failure-mode tests (§5) |
| `packages/cli/src/index.ts` | add `case "hook-intercept"`, add `cline`/`continue` `case` arms inside `case "hooks"`, update `printUsage()` |
| `packages/cli/src/commands/hooks-install.test.ts` | extend with `runCli(["hooks","cline","install",...])` and `runCli(["hooks","continue","install",...])` dispatcher-route tests (Defect B coverage) |
| `packages/hooks-continue/package.json` | new — thin re-export package (DEC-CLI-HOOK-INTERCEPT-CONTINUE-PKG-001) |
| `packages/hooks-continue/src/index.ts` | new — `export * from "@yakcc/hooks-cline"` re-export |
| `packages/hooks-continue/tsconfig.json` + `tsconfig.typecheck.json` + `vitest.config.ts` | new — mirror `packages/hooks-cline/` build config |
| `packages/hooks-continue/src/index.test.ts` | new — re-export resolution smoke test (§5 test 5) |

### Allowed paths (MAY be modified if necessary)

| Path | Reason |
|---|---|
| `pnpm-lock.yaml` | new workspace-link entries for `@yakcc/hooks-continue` |
| `packages/cli/package.json` | add `@yakcc/hooks-continue` as devDependency only if `hook-intercept.ts` ends up importing it (it should NOT; it imports `@yakcc/hooks-base` directly) — MOST LIKELY UNNECESSARY |

### Forbidden paths (MUST NOT be modified)

| Path | Reason |
|---|---|
| `MASTER_PLAN.md`, `docs/archive/developer/MASTER_PLAN.md` | governance write deferred per PR #750 reviewer feedback; orchestrator follow-up if needed |
| `bootstrap/expected-roots.json` | CI-only writer per DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001 |
| `packages/hooks-base/**` | reuse only, no edits — adding telemetry-writer changes is out-of-scope architecture work |
| `packages/hooks-claude-code/**` | not in scope; Phase-1 contract bypasses the library API |
| `packages/hooks-cline/**` | not in scope; re-exported by new `hooks-continue` package, not modified |
| `packages/hooks-cursor/**` | not in scope; latent (Cursor API not yet stable) |
| `packages/hooks-windsurf/**` | not in scope; latent |
| `packages/hooks-aider/**` | not in scope; latent |
| `packages/cli/src/commands/hooks-cline-install.ts` | already-correct installer; reviewer-confirmed working from `init.ts` callsite |
| `packages/cli/src/commands/hooks-continue-install.ts` | already-correct installer; reviewer-confirmed working from `init.ts` callsite |
| `packages/cli/src/commands/hooks-{cursor,windsurf,aider}-install.ts` | unrelated installers |
| `bench/**`, `examples/**`, `scripts/**` | unrelated runtime surfaces |
| `bootstrap/**` (except `bootstrap/expected-roots.json` re-iterated above) | CI-only writers; do not touch |
| Any `.md` file other than the plan in `plans/` | docs governance deferred |

### Expected state authorities touched

| Authority | Operation |
|---|---|
| CLI dispatch (runCli switch) | add 3 arms (1 new top-level + 2 hooks-sub) |
| Phase-1 telemetry write | consume (do NOT extend) |
| pnpm workspace package manifest | add 1 new package directory |

---

## §7. Work breakdown

Single slice — issue is tight and the fix is well-bounded. No sub-WI decomposition.

### W-S1-A: Create `packages/hooks-continue/` re-export package

1. `packages/hooks-continue/package.json` — mirror `packages/hooks-cline/package.json`, with:
   - `"name": "@yakcc/hooks-continue"`
   - dependencies: `"@yakcc/hooks-cline": "workspace:*"` only (plus dev deps as in hooks-cline)
2. `packages/hooks-continue/src/index.ts` — `export * from "@yakcc/hooks-cline";` (one line; DEC-CLI-HOOK-INTERCEPT-CONTINUE-PKG-001 documented as @decision header)
3. `packages/hooks-continue/tsconfig.json`, `tsconfig.typecheck.json`, `vitest.config.ts` — copy from hooks-cline
4. `packages/hooks-continue/src/index.test.ts` — assert re-export resolves
5. Run `pnpm install` to update lockfile

### W-S1-B: Implement `packages/cli/src/commands/hook-intercept.ts`

1. Export `async function hookIntercept(argv: readonly string[], logger: Logger, options?: HookInterceptOptions): Promise<number>` — signature mirrors other CLI handlers
2. `HookInterceptOptions` interface — TEST-ONLY seam containing:
   - `stdin?: NodeJS.ReadableStream` (defaults to `process.stdin`; tests inject a `Readable.from([buffer])`)
   - `telemetryDir?: string` (defaults to `resolveTelemetryDir()`; tests inject `tmpdir`)
   - `appendEvent?: typeof appendTelemetryEvent` (defaults to the real one; tests inject a throwing stub for silent-fail proof)
   - `now?: () => number` (defaults to `Date.now`; tests can pin timestamps)
3. Wrap entire body in `try { ... } catch { /* swallow */ }`; always return 0
4. Read stdin to EOF (use `for await (const chunk of stdin)` accumulator pattern)
5. `JSON.parse(stdinBuffer)` inside the try
6. Extract `tool_name`, `session_id`, `tool_input.new_string` || `tool_input.content`
7. Skip telemetry write if `tool_name` not in `{"Edit","Write","MultiEdit"}` — early `return 0` (after the try, exit 0 regardless)
8. Build `TelemetryEvent` per §3 schema mapping
9. Call `appendEvent(event, sessionId, telemetryDir)`
10. Return 0; logger MUST NOT emit anything on success or failure (empty stdout requirement)

### W-S1-C: Wire dispatcher in `packages/cli/src/index.ts`

1. Import `hookIntercept` from `./commands/hook-intercept.js`
2. Import `hooksClineInstall` from `./commands/hooks-cline-install.js`
3. Import `hooksContinueInstall` from `./commands/hooks-continue-install.js`
4. Add `case "hook-intercept"` arm to top-level switch — call `hookIntercept(rest)` (subcommand is reassembled into argv as in other arms)
5. Inside `case "hooks"` block, add `if (subcommand === "cline")` and `if (subcommand === "continue")` arms mirroring the existing cursor/windsurf/aider arms exactly
6. Update the `unknown hooks subcommand` error message to include `cline`/`continue`
7. Update `printUsage()`:
   - Add `hooks cline install` and `hooks continue install` rows in the COMMANDS table
   - Add `hook-intercept` row with note `(internal — invoked by IDE hook configs)` so the surface is documented but not advertised as a user-facing command

### W-S1-D: Tests

1. `packages/cli/src/commands/hook-intercept.test.ts` — full test matrix per §5 "Required tests" item 1 + item 3 spawned-subprocess smoke
2. `packages/cli/src/commands/hooks-install.test.ts` — extend with cline/continue dispatcher-route tests
3. `packages/hooks-continue/src/index.test.ts` — re-export smoke test

### W-S1-E: Verification

1. `pnpm install` (lockfile update)
2. `pnpm -w lint`
3. `pnpm -w typecheck`
4. `pnpm -r build`
5. `pnpm -r test`
6. Manual sanity (optional, on worktree): pipe a payload to `node packages/cli/dist/bin.js hook-intercept` and `cat` the resulting JSONL line — verify schema by eye before reviewer signoff. (This is NOT a required gate but a high-confidence add for the implementer.)

---

## §8. Commit boundary

One PR, one branch, one logical change. Suggested commit shape (squash or merge — implementer chooses):

- `feat(cli): #753 implement yakcc hook-intercept Phase-1 subprocess`
- `feat(cli): #753 wire hooks cline/continue subcommand dispatch`
- `feat(hooks-continue): #753 create thin re-export package per DEC-CLI-HOOK-INTERCEPT-CONTINUE-PKG-001`
- `test(cli): #753 hook-intercept stdin contract + dispatcher route coverage`

OR (preferred for atomic landing): single commit `fix(cli): #753 implement hook-intercept + wire cline/continue dispatch (closes #753)`.

PR title: `fix(cli): #753 implement yakcc hook-intercept Phase-1 + Cline/Continue dispatch (closes #753)`

---

## §9. Decisions

### DEC-CLI-HOOK-INTERCEPT-001 — `hook-intercept` Phase-1 contract

**Status:** decided (this plan)
**Title:** `yakcc hook-intercept` is a stdin-reading subprocess that captures telemetry per D-HOOK-5 and always exits 0 with empty stdout; no registry query, no substitution
**Rationale:**
- Verbatim execution of the Phase-1 contract from #216 and `docs/archive/developer/adr/hook-layer-architecture.md` (D-HOOK-1..6).
- The "write side" (installers) shipped in #216; the "read side" (this subprocess) was the missing half. We deliver only the read side, no more.
- Phase-2 substitution requires a registry handle, an embedding provider, and the substitution-rule infrastructure that already exists in `executeRegistryQueryWithSubstitution` — but invoking those from inside a per-tool-call subprocess introduces 200ms+ latency budgets we haven't characterized. That work is `WI-HOOK-PHASE-2-SUBSTITUTION`; this WI must NOT pre-empt it.
- Sacred Practice #12: the `appendTelemetryEvent`/`hashIntent`/`resolveSessionId`/`resolveTelemetryDir` seam is the single source of truth for Phase-1 telemetry; `hook-intercept.ts` MUST consume it, not parallel-implement it.

### DEC-CLI-HOOK-INTERCEPT-CONTINUE-PKG-001 — Continue hook-package = thin re-export of `@yakcc/hooks-cline`

**Status:** decided (this plan)
**Title:** Create `packages/hooks-continue/` as a minimal re-export of `@yakcc/hooks-cline`; do NOT duplicate the 250-line library; defer divergence to a separate WI when Continue's API demands it
**Options considered:**
- **Option 1 (rejected):** Create a full `packages/hooks-continue/` mirroring `packages/hooks-cline/` — 250+ lines, MCP tool, registerCommand, substitution handler.
- **Option 2 (CHOSEN):** Create `packages/hooks-continue/` as a thin re-export — 5 files (~40 LOC), `src/index.ts` is one line: `export * from "@yakcc/hooks-cline";`
- **Option 3 (rejected):** No new package; have the installer/docs reference `@yakcc/hooks-cline` directly for Continue. This breaks surface symmetry (every IDE except Continue has a `@yakcc/hooks-<ide>` package) and forces consumers to remember the alias.

**Rationale for Option 2:**
- **Surface symmetry preserved:** `@yakcc/hooks-cline`, `@yakcc/hooks-continue`, `@yakcc/hooks-cursor`, `@yakcc/hooks-windsurf`, `@yakcc/hooks-aider`, `@yakcc/hooks-claude-code` all exist. Consumers can `import { createHook } from "@yakcc/hooks-continue"` without remembering "actually that one's an alias".
- **Sacred Practice #5 (solid foundations, no dead code):** Continue.dev's API surface is currently identical-pattern to Cline's (per the existing `hooks-continue-install.ts` DEC-CLI-HOOKS-CONTINUE-INSTALL-001 — both VS Code extension, both marker-based, both lack stable Node.js API). Duplicating 250 lines of substitution-handler code that no consumer calls today is the textbook definition of dead weight. **Sacred Practice #12 (single source of truth):** an alias is one source; a duplicate is two.
- **Future-proof for divergence:** When Continue.dev ships a stable API that differs from Cline's, splitting the re-export into a real library is a future WI (a one-line PR-shaped delta: change `export * from "@yakcc/hooks-cline"` to a real implementation). This is strictly easier than the inverse (discovering the 250-line duplicate has drifted and reconciling).
- **Scope minimization:** This WI is an alpha-blocker; we want the smallest possible diff that unblocks the alpha. A 5-file re-export package is ~40 LOC; a full duplicate is ~250 LOC + duplicate test suite (~500 LOC). The savings are real.
- **Tradeoff acknowledged:** If Continue diverges from Cline before this WI is followed up, every existing consumer of `@yakcc/hooks-continue` is implicitly consuming Cline behavior. We mitigate by adding `// FUTURE: when Continue's API diverges from Cline's, replace this re-export with a real implementation. See DEC-CLI-HOOK-INTERCEPT-CONTINUE-PKG-001.` as a `@decision` header in `packages/hooks-continue/src/index.ts`.

### DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001 — `hook-intercept` is silent-fail by contract

**Status:** decided (this plan)
**Title:** Any exception inside `hook-intercept`'s body must be swallowed; the process must always exit 0 with empty stdout
**Rationale:**
- Claude Code's PreToolUse contract interprets non-zero exit code as "block the tool call". Telemetry-write failure (disk full, permission denied, ENOSPC, EROFS) blocking the user's `Edit`/`Write`/`MultiEdit` would be a worse failure mode than losing one telemetry line.
- D-HOOK-3 latency budget (≤200ms p95) and the broader "hook must never block tool emission" principle in the hook-layer ADR override Sacred Practice #5 (fail loudly) for this specific surface. Phase-1 telemetry loss is an observability gap, not a correctness violation.
- The override is **bounded to `hook-intercept` only**. All other code in `@yakcc/hooks-base`, `@yakcc/cli`, etc., continues to follow Sacred Practice #5 (fail loudly).
- The Evaluation Contract (§5) makes silent-fail explicitly testable via injected `appendEvent` stub. Reviewers can prove the swallow path without depending on filesystem failures.

---

## §10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `~/.yakcc/telemetry/` directory doesn't exist on first run (fresh user) | Medium | `appendTelemetryEvent` already calls `mkdirSync(dir, { recursive: true })`; tested for in `telemetry.ts:345`. Phase-1 test covers tmpdir injection — first-run path equivalent. |
| Windows path semantics — `homedir()` returns `C:\Users\<u>`, JSONL filenames with colons would break (e.g., `session-id` containing `:` from Claude Code) | Medium | `resolveSessionId()` returns either `CLAUDE_SESSION_ID` env (Anthropic's session IDs are UUIDs — colon-free) or process-scoped UUID. Issue's acceptance test uses `"session_id":"test"`. Implementer SHOULD also sanitize: reject session IDs containing `[<>:"/\\|?*]` (Windows-illegal filename chars) and fall back to `resolveSessionId()`. Document this in `hook-intercept.ts` `@decision` block. |
| Claude Code's stdin JSON shape changes between versions (no versioning header today) | Low | Best-effort field extraction — `tool_input?.new_string ?? tool_input?.content ?? ""`. Unknown fields ignored. Future Claude Code schema changes degrade gracefully to "no telemetry line" rather than crashing. |
| `session_id` field in payload vs `CLAUDE_SESSION_ID` env precedence: which wins? | Low | Plan §2 (Architecture, "Why session ID resolution is delicate") spec: payload `session_id` wins, env var is secondary, process UUID is tertiary. Acceptance test #2 enforces this precedence (payload `"session_id":"test"` → `test.jsonl`). |
| `pnpm install` after adding new package might churn unrelated lockfile entries | Low | Implementer runs `pnpm install` once; diff should show only `@yakcc/hooks-continue` link entries. If unrelated churn appears (e.g., transitive dep float), implementer reverts to last-known lockfile and runs `pnpm install --no-frozen-lockfile --lockfile-only` for surgical update. |
| TypeScript strictness in `hook-intercept.ts` (esp. around `JSON.parse` return type `any` → strict `unknown` flow) | Low | Use `parsed: unknown = JSON.parse(buf)` + type-guards (`typeof parsed === "object" && parsed !== null && "tool_name" in parsed`). Existing code in the repo (e.g., `hooks-cline-install.ts:63 readMarker`) shows the established pattern. |
| Spawned-subprocess smoke test in `hook-intercept.test.ts` fails on CI because `dist/bin.js` not yet built when vitest runs | Medium | Gate the spawn test with `if (!existsSync(distBin)) it.skip(...)`. Vitest runs after `pnpm build` in standard `pnpm -r test` invocation, but CI ordering must be confirmed. Implementer notes in PR description if skip is hit on CI. |
| Reviewer-discovered Cline/Continue dispatcher-route tests duplicate end-to-end coverage from `init.test.ts` (which already calls installers via init) | Low | The new tests cover the **dispatcher route**, not the installer logic. `init.test.ts` calls installers directly via the init function; this WI proves `runCli(["hooks","cline","install"])` resolves through the switch. Distinct concerns; not duplicate. |
| `printUsage()` change creates a snapshot-style test break in `hooks-install.props.test.ts` or similar | Low | Implementer greps for `printUsage` callers and snapshot tests before editing. If a snapshot test exists, update the snapshot in the same commit. |
| Operator publishes `0.5.0-alpha.1` before manual repro on real Claude Code session | OUT OF SCOPE — operator post-land action; this plan does not cover publish | N/A (operator owns) |

---

## §11. Inter-WI links

- **Parent (closed, deliverable missing):** #216 `WI-HOOK-PHASE-1-MVP`
- **Phase-2 follow-up (NOT this WI):** `WI-HOOK-PHASE-2-SUBSTITUTION` — registry query + substitution inside the intercept subprocess; depends on this WI landing first.
- **Related installer WIs:**
  - #656 (`WI-CLI-IDE-COVERAGE` — Cline + Continue installers, landed)
  - #687 (`WI-HOOK-IDE-COVERAGE` — hooks-cline + future hooks-* packages, landed)
  - #746 (`WI-CLI-INIT-NO-IDE` — recent init flow hardening, landed)
  - PR #750 (Windsurf installer, recently merged — reviewer feedback re: MASTER_PLAN.md deferral applies to this WI)
  - PR #751 (MASTER_PLAN.md moved to `docs/archive/developer/MASTER_PLAN.md`)

---

## §12. Post-land follow-ups (orchestrator/operator, NOT this WI)

1. Operator publishes `@yakcc/cli@0.5.0-alpha.1` to npm under `alpha` dist-tag.
2. Operator manual repro on real Mac Claude Code session: `npm install -g @yakcc/cli@0.5.0-alpha.1`, `yakcc init`, then Claude Code Edit → verify exit 0 + JSONL line appears.
3. File `WI-HOOK-PHASE-2-SUBSTITUTION` as the registry-aware follow-up.
4. Orchestrator may follow up with `CLAUDE_PLAN_MIGRATION=1` if MASTER_PLAN.md governance write is required for this WI (per PR #750 reviewer feedback path).
