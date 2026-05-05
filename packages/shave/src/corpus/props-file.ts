// SPDX-License-Identifier: MIT
// @decision DEC-V2-07-PREFLIGHT-L8-001
// title: Props-file corpus extraction uses name-based convention (option a)
// status: decided (WI-V2-07-PREFLIGHT-L8)
// rationale:
//   Two mapping algorithms were considered:
//   (a) Name-based: prop_<atomName>_<description> where <atomName> matches the
//       canonical function name inferred from the atom's source text via regex.
//       Predictable, requires authoring discipline, zero runtime cost.
//   (b) Signature-based: parse fast-check arbitrary types and match to atom
//       signature. Robust but significantly harder to implement and debug.
//   Option (a) is adopted as the starting convention. The atom name is the
//   FIRST underscore-delimited token after the `prop_` prefix, e.g.
//   `prop_serializeEmbedding_round_trip` → atom `serializeEmbedding`. This
//   maps directly to the function name inferred by inferAtomName() below.
//   Option (b) can be added as a future fallback if (a) proves brittle.
//
// Corpus bytes policy:
//   When an atom has ≥1 matching prop_<atomName>_* export, the ENTIRE
//   *.props.ts file is used as the corpus bytes. This is intentional:
//   (i)  The .props.ts file contains shared arbitraries and imports that
//        the individual prop_* functions depend on. Extracting a subset
//        would require tracking transitive symbol dependencies.
//   (ii) The full file is a genuine fast-check property-test file with no
//        placeholder markers — the audit script will classify it as
//        "present-real" for all covered atoms.
//   (iii) Registry content-addressing differentiates atoms via spec/impl
//        hashes, not via the corpus bytes alone, so identical corpus bytes
//        across atoms from the same source file is architecturally sound.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import type { CorpusResult } from "./types.js";

const encoder = new TextEncoder();

/**
 * Infer the primary function/constant name from an atom's source text.
 *
 * Mirrors the logic in corpus/upstream-test.ts inferFunctionName() so both
 * use the same name-extraction convention. Returns undefined if no name can
 * be determined (rare: bare expression blocks without any declaration).
 */
function inferAtomName(source: string): string | undefined {
  const fnMatch = source.match(/(?:^|\s)function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
  if (fnMatch?.[1]) return fnMatch[1];

  const constMatch = source.match(
    /(?:^|\s)(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/,
  );
  if (constMatch?.[1]) return constMatch[1];

  return undefined;
}

/**
 * Extract the atom-name prefix from a `prop_*` export name.
 *
 * Convention (DEC-V2-07-PREFLIGHT-L8-001 option a):
 *   prop_<atomName>_<description...>
 * The atom name is the first underscore-delimited token after the `prop_` prefix.
 *
 * Examples:
 *   prop_serializeEmbedding_round_trip  → "serializeEmbedding"
 *   prop_bytesToHex_length_is_double    → "bytesToHex"
 *   prop_makeProject_consistent_state   → "makeProject"
 */
function propExportAtomName(exportName: string): string | undefined {
  // Must start with "prop_"
  if (!exportName.startsWith("prop_")) return undefined;
  const rest = exportName.slice("prop_".length);
  const underscoreIdx = rest.indexOf("_");
  // Must have at least one more segment (atom name + description)
  if (underscoreIdx === -1) return undefined;
  return rest.slice(0, underscoreIdx);
}

/**
 * Check whether a *.props.ts file exports any `prop_<atomName>_*` entries for
 * the given atom name.
 *
 * Uses a lightweight regex scan rather than a full AST parse: we look for
 * `export const prop_<atomName>_` anywhere in the file text. This avoids
 * importing ts-morph in the hot path and is sufficient for the authoring
 * convention used in *.props.ts files.
 */
function hasMatchingExports(fileText: string, atomName: string): boolean {
  const pattern = new RegExp(`\\bexport\\s+const\\s+prop_${escapeRegex(atomName)}_`);
  return pattern.test(fileText);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Attempt to extract a property-test corpus from a sibling *.props.ts file.
 *
 * This is source (0) in the priority chain — higher priority than upstream-test.
 *
 * @param propsFilePath - Absolute path to the *.props.ts file (sibling of the source).
 * @param atomSource    - Raw source text of the atom being persisted.
 * @returns A CorpusResult when the file contains ≥1 matching prop_* export;
 *          undefined when the atom has no matching exports (caller falls through
 *          to source (a) upstream-test).
 */
export function extractFromPropsFile(
  propsFilePath: string,
  atomSource: string,
): CorpusResult | undefined {
  const atomName = inferAtomName(atomSource);
  if (atomName === undefined) {
    // Cannot infer atom name — skip props-file lookup.
    return undefined;
  }

  let fileText: string;
  try {
    fileText = readFileSync(propsFilePath, "utf-8");
  } catch {
    // File not readable (shouldn't happen since caller checks existsSync, but
    // be defensive — fall through to source (a)).
    return undefined;
  }

  if (!hasMatchingExports(fileText, atomName)) {
    // No matching prop_<atomName>_* exports in this file — fall through.
    return undefined;
  }

  // Matching exports found. Use the entire *.props.ts file as the corpus.
  // See rationale at the top of this file for why we use the full file.
  const bytes = encoder.encode(fileText);
  const contentHash = bytesToHex(blake3(bytes));
  const path = basename(propsFilePath);

  return {
    source: "props-file",
    bytes,
    path,
    contentHash,
  };
}

// Re-export for tests to verify the internal convention helpers.
export { inferAtomName, propExportAtomName, hasMatchingExports };
