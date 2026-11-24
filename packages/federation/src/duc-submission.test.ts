// SPDX-License-Identifier: MIT
/**
 * duc-submission.test.ts — the receiver's checks for a shared submission (#1287,
 * DEC-DUC-TRUST-MODEL-001). One test per failure mode in the decision's table: the check named for
 * it refuses it, and no earlier check does (the refusal names the first check that failed).
 *
 * Production sequence: liftAtom(source) → linkReferences → packGraph → SharedImplementation
 *   → checkSharedSubmission(batch, store) → verdict per implementation.
 */
import { brotliCompressSync } from "node:zlib";
import { type SpecYak, specHash } from "@yakcc/contracts";
import { type DucGraph, graphIdentity, liftAtom, linkReferences, packGraph } from "@yakcc/duc";
import { describe, expect, it } from "vitest";
import {
  type ConformanceVector,
  type ReceiverStore,
  type SharedImplementation,
  type StoredImplementation,
  checkSharedSubmission,
} from "./duc-submission.js";

function contract(name: string, inputs: string[], output: string, effects: string[] = []): SpecYak {
  return {
    name,
    inputs: inputs.map((type, i) => ({ name: `a${i}`, type })),
    outputs: [{ name: "result", type: output }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects,
    level: "L0",
    behavior: `the ${name} contract`,
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: effects.length === 0 ? "pure" : "io", threadSafety: "safe" },
    propertyTests: [],
  } as unknown as SpecYak;
}

function implementation(
  spec: SpecYak,
  graph: DucGraph,
  evidence: ConformanceVector[] = [],
  over: Partial<SharedImplementation> = {},
): SharedImplementation {
  const packed = packGraph(graph);
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

const emptyStore: ReceiverStore = { contracts: new Set(), implementationsOf: () => [] };

function storeOf(spec: string, impls: StoredImplementation[]): ReceiverStore {
  return {
    contracts: new Set([spec]),
    implementationsOf: (s) => (s === spec ? impls : []),
  };
}

const CLAMP_SPEC = contract("clamp", ["number", "number", "number"], "number");
const CLAMP = liftAtom(
  "export function clamp(x: number, lo: number, hi: number): number { if (x < lo) return lo; if (x > hi) return hi; return x; }",
);
const CLAMP_VECTORS: ConformanceVector[] = [
  { inputs: [5, 0, 10], output: 5 },
  { inputs: [-3, 0, 10], output: 0 },
  { inputs: [42, 0, 10], output: 10 },
];

async function verdictOf(impl: SharedImplementation, store = emptyStore, options = {}) {
  const v = await checkSharedSubmission([impl], store, options);
  return v.implementations[0];
}

describe("the receiver's checks, in order (#1287)", () => {
  it("admits a closed, well-typed graph that computes its evidence as conforming", async () => {
    const v = await verdictOf(implementation(CLAMP_SPEC, CLAMP, CLAMP_VECTORS));
    expect(v?.refused).toBeUndefined();
    expect(v?.level).toBe("conforming");
  });

  it("a graph with no evidence is admitted as a claim", async () => {
    const v = await verdictOf(implementation(CLAMP_SPEC, CLAMP));
    expect(v?.level).toBe("claimed");
  });

  it("1 decode: corrupt bytes, and a structure over the size cap", async () => {
    const corrupt = implementation(CLAMP_SPEC, CLAMP, [], {
      structure: new Uint8Array([1, 2, 3, 4, 5]),
    });
    expect((await verdictOf(corrupt))?.refused?.check).toBe("decode");
    const bomb = implementation(CLAMP_SPEC, CLAMP, [], {
      structure: brotliCompressSync(Buffer.alloc(1 << 20, 0x20)),
    });
    const v = await verdictOf(bomb, emptyStore, { maxStructureBytes: 64 * 1024 });
    expect(v?.refused?.check).toBe("decode");
    expect(v?.refused?.reason).toContain("65536 bytes");
  });

  it("2 well-formedness: a value with no producer", async () => {
    const g = liftAtom("export function f(a: number, b: number) { return a + b; }");
    const broken: DucGraph = {
      ...g,
      nodes: g.nodes.map((n) => (n.kind === "op" ? { ...n, inputs: [...n.inputs, "v99"] } : n)),
    };
    const v = await verdictOf(
      implementation(contract("f", ["number", "number"], "number"), broken),
    );
    expect(v?.refused?.check).toBe("well-formed");
    expect(v?.refused?.reason).toContain("conservation");
  });

  it("3 integrity: an identity or a contract hash that does not match the content", async () => {
    const wrongId = implementation(CLAMP_SPEC, CLAMP, [], { identity: "0".repeat(64) });
    expect((await verdictOf(wrongId))?.refused?.check).toBe("integrity");
    const other = liftAtom("export function f(x: number) { return x; }");
    const borrowedKey = implementation(CLAMP_SPEC, CLAMP, [], { identity: graphIdentity(other) });
    expect((await verdictOf(borrowedKey))?.refused?.check).toBe("integrity");
    const wrongSpec = implementation(CLAMP_SPEC, CLAMP, [], {
      specHash: specHash(contract("other", ["number"], "number")),
    });
    const v = await verdictOf(wrongSpec);
    expect(v?.refused?.check).toBe("integrity");
    expect(v?.refused?.reason).toContain("contract's hash");
  });

  it("3 integrity: a graph's root commits to its links and its format version (#1306)", async () => {
    // A root that is not the graph's, with the structure and identity unchanged.
    const wrongRoot = implementation(CLAMP_SPEC, CLAMP, [], { root: "0".repeat(64) });
    const v1 = await verdictOf(wrongRoot);
    expect(v1?.refused?.check).toBe("integrity");
    expect(v1?.refused?.reason).toContain("root");
    // A link swapped under the same structure: the identity still matches, the root does not.
    const honest = implementation(CLAMP_SPEC, CLAMP);
    const swapped = {
      ...honest,
      links: [
        ...honest.links,
        { reason: "free-identifier" as const, symbol: "x", spec: "9".repeat(64) },
      ],
    };
    const v2 = await verdictOf(swapped);
    expect(v2?.refused?.check).toBe("integrity");
    expect(v2?.refused?.reason).toContain("root");
  });

  it("4 no external code: an opaque construct, and code given as text", async () => {
    const withStmt = liftAtom("export function f(o: any) { with (o) { return x; } }");
    const v1 = await verdictOf(implementation(contract("f", ["unknown"], "unknown"), withStmt));
    expect(v1?.refused?.check).toBe("external-code");
    expect(v1?.refused?.reason).toContain("WithStatement#");
    // eval linked to a stored contract still runs text as code.
    const evalGraph = linkReferences(
      liftAtom('export function f(x: number) { return eval("x"); }'),
      (l) => (l.symbol === "eval" ? "spec-eval" : undefined),
    );
    const v2 = await verdictOf(
      implementation(contract("f", ["number"], "unknown"), evalGraph),
      storeOf("spec-eval", []),
    );
    expect(v2?.refused?.check).toBe("external-code");
    expect(v2?.refused?.reason).toContain("eval");
  });

  it("5 closure: an unlinked name, a link to an absent contract, an unknown base set", async () => {
    const free = liftAtom("export function f(x: number) { return helper(x) + 1; }");
    const spec = contract("f", ["number"], "number");
    const v1 = await verdictOf(implementation(spec, free));
    expect(v1?.refused?.check).toBe("closure");
    expect(v1?.refused?.reason).toContain("helper");
    const linked = linkReferences(free, (l) => (l.symbol === "helper" ? "spec-absent" : undefined));
    const v2 = await verdictOf(implementation(spec, linked));
    expect(v2?.refused?.check).toBe("closure");
    expect(v2?.refused?.reason).toContain("spec-absent");
    const v3 = await verdictOf(
      implementation(CLAMP_SPEC, CLAMP, [], { baseSet: { target: "jvm", version: 1 } }),
    );
    expect(v3?.refused?.check).toBe("closure");
    expect(v3?.refused?.reason).toContain("jvm@1");
  });

  it("5 closure: a batch closes its own links, and a linked atom runs with its dependency", async () => {
    const helperSpec = contract("double", ["number"], "number");
    const helper = liftAtom("export function double(n: number): number { return n * 2; }");
    const user = linkReferences(
      liftAtom("export function f(x: number): number { return double(x) + 1; }"),
      (l) => (l.symbol === "double" ? specHash(helperSpec) : undefined),
    );
    const v = await checkSharedSubmission(
      [
        implementation(contract("f", ["number"], "number"), user, [{ inputs: [3], output: 7 }]),
        implementation(helperSpec, helper, [{ inputs: [4], output: 8 }]),
      ],
      emptyStore,
    );
    expect(v.accepted).toBe(true);
    expect(v.implementations.map((i) => i.level)).toEqual(["conforming", "conforming"]);
  });

  it("6 capabilities: a capability or nondeterminism the contract does not declare", async () => {
    const env = liftAtom("export function f(k: string) { return process.env[k]; }");
    const pure = contract("f", ["string"], "unknown");
    const node = { baseSet: { target: "node", version: 2 } };
    const v1 = await verdictOf(implementation(pure, env, [], node));
    expect(v1?.refused?.check).toBe("capabilities");
    expect(v1?.refused?.reason).toContain('"process"');
    // Declared, it is admitted.
    const declared = contract("f", ["string"], "unknown", ["process:env"]);
    expect((await verdictOf(implementation(declared, env, [], node)))?.refused).toBeUndefined();
    const random = liftAtom("export function f(n: number) { return Math.random() * n; }");
    const v2 = await verdictOf(implementation(contract("f", ["number"], "number"), random));
    expect(v2?.refused?.check).toBe("capabilities");
    expect(v2?.refused?.reason).toContain("Math.random");
  });

  it("7 types: a result of the wrong type", async () => {
    const v = await verdictOf(
      implementation(contract("clamp", ["number", "number", "number"], "string"), CLAMP),
    );
    expect(v?.refused?.check).toBe("types");
    expect(v?.refused?.reason).toContain("string");
  });

  it("8 conformance: evidence the graph does not compute", async () => {
    const v = await verdictOf(
      implementation(CLAMP_SPEC, CLAMP, [...CLAMP_VECTORS, { inputs: [42, 0, 10], output: 42 }]),
    );
    expect(v?.refused?.check).toBe("conformance");
    expect(v?.refused?.reason).toContain("[42,0,10]");
  });

  it("8 conformance: a graph that does not finish is stopped", async () => {
    const spin = liftAtom(
      "export function f(n: number): number { while (n > 0) { n = n + 1; } return n; }",
    );
    const v = await verdictOf(
      implementation(contract("f", ["number"], "number"), spin, [{ inputs: [1], output: 0 }]),
      emptyStore,
      { vectorTimeoutMs: 100 },
    );
    expect(v?.refused?.check).toBe("conformance");
    expect(v?.refused?.reason).toContain("timed out");
  });

  it("9 corroboration: agreement with a stored implementation, and disagreement recorded", async () => {
    const spec = specHash(CLAMP_SPEC);
    const sameBehaviour = liftAtom(
      "export function clamp(x: number, lo: number, hi: number): number { return Math.min(Math.max(x, lo), hi); }",
    );
    const agreeing = storeOf(spec, [
      {
        identity: graphIdentity(sameBehaviour),
        graph: sameBehaviour,
        evidence: [{ inputs: [7, 8, 9], output: 8 }],
      },
    ]);
    const v1 = await verdictOf(implementation(CLAMP_SPEC, CLAMP, CLAMP_VECTORS), agreeing);
    expect(v1?.level).toBe("corroborated");
    expect(v1?.disagreements).toEqual([]);
    // Evidence chosen to pass: a "clamp" that ignores the upper bound passes its own vectors, and the
    // stored implementation's vectors show where it is wrong.
    const lowOnly = liftAtom(
      "export function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x; }",
    );
    const stored = storeOf(spec, [
      { identity: graphIdentity(CLAMP), graph: CLAMP, evidence: CLAMP_VECTORS },
    ]);
    const v2 = await verdictOf(
      implementation(CLAMP_SPEC, lowOnly, [{ inputs: [5, 0, 10], output: 5 }]),
      stored,
    );
    expect(v2?.refused).toBeUndefined();
    expect(v2?.level).toBe("conforming");
    expect(v2?.disagreements).toContainEqual({
      with: graphIdentity(CLAMP),
      inputs: [42, 0, 10],
      ours: 42,
      theirs: 10,
    });
  });

  it("a batch is accepted only when every implementation in it is admitted", async () => {
    const v = await checkSharedSubmission(
      [
        implementation(CLAMP_SPEC, CLAMP, CLAMP_VECTORS),
        implementation(CLAMP_SPEC, CLAMP, [], { identity: "0".repeat(64) }),
      ],
      emptyStore,
    );
    expect(v.accepted).toBe(false);
    expect(v.implementations.map((i) => i.refused?.check)).toEqual([undefined, "integrity"]);
  });
});
