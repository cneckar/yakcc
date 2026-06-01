/**
 * Tool: yakcc_reference
 *
 * @decision DEC-COMPOSE-BY-REF-REFERENCE-TOOL-001
 * @title yakcc_reference — compose-by-reference MCP tool (epic #1043 [4/6])
 * @status decided (wi-1047)
 * @rationale
 *   The compose-by-reference design (DEC-V3-DISCOVERY-D4-001) lets the model emit
 *   a ~10-token import line instead of writing a full implementation (~100–500 tokens).
 *   yakcc_compile returns the full assembled source; yakcc_reference returns ONLY the
 *   reference artifact: manifest_entry, import_line, and the .d.ts declaration needed
 *   for the import to typecheck. No implementation body is ever present in the response.
 *
 *   Call sequence (post WI-1047):
 *     1. yakcc_resolve → auto_accept candidate (top score > 0.92)
 *     2. yakcc_reference({ atom_id }) → { manifest_entry, import_line, dts_ref }
 *     3. Model writes `import_line` into source, writes `dts_ref.dts` to `dts_ref.path`,
 *        and appends `manifest_entry` to `.yakcc/manifest.json` via yakcc_reference's
 *        manifest_entry field.
 *     4. `yakcc build` later materialises the implementation from the manifest.
 *
 *   Architecture decisions:
 *
 *   (1) SAME SHORT-ID RESOLVER AS COMPILE (DEC-1028-COMPILE-FULL-ROOTS-001):
 *       resolveAtomId() is copied from compile.ts (a pure helper). Both tools
 *       use the same logic: full 64-char hex passthrough, prefix match against
 *       fullRoots (enumerateSpecs → selectBlocks). No new resolver authority
 *       (Sacred Practice #12).
 *
 *   (2) NO IMPLEMENTATION BODY:
 *       Unlike yakcc_compile, this tool NEVER calls assemble(). It uses
 *       registry.getBlock() to obtain the block row, then derives the symbol,
 *       builds the reference artifact via @yakcc/compile authority functions,
 *       and returns the result. Absence of the impl body is the defining property.
 *
 *   (3) SYMBOL DERIVATION — EXTRACT FROM IMPL SOURCE (single authority):
 *       The bound export symbol is extracted from the block's implSource via
 *       extractFunctionName() (regex; the same pattern used by assemble.ts
 *       buildStemSpecHashIndex). Falls back to stemToCamelCase(spec.name) if no
 *       export function declaration is found (e.g. const arrow exports).
 *       Both helpers are private to this file — no cross-package symbol authority.
 *
 *   (4) REFERENCE ARTIFACT via @yakcc/compile (single authorities):
 *       - addReference(emptyManifest(), {root, symbol}) → manifest_entry
 *       - referenceImportLine(reference) → import_line
 *       - materializedDtsPath(reference.alias) → dts_ref.path
 *       - generateAtomDts(spec, symbol) → dts_ref.dts
 *       No re-implementation of any of these (Sacred Practice #12).
 *
 *   (5) ERROR DISCIPLINE (DEC-MCP-ERROR-AS-CONTENT-004):
 *       Handler NEVER throws. Structured error codes: invalid_input,
 *       registry_unavailable, not_found, ambiguous_short_id.
 *
 *   (6) LAZY REGISTRY OPEN + FULL-ROOTS CACHE:
 *       Same pattern as compile.ts (DEC-1028-COMPILE-FULL-ROOTS-001).
 *       Registry opened once per tool instance; fullRoots enumerated once; both cached.
 *
 *   Cross-references:
 *     DEC-COMPOSE-BY-REF-MANIFEST-001       — manifest / addReference / importPath authority
 *     DEC-COMPOSE-BY-REF-DTS-001            — generateAtomDts authority
 *     DEC-1028-COMPILE-FULL-ROOTS-001       — full-registry enumeration pattern
 *     DEC-MCP-ERROR-AS-CONTENT-004          — errors as content, never throw
 *     DEC-MCP-TOOLS-REGISTRY-020            — TOOLS array authority
 *     Sacred Practice #12                   — single authority per domain
 *
 * Implements: yakcc#1047 (epic #1043 [4/6])
 */

import {
  addReference,
  emptyManifest,
  generateAtomDts,
  materializedDtsPath,
  referenceImportLine,
} from "@yakcc/compile";
import type { BlockMerkleRoot, SpecYak } from "@yakcc/contracts";
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
  return { ok: true, atomId };
}

// ---------------------------------------------------------------------------
// Short-id → full-root resolution (mirrored from compile.ts, single authority)
// ---------------------------------------------------------------------------

type ResolveIdResult =
  | { kind: "full"; root: BlockMerkleRoot }
  | { kind: "ambiguous"; matches: string[] }
  | { kind: "not_found" };

/**
 * Resolve a possibly-short atom_id to a unique BlockMerkleRoot.
 *
 * Mirrors the identical helper in compile.ts (DEC-1028-COMPILE-FULL-ROOTS-001).
 * Kept as a private copy to avoid compile.ts changes (forbidden per scope manifest).
 *
 * - 64-char hex string → pass straight through as BlockMerkleRoot.
 * - Shorter string → prefix-match against knownRoots (FULL registry block set).
 *   Unique match → resolve. Multiple matches → ambiguous. Zero → not_found.
 */
function resolveAtomId(
  atomId: string,
  knownRoots: ReadonlyArray<BlockMerkleRoot>,
): ResolveIdResult {
  if (/^[a-f0-9]{64}$/i.test(atomId)) {
    return { kind: "full", root: atomId.toLowerCase() as BlockMerkleRoot };
  }

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
// Symbol derivation
// ---------------------------------------------------------------------------

/**
 * Convert a kebab-case name to camelCase (fallback for symbol derivation).
 *
 * Examples: "ascii-char" → "asciiChar", "non-ascii-rejector" → "nonAsciiRejector"
 *
 * Copied from packages/compile/src/assemble.ts (same function, same purpose).
 */
function stemToCamelCase(stem: string): string {
  return stem.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Extract the primary exported function name from a block impl source.
 *
 * Scans for the first "export function <name>" or "export async function <name>" line.
 * Returns null if none found.
 *
 * Copied from packages/compile/src/assemble.ts (same production-proven logic).
 * This avoids a ts-morph dependency in mcp-registry while using the same symbol
 * authority as the compile path. DEC-COMPOSE-BY-REF-REFERENCE-TOOL-001.
 */
function extractFunctionName(source: string): string | null {
  for (const line of source.split("\n")) {
    const match = line.match(/^export\s+(?:async\s+)?function\s+(\w+)\s*[(<]/);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/**
 * Derive the bound export symbol for a block.
 *
 * Strategy (single authority for symbol derivation):
 * 1. extractFunctionName from implSource — the primary, most accurate path.
 *    Matches the first `export function <name>` or `export async function <name>`.
 *    This is the same logic assemble.ts uses for stem → SpecHash indexing.
 * 2. stemToCamelCase(spec.name) — fallback for const/arrow exports where
 *    the function name isn't on a top-level export function declaration.
 *    The atom's spec.name is typically the kebab-case filename stem, so this
 *    yields the canonical camelCase export name (e.g. "ascii-char" → "asciiChar").
 */
function deriveSymbol(implSource: string, spec: SpecYak): string {
  const fromImpl = extractFunctionName(implSource);
  if (fromImpl !== null) {
    return fromImpl;
  }
  // Fall back to camelCase of spec.name.
  return stemToCamelCase(spec.name);
}

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

/**
 * Options for createReferenceTool().
 *
 * Tests inject openRegistry to avoid real SQLite access and to control the
 * registry content seen by the handler. Production uses the default factory.
 */
export interface CreateReferenceToolOptions {
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
 * Create a yakcc_reference ToolModule with an optionally injected registry factory.
 *
 * Handler is a closure over the lazy registry promise. The registry is opened
 * once, seeded once, and the FULL block root set is enumerated once per tool
 * instance (DEC-1028-COMPILE-FULL-ROOTS-001). All three are cached so subsequent
 * calls pay zero setup cost.
 *
 * @param opts - Optional registry factory override (for tests).
 *
 * @decision DEC-COMPOSE-BY-REF-REFERENCE-TOOL-001
 */
export function createReferenceTool(opts?: CreateReferenceToolOptions): ToolModule {
  // Lazy-cached registry + full block roots (opened/enumerated at most once per instance).
  let registryPromise: Promise<{ registry: Registry; fullRoots: BlockMerkleRoot[] }> | null = null;

  function getRegistryAndFullRoots(): Promise<{
    registry: Registry;
    fullRoots: BlockMerkleRoot[];
  }> {
    if (registryPromise !== null) return registryPromise;
    const factory = opts?.openRegistry ?? defaultOpenRegistry;
    registryPromise = factory().then(async (registry) => {
      // Seed the registry so seed blocks are present for resolution.
      // seedRegistry is idempotent (INSERT OR IGNORE) — safe on an already-seeded DB.
      await seedRegistry(registry);

      // Enumerate the FULL registry block root set (DEC-1028-COMPILE-FULL-ROOTS-001).
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
    name: "yakcc_reference",

    description: [
      "Return the REFERENCE ARTIFACT for a yakcc atom — the token-savings path vs yakcc_compile.",
      "Call this after yakcc_resolve returns an auto_accept candidate (top score > 0.92)",
      "or after selecting a candidate from a candidate_list, when you want to REFERENCE the",
      "atom (10-token import) rather than materialise its implementation (~100–500 tokens).",
      "",
      "Accepts either:",
      "  - An 8-character short id (the `atom_id` prefix from resolve candidates)",
      "  - A full 64-character BLAKE3 hex merkle root",
      "",
      "Returns { manifest_entry, import_line, dts_ref } — NO implementation body.",
      "  - manifest_entry: the AtomReference object to append to .yakcc/manifest.json",
      "  - import_line:    the ~10-token import statement to write into your source file",
      "  - dts_ref.path:   where to write the .d.ts so the import typechecks pre-build",
      "  - dts_ref.dts:    the .d.ts content to write to dts_ref.path",
      "",
      "After writing import_line and the .d.ts, run `yakcc build` to materialise the impl.",
      "",
      "Error codes:",
      "  - not_found         → atom not in local registry (seed or fetch first)",
      "  - ambiguous_short_id → prefix matches multiple atoms; use a longer prefix",
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

      // --- Fetch the block row (NO assembly — reference path only) ---
      let row: Awaited<ReturnType<Registry["getBlock"]>>;
      try {
        row = await registry.getBlock(entryRoot);
      } catch (err) {
        return [
          {
            type: "text",
            text: JSON.stringify({
              error: "registry_unavailable",
              message: `Registry error fetching block ${entryRoot.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
              atom_id: atomId,
              root: entryRoot,
            }),
          },
        ];
      }

      if (row === null) {
        return [
          {
            type: "text",
            text: JSON.stringify({
              error: "not_found",
              message: `Block ${entryRoot.slice(0, 8)} resolved from registry enumeration but getBlock returned null.`,
              atom_id: atomId,
              root: entryRoot,
            }),
          },
        ];
      }

      // --- Decode the spec from specCanonicalBytes ---
      let spec: SpecYak;
      try {
        spec = JSON.parse(new TextDecoder().decode(row.specCanonicalBytes)) as SpecYak;
      } catch (err) {
        return [
          {
            type: "text",
            text: JSON.stringify({
              error: "registry_unavailable",
              message: `Failed to decode spec for ${entryRoot.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
              atom_id: atomId,
              root: entryRoot,
            }),
          },
        ];
      }

      // --- Derive the bound export symbol ---
      // extractFunctionName matches the production pattern used by assemble.ts.
      // stemToCamelCase(spec.name) is the fallback for const/arrow exports.
      // DEC-COMPOSE-BY-REF-REFERENCE-TOOL-001.
      const symbol = deriveSymbol(row.implSource, spec);

      // --- Build the reference artifact via @yakcc/compile (single authorities) ---
      // addReference: computes alias (12-char prefix), importPath (.yakcc/atoms/<alias>)
      // referenceImportLine: the ~10-token import statement
      // materializedDtsPath: .yakcc/atoms/<alias>.d.ts
      // generateAtomDts: .d.ts text from spec signature (typechecks pre-build)
      let manifest_entry: ReturnType<typeof addReference>["reference"];
      let import_line: string;
      let dts_path: string;
      let dts_content: string;
      try {
        const { reference } = addReference(emptyManifest(), { root: entryRoot, symbol });
        manifest_entry = reference;
        import_line = referenceImportLine(reference);
        dts_path = materializedDtsPath(reference.alias);
        dts_content = generateAtomDts(spec, symbol);
      } catch (err) {
        return [
          {
            type: "text",
            text: JSON.stringify({
              error: "registry_unavailable",
              message: `Failed to build reference artifact for ${entryRoot.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
              atom_id: atomId,
              root: entryRoot,
            }),
          },
        ];
      }

      // --- Return the reference artifact (NO implementation body) ---
      return [
        {
          type: "text",
          text: JSON.stringify(
            {
              atom_id: atomId,
              root: entryRoot,
              manifest_entry,
              import_line,
              dts_ref: {
                path: dts_path,
                dts: dts_content,
              },
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
 * (same approach as compile.ts defaultOpenRegistry).
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
 * The default yakcc_reference tool module, registered in the TOOLS array.
 * Uses the production registry factory (lazy open, cached per process).
 *
 * Tests use createReferenceTool({ openRegistry: mockFn }) instead.
 */
export const referenceTool: ToolModule = createReferenceTool();
