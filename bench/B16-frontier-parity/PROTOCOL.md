# B16 — Frontier parity: does a cheap model with a code library match an expensive model writing it?

Status: protocol of record, written before any live run. Changing the tasks, the arms, the
hypotheses or the decision rules after phase 2 starts requires recording the change and its
reason here.

## 1. The claim

> For a capability a library already implements, a cheap model that finds and reuses the
> implementation produces correct code as often as the best model writing it from scratch,
> for a small fraction of the cost of the cheapest model that can write it correctly.

The example is MD5. In B14's threshold sweep, Haiku wrote MD5 from scratch and got a wrong
digest. A larger model probably writes a correct MD5, at many times the price. The library
already holds a correct MD5. The value of yakcc is the gap between:

- Haiku finding that MD5 and calling it;
- the cheapest model that writes a correct MD5 in one go.

That gap must hold across many problems of the same shape, not one.

## 2. Why the earlier benchmarks could not show it

B4-tokens v3–v5 tested the same hypothesis ("a cheaper model will achieve the same quality on a
complex task that would have otherwise required an expensive model"). What they found, and
what B16 changes:

| Finding | B4 v3–v5 | B16 |
|---|---|---|
| Tasks too easy | v3: Haiku from scratch passed 4 of 5 tasks, so there was no quality gap to close | 34 tasks chosen where the hard part is knowledge or precision: hashes, check-digit standards, semver grammar, RFC formats. Difficulty is measured, not assumed (§5) |
| Circular corpus | v5's registry was built from the tasks' own reference implementations, with `behavior` text matching the query | The library is the vendored corpus of 20 real npm packages (528 modules), indexed before the tasks were written. No module was written or edited for a task |
| Context stuffing | Hooked runs used 35–40k input tokens per attempt (whole registry envelopes) | The routed arm sends a short need, sees 5 one-line candidates, and reads one root definition: about 1–3k input tokens |
| Low-confidence candidates ignored | v5: 14% pass when resolve returned a candidate list | The model confirms one candidate or none (B13: right 95% of the time when shown) |
| Spend undercounted | v4 counted only the last turn's tokens | Every call's usage is summed (B14 harness) |
| One scoring check | Oracle tests per task | Held-out cases: published vectors (RFCs, FIPS, ISO examples), hand-picked edge cases and seeded fuzz inputs, with expected values computed by the reference and checked against the vectors at build time |

## 3. Arms

Every arm gets the same task text. Scratch arms make one call. All arms run at effort `high`;
`S-haiku-max` tests whether more thinking alone rescues Haiku.

| Arm | Model | Strategy | Phase |
|---|---|---|---|
| `S-haiku` | Haiku 5.5 | scratch | 1 |
| `S-haiku-max` | Haiku 5.5 (effort max) | scratch | 1 |
| `R-haiku` | Haiku 5.5 | routed reuse (B14, 15-line threshold): write at once if small, else search, confirm, glue | 1 |
| `A-haiku` | Haiku 5.5 | search reuse (B14's reuse arm): always search first, confirm, glue (added after phase 1) | 1b |
| `O-haiku` | Haiku 5.5 | oracle reuse: the target module is handed over, glue only | 1 |
| `S-sonnet` | Sonnet 5.5 | scratch | 2 |
| `S-opus` | Opus 5.5 | scratch | 2 |
| `S-fable` | Fable 5.2 | scratch | 2 |

`O-haiku` is the reuse path's upper bound. The gap between `O-haiku` and `R-haiku` is the
discovery loss (search and confirm).

**`A-haiku`, added after phase 1.** Phase 1 showed where `R-haiku` loses. When it searched (59
of 136 attempts), the target was among the 5 shown 56 times and picked 50 times. Every hard task
it failed, it had routed to write: `canonical-emails`, `coerce-version` and `domain-name-valid`,
4 attempts each, all failed. Their specs are short, so they read as small. Searched offline with
needs worded as Haiku words them, all three targets and the three added tasks' targets are found:
11 of 12 queries first, the twelfth second. So the routed arm's loss on these is its routing rule,
not discovery. `A-haiku` always searches, to measure that loss. `R-haiku` stays the arm the
preregistered hypotheses test; `A-haiku` is secondary (§6).

## 4. Tasks

42 tasks in 5 families (34 in phase 1, see below):

| Family | Tasks | Examples |
|---|---|---|
| Versioning | 12 | npm range matching, containment, overlap, lowest version, bump, diff, sort |
| Validation | 16 | IBAN, ISBN, IPv6, payment cards, ISIN, EAN, ISSN, MAC, lat/long, FQDN, URLs, e-mail, container numbers, German tax IDs, Czech birth numbers, Bulgarian EGNs |
| Hashing and encodings | 6 | MD5, SHA-1, UUID v3, v5 and v1 to v6, base64 |
| Data and algorithms | 6 | deep copy, path updates, JSON Pointer, edit distance, closest match, topological sort |
| Dates | 2 | ISO 8601 parsing (week and ordinal dates), ISO formatting |

**Added after phase 1 (3 tasks, 37 in all).** Phase 1 found 7 hard tasks, too few for H1 and
H5, and 5 of them semver range algebra, one family. Three of the 7 were hard partly because
their spec left out a rule the module follows (the audit below), so the hard set may shrink
once fixed. The added tasks are hard by their standard, not by a module's choice, with inputs
kept to where module and standard agree (each task's expected values were also checked against
an independent implementation of its standard):

| Task | Family | Standard | Its hard part |
|---|---|---|---|
| `container-number-valid` | Validation | ISO 6346 | letter values skipping multiples of 11, weights 2^i, mod 11 |
| `german-tax-id-valid` | Validation | the Steuer-IdNr rules, ISO 7064 MOD 11,10 | the digit-repetition rule (one digit twice or three times, never three adjacent) |
| `uuid-v1-to-v6` | Hashing and encodings | RFC 9562 | the v6 field order |

Their tiers are not known until Haiku's scratch arms run on them (about $0.15): they join phase 1
before phase 2. (ISO 4217 currency codes were considered and left out: the module's list is a
snapshot that no date of the standard matches, `SLL` current and `ZWG` absent. BIC (ISO 9362)
was added and then dropped: `isBIC`'s code is under the index's 150-node floor, since its
country list is data, so the routed arm could never find it and the oracle arm would get no
module. It is left out for bcrypt's reason, §8.)

**Screened after phase 1b (6 tasks promoted, 42 in all).** Phase 1b showed the hard set was
5 tasks, 4 of one family. Candidates were then screened, each run under $2: Haiku from scratch
(`S-haiku`) and with the module handed over (`O-haiku`), 5 seeds each (`results/screen-1` to
`screen-5`, $0.84 in all). A candidate joins the set only when it is hard from scratch
(pass@1 < 0.6) and `O-haiku` passes it, so its spec is not the cause. Where a module departs
from its standard, the spec states the module's choice, or the inputs avoid the departure.
Every validation candidate's expected values were also checked against an independent
implementation of its standard.

- **Specs that restate the algorithm make tasks easy.** With every table and rule spelled out,
  Haiku from scratch passed all four national-ID candidates 5 of 5. The test is then of
  transcription, not of the knowledge a developer's need leaves to the model. So candidates
  were also screened with *brief* specs, as a developer states a need: the standard named, and
  only the module's choices where it departs from the standard or the standard leaves one open.
  This is the rule of §4 read strictly. The semver tasks were already written this way ("npm
  range semantics").
- **Promoted** (S-haiku pass@1, O-haiku pass@1):
  - `normalize-range` (semver `validRange`): 0.0, 1.0;
  - `below-range` (`ltr`): 0.0, 1.0;
  - `lowest-satisfying` (`minSatisfying`): 0.2, 1.0;
  - `czech-birth-number-valid-brief` (rodné číslo): 0.0, 1.0;
  - `german-tax-id-valid-brief`: 0.0, 1.0. It replaces `german-tax-id-valid`, whose full spec
    Haiku passed 5 of 5; that task is dropped;
  - `bulgarian-egn-valid` (EGN, brief): 0.0, 1.0.
- **Screened and left out as easy** (S-haiku 4 or 5 of 5), with full or brief specs:
  - codice fiscale, Finnish HETU, Romanian CNP, Polish NIP and PESEL, Estonian isikukood,
    Hungarian tax number, Danish CPR;
  - lodash's path syntax;
  - brief variants of the ISO 6346 container number, semver `inc`, `diff`, `coerce` and `sort`,
    and UUID v1 to v6.
- **Left out for a module quirk.** ISO timestamps (brief) failed from scratch only on
  `2007-W53-2`, a week that does not exist (2007 has 52 ISO weeks) but that date-fns accepts.
  With the choice stated, Haiku passed 5 of 5.
- **Left out unscreened:**
  - `isISO8601`'s strict mode, `isEmail` and `isMailtoURI`: chains of the module's own
    conventions, which a spec could only transcribe;
  - `isDate`: it throws on ordinary inputs;
  - Swedish personnummer: its check depends on today's date;
  - lodash `merge`: not a findable root.
- **The hard set is now 11 tasks:** 8 versioning (semver) and 3 validation (national IDs).
  Data, dates and hashing have none in this corpus.

The 13 B14 tasks keep their hand-checked cases. The 21 new tasks are in `tasks-new.mjs`. Each
task's held-out cases come from three places:

- **Published vectors** (`vectors`), checked against the reference at build time, so a buggy
  reference cannot become the answer.
- **Hand-picked edge inputs.**
- **Seeded fuzz inputs.**

Their expected values come from the reference: the corpus module plus a short reference
glue. Every boolean task has at least 4 true and 4 false cases.

**Specs.** Each spec states the behavior from the standard, and states the module's choices
where the standard leaves one open. No spec is derived from the module's code.

**Spec audit (phase 1 gate).** A task where `O-haiku` fails is a spec or glue problem, not a
model one, because the module is known to be right. Such a task is fixed or dropped before
phase 2. Fixes are recorded here.

Phase 1's audit (run `phase1-haiku`), with each failure's cause checked against the module:

| Task | `O-haiku` | Cause | Fix |
|---|---|---|---|
| `canonical-emails` | 0.25 | The spec said to remove dots; validator's `normalizeEmail` removes single dots and keeps a run of two or more (`aB..ba` → `ab..ba`) | Spec states it (B16's own spec; B14's is left as run) |
| `coerce-version` | 0.5 | semver's `coerce` gives null when a number has a leading zero (`2024.06.30-hotfix`, `v007`), not a later run | Spec states it |
| `domain-name-valid` | 0.75 | The spec allowed international letters only in the TLD; `isFQDN` allows them in every label (`bücher.de` is true) | Spec states it |
| `ean-valid` | 0.75 | Spec and module agree (`12345678901231` is a valid GTIN-14). The failing attempt assumed `isEAN` rejects 14 digits and dropped one | None: a model error, the task stays |

## 5. Measures

- **pass@1:** the share of attempts that pass every held-out case (N = 5 seeds per task and
  arm). The case share (the fraction of cases passed) is reported alongside.
- **Cost:** dollars per attempt from the reported usage (thinking included) at list prices.
  Dollars per correct solution = total dollars ÷ passing attempts.
- **Tier:** a task's difficulty is Haiku's from-scratch pass@1:
  - hard: below 0.6;
  - medium: 0.6 to below 1;
  - easy: 1.
- **One-shot model:** the cheapest scratch arm with pass@1 ≥ 0.8 on the task, or none.
- **Unit of analysis:** the task. Seeds are averaged within a task. Intervals are 95%
  bootstraps over tasks (10,000 resamples, seeded).

## 6. Hypotheses and decision rules (preregistered)

| | Hypothesis | Holds when |
|---|---|---|
| H1 parity | On hard tasks, `R-haiku` passes as often as the best scratch arm | mean(pass@1 R-haiku − best scratch) ≥ −0.05 and the interval's lower end > −0.10 |
| H2 cost | Where Haiku cannot write it but a larger model can, and `R-haiku` can, `R-haiku` costs a fraction | the geometric mean of (dollars per correct, R-haiku ÷ one-shot model) ≤ 0.2 and the interval's upper end ≤ 0.33 |
| H3 no harm | On easy tasks, routing does not hurt | mean pass@1 difference vs `S-haiku` ≥ −0.05 and the dollars-per-correct ratio (geometric) ≤ 1.5 |
| H4 generality | H1 and H5 hold in direction in every family with at least 4 tasks | per family |
| H5 lift | On hard tasks, `R-haiku` beats `S-haiku` | mean lift ≥ 0.30 and the interval's lower end > 0.15 |

The analysis also reports these:
- **Tasks solved only by reuse:** no scratch arm reaches 0.8, but `R-haiku` does.
- **The discovery loss:** pass@1 of `O-haiku` minus that of `R-haiku`.
- **The routing loss** (secondary, added after phase 1): pass@1 of `A-haiku` minus that of
  `R-haiku`, on the hard tasks and on all. Also H1's rule for `A-haiku` in place of `R-haiku`
  (`H1_searchArm`). It is reported, not used to decide H1: picking whichever reuse arm did better
  after the fact would overstate it.

A hypothesis that fails is reported as failed.

## 7. Phases and budget

| Phase | What | Estimated cost | Cap |
|---|---|---|---|
| 0 | Build cases (vectors checked), offline validation, dry run | $0 | |
| 1 | Haiku arms × 34 tasks × 5 seeds; spec audit | about $2 | $3 |
| 1b | `A-haiku` on all 37 tasks; the other Haiku arms on the 3 added and the 3 re-specced ones (305 attempts; phase 1 spent $3.08 on 610) | about $1.50 | $2, needs the go-ahead |
| 2 | Sonnet, Opus and Fable scratch × 37 × 5 | about $119 (Fable about $76) | needs the go-ahead |

The estimates assume generous output lengths (thinking included). The runner tracks actual
spend and stops at the cap. Rows are written as they finish, so a stopped run resumes.

## 8. Threats to validity

- **Task selection.** Tasks were chosen where the library has a module. The claim is
  conditional on coverage. B13 measured how often documented APIs resolve to a corpus root
  (81 did not), and #1309 tracks naming large roots so more of them are findable. bcrypt is
  left out because its hash function is not a findable root yet (it is assigned to an
  exported object, the #1309 case).
- **Reference semantics.** Where a module makes a choice the standard leaves open (validator's
  e-mail and URL defaults), the spec states it. Scratch is not graded against an unstated
  convention, and the spec audit (§4) catches the rest.
- **Contamination.** Larger models may have memorized MD5 or SHA-1. That is realistic: it is
  what writing from scratch costs and delivers today.
- **One language, one corpus, single calls.** JavaScript only, 20 packages, no agent loop
  with tests or retries. A scratch arm with self-testing and retries would cost more per
  correct solution, and would need its own arm.
- **Noise.** Five seeds per cell. Pass@1 per task is coarse. The conclusions rest on
  task-level means and their intervals, not on single tasks.
