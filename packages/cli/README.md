# @yakcc/cli

The `yakcc` command-line interface.

**Status: v1 fully closed. v1 wave-2 closed (live IDE hooks + WASM backend). v2 bootstrap in progress.**

## Commands

| Command | What it does today |
|---|---|
| `yakcc registry init [path]` | Create a SQLite + sqlite-vec registry at the given path (default: `.yakcc/registry.db`). Safe to run more than once; skips migration if schema is current. |
| `yakcc registry seed <dir>` | Walk a directory of block JSON files and register each block into the live registry. |
| `yakcc shave <source-dir>` | Recursively decompose a permissively-licensed TS/JS source tree into registry atoms. Uses static intent extraction (ts-morph + JSDoc) by default; no API key required. |
| `yakcc search <query>` | Structural search: filter the registry by input/output type signature and non-functional properties. Prints candidates with ids, behavior summaries, and similarity scores. |
| `yakcc query <intent> [--top k] [--rerank] [--registry p] [--card-file f]` | Vector search: find blocks semantically close to an intent string (or an IntentCard JSON file via `--card-file`). Uses `Registry.findCandidatesByIntent()` (WI-025). Free-text `<intent>` is wrapped into a minimal behavior-only IntentQuery. Prints ranked results with cosine distance and (when `--rerank`) structural scores. |
| `yakcc propose` | Submit a contract spec to the registry. Reads a JSON `ContractSpec` from stdin or a `--file` argument. Prints the assigned `ContractId` on success. |
| `yakcc compile <entry>` | Walk sub-contracts from the entry point, bind each to a registry implementation, and emit a runnable TypeScript artifact plus a provenance manifest. |
| `yakcc federation serve --registry <db> [--port n] [--host h]` | Start a read-only HTTP registry server that exposes the F1 federation wire protocol (WI-020). Blocks until SIGINT/SIGTERM. |
| `yakcc federation mirror --remote <url> --registry <db>` | Mirror all blocks from a remote registry peer into the local registry. Prints a `MirrorReport` as JSON on completion. Exits 0 even when some blocks fail (recoverable); exits 1 on `SchemaVersionMismatchError`. |
| `yakcc federation pull --remote <url> --root <merkleRoot> [--registry <db>]` | Pull a single block by its `BlockMerkleRoot` from a remote peer. Without `--registry`: diagnostic-only (prints root + specHash, no persistence). With `--registry <db>`: pulls and persists the block idempotently via `storeBlock` (WI-030). |
| `yakcc bootstrap [--registry p] [--manifest p] [--report p]` | Walk all `packages/*/src` and `examples/*/src` TypeScript files, shave each into a `:memory:` registry, and write `bootstrap/expected-roots.json` (sorted deterministic manifest). Add `--verify` to byte-compare against the committed manifest; exits 1 with a structured diff on mismatch. |
| `yakcc hooks claude-code install` | Install the Yakcc Claude Code hook into the current Claude Code project settings. |
| `yakcc hooks cursor install` | Install the Yakcc Cursor hook marker file. |
| `yakcc hooks codex install` | Install the Yakcc Codex CLI hook marker file. |

## Quickstart

```sh
# 1. Create a registry in the current project
yakcc registry init

# 2. Shave an existing library into atoms and register them
yakcc shave ./node_modules/some-lib/src

# 3. Search the registry
yakcc search "parse a JSON array of integers"

# 4. Compile a top-level contract to a runnable TS file
yakcc compile my-contract.json --out dist/program.ts
```

## Exit codes

- `0` — success
- `1` — usage error (unknown command, missing required argument)
- `2` — runtime error (registry not found, compilation failed, type error)

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
