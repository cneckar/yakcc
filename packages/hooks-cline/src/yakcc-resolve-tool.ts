// SPDX-License-Identifier: MIT
/**
 * yakcc-resolve-tool.ts — Cline adapter registering `yakcc_resolve` as a Cline
 * tool surface. Calls yakccResolve from @yakcc/hooks-base with a registry opened
 * via the workspace bootstrap registry path.
 *
 * Mirrors hooks-cursor/src/yakcc-resolve-tool.ts with cline-specific defaults:
 * markerDir defaults to ~/.config/cline, marker filename is
 * "yakcc-cline-resolve-tool.json".
 *
 * @decision DEC-HOOK-CLINE-002
 * @title yakcc_resolve tool adapter for Cline: embedded library call, marker-file stub
 * @status accepted (wi-687-s2-cline)
 * @rationale
 *   (A) EMBEDDED LIBRARY CALL (D-HOOK-6 discipline):
 *       Identical to the Cursor adapter — yakccResolve() is called directly,
 *       no IPC or sidecar. Registry opened via openRegistry() from @yakcc/registry.
 *
 *   (B) REGISTRATION PATH:
 *       Writes ~/.config/cline/yakcc-cline-resolve-tool.json — a marker file
 *       parallel to hooks-cursor's yakcc-cursor-resolve-tool.json, but in the
 *       Cline settings directory. The Cline VS Code extension API does not expose
 *       a Node.js-callable tool registration surface; the marker file is the stub
 *       registration.
 *
 *   (C) CLINE-SPECIFIC DEFAULTS:
 *       markerDir defaults to ~/.config/cline (not ~/.cursor).
 *       RESOLVE_TOOL_MARKER_FILENAME is "yakcc-cline-resolve-tool.json".
 *       All other logic (registry path resolution, lazy open, confidenceMode default)
 *       is identical to the Cursor adapter.
 *
 *   Cross-reference:
 *     DEC-HOOK-PHASE-3-L3-MCP-001 — original Claude Code implementation
 *     DEC-HOOK-CURSOR-PHASE4-002  — Cursor adapter (mirrored here)
 *     DEC-HOOK-CLINE-001          — Cline adapter parent decision
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { QueryIntentCard } from "@yakcc/contracts";
import { type ResolveResult, writeMarkerCommand, yakccResolve } from "@yakcc/hooks-base";
import { openRegistry } from "@yakcc/registry";
import type { Registry } from "@yakcc/registry";

// ---------------------------------------------------------------------------
// Tool definition constants
// ---------------------------------------------------------------------------

/** Filename for the yakcc_resolve tool registration marker (Cline adapter). */
export const RESOLVE_TOOL_MARKER_FILENAME = "yakcc-cline-resolve-tool.json";

/**
 * Default registry path: matches DEFAULT_REGISTRY_PATH in the CLI package.
 * Workspace-root-relative; resolved against process.cwd() in production.
 * Override via YAKCC_REGISTRY_PATH env var for test isolation.
 */
export const DEFAULT_REGISTRY_PATH = ".yakcc/registry.sqlite";

/**
 * Canonical system-prompt file path per D4 ADR Q4.
 * Located at docs/system-prompts/yakcc-discovery.md in the workspace root.
 * Same path as the Cursor adapter — the system prompt is shared.
 */
export const SYSTEM_PROMPT_PATH = "docs/system-prompts/yakcc-discovery.md";

// ---------------------------------------------------------------------------
// Tool argument schema
// ---------------------------------------------------------------------------

/**
 * Arguments accepted by the yakcc_resolve Cline tool.
 *
 * Identical to the Cursor adapter's YakccResolveToolArgs — the D4 ADR
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
 * The yakcc_resolve tool surface for Cline.
 *
 * Registered via registerTool(). Exposes a single resolve() method that
 * the hook harness calls when the LLM invokes yakcc_resolve in Cline.
 */
export interface YakccResolveTool {
  /**
   * Register the yakcc_resolve tool with the Cline extension harness.
   *
   * Writes ~/.config/cline/yakcc-cline-resolve-tool.json (or markerDir override)
   * recording the tool name, description, system-prompt location, and registration
   * timestamp. This is the stub registration until the Cline VS Code extension
   * API stabilises (DEC-HOOK-CLINE-002-B).
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
      `REGISTRY_UNREACHABLE: registry_unavailable — could not open registry at ${registryPath}: ${String(err)}`,
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
   * Override the marker directory (default: ~/.config/cline).
   * Tests supply a tmpdir path for isolation.
   */
  readonly markerDir?: string | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a YakccResolveTool for Cline backed by the configured registry.
 *
 * The registry is opened lazily on the first resolve() call and cached for
 * the lifetime of the tool instance.
 *
 * @param options - Optional overrides for registry path and marker directory.
 */
export function createYakccResolveTool(options?: CreateYakccResolveToolOptions): YakccResolveTool {
  const registryPath =
    options?.registryPath ??
    process.env.YAKCC_REGISTRY_PATH ??
    resolve(process.cwd(), DEFAULT_REGISTRY_PATH);

  const markerDir = options?.markerDir ?? join(homedir(), ".config", "cline");

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
