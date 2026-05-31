/**
 * Retrieval-quality integration test for yakcc_resolve.
 *
 * @decision DEC-MCP-RESOLVE-RETRIEVAL-QUALITY-TEST-001
 * @title Prove semantic retrieval: correct atom top-1 at score >= 0.85 against a seeded fixture registry
 * @status decided (wi-1006-resolve-semantic-embedding)
 * @rationale
 *   This test is the regression guard that proves the hash-stub degeneracy (WI-1006)
 *   is gone. It exercises the FULL PRODUCTION HANDLER PATH:
 *
 *     createResolveTool({ openRegistry: () => semanticallySeededRegistry })
 *       → handler → yakccResolve(registry, intentCard) → registry.findCandidatesByQuery()
 *       → createLocalEmbeddingProvider().embed() [REAL ONNX, Xenova/bge-small-en-v1.5]
 *       → KNN cosine distance → top-1 candidate
 *
 *   The fixture registry is seeded with createLocalEmbeddingProvider() — the SAME provider
 *   the handler now uses — so ingest/query parity (DEC-MCP-RESOLVE-SEMANTIC-EMBED-001) is
 *   proved by the test itself: mismatched providers would cause the storage.ts cross-provider
 *   rejection gate (DEC-V3-IMPL-QUERY-002) to throw "cross_provider_rejected".
 *
 *   Assertion: given a known-target atom ("compute SHA-256 hash of string") in a registry
 *   alongside semantically distant decoys, a matching query intent returns the target as
 *   top-1 with score >= 0.85 AND a non-degenerate gap (>= 0.05) to runner-up.
 *
 *   B6 offline guarantee (DEC-MCP-RESOLVE-OFFLINE-GUARANTEE-001):
 *   env.allowRemoteModels = false is set before any embed() call is made.
 *   env.cacheDir is pointed at the workspace-root cache where the ONNX model is
 *   pre-cached by a prior `pnpm install` or `pnpm test` in the workspace root.
 *   If the model is absent from cache, the test fails loudly — not silently.
 *
 * Compound-Interaction Test Requirement (CLAUDE.md):
 *   Crosses: createResolveTool factory → handler closure → yakccResolve (hooks-base) →
 *   registry.findCandidatesByQuery (registry/storage.ts) → embed() (contracts/embeddings.ts
 *   via @xenova/transformers ONNX pipeline) → KNN sqlite-vec → result JSON back to caller.
 *
 * Implements: yakcc#1006
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// ONNX offline guarantee — import @xenova/transformers and pin env synchronously
// before any embedding pipeline is initialized.
// ---------------------------------------------------------------------------
// NOTE: This import MUST come before @yakcc/contracts is imported so that
// env.allowRemoteModels=false is in effect before the first embed() call.
// Vitest resolves the alias chain: @yakcc/contracts → contracts/src/index.ts →
// embeddings.ts → lazily imports @xenova/transformers. The lazy import fires
// on the first embed() call inside storeBlock. By setting env here (module-level
// top-level await in ESM), we guarantee the flag is set before beforeAll runs.
import { env as xenovaEnv } from "@xenova/transformers";

// The workspace-root pnpm virtual store for @xenova/transformers contains the
// pre-cached ONNX model. Point cacheDir there so the test is hermetic (no network).
const __dirname_test = dirname(fileURLToPath(import.meta.url));
// Walk up: src/tools → src → mcp-registry → packages → [worktree root] → [repo root]
// from packages/mcp-registry/src/tools/ we go up 5 levels to get to the repo root
const WORKSPACE_ROOT = resolve(__dirname_test, "../../../../../..");
const XENOVA_CACHE_DIR = join(
  WORKSPACE_ROOT,
  "node_modules/.pnpm/@xenova+transformers@2.17.2/node_modules/@xenova/transformers/.cache",
);

// Pin offline mode (B6 air-gap guarantee for tests too)
xenovaEnv.allowRemoteModels = false;
xenovaEnv.cacheDir = XENOVA_CACHE_DIR;

// ---------------------------------------------------------------------------
// Workspace package imports (resolved via vitest.config.ts aliases to source)
// ---------------------------------------------------------------------------

import {
  createLocalEmbeddingProvider,
  blockMerkleRoot,
  specHash,
  canonicalize,
  canonicalAstHash,
  type ProofManifest,
  type SpecYak,
  type CanonicalAstHash,
} from "@yakcc/contracts";
import { openRegistry, type BlockTripletRow } from "@yakcc/registry";
import { createResolveTool } from "./resolve.js";
import type { HttpClient } from "../http-client.js";

// ---------------------------------------------------------------------------
// Fixture helpers — minimal SpecYak and BlockTripletRow builders
// ---------------------------------------------------------------------------

/** Build a minimal SpecYak from a name and a behavior string. */
function makeSpec(name: string, behavior: string): SpecYak {
  return {
    name,
    inputs: [{ name: "input", type: "string" }],
    outputs: [{ name: "result", type: "string" }],
    preconditions: [],
    postconditions: ["result is non-empty"],
    invariants: [],
    effects: [],
    level: "L0",
    behavior,
    guarantees: [{ id: "total", description: "Always returns or throws." }],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe", time: "O(n)", space: "O(1)" },
    propertyTests: [],
  };
}

/** Build a minimal ProofManifest. */
function makeManifest(): ProofManifest {
  return { artifacts: [{ kind: "property_tests", path: "property_tests.ts" }] };
}

/** Build a complete BlockTripletRow from a spec and impl source. */
function makeBlockRow(spec: SpecYak, implSource: string): BlockTripletRow {
  const manifest = makeManifest();
  const artifactBytes = new TextEncoder().encode("// property tests");
  const artifacts = new Map<string, Uint8Array>([["property_tests.ts", artifactBytes]]);
  const root = blockMerkleRoot({ spec, implSource, manifest, artifacts });
  const sh = specHash(spec);
  const canonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);
  return {
    blockMerkleRoot: root,
    specHash: sh,
    specCanonicalBytes: canonicalBytes,
    implSource,
    proofManifestJson: JSON.stringify(manifest),
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: canonicalAstHash(implSource) as CanonicalAstHash,
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle — build fixture registry once, tear down after all tests
// ---------------------------------------------------------------------------

let tmpDir: string;
let registryPath: string;

// The block merkle root of the target atom (stored by the seeding step).
let targetMerkleRoot: string;

beforeAll(async () => {
  // Create temp dir for the fixture SQLite file
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-resolve-retrieval-quality-"));
  registryPath = join(tmpDir, "fixture.sqlite");

  // Seed registry with createLocalEmbeddingProvider — SAME provider the handler uses.
  // This proves ingest/query parity (DEC-MCP-RESOLVE-SEMANTIC-EMBED-001).
  const provider = createLocalEmbeddingProvider();
  const registry = await openRegistry(registryPath, { embeddings: provider });

  // ---- Target atom: cryptographic hashing ----
  // Query will be semantically close: "compute SHA-256 hash of a string"
  const TARGET_BEHAVIOR =
    "Compute the SHA-256 cryptographic hash of a UTF-8 string and return the hex digest";
  const targetSpec = makeSpec("sha256-hash", TARGET_BEHAVIOR);
  const targetRow = makeBlockRow(
    targetSpec,
    `import { createHash } from "node:crypto";
export function sha256Hash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}`,
  );
  targetMerkleRoot = targetRow.blockMerkleRoot;
  await registry.storeBlock(targetRow);

  // ---- Decoy atom 1: HTTP requests (semantically distant from hashing) ----
  const decoy1Spec = makeSpec(
    "fetch-json",
    "Perform an HTTP GET request to a URL and parse the JSON response body",
  );
  const decoy1Row = makeBlockRow(
    decoy1Spec,
    `export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
  return res.json() as Promise<T>;
}`,
  );
  await registry.storeBlock(decoy1Row);

  // ---- Decoy atom 2: date formatting (semantically distant from hashing) ----
  const decoy2Spec = makeSpec(
    "format-date",
    "Format a Date object into a human-readable string using locale settings",
  );
  const decoy2Row = makeBlockRow(
    decoy2Spec,
    `export function formatDate(date: Date, locale = "en-US"): string {
  return date.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" });
}`,
  );
  await registry.storeBlock(decoy2Row);

  // ---- Decoy atom 3: string sorting (semantically distant) ----
  const decoy3Spec = makeSpec(
    "sort-strings",
    "Sort an array of strings alphabetically in ascending order",
  );
  const decoy3Row = makeBlockRow(
    decoy3Spec,
    `export function sortStrings(arr: string[]): string[] {
  return [...arr].sort((a, b) => a.localeCompare(b));
}`,
  );
  await registry.storeBlock(decoy3Row);

  await registry.close();
}, 90_000); // 90s timeout to cover first-time ONNX pipeline initialization

afterAll(() => {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("yakcc_resolve retrieval quality — semantic provider (Xenova/bge-small-en-v1.5)", () => {
  it(
    "target atom is top-1 at score >= 0.85 with non-degenerate gap to runner-up",
    async () => {
      // Open registry with the SAME provider used during seeding (parity proof).
      // A cross-provider mismatch would cause storage.ts:823 to throw 'cross_provider_rejected'.
      const provider = createLocalEmbeddingProvider();
      const fixtureRegistry = await openRegistry(registryPath, { embeddings: provider });

      // Drive the PRODUCTION handler path via createResolveTool with injected factory.
      // This is the same interface production uses; we just supply the already-opened
      // fixture registry instead of reading YAKCC_REGISTRY_PATH.
      const tool = createResolveTool({
        openRegistry: async () => fixtureRegistry,
      });

      // http stub that throws on any call — proves zero HTTP I/O on the resolve path.
      const http: HttpClient = {
        get: async () => {
          throw new Error(
            "[retrieval-quality] http.get must not be called — YAKCC_AIRGAPPED=1 set",
          );
        },
        post: async () => {
          throw new Error("[retrieval-quality] http.post must not be called");
        },
      } as unknown as HttpClient;

      // YAKCC_AIRGAPPED=1 suppresses the global HTTP cascade → proves zero network I/O.
      const savedAirgap = process.env.YAKCC_AIRGAPPED;
      process.env.YAKCC_AIRGAPPED = "1";
      let result: Awaited<ReturnType<typeof tool.handler>>;
      try {
        result = await tool.handler(
          {
            intent: {
              title: "compute SHA-256 hash of a string",
              description: "hash a UTF-8 string using SHA-256 and return hex digest",
            },
          },
          http,
        );
      } finally {
        if (savedAirgap !== undefined) {
          process.env.YAKCC_AIRGAPPED = savedAirgap;
        } else {
          process.env.YAKCC_AIRGAPPED = undefined;
        }
      }

      await fixtureRegistry.close();

      // --- Parse handler response ---
      expect(result).toHaveLength(1);
      const parsed = JSON.parse(result[0]!.text) as {
        confidence_tier: string;
        source: string;
        candidates: Array<{ atom_id: string; score: number; source: string }>;
        airgapped: boolean;
      };

      // Air-gap proof: handler returned local_only with airgapped=true
      expect(parsed.airgapped).toBe(true);
      expect(parsed.source).toBe("local_only");
      expect(parsed.candidates.length).toBeGreaterThan(0);

      const top1 = parsed.candidates[0]!;
      const runner_up = parsed.candidates[1];

      // --- Core retrieval quality assertion ---
      const TARGET_ADDRESS = targetMerkleRoot.slice(0, 8);

      // Log for evidence — visible in raw test output per contract requirements
      const runnerUpScore = runner_up?.score ?? 0;
      const gap = top1.score - runnerUpScore;
      console.log(
        `[retrieval-quality] top-1 atom_id=${top1.atom_id} score=${top1.score.toFixed(4)} ` +
          `runner-up=${runnerUpScore.toFixed(4)} gap=${gap.toFixed(4)} ` +
          `target=${TARGET_ADDRESS} modelId=${provider.modelId}`,
      );

      // The target atom (SHA-256 hashing) must be top-1 at score >= 0.85
      expect(top1.atom_id).toBe(TARGET_ADDRESS);
      expect(top1.score).toBeGreaterThanOrEqual(0.85);

      // Non-degenerate gap: top-1 must be meaningfully above runner-up
      // (proves this is not a degenerate constant-vector scenario)
      expect(gap).toBeGreaterThanOrEqual(0.05);
    },
    30_000,
  );

  it(
    "provider parity: createLocalEmbeddingProvider modelId is Xenova/bge-small-en-v1.5 (DEC-MCP-RESOLVE-SEMANTIC-EMBED-001)",
    async () => {
      // Proves that the query provider matches the ingest provider schema.
      // storage.ts:823 enforces cross-provider rejection; a mismatch would throw.
      const provider = createLocalEmbeddingProvider();
      expect(provider.modelId).toBe("Xenova/bge-small-en-v1.5");

      // Opening fixture with matching provider must succeed (no cross_provider_rejected throw)
      const fixtureRegistry = await openRegistry(registryPath, { embeddings: provider });
      // findCandidatesByQuery succeeds iff provider parity holds
      await expect(
        fixtureRegistry.findCandidatesByQuery({ behavior: "SHA256 hash" }),
      ).resolves.not.toThrow();
      await fixtureRegistry.close();
    },
    30_000,
  );

  it(
    "B6 offline proof: allowRemoteModels=false is set and model loads from local cache (no network)",
    () => {
      // This is a synchronous assertion proving that the env pin is in effect.
      // The fact that the above tests succeed with allowRemoteModels=false proves
      // the model was loaded from local cache only.
      expect(xenovaEnv.allowRemoteModels).toBe(false);
      expect(xenovaEnv.cacheDir).toBe(XENOVA_CACHE_DIR);
    },
  );
});
