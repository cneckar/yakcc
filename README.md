# Yakcc

**Status: v0 substrate operational; demo runnable.**

Yakcc is a local-only TypeScript substrate for assembling programs from content-addressed
basic blocks. A block is a minimal, behaviorally-specified piece of code stored in a
local SQLite registry under a SHA-256 content-address. The compiler resolves an
entry-point contract into a runnable TypeScript module and emits a provenance manifest
that names every constituent block by its content-address — making the full assembly
traceable and byte-reproducible.

The name is a yak-shave joke that is also a thesis: we shave once so callers never shave
again. The double-c is a nod to the long lineage of terse compiler names.

## References

- `MASTER_PLAN.md` — architecture decisions, work-item breakdown, and DEC-IDs.
- `DESIGN.md` — extended design rationale and contract philosophy.
- `AGENTS.md` — agent role definitions and ClauDEX dispatch conventions.

## Prerequisites

- Node.js >= 22 (project uses Node 22 APIs; tested on Node 22.22.0)
- pnpm >= 9 (`pnpm@9.15.0` declared in `packageManager`)

## Monorepo layout

```
packages/
  contracts/         @yakcc/contracts   — branded types, ContractSpec, ContractId
  registry/          @yakcc/registry    — SQLite-backed registry, openRegistry()
  ir/                @yakcc/ir          — strict-TS-subset IR and block types
  compile/           @yakcc/compile     — TS backend, assembler, provenance manifest
  seeds/             @yakcc/seeds       — hand-authored ~20-block seed corpus
  hooks-claude-code/ @yakcc/hooks-claude-code — Claude Code hook integration facade
  cli/               @yakcc/cli         — yakcc CLI (registry, compile, seed, search, hooks)

examples/
  parse-int-list/    target demo: assemble a JSON-integer-list parser from ~10 sub-blocks
```

## 15-minute path

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

## Verify acceptance

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
node packages/cli/dist/bin.js search examples/parse-int-list/contract.json
# Expected: one result line with score=1.0000
```

**3. Compile produces runnable module; re-run is byte-identical**

```sh
node packages/cli/dist/bin.js compile examples/parse-int-list
node examples/parse-int-list/dist/main.js
# Expected: listOfInts("[1,2,3]") => [1,2,3]

# Byte-identity check:
node packages/cli/dist/bin.js compile examples/parse-int-list --out /tmp/check2
shasum -a 256 examples/parse-int-list/dist/manifest.json /tmp/check2/manifest.json
# Both lines must show the same hash
```

**4. Compiled module imports zero runtime deps beyond seed blocks**

```sh
# inspect the compiled module — no import statements other than type imports
grep "^import " examples/parse-int-list/dist/module.ts
# Expected: no output (no runtime imports)
```

**5. Hooks install works**

```sh
node packages/cli/dist/bin.js hooks claude-code install --target /tmp/yakcc-hooks-check
# Expected: "yakcc hooks installed at /tmp/yakcc-hooks-check/.claude/CLAUDE.md", exit 0
cat /tmp/yakcc-hooks-check/.claude/CLAUDE.md
# Expected: contains "/yakcc" slash command stub
```

**6. Seeds property-test suite passes**

```sh
pnpm --filter @yakcc/seeds test
# Expected: "Tests: 157 passed"
```

**7. New contributor reaches criterion 3 in < 15 minutes**

Follow the "15-minute path" section above on a clean machine. Time the five steps
from `pnpm install` through `node examples/parse-int-list/dist/main.js`. On a
machine with a warm network cache this takes under 30 seconds; on a truly cold
machine (no pnpm store, no turbo cache) it takes under 9 minutes including all
TypeScript compilations.

## License

This project is dedicated to the public domain under [The Unlicense](LICENSE).
