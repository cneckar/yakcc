import { parseModuleIndex } from "@yakcc/discovery-search";
import { describe, expect, it } from "vitest";
import type { HttpClient } from "../http-client.js";
import { type ModuleToolDeps, makeFindModulesTool, makeGetModuleTool } from "./modules.js";

const http = {} as HttpClient;
const index = parseModuleIndex({
  version: 1,
  model: "test-model",
  entries: [
    {
      id: "csv/parse",
      pkg: "csv",
      sourceFile: "csv/sync.js",
      name: "parse",
      text: "csv › parse(input, options) [entry]\nParse CSV text into records, with quoting and delimiters.",
      closureTokens: 14728,
      closure: ["csv/parse", "csv/transform"],
    },
    {
      id: "semver/maxSatisfying",
      pkg: "semver",
      sourceFile: "semver/max.js",
      name: "maxSatisfying",
      text: "semver › maxSatisfying(versions, range) [entry]\nHighest version satisfying a range.",
      closureTokens: 6896,
      closure: ["semver/maxSatisfying"],
    },
  ],
  vectors: [
    [1, 0],
    [0, 1],
  ],
  sources: {
    "csv/parse": "function parse(input) { return transform(input); }",
    "csv/transform": "function transform(x) { return x; }",
    "semver/maxSatisfying": "function maxSatisfying() {}",
  },
});
const deps = (over: Partial<ModuleToolDeps> = {}): ModuleToolDeps => ({
  loadIndex: async () => index,
  embed: async (t) => ({
    vector: Float32Array.from(/csv/i.test(t) ? [1, 0] : [0, 1]),
    model: "test-model",
  }),
  ...over,
});
const json = async (p: Promise<{ text: string }[]>) => JSON.parse((await p)[0]?.text ?? "null");

describe("yakcc_find_modules (DEC-MCP-MODULES-001)", () => {
  it("returns ordered candidates with names and what each costs to write, and no verdict", async () => {
    const tool = makeFindModulesTool(deps());
    const r = await json(tool.handler({ need: "parse CSV text into records", k: 2 }, http));
    expect(r.candidates.map((c: { id: string }) => c.id)).toEqual([
      "csv/parse",
      "semver/maxSatisfying",
    ]);
    expect(r.candidates[0]).toMatchObject({ pick: 1, closureTokens: 14728 });
    expect(r.candidates[0].module).toMatch(/Parse CSV text/);
    expect(JSON.stringify(r)).not.toMatch(/"score"|"match"|"accept"/);
    expect(r.note).toMatch(/otherwise write it/);
  });

  it("validates input and reports errors as content", async () => {
    const tool = makeFindModulesTool(deps());
    expect((await json(tool.handler({}, http))).error).toBe("invalid_input");
    expect((await json(tool.handler({ need: "x", k: 50 }, http))).error).toBe("invalid_input");
    const noIndex = makeFindModulesTool(
      deps({ loadIndex: async () => Promise.reject(new Error("unset")) }),
    );
    expect(await json(noIndex.handler({ need: "x" }, http))).toEqual({
      error: "index_unavailable",
      message: "unset",
    });
  });

  it("refuses a query embedded with a different model than the index", async () => {
    const tool = makeFindModulesTool(
      deps({ embed: async () => ({ vector: Float32Array.from([1, 0]), model: "other" }) }),
    );
    expect((await json(tool.handler({ need: "parse csv" }, http))).error).toBe("model_mismatch");
  });

  it("the default tool explains how to get an index when YAKCC_MODULE_INDEX is unset", async () => {
    const saved = process.env.YAKCC_MODULE_INDEX;
    Reflect.deleteProperty(process.env, "YAKCC_MODULE_INDEX");
    try {
      const r = await json(makeFindModulesTool().handler({ need: "x" }, http));
      expect(r.error).toBe("index_unavailable");
      expect(r.message).toMatch(/build-module-index/);
    } finally {
      if (saved !== undefined) process.env.YAKCC_MODULE_INDEX = saved;
    }
  });
});

describe("yakcc_get_module", () => {
  it("returns the root first, then its closure", async () => {
    const r = await json(makeGetModuleTool(deps()).handler({ id: "csv/parse" }, http));
    expect(r.definitions.map((d: { id: string }) => d.id)).toEqual(["csv/parse", "csv/transform"]);
    expect(r.definitions[1].source).toMatch(/function transform/);
  });
  it("not_found for an unknown id, invalid_input for a missing one", async () => {
    const tool = makeGetModuleTool(deps());
    expect((await json(tool.handler({ id: "nope" }, http))).error).toBe("not_found");
    expect((await json(tool.handler({}, http))).error).toBe("invalid_input");
  });
});
