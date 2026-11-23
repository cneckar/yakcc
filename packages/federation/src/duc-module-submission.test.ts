import { existsSync } from "node:fs";
// SPDX-License-Identifier: MIT
/**
 * duc-module-submission.test.ts — a corpus package as a shared submission (#1287, #1290).
 *
 * Production sequence: shavePackage(fixture) → collectForestSlicePlans → each entry lifted
 *   (liftAtom, atomShape) → SharedImplementation per entry + one ModuleRecord per file
 *   → checkSharedSubmission(batch, store, { modules }).
 *
 * The evidence comes from the real package, loaded by Node's own `require`: the receiver runs the
 * graphs, in the module's order, and must compute what the package computes.
 */
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { type SpecYak, specHash } from "@yakcc/contracts";
import { atomShape, liftAtom, packGraph } from "@yakcc/duc";
import { collectForestSlicePlans, shavePackage, slice } from "@yakcc/shave";
import { describe, expect, it } from "vitest";
import {
  type ConformanceVector,
  type ModuleRecord,
  type SharedImplementation,
  checkSharedSubmission,
} from "./duc-submission.js";

const FIXTURES = resolve(__dirname, "../../shave/src/__fixtures__/module-graph");

function contract(name: string, inputs: number): SpecYak {
  return {
    name,
    inputs: Array.from({ length: inputs }, (_, i) => ({ name: `a${i}`, type: "unknown" })),
    outputs: [{ name: "result", type: "unknown" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior: `the ${name} statement`,
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe" },
    propertyTests: [],
  } as unknown as SpecYak;
}

/** A package shaved into one submission: an implementation per statement, a record per module. */
async function submissionOf(
  pkg: string,
  evidenceFor: (name: string) => ConformanceVector[],
): Promise<{ batch: SharedImplementation[]; modules: ModuleRecord[]; names: string[] }> {
  const registry = { findByCanonicalAstHash: async () => [] };
  const forest = await shavePackage(join(FIXTURES, pkg), { registry });
  const plans = await collectForestSlicePlans(forest, slice, registry);
  const batch: SharedImplementation[] = [];
  const modules: ModuleRecord[] = [];
  const names: string[] = [];
  for (const { filePath, slicePlan } of plans) {
    const statements: ModuleRecord["statements"][number][] = [];
    for (const [k, entry] of slicePlan.entries.entries()) {
      if (entry.kind !== "novel-glue" || typeof entry.source !== "string") continue;
      const graph = liftAtom(entry.source);
      const shape = atomShape(entry.source);
      const declares =
        shape.kind === "function" ? (shape.name !== undefined ? [shape.name] : []) : shape.names;
      const params = graph.nodes.filter((n) => n.kind === "param-source").length;
      const spec = contract(`${pkg}:${filePath}#${k}`, params);
      const packed = packGraph(graph);
      const name = shape.kind === "function" ? (shape.name ?? "") : "";
      batch.push({
        spec,
        specHash: specHash(spec),
        formatVersion: packed.formatVersion,
        structure: packed.structure,
        identity: packed.identity,
        links: packed.links,
        evidence: name !== "" ? evidenceFor(name) : [],
        baseSet: { target: "node", version: 2 },
      });
      names.push(name);
      statements.push({
        specHash: specHash(spec),
        identity: packed.identity,
        kind: shape.kind,
        declares,
      });
    }
    // Each relative `require` resolved to the package module it names.
    const requires: Record<string, string> = {};
    for (const entry of slicePlan.entries) {
      if (typeof entry.source !== "string") continue;
      for (const m of entry.source.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
        const spec = m[1] as string;
        const base = resolve(dirname(filePath), spec);
        const hit = [base, `${base}.js`, join(base, "index.js")].find(
          (f) => existsSync(f) && plans.some((p) => p.filePath === f),
        );
        if (hit !== undefined) requires[spec] = relative(join(FIXTURES, pkg), hit);
      }
    }
    modules.push({ id: relative(join(FIXTURES, pkg), filePath), statements, requires });
  }
  return { batch, modules, names };
}

/** A hand-written single-statement module, as a submission. */
function oneStatementModule(
  source: string,
  effects: string[] = [],
): { batch: SharedImplementation[]; modules: ModuleRecord[] } {
  const graph = liftAtom(source);
  const shape = atomShape(source);
  const spec = { ...contract("one", 0), effects } as SpecYak;
  const packed = packGraph(graph);
  return {
    batch: [
      {
        spec,
        specHash: specHash(spec),
        formatVersion: packed.formatVersion,
        structure: packed.structure,
        identity: packed.identity,
        links: packed.links,
        evidence: [],
        baseSet: { target: "node", version: 2 },
      },
    ],
    modules: [
      {
        id: "one.js",
        statements: [
          {
            specHash: specHash(spec),
            identity: packed.identity,
            kind: shape.kind,
            declares: shape.kind === "statement" ? shape.names : [],
          },
        ],
      },
    ],
  };
}

/** A value as JSON evidence holds it (undefined stays undefined). */
const json = (v: unknown): unknown =>
  v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as unknown);

describe("a corpus package as a shared submission (#1287, #1290)", () => {
  it("base64-js passes checks 1-8, its exports computing what the real package computes", async () => {
    const real = createRequire(__filename)(join(FIXTURES, "base64-js-1.5.1/index.js")) as Record<
      string,
      (x: unknown) => unknown
    >;
    const STRINGS = ["", "QQ==", "QUI=", "YWJj", "SGVsbG8sIHdvcmxkIQ==", "-_-_"];
    const BYTES = [[], [65], [65, 66], [97, 98, 99], [0, 255, 128, 64, 32, 16, 8]];
    const evidenceFor = (name: string): ConformanceVector[] => {
      const fn = real[name];
      if (fn === undefined) return [];
      const inputs = name === "fromByteArray" ? BYTES : STRINGS;
      return inputs.map((x) => ({ inputs: [x], output: json(fn(x)) }));
    };
    const { batch, modules, names } = await submissionOf("base64-js-1.5.1", evidenceFor);
    expect(modules).toHaveLength(1);
    expect(modules[0]?.statements.length).toBe(batch.length);

    const verdict = await checkSharedSubmission(
      batch,
      { contracts: new Set(), implementationsOf: () => [] },
      { modules },
    );
    const refused = verdict.implementations.filter((v) => v.refused !== undefined);
    expect(refused).toEqual([]);
    expect(verdict.accepted).toBe(true);
    // The package's exports reach conforming: their evidence runs in the module's context, after
    // the statements that fill the lookup tables.
    for (const name of ["byteLength", "toByteArray", "fromByteArray"]) {
      const at = names.indexOf(name);
      expect(at, name).toBeGreaterThanOrEqual(0);
      expect(verdict.implementations[at]?.level, name).toBe("conforming");
    }
  });

  it("without its module record, the same batch is not closed", async () => {
    const { batch } = await submissionOf("base64-js-1.5.1", () => []);
    const verdict = await checkSharedSubmission(batch, {
      contracts: new Set(),
      implementationsOf: () => [],
    });
    expect(verdict.accepted).toBe(false);
    const reasons = verdict.implementations.map((v) => v.refused?.reason ?? "").join("\n");
    expect(reasons).toContain("lookup");
    expect(reasons).toContain("exports");
  });

  it("a module whose statements are out of order does not compute what the package does", async () => {
    const real = createRequire(__filename)(join(FIXTURES, "base64-js-1.5.1/index.js")) as Record<
      string,
      (x: unknown) => unknown
    >;
    const evidenceFor = (name: string): ConformanceVector[] =>
      name === "fromByteArray"
        ? [{ inputs: [[97, 98, 99]], output: json(real.fromByteArray?.([97, 98, 99])) }]
        : [];
    const { batch, modules, names } = await submissionOf("base64-js-1.5.1", evidenceFor);
    // The statements that declare nothing are dropped from the record, among them the loop that
    // fills the lookup tables: the tables stay empty.
    const record = modules[0] as ModuleRecord;
    const emptied: ModuleRecord = {
      ...record,
      statements: record.statements.filter(
        (st) => st.kind === "function" || st.declares.length > 0,
      ),
    };
    const verdict = await checkSharedSubmission(
      batch,
      { contracts: new Set(), implementationsOf: () => [] },
      { modules: [emptied] },
    );
    const at = names.indexOf("fromByteArray");
    expect(verdict.implementations[at]?.refused?.check).toBe("conformance");
  });

  it("ms: one whole-file statement, its module.exports computing what the real package computes", async () => {
    const real = createRequire(__filename)(join(FIXTURES, "ms-2.1.3/index.js")) as (
      ...a: unknown[]
    ) => unknown;
    const inputs: unknown[][] = [
      ["2 days"],
      ["1h"],
      ["-3.5 m"],
      [60000],
      [1000, { long: true }],
      ["nonsense"],
    ];
    const { batch, modules } = await submissionOf("ms-2.1.3", () => []);
    const withEvidence = modules.map((m) => ({
      ...m,
      evidence: inputs.map((x) => ({ inputs: x, output: json(real(...x)) })),
    }));
    const verdict = await checkSharedSubmission(
      batch,
      { contracts: new Set(), implementationsOf: () => [] },
      { modules: withEvidence },
    );
    expect(verdict.implementations.filter((v) => v.refused !== undefined)).toEqual([]);
    expect(verdict.modules).toEqual([{ id: "index.js", conforming: true }]);
    expect(verdict.accepted).toBe(true);
  });

  it("uuid: 21 modules close, and a module runs the modules it requires", async () => {
    const { batch, modules } = await submissionOf("uuid-11.1.1", () => []);
    const real = createRequire(__filename)(join(FIXTURES, "uuid-11.1.1/dist/cjs/validate.js")) as {
      default: (x: unknown) => unknown;
    };
    const ids = [
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "not-a-uuid",
      "",
      "00000000-0000-0000-0000-000000000000",
    ];
    const withEvidence = modules.map((m) =>
      m.id.endsWith("cjs/validate.js")
        ? {
            ...m,
            evidence: ids.map((x) => ({ member: "default", inputs: [x], output: real.default(x) })),
          }
        : m,
    );
    const verdict = await checkSharedSubmission(
      batch,
      { contracts: new Set(), implementationsOf: () => [] },
      { modules: withEvidence },
    );
    // Closure holds everywhere; what is refused is refused for its capabilities (Date, crypto
    // under these pure contracts).
    const checks = new Set(verdict.implementations.map((v) => v.refused?.check).filter(Boolean));
    expect([...checks]).toEqual(["capabilities"]);
    const validate = verdict.modules.find((m) => m.id.endsWith("cjs/validate.js"));
    expect(validate).toEqual({ id: validate?.id, conforming: true });
  });

  it("a platform module closes on its target, and carries its labels", async () => {
    const store = { contracts: new Set<string>(), implementationsOf: () => [] };
    const fs = oneStatementModule('const fs = require("fs"); const data = fs.readFileSync;');
    const v1 = await checkSharedSubmission(fs.batch, store, { modules: fs.modules });
    expect(v1.implementations[0]?.refused?.check).toBe("capabilities");
    expect(v1.implementations[0]?.refused?.reason).toContain('require("fs") grants "io"');
    const fsDeclared = oneStatementModule('const fs = require("node:fs");', ["io:read"]);
    const v2 = await checkSharedSubmission(fsDeclared.batch, store, {
      modules: fsDeclared.modules,
    });
    expect(v2.implementations[0]?.refused).toBeUndefined();
    const crypto = oneStatementModule('const c = require("crypto");');
    const v3 = await checkSharedSubmission(crypto.batch, store, { modules: crypto.modules });
    expect(v3.implementations[0]?.refused?.reason).toContain("nondeterministic");
    // A package that is not the platform's, and not in the submission, is a hole.
    const external = oneStatementModule('const jws = require("jws");');
    const v4 = await checkSharedSubmission(external.batch, store, { modules: external.modules });
    expect(v4.implementations[0]?.refused?.check).toBe("closure");
    expect(v4.implementations[0]?.refused?.reason).toContain("require");
  });
});
