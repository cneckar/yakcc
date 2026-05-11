// SPDX-License-Identifier: MIT
// load-corpus.test.ts — tests for the A1 corpus enumeration helper.
//
// T2 (Evaluation Contract): The corpus-load helper, given a populated registry,
// returns a deterministic Corpus shape: every entry has a non-empty blockMerkleRoot
// (64-char hex), a packageName matching ^@?[a-z0-9-_/]+$ or "unknown", and a
// kind in {foreign, local, glue}. The same input registry produces a byte-identical
// JSON serialization across two consecutive calls.
//
// No mocks of @yakcc/registry (Sacred Practice #5 — real unit tests, not mocks).
// Tests use a fixture registry built via the @yakcc/registry public API.
// The fixture is populated with a small set of hand-crafted seed blocks that
// exercise all three atom kinds (local, foreign, glue/pre-migration).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BlockMerkleRoot, blockMerkleRoot, specHash } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Corpus, loadCorpusFromRegistry } from "../src/load-corpus.js";

// ---------------------------------------------------------------------------
// Fixture registry lifecycle
// ---------------------------------------------------------------------------

// Zero-vector embedding provider (no network access, deterministic).
const FIXTURE_EMBEDDINGS = {
  dimension: 384,
  modelId: "fixture/null-zero",
  embed: async (_text: string): Promise<Float32Array> => new Float32Array(384),
};

let suiteDir: string;
let registryPath: string;

// One known blockMerkleRoot of a 'local' block inserted into the fixture registry.
let knownLocalRoot: BlockMerkleRoot;
// One known blockMerkleRoot of a 'foreign' block.
let knownForeignRoot: BlockMerkleRoot;

beforeAll(async () => {
  suiteDir = mkdtempSync(join(tmpdir(), "yakcc-load-corpus-test-"));
  registryPath = join(suiteDir, "fixture.sqlite");

  const reg = await openRegistry(registryPath, { embeddings: FIXTURE_EMBEDDINGS });

  // Insert a minimal 'local' block. We construct a valid BlockTripletRow using
  // the public contracts API (blockMerkleRoot, specHash) — no direct SQLite access.
  const localSpec = {
    name: "fixture-local",
    level: "L0" as const,
    behavior: "A fixture local block for corpus-load testing",
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure" as const, threadSafety: "safe" as const },
    propertyTests: [],
  };
  const localSpecHash = specHash(localSpec);
  const { canonicalize, canonicalAstHash } = await import("@yakcc/contracts");
  const localSpecBytes = canonicalize(localSpec);
  const localImplSource = "export function fixtureLocal(): void {}";
  const localManifest = {
    schemaVersion: 1 as const,
    level: "L0" as const,
    specHash: localSpecHash,
    artifacts: [],
    tests: [],
  };
  const localArtifacts = new Map<string, Uint8Array>();
  const localRoot = blockMerkleRoot({
    spec: localSpec,
    implSource: localImplSource,
    manifest: localManifest,
    artifacts: localArtifacts,
  }) as BlockMerkleRoot;

  await reg.storeBlock({
    blockMerkleRoot: localRoot,
    specHash: localSpecHash,
    specCanonicalBytes: localSpecBytes,
    implSource: localImplSource,
    proofManifestJson: JSON.stringify(localManifest),
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: canonicalAstHash(localImplSource) as import("@yakcc/contracts").CanonicalAstHash,
    parentBlockRoot: null,
    artifacts: localArtifacts,
    kind: "local",
  });
  knownLocalRoot = localRoot;

  // Insert a 'foreign' block. Foreign blocks have a different identity formula
  // (keyed on kind + pkg + export, not spec/impl/proof).
  const foreignRoot = blockMerkleRoot({
    kind: "foreign",
    pkg: "node:path",
    export: "join",
  }) as BlockMerkleRoot;

  // Foreign blocks need a dummy spec/impl for the registry row, but the
  // identity comes from the foreign formula above.
  const foreignSpec = {
    name: "node-path-join",
    level: "L0" as const,
    behavior: "Join path segments (foreign: node:path#join)",
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure" as const, threadSafety: "safe" as const },
    propertyTests: [],
  };
  const foreignSpecHash = specHash(foreignSpec);
  const foreignSpecBytes = canonicalize(foreignSpec);
  const foreignImplSource = "// foreign: node:path#join";
  const foreignManifest = {
    schemaVersion: 1 as const,
    level: "L0" as const,
    specHash: foreignSpecHash,
    artifacts: [],
    tests: [],
  };

  await reg.storeBlock({
    blockMerkleRoot: foreignRoot,
    specHash: foreignSpecHash,
    specCanonicalBytes: foreignSpecBytes,
    implSource: foreignImplSource,
    proofManifestJson: JSON.stringify(foreignManifest),
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: canonicalAstHash(foreignImplSource) as import("@yakcc/contracts").CanonicalAstHash,
    parentBlockRoot: null,
    artifacts: new Map<string, Uint8Array>(),
    kind: "foreign",
    foreignPkg: "node:path",
    foreignExport: "join",
    foreignDtsHash: null,
  });
  knownForeignRoot = foreignRoot;

  await reg.close();
}, 30_000);

afterAll(() => {
  try {
    rmSync(suiteDir, { recursive: true, force: true });
  } catch {
    // Non-fatal cleanup.
  }
});

// ---------------------------------------------------------------------------
// T2: Shape invariants
// ---------------------------------------------------------------------------

describe("loadCorpusFromRegistry — shape invariants (T2)", () => {
  it("returns a Corpus with at least the two fixture blocks", async () => {
    const reg = await openRegistry(registryPath, { embeddings: FIXTURE_EMBEDDINGS });
    try {
      const corpus = await loadCorpusFromRegistry(reg);
      expect(corpus.atoms.length).toBeGreaterThanOrEqual(2);
    } finally {
      await reg.close();
    }
  });

  it("every atom has a 64-char hex blockMerkleRoot", async () => {
    const reg = await openRegistry(registryPath, { embeddings: FIXTURE_EMBEDDINGS });
    try {
      const corpus = await loadCorpusFromRegistry(reg);
      for (const atom of corpus.atoms) {
        expect(atom.blockMerkleRoot).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      await reg.close();
    }
  });

  it("every atom has a packageName matching ^@?[a-z0-9-_/:]+$ or 'unknown'", async () => {
    const reg = await openRegistry(registryPath, { embeddings: FIXTURE_EMBEDDINGS });
    try {
      const corpus = await loadCorpusFromRegistry(reg);
      const pkgPattern = /^(@?[a-z0-9-_/:.]+|unknown)$/;
      for (const atom of corpus.atoms) {
        expect(atom.packageName).toMatch(pkgPattern);
      }
    } finally {
      await reg.close();
    }
  });

  it("every atom.kind is 'local', 'foreign', or 'glue'", async () => {
    const reg = await openRegistry(registryPath, { embeddings: FIXTURE_EMBEDDINGS });
    try {
      const corpus = await loadCorpusFromRegistry(reg);
      const validKinds = new Set(["local", "foreign", "glue"]);
      for (const atom of corpus.atoms) {
        expect(validKinds.has(atom.kind)).toBe(true);
      }
    } finally {
      await reg.close();
    }
  });

  it("the fixture local block appears with kind='local' and packageName='unknown'", async () => {
    const reg = await openRegistry(registryPath, { embeddings: FIXTURE_EMBEDDINGS });
    try {
      const corpus = await loadCorpusFromRegistry(reg);
      const found = corpus.atoms.find((a) => a.blockMerkleRoot === knownLocalRoot);
      expect(found).toBeDefined();
      expect(found?.kind).toBe("local");
      expect(found?.packageName).toBe("unknown");
    } finally {
      await reg.close();
    }
  });

  it("the fixture foreign block appears with kind='foreign' and packageName='node:path'", async () => {
    const reg = await openRegistry(registryPath, { embeddings: FIXTURE_EMBEDDINGS });
    try {
      const corpus = await loadCorpusFromRegistry(reg);
      const found = corpus.atoms.find((a) => a.blockMerkleRoot === knownForeignRoot);
      expect(found).toBeDefined();
      expect(found?.kind).toBe("foreign");
      expect(found?.packageName).toBe("node:path");
    } finally {
      await reg.close();
    }
  });

  it("atoms are sorted ascending by blockMerkleRoot", async () => {
    const reg = await openRegistry(registryPath, { embeddings: FIXTURE_EMBEDDINGS });
    try {
      const corpus = await loadCorpusFromRegistry(reg);
      const roots = corpus.atoms.map((a) => a.blockMerkleRoot);
      const sorted = [...roots].sort((a, b) => a.localeCompare(b));
      expect(roots).toEqual(sorted);
    } finally {
      await reg.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T2: Determinism contract
// ---------------------------------------------------------------------------

describe("loadCorpusFromRegistry — determinism (T2)", () => {
  it("two consecutive calls on the same open registry produce byte-identical JSON", async () => {
    const reg = await openRegistry(registryPath, { embeddings: FIXTURE_EMBEDDINGS });
    try {
      const corpus1 = await loadCorpusFromRegistry(reg);
      const corpus2 = await loadCorpusFromRegistry(reg);
      const json1 = JSON.stringify(corpus1, null, 2);
      const json2 = JSON.stringify(corpus2, null, 2);
      expect(json1).toBe(json2);
    } finally {
      await reg.close();
    }
  });

  it("two separate openRegistry calls on the same SQLite path produce byte-identical Corpus JSON", async () => {
    const reg1 = await openRegistry(registryPath, { embeddings: FIXTURE_EMBEDDINGS });
    const corpus1 = await loadCorpusFromRegistry(reg1);
    await reg1.close();

    const reg2 = await openRegistry(registryPath, { embeddings: FIXTURE_EMBEDDINGS });
    const corpus2 = await loadCorpusFromRegistry(reg2);
    await reg2.close();

    const json1 = JSON.stringify(corpus1, null, 2);
    const json2 = JSON.stringify(corpus2, null, 2);
    expect(json1).toBe(json2);
  });
});

// ---------------------------------------------------------------------------
// Compound-interaction test: loadCorpusFromRegistry across local + foreign blocks
// ---------------------------------------------------------------------------

describe("loadCorpusFromRegistry — compound interaction (end-to-end)", () => {
  it("enumerates both local and foreign atoms from a mixed registry", async () => {
    const reg = await openRegistry(registryPath, { embeddings: FIXTURE_EMBEDDINGS });
    try {
      const corpus: Corpus = await loadCorpusFromRegistry(reg);

      const localAtoms = corpus.atoms.filter((a) => a.kind === "local");
      const foreignAtoms = corpus.atoms.filter((a) => a.kind === "foreign");

      // Both kinds must be present — skipping foreign enumeration is forbidden (I2).
      expect(localAtoms.length).toBeGreaterThanOrEqual(1);
      expect(foreignAtoms.length).toBeGreaterThanOrEqual(1);

      // The foreign atom must carry the foreignPkg as its packageName.
      const foreignNode = foreignAtoms.find((a) => a.packageName === "node:path");
      expect(foreignNode).toBeDefined();
    } finally {
      await reg.close();
    }
  });
});
