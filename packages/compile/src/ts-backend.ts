// SPDX-License-Identifier: MIT
// @decision DEC-COMPILE-TS-BACKEND-001: The TS backend assembles a single-file module
// by concatenating block sources in topological order (leaves first, entry last),
// deduplicating type imports from @yakcc/contracts, stripping intra-corpus import
// statements, type aliases, CONTRACT declarations, and re-exporting the entry block's
// primary function as the module's public surface.
// Status: updated (WI-T04) — block separator comment now uses BlockMerkleRoot instead
// of ContractId. The emit logic itself is unchanged; only the identity type used in
// comments and the block-map key type changed (BlockMerkleRoot ↔ ContractId).
// Original decision recorded at WI-005.
// Rationale: Blocks are self-contained — each inlines its sub-block logic rather than
// calling sibling functions at runtime. Composition is documented via "import type"
// declarations only. The backend therefore:
//   (1) strips "import type { X } from './X.js'" lines (sub-block composition refs)
//   (2) strips "type _X = typeof X" shadow-type aliases that reference stripped imports
//   (3) deduplicates "import type { ContractSpec } from '@yakcc/contracts'" to one header
//   (4) strips "export const CONTRACT = {...};" multi-line declarations (type metadata only;
//       every block exports it so it would cause duplicate-export errors in the assembled
//       module; it is not needed at runtime — only the function export is)
//   (5) concatenates the cleaned sources in topological order
//   (6) appends a re-export of the entry function
// No code is generated — only composition of registry-stored block sources.
//
// @decision DEC-COMPILE-TS-BACKEND-AST-001: Import stripping uses line-level string
// processing rather than ts-morph AST manipulation.
// Status: decided (WI-005)
// Rationale: The seeds blocks follow a predictable structure. Line-level processing is
// simpler, faster, and has no risk of reformatting block source (which must be preserved
// verbatim per the no-code-generation constraint). ts-morph would be accurate for
// arbitrary input but the strict-subset validator already guarantees the block sources
// are well-formed; line-level processing is sufficient and measurably cheaper.

import type { BlockMerkleRoot } from "@yakcc/contracts";
import type { ResolutionResult } from "./resolve.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A compilation backend: turns a ResolutionResult into a string of module source.
 *
 * No code is generated — only composition of registry-stored block sources.
 */
export interface Backend {
  readonly name: string;
  emit(resolution: ResolutionResult): Promise<string>;
}

// ---------------------------------------------------------------------------
// Internal: line-level source transformation
// ---------------------------------------------------------------------------

/**
 * Patterns that identify intra-corpus type import lines in a block source.
 *
 * These are the "import type { X } from './X.js'" declarations that document
 * composition but are not runtime dependencies. In the assembled module all
 * referenced blocks appear in the same file, so these imports are unnecessary
 * and would cause TypeScript to complain about missing modules.
 *
 * We match any "import type" line whose module specifier starts with "./"
 * or "@yakcc/seeds/" or "@yakcc/blocks/" — the same prefixes used by parseBlock.
 */
const INTRA_CORPUS_IMPORT_RE =
  /^import type\s+\{[^}]*\}\s+from\s+["'](\.|@yakcc\/seeds\/|@yakcc\/blocks\/)[^"']*["'];?\s*$/;

/**
 * Pattern that identifies shadow type alias lines ("type _X = typeof X").
 *
 * These suppress TypeScript's "imported but not used as a value" error for the
 * intra-corpus import type declarations. Once those imports are stripped, the
 * corresponding type aliases must also be stripped to avoid "cannot find name" errors.
 */
const SHADOW_TYPE_ALIAS_RE = /^type\s+_\w+\s*=\s*typeof\s+\w+\s*;?\s*$/;

/**
 * Pattern that identifies "import type { ContractSpec } from '@yakcc/contracts'"
 * and similar type-only imports from @yakcc/contracts. These are deduplicated to
 * a single import at the top of the assembled module.
 */
const CONTRACTS_IMPORT_RE = /^import type\s+\{[^}]*\}\s+from\s+["']@yakcc\/contracts["'];?\s*$/;

/**
 * Pattern that identifies the opening line of an "export const CONTRACT = {" declaration.
 *
 * Every block exports a CONTRACT constant containing its ContractSpec. When multiple
 * blocks are concatenated, this creates duplicate named exports which cause parse errors
 * in any ESM bundler/runtime. The CONTRACT value is type metadata only — it is not
 * needed at runtime in the assembled module (only the function export is). We strip the
 * entire multi-line declaration using brace-depth tracking in cleanBlockSource.
 */
const CONTRACT_EXPORT_START_RE = /^export const CONTRACT(?:\s*:\s*ContractSpec)?\s*=\s*\{/;

/**
 * Clean a single block's source for inclusion in the assembled module.
 *
 * - Strip intra-corpus import type lines (sub-block composition declarations)
 * - Strip shadow type alias lines (type _X = typeof X)
 * - Strip @yakcc/contracts import lines (deduplicated separately)
 * - Strip the entire "export const CONTRACT = {...};" multi-line declaration
 *   (present in every block; causes duplicate export errors in the assembled module)
 *
 * Returns the cleaned source with leading blank lines removed.
 */
function cleanBlockSource(source: string): string {
  const lines = source.split("\n");
  const cleaned: string[] = [];

  // Brace-depth counter used to skip the multi-line CONTRACT declaration.
  // When > 0, we are inside the declaration and suppress all lines until depth returns to 0.
  let contractDepth = 0;

  for (const line of lines) {
    // If we are inside a CONTRACT declaration, track brace depth and skip lines.
    if (contractDepth > 0) {
      for (const ch of line) {
        if (ch === "{") contractDepth++;
        else if (ch === "}") contractDepth--;
      }
      // contractDepth reached 0 means the closing brace of the declaration was on this line.
      // The line itself is part of the declaration — do not emit it.
      continue;
    }

    // Detect start of "export const CONTRACT = {" (may be multi-line).
    if (CONTRACT_EXPORT_START_RE.test(line)) {
      // Count braces on the opening line to determine if it closes on the same line.
      for (const ch of line) {
        if (ch === "{") contractDepth++;
        else if (ch === "}") contractDepth--;
      }
      // Skip this line regardless; if contractDepth is already 0, the declaration
      // was single-line (e.g. "export const CONTRACT = {};") — still drop it.
      continue;
    }

    if (INTRA_CORPUS_IMPORT_RE.test(line)) continue;
    if (SHADOW_TYPE_ALIAS_RE.test(line)) continue;
    if (CONTRACTS_IMPORT_RE.test(line)) continue;
    cleaned.push(line);
  }

  // Remove leading blank lines from the cleaned block.
  let start = 0;
  while (start < cleaned.length && cleaned[start]?.trim() === "") {
    start++;
  }

  return cleaned.slice(start).join("\n");
}

/**
 * Extract all ContractSpec type symbols from @yakcc/contracts import lines.
 *
 * Multiple blocks may import different symbols (e.g. ContractSpec, ContractId).
 * We collect the union of all imported symbols and emit one deduped import.
 */
function extractContractsImports(source: string): string[] {
  const symbols: string[] = [];
  for (const line of source.split("\n")) {
    const match = line.match(/^import type\s+\{([^}]*)\}\s+from\s+["']@yakcc\/contracts["'];?\s*$/);
    if (match?.[1]) {
      for (const sym of match[1].split(",")) {
        const trimmed = sym.trim();
        if (trimmed.length > 0) symbols.push(trimmed);
      }
    }
  }
  return symbols;
}

/**
 * Extract the primary exported function name from a block source.
 *
 * Looks for the first "export function <name>" or "export async function <name>" line.
 * Returns null if none is found.
 */
function extractEntryFunctionName(source: string): string | null {
  for (const line of source.split("\n")) {
    const match = line.match(/^export\s+(?:async\s+)?function\s+(\w+)\s*[(<]/);
    if (match?.[1]) return match[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal: full module assembly
// ---------------------------------------------------------------------------

function assembleModule(resolution: ResolutionResult): string {
  // Pass 1: collect all @yakcc/contracts type imports across all blocks.
  const allContractsSymbols = new Set<string>();
  for (const merkleRoot of resolution.order) {
    const block = resolution.blocks.get(merkleRoot);
    if (block === undefined) continue;
    for (const sym of extractContractsImports(block.source)) {
      allContractsSymbols.add(sym);
    }
  }

  const parts: string[] = [];

  // Header comment.
  parts.push(
    [
      "// Assembled by @yakcc/compile — do not edit by hand.",
      "// Every block is reproduced verbatim from the registry; no code was generated.",
    ].join("\n"),
  );

  // Deduped @yakcc/contracts import (omit if nothing was collected).
  if (allContractsSymbols.size > 0) {
    const symbols = [...allContractsSymbols].sort().join(", ");
    parts.push(`import type { ${symbols} } from "@yakcc/contracts";`);
  }

  // Pass 2: emit each block's cleaned source in topological order (leaves first).
  for (const merkleRoot of resolution.order) {
    const block = resolution.blocks.get(merkleRoot);
    if (block === undefined) continue;

    const cleaned = cleanBlockSource(block.source);
    if (cleaned.trim().length === 0) continue;

    parts.push(`\n// --- block: ${merkleRoot} ---\n${cleaned}`);
  }

  // Re-export the entry function as the module's named public surface.
  const entryBlock = resolution.blocks.get(resolution.entry);
  if (entryBlock !== undefined) {
    const fnName = extractEntryFunctionName(entryBlock.source);
    if (fnName !== null) {
      parts.push(`\n// Re-export entry function as module public surface.\nexport { ${fnName} };`);
    }
  }

  return `${parts.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create the built-in TypeScript backend.
 *
 * The backend concatenates block sources in topological order, deduplicates
 * @yakcc/contracts type imports, strips intra-corpus import declarations, and
 * re-exports the entry block's primary function.
 *
 * No code is generated — only composition of registry-stored block sources.
 */
export function tsBackend(): Backend {
  return {
    name: "ts",
    async emit(resolution: ResolutionResult): Promise<string> {
      return assembleModule(resolution);
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helper exported for testing
// ---------------------------------------------------------------------------

/** @internal — exposed for ts-backend unit tests only. */
export { cleanBlockSource, extractEntryFunctionName, assembleModule };

// Unused import suppression for BlockMerkleRoot (used in ResolutionResult type).
type _BlockMerkleRoot = BlockMerkleRoot;
