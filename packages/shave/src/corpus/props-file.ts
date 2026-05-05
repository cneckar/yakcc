// SPDX-License-Identifier: MIT
// props-file.ts — Corpus source (d): sibling *.props.ts file discovery and extraction.
//
// @decision DEC-V2-PREFLIGHT-L8-BOOTSTRAP-PROPS-001
// @title Props-file corpus source: sibling discovery + prop_<atom>_* name-based mapping
// @status accepted
// @rationale
//   The *.props.ts two-file convention (DEC-V2-PROPTEST-PATH-A-001) places a hand-authored
//   property-test corpus alongside each source file:
//     source:    packages/<pkg>/src/<file>.ts
//     companion: packages/<pkg>/src/<file>.props.ts
//
//   Discovery: check for a sibling file with .props.ts extension at the same directory as
//   the source file.
//
//   Mapping (name-based, per issue #101 recommendation A): exported identifiers matching
//   the pattern `prop_<atomName>_*` belong to the atom whose primary export name is
//   `<atomName>`. The atom name is inferred from the source text by finding the first
//   exported function or const declaration (matching the same heuristic as
//   corpus/upstream-test.ts::inferFunctionName, extended for `export function` and
//   `export const`).
//
//   If no sibling file exists OR the file contains no `prop_<atomName>_*` exports matching
//   this atom → returns undefined so the caller falls back to source (a)/(b)/(c).
//
//   Determinism guarantee: the result is a pure function of the source file path and the
//   sibling .props.ts content. Re-running bootstrap from a clean checkout produces a
//   byte-identical manifest (Sacred Practice determinism).
//
//   Glue awareness (DEC-V2-GLUE-AWARE-SHAVE-001): atoms classified as `glue` by the
//   slicer do not reach persistNovelGlueAtom (they are never stored in the registry).
//   This function's undefined return for unrecognized atom names naturally handles the
//   glue case — foreign imports and unsupported AST nodes have no prop_* exports and
//   get undefined, which causes the caller to use the auto-generated placeholder.
//   There is no "glue sentinel" needed here because glue never reaches the corpus path.
//
//   Content: when a match is found, the ENTIRE props file is used as the corpus artifact.
//   Rationale: the props file includes shared arbitraries, imports, and helpers that are
//   required for the relevant prop_* exports to be self-contained and executable. Slicing
//   out only the matching props would break their arbitraries and import dependencies.
//
//   Authority invariant L8-I1: this is the single canonical location for props-file
//   discovery. All consumers must use extractFromPropsFile(); no parallel discovery logic.
//
//   DEC-V2-PROPTEST-PATH-A-001 is consumed (not modified) here. See packages/contracts/src/
//   and packages/ir/src/ for authoring examples.

import { existsSync, readFileSync } from "node:fs";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import type { CorpusResult } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Canonical artifact path for props-file-sourced property-test corpora.
 *
 * Distinct from upstream-test's "property-tests.fast-check.ts" to allow
 * the audit script to distinguish sources (though in practice both resolve
 * to the same kind="property_tests" manifest entry).
 *
 * L8-I2: this constant is the single source of truth for the artifact path.
 */
export const PROPS_FILE_CORPUS_PATH = "property-tests.props-file.ts";

/**
 * Placeholder markers that, if found in props-file content, indicate the file
 * is itself a generated stub rather than a hand-authored corpus.
 *
 * In practice, hand-authored .props.ts files NEVER contain these strings.
 * This is a safety check: if the .props.ts file was accidentally generated
 * rather than hand-authored, we should fall back rather than claim it's real.
 *
 * Exported so tests can assert that results do not contain these markers.
 */
export const PROPS_FILE_PLACEHOLDER_MARKERS: readonly string[] = [
  "fc.pre(true); // placeholder",
  "return true; // placeholder",
  "// TODO: Replace with typed arbitrary",
  "Auto-generated property-test corpus (source: upstream-test adaptation)",
] as const;

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempt to extract a corpus from the sibling `<file>.props.ts` companion of
 * `sourceFilePath`, scoped to the atom whose primary exported name appears in
 * `atomSource`.
 *
 * Returns a CorpusResult when:
 *   1. A sibling `<dir>/<base>.props.ts` file exists next to `sourceFilePath`.
 *   2. The props file contains at least one `prop_<atomName>_*` export matching
 *      the atom's primary exported name.
 *   3. The props file content does not contain placeholder sentinel markers.
 *
 * Returns `undefined` when any of these conditions is not met. Callers should
 * fall back to lower-priority corpus sources (upstream-test, documented-usage,
 * ai-derived) when undefined is returned.
 *
 * @param atomSource     - Raw source text of the specific atom being processed.
 *                         Used to infer the atom's exported name.
 * @param sourceFilePath - Absolute path of the source file containing the atom.
 *                         The sibling `.props.ts` is resolved relative to this.
 * @returns CorpusResult with source="props-file", or undefined if no match.
 */
export function extractFromPropsFile(
  atomSource: string,
  sourceFilePath: string,
): CorpusResult | undefined {
  // Step 1: infer the atom name from the source text.
  const atomName = inferExportedName(atomSource);
  if (atomName === undefined) {
    // No recognizable exported name — glue/import/expression atom. No corpus.
    return undefined;
  }

  // Step 2: resolve the sibling .props.ts path.
  const propsFilePath = resolvePropsFilePath(sourceFilePath);
  if (!existsSync(propsFilePath)) {
    return undefined;
  }

  // Step 3: read the props file content.
  let propsContent: string;
  try {
    propsContent = readFileSync(propsFilePath, "utf-8");
  } catch {
    // Unreadable file — fall back gracefully.
    return undefined;
  }

  // Step 4: check for placeholder markers (safety guard against generated props files).
  for (const marker of PROPS_FILE_PLACEHOLDER_MARKERS) {
    if (propsContent.includes(marker)) {
      return undefined;
    }
  }

  // Step 5: verify the props file contains at least one prop_<atomName>_* export.
  const propPrefix = `prop_${atomName}_`;
  if (!propsContent.includes(propPrefix)) {
    // No props for this specific atom in this file — fall back.
    return undefined;
  }

  // Step 6: build the CorpusResult from the full props file content.
  // We use the ENTIRE props file (not just the matching props) because:
  //   - Shared arbitraries and imports at the top of the file are required by
  //     the prop_* exports; slicing them out would break executability.
  //   - The full file provides context for code review and auditing.
  const bytes = encoder.encode(propsContent);
  const contentHash = bytesToHex(blake3(bytes));

  return {
    source: "props-file",
    bytes,
    path: PROPS_FILE_CORPUS_PATH,
    contentHash,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the sibling `.props.ts` path for a given source file.
 *
 * Convention: `<dir>/<base>.props.ts` where `<dir>` and `<base>` are derived
 * from `sourceFilePath`. The `.ts` extension is replaced with `.props.ts`.
 *
 * Examples:
 *   packages/contracts/src/contract-id.ts → packages/contracts/src/contract-id.props.ts
 *   packages/ir/src/strict-subset.ts      → packages/ir/src/strict-subset.props.ts
 */
function resolvePropsFilePath(sourceFilePath: string): string {
  // Replace the trailing .ts extension with .props.ts.
  // This handles both .ts and .tsx files, though .props.tsx is not a convention.
  const withoutExt = sourceFilePath.replace(/\.tsx?$/, "");
  return `${withoutExt}.props.ts`;
}

/**
 * Infer the primary exported name from a TypeScript source text.
 *
 * Looks for the first occurrence of any of these patterns (in priority order):
 *   1. `export function <name>` — named function export
 *   2. `export async function <name>` — async function export
 *   3. `export const <name>` — const export (function expression or value)
 *   4. `export class <name>` — class export
 *   5. Non-exported fallback: `function <name>` — anonymous/inner helper
 *   6. Non-exported fallback: `const <name> =` — non-exported const
 *
 * Returns undefined when no pattern matches (e.g. pure import statements,
 * expression-only fragments, glue atoms with no declaration).
 *
 * @decision DEC-V2-PREFLIGHT-L8-BOOTSTRAP-PROPS-001 (mapping convention)
 * Name-based mapping is used (option A from issue #101) because:
 *   - It is predictable: authors know the atom name = the primary export name.
 *   - It matches the existing prop_<atom>_<property> authoring convention in all
 *     18 existing .props.ts files.
 *   - Signature-based matching (option B) is harder to debug when it fails.
 *   Implementers: if option B is ever needed, add a secondary lookup here.
 */
function inferExportedName(source: string): string | undefined {
  // Priority 1: `export function <name>` or `export async function <name>`
  const exportFnMatch = source.match(
    /(?:^|\n|\s)export\s+(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/,
  );
  if (exportFnMatch?.[1]) return exportFnMatch[1];

  // Priority 2: `export const <name>` (catches both values and function expressions)
  const exportConstMatch = source.match(
    /(?:^|\n|\s)export\s+(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/,
  );
  if (exportConstMatch?.[1]) return exportConstMatch[1];

  // Priority 3: `export class <name>`
  const exportClassMatch = source.match(
    /(?:^|\n|\s)export\s+(?:default\s+)?class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/,
  );
  if (exportClassMatch?.[1]) return exportClassMatch[1];

  // Priority 4: non-exported function (common in atoms extracted from inner functions)
  const fnMatch = source.match(/(?:^|\s)function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
  if (fnMatch?.[1]) return fnMatch[1];

  // Priority 5: non-exported const
  const constMatch = source.match(/(?:^|\s)(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/);
  if (constMatch?.[1]) return constMatch[1];

  return undefined;
}
