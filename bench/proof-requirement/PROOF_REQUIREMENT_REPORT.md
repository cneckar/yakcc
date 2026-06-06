<!-- SPDX-License-Identifier: MIT -->
<!--
  bench/proof-requirement/PROOF_REQUIREMENT_REPORT.md
  Report skeleton for the proof-requirement benchmark (wi-1089).
  Section headers and metric table structure are fixed here; values are filled
  after the paid live run (see METHODOLOGY.md §8 for the trigger conditions).
-->

# proof-requirement benchmark — Results Report

**Status:** PENDING (scaffold only — live run not yet executed)

**Prerequisite gates:**
- [ ] `node harness.mjs --dry-run` passes cleanly
- [ ] Seeding complete for crc32c, base64-encode, blake3-hash, hmac-sha256
- [ ] `liveResolve()` wired in harness.mjs (see METHODOLOGY.md §5)
- [ ] Projected cost reviewed and approved by operator
- [ ] Live run executed

---

## 0. Run metadata

| Field | Value |
|---|---|
| Run ID | _(fill after live run)_ |
| Run date | _(fill)_ |
| Model | claude-sonnet-4-6 |
| Registry | _(path + sha256 of .sqlite)_ |
| Tasks | 12 (see tasks.json) |
| Modes | required, preferred, ignored, per_block |
| Reps per task×mode | 3 |
| Total reps | _(fill)_ |
| Actual cost | $_(fill)_ |
| Budget cap | $30 |
| YAKCC_PROOF_BONUS | 0.10 (default) |
| YAKCC_RETRACTION_PENALTY | 0.20 (default) |

---

## 1. Substitution rate by mode (Q1, Q2)

> **Definition:** fraction of reps where `substituted=true`
> (i.e., `confidence_tier=auto_accept` AND model used the reference-emit path).
>
> **Interpretation:** higher substitution rate = fewer output tokens, lower cost.
> `required` on seeded tasks should approach 100%; `required` on unseeded tasks
> must be 0% (no_candidates returned). `preferred` > `ignored` for seeded tasks
> proves the proof bonus has measurable effect.

### All tasks

| Mode | n_reps | substituted | substitution_rate |
|---|---|---|---|
| required | — | — | — |
| preferred | — | — | — |
| ignored | — | — | — |
| per_block | — | — | — |

### Seeded tasks only (crc32c, base64-encode, blake3-hash, hmac-sha256)

| Mode | n_reps | substituted | substitution_rate |
|---|---|---|---|
| required | — | — | — |
| preferred | — | — | — |
| ignored | — | — | — |
| per_block | — | — | — |

### Unseeded tasks only

| Mode | n_reps | substituted | substitution_rate |
|---|---|---|---|
| required | — | — | — (expected 0%) |
| preferred | — | — | — |
| ignored | — | — | — |
| per_block | — | — | — |

---

## 2. Token cost delta vs. `ignored` baseline (Q4)

> **Definition:** `output_token_reduction = (avg_output[ignored] - avg_output[mode]) / avg_output[ignored] × 100`
> A positive value = fewer tokens than baseline.
>
> **Interpretation:** `required` and `preferred` should show positive reduction for seeded tasks
> (substitution collapses output to ~14 tokens from ~900–2000). For unseeded tasks,
> `required` may show negative reduction (model must author + produces triplet emission).

### Average output tokens per mode

| Mode | avg_input_tokens | avg_output_tokens | avg_cost_usd | output_reduction_vs_ignored |
|---|---|---|---|---|
| required | — | — | — | — |
| preferred | — | — | — | — |
| ignored | — | — | — | 0% (baseline) |
| per_block | — | — | — | — |

### Per-task breakdown (representative tasks)

| Task | mode=required out_tok | mode=preferred out_tok | mode=ignored out_tok | mode=per_block out_tok |
|---|---|---|---|---|
| crc32c (seeded) | — | — | — | — |
| base64-encode (seeded) | — | — | — | — |
| blake3-hash (seeded) | — | — | — | — |
| hmac-sha256 (seeded) | — | — | — | — |
| utf8-codec (unseeded) | — | — | — | — |
| semver-range (unseeded) | — | — | — | — |
| per-block-hash-and-encode | — | — | — | — |

---

## 3. Per-block adoption (Q3)

> **Definition:** `per_block_adoption = count(per_block reps resolved via hot_hit or warm_candidate_list) / total per_block reps`
>
> **Interpretation:** a high adoption rate on the compound task (`per-block-hash-and-encode`)
> indicates sophisticated agents decompose compound intents and use `per_block` mode
> spontaneously or when prompted. The interesting comparison is:
>   compound task per_block adoption  vs.  compound task ignored adoption
> If `per_block` adoption is significantly higher, the mode provides a measurable
> nudge toward decomposition.

| Task | mode | n_reps | resolved | per_block_adoption |
|---|---|---|---|---|
| per-block-hash-and-encode | per_block | — | — | — |
| per-block-hash-and-encode | ignored | — | — | — (baseline) |
| all compound tasks | per_block | — | — | — |

---

## 4. Flow-class distribution

> **Definition:** `flow_class` ∈ { hot_hit, warm_candidate_list, cold_miss, required_no_match }
>
> - `hot_hit`: auto_accept + substituted
> - `warm_candidate_list`: candidate_list returned (agent saw options but substitution not confirmed)
> - `cold_miss`: no_candidates (below threshold or unseeded + ignored/preferred)
> - `required_no_match`: no_candidates with `reason=no_proven_atoms_match` (required mode, no proof)

| Mode | hot_hit | warm_candidate_list | cold_miss | required_no_match | total |
|---|---|---|---|---|---|
| required | — | — | — | — | — |
| preferred | — | — | — | — | — |
| ignored | — | — | — | — | — |
| per_block | — | — | — | — | — |

---

## 5. Reason code distribution

> Reason codes from #1088 G.5:
> - `no_proven_atoms_match`: `required` mode hard filter dropped all candidates
> - `retracted_top_candidate`: top-semantic match was retracted (should be 0 in this run if no retractions)

| Reason | count | modes observed |
|---|---|---|
| no_proven_atoms_match | — | required, per_block (required dims) |
| retracted_top_candidate | — | — |
| below_threshold | — | ignored, preferred |
| (none) | — | hot_hit reps |

---

## 6. Proposed default validation

> Validate or revise: `YAKCC_PROOF_BONUS=0.10` and `YAKCC_RETRACTION_PENALTY=0.20`.

| Question | Expected | Observed | Pass? |
|---|---|---|---|
| Does +0.10 bonus push 0.80-scoring seeded atom to auto_accept? | yes (0.80+0.10=0.90>0.85) | — | — |
| Does -0.20 penalty drop 0.91-scoring retracted atom below auto_accept? | yes (0.91-0.20=0.71<0.85) | — | — |
| Is substitution_rate[preferred] > substitution_rate[ignored] for seeded tasks? | yes | — | — |
| Is substitution_rate[required] ≈ 100% for seeded tasks? | yes | — | — |
| Is substitution_rate[required] = 0% for unseeded tasks? | yes | — | — |

**Recommendation:** _(fill after live run)_

- If `preferred` shows no improvement over `ignored`: increase `YAKCC_PROOF_BONUS` to 0.15.
- If `required` on seeded tasks shows < 90% substitution: investigate score distribution;
  seeded atoms may be scoring below 0.85 even without proof adjustment.
- If retraction penalty produces false-negative for near-duplicate atoms: reduce to 0.15.

---

## 7. Conclusions

_(Fill after live run)_

**Q1 — Does `required` eliminate hedging for seeded tasks?**

_(Fill)_

**Q2 — Does `preferred` increase substitution vs. `ignored`?**

_(Fill)_

**Q3 — Do sophisticated agents use `per_block` for compound tasks?**

_(Fill)_

**Q4 — What is the token-cost delta when proof modes change behaviour?**

_(Fill)_

**Default recommendation:** _(Fill)_

---

## 8. Cross-references

- `METHODOLOGY.md` — measurement authority; this report is the deliverable of §8
- `tasks.json` — corpus definitions
- `harness.mjs` — the runnable implementation
- `results/` — raw JSONL traces and summary JSONs
- `gh issue #1088` — proof_requirement spec
- `gh issue #1089` — this benchmark
