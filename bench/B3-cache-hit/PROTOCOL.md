# B3 Cache-Hit Sprint Protocol

<!--
  @decision DEC-704-B3-PROTOCOL-AUTHORITY-001
  title: bench/B3-cache-hit/PROTOCOL.md is the canonical authority for the B3 sprint procedure
  status: accepted
  rationale: #187 references this file for acceptance; future revisions amend here, not the issue.
  authority-domain: b3-protocol

  @decision DEC-WI187-008
  title: Five selection-bias protocol clauses (see §8 below)
  status: accepted (WI-187)
  rationale:
    Task list locked pre-sprint (clause 1), classifier ≠ sprinter (clause 2),
    no mid-sprint reclassification (clause 3), abandoned tasks explicit (clause 4),
    tasks not in pre-sprint list flagged (clause 5).
    Cross-reference: PLAN.md §4.8 / #187
-->

> Hands-on protocol for the B3 cache-hit benchmark ([#187](https://github.com/cneckar/yakcc/issues/187)):
> a 3+3+3 day sprint that measures registry-hit rate on real engineer work, with and without the
> yakcc hook engaged. The tester (operator, friendly engineer, or a sister AI) follows this
> document end-to-end. No other doc is required beyond the install pointer in Step 1.
>
> **This revision** (WI-187 / `DEC-WI187-005`) replaces the manual `grep -c` loop in the prior
> §2.2 checkpoint with the new `yakcc bench b3` harness. All task marking and aggregation now
> happens through this CLI surface.

**Audience:** B3 sprint operators and external volunteer testers.

**Issue authority:** [#187](https://github.com/cneckar/yakcc/issues/187) (B3 parent), [#704](https://github.com/cneckar/yakcc/issues/704) (alpha-gate WI), [WI-187](https://github.com/cneckar/yakcc/issues/187) (harness WI).

---

## 1. Setup

*Pre-sprint, approximately 30 minutes.*

1. **Install yakcc.** Follow [docs/ALPHA.md § Install](../../docs/ALPHA.md#install-alpha-specific).
   The monorepo clone path is the primary install today; the optional local binary build is
   described there as well.

2. **Initialise in the target project.**
   ```sh
   cd ~/your-project
   yakcc init
   ```
   `yakcc init` wires IDE hooks (Claude Code, Cursor, Cline, Continue.dev) and seeds the
   bootstrap corpus (~4 k atoms) in one step. No separate seed command needed.

3. **Verify telemetry is flowing.**
   ```sh
   yakcc telemetry --tail 5
   ```
   Must show at least one recent event. If no events appear, the hook is not firing — debug
   before proceeding.

4. **Define the task list.** Select ≥ 30 real engineering tasks from the target project. Stratify
   into three categories:
   - **Boilerplate** — repetitive, pattern-following (CRUD handlers, test scaffolding, …)
   - **Glue** — moderate novelty, adapts existing patterns to new context
   - **Novel logic** — genuinely new algorithms or domain-specific reasoning

   Record the task list in `tasks.csv` using the template at
   `bench/B3-cache-hit/tasks.csv.template` before the sprint begins. The format is:
   ```
   slug,category,classifier
   implement-user-creation,boilerplate,alice
   wire-auth-middleware,glue,alice
   design-caching-strategy,novel-logic,alice
   ```

5. **Independent reviewer pre-classifies tasks** (DEC-WI187-008 clause 1 + clause 2).
   A second person (operator or a sister AI) fills in the `category` and `classifier` columns
   before the sprint begins. The sprint engineer must NOT influence classifications. This prevents
   post-hoc rationalisation of results.

6. **Choose sprint IDs.** Two sprint IDs distinguish the two arms:
   - Hook-enabled arm: `b3-on`
   - Hook-disabled arm: `b3-off`

   These IDs are passed as `--sprint` on every `task-begin` / `task-end` invocation.
   Marker files will be created at:
   - `~/.yakcc/telemetry/bench-b3/b3-on.jsonl`
   - `~/.yakcc/telemetry/bench-b3/b3-off.jsonl`

---

## 2. Hook-enabled arm

*3 working days. Sprint ID: `b3-on`*

1. Engineer works normally. The hook intercepts every `Edit`/`Write`/`MultiEdit` call and routes
   through the local registry. **Do not disable or modify hook settings during this arm.**

2. **At the start of each task**, record the task boundary:
   ```sh
   yakcc bench b3 task-begin <slug> \
       --category <boilerplate|glue|novel-logic> \
       --classifier <reviewer-name> \
       --sprint b3-on
   ```
   Use the slug and classification from `tasks.csv`. The `--classifier` value must match the
   independent reviewer who pre-classified this task (DEC-WI187-008 clause 2).

   Example:
   ```sh
   yakcc bench b3 task-begin implement-user-creation \
       --category boilerplate \
       --classifier alice \
       --sprint b3-on
   ```

3. **At the end of each task**, record the outcome:
   ```sh
   # Task completed normally:
   yakcc bench b3 task-end implement-user-creation --sprint b3-on

   # Task abandoned mid-sprint (excluded from N and hit-rate):
   yakcc bench b3 task-end implement-user-creation --outcome abandoned --sprint b3-on

   # Task blocked by external dependency:
   yakcc bench b3 task-end implement-user-creation --outcome blocked --sprint b3-on
   ```

   **Important:** A task abandoned without a `task-end` record becomes an open task in the
   report. Always close tasks explicitly, even if abandoned (DEC-WI187-008 clause 4).

4. **No mid-sprint reclassification** (DEC-WI187-008 clause 3). The category is frozen at
   `task-begin` time. There is no `task-update-category` command.

5. **End-of-day checkpoint.** After each day, review current status:
   ```sh
   yakcc bench b3 report --sprint b3-on
   ```
   This shows tasks declared, completed, any open tasks, and current per-category hit rates.
   The report will show `INSUFFICIENT_DATA` until ≥ 30 tasks are completed — this is expected.

---

## 3. Hook-disabled arm

*3 working days. Sprint ID: `b3-off`*

1. **Uninstall hooks** before starting (DEC-WI187-007 — comparator arm = same flow, hooks off):
   ```sh
   yakcc hooks claude-code install --uninstall
   # repeat for other IDEs you wired in Setup
   ```
   Verify that no new `registry-hit` events appear in `yakcc telemetry --tail 5` during a session.

2. Engineer works on the same task domain as the hook-enabled arm. The goal is statistical
   comparability: similar complexity mix, similar time budget per task.

3. **Use the same `task-begin` / `task-end` flow**, with `--sprint b3-off`:
   ```sh
   yakcc bench b3 task-begin implement-user-creation \
       --category boilerplate \
       --classifier alice \
       --sprint b3-off

   # ... do the work ...

   yakcc bench b3 task-end implement-user-creation --sprint b3-off
   ```

4. Events for the disabled arm will contain no `registry-hit` records. This is expected.
   The aggregator will report 0% hit rate for all categories in this arm.

---

## 4. Analysis

*After both arms are complete.*

### 4.1 Produce the hook-enabled report

```sh
yakcc bench b3 report --sprint b3-on --tasks bench/B3-cache-hit/tasks.csv
```

The `--tasks` flag enables unlisted-task detection (DEC-WI187-008 clause 5) — any task
that was recorded during the sprint but not in the pre-sprint CSV is flagged in the report.

For machine-readable output (paste into GitHub issue #187):
```sh
yakcc bench b3 report --sprint b3-on --json
```

### 4.2 Produce the hook-disabled baseline

```sh
yakcc bench b3 report --sprint b3-off --tasks bench/B3-cache-hit/tasks.csv
```

### 4.3 Evaluate against the pass bars

The `yakcc bench b3 report` output includes the verdict line automatically:

```
Per category:
  boilerplate    (n=12)  hit rate: 67.3%   bar: ≥60.0%  PASS
  glue           (n=11)  hit rate: 34.1%   bar: ≥30.0%  PASS
  novel-logic    (n= 8)  hit rate:  4.8%   bar: ≥10.0%  FAIL

Overall verdict vs #187 bars: YELLOW
KILL criterion (<30% boilerplate): not triggered (67.3% ≥ 30%)
```

| Category    | Bar   | Meaning if met                            |
|-------------|-------|-------------------------------------------|
| Boilerplate | ≥ 60% | Registry hits the most common pattern set |
| Glue        | ≥ 30% | Partial coverage of adapter work          |
| Novel logic | ≥ 10% | Even low-novelty work sees some hits      |

KILL criterion: if boilerplate hit rate < 30%, the registry coverage is too sparse to be
useful and the sprint result is an automatic RED regardless of other category results.

### 4.4 Selection-bias review

Before accepting the results, check:
- Are there tasks in `openTaskSlugs` (began but never ended)? Investigate each.
- Are there tasks in `unlistedTaskSlugs` (not in pre-sprint CSV)? Determine if they should
  be counted or excluded.
- Did the same person act as both classifier and sprint engineer? The harness cannot enforce
  this, but the independent classifier requirement (clause 2) must be documented in the
  verdict comment.

---

## 5. Verdict

*Final output of the sprint.*

1. **Annotate `DEC-BENCH-B3-001` in MASTER_PLAN.md** with the observed hit rates, the token-spend
   delta, and a GREEN / YELLOW / RED verdict against the bars:
   - **GREEN** — all three bars met
   - **YELLOW** — one bar missed by < 10 pp; qualitative evidence supports the miss
   - **RED** — any bar missed by ≥ 10 pp, or KILL criterion triggered, or results inconclusive

2. **Commit the evidence.** The commit should include:
   - `bench/B3-cache-hit/results/b3-on-report.json` (from `yakcc bench b3 report --sprint b3-on --json`)
   - `bench/B3-cache-hit/results/b3-off-report.json` (from `yakcc bench b3 report --sprint b3-off --json`)
   - `bench/B3-cache-hit/tasks.csv` (the pre-sprint task list)
   - No source code from the target project; JSONL marker files contain only slugs and timestamps.

3. **File a verdict comment on [#187](https://github.com/cneckar/yakcc/issues/187)** quoting
   the three hit rates from `--json`, the verdict line, and the KILL criterion status.
   Close #187 if verdict is GREEN; leave open with `YELLOW — re-run after corpus growth`
   label otherwise.

---

## 6. Task category taxonomy

### Boilerplate

Repetitive, pattern-following work where the output is largely structurally identical to prior
code in the codebase. Examples: CRUD route handlers following an established pattern, test
scaffolding that mirrors existing test files, configuration schema extensions that follow a
documented convention, database migration scripts with a standard up/down structure.

**Classification signal:** The engineer could produce the output by copy-pasting and adapting
an existing file, with < 20% novel structure.

### Glue

Moderate novelty, adapts existing patterns to a new context or interface boundary. Examples:
wiring a new service client into an existing dependency-injection container, adapting a library's
API to match the project's own interface conventions, connecting two existing subsystems with a
thin adapter layer.

**Classification signal:** The engineer understands the destination interface well but must
reason about the mismatch with the source. Roughly 20–60% novel structure.

### Novel logic

Genuinely new algorithms, domain-specific reasoning, or architectural decisions with no clear
prior art in the codebase. Examples: designing a caching strategy for a new access pattern,
implementing a custom rate-limiter with novel backoff semantics, authoring a DSL parser.

**Classification signal:** The engineer must reason from first principles for > 60% of the
output. No existing file serves as a structural template.

---

## 7. Harness quick reference

```sh
# Start a task
yakcc bench b3 task-begin <slug> \
    --category <boilerplate|glue|novel-logic> \
    --classifier <reviewer-id> \
    --sprint <b3-on|b3-off>

# End a task (default outcome: completed)
yakcc bench b3 task-end <slug> --sprint <b3-on|b3-off>

# End an abandoned task
yakcc bench b3 task-end <slug> --outcome abandoned --sprint <b3-on|b3-off>

# View current status (human-readable)
yakcc bench b3 report --sprint <b3-on|b3-off>

# View current status (machine-readable JSON)
yakcc bench b3 report --sprint <b3-on|b3-off> --json

# Check against pre-sprint task list
yakcc bench b3 report --sprint <b3-on|b3-off> --tasks bench/B3-cache-hit/tasks.csv

# Show help
yakcc bench b3 --help
```

Marker files are stored at:
```
~/.yakcc/telemetry/bench-b3/b3-on.jsonl
~/.yakcc/telemetry/bench-b3/b3-off.jsonl
```

(or under `$YAKCC_TELEMETRY_DIR/bench-b3/` if the env var is set).

---

## 8. Selection-bias controls (DEC-WI187-008)

The following five clauses are enforced by protocol. The harness enforces clauses 3 and 4
mechanically; the others are procedural:

1. **Task list locked pre-sprint.** The independent classifier fills in `tasks.csv` with all
   ≥ 30 tasks and their categories before the sprint engineer begins coding. No tasks may be
   added after coding starts without explicit operator approval and a note in the verdict.

2. **Classifier ≠ sprinter.** The `--classifier` value must identify a different person than
   the sprint engineer. If the same identity appears as both classifier and sprinter, the
   verdict must document this as a confound.

3. **No mid-sprint reclassification.** Once `task-begin` is run, the category is frozen.
   There is no `task-update-category` command. Any reclassification attempt requires deleting
   and re-running `task-begin`, which creates a visible gap in the marker JSONL.

4. **Abandonment is explicit.** An abandoned task must be closed with `--outcome abandoned`.
   The aggregator excludes abandoned tasks from N and from hit-rate computation. The abandoned
   count appears separately in the report so cherry-picking via abandonment is visible.

5. **Tasks not in pre-sprint list are flagged.** When `--tasks tasks.csv` is provided, the
   aggregator warns on any task slug that appears in the markers but not in the CSV. These
   tasks are included in the report by default but the operator may exclude them.

---

## Cross-references

- [#187](https://github.com/cneckar/yakcc/issues/187) — B3 parent issue; this protocol satisfies its acceptance criteria
- [#704](https://github.com/cneckar/yakcc/issues/704) — alpha-gate docs work item that authored the original file
- [WI-187 PLAN.md](../../PLAN.md) — implementer plan with full ADR rationale
- [docs/ALPHA.md](../../docs/ALPHA.md) — tester install + onboarding guide
- `bench/B3-cache-hit/tasks.csv.template` — pre-sprint task list template
