// SPDX-License-Identifier: MIT
// @decision DEC-V2-07-PREFLIGHT-L8-001
// title: props-file extraction uses name-based prop_<atom>_<property> mapping, whole-file corpus
// status: accepted (WI-V2-07-PREFLIGHT L8)
// rationale:
//   When a sibling *.props.ts file exists alongside the source file being shaved,
//   and it contains at least one `export const prop_<atomName>_` export matching the
//   atom's function name, the entire .props.ts file is used as the corpus artifact.
//   This is "source (0)" in the priority chain — it takes precedence over all
//   auto-generated sources (upstream-test, documented-usage, ai-derived) because
//   hand-authored fast-check properties are always higher quality than generated stubs.
//
//   Whole-file strategy: the entire .props.ts file is emitted as-is rather than
//   filtering to only the matching prop_<atomName>_* exports. This preserves shared
//   arbitraries, helper functions, and imports that multiple property exports depend on.
//
//   Name inference: the atom name is inferred from the source text by matching the
//   first `function <name>` or `const <name> =` declaration. This mirrors the logic
//   in upstream-test.ts (inferFunctionName). If no name can be inferred, the source
//   returns undefined (no match).

import { readFile } from "node:fs/promises";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import type { CorpusResult, IntentCardInput } from "./types.js";

const encoder = new TextEncoder();

/**
 * Attempt to infer the primary function name from a source string.
 *
 * Mirrors inferFunctionName() in upstream-test.ts — looks for the first
 * `function <name>` or `const/let/var <name> =` declaration.
 */
function inferFunctionName(source: string): string | undefined {
  const fnMatch = source.match(/(?:^|\s)function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
  if (fnMatch?.[1]) return fnMatch[1];

  const constMatch = source.match(/(?:^|\s)(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/);
  if (constMatch?.[1]) return constMatch[1];

  return undefined;
}

/**
 * Extract a property-test corpus from a sibling *.props.ts file.
 *
 * This is corpus extraction source (0): props-file. It takes priority over all
 * auto-generated sources (upstream-test, documented-usage, ai-derived).
 *
 * Returns undefined when:
 *   - The props file does not exist (ENOENT or other read error).
 *   - No function name can be inferred from the atom source.
 *   - The props file contains no `export const prop_<atomName>_` exports.
 *
 * When successful, returns a CorpusResult whose bytes are the entire props file
 * content (UTF-8 encoded) and whose path is `<atomName>.props.ts`.
 *
 * @param propsFilePath - Absolute path to the sibling *.props.ts file.
 * @param _intentCard   - The intent card (unused; reserved for future filtering).
 * @param source        - The raw source text of the atom (used for name inference).
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
  if (atomName === undefined) return undefined;

  // Check that the props file contains at least one prop_<atomName>_ export.
  if (!new RegExp(`(?:^|[\\s;])export\\s+const\\s+prop_${atomName}_`).test(fileContent)) {
    return undefined;
  }

  const bytes = encoder.encode(fileContent);
  return {
    source: "props-file",
    bytes,
    path: `${atomName}.props.ts`,
    contentHash: bytesToHex(blake3(bytes)),
  };
}
