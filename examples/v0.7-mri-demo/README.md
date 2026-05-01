# v0.7-mri-demo

v0.7 acceptance demo for yakcc. Exercises the universalize pipeline
(license gate → intent extraction → decompose → slice) end-to-end on a
small TS argv parser adapted from `lukeed/mri`.

## Purpose

This demo is the acceptance vehicle for WI-015 in MASTER_PLAN.md. It proves
that the v0.7 pipeline is correctly wired: a permissively-licensed source
file passes the license gate, reaches the LLM-backed intent-extraction step,
and produces atoms that can be stored in the SQLite-backed registry and
reassembled via `assembleCandidate`.

## Why mri-shaped

The v0.7 plan targets `lukeed/mri` (MIT, ~200 LOC, naturally compositional)
because its structure exercises the Sub-function Granularity Principle: each
logical unit (flag parsing, alias resolution, boolean detection, positional
accumulation) maps to a distinct leaf that `isAtom()` can classify separately.

Per `DEC-DECOMPOSE-STAGE-015-CORRECTION`, the demo vendors a small TS
adaptation rather than the original JS source. mri is a JavaScript package;
yakcc's IR pipeline is strict-TS and requires ts-morph AST canonicalization.
The TS adaptation preserves the algorithmic shape and full MIT attribution
while remaining processable by the pipeline.

Adapted from: lukeed/mri@20c4fb7 (latest main as of 2025-01)
See: https://github.com/lukeed/mri for the canonical implementation.

## Acceptance criteria (WI-015)

| # | Criterion | Status |
|---|---|---|
| (a) | atom test on every leaf | ⚠️ requires live decomposition (`ANTHROPIC_API_KEY`) |
| (b) | yakcc compile output matches mri's published test corpus byte-identically | ❌ deferred — mri is JS; TS adaptation provides the structural substrate, byte-equivalence with literal mri is not achievable through the strict-TS IR |
| (c) | intent-card cache hit on repeated run uses zero Anthropic API calls | ⚠️ achievable with live first-run + cache replay; offline-only test path needs a public `seedIntentCache` helper from `@yakcc/shave` (deferred) |
| (d) | GPL-prepared input refused with clear error | ✅ live offline (license gate runs before LLM) |
| (e) | provenance manifest names every atom by BlockMerkleRoot with parent-block links | ⚠️ schema + manifest extension landed (WI-014-04); population logic gated on (a) |
| (f) | synthetic-monolithic-proposal acceptance check | ⚠️ wired via `assembleCandidate` (WI-014-05); end-to-end run gated on (a) |

## What the offline test suite covers (`test/acceptance.test.ts`)

**Test A — License refusal** (criterion d): calls `universalize()` with a
GPL-3.0-or-later source string; asserts `LicenseRefusedError` is thrown before
any LLM call. Fully offline.

**Test B — Pipeline structural smoke test** (criterion a, partial): reads
`argv-parser.ts` (the MIT-licensed demo target), strips SPDX lines for stable
bytes, then calls `universalize()` with a mock registry that returns no cached
blocks. Asserts `AnthropicApiKeyMissingError` — proving the pipeline passed the
license gate and reached the intent-extraction step. Offline-tolerant: the
gate, the router, and the API-key check all executed in the correct order.

**Test C — Public surface contract**: asserts every symbol in the v0.7 public
surface (`shave`, `universalize`, `LicenseRefusedError`,
`AnthropicApiKeyMissingError`, `detectLicense`, `licenseGate`) is importable
and defined from `@yakcc/shave`. Proves the package is correctly consumable as
a downstream dependency.

**Test D — Compile surface contract**: asserts `assembleCandidate` and
`CandidateNotResolvableError` are importable and defined from `@yakcc/compile`.
Wire-tests the compile package without requiring a seeded registry.

## How to run (offline)

From the repo root:

```bash
pnpm --filter v0.7-mri-demo test
```

## How to run (live — full end-to-end)

Set your API key, build the CLI, then invoke the shave command:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm --filter @yakcc/cli build
node packages/cli/dist/bin.js shave examples/v0.7-mri-demo/src/argv-parser.ts \
  --registry .yakcc/registry.sqlite
```

First run: extracts intent, decomposes to atoms, persists blocks in SQLite.
Second run: replays from the registry cache with zero API calls (criterion c).

## Attribution

`src/argv-parser.ts` is adapted from lukeed/mri (MIT License).
The MIT license header and source attribution are preserved in the file.
Original: https://github.com/lukeed/mri
Commit pin: 20c4fb7 (see file header for current pin).
