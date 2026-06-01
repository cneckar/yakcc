/**
 * Shared registry opener for MCP tools that do not use embeddings.
 *
 * @decision DEC-1069-REFEMIT-PROVIDER-001
 * @title openRegistryMatchingStoredProvider — detect stored embedding model, open with matching provider
 * @status decided (wi-1069)
 * @rationale
 *   yakcc_reference and yakcc_compile do not use vector search, but openRegistry
 *   requires an embedding provider whose modelId matches the one used to build the
 *   registry (packages/registry enforces a provider-consistency guard at open time).
 *
 *   Standard production registries are embedded with createLocalEmbeddingProvider
 *   (Xenova/bge-small-en-v1.5); bootstrap/offline registries use
 *   createOfflineEmbeddingProvider (yakcc/offline-blake3-stub). Passing the wrong
 *   explicit provider throws "Registry was embedded with model X, but current
 *   provider uses Y" → registry_unavailable mismatch error in reference/compile.
 *
 *   Fix: probe the stored model before opening.
 *   Strategy: try opening with the local provider first (covers the standard
 *   production case). If openRegistry throws with reason="embedding_model_mismatch",
 *   fall back to the offline provider. Both attempts use explicit providers so the
 *   guard fires loudly — no silent model rewrites (DEC-EMBED-REGISTRY-META-002).
 *
 *   Why try-local-first, not no-provider: passing no explicit provider would
 *   suppress the guard entirely (callerSetExplicitProvider=false), which can
 *   silently attach the wrong provider to the Registry object. The try-then-match
 *   approach guarantees the attached provider matches the stored one — correct
 *   behaviour if embedding is ever exercised on a reference/compile code path.
 *
 *   Why not raw SQLite probe: would require a direct better-sqlite3 dependency in
 *   mcp-registry; the two-provider fallback chain covers all current production
 *   cases without pulling in a new dep.
 *
 *   Single authority: reference.ts and compile.ts both call this helper — no
 *   duplicate defaultOpenRegistry implementations (Sacred Practice #12).
 *
 *   Error contract: any open failure other than embedding_model_mismatch is
 *   re-thrown; the caller is responsible for wrapping in errorContent.
 *
 * @see packages/registry/src/storage.ts — DEC-EMBED-REGISTRY-META-002 (guard behaviour)
 * Implements: yakcc#1069
 */

import type { Registry } from "@yakcc/registry";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the registry path from env or default, then open it with a provider
 * that matches the stored embedding model.
 *
 * Algorithm:
 *   1. Try openRegistry with createLocalEmbeddingProvider (covers Xenova/bge-small
 *      and all LOCAL_KNOWN_MODELS registries).
 *   2. If that throws with reason="embedding_model_mismatch", retry with
 *      createOfflineEmbeddingProvider (covers yakcc/offline-blake3-stub).
 *   3. Any other error is re-thrown directly.
 *
 * @param registryPath Absolute path to the registry SQLite file.
 * @returns Registry opened with the matching embedding provider.
 * @throws {Error} If the registry cannot be opened for reasons other than
 *   a recoverable provider mismatch.
 */
export async function openRegistryMatchingStoredProvider(registryPath: string): Promise<Registry> {
  const { openRegistry } = await import("@yakcc/registry");
  const { createLocalEmbeddingProvider, createOfflineEmbeddingProvider } = await import(
    "@yakcc/contracts"
  );

  // Step 1: try local provider (production default — Xenova/bge-small-en-v1.5
  // or any LOCAL_KNOWN_MODELS entry).
  try {
    return await openRegistry(registryPath, {
      embeddings: createLocalEmbeddingProvider(),
    });
  } catch (err) {
    // Re-throw anything that is not a recoverable provider mismatch.
    if (!isProviderMismatchError(err)) {
      throw err;
    }
  }

  // Step 2: local provider did not match — try the offline deterministic
  // provider (yakcc/offline-blake3-stub). If this also mismatches, the error
  // propagates to the caller as a genuine registry_unavailable condition.
  return openRegistry(registryPath, {
    embeddings: createOfflineEmbeddingProvider(),
  });
}

/**
 * Resolve the default registry path for MCP tool use.
 *
 * Priority:
 *   1. YAKCC_REGISTRY_PATH env var (absolute or relative to cwd)
 *   2. ".yakcc/registry.sqlite" relative to process.cwd()
 */
export async function resolveDefaultRegistryPath(): Promise<string> {
  const { resolve } = await import("node:path");
  const DEFAULT_REGISTRY_PATH = ".yakcc/registry.sqlite";
  return process.env.YAKCC_REGISTRY_PATH ?? resolve(process.cwd(), DEFAULT_REGISTRY_PATH);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True if `err` is the specific embedding-model-mismatch error from openRegistry. */
function isProviderMismatchError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as Error & { reason?: string }).reason === "embedding_model_mismatch"
  );
}
