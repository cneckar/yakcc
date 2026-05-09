# @yakcc/seeds — Seed Corpus

The seed corpus is a collection of ~20 hand-authored, content-addressed basic
blocks that compose a JSON list-of-integers parser. It is the first real data
in the Yakcc registry and demonstrates the core compositional principle: each
block is minimal, specced, and independently testable.

## Purpose

This package serves three functions:

1. **Demonstrate composition.** The `list-of-ints` block parses `"[1,2,3]"` by
   composing `integer`, `whitespace`, `bracket`, and `comma` — not via a monolithic
   regex. Each sub-block is a registry entry in its own right.

2. **Bootstrap the registry.** `seedRegistry(registry)` stores all blocks into
   a `Registry` instance and returns their content-addressed `ContractId`s.

3. **Prove the IR rules.** Every block source passes `validateStrictSubset` from
   `@yakcc/ir`, establishing that hand-authored blocks can satisfy the strict-TS
   subset without special casing.

## Block inventory

| File | Function | Description |
|------|----------|-------------|
| `ascii-char.ts` | `asciiChar` | Consume one ASCII char at a position |
| `ascii-digit-set.ts` | `isAsciiDigit` | Membership test for ASCII digit characters |
| `bracket.ts` | `bracket` | Match `[` or `]` at a position |
| `comma.ts` | `comma` | Match `,` at a position |
| `comma-separated-integers.ts` | `commaSeparatedIntegers` | Parse comma-separated integer interior |
| `digit.ts` | `digit` | Parse a single ASCII digit char to integer 0-9 |
| `digit-or-throw.ts` | `digitOrThrow` | Parse a digit or throw with a descriptive message |
| `empty-list-content.ts` | `emptyListContent` | Recognize an empty list interior `]` |
| `eof-check.ts` | `eofCheck` | Assert end-of-input at a position |
| `integer.ts` | `integer` | Parse a decimal integer (one or more digits) |
| `list-of-ints.ts` | `listOfInts` | Parse `"[i1,i2,...]"` to `number[]` |
| `non-ascii-rejector.ts` | `nonAsciiRejector` | Assert all input bytes are ASCII |
| `nonempty-list-content.ts` | `nonemptyListContent` | Parse list interior with at least one element |
| `optional-whitespace.ts` | `optionalWhitespace` | Skip optional whitespace; explicit alias |
| `peek-char.ts` | `peekChar` | Peek at a character without advancing position |
| `position-step.ts` | `positionStep` | Advance a position by N characters |
| `signed-integer.ts` | `signedInteger` | Parse an optionally-signed decimal integer |
| `string-from-position.ts` | `stringFromPosition` | Extract a substring from a position |
| `whitespace.ts` | `whitespace` | Skip optional whitespace and return new position |

## Composition graph

```
list-of-ints
├── bracket          (open/close brackets)
├── whitespace       (surrounding whitespace)
├── nonempty-list-content
│   ├── integer
│   │   └── digit
│   ├── comma
│   └── whitespace
└── empty-list-content
```

## Usage

```ts
import { openRegistry } from "@yakcc/registry";
import { seedRegistry } from "@yakcc/seeds";

const registry = await openRegistry({ path: ":memory:" });
const { stored, contractIds } = await seedRegistry(registry);
console.log(`Seeded ${stored} blocks`);
```

## Source-text strategy

Each block file exports a `SOURCE` string constant containing its own source text. This avoids runtime filesystem access post-build. The `SOURCE` export is co-located in the same file so it stays in sync by construction — a change to the implementation requires updating both the function and `SOURCE` in the same edit.
