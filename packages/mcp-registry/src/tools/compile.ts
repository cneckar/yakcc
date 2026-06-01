/**
 * Tool: yakcc_compile
 *
 * @decision DEC-1028-COMPILE-FULL-ROOTS-001
 * @title yakcc_compile — use full registry block roots for id-resolution and assembly
 * @status decided (wi-1028)
 * @rationale
 *   Prior to WI-1028, short-id prefix matching used seedRegistry().merkleRoots
 *   (~26 seed blocks). yakcc_resolve returns 8-char prefixes of BlockMerkleRoots
 *   from the FULL local registry, which can contain many non-seed atoms. Attempting
 *   to compile a non-seed atom (by short id) always returned not_found/"ghost
 *   reference" even though the atom was present in the registry.
 *
 *   Fix: enumerate the FULL registry block roots via
 *     for (const sh of await registry.enumerateSpecs())
 *       for (const root of await registry.selectBlocks(sh)) fullRoots.push(root);
 *   and use those roots for BOTH prefix matching (resolveAtomId) AND as
 *   knownMerkleRoots in assemble(). This is the canonical pattern used by
 *   packages/registry/src/rebuild.ts:104-112.
 *
 *   seedRegistry is retained so seed blocks are present in the local DB on first
 *   use, but its merkleRoots are no longer authoritative for id-resolution. After
 *   seeding, fullRoots is built from the registry itself — one authority.
 *
 *   Architecture decisions:
 *
 *   (1) LOCAL-ONLY (D-HOOK-6, Sacred Practice #12):
 *       The local registry is the sole authority. No HTTP fallback — compiling
 *       an atom that exists only in the global commons (not in the local DB)
 *       is not in scope for WI-1007 (follow-up WI).
 *
 *   (2) FULL-REGISTRY SHORT-ID RESOLUTION (one authority, WI-1028):
 *       An 8-char (or any non-64-char) atom_id is treated as a prefix against
 *       the FULL set of BlockMerkleRoots enumerated from the registry
 *       (enumerateSpecs → selectBlocks). Unique prefix → resolve; ambiguous →
 *       structured ambiguous_short_id content; no match → not_found.
 *       Full 64-char root passes straight through (no enumeration needed).
 *       One short-id authority; no parallel scheme.
 *
 *   (3) ASSEMBLE PREFERRED:
 *       Uses assemble() from @yakcc/compile (not just registry.getBlock().implSource)
 *       so multi-block composite atoms work correctly. The fullRoots from the
 *       full-registry enumeration are forwarded as the pre-scan stem index.
 *
 *   (4) ERROR DISCIPLINE (DEC-MCP-ERROR-AS-CONTENT-004):
 *       All errors returned as structured MCP content. The handler NEVER throws.
 *       Structured error codes: invalid_input, registry_unavailable,
 *       not_found, ambiguous_short_id, assembly_failed.
 *
 *   (5) LAZY REGISTRY OPEN + FULL-ROOTS CACHE:
 *       Registry opened once per tool instance (same pattern as resolve.ts).
 *       Full registry roots are enumerated once and cached alongside the registry.
 *       Factory injectable for tests.
 *
 *   Cross-references:
 *     DEC-HOOK-PROACTIVE-PRIMARY-001       — initiative umbrella
 *     DEC-MCP-ERROR-AS-CONTENT-004         — errors as content, never throw
 *     DEC-MCP-STDERR-LOGGING-005           — no stdout (no console.log)
 *     Sacred Practice #12                  — single authority for short-id resolution
 *     packages/registry/src/rebuild.ts:104 — canonical enumerateSpecs→selectBlocks pattern
 *
 * Implements: yakcc#1007, yakcc#1028
 */

import { assemble } from "@yakcc/compile";
import type { Artifact } from "@yakcc/compile";
import type { BlockMerkleRoot } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";
import { seedRegistry } from "@yakcc/seeds";
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
 * - Shorter string → prefix-match against knownRoots (FULL registry block set).
 *   Unique match → resolve. Multiple matches → ambiguous. Zero → not_found.
 *
 * This is the single short-id resolution authority for the MCP compile tool
 * (Sacred Practice #12, DEC-1028-COMPILE-FULL-ROOTS-001). knownRoots must
 * come from the full registry enumeration (enumerateSpecs → selectBlocks),
 * NOT from seedRegistry().merkleRoots, so non-seed atoms resolve correctly.
 */
function resolveAtomId(
  atomId: string,
  knownRoots: ReadonlyArray<BlockMerkleRoot>,
): ResolveIdResult {
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
 * once, seeded once, and the FULL block root set is enumerated once per tool
 * instance (DEC-1028-COMPILE-FULL-ROOTS-001). All three are cached so subsequent
 * calls pay zero setup cost.
 *
 * @param opts - Optional registry factory override (for tests).
 */
export function createCompileTool(opts?: CreateCompileToolOptions): ToolModule {
  // Lazy-cached registry + full block roots (opened/enumerated at most once per instance).
  let registryPromise: Promise<{ registry: Registry; fullRoots: BlockMerkleRoot[] }> | null = null;

  function getRegistryAndFullRoots(): Promise<{ registry: Registry; fullRoots: BlockMerkleRoot[] }> {
    if (registryPromise !== null) return registryPromise;
    const factory = opts?.openRegistry ?? defaultOpenRegistry;
    registryPromise = factory().then(async (registry) => {
      // Seed the registry so seed blocks are present for resolution and assembly.
      // seedRegistry is idempotent (INSERT OR IGNORE) — safe on an already-seeded DB.
      await seedRegistry(registry);

      // Enumerate the FULL registry block root set (DEC-1028-COMPILE-FULL-ROOTS-001).
      // This is the canonical pattern from packages/registry/src/rebuild.ts:104-112.
      // Using seed roots alone misses non-seed atoms returned by yakcc_resolve.
      const fullRoots: BlockMerkleRoot[] = [];
      const specHashes = await registry.enumerateSpecs();
      for (const sh of specHashes) {
        const roots = await registry.selectBlocks(sh);
        for (const root of roots) fullRoots.push(root);
      }

      return { registry, fullRoots };
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

      // --- Open registry + seed + enumerate full roots (lazy, cached) ---
      let registry: Registry;
      let fullRoots: BlockMerkleRoot[];
      try {
        ({ registry, fullRoots } = await getRegistryAndFullRoots());
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

      // --- Short-id → full-root resolution (against FULL registry, not seed-only) ---
      const resolved = resolveAtomId(atomId, fullRoots);

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
          knownMerkleRoots: fullRoots,
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
 * Delegates to openRegistryMatchingStoredProvider so the registry opens
 * successfully against BOTH local-embedded (Xenova/bge-small-en-v1.5) and
 * offline-embedded (yakcc/offline-blake3-stub) registries. Previously used
 * createOfflineEmbeddingProvider explicitly, which threw a provider-mismatch
 * error against any standard local-embedded registry (issue #1069).
 *
 * @decision DEC-1069-REFEMIT-PROVIDER-001
 */
async function defaultOpenRegistry(): Promise<Registry> {
  const { resolveDefaultRegistryPath, openRegistryMatchingStoredProvider } = await import(
    "./registry-open.js"
  );
  const registryPath = await resolveDefaultRegistryPath();
  return openRegistryMatchingStoredProvider(registryPath);
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
