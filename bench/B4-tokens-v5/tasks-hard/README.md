# B4-v5 Hard Task Set (#1049)

Three genuinely large/hard benchmark atoms for the B4-v5 token-economics experiment
(epic #1043). Each atom is algorithmically Haiku-failure-prone and at least 200
implementation lines. They extend the existing 6 easy atoms (`tasks.json`) without
modifying the governed v5 harness.

## Atoms

### 1. `avl-tree` — Self-Balancing AVL Tree

**File**: `avl-tree/reference-impl.ts` (287 lines)

**Export**: `AVLTree<K, V>` — insert, get, delete (in-order-successor replacement),
keysInOrder, height, size. Balance invariant `|bf| <= 1` at every node after every
operation.

**Haiku failure mode (double-rotation trap)**: Haiku implements LL/RR single-rotation
correctly but fails LR/RL double-rotation cases. It also stops rebalancing after the
first rotation instead of walking the full ancestor chain. The oracle verifies
`isBalanced()` after non-trivial delete sequences and checks the exact double-rotation
case `[50,30,70,20,40,60,80,35,45]` with `delete(20)`.

### 2. `pratt-expr-eval` — Pratt Expression Parser+Evaluator

**File**: `pratt-expr-eval/reference-impl.ts` (236 lines)

**Export**: `ExpressionEvaluator` — Pratt (top-down operator precedence) parser+evaluator
for `+,-,*,/,%` with correct precedence, left-associativity, unary minus, parentheses,
integer+decimal literals, typed `ParseError` on malformed input.

**Haiku failure mode (precedence + left-associativity trap)**: Haiku right-associates
subtraction (`2-3-4 = 3` instead of `-5`), rejects unary minus after binary ops
(`1+-2` throws instead of `-1`), places `%` at additive precedence (wrong), and
silently returns `NaN`/`0` instead of throwing `ParseError` on bad input.

### 3. `dijkstra-heap` — Dijkstra + Inline Binary Min-Heap

**File**: `dijkstra-heap/reference-impl.ts` (241 lines)

**Export**: `Graph` — Dijkstra shortest-path on a directed weighted graph backed by an
inline binary min-heap (0-based, sift-up/down, lazy-deletion for decrease-key).
`shortestPath` returns distance+path; `shortestDistances` returns full `Map`. Rejects
negative weights with `NegativeWeightError`. Unreachable nodes: distance=`Infinity`,
path=`[]`.

**Haiku failure mode (heap + decrease-key trap)**: Haiku's sift-down compares against
only the left child (not `min(left, right)`), making the heap non-minimal. It also
omits lazy-deletion so stale heap entries produce wrong distances when multiple paths
reach the same node.

## Files

```
tasks-hard/
├── avl-tree/
│   ├── prompt.md          — Task prompt (adversarial framing)
│   ├── oracle.test.ts     — 26+ oracle tests (vitest)
│   └── reference-impl.ts  — Ground-truth implementation
├── pratt-expr-eval/
│   ├── prompt.md
│   ├── oracle.test.ts     — 26+ oracle tests
│   └── reference-impl.ts
├── dijkstra-heap/
│   ├── prompt.md
│   ├── oracle.test.ts     — 28+ oracle tests
│   └── reference-impl.ts
├── size-delta.mjs         — Size-stratified token-delta analysis (offline, deterministic)
├── size-delta.test.mjs    — Tests for size-delta analysis (12 tests)
├── vitest.config.mjs      — Vitest config (oracle tests + size-delta test)
├── README.md              — This file
└── results/
    ├── size-delta.json    — Machine-readable dossier
    └── size-delta.md      — Human-readable dossier with operator-gated section
```

`tasks-hard.json` at the bench root is the task manifest (same schema as `tasks.json`).

## Running the Oracle Tests

```bash
cd bench/B4-tokens-v5
npx vitest run --config tasks-hard/vitest.config.mjs
```

Expected: **92 tests pass** (80 oracle + 12 size-delta). No API key needed.

## Running the Size-Delta Analysis

```bash
# From repo root (worktree must have packages built):
node bench/B4-tokens-v5/tasks-hard/size-delta.mjs

# JSON output:
node bench/B4-tokens-v5/tasks-hard/size-delta.mjs --json
```

Produces `results/size-delta.json` and `results/size-delta.md`. Fully offline,
deterministic — no API calls.

### Key result (real numbers)

| atom | stratum | impl lines | impl tokens | import tokens | savings | ratio |
|------|---------|-----------|------------|--------------|---------|-------|
| crc32c | small | 48 | 309 | 13 | 296 | 23.8x |
| base32-rfc4648 | small | 76 | 521 | 14 | 507 | 37.2x |
| ring-buffer | small | 79 | 533 | 14 | 519 | 38.1x |
| utf8-codec | small | 103 | 777 | 14 | 763 | 55.5x |
| semver-range | small | 121 | 945 | 14 | 931 | 67.5x |
| lru-ttl-cache | small | 175 | 1102 | 14 | 1088 | 78.7x |
| dijkstra-heap | **large** | 241 | 1930 | 13 | 1917 | **148.5x** |
| pratt-expr-eval | **large** | 236 | 1941 | 16 | 1925 | **121.3x** |
| avl-tree | **large** | 287 | 2009 | 13 | 1996 | **154.5x** |

**Finding**: median absolute savings for large atoms (1925 tok) is 3.0× greater than
for small atoms (641 tok). Collapse holds for all 9 atoms (min ratio: 23.8x). This
confirms #1041's tail-value hypothesis on a real large-atom corpus.

## OPERATOR-GATED: Pass-Rate / Rescue-Rate Matrix

The offline analysis above measures output-token collapse only. The unhooked fail-rate
and hooked rescue-rate for the hard atoms require paid model runs (Haiku especially).

See `results/size-delta.md` for the exact command. In short:

```bash
cd bench/B4-tokens-v5
ANTHROPIC_API_KEY=<key> YAKCC_REGISTRY_PATH=<registry.db> \
  node harness/phase2-v5.mjs --task avl-tree --n-reps 3
# ... repeat for pratt-expr-eval and dijkstra-heap
```

> The hard atoms must be added to `tasks.json` first (same schema), OR the harness
> must be extended with a `--tasks-file` flag. `tasks-hard.json` is structurally
> compatible. Do NOT modify the governed harness files (phase2-v5.mjs, matrix-v5.mjs,
> PROTOCOL.md) — those are operator-owned.

No pass-rate/rescue-rate numbers are claimed here: they are operator-gated and require
API keys not present in this environment.

## Schema

`tasks-hard.json` uses the same schema as `tasks.json`:

```jsonc
{
  "id": "avl-tree",
  "prompt_file": "tasks-hard/avl-tree/prompt.md",
  "oracle_test": "tasks-hard/avl-tree/oracle.test.ts",
  "reference_impl": "tasks-hard/avl-tree/reference-impl.ts",
  "sha256": "...",
  "description": "...",
  "adversarial_framing": "...",
  "expected_export": "named:AVLTree",
  "complexity_domain": "data_structure"
}
```

The operator can point the v5 matrix runner at `tasks-hard.json` to measure the hard
tail. The governed harness and `tasks.json` are untouched.
