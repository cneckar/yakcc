// SPDX-License-Identifier: MIT
// @decision DEC-V2-07-PREFLIGHT-L8-001
// title: props-file extraction uses name-based prop_<atom>_<property> mapping, whole-file corpus
// status: accepted (WI-V2-07-PREFLIGHT L8)
// rationale:
//   The props-file source is the highest-priority corpus extractor. When a sibling
//   *.props.ts file exists adjacent to the atom's source file, this extractor:
//     1. Reads the props file.
//     2. Infers the atom function name from the atom source text.
//     3. Checks whether any prop_<atomName>_* export exists in the props file.
//     4. If found, uses the ENTIRE props file content as the corpus bytes.
//
//   Whole-file strategy (vs per-export extraction): the props file is authored
//   per-source-file, not per-atom. It typically contains cross-atom helper
//   arbitraries (e.g. contractSpecArb in merkle.props.ts) that are shared between
//   prop_* exports. Extracting only matching exports would silently drop these
//   dependencies, producing a broken corpus artifact. Using the whole file avoids
//   this and is correct since the file IS the property suite for all atoms in
//   the sibling source.
//
//   DEC-V2-GLUE-AWARE-SHAVE-001: glue atoms (kind="glue") have no intentCard and
//   are never passed to extractCorpus(); this extractor is never called for glue.

import { readFile } from "node:fs/promises";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import type { CorpusResult, IntentCardInput } from "./types.js";

const encoder = new TextEncoder();

/**
 * Canonical artifact path for props-file corpus results.
 * Parameterized by atom name so different atoms get distinct manifest paths.
 */
function propsArtifactPath(atomName: string): string {
  return `${atomName}.props.ts`;
}

/**
 * Attempt to extract a property-test corpus from a sibling *.props.ts file.
 *
 * Reads propsFilePath and checks whether it contains any `prop_<atomName>_*`
 * export corresponding to the atom's function name (inferred from `source`).
 * If found, returns the entire file content as the corpus artifact.
 *
 * Returns undefined when:
 *   - The file does not exist or cannot be read.
 *   - No function name can be inferred from the atom source.
 *   - No prop_<atomName>_* export is found in the props file.
 *
 * Callers should fall through to the next source in the priority chain when
 * this function returns undefined.
 *
 * @param propsFilePath - Absolute path to the sibling *.props.ts file.
 * @param _intentCard   - Unused (kept for signature symmetry with other extractors).
 * @param source        - Raw source text of the atom; used to infer the function name.
 * @returns A CorpusResult with source="props-file", or undefined on no match.
 */
export async function extractFromPropsFile(
  propsFilePath: string,
  _intentCard: IntentCardInput,
  source: string,
): Promise<CorpusResult | undefined> {
  let fileContent: string;
  try {
    fileContent = await readFile(propsFilePath, "utf-8");
  } catch {
    return undefined;
  }

  const atomName = inferFunctionName(source);
  if (atomName === undefined) {
    return undefined;
  }

  // Check whether any prop_<atomName>_* export exists (name-based mapping).
  // The regex uses a word boundary before `prop_` to avoid false matches on
  // names like `my_prop_foo_bar` (which would not be a valid prop export).
  // Escape regex meta chars in atomName before substitution. Fixes #165: identifiers
  // like `$` or `$0` contain regex metacharacters (notably `$` as end-of-input anchor)
  // that would silently break the match when interpolated unescaped.
  const escapedAtomName = atomName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`(?:^|\\s|;)export\\s+const\\s+prop_${escapedAtomName}_`).test(fileContent)) {
    return undefined;
  }

  const bytes = encoder.encode(fileContent);
  const contentHash = bytesToHex(blake3(bytes));

  return {
    source: "props-file",
    bytes,
    path: propsArtifactPath(atomName),
    contentHash,
  };
}

/**
 * Infer the primary function name from a source string.
 * Mirrors the same helper used in upstream-test.ts and documented-usage.ts.
 */
function inferFunctionName(source: string): string | undefined {
  const fnMatch = source.match(/(?:^|\s)function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
  if (fnMatch?.[1]) return fnMatch[1];

  const constMatch = source.match(/(?:^|\s)(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/);
  if (constMatch?.[1]) return constMatch[1];

  return undefined;
}
