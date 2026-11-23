import type { EmbeddingProvider } from "@yakcc/contracts";
// SPDX-License-Identifier: MIT
// DUC implementations in the registry (#1279): stored by the pair (specHash, graph identity), with
// the structure once per identity, and links and annotations as their own records.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DucImplementationRow, Registry } from "./index.js";
import { SCHEMA_VERSION } from "./schema.js";
import { openRegistry } from "./storage.js";

const embeddings: EmbeddingProvider = {
  dimension: 384,
  modelId: "test/zero",
  embed: async () => new Float32Array(384),
};

const row = (over: Partial<DucImplementationRow> = {}): DucImplementationRow => ({
  specHash: "spec-a",
  graphIdentity: "graph-1",
  formatVersion: 1,
  lifterVersion: 1,
  structure: new Uint8Array([1, 2, 3, 4]),
  links: [{ reason: "free-identifier", symbol: "helper", spec: "spec-h" }],
  annotations: new Uint8Array([9, 9]),
  ...over,
});

let registry: Registry;
beforeEach(async () => {
  registry = await openRegistry(":memory:", { embeddings });
});
afterEach(async () => {
  await registry.close();
});

describe("DUC implementations (#1279)", () => {
  it("is at schema 18", () => {
    expect(SCHEMA_VERSION).toBe(18);
  });

  it("stores and loads an implementation by its pair", async () => {
    await registry.storeDucImplementation(
      row({ tsCache: "export function f() {}", blockMerkleRoot: "block-1" }),
    );
    const back = await registry.getDucImplementation("spec-a", "graph-1");
    expect(back?.structure).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(back?.links).toEqual([{ reason: "free-identifier", symbol: "helper", spec: "spec-h" }]);
    expect(back?.annotations).toEqual(new Uint8Array([9, 9]));
    expect(back?.tsCache).toBe("export function f() {}");
    expect(back?.blockMerkleRoot).toBe("block-1");
    expect(await registry.getDucImplementation("spec-a", "graph-2")).toBeNull();
  });

  it("several graphs implement one contract, and one graph several contracts", async () => {
    await registry.storeDucImplementation(row({ graphIdentity: "graph-1", createdAt: 1 }));
    await registry.storeDucImplementation(row({ graphIdentity: "graph-2", createdAt: 2 }));
    await registry.storeDucImplementation(
      row({ specHash: "spec-b", graphIdentity: "graph-1", links: [] }),
    );
    expect(await registry.listDucImplementations("spec-a")).toEqual(["graph-1", "graph-2"]);
    expect(await registry.listDucImplementations("spec-b")).toEqual(["graph-1"]);
    // The same structure under another contract can be linked differently.
    expect((await registry.getDucImplementation("spec-b", "graph-1"))?.links).toEqual([]);
  });

  it("is idempotent on the pair, and a later store replaces the links", async () => {
    await registry.storeDucImplementation(row());
    await registry.storeDucImplementation(
      row({
        links: [{ reason: "unlinked-reference", symbol: "x", module: "./m", spec: "spec-x" }],
        tsCache: null,
      }),
    );
    const back = await registry.getDucImplementation("spec-a", "graph-1");
    expect(back?.links).toEqual([
      { reason: "unlinked-reference", symbol: "x", module: "./m", spec: "spec-x" },
    ]);
    expect(await registry.listDucImplementations("spec-a")).toEqual(["graph-1"]);
  });
});

describe("graph search by retrieval signature (#1280)", () => {
  // A deterministic embedder: each character's count, folded into 384 dimensions.
  const counting: EmbeddingProvider = {
    dimension: 384,
    modelId: "test/counting",
    embed: async (text) => {
      const v = new Float32Array(384);
      for (const ch of text)
        v[(ch.codePointAt(0) ?? 0) % 384] = (v[(ch.codePointAt(0) ?? 0) % 384] ?? 0) + 1;
      return v;
    },
  };
  let reg: Registry;
  beforeEach(async () => {
    reg = await openRegistry(":memory:", { embeddings: counting });
  });
  afterEach(async () => {
    await reg.close();
  });

  it("finds the stored graphs nearest a signature, with the contracts each implements", async () => {
    await reg.storeDucImplementation(row({ graphIdentity: "g-add", signature: "ops + + +" }));
    await reg.storeDucImplementation(
      row({ specHash: "spec-b", graphIdentity: "g-add", signature: "ops + + +" }),
    );
    await reg.storeDucImplementation(row({ graphIdentity: "g-mul", signature: "ops * * *" }));
    await reg.storeDucImplementation(row({ graphIdentity: "g-none" }));
    const found = await reg.findDucGraphsBySignature("ops + +", 5);
    expect(found.map((m) => m.graphIdentity)).toEqual(["g-add", "g-mul"]);
    expect(found[0]?.specHashes).toEqual(["spec-a", "spec-b"]);
    expect(found[0]?.distance).toBeLessThan(found[1]?.distance ?? 0);
    expect(await reg.findDucGraphsBySignature("ops * *", 1)).toEqual([
      expect.objectContaining({ graphIdentity: "g-mul", specHashes: ["spec-a"] }),
    ]);
  });

  it("a graph stored without a signature is not indexed", async () => {
    await reg.storeDucImplementation(row());
    expect(await reg.findDucGraphsBySignature("anything", 3)).toEqual([]);
  });
});
