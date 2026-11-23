import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { type SpecYak, specHash } from "@yakcc/contracts";
import { atomShape, liftAtom, packGraph } from "@yakcc/duc";
import { collectForestSlicePlans, shavePackage, slice } from "@yakcc/shave";
import ts from "typescript";
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
            declares:
              shape.kind === "statement"
                ? shape.names
                : shape.name !== undefined
                  ? [shape.name]
                  : [],
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
  const BASE64 = join(FIXTURES, "base64-js-1.5.1/index.js");
  const real64 = (): Record<string, (x: unknown) => unknown> =>
    createRequire(__filename)(BASE64) as Record<string, (x: unknown) => unknown>;
  const STRINGS = ["", "QQ==", "QUI=", "YWJj", "SGVsbG8sIHdvcmxkIQ==", "-_-_"];
  const BYTES = [[], [65], [65, 66], [97, 98, 99], [0, 255, 128, 64, 32, 16, 8]];
  /** base64-js's exports on the inputs, as module evidence: computed by Node's own require. */
  const base64Evidence = (): NonNullable<ModuleRecord["evidence"]> => {
    const real = real64();
    return ["byteLength", "toByteArray", "fromByteArray"].flatMap((member) =>
      (member === "fromByteArray" ? BYTES : STRINGS).map((x) => ({
        member,
        inputs: [x],
        output: json(real[member]?.(x)),
      })),
    );
  };

  it("base64-js passes checks 1-8, its exports computing what the real package computes", async () => {
    // The graph decides what is stored: base64-js lifts whole, one module statement.
    const { batch, modules } = await submissionOf("base64-js-1.5.1", () => []);
    expect(modules).toHaveLength(1);
    expect(modules[0]?.statements.length).toBe(batch.length);
    const verdict = await checkSharedSubmission(
      batch,
      { contracts: new Set(), implementationsOf: () => [] },
      { modules: modules.map((m) => ({ ...m, evidence: base64Evidence() })) },
    );
    expect(verdict.implementations.filter((v) => v.refused !== undefined)).toEqual([]);
    expect(verdict.modules).toEqual([{ id: "index.js", conforming: true }]);
    expect(verdict.accepted).toBe(true);
  });

  it("without its module record, the same batch is not closed", async () => {
    const { batch } = await submissionOf("base64-js-1.5.1", () => []);
    const verdict = await checkSharedSubmission(batch, {
      contracts: new Set(),
      implementationsOf: () => [],
    });
    expect(verdict.accepted).toBe(false);
    const reasons = verdict.implementations.map((v) => v.refused?.reason ?? "").join("\n");
    expect(reasons).toContain("exports");
  });

  it("a module whose statements are out of order does not compute what the package does", async () => {
    // base64-js as its top-level statements, one implementation each.
    const sf = ts.createSourceFile(
      "index.js",
      readFileSync(BASE64, "utf8"),
      ts.ScriptTarget.ES2022,
    );
    const lines = sf.statements
      .map((st) => st.getText(sf))
      .filter((t) => !/^['"]use strict['"]/.test(t));
    const batch: SharedImplementation[] = [];
    const statements: ModuleRecord["statements"][number][] = [];
    for (const line of lines) {
      const m = oneStatementModule(line);
      batch.push(...m.batch);
      statements.push(...(m.modules[0]?.statements ?? []));
    }
    const store = { contracts: new Set<string>(), implementationsOf: () => [] };
    const inOrder: ModuleRecord = { id: "index.js", statements, evidence: base64Evidence() };
    const ok = await checkSharedSubmission(batch, store, { modules: [inOrder] });
    expect(ok.modules).toEqual([{ id: "index.js", conforming: true }]);
    // Without the statements that declare nothing (the loop that fills the tables), the tables
    // stay empty and the exports compute something else.
    const emptied: ModuleRecord = {
      ...inOrder,
      statements: statements.filter((st) => st.kind === "function" || st.declares.length > 0),
    };
    const wrong = await checkSharedSubmission(batch, store, { modules: [emptied] });
    expect(wrong.modules[0]?.conforming).toBe(false);
    expect(wrong.accepted).toBe(false);
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

  it("a require cycle: the receiver sees the partial exports Node sees (#1267)", async () => {
    // a.js starts, requires b.js, which requires a.js back while a is half-initialized.
    const A = [
      "exports.x = 1;",
      'const b = require("./b.js");',
      "exports.get = function () { return [b.z, b.sawGet]; };",
    ];
    const B = [
      'const a = require("./a.js");',
      "exports.z = a.x * 10;",
      "exports.sawGet = typeof a.get;",
    ];
    const dir = mkdtempSync(join(tmpdir(), "yakcc-cycle-"));
    writeFileSync(join(dir, "a.js"), A.join("\n"));
    writeFileSync(join(dir, "b.js"), B.join("\n"));
    const expected = json(
      (createRequire(__filename)(join(dir, "a.js")) as { get: () => unknown }).get(),
    );
    expect(expected).toEqual([10, "undefined"]); // b ran before a defined get
    const batch: SharedImplementation[] = [];
    const recordOf = (id: string, lines: string[]): ModuleRecord => ({
      id,
      requires: { "./a.js": "a.js", "./b.js": "b.js" },
      statements: lines.map((line, k) => {
        const graph = liftAtom(line);
        const shape = atomShape(line);
        const spec = contract(`${id}#${k}`, 0);
        const packed = packGraph(graph);
        batch.push({
          spec,
          specHash: specHash(spec),
          formatVersion: packed.formatVersion,
          structure: packed.structure,
          identity: packed.identity,
          links: packed.links,
          evidence: [],
          baseSet: { target: "node", version: 2 },
        });
        return {
          specHash: specHash(spec),
          identity: packed.identity,
          kind: shape.kind,
          declares: shape.kind === "statement" ? shape.names : [],
        };
      }),
    });
    const modules = [
      { ...recordOf("a.js", A), evidence: [{ member: "get", inputs: [], output: expected }] },
      recordOf("b.js", B),
    ];
    const verdict = await checkSharedSubmission(
      batch,
      { contracts: new Set(), implementationsOf: () => [] },
      { modules },
    );
    expect(verdict.implementations.filter((v) => v.refused !== undefined)).toEqual([]);
    expect(verdict.modules).toEqual([{ id: "a.js", conforming: true }]);
    rmSync(dir, { recursive: true, force: true });
  });
});
