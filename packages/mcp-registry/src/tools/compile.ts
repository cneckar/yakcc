/**
 * Tool: yakcc_compile
 *
 * @decision DEC-MCP-COMPILE-EXEC-1007-001
 * @title yakcc_compile — materialize an atom's impl source from the local registry
 * @status decided (wi-1007)
 * @rationale
 *   After yakcc_resolve surfaces a candidate (auto_accept or chosen from
 *   candidate_list), the model used to emit the inert CLI string
 *   `yakcc compile <id>` — which produced nothing inside a Claude Code session.
 *   This tool closes that gap: it resolves the atom in the LOCAL registry,
 *   runs `assemble()` from @yakcc/compile, and returns the write-ready
 *   `artifact.source` so the model can immediately pass it to Edit/Write.
 *
 *   Architecture decisions:
 *
 *   (1) LOCAL-ONLY (D-HOOK-6, Sacred Practice #12):
 *       The local registry is the sole authority. No HTTP fallback — compiling
 *       an atom that exists only in the global commons (not in the local DB)
 *       is not in scope for WI-1007 (follow-up WI).
 *
 *   (2) SHORT-ID RESOLUTION (one authority):
 *       An 8-char (or any non-64-char) atom_id is treated as a prefix against
 *       the full set of BlockMerkleRoots known to the seeded registry
 *       (seedRegistry(registry).merkleRoots — the same set CLI compile.ts:199
 *       uses). Unique prefix → resolve; ambiguous → structured
 *       ambiguous_short_id content; no match → not_found.
 *       Full 64-char root passes straight through (no seedRegistry call needed).
 *       One short-id authority; no parallel scheme.
 *
 *   (3) ASSEMBLE PREFERRED:
 *       Uses assemble() from @yakcc/compile (not just registry.getBlock().implSource)
 *       so multi-block composite atoms work correctly. The knownMerkleRoots from
 *       seedRegistry are forwarded as the pre-scan stem index (same as CLI).
 *
 *   (4) ERROR DISCIPLINE (DEC-MCP-ERROR-AS-CONTENT-004):
 *       All errors returned as structured MCP content. The handler NEVER throws.
 *       Structured error codes: invalid_input, registry_unavailable,
 *       not_found, ambiguous_short_id, assembly_failed.
 *
 *   (5) LAZY REGISTRY OPEN:
 *       Registry opened once per tool instance (same pattern as resolve.ts).
 *       Factory injectable for tests.
 *
 *   Cross-references:
 *     DEC-HOOK-PROACTIVE-PRIMARY-001 — initiative umbrella
 *     DEC-MCP-ERROR-AS-CONTENT-004   — errors as content, never throw
 *     DEC-MCP-STDERR-LOGGING-005     — no stdout (no console.log)
 *     Sacred Practice #12            — single authority for short-id resolution
 *     CLI compile.ts lines 195-257   — reference implementation for assemble flow
 *
 * Implements: yakcc#1007
 */

import { assemble } from "@yakcc/compile";
import type { Artifact } from "@yakcc/compile";
import type { BlockMerkleRoot } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";
import { seedRegistry } from "@yakcc/seeds";
import type { SeedResult } from "@yakcc/seeds";
import type { HttpClient } from "../http-client.js";
import type { MCPContent, ToolModule } from "./types.js";

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

type ParsedInput = { ok: true; atomId: string } | { ok: false; message: string };

function parseArgs(args: unknown): ParsedInput {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, message: "args must be a non-null object" };
  }
  const obj = args as Record<string, unknown>;
  const atomId = obj.atom_id;
  if (typeof atomId !== "string" || atomId.length === 0) {
    return { ok: false, message: "atom_id must be a non-empty string" };
  }
  // Accept short ids (>=4 chars, practical minimum) or full 64-char roots.
  // We do not enforce minimum length here — any non-empty string is forwarded
  // to the resolution step, which will return not_found for trivially short ids.
  return { ok: true, atomId };
}

// ---------------------------------------------------------------------------
// Short-id → full-root resolution
// ---------------------------------------------------------------------------

type ResolveIdResult =
  | { kind: "full"; root: BlockMerkleRoot }
  | { kind: "ambiguous"; matches: string[] }
  | { kind: "not_found" };

/**
 * Resolve a possibly-short atom_id to a unique BlockMerkleRoot.
 *
 * - 64-char hex string → pass straight through as BlockMerkleRoot.
 * - Shorter string → prefix-match against knownRoots (the seeded registry set).
 *   Unique match → resolve. Multiple matches → ambiguous. Zero → not_found.
 *
 * This is the single short-id resolution authority for the MCP compile tool
 * (Sacred Practice #12). The knownRoots come from seedRegistry().merkleRoots,
 * matching CLI compile.ts line 199.
 */
function resolveAtomId(atomId: string, knownRoots: ReadonlyArray<BlockMerkleRoot>): ResolveIdResult {
  // Full 64-char merkle root: pass through directly.
  if (/^[a-f0-9]{64}$/i.test(atomId)) {
    return { kind: "full", root: atomId.toLowerCase() as BlockMerkleRoot };
  }

  // Short id: prefix match against known roots.
  const prefix = atomId.toLowerCase();
  const matches = knownRoots.filter((r) => r.startsWith(prefix));

  if (matches.length === 0) {
    return { kind: "not_found" };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", matches: matches as string[] };
  }
  return { kind: "full", root: matches[0] as BlockMerkleRoot };
}

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

/**
 * Options for createCompileTool().
 *
 * Tests inject openRegistry to avoid real SQLite access and to control the
 * registry content seen by the handler. Production uses the default factory.
 */
export interface CreateCompileToolOptions {
  /**
   * Factory for the local registry. Called lazily on the first handler
   * invocation and cached for the tool instance lifetime.
   * Defaults to the production registry opener (YAKCC_REGISTRY_PATH or
   * .yakcc/registry.sqlite from cwd).
   */
  readonly openRegistry?: (() => Promise<Registry>) | undefined;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create a yakcc_compile ToolModule with an optionally injected registry factory.
 *
 * Handler is a closure over the lazy registry promise. The registry is opened
 * once and seeded once per tool instance. The seeded merkle roots are cached
 * alongside the registry so subsequent calls don't re-seed.
 *
 * @param opts - Optional registry factory override (for tests).
 */
export function createCompileTool(opts?: CreateCompileToolOptions): ToolModule {
  // Lazy-cached registry + seed state (opened and seeded at most once per instance).
  let registryPromise: Promise<{ registry: Registry; seedResult: SeedResult }> | null = null;

  function getRegistryAndSeed(): Promise<{ registry: Registry; seedResult: SeedResult }> {
    if (registryPromise !== null) return registryPromise;
    const factory = opts?.openRegistry ?? defaultOpenRegistry;
    registryPromise = factory().then(async (registry) => {
      // seedRegistry is idempotent (INSERT OR IGNORE) — safe to call on an
      // already-seeded registry. We need its merkleRoots for short-id resolution.
      const seedResult = await seedRegistry(registry);
      return { registry, seedResult };
    });
    return registryPromise;
  }

  return {
    name: "yakcc_compile",

    description: [
      "Materialize a yakcc atom's implementation source from the local registry.",
      "Call this after yakcc_resolve returns an auto_accept candidate or after you",
      "have selected a candidate from a candidate_list.",
      "",
      "Accepts either:",
      "  - An 8-character short id (the `atom_id` prefix from resolve candidates)",
      "  - A full 64-character BLAKE3 hex merkle root",
      "",
      "Returns the write-ready `source` string (the compiled TypeScript module).",
      "Write it to the target file with Edit or Write — do NOT copy-paste it manually.",
      "",
      "Error codes in the response:",
      "  - not_found         → atom not in the local registry (seed or fetch first)",
      "  - ambiguous_short_id → prefix matches multiple atoms; use a longer prefix",
      "  - assembly_failed   → atom found but assemble() failed (check dependencies)",
    ].join("\n"),

    inputSchema: {
      type: "object",
      required: ["atom_id"],
      properties: {
        atom_id: {
          type: "string",
          minLength: 1,
          description:
            "8-character short id (address prefix from yakcc_resolve) or full 64-char BLAKE3 hex merkle root.",
        },
      },
      additionalProperties: false,
    },

    async handler(args: unknown, _http: HttpClient): Promise<MCPContent[]> {
      // --- Input validation ---
      const parsed = parseArgs(args);
      if (!parsed.ok) {
        return [
          {
            type: "text",
            text: JSON.stringify({ error: "invalid_input", message: parsed.message }),
          },
        ];
      }

      const { atomId } = parsed;

      // --- Open registry + seed (lazy, cached) ---
      let registry: Registry;
      let seedResult: SeedResult;
      try {
        ({ registry, seedResult } = await getRegistryAndSeed());
      } catch (err) {
        return [
          {
            type: "text",
            text: JSON.stringify({
              error: "registry_unavailable",
              message: `Could not open or seed local registry: ${err instanceof Error ? err.message : String(err)}`,
            }),
          },
        ];
      }

      // --- Short-id → full-root resolution ---
      const resolved = resolveAtomId(atomId, seedResult.merkleRoots);

      if (resolved.kind === "not_found") {
        return [
          {
            type: "text",
            text: JSON.stringify({
              error: "not_found",
              message: `No atom found matching '${atomId}' in the local registry.`,
              atom_id: atomId,
            }),
          },
        ];
      }

      if (resolved.kind === "ambiguous") {
        return [
          {
            type: "text",
            text: JSON.stringify({
              error: "ambiguous_short_id",
              message: `Short id '${atomId}' matches ${resolved.matches.length} atoms. Retry with one of these full roots.`,
              atom_id: atomId,
              matches: resolved.matches,
            }),
          },
        ];
      }

      const entryRoot = resolved.root;

      // --- Assemble the artifact (prefers assemble() so multi-block atoms work) ---
      let artifact: Artifact;
      try {
        artifact = await assemble(entryRoot, registry, undefined, {
          knownMerkleRoots: seedResult.merkleRoots,
        });
      } catch (err) {
        return [
          {
            type: "text",
            text: JSON.stringify({
              error: "assembly_failed",
              message: `Assembly failed for ${entryRoot.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
              atom_id: atomId,
              root: entryRoot,
            }),
          },
        ];
      }

      // --- Return the write-ready source + manifest summary ---
      return [
        {
          type: "text",
          text: JSON.stringify(
            {
              atom_id: atomId,
              root: entryRoot,
              source: artifact.source,
              block_count: artifact.manifest.entries.length,
              manifest: artifact.manifest,
            },
            null,
            2,
          ),
        },
      ];
    },
  };
}

// ---------------------------------------------------------------------------
// Default production registry opener
// ---------------------------------------------------------------------------

/**
 * Default registry opener for production use.
 *
 * Resolves the registry path from YAKCC_REGISTRY_PATH env var or falls back
 * to ".yakcc/registry.sqlite" relative to process.cwd().
 * Uses createOfflineEmbeddingProvider for deterministic, low-latency embeddings
 * (same approach as resolve.ts defaultOpenRegistry — DEC-HOOK-PHASE-3-L3-MCP-001-C).
 *
 * Note: compile does not use embeddings for root lookup, but openRegistry
 * requires an embedding provider for schema consistency. Offline provider
 * is zero-cost for operations that never query the vector index.
 */
async function defaultOpenRegistry(): Promise<Registry> {
  const { resolve } = await import("node:path");
  const { openRegistry } = await import("@yakcc/registry");
  const { createOfflineEmbeddingProvider } = await import("@yakcc/contracts");

  const DEFAULT_REGISTRY_PATH = ".yakcc/registry.sqlite";
  const registryPath =
    process.env.YAKCC_REGISTRY_PATH ?? resolve(process.cwd(), DEFAULT_REGISTRY_PATH);

  const provider = createOfflineEmbeddingProvider();
  return openRegistry(registryPath, { embeddings: provider });
}

// ---------------------------------------------------------------------------
// Default export — the production tool instance
// ---------------------------------------------------------------------------

/**
 * The default yakcc_compile tool module, registered in the TOOLS array.
 * Uses the production registry factory (lazy open, cached per process).
 *
 * Tests use createCompileTool({ openRegistry: mockFn }) instead.
 */
export const compileTool: ToolModule = createCompileTool();
