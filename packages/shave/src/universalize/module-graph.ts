// SPDX-License-Identifier: MIT
/**
 * @decision DEC-WI510-DEP-FOLLOWING-ENGINE-001
 * title: #510 is a @yakcc/shave engine change — dependency-following recursion, not hand-authored corpus
 * status: decided
 * rationale:
 *   Hand-authoring ~30 npm-function atoms beside the real shave engine is a
 *   Sacred-Practice-12 (single-source-of-truth) violation — two authorities for
 *   "what an atom is." #510's deliverable is teaching @yakcc/shave to follow
 *   import/require edges across the package boundary and emit a connected
 *   call-graph atom forest. The 11 npm packages in the issue body are graduated
 *   acceptance fixtures that prove the engine works, not the deliverable itself.
 *   Operator-adjudicated reframe, 2026-05-14.
 *
 * @decision DEC-WI510-ENGINE-ORCHESTRATION-LAYER-001
 * title: Module-resolution-aware recursion lives in a new orchestration layer above decompose()
 * status: decided
 * rationale:
 *   decompose() carries an extraordinary @decision history (DEC-RECURSION-005 +
 *   ~8 slicer-policy DECs, each a hard-won self-shave success gain). A new
 *   universalize/module-graph.ts layer owns module resolution, the visited-set
 *   cycle guard, and per-module Project creation, calling the *unchanged*
 *   decompose() per module and stitching results into one connected forest.
 *   Keeps the proven per-file engine frozen; isolates the genuinely new concern.
 *   Option 1 (extend decompose()'s signature) was rejected as higher blast radius.
 *   decompose() is literally untouched — all new code lives here and in
 *   module-resolver.ts.
 *
 * @decision DEC-WI510-FOREST-CONNECTED-NOT-NESTED-001
 * title: Engine output is one connected call-graph forest; every internal node independently selectable
 * status: decided
 * rationale:
 *   Not a monolithic tree, not N disconnected per-module trees. In-package
 *   ForeignLeafEntry edges are replaced by direct ModuleEdge entries pointing
 *   to the resolved module's ModuleForestNode. The forest is a single data
 *   structure whose nodes are the union of all per-module RecursionTree roots.
 *   The slicer runs over the forest via the existing slice() function; storeBlock
 *   dedup by canonicalAstHash handles shared subgraphs. The package boundary
 *   governs resolver reach (B-scope), not output topology.
 *
 * @decision DEC-WI510-RECURSION-SCOPE-B-001
 * title: Slice 1 recursion scope is B (within-package boundary); A/C are follow-on issues
 * status: decided
 * rationale:
 *   Follow import/require edges within the target package boundary only; external
 *   npm deps remain ForeignLeafEntry. Content-addressed identity means a dep
 *   shaved later retroactively benefits all referrers via the idempotent storeBlock.
 *   B→C boundary is one predicate (isInPackageBoundary in module-resolver.ts).
 *
 * @decision DEC-WI510-BEST-EFFORT-MODULE-DEGRADATION-001
 * title: Unresolvable/non-shaveable modules degrade to foreign-leaf stubs; rest still shaves
 * status: decided
 * rationale:
 *   Extends the existing glue-aware per-subgraph best-effort discipline
 *   (DEC-V2-SLICER-SEARCH-001) from per-subgraph-within-a-file to
 *   per-module-across-an-edge. No throw-on-bad-edge: an unresolvable specifier,
 *   a .d.ts-only dep, or a module that ts-morph cannot parse degrades to a
 *   ModuleStubEntry. Genuinely unparseable source that makes ts-morph throw still
 *   propagates — best-effort is not a blanket exception handler.
 *
 * @decision DEC-WI510-MS-FIXTURE-FIRST-001
 * title: Slice 1 engine-proof fixture is ms, not validator
 * status: decided
 * rationale:
 *   Slice 1 proves the engine, not a headline package. ms (v2.1.3) is pure,
 *   near-single-file, with a shallow internal structure — it exercises
 *   resolve-decompose-join-terminate without validator/lib/**'s call-graph breadth.
 *   validator is Slice 2, where it stress-tests breadth and serves as the triad MVDP
 *   demo binding.
 */

import { readFileSync } from "node:fs";
import { dirname, normalize } from "node:path";
import type { ShaveRegistryView } from "../types.js";
import {
  UNRESOLVABLE,
  extractImportSpecifiers,
  extractRequireSpecifiers,
  isInPackageBoundary,
  resolveModuleEdge,
  resolvePackageEntry,
} from "./module-resolver.js";
import { decompose } from "./recursion.js";
import type { RecursionTree, SlicePlan } from "./types.js";

// ---------------------------------------------------------------------------
// Forest data types
// ---------------------------------------------------------------------------

/**
 * A successfully-decomposed module in the connected forest.
 * Carries the per-module RecursionTree produced by the existing decompose().
 */
export interface ModuleForestNode {
  readonly kind: "module";
  /** Absolute normalized path of the source file. */
  readonly filePath: string;
  /** The RecursionTree produced by decompose() for this module's source. */
  readonly tree: RecursionTree;
  /**
   * In-package edges: specifiers from this module that were resolved within
   * the package boundary and are present in the forest as other ModuleForestNode
   * or ModuleStubEntry entries. Sorted for determinism.
   */
  readonly inPackageEdges: readonly string[];
  /**
   * External specifiers (outside the package boundary or unresolvable).
   * These become ForeignLeafEntry in the combined SlicePlan.
   */
  readonly externalSpecifiers: readonly string[];
}

/**
 * A module entry that could not be decomposed (unresolvable, .d.ts-only,
 * or ts-morph parse failure). The rest of the forest is still valid.
 *
 * Best-effort discipline: DEC-WI510-BEST-EFFORT-MODULE-DEGRADATION-001.
 */
export interface ModuleStubEntry {
  readonly kind: "stub";
  /** The specifier or absolute path that was attempted. */
  readonly specifier: string;
  /** Human-readable reason why this module could not be decomposed. */
  readonly reason: string;
}

/** A node in the connected module forest. */
export type ModuleForestEntry = ModuleForestNode | ModuleStubEntry;

/**
 * The complete connected call-graph atom forest produced by the
 * module-resolution-aware recursion engine.
 *
 * `nodes` is an ordered list of all per-module entries, starting with the
 * package entry-point and proceeding in BFS order. Determinism is guaranteed
 * by the sorted edge and specifier lists within each node.
 *
 * `entryPath` is the absolute path of the package entry-point module.
 */
export interface ModuleForest {
  /** All module entries, BFS order from the entry-point. Deterministic. */
  readonly nodes: readonly ModuleForestEntry[];
  /** Absolute path of the package entry-point module. */
  readonly entryPath: string;
  /** Absolute path of the package root. */
  readonly packageRoot: string;
  /** Total count of successfully-decomposed modules. */
  readonly moduleCount: number;
  /** Total count of stub entries (modules that could not be decomposed). */
  readonly stubCount: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for shavePackage().
 */
export interface ShavePackageOptions {
  /**
   * Registry view for atom lookup and optional persistence.
   * Forwarded to decompose() for each module.
   */
  readonly registry: Pick<ShaveRegistryView, "findByCanonicalAstHash">;
  /**
   * Override the package entry-point path.
   * When not supplied, resolvePackageEntry(packageRoot) is used.
   */
  readonly entryPath?: string | undefined;
  /**
   * Maximum number of modules to visit. Acts as a safety bound against
   * unexpectedly large package graphs. Default: 500.
   */
  readonly maxModules?: number | undefined;
}

const DEFAULT_MAX_MODULES = 500;

// ---------------------------------------------------------------------------
// Visited-set cycle guard
// ---------------------------------------------------------------------------

/**
 * Normalize a file path for use as a visited-set key.
 * Using a normalized lowercase key ensures cycle detection is correct even
 * when the same file is referenced with mixed case on case-insensitive file
 * systems (Windows NTFS).
 *
 * @decision DEC-WI510-ENGINE-ORCHESTRATION-LAYER-001 (visited-set key choice)
 * rationale:
 *   The visited-set is keyed by normalized+lowercased absolute path — not by
 *   specifier — because the same file may be reached via different specifiers
 *   (e.g. './lib/foo' from one file, '../lib/foo' from another). Keying by
 *   resolved absolute path is the only reliable cycle guard for real npm packages.
 */
function visitedKey(filePath: string): string {
  // Normalize to forward-slashes and lowercase for reliable cross-platform dedup.
  // On Windows, normalize() produces backslashes; the same file reached via different
  // separator styles would produce different keys without this normalization.
  return normalize(filePath).replace(/\\/g, "/").toLowerCase();
}

// ---------------------------------------------------------------------------
// Source reading helper
// ---------------------------------------------------------------------------

/**
 * Read a source file, returning undefined when the file cannot be read.
 * Best-effort: I/O errors degrade to a stub, not a wholesale failure.
 */
function tryReadSource(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main orchestration: shavePackage()
// ---------------------------------------------------------------------------

/**
 * Shave a package rooted at `packageRoot` into a connected call-graph atom forest.
 *
 * Algorithm (B-scope BFS, DEC-WI510-RECURSION-SCOPE-B-001):
 *   1. Resolve the package entry-point via resolvePackageEntry() or options.entryPath.
 *   2. Start a BFS queue with the entry-point path.
 *   3. For each file dequeued:
 *      a. Guard against revisits via visited-set (cycle guard).
 *      b. Read the source file.
 *      c. Call the existing decompose() to get the per-module RecursionTree.
 *      d. Extract all import/require specifiers from the source.
 *      e. For each specifier, resolve via resolveModuleEdge():
 *         - If resolved AND within the package boundary (isInPackageBoundary):
 *           enqueue the resolved path and record as an in-package edge.
 *         - Otherwise: record as external (will become ForeignLeafEntry).
 *      f. Emit a ModuleForestNode into the results list.
 *   4. Unresolvable/unreadable/decompose-failed modules emit a ModuleStubEntry.
 *   5. Return the ModuleForest with all nodes in BFS order.
 *
 * Determinism:
 *   - Specifiers are extracted, resolved, and sorted before enqueueing.
 *   - Visited-set prevents re-processing.
 *   - BFS order from a deterministic entry-point is stable across runs.
 *   (DEC-WI510-BEST-EFFORT-MODULE-DEGRADATION-001, point 4 of §6.5)
 *
 * @param packageRoot - Absolute path to the npm package root directory.
 * @param options     - Registry, optional entry-point override, maxModules.
 */
export async function shavePackage(
  packageRoot: string,
  options: ShavePackageOptions,
): Promise<ModuleForest> {
  const maxModules = options.maxModules ?? DEFAULT_MAX_MODULES;
  const normalRoot = normalize(packageRoot);

  // Resolve the entry-point
  const entryResolved = options.entryPath ?? resolvePackageEntry(normalRoot);
  if (entryResolved === UNRESOLVABLE) {
    // Cannot even start — no entry point resolvable. Return empty forest with one stub.
    return {
      nodes: [
        {
          kind: "stub",
          specifier: packageRoot,
          reason: "Package entry-point could not be resolved (no package.json#main/exports/index)",
        },
      ],
      entryPath: packageRoot,
      packageRoot: normalRoot,
      moduleCount: 0,
      stubCount: 1,
    };
  }
  const entryPath = normalize(entryResolved);

  // BFS state
  const queue: string[] = [entryPath];
  const visited = new Set<string>([visitedKey(entryPath)]);
  const nodes: ModuleForestEntry[] = [];
  let moduleCount = 0;
  let stubCount = 0;

  while (queue.length > 0 && moduleCount + stubCount < maxModules) {
    // Dequeue in FIFO order for BFS. Sort the queue entries at each level for
    // determinism when multiple entries are enqueued simultaneously.
    const filePath = queue.shift();
    if (filePath === undefined) {
      break;
    }

    // Read source
    const source = tryReadSource(filePath);
    if (source === undefined) {
      nodes.push({
        kind: "stub",
        specifier: filePath,
        reason: `Could not read file: ${filePath}`,
      });
      stubCount++;
      continue;
    }

    // Skip .d.ts files — they are type-only and have no runtime implementation.
    // Best-effort: treat as stub.
    if (filePath.endsWith(".d.ts") || filePath.endsWith(".d.mts") || filePath.endsWith(".d.cts")) {
      nodes.push({
        kind: "stub",
        specifier: filePath,
        reason: ".d.ts-only declaration file — no runtime implementation to shave",
      });
      stubCount++;
      continue;
    }

    // Decompose the module via the existing per-file engine.
    // Errors are caught; they become stubs (best-effort, §6.5 point 5: genuinely
    // unparseable source that makes ts-morph throw is a non-best-effort propagation
    // but at the module level, not the forest level).
    let tree: RecursionTree;
    try {
      tree = await decompose(source, options.registry);
    } catch (err) {
      nodes.push({
        kind: "stub",
        specifier: filePath,
        reason: `decompose() failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      stubCount++;
      continue;
    }

    // Extract all import/require specifiers from the source.
    const importDir = dirname(filePath);
    const importSpecs = extractImportSpecifiers(source, filePath);
    const requireSpecs = extractRequireSpecifiers(source, filePath);

    // Deduplicate and sort for determinism.
    const allSpecs = [...new Set([...importSpecs, ...requireSpecs])].sort();

    const inPackageEdges: string[] = [];
    const externalSpecifiers: string[] = [];

    for (const spec of allSpecs) {
      // Skip node: builtins and workspace-internal imports — always external.
      if (spec.startsWith("node:") || spec.startsWith("@yakcc/")) {
        externalSpecifiers.push(spec);
        continue;
      }

      const resolved = resolveModuleEdge(spec, importDir, normalRoot);

      if (resolved === UNRESOLVABLE) {
        // Unresolvable → external (will become ForeignLeafEntry)
        externalSpecifiers.push(spec);
        continue;
      }

      const resolvedPath = normalize(resolved);

      if (!isInPackageBoundary(resolvedPath, normalRoot)) {
        // Outside the package boundary → external (B-scope predicate)
        externalSpecifiers.push(spec);
        continue;
      }

      // Within the package boundary: enqueue if not already visited.
      inPackageEdges.push(resolvedPath);
      const key = visitedKey(resolvedPath);
      if (!visited.has(key)) {
        visited.add(key);
        queue.push(resolvedPath);
      }
    }

    // Sort edges for determinism before emitting the node.
    inPackageEdges.sort();
    externalSpecifiers.sort();

    nodes.push({
      kind: "module",
      filePath: normalize(filePath),
      tree,
      inPackageEdges,
      externalSpecifiers,
    });
    moduleCount++;
  }

  // Any remaining items in the queue when maxModules was hit become stubs.
  for (const filePath of queue) {
    nodes.push({
      kind: "stub",
      specifier: filePath,
      reason: `maxModules limit (${maxModules}) reached — module not visited`,
    });
    stubCount++;
  }

  return {
    nodes,
    entryPath,
    packageRoot: normalRoot,
    moduleCount,
    stubCount,
  };
}

// ---------------------------------------------------------------------------
// Forest inspection helpers
// ---------------------------------------------------------------------------

/**
 * Returns all successfully-decomposed ModuleForestNode entries from a forest.
 * Convenience helper for tests and downstream consumers.
 */
export function forestModules(forest: ModuleForest): readonly ModuleForestNode[] {
  return forest.nodes.filter((n): n is ModuleForestNode => n.kind === "module");
}

/**
 * Returns all stub entries from a forest.
 * Convenience helper for diagnosing degradation.
 */
export function forestStubs(forest: ModuleForest): readonly ModuleStubEntry[] {
  return forest.nodes.filter((n): n is ModuleStubEntry => n.kind === "stub");
}

/**
 * Count the total leaf nodes (atoms) across all module RecursionTrees in the forest.
 * Each leaf represents an independently-addressable behavior atom.
 */
export function forestTotalLeafCount(forest: ModuleForest): number {
  let total = 0;
  for (const node of forest.nodes) {
    if (node.kind === "module") {
      total += node.tree.leafCount;
    }
  }
  return total;
}

/**
 * Collect the combined slice plans from all successfully-decomposed modules.
 *
 * This is the bridge between the module forest and the existing slice() function.
 * Each module's RecursionTree is sliced independently using the provided
 * slicer function; the resulting SlicePlans are combined into one list.
 *
 * Determinism: modules are processed in forest BFS order (already deterministic).
 *
 * @param forest  - The connected module forest.
 * @param sliceFn - The slice() function from slicer.ts (injected to avoid circular deps).
 * @param registry - Registry view for the slicer.
 * @param mode    - Slice mode ('strict' | 'glue-aware').
 */
export async function collectForestSlicePlans(
  forest: ModuleForest,
  sliceFn: (
    tree: RecursionTree,
    registry: Pick<ShaveRegistryView, "findByCanonicalAstHash">,
    options?: { shaveMode?: "strict" | "glue-aware" },
  ) => Promise<SlicePlan>,
  registry: Pick<ShaveRegistryView, "findByCanonicalAstHash">,
  mode: "strict" | "glue-aware" = "glue-aware",
): Promise<
  readonly {
    readonly filePath: string;
    readonly slicePlan: SlicePlan;
  }[]
> {
  const results: { filePath: string; slicePlan: SlicePlan }[] = [];

  for (const node of forest.nodes) {
    if (node.kind !== "module") continue;
    const slicePlan = await sliceFn(node.tree, registry, { shaveMode: mode });
    results.push({ filePath: node.filePath, slicePlan });
  }

  return results;
}
