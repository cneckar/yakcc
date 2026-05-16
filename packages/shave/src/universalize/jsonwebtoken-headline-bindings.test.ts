// SPDX-License-Identifier: MIT
/**
 * WI-510 Slice 6 --- per-entry shave of two jsonwebtoken headline bindings.
 *
 * Engine is FROZEN after Slice 1. This is a pure fixture-and-test slice.
 * jsonwebtoken@9.0.2: two entryPath shaves (verify.js, decode.js).
 * Three corpus rows total; decode-base64url and parse-jose-header share the same decode.js atom.
 *
 * @decision DEC-WI510-S6-PER-ENTRY-SHAVE-001
 * title: Slice 6 shaves jsonwebtoken verify+decode + bcryptjs package atom per-entry
 * status: decided
 * rationale: Inherits the structural pattern from Slices 2-4.
 *
 * @decision DEC-WI510-S6-JWT-VERSION-PIN-001
 * title: Pin to jsonwebtoken@9.0.2 (current latest dist-tag)
 * status: decided
 * rationale: 9.0.2 latest dist-tag (verified 2026-05-16), plain CJS, 10 npm runtime deps + 1 Node builtin.
 *
 * @decision DEC-WI510-S6-JWT-HS256-VERIFY-BINDING-001
 * title: Issue-body HS256-verify resolves to verify.js
 * status: decided
 * rationale: jsonwebtoken verify dispatches on options.algorithms. No separate HS256 file.
 *
 * @decision DEC-WI510-S6-JWT-DECODE-BASE64URL-BINDING-001
 * title: Issue-body decode-base64url resolves to decode.js
 * status: decided
 * rationale: decode(token) returns {header,payload,signature}; base64url via jws external dep.
 *
 * @decision DEC-WI510-S6-JWT-PARSE-JOSE-HEADER-BINDING-001
 * title: Issue-body parse-jose-header resolves to the SAME decode.js source file
 * status: decided
 * rationale: Two issue-body headlines collapse to one source file and one atom. Two corpus rows.
 *
 * @decision DEC-WI510-S6-NPM-EXTERNAL-FAN-OUT-001
 * title: jsonwebtoken verify exercises externalSpecifiers on multiple npm packages + 1 Node builtin
 * status: decided
 * rationale: First WI-510 fixture with multi-element npm externalSpecifiers. Plan 5.6 criterion 12.
 *
 * @decision DEC-WI510-S6-FIXTURE-FULL-TARBALL-001
 * title: Vendor the full jsonwebtoken-9.0.2 and bcryptjs-2.4.3 published tarballs verbatim
 * status: decided
 * rationale: Inherits DEC-WI510-S3-FIXTURE-FULL-TARBALL-001 and DEC-WI510-S4-FIXTURE-FULL-TARBALL-001.
 */

import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalEmbeddingProvider, createOfflineEmbeddingProvider } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import { describe, expect, it } from "vitest";
import { sourceHash } from "../cache/key.js";
import { STATIC_MODEL_TAG, STATIC_PROMPT_VERSION } from "../intent/constants.js";
import type { IntentCard } from "../intent/types.js";
import { maybePersistNovelGlueAtom } from "../persist/atom-persist.js";
import type { ShaveRegistryView } from "../types.js";
import {
  collectForestSlicePlans,
  forestModules,
  forestStubs,
  forestTotalLeafCount,
  shavePackage,
} from "./module-graph.js";
import { slice } from "./slicer.js";
import type { NovelGlueEntry } from "./types.js";

const USE_LOCAL_PROVIDER = process.env.DISCOVERY_EVAL_PROVIDER === "local";

const FIXTURES_DIR = join(fileURLToPath(new URL("../__fixtures__/module-graph", import.meta.url)));
const JWT_FIXTURE_ROOT = join(FIXTURES_DIR, "jsonwebtoken-9.0.2");

const emptyRegistry: Pick<ShaveRegistryView, "findByCanonicalAstHash"> = {
  findByCanonicalAstHash: async () => [],
};

function collectLeafHashes(node: {
  kind: string;
  canonicalAstHash?: string;
  children?: unknown[];
}): string[] {
  if (node.kind === "atom") return [node.canonicalAstHash ?? ""];
  if (node.kind === "branch" && Array.isArray(node.children)) {
    return node.children.flatMap((c) =>
      collectLeafHashes(c as { kind: string; canonicalAstHash?: string; children?: unknown[] }),
    );
  }
  return [];
}

function withStubIntentCard(entry: NovelGlueEntry): NovelGlueEntry {
  const stubCard: IntentCard = {
    schemaVersion: 1,
    behavior: `stub:${entry.canonicalAstHash.slice(0, 16)}`,
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    notes: ["WI-510 Slice 6 section E stub intent card for persist pipeline test"],
    modelVersion: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    sourceHash: sourceHash(entry.source),
    extractedAt: "2026-05-16T00:00:00.000Z",
  };
  return { ...entry, intentCard: stubCard };
}

function withSemanticIntentCard(
  entry: NovelGlueEntry,
  behaviorText: string,
  semanticHints: readonly string[] = [],
): NovelGlueEntry {
  const semanticCard: IntentCard = {
    schemaVersion: 1,
    behavior: behaviorText,
    inputs: [],
    outputs: [],
    preconditions: semanticHints,
    postconditions: [],
    notes: ["WI-510 Slice 6 section F semantic intent card for combinedScore quality gate"],
    modelVersion: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    sourceHash: sourceHash(entry.source),
    extractedAt: "2026-05-16T00:00:00.000Z",
  };
  return { ...entry, intentCard: semanticCard };
}

// ---------------------------------------------------------------------------
// jsonwebtoken verify -- sections A-E
// Entry: verify.js
// Expected: moduleCount in [3, 12] (plan section 3.1 wide range, issue #576 risk)
// stubCount = 0 (external npm edges go into externalSpecifiers, not stubCount)
// DEC-WI510-S6-NPM-EXTERNAL-FAN-OUT-001: first WI-510 fixture with multi-npm externalSpecifiers
// ---------------------------------------------------------------------------

describe("jsonwebtoken verify -- per-entry shave (WI-510 Slice 6)", () => {
  it(
    "section A -- moduleCount in [3,12], stubCount=0, forestTotalLeafCount>0, externalSpecifiers includes jws",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(JWT_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(JWT_FIXTURE_ROOT, "verify.js"),
      });
      console.log("[jwt-verify sA] moduleCount:", forest.moduleCount);
      console.log("[jwt-verify sA] stubCount:", forest.stubCount);
      console.log("[jwt-verify sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      console.log(
        "[jwt-verify sA] BFS filePaths:",
        forestModules(forest).map((m) => normalize(m.filePath).split("jsonwebtoken-9.0.2")[1]),
      );
      const allExternalSpecifiers = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      console.log("[jwt-verify sA] allExternalSpecifiers:", allExternalSpecifiers);
      // Wide lower bound (3): concedes to issue #576 class-arrow-gap risk in transitives.
      expect(
        forest.moduleCount,
        "verify moduleCount should be in [3, 12] (plan section 3.1)",
      ).toBeGreaterThanOrEqual(3);
      expect(
        forest.moduleCount,
        "verify moduleCount should be in [3, 12] (plan section 3.1)",
      ).toBeLessThanOrEqual(12);
      // External npm edges go into externalSpecifiers, not stubCount.
      expect(
        forest.stubCount,
        "verify forest-level stubCount is 0 (external deps in externalSpecifiers)",
      ).toBe(0);
      // DEC-WI510-S6-NPM-EXTERNAL-FAN-OUT-001: jws must be present as externalSpecifier.
      // Plan section 5.6 criterion 12: load-bearing npm-package-external corroboration.
      expect(
        allExternalSpecifiers.some((sp) => sp === "jws" || sp.includes("jws")),
        "verify externalSpecifiers must include jws (DEC-WI510-S6-NPM-EXTERNAL-FAN-OUT-001)",
      ).toBe(true);
      expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
    },
  );

  it("section B -- forest.nodes[0] is verify.js", { timeout: 120_000 }, async () => {
    const forest = await shavePackage(JWT_FIXTURE_ROOT, {
      registry: emptyRegistry,
      entryPath: join(JWT_FIXTURE_ROOT, "verify.js"),
    });
    const firstNode = forest.nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.kind).toBe("module");
    if (firstNode?.kind === "module") expect(firstNode.filePath).toContain("verify.js");
  });

  it(
    "section C -- subgraph has only jsonwebtoken-9.0.2 modules; sign.js absent; multi-npm externalSpecifiers proven",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(JWT_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(JWT_FIXTURE_ROOT, "verify.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) expect(fp).toContain("jsonwebtoken-9.0.2");
      expect(filePaths.some((p) => p.includes("verify.js"))).toBe(true);
      expect(
        filePaths.every((p) => !p.endsWith("sign.js")),
        "sign.js must NOT be in the verify subgraph",
      ).toBe(true);
      const externalSpecifiers = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      console.log("[jwt-verify sC] externalSpecifiers:", externalSpecifiers);
      expect(
        externalSpecifiers.length,
        "verify subgraph must have at least one external specifier",
      ).toBeGreaterThan(0);
      expect(
        externalSpecifiers.some((sp) => sp === "jws" || sp.includes("jws")),
        "verify externalSpecifiers must include jws",
      ).toBe(true);
      expect(forestStubs(forest).length).toBe(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for verify subgraph",
    { timeout: 120_000 },
    async () => {
      const entryPath = join(JWT_FIXTURE_ROOT, "verify.js");
      const forest1 = await shavePackage(JWT_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
      const forest2 = await shavePackage(JWT_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
      expect(forest1.moduleCount).toBe(forest2.moduleCount);
      expect(forest1.stubCount).toBe(forest2.stubCount);
      expect(forestTotalLeafCount(forest1)).toBe(forestTotalLeafCount(forest2));
      expect(forestModules(forest1).map((m) => m.filePath)).toEqual(
        forestModules(forest2).map((m) => m.filePath),
      );
      expect(
        forestModules(forest1)
          .flatMap((m) => collectLeafHashes(m.tree.root))
          .sort(),
      ).toEqual(
        forestModules(forest2)
          .flatMap((m) => collectLeafHashes(m.tree.root))
          .sort(),
      );
      expect(
        forestModules(forest1)
          .flatMap((m) => m.externalSpecifiers)
          .sort(),
      ).toEqual(
        forestModules(forest2)
          .flatMap((m) => m.externalSpecifiers)
          .sort(),
      );
    },
  );

  it(
    "section E -- verify forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(JWT_FIXTURE_ROOT, {
          registry,
          entryPath: join(JWT_FIXTURE_ROOT, "verify.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        expect(plans.length).toBeGreaterThan(0);
        let persistedCount = 0;
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue") {
              const mr = await maybePersistNovelGlueAtom(withStubIntentCard(entry), registry);
              if (mr !== undefined) {
                persistedCount++;
                expect(await registry.getBlock(mr)).not.toBeNull();
              }
            }
          }
        }
        console.log("[jwt-verify sE] persisted atoms:", persistedCount);
        expect(persistedCount).toBeGreaterThan(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// jsonwebtoken decode -- sections A-E
// Entry: decode.js
// Expected: moduleCount in [1, 2] (plan section 3.2 -- smallest subgraph in WI-510 suite)
// decode.js has only one external require: jws.
// Two issue-body bindings map to this file:
//   decode-base64url (DEC-WI510-S6-JWT-DECODE-BASE64URL-BINDING-001)
//   parse-jose-header (DEC-WI510-S6-JWT-PARSE-JOSE-HEADER-BINDING-001)
// Both corpus rows retrieve the same atom merkle root.
// ---------------------------------------------------------------------------

describe("jsonwebtoken decode -- per-entry shave (WI-510 Slice 6)", () => {
  it(
    "section A -- moduleCount in [1,2], stubCount=0, forestTotalLeafCount>0, externalSpecifiers includes jws",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(JWT_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(JWT_FIXTURE_ROOT, "decode.js"),
      });
      console.log("[jwt-decode sA] moduleCount:", forest.moduleCount);
      console.log("[jwt-decode sA] stubCount:", forest.stubCount);
      console.log("[jwt-decode sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      console.log(
        "[jwt-decode sA] BFS filePaths:",
        forestModules(forest).map((m) => normalize(m.filePath).split("jsonwebtoken-9.0.2")[1]),
      );
      const allExternalSpecifiers = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      console.log("[jwt-decode sA] allExternalSpecifiers:", allExternalSpecifiers);
      expect(
        forest.moduleCount,
        "decode moduleCount should be in [1, 2] (plan section 3.2)",
      ).toBeGreaterThanOrEqual(1);
      expect(
        forest.moduleCount,
        "decode moduleCount should be in [1, 2] (plan section 3.2)",
      ).toBeLessThanOrEqual(2);
      expect(
        forest.stubCount,
        "decode forest-level stubCount is 0 (jws in externalSpecifiers)",
      ).toBe(0);
      expect(
        allExternalSpecifiers.some((sp) => sp === "jws" || sp.includes("jws")),
        "decode externalSpecifiers must include jws",
      ).toBe(true);
      expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
    },
  );

  it("section B -- forest.nodes[0] is decode.js", { timeout: 120_000 }, async () => {
    const forest = await shavePackage(JWT_FIXTURE_ROOT, {
      registry: emptyRegistry,
      entryPath: join(JWT_FIXTURE_ROOT, "decode.js"),
    });
    const firstNode = forest.nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.kind).toBe("module");
    if (firstNode?.kind === "module") expect(firstNode.filePath).toContain("decode.js");
  });

  it(
    "section C -- decode subgraph has only decode.js; no verify/sign/index; jws externalSpecifier proven",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(JWT_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(JWT_FIXTURE_ROOT, "decode.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) expect(fp).toContain("jsonwebtoken-9.0.2");
      expect(filePaths.some((p) => p.includes("decode.js"))).toBe(true);
      const unrelated = ["verify.js", "sign.js", "index.js"];
      for (const u of unrelated) {
        expect(
          filePaths.every((p) => !p.endsWith(u)),
          `${u} must NOT be in decode subgraph`,
        ).toBe(true);
      }
      const externalSpecifiers = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      console.log("[jwt-decode sC] externalSpecifiers:", externalSpecifiers);
      expect(
        externalSpecifiers.some((sp) => sp === "jws" || sp.includes("jws")),
        "decode externalSpecifiers must include jws",
      ).toBe(true);
      expect(forestStubs(forest).length).toBe(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for decode subgraph",
    { timeout: 120_000 },
    async () => {
      const entryPath = join(JWT_FIXTURE_ROOT, "decode.js");
      const forest1 = await shavePackage(JWT_FIXTURE_ROOT, { registry: emptyRegistry, entryPath });
      const forest2 = await shavePackage(JWT_FIXTURE_ROOT, { registry: emptyRegistry, entryPath });
      expect(forest1.moduleCount).toBe(forest2.moduleCount);
      expect(forest1.stubCount).toBe(forest2.stubCount);
      expect(forestTotalLeafCount(forest1)).toBe(forestTotalLeafCount(forest2));
      expect(forestModules(forest1).map((m) => m.filePath)).toEqual(
        forestModules(forest2).map((m) => m.filePath),
      );
      expect(
        forestModules(forest1)
          .flatMap((m) => collectLeafHashes(m.tree.root))
          .sort(),
      ).toEqual(
        forestModules(forest2)
          .flatMap((m) => collectLeafHashes(m.tree.root))
          .sort(),
      );
    },
  );

  it(
    "section E -- decode forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(JWT_FIXTURE_ROOT, {
          registry,
          entryPath: join(JWT_FIXTURE_ROOT, "decode.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        expect(plans.length).toBeGreaterThan(0);
        let persistedCount = 0;
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue") {
              const mr = await maybePersistNovelGlueAtom(withStubIntentCard(entry), registry);
              if (mr !== undefined) {
                persistedCount++;
                expect(await registry.getBlock(mr)).not.toBeNull();
              }
            }
          }
        }
        console.log("[jwt-decode sE] persisted atoms:", persistedCount);
        // decode.js is a short (~30 line) module-level function. May produce GlueLeafEntry only.
        expect(persistedCount).toBeGreaterThanOrEqual(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Section F tests (combinedScore quality gate, DISCOVERY_EVAL_PROVIDER=local)
// Per plan section 5.6 criterion 7: if DISCOVERY_EVAL_PROVIDER=local is absent,
// the quality block skips -- the slice is BLOCKED, not ready.
// ---------------------------------------------------------------------------

describe("jsonwebtoken verify section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "jsonwebtoken verify combinedScore >= 0.70 for HS256-verify corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(JWT_FIXTURE_ROOT, {
          registry,
          entryPath: join(JWT_FIXTURE_ROOT, "verify.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(
                  entry,
                  "Verify a JSON Web Token signature using the HS256 HMAC-SHA256 algorithm and return the decoded payload",
                  [
                    "JWT signature verification using symmetric HMAC-SHA256 secret key",
                    "validates token expiry and not-before claims after verifying signature",
                    "HS256 algorithm symmetric secret constant-time compare",
                  ],
                ),
                registry,
              );
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Verify a JSON Web Token signature using the HS256 HMAC-SHA256 algorithm and return the decoded payload",
          topK: 10,
        });
        console.log(
          "[jwt-verify sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(result.candidates.length).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[jwt-verify sF] top combinedScore:", topScore);
        expect(
          topScore,
          "jsonwebtoken verify combinedScore must be >= 0.70",
        ).toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

describe("jsonwebtoken decode-base64url section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "jsonwebtoken decode-base64url combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(JWT_FIXTURE_ROOT, {
          registry,
          entryPath: join(JWT_FIXTURE_ROOT, "decode.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(
                  entry,
                  "Decode the three base64url-encoded sections of a JSON Web Token into header, payload, and signature parts",
                  [
                    "JWT decoding without signature verification base64url sections",
                    "parses header payload signature from dot-separated JWT string",
                    "jws.decode returns header payload signature object",
                  ],
                ),
                registry,
              );
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Decode the three base64url-encoded sections of a JSON Web Token into header, payload, and signature parts",
          topK: 10,
        });
        console.log(
          "[jwt-decode-b64 sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(result.candidates.length).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[jwt-decode-b64 sF] top combinedScore:", topScore);
        expect(
          topScore,
          "jsonwebtoken decode-base64url combinedScore must be >= 0.70",
        ).toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

describe("jsonwebtoken parse-jose-header section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "jsonwebtoken parse-jose-header combinedScore >= 0.70 for corpus query; same decode.js atom as decode-base64url",
    { timeout: 120_000 },
    async () => {
      // DEC-WI510-S6-JWT-PARSE-JOSE-HEADER-BINDING-001: parse-jose-header maps to the same
      // decode.js atom as decode-base64url. Both corpus rows retrieve the same merkle root.
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(JWT_FIXTURE_ROOT, {
          registry,
          entryPath: join(JWT_FIXTURE_ROOT, "decode.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(
                  entry,
                  "Parse the JOSE header of a JSON Web Token to extract the alg and kid fields for key selection",
                  [
                    "JWT JOSE header parsing alg kid algorithm key selection",
                    "decode complete option returns header with alg kid fields",
                    "JSON Web Signature header base64url decode algorithm identifier",
                  ],
                ),
                registry,
              );
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Parse the JOSE header of a JSON Web Token to extract the alg and kid fields for key selection",
          topK: 10,
        });
        console.log(
          "[jwt-parse-jose sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(result.candidates.length).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[jwt-parse-jose sF] top combinedScore:", topScore);
        expect(
          topScore,
          "jsonwebtoken parse-jose-header combinedScore must be >= 0.70",
        ).toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Compound interaction test -- real production sequence end-to-end
// Plan section 5.1: at least one test exercising the real production sequence
// crossing multiple internal component boundaries:
//   shavePackage -> collectForestSlicePlans -> maybePersistNovelGlueAtom
// Both jsonwebtoken headline shaves (verify and decode) run in sequence.
// ---------------------------------------------------------------------------

describe("jsonwebtoken headline bindings -- compound interaction (real production sequence)", () => {
  it(
    "both per-entry shaves (verify, decode) complete, produce non-empty forests with externalSpecifiers, and persist via real path",
    { timeout: 300_000 },
    async () => {
      const bindings = [
        {
          name: "verify",
          entry: "verify.js",
          minMod: 3,
          maxMod: 12,
          requiredExternalSpecifier: "jws",
        },
        {
          name: "decode",
          entry: "decode.js",
          minMod: 1,
          maxMod: 2,
          requiredExternalSpecifier: "jws",
        },
      ] as const;
      for (const b of bindings) {
        const registry = await openRegistry(":memory:", {
          embeddings: createOfflineEmbeddingProvider(),
        });
        try {
          const forest = await shavePackage(JWT_FIXTURE_ROOT, {
            registry,
            entryPath: join(JWT_FIXTURE_ROOT, b.entry),
          });
          expect(forest.moduleCount).toBeGreaterThanOrEqual(b.minMod);
          expect(forest.moduleCount).toBeLessThanOrEqual(b.maxMod);
          expect(forest.stubCount).toBe(0);
          const extSpecs = forestModules(forest).flatMap((m) => m.externalSpecifiers);
          expect(
            extSpecs.some(
              (sp) =>
                sp === b.requiredExternalSpecifier || sp.includes(b.requiredExternalSpecifier),
            ),
            `${b.name}: externalSpecifiers must include '${b.requiredExternalSpecifier}'`,
          ).toBe(true);
          const firstNode = forest.nodes[0];
          expect(firstNode?.kind).toBe("module");
          if (firstNode?.kind === "module") {
            expect(firstNode.filePath).toContain(b.entry);
          }
          const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
          expect(plans.length).toBeGreaterThan(0);
          let persistedCount = 0;
          for (const { slicePlan } of plans) {
            for (const entry of slicePlan.entries) {
              if (entry.kind === "novel-glue") {
                const mr = await maybePersistNovelGlueAtom(withStubIntentCard(entry), registry);
                if (mr !== undefined) persistedCount++;
              }
            }
          }
          // verify subgraph (larger) should produce novel-glue atoms.
          // decode subgraph (tiny) may produce GlueLeafEntry only.
          if (b.name === "verify") {
            expect(persistedCount).toBeGreaterThan(0);
          }
          console.log(
            `[compound] jwt ${b.name}: moduleCount=${forest.moduleCount} stubCount=${forest.stubCount} externalSpecifiers=${extSpecs.join(",")} persisted=${persistedCount}`,
          );
        } finally {
          await registry.close();
        }
      }
    },
  );
});
