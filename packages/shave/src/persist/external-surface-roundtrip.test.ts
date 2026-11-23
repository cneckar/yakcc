// SPDX-License-Identifier: MIT
// WI-EXPLAIN-03 (#1172) round trip through a real SQLite registry: the declared external
// surface of a persisted atom is read back from the stored row, with no re-lifting.
import type { CanonicalAstHash, EmbeddingProvider } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import { describe, expect, it } from "vitest";
import type { IntentCard } from "../intent/types.js";
import type { NovelGlueEntry } from "../universalize/types.js";
import { persistNovelGlueAtom } from "./atom-persist.js";
import { DucGateRejection, externalSurfaceOf, moduleBindingsOf } from "./duc-gate.js";

const HASH = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as CanonicalAstHash;

const intentCard: IntentCard = {
  schemaVersion: 1,
  behavior: "Read a file and return its uppercased text",
  inputs: [{ name: "path", typeHint: "string", description: "The path" }],
  outputs: [{ name: "text", typeHint: "string", description: "The text" }],
  preconditions: [],
  postconditions: [],
  notes: [],
  modelVersion: "static",
  promptVersion: "v1",
  sourceHash: "00",
  extractedAt: "2025-01-01T00:00:00.000Z",
};

function mockEmbeddings(): EmbeddingProvider {
  return {
    dimension: 384,
    modelId: "mock/external-surface",
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(384);
      for (let i = 0; i < 384; i++) vec[i] = (text.charCodeAt(i % text.length) + i) / 1000;
      return vec;
    },
  };
}

describe("external surface survives a real registry round trip (#1172)", () => {
  it("foreign imports, ambient reads, and captures are read back from the stored row", async () => {
    // The module supplies a pure capture (TABLE). The atom itself has a foreign read and an ambient read.
    const moduleSource = [
      'import { readFileSync } from "node:fs";',
      "const TABLE = [1, 2, 3];",
      "export function loadUpper(path: string): string {",
      "  return readFileSync(path).toString().toUpperCase() + String(TABLE[0] + Math.abs(0));",
      "}",
    ].join("\n");
    const atomSource =
      "function loadUpper(path) { return readFileSync(path).toString().toUpperCase() + String(TABLE[0] + Math.abs(0)); }";
    const entry: NovelGlueEntry = {
      kind: "novel-glue",
      sourceRange: { start: 0, end: atomSource.length },
      source: atomSource,
      canonicalAstHash: HASH,
      intentCard,
    };
    const registry = await openRegistry(":memory:", { embeddings: mockEmbeddings() });
    try {
      const root = await persistNovelGlueAtom(entry, registry, {
        ducGateMode: "reject",
        moduleBindings: moduleBindingsOf(moduleSource),
        internalSymbols: new Set(),
      });
      expect(root).toBeDefined();
      const row = await registry.getBlock(root as never);
      expect(row).not.toBeNull();
      const surface = externalSurfaceOf(row?.ducUsupp ?? null);
      expect(surface).not.toBeNull();
      // readFileSync is not an import in the atom fragment, so it is resolved through the module binding.
      expect(surface?.captures.map((c) => c.symbol).sort()).toEqual(
        ["TABLE", "readFileSync"].sort(),
      );
      expect(surface?.ambient).toEqual(expect.arrayContaining(["Math", "String"]));
      expect(surface?.unexplained).toEqual([]);
      // The capture hashes survive the round trip.
      expect(surface?.captures.every((c) => /^[0-9a-f]{64}$/.test(c.declHash ?? ""))).toBe(true);
    } finally {
      await registry.close();
    }
  });
});

describe("the gate rejects by default at persist time (#1173, DEC-DUC-GATE-REJECT-001)", () => {
  it("an atom with an unexplained reference is not persisted, with no mode given", async () => {
    const saved = process.env.YAKCC_DUC_GATE;
    // biome-ignore lint/performance/noDelete: an unset variable is the case under test.
    delete process.env.YAKCC_DUC_GATE;
    const atomSource = "function tally(xs) { return mystery(xs) + xs.length; }";
    const entry: NovelGlueEntry = {
      kind: "novel-glue",
      sourceRange: { start: 0, end: atomSource.length },
      source: atomSource,
      canonicalAstHash: HASH,
      intentCard,
    };
    const registry = await openRegistry(":memory:", { embeddings: mockEmbeddings() });
    try {
      await expect(persistNovelGlueAtom(entry, registry, {})).rejects.toBeInstanceOf(
        DucGateRejection,
      );
      await expect(persistNovelGlueAtom(entry, registry, {})).rejects.toThrow(/mystery/);
      // The escape hatch admits it.
      process.env.YAKCC_DUC_GATE = "warn";
      const warned: string[] = [];
      const original = console.warn;
      console.warn = (m: string) => void warned.push(m);
      try {
        expect(await persistNovelGlueAtom(entry, registry, {})).toBeDefined();
      } finally {
        console.warn = original;
      }
      expect(warned.join("\n")).toContain("mystery");
    } finally {
      // biome-ignore lint/performance/noDelete: assigning undefined would set the string "undefined".
      if (saved === undefined) delete process.env.YAKCC_DUC_GATE;
      else process.env.YAKCC_DUC_GATE = saved;
      await registry.close();
    }
  });
});
