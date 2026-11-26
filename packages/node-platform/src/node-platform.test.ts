// SPDX-License-Identifier: Apache-2.0
// Node's library through the real pipeline (#1331), and its bindings classified (#1331's DEC).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BINDINGS, memberLayer } from "./bindings.js";
import {
  NODE_LIB,
  UNDEFINED_IN_NODE,
  WRAPPER_PARAMS,
  boundNames,
  nodeModuleIds,
  shaveNodeModule,
} from "./shave-node.js";

const manifest = JSON.parse(readFileSync(join(NODE_LIB, "..", "manifest.json"), "utf8")) as {
  node: string;
  modules: string[];
  bindings: Record<string, string[] | null>;
};

describe("the vendored library", () => {
  it("is Node v22.23.5's, every builtin module of it", () => {
    expect(manifest.node).toBe("v22.23.5");
    expect(nodeModuleIds()).toEqual(manifest.modules);
    expect(manifest.modules.length).toBe(359);
  });
});

describe("internalBinding, classified", () => {
  it("every binding the library names is classified, and nothing else is", () => {
    expect(Object.keys(BINDINGS).sort()).toEqual(Object.keys(manifest.bindings).sort());
  });

  it("each member exception names a member the binding has", () => {
    for (const [name, b] of Object.entries(BINDINGS))
      for (const member of Object.keys(b.members ?? {}))
        expect(manifest.bindings[name], `${name}.${member}`).toContain(member);
  });

  it("a member's layer is its exception's, else its binding's", () => {
    expect(memberLayer("fs", "open")).toBe("os");
    expect(memberLayer("buffer", "compare")).toBe("logic");
    expect(memberLayer("crypto", "RandomBytesJob")).toBe("os");
    expect(memberLayer("nope", "x")).toBeUndefined();
  });
});

describe("the names a module runs with bound", () => {
  it("V8's profiling tools run in the context v8_prof_processor makes and v8_prof_polyfill fills", () => {
    const tools = boundNames("internal/deps/v8/tools/profile");
    for (const name of ["print", "printErr", "read", "write", "quit", "os", "arguments"])
      expect(tools.has(name), name).toBe(true);
    expect(boundNames("path")).toBe(WRAPPER_PARAMS);
  });

  it("a name Node does not define passes the gate only on the allowlist, with its reason (#1173)", async () => {
    for (const names of Object.values(UNDEFINED_IN_NODE))
      for (const [name, reason] of Object.entries(names)) expect(reason, name).not.toBe("");
    const r = await shaveNodeModule("internal/deps/cjs-module-lexer/lexer");
    expect(r.unexplained).toEqual({});
    expect(r.allowed).toEqual({ syntaxError: 1 });
    expect(r.clean).toBe(r.atoms);
  }, 300_000);
});

describe("milestone modules shave through the real pipeline, every atom passing the gate", () => {
  // #1331's acceptance: path, util, url, events, buffer, string_decoder; and modules that found a
  // gap in the measurement of the whole library: `globalThis` destructured from primordials
  // (internal/test/binding), and a function hoisted over its own block's const in two blocks
  // (stream).
  for (const id of [
    "path",
    "util",
    "url",
    "events",
    "buffer",
    "string_decoder",
    "internal/test/binding",
    "stream",
  ])
    it(id, async () => {
      const r = await shaveNodeModule(id);
      expect(r.atoms, id).toBeGreaterThan(0);
      expect(r.liftErrors, id).toEqual([]);
      expect(r.unfaithful, id).toEqual([]);
      expect(r.unexplained, id).toEqual({});
      expect(r.clean, id).toBe(r.atoms);
      for (const b of r.bindings) expect(BINDINGS[b], `${id} reads ${b}`).toBeDefined();
    });
});
