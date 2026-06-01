/**
 * Integration test: stdio MCP server end-to-end.
 *
 * @decision DEC-MCP-INTEGRATION-TEST-021
 * @title End-to-end integration test via SDK Client + StdioClientTransport
 * @status decided (wi-944, bite 3)
 * @rationale
 *   The unit tests (tool/*.test.ts, http-client.test.ts, schema.test.ts) cover
 *   individual components with injected mocks. This suite proves the REAL production
 *   sequence: LLM host spawns `node dist/index.js`, writes MCP requests to stdin,
 *   reads MCP responses from stdout. A local node:http server stands in for
 *   registry.yakcc.com so no network is needed.
 *
 *   Real production sequence exercised:
 *   1. Spawn compiled dist/index.js as a child process
 *   2. MCP SDK Client connects over stdio transport
 *   3. Client issues tools/list → server iterates TOOLS[] and responds
 *   4. Client issues tools/call → server finds tool, calls handler, handler
 *      makes HTTP request to mock registry, handler returns content
 *   5. Client reads response; test asserts shape
 *
 *   The W-141 invariant (bare WireBlockTriplet POST body) is enforced by
 *   asserting the captured request body does NOT contain a wrapper key.
 *
 * Compound-Interaction Test Requirement (CLAUDE.md):
 *   These tests cross: compiled binary entry → MCP Server class → tool handler →
 *   HttpClient → mock registry HTTP server → back up the chain.
 *
 * Implements: yakcc#944
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIST = join(__dirname, "..", "..", "dist", "index.js");

// ---------------------------------------------------------------------------
// Minimal inline HTTP mock for registry.yakcc.com
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  path: string;
  body: string;
}

interface MockServer {
  port: number;
  baseUrl: string;
  getRequests: () => CapturedRequest[];
  clearRequests: () => void;
  setNextResponse: (body: unknown, status?: number) => void;
  close: () => Promise<void>;
}

function createMockRegistryServer(): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    const captured: CapturedRequest[] = [];
    let nextBody: string = JSON.stringify({});
    let nextStatus: number = 200;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on("end", () => {
        captured.push({
          method: req.method ?? "UNKNOWN",
          path: req.url ?? "/",
          body: raw,
        });
        res.writeHead(nextStatus, { "Content-Type": "application/json" });
        res.end(nextBody);
      });
    });

    server.on("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Could not determine mock server port"));
        return;
      }
      const port = addr.port;
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        getRequests: () => [...captured],
        clearRequests: () => {
          captured.length = 0;
        },
        setNextResponse: (body, status = 200) => {
          nextBody = JSON.stringify(body);
          nextStatus = status;
        },
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => {
              if (err) rej(err);
              else res();
            });
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("stdio MCP server integration", () => {
  let mock: MockServer;
  let client: Client;
  let transport: StdioClientTransport;

  beforeEach(async () => {
    mock = await createMockRegistryServer();

    transport = new StdioClientTransport({
      command: "node",
      args: [SERVER_DIST],
      env: {
        ...process.env,
        YAKCC_REGISTRY_URL: mock.baseUrl,
      },
      stderr: "pipe",
    });

    client = new Client(
      { name: "test-client", version: "0.0.0" },
      { capabilities: {} },
    );

    await client.connect(transport);
  });

  afterEach(async () => {
    try {
      await client.close();
    } catch {
      // best-effort
    }
    await mock.close();
  });

  // -------------------------------------------------------------------------
  // tools/list
  // -------------------------------------------------------------------------

  it("tools/list returns exactly 11 tool definitions including yakcc_resolve, yakcc_compile, and yakcc_reference (wi-953, wi-1007, wi-1047)", async () => {
    const result = await client.listTools();
    expect(result.tools).toHaveLength(11);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("yakcc_search_atoms");
    // Spot-check the full expected set
    const expected = [
      "yakcc_resolve",
      "yakcc_compile",
      "yakcc_reference",
      "yakcc_search_atoms",
      "yakcc_get_atom",
      "yakcc_list_specs",
      "yakcc_get_spec",
      "yakcc_submit_atom",
      "yakcc_request_shave",
      "yakcc_get_shave_status",
      "yakcc_get_provenance",
    ];
    for (const name of expected) {
      expect(names, `expected tool ${name} to be registered`).toContain(name);
    }
  });

  it("each tool definition has name, description, and inputSchema with type=object", async () => {
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(typeof tool.name, `${tool.name}.name`).toBe("string");
      expect(typeof tool.description, `${tool.name}.description`).toBe("string");
      expect(tool.inputSchema.type, `${tool.name}.inputSchema.type`).toBe("object");
    }
  });

  // -------------------------------------------------------------------------
  // tools/call — yakcc_search_atoms forwards to mock GET /v1/blocks
  // -------------------------------------------------------------------------

  it("tools/call yakcc_search_atoms forwards to mock GET /v1/blocks", async () => {
    // The registry returns { roots: string[], nextCursor?: string } (not "blocks").
    // searchAtoms maps roots → roots in its MCP response.
    mock.setNextResponse({
      roots: ["deadbeef", "cafebabe"],
      nextCursor: null,
    });

    const result = await client.callTool({
      name: "yakcc_search_atoms",
      arguments: { limit: 5 },
    });

    expect(result.isError).toBeFalsy();

    // Verify the mock registry received a GET to /v1/blocks
    const reqs = mock.getRequests();
    expect(reqs.length).toBeGreaterThan(0);
    const searchReq = reqs.find((r) => r.path.startsWith("/v1/blocks"));
    expect(searchReq, "expected a GET /v1/blocks request").toBeDefined();
    expect(searchReq?.method).toBe("GET");

    // Verify the response content is valid JSON with the roots array
    const contentItem = (result.content as Array<{ type: string; text: string }>)[0];
    expect(contentItem?.type).toBe("text");
    const parsed: unknown = JSON.parse(contentItem?.text ?? "{}");
    expect(parsed).toMatchObject({ roots: expect.any(Array), nextCursor: null });
  });

  // -------------------------------------------------------------------------
  // tools/call — yakcc_submit_atom POSTs bare WireBlockTriplet (W-141)
  // -------------------------------------------------------------------------

  it("tools/call yakcc_submit_atom POSTs bare WireBlockTriplet without envelope (W-141)", async () => {
    mock.setNextResponse({ accepted: true, hash: "deadbeef", deduped: false });

    const wireBlock = {
      specHash: "aabbcc",
      specCanonicalBytes: "dGVzdA==",
      blockMerkleRoot: "112233",
      implSource: "test-impl",
    };

    const result = await client.callTool({
      name: "yakcc_submit_atom",
      arguments: { block: wireBlock },
    });

    expect(result.isError).toBeFalsy();

    // Verify the mock received a POST to /v1/blocks/submit
    const reqs = mock.getRequests();
    const submitReq = reqs.find((r) => r.path === "/v1/blocks/submit");
    expect(submitReq, "expected POST /v1/blocks/submit").toBeDefined();
    expect(submitReq?.method).toBe("POST");

    // W-141 invariant: the POST body must be a bare WireBlockTriplet.
    // It must NOT be wrapped in { schemaVersion: 1, block: ... } or any envelope.
    const posted: unknown = JSON.parse(submitReq?.body ?? "{}");
    expect(posted).toMatchObject(wireBlock);
    // Explicitly assert no envelope keys exist
    expect(posted).not.toHaveProperty("schemaVersion");
    expect(posted).not.toHaveProperty("block");

    // Verify the MCP response content
    const contentItem = (result.content as Array<{ type: string; text: string }>)[0];
    const responseData: unknown = JSON.parse(contentItem?.text ?? "{}");
    expect(responseData).toMatchObject({ accepted: true, hash: "deadbeef", deduped: false });
  });

  // -------------------------------------------------------------------------
  // unknown tool returns isError=true, not a throw
  // -------------------------------------------------------------------------

  it("tools/call for an unknown tool name returns isError=true content", async () => {
    const result = await client.callTool({ name: "yakcc_nonexistent_tool", arguments: {} });
    expect(result.isError).toBe(true);
    const contentItem = (result.content as Array<{ type: string; text: string }>)[0];
    expect(contentItem?.type).toBe("text");
    expect(contentItem?.text).toMatch(/unknown tool/);
  });

  // -------------------------------------------------------------------------
  // DEC-MCP-STDERR-LOGGING-005: no non-MCP bytes on stdout
  // This is enforced implicitly by the SDK Client — if garbage bytes appeared
  // on stdout the Client.connect() or callTool() would throw a parse error.
  // We assert it explicitly by verifying the server started and handled calls
  // without any JSON-RPC framing errors.
  // -------------------------------------------------------------------------

  it("DEC-MCP-STDERR-LOGGING-005: server communication succeeds without stdout corruption", async () => {
    // If any non-MCP bytes appeared on stdout the SDK would have thrown during
    // connect() or listTools() above. This test just verifies we can complete
    // a full round-trip without errors, which is only possible if stdout is clean.
    mock.setNextResponse({ blocks: [], nextCursor: null });
    const result = await client.listTools();
    expect(result.tools).toHaveLength(11);
    // Also do a tool call to confirm wire integrity for request/response cycle
    const callResult = await client.callTool({
      name: "yakcc_search_atoms",
      arguments: { query: "probe" },
    });
    expect(callResult.isError).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// tools/call yakcc_resolve — full round-trip through the global cascade (WI-953)
//
// @decision DEC-953B-RESOLVE-ROUNDTRIP-001
// @title yakcc_resolve integration test exercises the global cascade end-to-end
// @status decided (wi-953-b)
// @rationale
//   The compound-interaction requirement (CLAUDE.md) mandates a test that crosses
//   multiple component boundaries in the real production sequence. For yakcc_resolve
//   the production sequence is:
//     LLM host → compiled dist/index.js (stdio MCP) → resolve handler
//     → local SQLite registry (empty temp db, no candidates)
//     → global cascade: GET /v1/blocks via HttpClient → mock registry server
//     → merged response envelope with source="local+global" → LLM host
//
//   A separate describe/beforeEach is required because the server must be spawned
//   with YAKCC_REGISTRY_PATH pointing to a valid directory so better-sqlite3 can
//   create an empty registry file (no parent-dir creation needed in /tmp). The
//   empty local registry returns zero candidates, which falls through to the global
//   cascade, which hits the mock GET /v1/blocks route — proving the full cascade.
//
//   Asserted properties of the resolve envelope (D4 ADR Q5 hybrid mode):
//     confidence_tier: "candidate_list" | "no_candidates" (no auto_accept from empty local)
//     source: "local+global" (global cascade was exercised)
//     candidates: array containing at least the global root from the mock response
//     airgapped: false
// ---------------------------------------------------------------------------

describe("tools/call yakcc_resolve — global cascade round-trip (wi-953)", () => {
  let mock: MockServer;
  let client: Client;
  let transport: StdioClientTransport;
  let tmpRegistryDir: string;

  beforeEach(async () => {
    mock = await createMockRegistryServer();

    // Create a temp directory where better-sqlite3 can create the registry file.
    // The file itself is created by openRegistry on first call from the server binary.
    tmpRegistryDir = mkdtempSync(join(tmpdir(), "yakcc-resolve-test-"));
    const registryPath = join(tmpRegistryDir, "registry.sqlite");

    transport = new StdioClientTransport({
      command: "node",
      args: [SERVER_DIST],
      env: {
        ...process.env,
        YAKCC_REGISTRY_URL: mock.baseUrl,
        // Point to a path in an existing dir; openRegistry creates the file.
        YAKCC_REGISTRY_PATH: registryPath,
        // Ensure global cascade is NOT suppressed.
        YAKCC_AIRGAPPED: "",
      },
      stderr: "pipe",
    });

    client = new Client(
      { name: "test-client-resolve", version: "0.0.0" },
      { capabilities: {} },
    );

    await client.connect(transport);
  });

  afterEach(async () => {
    try {
      await client.close();
    } catch {
      // best-effort
    }
    await mock.close();
    try {
      rmSync(tmpRegistryDir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  });

  it("yakcc_resolve global cascade: empty local registry falls through to GET /v1/blocks and returns resolve envelope", async () => {
    // The mock registry returns two global roots.
    // The local SQLite is fresh/empty → 0 local candidates → no auto_accept.
    // The handler falls through to the global cascade: GET /v1/blocks?limit=N.
    // The resolve envelope must carry: confidence_tier, source, candidates, airgapped.
    mock.setNextResponse({
      roots: [
        "deadbeef112233445566778899aabbccddeeff00deadbeef112233445566778899",
        "cafebabe112233445566778899aabbccddeeff00cafebabe112233445566778899",
      ],
      nextCursor: null,
    });

    const result = await client.callTool({
      name: "yakcc_resolve",
      arguments: {
        intent: { title: "find matching blocks for integration test" },
        limit: 5,
      },
    });

    // The handler MUST NOT return isError=true for a normal cascade call.
    expect(result.isError).toBeFalsy();

    // Parse the text content — the resolve tool always returns a single text item.
    const contentItem = (result.content as Array<{ type: string; text: string }>)[0];
    expect(contentItem?.type).toBe("text");

    const envelope = JSON.parse(contentItem?.text ?? "{}") as {
      confidence_tier: string;
      source: string;
      candidates: Array<{ atom_id: string; score: number; source: string }>;
      airgapped: boolean;
    };

    // D4 ADR Q5: empty local → no auto_accept; global candidates present → candidate_list.
    // If the global call somehow returns 0 roots (degenerate), tier is no_candidates.
    expect(["candidate_list", "no_candidates"]).toContain(envelope.confidence_tier);

    // Global cascade was exercised — source must reflect that.
    expect(envelope.source).toBe("local+global");

    // airgapped must be false (we did not set YAKCC_AIRGAPPED=1).
    expect(envelope.airgapped).toBe(false);

    // candidates is always present (may be empty only if mock returned empty roots).
    expect(Array.isArray(envelope.candidates)).toBe(true);

    // The mock returned two roots — both should appear as global candidates.
    const globalCandidates = envelope.candidates.filter((c) => c.source === "global");
    expect(globalCandidates.length).toBe(2);

    // Each global candidate has the atom_id = the full root hash (not sliced).
    expect(globalCandidates[0]?.atom_id).toBe(
      "deadbeef112233445566778899aabbccddeeff00deadbeef112233445566778899",
    );
    expect(globalCandidates[1]?.atom_id).toBe(
      "cafebabe112233445566778899aabbccddeeff00cafebabe112233445566778899",
    );
    // Global candidates carry score=0 (no local semantic score in v1 catalog walk).
    expect(globalCandidates[0]?.score).toBe(0);

    // The global cascade hit GET /v1/blocks — confirm the mock saw the request.
    const reqs = mock.getRequests();
    const globalReq = reqs.find((r) => r.path.startsWith("/v1/blocks") && r.method === "GET");
    expect(globalReq, "global cascade must hit GET /v1/blocks").toBeDefined();
  });

  it("yakcc_resolve returns a well-formed D4 envelope when YAKCC_AIRGAPPED=1 suppresses global cascade", async () => {
    // Re-create transport with YAKCC_AIRGAPPED=1.
    // The existing client uses the non-airgapped transport, so we create a fresh pair.
    await client.close();
    await mock.close();

    mock = await createMockRegistryServer();
    const registryPath = join(tmpRegistryDir, "registry-airgap.sqlite");

    const airgapTransport = new StdioClientTransport({
      command: "node",
      args: [SERVER_DIST],
      env: {
        ...process.env,
        YAKCC_REGISTRY_URL: mock.baseUrl,
        YAKCC_REGISTRY_PATH: registryPath,
        YAKCC_AIRGAPPED: "1",
      },
      stderr: "pipe",
    });

    const airgapClient = new Client(
      { name: "test-client-airgap", version: "0.0.0" },
      { capabilities: {} },
    );
    await airgapClient.connect(airgapTransport);

    try {
      const result = await airgapClient.callTool({
        name: "yakcc_resolve",
        arguments: { intent: { title: "airgapped resolve test" } },
      });

      expect(result.isError).toBeFalsy();
      const contentItem = (result.content as Array<{ type: string; text: string }>)[0];
      const envelope = JSON.parse(contentItem?.text ?? "{}") as {
        confidence_tier: string;
        source: string;
        airgapped: boolean;
      };

      // Airgapped → local_only source (no global cascade).
      expect(envelope.source).toBe("local_only");
      expect(envelope.airgapped).toBe(true);
      expect(["candidate_list", "no_candidates"]).toContain(envelope.confidence_tier);

      // The mock must NOT have received any /v1/blocks request (global was skipped).
      const reqs = mock.getRequests();
      const globalReq = reqs.find((r) => r.path.startsWith("/v1/blocks"));
      expect(globalReq, "airgapped: global cascade must NOT fire").toBeUndefined();
    } finally {
      try {
        await airgapClient.close();
      } catch {
        // best-effort
      }
    }
  });
});
