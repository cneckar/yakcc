# Yakcc

**Status: v1 fully closed. v1 wave-2 closed (live IDE hooks + WASM backend shipped). v2 bootstrap in progress (`yakcc bootstrap` one-shot mode landed; `--verify` mode in-flight).**

Yakcc is a local-only TypeScript substrate for assembling programs from content-addressed
basic blocks. A block is a triplet directory (`spec.yak` + `impl.ts` + `proof/`) stored
in a local SQLite registry. The block's identity is its `BlockMerkleRoot`:

```
spec_hash  = BLAKE3(canonicalize(spec.yak))
impl_hash  = BLAKE3(UTF-8 bytes of impl.ts)
proof_root = BLAKE3(canonicalize(manifest.json) || BLAKE3(artifact[0].bytes) || ...)
block_merkle_root = BLAKE3(spec_hash || impl_hash || proof_root)
```

The proof root commits to both the proof manifest and the artifact-byte map
(`BlockTriplet.artifacts`), so any change to a proof artifact changes the block's identity.
The compiler resolves an entry-point spec into a runnable TypeScript module and emits a
provenance manifest naming every constituent block by its `BlockMerkleRoot`.

The name is a yak-shave joke that is also a thesis: we shave once so callers never shave
again. The double-c is a nod to the long lineage of terse compiler names.

## References

- `MASTER_PLAN.md` — architecture decisions, work-item breakdown, and DEC-IDs.
- `DESIGN.md` — extended design rationale and contract philosophy.
- `AGENTS.md` — agent role definitions and ClauDEX dispatch conventions.
- `VERIFICATION.md` — verification ladder L0..L3, ocap discipline, triplet identity, TCB hardening.
- `FEDERATION.md` — trust/scale axis F0..F4, package decomposition, F4 economics.
- `FEDERATION_PROTOCOL.md` — wire protocol for inter-node block exchange (WI-019).
- `MANIFESTO.md` — "The Shave at the End of History": the project's voice and intent.
- `suggestions.txt` — universalizer pipeline (AST canon, native auto-decomposition, behavioral embeddings); constitutional input.

## Prerequisites

- Node.js >= 22 (project uses Node 22 APIs; tested on Node 22.22.0)
- pnpm >= 9 (`pnpm@9.15.0` declared in `packageManager`)

## Monorepo layout

```
packages/
  contracts/         @yakcc/contracts        — branded types: SpecYak, ContractId, BlockMerkleRoot, SpecHash
  registry/          @yakcc/registry         — SQLite-backed registry, openRegistry(), exportManifest()
  ir/                @yakcc/ir               — strict-TS-subset IR, validateStrictSubset(), validateStrictSubsetProject()
  compile/           @yakcc/compile          — TS + WASM backends, assembler, provenance manifest
  seeds/             @yakcc/seeds            — hand-authored ~20-block seed corpus
  hooks-base/        @yakcc/hooks-base       — shared hook types: EmissionContext, HookResponse, executeRegistryQuery()
  hooks-claude-code/ @yakcc/hooks-claude-code — Claude Code hook: registry-hit / synthesis-required / passthrough
  hooks-cursor/      @yakcc/hooks-cursor     — Cursor hook (same contract as hooks-claude-code)
  hooks-codex/       @yakcc/hooks-codex      — Codex CLI hook (same contract as hooks-claude-code)
  federation/        @yakcc/federation       — F1 read-only block mirror: serveRegistry(), mirrorRegistry(), pullBlock()
  cli/               @yakcc/cli              — yakcc CLI (registry init, seed, shave, search, query, propose, compile, bootstrap, federation, hooks install)
  shave/             @yakcc/shave            — universalizer pipeline: intent extraction (static or LLM), atom decomposition, slicer, atom-persist
  variance/          @yakcc/variance         — variance scoring + contract design rules (intersection/majority-vote/union per WI-011)

examples/
  parse-int-list/    target demo: assemble a JSON-integer-list parser from ~10 sub-blocks
  v0.7-mri-demo/     offline-tolerant acceptance harness for the shave pipeline
```

## 15-minute path (v0 demo)

The sequence below reproduces v0 exit criteria 1–4 from a clean clone.
Wall-clock time on the development machine (cold install, no turbo cache): **~9 seconds**.

```sh
# 1. Install dependencies and build all packages
pnpm install
pnpm build

# 2. Initialise a local SQLite registry (default: .yakcc/registry.sqlite)
node packages/cli/dist/bin.js registry init

# 3. Ingest the ~20-block seed corpus into the registry
node packages/cli/dist/bin.js seed

# 4. Compile parse-int-list; writes dist/module.ts + dist/manifest.json
node packages/cli/dist/bin.js compile examples/parse-int-list

# 5. Run the assembled demo
node examples/parse-int-list/dist/main.js
```

Expected output from step 5:

```
parse-int-list demo — assembled by Yakcc v0
============================================
  listOfInts("[1,2,3]") => [1,2,3]
  listOfInts("[]") => []
  listOfInts("[ 42 ]") => [42]
  listOfInts("[10,200,3000]") => [10,200,3000]

Error cases:
  listOfInts("[abc]") => throws SyntaxError
  listOfInts("[1,2,") => throws SyntaxError
  listOfInts("[1]x") => throws SyntaxError
```

## Verify acceptance (v0 criteria)

The seven v0 exit criteria and the exact command to verify each:

**1. Build pipeline is green**

```sh
pnpm install && pnpm build
# Expected: "Tasks: N successful" from Turbo, exit 0
```

**2. Registry init + seed round-trips via search**

```sh
node packages/cli/dist/bin.js registry init
node packages/cli/dist/bin.js seed
# Expected: "seeded 20 contracts; ids: ..."
node packages/cli/dist/bin.js search ./examples/parse-int-list/spec.yak
# Expected: one result line with score=1.0000
```

**3. Compile produces runnable module; re-run is byte-identical**

```sh
node packages/cli/dist/bin.js compile examples/parse-int-list
node examples/parse-int-list/dist/main.js
# Expected: listOfInts("[1,2,3]") => [1,2,3]

# Byte-identity check (Linux/macOS):
node packages/cli/dist/bin.js compile examples/parse-int-list --out /tmp/check2
shasum -a 256 examples/parse-int-list/dist/manifest.json /tmp/check2/manifest.json
# Both lines must show the same hash
```

**4. Compiled module imports zero runtime deps beyond seed blocks**

```sh
grep "^import " examples/parse-int-list/dist/module.ts
# Expected: no output (no runtime imports)
```

**5. Hooks install works**

```sh
node packages/cli/dist/bin.js hooks claude-code install --target /tmp/yakcc-hooks-check
# Expected: "yakcc hooks installed at /tmp/yakcc-hooks-check/.claude/CLAUDE.md", exit 0
```

**6. Seeds property-test suite passes**

```sh
pnpm --filter @yakcc/seeds test
# Expected: "Tests: 158 passed"
```

**7. New contributor reaches criterion 3 in < 15 minutes**

Follow the "15-minute path" section above on a clean machine. Time the five steps
from `pnpm install` through `node examples/parse-int-list/dist/main.js`. On a
machine with a warm network cache this takes under 30 seconds; on a truly cold
machine (no pnpm store, no turbo cache) it takes under 9 minutes including all
TypeScript compilations.

## Verify acceptance (v0.7 + v1 wave-1)

These checks cover the work items landed in v1 wave-1.

**Static intent extraction — no API key required (WI-023)**

The shave pipeline defaults to the static (TypeScript Compiler API + JSDoc) strategy.
`ANTHROPIC_API_KEY` is NOT required for the static path.

```sh
# Build first if you haven't already:
pnpm install && pnpm build
node packages/cli/dist/bin.js registry init

# Shave a permissively-licensed MIT source file with forced offline mode:
node packages/cli/dist/bin.js shave examples/v0.7-mri-demo/src/argv-parser.ts --offline
# Expected: "Shaved <path>:" followed by atoms and intentCards counts
```

**Registry artifact-bytes persistence (WI-022a)**

`BlockTriplet.artifacts` (a `Map<string, Uint8Array>`) round-trips through
`storeBlock` / `getBlock`. The `@yakcc/contracts` test suite verifies determinism
and sensitivity of the full `BlockMerkleRoot` derivation including artifact bytes:

```sh
pnpm --filter @yakcc/contracts test
# Expected: all tests pass including blockMerkleRoot determinism (1000 cases)
# and sensitivity suites (500 cases each for spec, impl, artifact changes)
```

**Property-test corpus populated (WI-016)**

After running `seed`, each block's proof manifest contains a `property_tests` artifact.
The seeds test suite exercises all 158 property-test cases:

```sh
node packages/cli/dist/bin.js registry init
node packages/cli/dist/bin.js seed
pnpm --filter @yakcc/seeds test
# Expected: "Tests: 158 passed"
```

**Parent-block lineage (WI-017)**

The compile provenance manifest names `recursionParent` for non-root atoms.
Run the parse-int-list compile and inspect the manifest:

```sh
node packages/cli/dist/bin.js compile examples/parse-int-list
node -e "const m=JSON.parse(require('fs').readFileSync('examples/parse-int-list/dist/manifest.json','utf8')); console.log(JSON.stringify(m,null,2))" | head -40
# Expected: "blocks" array; non-root entries carry "recursionParent" field
```

**Federation protocol design (WI-019) and runtime (WI-020/021)**

`FEDERATION_PROTOCOL.md` documents the wire protocol for inter-node block exchange.
The F1 read-only mirror runtime (`@yakcc/federation`) landed in WI-020. The
end-to-end v1 federation demo landed in WI-021 (`d9cb449`) with a full acceptance
test suite at `examples/v1-federation-demo/test/acceptance.test.ts` proving
cross-machine byte-identical compile.

```sh
pnpm --filter @yakcc/federation test
# Expected: all tests pass
```

**Vector-search query API (WI-025/029)**

`Registry.findCandidatesByIntent(intentCard, { k?, rerank? })` is live. Embeddings
are generated and stored on every `storeBlock` call; `findCandidatesByIntent` runs a
KNN query against them. The `yakcc query <intent>` CLI command exposes this surface:

```sh
yakcc query "parse a JSON array of integers" --top 5
# Expected: ranked results with cosine scores and block ids
```

## What's NOT yet wired

Honest list of capabilities that are planned but not yet shipped:

- **`yakcc bootstrap --verify`**: one-shot bootstrap mode (`yakcc bootstrap`) is live and produces a deterministic `bootstrap/expected-roots.json`. The `--verify` flag (byte-compare against committed manifest, structured diff on mismatch) is in-flight as WI-V2-BOOTSTRAP-03.
- **v2 self-hosting (Phases B–I)**: IR subset extensions, foreign-block primitives, source refactor for shavability, property-test coverage, first shave pass, compile self-equivalence, two-pass bootstrap equivalence, and v2 CI demo are all gated on the v2 bootstrap chain closing. See `MASTER_PLAN.md` for the full v2 wave map.
- **WASM string/mixed substrates**: the WASM backend (`compileToWasm`) handles numeric (i32/i64/f64) substrates today. String-handling and record/array lowering (type-lowering pass WI-V1W2-WASM-02) are deferred to a follow-on wave.
- **Federation publishing path (F2+)**: the F1 read-only mirror (`@yakcc/federation`) covers content-addressed pull only. F2+ (block submission, dispute adjudication) is deferred. See `FEDERATION.md` for the F0..F4 axis.

## License

This project is dedicated to the public domain under [The Unlicense](LICENSE).
