# B16 phase 2: proposal for approval

**The ask:** run Sonnet 5.5, Opus 5.5 and Fable 5.2 from scratch on the 12 tasks Haiku cannot
reliably write, 5 seeds each, plus fresh Haiku reuse arms on all 42 tasks. Estimated **$61**,
hard cap **$80**. It decides H1 (parity) and H2 (cost), the claims the project rests on.

## What the iterations since phase 1b changed (all under $2 each, $4.51 in all)

| Run | Cost | What it showed |
|---|---|---|
| phase 1b | $0.82 | Phase 1's hard non-semver tasks were spec errors; the routing loss was zero |
| screen-1 to screen-5 | $0.84 | Specs that restate an algorithm make tasks easy. Brief specs (the standard named, only the module's choices stated) found 6 more hard tasks |
| phase 1c | $0.53 | Reuse solves the new semver tasks 5 of 5. On national IDs Haiku won't search |
| phase 1d (forced search) | $0.72 | Even when forced to search, Haiku declines `isTaxID` at the confirm step |
| phase 1e (card fix) | $0.13 | A card bug fixed (`isTaxID` showed another function's comment). Still not picked: its card doesn't name the countries it covers |
| calibration | $1.47 | Frontier cost per attempt on hard semver tasks: Sonnet $0.13, Opus $0.44, Fable $0.73 (1.5–3× the estimate). All three pass `normalize-range` |

## The task set: 42 tasks, 12 hard or medium for Haiku from scratch

| Task | Family | Haiku from scratch | Haiku routed reuse |
|---|---|---|---|
| `above-range`, `below-range`, `lowest-allowed-version`, `normalize-range`, `range-within-range`, `ranges-overlap` | versioning | 0.00 | 1.00 |
| `lowest-satisfying` | versioning | 0.20 | 1.00 |
| `coerce-version` | versioning | 0.40 | 0.80 |
| `best-compatible-version` | versioning | 0.60 | 1.00 |
| `bulgarian-egn-valid` | validation | 0.00 | 0.20 |
| `czech-birth-number-valid-brief`, `german-tax-id-valid-brief` | validation | 0.00 | 0.00 |

The other 30 tasks are easy for Haiku from scratch (pass@1 ≥ 0.8); there routed reuse does no
harm (H3 holds: pass@1 difference 0.00, cost 0.93× of scratch).

## Design

1. **Frontier arms only on the 12 tasks below 0.8.** H1, H2, H4 and "tasks solved only by
   reuse" use only these tasks; H3 needs no frontier arm. This costs a third as much as
   running all 42 and loses no hypothesis.
2. **The reuse arms rerun with fresh attempts in phase 2** (`R-haiku` primary; `A-haiku`,
   `F-haiku` and `O-haiku` secondary) on all 42 tasks, with the fixed index. This keeps the
   arm the hypotheses test from having been chosen on the data it is tested with. It costs
   about $1.
3. **Hypotheses and decision rules unchanged (PROTOCOL.md §6).** `R-haiku` is the arm H1, H2
   and H5 test, as preregistered. `F-haiku`'s and `A-haiku`'s H1 are reported and do not decide.
4. **Effort `high`, 32k output tokens, 5 seeds**, as in the protocol.

## What I expect (written before the run)

- **Versioning (9 tasks): parity and a large cost gap.** Routed Haiku passes about 1.0; the
  calibration's frontier attempts passed. Cost per correct: Haiku about $0.002 against Sonnet's
  $0.13, a ratio near 0.02, far inside H2's bar of 0.2.
- **Validation (3 tasks): reuse loses.** Haiku rarely picks the module because its card does
  not name the countries it covers. Sonnet and Opus also missed one Czech case each. So H1 over
  all 12 may fall near its −0.05 bar, and H4 (generality) is likely to fail for validation.
  That outcome is informative: the bottleneck there is the module's card, not the model.

## Cost

| Arm | Tasks × seeds | $ per attempt (calibrated) | Estimate |
|---|---|---|---|
| S-sonnet | 12 × 5 | $0.13 versioning, $0.015 validation | $6.1 |
| S-opus | 12 × 5 | $0.44, $0.03 | $20.3 |
| S-fable | 12 × 5 | $0.73, $0.07 | $33.9 |
| R-, A-, F-, O-haiku (fresh) | 42 × 5 each | about $0.002 | $1.0 |
| **Total** | | | **$61** (cap $80) |

## The commands (after approval)

```sh
# (The fixed index, from the repo root: .cache is not committed.)
node scripts/build-module-index.mjs --all-builds --min-nodes 150 \
  --descriptions bench/B12-need-to-code/results/descriptions.json \
  --out bench/B16-frontier-parity/.cache/module-index-min150-v2.json
cd bench/B16-frontier-parity
H=above-range,below-range,lowest-allowed-version,normalize-range,range-within-range,ranges-overlap,lowest-satisfying,coerce-version,best-compatible-version,bulgarian-egn-valid,czech-birth-number-valid-brief,german-tax-id-valid-brief
node harness/run.mjs --client anthropic --run phase2 --index .cache/module-index-min150-v2.json \
  --arms R-haiku,A-haiku,F-haiku,O-haiku --seeds 5 --max-dollars 2
node harness/run.mjs --client anthropic --run phase2 --arms S-sonnet,S-opus,S-fable \
  --tasks $H --seeds 5 --max-dollars 78
node harness/analyze.mjs --run phase2 --run phase1-scratch
```

The analysis pools phase 2 with `results/phase1-scratch`: only phase 1's Haiku scratch arms (`S-haiku`,
`S-haiku-max`), which set the tiers.

## Not addressed (threats, PROTOCOL.md §8)

- One corpus of 20 npm packages, JavaScript only. Eight of the 12 hard tasks are one package's
  range algebra.
- No scratch arm that tests its own code and retries; a frontier model with tests would cost
  more and might pass more.
- The card problem found in phase 1d and 1e (a general-purpose module whose card does not name
  its cases is not picked) is a discovery issue for #1309, not fixed here.
