// @decision DEC-CORPUS-001 (WI-016)
// title: Corpus extraction unit tests: determinism, cache seeding, priority chain, cascade, and error path
// status: decided (WI-016, extended WI-V2-07-L8)
// rationale:
//   Tests cover the full contract of the corpus extraction module:
//   (1) upstream-test determinism, (2) documented-usage determinism,
//   (3) ai-derived cache cold/warm, (4) priority order a>b>c,
//   (5) cascade variant (a+b disabled → c), (6) all-disabled error,
//   (7) props-file extractor: match/no-match/missing-file,
//   (8) props-file wins priority over upstream-test.
//   DEC-SHAVE-002: no Anthropic SDK import; cache is seeded via public seedCorpusCache.
//   DEC-SHAVE-003: seedCorpusCache is the only authority for priming the AI-derived cache.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractFromDocumentedUsage } from "./documented-usage.js";
import {
  extractCorpus,
  extractCorpusCascade,
  extractFromPropsFile,
  seedCorpusCache,
} from "./index.js";
import type { CorpusAtomSpec, IntentCardInput } from "./types.js";
import { extractFromUpstreamTest } from "./upstream-test.js";
import { extractFromAiDerivedCached } from "./ai-derived.js";

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

/** A *.props.ts fixture containing prop_parseIntList_* exports. */
const PROPS_FILE_CONTENT = `// Hand-authored property tests for parseIntList
import * as fc from "fast-check";
import { parseIntList } from "./index.js";

export const prop_parseIntList_returns_array = fc.property(
  fc.string(),
  (raw) => Array.isArray(parseIntList(raw)),
);

export const prop_parseIntList_non_negative_length = fc.property(
  fc.string(),
  (raw) => parseIntList(raw).length >= 0,
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

  it("returns a CorpusResult with source='props-file' when matching prop_<atom>_* exports exist", async () => {
    const propsFilePath = join(tmpDir, "index.props.ts");
    writeFileSync(propsFilePath, PROPS_FILE_CONTENT, "utf-8");
    const intentCard = makeIntentCard();

    const result = await extractFromPropsFile(propsFilePath, intentCard, PLAIN_SOURCE);

    expect(result).not.toBeUndefined();
    expect(result!.source).toBe("props-file");
    expect(result!.bytes.length).toBeGreaterThan(0);
    expect(result!.path).toBe("parseIntList.props.ts");
    expect(result!.contentHash.length).toBe(64); // BLAKE3-256 hex
    // Artifact bytes must contain the hand-authored content (not a sentinel stub)
    const text = Buffer.from(result!.bytes).toString("utf-8");
    expect(text).toContain("prop_parseIntList_returns_array");
    expect(text).not.toContain("Auto-generated property-test corpus");
  });

  it("returns undefined when the props file has no prop_<atom>_* export for the atom", async () => {
    const propsFilePath = join(tmpDir, "other.props.ts");
    // Props file exists but has exports for a different atom (prop_otherFn_*)
    writeFileSync(propsFilePath, "export const prop_otherFn_something = true;\n", "utf-8");
    const intentCard = makeIntentCard();

    const result = await extractFromPropsFile(propsFilePath, intentCard, PLAIN_SOURCE);
    expect(result).toBeUndefined();
  });

  it("returns undefined when the props file does not exist", async () => {
    const missingPath = join(tmpDir, "nonexistent.props.ts");
    const intentCard = makeIntentCard();

    const result = await extractFromPropsFile(missingPath, intentCard, PLAIN_SOURCE);
    expect(result).toBeUndefined();
  });

  it("returns undefined when the function name cannot be inferred from source", async () => {
    const propsFilePath = join(tmpDir, "anon.props.ts");
    writeFileSync(propsFilePath, "export const prop_foo_bar = true;\n", "utf-8");
    const intentCard = makeIntentCard();
    const anonymousSource = `// no function declaration here\nconst x = 1;`;

    const result = await extractFromPropsFile(propsFilePath, intentCard, anonymousSource);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 8: props-file wins priority over upstream-test
// ---------------------------------------------------------------------------

describe("extractCorpus() — props-file priority", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "yakcc-props-priority-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns props-file result when propsFilePath is set and has matching exports", async () => {
    const propsFilePath = join(tmpDir, "index.props.ts");
    writeFileSync(propsFilePath, PROPS_FILE_CONTENT, "utf-8");
    const intentCard = makeIntentCard();

    const atomSpec: CorpusAtomSpec = {
      source: PLAIN_SOURCE,
      intentCard,
      propsFilePath,
    };

    const result = await extractCorpus(atomSpec);
    expect(result.source).toBe("props-file");
  });

  it("falls back to upstream-test when props-file has no matching export", async () => {
    const propsFilePath = join(tmpDir, "index.props.ts");
    writeFileSync(propsFilePath, "export const prop_otherAtom_foo = true;\n", "utf-8");
    const intentCard = makeIntentCard();

    const atomSpec: CorpusAtomSpec = {
      source: PLAIN_SOURCE,
      intentCard,
      propsFilePath,
    };

    const result = await extractCorpus(atomSpec);
    expect(result.source).toBe("upstream-test");
  });
});
