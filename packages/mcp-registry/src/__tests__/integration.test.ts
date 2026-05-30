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

  it("tools/list returns exactly 9 tool definitions including yakcc_resolve (wi-953)", async () => {
    const result = await client.listTools();
    expect(result.tools).toHaveLength(9);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("yakcc_search_atoms");
    // Spot-check the full expected set
    const expected = [
      "yakcc_resolve",
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
    expect(result.tools).toHaveLength(9);
    // Also do a tool call to confirm wire integrity for request/response cycle
    const callResult = await client.callTool({
      name: "yakcc_search_atoms",
      arguments: { query: "probe" },
    });
    expect(callResult.isError).toBeFalsy();
  });
});
