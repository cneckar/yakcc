# Discovery Benchmark Corpus

**WI-V3-DISCOVERY-D5-CORPUS-SEED** (issue #269)
**DEC-V3-DISCOVERY-D5-001** — per-category corpus schema

---

## Purpose

This corpus is the input to the DEC-V3-INITIATIVE-001 measurement-first gate.
It determines whether D1's multi-dimensional embedding schema (5× storage cost vs
single-vector) is empirically justified by retrieval quality differences across
query categories.

The key question: does single-vector retrieval hit rate differ between queries that
mention **only behavior** (category 1) and queries that stress **multiple aspects**
(category 5)? If yes, multi-dimensional embeddings have measurable value. If no,
single-vector is sufficient and D1 should not proceed.

---

## Stored Side

The stored side is the **full yakcc self-shave registry** — every atom that
`yakcc bootstrap` produces against the current source tree.

- **Source:** `bootstrap/yakcc.registry.sqlite` (auto-built; gitignored)
- **Size:** ~1,773+ atoms at time of authoring
- **Determinism anchor:** `bootstrap/expected-roots.json` (committed; content-addressed)

The harness re-uses the existing bootstrap SQLite if present. If absent, the full-corpus
test is skipped (it requires a local bootstrap run, unlike the inline 9-entry harness
which uses `:memory:`).

---

## Query Side: 5-Category Stratification

The 5 categories are the experimental design for D1's value proposition.
D1 only adds value if queries actually stress different embedding dimensions.

| Category | Count | Description | D1 value-prop |
|---|---|---|---|
| **behavior-only** | 10 | Queries mentioning only what the function does | Baseline — single-vector should handle this well |
| **guarantees-stressed** | 10 | Queries mentioning or implying guarantees (purity, monotonicity, totality) | D1's `embedding_guarantees` dimension |
| **error-condition-stressed** | 10 | Queries mentioning or implying error handling (throws, rejects, validates) | D1's `embedding_error_conditions` dimension |
| **non-functional-stressed** | 10 | Queries mentioning O(n), purity, thread-safety, determinism | D1's `embedding_non_functional` dimension |
| **multi-aspect** | 10 | Queries combining 2+ above aspects | D1's strongest expected differentiator |

---

## Entry Shape

Each entry in `corpus.json` is a `BenchmarkEntry`-compatible object extended with:

- **`category`**: one of the 5 category keys
- **`expectedAtomName`** (optional): seed atom name, resolved at test time to a
  `BlockMerkleRoot` by reading the actual seed block files and calling `blockMerkleRoot()`
- **`expectedAtom`**: always `null` in the committed file; filled in at test runtime
  for entries with `expectedAtomName`

`expectedAtom` is never hardcoded as a hash — the root is computed from the actual
spec+impl+proof files so it stays correct even if implementation details change.

---

## Corpus Authoring Methodology

### Source (a): Reverse-engineered from seed atoms (~30 positive entries)

For each of 8 target seed atoms (ascii-char, digit, integer, comma, bracket,
eof-check, peek-char, whitespace), 3–4 queries were authored across categories
that best exercise each category's distinctive dimension. Additional atoms
(position-step, ascii-digit-set, char-code, empty-list-content, list-of-ints,
non-ascii-rejector, signed-integer, string-from-position) contribute 1 query each
in the category that best matches their spec's properties.

### Source (b): Synthetic realistic tasks (~20 negative-space entries)

Two per-category entries deliberately target functions **not** in the seed registry
(haversine distance, UUID generation, hash functions, sorting, base64 encoding,
factorial, CSV parsing, JSON parsing, integer division, clamping).

These exercise the no-match path and populate M5's poor band for calibration.

---

## Per-Category Decision Logic

Run the full-corpus harness (`pnpm --filter @yakcc/registry test` with
`DISCOVERY_EVAL_PROVIDER=local`) to produce per-category numbers.

**Interpretation:**

| Outcome | Actionable decision |
|---|---|
| Single-vector M1 ≥ 80% on ALL 5 categories | Pause v3 IMPL — multi-dim is not empirically justified |
| Single-vector M1 ≥ 80% on category 1 but < 80% on category 5 | Proceed v3 IMPL — multi-dim has measurable value |
| Mixed results (M1 passes some categories, fails others) | Partial multi-dim — consider embedding only the failing dimensions |

---

## Corpus Integrity

- Entries are monotonic: add never delete. Retired entries move to `retired/` with rationale.
- Corpus hash is recorded in each baseline JSON artifact for reproducibility.
- `expectedAtomName` values reference seed block directory names in
  `packages/seeds/src/blocks/`. If a seed block is renamed, update the corpus.

---

## Files

- `corpus.json` — this file; the committed stratified corpus
- `pending.json` — gap log (committed; tracks no-match results needing new atoms)
  (created after the first full-corpus harness run)
