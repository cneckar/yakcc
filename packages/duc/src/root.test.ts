// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { liftAtom } from "./lift.js";
import { rootedGraph } from "./root.js";
import { packGraph } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The relative modules a source imports, at run time (type-only imports aside). */
function importsOf(file: string): string[] {
  const text = readFileSync(join(here, file), "utf8");
  return [...text.matchAll(/^import (?!type )[^;]*?from "([^"]+)";|^import "([^"]+)";/gms)].map(
    (m) => (m[1] ?? m[2]) as string,
  );
}

describe("a graph's root, without the store (#1370)", () => {
  it("is packGraph's root, identity and links", () => {
    const g = liftAtom(
      "export function f(x: number, o: { k: number }) { const s = Math.sin(x) + o.k; return s > 1 ? g(s) : s; }",
    );
    const packed = packGraph(g);
    const rooted = rootedGraph(g);
    expect(rooted.root).toBe(packed.root);
    expect(rooted.identity).toBe(packed.identity);
    expect(rooted.links).toEqual(packed.links);
    expect(rooted.links.some((l) => l.reason === "operation")).toBe(true);
  });

  it("imports no node: module and not the lifter, the store or the atom library", () => {
    const seen = new Set<string>();
    const pending = ["root.ts"];
    const outside: string[] = [];
    while (pending.length > 0) {
      const file = pending.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of importsOf(file)) {
        if (spec.startsWith("./")) pending.push(spec.slice(2).replace(/\.js$/, ".ts"));
        else if (!spec.startsWith("@noble/hashes/")) outside.push(`${file}: ${spec}`);
      }
    }
    expect(outside).toEqual([]);
    expect([...seen]).toEqual(
      expect.arrayContaining(["canonical.ts", "operation-refs.ts", "ops.ts"]),
    );
    for (const heavy of ["lift.ts", "store.ts", "operations.ts"])
      expect(seen.has(heavy)).toBe(false);
  });
});
