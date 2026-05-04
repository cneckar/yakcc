// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/federation serve.ts atoms. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L2)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.

// ---------------------------------------------------------------------------
// Property-test corpus for federation/src/serve.ts atoms
//
// Atoms covered (6):
//   sendJson             (A4.1) — private; writes JSON body with Content-Type header
//   sendError            (A4.2) — private; wraps sendJson with { error: code } envelope
//   handleSchemaVersion  (A4.3) — private; returns { schemaVersion: SCHEMA_VERSION }
//   handleListSpecs      (A4.4) — private; calls registry.enumerateSpecs() → { specHashes }
//   handleGetSpec        (A4.5) — private; calls registry.selectBlocks() → 200/404
//   handleGetBlock       (A4.6) — private; calls registry.getBlock() → 200/404
//
// All six atoms are private (not exported). They are exercised transitively through
// the public serveRegistry() API by making real HTTP requests against a live server
// bound to port 0 (OS-assigned). This keeps the tests IO-local (loopback only)
// while exercising the actual production HTTP path including JSON serialisation,
// status codes, Content-Type headers, and error envelopes.
//
// The Registry injected is a minimal in-memory stub — no SQLite, no disk IO.
// Properties use fc.asyncProperty against arbitrary SpecHash / BlockMerkleRoot
// values to verify protocol invariants, not just single fixed inputs.
//
// Note: serveRegistry starts a real node:http server. Each property creates and
// tears it down within the async property body to keep tests hermetic.
// ---------------------------------------------------------------------------

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";
import { SCHEMA_VERSION } from "@yakcc/registry";
import * as fc from "fast-check";
import { serveRegistry } from "./serve.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/**
 * Arbitrary for SpecHash hex strings (64 lowercase hex chars).
 */
const specHashArb: fc.Arbitrary<SpecHash> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join("") as SpecHash);

/**
 * Arbitrary for BlockMerkleRoot hex strings (64 lowercase hex chars).
 */
const blockRootArb: fc.Arbitrary<BlockMerkleRoot> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join("") as BlockMerkleRoot);

// ---------------------------------------------------------------------------
// Minimal Registry stub builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal stub Registry that satisfies the Registry interface surface
 * used by serveRegistry (enumerateSpecs, selectBlocks, getBlock).
 *
 * All methods not used by serve.ts throw "not_implemented" to surface accidental
 * calls clearly during property execution.
 *
 * @param specs      - Map from SpecHash → BlockMerkleRoot[] for enumerateSpecs/selectBlocks.
 * @param blocks     - Map from BlockMerkleRoot → StoredBlock for getBlock.
 */
function makeStubRegistry(
  specs: Map<SpecHash, BlockMerkleRoot[]>,
  blocks: Map<BlockMerkleRoot, unknown>,
): Registry {
  return {
    async enumerateSpecs(): Promise<SpecHash[]> {
      return Array.from(specs.keys());
    },
    async selectBlocks(specHash: SpecHash): Promise<BlockMerkleRoot[]> {
      return specs.get(specHash) ?? [];
    },
    async getBlock(root: BlockMerkleRoot): Promise<unknown> {
      return blocks.get(root) ?? null;
    },
    // Remaining Registry methods are not called by serve.ts.
    // Return typed rejections so accidental calls surface clearly.
    insertBlock(): never {
      throw new Error("stub: insertBlock not implemented");
    },
    listBlocks(): never {
      throw new Error("stub: listBlocks not implemented");
    },
    close(): never {
      throw new Error("stub: close not implemented");
    },
  } as unknown as Registry;
}

/**
 * Perform a GET request against the served URL and return { status, body }.
 * Body is parsed as JSON. Throws on network error.
 */
async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url);
  const body: unknown = await res.json();
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// A4.1: sendJson — exercised transitively via every endpoint
//
// sendJson is private. Observable behaviour:
//   - Content-Type is "application/json" on every successful response.
//   - The response body is valid JSON matching the passed object.
//   - Status code is exactly what was passed.
//
// These invariants are validated transitively through handleSchemaVersion
// (the simplest endpoint that calls sendJson directly) to avoid needing to
// export or mock the private helper.
// ---------------------------------------------------------------------------

/**
 * prop_sendJson_content_type_is_application_json
 *
 * Every endpoint that calls sendJson responds with Content-Type: application/json.
 * Verified via the /schema-version endpoint (simplest, no registry IO).
 *
 * Invariant: sendJson always sets "Content-Type: application/json" regardless of
 * the body value (DEC-SERVE-E-020: all federation endpoints respond with application/json).
 */
export const prop_sendJson_content_type_is_application_json = fc.asyncProperty(
  fc.constant(null),
  async () => {
    const registry = makeStubRegistry(new Map(), new Map());
    const handle = await serveRegistry(registry, { port: 0 });
    try {
      const res = await fetch(`${handle.url}/schema-version`);
      const ct = res.headers.get("content-type") ?? "";
      return ct.startsWith("application/json");
    } finally {
      await handle.close();
    }
  },
);

/**
 * prop_sendJson_body_matches_passed_object
 *
 * The body returned by /schema-version exactly matches { schemaVersion: SCHEMA_VERSION }.
 * This verifies sendJson serialises the object faithfully (JSON.stringify round-trip).
 *
 * Invariant: JSON.parse(JSON.stringify(body)) deep-equals the original value.
 */
export const prop_sendJson_body_matches_passed_object = fc.asyncProperty(
  fc.constant(null),
  async () => {
    const registry = makeStubRegistry(new Map(), new Map());
    const handle = await serveRegistry(registry, { port: 0 });
    try {
      const { body } = await getJson(`${handle.url}/schema-version`);
      return (
        typeof body === "object" &&
        body !== null &&
        "schemaVersion" in body &&
        (body as { schemaVersion: unknown }).schemaVersion === SCHEMA_VERSION
      );
    } finally {
      await handle.close();
    }
  },
);

// ---------------------------------------------------------------------------
// A4.2: sendError — exercised transitively via 404/405 responses
//
// sendError wraps sendJson with { error: "<code>" }. Observable behaviour:
//   - Body is { error: string }.
//   - Status is the passed HTTP code.
//   - The "error" field matches the passed code string exactly.
// ---------------------------------------------------------------------------

/**
 * prop_sendError_unknown_path_returns_not_found_envelope
 *
 * An unknown GET path returns HTTP 404 with body { error: "not_found" }.
 * Path is drawn from fc.stringMatching(/^[0-9a-f]{1,20}$/) to ensure varied, unrecognised paths.
 *
 * Invariant: sendError(res, 404, "not_found") → { error: "not_found" } and
 * status === 404. The envelope key is always "error" (FEDERATION_PROTOCOL.md §3).
 */
export const prop_sendError_unknown_path_returns_not_found_envelope = fc.asyncProperty(
  fc.stringMatching(/^[0-9a-f]{1,20}$/).filter((s) => !["schema-version"].includes(s)),
  async (pathSuffix) => {
    const registry = makeStubRegistry(new Map(), new Map());
    const handle = await serveRegistry(registry, { port: 0 });
    try {
      const { status, body } = await getJson(`${handle.url}/unknown/${pathSuffix}`);
      return (
        status === 404 &&
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        (body as { error: unknown }).error === "not_found"
      );
    } finally {
      await handle.close();
    }
  },
);

/**
 * prop_sendError_non_get_method_returns_405_method_not_allowed
 *
 * Non-GET requests return HTTP 405 with body { error: "method_not_allowed" }.
 * Method is drawn from a constant set of non-GET HTTP methods.
 *
 * Invariant: sendError(res, 405, "method_not_allowed") → { error: "method_not_allowed" }
 * and status === 405 (DEC-V1-WAVE-1-SCOPE-001: read-only, all mutations rejected).
 */
export const prop_sendError_non_get_method_returns_405_method_not_allowed = fc.asyncProperty(
  fc.constantFrom("POST", "PUT", "DELETE", "PATCH"),
  async (method) => {
    const registry = makeStubRegistry(new Map(), new Map());
    const handle = await serveRegistry(registry, { port: 0 });
    try {
      const res = await fetch(`${handle.url}/v1/specs`, { method });
      const body: unknown = await res.json();
      return (
        res.status === 405 &&
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        (body as { error: unknown }).error === "method_not_allowed"
      );
    } finally {
      await handle.close();
    }
  },
);

// ---------------------------------------------------------------------------
// A4.3: handleSchemaVersion — GET /schema-version
//
// Observable behaviour:
//   - Always returns HTTP 200.
//   - Body is { schemaVersion: SCHEMA_VERSION } (the local constant).
//   - Does not call any Registry method (no IO).
// ---------------------------------------------------------------------------

/**
 * prop_handleSchemaVersion_returns_200_with_local_version
 *
 * GET /schema-version always returns 200 { schemaVersion: SCHEMA_VERSION }.
 *
 * Invariant (DEC-TRANSPORT-SCHEMA-VERSION-020): the endpoint returns the local
 * SCHEMA_VERSION constant, not a registry-derived value. The caller (mirrorRegistry)
 * uses this to detect schema-version mismatches before pulling.
 */
export const prop_handleSchemaVersion_returns_200_with_local_version = fc.asyncProperty(
  fc.constant(null),
  async () => {
    const registry = makeStubRegistry(new Map(), new Map());
    const handle = await serveRegistry(registry, { port: 0 });
    try {
      const { status, body } = await getJson(`${handle.url}/schema-version`);
      return (
        status === 200 &&
        typeof body === "object" &&
        body !== null &&
        "schemaVersion" in body &&
        (body as { schemaVersion: unknown }).schemaVersion === SCHEMA_VERSION
      );
    } finally {
      await handle.close();
    }
  },
);

// ---------------------------------------------------------------------------
// A4.4: handleListSpecs — GET /v1/specs
//
// Observable behaviour:
//   - Returns HTTP 200 with { specHashes: SpecHash[] }.
//   - specHashes is exactly what registry.enumerateSpecs() returns.
//   - Returns [] when the registry is empty.
// ---------------------------------------------------------------------------

/**
 * prop_handleListSpecs_returns_all_enumerated_spec_hashes
 *
 * GET /v1/specs returns { specHashes: [...] } containing exactly the hashes
 * returned by registry.enumerateSpecs().
 *
 * Invariant (DEC-TRANSPORT-LIST-METHODS-020): listSpecs maps to /v1/specs;
 * handleListSpecs must pass the full enumerateSpecs() result through unchanged.
 */
export const prop_handleListSpecs_returns_all_enumerated_spec_hashes = fc.asyncProperty(
  fc.array(specHashArb, { minLength: 0, maxLength: 5 }),
  async (specHashes) => {
    const specs = new Map<SpecHash, BlockMerkleRoot[]>(specHashes.map((h) => [h, []]));
    const registry = makeStubRegistry(specs, new Map());
    const handle = await serveRegistry(registry, { port: 0 });
    try {
      const { status, body } = await getJson(`${handle.url}/v1/specs`);
      if (status !== 200) return false;
      if (typeof body !== "object" || body === null || !("specHashes" in body)) return false;
      const returned = (body as { specHashes: unknown }).specHashes;
      if (!Array.isArray(returned)) return false;
      // Order may differ (Map insertion order vs enumeration); check set equality.
      if (returned.length !== specHashes.length) return false;
      const returnedSet = new Set(returned as string[]);
      return specHashes.every((h) => returnedSet.has(h));
    } finally {
      await handle.close();
    }
  },
);

/**
 * prop_handleListSpecs_returns_empty_array_for_empty_registry
 *
 * GET /v1/specs returns { specHashes: [] } when the registry has no specs.
 *
 * Invariant: the response body always has a specHashes array field, even when
 * empty. Callers must not receive undefined or null for that field.
 */
export const prop_handleListSpecs_returns_empty_array_for_empty_registry = fc.asyncProperty(
  fc.constant(null),
  async () => {
    const registry = makeStubRegistry(new Map(), new Map());
    const handle = await serveRegistry(registry, { port: 0 });
    try {
      const { status, body } = await getJson(`${handle.url}/v1/specs`);
      return (
        status === 200 &&
        typeof body === "object" &&
        body !== null &&
        "specHashes" in body &&
        Array.isArray((body as { specHashes: unknown }).specHashes) &&
        (body as { specHashes: unknown[] }).specHashes.length === 0
      );
    } finally {
      await handle.close();
    }
  },
);

// ---------------------------------------------------------------------------
// A4.5: handleGetSpec — GET /v1/spec/<specHash>
//
// Observable behaviour:
//   - Returns 200 { specHash, blockMerkleRoots } when roots exist.
//   - Returns 404 { error: "spec_not_found" } when selectBlocks returns [].
//   - specHash in the response equals the URL parameter exactly.
// ---------------------------------------------------------------------------

/**
 * prop_handleGetSpec_returns_roots_when_present
 *
 * GET /v1/spec/<specHash> returns 200 with the roots from registry.selectBlocks().
 *
 * Invariant: the response envelope carries both specHash (echo of the URL param)
 * and blockMerkleRoots (from selectBlocks). Per http-transport.ts: the receiver
 * parses `envelope.blockMerkleRoots`.
 */
export const prop_handleGetSpec_returns_roots_when_present = fc.asyncProperty(
  specHashArb,
  fc.array(blockRootArb, { minLength: 1, maxLength: 4 }),
  async (specHash, roots) => {
    const specs = new Map<SpecHash, BlockMerkleRoot[]>([[specHash, roots]]);
    const registry = makeStubRegistry(specs, new Map());
    const handle = await serveRegistry(registry, { port: 0 });
    try {
      const { status, body } = await getJson(`${handle.url}/v1/spec/${specHash}`);
      if (status !== 200) return false;
      if (typeof body !== "object" || body === null) return false;
      const b = body as { specHash?: unknown; blockMerkleRoots?: unknown };
      if (b.specHash !== specHash) return false;
      if (!Array.isArray(b.blockMerkleRoots)) return false;
      if (b.blockMerkleRoots.length !== roots.length) return false;
      return roots.every((r, i) => (b.blockMerkleRoots as string[])[i] === r);
    } finally {
      await handle.close();
    }
  },
);

/**
 * prop_handleGetSpec_returns_404_when_absent
 *
 * GET /v1/spec/<specHash> returns 404 { error: "spec_not_found" } when the
 * registry has no blocks for that spec (selectBlocks returns []).
 *
 * Invariant: handleGetSpec must not return 200 with an empty roots array —
 * absence is represented as 404, not an empty success. Callers rely on this
 * to distinguish "no blocks" from "spec exists but empty" (which is impossible
 * in yakcc since a spec with no blocks is never persisted).
 */
export const prop_handleGetSpec_returns_404_when_absent = fc.asyncProperty(
  specHashArb,
  async (specHash) => {
    // Registry has no specs → selectBlocks returns []
    const registry = makeStubRegistry(new Map(), new Map());
    const handle = await serveRegistry(registry, { port: 0 });
    try {
      const { status, body } = await getJson(`${handle.url}/v1/spec/${specHash}`);
      return (
        status === 404 &&
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        (body as { error: unknown }).error === "spec_not_found"
      );
    } finally {
      await handle.close();
    }
  },
);

// ---------------------------------------------------------------------------
// A4.6: handleGetBlock — GET /v1/block/<merkleRoot>
//
// Observable behaviour:
//   - Returns 200 with the serialized WireBlockTriplet when the block exists.
//   - Returns 404 { error: "block_not_found" } when getBlock returns null.
//   - The serialized wire payload is a JSON object (not null, not array).
// ---------------------------------------------------------------------------

/**
 * prop_handleGetBlock_returns_404_when_block_absent
 *
 * GET /v1/block/<root> returns 404 { error: "block_not_found" } when
 * registry.getBlock() returns null.
 *
 * Invariant: handleGetBlock must not serve a 200 for a root that has no
 * stored block. The caller (pullBlock) relies on 404 → not_found to surface
 * "block unavailable at this peer" (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002).
 */
export const prop_handleGetBlock_returns_404_when_block_absent = fc.asyncProperty(
  blockRootArb,
  async (root) => {
    // Registry has no blocks → getBlock returns null
    const registry = makeStubRegistry(new Map(), new Map());
    const handle = await serveRegistry(registry, { port: 0 });
    try {
      const { status, body } = await getJson(`${handle.url}/v1/block/${root}`);
      return (
        status === 404 &&
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        (body as { error: unknown }).error === "block_not_found"
      );
    } finally {
      await handle.close();
    }
  },
);

/**
 * prop_handleGetBlock_returns_200_json_object_when_block_present
 *
 * GET /v1/block/<root> returns 200 with a JSON object when the block exists.
 * The block stub is a plain object that passes through serializeWireBlockTriplet
 * (which is an actual serialization function — only a real StoredBlock would
 * produce a correct WireBlockTriplet).
 *
 * This property verifies the routing/status-code invariant specifically:
 * when getBlock returns non-null, handleGetBlock responds 200 with a JSON object.
 * It does not re-verify the wire format (that is covered by wire.props.ts).
 *
 * The stub block is constructed to match the StoredBlock schema used by
 * serializeWireBlockTriplet so the serialiser does not throw.
 */
export const prop_handleGetBlock_returns_200_json_object_when_block_present = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    // Minimal BlockTripletRow stub that serializeWireBlockTriplet can process.
    // Fields mirror BlockTripletRow from @yakcc/registry (index.ts).
    // Note: the field is `artifacts` (ReadonlyMap<string, Uint8Array>), NOT
    // `artifactBytes` — that is the wire-format field name used in WireBlockTriplet.
    const storedBlock = {
      blockMerkleRoot: root,
      specHash,
      specCanonicalBytes: new Uint8Array(0),
      implSource: "",
      proofManifestJson: "{}",
      artifacts: new Map<string, Uint8Array>(),
      level: "L0" as const,
      createdAt: Date.now(),
      canonicalAstHash: specHash, // use specHash as placeholder (hex string same shape)
      parentBlockRoot: null,
    };
    const blocks = new Map<BlockMerkleRoot, unknown>([[root, storedBlock]]);
    const registry = makeStubRegistry(new Map(), blocks);
    const handle = await serveRegistry(registry, { port: 0 });
    try {
      const { status, body } = await getJson(`${handle.url}/v1/block/${root}`);
      // If serializeWireBlockTriplet rejects the stub, the server would respond 500.
      // Accept 200 with an object as proof of the routing invariant.
      return status === 200 && typeof body === "object" && body !== null && !Array.isArray(body);
    } finally {
      await handle.close();
    }
  },
);
