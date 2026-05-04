/**
 * slice-plan.test.ts — unit tests for the SlicePlan-based compile pipeline.
 *
 * Tests cover:
 *   - compileToTypeScript: assembles a TS source string from a SlicePlan.
 *   - GlueLeafInWasmModeError: typed rejection error for glue-in-WASM paths.
 *   - assertNoGlueLeaf: validation helper that throws on GlueLeafEntry.
 *
 * WI-V2-GLUE-LEAF-CONTRACT acceptance criteria D:
 *   "Compile pipeline test: compileToTypeScript on a slice plan with a
 *    GlueLeafEntry emits the verbatim glue source in the output."
 *   "WASM test: behavior per DEC-V2-GLUE-LEAF-WASM-001."
 *
 * These tests use manually-constructed SlicePlan fixtures (not produced by the
 * live slicer) because the search-algorithm slicer that emits GlueLeafEntry
 * lands in WI-V2-SLICER-SEARCH-ALG, not here.
 */

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import type { GlueLeafEntry, NovelGlueEntry, PointerEntry, SlicePlan } from "@yakcc/shave";
import { describe, expect, it } from "vitest";
import { GlueLeafInWasmModeError, assertNoGlueLeaf, compileToTypeScript } from "./slice-plan.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeGlueEntry(
  source: string,
  hash = "deadbeef00000000",
  reason = "unsupported-node: GeneratorFunction",
): GlueLeafEntry {
  return { kind: "glue", source, canonicalAstHash: hash, reason };
}

function makeNovelEntry(source: string, hash = "feedcafe00000000"): NovelGlueEntry {
  return {
    kind: "novel-glue",
    sourceRange: { start: 0, end: source.length },
    source,
    canonicalAstHash: hash as CanonicalAstHash,
  };
}

function makePointerEntry(
  merkleRoot = "merkle-001" as BlockMerkleRoot,
  hash = "aabbccdd00000000",
): PointerEntry {
  return {
    kind: "pointer",
    sourceRange: { start: 0, end: 10 },
    merkleRoot,
    canonicalAstHash: hash as CanonicalAstHash,
    matchedBy: "canonical_ast_hash",
  };
}

function makePlan(
  entries: SlicePlan["entries"],
  glueBytes = 0,
  novelBytes = 0,
  pointerBytes = 0,
): SlicePlan {
  return {
    entries,
    matchedPrimitives: [],
    sourceBytesByKind: {
      pointer: pointerBytes,
      novelGlue: novelBytes,
      glue: glueBytes,
    },
  };
}

// ---------------------------------------------------------------------------
// compileToTypeScript — GlueLeafEntry handling
// ---------------------------------------------------------------------------

describe("compileToTypeScript — GlueLeafEntry verbatim emit", () => {
  it("emits verbatim glue source in the output (acceptance criteria D)", () => {
    const glueSource = "function* gen() { yield 1; yield 2; }";
    const plan = makePlan([makeGlueEntry(glueSource)], glueSource.length);

    const output = compileToTypeScript(plan);

    expect(output).toContain(glueSource);
  });

  it("wraps glue source with comment boundary markers", () => {
    const glueSource = "const x = Symbol();";
    const hash = "abcd1234efgh5678";
    const plan = makePlan([makeGlueEntry(glueSource, hash)]);

    const output = compileToTypeScript(plan);

    expect(output).toContain(`// --- glue: ${hash.slice(0, 8)}`);
    expect(output).toContain("// --- end glue ---");
  });

  it("includes the assembly header comment", () => {
    const plan = makePlan([makeGlueEntry("const x = 1;")]);

    const output = compileToTypeScript(plan);

    expect(output).toContain("Assembled by @yakcc/compile");
  });

  it("emits multiple entries in plan order", () => {
    const novelSource = "function add(a: number, b: number): number { return a + b; }";
    const glueSource = "function* gen() { yield 42; }";

    const plan = makePlan(
      [makeNovelEntry(novelSource), makeGlueEntry(glueSource)],
      glueSource.length,
      novelSource.length,
    );

    const output = compileToTypeScript(plan);

    // Both entries present.
    expect(output).toContain(novelSource);
    expect(output).toContain(glueSource);

    // Glue appears AFTER novel-glue (plan order preserved).
    const novelPos = output.indexOf(novelSource);
    const gluePos = output.indexOf(glueSource);
    expect(novelPos).toBeLessThan(gluePos);
  });

  it("skips ForeignLeafEntry — foreign deps are not inlined", () => {
    const foreignEntry = {
      kind: "foreign-leaf" as const,
      pkg: "node:fs",
      export: "readFileSync",
    };
    const plan = makePlan([foreignEntry]);

    const output = compileToTypeScript(plan);

    // Foreign leaf must NOT appear in the assembled output.
    expect(output).not.toContain("node:fs");
    expect(output).not.toContain("readFileSync");
  });

  it("emits pointer comment for PointerEntry (source not available without registry)", () => {
    const merkle = "merkle-test-001" as BlockMerkleRoot;
    const plan = makePlan([makePointerEntry(merkle)]);

    const output = compileToTypeScript(plan);

    expect(output).toContain(`// --- pointer: ${merkle}`);
  });

  it("plan with only NovelGlueEntry produces correct source output", () => {
    const src = "export function square(n: number): number { return n * n; }";
    const plan = makePlan([makeNovelEntry(src)], 0, src.length);

    const output = compileToTypeScript(plan);

    expect(output).toContain(src);
    expect(output).not.toContain("// --- glue:");
  });
});

// ---------------------------------------------------------------------------
// GlueLeafInWasmModeError
// ---------------------------------------------------------------------------

describe("GlueLeafInWasmModeError", () => {
  it("constructs with correct name and message", () => {
    const entry = makeGlueEntry("const x = Symbol();", "cafebabe00000000", "unsupported: Symbol");
    const err = new GlueLeafInWasmModeError(entry);

    expect(err.name).toBe("GlueLeafInWasmModeError");
    expect(err.message).toContain("cafebabe");
    expect(err.message).toContain("compileToTypeScript");
  });

  it("carries canonicalAstHash and glueReason fields", () => {
    const hash = "deadbeef12345678";
    const reason = "unsupported-node: GeneratorDeclaration";
    const entry = makeGlueEntry("function* g() {}", hash, reason);
    const err = new GlueLeafInWasmModeError(entry);

    expect(err.canonicalAstHash).toBe(hash);
    expect(err.glueReason).toBe(reason);
  });

  it("is an instance of Error", () => {
    const err = new GlueLeafInWasmModeError(makeGlueEntry("x"));
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// assertNoGlueLeaf — DEC-V2-GLUE-LEAF-WASM-001 (option a: reject on glue)
// ---------------------------------------------------------------------------

describe("assertNoGlueLeaf — WASM rejection guard (DEC-V2-GLUE-LEAF-WASM-001)", () => {
  it("does not throw for a plan with no GlueLeafEntry", () => {
    const source = "export function add(a: number, b: number): number { return a + b; }";
    const plan = makePlan([makeNovelEntry(source)], 0, source.length);

    expect(() => assertNoGlueLeaf(plan)).not.toThrow();
  });

  it("throws GlueLeafInWasmModeError on the first GlueLeafEntry found", () => {
    const glueSource = "function* gen() { yield 1; }";
    const plan = makePlan([makeGlueEntry(glueSource)], glueSource.length);

    expect(() => assertNoGlueLeaf(plan)).toThrow(GlueLeafInWasmModeError);
  });

  it("throws even if GlueLeafEntry is mixed with valid entries", () => {
    const novelSource = "function pure(n: number): number { return n; }";
    const glueSource = "const sym = Symbol('key');";
    const plan = makePlan(
      [makeNovelEntry(novelSource), makeGlueEntry(glueSource)],
      glueSource.length,
      novelSource.length,
    );

    expect(() => assertNoGlueLeaf(plan)).toThrow(GlueLeafInWasmModeError);
  });

  it("error message points to compileToTypeScript as the alternative", () => {
    const plan = makePlan([makeGlueEntry("const x = 1;")]);
    let caught: Error | undefined;
    try {
      assertNoGlueLeaf(plan);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain("compileToTypeScript");
  });

  it("does not throw for an empty plan", () => {
    const plan = makePlan([]);
    expect(() => assertNoGlueLeaf(plan)).not.toThrow();
  });
});
