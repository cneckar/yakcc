# Registry Coverage — B4-Tokens Slice 2 Tasks

Generated: 2026-05-13 | WI: WI-B4-MCP-ATOM-LOOKUP | Registry atoms: 21

Reshuffled: 2026-05-16 | WI: WI-607 | Classification: shave-first per DEC-BENCH-COVERAGE-SHAVE-FIRST-001

## Methodology change

Coverage gaps are now classified shave-first. The 2026-05-13 scan flagged 5 GAPs and 3 PARTIALs as "NEEDS_FILING" seed-writing tasks (issues #465, #467, #468, #469). After review (issue #607), all 8 are reclassified as shave-queue: an existing npm package would yield the needed atom when shaved, matching the WI-510 cascade pattern (lodash, date-fns, uuid, nanoid, jsonwebtoken, bcryptjs already shaved). Seed-writing is reserved for true L0 primitives (parsing building blocks; current 26 seeds in `packages/seeds/src/blocks/`) where no real-package equivalent exists. Per `DEC-BENCH-COVERAGE-SHAVE-FIRST-001` (see `docs/adr/benchmark-suite-methodology.md`).

## Coverage Matrix

| Task | Slice | Classification | Shave Candidate | Notes |
|------|-------|----------------|-----------------|-------|
| lru-cache-with-ttl | existing | shave-queue | `lru-cache`, `quick-lru` | |
| csv-parser-quoted | existing | shave-queue | `csv-parse`, `papaparse` | was PARTIAL — reclassified shave-queue |
| debounce-with-cancel | existing | shave-queue (likely already covered) | lodash shave (#598) — note as superseded | verify by re-scan in a follow-up |
| levenshtein-with-memo | new (#459) | shave-queue | `js-levenshtein`, `fastest-levenshtein` | |
| topological-sort-kahns | new (#459) | shave-queue | `toposort`, `dependency-graph` | |
| json-pointer-resolve | new (#459) | shave-queue | `jsonpointer`, `json-pointer` | |
| base64-encode-rfc4648 | new (#459) | shave-queue | `base64-js`, `js-base64`; OR Node built-in `Buffer.from(...).toString('base64')` | note the built-in option |
| semver-range-satisfies | new (#459) | shave-queue | `semver` (the official npm) | |

**Summary:** 8 total tasks: 0 L0-seed-gap / 8 shave-queue / 0 shave-on-miss-eligible (zero hand-written seeds needed — all gaps fillable via npm shave)

## Status Definitions

- **FULL** — at least one atom with confidence >= 0.70
- **PARTIAL** — top candidate confidence 0.50–0.69; semantically related atoms exist
- **L0-seed-gap** — true parsing primitive missing from `packages/seeds/`; needed for bootstrap composition; rare (should be <5/scan). No real-package equivalent (or none with reasonable license/dep weight). Action: file a narrow seed-writing issue.
- **shave-queue** — package-shaped gap. Named npm package(s) exist and would yield the needed atom(s) when shaved. Action: feed the WI-510-style shave-corpus expansion target list; NO seed-writing issue.
- **shave-on-miss-eligible** — will fill automatically via WI-508 Slice 2 import-intercept hook when a real consumer hits it. Action: none (passive).

## Embedding Provider Note

The current registry uses `yakcc/offline-blake3-stub`. This provider:
- Produces deterministic vectors from BLAKE3 hashes of atom text
- Has low discrimination — all pairwise distances cluster near 0.3–0.35
- Is intentional for offline/CI use (no external API calls)

Note: All confidence scores from the 2026-05-13 scan were produced by the **offline/blake3-stub embedding provider**, which generates deterministic low-discrimination vectors. Confidence < 0.4 for all tasks is expected until the registry is rebuilt with a real embedding model (e.g. `all-MiniLM-L6-v2`). The shave-first reclassification is independent of confidence scores — it reflects the categorical observation that named npm packages address every gap.

## Task-by-Task Coverage Details

### lru-cache-with-ttl — shave-queue
**Query intent:** cache key-value pairs with TTL expiration and LRU eviction, O(1) get/set via doubly-linked-list and hash map

**Shave candidate:** `lru-cache` (Isaac Schlueter, 30M+ weekly downloads), `quick-lru`

Both packages implement the LRU + TTL pattern as real-world npm dependencies. Shaving either yields the doubly-linked-list node and TTL eviction atoms without hand-writing L0 seeds.

---

### csv-parser-quoted — shave-queue
**Query intent:** parse CSV data with quoted fields per RFC 4180, handle embedded newlines and escaped quotes

**Shave candidate:** `csv-parse`, `papaparse` (subset)

Was previously classified PARTIAL due to structural proximity of comma/bracket/peek-char atoms. Reclassified shave-queue: `csv-parse` and `papaparse` are real-world packages that directly implement RFC 4180 quoted-field parsing; shaving yields atoms that are semantically correct, not just structurally adjacent.

---

### debounce-with-cancel — shave-queue (likely already covered)
**Query intent:** debounce a function call with delayed execution, cancel pending timer with clearTimeout, flush immediately

**Shave candidate:** covered by lodash shave (#598) — note as superseded; verify by re-scan in a follow-up

The lodash shave shipped in #598 likely already produced the timer-handle closure pattern as a real shaved atom. A re-scan post-#598 should confirm FULL coverage before filing any follow-up.

---

### levenshtein-with-memo — shave-queue
**Query intent:** compute minimum edit distance between two strings using dynamic programming memoization

**Shave candidate:** `js-levenshtein`, `fastest-levenshtein`

Both packages implement the memoized edit-distance pattern. Shaving yields a memoize+matrix-iteration atom without requiring a hand-written L0 seed.

---

### topological-sort-kahns — shave-queue
**Query intent:** topological sort of a directed acyclic graph using Kahn's algorithm with in-degree queue

**Shave candidate:** `toposort`, `dependency-graph`

Both packages implement graph traversal and queue-drain patterns that map to Kahn's algorithm. Shaving yields queue-drain and in-degree-map atoms from production-quality implementations.

---

### json-pointer-resolve — shave-queue
**Query intent:** resolve JSON pointer per RFC 6901 navigating nested objects and arrays with escape sequences ~0 / ~1

**Shave candidate:** `jsonpointer`, `json-pointer`

Both packages implement RFC 6901 token-splitting and ~0/~1 escape decoding. Shaving yields the json-pointer-token-splitter atom directly from the canonical implementation.

---

### base64-encode-rfc4648 — shave-queue
**Query intent:** base64 encode binary data using RFC 4648 alphabet with padding character `=`

**Shave candidate:** `base64-js`, `js-base64`; OR Node built-in `Buffer.from(...).toString('base64')`

The base64-alphabet and 3-byte grouping pattern is available both via npm packages and via Node's built-in Buffer API. The built-in option means this gap may be resolvable without a shave at all — the atom can reference the runtime-provided primitive.

---

### semver-range-satisfies — shave-queue
**Query intent:** parse semantic version and check if it satisfies a range constraint following semver specification

**Shave candidate:** `semver` (the official npm)

The `semver` package is the npm-canonical semver implementation (maintained by npm/GitHub). Shaving it yields the version-triple parser and range-operator grammar atoms directly from the reference implementation.

---

## Machine-Readable Data

Full structured coverage data (confidence scores, candidate signatures, action items):
`bench/B4-tokens/results/registry-coverage-2026-05-13.json`
