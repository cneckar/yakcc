// SPDX-License-Identifier: MIT
// survey.test.ts — Sampled cold-pass survey of wave-3 lowering gaps.
//
// @decision DEC-V1-WAVE-4-WASM-SURVEY-001
// @title Sampled survey shaves packages/seeds/src/blocks/*/impl.ts to populate
//   pending-atoms.json with categorized LoweringError reasons.
// @status decided (WI-V1W4-LOWER-EXTEND-SURVEY-001)
// @rationale
//   The full packages/*/src walk is structurally infeasible without a deferred
//   cold-pass infra step (see WI-V1W4-LOWER-PARITY-CACHE-001). The sampled
//   subset (~20 small seed-block atoms) gives wave-4 a starting roadmap of
//   categorized LoweringError gaps that can be split into per-capability
//   WI-V1W4-LOWER-EXTEND-* followup WIs. The pending-atoms.json header
//   documents this sample scope so reviewers don't mistake it for full coverage.
//
//   Production sequence exercised by this test:
//     collectSeedImplFiles()                         [enumerate seed blocks]
//     -> regenerateCorpus({ sourceFiles })           [shave seed-block subset]
//     -> for each atom: wasmBackend().emit(res)      [attempt lowering]
//     -> classifyError() on failure                  [categorize LoweringError]
//     -> writePendingAtoms(PENDING_PATH, atoms)      [persist results]
//     -> saveCache(CACHE_PATH, ...)                  [populate shave-cache.json]
//
//   This test does NOT modify wave-3 lowering source to make atoms pass — it
//   categorizes failures for actionable followup WIs per the dispatch contract.
//   Every shaved atom ends up in either covered OR pending (Sacred Practice #5).

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tsBackend, wasmBackend } from "@yakcc/compile";
import type { ResolutionResult, ResolvedBlock } from "@yakcc/compile";
import {
  type BlockMerkleRoot,
  type LocalTriplet,
  type SpecYak,
  blockMerkleRoot,
  specHash,
} from "@yakcc/contracts";
import {
  type PendingAtom,
  loadPendingAtoms,
  regenerateCorpus,
  writePendingAtoms,
} from "./corpus-loader.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const _dir = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(_dir, "shave-cache.json");
const PENDING_PATH = join(_dir, "pending-atoms.json");

// Locate the repo root: walk up from _dir to find pnpm-workspace.yaml.
// Using a self-contained finder here so this file has no build-time dep on
// corpus-loader internals and remains independently runnable.
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

const REPO_ROOT = findRepoRoot(_dir);
const SEEDS_BLOCKS_DIR = join(REPO_ROOT, "packages", "seeds", "src", "blocks");

// ---------------------------------------------------------------------------
// LoweringError duck-typing (mirrors closer-parity.test.ts pattern)
// @decision DEC-V1-WAVE-4-WASM-SURVEY-001 (same WI)
// LoweringError is not re-exported from @yakcc/compile (packages/** out-of-scope).
// Duck-typing: Error with name === "LoweringError" and a string `kind` field.
// ---------------------------------------------------------------------------

type LoweringErrorKind =
  | "unsupported-node"
  | "unsupported-capture"
  | "unsupported-runtime-closure"
  | "type-mismatch"
  | "no-export"
  | string;

interface LoweringErrorLike extends Error {
  readonly kind: LoweringErrorKind;
}

function isLoweringError(err: unknown): err is LoweringErrorLike {
  return (
    err instanceof Error &&
    err.name === "LoweringError" &&
    typeof (err as unknown as Record<string, unknown>)["kind"] === "string"
  );
}

// ---------------------------------------------------------------------------
// ResolutionResult synthesis helpers
// (replicated from closer-parity.test.ts — kept minimal; no cross-test import)
// ---------------------------------------------------------------------------

const MINIMAL_MANIFEST_JSON = JSON.stringify({
  artifacts: [{ kind: "property_tests", path: "tests.fast-check.ts" }],
});

function makeSpecYakLocal(name: string, behavior: string): SpecYak {
  return {
    name,
    inputs: [{ name: "a", type: "number" }],
    outputs: [{ name: "result", type: "number" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior,
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe" },
    propertyTests: [],
  };
}

function makeMerkleRootLocal(name: string, behavior: string, implSource: string): BlockMerkleRoot {
  const spec = makeSpecYakLocal(name, behavior);
  const manifest = JSON.parse(MINIMAL_MANIFEST_JSON) as {
    artifacts: Array<{ kind: string; path: string }>;
  };
  const artifactBytes = new TextEncoder().encode(implSource);
  const artifactsMap = new Map<string, Uint8Array>();
  for (const art of manifest.artifacts) {
    artifactsMap.set(art.path, artifactBytes);
  }
  return blockMerkleRoot({
    spec,
    implSource,
    manifest: manifest as LocalTriplet["manifest"],
    artifacts: artifactsMap,
  });
}

function makeResolutionLocal(
  blocks: ReadonlyArray<{ id: BlockMerkleRoot; source: string }>,
): ResolutionResult {
  const blockMap = new Map<BlockMerkleRoot, ResolvedBlock>();
  const order: BlockMerkleRoot[] = [];
  for (const { id, source } of blocks) {
    const sh = specHash(makeSpecYakLocal(id.slice(0, 8), `behavior-${id.slice(0, 8)}`));
    blockMap.set(id, { merkleRoot: id, specHash: sh, source, subBlocks: [] });
    order.push(id);
  }
  const entry = order[order.length - 1] as BlockMerkleRoot;
  return { entry, blocks: blockMap, order };
}

/** Build a synthetic ResolutionResult for a single-function atom source. */
function makeSingleBlockResolutionLocal(fnSource: string): ResolutionResult {
  const fnName = fnSource.match(/export\s+function\s+(\w+)/)?.[1] ?? "fn";
  const id = makeMerkleRootLocal(fnName, `${fnName} substrate`, fnSource);
  return makeResolutionLocal([{ id, source: fnSource }]);
}

// ---------------------------------------------------------------------------
// Seed-block file collection
// ---------------------------------------------------------------------------

/**
 * Collect all impl.ts files under packages/seeds/src/blocks/<blockName>/impl.ts.
 * Returns paths sorted alphabetically for deterministic survey order.
 */
function collectSeedImplFiles(): string[] {
  const files: string[] = [];
  if (!existsSync(SEEDS_BLOCKS_DIR)) {
    return files;
  }
  for (const blockName of readdirSync(SEEDS_BLOCKS_DIR).sort()) {
    const blockDir = join(SEEDS_BLOCKS_DIR, blockName);
    try {
      if (!statSync(blockDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const implPath = join(blockDir, "impl.ts");
    if (existsSync(implPath)) {
      files.push(implPath);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify a thrown error during wasmBackend().emit() into a PendingAtom.
 *
 * LoweringError detection mirrors closer-parity.test.ts. Non-LoweringError
 * errors are classified as 'other' to satisfy Sacred Practice #5 (every atom
 * ends up in covered or pending — no silent skips).
 *
 * The reason string is capped at 200 chars to keep pending-atoms.json readable.
 */
function classifyError(
  err: unknown,
  atom: { canonicalAstHash: string; sourcePath: string },
): PendingAtom {
  if (isLoweringError(err)) {
    const category =
      err.kind === "unsupported-runtime-closure"
        ? ("unsupported-runtime-closure" as const)
        : ("lowering-error" as const);
    const reason = `LoweringError (${err.kind}): ${err.message}`.slice(0, 200);
    return {
      canonicalAstHash: atom.canonicalAstHash,
      sourcePath: atom.sourcePath,
      reason,
      category,
    };
  }

  // Unexpected / non-lowering error: classify as 'other' so the atom is
  // not silently dropped from the partition (Sacred Practice #5).
  const msg = err instanceof Error ? err.message : String(err);
  const reason = `other: ${msg}`.slice(0, 200);
  return {
    canonicalAstHash: atom.canonicalAstHash,
    sourcePath: atom.sourcePath,
    reason,
    category: "other",
  };
}

// ---------------------------------------------------------------------------
// Survey test
// ---------------------------------------------------------------------------

describe("WI-V1W4-LOWER-EXTEND-SURVEY-001 sampled cold-pass survey", () => {
  it(
    "shaves seed-block subset, categorizes LoweringErrors, persists pending-atoms.json + shave-cache.json",
    async () => {
      const sourceFiles = collectSeedImplFiles();
      console.log(`[survey] sampling ${sourceFiles.length} seed-block impl.ts files`);
      console.log(`[survey] SEEDS_BLOCKS_DIR: ${SEEDS_BLOCKS_DIR}`);

      expect(
        sourceFiles.length,
        `Expected at least 1 seed-block impl.ts in ${SEEDS_BLOCKS_DIR}`,
      ).toBeGreaterThan(0);

      // Step 1: Shave the sampled subset, populating shave-cache.json.
      // regenerateCorpus uses the sourceFiles override path — only these 20 files
      // are shaved instead of the full packages walk (DEC-V1-WAVE-4-WASM-PARITY-CORPUS-SOURCEWALK-001).
      const corpus = await regenerateCorpus(CACHE_PATH, { sourceFiles });
      console.log(
        `[survey] corpus: ${corpus.size} unique atoms from ${corpus.filesWalked} files` +
          ` (${corpus.cacheHits} cache hits, ${corpus.cacheMisses} misses, ${corpus.shaveFailures} failures)`,
      );

      // Step 2: For each atom, attempt WASM lowering. Classify failures.
      const pendingAtoms: PendingAtom[] = [];
      let coveredCount = 0;
      const categoryTally: Record<string, number> = {};

      for (const [hash, atom] of corpus.atoms) {
        try {
          const resolution = makeSingleBlockResolutionLocal(atom.implSource);
          // Attempt wasm emit — if this succeeds, the atom is covered.
          await wasmBackend().emit(resolution);
          // Also verify ts-backend emits non-empty output (mirrors closer-parity pattern).
          const tsOut = await tsBackend().emit(resolution);
          expect(
            tsOut.length,
            `ts-backend output empty for atom ${hash.slice(0, 16)}`,
          ).toBeGreaterThan(0);
          coveredCount++;
        } catch (err) {
          const pending = classifyError(err, { canonicalAstHash: hash, sourcePath: atom.sourcePath });
          pendingAtoms.push(pending);
          categoryTally[pending.category] = (categoryTally[pending.category] ?? 0) + 1;
        }
      }

      // Step 3: Merge with any pre-existing pending atoms.
      // Preserve prior state (reason, category) but upgrade sourcePath when the
      // prior entry has a registry: fallback and this run resolved a real path.
      // This handles the corpus-provenance fix (WI-V1W4-LOWER-EXTEND-CORPUS-PROVENANCE-001):
      // the prior pending-atoms.json was written before the merkleRoot→sourcePath map
      // was implemented, so all entries carried "registry:<hash>" labels. On re-run,
      // the corpus-loader now provides real file paths — the merge should absorb them.
      const preExisting = loadPendingAtoms(PENDING_PATH);
      const newByHash = new Map(pendingAtoms.map((p) => [p.canonicalAstHash, p]));
      const mergedPending: PendingAtom[] = preExisting.map((existing) => {
        const updated = newByHash.get(existing.canonicalAstHash);
        if (
          updated !== undefined &&
          existing.sourcePath !== null &&
          existing.sourcePath.startsWith("registry:") &&
          updated.sourcePath !== null &&
          !updated.sourcePath.startsWith("registry:")
        ) {
          // Upgrade the sourcePath from registry fallback to real path; keep
          // other fields (reason, category) from the existing entry so edits
          // made by prior implementers are not silently overwritten.
          return { ...existing, sourcePath: updated.sourcePath };
        }
        return existing;
      });
      // Append genuinely new atoms (not in the pre-existing list at all).
      const existingHashes = new Set(preExisting.map((p) => p.canonicalAstHash));
      for (const p of pendingAtoms) {
        if (!existingHashes.has(p.canonicalAstHash)) {
          mergedPending.push(p);
        }
      }

      // Step 4: Persist pending-atoms.json.
      writePendingAtoms(PENDING_PATH, mergedPending);

      // Step 5: Print evidence summary.
      console.log(`[survey] covered: ${coveredCount}/${corpus.size}`);
      console.log(`[survey] pending (new this run): ${pendingAtoms.length}`);
      console.log(`[survey] pending (total after merge): ${mergedPending.length}`);
      console.log(`[survey] category breakdown:`, categoryTally);
      console.log(`[survey] shave-cache.json written: ${CACHE_PATH}`);
      console.log(`[survey] pending-atoms.json written: ${PENDING_PATH}`);

      // Log representative samples for each category (up to 3 per category).
      for (const [cat, count] of Object.entries(categoryTally)) {
        const samples = pendingAtoms
          .filter((p) => p.category === cat)
          .slice(0, 3)
          .map((p) => `  hash=${p.canonicalAstHash.slice(0, 16)} path=${p.sourcePath} reason=${p.reason.slice(0, 80)}`);
        console.log(`[survey] category '${cat}' (${count} atoms):`);
        for (const s of samples) {
          console.log(s);
        }
      }

      // Acceptance assertions (per dispatch contract):
      // 1. Corpus must be non-empty.
      expect(corpus.size).toBeGreaterThan(0);

      // 2. Partition completeness: every atom is in exactly one of covered or pending.
      expect(coveredCount + pendingAtoms.length).toBe(corpus.size);

      // 3. Survey must be non-empty (at least one atom total).
      expect(coveredCount + pendingAtoms.length).toBeGreaterThan(0);
    },
    300_000, // 5-minute timeout for the sampled shave run
  );
});
