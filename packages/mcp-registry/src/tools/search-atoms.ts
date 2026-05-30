/**
 * Tool: yakcc_search_atoms
 * List block merkle roots from the registry with optional pagination.
 *
 * @decision DEC-MCP-TOOL-SEARCH-ATOMS-012
 * @title yakcc_search_atoms — paginated block listing via GET /v1/blocks
 * @status decided (wi-944, bite 2)
 * @rationale
 *   Exposes the registry's block listing endpoint. The `after` query param is
 *   the server's cursor parameter; we accept it as `cursor` to match MCP
 *   naming conventions and translate it in the path builder. Limit is capped
 *   at 1000 matching the server contract. DEC-MCP-ERROR-AS-CONTENT-004:
 *   all HttpError instances are caught and returned as structured text content.
 *
 * HTTP: GET /v1/blocks?limit=N&after=<cursor>
 * Implements: yakcc#944
 */

import { HttpError } from "../http-client.js";
import type { HttpClient } from "../http-client.js";
import type { MCPContent, ToolModule } from "./types.js";

interface SearchAtomsArgs {
  limit?: number;
  cursor?: string;
}

interface SearchAtomsResponse {
  roots: string[];
  nextCursor?: string;
}

function parseArgs(
  args: unknown,
): { ok: true; value: SearchAtomsArgs } | { ok: false; message: string } {
  if (args === undefined || args === null) {
    return { ok: true, value: {} };
  }
  if (typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, message: "args must be an object" };
  }
  const obj = args as Record<string, unknown>;
  const limit = obj.limit;
  const cursor = obj.cursor;
  if (
    limit !== undefined &&
    (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000)
  ) {
    return { ok: false, message: "limit must be an integer between 1 and 1000" };
  }
  if (cursor !== undefined && typeof cursor !== "string") {
    return { ok: false, message: "cursor must be a string" };
  }
  const value: SearchAtomsArgs = {};
  if (typeof limit === "number") value.limit = limit;
  if (typeof cursor === "string") value.cursor = cursor;
  return { ok: true, value };
}

export const searchAtoms: ToolModule = {
  name: "yakcc_search_atoms",
  description:
    "List block merkle roots from the yakcc registry. Supports pagination via limit and cursor.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        description: "Number of results to return (1–1000). Defaults to server default.",
        minimum: 1,
        maximum: 1000,
      },
      cursor: {
        type: "string",
        description: "Pagination cursor from a previous response's nextCursor field.",
      },
    },
    additionalProperties: false,
  },

  async handler(args: unknown, http: HttpClient): Promise<MCPContent[]> {
    const parsed = parseArgs(args);
    if (!parsed.ok) {
      return [
        {
          type: "text",
          text: JSON.stringify({ error: "invalid_input", message: parsed.message }),
        },
      ];
    }

    const { limit, cursor } = parsed.value;
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (cursor !== undefined) params.set("after", cursor);
    const qs = params.toString();
    const path = qs ? `v1/blocks?${qs}` : "v1/blocks";

    try {
      const result = await http.get<SearchAtomsResponse>(path);
      return [
        {
          type: "text",
          text: JSON.stringify({
            roots: result.roots ?? [],
            nextCursor: result.nextCursor ?? null,
          }),
        },
      ];
    } catch (err) {
      if (err instanceof HttpError) {
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
