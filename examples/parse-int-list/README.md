# parse-int-list

The v0 demo target for Yakcc — a program assembled entirely from content-addressed
basic blocks in a local SQLite registry.

## What this example demonstrates

`parse-int-list` parses a JSON-style array of non-negative integers — input like
`[1, 42, 100]` — and returns the integers as a typed readonly array. The program is
assembled by `yakcc compile` from hand-authored basic blocks stored in the registry;
no code is generated at assembly time, and no runtime parser-combinator framework is
imported. Every line in the output module traces to a named block with a content-address
in the provenance manifest.

## Compose tree

The assembler resolves `listOfInts` (the entry-point block) and its full transitive
dependency graph. Ten blocks appear in the manifest:

| Function | Role |
|---|---|
| `listOfInts` | Entry point: validates ASCII, dispatches empty vs nonempty list |
| `nonemptyListContent` | Parses one or more comma-separated integers + closing `]` |
| `bracket` | Asserts `[` or `]` at a position, returns next position |
| `emptyListContent` | Recognises `]` that closes an empty list |
| `eofCheck` | Asserts no trailing input after the closing `]` |
| `nonAsciiRejector` | Scans full input; throws `RangeError` on any non-ASCII byte |
| `comma` | Asserts `,` at a position, returns next position |
| `integer` | Parses one or more decimal digits; returns `[value, newPosition]` |
| `optionalWhitespace` | Skips zero or more spaces or tabs; returns new position |
| `peekChar` | Returns the character at a position without advancing |

Each block is stored under its SHA-256 content-address. The `composedFrom` graph
in `dist/manifest.json` records which blocks each compositor block depends on.

## Run it

From the repository root, after a fresh install:

```sh
pnpm install
pnpm build

# Initialise a local registry and ingest the seed corpus
node packages/cli/dist/bin.js registry init
node packages/cli/dist/bin.js seed

# Compile parse-int-list; writes dist/module.ts and dist/manifest.json
node packages/cli/dist/bin.js compile examples/parse-int-list

# Run the assembled demo
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

Error cases:
  listOfInts("[abc]") => throws SyntaxError
  listOfInts("[1,2,") => throws SyntaxError
  listOfInts("[1]x") => throws SyntaxError
```

Pass a single argument for a one-off parse:

```sh
node examples/parse-int-list/dist/main.js '[1,2,3]'
# listOfInts("[1,2,3]") => [1,2,3]
```

## What the manifest contains

`dist/manifest.json` is the provenance manifest emitted by `yakcc compile`.
It records:

- `entry` — the SHA-256 content-address of the `listOfInts` entry-point block.
- `entries[]` — one object per block in the transitive closure, each containing:
  - `contractId` — the SHA-256 content-address of the block source.
  - `source` — the full TypeScript source of the block.
  - `subBlocks[]` — content-addresses of the blocks this block directly composes.
  - `verificationStatus` — `"unverified"` in v0 (property-test integration lands post-v0).

The manifest is deterministic: re-running `yakcc compile` on an unchanged registry
produces a byte-identical `manifest.json`.

## License

This example is dedicated to the public domain under [The Unlicense](../../LICENSE).
