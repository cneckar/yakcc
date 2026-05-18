// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v3/harness/atom-sync.mjs
//
// @decision DEC-B4-V3-HARNESS-INTEGRATION-001
// @title B4-v3 atom extraction: shave pipeline integration for Phase 1
// @status accepted
// @rationale
//   Phase 1 generates code via Opus. After each emission this module opens the
//   per-run SQLite registry and runs the shave pipeline on the generated file.
//   The shave pipeline extracts intent cards and atom stubs; atoms are persisted
//   via registry.storeBlock() so Phase 2 hooked cells can query them via the MCP
//   server.
//
//   The per-run registry is isolated from the production registry (.yakcc/registry.sqlite)
//   to prevent attribution contamination (B2 in issue #668).
//
//   OFFLINE MODE (unit tests only): pass options.offline=true + options.cacheDir to
//   skip intent-extraction API calls and use seeded cache entries instead. Never use
//   offline mode in a real Phase 1 run — seeded intents are test fixtures, not real
//   behavioral descriptions.
//
// Exports:
//   syncAtoms({ implFile, registryPath, repoRoot, options? }) -> Promise<string[]>
//     Returns array of ShavedAtomStub.merkleRoot strings for atoms persisted in this call.
//     Returns [] if shave pipeline fails (logged to stderr; Phase 1 continues).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Open the per-run registry and run the shave pipeline on a generated impl file.
 *
 * @param {{
 *   implFile: string,       // absolute path to the TypeScript impl file
 *   registryPath: string,  // path for the per-run SQLite registry
 *   repoRoot: string,      // absolute path to the yakcc repo root
 *   options?: {            // passed through to shave()
 *     offline?: boolean,
 *     cacheDir?: string,
 *     useOfflineEmbeddings?: boolean, // true in tests to skip HuggingFace download
 *   },
 * }} params
 * @returns {Promise<string[]>} BlockMerkleRoot strings of persisted atoms
 */
export async function syncAtoms({ implFile, registryPath, repoRoot, options = {} }) {
  // Ensure the registry directory exists.
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

    // Open (or create) the per-run registry.
    // Production: use the local semantic embedding provider (DEC-V0-B4-EMBED-SWAP-001).
    // Tests: use the offline BLAKE3 provider (no network) via options.useOfflineEmbeddings.
    const embeddings = options.useOfflineEmbeddings
      ? createOfflineEmbeddingProvider()
      : createLocalEmbeddingProvider();
    registry = await openRegistry(registryPath, { embeddings });

    const result = await shave(implFile, registry, options);

    // Collect merkleRoot from each persisted atom stub in the shave result.
    // ShavedAtomStub.merkleRoot is populated only for novel atoms persisted to
    // the registry (undefined for pointer atoms / skipped atoms).
    const merkleRoots = (result.atoms ?? [])
      .map((a) => a.merkleRoot)
      .filter(Boolean);

    return merkleRoots;
  } catch (err) {
    process.stderr.write(
      `[atom-sync] shave pipeline failed for ${implFile}: ${err.message}\n` +
      '  Atoms were NOT written to the registry for this rep.\n' +
      '  Phase 1 continues; Phase 2 MCP queries for this task may return fewer atoms.\n'
    );
    return [];
  } finally {
    if (registry) {
      await registry.close().catch(() => {});
    }
  }
}
