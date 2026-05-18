// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v4/harness/atom-sync-v4.mjs
//
// @decision DEC-B4-V4-CORPUS-COMPOSITE-001
// @title B4-v4 atom sync: two-pass shave — fine-grained (L0) + coarse whole-impl
// @status accepted
// @rationale
//   DEC-BENCH-B4-V3-001 dossier root cause: B4-v3 Phase 1 produced 194 atoms ALL at
//   L0 leaf-level (avg 88 chars, max 1,601 chars). No whole-impl atom exists that a
//   weak model's intent query can find for a task-scale rescue.
//
//   Fix (Option A — issue #722): persist task-scale composite atoms by running a
//   second shave pass with maxControlFlowBoundaries=999 (effectively unlimited).
//   At this threshold the shave recursion treats the whole Opus solution as atomic
//   (no further decomposition), producing one "whole-impl" atom per generated file.
//   Both the fine-grained L0 atoms and the whole-impl atom are persisted to the same
//   registry. The MCP server's semantic search returns both; whole-impl atoms have a
//   broader spec (covers the full task intent) so they should match high-confidence
//   for task-level queries.
//
//   Why maxControlFlowBoundaries=999?
//   The shave isAtom() predicate deems a node non-atomic if its descendant CF count
//   exceeds maxControlFlowBoundaries (default=1, packages/shave/src/universalize/
//   atom-test.ts). A typical task implementation has 10–50 CF boundaries (ifs, loops,
//   switches). Setting maxControlFlowBoundaries=999 makes the root node atomic for
//   any realistic task implementation without changing the fine-grained default pass.
//   The exact value 999 is a safe upper bound; Infinity is not used because
//   RecursionOptions.maxControlFlowBoundaries is typed as number.
//
//   NEVER-SYNTHETIC invariant: both passes use the real shave() pipeline on real
//   Opus-generated source. No atom content is hand-crafted or LLM-fabricated.
//
// Exports:
//   syncAtoms(params)      — fine-grained shave (maxCF=1, same as B4-v3)
//   syncWholeImpl(params)  — coarse shave (maxCF=999, whole-impl atom)

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Run the standard fine-grained shave pipeline (maxControlFlowBoundaries=1).
 * Identical to B4-v3 atom-sync.mjs.
 */
export async function syncAtoms({ implFile, registryPath, repoRoot, options = {} }) {
  return _shaveFile({ implFile, registryPath, repoRoot, options, label: 'fine' });
}

/**
 * Run a coarse shave pass (maxControlFlowBoundaries=999) to persist a whole-impl atom.
 * Produces at most one atom per file: the root-level task implementation.
 * Returns [] if the file is empty or shave fails.
 */
export async function syncWholeImpl({ implFile, registryPath, repoRoot, options = {} }) {
  return _shaveFile({
    implFile,
    registryPath,
    repoRoot,
    options: {
      ...options,
      recursionOptions: { maxControlFlowBoundaries: 999 },
    },
    label: 'coarse',
  });
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

async function _shaveFile({ implFile, registryPath, repoRoot, options, label }) {
  mkdirSync(dirname(registryPath), { recursive: true });

  let registry;
  try {
    const { openRegistry } = await import(
      new URL(`file://${repoRoot}/packages/registry/dist/index.js`).href
    );
    const { createLocalEmbeddingProvider, createOfflineEmbeddingProvider } = await import(
      new URL(`file://${repoRoot}/packages/contracts/dist/index.js`).href
    );
    const { shave } = await import(
      new URL(`file://${repoRoot}/packages/shave/dist/index.js`).href
    );

    const embeddings = options.useOfflineEmbeddings
      ? createOfflineEmbeddingProvider()
      : createLocalEmbeddingProvider();
    registry = await openRegistry(registryPath, { embeddings });

    const result = await shave(implFile, registry, options);

    const merkleRoots = (result.atoms ?? [])
      .map((a) => a.merkleRoot)
      .filter(Boolean);

    return merkleRoots;
  } catch (err) {
    process.stderr.write(
      `[atom-sync-v4:${label}] shave pipeline failed for ${implFile}: ${err.message}\n` +
      '  Atoms were NOT written to the registry for this rep.\n',
    );
    return [];
  } finally {
    if (registry) {
      await registry.close().catch(() => {});
    }
  }
}
