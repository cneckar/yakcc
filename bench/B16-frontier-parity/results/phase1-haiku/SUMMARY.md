# B16 phase 1 (Haiku arms): summary

Run `phase1-haiku`: 34 tasks. It stopped at its $3 cap after 610 of 680 attempts ($3.08):
- `S-haiku` and `S-haiku-max` have 5 seeds;
- `R-haiku` and `O-haiku` have 4 (the last seed was not reached).

The full per-task table is `report.md`.

| Arm | Mean pass@1 | Dollars per correct |
|---|---|---|
| S-haiku (from scratch, effort high) | 0.78 | $0.00453 |
| S-haiku-max (from scratch, effort max) | 0.42 | $0.03036 |
| **R-haiku (routed reuse)** | **0.91** | **$0.00182** |
| O-haiku (target module handed over) | 0.95 | $0.00125 |

**Tiers by Haiku's from-scratch pass@1.** 7 hard, 1 medium, 26 easy.
- **The hard tasks:** `range-within-range`, `canonical-emails`, `ranges-overlap`, `lowest-allowed-version`, `coerce-version`, `above-range` and `domain-name-valid`.
- **The medium task:** `best-compatible-version`.

**What phase 1 shows**

- **H5 (lift on hard tasks).** The mean lift of `R-haiku` over `S-haiku` is 0.57, interval [0.14, 0.86]. The rule needs the interval's lower end above 0.15, so H5 does not hold as written: it misses by 0.01, on 7 tasks.
  - The semver tasks go from 0 to 1.
  - The other two hard tasks fail on the routed arm too, and for them the spec audit below applies.
- **H3 (no harm on easy tasks)** holds:
  - mean pass@1 difference 0.00;
  - dollars per correct at 0.93× of `S-haiku`.
- **Discovery loss** (`O-haiku` − `R-haiku`): 0.04, interval [−0.01, 0.10].
- **More thinking does not rescue Haiku.** `S-haiku-max` passes less than `S-haiku` and costs 7× more per correct. 93 of its 168 attempts hit the 32k output limit (the mean output was 25k tokens).
- **Spec audit (PROTOCOL.md §4): four tasks fail even with the module handed over** (`O-haiku` < 1), so their specs or reference glue need fixing before phase 2:

  | Task | `O-haiku` pass@1 |
  |---|---|
  | `canonical-emails` | 0.25 |
  | `coerce-version` | 0.5 |
  | `ean-valid` | 0.75 |
  | `domain-name-valid` | 0.75 |

Phase 2 (Sonnet, Opus, Fable) is not run. Reuse economics (#1253) is paused by the self-rebuild plan, #1361.
