// SPDX-License-Identifier: MIT
// @decision DEC-HTTP-TRANSPORT-020: HTTP+JSON transport implementation for federation.
// Status: decided (WI-020 Dispatch C, FEDERATION_PROTOCOL.md §3)
// Title: createHttpTransport — Node 22 global fetch, injected for tests
// Rationale:
//   v1 uses Node 22's built-in global fetch (no undici/axios/node-fetch dep).
//   The fetch implementation is injectable via opts.fetch so test suites can
//   provide stub fetch functions without real network I/O.
//
//   Error handling per FEDERATION_PROTOCOL.md §3 "Errors":
//     - Non-2xx with { "error": "<code>", "message": "..." } body
//       → TransportError({ code: error, message })
//     - Non-2xx without a parseable error envelope
//       → TransportError({ code: 'internal_error' })
//     - 404 on fetchSpec → returns [] (normal: peer has no blocks for that spec)
//
// @decision DEC-V1-FEDERATION-PROTOCOL-001: Transport is HTTP+JSON. The Transport
// interface (types.ts) is the seam for future libp2p/IPFS transports. createHttpTransport
// is the only concrete implementation shipped in v1 wave-1.
// Status: decided (MASTER_PLAN.md DEC-V1-FEDERATION-PROTOCOL-001)
//
// @decision DEC-NO-OWNERSHIP-011: No ownership fields anywhere.
// Status: decided (MASTER_PLAN.md DEC-NO-OWNERSHIP-011)
// Rationale: No person-shaped identifier appears in request construction, response
// parsing, or error reporting. The wire shapes consumed here are defined in types.ts
// and carry no ownership fields by schema design.

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import {
  blockUrl,
  blocksUrl,
  manifestUrl,
  schemaVersionUrl,
  specUrl,
  specsUrl,
} from "./transport.js";
import { TransportError } from "./types.js";
import type {
  CatalogPage,
  RemoteManifest,
  RemotePeer,
  Transport,
  WireBlockTriplet,
} from "./types.js";

// ---------------------------------------------------------------------------
// Error envelope parsing
// ---------------------------------------------------------------------------

/**
 * The JSON error envelope defined in FEDERATION_PROTOCOL.md §3 "Errors".
 * Non-2xx responses from a compliant peer include this shape.
 */
interface WireErrorEnvelope {
  error: string;
  message?: string;
}

/**
 * Attempt to parse a WireErrorEnvelope from an unknown value.
 * Returns the envelope if it has a string `error` field; null otherwise.
 */
function parseErrorEnvelope(value: unknown): WireErrorEnvelope | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (typeof v.error === "string" && v.error.length > 0) {
      const envelope: WireErrorEnvelope = { error: v.error };
      if (typeof v.message === "string") {
        envelope.message = v.message;
      }
      return envelope;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Read a fetch Response and return the parsed JSON body.
 * Throws TransportError for any non-2xx status.
 *
 * Per FEDERATION_PROTOCOL.md §3:
 *   - Non-2xx with valid { error, message } envelope → TransportError with wire code.
 *   - Non-2xx without parseable envelope → TransportError({ code: 'internal_error' }).
 */
async function readJsonResponse(response: Response): Promise<unknown> {
  if (response.ok) {
    return response.json() as Promise<unknown>;
  }

  // Non-2xx — attempt to parse error envelope.
  let body: unknown;
  try {
    body = await (response.json() as Promise<unknown>);
  } catch {
    // Body is not JSON — protocol violation; treat as internal_error.
    throw new TransportError({
      code: "internal_error",
      message: `HTTP ${response.status} with non-JSON body from ${response.url}`,
    });
  }

  const envelope = parseErrorEnvelope(body);
  if (envelope !== null) {
    throw new TransportError({
      code: envelope.error,
      message: envelope.message ?? `HTTP ${response.status}: ${envelope.error}`,
    });
  }

  // Non-2xx with JSON body that is not a valid error envelope — internal_error.
  throw new TransportError({
    code: "internal_error",
    message: `HTTP ${response.status} with unexpected body shape from ${response.url}`,
  });
}

// ---------------------------------------------------------------------------
// createHttpTransport
// ---------------------------------------------------------------------------

/**
 * Options for createHttpTransport.
 *
 * The `fetch` option is the escape hatch for tests: inject a stub fetch function
 * to exercise all transport logic without real network I/O. Production callers
 * omit it and use the Node 22 global fetch.
 *
 * Per DEC-HTTP-TRANSPORT-020: no undici/axios/node-fetch. Node 22 global fetch only.
 */
export interface HttpTransportOptions {
  /** Override the global fetch (for tests). Defaults to the Node 22 global fetch. */
  fetch?: typeof fetch;
}

/**
 * Create the default HTTP+JSON transport.
 *
 * This is the v1 concrete implementation of the Transport interface. Its role
 * is to turn URL + fetch response into the typed domain objects defined in
 * types.ts. Integrity checking of WireBlockTriplet is NOT performed here —
 * that responsibility belongs to the caller (pullBlock / mirrorRegistry) via
 * deserializeWireBlockTriplet, per FEDERATION_PROTOCOL.md §4.
 *
 * @param opts - Optional overrides (primarily `fetch` for test injection).
 * @returns A Transport implementation backed by HTTP+JSON.
 *
 * FEDERATION_PROTOCOL.md §3, §5.
 */
export function createHttpTransport(opts?: HttpTransportOptions): Transport {
  // Capture the fetch implementation once at construction time. This ensures a
  // stable reference even if the caller modifies `opts` after construction.
  const _fetch: typeof fetch = opts?.fetch ?? globalThis.fetch;

  return {
    // -----------------------------------------------------------------------
    // fetchManifest — GET /v1/manifest
    // -----------------------------------------------------------------------

    async fetchManifest(remote: RemotePeer): Promise<RemoteManifest> {
      const url = manifestUrl(remote);
      const response = await _fetch(url);
      const body = await readJsonResponse(response);
      // Return the body as-is; structural validation happens at the caller
      // (mirrorRegistry checks protocolVersion/schemaVersion).
      return body as RemoteManifest;
    },

    // -----------------------------------------------------------------------
    // fetchCatalogPage — GET /v1/blocks?limit=<limit>&after=<after>
    // -----------------------------------------------------------------------

    async fetchCatalogPage(
      remote: RemotePeer,
      after: BlockMerkleRoot | null,
      limit: number,
    ): Promise<CatalogPage> {
      const url = blocksUrl(remote, limit, after);
      const response = await _fetch(url);
      const body = await readJsonResponse(response);
      return body as CatalogPage;
    },

    // -----------------------------------------------------------------------
    // fetchBlock — GET /v1/block/<root>
    // -----------------------------------------------------------------------

    async fetchBlock(remote: RemotePeer, root: BlockMerkleRoot): Promise<WireBlockTriplet> {
      const url = blockUrl(remote, root);
      const response = await _fetch(url);
      const body = await readJsonResponse(response);
      return body as WireBlockTriplet;
    },

    // -----------------------------------------------------------------------
    // fetchSpec — GET /v1/spec/<specHash>
    // -----------------------------------------------------------------------

    async fetchSpec(remote: RemotePeer, specHash: SpecHash): Promise<readonly BlockMerkleRoot[]> {
      const url = specUrl(remote, specHash);
      const response = await _fetch(url);

      // 404 is normal: the peer has no blocks for this spec (FEDERATION_PROTOCOL.md §3).
      if (response.status === 404) {
        return [];
      }

      const body = await readJsonResponse(response);
      // Wire shape: { specHash: string; blockMerkleRoots: string[] }
      const envelope = body as { specHash: string; blockMerkleRoots: BlockMerkleRoot[] };
      return envelope.blockMerkleRoots;
    },

    // -----------------------------------------------------------------------
    // getSchemaVersion — GET /schema-version
    // DEC-TRANSPORT-SCHEMA-VERSION-020: first call mirrorRegistry makes before
    // inserting anything. Aborts on mismatch via SchemaVersionMismatchError.
    // -----------------------------------------------------------------------

    async getSchemaVersion(remote: RemotePeer): Promise<{ readonly schemaVersion: number }> {
      const url = schemaVersionUrl(remote);
      const response = await _fetch(url);
      const body = await readJsonResponse(response);
      return body as { readonly schemaVersion: number };
    },

    // -----------------------------------------------------------------------
    // listSpecs — GET /v1/specs
    // DEC-TRANSPORT-LIST-METHODS-020: lists all spec hashes served by the peer.
    // -----------------------------------------------------------------------

    async listSpecs(remote: RemotePeer): Promise<readonly SpecHash[]> {
      const url = specsUrl(remote);
      const response = await _fetch(url);
      const body = await readJsonResponse(response);
      // Wire shape: { specHashes: string[] }
      const envelope = body as { specHashes: SpecHash[] };
      return envelope.specHashes;
    },

    // -----------------------------------------------------------------------
    // listBlocks — GET /v1/spec/<specHash>
    // DEC-TRANSPORT-LIST-METHODS-020: same endpoint as fetchSpec; named
    // separately to communicate intent at the mirrorRegistry call site.
    // -----------------------------------------------------------------------

    async listBlocks(remote: RemotePeer, specHash: SpecHash): Promise<readonly BlockMerkleRoot[]> {
      const url = specUrl(remote, specHash);
      const response = await _fetch(url);

      // 404 is normal: the peer has no blocks for this spec.
      if (response.status === 404) {
        return [];
      }

      const body = await readJsonResponse(response);
      const envelope = body as { specHash: string; blockMerkleRoots: BlockMerkleRoot[] };
      return envelope.blockMerkleRoots;
    },
  };
}
