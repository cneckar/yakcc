// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-004: hand-authored property-test corpus for
// @yakcc/federation http-transport.ts atoms. Two-file pattern: this file (.props.ts)
// is vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-87-fill-federation)
// Rationale: Same two-file pattern as pull.props.ts — corpus is runtime-independent.

// ---------------------------------------------------------------------------
// Property-test corpus for federation/src/http-transport.ts atoms
//
// Atom covered (1 exported factory):
//   createHttpTransport (A5.1) — returns a Transport backed by HTTP+JSON fetch
//
// Private helpers tested transitively:
//   parseErrorEnvelope  (A5.2) — via non-2xx error flow
//   readJsonResponse    (A5.3) — via all transport methods
//
// Properties exercised (8):
//   1. fetchBlock 200 → returns body as WireBlockTriplet (no parsing/mutation)
//   2. fetchBlock non-2xx with error envelope → TransportError with wire code
//   3. fetchBlock non-2xx without error envelope → TransportError("internal_error")
//   4. fetchSpec 404 → returns [] (FEDERATION_PROTOCOL.md §3 "not_found is normal")
//   5. fetchSpec 200 → returns blockMerkleRoots from the wire envelope
//   6. getSchemaVersion 200 → returns { schemaVersion } unchanged
//   7. listSpecs 200 → returns specHashes array from envelope
//   8. fetch injection: injected fetch is called (not globalThis.fetch)
//
// All properties use an injected stub fetch — no real network I/O.
// DEC-HTTP-TRANSPORT-020: fetch is injectable via opts.fetch.
// ---------------------------------------------------------------------------

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import * as fc from "fast-check";
import { createHttpTransport } from "./http-transport.js";
import { TransportError } from "./types.js";
import type { RemotePeer, WireBlockTriplet } from "./types.js";

// ---------------------------------------------------------------------------
// Stub fetch builder
// ---------------------------------------------------------------------------

/**
 * Build a stub fetch function that returns a fixed Response.
 *
 * @param status  HTTP status code (200, 404, 500, etc.)
 * @param body    The JSON body to serialize and return.
 */
function makeFetch(status: number, body: unknown): typeof fetch {
  return (_input, _init?) => {
    const json = JSON.stringify(body);
    const response = new Response(json, {
      status,
      headers: { "Content-Type": "application/json" },
    });
    return Promise.resolve(response);
  };
}

/**
 * Build a stub fetch that returns a non-JSON body for non-2xx responses.
 * Used to exercise the "no parseable envelope" path in readJsonResponse.
 */
function makeFetchNonJson(status: number): typeof fetch {
  return (_input, _init?) => {
    const response = new Response("Internal Server Error (plain text)", {
      status,
      headers: { "Content-Type": "text/plain" },
    });
    return Promise.resolve(response);
  };
}

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

const remotePeerArb: fc.Arbitrary<RemotePeer> = fc.constantFrom(
  "http://127.0.0.1:9002",
  "http://peer-c.example.com",
);

const blockRootArb: fc.Arbitrary<BlockMerkleRoot> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join("") as BlockMerkleRoot);

const specHashArb: fc.Arbitrary<SpecHash> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join("") as SpecHash);

/**
 * Arbitrary for a minimal-shape WireBlockTriplet.
 * createHttpTransport returns the body as-is (no validation); these properties
 * test the transport layer, not the integrity gate.
 */
const wireBodyArb: fc.Arbitrary<WireBlockTriplet> = fc
  .record({
    blockMerkleRoot: blockRootArb,
    specHash: specHashArb,
    specCanonicalBytes: fc.constant("aGVsbG8="), // base64("hello")
    implSource: fc.constant("export function f() {}"),
    proofManifestJson: fc.constant('{"artifacts":[{"kind":"property_tests","path":"f.fc.ts"}]}'),
    artifactBytes: fc.constant({ "f.fc.ts": "dGVzdA==" }),
    level: fc.constant("L0" as const),
    createdAt: fc.integer({ min: 1_000_000, max: 9_999_999_999_999 }),
    canonicalAstHash: blockRootArb, // same shape: 64 hex chars
    parentBlockRoot: fc.constant(null),
  });

// ---------------------------------------------------------------------------
// A5.1: createHttpTransport — properties
// ---------------------------------------------------------------------------

/**
 * prop_fetchBlock_200_returns_body_as_wire
 *
 * When the stub fetch returns 200 with a WireBlockTriplet body, transport.fetchBlock
 * returns that body unchanged (no parsing, no mutation).
 *
 * Invariant (http-transport.ts): fetchBlock returns body as WireBlockTriplet;
 * integrity checking is the caller's responsibility (pullBlock / mirrorRegistry).
 */
export const prop_fetchBlock_200_returns_body_as_wire = fc.asyncProperty(
  remotePeerArb,
  blockRootArb,
  wireBodyArb,
  async (remote, root, wireBody) => {
    const transport = createHttpTransport({ fetch: makeFetch(200, wireBody) });
    const result = await transport.fetchBlock(remote, root);
    // The transport returns the body verbatim — compare the string fields.
    return (
      result.blockMerkleRoot === wireBody.blockMerkleRoot &&
      result.specHash === wireBody.specHash &&
      result.implSource === wireBody.implSource &&
      result.level === wireBody.level
    );
  },
);

/**
 * prop_fetchBlock_non2xx_with_error_envelope_throws_TransportError
 *
 * When the stub fetch returns a non-2xx with a valid { error, message } envelope,
 * transport.fetchBlock throws TransportError with code === envelope.error.
 *
 * Invariant (DEC-HTTP-TRANSPORT-020, FEDERATION_PROTOCOL.md §3 "Errors"):
 * Non-2xx with parseable envelope → TransportError({ code: error, message }).
 */
export const prop_fetchBlock_non2xx_with_error_envelope_throws_TransportError =
  fc.asyncProperty(
    remotePeerArb,
    blockRootArb,
    fc.constantFrom("not_found", "rate_limited", "internal_error", "forbidden"),
    fc.integer({ min: 400, max: 599 }),
    async (remote, root, errorCode, status) => {
      const envelope = { error: errorCode, message: `stub: ${errorCode}` };
      const transport = createHttpTransport({ fetch: makeFetch(status, envelope) });
      try {
        await transport.fetchBlock(remote, root);
        return false; // must have thrown
      } catch (err) {
        return err instanceof TransportError && err.code === errorCode;
      }
    },
  );

/**
 * prop_fetchBlock_non2xx_without_envelope_throws_internal_error
 *
 * When the stub fetch returns a non-2xx with a plain-text (non-JSON) body,
 * transport.fetchBlock throws TransportError({ code: "internal_error" }).
 *
 * Invariant (FEDERATION_PROTOCOL.md §3): protocol violation (non-JSON body on error)
 * is classified as "internal_error" to prevent information leakage.
 */
export const prop_fetchBlock_non2xx_without_envelope_throws_internal_error =
  fc.asyncProperty(
    remotePeerArb,
    blockRootArb,
    fc.integer({ min: 500, max: 599 }),
    async (remote, root, status) => {
      const transport = createHttpTransport({ fetch: makeFetchNonJson(status) });
      try {
        await transport.fetchBlock(remote, root);
        return false;
      } catch (err) {
        return err instanceof TransportError && err.code === "internal_error";
      }
    },
  );

/**
 * prop_fetchSpec_404_returns_empty_array
 *
 * When the stub fetch returns 404 for fetchSpec, transport returns [] without
 * throwing TransportError.
 *
 * Invariant (FEDERATION_PROTOCOL.md §3): 404 on fetchSpec is not an error —
 * it means the remote has no blocks for this spec. The caller gets [].
 */
export const prop_fetchSpec_404_returns_empty_array = fc.asyncProperty(
  remotePeerArb,
  specHashArb,
  async (remote, sh) => {
    const transport = createHttpTransport({
      fetch: (_url, _init?) => {
        return Promise.resolve(
          new Response('{"error":"not_found"}', {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
        );
      },
    });
    const result = await transport.fetchSpec(remote, sh);
    return Array.isArray(result) && result.length === 0;
  },
);

/**
 * prop_fetchSpec_200_returns_blockMerkleRoots
 *
 * When the stub fetch returns 200 with { specHash, blockMerkleRoots },
 * transport.fetchSpec returns the blockMerkleRoots array unchanged.
 *
 * Invariant: fetchSpec unwraps the wire envelope and returns only the roots list.
 */
export const prop_fetchSpec_200_returns_blockMerkleRoots = fc.asyncProperty(
  remotePeerArb,
  specHashArb,
  fc.array(blockRootArb, { minLength: 0, maxLength: 5 }),
  async (remote, sh, roots) => {
    const envelope = { specHash: sh, blockMerkleRoots: roots };
    const transport = createHttpTransport({ fetch: makeFetch(200, envelope) });
    const result = await transport.fetchSpec(remote, sh);
    if (result.length !== roots.length) return false;
    for (let i = 0; i < roots.length; i++) {
      if (result[i] !== roots[i]) return false;
    }
    return true;
  },
);

/**
 * prop_getSchemaVersion_200_returns_schemaVersion
 *
 * When the stub fetch returns 200 with { schemaVersion }, transport.getSchemaVersion
 * returns that object unchanged.
 *
 * Invariant (DEC-TRANSPORT-SCHEMA-VERSION-020): getSchemaVersion is the first call
 * in mirrorRegistry; it must faithfully pass through the remote's schemaVersion number.
 */
export const prop_getSchemaVersion_200_returns_schemaVersion = fc.asyncProperty(
  remotePeerArb,
  fc.integer({ min: 1, max: 100 }),
  async (remote, version) => {
    const transport = createHttpTransport({
      fetch: makeFetch(200, { schemaVersion: version }),
    });
    const result = await transport.getSchemaVersion(remote);
    return result.schemaVersion === version;
  },
);

/**
 * prop_listSpecs_200_returns_specHashes
 *
 * When the stub fetch returns 200 with { specHashes }, transport.listSpecs
 * returns the specHashes array unchanged.
 *
 * Invariant: listSpecs unwraps the wire envelope and returns only the hashes list.
 */
export const prop_listSpecs_200_returns_specHashes = fc.asyncProperty(
  remotePeerArb,
  fc.array(specHashArb, { minLength: 0, maxLength: 5 }),
  async (remote, hashes) => {
    const envelope = { specHashes: hashes };
    const transport = createHttpTransport({ fetch: makeFetch(200, envelope) });
    const result = await transport.listSpecs(remote);
    if (result.length !== hashes.length) return false;
    for (let i = 0; i < hashes.length; i++) {
      if (result[i] !== hashes[i]) return false;
    }
    return true;
  },
);

/**
 * prop_injected_fetch_is_called_not_globalThis
 *
 * The injected fetch function is called (not globalThis.fetch), proving the
 * opts.fetch injection path works end-to-end.
 *
 * Invariant (DEC-HTTP-TRANSPORT-020): tests must be able to inject fetch to
 * exercise all transport logic without real network I/O.
 */
export const prop_injected_fetch_is_called_not_globalThis = fc.asyncProperty(
  remotePeerArb,
  blockRootArb,
  wireBodyArb,
  async (remote, root, wireBody) => {
    let called = false;
    const stubFetch: typeof fetch = (_input, _init?) => {
      called = true;
      return Promise.resolve(new Response(JSON.stringify(wireBody), { status: 200 }));
    };

    const transport = createHttpTransport({ fetch: stubFetch });
    await transport.fetchBlock(remote, root);
    return called;
  },
);
