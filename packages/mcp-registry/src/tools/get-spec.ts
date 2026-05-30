/**
 * Tool: yakcc_get_spec
 * Fetch a single spec record by its hash.
 *
 * @decision DEC-MCP-TOOL-GET-SPEC-015
 * @title yakcc_get_spec — spec detail fetch via GET /v1/spec/<hash>
 * @status decided (wi-944, bite 2)
 * @rationale
 *   Thin adapter from MCP args to the registry spec detail endpoint.
 *   Uses parseSpecHash for input validation (DEC-MCP-SCHEMA-PARSERS-010).
 *   Returns the server's response body as-is (DEC-MCP-PASSTHROUGH-WIRE-003).
 *   DEC-MCP-ERROR-AS-CONTENT-004 applies for all error paths.
 *
 * HTTP: GET /v1/spec/<hash>
 * Implements: yakcc#944
 */

import { HttpError } from "../http-client.js";
import type { HttpClient } from "../http-client.js";
import { parseSpecHash } from "../schema.js";
import type { MCPContent, ToolModule } from "./types.js";

export const getSpec: ToolModule = {
  name: "yakcc_get_spec",
  description:
    "Fetch a single spec record by its 64-character BLAKE3 hex hash from the yakcc registry.",
  inputSchema: {
    type: "object",
    properties: {
      specHash: {
        type: "string",
        description: "64-character lowercase hex BLAKE3 hash of the spec.",
        pattern: "^[a-f0-9]{64}$",
      },
    },
    required: ["specHash"],
    additionalProperties: false,
  },

  async handler(args: unknown, http: HttpClient): Promise<MCPContent[]> {
    const obj =
      args !== null && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    const parsed = parseSpecHash(obj.specHash);
    if (!parsed.ok) {
      return [
        {
          type: "text",
          text: JSON.stringify({ error: parsed.code, message: parsed.message }),
        },
      ];
    }

    try {
      const result = await http.get<unknown>(`v1/spec/${parsed.value}`);
      return [{ type: "text", text: JSON.stringify(result) }];
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 404) {
          return [
            {
              type: "text",
              text: JSON.stringify({
                error: "not_found",
                message: `Spec ${parsed.value} not found`,
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
