# WI-579-S6 — Closer: E2E + Corpus 50 + ADR + Bench Scaffold

**Workflow:** wi-594-s6-closer
**Goal:** g-594-s6-closer
**Closes:** GH #579 (all 6 layers shipped + Layer 6 eval gate at 50 rows green)
**Parent plan:** plans/wi-579-hook-enforcement-architecture.md
**Status:** implementer pass complete — awaiting reviewer
**Authority domain:** hook-enforcement-closer

---

## 1. Slice Scope

S6 is the closer slice of the six-slice #579 enforcement architecture. It adds
no new enforcement logic (S1-S5 shipped all five mechanical layers). S6's work
is purely orchestration:

1. **Corpus expansion** — extend `enforcement-eval-corpus.json` from 23 rows
   (S1-S5 seeds) to 50 rows (10 per layer × 5 layers).
2. **E2E test** — write `enforcement-e2e.test.ts` exercising all 5 layers in a
   single realistic multi-event session.
3. **ADR** — write `docs/adr/hook-enforcement-architecture.md` documenting the
   full 6-layer architecture with all DEC-HOOK-ENF-* ID cross-references.
4. **Bench scaffold** — create placeholder JSON files for B1/B4/B5/B9/B10
   baselines; actual bench runs are deferred (heavy compute).
5. **This plan** — `plans/wi-579-s6-closer.md`.

---

## 2. Authority Invariants

- **S1-S5 layer source files are untouched.** S6 owns corpus, tests, docs, and
  bench scaffolding only.
- **Corpus harness unchanged.** Only rows are added to `enforcement-eval-corpus.json`;
  the harness in `enforcement-eval-corpus.test.ts` is extended with new row
  assertions and updated invariants (≥50 rows, 10 per layer).
- **ADR documents as-built architecture.** It does not prescribe new design or
  introduce new decision IDs beyond `DEC-HOOK-ENF-ARCHITECTURE-001` (the ADR
  container decision) and `DEC-HOOK-ENF-E2E-001` (the e2e test decision).
- **Bench baselines are explicitly `status: "placeholder"`.** No bench run is
  executed in this slice. Actual numbers are a follow-up WI.

---

## 3. Corpus Distribution

Target distribution for the 50-row corpus:

| Layer | Module | S1-S5 Seed | S6 Additions | Total |
|---|---|---|---|---|
| L1 | intent-specificity | 7 | 3 | 10 |
| L2 | result-set-size | 5 | 5 | 10 |
| L3 | atom-size-ratio | 5 | 5 | 10 |
| L4 | descent-tracker | 3 | 7 | 10 |
| L5 | drift-detector | 3 | 7 | 10 |
| **Total** | | **23** | **27** | **50** |

New rows cover edge cases not in the S1-S5 seeds:
- L1: triple-rejection (meta+stop+too_short), high-quality parse/encode examples
- L2: empty result set, single-match ideal case, all-weak 11-total over maxOverall
- L3: moderate atoms at various ratios, below-minFloor boundary, very large atoms
- L4: one-miss (depth=1), over-threshold (depth=5), elevated minDepth=3 scenarios
- L5: result_set_median and ratio_median dimensions, boundary-exact bypass rate,
  disableDetection bypass, dual-dimension alert, all-healthy accept

---

## 4. ADR Decision IDs

The ADR (`docs/adr/hook-enforcement-architecture.md`) cross-references all
DEC-HOOK-ENF-* IDs from S1-S5:

**Config authority:**
- DEC-HOOK-ENF-CONFIG-001

**Layer 1:**
- DEC-HOOK-ENF-LAYER1-INTENT-SPECIFICITY-001
- DEC-HOOK-ENF-LAYER1-SINGLE-WORD-001
- DEC-HOOK-ENF-LAYER1-MIN-WORDS-001
- DEC-HOOK-ENF-LAYER1-MAX-WORDS-001
- DEC-HOOK-ENF-LAYER1-STOP-WORDS-001
- DEC-HOOK-ENF-LAYER1-META-WORDS-001
- DEC-HOOK-ENF-LAYER1-ACTION-VERBS-001
- DEC-HOOK-ENF-LAYER1-PREDICATE-PREFIX-001
- DEC-HOOK-ENF-LAYER1-IO-HINT-001
- DEC-HOOK-ENF-LAYER1-ESCAPE-HATCH-001
- DEC-HOOK-ENF-LAYER1-CONSTANTS-RETROFIT-001
- DEC-HOOK-ENF-LAYER1-TELEMETRY-001

**Layer 2:**
- DEC-HOOK-ENF-LAYER2-RESULT-SET-SIZE-001
- DEC-HOOK-ENF-LAYER2-SCORE-FORMULA-001
- DEC-HOOK-ENF-LAYER2-TELEMETRY-001

**Layer 3:**
- DEC-HOOK-ENF-LAYER3-ATOM-SIZE-RATIO-001
- DEC-HOOK-ENF-LAYER3-RATIO-THRESHOLD-001
- DEC-HOOK-ENF-LAYER3-MIN-FLOOR-001
- DEC-HOOK-ENF-LAYER3-TELEMETRY-001

**Layer 4:**
- DEC-HOOK-ENF-LAYER4-DESCENT-TRACKING-001
- DEC-HOOK-ENF-LAYER4-MIN-DEPTH-001
- DEC-HOOK-ENF-LAYER4-SHALLOW-ALLOW-001
- DEC-HOOK-ENF-LAYER4-TELEMETRY-001

**Layer 5:**
- DEC-HOOK-ENF-LAYER5-DRIFT-DETECTION-001
- DEC-HOOK-ENF-LAYER5-WINDOW-001
- DEC-HOOK-ENF-LAYER5-SPECIFICITY-FLOOR-001
- DEC-HOOK-ENF-LAYER5-DESCENT-MAX-001
- DEC-HOOK-ENF-LAYER5-RESULT-MAX-001
- DEC-HOOK-ENF-LAYER5-RATIO-MAX-001
- DEC-HOOK-ENF-LAYER5-TELEMETRY-001

**Layer 6:**
- DEC-HOOK-ENF-LAYER6-EVAL-CORPUS-001

**S6 new decisions:**
- DEC-HOOK-ENF-ARCHITECTURE-001 (ADR container)
- DEC-HOOK-ENF-E2E-001 (e2e test design)

---

## 5. Deferred Work

The following are explicitly out of scope for S6 and require follow-up WIs:

1. **Full bench runs** — B1/B4/B5/B9/B10 post-#579 baselines. Bench suites are
   heavy compute; placeholder JSONs are created but not filled. A dedicated
   bench-run WI should be filed.
2. **Threshold calibration** — Layer 4 minDepth=2 is pending calibration on real
   B4/B9 sweep data (DEC-HOOK-ENF-LAYER4-MIN-DEPTH-001). Layer 5 thresholds are
   also calibration-pending.
3. **Registry integration wiring** — The enforcement layers are implemented but
   not yet wired into `executeRegistryQueryWithSubstitution` in `index.ts`. S6
   does not wire them; the wiring plan is tracked separately.

---

## 6. Acceptance Criteria

- `enforcement-eval-corpus.json` has exactly 50 rows (10 per layer × 5 layers)
- Corpus structural invariants updated in `enforcement-eval-corpus.test.ts`
- `enforcement-e2e.test.ts` exercises all 5 layers in a single flow
- `docs/adr/hook-enforcement-architecture.md` created with all 32 DEC-HOOK-ENF-*
  IDs listed and cross-referenced
- 5 bench placeholder JSON files created (B1/B4/B5/B9/B10), each with `status: "placeholder"`
- This plan file present
- All S1-S5 tests pass (no regression)
- `pnpm -w lint` and `pnpm -w typecheck` clean
