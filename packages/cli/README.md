# @yakcc/cli

The `yakcc` command-line interface.

## What this package provides

The `yakcc` binary exposes five commands:

| Command | Description |
|---|---|
| `yakcc registry init [path]` | Initialize a new registry at the given path (default: `.yakcc/registry.db`). Creates the SQLite database and prepares the sqlite-vec extension. |
| `yakcc propose` | Submit a contract spec to the registry. Reads a JSON `ContractSpec` from stdin or a `--file` argument. Prints the assigned `ContractId` on success. |
| `yakcc search <query>` | Search the registry for contracts matching the query string. Prints up to 10 candidates with their ids, behavior summaries, and similarity scores. |
| `yakcc compile <contractId>` | Assemble a complete program satisfying the given contract. Writes the emitted source to stdout or a `--out` file. Prints the provenance manifest to stderr. |
| `yakcc block author` | Interactively author a new basic block. Prompts for a source file and a contract id, validates the block against the strict-TS subset, and registers it. |

## Invocation form

```
yakcc <command> [options]
```

Exit codes:
- `0` — success
- `1` — usage error (unknown command, missing required argument)
- `2` — runtime error (registry not found, compilation failed, type error)

## v0 status

v0 ships the command surface only. All five commands print a placeholder
message and exit 0. WI-003 wires `registry init`, `propose`, and `search` to
the live SQLite registry. WI-005 wires `compile` to the assembler.

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
