// SPDX-License-Identifier: MIT
// DUC implementations over the wire (#1291): serve → mirror → submit, every implementation received
// through the receiver's checks, stored by contract and root with the trust level it reached.
import { type EmbeddingProvider, type SpecYak, specHash } from "@yakcc/contracts";
import {
  type DucGraph,
  byMeaning,
  contractSignature,
  liftAtom,
  linkReferences,
  packGraph,
} from "@yakcc/duc";
import { type Registry, openRegistry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDucClient, mirrorDuc } from "./duc-client.js";
import { moduleRootOf, receiveDucSubmission } from "./duc-receive.js";
import type { ConformanceVector, ModuleRecord, SharedImplementation } from "./duc-submission.js";
import { type ServeHandle, serveRegistry } from "./serve.js";

const embeddings: EmbeddingProvider = {
  dimension: 384,
  modelId: "test/zero",
  embed: async () => new Float32Array(384),
};

function contract(name: string, inputs: string[], output: string): SpecYak {
  return {
    name,
    inputs: inputs.map((type, i) => ({ name: `a${i}`, type })),
    outputs: [{ name: "result", type: output }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior: `the ${name} contract`,
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe" },
    propertyTests: [],
  } as unknown as SpecYak;
}

function implementation(
  spec: SpecYak,
  graph: DucGraph,
  evidence: ConformanceVector[],
  over: Partial<SharedImplementation> = {},
): SharedImplementation {
  const packed = packGraph(byMeaning(graph, contractSignature(spec)));
  return {
    spec,
    specHash: specHash(spec),
    formatVersion: packed.formatVersion,
    structure: packed.structure,
    identity: packed.identity,
    root: packed.root,
    lifterVersion: packed.lifterVersion,
    links: packed.links,
    evidence,
    baseSet: { target: "ecmascript", version: 1 },
    ...over,
  };
}

const INC = contract("inc", ["number"], "number");
const TWICE = contract("twice", ["number"], "number");
const inc = implementation(
  INC,
  liftAtom("export function inc(x: number): number { return x + 1; }"),
  [{ inputs: [1], output: 2 }],
);
const twice = implementation(
  TWICE,
  linkReferences(
    liftAtom("export function twice(x: number): number { return inc(inc(x)); }"),
    (label) => (label.symbol === "inc" ? specHash(INC) : undefined),
  ),
  [{ inputs: [1], output: 3 }],
);

let source: Registry;
let target: Registry;
let served: ServeHandle;
beforeEach(async () => {
  source = await openRegistry(":memory:", { embeddings });
  target = await openRegistry(":memory:", { embeddings });
  served = await serveRegistry(source);
});
afterEach(async () => {
  await served.close();
  await source.close();
  await target.close();
});

describe("DUC implementations over the wire (#1291)", () => {
  it("received, stored by contract and root with the trust level reached", async () => {
    const verdict = await receiveDucSubmission(source, [inc, twice]);
    expect(verdict.accepted).toBe(true);
    expect(await source.listDucImplementations(specHash(TWICE))).toEqual([twice.root]);
    const row = await source.getDucImplementation(specHash(TWICE), twice.root);
    expect(row?.trustLevel).toBe("conforming");
    expect(row?.links).toEqual([{ reason: "free-identifier", symbol: "inc", spec: specHash(INC) }]);
    expect(
      new TextDecoder().decode((await source.getDucContract(specHash(TWICE))) ?? undefined),
    ).toContain('"name":"twice"');
  });

  it("served and mirrored: the mirror receives through the checks, and holds the same roots", async () => {
    await receiveDucSubmission(source, [inc, twice]);
    const client = createDucClient(served.url);
    expect([...(await client.listSpecs())].sort()).toEqual([specHash(INC), specHash(TWICE)].sort());
    const report = await mirrorDuc(client, target);
    expect(report).toMatchObject({ fetched: 2, stored: 2, refused: [], failures: [] });
    expect(await target.listDucImplementations(specHash(TWICE))).toEqual([twice.root]);
    expect((await target.getDucImplementation(specHash(INC), inc.root))?.trustLevel).toBe(
      "conforming",
    );
    // A second mirror fetches nothing it holds.
    expect(await mirrorDuc(client, target)).toMatchObject({ fetched: 0, stored: 0 });
  });

  it("submitted: a tampered root is refused and not stored; a good one is stored", async () => {
    const client = createDucClient(served.url);
    const tampered = { ...inc, root: "0".repeat(64) };
    const refused = await client.submit([tampered]);
    expect(refused.accepted).toBe(false);
    expect(refused.implementations[0]?.refused?.check).toBe("integrity");
    expect(await source.listDucImplementations(specHash(INC))).toEqual([]);
    const ok = await client.submit([inc]);
    expect(ok.accepted).toBe(true);
    expect(await source.listDucImplementations(specHash(INC))).toEqual([inc.root]);
  });

  it("evidence the graph does not compute is refused over the wire too", async () => {
    const client = createDucClient(served.url);
    const wrong = implementation(
      INC,
      liftAtom("export function inc(x: number): number { return x + 2; }"),
      [{ inputs: [1], output: 2 }],
    );
    const verdict = await client.submit([wrong]);
    expect(verdict.implementations[0]?.refused?.check).toBe("conformance");
    expect(await source.listDucImplementations(specHash(INC))).toEqual([]);
  });

  it("a module record is stored by its root and served", async () => {
    const module: ModuleRecord = {
      id: "index.js",
      statements: [
        { specHash: specHash(INC), identity: inc.identity, kind: "function", declares: ["inc"] },
      ],
    };
    await receiveDucSubmission(source, [inc], [module]);
    const client = createDucClient(served.url);
    expect(await client.fetchModule(moduleRootOf(module))).toEqual(module);
  });

  it("a malformed submission is a 400 with the reason", async () => {
    const res = await fetch(`${served.url}/v1/duc/submit`, {
      method: "POST",
      body: JSON.stringify({ implementations: [{ specHash: "x" }] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toMatch(/duc wire/);
  });
});
