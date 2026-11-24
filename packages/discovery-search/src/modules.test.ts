// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  type ModuleEntry,
  bm25Rank,
  denseRank,
  moduleSource,
  parseModuleIndex,
  searchModules,
  tokenize,
} from "./modules.js";

const entry = (id: string, text: string, closure: string[] = [id]): ModuleEntry => ({
  id,
  pkg: id.split("/")[0] ?? id,
  sourceFile: `${id}.js`,
  name: id,
  text,
  closureTokens: 100,
  closure,
});

const unit = (xs: number[]) => {
  const n = Math.hypot(...xs);
  return Float32Array.from(xs.map((x) => x / n));
};

const index = parseModuleIndex({
  version: 1,
  model: "test-model",
  entries: [
    entry(
      "csv/parse",
      "csv › parse(input, options) parse CSV text into records; quotes delimiter columns",
      ["csv/parse", "csv/tokenize"],
    ),
    entry("semver/satisfies", "semver › satisfies(version, range) check a version against a range"),
    entry("lru/LRUCache", "lru › LRUCache bounded cache evicting least recently used entries ttl"),
  ],
  vectors: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  sources: { "csv/parse": "function parse() {}", "csv/tokenize": "function tokenize() {}" },
});

describe("module discovery (DEC-DISCOVERY-MODULES-001)", () => {
  it("tokenizes identifier wholes and parts, as the registry's lexical channel does", () => {
    expect(tokenize("maxSatisfying parse_iso")).toEqual([
      "maxsatisfying",
      "max",
      "satisfying",
      "parse_iso",
      "parse",
      "iso",
    ]);
  });

  it("BM25 finds the entry that shares rare words with the query", () => {
    expect(
      bm25Rank(
        index.entries.map((e) => e.text),
        "least recently used cache",
      )[0],
    ).toBe(2);
    expect(
      bm25Rank(
        index.entries.map((e) => e.text),
        "nothing matches here",
      ),
    ).toEqual([]);
  });

  it("dense ranking orders by dot product", () => {
    expect(denseRank(unit([0.1, 0.9, 0.2]), index.vectors)).toEqual([1, 2, 0]);
  });

  it("fuses both channels and reports which found each hit", () => {
    const hits = searchModules(index, unit([0.9, 0.1, 0.1]), "parse CSV records with quotes", {
      k: 2,
    });
    expect(hits[0]?.entry.id).toBe("csv/parse");
    expect(hits[0]?.channels).toEqual(["dense", "lexical"]);
    expect(hits).toHaveLength(2);
  });

  it("a lexical-only hit can outrank a weak dense one", () => {
    // The vector points at semver, but the words point at the cache.
    const hits = searchModules(index, unit([0.2, 0.9, 0.3]), "bounded cache with ttl eviction", {
      k: 3,
    });
    expect(hits.map((h) => h.entry.id).slice(0, 2)).toContain("lru/LRUCache");
  });

  it("returns a module's closure sources, root first, and null for an unknown id", () => {
    expect(moduleSource(index, "csv/parse")?.map((s) => s.id)).toEqual([
      "csv/parse",
      "csv/tokenize",
    ]);
    expect(moduleSource(index, "nope")).toBeNull();
  });

  it("rejects malformed indexes", () => {
    expect(() => parseModuleIndex({ model: "m", entries: [entry("a", "a")], vectors: [] })).toThrow(
      TypeError,
    );
    expect(() => parseModuleIndex({})).toThrow(TypeError);
  });
});
