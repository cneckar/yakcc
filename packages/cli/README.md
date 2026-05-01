# @yakcc/cli

The `yakcc` command-line interface.

**Status: v0 substrate operational; v1 wave-1 federation work in progress.**

## Commands

| Command | What it does today |
|---|---|
| `yakcc registry init [path]` | Create a SQLite + sqlite-vec registry at the given path (default: `.yakcc/registry.db`). Safe to run more than once; skips migration if schema is current. |
| `yakcc registry seed <dir>` | Walk a directory of block JSON files and register each block into the live registry. |
| `yakcc shave <source-dir>` | Recursively decompose a permissively-licensed TS/JS source tree into registry atoms. Uses static intent extraction (ts-morph + JSDoc) by default; no API key required. |
| `yakcc search <query>` | Search the registry for contracts matching the query string. Prints candidates with ids, behavior summaries, and similarity scores. |
| `yakcc propose` | Submit a contract spec to the registry. Reads a JSON `ContractSpec` from stdin or a `--file` argument. Prints the assigned `ContractId` on success. |
| `yakcc compile <entry>` | Walk sub-contracts from the entry point, bind each to a registry implementation, and emit a runnable TypeScript artifact plus a provenance manifest. |
| `yakcc hooks claude-code install` | Install the Yakcc Claude Code hook into the current Claude Code project settings. |

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
