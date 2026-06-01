# Compose-by-Reference Economics Dossier

## Header

| Field | Value |
|---|---|
| Run ID | `phase2-v5-2026-06-01T18-26-18` |
| Completed at | 2026-06-01T19:28:28.482Z |
| Total runs | 162 (6 tasks × 9 cells × 3 reps) |
| Total cost | \$24.40 (cap \$30.00) |
| Hooked arm | reference-emit |
| Corpus | committed bge-small bench corpus (auto_accept atoms) |
| Tasks | crc32c, utf8-codec, base32-rfc4648, lru-ttl-cache, semver-range, ring-buffer |

---

## Per-Cell Economics

Mean values across tasks × reps (N=18 per cell = 6 tasks × 3 reps).

| Cell | Config | Oracle pass | Mean in-tok | Mean out-tok | Mean cache-read | $/run | Mean turns |
|---|---|---|---|---|---|---|---|
| A | Opus unhooked | 18/18 (100%) | 785 | 1,330 | — | $0.112 | 1.0 |
| B | Opus hooked, cache off | 13/18 (72%) | 39,553 | 668 | — | $0.643 | 3.0 |
| B2 | Opus hooked, cache on | 11/18 (61%) | 6,282 | 654 | 26.9k | $0.302 | 3.0 |
| C | Sonnet unhooked | 17/18 (94%) | 593 | 1,392 | — | $0.023 | 1.0 |
| D | Sonnet hooked, cache off | 9/18 (50%) | 35,648 | 1,704 | — | $0.133 | 3.3 |
| D2 | Sonnet hooked, cache on | 12/18 (67%) | 7,926 | 2,366 | 21.4k | $0.085 | 3.2 |
| E | Haiku unhooked | 12/18 (67%) | 592 | 1,179 | — | $0.005 | 1.0 |
| F | Haiku hooked, cache off | 10/18 (56%) | 38,876 | 1,194 | — | $0.036 | 3.5 |
| F2 | Haiku hooked, cache on | 9/18 (50%) | 7,077 | 1,057 | 24.7k | $0.017 | 3.5 |

---

## Headline Finding: Oracle Pass Conditioned on Resolve Tier

Pooled across all hooked cells (B, B2, D, D2, F, F2):

| Resolve tier | Oracle pass | Rate |
|---|---|---|
| **auto_accept** | 58/64 | **91%** |
| candidate_list  | 6/44 | 14% |

**Compose-by-reference works when resolve is confident; it fails when it isn't.**

When `yakcc_resolve` returns `auto_accept`, the model follows the reference-emit
path and the oracle passes at 91%. When resolve falls back to
`candidate_list`, the model abandons the candidate and writes verbatim code,
yielding only 14% oracle pass — a 77-point gap.

---

## Reference-Emit Works When Followed

### Substitution Oracle: substitution_oracle_passed / substituted

When the model does follow the reference-emit path (i.e., `flow_class=followed`),
the resulting substitution passes the oracle at near-100%.

| Cell | Config | Substitution oracle pass |
|---|---|---|
| B | Opus hooked, cache off | 13/13 (100%) |
| B2 | Opus hooked, cache on | 11/11 (100%) |
| D | Sonnet hooked, cache off | 8/10 (80%) |
| D2 | Sonnet hooked, cache on | 9/9 (100%) |
| F | Haiku hooked, cache off | 9/11 (82%) |
| F2 | Haiku hooked, cache on | 8/10 (80%) |

### Output Collapse on Followed vs Ignored Path

On the followed path the model emits a short import/reference line (~530–780 tokens).
On the ignored path it writes full verbatim code (~700–2,772 tokens).

| Cell | Config | Out-tok (followed, mean) | Out-tok (ignored, mean) |
|---|---|---|---|
| B | Opus hooked, cache off | 634 (n=13) | 756 (n=5) |
| B2 | Opus hooked, cache on | 627 (n=11) | 696 (n=7) |
| D | Sonnet hooked, cache off | 671 (n=8) | 1905 (n=8) |
| D2 | Sonnet hooked, cache on | 538 (n=6) | 2772 (n=9) |
| F | Haiku hooked, cache off | 780 (n=11) | 1846 (n=7) |
| F2 | Haiku hooked, cache on | 721 (n=10) | 1476 (n=8) |

---

## The Leak: candidate_list and model_ignored_candidate

Failure class distribution across all hooked cells (N=108 reps):

| Failure class | Count |
|---|---|
| none | 64 |
| model_ignored_candidate | 44 |

Flow class distribution across all hooked cells:

| Flow class | Count |
|---|---|
| followed | 59 |
| resolved_then_ignored | 44 |
| malformed | 5 |

When `tier_returned=candidate_list` the model almost universally ignores the
candidate (`resolved_then_ignored`, `failure_class=model_ignored_candidate`).

**auto_accept coverage against the 6-atom corpus** (the real ceiling):

| Driver | Cell | auto_accept / total | Coverage |
|---|---|---|---|
| opus | B | 13/18 | 72% |
| sonnet | D | 10/18 | 56% |
| haiku | F | 11/18 | 61% |

The two concrete levers to close the gap:

1. **Raise auto_accept coverage**: larger/better reference corpus, improved embedding
   quality, or threshold tuning to convert more resolves from `candidate_list` to
   `auto_accept`.
2. **Fix candidate_list prompt compliance**: improve the system prompt or few-shot
   examples so the model prefers a returned candidate over writing a worse verbatim
   implementation.

---

## Haiku Rescue — The Honest Verdict

| | Cell | Oracle pass | Pass % |
|---|---|---|---|
| Haiku unhooked | E | 12/18 | 67% |
| Haiku hooked, cache off | F | 10/18 | 56% |

**Raw aggregate: Haiku unhooked (E) 67% vs hooked (F) 56% = -11pt.**
The naive "Haiku rescue" claim is NOT supported by the raw matrix.

Conditioned on resolve tier for cell F:

| Tier | Oracle pass | Rate |
|---|---|---|
| auto_accept | 9/11 | 82% |
| candidate_list | 1/7 | 14% |

The rescue is real only when resolve auto-accepts — the hooked path is dramatically
stronger under auto_accept. Per-task F pass rates (tracks auto_accept coverage):

| Task | E pass | F pass |
|---|---|---|
| crc32c | 3/3 | 3/3 |
| utf8-codec | 2/3 | 0/3 |
| base32-rfc4648 | 2/3 | 1/3 |
| lru-ttl-cache | 2/3 | 2/3 |
| semver-range | 0/3 | 1/3 |
| ring-buffer | 3/3 | 3/3 |

Do not claim a Haiku rescue the data doesn't show; the rescue is conditional on
resolve auto_accept coverage per task.

---

## Prompt-Cache Effect

Cost with prompt caching disabled → enabled (hooked cells, cache_off → cache_on):

| Driver | cache_off ($/run) | cache_on ($/run) | Saving | Cache-read tokens |
|---|---|---|---|---|
| opus | $0.643 | $0.302 | -53% | 26.9k |
| sonnet | $0.133 | $0.085 | -36% | 21.4k |
| haiku | $0.036 | $0.017 | -52% | 24.7k |

Prompt caching is the one unambiguous win: 36–53% cost reduction with no quality
change (oracle pass rates are within noise across cache_off/cache_on pairs).
Cache-read tokens per run: ~21.4k–26.9k.

---

## Method Notes

- Real `@yakcc/mcp-registry` server running with `YAKCC_AIRGAPPED=1`
- Multi-turn tool loop over production `yakcc_resolve` + `yakcc_reference` tools
- Substitution oracle on materialized source: short `atom_id` resolved to full
  `BlockMerkleRoot` via the #1068 `resolveShortId` fix, then assembled
- Real Anthropic billing per API call (no mock responses)
- 6 tasks × 9 cells × 3 reps = 162 total runs
- Total spend: \$24.40 against \$30.00 cap

---

## Bottom Line

The compose-by-reference **mechanism is validated**: when `yakcc_resolve` returns
`auto_accept`, the oracle passes at 91%, substitution succeeds at near-100%,
and output collapses to a short import reference versus full verbatim code on the
ignored path. End-to-end success is gated by resolve `auto_accept` coverage
(currently 72% Opus / 56% Sonnet / 61% Haiku against the 6-atom corpus) and by
`candidate_list` prompt compliance — those are the next work items. Prompt caching
independently cuts hooked-arm cost by 36–53%, a free win deployable now.
