/**
 * Tool: yakcc_request_shave
 * Request a shave operation for a package coordinate.
 *
 * @decision DEC-MCP-TOOL-REQUEST-SHAVE-017
 * @title yakcc_request_shave — shave request submission via POST /v1/shave-requests
 * @status decided (wi-944, bite 2)
 * @rationale
 *   Accepts a ShaveRequestCoord discriminated by source (pypi/npm/github) and
 *   posts it to the registry. 201 and 200 (deduped) both map to success content.
 *   400 codes unsupported_source and bad_coordinate are surfaced verbatim.
 *   429 codes coord_in_failure_cooldown and ip_rate_limited surface with
 *   retryAfter extracted from the response body when present.
 *   DEC-MCP-ERROR-AS-CONTENT-004 applies for all paths.
 *
 * HTTP: POST /v1/shave-requests
 * Implements: yakcc#944
 */

import { HttpError } from "../http-client.js";
import type { HttpClient } from "../http-client.js";
import { parseShaveRequestCoord } from "../schema.js";
import type { MCPContent, ToolModule } from "./types.js";

interface ShaveRequestResponse {
  id: string;
  status: string;
  retryAfter?: number;
}

/** Extract retryAfter from a 429 response body if present. */
function extractRetryAfter(bodyJson: unknown): number | undefined {
  if (bodyJson === null || typeof bodyJson !== "object") return undefined;
  const b = bodyJson as Record<string, unknown>;
  if (typeof b.retryAfter === "number") return b.retryAfter;
  // Also check nested error object
  if (typeof b.error === "object" && b.error !== null) {
    const inner = b.error as Record<string, unknown>;
    if (typeof inner.retryAfter === "number") return inner.retryAfter;
  }
  return undefined;
}

export const requestShave: ToolModule = {
  name: "yakcc_request_shave",
  description:
    "Request a shave operation for a package coordinate (pypi, npm, or github). Returns the shave request id and status.",
  inputSchema: {
    type: "object",
    properties: {
      coord: {
        type: "object",
        description:
          "Shave request coordinate. Discriminated by source: pypi/npm require name+version; github requires owner+repo+ref.",
        properties: {
          source: { type: "string", enum: ["pypi", "npm", "github"] },
          name: { type: "string" },
          version: { type: "string" },
          owner: { type: "string" },
          repo: { type: "string" },
          ref: { type: "string" },
        },
        required: ["source"],
      },
    },
    required: ["coord"],
    additionalProperties: false,
  },

  async handler(args: unknown, http: HttpClient): Promise<MCPContent[]> {
    const obj =
      args !== null && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    const parsed = parseShaveRequestCoord(obj.coord);
    if (!parsed.ok) {
      return [
        {
          type: "text",
          text: JSON.stringify({ error: parsed.code, message: parsed.message }),
        },
      ];
    }

    try {
      const result = await http.post<ShaveRequestResponse>("v1/shave-requests", parsed.value);
      return [
        {
          type: "text",
          text: JSON.stringify({ id: result.id, status: result.status }),
        },
      ];
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 429) {
          const retryAfter = extractRetryAfter(err.bodyJson);
          return [
            {
              type: "text",
              text: JSON.stringify({
                error: err.code,
                message: err.message,
                status: err.status,
                ...(retryAfter !== undefined ? { retryAfter } : {}),
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
