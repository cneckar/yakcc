// SPDX-License-Identifier: MIT
//
// Tests for createCommonsSubmitter (WI-794 slice 3 /
// DEC-COMMONS-SUBMIT-AT-STOREBLOCK-001).

import {
  blockMerkleRoot,
  canonicalize,
  specHash as computeSpecHash,
  validateProofManifestL0,
} from "@yakcc/contracts";
import type {
  BlockMerkleRoot,
  CanonicalAstHash,
  SpecHash,
  SpecYak,
} from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import { describe, expect, it } from "vitest";
import { createCommonsSubmitter } from "./submit.js";

const SPEC: SpecYak = {
  name: "submitTestFn",
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
const ARTIFACT_PATH = "tests.fast-check.ts";

function makeRow(implVariant: string): BlockTripletRow {
  const implSource = `export function fn(): unknown { return null; } /* ${implVariant} */`;
  const artifactBytes = new TextEncoder().encode("// dummy");
  const artifacts = new Map<string, Uint8Array>([[ARTIFACT_PATH, artifactBytes]]);
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

// Helper: drain microtasks until a condition or a timeout.
async function waitFor(cond: () => boolean, timeoutMs = 200): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("createCommonsSubmitter (#794 slice 3)", () => {
  it("POSTs to <url>/v1/blocks/submit with JSON body and calls onSuccess on 2xx", async () => {
    const calls: string[] = [];
    const successes: BlockMerkleRoot[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const submit = createCommonsSubmitter({
      url: "https://commons.example.com",
      fetchImpl: fakeFetch,
      onSuccess: (root) => successes.push(root as BlockMerkleRoot),
    });
    const row = makeRow("v1");
    submit(row); // fire-and-forget — must return synchronously
    await waitFor(() => successes.length > 0);
    expect(calls).toEqual(["https://commons.example.com/v1/blocks/submit"]);
    expect(successes).toEqual([row.blockMerkleRoot]);
  });

  it("strips trailing slashes from the base URL", async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    };
    const submit = createCommonsSubmitter({
      url: "https://commons.example.com///",
      fetchImpl: fakeFetch,
    });
    submit(makeRow("trim"));
    await waitFor(() => calls.length > 0);
    expect(calls[0]).toBe("https://commons.example.com/v1/blocks/submit");
  });

  it("calls onError on non-2xx response without throwing to the caller", async () => {
    const errors: Array<{ msg: string; root: string }> = [];
    const fakeFetch: typeof fetch = async () => new Response("{}", { status: 500 });
    const submit = createCommonsSubmitter({
      url: "https://commons.example.com",
      fetchImpl: fakeFetch,
      onError: (err, root) => errors.push({ msg: err.message, root }),
    });
    const row = makeRow("err");
    submit(row);
    await waitFor(() => errors.length > 0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.msg).toContain("HTTP 500");
    expect(errors[0]?.root).toBe(row.blockMerkleRoot);
  });

  it("routes fetch rejections through onError (network down)", async () => {
    const errors: Array<{ msg: string }> = [];
    const fakeFetch: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const submit = createCommonsSubmitter({
      url: "https://commons.example.com",
      fetchImpl: fakeFetch,
      onError: (err) => errors.push({ msg: err.message }),
    });
    submit(makeRow("net"));
    await waitFor(() => errors.length > 0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.msg).toContain("ECONNREFUSED");
  });

  it("submit() returns immediately (does not block on fetch)", async () => {
    let resolveFetch: ((v: Response) => void) | null = null;
    const slowFetch: typeof fetch = () =>
      new Promise<Response>((r) => {
        resolveFetch = r;
      });
    const submit = createCommonsSubmitter({
      url: "https://commons.example.com",
      fetchImpl: slowFetch,
    });
    const t0 = Date.now();
    submit(makeRow("fast"));
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(50); // Sync return, no await
    // Cleanup: resolve the hanging fetch so vitest doesn't hold.
    if (resolveFetch !== null) {
      (resolveFetch as (v: Response) => void)(new Response("{}", { status: 200 }));
    }
  });

  it("survives sync serialize errors by routing through onError", async () => {
    const errors: Array<{ msg: string }> = [];
    let fetchCalled = false;
    const submit = createCommonsSubmitter({
      url: "https://commons.example.com",
      fetchImpl: async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      },
      onError: (err) => errors.push({ msg: err.message }),
    });
    // Force a JSON.stringify failure by replacing implSource with a getter that throws.
    const row = makeRow("circ");
    Object.defineProperty(row, "implSource", {
      get(): string {
        throw new Error("synthetic-serialize-error");
      },
      configurable: true,
    });
    submit(row);
    // Sync path: error reported before any fetch attempt.
    expect(fetchCalled).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.msg).toContain("synthetic-serialize-error");
  });
});
