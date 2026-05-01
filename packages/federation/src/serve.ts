// @decision DEC-SERVE-E-020: serveRegistry — read-only HTTP mirror server (Slice E).
// Status: decided (WI-020 Dispatch E, FEDERATION_PROTOCOL.md §3)
// Title: serve.ts — F1 read-only registry HTTP server (four Slice-E endpoints)
// Rationale:
//   serveRegistry exposes a local Registry over HTTP following FEDERATION_PROTOCOL.md §3.
//   It is strictly GET-only (all non-GET methods → 405). The four Slice-E endpoints are:
//     GET /schema-version       → { schemaVersion: number }
//     GET /v1/specs             → { specHashes: SpecHash[] }
//     GET /v1/spec/<specHash>   → { specHash, blockMerkleRoots: BlockMerkleRoot[] } | 404
//     GET /v1/block/<root>      → WireBlockTriplet via serializeWireBlockTriplet | 404
//   /v1/manifest and /v1/blocks are intentionally deferred to Slice F (not in scope here).
//   No mutation endpoint exists — not even behind a flag (DEC-V1-WAVE-1-SCOPE-001).
//   port: 0 binds an OS-assigned port (useful for tests). close() shuts down cleanly.
//
// @decision DEC-SERVE-SPECS-ENUMERATION-020: enumerateSpecs optional callback.
// Status: decided (WI-020 Dispatch E)
// Title: Spec enumeration via injected callback
// Rationale:
//   The Registry public interface (packages/registry/src/index.ts) exposes no method to
//   enumerate all distinct spec hashes (only selectBlocks(specHash) and getBlock). Adding
//   one to the Registry interface is out of scope for WI-020 (Dispatch E scope:
//   federation/src/ only). To preserve the single-authority invariant and keep serve.ts
//   testable, serveRegistry accepts an optional `enumerateSpecs()` callback in opts.
//   Production callers supply this from their SQLite layer. Test callers track inserted
//   spec hashes via a helper wrapper.
//   Future Implementers: when a public enumeration primitive lands on Registry, replace
//   the callback with a direct call and remove this callback from ServeOptions.
//
// @decision DEC-NO-OWNERSHIP-011: No ownership fields anywhere.
// Status: decided (MASTER_PLAN.md DEC-NO-OWNERSHIP-011)
//
// @decision DEC-V1-WAVE-1-SCOPE-001: F1 read-only mirror only in v1 wave-1.
// Status: decided (MASTER_PLAN.md DEC-V1-WAVE-1-SCOPE-001)

import * as http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";
import { SCHEMA_VERSION } from "@yakcc/registry";
import { serializeWireBlockTriplet } from "./wire.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for serveRegistry.
 */
export interface ServeOptions {
  /**
   * TCP port to listen on. Default 0 (OS-assigned).
   * Pass 0 to let the OS pick an available port; use ServeHandle.url to find it.
   */
  readonly port?: number;
  /**
   * Bind host. Default "127.0.0.1".
   * Pass "0.0.0.0" to accept connections on all interfaces.
   */
  readonly host?: string;
  /**
   * Callback that returns all distinct SpecHashes known to this registry.
   * Required for GET /v1/specs to return real data.
   *
   * Per DEC-SERVE-SPECS-ENUMERATION-020: supply this from the SQLite layer in
   * production. In tests, use a tracking wrapper (see serve.test.ts).
   *
   * If omitted, GET /v1/specs returns { specHashes: [] }.
   */
  readonly enumerateSpecs?: () => Promise<readonly SpecHash[]>;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Send a JSON response with the given status code and Content-Type.
 * All federation endpoints respond with application/json per FEDERATION_PROTOCOL.md §3.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload, "utf-8"),
  });
  res.end(payload);
}

/**
 * Send a protocol §3 error envelope: { "error": "<code>" }.
 *
 * @param res    - The outgoing HTTP response.
 * @param status - HTTP status code (404, 405, etc.).
 * @param code   - Wire error code string.
 */
function sendError(res: ServerResponse, status: number, code: string): void {
  sendJson(res, status, { error: code });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /schema-version
 *
 * Returns { schemaVersion: SCHEMA_VERSION }.
 * Per DEC-TRANSPORT-SCHEMA-VERSION-020: mirrorRegistry calls this first to abort
 * if the remote schema version exceeds the local one.
 */
function handleSchemaVersion(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { schemaVersion: SCHEMA_VERSION });
}

/**
 * GET /v1/specs
 *
 * Returns { specHashes: SpecHash[] } — all distinct spec hashes served.
 * Requires opts.enumerateSpecs; returns empty array if not provided.
 *
 * DEC-TRANSPORT-LIST-METHODS-020 (see types.ts): listSpecs maps to this endpoint.
 */
async function handleListSpecs(
  _req: IncomingMessage,
  res: ServerResponse,
  opts: ServeOptions,
): Promise<void> {
  const specHashes =
    opts.enumerateSpecs !== undefined ? await opts.enumerateSpecs() : ([] as SpecHash[]);
  sendJson(res, 200, { specHashes });
}

/**
 * GET /v1/spec/<specHash>
 *
 * Returns { specHash, blockMerkleRoots: BlockMerkleRoot[] } for the given specHash,
 * or 404 with { error: "spec_not_found" } if no blocks exist for that spec.
 *
 * Per http-transport.ts: the receiver parses `envelope.blockMerkleRoots`.
 */
async function handleGetSpec(
  _req: IncomingMessage,
  res: ServerResponse,
  local: Registry,
  specHashParam: string,
): Promise<void> {
  const roots = await local.selectBlocks(specHashParam as SpecHash);
  if (roots.length === 0) {
    sendError(res, 404, "spec_not_found");
    return;
  }
  sendJson(res, 200, {
    specHash: specHashParam,
    blockMerkleRoots: roots,
  });
}

/**
 * GET /v1/block/<merkleRoot>
 *
 * Returns the WireBlockTriplet for the given merkle root (via serializeWireBlockTriplet),
 * or 404 with { error: "block_not_found" } if the block is not in the registry.
 *
 * Per DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: serializeWireBlockTriplet encodes
 * all artifact bytes into the wire shape. The receiver validates via
 * deserializeWireBlockTriplet before trusting the row.
 */
async function handleGetBlock(
  _req: IncomingMessage,
  res: ServerResponse,
  local: Registry,
  merkleRootParam: string,
): Promise<void> {
  const row = await local.getBlock(merkleRootParam as BlockMerkleRoot);
  if (row === null) {
    sendError(res, 404, "block_not_found");
    return;
  }
  sendJson(res, 200, serializeWireBlockTriplet(row));
}

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

/**
 * Parse the incoming request and route it to the appropriate handler.
 *
 * All non-GET methods return 405 with the §3 error envelope.
 * Unknown GET paths return 404 with { error: "not_found" }.
 */
async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  local: Registry,
  opts: ServeOptions,
): Promise<void> {
  // All non-GET methods return 405 (DEC-V1-WAVE-1-SCOPE-001: read-only).
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    sendError(res, 405, "method_not_allowed");
    return;
  }

  // Parse path — strip query string.
  const rawPath = (req.url ?? "/").split("?")[0] ?? "/";

  // Route: GET /schema-version
  if (rawPath === "/schema-version") {
    handleSchemaVersion(req, res);
    return;
  }

  // Route: GET /v1/specs
  if (rawPath === "/v1/specs") {
    await handleListSpecs(req, res, opts);
    return;
  }

  // Route: GET /v1/spec/<specHash>
  const specMatch = /^\/v1\/spec\/([^/]+)$/.exec(rawPath);
  if (specMatch !== null) {
    const specHashParam = specMatch[1];
    if (specHashParam !== undefined && specHashParam.length > 0) {
      await handleGetSpec(req, res, local, specHashParam);
      return;
    }
  }

  // Route: GET /v1/block/<merkleRoot>
  const blockMatch = /^\/v1\/block\/([^/]+)$/.exec(rawPath);
  if (blockMatch !== null) {
    const merkleRootParam = blockMatch[1];
    if (merkleRootParam !== undefined && merkleRootParam.length > 0) {
      await handleGetBlock(req, res, local, merkleRootParam);
      return;
    }
  }

  // Unknown path → 404 not_found.
  sendError(res, 404, "not_found");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Result of serveRegistry. Carries the resolved URL and a clean-shutdown function.
 */
export interface ServeHandle {
  /** The underlying node:http Server instance. */
  readonly server: Server;
  /**
   * The URL the server is listening on, e.g. "http://127.0.0.1:54321".
   * When opts.port was 0, this reflects the OS-assigned port.
   */
  readonly url: string;
  /** Shut down the HTTP server gracefully. Resolves once the server is fully closed. */
  readonly close: () => Promise<void>;
}

/**
 * Start a read-only HTTP server exposing `registry` as a federation peer.
 *
 * Implements the Slice-E GET endpoints of FEDERATION_PROTOCOL.md §3:
 *   GET /schema-version                  → { schemaVersion: number }
 *   GET /v1/specs                        → { specHashes: SpecHash[] }
 *   GET /v1/spec/<specHash>              → { specHash, blockMerkleRoots } | 404
 *   GET /v1/block/<merkleRoot>           → WireBlockTriplet | 404
 *
 * /v1/manifest and /v1/blocks are intentionally deferred to Slice F.
 *
 * All non-GET methods return 405 { error: "method_not_allowed" }.
 * Unknown GET paths return 404 { error: "not_found" }.
 *
 * When opts.port === 0 (the default), the OS picks an available port and the
 * resolved URL is returned in ServeHandle.url.
 *
 * Per DEC-V1-WAVE-1-SCOPE-001: READ-ONLY. No mutation endpoint.
 * Per DEC-SERVE-SPECS-ENUMERATION-020: supply opts.enumerateSpecs for /v1/specs to
 * return real data (otherwise returns empty array).
 *
 * @param registry - The local Registry to serve blocks from.
 * @param options  - Bind address, port, and optional spec enumeration callback.
 * @returns A ServeHandle with the resolved URL and a close() function.
 */
export async function serveRegistry(
  registry: Registry,
  options?: ServeOptions,
): Promise<ServeHandle> {
  const port = options?.port ?? 0;
  const host = options?.host ?? "127.0.0.1";
  const opts: ServeOptions = options ?? {};

  const server = http.createServer((req, res) => {
    dispatch(req, res, registry, opts).catch((err: unknown) => {
      // Last-resort error handler: respond 500 and log, so the server doesn't crash
      // on an unhandled async rejection from a request handler.
      if (!res.headersSent) {
        sendError(res, 500, "internal_error");
      } else {
        res.end();
      }
      console.error("[serveRegistry] Unhandled request error:", err);
    });
  });

  // Wait for the server to bind and resolve the actual port.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("serveRegistry: unexpected server address type");
  }

  const resolvedUrl = `http://${host}:${address.port}`;

  let closed = false;

  return {
    server,
    url: resolvedUrl,
    close(): Promise<void> {
      // Idempotent: a second call to close() is a no-op.
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err !== undefined) {
            // "Server is not running" — already stopped — treat as success.
            if ((err as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
              resolve();
            } else {
              reject(err);
            }
          } else {
            resolve();
          }
        });
      });
    },
  };
}
