/**
 * Tool: yakcc_get_atom
 * Fetch a single block by its BLAKE3 merkle root.
 *
 * @decision DEC-MCP-TOOL-GET-ATOM-013
 * @title yakcc_get_atom — fetch WireBlockTriplet via GET /v1/block/<root>
 * @status decided (wi-944, bite 2)
 * @rationale
 *   Returns the raw WireBlockTriplet JSON as-is (DEC-MCP-PASSTHROUGH-WIRE-003:
 *   tool layer must not re-shape wire objects — the consumer owns deserialization).
 *   404 is a first-class case: returns { error: "not_found" } content rather
 *   than propagating HttpError. All other HttpErrors surface as structured content
 *   per DEC-MCP-ERROR-AS-CONTENT-004.
 *
 * HTTP: GET /v1/block/<root>
 * Implements: yakcc#944
 */

import { HttpError } from "../http-client.js";
import type { HttpClient } from "../http-client.js";
import { parseBlockMerkleRoot } from "../schema.js";
import type { MCPContent, ToolModule } from "./types.js";

export const getAtom: ToolModule = {
  name: "yakcc_get_atom",
  description:
    "Fetch a single atom block by its 64-character BLAKE3 hex merkle root. Returns the raw WireBlockTriplet JSON.",
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
      const result = await http.get<unknown>(`v1/block/${parsed.value}`);
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
