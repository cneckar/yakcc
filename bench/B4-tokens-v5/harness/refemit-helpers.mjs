// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/harness/refemit-helpers.mjs
//
// @decision DEC-BENCH-B4-V5-REFEMIT-ARM-001
// @title Reference-emit arm helpers — oracle materializes resolved atom via assemble()
// @status accepted
// @rationale
//   The B4-v5 auto_accept hooked arm now measures the COMPOSE-BY-REFERENCE
//   (reference-emit) path (PROTOCOL.md DEC-BENCH-B4-V5-REFEMIT-ARM-001).
//   Previously the oracle parsed "yakcc compile <atom_id>" from model text and
//   fetched the impl via SQLite SELECT.  That approach had TWO problems:
//
//     1. The YAKCC_RESOLVE_TOOL_DEF description told the model "emit `yakcc compile
//        <atom_id>`" — which CONTRADICTED the discovery prompt's Section A
//        (reference-emit: call yakcc_reference + write only the import line).
//        The conflicting instruction forced the verbatim compile-emit path.
//
//     2. The oracle never verified that the resolved atom materializes correctly
//        via the real @yakcc/compile assemble() path.
//
//   This module fixes both:
//
//   ORACLE (materializeAtomSource):
//     On auto_accept, the harness ALREADY has the resolved atom's root from the
//     yakcc_resolve envelope (candidates[0]).  We materialize the impl body using
//     the REAL assemble(root, registry) from @yakcc/compile — the same path
//     yakcc_compile and `yakcc build` use.  This means:
//       - The oracle measures whether the resolved atom's materialized impl passes
//         the task oracle (the real correctness signal).
//       - It works regardless of what the model emits (import line or anything else)
//         — the economics are in the model output tokens (tiny import line vs full impl).
//       - fetchAtomImplSource is still used for quick impl_source reads, but assemble()
//         is the authority for the materialized artifact (single-pass DFS with sub-deps).
//
//   MANIFEST-PRESENT (writeManifestPresent):
//     The discovery prompt's Section A fires only when ".yakcc/manifest.json" is present
//     in the project.  This helper writes an empty manifest to a per-rep temp dir so
//     the hooked arm's "project" satisfies that precondition.
//
//   MCP TOOL DEF (YAKCC_REFERENCE_TOOL_DEF):
//     Definition of the yakcc_reference tool to expose to the model alongside
//     yakcc_resolve.  The inputSchema mirrors the production tool's schema
//     (atom_id required; project_root optional for apply-mode).
//
// Sacred Practice #12: materialize ONLY via the real @yakcc/compile assemble();
// resolve/reference via the real spawned mcp-registry. No fabricated numbers.
//
// Exports:
//   YAKCC_REFERENCE_TOOL_DEF   — tool definition to expose to the model
//   writeManifestPresent(dir)  — write empty .yakcc/manifest.json to dir
//   materializeAtomSource(registryPath, atomRoot) → { source: string } | { error: string }

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// yakcc_reference tool definition (exposed to model alongside yakcc_resolve)
// ---------------------------------------------------------------------------

/**
 * Tool definition for yakcc_reference to expose in the hooked arm's tools array.
 *
 * The inputSchema mirrors the production tool (packages/mcp-registry/src/tools/reference.ts):
 *   - atom_id (required): 8-char short id or full 64-char BLAKE3 hex merkle root
 *   - project_root (optional): absolute path for apply-mode (manifest+dts written by tool)
 *
 * This is what makes the discovery prompt's Section A fire correctly — the model
 * sees yakcc_reference as an available tool and calls it after yakcc_resolve returns
 * auto_accept, then writes only the import_line.
 */
export const YAKCC_REFERENCE_TOOL_DEF = {
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
    "APPLY MODE (recommended): pass `project_root` (absolute path to your project).",
    "  The tool writes the manifest entry to <project_root>/.yakcc/manifest.json",
    "  and the .d.ts to <project_root>/.yakcc/atoms/<alias>.d.ts automatically.",
    "  Returns ONLY { import_line, applied: true } — write ONLY the import_line.",
    "",
    "WITHOUT project_root (legacy): returns { manifest_entry, import_line, dts_ref }.",
    "  - import_line: the ~10-token import statement to write into your source file",
    "  - No implementation body is ever returned.",
    "",
    "After writing import_line, run `yakcc build` to materialise the impl.",
    "",
    "Error codes:",
    "  - not_found          => atom not in local registry (seed or fetch first)",
    "  - ambiguous_short_id => prefix matches multiple atoms; use a longer prefix",
    "  - apply_failed       => project_root unwritable or manifest unparseable",
  ].join("\n"),
  input_schema: {
    type: "object",
    required: ["atom_id"],
    properties: {
      atom_id: {
        type: "string",
        minLength: 1,
        description:
          "8-character short id (address prefix from yakcc_resolve) or full 64-char BLAKE3 hex merkle root.",
      },
      project_root: {
        type: "string",
        minLength: 1,
        description:
          "Absolute path to the project root. When provided, apply-mode writes the manifest entry and .d.ts; response contains only import_line (applied: true).",
      },
    },
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Manifest-present helper (Section A precondition)
// ---------------------------------------------------------------------------

/**
 * Write an empty .yakcc/manifest.json into a temp project dir so the discovery
 * prompt's Section A (reference-emit) fires for the hooked arm.
 *
 * The discovery prompt Section A is conditioned on ".yakcc/manifest.json" being
 * present in the project. When project_root is passed to yakcc_reference (apply-mode),
 * the tool reads and updates this manifest.
 *
 * @param {string} projectDir  Absolute path to the per-rep temp project directory.
 */
export function writeManifestPresent(projectDir) {
  const yakccDir = join(projectDir, ".yakcc");
  mkdirSync(yakccDir, { recursive: true });
  const manifestPath = join(yakccDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    // emptyManifest() equivalent: {"version":1,"references":[]}
    // Using the minimal form rather than importing @yakcc/compile here to keep
    // this file side-effect-free at import time (no registry open, no native deps).
    writeFileSync(manifestPath, JSON.stringify({ version: 1, references: [] }, null, 2), "utf8");
  }
}

// ---------------------------------------------------------------------------
// Atom materialization via @yakcc/compile assemble() (oracle authority)
// ---------------------------------------------------------------------------

// Resolve the true repo root that has packages/compile/dist installed.
// In a git worktree, process.env.YAKCC_REPO_ROOT should be set to the main repo.
// Fallback: walk up from __dirname until we find a root with compile dist.
function findRepoRoot() {
  const envRoot = process.env.YAKCC_REPO_ROOT;
  if (envRoot && existsSync(join(envRoot, "packages", "compile", "dist", "assemble.js"))) {
    return envRoot;
  }
  let candidate = resolve(__dirname, "../../..");
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(candidate, "packages", "compile", "dist", "assemble.js"))) {
      return candidate;
    }
    candidate = resolve(candidate, "..");
  }
  return resolve(__dirname, "../../..");
}

const REPO_ROOT = findRepoRoot();

// Lazy-cached registry instances per registryPath.
// We open WITHOUT an explicit embedding provider so openRegistry's
// callerSetExplicitProvider=false path is taken — this suppresses the
// embedding-model-mismatch throw for registries seeded with BGE (corpus/registry.sqlite).
// assemble() only calls getBlock() + selectBlocks() — no KNN search needed.
// (DEC-BENCH-B4-V5-REFEMIT-ARM-001: materialization does not require embeddings.)
const _registryCache = new Map();

async function getRegistry(registryPath) {
  if (_registryCache.has(registryPath)) return _registryCache.get(registryPath);

  // Import the production registry opener from workspace packages.
  // Do NOT pass an explicit embeddings option — assemble() only calls getBlock/selectBlocks
  // which are embedding-free; passing an explicit provider triggers the model-mismatch
  // guard in openRegistry when the corpus was embedded with a different model (BGE vs stub).
  const registryPkgDist = join(REPO_ROOT, "packages", "registry", "dist");

  const { openRegistry } = await import(
    new URL(`file://${join(registryPkgDist, "index.js")}`).href
  );

  // No embeddings option → callerSetExplicitProvider=false → mismatch guard suppressed.
  const registry = await openRegistry(registryPath);

  _registryCache.set(registryPath, registry);
  return registry;
}

/**
 * Materialize the full assembled source for an atom from its block_merkle_root.
 *
 * Uses the REAL @yakcc/compile assemble() — the same DFS resolver that
 * yakcc_compile and `yakcc build` use.  This is the authoritative oracle path
 * for auto_accept: it verifies the resolved atom's materialized impl passes the
 * task oracle, proving the reference-emit substitution is semantically correct.
 *
 * @param {string} registryPath  Absolute path to the registry SQLite file.
 * @param {string} atomRoot      The 64-char block_merkle_root (full root).
 * @returns {Promise<{source: string} | {error: string, failure_class: string}>}
 */
export async function materializeAtomSource(registryPath, atomRoot) {
  if (!existsSync(registryPath)) {
    return {
      error: `Registry not found: ${registryPath}`,
      failure_class: "atom_fetch_failed",
    };
  }

  if (!atomRoot || typeof atomRoot !== "string" || !/^[a-f0-9]{8,64}$/i.test(atomRoot)) {
    return {
      error: `Invalid atom root format: ${atomRoot}`,
      failure_class: "atom_fetch_failed",
    };
  }

  try {
    const registry = await getRegistry(registryPath);

    // Import assemble from the built @yakcc/compile package.
    const compileDist = join(REPO_ROOT, "packages", "compile", "dist");
    const { assemble } = await import(new URL(`file://${join(compileDist, "assemble.js")}`).href);

    // assemble() needs the full 64-char root; short IDs need to be resolved first.
    // For the bench oracle, candidates[0].root from yakcc_resolve is always the full root.
    const root = atomRoot.toLowerCase();

    const artifact = await assemble(root, registry);
    return { source: artifact.source };
  } catch (err) {
    return {
      error: `assemble() failed for ${atomRoot.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      failure_class: "atom_assemble_failed",
    };
  }
}
