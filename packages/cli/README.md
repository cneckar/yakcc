# @yakcc/cli

> **Shave once, reuse forever.**

Yakcc is a content-addressed block registry for assembling programs from verified, reusable building blocks. Instead of generating the same parsing logic, data transformation, or utility function over and over, your IDE's AI assistant shaves it once into an atomic, tested block and stores it in a local registry. The next time you need it — in any project, on any machine — the registry serves the exact same bytes, with proof that it works.

This package is the `yakcc` command-line interface.

## Install

```sh
npm install -g @yakcc/cli@alpha
# or
pnpm add -g @yakcc/cli@alpha
```

> v0.5.0-alpha.0 is the **first public alpha**. Install via the `alpha` tag so a plain `npm install @yakcc/cli` doesn't pull pre-release bits.

## 60-second quickstart

```sh
# In any project directory:
yakcc init
```

`yakcc init` creates a `.yakcc/` directory, wires up hooks for whichever supported IDEs it detects (Claude Code, Cursor, Cline, Continue.dev, Windsurf, Aider), and seeds the local registry with bootstrap atoms.

From there, your IDE's AI assistant consults the registry whenever it emits code. Matching atoms get served directly; novel emissions get atomized into the registry for next time.

## What you get

- **Reproducibility by construction.** Every assembled program carries a provenance manifest naming every constituent block by its content-address. Bit-for-bit reproducibility is the default, not a build option.
- **Verified building blocks.** Every block carries property tests. You always know what was tested and how.
- **6-IDE adapter cascade.** Claude Code, Cursor, Cline, Continue.dev, Windsurf, Aider.
- **Offline-first.** No API key required for most operations. Vector search uses a local embedding model; shaving uses static TypeScript analysis by default.
- **Federation.** Registries can mirror each other over HTTP; every transferred block is integrity-checked.

## Common commands

| Command | What it does |
|---|---|
| `yakcc init [--target <dir>] [--peer <url>]` | Set up yakcc in a project; auto-detects supported IDEs. |
| `yakcc compile <entry>` | Walk sub-contracts from the entry point and emit a runnable artifact + provenance manifest. |
| `yakcc shave <source-dir>` | Decompose a permissively-licensed TS/JS tree into registry atoms (static analysis, no API key). |
| `yakcc query <intent>` | Vector search for atoms matching a natural-language intent. |
| `yakcc registry rebuild` | Regenerate registry embeddings. |
| `yakcc bootstrap --verify` | Confirm registry/atom-corpus health (byte-compare against committed manifest). |
| `yakcc federation serve` | Run a read-only HTTP registry peer. |
| `yakcc federation mirror --remote <url>` | Mirror all blocks from a remote peer into the local registry. |
| `yakcc uninstall [--purge]` | Remove yakcc from a project. |

Run `yakcc --help` for the full surface.

## Exit codes

- `0` — success
- `1` — usage error
- `2` — runtime error (registry not found, compilation failed, type error)

## Documentation

- Full walkthrough: [docs/USING_YAKCC.md](https://github.com/cneckar/yakcc/blob/main/docs/USING_YAKCC.md)
- Alpha tester guide: [docs/ALPHA.md](https://github.com/cneckar/yakcc/blob/main/docs/ALPHA.md)
- Advanced topics (federation, airgap, custom embeddings): [docs/ADVANCED.md](https://github.com/cneckar/yakcc/blob/main/docs/ADVANCED.md)
- Troubleshooting: [docs/TROUBLESHOOTING.md](https://github.com/cneckar/yakcc/blob/main/docs/TROUBLESHOOTING.md)

## Reporting issues

File at [github.com/cneckar/yakcc/issues](https://github.com/cneckar/yakcc/issues). Alpha-tester feedback is the most valuable signal we get right now.

## License

Yakcc consists of two distinct artifacts with different licenses:

- **Substrate code** (this package) — [Apache License 2.0](./LICENSE).
- **Atom content** (registry contents under `dist/blocks/`) — public domain via [The Unlicense](./LICENSE-ATOMS).
