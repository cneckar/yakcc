# DEC-BENCH-B4-V3-001 — B4-v3 hypothesis matrix execution dossier

> **Status**: accepted
> **Decision**: First B4-v3 matrix run is preserved as the inaugural execution of record. The hypothesis (registry-hooked atoms reduce output tokens) is **not supported at this corpus shape**. Next-iteration design changes documented inline; second matrix run is a separate WI gated on those changes.
> **Closes**: #653
> **Run identifiers (canonical)**: `phase1-2026-05-17T23-16-09` + `phase2-2026-05-17T23-23-33`
> **Total spend**: $7.08 USD against $75 cap (`DEC-V0-B4-SLICE2-COST-CEILING-004`)
> **Operator authorization**: `cdn@yakcc.com`, 2026-05-17 ("run the full benchmarks")

## 1. Objective

Per #653, execute the B4-v3 two-phase hypothesis matrix end-to-end and produce a DEC-attributed dossier. The hypothesis under test:

> Giving a weaker model (sonnet, haiku) access to a registry of atoms shaved from a stronger model's (opus) solutions lets the weaker model produce the same correct output with **fewer total tokens** (and ideally higher pass-rate). Without hooks, the weaker model either fails or burns more output. With hooks, it leverages the registry to short-cut to a correct solution.

The matrix shape: **3 models × 2 hook configs × 5 tasks × 3 reps = 90 calls** in Phase 2, building on Phase 1's Opus-built corpus.

## 2. Execution mechanics

### Phase 1 (corpus build, Opus unhooked)

Two runs, because of an apparatus discovery:

| Run | Outcome | Cost | Atoms in registry |
|---|---|---|---|
| `phase1-2026-05-17T23-06-34` | 13/15 oracle PASS but **license-refused** in shave atom-sync (LLM scratch impls lacked SPDX headers) | $1.70 | **0** |
| `phase1-2026-05-17T23-16-09` | 13/15 oracle PASS, atoms registered | $1.75 | **335** |

The license-refused failure surfaced an apparatus gap: the shave pipeline's license gate refused LLM-generated scratch impls. Patched in `bench/B4-tokens-v3/harness/atom-sync.mjs` (auto-prepend MIT SPDX) — the patch was a workaround mirroring the production `hooks-base/atomize.ts` pattern. The underlying license-gate vestige was subsequently removed entirely via #682/PR #714 per operator DEC ("we are reimplementing behavior, not copying code"). Both the bench workaround AND the production atomize SPDX-prepend are now gone in main.

Both phase 1 result files are preserved here for the historical record of the apparatus discovery.

### Phase 2 (matrix exploit, 6 cells × 5 tasks × 3 reps)

Single run: `phase2-2026-05-17T23-23-33`. 90/90 calls completed. Total cost $5.33.

Cells:

| Cell | Model | Hook config |
|---|---|---|
| A | opus | unhooked (baseline) |
| B | opus | hooked (registry via MCP) |
| C | sonnet | unhooked |
| D | sonnet | hooked |
| E | haiku | unhooked |
| F | haiku | hooked |

## 3. Headline empirical findings

### Oracle pass-rate (X/3 reps)

| Task | A opus·unhooked | B opus·hooked | C sonnet·unhooked | D sonnet·hooked | E haiku·unhooked | F haiku·hooked |
|---|---|---|---|---|---|---|
| json5-parser | **3/3** | **0/3** | **3/3** | **0/3** | 0/3 | 1/3 |
| pkce-code-verifier | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| two-phase-commit | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| kahan-running-stats | 3/3 | 3/3 | 3/3 | 2/3 | 3/3 | 3/3 |
| token-bucket-rate-limiter | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |

### Per-cell token / cost averages (where all reps succeeded — clean apples-to-apples)

pkce-code-verifier (every cell passed; cleanest comparison):

| Cell | in tokens | out tokens | total | $/call |
|---|---|---|---|---|
| A opus unhooked | 734 | 411 | 1,145 | $0.042 |
| **B opus hooked** | **4,128** | **449** | **4,577** | **$0.096** |
| C sonnet unhooked | 521 | 307 | 828 | $0.006 |
| **D sonnet hooked** | **3,714** | **1,817** | **5,531** | **$0.038** |
| E haiku unhooked | 520 | 339 | 859 | $0.002 |
| **F haiku hooked** | **3,661** | **613** | **4,274** | **$0.005** |

### Hooked-vs-unhooked deltas summary (across all passing tasks)

- **Input tokens (hooked)**: 4–7× the unhooked baseline (MCP context-stuffing).
- **Output tokens (hooked)**: roughly equal (opus) to 2–6× larger (sonnet) than unhooked. Never smaller.
- **Cost per call (hooked)**: 2–6× the unhooked baseline.
- **Quality (hooked)**: equal or worse. Opus+hooked and Sonnet+hooked truncated at max_tokens=4096 on json5-parser (the largest output task), failing 0/3.

## 4. Verdict on the hypothesis

**The hypothesis is not supported at this corpus shape.**

Hooking added cost on every cell where it could be measured cleanly, never reduced output tokens, and degraded quality on the one task large enough to stress the output budget. The faint signal toward a rescue is on `json5-parser × F haiku hooked` (1/3 pass vs 0/3 unhooked) — the one cell where the test conditions for "weak model rescued by registry" actually fired. N=3 is too thin to call it confirmed.

**But the experimental design did not actually exercise the rescue scenario for 4 of 5 tasks** — pkce / two-phase-commit / kahan / token-bucket are within haiku's solo capability, so registry rescue couldn't help (haiku didn't fail in the first place). The "hooks degrade outcome" finding is empirically robust; the "hooks rescue weak models" hypothesis is not actually under test on those 4 tasks.

## 5. Design observations surfaced (operator, 2026-05-17 review)

Two structural issues with the apparatus, discovered while interpreting the data:

### 5.1 Registry is shredded; no task-scale atoms to find

Querying the populated registry directly:
- 194 atoms total
- ALL 194 at level L0 (leaf-level fragments)
- Largest impl_source: 1,601 chars
- Average impl_source: 88 chars

The biggest root blocks are tiny things like `class RateLimitError extends Error {...}` (415 chars), `base64urlEncode(buf) {...}` (162 chars), `let pos = 0;` (12 chars), and one literal `0` (1 char).

**There is no "json5-parser whole impl" atom for haiku to find.** Shave's decomposer is shredding Opus's solutions all the way down to single-statement / single-literal fragments. The hooked model's MCP query — even if it asked for "find me a json5 parser" — would get back no match, because no atom in the registry represents anything close to "a json5 parser." The hypothesis assumes "Opus solved it → atom for the whole solution is in the registry → dumb model finds it" — but shave decomposed the solution into 100+ fragments. The weak model would have to find *and assemble* those fragments, which is a harder task than just writing the impl from scratch.

### 5.2 Task set isn't calibrated to weak-model failure threshold

Only json5-parser was hard enough to make haiku fail (and even there, haiku unhooked got 36/40 and 38/40 — close to passing). The other 4 tasks were within haiku's solo capability, so the rescue test couldn't fire. A meaningful rescue experiment needs tasks deliberately calibrated to the weaker model's failure boundary.

## 6. Next iteration: changes needed before B4-v4

Two structural changes for the next matrix to actually test the hypothesis:

1. **Registry redesign**: persist task-scale composite atoms alongside leaf atoms (or add an "intent index" of full Opus solutions queryable by task intent). Without this, top-down "find a complete solution" queries from the hooked model have nothing to match.
2. **Task-set recalibration**: pick 6–10 tasks deliberately at or beyond haiku's failure boundary. Larger impls, intricate state machines, full parsers — things haiku reliably fails to produce solo. Without this, the rescue effect can't be observed even if the registry has good atoms.
3. **(Optional) Dumber-than-haiku cell**: add `claude-3-haiku-20240307` (the original Haiku 3.0) as cells G/H. Same matrix shape, but with a model far enough below the failure boundary to make rescue measurable.
4. **(Optional) Increased rep count on rescue-eligible tasks**: N=10 instead of N=3 on tasks where the rescue test fires, so 1/3 vs 0/3 signals become statistically meaningful.

These belong in a separate WI (B4-v4 or similar). #653 is closed by this dossier; the redesign work needs its own DEC.

## 7. Apparatus / process notes

- **Cost discipline held**: $7.08 actual / $75 cap. Phase 1 v1 (the license-refused failed run) cost $1.70 and produced no usable atoms — that's the apparatus tax for discovering the gate. Worth recording.
- **Honesty clause held**: the test conditions clearly favored the null hypothesis, and the dossier records that honestly rather than reframing the data.
- **Apparatus changes since this run**:
  - Bench `ensureSpdxHeader` workaround removed (#714)
  - Production `hooks-base/atomize.ts` MIT-SPDX auto-prepend removed (#714)
  - shave license gate entirely removed (#682 / PR #714)
  - These changes mean B4-v4 will not need the SPDX workaround at all — the gate that motivated it is gone.
- **Raw artifacts** (committed alongside this dossier):
  - `phase1-2026-05-17T23-06-34.json` + `.jsonl` — the license-refused run
  - `phase1-2026-05-17T23-16-09.json` + `.jsonl` — the corpus-build run
  - `phase2-2026-05-17T23-23-33.json` + `.jsonl` — the matrix run

## 8. Cross-references

- WI: #653 (`[FuckGoblin] WI-B4-V3-EXECUTE`)
- Predecessor: PR #647 (harness landing only)
- Budget DEC: `DEC-V0-B4-SLICE2-COST-CEILING-004`
- Phase-split DEC: `DEC-BENCH-B4-V3-PHASE1-BUDGET-001`
- Related apparatus PRs: #714 (license-gate removal), #682 (issue)
- Cluster context: `DEC-B4-CONVERGENCE-001` (Path A + Path B convergence — Path A landed via WI-510 / #642 cluster; this dossier represents the Path A *measurement* leg, even though it refutes the convergence hypothesis at this corpus shape)
