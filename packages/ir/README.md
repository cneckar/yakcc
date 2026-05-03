# @yakcc/ir

The intermediate representation for strict-TypeScript-subset basic blocks.

## What this package provides

- **`validateStrictSubset(source)`** — validate a single source string against the strict-TS-subset grammar. Returns a `ValidationResult` with any `ValidationError` violations. The strict subset bans: `any`, `eval`, untyped imports, runtime reflection, mutable globals, top-level side effects (with a documented `// @cli-entry` exemption for CLI entry points, DEC-IR-CLI-ENTRY-EXEMPTION-001), classes (outside an explicit class-allowlist), and dynamic `import()`.
- **`validateStrictSubsetFile(filePath)`** — file-level variant; reads and validates a `.ts` source file in isolated mode.
- **`validateStrictSubsetProject(tsconfigPath)`** — project-mode validation (WI-V2-01, DEC-V2-IR-PROJECT-MODE-001). Loads a real `tsconfig.json` via ts-morph's `tsConfigFilePath` constructor option, resolving cross-file relative imports, workspace `@yakcc/*` cross-package imports, and `node:*` builtin imports through the actual TypeScript resolver. Eliminates the ~98% false-positive `no-untyped-imports` rate seen in isolated mode against whole-package source. Both modes consume the same rule registry (Sacred Practice #12).
- **`parseBlockTriplet(source)`** — parse a source string into a typed block representation used by the assembler.
- **`ValidationError`** / **`ValidationResult`** — error and result types.
- **`ProjectValidationResult`** — result type for project-mode validation. Includes per-file violation lists and a summary.

## Public API

```ts
import {
  validateStrictSubset,
  validateStrictSubsetFile,
  validateStrictSubsetProject,
  parseBlockTriplet,
} from "@yakcc/ir";
import type { ValidationResult, ProjectValidationResult } from "@yakcc/ir";

// Single-source validation (seed blocks, isolated atoms)
const result: ValidationResult = validateStrictSubset(source);
if (!result.valid) {
  for (const err of result.errors) {
    console.error(err.rule, err.message, err.location);
  }
}

// File-level isolated validation
const fileResult = await validateStrictSubsetFile("packages/seeds/src/blocks/parse-int/impl.ts");

// Project-mode validation (resolves cross-package imports; use for whole-package audits)
const projectResult: ProjectValidationResult = await validateStrictSubsetProject(
  "packages/registry/tsconfig.json"
);
```

## Strict-subset scope

The validator checks **block implementations** (seed corpus, shaved atoms) and **yakcc's own source** (via project mode). The IR toolchain files themselves (`strict-subset.ts`, `block-parser.ts`, etc.) import `ts-morph` and `node:fs` and are intentionally outside the strict-subset grammar — they are the validator, not the validated.

Project-mode self-validation of yakcc's own packages was performed in WI-V2-01; the 4 real violations found were fixed in WI-V2-02 (two singleton mutables in `embeddings.ts` + two CLI entry-point dispatches).

## What is not yet wired

- **IR lowering for all v2 constructs**: `async`/`await`, classes, conditional/mapped/deep-generic types, and `unknown` narrowing patterns are used by yakcc itself but not yet admitted to the IR as validated-and-lowerable constructs. Extension is tracked as WI-V2-03 (IR subset extensions for self-hosting, Phase B), gated on the v2 bootstrap chain.

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
