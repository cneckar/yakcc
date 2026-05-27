// SPDX-License-Identifier: MIT
//
// Tests for makeCommonsBinding (WI-794 slice 4 / commons-push CLI helper).

import type { BlockMerkleRoot, SpecYak } from "@yakcc/contracts";
import {
  blockMerkleRoot,
  canonicalize,
  specHash as computeSpecHash,
  validateProofManifestL0,
} from "@yakcc/contracts";
import type { CanonicalAstHash, SpecHash } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import type { BlockTripletRow, Registry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COMMONS_URL, makeCommonsBinding } from "./commons-submit.js";

const ZERO_EMBEDDINGS = {
  dimension: 384,
  modelId: "test-stub",
  async embed(_text: string): Promise<Float32Array> {
    return new Float32Array(384);
  },
};

const SPEC: SpecYak = {
  name: "commonsBindingFn",
  inputs: [{ name: "n", type: "number" }],
  outputs: [{ name: "r", type: "string" }],
  preconditions: [],
  postconditions: [],
  invariants: [],
  effects: [],
  level: "L0",
};

const PROOF_MANIFEST_JSON =
  '{"artifacts":[{"kind":"property_tests","path":"tests.fast-check.ts"}]}';
const PROOF_MANIFEST = validateProofManifestL0(JSON.parse(PROOF_MANIFEST_JSON));

function makeRow(implVariant: string): BlockTripletRow {
  const implSource = `export function fn(): unknown { return null; } /* ${implVariant} */`;
  const artifactBytes = new TextEncoder().encode("// dummy");
  const artifacts = new Map<string, Uint8Array>([["tests.fast-check.ts", artifactBytes]]);
  const specCanonicalBytes = canonicalize(SPEC as unknown as Parameters<typeof canonicalize>[0]);
  const specHashHex = computeSpecHash(SPEC) as SpecHash;
  const merkleRoot = blockMerkleRoot({
    spec: SPEC,
    implSource,
    manifest: PROOF_MANIFEST,
    artifacts,
  });
  return {
    blockMerkleRoot: merkleRoot,
    specHash: specHashHex,
    specCanonicalBytes,
    implSource,
    proofManifestJson: PROOF_MANIFEST_JSON,
    level: "L0",
    createdAt: 1_714_000_000_000,
    canonicalAstHash: "a".repeat(64) as CanonicalAstHash,
    parentBlockRoot: null,
    artifacts,
  };
}

describe("makeCommonsBinding (#794 slice 4)", () => {
  let savedAirgap: string | undefined;
  let savedUrl: string | undefined;

  beforeEach(() => {
    savedAirgap = process.env.YAKCC_AIRGAP;
    savedUrl = process.env.YAKCC_COMMONS_URL;
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env.YAKCC_AIRGAP;
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env.YAKCC_COMMONS_URL;
  });

  afterEach(() => {
    if (savedAirgap === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
      delete process.env.YAKCC_AIRGAP;
    } else {
      process.env.YAKCC_AIRGAP = savedAirgap;
    }
    if (savedUrl === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
      delete process.env.YAKCC_COMMONS_URL;
    } else {
      process.env.YAKCC_COMMONS_URL = savedUrl;
    }
  });

  it("returns commonsSubmit=undefined when registryPath is :memory:", () => {
    const b = makeCommonsBinding({ registryPath: ":memory:" });
    expect(b.commonsSubmit).toBeUndefined();
  });

  it("returns commonsSubmit=undefined when airgapped=true", () => {
    const b = makeCommonsBinding({ registryPath: "/tmp/r.sqlite", airgapped: true });
    expect(b.commonsSubmit).toBeUndefined();
  });

  it("returns commonsSubmit=undefined when YAKCC_AIRGAP=1", () => {
    process.env.YAKCC_AIRGAP = "1";
    const b = makeCommonsBinding({ registryPath: "/tmp/r.sqlite" });
    expect(b.commonsSubmit).toBeUndefined();
  });

  it("returns a working commonsSubmit otherwise", () => {
    const b = makeCommonsBinding({
      registryPath: "/tmp/r.sqlite",
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    expect(b.commonsSubmit).toBeDefined();
    expect(typeof b.commonsSubmit).toBe("function");
  });

  it("commonsSubmit POSTs to the default URL when no override is set", async () => {
    const urls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response("{}", { status: 200 });
    };
    const b = makeCommonsBinding({ registryPath: "/tmp/r.sqlite", fetchImpl: fakeFetch });
    const row = makeRow("default-url");
    b.commonsSubmit?.(row);
    await new Promise((r) => setTimeout(r, 20));
    expect(urls[0]).toBe(`${DEFAULT_COMMONS_URL}/v1/blocks/submit`);
  });

  it("commonsSubmit POSTs to YAKCC_COMMONS_URL when set", async () => {
    process.env.YAKCC_COMMONS_URL = "https://custom.example.com";
    const urls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response("{}", { status: 200 });
    };
    const b = makeCommonsBinding({ registryPath: "/tmp/r.sqlite", fetchImpl: fakeFetch });
    b.commonsSubmit?.(makeRow("env-url"));
    await new Promise((r) => setTimeout(r, 20));
    expect(urls[0]).toBe("https://custom.example.com/v1/blocks/submit");
  });

  it("explicit commonsUrl in policy beats env var", async () => {
    process.env.YAKCC_COMMONS_URL = "https://env.example.com";
    const urls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response("{}", { status: 200 });
    };
    const b = makeCommonsBinding({
      registryPath: "/tmp/r.sqlite",
      commonsUrl: "https://policy.example.com",
      fetchImpl: fakeFetch,
    });
    b.commonsSubmit?.(makeRow("policy-url"));
    await new Promise((r) => setTimeout(r, 20));
    expect(urls[0]).toBe("https://policy.example.com/v1/blocks/submit");
  });

  it("bind(registry) wires the success callback to markBlockSubmitted", async () => {
    // Open a real :memory: registry to verify markBlockSubmitted lands.
    // Note: we still use a non-:memory: PATH for the policy so the binding is active.
    const fakeFetch: typeof fetch = async () => new Response("{}", { status: 200 });
    const b = makeCommonsBinding({
      registryPath: "/tmp/r.sqlite",
      fetchImpl: fakeFetch,
    });
    // The registry instance is :memory: regardless — the policy only gates
    // construction of the submitter, not what registry we attach to.
    const registry: Registry = await openRegistry(":memory:", { embeddings: ZERO_EMBEDDINGS });
    b.bind(registry);

    const row = makeRow("bind-mark");
    await registry.storeBlock(row);
    // Simulate the slice-3 storeBlock seam firing the binding ourselves —
    // we're testing the helper composition, not the storage path.
    b.commonsSubmit?.(row);

    // Wait for the async POST + markBlockSubmitted to land.
    await new Promise((r) => setTimeout(r, 50));

    const unsubmitted = await registry.listUnsubmittedBlocks(10);
    expect(unsubmitted).not.toContain(row.blockMerkleRoot as BlockMerkleRoot);
    await registry.close();
  });
});
