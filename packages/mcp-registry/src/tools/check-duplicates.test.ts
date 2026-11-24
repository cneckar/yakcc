/**
 * Tests for yakcc_check_duplicates and the behavior module (DEC-MCP-CHECK-DUPLICATES-001,
 * DEC-MCP-BEHAVIOR-001): loading new code, verdicts, a small index with stored code, and the
 * pins that keep the codec and probes identical to the bench that measured them (B15).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type BehaviorEntry,
  type BehaviorIndex,
  CODEC,
  call,
  findNeighbors,
  fitsType,
  loadFunction,
  outputKey,
  probeArgs,
  verdict,
} from "../behavior.js";
import { makeCheckDuplicatesTool } from "./check-duplicates.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const REVERSE_STORED = "function reverse(s) { return String(s).split('').reverse().join(''); }";
const UPPER_STORED = "function upper(s) { return String(s).toUpperCase(); }";

/** An index entry recorded from stored source, the way the build script records it. */
function entry(id: string, source: string, name: string, text: string): BehaviorEntry {
  const f = loadFunction(source, name);
  return {
    id,
    pkg: "fixture",
    name,
    sourceFile: `fixture/${name}.js`,
    arity: 1,
    text,
    probes: probeArgs(1).map((a) => call(f, a)),
    examples: [],
  };
}

const index: BehaviorIndex = {
  version: 1,
  entries: [
    entry("rev", REVERSE_STORED, "reverse", "Reverses the characters of a string."),
    entry("up", UPPER_STORED, "upper", "Upper-cases a string."),
  ],
  files: {
    "fixture/reverse.js": {
      js: `${REVERSE_STORED}\n;module.__picked = { reverse: reverse };`,
      deps: {},
    },
    "fixture/upper.js": { js: `${UPPER_STORED}\n;module.__picked = { upper: upper };`, deps: {} },
  },
};

const tool = makeCheckDuplicatesTool({ loadIndex: async () => index });
const run = async (args: unknown) => {
  const out = await tool.handler(args, undefined as never);
  return JSON.parse(out[0]?.text ?? "null");
};

describe("loadFunction", () => {
  it("loads TypeScript with export, and picks the named or first function", () => {
    const f = loadFunction("export function twice(n: number): number { return n * 2; }");
    expect(call(f, [3])).toEqual({ ok: true, key: "6", informative: true });
  });
  it("refuses imports and has no host globals", () => {
    expect(() => loadFunction("import x from 'y';\nexport function f() { return x; }")).toThrow(
      /no imports/,
    );
    const f = loadFunction("function g() { return typeof process + typeof require; }");
    expect(call(f, [])).toMatchObject({ ok: true, key: '"undefinedundefined"' });
  });
  it("bounds a hang", () => {
    const f = loadFunction("function h() { for (;;) {} }");
    expect(call(f, [])).toEqual({ ok: false, error: "timeout" });
  });
});

describe("verdicts and types", () => {
  it("a rewrite is equivalent to its stored twin; text and behavior both find it", async () => {
    const r = await run({
      code: "export function rev(s: string): string { let o = ''; for (let i = s.length - 1; i >= 0; i--) o += s[i]; return o; }",
      paramTypes: ["string"],
      description: "reverse a string",
      examples: [{ args: ["abc"], returns: "cba" }],
    });
    expect(r.passesOwnExamples).toBe(true);
    expect(r.neighbors[0]).toMatchObject({ id: "rev", verdict: "equivalent", ranOnExamples: true });
    expect(r.neighbors[0].from).toEqual(["behavior", "text"]);
    expect(r.neighbors.find((n: { id: string }) => n.id === "up").verdict).toBe("different");
  });
  it("near: an edge-case difference is reported with its input", () => {
    const f = loadFunction(
      "function rev(s) { return s.length > 20 ? s : s.split('').reverse().join(''); }",
    );
    const { neighbors } = findNeighbors(index, f, { arity: 1, paramTypes: ["string"] });
    const rev = neighbors.find((n) => n.id === "rev");
    expect(rev?.verdict).toBe("near");
    expect(rev?.counterexamples[0]?.args).toEqual(["109156be-c4fb-41ea-b1b4-efe1671c5836"]);
  });
  it("functions that return nothing useful are inconclusive", () => {
    expect(
      verdict({ comparable: 5, agree: 5, informative: 0, distinct: 0, counterexamples: [] }),
    ).toBe("inconclusive");
  });
  it("keeps probes inside the declared types", () => {
    expect(fitsType([["a", "b"]], "[string, string][]")).toBe(true);
    expect(fitsType([1, 2], "[string, string][]")).toBe(false);
    expect(fitsType("x", "unknown")).toBe(true);
  });
  it("hashes long outputs", () => {
    expect(outputKey("x".repeat(200))).toMatch(/^#[0-9a-f]{16}$/);
  });
});

describe("errors come back as content", () => {
  it("bad arguments, unloadable code, a missing index", async () => {
    expect((await run({ code: "", paramTypes: [] })).error).toBe("invalid_args");
    expect((await run({ code: "not code (", paramTypes: [] })).error).toBe("code_not_loadable");
    const noIndex = makeCheckDuplicatesTool({
      loadIndex: () => Promise.reject(new Error("YAKCC_BEHAVIOR_INDEX is not set")),
    });
    const out = JSON.parse(
      (await noIndex.handler({ code: "function f() {}", paramTypes: [] }, undefined as never))[0]
        ?.text ?? "null",
    );
    expect(out.error).toBe("index_unavailable");
  });
});

describe("pinned to the bench that measured it (B12 probes and codec, B15)", () => {
  it("uses the same codec as B12's sandbox", () => {
    const sandbox = readFileSync(join(repo, "bench/B12-need-to-code/harness/sandbox.mjs"), "utf8");
    expect(sandbox.includes(CODEC)).toBe(true);
  });
  it("uses the same probe inputs as B12's cards", async () => {
    const cards = await import(
      pathToFileURL(join(repo, "bench/B12-need-to-code/harness/cards.mjs")).href
    );
    for (const arity of [0, 1, 2, 3, 4]) expect(probeArgs(arity)).toEqual(cards.probeArgs(arity));
  });
});
