// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/compile ts-backend.ts atoms. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3a)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.

// ---------------------------------------------------------------------------
// Property-test corpus for compile/src/ts-backend.ts atoms
//
// Atoms covered (10 named):
//   cleanBlockSource           (A6.1) — exported @internal; strips imports, aliases, CONTRACT
//   extractContractsImports    (A6.2) — private; collects @yakcc/contracts symbols
//   extractEntryFunctionName   (A6.3) — exported @internal; finds first export function name
//   assembleModule             (A6.4) — exported @internal; full module builder
//   tsBackend                  (A6.5) — exported factory; returns Backend with name="ts"
//   INTRA_CORPUS_IMPORT_RE     (A6.6) — private regex; tested transitively via cleanBlockSource
//   SHADOW_TYPE_ALIAS_RE       (A6.7) — private regex; tested transitively via cleanBlockSource
//   CONTRACTS_IMPORT_RE        (A6.8) — private regex; tested transitively via cleanBlockSource
//   CONTRACT_EXPORT_START_RE   (A6.9) — private regex; tested transitively via cleanBlockSource
//   Backend interface          (A6.10) — interface shape: name + emit()
//
// All tests use synthetic in-memory ResolutionResult values — no Registry, no disk IO.
// Properties cover:
//   - cleanBlockSource strips intra-corpus imports
//   - cleanBlockSource strips shadow type aliases (type _X = typeof X)
//   - cleanBlockSource strips @yakcc/contracts imports
//   - cleanBlockSource strips multi-line CONTRACT declaration
//   - cleanBlockSource preserves non-matching lines
//   - extractEntryFunctionName finds first export function/async function name
//   - extractEntryFunctionName returns null for no-export source
//   - assembleModule includes a header comment
//   - assembleModule deduplicates @yakcc/contracts imports
//   - assembleModule re-exports the entry function name
//   - tsBackend().name === "ts"
//   - tsBackend().emit is a function returning a string
// ---------------------------------------------------------------------------

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import * as fc from "fast-check";
import type { ResolutionResult } from "./resolve.js";
import {
  assembleModule,
  cleanBlockSource,
  extractEntryFunctionName,
  tsBackend,
} from "./ts-backend.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

const hexHash64: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

const blockRootArb: fc.Arbitrary<BlockMerkleRoot> = hexHash64 as fc.Arbitrary<BlockMerkleRoot>;
const specHashArb: fc.Arbitrary<SpecHash> = hexHash64 as fc.Arbitrary<SpecHash>;

/**
 * Build a minimal ResolutionResult with one block.
 */
function makeSingleBlockResolution(
  root: BlockMerkleRoot,
  specHash: SpecHash,
  source: string,
): ResolutionResult {
  return {
    entry: root,
    blocks: new Map([[root, { merkleRoot: root, specHash, source, subBlocks: [] }]]),
    order: [root],
  };
}

// ---------------------------------------------------------------------------
// A6.1: cleanBlockSource — strips intra-corpus imports
// ---------------------------------------------------------------------------

/**
 * prop_cleanBlockSource_strips_dot_slash_imports
 *
 * A `import type { X } from "./x.js"` line is stripped from block source.
 * Non-import lines are preserved in the cleaned output.
 *
 * Invariant (A6.1, A6.6): INTRA_CORPUS_IMPORT_RE matches "./" prefix imports;
 * cleanBlockSource removes them without affecting surrounding code.
 */
export const prop_cleanBlockSource_strips_dot_slash_imports = fc.property(
  fc.constantFrom(
    `import type { Foo } from "./foo.js";`,
    `import type { Bar, Baz } from "./bar.js"`,
    `import type { Qux } from "./nested/qux.js";`,
  ),
  fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !s.includes("import")),
  (importLine, code) => {
    const source = `${importLine}\n${code}`;
    const cleaned = cleanBlockSource(source);
    return !cleaned.includes(importLine) && cleaned.includes(code.trim());
  },
);

/**
 * prop_cleanBlockSource_strips_seeds_imports
 *
 * A `import type { X } from "@yakcc/seeds/..."` line is stripped.
 *
 * Invariant (A6.6): INTRA_CORPUS_IMPORT_RE covers "@yakcc/seeds/" prefix.
 */
export const prop_cleanBlockSource_strips_seeds_imports = fc.property(
  fc.constantFrom(
    `import type { Digit } from "@yakcc/seeds/blocks/digit";`,
    `import type { IsValid } from "@yakcc/seeds/blocks/is-valid"`,
    `import type { Bracket } from "@yakcc/seeds/blocks/bracket";`,
  ),
  (importLine) => {
    const cleaned = cleanBlockSource(importLine);
    return !cleaned.includes("@yakcc/seeds/");
  },
);

/**
 * prop_cleanBlockSource_strips_shadow_type_aliases
 *
 * Lines of the form `type _X = typeof X;` are stripped by cleanBlockSource.
 *
 * Invariant (A6.1, A6.7): SHADOW_TYPE_ALIAS_RE matches "type _Identifier = typeof Identifier".
 */
export const prop_cleanBlockSource_strips_shadow_type_aliases = fc.property(
  fc.constantFrom(
    "type _Foo = typeof Foo;",
    "type _Bar = typeof Bar",
    "type _NonAsciiRejector = typeof NonAsciiRejector;",
  ),
  (aliasLine) => {
    const cleaned = cleanBlockSource(aliasLine);
    return cleaned.trim().length === 0 || !cleaned.includes("type _");
  },
);

/**
 * prop_cleanBlockSource_strips_contracts_imports
 *
 * Lines of the form `import type { ... } from "@yakcc/contracts"` are stripped.
 *
 * Invariant (A6.1, A6.8): CONTRACTS_IMPORT_RE matches the @yakcc/contracts import;
 * these are deduplicated separately as a single header by assembleModule.
 */
export const prop_cleanBlockSource_strips_contracts_imports = fc.property(
  fc.constantFrom(
    `import type { ContractSpec } from "@yakcc/contracts";`,
    `import type { ContractSpec, ContractId } from "@yakcc/contracts"`,
    `import type { BlockMerkleRoot } from "@yakcc/contracts";`,
  ),
  (importLine) => {
    const cleaned = cleanBlockSource(importLine);
    return !cleaned.includes("@yakcc/contracts");
  },
);

/**
 * prop_cleanBlockSource_strips_CONTRACT_export_single_line
 *
 * A single-line `export const CONTRACT = {};` declaration is stripped.
 *
 * Invariant (A6.1, A6.9): CONTRACT_EXPORT_START_RE matches the opening of
 * the CONTRACT export; brace-depth tracking drops the entire declaration.
 */
export const prop_cleanBlockSource_strips_CONTRACT_export_single_line = fc.property(
  fc.constantFrom("export const CONTRACT = {};", "export const CONTRACT: ContractSpec = {};"),
  (contractLine) => {
    const cleaned = cleanBlockSource(contractLine);
    return !cleaned.includes("CONTRACT");
  },
);

/**
 * prop_cleanBlockSource_preserves_non_matching_lines
 *
 * Lines that are not imports, aliases, or CONTRACT declarations are preserved
 * verbatim in the cleaned output.
 *
 * Invariant (A6.1): cleanBlockSource is a filter — it never transforms or
 * corrupts lines that don't match its strip patterns.
 */
export const prop_cleanBlockSource_preserves_non_matching_lines = fc.property(
  fc.constantFrom(
    "export function add(a: number, b: number): number { return a + b; }",
    "export const PI = 3.14159;",
    "export type Pair = { first: number; second: string };",
    "const x = 42;",
    "return x + y;",
  ),
  (codeLine) => {
    const cleaned = cleanBlockSource(codeLine);
    return cleaned.includes(codeLine.trim());
  },
);

// ---------------------------------------------------------------------------
// A6.3: extractEntryFunctionName
// ---------------------------------------------------------------------------

/**
 * prop_extractEntryFunctionName_finds_export_function
 *
 * Given a source string with `export function <name>(`, extractEntryFunctionName
 * returns exactly that function name.
 *
 * Invariant (A6.3): the regex matches the first `export function` or
 * `export async function` line and returns the identifier.
 */
export const prop_extractEntryFunctionName_finds_export_function = fc.property(
  fc.constantFrom(
    ["export function add(a: number, b: number): number { return a + b; }", "add"],
    ["export async function fetch(): Promise<void> {}", "fetch"],
    ["export function identity<T>(v: T): T { return v; }", "identity"],
    [
      "export function nonAsciiRejector(s: string): boolean { return /^[\\x00-\\x7F]*$/.test(s); }",
      "nonAsciiRejector",
    ],
  ) as fc.Arbitrary<[string, string]>,
  ([source, expectedName]) => {
    const found = extractEntryFunctionName(source);
    return found === expectedName;
  },
);

/**
 * prop_extractEntryFunctionName_returns_null_for_no_export
 *
 * When no `export function` or `export async function` line is present,
 * extractEntryFunctionName returns null.
 *
 * Invariant (A6.3): the function scans all lines but returns null if none
 * match the export function pattern. Callers must handle null gracefully.
 */
export const prop_extractEntryFunctionName_returns_null_for_no_export = fc.property(
  fc.constantFrom(
    "const x = 1;",
    "type Foo = { bar: string };",
    "function helper() {}", // no export keyword
    "import type { X } from './x.js';",
    "",
  ),
  (source) => {
    const found = extractEntryFunctionName(source);
    return found === null;
  },
);

// ---------------------------------------------------------------------------
// A6.4: assembleModule
// ---------------------------------------------------------------------------

/**
 * prop_assembleModule_includes_header_comment
 *
 * The assembled module always begins with the "Assembled by @yakcc/compile" header
 * comment, regardless of block contents.
 *
 * Invariant (A6.4): assembleModule always prepends the header comment identifying
 * the source as a compiled artifact that must not be edited by hand.
 */
export const prop_assembleModule_includes_header_comment = fc.property(
  blockRootArb,
  specHashArb,
  fc.string({ minLength: 0, maxLength: 20 }),
  (root, specHash, source) => {
    const resolution = makeSingleBlockResolution(root, specHash, source);
    const output = assembleModule(resolution);
    return output.includes("Assembled by @yakcc/compile");
  },
);

/**
 * prop_assembleModule_deduplicates_contracts_imports
 *
 * When two blocks each import different symbols from @yakcc/contracts, the
 * assembled module contains exactly one `import type { ... } from "@yakcc/contracts"` line.
 *
 * Invariant (A6.4, DEC-COMPILE-TS-BACKEND-001 §3): assembleModule collects all
 * @yakcc/contracts symbols from all blocks and emits one deduplicated import.
 */
export const prop_assembleModule_deduplicates_contracts_imports = fc.property(
  blockRootArb,
  specHashArb,
  blockRootArb,
  specHashArb,
  (root1, spec1, root2, spec2) => {
    fc.pre(root1 !== root2);
    const src1 = `import type { ContractSpec } from "@yakcc/contracts";
export function leaf(): void {}`;
    const src2 = `import type { ContractSpec } from "@yakcc/contracts";
import type { Leaf } from "@yakcc/seeds/blocks/leaf";
export function entry(): void {}`;
    const resolution: ResolutionResult = {
      entry: root2,
      blocks: new Map([
        [root1, { merkleRoot: root1, specHash: spec1, source: src1, subBlocks: [] }],
        [root2, { merkleRoot: root2, specHash: spec2, source: src2, subBlocks: [root1] }],
      ]),
      order: [root1, root2],
    };
    const output = assembleModule(resolution);
    // Count occurrences of the contracts import line
    const matches = output.match(/import type \{[^}]*\} from "@yakcc\/contracts"/g);
    return matches !== null && matches.length === 1;
  },
);

/**
 * prop_assembleModule_re_exports_entry_function
 *
 * The assembled module ends with a re-export of the entry block's primary function.
 *
 * Invariant (A6.4, DEC-COMPILE-TS-BACKEND-001 §6): assembleModule appends
 * `export { <fnName> };` for the entry block's first exported function name.
 */
export const prop_assembleModule_re_exports_entry_function = fc.property(
  blockRootArb,
  specHashArb,
  fc.constantFrom("compute", "transform", "validate", "process"),
  (root, specHash, fnName) => {
    const source = `export function ${fnName}(x: number): number { return x; }`;
    const resolution = makeSingleBlockResolution(root, specHash, source);
    const output = assembleModule(resolution);
    return output.includes(`export { ${fnName} }`);
  },
);

// ---------------------------------------------------------------------------
// A6.5: tsBackend — factory invariants
// ---------------------------------------------------------------------------

/**
 * prop_tsBackend_name_is_ts
 *
 * The Backend returned by tsBackend() always has name === "ts".
 *
 * Invariant (A6.5, A6.10): the name field identifies the backend type;
 * "ts" is the canonical name for the TypeScript source concatenation backend.
 */
export const prop_tsBackend_name_is_ts = fc.property(fc.constant(null), () => {
  const backend = tsBackend();
  return backend.name === "ts";
});

/**
 * prop_tsBackend_emit_returns_string
 *
 * tsBackend().emit(resolution) returns a non-empty string for any single-block
 * resolution. The emitted string includes the assembly header comment.
 *
 * Invariant (A6.5, A6.10): emit is an async function that resolves to a string;
 * it does not throw for valid ResolutionResult inputs.
 */
export const prop_tsBackend_emit_returns_string = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const source = "export function run(): void {}";
    const resolution = makeSingleBlockResolution(root, specHash, source);
    const backend = tsBackend();
    const output = await backend.emit(resolution);
    return typeof output === "string" && output.length > 0 && output.includes("Assembled by");
  },
);

/**
 * prop_tsBackend_emit_deterministic
 *
 * Two consecutive calls to tsBackend().emit with the same resolution produce
 * byte-identical output.
 *
 * Invariant (A6.4, DEC-COMPILE-TS-BACKEND-001): the backend is a pure function
 * of the resolution; no random state or timestamps are included in the output.
 * This underpins the byte-identical re-emit invariant.
 */
export const prop_tsBackend_emit_deterministic = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  fc.string({ minLength: 0, maxLength: 30 }),
  async (root, specHash, extraSource) => {
    const source = `export function compute(): void { const x = ${JSON.stringify(extraSource)}; }`;
    const resolution = makeSingleBlockResolution(root, specHash, source);
    const backend = tsBackend();
    const out1 = await backend.emit(resolution);
    const out2 = await backend.emit(resolution);
    return out1 === out2;
  },
);
