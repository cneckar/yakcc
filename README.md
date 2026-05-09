# Yakcc

**Shave once, reuse forever.** Yakcc is a content-addressed block registry for assembling programs from verified, reusable building blocks.

The core idea: instead of writing the same parsing logic, data transformation, or utility function over and over, you shave it once into an atomic, tested block and store it in a local registry. The next time you need it — in any project, on any machine — the registry serves the exact same bytes, with proof that it works.

The name is a yak-shave joke that is also a thesis. The double-c is a nod to the long lineage of terse compiler names.

## Why it matters

**Reproducibility by construction.** Every assembled program carries a provenance manifest naming every constituent block by its content-address. Bit-for-bit reproducibility is not a build option — it is the default.

**Verified building blocks.** Every block in the registry carries property tests. When you compose blocks into a program, you know exactly what was tested and how.

**IDE integration.** Hooks for Claude Code, Cursor, and Codex CLI intercept code-emission events and check the registry first. If a matching block already exists, it is served — no generation needed.

**Offline-first.** No API key is required for most operations. Shaving uses static TypeScript analysis by default. Vector search uses a local embedding model.

**Federation.** Registries can mirror each other over HTTP. Every transferred block is integrity-checked by recomputing its content-address from the received bytes.

## Use cases

- **Eliminating duplicate logic across projects** — shave utility functions once, use them everywhere via the registry.
- **Auditable programs** — the provenance manifest proves which blocks were used and that they passed their property tests.
- **Team registries** — serve a shared registry with `yakcc federation serve`; developers mirror blocks locally with `yakcc federation mirror`.
- **AI-assisted development** — IDE hooks serve registry matches before an AI generates new code, anchoring generation to verified prior work.

## Getting started

```sh
# Install dependencies and build all packages
pnpm install && pnpm build

# Create a local registry
yakcc registry init

# Ingest the seed corpus (~20 blocks composing a JSON integer-list parser)
yakcc seed

# Assemble the parse-int-list demo
yakcc compile examples/parse-int-list

# Run it
node examples/parse-int-list/dist/main.js
```

Expected output:

```
parse-int-list demo — assembled by Yakcc v0
============================================
  listOfInts("[1,2,3]") => [1,2,3]
  listOfInts("[]") => []
  listOfInts("[ 42 ]") => [42]
  listOfInts("[10,200,3000]") => [10,200,3000]
```

## Shaving your own code

```sh
# Shave a permissively-licensed TypeScript source file into registry atoms
yakcc shave src/my-utils.ts

# Search the registry for a block matching an intent
yakcc search "parse a JSON array of integers"

# Semantic vector search
yakcc query "parse a JSON array of integers" --top 5

# Bootstrap: shave yakcc's own source and verify the manifest
yakcc bootstrap --verify
```

## IDE hook installation

```sh
yakcc hooks claude-code install   # Claude Code
yakcc hooks cursor install        # Cursor
yakcc hooks codex install         # Codex CLI
```

## Prerequisites

- Node.js >= 22
- pnpm >= 9

## Monorepo layout

```
packages/
  contracts/         @yakcc/contracts         — block types, content-addressing, canonicalization
  registry/          @yakcc/registry          — SQLite-backed registry with vector search
  ir/                @yakcc/ir                — strict-TS-subset IR validation
  compile/           @yakcc/compile           — TS + AssemblyScript/WASM backends, assembler
  shave/             @yakcc/shave             — universalizer pipeline: license gate, intent extraction, decompose, slice
  seeds/             @yakcc/seeds             — ~20-block seed corpus (JSON integer-list parser)
  hooks-base/        @yakcc/hooks-base        — shared hook logic for IDE integrations
  hooks-claude-code/ @yakcc/hooks-claude-code — Claude Code hook
  hooks-cursor/      @yakcc/hooks-cursor      — Cursor hook
  hooks-codex/       @yakcc/hooks-codex       — Codex CLI hook
  federation/        @yakcc/federation        — F1 read-only block mirror over HTTP
  cli/               @yakcc/cli               — yakcc CLI
  variance/          @yakcc/variance          — variance scoring and contract design rules

examples/
  parse-int-list/    — assemble a JSON integer-list parser from seed blocks
  v0.7-mri-demo/     — acceptance harness for the shave pipeline
  v1-federation-demo/ — cross-machine byte-identical compile via federation
```

## Further reading

- [`MASTER_PLAN.md`](MASTER_PLAN.md) — architecture decisions and work-item history
- [`DESIGN.md`](DESIGN.md) — extended design rationale and contract philosophy
- [`VERIFICATION.md`](VERIFICATION.md) — verification ladder, triplet identity, TCB
- [`FEDERATION.md`](FEDERATION.md) — F0..F4 federation trust/scale axis
- [`MANIFESTO.md`](MANIFESTO.md) — the project's voice and intent

## v2 self-hosting demo

`yakcc bootstrap --verify` shaves the entire codebase into an in-memory registry, exports a deterministic manifest sorted by `BlockMerkleRoot`, and byte-compares it to the committed `bootstrap/expected-roots.json`. A clean exit proves every yakcc atom on disk is content-addressed by the same hash the registry would assign on a fresh shave.

```sh
pnpm install --frozen-lockfile
pnpm -r build
node packages/cli/dist/bin.js bootstrap --verify
```

See [docs/V2_SELF_HOSTING_DEMO.md](docs/V2_SELF_HOSTING_DEMO.md) for the fresh-clone reproduction, manifest semantics, and CI integration.

## License

This project is dedicated to the public domain under [The Unlicense](LICENSE).
