// SPDX-License-Identifier: MIT
// @decision DEC-SERVE-E-020: serveRegistry — read-only HTTP mirror server (Slice E).
// Status: decided (WI-020 Dispatch E, FEDERATION_PROTOCOL.md §3)
// Title: serve.ts — F1 read-only registry HTTP server (five GET endpoints)
// Rationale:
//   serveRegistry exposes a local Registry over HTTP following FEDERATION_PROTOCOL.md §3.
//   It is strictly GET-only (all non-GET methods → 405). The five endpoints are:
//     GET /schema-version       → { schemaVersion: number }
//     GET /v1/specs             → { specHashes: SpecHash[] }
//     GET /v1/spec/<specHash>   → { specHash, blockMerkleRoots: BlockMerkleRoot[] } | 404
//     GET /v1/block/<root>      → WireBlockTriplet via serializeWireBlockTriplet | 404
//     GET /v1/blocks            → { blocks: BlockMerkleRoot[], nextCursor: BlockMerkleRoot | null }
//   /v1/blocks shipped in WI-792 (DEC-792-MANIFEST-DEFERRED). Only /v1/manifest
//   remains deferred to Slice F-2.
//   No mutation endpoint exists — not even behind a flag (DEC-V1-WAVE-1-SCOPE-001).
//   port: 0 binds an OS-assigned port (useful for tests). close() shuts down cleanly.
//
// @decision DEC-SERVE-SPECS-ENUMERATION-020: enumerateSpecs via Registry interface (WI-026 closure).
// Status: superseded/closed (WI-026)
// Title: Spec enumeration via Registry.enumerateSpecs()
// Rationale:
//   WI-026 added Registry.enumerateSpecs() as a first-class method on the Registry interface.
//   The former optional callback (ServeOptions.enumerateSpecs) was a workaround because the
//   Registry interface had no enumerate-distinct-specs primitive. Post-WI-026, serveRegistry
//   calls registry.enumerateSpecs() directly. The callback field is removed from ServeOptions.
//   No dual-authority: the old callback path is gone (Sacred Practice #12).
//
// @decision DEC-NO-OWNERSHIP-011: No ownership fields anywhere.
// Status: decided (MASTER_PLAN.md DEC-NO-OWNERSHIP-011)
//
// @decision DEC-V1-WAVE-1-SCOPE-001: F1 read-only mirror only in v1 wave-1.
// Status: decided (MASTER_PLAN.md DEC-V1-WAVE-1-SCOPE-001)
//
// @decision DEC-792-MANIFEST-DEFERRED
// title: /v1/manifest stays deferred to Slice F-2; /v1/blocks shipped in WI-792
// status: accepted (WI-792)
// rationale: /v1/manifest requires computing rootsDigest (full table scan +
//   BLAKE3 over all roots) — separable surface with its own test requirements.
//   /v1/blocks is needed now by yakforge R2RegistryAdapter (cneckar/yakforge#28).
//   Split defers /v1/manifest without blocking /v1/blocks consumers.
//
// @decision DEC-792-LIMITS
// title: Default limit=256, max=1000, min=1; bad input → 400 bad_request
// status: accepted (WI-792)
// rationale: Default 256 is efficient for HTTP/2 multiplexed slots and friendly
//   for debug curl. Max 1000 matches FEDERATION_PROTOCOL.md §3 example as upper
//   sane bound. The server rejects outside [1,1000] with 400 — no silent clamp
//   at the HTTP layer (Registry layer clamps defensively for direct callers).

import * as http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";
import { SCHEMA_VERSION } from "@yakcc/registry";
import { deserializeWireBlockTriplet, serializeWireBlockTriplet } from "./wire.js";

// ---------------------------------------------------------------------------
// @decision DEC-COMMONS-SUBMIT-WRITE-ENDPOINT-001 (WI-794 slice 2)
// @title POST /v1/blocks/submit — anonymous unauthenticated write endpoint
// @status accepted (WI-794 slice 2)
// @rationale
//   DEC-COMMONS-NO-AUTH-001 mandates anonymous writes for the commons. This
//   route is the server-side half of the auto-submit flywheel: any client
//   that has captured a novel atom POSTs the JSON wire envelope here, and
//   the server inserts via storeBlock. storeBlock is idempotent on
//   BlockMerkleRoot, so re-submission is a no-op (returns 200 with
//   {accepted: true, novel: false}). All wire-format validation is delegated
//   to deserializeWireBlockTriplet, which throws structured TypeErrors on
//   malformed input — those surface as 400 bad_request to the caller.
//   This slice ships only the server route; the client-side fire-and-forget
//   push wiring at the storeBlock seam is slice 3 (WI-794).
// ---------------------------------------------------------------------------

/** Maximum bytes accepted in a POST /v1/blocks/submit request body. */
const SUBMIT_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MiB — generous; typical envelope is < 64 KiB

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
// Pagination constants for GET /v1/blocks (DEC-792-LIMITS)
// ---------------------------------------------------------------------------

/**
 * Default number of blocks per catalog page when the `?limit=` query param
 * is absent. 256 is efficient for HTTP/2 multiplexed slots and friendly for
 * debug `curl`. (DEC-792-LIMITS)
 */
const DEFAULT_CATALOG_LIMIT = 256;

/**
 * Maximum accepted `?limit=` value. Requests with limit > MAX_CATALOG_LIMIT
 * return 400 `bad_request`. Matches the FEDERATION_PROTOCOL.md §3 example
 * as the upper sane bound. (DEC-792-LIMITS)
 */
const MAX_CATALOG_LIMIT = 1000;

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
 * Calls registry.enumerateSpecs() directly (DEC-SERVE-SPECS-ENUMERATION-020, WI-026 closure).
 *
 * DEC-TRANSPORT-LIST-METHODS-020 (see types.ts): listSpecs maps to this endpoint.
 */
async function handleListSpecs(
  _req: IncomingMessage,
  res: ServerResponse,
  local: Registry,
): Promise<void> {
  const specHashes = await local.enumerateSpecs();
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

/**
 * GET /v1/blocks?limit=<N>&after=<cursor>
 *
 * Returns one page of the block catalog as `{ blocks: BlockMerkleRoot[],
 * nextCursor: BlockMerkleRoot | null }` — the CatalogPage wire shape from
 * FEDERATION_PROTOCOL.md §3 and `@yakcc/federation`'s `types.ts:71`.
 *
 * Query parameters:
 *   - `limit`: integer in [1, 1000]. Absent → DEFAULT_CATALOG_LIMIT (256).
 *     Present-but-invalid (non-integer, ≤ 0, > MAX_CATALOG_LIMIT) → 400.
 *   - `after`: exclusive lower-bound cursor (block_merkle_root value from the
 *     previous page's nextCursor). Absent or empty-string → null (start from
 *     beginning). Present → passed to Registry.listCatalogPage unchanged.
 *
 * The `nextCursor` field is ALWAYS present in the response (never omitted),
 * either as a BlockMerkleRoot string or as JSON `null`. This is load-bearing
 * for `fetchCatalogPage` in `http-transport.ts:176` which parses it directly.
 *
 * @decision DEC-792-METHOD-NAME: calls local.listCatalogPage(after, limit).
 * @decision DEC-792-AFTER-SEMANTICS: `after=` is a strict-GT cursor; empty/absent → null.
 * @decision DEC-792-LIMITS: validates limit before calling Registry layer.
 * @decision DEC-792-RETURN-TYPE-INLINE: returns the CatalogPage structural shape
 *   without importing `CatalogPage` from this package (avoids serve.ts having
 *   an intra-package named-type dependency that could become a maintenance hazard).
 */
async function handleListCatalogPage(
  req: IncomingMessage,
  res: ServerResponse,
  local: Registry,
): Promise<void> {
  // Re-parse the full URL to access query params. The dispatcher already
  // stripped the query string from rawPath for path routing, so we must
  // re-derive it from req.url here. "http://x" is a throwaway base — only
  // the searchParams are used.
  const searchParams = new URL(req.url ?? "/", "http://x").searchParams;

  // Parse `limit` — DEC-792-LIMITS.
  let limit: number;
  const limitRaw = searchParams.get("limit");
  if (limitRaw === null) {
    limit = DEFAULT_CATALOG_LIMIT;
  } else {
    // Must be a whole-number decimal integer, no leading zeros after a minus.
    const limitNum = Number(limitRaw);
    if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > MAX_CATALOG_LIMIT) {
      sendError(res, 400, "bad_request");
      return;
    }
    limit = limitNum;
  }

  // Parse `after` — DEC-792-AFTER-SEMANTICS.
  // Absent → null (start from beginning). Present-but-empty → 400 bad_request.
  let after: BlockMerkleRoot | null;
  const afterRaw = searchParams.get("after");
  if (afterRaw === null) {
    after = null;
  } else if (afterRaw.length === 0) {
    sendError(res, 400, "bad_request");
    return;
  } else {
    after = afterRaw as BlockMerkleRoot;
  }

  const page = await local.listCatalogPage(after, limit);

  // Explicitly construct the response object so `nextCursor` is always present
  // as `null` (not `undefined`) — JSON.stringify omits undefined properties,
  // which would break fetchCatalogPage's direct property read in http-transport.ts:176.
  sendJson(res, 200, {
    blocks: page.blocks,
    nextCursor: page.nextCursor,
  });
}

// ---------------------------------------------------------------------------
// POST /v1/blocks/submit — anonymous commons-push write endpoint
// (DEC-COMMONS-SUBMIT-WRITE-ENDPOINT-001 / WI-794 slice 2)
// ---------------------------------------------------------------------------

/**
 * Read the request body as a UTF-8 string, bounded by SUBMIT_MAX_BODY_BYTES.
 * Resolves to the body string on success, or rejects with an Error whose
 * .message names the failure mode ("body_too_large" | "read_error").
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > SUBMIT_MAX_BODY_BYTES) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (err) => {
      reject(new Error(`read_error: ${err.message}`));
    });
  });
}

/**
 * POST /v1/blocks/submit handler.
 *
 * Wire format: a WireBlockTriplet JSON body (the same shape returned by
 * GET /v1/block/<root>). On accept: storeBlock is called and 200 is returned.
 * Idempotency: storeBlock dedupes on BlockMerkleRoot, so re-submitting the
 * same atom is a server-side no-op — the response is still 200.
 *
 * Failure modes:
 *   - body > 5 MiB → 413 body_too_large
 *   - malformed JSON → 400 bad_request (with reason="malformed_json")
 *   - wire-format violation → 400 bad_request (with reason from deserializeWireBlockTriplet)
 *   - storeBlock unexpected throw → 500 internal_error
 */
async function handleSubmitBlock(
  req: IncomingMessage,
  res: ServerResponse,
  local: Registry,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "body_too_large") {
      sendError(res, 413, "body_too_large");
      return;
    }
    sendError(res, 400, "bad_request");
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "bad_request", reason: "malformed_json" });
    return;
  }

  let row: import("@yakcc/registry").BlockTripletRow;
  try {
    row = deserializeWireBlockTriplet(parsed);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    sendJson(res, 400, { error: "bad_request", reason });
    return;
  }

  try {
    await local.storeBlock(row);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: "internal_error", reason });
    return;
  }

  // 200 OK on accept (or no-op via BlockMerkleRoot dedupe). The wire response
  // is deliberately minimal — no per-atom metadata, no novelty flag — to
  // preserve the anonymous-by-construction property (DEC-COMMONS-NO-AUTH-001).
  sendJson(res, 200, { accepted: true });
}

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

/**
 * Parse the incoming request and route it to the appropriate handler.
 *
 * POST /v1/blocks/submit is the only write endpoint (WI-794 slice 2 /
 * DEC-COMMONS-SUBMIT-WRITE-ENDPOINT-001). All other paths are read-only;
 * non-GET methods on those paths return 405 with the §3 error envelope.
 * Unknown paths return 404 with { error: "not_found" }.
 */
async function dispatch(req: IncomingMessage, res: ServerResponse, local: Registry): Promise<void> {
  // Parse path — strip query string.
  const rawPath = (req.url ?? "/").split("?")[0] ?? "/";

  // POST /v1/blocks/submit is the sole write endpoint
  // (DEC-COMMONS-SUBMIT-WRITE-ENDPOINT-001 / WI-794 slice 2).
  // All other paths are read-only (DEC-V1-WAVE-1-SCOPE-001) — non-GET → 405.
  if (rawPath === "/v1/blocks/submit") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendError(res, 405, "method_not_allowed");
      return;
    }
    await handleSubmitBlock(req, res, local);
    return;
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    sendError(res, 405, "method_not_allowed");
    return;
  }

  // Route: GET /schema-version
  if (rawPath === "/schema-version") {
    handleSchemaVersion(req, res);
    return;
  }

  // Route: GET /v1/specs
  if (rawPath === "/v1/specs") {
    await handleListSpecs(req, res, local);
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

  // Route: GET /v1/blocks?limit=<N>&after=<cursor>  (WI-792, DEC-792-METHOD-NAME)
  if (rawPath === "/v1/blocks") {
    await handleListCatalogPage(req, res, local);
    return;
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
 * Implements the GET endpoints of FEDERATION_PROTOCOL.md §3:
 *   GET /schema-version                  → { schemaVersion: number }
 *   GET /v1/specs                        → { specHashes: SpecHash[] }
 *   GET /v1/spec/<specHash>              → { specHash, blockMerkleRoots } | 404
 *   GET /v1/block/<merkleRoot>           → WireBlockTriplet | 404
 *   GET /v1/blocks[?limit=N][&after=<cursor>]
 *                                        → { blocks: BlockMerkleRoot[], nextCursor: BlockMerkleRoot | null }
 *
 * /v1/blocks shipped in WI-792 (DEC-792-MANIFEST-DEFERRED). Only /v1/manifest
 * remains deferred to Slice F-2 (rootsDigest computation is a separate surface).
 *
 * All non-GET methods return 405 { error: "method_not_allowed" }.
 * Unknown GET paths return 404 { error: "not_found" }.
 *
 * When opts.port === 0 (the default), the OS picks an available port and the
 * resolved URL is returned in ServeHandle.url.
 *
 * Per DEC-V1-WAVE-1-SCOPE-001: READ-ONLY. No mutation endpoint.
 * Per DEC-SERVE-SPECS-ENUMERATION-020 (WI-026 closure): GET /v1/specs calls
 * registry.enumerateSpecs() directly — no callback needed in options.
 * Per DEC-792-METHOD-NAME: GET /v1/blocks calls registry.listCatalogPage() directly.
 *
 * @param registry - The local Registry to serve blocks from.
 * @param options  - Bind address and port.
 * @returns A ServeHandle with the resolved URL and a close() function.
 */
export async function serveRegistry(
  registry: Registry,
  options?: ServeOptions,
): Promise<ServeHandle> {
  const port = options?.port ?? 0;
  const host = options?.host ?? "127.0.0.1";

  const server = http.createServer((req, res) => {
    dispatch(req, res, registry).catch((err: unknown) => {
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
