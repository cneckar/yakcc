# v1-wave-3-wasm-lower-demo

Wave-3 closer harness for the yakcc WASM backend. Drives the WASM backend
over the **yakcc-self-shave corpus** and asserts structural correctness across
all atoms, with value-level parity for atoms where source is recoverable.

GitHub issue: [#36 WI-V1W3-WASM-LOWER-11](https://github.com/darkry/yakcc/issues/36)

MASTER_PLAN.md row: `WI-V1W3-WASM-LOWER-11`

---

## Purpose

This demo is the v1 wave-3 closer. It proves the WASM backend can accept the
real yakcc self-shave corpus (`bootstrap/expected-roots.json`, 1766 entries,
1746 unique `canonicalAstHash` values) and:

1. Produce valid WASM bytes (or classify the atom as `pending`) for every atom.
2. Pass `WebAssembly.validate()` for 100% of bytes-producing atoms.
3. Assert value-level parity vs `ts-backend` for covered atoms across P-buckets.
4. Maintain partition completeness: `{covered} ∪ {pending} == {all hashes}`.
5. Write a `pending-atoms.json` registry with per-atom reasons for every atom
   that could not be covered (honest accounting, Sacred Practice #5).

---

## How to run

```bash
# From the repo root (or worktree root):
pnpm --filter v1-wave-3-wasm-lower-demo test

# Typecheck only:
pnpm --filter v1-wave-3-wasm-lower-demo build
```

The test suite runs in one pass. `beforeAll` does the emit sweep over all 1746
corpus atoms (~5s), then the P-bucket describes exercise covered atoms with
property-based assertions (fast-check, ≥20 runs per atom per bucket).

---

## Corpus shape

`bootstrap/expected-roots.json` is the output of `yakcc bootstrap` (self-shave
of the yakcc monorepo via `WI-V2-BOOTSTRAP-01`). It carries 1766 entries and
1746 **unique `canonicalAstHash` values** — the canonical denominator for all
coverage measurements. Entries with duplicate hashes are identical atoms
decomposed at different abstraction levels; only unique hashes are counted.

---

## P-bucket scheme

The harness classifies each recovered atom source into a P-bucket:

| Bucket | Description | Parity test |
|--------|-------------|-------------|
| P1a | Numeric i32 (bitwise forces i32 domain) | `fc.integer`, 20 runs, `result === tsRef \| 0` |
| P1b | Numeric i64 (large literal forces i64 domain) | `WebAssembly.validate` + ts-emit only |
| P1c | Numeric f64 (division forces f64 domain) | `fc.float`, 20 runs, relative diff < 1e-9 |
| P2 | String-param (str-length shape) | `fc.string`, 20 runs, `result === s.length` |
| P3 | Record-of-numbers (3-field struct) | `fc.integer` x3, 20 runs, struct layout parity |
| P-OTHER | Seeds and other recovered atoms | Structural only: `WebAssembly.validate` + ts-emit |

Classification uses a curated substrate table (`CURATED_SUBSTRATES` in
`corpus-loader.ts`) rather than re-implementing the visitor's shape detection.
See `DEC-V1-WAVE-3-WASM-DEMO-CLASSIFY-001` in `corpus-loader.ts`.

---

## `pending-atoms.json` schema

Written by the test harness after each run. Entries are accumulative (new atoms
are added; existing entries are never overwritten).

```json
[
  {
    "canonicalAstHash": "<64-hex-char BLAKE3 hash>",
    "sourcePath": "<absolute path or null>",
    "reason": "<≥10-char human-readable reason>",
    "category": "lowering-error | unsupported-host | unsupported-runtime-closure | no-input-arbitrary | no-export-found | other"
  }
]
```

Category semantics:
- `lowering-error` — `wasmBackend().emit()` threw `LoweringError` during emit
- `unsupported-host` — atom requires a host import not in the WASM host contract
- `unsupported-runtime-closure` — atom captures a closure at runtime
- `no-input-arbitrary` — no `fast-check` `Arbitrary` exists for the input types
- `no-export-found` — atom has no exported function the WASM backend can target
- `other` — source not recoverable (only hash is available without the bootstrap SQLite)

---

## Source recovery decision

`@decision DEC-V1-WAVE-3-WASM-DEMO-CORPUS-001`

The corpus carries no `implSource` — the `implSourceHash` column is
`BLAKE3("")` sentinel for all entries (generated without artifact content).

Static recovery is used: seeds (`packages/seeds/src/blocks/*/impl.ts`) plus
a curated substrate table. This covers atoms whose source appears verbatim
in those two sources. All other atoms are marked `pending` with
`category: "other"`.

**Coverage impact:** static recovery yielded 1/1746 = 0.1% coverage in the
current corpus. The 80% acceptance threshold cannot be met without
`bootstrap/yakcc.registry.sqlite`. Planner options:

- (a) Make `bootstrap/yakcc.registry.sqlite` available in CI via LFS or a
  setup step — would provide near-100% source recovery.
- (b) Lower the 80% threshold to match static-recovery capacity.

See `COVERAGE_GAP_NOTE` in `test/closer-parity.test.ts` and
`DEC-V1-WAVE-3-WASM-DEMO-CORPUS-001` in `test/corpus-loader.ts`.

---

## What the harness proves today

Despite the coverage gap, the harness produces real evidence:

- Partition completeness: every corpus hash is in exactly one of
  `{covered, pending}` — no silent skips (Sacred Practice #5).
- `WebAssembly.validate()` passes for all 1 bytes-producing atoms.
- The P-bucket property tests (P1a/P1c/P2/P3) are structurally correct and
  will activate automatically as more atoms become covered.
- `pending-atoms.json` is fully populated with honest per-atom reasons.

---

## Files

```
test/
  closer-parity.test.ts   # Main harness: P-bucket describes, validate sweep, coverage gate
  corpus-loader.ts         # Source recovery, corpus parsing, pending-atoms I/O
  pending-atoms.json       # Auto-written after each run (1745 entries, category breakdown)
package.json               # workspace:* deps: @yakcc/compile, @yakcc/contracts, @yakcc/seeds
tsconfig.json              # extends ../../tsconfig.base.json, lib: ["ES2022", "dom"]
```
