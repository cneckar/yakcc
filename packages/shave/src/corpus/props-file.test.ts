// SPDX-License-Identifier: MIT
// props-file.test.ts — Unit tests for the props-file corpus extraction source.
//
// @decision DEC-V2-PREFLIGHT-L8-BOOTSTRAP-PROPS-001
// @title Tests verify props-file source: discovery, atom-name mapping, glue handling, fallback
// @status accepted
// @rationale Test-first: these tests define the contract before the implementation.
//   Four test groups:
//   (1) Happy path — sibling .props.ts exists with prop_<atom>_* exports → present-real content
//   (2) No-props fallback — sibling .props.ts absent → returns undefined (caller falls back)
//   (3) No-matching-props — sibling .props.ts exists but no props for this atom → undefined
//   (4) Glue atom — atom source has no recognizable export name → returns undefined
//
// These tests drive the naming convention and wiring strategy captured in
// DEC-V2-PREFLIGHT-L8-BOOTSTRAP-PROPS-001.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PROPS_FILE_CORPUS_PATH,
  PROPS_FILE_PLACEHOLDER_MARKERS,
  extractFromPropsFile,
} from "./props-file.js";

const FIXTURE_DIR = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "__fixtures__",
  "props-wiring",
);

// ---------------------------------------------------------------------------
// Sanity: fixture files actually exist
// ---------------------------------------------------------------------------

it("fixture files exist", () => {
  expect(existsSync(join(FIXTURE_DIR, "sample-atom.ts"))).toBe(true);
  expect(existsSync(join(FIXTURE_DIR, "sample-atom.props.ts"))).toBe(true);
  expect(existsSync(join(FIXTURE_DIR, "no-props-atom.ts"))).toBe(true);
});

// ---------------------------------------------------------------------------
// (1) Happy path: sibling .props.ts with matching prop_<atom>_* exports
// ---------------------------------------------------------------------------

describe("extractFromPropsFile — happy path", () => {
  const sampleAtomSource = `export function toUpperCase(input: string): string {
  return input.toUpperCase();
}`;

  it("returns a CorpusResult when sibling .props.ts exists with matching props", () => {
    const result = extractFromPropsFile(
      sampleAtomSource,
      join(FIXTURE_DIR, "sample-atom.ts"),
    );
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
  });

  it("result has source='props-file'", () => {
    const result = extractFromPropsFile(
      sampleAtomSource,
      join(FIXTURE_DIR, "sample-atom.ts"),
    );
    expect(result?.source).toBe("props-file");
  });

  it("result has the correct canonical artifact path", () => {
    const result = extractFromPropsFile(
      sampleAtomSource,
      join(FIXTURE_DIR, "sample-atom.ts"),
    );
    expect(result?.path).toBe(PROPS_FILE_CORPUS_PATH);
  });

  it("result bytes are non-empty and decode to valid UTF-8", () => {
    const result = extractFromPropsFile(
      sampleAtomSource,
      join(FIXTURE_DIR, "sample-atom.ts"),
    );
    expect(result?.bytes).toBeDefined();
    expect(result!.bytes.length).toBeGreaterThan(0);
    const decoded = new TextDecoder().decode(result?.bytes);
    expect(decoded.length).toBeGreaterThan(0);
  });

  it("result content contains prop_toUpperCase_ exports (present-real, no placeholder markers)", () => {
    const result = extractFromPropsFile(
      sampleAtomSource,
      join(FIXTURE_DIR, "sample-atom.ts"),
    );
    const decoded = new TextDecoder().decode(result?.bytes);
    expect(decoded).toContain("prop_toUpperCase_");

    // Must NOT contain any of the placeholder sentinel markers
    for (const marker of PROPS_FILE_PLACEHOLDER_MARKERS) {
      expect(decoded).not.toContain(marker);
    }
  });

  it("result has a non-empty contentHash (BLAKE3 hex)", () => {
    const result = extractFromPropsFile(
      sampleAtomSource,
      join(FIXTURE_DIR, "sample-atom.ts"),
    );
    expect(result?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("result is deterministic: same inputs produce identical bytes", () => {
    const r1 = extractFromPropsFile(
      sampleAtomSource,
      join(FIXTURE_DIR, "sample-atom.ts"),
    );
    const r2 = extractFromPropsFile(
      sampleAtomSource,
      join(FIXTURE_DIR, "sample-atom.ts"),
    );
    expect(r1?.contentHash).toBe(r2?.contentHash);
    expect(r1?.bytes).toEqual(r2?.bytes);
  });
});

// ---------------------------------------------------------------------------
// (2) No-props fallback: sibling .props.ts does not exist
// ---------------------------------------------------------------------------

describe("extractFromPropsFile — no sibling props file", () => {
  it("returns undefined when no .props.ts sibling exists", () => {
    const atomSource = `export function multiply(a: number, b: number): number {
  return a * b;
}`;
    const result = extractFromPropsFile(
      atomSource,
      join(FIXTURE_DIR, "no-props-atom.ts"),
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (3) Props file exists but no matching props for this atom
// ---------------------------------------------------------------------------

describe("extractFromPropsFile — no matching props for atom name", () => {
  it("returns undefined when props file has no prop_<atomName>_* exports for this atom", () => {
    // Use the sample-atom.props.ts but with an atom whose name doesn't match
    const atomSource = `export function somethingEntirelyDifferent(x: number): number {
  return x * 2;
}`;
    const result = extractFromPropsFile(
      atomSource,
      join(FIXTURE_DIR, "sample-atom.ts"),
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (4) Glue atom: no recognizable exported name → undefined
// ---------------------------------------------------------------------------

describe("extractFromPropsFile — glue atom with no export name", () => {
  it("returns undefined when atom source has no recognizable exported function name", () => {
    // Glue-like code: import statement or expression with no function export
    const glueAtomSource = `import { readFile } from "node:fs/promises";`;
    const result = extractFromPropsFile(
      glueAtomSource,
      join(FIXTURE_DIR, "sample-atom.ts"),
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (5) Integration: extractFromPropsFile is invoked with real props content
// ---------------------------------------------------------------------------

describe("extractFromPropsFile — content structure", () => {
  const sampleAtomSource = `export function toUpperCase(input: string): string {
  return input.toUpperCase();
}`;

  it("decoded content includes the props-file header comment", () => {
    const result = extractFromPropsFile(
      sampleAtomSource,
      join(FIXTURE_DIR, "sample-atom.ts"),
    );
    const decoded = new TextDecoder().decode(result?.bytes);
    // The result should contain the actual props file content (not generated stubs)
    expect(decoded).toContain("prop_toUpperCase_idempotent");
    expect(decoded).toContain("prop_toUpperCase_length_preserving");
  });
});
