#!/usr/bin/env node
/**
 * @yakcc/mcp-registry — stdio MCP server entry point.
 *
 * @decision DEC-MCP-STDIO-TRANSPORT-002
 * @title Use StdioServerTransport as the sole transport for the MCP server
 * @status decided (wi-944, bite 3)
 * @rationale
 *   The MCP server is invoked by LLM hosts (Claude Desktop, Cline, etc.) as a
 *   child process. Stdio is the canonical transport for that deployment model.
 *   No HTTP server, no port binding — this is a pure stdio subprocess.
 *
 * @decision DEC-MCP-BIN-ENTRY-007
 * @title Package entry point doubles as the CLI binary (yakcc-mcp-registry)
 * @status decided (wi-944, bite 3)
 * @rationale
 *   The shebang + package.json#bin wiring means `npx @yakcc/mcp-registry` works
 *   out of the box. The binary and the ESM module export are the same file because
 *   the package has exactly one public surface: "boot an MCP server".
 *   Sacred Practice #12: one authority per operational fact.
 *
 * @decision DEC-MCP-STDERR-LOGGING-005
 * @title All diagnostic output goes to stderr; stdout is reserved for MCP wire
 * @status decided (wi-944, bite 1)
 * @rationale
 *   The MCP stdio transport uses stdout as its wire. Any non-MCP bytes on stdout
 *   will corrupt the JSON-RPC framing. All process.stderr.write() calls here are
 *   intentional. Never use console.log() in this file or in tool handlers.
 *
 * Implements: yakcc#944
 * Tracks: yakforge#49
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createHttpClient } from "./http-client.js";
import { TOOLS } from "./tools/index.js";

async function main(): Promise<void> {
  // exactOptionalPropertyTypes: omit baseUrl when env var is unset so
  // createHttpClient sees an absent key (not `undefined`) and falls back to
  // DEFAULT_REGISTRY_URL. DEC-MCP-FETCH-ONE-CLIENT-006.
  const httpOpts: { baseUrl?: string; timeoutMs: number } = { timeoutMs: 30_000 };
  const envUrl = process.env.YAKCC_REGISTRY_URL;
  if (envUrl !== undefined) {
    httpOpts.baseUrl = envUrl;
  }
  const http = createHttpClient(httpOpts);

  const server = new Server(
    { name: "@yakcc/mcp-registry", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const content = await tool.handler(req.params.arguments ?? {}, http);
      return { content };
    } catch (err) {
      // Tool handlers must not throw — they map errors to content per
      // DEC-MCP-ERROR-AS-CONTENT-004. This catch is a fail-safe for unexpected
      // bugs in tool implementations.
      const msg = err instanceof Error ? err.message : String(err);
      // stderr ONLY — DEC-MCP-STDERR-LOGGING-005
      process.stderr.write(`[mcp-registry] tool ${req.params.name} threw: ${msg}\n`);
      return {
        content: [{ type: "text", text: `internal_error: ${msg}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr ONLY — DEC-MCP-STDERR-LOGGING-005
  process.stderr.write("[mcp-registry] ready\n");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[mcp-registry] fatal: ${msg}\n`);
  process.exit(1);
});

// Re-export public API surface for library consumers (importers, not binary runners).
export { createHttpClient, DEFAULT_REGISTRY_URL, HttpClient, HttpError } from "./http-client.js";
export type { HttpClientOpts } from "./http-client.js";
