/**
 * Tool: yakcc_submit_atom
 * Submit a new atom block to the registry.
 *
 * @decision DEC-MCP-TOOL-SUBMIT-ATOM-016
 * @title yakcc_submit_atom — block submission via POST /v1/blocks/submit
 * @status decided (wi-944, bite 2)
 * @rationale
 *   Accepts a bare WireBlockTriplet (no envelope wrapper) and POSTs it
 *   directly to the registry per yakforge W-141. The server owns integrity
 *   validation; this tool only enforces structural shape via parseWireBlockTriplet.
 *   400 error codes invalid_wire and integrity_failed are surfaced verbatim.
 *   413 maps to PAYLOAD_TOO_LARGE. DEC-MCP-ERROR-AS-CONTENT-004 applies.
 *
 * HTTP: POST /v1/blocks/submit
 * Implements: yakcc#944
 */

import { HttpError } from "../http-client.js";
import type { HttpClient } from "../http-client.js";
import { parseWireBlockTriplet } from "../schema.js";
import type { MCPContent, ToolModule } from "./types.js";

interface SubmitAtomResponse {
  accepted: boolean;
  hash: string;
  deduped: boolean;
}

export const submitAtom: ToolModule = {
  name: "yakcc_submit_atom",
  description:
    "Submit a new atom block to the yakcc registry. Accepts a WireBlockTriplet and returns the accepted hash.",
  inputSchema: {
    type: "object",
    properties: {
      block: {
        type: "object",
        description:
          "The WireBlockTriplet to submit (specHash, specCanonicalBytes, blockMerkleRoot, implSource).",
        properties: {
          specHash: { type: "string" },
          specCanonicalBytes: { type: "string" },
          blockMerkleRoot: { type: "string" },
          implSource: { type: "string" },
        },
        required: ["specHash", "specCanonicalBytes", "blockMerkleRoot", "implSource"],
      },
    },
    required: ["block"],
    additionalProperties: false,
  },

  async handler(args: unknown, http: HttpClient): Promise<MCPContent[]> {
    const obj =
      args !== null && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    const parsed = parseWireBlockTriplet(obj.block);
    if (!parsed.ok) {
      return [
        {
          type: "text",
          text: JSON.stringify({ error: parsed.code, message: parsed.message }),
        },
      ];
    }

    try {
      const result = await http.post<SubmitAtomResponse>("v1/blocks/submit", parsed.value);
      return [
        {
          type: "text",
          text: JSON.stringify({
            accepted: result.accepted,
            hash: result.hash,
            deduped: result.deduped,
          }),
        },
      ];
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 413) {
          return [
            {
              type: "text",
              text: JSON.stringify({
                error: "PAYLOAD_TOO_LARGE",
                message: "Block payload exceeds the server's size limit.",
              }),
            },
          ];
        }
        // Surface server error codes (invalid_wire, integrity_failed, etc.)
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
