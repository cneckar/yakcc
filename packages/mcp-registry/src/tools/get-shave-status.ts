/**
 * Tool: yakcc_get_shave_status
 * Retrieve the status of a shave request by its UUID.
 *
 * @decision DEC-MCP-TOOL-GET-SHAVE-STATUS-018
 * @title yakcc_get_shave_status — shave request poll via GET /v1/shave-requests/<id>
 * @status decided (wi-944, bite 2)
 * @rationale
 *   Accepts a UUID shave request ID and returns the full status record from
 *   the registry. The response includes status, atomHashes, blockMerkleRoots,
 *   and optionally an error field. Returned as-is per DEC-MCP-PASSTHROUGH-WIRE-003.
 *   DEC-MCP-ERROR-AS-CONTENT-004 applies for all error paths.
 *
 * HTTP: GET /v1/shave-requests/<id>
 * Implements: yakcc#944
 */

import { HttpError } from "../http-client.js";
import type { HttpClient } from "../http-client.js";
import type { MCPContent, ToolModule } from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseId(input: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof input !== "string") {
    return { ok: false, message: "id must be a string (UUID)" };
  }
  if (!UUID_RE.test(input)) {
    return { ok: false, message: "id must be a valid UUID" };
  }
  return { ok: true, value: input };
}

export const getShaveStatus: ToolModule = {
  name: "yakcc_get_shave_status",
  description:
    "Retrieve the current status of a shave request by its UUID. Returns status, atomHashes, blockMerkleRoots, and any error.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "UUID of the shave request (returned by yakcc_request_shave).",
        format: "uuid",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },

  async handler(args: unknown, http: HttpClient): Promise<MCPContent[]> {
    const obj =
      args !== null && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    const parsed = parseId(obj.id);
    if (!parsed.ok) {
      return [
        {
          type: "text",
          text: JSON.stringify({ error: "invalid_input", message: parsed.message }),
        },
      ];
    }

    try {
      const result = await http.get<unknown>(`v1/shave-requests/${parsed.value}`);
      return [{ type: "text", text: JSON.stringify(result) }];
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 404) {
          return [
            {
              type: "text",
              text: JSON.stringify({
                error: "not_found",
                message: `Shave request ${parsed.value} not found`,
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
