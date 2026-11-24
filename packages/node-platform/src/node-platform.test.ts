// SPDX-License-Identifier: Apache-2.0
// Node's library through the real pipeline (#1331), and its bindings classified (#1331's DEC).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BINDINGS, memberLayer } from "./bindings.js";
import { NODE_LIB, nodeModuleIds, shaveNodeModule } from "./shave-node.js";

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

describe("milestone modules shave through the real pipeline, every atom passing the gate", () => {
  // #1331's acceptance: path, util, url, events, buffer, string_decoder.
  for (const id of ["path", "util", "url", "events", "buffer", "string_decoder"])
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
