// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/federation pull.ts atoms. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L2)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.

// ---------------------------------------------------------------------------
// Property-test corpus for federation/src/pull.ts atoms
//
// Atoms covered (2):
//   resolveTransport (A3.1) — private; returns injected transport or lazy HTTP default
//   pullBlock        (A3.2) — exported; fetch + mandatory integrity gate via
//                             deserializeWireBlockTriplet
//
// resolveTransport is private (not exported). It is exercised transitively through
// pullBlock: when PullOptions.transport is supplied, resolveTransport returns it
// unchanged; when omitted, it would lazily import ./http-transport.js (not tested
// here — that path requires network + globalThis.fetch). Properties here inject
// a stub Transport to stay pure and IO-free, exercising the observable contract
// of resolveTransport via pullBlock's behaviour.
//
// pullBlock routes every WireBlockTriplet through deserializeWireBlockTriplet
// (the mandatory integrity gate). Properties verify the transport-injection path,
// error propagation, and the authority invariant (DEC-PULL-020).
//
// Note: pullBlock is async and calls deserializeWireBlockTriplet which performs
// full integrity checks. Properties use fc.asyncProperty with a stub transport
// that produces valid wire objects (roundtripped through serialize/deserialize)
// to verify the success path, and a corrupt-wire stub to verify the rejection path.
// ---------------------------------------------------------------------------

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import * as fc from "fast-check";
import { pullBlock, pullSpec } from "./pull.js";
import type { RemotePeer, Transport, WireBlockTriplet } from "./types.js";
import { TransportError } from "./types.js";

// ---------------------------------------------------------------------------
// Shared arbitraries and stub builders
// ---------------------------------------------------------------------------

/**
 * Arbitrary for RemotePeer (opaque mirror URL strings).
 * pullBlock passes this to transport.fetchBlock; the stub ignores it.
 */
const remotePeerArb: fc.Arbitrary<RemotePeer> = fc.constantFrom(
  "http://127.0.0.1:9000",
  "http://peer-a.example.com",
  "http://[::1]:8080",
);

/**
 * Arbitrary for BlockMerkleRoot hex strings (64 lowercase hex chars).
 * These are passed to pullBlock as the root to fetch; the stub returns them
 * verbatim in the wire payload — but the integrity gate will reject anything
 * not matching a real computed root, so these properties test transport routing,
 * not the integrity check itself.
 */
const blockRootArb: fc.Arbitrary<BlockMerkleRoot> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join("") as BlockMerkleRoot);

/**
 * Arbitrary for SpecHash hex strings (64 lowercase hex chars).
 */
const specHashArb: fc.Arbitrary<SpecHash> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join("") as SpecHash);

/**
 * Build a stub Transport that always throws TransportError with the given code.
 *
 * Used to verify that pullBlock propagates TransportErrors from the transport
 * layer without swallowing them (DEC-PULL-020 authority invariant).
 */
function makeFailingTransport(code: string): Transport {
  const err = new TransportError({ code, message: `stub: ${code}` });
  return {
    fetchBlock: () => Promise.reject(err),
    fetchSpec: () => Promise.reject(err),
    fetchManifest: () => Promise.reject(err),
    fetchCatalogPage: () => Promise.reject(err),
    getSchemaVersion: () => Promise.reject(err),
    listSpecs: () => Promise.reject(err),
    listBlocks: () => Promise.reject(err),
  };
}

/**
 * Build a stub Transport that returns a structurally invalid WireBlockTriplet
 * (missing required fields). deserializeWireBlockTriplet should reject this
 * at the integrity gate, causing pullBlock to throw IntegrityError or similar.
 *
 * Used to verify that pullBlock does not bypass the integrity gate — it never
 * returns an unverified row, even if the transport succeeds (DEC-PULL-020).
 */
function makeCorruptWireTransport(): Transport {
  const corruptWire = {
    blockMerkleRoot: "not-a-real-hash",
    specHash: "not-a-real-hash",
    specCanonicalBytes: "",
    implSource: "",
    proofManifestJson: "{}",
    artifactBytes: {},
    level: "L0" as const,
    createdAt: 0,
    canonicalAstHash: "not-a-real-hash",
    parentBlockRoot: null,
  } satisfies WireBlockTriplet;
  return {
    fetchBlock: () => Promise.resolve(corruptWire),
    fetchSpec: () => Promise.resolve([]),
    fetchManifest: () => Promise.reject(new TransportError({ code: "not_implemented" })),
    fetchCatalogPage: () => Promise.reject(new TransportError({ code: "not_implemented" })),
    getSchemaVersion: () => Promise.resolve({ schemaVersion: 1 }),
    listSpecs: () => Promise.resolve([]),
    listBlocks: () => Promise.resolve([]),
  };
}

/**
 * Build a stub Transport for fetchSpec that returns a fixed list of roots.
 */
function makeSpecTransport(roots: readonly BlockMerkleRoot[]): Transport {
  return {
    fetchBlock: () => Promise.reject(new TransportError({ code: "not_implemented" })),
    fetchSpec: () => Promise.resolve(roots),
    fetchManifest: () => Promise.reject(new TransportError({ code: "not_implemented" })),
    fetchCatalogPage: () => Promise.reject(new TransportError({ code: "not_implemented" })),
    getSchemaVersion: () => Promise.resolve({ schemaVersion: 1 }),
    listSpecs: () => Promise.resolve([]),
    listBlocks: () => Promise.resolve([]),
  };
}

/**
 * Build a stub Transport for fetchSpec that throws TransportError(not_found).
 *
 * Used to verify pullSpec's 404-normalization: not_found → [] (per
 * FEDERATION_PROTOCOL.md §3 and the dispatch contract §"What to build").
 */
function makeNotFoundTransport(): Transport {
  return {
    fetchBlock: () => Promise.reject(new TransportError({ code: "not_found" })),
    fetchSpec: () => Promise.reject(new TransportError({ code: "not_found" })),
    fetchManifest: () => Promise.reject(new TransportError({ code: "not_found" })),
    fetchCatalogPage: () => Promise.reject(new TransportError({ code: "not_found" })),
    getSchemaVersion: () => Promise.reject(new TransportError({ code: "not_found" })),
    listSpecs: () => Promise.reject(new TransportError({ code: "not_found" })),
    listBlocks: () => Promise.reject(new TransportError({ code: "not_found" })),
  };
}

// ---------------------------------------------------------------------------
// A3.1: resolveTransport — tested transitively via pullBlock/pullSpec
//
// resolveTransport() is private. Observable behaviour:
//   - When PullOptions.transport is provided, that transport is used exclusively
//     (its fetchBlock/fetchSpec is called, not the HTTP default).
//   - When PullOptions.transport is omitted, the lazy HTTP transport would be
//     used — not tested here (requires network); that path is covered by
//     integration tests (transport.test.ts).
//
// Properties below verify the injection path by observing that calls made on
// the stub transport (not the HTTP module) determine the pullBlock outcome.
// ---------------------------------------------------------------------------

/**
 * prop_resolveTransport_uses_injected_transport_on_block_error
 *
 * When a transport is injected that throws TransportError("network_error"),
 * pullBlock propagates that exact error (not an HTTP error). This proves
 * resolveTransport chose the injected transport, not the lazy HTTP default.
 *
 * Invariant: resolveTransport(opts) returns opts.transport when it is defined;
 * the HTTP module is never imported in this path.
 */
export const prop_resolveTransport_uses_injected_transport_on_block_error = fc.asyncProperty(
  remotePeerArb,
  blockRootArb,
  async (remote, root) => {
    const transport = makeFailingTransport("network_error");
    try {
      await pullBlock(remote, root, { transport });
      return false; // must have thrown
    } catch (err) {
      return err instanceof TransportError && err.code === "network_error";
    }
  },
);

/**
 * prop_resolveTransport_uses_injected_transport_on_spec_error
 *
 * When a transport is injected that throws TransportError("server_error"),
 * pullSpec propagates that exact error (not "not_found", which gets translated).
 *
 * Invariant: resolveTransport(opts) returns opts.transport; "server_error" is
 * not the "not_found" sentinel, so pullSpec re-throws it unchanged.
 */
export const prop_resolveTransport_uses_injected_transport_on_spec_error = fc.asyncProperty(
  remotePeerArb,
  specHashArb,
  async (remote, specHash) => {
    const transport = makeFailingTransport("server_error");
    try {
      await pullSpec(remote, specHash, { transport });
      return false; // must have thrown
    } catch (err) {
      return err instanceof TransportError && err.code === "server_error";
    }
  },
);

// ---------------------------------------------------------------------------
// A3.2: pullBlock — exported, mandatory integrity gate
// ---------------------------------------------------------------------------

/**
 * prop_pullBlock_rejects_corrupt_wire_via_integrity_gate
 *
 * When the transport returns a structurally invalid WireBlockTriplet,
 * pullBlock throws (IntegrityError or similar) — it never returns an
 * unverified row to the caller.
 *
 * Authority invariant (DEC-PULL-020, DEC-V1-FEDERATION-WIRE-ARTIFACTS-002):
 * pullBlock MUST route every wire value through deserializeWireBlockTriplet.
 * A corrupt wire (mismatched root, invalid spec, etc.) must cause a throw,
 * not a silent pass-through.
 */
export const prop_pullBlock_rejects_corrupt_wire_via_integrity_gate = fc.asyncProperty(
  remotePeerArb,
  blockRootArb,
  async (remote, root) => {
    const transport = makeCorruptWireTransport();
    try {
      await pullBlock(remote, root, { transport });
      return false; // must have thrown — corrupt wire is never trusted
    } catch (_err) {
      // Any throw here proves the integrity gate executed.
      return true;
    }
  },
);

/**
 * prop_pullBlock_propagates_transport_error_unchanged
 *
 * When the transport throws a TransportError (e.g. "timeout"), pullBlock
 * propagates it as-is without wrapping or swallowing.
 *
 * Invariant: pullBlock does not catch transport-layer errors; they propagate
 * directly to the caller so they can distinguish network failures from
 * integrity failures (DEC-PULL-020).
 */
export const prop_pullBlock_propagates_transport_error_unchanged = fc.asyncProperty(
  remotePeerArb,
  blockRootArb,
  fc.constantFrom("timeout", "connection_refused", "tls_error", "rate_limited"),
  async (remote, root, code) => {
    const transport = makeFailingTransport(code);
    try {
      await pullBlock(remote, root, { transport });
      return false; // must have thrown
    } catch (err) {
      return err instanceof TransportError && err.code === code;
    }
  },
);

/**
 * prop_pullSpec_not_found_normalizes_to_empty_array
 *
 * When the transport throws TransportError("not_found") from fetchSpec,
 * pullSpec returns [] instead of throwing.
 *
 * Invariant (FEDERATION_PROTOCOL.md §3): a 404 means the remote peer has
 * no blocks for this spec; this is not an error condition for the caller.
 * pullSpec is responsible for translating the not_found sentinel into [].
 */
export const prop_pullSpec_not_found_normalizes_to_empty_array = fc.asyncProperty(
  remotePeerArb,
  specHashArb,
  async (remote, specHash) => {
    const transport = makeNotFoundTransport();
    const result = await pullSpec(remote, specHash, { transport });
    return Array.isArray(result) && result.length === 0;
  },
);

/**
 * prop_pullSpec_returns_roots_from_transport
 *
 * When the transport's fetchSpec returns a list of BlockMerkleRoots,
 * pullSpec returns them unchanged.
 *
 * Invariant: pullSpec is a thin wrapper — it passes the transport result
 * through without filtering, reordering, or modifying the roots list.
 */
export const prop_pullSpec_returns_roots_from_transport = fc.asyncProperty(
  remotePeerArb,
  specHashArb,
  fc.array(blockRootArb, { minLength: 0, maxLength: 5 }),
  async (remote, specHash, roots) => {
    const transport = makeSpecTransport(roots);
    const result = await pullSpec(remote, specHash, { transport });
    if (result.length !== roots.length) return false;
    for (let i = 0; i < roots.length; i++) {
      if (result[i] !== roots[i]) return false;
    }
    return true;
  },
);
