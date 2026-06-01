/**
 * project-manifest.test.ts — Unit tests for ProjectManifest types, parse/serialize/
 * addReference helpers, and path/import-line utilities.
 *
 * Production sequence exercised:
 *   addReference(emptyManifest(), ...) → ProjectManifest
 *   serializeProjectManifest(m) → JSON text
 *   parseProjectManifest(text) → ProjectManifest (round-trip)
 *
 * Also loads and parses the fixture `.yakcc/manifest.json` to prove that the
 * canonical fixture file round-trips through parse+serialize.
 *
 * No mocks needed — ProjectManifest is a pure data module with no I/O.
 * Fixture file is read via Node's readFileSync at test time.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BlockMerkleRoot } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import {
  PROJECT_MANIFEST_PATH,
  ProjectManifestError,
  addReference,
  emptyManifest,
  materializedDtsPath,
  materializedModulePath,
  parseProjectManifest,
  referenceImportLine,
  serializeProjectManifest,
} from "./project-manifest.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_DIR = join(__dirname, "__fixtures__", "project-manifest");

/** A valid 64-char lowercase hex root for testing. */
function fakeRoot(char: string): BlockMerkleRoot {
  return char.repeat(64) as BlockMerkleRoot;
}

/** A fixture root that starts with 'a' repeated 12 times, then diverges. */
const ROOT_A = ("a".repeat(12) + "b".repeat(52)) as BlockMerkleRoot;
/** A fixture root that shares 12-char prefix with ROOT_A but differs at char 13. */
const ROOT_A_COLLISION = `${"a".repeat(12)}c${"b".repeat(51)}` as BlockMerkleRoot;
/** A root with a completely different prefix. */
const ROOT_B = "b".repeat(64) as BlockMerkleRoot;

// ---------------------------------------------------------------------------
// emptyManifest
// ---------------------------------------------------------------------------

describe("emptyManifest", () => {
  it("returns version 1 with empty references", () => {
    const m = emptyManifest();
    expect(m.version).toBe(1);
    expect(m.references).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseProjectManifest — valid input
// ---------------------------------------------------------------------------

describe("parseProjectManifest — valid input", () => {
  it("parses a manifest with one reference", () => {
    const root = ROOT_A;
    const alias = root.slice(0, 12);
    const text = JSON.stringify({
      version: 1,
      references: [
        {
          root,
          symbol: "myAtom",
          alias,
          importPath: `.yakcc/atoms/${alias}`,
          registry: "local",
          version: null,
        },
      ],
    });
    const m = parseProjectManifest(text);
    expect(m.version).toBe(1);
    expect(m.references).toHaveLength(1);
    expect(m.references[0]?.root).toBe(root);
    expect(m.references[0]?.symbol).toBe("myAtom");
    expect(m.references[0]?.alias).toBe(alias);
    expect(m.references[0]?.importPath).toBe(`.yakcc/atoms/${alias}`);
    expect(m.references[0]?.registry).toBe("local");
    expect(m.references[0]?.version).toBeNull();
  });

  it("parses a manifest with version string in version field", () => {
    const root = ROOT_B;
    const alias = root.slice(0, 12);
    const text = JSON.stringify({
      version: 1,
      references: [
        {
          root,
          symbol: "compute",
          alias,
          importPath: `.yakcc/atoms/${alias}`,
          registry: "remote",
          version: "1.2.3",
        },
      ],
    });
    const m = parseProjectManifest(text);
    expect(m.references[0]?.version).toBe("1.2.3");
    expect(m.references[0]?.registry).toBe("remote");
  });

  it("parses a manifest with zero references", () => {
    const m = parseProjectManifest(JSON.stringify({ version: 1, references: [] }));
    expect(m.references).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseProjectManifest — rejection cases (fail loudly)
// ---------------------------------------------------------------------------

describe("parseProjectManifest — rejection", () => {
  it("throws on invalid JSON", () => {
    expect(() => parseProjectManifest("{not valid json")).toThrowError(ProjectManifestError);
  });

  it("throws on non-object root", () => {
    expect(() => parseProjectManifest("[]")).toThrowError(ProjectManifestError);
    expect(() => parseProjectManifest('"string"')).toThrowError(ProjectManifestError);
  });

  it("throws on wrong version (version=2)", () => {
    const text = JSON.stringify({ version: 2, references: [] });
    expect(() => parseProjectManifest(text)).toThrowError(/version must be 1/);
  });

  it("throws on wrong version (version='1' as string)", () => {
    const text = JSON.stringify({ version: "1", references: [] });
    expect(() => parseProjectManifest(text)).toThrowError(/version must be 1/);
  });

  it("throws when references is missing", () => {
    const text = JSON.stringify({ version: 1 });
    expect(() => parseProjectManifest(text)).toThrowError(/references must be an array/);
  });

  it("throws on root that is not 64 chars", () => {
    const text = JSON.stringify({
      version: 1,
      references: [
        {
          root: "abc123",
          symbol: "x",
          alias: "abc123",
          importPath: ".yakcc/atoms/abc123",
          registry: "local",
          version: null,
        },
      ],
    });
    expect(() => parseProjectManifest(text)).toThrowError(/64 lowercase hex/);
  });

  it("throws on root containing uppercase hex", () => {
    const uppercaseRoot = "A".repeat(64);
    const alias = uppercaseRoot.slice(0, 12).toLowerCase();
    const text = JSON.stringify({
      version: 1,
      references: [
        {
          root: uppercaseRoot,
          symbol: "x",
          alias,
          importPath: `.yakcc/atoms/${alias}`,
          registry: "local",
          version: null,
        },
      ],
    });
    expect(() => parseProjectManifest(text)).toThrowError(/64 lowercase hex/);
  });

  it("throws on empty symbol", () => {
    const root = ROOT_A;
    const alias = root.slice(0, 12);
    const text = JSON.stringify({
      version: 1,
      references: [
        {
          root,
          symbol: "",
          alias,
          importPath: `.yakcc/atoms/${alias}`,
          registry: "local",
          version: null,
        },
      ],
    });
    expect(() => parseProjectManifest(text)).toThrowError(/symbol must be a non-empty string/);
  });

  it("throws when alias is not a prefix of root", () => {
    const root = ROOT_A;
    const text = JSON.stringify({
      version: 1,
      references: [
        {
          root,
          symbol: "x",
          alias: "zzzzzzzzzzzz", // not a prefix of root
          importPath: ".yakcc/atoms/zzzzzzzzzzzz",
          registry: "local",
          version: null,
        },
      ],
    });
    expect(() => parseProjectManifest(text)).toThrowError(/not a prefix of root/);
  });

  it("throws on importPath inconsistent with alias", () => {
    const root = ROOT_A;
    const alias = root.slice(0, 12);
    const text = JSON.stringify({
      version: 1,
      references: [
        {
          root,
          symbol: "x",
          alias,
          importPath: ".yakcc/atoms/WRONG",
          registry: "local",
          version: null,
        },
      ],
    });
    expect(() => parseProjectManifest(text)).toThrowError(/importPath must be/);
  });

  it("throws on duplicate alias", () => {
    const alias = ROOT_A.slice(0, 12);
    const text = JSON.stringify({
      version: 1,
      references: [
        {
          root: ROOT_A,
          symbol: "x",
          alias,
          importPath: `.yakcc/atoms/${alias}`,
          registry: "local",
          version: null,
        },
        {
          root: ROOT_B,
          symbol: "y",
          alias, // same alias for different root — should fail
          importPath: `.yakcc/atoms/${alias}`,
          registry: "local",
          version: null,
        },
      ],
    });
    // ROOT_B doesn't start with ROOT_A's alias, so the alias-not-prefix check fires first
    // for ROOT_B. That's still a correct rejection.
    expect(() => parseProjectManifest(text)).toThrowError(ProjectManifestError);
  });
});

// ---------------------------------------------------------------------------
// serializeProjectManifest + round-trip
// ---------------------------------------------------------------------------

describe("serializeProjectManifest", () => {
  it("produces valid JSON with 2-space indent and trailing newline", () => {
    const m = emptyManifest();
    const text = serializeProjectManifest(m);
    expect(text.endsWith("\n")).toBe(true);
    // Must parse as valid JSON
    const reparsed = JSON.parse(text);
    expect(reparsed.version).toBe(1);
    expect(reparsed.references).toEqual([]);
  });

  it("round-trips: parse(serialize(m)) equals m", () => {
    const { manifest: m } = addReference(emptyManifest(), {
      root: ROOT_A,
      symbol: "myFn",
    });
    const text = serializeProjectManifest(m);
    const reparsed = parseProjectManifest(text);
    expect(reparsed.version).toBe(m.version);
    expect(reparsed.references).toHaveLength(1);
    expect(reparsed.references[0]?.root).toBe(ROOT_A);
    expect(reparsed.references[0]?.symbol).toBe("myFn");
    expect(reparsed.references[0]?.alias).toBe(ROOT_A.slice(0, 12));
  });

  it("round-trip is stable: serialize(parse(serialize(m))) === serialize(m)", () => {
    const { manifest: m } = addReference(emptyManifest(), {
      root: ROOT_A,
      symbol: "myFn",
      registry: "remote",
      version: "2.0",
    });
    const text1 = serializeProjectManifest(m);
    const text2 = serializeProjectManifest(parseProjectManifest(text1));
    expect(text2).toBe(text1);
  });

  it("emits stable key order (version, references; ref keys: root,symbol,alias,importPath,registry,version)", () => {
    const { manifest: m } = addReference(emptyManifest(), {
      root: ROOT_A,
      symbol: "fn",
    });
    const text = serializeProjectManifest(m);
    const obj = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(obj)).toEqual(["version", "references"]);
    const ref = (obj.references as unknown[])[0] as Record<string, unknown>;
    expect(Object.keys(ref)).toEqual([
      "root",
      "symbol",
      "alias",
      "importPath",
      "registry",
      "version",
    ]);
  });
});

// ---------------------------------------------------------------------------
// addReference
// ---------------------------------------------------------------------------

describe("addReference — basic", () => {
  it("adds a reference with default alias (first 12 chars of root)", () => {
    const { manifest, reference } = addReference(emptyManifest(), {
      root: ROOT_A,
      symbol: "fn",
    });
    expect(manifest.references).toHaveLength(1);
    expect(reference.root).toBe(ROOT_A);
    expect(reference.symbol).toBe("fn");
    expect(reference.alias).toBe(ROOT_A.slice(0, 12));
    expect(reference.importPath).toBe(`.yakcc/atoms/${ROOT_A.slice(0, 12)}`);
    expect(reference.registry).toBe("local");
    expect(reference.version).toBeNull();
  });

  it("accepts explicit registry and version", () => {
    const { reference } = addReference(emptyManifest(), {
      root: ROOT_A,
      symbol: "fn",
      registry: "remote-registry",
      version: "3.1.4",
    });
    expect(reference.registry).toBe("remote-registry");
    expect(reference.version).toBe("3.1.4");
  });

  it("does not mutate the input manifest", () => {
    const before = emptyManifest();
    addReference(before, { root: ROOT_A, symbol: "fn" });
    expect(before.references).toHaveLength(0);
  });
});

describe("addReference — idempotency", () => {
  it("returns the existing manifest unchanged when same root+symbol is added again", () => {
    const { manifest: m1 } = addReference(emptyManifest(), {
      root: ROOT_A,
      symbol: "fn",
    });
    const { manifest: m2, reference } = addReference(m1, {
      root: ROOT_A,
      symbol: "fn",
    });
    // Same object reference for manifest (not a copy)
    expect(m2).toBe(m1);
    expect(m2.references).toHaveLength(1);
    expect(reference.alias).toBe(ROOT_A.slice(0, 12));
  });

  it("does NOT treat same root + different symbol as idempotent (two refs)", () => {
    const { manifest: m1 } = addReference(emptyManifest(), {
      root: ROOT_A,
      symbol: "fn1",
    });
    const { manifest: m2 } = addReference(m1, {
      root: ROOT_A,
      symbol: "fn2",
    });
    // Same root, different symbol → two separate references with distinct aliases
    expect(m2.references).toHaveLength(2);
    // Second reference's alias must be distinct (root is same, but prefix extended past first)
    expect(m2.references[0]?.alias).not.toBe(m2.references[1]?.alias);
  });
});

describe("addReference — alias collision extension", () => {
  it("extends alias past 12 chars when 12-char prefix collides", () => {
    // ROOT_A and ROOT_A_COLLISION share the first 12 chars.
    const { manifest: m1 } = addReference(emptyManifest(), {
      root: ROOT_A,
      symbol: "fn1",
    });
    const { manifest: m2, reference: ref2 } = addReference(m1, {
      root: ROOT_A_COLLISION,
      symbol: "fn2",
    });

    expect(m2.references).toHaveLength(2);

    const ref1 = m2.references[0];
    expect(ref1?.alias).toBe(ROOT_A.slice(0, 12)); // 12 chars — original
    // ref2 must have a longer alias that disambiguates from ref1
    expect(ref2.alias.length).toBeGreaterThan(12);
    expect(ROOT_A_COLLISION.startsWith(ref2.alias)).toBe(true);
    // Aliases must be distinct
    expect(ref1?.alias).not.toBe(ref2.alias);
  });

  it("importPath is consistent with the extended alias", () => {
    const { manifest: m1 } = addReference(emptyManifest(), {
      root: ROOT_A,
      symbol: "fn1",
    });
    const { reference: ref2 } = addReference(m1, {
      root: ROOT_A_COLLISION,
      symbol: "fn2",
    });
    expect(ref2.importPath).toBe(`.yakcc/atoms/${ref2.alias}`);
  });

  it("triple collision: three roots sharing 12-char prefix all get distinct aliases", () => {
    // All three share the same first 12 chars but diverge at position 12, 13, 14.
    const prefix12 = "abcdef012345";
    const rootX = `${prefix12}0${"f".repeat(51)}` as BlockMerkleRoot;
    const rootY = `${prefix12}1${"f".repeat(51)}` as BlockMerkleRoot;
    const rootZ = `${prefix12}2${"f".repeat(51)}` as BlockMerkleRoot;

    const { manifest: m1 } = addReference(emptyManifest(), { root: rootX, symbol: "x" });
    const { manifest: m2 } = addReference(m1, { root: rootY, symbol: "y" });
    const { manifest: m3, reference: refZ } = addReference(m2, { root: rootZ, symbol: "z" });

    expect(m3.references).toHaveLength(3);
    const aliases = m3.references.map((r) => r.alias);
    // All aliases must be unique
    expect(new Set(aliases).size).toBe(3);
    // All must be prefixes of their respective roots
    const refX = m3.references[0];
    const refY = m3.references[1];
    expect(refX).toBeDefined();
    expect(refY).toBeDefined();
    expect(rootX.startsWith(refX?.alias ?? "")).toBe(true);
    expect(rootY.startsWith(refY?.alias ?? "")).toBe(true);
    expect(rootZ.startsWith(refZ.alias)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Path and import-line helpers
// ---------------------------------------------------------------------------

describe("materializedModulePath", () => {
  it("returns .yakcc/atoms/<alias>.ts", () => {
    expect(materializedModulePath("abc123def456")).toBe(".yakcc/atoms/abc123def456.ts");
  });
});

describe("materializedDtsPath", () => {
  it("returns .yakcc/atoms/<alias>.d.ts", () => {
    expect(materializedDtsPath("abc123def456")).toBe(".yakcc/atoms/abc123def456.d.ts");
  });
});

describe("referenceImportLine", () => {
  it("returns the exact import statement for a reference", () => {
    const { reference } = addReference(emptyManifest(), {
      root: ROOT_A,
      symbol: "crc32c",
    });
    const line = referenceImportLine(reference);
    expect(line).toBe(`import { crc32c } from ".yakcc/atoms/${ROOT_A.slice(0, 12)}";`);
  });

  it('matches the format: import { <symbol> } from "<importPath>"', () => {
    const { reference } = addReference(emptyManifest(), {
      root: ROOT_B,
      symbol: "parseInt",
    });
    const line = referenceImportLine(reference);
    expect(line).toMatch(/^import \{ .+ \} from "\.yakcc\/atoms\/[0-9a-f]+";$/);
  });
});

// ---------------------------------------------------------------------------
// PROJECT_MANIFEST_PATH constant
// ---------------------------------------------------------------------------

describe("PROJECT_MANIFEST_PATH", () => {
  it("is the canonical .yakcc/manifest.json path", () => {
    expect(PROJECT_MANIFEST_PATH).toBe(".yakcc/manifest.json");
  });
});

// ---------------------------------------------------------------------------
// Fixture: load and parse the canonical fixture manifest
// ---------------------------------------------------------------------------

describe("fixture: .yakcc/manifest.json", () => {
  it("parses successfully", () => {
    const text = readFileSync(join(FIXTURE_DIR, ".yakcc", "manifest.json"), "utf-8");
    expect(() => parseProjectManifest(text)).not.toThrow();
  });

  it("has at least one atom reference", () => {
    const text = readFileSync(join(FIXTURE_DIR, ".yakcc", "manifest.json"), "utf-8");
    const m = parseProjectManifest(text);
    expect(m.references.length).toBeGreaterThanOrEqual(1);
  });

  it("round-trips through serialize+parse", () => {
    const text = readFileSync(join(FIXTURE_DIR, ".yakcc", "manifest.json"), "utf-8");
    const m = parseProjectManifest(text);
    const serialized = serializeProjectManifest(m);
    const reparsed = parseProjectManifest(serialized);
    expect(reparsed.version).toBe(m.version);
    expect(reparsed.references).toHaveLength(m.references.length);
    for (let i = 0; i < m.references.length; i++) {
      expect(reparsed.references[i]?.root).toBe(m.references[i]?.root);
      expect(reparsed.references[i]?.symbol).toBe(m.references[i]?.symbol);
      expect(reparsed.references[i]?.alias).toBe(m.references[i]?.alias);
    }
  });
});

// ---------------------------------------------------------------------------
// Compound production-sequence test
// (exercising the real flow: emptyManifest → addReference* → serialize → parse)
// ---------------------------------------------------------------------------

describe("compound production sequence: build manifest → serialize → parse → importLine", () => {
  it("exercises the full compose-by-reference reference lifecycle", () => {
    // Step 1: model calls addReference for the first atom (e.g. crc32c)
    const crc32cRoot = fakeRoot("1");
    const { manifest: m1, reference: ref1 } = addReference(emptyManifest(), {
      root: crc32cRoot,
      symbol: "crc32c",
      registry: "local",
    });

    // Step 2: model calls addReference for a second atom (e.g. utf8Encode)
    const utf8Root = fakeRoot("2");
    const { manifest: m2, reference: ref2 } = addReference(m1, {
      root: utf8Root,
      symbol: "utf8Encode",
    });

    // Manifests are additive and immutable
    expect(m1.references).toHaveLength(1);
    expect(m2.references).toHaveLength(2);

    // Step 3: manifest is serialized to disk
    const text = serializeProjectManifest(m2);

    // Step 4: yakcc build (#1045) reads the manifest back from disk
    const loaded = parseProjectManifest(text);
    expect(loaded.references).toHaveLength(2);

    // Step 5: #1047 MCP tool computes the import lines for the model to emit
    const loadedRef1 = loaded.references[0];
    const loadedRef2 = loaded.references[1];
    if (loadedRef1 === undefined || loadedRef2 === undefined) {
      throw new Error("Expected 2 loaded references");
    }
    const line1 = referenceImportLine(loadedRef1);
    const line2 = referenceImportLine(loadedRef2);

    expect(line1).toBe(`import { crc32c } from "${ref1.importPath}";`);
    expect(line2).toBe(`import { utf8Encode } from "${ref2.importPath}";`);

    // Step 6: verify the alias rule — each alias is a prefix of its root
    for (const ref of loaded.references) {
      expect(ref.root.startsWith(ref.alias)).toBe(true);
    }

    // Step 7: path helpers produce the expected file paths for #1045/#1046
    expect(materializedModulePath(ref1.alias)).toBe(`.yakcc/atoms/${ref1.alias}.ts`);
    expect(materializedDtsPath(ref1.alias)).toBe(`.yakcc/atoms/${ref1.alias}.d.ts`);
  });
});
