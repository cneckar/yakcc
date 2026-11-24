// SPDX-License-Identifier: MIT
// DUC implementations in the registry (#1291): an implementation by the pair (specHash, graph root),
// the structure once per identity, the links once per root, and what is attached to the pair
// (annotations, trust level, evidence, the TypeScript cache) beside it.
import type { EmbeddingProvider } from "@yakcc/contracts";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DucImplementationRow, Registry } from "./index.js";
import { SCHEMA_VERSION, applyMigrations } from "./schema.js";
import { openRegistry } from "./storage.js";

const embeddings: EmbeddingProvider = {
  dimension: 384,
  modelId: "test/zero",
  embed: async () => new Float32Array(384),
};

const row = (over: Partial<DucImplementationRow> = {}): DucImplementationRow => ({
  specHash: "spec-a",
  graphIdentity: "graph-1",
  graphRoot: "root-1",
  formatVersion: 3,
  lifterVersion: 42,
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

describe("DUC implementations (#1291)", () => {
  it("is at schema 19", () => {
    expect(SCHEMA_VERSION).toBe(19);
  });

  it("stores and loads an implementation by its contract and root", async () => {
    await registry.storeDucImplementation(
      row({
        tsCache: "export function f() {}",
        blockMerkleRoot: "block-1",
        blockRoot: "duc-block-1",
        trustLevel: "conforming",
        evidence: '[{"inputs":[1],"output":2}]',
        baseSet: '{"target":"ecmascript","version":1}',
      }),
    );
    const back = await registry.getDucImplementation("spec-a", "root-1");
    expect(back).toMatchObject({
      graphIdentity: "graph-1",
      graphRoot: "root-1",
      formatVersion: 3,
      lifterVersion: 42,
      structure: new Uint8Array([1, 2, 3, 4]),
      links: [{ reason: "free-identifier", symbol: "helper", spec: "spec-h" }],
      annotations: new Uint8Array([9, 9]),
      tsCache: "export function f() {}",
      blockMerkleRoot: "block-1",
      blockRoot: "duc-block-1",
      trustLevel: "conforming",
      evidence: '[{"inputs":[1],"output":2}]',
      baseSet: '{"target":"ecmascript","version":1}',
    });
    expect(await registry.getDucImplementation("spec-a", "root-2")).toBeNull();
  });

  it("one structure, two roots: the same graph linked two ways is two implementations", async () => {
    await registry.storeDucImplementation(row({ createdAt: 1 }));
    await registry.storeDucImplementation(
      row({
        graphRoot: "root-2",
        links: [{ reason: "free-identifier", symbol: "helper", spec: "spec-other" }],
        createdAt: 2,
      }),
    );
    expect(await registry.listDucImplementations("spec-a")).toEqual(["root-1", "root-2"]);
    expect((await registry.getDucImplementation("spec-a", "root-2"))?.links).toEqual([
      { reason: "free-identifier", symbol: "helper", spec: "spec-other" },
    ]);
    expect((await registry.getDucImplementation("spec-a", "root-1"))?.links).toEqual([
      { reason: "free-identifier", symbol: "helper", spec: "spec-h" },
    ]);
  });

  it("several graphs implement one contract, and one root several contracts", async () => {
    await registry.storeDucImplementation(row({ createdAt: 1 }));
    await registry.storeDucImplementation(
      row({ graphIdentity: "graph-2", graphRoot: "root-2", createdAt: 2 }),
    );
    await registry.storeDucImplementation(row({ specHash: "spec-b" }));
    expect(await registry.listDucImplementations("spec-a")).toEqual(["root-1", "root-2"]);
    expect(await registry.listDucImplementations("spec-b")).toEqual(["root-1"]);
  });

  it("is idempotent on the pair; what is attached is kept unless given anew", async () => {
    await registry.storeDucImplementation(row({ tsCache: "a", trustLevel: "claimed" }));
    await registry.storeDucImplementation(row({ tsCache: null, trustLevel: "corroborated" }));
    const back = await registry.getDucImplementation("spec-a", "root-1");
    expect(back?.tsCache).toBe("a");
    expect(back?.trustLevel).toBe("corroborated");
    expect(await registry.listDucImplementations("spec-a")).toEqual(["root-1"]);
  });

  it("refuses a trust level that is not one", async () => {
    await expect(
      registry.storeDucImplementation(row({ trustLevel: "trusted" as never })),
    ).rejects.toThrow(/CHECK constraint/);
  });

  it("an implementation received without a block keeps its contract; the contracts are listed", async () => {
    const spec = new TextEncoder().encode('{"name":"f"}');
    await registry.storeDucImplementation(row({ specCanonicalBytes: spec }));
    await registry.storeDucImplementation(row({ specHash: "spec-b" }));
    expect(await registry.getDucContract("spec-a")).toEqual(spec);
    expect(await registry.getDucContract("spec-b")).toBeNull();
    expect(await registry.enumerateDucSpecs()).toEqual(["spec-a", "spec-b"]);
  });

  it("stores a module record once, by its root", async () => {
    await registry.storeDucModule({ moduleRoot: "m-1", record: '{"id":"index.js"}' });
    await registry.storeDucModule({ moduleRoot: "m-1", record: '{"id":"changed"}' });
    expect((await registry.getDucModule("m-1"))?.record).toBe('{"id":"index.js"}');
    expect(await registry.getDucModule("m-2")).toBeNull();
  });
});

describe("migration 19 (#1291)", () => {
  it("a database with the provisional tables of 17 and 18 ends in the final form", () => {
    const db = new Database(":memory:");
    sqliteVec.load(db);
    db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
    applyMigrations(db);
    // Put back a provisional table, as a database migrated to 18 before this one had it.
    db.exec("DROP TABLE duc_implementations");
    db.exec(
      "CREATE TABLE duc_implementations (spec_hash TEXT, graph_identity TEXT, block_merkle_root TEXT, ts_cache TEXT, created_at INTEGER)",
    );
    db.exec("INSERT INTO duc_implementations VALUES ('s', 'g', NULL, NULL, 0)");
    db.prepare("UPDATE schema_version SET version = ?").run(18);
    applyMigrations(db);
    const columns = (
      db.prepare("PRAGMA table_info(duc_implementations)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns).toContain("graph_root");
    expect(columns).toContain("trust_level");
    expect(db.prepare("SELECT count(*) AS n FROM duc_implementations").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 19 });
    db.close();
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

  it("finds the stored graphs nearest a signature, with each implementation by contract and root", async () => {
    await reg.storeDucImplementation(
      row({ graphIdentity: "g-add", graphRoot: "r-add", signature: "ops + + +", createdAt: 1 }),
    );
    await reg.storeDucImplementation(
      row({
        specHash: "spec-b",
        graphIdentity: "g-add",
        graphRoot: "r-add",
        signature: "ops + + +",
        createdAt: 2,
      }),
    );
    await reg.storeDucImplementation(
      row({ graphIdentity: "g-mul", graphRoot: "r-mul", signature: "ops * * *" }),
    );
    await reg.storeDucImplementation(row({ graphIdentity: "g-none", graphRoot: "r-none" }));
    const found = await reg.findDucGraphsBySignature("ops + +", 5);
    expect(found.map((m) => m.graphIdentity)).toEqual(["g-add", "g-mul"]);
    expect(found[0]?.specHashes).toEqual(["spec-a", "spec-b"]);
    expect(found[0]?.implementations).toEqual([
      { specHash: "spec-a", graphRoot: "r-add" },
      { specHash: "spec-b", graphRoot: "r-add" },
    ]);
    expect(found[0]?.distance).toBeLessThan(found[1]?.distance ?? 0);
  });

  it("a graph stored without a signature is not indexed", async () => {
    await reg.storeDucImplementation(row());
    expect(await reg.findDucGraphsBySignature("anything", 3)).toEqual([]);
  });
});
