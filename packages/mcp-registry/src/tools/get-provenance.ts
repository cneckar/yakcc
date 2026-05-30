/**
 * Tool: yakcc_get_provenance
 * Fetch the provenance sources for a block by its BLAKE3 merkle root.
 *
 * @decision DEC-MCP-TOOL-GET-PROVENANCE-019
 * @title yakcc_get_provenance — provenance fetch via GET /v1/blocks/<root>/sources
 * @status decided (wi-944, bite 2)
 * @rationale
 *   Returns the { root, sources: [...] } provenance record from yakforge W-139.
 *   Uses parseBlockMerkleRoot for input validation (DEC-MCP-SCHEMA-PARSERS-010).
 *   Response is returned as-is per DEC-MCP-PASSTHROUGH-WIRE-003.
 *   DEC-MCP-ERROR-AS-CONTENT-004 applies for all error paths.
 *
 * HTTP: GET /v1/blocks/<root>/sources
 * Implements: yakcc#944
 */

import { HttpError } from "../http-client.js";
import type { HttpClient } from "../http-client.js";
import { parseBlockMerkleRoot } from "../schema.js";
import type { MCPContent, ToolModule } from "./types.js";

export const getProvenance: ToolModule = {
  name: "yakcc_get_provenance",
  description:
    "Fetch the provenance sources for a block identified by its 64-character BLAKE3 hex merkle root.",
  inputSchema: {
    type: "object",
    properties: {
      root: {
        type: "string",
        description: "64-character lowercase hex BLAKE3 merkle root of the block.",
        pattern: "^[a-f0-9]{64}$",
      },
    },
    required: ["root"],
    additionalProperties: false,
  },

  async handler(args: unknown, http: HttpClient): Promise<MCPContent[]> {
    const obj =
      args !== null && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    const parsed = parseBlockMerkleRoot(obj.root);
    if (!parsed.ok) {
      return [
        {
          type: "text",
          text: JSON.stringify({ error: parsed.code, message: parsed.message }),
        },
      ];
    }

    try {
      const result = await http.get<unknown>(`v1/blocks/${parsed.value}/sources`);
      return [{ type: "text", text: JSON.stringify(result) }];
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 404) {
          return [
            {
              type: "text",
              text: JSON.stringify({
                error: "not_found",
                message: `Block ${parsed.value} not found`,
              }),
            },
          ];
        }
        return [
          {
            type: "text",
            text: JSON.stringify({ error: err.code, message: err.message, status: err.status }),
          },
        ];
      }
      return [
        {
          type: "text",
          text: JSON.stringify({ error: "unexpected_error", message: String(err) }),
        },
      ];
    }
  },
};
