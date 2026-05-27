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

function makeRow(implVariant: string): BlockTripletRow {
  const specCanonicalBytes = new TextEncoder().encode(canonicalize(SPEC));
  const sHash: SpecHash = computeSpecHash(SPEC);
  const implSource = `// SPDX-License-Identifier: MIT\nexport const v = "${implVariant}";\n`;
  const artifacts = new Map<string, Uint8Array>([
    ["tests.fast-check.ts", new TextEncoder().encode("// dummy")],
  ]);
  const root = blockMerkleRoot({
    spec: specCanonicalBytes,
    impl: implSource,
    manifest: PROOF_MANIFEST,
    artifacts,
  });
  return {
    blockMerkleRoot: root,
    specHash: sHash,
    specCanonicalBytes,
    implSource,
    proofManifestJson: PROOF_MANIFEST_JSON,
    level: "L0",
    createdAt: 0,
    canonicalAstHash: ("0".repeat(64) as unknown) as CanonicalAstHash,
    artifacts,
    kind: "local",
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
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const successes: BlockMerkleRoot[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const submit = createCommonsSubmitter({
      url: "https://commons.example.com",
      fetchImpl: fakeFetch,
      onSuccess: (root) => successes.push(root as BlockMerkleRoot),
    });
    const row = makeRow("v1");
    submit(row); // fire-and-forget — should return immediately
    await waitFor(() => successes.length > 0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://commons.example.com/v1/blocks/submit");
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]?.init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(successes).toEqual([row.blockMerkleRoot]);
  });

  it("strips trailing slashes from the base URL", async () => {
    const calls: Array<{ url: string }> = [];
    const fakeFetch: typeof fetch = async (input) => {
      calls.push({ url: String(input) });
      return new Response("{}", { status: 200 });
    };
    const submit = createCommonsSubmitter({
      url: "https://commons.example.com///",
      fetchImpl: fakeFetch,
    });
    submit(makeRow("trim"));
    await waitFor(() => calls.length > 0);
    expect(calls[0]?.url).toBe("https://commons.example.com/v1/blocks/submit");
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
    resolveFetch?.(new Response("{}", { status: 200 }));
  });

  it("survives serialize errors (sync) by routing through onError", async () => {
    const errors: Array<{ msg: string }> = [];
    const submit = createCommonsSubmitter({
      url: "https://commons.example.com",
      fetchImpl: async () => new Response("{}", { status: 200 }),
      onError: (err) => errors.push({ msg: err.message }),
    });
    // Deliberately malformed row: missing required fields. serializeWireBlockTriplet
    // is tolerant on TS-type-conforming inputs, so instead force a JSON.stringify
    // failure by injecting a circular structure on `artifacts`.
    const row = makeRow("circ") as BlockTripletRow & { _circ?: unknown };
    // biome-ignore lint/suspicious/noExplicitAny: deliberate circular for test
    const circ: any = {};
    circ.self = circ;
    (row as { _circ?: unknown })._circ = circ;
    // Patch artifacts to include the cycle by reflection on the wire shape
    // (createCommonsSubmitter only JSON.stringify's the wire envelope, so we
    // inject a circular ref into a wire-derivable surface).
    Object.defineProperty(row, "implSource", {
      get() {
        // Throw during serialization — surfaces as a sync error before fetch
        throw new Error("synthetic-serialize-error");
      },
      configurable: true,
    });
    submit(row);
    // Sync path: error reported before microtask drain
    expect(errors).toHaveLength(1);
    expect(errors[0]?.msg).toContain("synthetic-serialize-error");
  });
});
