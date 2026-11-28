# B16 phase 1b (Haiku arms): summary

Run `phase1b-haiku`, $0.82 of a $2 cap, 305 attempts:
- `A-haiku` (always search) on all 37 tasks, 5 seeds;
- the other Haiku arms on the 3 added tasks and the 3 re-specced ones, 5 seeds.

`results/phase1-combined` pools it with phase 1's rows. The re-specced tasks keep only their new
rows, since their old specs were faulty, and `bic-valid` is dropped. Its `report.md` is the full
per-task table.

| Arm | Mean pass@1 | Dollars per correct |
|---|---|---|
| S-haiku (from scratch, effort high) | 0.865 | $0.00390 |
| S-haiku-max (from scratch, effort max) | 0.476 | $0.02671 |
| **R-haiku (routed reuse)** | **0.995** | **$0.00163** |
| A-haiku (always search) | 0.978 | $0.00173 |
| O-haiku (target module handed over) | 0.993 | $0.00123 |

**What phase 1b shows**

- **Phase 1's hard non-semver tasks were spec errors, not hard tasks.** With their specs fixed,
  Haiku from scratch passes `canonical-emails` and `domain-name-valid` 5 of 5, and
  `coerce-version` 2 of 5.
- **The added tasks are easy.** ISO 6346 container numbers, German tax IDs and UUID v1 to v6 all
  pass 5 of 5 from scratch. A check-digit standard is not hard for Haiku.
- **So the routing loss is zero on the hard tasks** (`A-haiku` − `R-haiku`: 0.00). Phase 1's
  finding that the routed arm lost by writing what it should have searched for came from the
  faulty specs. On all tasks, always searching is slightly worse, −0.016 [−0.038, 0.000], and
  costs a little more.
- **The hard set is 5 tasks, 4 of one family:** semver range algebra (`range-within-range`,
  `ranges-overlap`, `lowest-allowed-version`, `above-range`, 0 of 5 from scratch, all solved by
  reuse) and `coerce-version`.
  - H5 (lift on hard tasks) now holds: mean lift 0.88 [0.64, 1.00] on 5 tasks.
  - H3 (no harm on easy tasks) holds: pass@1 difference 0.00, cost 0.93× of scratch.
  - Discovery loss is nil: −0.001 [−0.020, 0.016].
- **H4 (generality) cannot be tested:** every hard task but one is semver's. In this corpus,
  what a cheap model cannot write but a library has is one package's range algebra.
- **More thinking still hurts Haiku:** `S-haiku-max` passes 0.48 at 7× the cost per correct.

Phase 2 (frontier scratch arms) is not run.
