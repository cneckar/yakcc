// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { EMIT_CASES } from "./__fixtures__/emit-cases.js";
import { graphIdentity } from "./canonical.js";
import { linkReferences } from "./closure.js";
import { liftAtom } from "./lift.js";
import { GRAPH_FORMAT_VERSION, packGraph, unpackGraph } from "./store.js";

describe("the stored form of a graph (#1279)", () => {
  it("packs and unpacks every emitter source with its identity unchanged", () => {
    for (const tc of EMIT_CASES) {
      const g = liftAtom(tc.source);
      const packed = packGraph(g);
      expect(packed.identity).toBe(graphIdentity(g));
      expect(graphIdentity(unpackGraph(packed))).toBe(packed.identity);
    }
  });

  it("the structure holds no origin text and no link", () => {
    const g = liftAtom("export function f(secretName: number) { return helper(secretName); }");
    const linked = linkReferences(g, (d) => (d.symbol === "helper" ? "spec-of-helper" : undefined));
    const packed = packGraph(linked);
    const bare = unpackGraph({ ...packed, links: [], annotations: undefined });
    expect(JSON.stringify(bare)).not.toContain("secretName");
    expect(JSON.stringify(bare)).not.toContain("spec-of-helper");
    // The same structure, linked or not, is the same stored bytes.
    expect(Buffer.from(packPlain(g)).equals(Buffer.from(packed.structure))).toBe(true);
  });

  it("links and annotations come back when given", () => {
    const g = liftAtom("export function f(secretName: number) { return helper(secretName); }");
    const linked = linkReferences(g, (d) => (d.symbol === "helper" ? "spec-of-helper" : undefined));
    const packed = packGraph(linked);
    expect(packed.links).toEqual([
      { reason: "free-identifier", symbol: "helper", spec: "spec-of-helper" },
    ]);
    const back = unpackGraph(packed);
    expect(back.nodes.find((n) => n.diamond?.symbol === "helper")?.diamond?.spec).toBe(
      "spec-of-helper",
    );
    expect(JSON.stringify(back)).toContain("secretName");
  });

  it("closures keep their structure, links and annotations", () => {
    const g = liftAtom(
      "export function f(k: number) { const add = (yy: number) => helper(yy) + k; return add(1); }",
    );
    const linked = linkReferences(g, (d) => (d.symbol === "helper" ? "h" : undefined));
    const back = unpackGraph(packGraph(linked));
    expect(graphIdentity(back)).toBe(graphIdentity(g));
    // `helper` is a capture of the closure, so its reference, and its link, are the enclosing graph's.
    expect(back.nodes.find((n) => n.diamond?.symbol === "helper")?.diamond?.spec).toBe("h");
    const closure = back.nodes.find((n) => n.closure !== undefined)?.closure;
    expect(JSON.stringify(closure)).toContain("yy");
  });

  it("a format it does not read is refused", () => {
    const packed = packGraph(liftAtom("export function f(x: number) { return x; }"));
    expect(() => unpackGraph({ ...packed, formatVersion: GRAPH_FORMAT_VERSION + 1 })).toThrow(
      /format/,
    );
  });
});

function packPlain(g: ReturnType<typeof liftAtom>): Uint8Array {
  return packGraph(g).structure;
}
