# @yakcc/ir

The intermediate representation for strict-TypeScript-subset basic blocks.

## What this package provides

- **`BlockAst`** — an opaque AST type representing a parsed basic block. v0
  carries the raw source as a string; WI-004 replaces this with a structured
  node tree that encodes the strict-TS-subset grammar.
- **`parseBlock(source)`** — parses a source string into a `BlockAst`. v0
  accepts all input as valid (facade); WI-004 wires the real parser that
  enforces the strict subset.
- **`validateStrictSubset(ast)`** — validates that a `BlockAst` conforms to
  the strict-TS-subset grammar. Returns a `ValidationResult` with any
  violations. v0 always returns `{ valid: true }` (facade).

## What callers consume

Downstream packages (`@yakcc/compile`, `@yakcc/cli`) consume `BlockAst` as the
unit of composition. A block is never reassembled from its AST at runtime —
the source text is preserved as the canonical artifact. The AST is used only
during compilation to verify that blocks compose without type errors and that
no disallowed language features (classes, `this`, mutable globals, dynamic
`import()`) are present.

## How composition is expressed

Basic blocks are composed by sequencing: the output type of one block must
match the input type of the next. Composition is checked at the `ContractSpec`
level (type strings) in v0, and at the AST level in WI-004 once the IR
validator is live.

```ts
import type { BlockAst } from "@yakcc/ir";
import { parseBlock, validateStrictSubset } from "@yakcc/ir";

const ast: BlockAst = parseBlock(source);
const result = validateStrictSubset(ast);
if (!result.valid) {
  throw new Error(`Block violates strict subset: ${result.violations.join(", ")}`);
}
```

## What this package does not do (yet)

- **No real parser** — WI-004 replaces the facade with a strict-TS-subset
  parser built on the TypeScript compiler API.
- **No violation reporting** — WI-004 implements the violation collector.
- **No AST transformation** — the IR is read-only; transformations are not
  part of the v0 scope.

## Strict-subset scope

`validateStrictSubset` and `validateStrictSubsetFile` validate **block sources**
(seed contract implementations under `packages/seeds/src/blocks/**`), NOT the IR
toolchain itself. The CLI (`pnpm strict-subset`) defaults to that directory: if it
does not exist yet (before WI-006 lands), the command exits 0 with a diagnostic
message. Explicit file paths override the default. The IR toolchain files
(`strict-subset.ts`, `block-parser.ts`, etc.) import `ts-morph` and `node:fs` and
are intentionally outside the strict-subset grammar — they are the validator, not
the validated.

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
