/**
 * Shared types for all tool modules (DEC-MCP-TOOL-INTERFACE-011).
 *
 * @decision DEC-MCP-TOOL-INTERFACE-011
 * @title Uniform ToolModule interface for all 8 tool adapters
 * @status decided (wi-944, bite 2)
 * @rationale
 *   The bite-3 stdio server iterates TOOLS[] and registers each via the MCP SDK.
 *   Defining the interface here lets tool modules stay self-contained and lets
 *   tools/index.ts and the server entry share the same structural type without
 *   importing from the SDK directly in every tool file.
 *
 * MCPContent mirrors the MCP "content block" shape: { type: "text", text: string }.
 * The tool handler returns an array of these; the server wraps them in the
 * CallToolResult envelope.
 *
 * Implements: yakcc#944
 */

import type { HttpClient } from "../http-client.js";

/** A single MCP text content block (the only content type used by these tools). */
export interface MCPContent {
  type: "text";
  text: string;
}

/**
 * Structural interface every tool module must satisfy.
 * The bite-3 server uses this to register tools with the MCP SDK.
 */
export interface ToolModule {
  /** MCP tool identifier — the name the LLM sees and invokes. */
  name: string;
  /** Concise description surfaced to the LLM in the tool list. */
  description: string;
  /** JSON Schema for the tool's input arguments. */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /**
   * Handle a tool call.
   * @param args - Raw, unvalidated args from the MCP layer.
   * @param http - Injected HttpClient (allows test injection without env side-effects).
   * @returns Array of MCP content blocks (never throws — errors become content).
   */
  handler(args: unknown, http: HttpClient): Promise<MCPContent[]>;
}
