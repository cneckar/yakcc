// SPDX-License-Identifier: MIT
/**
 * yakcc-resolve-tool.ts — Cursor adapter registering `yakcc_resolve` as a Cursor
 * tool surface. Calls yakccResolve from @yakcc/hooks-base with a registry opened
 * via the workspace bootstrap registry path.
 *
 * Mirrors hooks-claude-code/src/yakcc-resolve-tool.ts (Phase 3 L3) with
 * cursor-specific defaults: markerDir defaults to ~/.cursor, marker filename
 * is "yakcc-cursor-resolve-tool.json".
 *
 * @decision DEC-HOOK-CURSOR-PHASE4-002
 * @title yakcc_resolve tool adapter for Cursor: embedded library call, marker-file stub
 * @status accepted (WI-HOOK-PHASE-4-CURSOR, closes #219)
 * @rationale
 *   (A) EMBEDDED LIBRARY CALL (D-HOOK-6 discipline):
 *       Identical to the Claude Code adapter — yakccResolve() is called directly,
 *       no IPC or sidecar. Registry opened via openRegistry() from @yakcc/registry.
 *
 *   (B) REGISTRATION PATH:
 *       Writes ~/.cursor/yakcc-cursor-resolve-tool.json — a marker file parallel to
 *       hooks-claude-code's yakcc-resolve-tool.json, but in the Cursor settings
 *       directory. The Cursor VS Code extension API does not expose a Node.js-callable
 *       tool registration surface (same constraint as registerCommand); the marker
 *       file is the stub registration.
 *
 *   (C) CURSOR-SPECIFIC DEFAULTS:
 *       markerDir defaults to ~/.cursor (not ~/.claude).
 *       RESOLVE_TOOL_MARKER_FILENAME is "yakcc-cursor-resolve-tool.json".
 *       All other logic (registry path resolution, lazy open, confidenceMode default)
 *       is identical to the Claude Code adapter.
 *
 *   Cross-reference:
 *     DEC-HOOK-PHASE-3-L3-MCP-001 — original Claude Code implementation
 *     DEC-HOOK-CURSOR-PHASE4-001 — Phase 4 cursor parity parent decision
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { QueryIntentCard } from "@yakcc/contracts";
import {
  type ResolveResult,
  yakccResolve,
  writeMarkerCommand,
} from "@yakcc/hooks-base";
import { openRegistry } from "@yakcc/registry";
import type { Registry } from "@yakcc/registry";

// ---------------------------------------------------------------------------
// Tool definition constants
// ---------------------------------------------------------------------------

/** Filename for the yakcc_resolve tool registration marker (Cursor adapter). */
export const RESOLVE_TOOL_MARKER_FILENAME = "yakcc-cursor-resolve-tool.json";

/**
 * Default registry path: matches DEFAULT_REGISTRY_PATH in the CLI package.
 * Workspace-root-relative; resolved against process.cwd() in production.
 * Override via YAKCC_REGISTRY_PATH env var for test isolation.
 */
export const DEFAULT_REGISTRY_PATH = ".yakcc/registry.sqlite";

/**
 * Canonical system-prompt file path per D4 ADR Q4.
 * Located at docs/system-prompts/yakcc-discovery.md in the workspace root.
 * Same path as the Claude Code adapter — the system prompt is shared.
 */
export const SYSTEM_PROMPT_PATH = "docs/system-prompts/yakcc-discovery.md";

// ---------------------------------------------------------------------------
// Tool argument schema
// ---------------------------------------------------------------------------

/**
 * Arguments accepted by the yakcc_resolve Cursor tool.
 *
 * Identical to the Claude Code adapter's YakccResolveToolArgs — the D4 ADR
 * tool schema is shared across IDE adapters.
 */
export interface YakccResolveToolArgs {
  /**
   * The query: either a behavior string or a full QueryIntentCard.
   * A bare string is treated as QueryIntentCard{ behavior: string }.
   */
  readonly query: string | QueryIntentCard;
  /**
   * Confidence mode per D4 ADR Q5.
   * Default: "hybrid" (auto-accept when combinedScore > 0.92 AND gap > 0.15).
   */
  readonly confidenceMode?: "auto_accept" | "always_show" | "hybrid" | undefined;
}

// ---------------------------------------------------------------------------
// YakccResolveTool interface
// ---------------------------------------------------------------------------

/**
 * The yakcc_resolve tool surface for Cursor.
 *
 * Registered via registerTool(). Exposes a single resolve() method that
 * the hook harness calls when the LLM invokes yakcc_resolve in Cursor.
 */
export interface YakccResolveTool {
  /**
   * Register the yakcc_resolve tool with the Cursor extension harness.
   *
   * Writes ~/.cursor/yakcc-cursor-resolve-tool.json (or markerDir override)
   * recording the tool name, description, system-prompt location, and registration
   * timestamp. This is the stub registration until the Cursor VS Code extension
   * API stabilises (DEC-HOOK-CURSOR-PHASE4-002-B).
   */
  registerTool(): void;

  /**
   * Invoke the yakcc_resolve tool with the given arguments.
   *
   * Opens (or reuses) the registry, calls yakccResolve(), and returns the
   * D4 evidence-projection envelope. Throws on registry open failure.
   *
   * @param args - Tool arguments: query + optional confidenceMode
   */
  resolve(args: YakccResolveToolArgs): Promise<ResolveResult>;
}

// ---------------------------------------------------------------------------
// Registry lifecycle (lazy open, cached per tool instance)
// ---------------------------------------------------------------------------

async function openConfiguredRegistry(registryPath: string): Promise<Registry> {
  try {
    const { createOfflineEmbeddingProvider } = await import("@yakcc/contracts");
    const provider = createOfflineEmbeddingProvider();
    return await openRegistry(registryPath, { embeddings: provider });
  } catch (err) {
    throw new Error(
      `REGISTRY_UNREACHABLE: registry_unavailable — ` +
        `could not open registry at ${registryPath}: ${String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export interface CreateYakccResolveToolOptions {
  /**
   * Override the registry SQLite path.
   * Defaults to process.env.YAKCC_REGISTRY_PATH ?? resolve(process.cwd(), DEFAULT_REGISTRY_PATH).
   */
  readonly registryPath?: string | undefined;
  /**
   * Override the marker directory (default: ~/.cursor).
   * Tests supply a tmpdir path for isolation.
   */
  readonly markerDir?: string | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a YakccResolveTool for Cursor backed by the configured registry.
 *
 * The registry is opened lazily on the first resolve() call and cached for
 * the lifetime of the tool instance.
 *
 * @param options - Optional overrides for registry path and marker directory.
 */
export function createYakccResolveTool(
  options?: CreateYakccResolveToolOptions,
): YakccResolveTool {
  const registryPath =
    options?.registryPath ??
    process.env["YAKCC_REGISTRY_PATH"] ??
    resolve(process.cwd(), DEFAULT_REGISTRY_PATH);

  const markerDir = options?.markerDir ?? join(homedir(), ".cursor");

  let registryPromise: Promise<Registry> | null = null;

  function getRegistry(): Promise<Registry> {
    if (registryPromise === null) {
      registryPromise = openConfiguredRegistry(registryPath);
    }
    return registryPromise;
  }

  return {
    registerTool(): void {
      writeMarkerCommand(markerDir, RESOLVE_TOOL_MARKER_FILENAME, {
        tool: "yakcc_resolve",
        description:
          "Resolve a code-generation intent against the yakcc registry. " +
          "Returns D4 evidence-projection envelopes for matching atoms.",
        systemPromptPath: SYSTEM_PROMPT_PATH,
        registryPath,
        registeredAt: new Date().toISOString(),
      });
    },

    async resolve(args: YakccResolveToolArgs): Promise<ResolveResult> {
      const registry = await getRegistry();
      return yakccResolve(registry, args.query, {
        confidenceMode: args.confidenceMode ?? "hybrid",
      });
    },
  };
}
