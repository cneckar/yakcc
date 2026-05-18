# B3 Cache-Hit Sprint Protocol

<!--
  @decision DEC-704-B3-PROTOCOL-AUTHORITY-001
  title: bench/B3-cache-hit/PROTOCOL.md is the canonical authority for the B3 sprint procedure
  status: accepted
  rationale: #187 references this file for acceptance; future revisions amend here, not the issue.
  authority-domain: b3-protocol
-->

> Hands-on protocol for the B3 cache-hit benchmark ([#187](https://github.com/cneckar/yakcc/issues/187)):
> a 3+3+3 day sprint that measures registry-hit rate on real engineer work, with and without the
> yakcc hook engaged. The tester (operator, friendly engineer, or a sister AI) follows this
> document end-to-end. No other doc is required beyond the install pointer in Step 1.

**Audience:** B3 sprint operators and external volunteer testers.

**Issue authority:** [#187](https://github.com/cneckar/yakcc/issues/187) (B3 parent), [#704](https://github.com/cneckar/yakcc/issues/704) (alpha-gate WI that produced this file).

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
   tail -1 ~/.yakcc/telemetry/*.jsonl
   ```
   Must show at least one event. If the file is empty or absent, the hook is not firing — debug
   before proceeding.

4. **Define the task list.** Select ≥ 30 real engineering tasks from the target project. Stratify
   into three categories:
   - **Boilerplate** — repetitive, pattern-following (CRUD handlers, test scaffolding, …)
   - **Glue** — moderate novelty, adapts existing patterns to new context
   - **Novel logic** — genuinely new algorithms or domain-specific reasoning

5. **Independent reviewer pre-classifies tasks.** A second person (operator or a sister AI)
   assigns each task to a category before the sprint begins, without input from the sprint
   engineer. This prevents post-hoc rationalisation of results.

---

## 2. Hook-enabled arm

*3 working days.*

1. Engineer works normally. The hook intercepts every `Edit`/`Write`/`MultiEdit` call and routes
   through the local registry. **Do not disable or modify hook settings during this arm.**

2. **End-of-day checkpoint.** After each day, record outcome counts:
   ```sh
   grep -c '"outcome":"registry-hit"'    ~/.yakcc/telemetry/*.jsonl
   grep -c '"outcome":"synthesis-required"' ~/.yakcc/telemetry/*.jsonl
   grep -c '"outcome":"passthrough"'     ~/.yakcc/telemetry/*.jsonl
   ```

3. **Per-task friction log.** For each completed task, note (informally) whether the hook
   introduced perceptible friction (0 = none, 1 = slight, 2 = noticeable, 3 = blocked).
   This is qualitative signal for the Analysis phase — don't over-engineer it.

4. At the end of Day 3, snapshot the full telemetry for the arm:
   ```sh
   cp -r ~/.yakcc/telemetry/ /tmp/b3-arm-hook-enabled/
   ```

---

## 3. Hook-disabled arm

*3 working days.*

1. **Uninstall hooks** before starting:
   ```sh
   yakcc hooks claude-code install --uninstall
   # repeat for other IDEs you wired in Setup
   ```
   Verify that the hook file is removed (or that `tail -1 ~/.yakcc/telemetry/*.jsonl` no longer
   shows new events during a session).

2. Engineer works on the same task domain as the hook-enabled arm. The goal is statistical
   comparability: similar complexity mix, similar time budget per task.

3. **Capture baseline emission count.** No atom matching is expected. Record:
   - Total output tokens per task (from IDE telemetry or manual estimate)
   - Number of inference passes per task
   - No `registry-hit` events are expected; any that appear indicate a stale hook wire.

4. At the end of Day 3, snapshot the arm:
   ```sh
   cp -r ~/.yakcc/telemetry/ /tmp/b3-arm-hook-disabled/
   ```

---

## 4. Analysis

*Approximately 3 days.*

1. **Aggregate hit rates by category.**
   For the hook-enabled arm, compute:
   - `boilerplate_hit_rate = registry-hit count / total boilerplate tasks`
   - `glue_hit_rate = registry-hit count / total glue tasks`
   - `novel_logic_hit_rate = registry-hit count / total novel-logic tasks`

2. **Diff token spend per task.**
   Compare output tokens and inference passes between arms for matched tasks. Report:
   - Mean output-token reduction (%)
   - Median output-token reduction (%)
   - Tasks where hook-enabled was *more* expensive (flag for root-cause)

3. **Selection-bias check.**
   Review whether the sprint engineer subconsciously routed tasks differently between arms
   (e.g., harder tasks to the hook-disabled arm). If the independent reviewer notices
   systematic category drift, note it as a confound in the verdict.

4. **Publish per-category hit rates against the bars:**
   | Category | Bar |
   |---|---|
   | Boilerplate | ≥ 60% |
   | Glue | ≥ 30% |
   | Novel logic | ≥ 10% |

---

## 5. Verdict

*Final output of the sprint.*

1. **Annotate `DEC-BENCH-B3-001` in MASTER_PLAN.md** with the observed hit rates, the token-spend
   delta, and a GREEN / YELLOW / RED verdict against the bars:
   - **GREEN** — all three bars met
   - **YELLOW** — one bar missed by < 10 pp; qualitative evidence supports the miss
   - **RED** — any bar missed by ≥ 10 pp, or results inconclusive

2. **Commit raw telemetry** (hashes only — no source code from the target project). The commit
   should include the per-arm snapshot directories from Steps 2.4 and 3.4 above, the per-category
   hit-rate CSV, and the token-spend comparison table.

3. **File a verdict comment on [#187](https://github.com/cneckar/yakcc/issues/187)** linking to
   the telemetry commit and quoting the three hit rates and the token-spend delta. Close #187 if
   verdict is GREEN; leave open with a "YELLOW — re-run after corpus growth" label otherwise.

---

## Cross-references

- [#187](https://github.com/cneckar/yakcc/issues/187) — B3 parent issue; this protocol satisfies its acceptance criteria
- [#704](https://github.com/cneckar/yakcc/issues/704) — alpha-gate docs work item that authored this file
- [docs/ALPHA.md](../../docs/ALPHA.md) — tester install + onboarding guide
