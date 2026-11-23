// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { bm25Search, buildBm25, reciprocalRankFusion, tokenize } from "./lexical.js";

describe("tokenize", () => {
  it("keeps whole identifiers and their camelCase and snake parts", () => {
    const t = tokenize("sanitizeFilename and parse_json");
    expect(t).toEqual(
      expect.arrayContaining([
        "sanitizefilename",
        "sanitize",
        "filename",
        "parse_json",
        "parse",
        "json",
      ]),
    );
  });
});

describe("BM25 lexical channel (WI-REUSE B3, #1260)", () => {
  const docs = [
    {
      id: "a",
      text: "Removes unsafe characters from a path so it can be written to disk: sanitizeFilename",
    },
    { id: "b", text: "Reads a file from disk and returns its contents as text" },
    { id: "c", text: "Adds two numbers together" },
  ];

  it("recovers the exact identifier that an embedding would blur", () => {
    const idx = buildBm25(docs);
    const hits = bm25Search(idx, "sanitizeFilename");
    expect(hits[0]?.id).toBe("a");
    expect(hits.map((h) => h.id)).not.toContain("c");
  });

  it("matches on a part of a compound identifier", () => {
    const idx = buildBm25(docs);
    expect(bm25Search(idx, "filename")[0]?.id).toBe("a");
  });

  it("a relevance cutoff drops hits that match only a generic token", () => {
    const idx = buildBm25(docs);
    const all = bm25Search(idx, "sanitizeFilename a value");
    const cut = bm25Search(idx, "sanitizeFilename a value", 10, { minRelative: 0.2 });
    expect(all.length).toBeGreaterThan(cut.length);
    expect(cut.map((h) => h.id)).toEqual(["a"]);
  });

  it("returns nothing for a query with no shared terms", () => {
    expect(bm25Search(buildBm25(docs), "zebra")).toEqual([]);
  });

  it("is deterministic", () => {
    const idx = buildBm25(docs);
    expect(bm25Search(idx, "disk file")).toEqual(bm25Search(idx, "disk file"));
  });
});

describe("reciprocal rank fusion (WI-REUSE B3, #1260)", () => {
  it("an item found by both channels outranks one found by only one", () => {
    const lexical = ["x", "a", "b"];
    const embedding = ["y", "a", "z"];
    const fused = reciprocalRankFusion([lexical, embedding]);
    expect(fused[0]?.id).toBe("a");
    expect(fused.map((h) => h.id)).toEqual(expect.arrayContaining(["x", "y", "z", "b"]));
  });

  it("keeps a single channel's order when the other is empty", () => {
    expect(reciprocalRankFusion([["p", "q"], []]).map((h) => h.id)).toEqual(["p", "q"]);
  });

  it("breaks score ties by first appearance", () => {
    expect(reciprocalRankFusion([["m"], ["n"]]).map((h) => h.id)).toEqual(["m", "n"]);
  });
});
