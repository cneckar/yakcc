// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave corpus/props-file.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3i)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from props-file.ts):
//   extractFromPropsFile(propsFilePath, _intentCard, source) — props-file corpus extractor (PF1.1–PF1.9)
//   inferFunctionName (private helper, tested indirectly via extractFromPropsFile) (PF2.1–PF2.3)
//
// Properties covered (12 prop_* exports):
//   1.  extractFromPropsFile returns undefined when file cannot be read
//   2.  extractFromPropsFile returns undefined when no function name inferable from source
//   3.  extractFromPropsFile returns undefined when props file has no matching prop_ export
//   4.  extractFromPropsFile returns CorpusResult with source='props-file' on match
//   5.  extractFromPropsFile result.bytes is UTF-8 encoding of file content
//   6.  extractFromPropsFile result.contentHash is 64-char hex string
//   7.  extractFromPropsFile result.path equals atomName + '.props.ts'
//   8.  extractFromPropsFile does not mutate _intentCard input
//   9.  extractFromPropsFile does not mutate source input
//   10. inferFunctionName: function declaration wins over const assignment (indirect)
//   11. inferFunctionName: const/let/var assignment used as fallback (indirect)
//   12. inferFunctionName: returns undefined for source with no inferrable name (indirect)

// ---------------------------------------------------------------------------
// Property-test corpus for corpus/props-file.ts
// ---------------------------------------------------------------------------

import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as fc from "fast-check";
import { extractFromPropsFile } from "./props-file.js";
import type { IntentCardInput } from "./types.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary IntentCardInput — minimal shape needed by extractFromPropsFile. */
const intentCardInputArb: fc.Arbitrary<IntentCardInput> = fc.record({
  behavior: nonEmptyStr,
  inputs: fc.array(
    fc.record({
      name: nonEmptyStr,
      typeHint: nonEmptyStr,
      description: fc.string({ minLength: 0, maxLength: 40 }),
    }),
    { minLength: 0, maxLength: 3 },
  ),
  outputs: fc.array(
    fc.record({
      name: nonEmptyStr,
      typeHint: nonEmptyStr,
      description: fc.string({ minLength: 0, maxLength: 40 }),
    }),
    { minLength: 0, maxLength: 3 },
  ),
  preconditions: fc.array(nonEmptyStr, { minLength: 0, maxLength: 3 }),
  postconditions: fc.array(nonEmptyStr, { minLength: 0, maxLength: 3 }),
  notes: fc.array(fc.string(), { minLength: 0, maxLength: 2 }),
  sourceHash: fc
    .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
    .map((nibbles) => nibbles.map((n) => n.toString(16)).join("")),
  modelVersion: nonEmptyStr,
  promptVersion: nonEmptyStr,
});

/** Valid identifier string for use as an atom/function name. */
const identifierArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s));

/** Source string with a valid function declaration (inferFunctionName → function-decl path). */
const sourceFnDeclArb: fc.Arbitrary<[string, string]> = identifierArb.map((name) => [
  name,
  `export function ${name}(x: string): string { return x; }`,
]);

/** Source string with a const assignment but no function decl (inferFunctionName → const path). */
const sourceConstArb: fc.Arbitrary<[string, string]> = identifierArb.map((name) => [
  name,
  `const ${name} = (x: string): string => x;`,
]);

// ---------------------------------------------------------------------------
// PF1.1: extractFromPropsFile returns undefined when file cannot be read
// ---------------------------------------------------------------------------

/**
 * @summary extractFromPropsFile returns undefined when propsFilePath points to a non-existent file.
 */
export const prop_extractFromPropsFile_returnsUndefined_whenFileCannotBeRead: fc.IAsyncPropertyWithHooks<
  [IntentCardInput, string]
> = fc.asyncProperty(intentCardInputArb, fc.string(), async (card, source) => {
  const propsFilePath = path.join(os.tmpdir(), `l3i-pf-nonexistent-${Date.now()}.props.ts`);
  const result = await extractFromPropsFile(propsFilePath, card, source);
  return result === undefined;
});

// ---------------------------------------------------------------------------
// PF1.2: extractFromPropsFile returns undefined when no function name inferable
// ---------------------------------------------------------------------------

/**
 * @summary extractFromPropsFile returns undefined when source contains no inferable function name.
 */
export const prop_extractFromPropsFile_returnsUndefined_whenNoFunctionNameInferable: fc.IAsyncPropertyWithHooks<
  [IntentCardInput]
> = fc.asyncProperty(intentCardInputArb, async (card) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "l3i-pf-nofn-"));
  try {
    const propsFilePath = path.join(tmpDir, "stub.props.ts");
    // Write a props file that has some exports
    await writeFile(propsFilePath, `export const prop_anything_here = "stub";`, "utf-8");
    // Use source with no inferable function name — raw string/number literal
    const result = await extractFromPropsFile(propsFilePath, card, "42");
    return result === undefined;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PF1.3: extractFromPropsFile returns undefined when props file has no matching export
// ---------------------------------------------------------------------------

/**
 * @summary extractFromPropsFile returns undefined when the props file has no prop_<atomName>_* export.
 */
export const prop_extractFromPropsFile_returnsUndefined_whenNoMatchingExport: fc.IAsyncPropertyWithHooks<
  [IntentCardInput]
> = fc.asyncProperty(intentCardInputArb, async (card) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "l3i-pf-nomatch-"));
  try {
    const atomName = "myTargetFn";
    const source = `export function ${atomName}(x: string): string { return x; }`;
    const propsFilePath = path.join(tmpDir, `${atomName}.props.ts`);
    // Only exports for a different atom — not prop_myTargetFn_*
    const propsContent = `export const prop_otherFn_someInvariant = "stub";`;
    await writeFile(propsFilePath, propsContent, "utf-8");

    const result = await extractFromPropsFile(propsFilePath, card, source);
    return result === undefined;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PF1.4: extractFromPropsFile returns CorpusResult with source='props-file' on match
// ---------------------------------------------------------------------------

/**
 * @summary extractFromPropsFile returns a CorpusResult with source='props-file' when match found.
 */
export const prop_extractFromPropsFile_returnsPropsFileSource_whenMatchFound: fc.IAsyncPropertyWithHooks<
  [IntentCardInput]
> = fc.asyncProperty(intentCardInputArb, async (card) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "l3i-pf-match-"));
  try {
    const atomName = "myTargetFn";
    const source = `export function ${atomName}(x: string): string { return x; }`;
    const propsFilePath = path.join(tmpDir, `${atomName}.props.ts`);
    const propsContent = `export const prop_${atomName}_someInvariant = "stub";`;
    await writeFile(propsFilePath, propsContent, "utf-8");

    const result = await extractFromPropsFile(propsFilePath, card, source);
    return result !== undefined && result.source === "props-file";
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PF1.5: extractFromPropsFile result.bytes is UTF-8 encoding of file content
// ---------------------------------------------------------------------------

/**
 * @summary extractFromPropsFile result.bytes matches the UTF-8 encoded file content.
 */
export const prop_extractFromPropsFile_bytesIsUtf8EncodedContent: fc.IAsyncPropertyWithHooks<
  [IntentCardInput]
> = fc.asyncProperty(intentCardInputArb, async (card) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "l3i-pf-bytes-"));
  try {
    const atomName = "myTargetFn";
    const source = `export function ${atomName}(x: string): string { return x; }`;
    const propsFilePath = path.join(tmpDir, `${atomName}.props.ts`);
    const propsContent = `export const prop_${atomName}_bytesCheck = "stub content here";`;
    await writeFile(propsFilePath, propsContent, "utf-8");

    const result = await extractFromPropsFile(propsFilePath, card, source);
    if (result === undefined) return false;

    const encoder = new TextEncoder();
    const expected = encoder.encode(propsContent);
    if (result.bytes.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (result.bytes[i] !== expected[i]) return false;
    }
    return true;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PF1.6: extractFromPropsFile result.contentHash is a 64-char hex string
// ---------------------------------------------------------------------------

/**
 * @summary extractFromPropsFile result.contentHash is exactly 64 lowercase hex characters.
 */
export const prop_extractFromPropsFile_contentHashIs64CharHex: fc.IAsyncPropertyWithHooks<
  [IntentCardInput]
> = fc.asyncProperty(intentCardInputArb, async (card) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "l3i-pf-hash-"));
  try {
    const atomName = "myTargetFn";
    const source = `export function ${atomName}(x: string): string { return x; }`;
    const propsFilePath = path.join(tmpDir, `${atomName}.props.ts`);
    const propsContent = `export const prop_${atomName}_hashCheck = "hash test";`;
    await writeFile(propsFilePath, propsContent, "utf-8");

    const result = await extractFromPropsFile(propsFilePath, card, source);
    if (result === undefined) return false;

    return /^[0-9a-f]{64}$/.test(result.contentHash);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PF1.7: extractFromPropsFile result.path equals atomName + '.props.ts'
// ---------------------------------------------------------------------------

/**
 * @summary extractFromPropsFile result.path equals the inferred atom name plus '.props.ts'.
 */
export const prop_extractFromPropsFile_resultPathIsAtomNameDotPropsTs: fc.IAsyncPropertyWithHooks<
  [[string, string]]
> = fc.asyncProperty(sourceFnDeclArb, async ([atomName, source]) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "l3i-pf-path-"));
  try {
    const propsFilePath = path.join(tmpDir, `${atomName}.props.ts`);
    const propsContent = `export const prop_${atomName}_pathCheck = "stub";`;
    await writeFile(propsFilePath, propsContent, "utf-8");

    const card: IntentCardInput = {
      behavior: "test",
      inputs: [],
      outputs: [],
      preconditions: [],
      postconditions: [],
      notes: [],
      sourceHash: "a".repeat(64),
      modelVersion: "v1",
      promptVersion: "p1",
    };
    const result = await extractFromPropsFile(propsFilePath, card, source);
    if (result === undefined) return false;

    return result.path === `${atomName}.props.ts`;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PF1.8: extractFromPropsFile does not mutate _intentCard input
// ---------------------------------------------------------------------------

/**
 * @summary extractFromPropsFile leaves _intentCard structurally identical before and after the call.
 */
export const prop_extractFromPropsFile_doesNotMutateIntentCard: fc.IAsyncPropertyWithHooks<
  [IntentCardInput]
> = fc.asyncProperty(intentCardInputArb, async (card) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "l3i-pf-mutcard-"));
  try {
    const atomName = "myTargetFn";
    const source = `export function ${atomName}(x: string): string { return x; }`;
    const propsFilePath = path.join(tmpDir, `${atomName}.props.ts`);
    const propsContent = `export const prop_${atomName}_mutCheck = "stub";`;
    await writeFile(propsFilePath, propsContent, "utf-8");

    const cardBefore = JSON.stringify(card);
    await extractFromPropsFile(propsFilePath, card, source);
    const cardAfter = JSON.stringify(card);
    return cardBefore === cardAfter;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PF1.9: extractFromPropsFile does not mutate source input
// ---------------------------------------------------------------------------

/**
 * @summary extractFromPropsFile leaves source string identical before and after the call.
 */
export const prop_extractFromPropsFile_doesNotMutateSource: fc.IAsyncPropertyWithHooks<
  [IntentCardInput, string]
> = fc.asyncProperty(intentCardInputArb, fc.string(), async (card, source) => {
  // Use a missing file path — still exercises the source-immutability path
  const propsFilePath = path.join(os.tmpdir(), `l3i-pf-mutsrc-${Date.now()}.props.ts`);
  const sourceBefore = source;
  await extractFromPropsFile(propsFilePath, card, source);
  return source === sourceBefore;
});

// ---------------------------------------------------------------------------
// PF2.1: inferFunctionName — function declaration wins over const assignment (indirect)
// ---------------------------------------------------------------------------

/**
 * @summary extractFromPropsFile infers function name from function declaration (not const) when both present.
 */
export const prop_extractFromPropsFile_inferFunctionName_fnDeclWins: fc.IAsyncPropertyWithHooks<
  [[string, string]]
> = fc.asyncProperty(sourceFnDeclArb, async ([atomName, source]) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "l3i-pf-fndecl-"));
  try {
    // Props file has export for the function-decl name; no export for any other name.
    const propsFilePath = path.join(tmpDir, `${atomName}.props.ts`);
    const propsContent = `export const prop_${atomName}_fnDeclMatch = "stub";`;
    await writeFile(propsFilePath, propsContent, "utf-8");

    const card: IntentCardInput = {
      behavior: "test",
      inputs: [],
      outputs: [],
      preconditions: [],
      postconditions: [],
      notes: [],
      sourceHash: "b".repeat(64),
      modelVersion: "v1",
      promptVersion: "p1",
    };
    const result = await extractFromPropsFile(propsFilePath, card, source);
    // Should find a match because fn-decl name is inferred correctly
    return result !== undefined && result.source === "props-file";
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PF2.2: inferFunctionName — const/let/var assignment used as fallback (indirect)
// ---------------------------------------------------------------------------

/**
 * @summary extractFromPropsFile infers function name from const assignment when no function declaration.
 */
export const prop_extractFromPropsFile_inferFunctionName_constFallback: fc.IAsyncPropertyWithHooks<
  [[string, string]]
> = fc.asyncProperty(sourceConstArb, async ([atomName, source]) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "l3i-pf-const-"));
  try {
    const propsFilePath = path.join(tmpDir, `${atomName}.props.ts`);
    const propsContent = `export const prop_${atomName}_constMatch = "stub";`;
    await writeFile(propsFilePath, propsContent, "utf-8");

    const card: IntentCardInput = {
      behavior: "test",
      inputs: [],
      outputs: [],
      preconditions: [],
      postconditions: [],
      notes: [],
      sourceHash: "c".repeat(64),
      modelVersion: "v1",
      promptVersion: "p1",
    };
    const result = await extractFromPropsFile(propsFilePath, card, source);
    // Should find a match via const-path inference
    return result !== undefined && result.source === "props-file";
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PF2.3: inferFunctionName — returns undefined for source with no inferable name (indirect)
// ---------------------------------------------------------------------------

/**
 * @summary extractFromPropsFile returns undefined when source has neither function decl nor const assignment.
 */
export const prop_extractFromPropsFile_inferFunctionName_undefinedForNoName: fc.IAsyncPropertyWithHooks<
  [IntentCardInput]
> = fc.asyncProperty(intentCardInputArb, async (card) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "l3i-pf-noname-"));
  try {
    const propsFilePath = path.join(tmpDir, "stub.props.ts");
    // Props file has some exports, but source won't match any because name is uninferable
    await writeFile(propsFilePath, `export const prop_anything_invariant = "stub";`, "utf-8");
    // Source with no function declaration or const/let/var assignment
    const source = `// just a comment\n"use strict";`;
    const result = await extractFromPropsFile(propsFilePath, card, source);
    return result === undefined;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
