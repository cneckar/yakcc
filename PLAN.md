# PLAN — WI-187 B3 Cache-Hit Telemetry Harness

> Planner output for [`#187`](https://github.com/cneckar/yakcc/issues/187)
> ([Serenity] WI-BENCHMARK-B3 — Cache hit rate on 3-day human-engineer sprint).
> Workflow `wi-187-b3-harness`, work item `wi-187-b3-harness-plan`.
> Branch `feature/187-b3-harness` off `origin/main` (`df669fb`).

## 1 — Scope of this WI (and what it is NOT)

This WI ships **the telemetry harness, CLI seam, and PROTOCOL revision** that
make the B3 sprint mechanically executable. The sprint *execution itself*
(6 days of engineer wall-clock + analysis) is downstream operator work,
explicitly out of scope.

**In scope (this WI):**
- A task-boundary mechanism the engineer invokes from the shell.
- Per-task classification (boilerplate / glue / novel-logic) captured at task
  start.
- An aggregator that consumes the existing JSONL telemetry stream and
  produces per-task + per-category hit-rate breakdowns vs the #187 bars.
- A revision of `bench/B3-cache-hit/PROTOCOL.md` that walks the operator
  through the new CLI surface end-to-end (replacing the manual `grep -c`
  loop in §2.2 of the existing protocol).
- Tests: unit (math), property (order-invariant aggregation), real-path
  (end-to-end task-begin → hook fire → task-end → report).

**Out of scope (this WI):**
- Hook-layer changes. Existing `captureTelemetry` already records every
  `registry-hit` / `synthesis-required` / `passthrough` / `atomized` event
  with intent hash, session ID, latency, and atom hash. That is the corpus
  the aggregator reads from — we do **not** add a parallel telemetry path.
  (Sacred Practice #12.)
- The corpus. B3 measures the existing corpus; it does not mutate it.
- The B3 KILL-criterion decision. That belongs to the operator + #150
  re-planning, not to this implementer.
- Sprint execution. The PROTOCOL describes how; the operator decides when.
- Comparator-arm tooling beyond an env-var toggle. See §4.7.

## 2 — Problem decomposition (challenge the requirement)

The #187 acceptance bar is:
> ≥60% hit rate on boilerplate, ≥30% on glue, ≥10% on novel-logic, N ≥ 30
> tasks, independent classifier, comparator arm with hook disabled.

The mechanical question is: **given the existing telemetry pipeline already
records every cache event with a session ID, what is the smallest harness that
turns those events into a per-task-per-category hit-rate report?**

The blocking gap is **task identity**. Today every event is tagged with a
`sessionId` (Claude Code conversation ID or process UUID) and an `intentHash`
(BLAKE3 of the LLM intent string). Neither is a "task" in the #187 sense — a
single 30-min engineering task can span many intents and many sessions, and a
single session can span many tasks. The engineer needs a way to *declare*
where one task ends and the next begins, and what category each one is.

Once task identity is solved, classification is a sidecar field on the same
record, and the aggregator is straightforward join + group-by + ratio.

**Simpler-path check:** could we skip task boundaries and just report
session-level hit rate? **No.** Session granularity is too coarse (intents
within a single Claude session may span multiple engineering tasks) and too
fine (a multi-day refactor may span dozens of sessions). The #187 stratified
bar is per-task, not per-session. Without task identity we cannot satisfy
the acceptance criteria.

**Simpler-path check:** could we use the `intentHash` and cluster post-hoc?
**No.** Intent hashes are opaque (privacy-by-default; the plaintext intent
is never persisted), so post-hoc clustering would need re-classification of
hashes the operator cannot read back. Pre-declared boundaries are simpler
and cheaper.

## 3 — Architecture — state authorities & integration surfaces

| Domain                       | Authority (canonical)                                            | This WI relationship          |
|------------------------------|------------------------------------------------------------------|-------------------------------|
| Cache hit/miss event capture | `packages/hooks-base/src/telemetry.ts` (`captureTelemetry`)      | **read-only consumer**        |
| Telemetry event schema       | `TelemetryEvent` type in `telemetry.ts`                          | additive sidecar file only    |
| Telemetry file location      | `resolveTelemetryDir()` in `telemetry.ts`                        | **reused verbatim**           |
| JSONL parser seam            | `readTelemetrySessions()` in `telemetry.ts` (DEC-CLI-STATS-READER-SEAM-001) | **reused verbatim** |
| Session ID                   | `resolveSessionId()` in `telemetry.ts`                           | reused for task→session join  |
| CLI command registration     | `packages/cli/src/index.ts` switch in `runCli()`                 | **adds one new case `"bench"`** |
| `yakcc stats` aggregator     | `packages/cli/src/commands/stats.ts`                             | **not modified** (#768 owns Tier-2) |
| Sprint protocol document     | `bench/B3-cache-hit/PROTOCOL.md`                                 | **revised in place** (#704 already authored §1–§5) |

Sacred Practice #12 (Single Source of Truth) is honored: the harness adds a
**task-marker sidecar** but does not duplicate, fork, or shadow the telemetry
event stream. The marker file is the *only* new piece of state.

## 4 — The 8 design decisions

### DEC-WI187-001 — Task-boundary mechanism

**Decision.** A new CLI subcommand `yakcc bench b3 task-begin <slug>
--category <boilerplate|glue|novel-logic>` writes a marker line to a sidecar
JSONL file. A matching `yakcc bench b3 task-end` writes a close line. Task
identity is the slug; classification is pinned at `task-begin` time.

**Alternatives considered.**
- *Claude Code conversation ID alone.* Rejected — too coarse and too fine
  (see §2 Simpler-path check).
- *Per-prompt / per-tool-use ID via telemetry-wire.* Rejected — these are
  finer-grained than a task (a single task fires many tool uses) and the
  engineer cannot mark them.
- *Cursor IDE session ID + file path.* Rejected — IDE-specific and brittle;
  yakcc supports five IDE families per `hooks-{aider,cline,continue,cursor,
  windsurf}-install`. CLI marker is IDE-agnostic.
- *Post-hoc annotation of intent-hash clusters.* Rejected — intent hashes
  are opaque (privacy by default in DEC-HOOK-PHASE-1-001), so post-hoc human
  reading isn't possible.

**Rationale.** Explicit operator action is the cheapest mechanism that
matches the protocol's existing structure ("engineer works on a task,
records outcome, moves on"). The CLI marker is IDE-agnostic, requires zero
hook-layer changes, and produces a small, auditable log file the
independent reviewer can sanity-check post-sprint.

### DEC-WI187-002 — Event schema (sidecar markers)

**Decision.** Task markers persist as JSONL records distinct from the
telemetry stream. One record per `task-begin` and one per `task-end`. Fields:

```jsonc
{
  "kind": "task-begin",                      // discriminator
  "t": 1737000000000,                        // Date.now() at command run
  "taskSlug": "implement-user-creation",     // engineer-provided
  "category": "boilerplate",                 // | "glue" | "novel-logic"
  "classifier": "alice",                     // independent reviewer name/id
  "sessionIdAtStart": "abc-123-…",           // resolveSessionId() at run
  "note": null                               // optional free-text reason
}
{
  "kind": "task-end",
  "t": 1737000300000,
  "taskSlug": "implement-user-creation",
  "outcome": "completed",                    // | "abandoned" | "blocked"
  "sessionIdAtEnd": "abc-123-…"
}
```

**Required fields and the rationale for each.**
- `kind` — discriminator; lets the aggregator skip non-marker lines if the
  schema grows.
- `t` — wall-clock; the aggregator joins task→events by time-window between
  matching begin/end pairs.
- `taskSlug` — primary key; the engineer chooses a stable kebab-case slug;
  the aggregator group-bys on this.
- `category` — pinned at begin time so post-hoc rationalisation is
  impossible (per #187 stratification clause).
- `classifier` — selection-bias control: the independent reviewer's name is
  recorded so reports can flag "task classified by the sprinter themself"
  as a confound.
- `sessionIdAtStart` / `sessionIdAtEnd` — auxiliary integrity check; if
  these differ, the aggregator notes session crossover (informational
  only — events are joined by `t`, not by session).
- `outcome` (on task-end) — abandoned tasks are excluded from the N≥30
  count by the aggregator.

### DEC-WI187-003 — Storage format & location

**Decision.** One file per **sprint**, not per task:
`$YAKCC_TELEMETRY_DIR/bench-b3/<sprint-id>.jsonl`, where `<sprint-id>` is a
CLI-provided slug (default `default`). The default resolves to
`~/.yakcc/telemetry/bench-b3/default.jsonl`.

Append-only, line-delimited JSON, mirroring the existing `telemetry.ts`
storage discipline (DEC-HOOK-PHASE-1-001). The aggregator reads the whole
file in one pass — the sprint produces at most ~120 records (30 tasks ×
2 markers × 2 arms) so size is trivial.

**Why under `YAKCC_TELEMETRY_DIR`?** The aggregator must find the marker
file next to the event stream so a single env var controls both for the
operator. Sub-dir `bench-b3/` keeps the marker file from polluting the
session listing in `yakcc telemetry`.

**Why one file per sprint instead of one per task?** N≥30 files would
clutter `ls`, raise FS-race risk under fast `task-end` / `task-begin`
sequences, and force the aggregator to do directory scans. A single
append-only file removes all three.

### DEC-WI187-004 — Hook integration point

**Decision.** **Zero hook-layer modifications.** The harness does not
import, monkey-patch, or wrap `captureTelemetry`, `appendTelemetryEvent`,
or any file under `packages/hooks-base/src/`. The hook continues to emit
session-tagged events; the harness joins them to tasks at *report time*.

This honors Sacred Practice #12: there is one cache-event authority
(`telemetry.ts`) and we add a sidecar marker file, not a parallel event
stream. If the hook ever changes its emission shape, the harness's
`readTelemetrySessions()` consumer benefits automatically.

The aggregator joins task → events using the pair `(sessionId,
t-in-[begin,end])`. The session ID is recorded on the marker (DEC-WI187-002)
so when a task spans multiple sessions, the aggregator falls back to
time-window-only join and emits a `session-crossover: true` note in the
report.

### DEC-WI187-005 — Reporter shape

**Decision.** A new CLI subcommand `yakcc bench b3 report [--sprint <id>]
[--json]` registered in `packages/cli/src/index.ts`. The reporter lives in
a new file `packages/cli/src/commands/bench-b3.ts` that dispatches the
three b3 sub-actions (`task-begin`, `task-end`, `report`). The aggregator
logic lives in a sibling module
`packages/cli/src/commands/bench-b3-aggregator.ts` so it is unit-testable
in isolation from the CLI argv plumbing.

**Why a CLI subcommand and not a standalone `bench/B3-cache-hit/run.mjs`?**
Three reasons:
1. The existing `yakcc stats` and `yakcc telemetry` commands are the
   operator's mental model — adding `yakcc bench b3 …` is consistent and
   the engineer needs only one install path.
2. Cross-platform — the CLI is the only universally installed surface;
   bench-local Node scripts (per B4-tokens / B5-coherence) require
   `pnpm --dir bench/B3-cache-hit install` which the protocol must
   document.
3. The aggregator imports `readTelemetrySessions` from
   `@yakcc/hooks-base/telemetry.js`; CLI is the natural consumer of
   `@yakcc/hooks-base`.

**No new package.** `bench/B3-cache-hit/` keeps its existing role as a
*protocol-and-results* directory; no `package.json` is added there.

### DEC-WI187-006 — Classification metadata

**Decision.** Classification is captured **at `task-begin` time as a
required argument**:

```sh
yakcc bench b3 task-begin "implement-user-creation" \
    --category boilerplate \
    --classifier alice
```

Both `--category` and `--classifier` are required (no silent default). The
aggregator refuses to count any task missing either field. The CLI is
non-interactive (consistent with `yakcc stats` / `yakcc telemetry`
DEC-CLI-STATS-COMMAND-001).

**Why mandatory at start?** The #187 acceptance criterion is that "an
independent reviewer classifies pre-sprint." Capturing at start prevents
two failure modes:
- (a) the engineer pre-decides category mid-task to favor results;
- (b) the engineer forgets to classify and the data is unusable.

If the operator wants to pre-classify the full task list before the sprint
starts (the #187-preferred model), they can prepare a shell script with
the `task-begin` lines pre-populated.

### DEC-WI187-007 — Comparator-arm methodology

**Decision.** The comparator arm reuses the **same marker schema and same
aggregator**. The hook-off arm is produced by running the engineer's IDE
with the hook fully uninstalled per `bench/B3-cache-hit/PROTOCOL.md §3`
(`yakcc hooks <ide> install --uninstall`), then `task-begin` / `task-end`
as usual. Events for that arm will simply not contain `registry-hit`
records.

To prevent accidental cross-contamination, the reporter requires a
`--sprint <id>` flag and the two arms MUST use distinct sprint IDs (e.g.
`b3-on` and `b3-off`). The protocol mandates this naming.

**Rejected alternative:** runtime env-var toggle (`YAKCC_HOOK_DISABLE=1`)
to switch arms within a single sprint. Rejected because (a) the hook
escape hatches today are layer-specific (`YAKCC_HOOK_DISABLE_SUBSTITUTE`,
`YAKCC_HOOK_DISABLE_ATOMIZE`, etc.); there is no single global toggle and
inventing one is out of scope; (b) the #187 protocol already specifies
"uninstall hooks" for the comparator arm, so we honor that.

**No `yakcc bench b3 baseline` distinct verb.** The comparator arm is the
same flow with hooks uninstalled — a separate verb would imply different
data shape which is wrong.

### DEC-WI187-008 — Protocol selection-bias controls

**Decision.** The revised `bench/B3-cache-hit/PROTOCOL.md` (this WI's
deliverable) adds the following explicit clauses:

1. **Task list locked pre-sprint.** The independent classifier writes the
   full N≥30 task list with categories into a `tasks.csv` (or similar)
   *before* the engineer starts coding. The protocol provides a template.
2. **Classifier ≠ sprinter.** The protocol requires the `--classifier`
   argument to be a different identity from the engineer running the
   sprint. The aggregator does not enforce this (it cannot know), but the
   report flags the run if the same identity appears as both classifier
   and last-known git committer.
3. **No mid-sprint reclassification.** Once `task-begin` is run, the
   category is frozen. There is no `task-update-category` command.
4. **Abandonment is explicit.** A task abandoned mid-sprint must be ended
   with `task-end --outcome abandoned` and is excluded from the N≥30
   count and from hit-rate computation. The aggregator surfaces abandoned
   count separately so cherry-picking via abandonment is visible.
5. **Tasks not in the pre-sprint list are excluded.** The aggregator
   warns when a `task-begin` slug is not in `tasks.csv` (if provided
   via `--tasks <path>`). The warning is informational, not fatal — the
   operator decides whether to count those tasks.

These five clauses translate the #187 "selection bias check" prose into
operator-visible mechanism.

## 5 — Reporter output shape

Default (text):

```
B3 cache-hit report — sprint: b3-on
================================================
Tasks declared:   32
Tasks completed:  31    (abandoned: 1)
Events joined:    1,247
Events orphaned:  18    (outside any task window)
Session crossover: 2 tasks

Per category:
  boilerplate    (n=12)  hit rate: 67.3%   bar: ≥60.0%  PASS
  glue           (n=11)  hit rate: 34.1%   bar: ≥30.0%  PASS
  novel-logic    (n= 8)  hit rate:  4.8%   bar: ≥10.0%  FAIL (selection-bias confound — too low)

Overall verdict vs #187 bars: YELLOW
KILL criterion (<30% boilerplate): not triggered (67.3% ≥ 30%)
```

`--json` emits a strictly-typed payload (schema v1) mirroring `yakcc stats`
shape conventions, with top-level keys:
`version`, `generatedAt`, `sprint`, `tasks`, `perCategory`, `verdict`,
`kill_triggered`.

## 6 — Wave decomposition (implementer slicing guidance)

This is a single-PR WI. The implementer may slice locally as commits:

| W-ID    | Item                                                                          | Wt | Deps  | Gate    |
|---------|-------------------------------------------------------------------------------|----|-------|---------|
| W-187-A | Marker schema + sidecar JSONL writer module (`bench-b3-markers.ts`)           | S  | —     | tests   |
| W-187-B | `task-begin` / `task-end` CLI subcommands wired into `bench-b3.ts`            | M  | A     | tests   |
| W-187-C | Aggregator module (`bench-b3-aggregator.ts`) — pure functions, no I/O        | M  | A     | tests + props |
| W-187-D | `report` subcommand wires the aggregator + reads `telemetry` events           | M  | A,B,C | tests + real-path |
| W-187-E | `yakcc bench b3` dispatch in `packages/cli/src/index.ts` + `--help` line      | S  | B,D   | tests   |
| W-187-F | PROTOCOL.md revision (PROTOCOL §1–§5 updated to use the new CLI)              | S  | E     | review  |

Critical path: A → C → D → F. Max parallel width: 2 (A in parallel with
nothing else; B and C can land together after A).

## 7 — Evaluation Contract (for the implementer)

**Required tests (vitest unit + props):**
- `bench-b3-markers.test.ts` — marker JSONL roundtrip, append-only
  guarantee under concurrent writes (`fs.appendFileSync` POSIX semantics),
  rejection of malformed input.
- `bench-b3-aggregator.test.ts` — per-category hit-rate math is correct
  for: zero events, one task, multi-task, abandoned task excluded,
  session crossover detection, intent-too-broad/result-set-too-large
  treated as **misses** (not hits) per #187 semantics.
- `bench-b3-aggregator.props.ts` — fast-check property: aggregator output
  is **identity-stable across event-order reorderings** within a task
  window (sort events into the file in any permutation; same report).
- `bench-b3.test.ts` (CLI level) — `task-begin` / `task-end` exit codes,
  `--category` validation (rejects unknown values), missing required-arg
  errors, `report` against a fixture sprint file.
- `index.test.ts` smoke — `yakcc bench b3 --help` lists three subcommands;
  `yakcc bench b3 unknown` exits non-zero with usage line.

**Required evidence (paste verbatim in PR description):**
- A sample sprint JSONL produced by running `yakcc bench b3 task-begin
  "smoke" --category boilerplate --classifier dev`, then exercising the
  hook with one cache hit + one passthrough via `yakcc shave-* /
  yakcc-resolve-*` against a seeded fixture, then `yakcc bench b3
  task-end "smoke"`, then `yakcc bench b3 report --sprint default`.
- The full `--json` and text report from that fixture sprint.

**Required real-path checks:**
- Marker file is produced under `$YAKCC_TELEMETRY_DIR/bench-b3/`
  (no `/tmp` shortcut).
- Report consumes events via `readTelemetrySessions` from
  `@yakcc/hooks-base/telemetry.js` — **no second JSONL parser** in
  `bench-b3-aggregator.ts` (mirror DEC-CLI-STATS-READER-SEAM-001 / Sacred
  Practice #12).
- PROTOCOL.md references commands by their exact landed invocation.
- `yakcc bench b3 --help` lists `task-begin`, `task-end`, `report`.

**Required authority invariants:**
- Zero touched files under `packages/hooks-base/src/`. The hook stays
  the single authority for cache-event emission.
- Zero touched files under `packages/registry/`. B3 is read-side
  telemetry analysis.
- `bench-b3-aggregator.ts` contains no `JSON.parse` loop over telemetry
  files. Only `readTelemetrySessions` is allowed.
- `yakcc stats` is not modified (Tier-2 work is tracked at #768).
- `yakcc telemetry` is not modified.

**Forbidden shortcuts:**
- No in-memory-only event buffer in the harness — markers must persist.
- No synthetic event generation in production code paths. Fixtures used
  in tests live under `packages/cli/src/__fixtures__/bench-b3/` or
  inline as test-local strings, never in the production aggregator.
- No `dynamic require` of telemetry internals; only the exported
  `readTelemetrySessions`, `resolveTelemetryDir`, `TelemetryEvent`
  surface is consumed.
- No silent default for `--category` or `--classifier`. Both required.
- No "fallback to most-recent session" magic if `--sprint` is omitted;
  the default sprint id is the literal `"default"`.

**Ready-for-guardian:**
- All required tests pass (unit + props) under `pnpm --filter
  @yakcc/cli test`.
- Smoke tests pass under `pnpm test` from repo root.
- Lint + typecheck clean (`pnpm lint`, `pnpm typecheck`) — pre-push
  hygiene gate.
- `tsc --noEmit` clean for `packages/cli` and `packages/hooks-base`
  (the latter must compile unchanged).
- A live sprint smoke-run completed locally: events flow into the
  marker file, the report renders, verdict line includes the three
  category bars + KILL line.
- PR description includes the sample JSONL and report verbatim.
- PROTOCOL.md updated and rendered in the PR diff.

**Rollback boundary:** Single PR. Reverting the merge restores prior
state cleanly because (a) we add no new state authority, (b) no
hook-layer code changes, (c) the marker file is sidecar-only.

## 8 — Scope Manifest (canonical — also persisted via `cc-policy workflow scope-sync`)

**Allowed paths (implementer may touch):**
- `packages/cli/src/commands/bench-b3.ts` (new)
- `packages/cli/src/commands/bench-b3.test.ts` (new)
- `packages/cli/src/commands/bench-b3-markers.ts` (new)
- `packages/cli/src/commands/bench-b3-markers.test.ts` (new)
- `packages/cli/src/commands/bench-b3-aggregator.ts` (new)
- `packages/cli/src/commands/bench-b3-aggregator.test.ts` (new)
- `packages/cli/src/commands/bench-b3-aggregator.props.ts` (new)
- `packages/cli/src/__fixtures__/bench-b3/*.jsonl` (new test fixtures)
- `packages/cli/src/__fixtures__/bench-b3/**` (new test fixtures)
- `packages/cli/src/index.ts` (add `"bench"` switch case + help line)
- `packages/cli/src/index.test.ts` (smoke for `bench b3 --help`)
- `bench/B3-cache-hit/PROTOCOL.md` (revise §1–§5 to use new CLI)
- `bench/B3-cache-hit/tasks.csv.template` (new — pre-sprint task list template)

**Required paths (must be modified for the WI to be complete):**
- `packages/cli/src/commands/bench-b3.ts`
- `packages/cli/src/commands/bench-b3-markers.ts`
- `packages/cli/src/commands/bench-b3-aggregator.ts`
- `packages/cli/src/index.ts`
- `bench/B3-cache-hit/PROTOCOL.md`

**Forbidden paths:**
- `packages/hooks-base/**` — single source of truth for cache-event
  emission; do not touch.
- `packages/hooks-*/**` — IDE adapters; no harness wiring here.
- `packages/registry/**` — read-only consumers only; no touches.
- `packages/contracts/**` — schema authority; harness is sidecar.
- `packages/cli/src/commands/stats.ts` — Tier-2 follow-up at #768.
- `packages/cli/src/commands/telemetry.ts` — orthogonal command.
- `docs/archive/developer/MASTER_PLAN.md` — not churned for this WI;
  the post-landing decision-log row is added once results land,
  authored by a future planner pass.
- `bootstrap/**`, `.claude/**`, `runtime/**`, `hooks/**` — control
  plane.

**State authorities touched (read-only):**
- Telemetry JSONL stream under `YAKCC_TELEMETRY_DIR` — read via
  `readTelemetrySessions`.

**State authorities introduced:**
- Sidecar task-marker JSONL under `$YAKCC_TELEMETRY_DIR/bench-b3/` —
  owner: `bench-b3-markers.ts`; aggregator is the only reader.

## 9 — MASTER_PLAN alignment

`MASTER_PLAN.md` at the worktree root is a redirect stub. The real plan
lives at `docs/archive/developer/MASTER_PLAN.md` and references #187 as
"deferred-pre-req" under `DEC-BENCH-SUITE-DEFERRAL-001` (line 2857). That
deferral was conditional on "hook-layer v0.5+ maturity AND v3 discovery
substrate D1+D4." Both prerequisites have landed (hook layer is in
production, D1/D4 are #151/#154 closed). The harness shipping here is the
unblock, not a churning of the deferral row.

**This WI does NOT modify the master plan.** A future post-sprint
planner pass will add the verdict (`DEC-BENCH-B3-001`) once the operator
runs the sprint and reports results. The implementer should cite #187
directly in commit messages and `@decision` annotations.

## 10 — Decision Log additions (in-file, no MASTER_PLAN churn)

`@decision` annotations the implementer writes in source:

- `DEC-WI187-001` — task boundaries via CLI marker (DEC-WI187-001 → §4.1 above)
- `DEC-WI187-002` — sidecar JSONL marker schema (§4.2)
- `DEC-WI187-003` — one file per sprint under `bench-b3/` (§4.3)
- `DEC-WI187-004` — zero hook-layer modifications (§4.4)
- `DEC-WI187-005` — `yakcc bench b3` CLI subcommand (§4.5)
- `DEC-WI187-006` — classification required at task-begin (§4.6)
- `DEC-WI187-007` — comparator arm = same flow, distinct sprint id (§4.7)
- `DEC-WI187-008` — five selection-bias protocol clauses (§4.8)

Each `@decision` block in source must include rationale and a back-link
to this PLAN.md (e.g. `Cross-reference: PLAN.md §4.1 / #187`).

## 11 — Implementer marching orders

1. Branch is already provisioned at `feature/187-b3-harness`. Verify HEAD
   is descended from `df669fb`.
2. Implement in the slice order of §6. Run `pnpm --filter @yakcc/cli test`
   after each slice.
3. Before pushing: rebase onto `origin/main`, run `pnpm lint`, `pnpm
   typecheck`, full vitest, and the local smoke described under §7
   "Required evidence." Capture the report output for the PR description.
4. Mark the WI ready via `cc-policy evaluation set ready_for_guardian`
   when all gates green (the Agent-tool path does not auto-project,
   per `feedback_agent_tool_completion_projection_gap`).
5. PR title: `feat(cli,bench): #187 — B3 telemetry harness (task markers
   + stratified report)`. Body: paste the smoke evidence verbatim.
6. Do NOT close #187. The sprint execution is still pending. The PR body
   says "Unblocks the operator-run sprint per
   `bench/B3-cache-hit/PROTOCOL.md`."

## 12 — Open questions for the operator (post-WI)

These are NOT blockers for the implementer — they are operator decisions
the harness defers to the sprint-execution phase:

- Who is the "representative engineer" (the #187 selection-bias control)?
- Which classifier is the "independent reviewer"?
- Which 30+ tasks form the pre-sprint task list?
- Where will the comparator-arm sprint slot in calendar-wise?

The harness does not need answers to any of these to ship.

---

PLAN authored 2026-05-27 against worktree HEAD `df669fb` (origin/main).
