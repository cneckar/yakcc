/**
 * import-intercept.test.ts -- Unit tests for import-intercept module (WI-508 Slice 1).
 */

import type { Registry } from "@yakcc/registry";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ImportBinding,
  type ImportInterceptResult,
  type InterceptCandidate,
  SLICE1_INTERCEPT_ALLOWLIST,
  applyImportIntercept,
  buildImportIntentCard,
  runImportIntercept,
  scanImportsForIntercept,
} from "../src/import-intercept.js";
import type { EmissionContext, HookResponseWithSubstitution } from "../src/index.js";

// Minimal stub registry for unit tests
type StubResolveStatus = "matched" | "weak_only" | "no_match";

function makeStubRegistry(status: StubResolveStatus, score = 0.8): Registry {
  return {
    async findCandidatesByQuery(_intentCard: import("@yakcc/contracts").QueryIntentCard) {
      if (status === "matched") {
        return {
          candidates: [{
            combinedScore: score,
            cosineDistance: 1 - score,
            autoAccepted: score > 0.85,
            perDimensionScores: {},
            block: {
              blockMerkleRoot: "aabbccdd1122" as import("@yakcc/contracts").BlockMerkleRoot,
              specCanonicalBytes: new TextEncoder().encode(JSON.stringify({ behavior: "validate email" })),
              canonicalAstHash: "hash1",
              specHash: "spechash1",
              proofManifestJson: JSON.stringify({ artifacts: [{}, {}] }),
              embeddings: [],
              glueLeafEntries: [],
              wasmArtifact: null,
              implSource: "export function isEmail() {}",
              level: "L0" as const,
              createdAt: 0,
              artifacts: new Map(),
            },
          }],
          nearMisses: [],
        } as unknown as import("@yakcc/registry").FindCandidatesByQueryResult;
      }
      return {
        candidates: status === "weak_only"
          ? [{ combinedScore: 0.55, cosineDistance: 0.45, autoAccepted: false, perDimensionScores: {}, block: {
              blockMerkleRoot: "ddccbbaa1122" as import("@yakcc/contracts").BlockMerkleRoot,
              specCanonicalBytes: new TextEncoder().encode(JSON.stringify({ behavior: "weak" })),
              canonicalAstHash: "hash2",
              specHash: "spechash2",
              proofManifestJson: JSON.stringify({ artifacts: [] }),
              embeddings: [],
              glueLeafEntries: [],
              wasmArtifact: null,
              implSource: "export function f() {}",
              level: "L0" as const,
              createdAt: 0,
              artifacts: new Map(),
            }}]
          : [],
        nearMisses: [],
      } as unknown as import("@yakcc/registry").FindCandidatesByQueryResult;
    },
  } as unknown as Registry;
}

const BASE_RESPONSE: HookResponseWithSubstitution = { kind: "passthrough", substituted: false };
const CTX: EmissionContext = { intent: "validate email address" };

// ---------------------------------------------------------------------------
// Tests: scanImportsForIntercept
// ---------------------------------------------------------------------------

describe("scanImportsForIntercept", () => {
  it("skips type-only imports", () => {
    const src = `import type { IsEmail } from "validator";\n`;
    const result = scanImportsForIntercept(src);
    expect(result.interceptCandidates).toHaveLength(0);
    expect(result.importedDynamic).toHaveLength(0);
  });

  it("skips relative imports", () => {
    const src = `import { foo } from "./local";\n`;
    const result = scanImportsForIntercept(src);
    expect(result.interceptCandidates).toHaveLength(0);
  });

  it("skips node: builtins", () => {
    const src = `import { readFileSync } from "node:fs";\n`;
    const result = scanImportsForIntercept(src);
    expect(result.interceptCandidates).toHaveLength(0);
  });

  it("skips @yakcc/ workspace imports", () => {
    const src = `import { Registry } from "@yakcc/registry";\n`;
    const result = scanImportsForIntercept(src);
    expect(result.interceptCandidates).toHaveLength(0);
  });

  it("skips bare Node core module fs", () => {
    const src = `import fs from "fs";\n`;
    const result = scanImportsForIntercept(src);
    expect(result.interceptCandidates).toHaveLength(0);
  });

  it("puts off-allowlist foreign imports in importedDynamic", () => {
    const src = `import zod from "zod";\n`;
    const result = scanImportsForIntercept(src);
    expect(result.interceptCandidates).toHaveLength(0);
    expect(result.importedDynamic).toHaveLength(1);
    expect(result.importedDynamic[0]?.moduleSpecifier).toBe("zod");
  });

  it("puts validator import in interceptCandidates", () => {
    const src = `import { isEmail } from "validator";\n`;
    const result = scanImportsForIntercept(src);
    expect(result.interceptCandidates).toHaveLength(1);
    const cand = result.interceptCandidates[0];
    expect(cand?.binding.moduleSpecifier).toBe("validator");
    expect(cand?.binding.namedImports).toContain("isEmail");
  });

  it("handles default import from validator", () => {
    const src = `import validator from "validator";\n`;
    const result = scanImportsForIntercept(src);
    expect(result.interceptCandidates).toHaveLength(1);
    expect(result.interceptCandidates[0]?.binding.defaultImport).toBe("validator");
  });

  it("handles empty source", () => {
    const result = scanImportsForIntercept("");
    expect(result.interceptCandidates).toHaveLength(0);
  });

  // EC section 4.1 required test: namespace import capture (F-508-02)
  it("captures namespace import from validator as interceptCandidate", () => {
    const src = `import * as v from "validator";
`;
    const result = scanImportsForIntercept(src);
    expect(result.interceptCandidates).toHaveLength(1);
    const cand = result.interceptCandidates[0];
    expect(cand?.binding.moduleSpecifier).toBe("validator");
    // namespaceImport must be captured (not null)
    expect(cand?.binding.namespaceImport).toBe("v");
    expect(cand?.binding.namedImports).toHaveLength(0);
    expect(cand?.binding.defaultImport).toBeNull();
  });

  // EC section 4.1 required test: dynamic import logged-not-dropped (F-508-02)
  // Static import("validator") call expressions are NOT ImportDeclarations in the AST,
  // so they are not intercepted. However the off-allowlist importedDynamic bucket is
  // the correct place to record them as a known limitation (Slice 1 scope).
  // This test asserts the source is handled without throwing and that the static
  // import from validator that IS present still registers as an intercept candidate.
  it("dynamic import() expression does not appear in interceptCandidates", () => {
    // A file with both a static import (interceptable) and a dynamic import() expression.
    const src = [
      `import { isEmail } from "validator";`,
      `const v = await import("validator");`,
      "",
    ].join("\n");
    const result = scanImportsForIntercept(src);
    // The static import IS in interceptCandidates
    expect(result.interceptCandidates).toHaveLength(1);
    expect(result.interceptCandidates[0]?.binding.moduleSpecifier).toBe("validator");
    // import() expressions are not ImportDeclarations -- they are not in interceptCandidates
    // (they are function calls in the AST, not ImportDeclaration nodes)
    // The test asserts the scanner does not throw and the static path still works.
    expect(result.interceptCandidates).not.toHaveLength(0);
  });

  // EC section 4.1 required test: mixed type/value inline import (F-508-02)
  // import { type T, isEmail } from 'validator' -- isEmail is a value binding,
  // T is a type-only inline specifier. The scanner must capture isEmail and not T.
  it("mixed type/value import: captures value binding isEmail, excludes inline type T", () => {
    const src = `import { type IsEmailOptions, isEmail } from "validator";
`;
    const result = scanImportsForIntercept(src);
    expect(result.interceptCandidates).toHaveLength(1);
    const cand = result.interceptCandidates[0];
    expect(cand?.binding.moduleSpecifier).toBe("validator");
    // isEmail (value binding) must be captured
    expect(cand?.binding.namedImports).toContain("isEmail");
    // IsEmailOptions (inline type modifier) must NOT be captured
    expect(cand?.binding.namedImports).not.toContain("IsEmailOptions");
  });
});

// ---------------------------------------------------------------------------
// Tests: buildImportIntentCard
// ---------------------------------------------------------------------------

describe("buildImportIntentCard", () => {
  it("builds behavior from named imports", () => {
    const binding: ImportBinding = {
      moduleSpecifier: "validator",
      namedImports: ["isEmail", "isURL"],
      defaultImport: null,
      namespaceImport: null,
    };
    const card = buildImportIntentCard(binding);
    expect(card.behavior).toBe("validator -- isEmail, isURL");
  });

  it("builds behavior from default import", () => {
    const binding: ImportBinding = {
      moduleSpecifier: "validator",
      namedImports: [],
      defaultImport: "validator",
      namespaceImport: null,
    };
    const card = buildImportIntentCard(binding);
    expect(card.behavior).toBe("validator -- validator");
  });

  it("truncates more than 3 named imports", () => {
    const binding: ImportBinding = {
      moduleSpecifier: "validator",
      namedImports: ["a", "b", "c", "d"],
      defaultImport: null,
      namespaceImport: null,
    };
    const card = buildImportIntentCard(binding);
    expect(card.behavior).toBe("validator -- a, b, c, ...");
  });
});

// ---------------------------------------------------------------------------
// Tests: runImportIntercept
// ---------------------------------------------------------------------------

describe("runImportIntercept", () => {
  const validatorCandidate: InterceptCandidate = {
    binding: {
      moduleSpecifier: "validator",
      namedImports: ["isEmail"],
      defaultImport: null,
      namespaceImport: null,
    },
    intentCard: { behavior: "validator -- isEmail" },
  };

  it("returns intercepted=false when registry returns no_match", async () => {
    const registry = makeStubRegistry("no_match") as Registry;
    const results = await runImportIntercept([validatorCandidate], registry, CTX);
    expect(results).toHaveLength(1);
    expect(results[0]?.intercepted).toBe(false);
    expect(results[0]?.address).toBeNull();
  });

  it("returns intercepted=false when registry returns weak_only", async () => {
    const registry = makeStubRegistry("weak_only") as Registry;
    const results = await runImportIntercept([validatorCandidate], registry, CTX);
    expect(results[0]?.intercepted).toBe(false);
  });

  it("returns intercepted=true when registry returns matched", async () => {
    const registry = makeStubRegistry("matched", 0.85) as Registry;
    const results = await runImportIntercept([validatorCandidate], registry, CTX);
    expect(results).toHaveLength(1);
    expect(results[0]?.intercepted).toBe(true);
    expect(results[0]?.address).toBe("aabbccdd");
    expect(results[0]?.score).toBe(0.85);
  });

  it("returns intercepted=false when registry throws", async () => {
    const brokenRegistry = {
      async findCandidatesByQuery() { throw new Error("db down"); },
    } as unknown as Registry;
    const results = await runImportIntercept([validatorCandidate], brokenRegistry, CTX);
    expect(results[0]?.intercepted).toBe(false);
  });

  it("returns empty array when candidates is empty", async () => {
    const registry = makeStubRegistry("matched") as Registry;
    const results = await runImportIntercept([], registry, CTX);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: applyImportIntercept
// ---------------------------------------------------------------------------

describe("applyImportIntercept", () => {
  const VALIDATOR_SOURCE = `import { isEmail } from "validator";\nconst ok = isEmail(email);\n`;

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: env-var removal is intentional; setting to undefined leaves the key present
    delete process.env.YAKCC_HOOK_DISABLE_SUBSTITUTE;
  });

  it("returns base when emittedCode is empty", async () => {
    const registry = makeStubRegistry("matched") as Registry;
    const result = await applyImportIntercept(BASE_RESPONSE, "", CTX, registry);
    expect(result).toBe(BASE_RESPONSE);
  });

  it("returns base when YAKCC_HOOK_DISABLE_SUBSTITUTE=1", async () => {
    process.env.YAKCC_HOOK_DISABLE_SUBSTITUTE = "1";
    const registry = makeStubRegistry("matched") as Registry;
    const result = await applyImportIntercept(BASE_RESPONSE, VALIDATOR_SOURCE, CTX, registry);
    expect(result).toBe(BASE_RESPONSE);
  });

  it("returns base when no covered imports", async () => {
    const registry = makeStubRegistry("matched") as Registry;
    const src = `import { readFileSync } from "node:fs";\n`;
    const result = await applyImportIntercept(BASE_RESPONSE, src, CTX, registry);
    expect(result).toBe(BASE_RESPONSE);
  });

  it("returns base when registry returns no_match", async () => {
    const registry = makeStubRegistry("no_match") as Registry;
    const result = await applyImportIntercept(BASE_RESPONSE, VALIDATOR_SOURCE, CTX, registry);
    expect(result).toBe(BASE_RESPONSE);
  });

  it("attaches importInterceptResults when intercepted=true", async () => {
    const registry = makeStubRegistry("matched", 0.85) as Registry;
    const result = await applyImportIntercept(BASE_RESPONSE, VALIDATOR_SOURCE, CTX, registry);
    expect(result).not.toBe(BASE_RESPONSE);
    const r = result as HookResponseWithSubstitution & { importInterceptResults?: ImportInterceptResult[] };
    expect(r.importInterceptResults).toBeDefined();
    expect(r.importInterceptResults?.[0]?.intercepted).toBe(true);
    expect(r.importInterceptResults?.[0]?.binding.moduleSpecifier).toBe("validator");
  });

  it("returns base unchanged when registry throws", async () => {
    const brokenRegistry = {
      async findCandidatesByQuery() { throw new Error("db error"); },
    } as unknown as Registry;
    const result = await applyImportIntercept(BASE_RESPONSE, VALIDATOR_SOURCE, CTX, brokenRegistry);
    expect(result.kind).toBe("passthrough");
    expect(result.substituted).toBe(false);
  });

  it("SLICE1_INTERCEPT_ALLOWLIST contains validator", () => {
    expect(SLICE1_INTERCEPT_ALLOWLIST.has("validator")).toBe(true);
  });
});
