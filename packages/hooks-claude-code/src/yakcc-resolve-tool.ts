// SPDX-License-Identifier: MIT
/**
 * yakcc-resolve-tool.ts — Thin adapter registering `yakcc_resolve` as a Claude Code
 * tool surface (MCP tool definition). Calls yakccResolve from @yakcc/hooks-base
 * with a registry opened via the workspace bootstrap registry path.
 *
 * @decision DEC-HOOK-PHASE-3-L3-MCP-001
 * @title yakcc_resolve MCP tool adapter: embedded library call, settings.json hook path
 * @status accepted
 * @rationale
 *   This adapter wires the D4 ADR tool-call surface into the Claude Code hook
 *   ecosystem. Three design decisions captured here:
 *
 *   (A) EMBEDDED LIBRARY CALL (D-HOOK-6 discipline):
 *       The tool calls yakccResolve() from @yakcc/hooks-base directly — no IPC,
 *       no RPC, no sidecar process. The registry is opened via openRegistry() from
 *       @yakcc/registry using the workspace bootstrap registry path. This is the
 *       same embedded-library-call pattern as Phase 1/2 hooks. A sidecar approach
 *       was explicitly rejected by D-HOOK-4 (no sidecar files).
 *
 *   (B) REGISTRATION PATH:
 *       The tool surface is registered via the same settings.json hook path used by
 *       Phase 1 (registerSlashCommand writes ~/.claude/yakcc-slash-command.json).
 *       This adapter writes ~/.claude/yakcc-resolve-tool.json — a parallel marker
 *       file recording the tool definition, system-prompt location, and registration
 *       timestamp. The Claude Code MCP extension API does not expose a Node.js-
 *       callable tool registration surface as of v1; the marker file is the stub
 *       registration until that API stabilises (same rationale as registerSlashCommand).
 *
 *   (C) REGISTRY PATH RESOLUTION:
 *       The workspace bootstrap registry path is ".yakcc/registry.sqlite" (relative
 *       to the workspace root). This matches DEFAULT_REGISTRY_PATH in the CLI package
 *       (packages/cli/src/commands/registry-init.ts). The tool adapter resolves this
 *       relative path against process.cwd() — the workspace root in production.
 *       Tests override via YAKCC_REGISTRY_PATH env var for test isolation.
 *
 *   (D) CONFIDENCEMODE DEFAULT:
 *       The tool adapter defaults to "hybrid" per D4 ADR Q5 (auto-accept only when
 *       combinedScore > 0.92 AND gap-to-top-2 > 0.15). Callers may override by
 *       passing confidenceMode in the tool call arguments.
 *
 *   Cross-reference:
 *     DEC-HOOK-PHASE-3-L3-MCP-001 — envelope shape, 4-band thresholds, D-HOOK-6
 *     docs/adr/discovery-llm-interaction.md — D4 ADR (canonical authority)
 *     docs/system-prompts/yakcc-discovery.md — verbatim system-prompt text
 *     packages/cli/src/commands/registry-init.ts — DEFAULT_REGISTRY_PATH authority
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { QueryIntentCard } from "@yakcc/contracts";
import {
  type ResolveResult,
  yakccResolve,
} from "@yakcc/hooks-base";
import { openRegistry } from "@yakcc/registry";
import type { Registry } from "@yakcc/registry";
import { writeMarkerCommand } from "@yakcc/hooks-base";

// ---------------------------------------------------------------------------
// Tool definition constants
// ---------------------------------------------------------------------------

/** Filename for the yakcc_resolve tool registration marker. */
export const RESOLVE_TOOL_MARKER_FILENAME = "yakcc-resolve-tool.json";

/**
 * Default registry path: matches DEFAULT_REGISTRY_PATH in the CLI package.
 * Workspace-root-relative; resolved against process.cwd() in production.
 * Override via YAKCC_REGISTRY_PATH env var for test isolation.
 */
export const DEFAULT_REGISTRY_PATH = ".yakcc/registry.sqlite";

/**
 * Canonical system-prompt file path per D4 ADR Q4.
 * Located at docs/system-prompts/yakcc-discovery.md in the workspace root.
 */
export const SYSTEM_PROMPT_PATH = "docs/system-prompts/yakcc-discovery.md";

// ---------------------------------------------------------------------------
// Tool argument schema (D4 ADR Q1: single yakcc_resolve tool)
// ---------------------------------------------------------------------------

/**
 * Arguments accepted by the yakcc_resolve MCP tool.
 *
 * query is the primary argument — either a behavior string (shorthand) or a
 * full QueryIntentCard. confidenceMode is the D4 ADR Q5 caller-side signal.
 *
 * This schema is what the LLM sees in the tool definition; it maps to
 * yakccResolve()'s input union (string | QueryIntentCard | HashLookup).
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
 * The yakcc_resolve tool surface for Claude Code.
 *
 * Registered via registerTool(). Exposes a single resolve() method that
 * the hook harness calls when the LLM invokes yakcc_resolve.
 */
export interface YakccResolveTool {
  /**
   * Register the yakcc_resolve tool with the Claude Code harness.
   *
   * Writes ~/.claude/yakcc-resolve-tool.json (or markerDir override) recording
   * the tool name, description, system-prompt location, and registration timestamp.
   * This is the stub registration until the Claude Code MCP tool registration API
   * stabilises (D-HOOK-6, DEC-HOOK-PHASE-3-L3-MCP-001-B).
   */
  registerTool(): void;

  /**
   * Invoke the yakcc_resolve tool with the given arguments.
   *
   * Opens (or reuses) the registry, calls yakccResolve(), and returns the
   * D4 evidence-projection envelope. Throws RegistryUnreachable on registry
   * open failure (D4 ADR Q6 F1 — caller should emit REGISTRY_UNREACHABLE note).
   *
   * @param args - Tool arguments: query + optional confidenceMode
   */
  resolve(args: YakccResolveToolArgs): Promise<ResolveResult>;
}

// ---------------------------------------------------------------------------
// Registry lifecycle (lazy open, cached per tool instance)
// ---------------------------------------------------------------------------

/**
 * Open the registry at the configured path.
 * Throws with a descriptive message on failure (D4 ADR Q6 F1).
 */
async function openConfiguredRegistry(registryPath: string): Promise<Registry> {
  try {
    // Use the offline embedding provider for tool-surface use: deterministic,
    // no model download required, suitable for production hook latency budget.
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
// Factory
// ---------------------------------------------------------------------------

/**
 * Tool factory options.
 */
export interface CreateYakccResolveToolOptions {
  /**
   * Override the registry SQLite path.
   * Defaults to process.env.YAKCC_REGISTRY_PATH ?? resolve(process.cwd(), DEFAULT_REGISTRY_PATH).
   */
  readonly registryPath?: string | undefined;
  /**
   * Override the marker directory (default: ~/.claude).
   * Tests supply a tmpdir path for isolation.
   */
  readonly markerDir?: string | undefined;
}

/**
 * Create a YakccResolveTool backed by the configured registry.
 *
 * The registry is opened lazily on the first resolve() call and cached for
 * the lifetime of the tool instance. This avoids opening the DB at registration
 * time (which would fail if the registry doesn't exist yet during bootstrap).
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

  const markerDir = options?.markerDir ?? join(homedir(), ".claude");

  // Lazy-cached registry handle
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
