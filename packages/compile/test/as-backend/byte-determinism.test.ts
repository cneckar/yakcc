// SPDX-License-Identifier: MIT
//
// byte-determinism.test.ts — AS-backend T4: byte-determinism extension
//
// Phase 1 established byte-determinism for i32 atoms in numeric-parity.test.ts.
// Phase 2A extends the proof to:
//   - One multi-export module (3 exported functions)
//   - One record substrate (sumRecord3 with exportMemory: true)
//
// Each case calls emit() 3 times and asserts all three sha256 hashes are identical.
// Evidence is appended to tmp/wi-146-evidence/byte-determinism.log.
//
// @decision DEC-V1-LOWER-BACKEND-REUSE-001 (determinism validated in Phase 0 Q1;
//   Phase 1 re-validated under MVP conditions; Phase 2A extends to multi-export + records)
// @decision DEC-AS-MULTI-EXPORT-001
// @decision DEC-AS-RECORD-LAYOUT-001
// @decision DEC-AS-BACKEND-OPTIONS-001

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type BlockMerkleRoot,
  type LocalTriplet,
  type SpecYak,
  blockMerkleRoot,
  specHash,
} from "@yakcc/contracts";
import { assemblyScriptBackend } from "../../src/as-backend.js";
import type { ResolutionResult, ResolvedBlock } from "../../src/resolve.js";

// ---------------------------------------------------------------------------
// Evidence directory
// ---------------------------------------------------------------------------

const EVIDENCE_DIR = join(import.meta.dirname, "../../../../tmp/wi-146-evidence");

function appendEvidence(filename: string, content: string): void {
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    appendFileSync(join(EVIDENCE_DIR, filename), `${content}\n`, "utf8");
  } catch {
    // Evidence writing is best-effort
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const MINIMAL_MANIFEST_JSON = JSON.stringify({
  artifacts: [{ kind: "property_tests", path: "tests.fast-check.ts" }],
});

function makeSpecYak(name: string, behavior: string): SpecYak {
  return {
    name,
    inputs: [{ name: "a", type: "number" }],
    outputs: [{ name: "result", type: "number" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior,
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe" },
    propertyTests: [],
  };
}

function makeMerkleRoot(name: string, behavior: string, implSource: string): BlockMerkleRoot {
  const spec = makeSpecYak(name, behavior);
  const manifest = JSON.parse(MINIMAL_MANIFEST_JSON) as {
    artifacts: Array<{ kind: string; path: string }>;
  };
  const artifactBytes = new TextEncoder().encode(implSource);
  const artifactsMap = new Map<string, Uint8Array>();
  for (const art of manifest.artifacts) {
    artifactsMap.set(art.path, artifactBytes);
  }
  return blockMerkleRoot({
    spec,
    implSource,
    manifest: manifest as LocalTriplet["manifest"],
    artifacts: artifactsMap,
  });
}

function makeResolution(
  blocks: ReadonlyArray<{ id: BlockMerkleRoot; source: string }>,
): ResolutionResult {
  const blockMap = new Map<BlockMerkleRoot, ResolvedBlock>();
  const order: BlockMerkleRoot[] = [];
  for (const { id, source } of blocks) {
    const sh = specHash(makeSpecYak(id.slice(0, 8), `behavior-${id.slice(0, 8)}`));
    blockMap.set(id, { merkleRoot: id, specHash: sh, source, subBlocks: [] });
    order.push(id);
  }
  const entry = order[order.length - 1] as BlockMerkleRoot;
  return { entry, blocks: blockMap, order };
}

function makeSourceResolution(name: string, source: string): ResolutionResult {
  const id = makeMerkleRoot(name, `Byte-determinism substrate: ${name}`, source);
  return makeResolution([{ id, source }]);
}

// ---------------------------------------------------------------------------
// Byte-determinism: multi-export module (3 sequential emit() calls)
//
// @decision DEC-AS-MULTI-EXPORT-001
// ---------------------------------------------------------------------------

describe("AS backend byte-determinism — multi-export module (Phase 2A)", () => {
  it("3 sequential emit() calls on the same 3-export module produce identical sha256 hashes", async () => {
    const MULTI_EXPORT_SOURCE = `
export function add(a: i32, b: i32): i32 { return (a + b); }
export function sub(a: i32, b: i32): i32 { return (a - b); }
export function mul(a: i32, b: i32): i32 { return (a * b); }
`.trim();

    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("determinism-multi-export", MULTI_EXPORT_SOURCE);

    const hashes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const wasmBytes = await backend.emit(resolution);
      const hash = createHash("sha256").update(wasmBytes).digest("hex");
      hashes.push(hash);
    }

    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[1]).toBe(hashes[2]);

    const now = new Date().toISOString();
    appendEvidence(
      "byte-determinism.log",
      [
        `=== byte-determinism check (multi-export module) — ${now} ===`,
        "atom: 3-export module (add/sub/mul i32 functions)",
        `run 1: ${hashes[0] ?? "?"}`,
        `run 2: ${hashes[1] ?? "?"}`,
        `run 3: ${hashes[2] ?? "?"}`,
        `result: ${hashes[0] === hashes[2] ? "IDENTICAL (PASS)" : "DIVERGED (FAIL)"}`,
        "",
      ].join("\n"),
    );
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Byte-determinism: record substrate (sumRecord3 with exportMemory)
//
// @decision DEC-AS-RECORD-LAYOUT-001
// @decision DEC-AS-BACKEND-OPTIONS-001
// ---------------------------------------------------------------------------

describe("AS backend byte-determinism — record substrate (Phase 2A)", () => {
  it("3 sequential emit() calls on sumRecord3 (exportMemory: true) produce identical sha256 hashes", async () => {
    const SUMRECORD3_SOURCE = `
export function sumRecord3(ptr: i32, _size: i32): i32 {
  const a = load<i32>(ptr + 0);
  const b = load<i32>(ptr + 8);
  const c = load<i32>(ptr + 16);
  return (a + b + c);
}
`.trim();

    // exportMemory: true per DEC-AS-BACKEND-OPTIONS-001 / DEC-AS-RECORD-LAYOUT-001
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("determinism-sumRecord3", SUMRECORD3_SOURCE);

    const hashes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const wasmBytes = await backend.emit(resolution);
      const hash = createHash("sha256").update(wasmBytes).digest("hex");
      hashes.push(hash);
    }

    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[1]).toBe(hashes[2]);

    const now = new Date().toISOString();
    appendEvidence(
      "byte-determinism.log",
      [
        `=== byte-determinism check (record substrate sumRecord3) — ${now} ===`,
        "atom: sumRecord3(ptr: i32, _size: i32): i32 — 3 i32 fields at 8-byte stride",
        `run 1: ${hashes[0] ?? "?"}`,
        `run 2: ${hashes[1] ?? "?"}`,
        `run 3: ${hashes[2] ?? "?"}`,
        `result: ${hashes[0] === hashes[2] ? "IDENTICAL (PASS)" : "DIVERGED (FAIL)"}`,
        "",
      ].join("\n"),
    );
  }, 60_000);
});
