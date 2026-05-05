// @decision DEC-CORPUS-001 (WI-016)
// title: Corpus extraction unit tests: determinism, cache seeding, priority chain, cascade, and error path
// status: decided (WI-016)
// rationale:
//   Six tests cover the full contract of the corpus extraction module:
//   (1) upstream-test determinism, (2) documented-usage determinism,
//   (3) ai-derived cache cold/warm, (4) priority order a>b>c,
//   (5) cascade variant (a+b disabled → c), (6) all-disabled error.
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
  seedCorpusCache,
} from "./index.js";
import type { CorpusAtomSpec, IntentCardInput } from "./types.js";
import { extractFromUpstreamTest } from "./upstream-test.js";
import { extractFromAiDerivedCached } from "./ai-derived.js";
import {
  extractFromPropsFile,
  inferAtomName,
  propExportAtomName,
  hasMatchingExports,
} from "./props-file.js";

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
        enablePropsFile: false,
        enableUpstreamTest: false,
        enableDocumentedUsage: false,
        enableAiDerived: false,
      }),
    ).rejects.toThrow("all enabled sources failed or were disabled");
  });
});

// ---------------------------------------------------------------------------
// Test 7: props-file corpus source (DEC-V2-07-PREFLIGHT-L8-001)
// ---------------------------------------------------------------------------

const PROPS_FILE_CONTENT = `// SPDX-License-Identifier: MIT
import * as fc from "fast-check";

export const prop_parseIntList_returns_array = fc.property(
  fc.array(fc.integer()),
  (nums) => {
    return Array.isArray(nums);
  },
);

export const prop_parseIntList_deterministic = fc.property(
  fc.string(),
  (s) => {
    return typeof s === "string";
  },
);
`;

describe("extractFromPropsFile() — props-file corpus source", () => {
  let tmpDir: string;
  let propsFilePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "yakcc-props-test-"));
    propsFilePath = join(tmpDir, "parse-int-list.props.ts");
    writeFileSync(propsFilePath, PROPS_FILE_CONTENT, "utf-8");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a CorpusResult with source=props-file when matching exports exist", () => {
    const result = extractFromPropsFile(propsFilePath, PLAIN_SOURCE);

    expect(result).not.toBeUndefined();
    expect(result!.source).toBe("props-file");
    expect(result!.bytes.length).toBeGreaterThan(0);
    expect(result!.path).toBe("parse-int-list.props.ts");
    expect(result!.contentHash.length).toBe(64); // BLAKE3-256 hex
  });

  it("returns undefined when the atom name has no matching prop_* exports", () => {
    const noMatchSource = `function unknownAtom(x: number): number { return x; }`;
    const result = extractFromPropsFile(propsFilePath, noMatchSource);
    expect(result).toBeUndefined();
  });

  it("returns undefined for an atom source with no inferable name", () => {
    const bareSource = `1 + 1;`;
    const result = extractFromPropsFile(propsFilePath, bareSource);
    expect(result).toBeUndefined();
  });

  it("returns undefined when the props file does not exist", () => {
    const result = extractFromPropsFile(join(tmpDir, "nonexistent.props.ts"), PLAIN_SOURCE);
    expect(result).toBeUndefined();
  });

  it("corpus bytes are the full props file content (deterministic)", () => {
    const r1 = extractFromPropsFile(propsFilePath, PLAIN_SOURCE);
    const r2 = extractFromPropsFile(propsFilePath, PLAIN_SOURCE);
    expect(r1).not.toBeUndefined();
    expect(r1!.contentHash).toBe(r2!.contentHash);
    expect(r1!.bytes).toEqual(r2!.bytes);
  });
});

describe("props-file internals — naming convention helpers", () => {
  it("inferAtomName extracts camelCase function names", () => {
    expect(inferAtomName("function parseIntList(x: string) {}")).toBe("parseIntList");
    expect(inferAtomName("const serializeEmbedding = (v: Float32Array) => Buffer.from(v);")).toBe(
      "serializeEmbedding",
    );
    expect(inferAtomName("1 + 1;")).toBeUndefined();
  });

  it("propExportAtomName extracts atom name from prop_* export names", () => {
    expect(propExportAtomName("prop_parseIntList_returns_array")).toBe("parseIntList");
    expect(propExportAtomName("prop_bytesToHex_length_is_double_input")).toBe("bytesToHex");
    expect(propExportAtomName("prop_validateStrictSubset_ok")).toBe("validateStrictSubset");
    expect(propExportAtomName("not_a_prop")).toBeUndefined();
    expect(propExportAtomName("prop_noUnderscore")).toBeUndefined();
  });

  it("hasMatchingExports finds prop_<atomName>_ pattern in file text", () => {
    expect(hasMatchingExports(PROPS_FILE_CONTENT, "parseIntList")).toBe(true);
    expect(hasMatchingExports(PROPS_FILE_CONTENT, "unknownAtom")).toBe(false);
  });
});

describe("extractCorpus() — source (0) props-file priority", () => {
  let tmpDir: string;
  let propsFilePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "yakcc-props-priority-test-"));
    propsFilePath = join(tmpDir, "parse-int-list.props.ts");
    writeFileSync(propsFilePath, PROPS_FILE_CONTENT, "utf-8");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("source (0) wins over source (a) when matching props file exists", async () => {
    const intentCard = makeIntentCard();
    const atomSpec: CorpusAtomSpec = {
      source: PLAIN_SOURCE,
      intentCard,
      propsFilePath,
    };

    const result = await extractCorpus(atomSpec);
    expect(result.source).toBe("props-file");
  });

  it("falls through to source (a) when enablePropsFile is false", async () => {
    const intentCard = makeIntentCard();
    const atomSpec: CorpusAtomSpec = {
      source: PLAIN_SOURCE,
      intentCard,
      propsFilePath,
    };

    const result = await extractCorpus(atomSpec, { enablePropsFile: false });
    expect(result.source).toBe("upstream-test");
  });

  it("falls through to source (a) when atom has no matching props exports", async () => {
    const intentCard = makeIntentCard();
    const atomSpec: CorpusAtomSpec = {
      source: `function unknownAtom() {}`,
      intentCard,
      propsFilePath,
    };

    const result = await extractCorpus(atomSpec);
    expect(result.source).toBe("upstream-test");
  });
});
