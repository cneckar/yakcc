// SPDX-License-Identifier: MIT
//
// mcp-config.ts — Read/merge/write .mcp.json (Claude Code project-level MCP config)
//
// Claude Code reads project-local MCP servers from `.mcp.json` in the project
// root. Format reference: https://docs.claude.com/en/docs/claude-code/mcp
//
// @decision DEC-CLI-MCP-CONFIG-001
// title: .mcp.json is written by a single authority function `writeMcpJsonEntry`;
//        merge (not replace) semantics preserve unrelated servers
// status: accepted (WI-1005-mcp-init)
// rationale:
//   A user's project may already have .mcp.json entries for other servers (e.g.
//   GitHub, database tools, etc.). Replacing the file wholesale would silently
//   drop those configs. Merge-by-key preserves all existing entries and is
//   idempotent: re-running `yakcc init` with the same entry name either
//   overwrites just that key or leaves it unchanged. The merge is performed at
//   the `mcpServers` top-level object only — deep merging individual server
//   configs is not needed because each server entry is a self-contained unit.
//
//   FAILURE MODE: if .mcp.json exists but is not valid JSON, this function
//   throws so init can surface a clear error. Silently overwriting a corrupt
//   file risks destroying user configuration.
//
//   WRITE STRATEGY: JSON.stringify with 2-space indent to stay consistent with
//   the format Claude Code itself produces when editing .mcp.json.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Filename consumed by Claude Code for project-level MCP server registration. */
export const MCP_JSON_FILENAME = ".mcp.json";

/**
 * Shape of a single MCP server entry inside `.mcp.json#mcpServers`.
 *
 * Matches the Claude Code `.mcp.json` format:
 * ```json
 * { "command": "npx", "args": ["-y", "yakcc-mcp-registry"] }
 * ```
 */
export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Shape of the `.mcp.json` file consumed by Claude Code.
 */
export interface McpJson {
  mcpServers: Record<string, McpServerEntry>;
}

/**
 * Read an existing `.mcp.json` from `targetDir`, or return null if absent.
 *
 * Throws a descriptive `Error` if the file exists but cannot be parsed as
 * valid JSON so callers can surface the error instead of clobbering user data.
 */
export function readMcpJson(targetDir: string): McpJson | null {
  const filePath = join(targetDir, MCP_JSON_FILENAME);
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${MCP_JSON_FILENAME} in ${targetDir} is not valid JSON: ${(err as Error).message}`,
    );
  }

  // Normalise: ensure mcpServers exists (tolerant of minimal hand-created files)
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${MCP_JSON_FILENAME} in ${targetDir} must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.mcpServers === undefined) {
    obj.mcpServers = {};
  }
  if (typeof obj.mcpServers !== "object" || obj.mcpServers === null) {
    throw new Error(`${MCP_JSON_FILENAME}.mcpServers in ${targetDir} must be an object`);
  }
  return obj as unknown as McpJson;
}

/**
 * Write `{ mcpServers: { [name]: entry } }` into `.mcp.json` in `targetDir`,
 * merging with any existing contents.
 *
 * Behaviour:
 * - If `.mcp.json` does not exist: creates it with just this entry.
 * - If `.mcp.json` exists and has an unrelated server: adds the entry,
 *   preserving all other keys under `mcpServers`.
 * - If `.mcp.json` exists and already has an entry for `name`: overwrites
 *   just that entry (idempotent).
 *
 * Throws if the existing file is not parseable JSON.
 *
 * @param targetDir  Project root to write `.mcp.json` into.
 * @param name       Key name under `mcpServers` (e.g. `"yakcc"`).
 * @param entry      The MCP server config to write.
 */
export function writeMcpJsonEntry(targetDir: string, name: string, entry: McpServerEntry): void {
  const existing = readMcpJson(targetDir) ?? { mcpServers: {} };
  const updated: McpJson = {
    ...existing,
    mcpServers: {
      ...existing.mcpServers,
      [name]: entry,
    },
  };
  const filePath = join(targetDir, MCP_JSON_FILENAME);
  writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
}
