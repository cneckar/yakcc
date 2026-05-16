// SPDX-License-Identifier: MIT
//
// as-compile-cache.ts — Content-addressed compile cache for assemblyScriptBackend().emit()
//
// @decision DEC-AS-COMPILE-CACHE-001
// Title: Cache key = sha256(canonicalAstHash + "|" + ascVersion + "|" + ascFlagsHash).
//        Sole authority for compiled-wasm reuse in the parity test path.
// Status: decided (plans/wi-531-asc-compile-cache.md §DEC-AS-COMPILE-CACHE-001)
// Rationale:
//   Cold-cache closer-parity-as.test.ts runs exceed 60 min because asc is invoked
//   once per atom (4119+) via execFileSync — a new Node child process per call.
//   Caching the compiled WASM bytes keyed on (canonicalAstHash, ascVersion,
//   ascFlagsHash) lets warm runs skip the expensive shell-out entirely.
//   Key components:
//     - canonicalAstHash: atom identity from the shave corpus-loader (per-atom unique).
//     - ascVersion: from assemblyscript/package.json; version skew invalidates entries.
//     - ascFlagsHash: sha256 of the canonical asc flag array so flag changes invalidate.
//   No TTL — content-addressed only (wall-clock TTL is explicitly forbidden by workflow
//   contract per DEC-AS-COMPILE-CACHE-001 decision).
//
// @decision DEC-AS-COMPILE-CACHE-002
// Title: Two-level shard cache at <repoRoot>/tmp/yakcc-as-cache/; atomic-rename helper
//        inlined here (not lifted to a shared package yet).
// Status: decided (plans/wi-531-asc-compile-cache.md §DEC-AS-COMPILE-CACHE-002)
// Rationale:
//   Two-level sharding (<root>/<key[0..3]>/<key>.wasm) mirrors file-cache.ts in
//   packages/shave/src/cache/file-cache.ts:20-25 for consistency.
//   The renameWithRetry helper is inlined rather than imported from @yakcc/shave to
//   avoid cross-package coupling for two callers. Lift to a shared @yakcc/cache-fs
//   package when a third caller emerges (Sacred Practice #12 trade-off recorded here).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WasmBackend } from "./as-backend.js";
import type { ResolutionResult } from "./resolve.js";

// ---------------------------------------------------------------------------
// renameWithRetry — inlined from packages/shave/src/cache/atomic-write.ts
//
// @decision DEC-AS-COMPILE-CACHE-002 — atomic rename helper inlined here (not
// lifted to a shared package yet). Mirrors DEC-SHAVE-CACHE-RENAME-RETRY-001
// logic in packages/shave/src/cache/atomic-write.ts. Two callers do not justify
// cross-package coupling; lift to @yakcc/cache-fs when a third emerges.
// ---------------------------------------------------------------------------

const RENAME_MAX_ATTEMPTS = 5;
const RENAME_BACKOFF_MS: readonly number[] = [10, 20, 40, 80, 160];
const RENAME_RETRYABLE = new Set<string>(["EPERM", "EBUSY"]);

async function renameWithRetry(src: string, dst: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      await rename(src, dst);
      return;
    } catch (err) {
      lastErr = err;
      const code =
        err !== null && typeof err === "object" && "code" in err
          ? (err as { code: unknown }).code
          : undefined;
      if (typeof code !== "string" || !RENAME_RETRYABLE.has(code)) {
        throw err;
      }
      if (attempt < RENAME_MAX_ATTEMPTS - 1) {
        const delay =
          RENAME_BACKOFF_MS[attempt] ?? RENAME_BACKOFF_MS[RENAME_BACKOFF_MS.length - 1] ?? 160;
        await new Promise<void>((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Module-level constants (computed once at first import)
// ---------------------------------------------------------------------------

/**
 * Canonical asc flags used when exportMemory=false (the test default).
 * @decision DEC-AS-COMPILE-CACHE-001 — hash covers flags only, not srcPath/outPath
 * (those vary per call and must not be part of the content-addressed key).
 */
const CANONICAL_ASC_FLAGS = ["--optimize", "--runtime", "stub", "--noExportMemory"] as const;

/** SHA-256 of the canonical asc flag array. Changes on flag set changes. */
export const ASC_FLAGS_HASH: string = createHash("sha256")
  .update(JSON.stringify(CANONICAL_ASC_FLAGS))
  .digest("hex");

/** Version from assemblyscript/package.json — read once at module load. */
export const ASC_VERSION: string = (() => {
  const require = createRequire(import.meta.url);
  const pkgPath: string = require.resolve("assemblyscript/package.json") as string;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
})();

/** In-flight promise lock: prevents concurrent compiles of the same key. */
const inFlight = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

// ---------------------------------------------------------------------------
// Cache path helpers
// ---------------------------------------------------------------------------

/**
 * Default cache root: <repoRoot>/tmp/yakcc-as-cache.
 * Override with YAKCC_AS_CACHE_DIR env var (for test isolation).
 *
 * @decision DEC-AS-COMPILE-CACHE-002 — cache root under project tmp/, NOT /tmp/
 * (Sacred Practice #3: no /tmp/ litter on the user's machine).
 */
export function defaultCacheDir(): string {
  if (process.env.YAKCC_AS_CACHE_DIR) {
    return process.env.YAKCC_AS_CACHE_DIR;
  }
  // Resolve from this module's location upward to the project root.
  // as-compile-cache.ts lives at packages/compile/src/ → go up 3 levels.
  const thisDir = fileURLToPath(new URL(".", import.meta.url));
  const projectRoot = resolve(thisDir, "..", "..", "..");
  return join(projectRoot, "tmp", "yakcc-as-cache");
}

/** Return {shardDir, wasmPath, tmpPath} for a cache key. */
function shardPaths(
  cacheDir: string,
  key: string,
): { shardDir: string; wasmPath: string; tmpPath: string } {
  const shard = key.slice(0, 3); // two-level: first 3 hex chars
  const shardDir = join(cacheDir, shard);
  const wasmPath = join(shardDir, `${key}.wasm`);
  const tmpPath = join(shardDir, `${key}.tmp.${Math.random().toString(36).slice(2)}`);
  return { shardDir, wasmPath, tmpPath };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive the cache key from the three-component tuple.
 * Key = sha256(atomHash + "|" + ascVersion + "|" + ascFlagsHash) as 64-char hex.
 *
 * @decision DEC-AS-COMPILE-CACHE-001
 */
export function deriveCacheKey(atomHash: string): string {
  return createHash("sha256").update(`${atomHash}|${ASC_VERSION}|${ASC_FLAGS_HASH}`).digest("hex");
}

export interface CachedAsEmitOpts {
  /** Override cache directory (useful for test isolation). */
  readonly cacheDir?: string;
  /**
   * Disable cache entirely. Equivalent to YAKCC_AS_CACHE_DISABLE=1 env var.
   * Returns cacheStatus: "disabled" and always invokes backend.emit().
   */
  readonly disable?: boolean;
}

export interface CachedAsEmitResult {
  /** The compiled WASM bytes — byte-identical to what backend.emit() would return. */
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** Whether this result came from the cache ("hit") or required a fresh compile ("miss"). */
  readonly cacheStatus: "hit" | "miss" | "disabled";
}

/**
 * Attempt to read a valid WASM entry from the disk cache.
 * Returns bytes on hit, undefined on miss or corrupt entry.
 * Corrupt entries (invalid WASM) are unlinked so the next call recompiles.
 */
async function readWasm(
  cacheDir: string,
  key: string,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const { wasmPath } = shardPaths(cacheDir, key);
  let raw: Buffer;
  try {
    raw = readFileSync(wasmPath);
  } catch (err: unknown) {
    const code =
      err !== null && typeof err === "object" && "code" in err
        ? (err as { code: unknown }).code
        : undefined;
    if (code === "ENOENT") return undefined; // clean miss
    console.warn(`[as-cache] readWasm: unexpected error reading ${wasmPath}: ${String(err)}`);
    return undefined;
  }
  if (raw.length === 0) {
    // Corrupt / zero-byte entry: unlink and treat as miss.
    console.warn(`[as-cache] corrupt zero-byte cache entry at ${wasmPath}; evicting`);
    await unlink(wasmPath).catch(() => undefined);
    return undefined;
  }
  // Validate WASM magic bytes (0x00 0x61 0x73 0x6d) — fast structural check.
  if (raw[0] !== 0x00 || raw[1] !== 0x61 || raw[2] !== 0x73 || raw[3] !== 0x6d) {
    console.warn(`[as-cache] corrupt cache entry (bad magic) at ${wasmPath}; evicting`);
    await unlink(wasmPath).catch(() => undefined);
    return undefined;
  }
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) as Uint8Array<ArrayBuffer>;
}

/**
 * Write WASM bytes to the disk cache atomically.
 * Best-effort: if write fails, logs a warning but does NOT throw.
 * The caller has already received correct bytes; cache miss on next run is acceptable.
 *
 * @decision DEC-AS-COMPILE-CACHE-006 — atomic write via renameWithRetry; no torn writes.
 */
async function writeWasm(
  cacheDir: string,
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const { shardDir, wasmPath, tmpPath } = shardPaths(cacheDir, key);
  try {
    mkdirSync(shardDir, { recursive: true });
    writeFileSync(tmpPath, bytes);
    await renameWithRetry(tmpPath, wasmPath);
  } catch (err) {
    console.warn(`[as-cache] writeWasm: failed to write cache entry ${wasmPath}: ${String(err)}`);
    // Best-effort: try to remove tmp file; ignore error.
    await unlink(tmpPath).catch(() => undefined);
  }
}

/**
 * Emit WASM bytes via the backend, using the content-addressed disk cache when possible.
 *
 * Flow:
 *   1. If disabled → call backend.emit() directly, return {bytes, cacheStatus: "disabled"}.
 *   2. Derive cache key from (atomHash, ASC_VERSION, ASC_FLAGS_HASH).
 *   3. Try disk cache (readWasm) → hit: return {bytes, cacheStatus: "hit"}.
 *   4. Acquire in-memory promise lock (thundering herd guard) → may share an existing compile.
 *   5. On lock owner: call backend.emit(), writeWasm (opportunistic), resolve lock.
 *   6. Return {bytes, cacheStatus: "miss"}.
 *
 * @decision DEC-AS-COMPILE-CACHE-003 — wrapper module (Option C); backend stays pure.
 * @decision DEC-AS-COMPILE-CACHE-004 — in-memory promise lock prevents thundering herd.
 * @decision DEC-AS-COMPILE-CACHE-005 — bytes returned are byte-identical to direct emit().
 */
export async function cachedAsEmit(
  backend: WasmBackend,
  resolution: ResolutionResult,
  atomHash: string,
  opts?: CachedAsEmitOpts,
): Promise<CachedAsEmitResult> {
  // Short-circuit if cache is disabled.
  const disabled = opts?.disable === true || process.env.YAKCC_AS_CACHE_DISABLE === "1";
  if (disabled) {
    const bytes = await backend.emit(resolution);
    return { bytes, cacheStatus: "disabled" };
  }

  const cacheDir = opts?.cacheDir ?? defaultCacheDir();
  const key = deriveCacheKey(atomHash);

  // Try disk cache first (fast path — no lock needed).
  const cached = await readWasm(cacheDir, key);
  if (cached !== undefined) {
    return { bytes: cached, cacheStatus: "hit" };
  }

  // Cache miss: acquire in-memory promise lock to prevent thundering herd.
  // @decision DEC-AS-COMPILE-CACHE-004
  const existing = inFlight.get(key);
  if (existing !== undefined) {
    // Another worker is already compiling this key — share its result.
    const bytes = await existing;
    return { bytes, cacheStatus: "miss" };
  }

  // We are the lock owner: create the compile promise and register it.
  let resolveBytes!: (bytes: Uint8Array<ArrayBuffer>) => void;
  let rejectBytes!: (err: unknown) => void;
  const compilePromise = new Promise<Uint8Array<ArrayBuffer>>((res, rej) => {
    resolveBytes = res;
    rejectBytes = rej;
  });
  inFlight.set(key, compilePromise);

  try {
    const bytes = await backend.emit(resolution);
    // Write to disk cache opportunistically (best-effort, non-blocking correctness).
    await writeWasm(cacheDir, key, bytes);
    resolveBytes(bytes);
    return { bytes, cacheStatus: "miss" };
  } catch (err) {
    rejectBytes(err);
    throw err;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Utility: remove all entries from the in-memory promise lock map.
 * Safe to call between tests; does not touch disk.
 * Do NOT call in production code — for test isolation only.
 */
export function clearInFlightLock(): void {
  inFlight.clear();
}

/**
 * Utility: clear the on-disk cache directory.
 * For test isolation ONLY — do NOT call in production code.
 */
export async function clearCache(cacheRoot: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(cacheRoot, { recursive: true, force: true });
}
