# Yakcc

**Status: v0 — active scaffolding. Core interfaces are established; persistence,
real hash algorithms, and live embeddings land in subsequent work items.**

Yakcc is a local-only TypeScript substrate for assembling programs from
content-addressed basic blocks. Each block carries a behavioral contract; the
registry stores blocks by contract identity so the compiler can resolve an
entry-point contract into a runnable program and emit a provenance manifest
naming every constituent block by its content-address.

The v0 scope is intentionally narrow: hand-authored blocks, an in-memory
registry facade, and a stub assembler. The goal is a verified end-to-end
skeleton before persistence and real hashing complicate the design.

## References

- `MASTER_PLAN.md` — architecture decisions, work-item breakdown, and DEC-IDs.
- `DESIGN.md` — extended design rationale and contract philosophy.
- `AGENTS.md` — agent role definitions and ClauDEX dispatch conventions.

## Monorepo layout

```
packages/
  contracts/        @yakcc/contracts  — branded types, ContractSpec, ContractId
  registry/         @yakcc/registry   — Registry interface and in-memory facade
  ir/               @yakcc/ir         — strict-TS-subset IR and block types
  compile/          @yakcc/compile    — backend interface, TS backend, assembler
  hooks-claude-code/@yakcc/hooks-claude-code — Claude Code hook integration facade
  cli/              @yakcc/cli        — yakcc CLI (registry init, propose, compile)

examples/
  parse-int-list/   target demo: parse a JSON array of integers from ~6 sub-blocks
```

## Quick start

```sh
pnpm install
pnpm typecheck
```

Building individual packages:

```sh
pnpm --filter @yakcc/contracts build
pnpm --filter @yakcc/cli build
```

## License

This project is dedicated to the public domain under [The Unlicense](LICENSE).
