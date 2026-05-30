/**
 * Tool: yakcc_list_specs
 * Retrieve the full list of spec hashes from the registry.
 *
 * @decision DEC-MCP-TOOL-LIST-SPECS-014
 * @title yakcc_list_specs — full spec list via GET /v1/specs
 * @status decided (wi-944, bite 2)
 * @rationale
 *   The /v1/specs endpoint returns the complete set of spec hashes without
 *   pagination (registry design decision). No input args required. Returns
 *   the list as-is. DEC-MCP-ERROR-AS-CONTENT-004 applies for all error paths.
 *
 * HTTP: GET /v1/specs
 * Implements: yakcc#944
 */

import { HttpError } from "../http-client.js";
import type { HttpClient } from "../http-client.js";
import type { MCPContent, ToolModule } from "./types.js";

interface ListSpecsResponse {
  specs: string[];
}

export const listSpecs: ToolModule = {
  name: "yakcc_list_specs",
  description: "Retrieve the full list of spec hashes from the yakcc registry.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },

  async handler(_args: unknown, http: HttpClient): Promise<MCPContent[]> {
    try {
      const result = await http.get<ListSpecsResponse>("v1/specs");
      return [
        {
          type: "text",
          text: JSON.stringify({ specs: result.specs ?? [] }),
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
