// @decision DEC-CORPUS-001 (WI-016)
// title: Corpus extraction unit tests: determinism, cache seeding, priority chain, cascade, and error path
// status: decided (WI-016)
// rationale:
//   Eight tests cover the full contract of the corpus extraction module:
//   (1) upstream-test determinism, (2) documented-usage determinism,
//   (3) ai-derived cache cold/warm, (4) priority order a>b>c,
//   (5) cascade variant (a+b disabled → c), (6) all-disabled error,
//   (7) extractFromPropsFile (match/no-match/missing-file),
//   (8) props-file priority over upstream-test in extractCorpus().
//   DEC-SHAVE-002: no Anthropic SDK import; cache is seeded via public seedCorpusCache.
//   DEC-SHAVE-003: seedCorpusCache is the only authority for priming the AI-derived cache.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractFromAiDerivedCached } from "./ai-derived.js";
import { extractFromDocumentedUsage } from "./documented-usage.js";
import {
  extractCorpus,
  extractCorpusCascade,
  extractFromPropsFile,
  seedCorpusCache,
} from "./index.js";
import type { CorpusAtomSpec, IntentCardInput } from "./types.js";
import { extractFromUpstreamTest } from "./upstream-test.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal IntentCard fixture for corpus extraction tests.
 *
 * Mirrors the helper pattern from packages/shave/src/persist/triplet.test.ts.
 * Deliberately recreated here — do NOT import from triplet.test.ts.
 */
function makeIntentCard(overrides: Partial<IntentCardInput> = {}): IntentCardInput {
  return {
    behavior: "Parse a comma-separated list of integers and return them as an array",
    inputs: [{ name: "raw", typeHint: "string", description: "The raw CSV string" }],
    outputs: [{ name: "result", typeHint: "number[]", description: "Parsed integers" }],
    preconditions: ["raw is a non-empty string"],
    postconditions: ["result.length >= 0"],
    notes: ["Trailing commas are ignored"],
    modelVersion: "claude-3-5-haiku-20241022",
    promptVersion: "v1.0",
    sourceHash: "deadbeef",
    ...overrides,
  };
}

/** Plain atom source text with no JSDoc @example blocks. */
const PLAIN_SOURCE = `function parseIntList(raw: string): number[] {
  return raw.split(",").map(Number).filter(Number.isFinite);
}`;

/** Atom source text containing a JSDoc @example block for documented-usage synthesis. */
const JSDOC_SOURCE = `/**
 * Parse a comma-separated list of integers.
 *
 * @example
 * parseIntList("1,2,3") // => [1, 2, 3]
 */
function parseIntList(raw: string): number[] {
  return raw.split(",").map(Number).filter(Number.isFinite);
}`;

/** Fast-check file content used to seed the AI-derived cache. */
const AI_CORPUS_CONTENT = `import * as fc from "fast-check";
import { describe, it } from "vitest";

describe("parseIntList property tests (ai-derived)", () => {
  it("returns an array of finite integers", () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), (nums) => {
        const raw = nums.join(",");
        const result = parseIntList(raw);
        return Array.isArray(result);
      }),
    );
  });
});
`;

// ---------------------------------------------------------------------------
// Test 1: upstream-test determinism
// ---------------------------------------------------------------------------

describe("extractFromUpstreamTest()", () => {
  it("produces a deterministic fast-check property file for a fixture IntentCard", () => {
    const intentCard = makeIntentCard();

    const result1 = extractFromUpstreamTest(intentCard, PLAIN_SOURCE);
    const result2 = extractFromUpstreamTest(intentCard, PLAIN_SOURCE);

    // Source discrimination
    expect(result1.source).toBe("upstream-test");

    // Path is non-empty and ends with .ts
    expect(result1.path.length).toBeGreaterThan(0);
    expect(result1.path.endsWith(".ts")).toBe(true);

    // Determinism: identical bytes on second call
    expect(result1.bytes).toBeInstanceOf(Uint8Array);
    expect(result2.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(result1.bytes).toString("hex")).toBe(
      Buffer.from(result2.bytes).toString("hex"),
    );

    // Determinism: identical contentHash
    expect(result1.contentHash).toBe(result2.contentHash);
    expect(result1.contentHash.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: documented-usage determinism
// ---------------------------------------------------------------------------

describe("extractFromDocumentedUsage()", () => {
  it("produces a deterministic fast-check property file for an IntentCard with a JSDoc @example block", () => {
    const intentCard = makeIntentCard();

    const result1 = extractFromDocumentedUsage(intentCard, JSDOC_SOURCE);
    const result2 = extractFromDocumentedUsage(intentCard, JSDOC_SOURCE);

    // Source discrimination
    expect(result1.source).toBe("documented-usage");

    // Determinism: byte-identical
    expect(result1.bytes).toBeInstanceOf(Uint8Array);
    expect(result2.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(result1.bytes).toString("hex")).toBe(
      Buffer.from(result2.bytes).toString("hex"),
    );

    // Determinism: identical contentHash
    expect(result1.contentHash).toBe(result2.contentHash);
    expect(result1.contentHash.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 3: ai-derived cache-only (cold → undefined; warm → populated CorpusResult)
// ---------------------------------------------------------------------------

describe("extractFromAiDerivedCached()", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(os.tmpdir(), "yakcc-corpus-test-"));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("returns undefined on cold cache and returns a populated CorpusResult after seedCorpusCache()", async () => {
    const intentCard = makeIntentCard();

    // Cold cache: must return undefined (offline, no Anthropic SDK call)
    const cold = await extractFromAiDerivedCached(intentCard, PLAIN_SOURCE, cacheDir);
    expect(cold).toBeUndefined();

    // Seed the cache via the public authority (DEC-SHAVE-003)
    await seedCorpusCache({ source: PLAIN_SOURCE, cacheDir }, AI_CORPUS_CONTENT);

    // Warm cache: must return a populated CorpusResult
    const warm = await extractFromAiDerivedCached(intentCard, PLAIN_SOURCE, cacheDir);
    expect(warm).not.toBeUndefined();
    expect(warm!.source).toBe("ai-derived");
    expect(warm!.bytes).toBeInstanceOf(Uint8Array);
    expect(warm!.bytes.length).toBeGreaterThan(0);
    expect(warm!.path.length).toBeGreaterThan(0);
    expect(warm!.contentHash.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Priority order a > b > c
// ---------------------------------------------------------------------------

describe("extractCorpus() — priority order", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(os.tmpdir(), "yakcc-corpus-priority-"));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("returns upstream-test result when all three sources are available (upstream > documented-usage > ai-derived)", async () => {
    const intentCard = makeIntentCard();

    // Pre-seed the AI-derived cache so source (c) is available
    await seedCorpusCache({ source: PLAIN_SOURCE, cacheDir }, AI_CORPUS_CONTENT);

    const atomSpec: CorpusAtomSpec = {
      source: PLAIN_SOURCE,
      intentCard,
      cacheDir,
    };

    // All three sources enabled (default). Upstream-test must win.
    const result = await extractCorpus(atomSpec);
    expect(result.source).toBe("upstream-test");
  });
});

// ---------------------------------------------------------------------------
// Test 5: Cascade variant (a+b disabled → ai-derived)
// ---------------------------------------------------------------------------

describe("extractCorpusCascade() — cascade to ai-derived when a+b disabled", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(os.tmpdir(), "yakcc-corpus-cascade-"));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("returns ai-derived result when enableUpstreamTest=false, enableDocumentedUsage=false, and cache is pre-seeded", async () => {
    const intentCard = makeIntentCard();

    // Pre-seed cache via public helper (DEC-SHAVE-003)
    await seedCorpusCache({ source: PLAIN_SOURCE, cacheDir }, AI_CORPUS_CONTENT);

    const atomSpec: CorpusAtomSpec = {
      source: PLAIN_SOURCE,
      intentCard,
      cacheDir,
    };

    const result = await extractCorpusCascade(atomSpec, {
      enableUpstreamTest: false,
      enableDocumentedUsage: false,
      enableAiDerived: true,
    });

    expect(result.source).toBe("ai-derived");
    expect(result.bytes.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 6: All-sources-disabled error
// ---------------------------------------------------------------------------

describe("extractCorpus() — all-sources-disabled error", () => {
  it('throws an Error containing "all enabled sources failed or were disabled" when all sources are disabled', async () => {
    const intentCard = makeIntentCard();
    const atomSpec: CorpusAtomSpec = {
      source: PLAIN_SOURCE,
      intentCard,
    };

    await expect(
      extractCorpus(atomSpec, {
        enableUpstreamTest: false,
        enableDocumentedUsage: false,
        enableAiDerived: false,
      }),
    ).rejects.toThrow("all enabled sources failed or were disabled");
  });
});

// ---------------------------------------------------------------------------
// Test 7: extractFromPropsFile — match, no-match, missing-file
// ---------------------------------------------------------------------------

/** Props file content containing a prop_parseIntList_ export (matching PLAIN_SOURCE). */
const PROPS_FILE_CONTENT = `// Hand-authored fast-check property tests
import * as fc from "fast-check";

export const prop_parseIntList_returns_array = fc.property(
  fc.array(fc.integer()),
  (nums) => {
    const raw = nums.join(",");
    const result = parseIntList(raw);
    return Array.isArray(result);
  },
);
`;

describe("extractFromPropsFile()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "yakcc-props-file-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a CorpusResult with source='props-file' when the file has a matching prop_<atomName>_ export", async () => {
    const propsPath = join(tmpDir, "parseIntList.props.ts");
    writeFileSync(propsPath, PROPS_FILE_CONTENT, "utf-8");

    const result = await extractFromPropsFile(propsPath, makeIntentCard(), PLAIN_SOURCE);

    expect(result).not.toBeUndefined();
    expect(result!.source).toBe("props-file");
    expect(result!.bytes).toBeInstanceOf(Uint8Array);
    expect(result!.bytes.length).toBeGreaterThan(0);
    expect(result!.path).toBe("parseIntList.props.ts");
    expect(result!.contentHash.length).toBeGreaterThan(0);
  });

  it("returns undefined when the props file has no matching prop_<atomName>_ export", async () => {
    const propsPath = join(tmpDir, "other.props.ts");
    writeFileSync(propsPath, "export const prop_unrelatedFunction_foo = true;\n", "utf-8");

    const result = await extractFromPropsFile(propsPath, makeIntentCard(), PLAIN_SOURCE);

    expect(result).toBeUndefined();
  });

  it("returns undefined when the props file does not exist", async () => {
    const result = await extractFromPropsFile(
      join(tmpDir, "nonexistent.props.ts"),
      makeIntentCard(),
      PLAIN_SOURCE,
    );

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 8: props-file takes priority over upstream-test in extractCorpus()
// ---------------------------------------------------------------------------

describe("extractCorpus() — props-file priority over upstream-test", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "yakcc-props-priority-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns props-file result (source 0) when propsFilePath has a matching export, even with enableUpstreamTest=true", async () => {
    const propsPath = join(tmpDir, "parseIntList.props.ts");
    writeFileSync(propsPath, PROPS_FILE_CONTENT, "utf-8");

    const atomSpec: CorpusAtomSpec = {
      source: PLAIN_SOURCE,
      intentCard: makeIntentCard(),
      propsFilePath: propsPath,
    };

    const result = await extractCorpus(atomSpec);

    expect(result.source).toBe("props-file");
    expect(new TextDecoder().decode(result.bytes)).toBe(PROPS_FILE_CONTENT);
  });

  it("falls through to upstream-test when propsFilePath has no matching export", async () => {
    const propsPath = join(tmpDir, "other.props.ts");
    writeFileSync(propsPath, "export const prop_unrelatedFunction_foo = true;\n", "utf-8");

    const atomSpec: CorpusAtomSpec = {
      source: PLAIN_SOURCE,
      intentCard: makeIntentCard(),
      propsFilePath: propsPath,
    };

    const result = await extractCorpus(atomSpec);

    expect(result.source).toBe("upstream-test");
  });
});
