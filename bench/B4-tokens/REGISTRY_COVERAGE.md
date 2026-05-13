# Registry Coverage — B4-Tokens Slice 2 Tasks

Generated: 2026-05-13 | WI: WI-B4-MCP-ATOM-LOOKUP | Registry atoms: 21

## Coverage Matrix

| Task | Slice | Status | Top Candidate | Confidence | Gap Issue |
|------|-------|--------|---------------|------------|-----------|
| lru-cache-with-ttl | existing | GAP | positionStep | 0.32 | — |
| csv-parser-quoted | existing | PARTIAL | signedInteger | 0.30 | — |
| debounce-with-cancel | existing | PARTIAL | signedInteger | 0.29 | — (timer-handle seeded, needs rebuild) |
| levenshtein-with-memo | new (#459) | GAP | whitespace | 0.28 | NEEDS_FILING |
| topological-sort-kahns | new (#459) | GAP | emptyListContent | 0.29 | NEEDS_FILING |
| json-pointer-resolve | new (#459) | PARTIAL | positionStep | 0.33 | NEEDS_FILING |
| base64-encode-rfc4648 | new (#459) | GAP | isAsciiDigit | 0.32 | NEEDS_FILING |
| semver-range-satisfies | new (#459) | PARTIAL | nonAsciiRejector | 0.30 | NEEDS_FILING |

**Summary:** 0 FULL / 3 PARTIAL / 5 GAP (8 total tasks, 5 gap issues to file)

## Status Definitions

- **FULL** — at least one atom with confidence >= 0.70
- **PARTIAL** — top candidate confidence 0.50–0.69 (semantically related atoms exist; real embeddings may close the gap) OR: an atom was seeded but the registry has not been rebuilt
- **GAP** — no atom in the corpus addresses this algorithmic pattern; new seed atom required

Note: All confidence scores were produced by the **offline/blake3-stub embedding provider**, which generates deterministic low-discrimination vectors. Confidence < 0.4 for all tasks is expected until the registry is rebuilt with a real embedding model (e.g. `all-MiniLM-L6-v2`). PARTIAL entries reflect structural/topological proximity in the vector space, not semantic similarity.

## Embedding Provider Note

The current registry uses `yakcc/offline-blake3-stub`. This provider:
- Produces deterministic vectors from BLAKE3 hashes of atom text
- Has low discrimination — all pairwise distances cluster near 0.3–0.35
- Is intentional for offline/CI use (no external API calls)

After bootstrapping with a real embedding model, PARTIAL tasks (csv-parser, debounce, json-pointer, semver) should achieve FULL coverage. GAP tasks require new seed atoms regardless of embedding quality.

## Task-by-Task Coverage Details

### lru-cache-with-ttl — GAP
**Query intent:** cache key-value pairs with TTL expiration and LRU eviction, O(1) get/set via doubly-linked-list and hash map

No atom in the corpus models doubly-linked-list node or LRU eviction. The parsing-primitive corpus is semantically distant from cache data structures.

**Atoms needed:** `lru-node` (doubly-linked-list node with prev/next pointers), `timestamp-provider` (monotonic timestamp for TTL). Both are separate seed WIs; out of scope for WI-460.

---

### csv-parser-quoted — PARTIAL
**Query intent:** parse CSV data with quoted fields per RFC 4180, handle embedded newlines and escaped quotes

The comma, bracket, and peek-char atoms are structurally related to CSV parsing. With a real embedding model, these should surface at >= 0.5. This is a threshold gap, not a registry gap.

---

### debounce-with-cancel — PARTIAL (pending rebuild)
**Query intent:** debounce a function call with delayed execution, cancel pending timer with clearTimeout, flush immediately

The `timer-handle` atom was seeded by WI-460 (closes #454). It models the setTimeout/clearTimeout closure pattern directly. Confidence will improve after `yakcc bootstrap` rebuilds the registry with this atom.

**Action:** Run `yakcc bootstrap` to include timer-handle in query results.

---

### levenshtein-with-memo — GAP
**Query intent:** compute minimum edit distance between two strings using dynamic programming memoization

No atom models memoization or 2D matrix iteration.

**Atom needed:** `memoize` (generic function memoization pattern using a Map cache). Filing gap issue.

---

### topological-sort-kahns — GAP
**Query intent:** topological sort of a directed acyclic graph using Kahn's algorithm with in-degree queue

No atom models graph traversal, in-degree maps, or queue-drain patterns.

**Atom needed:** `queue-drain` (process items from a queue until empty, accumulating results). Filing gap issue.

---

### json-pointer-resolve — PARTIAL
**Query intent:** resolve JSON pointer per RFC 6901 navigating nested objects and arrays with escape sequences ~0 / ~1

The `positionStep` and `string-from-position` atoms provide structural navigation primitives. Missing: the JSON pointer escape-decode pattern (~0 → `~`, ~1 → `/`).

**Atom needed:** `json-pointer-token-splitter` (split RFC 6901 pointer on `/`, decode ~0/~1). Filing gap issue.

---

### base64-encode-rfc4648 — GAP
**Query intent:** base64 encode binary data using RFC 4648 alphabet with padding character `=`

The `isAsciiDigit` atom is tangentially related but does not provide the 64-char alphabet or 3-byte grouping.

**Atom needed:** `base64-alphabet` (alphabet lookup table + 3-byte to 4-char encode). Filing gap issue.

---

### semver-range-satisfies — PARTIAL
**Query intent:** parse semantic version and check if it satisfies a range constraint following semver specification

The `integer` and `digit` atoms cover `major.minor.patch` numeric parsing. Missing: dot/hyphen tokenization and range operator grammar.

**Atom needed:** `semver-component-parser` (compose integer + dot-separator into a version triple). Filing gap issue.

---

## Machine-Readable Data

Full structured coverage data (confidence scores, candidate signatures, action items):
`bench/B4-tokens/results/registry-coverage-2026-05-13.json`
