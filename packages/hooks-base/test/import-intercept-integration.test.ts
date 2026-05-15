/**
 * import-intercept-integration.test.ts -- Integration tests for WI-508 import-intercept.
 *
 * Production sequence exercised (Compound-Interaction Test, DEC-WI508-INTERCEPT-006):
 *   executeRegistryQueryWithSubstitution(registry, ctx, emittedCode, toolName, opts)
 *   -> applyImportIntercept() -> scanImportsForIntercept() -> yakccResolve()
 *   -> findCandidatesByQuery() -> combinedScore >= CONFIDENT_THRESHOLD -> intercepted=true
 *
 * Tests:
 *   1. Positive case: emitted code has validator import + registry has covering atom
 *      -> importInterceptResults present and intercepted=true.
 *   2. Negative case: empty registry -> importInterceptResults absent (graceful no-op).
 *   3. No covered imports -> importInterceptResults absent.
 *   4. YAKCC_HOOK_DISABLE_SUBSTITUTE=1 -> importInterceptResults absent.
 *
 * @decision DEC-WI508-INTERCEPT-007
 * title: Integration test uses identity-embedder to guarantee cosine similarity = 1.0
 * status: decided (WI-508-IMPORT-INTERCEPT Slice 1 fix round)
 * rationale:
 *   Plan section 4.5 requires synthetic atoms score above 0.70 for their fixture query,
 *   isolating the plumbing test from embedder calibration. Approach (a): use an
 *   EmbeddingProvider that returns the same unit vector for ALL inputs. When stored atom
 *   and query both produce identical unit vectors, cosine distance = 0, combinedScore = 1.0
 *   >= CONFIDENT_THRESHOLD (0.70). This guarantees the intercept fires for the positive
 *   case test without depending on embedder calibration or semantic alignment.
 *   The identity model ID is distinct from any real provider so cross-provider rejection
 *   (D2 invariant) does not fire (same model used for both store and query).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CanonicalAstHash,
  type EmbeddingProvider,
  type ProofManifest,
  type SpecYak,
  blockMerkleRoot,
  canonicalize,
  canonicalAstHash as deriveCanonicalAstHash,
  specHash as deriveSpecHash,
} from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import { openRegistry } from "@yakcc/registry";
import { afterEach, describe, expect, it } from "vitest";
import type { ImportInterceptResult } from "../src/import-intercept.js";
import {
  type HookResponseWithSubstitution,
  executeRegistryQueryWithSubstitution,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Identity embedding provider -- returns the same unit vector for every input.
//
// @decision DEC-WI508-INTERCEPT-007 (see file header)
//
// Because the atom is stored with this provider AND the query is run with this
// provider, cosine distance = 0 for every (atom, query) pair.
// Combined score formula: 1 - L^2/4 = 1 - 0/4 = 1.0 >= CONFIDENT_THRESHOLD (0.70).
// ---------------------------------------------------------------------------

function identityEmbeddingProvider(): EmbeddingProvider {
  // unit vector e1 = (1, 0, 0, ..., 0). All inputs map to this same vector.
  const FIXED_VEC = new Float32Array(384);
  FIXED_VEC[0] = 1.0;
  return {
    dimension: 384,
    modelId: "identity/test-intercept-v1",
    async embed(_text: string): Promise<Float32Array> {
      return FIXED_VEC.slice();
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: build a minimal BlockTripletRow for storeBlock
// ---------------------------------------------------------------------------

function buildValidatorAtom(): BlockTripletRow {
  const spec: SpecYak = {
    name: "validator/isEmail",
    behavior: "validator -- isEmail validate email address",
    inputs: [],
    outputs: [],
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe" },
    propertyTests: [],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
  };
  const implSource =
    "export function isEmail(s: string): boolean { return s.includes('@'); }";
  const manifest: ProofManifest = { artifacts: [] };
  const artifacts = new Map<string, Uint8Array>();
  const root = blockMerkleRoot({ spec, implSource, manifest, artifacts });
  const sh = deriveSpecHash(spec);
  const canonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);
  return {
    blockMerkleRoot: root,
    specHash: sh,
    specCanonicalBytes: canonicalBytes,
    implSource,
    proofManifestJson: JSON.stringify(manifest),
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: deriveCanonicalAstHash(implSource) as CanonicalAstHash,
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

/** Extended type to access importInterceptResults on the non-substituted branch. */
type ResponseWithIntercept = HookResponseWithSubstitution & {
  importInterceptResults?: ImportInterceptResult[];
};

describe("executeRegistryQueryWithSubstitution -- import-intercept integration", () => {
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: env-var removal is intentional; setting to undefined leaves the key present
    delete process.env.YAKCC_HOOK_DISABLE_SUBSTITUTE;
  });

  // Import-only source: no binding call expression.
  // extractBindingShape() needs a const x = fn() pattern; without it,
  // substituted=false so the import-intercept branch is reached.
  const VALIDATOR_SOURCE = 'import { isEmail } from "validator";\n';
  const NO_IMPORT_SOURCE = "function add(a: number, b: number): number { return a + b; }\n";

  // -------------------------------------------------------------------------
  // POSITIVE CASE (F-508-01 requirement):
  //   Registry seeded with covering atom + identity embedder -> intercept fires.
  //   Assert importInterceptResults is present and intercepted=true.
  //   Paste observed HookResponseWithSubstitution per EC section 4.6.7.
  // -------------------------------------------------------------------------
  it("POSITIVE: intercept fires -- importInterceptResults present when registry has covering atom", async () => {
    const embedProv = identityEmbeddingProvider();
    const registry = await openRegistry(":memory:", { embeddings: embedProv });
    const atom = buildValidatorAtom();
    await registry.storeBlock(atom);

    const ctx = { intent: "validate email address using isEmail from validator" };
    const result = (await executeRegistryQueryWithSubstitution(
      registry,
      ctx,
      VALIDATOR_SOURCE,
      "Write",
      { threshold: 0.3, telemetryDir: join(tmpdir(), "yakcc-test-intercept-pos") },
    )) as ResponseWithIntercept;

    // Paste observed HookResponseWithSubstitution (positive case) -- required by EC section 4.6.7.
    console.log(
      "[positive-case] observed HookResponseWithSubstitution:",
      JSON.stringify(
        {
          kind: result.kind,
          substituted: result.substituted,
          importInterceptResults: result.importInterceptResults?.map((r) => ({
            binding: r.binding,
            intercepted: r.intercepted,
            address: r.address,
            score: r.score,
          })),
        },
        null,
        2,
      ),
    );

    // importInterceptResults MUST be present -- the intercept fired
    expect(result.importInterceptResults).toBeDefined();
    expect(result.importInterceptResults).not.toHaveLength(0);

    // The first result must be intercepted=true (combinedScore >= CONFIDENT_THRESHOLD 0.70)
    const first = result.importInterceptResults?.[0];
    expect(first?.intercepted).toBe(true);
    expect(first?.binding.moduleSpecifier).toBe("validator");
    expect(first?.address).not.toBeNull();
    expect(first?.score).toBeGreaterThanOrEqual(0.7);
  });

  // -------------------------------------------------------------------------
  // NEGATIVE CASE (F-508-01 requirement):
  //   Empty registry -> intercept does NOT fire -> importInterceptResults absent.
  //   Paste observed HookResponseWithSubstitution per EC section 4.6.7.
  // -------------------------------------------------------------------------
  it("NEGATIVE: no intercept -- importInterceptResults absent when registry is empty", async () => {
    const embedProv = identityEmbeddingProvider();
    const registry = await openRegistry(":memory:", { embeddings: embedProv });
    // No blocks stored -- registry is intentionally empty to test graceful no-op

    const ctx = { intent: "validate email address" };
    const result = (await executeRegistryQueryWithSubstitution(
      registry,
      ctx,
      VALIDATOR_SOURCE,
      "Write",
      { threshold: 0.3 },
    )) as ResponseWithIntercept;

    // Paste observed HookResponseWithSubstitution (negative case) -- required by EC section 4.6.7.
    console.log(
      "[negative-case] observed HookResponseWithSubstitution:",
      JSON.stringify(
        { kind: result.kind, substituted: result.substituted, importInterceptResults: result.importInterceptResults },
        null,
        2,
      ),
    );

    expect(result).toBeDefined();
    expect(result.substituted).toBe(false);
    // importInterceptResults MUST be absent -- graceful no-op when registry has no coverage
    expect(result.importInterceptResults).toBeUndefined();
  });

  it("no intercept when emitted code has no covered imports", async () => {
    const embedProv = identityEmbeddingProvider();
    const registry = await openRegistry(":memory:", { embeddings: embedProv });
    const atom = buildValidatorAtom();
    await registry.storeBlock(atom);

    const ctx = { intent: "add two numbers" };
    const result = (await executeRegistryQueryWithSubstitution(
      registry,
      ctx,
      NO_IMPORT_SOURCE,
      "Write",
      { threshold: 0.3 },
    )) as ResponseWithIntercept;

    expect(result).toBeDefined();
    expect(result.importInterceptResults).toBeUndefined();
  });

  it("disable knob YAKCC_HOOK_DISABLE_SUBSTITUTE=1 skips import-intercept", async () => {
    process.env.YAKCC_HOOK_DISABLE_SUBSTITUTE = "1";
    const embedProv = identityEmbeddingProvider();
    const registry = await openRegistry(":memory:", { embeddings: embedProv });
    const atom = buildValidatorAtom();
    await registry.storeBlock(atom);

    const ctx = { intent: "validate email address" };
    const result = (await executeRegistryQueryWithSubstitution(
      registry,
      ctx,
      VALIDATOR_SOURCE,
      "Write",
      { threshold: 0.3 },
    )) as ResponseWithIntercept;

    // Disable knob means substitution AND import-intercept both skip
    expect(result.substituted).toBe(false);
    expect(result.importInterceptResults).toBeUndefined();
  });
});