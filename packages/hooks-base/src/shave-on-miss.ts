// SPDX-License-Identifier: MIT
// shave-on-miss.ts -- Background shave queue for import-intercept miss path.
//
// @decision DEC-WI508-S2-IN-PROC-BACKGROUND-001
// title: In-process module-scope background queue, dedup by (packageName, entryPath)
// status: decided (WI-508 Slice 2)
// rationale:
//   Simplest path that satisfies the async requirement. storeBlock idempotence
//   makes cross-process duplicates safe (wasteful but correct). Cross-process dedup
//   is a follow-on per plan section 10.7.
//
// @decision DEC-WI508-S2-ASYNC-BACKGROUND-001
// title: First-occurrence: passthrough now, shave-in-background; second occurrence: registry hit
// status: decided (WI-508 Slice 2)
// rationale:
//   Operator addendum (issue #508 comment 4457079594) explicitly chose this semantics.
//   Synchronous shave would block emission and violate the D-HOOK-3 200ms latency budget.
//
// @decision DEC-WI508-S2-ENTRY-ROOT-COMPOSITION-001
// title: shave() with the entry path IS the minimally-viable composition
// status: decided (WI-508 Slice 2)
// rationale:
//   No separate assembly algorithm added. shave() with persist:true calls
//   universalize({persist:true}) which calls maybePersistNovelGlueAtom for each
//   NovelGlueEntry. This IS the entry-rooted composition the plan describes.
//   shavePackage() is not in the @yakcc/shave public API; shave() is the equivalent.
//
// @decision DEC-WI508-S2-SHAVE-CORPUS-DIR-001
// title: YAKCC_SHAVE_ON_MISS_CORPUS_DIR env var configures corpus path; default node_modules
// status: decided (WI-508 Slice 2)
// rationale:
//   Matches YAKCC_TELEMETRY_DIR / YAKCC_HOOK_DISABLE_SUBSTITUTE env-var pattern.
//   No new config-file authority. Tests set it to the vendored fixture path.
//
// @decision DEC-WI508-S2-SHAVE-MISS-FAIL-LOUD-OFF-001
// title: Shave-on-miss failures are observe-dont-mutate: caught, telemetry logged, base returned
// status: decided (WI-508 Slice 2)
// rationale:
//   Same discipline as Slice 1 DEC-WI508-INTERCEPT-004. One failure-handling authority.
//
// @decision DEC-WI508-S2-PERSIST-VIA-MAYBE-PERSIST-001
// title: Atoms persist via shave({persist:true}) which internally calls maybePersistNovelGlueAtom
// status: decided (WI-508 Slice 2)
// rationale:
//   Single persistence authority per DEC-ATOM-PERSIST-001. No direct storeBlock calls.
//
// @decision DEC-WI508-S2-RESPONSE-ENRICH-ADDITIVE-001
// title: ShaveOnMissResult.shaveOnMissEnqueued is an additive flag on the response
// status: decided (WI-508 Slice 2)
// rationale:
//   Makes the side-effect observable without changing existing field shapes.
//
// @decision DEC-WI508-S2-TELEMETRY-OUTCOME-ADDITIVE-001
// title: Three new outcome values added to TelemetryEvent.outcome union
// status: decided (WI-508 Slice 2)
// rationale:
//   Backward-compatible additive expansion. Old consumers see new values as unrecognized.
//
// @decision DEC-WI508-S2-REGISTRY-IS-CANONICAL-001
// title: The Registry instance passed into applyImportIntercept() is the single canonical registry
// status: decided (WI-508 Slice 2)
// rationale:
//   No parallel registry handle. Same SQLite database for both query and write paths.
//
// @decision DEC-WI508-S2-GATE-ALLOWS-DURING-ASYNC-001
// title: Compile-time import gate accepts during the async window; tightens as registry grows
// status: decided (WI-508 Slice 2)
// rationale:
//   Gate existing semantics (refuse iff registry has covering atom) make this automatic.

import { existsSync, readdirSync } from "node:fs";
import { join, normalize } from "node:path";
import type { Registry } from "@yakcc/registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result returned by applyShaveOnMiss().
 * DEC-WI508-S2-RESPONSE-ENRICH-ADDITIVE-001: shaveOnMissEnqueued makes the
 * side-effect observable without changing existing field shapes.
 */
export interface ShaveOnMissResult {
  /** Whether a background shave was enqueued for this binding. */
  readonly shaveOnMissEnqueued: boolean;
  /**
   * Whether the entry path was resolved in the corpus (true) or unresolvable (false).
   * False means the corpus does not contain this package/binding — the caller should
   * treat this as a no-op (same as pre-Slice-2 behavior).
   * DEC-WI508-S2-RESPONSE-ENRICH-ADDITIVE-001.
   */
  readonly entryResolved: boolean;
  /** BlockMerkleRoot[:8] prefixes of atoms created during the background shave. */
  readonly atomsCreated: readonly string[];
}

type QueueKey = string;

type QueueStatus =
  | { readonly state: "pending"; readonly drain: Promise<void> }
  | { readonly state: "completed"; readonly atomsCreated: readonly string[] }
  | { readonly state: "error"; readonly error: unknown };

// ---------------------------------------------------------------------------
// Module-scope background queue (DEC-WI508-S2-IN-PROC-BACKGROUND-001)
// ---------------------------------------------------------------------------

const _queue = new Map<QueueKey, QueueStatus>();

function makeQueueKey(packageName: string, entryPath: string): QueueKey {
  const normEntry = normalize(entryPath).replace(/\\/g, "/");
  return `${packageName}::${normEntry}`;
}

// ---------------------------------------------------------------------------
// Corpus-dir resolution (DEC-WI508-S2-SHAVE-CORPUS-DIR-001)
// ---------------------------------------------------------------------------

/**
 * Resolve the corpus directory from YAKCC_SHAVE_ON_MISS_CORPUS_DIR env var.
 * Defaults to {cwd}/node_modules when the env var is not set.
 */
export function resolveCorpusDir(): string {
  return process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR ?? join(process.cwd(), "node_modules");
}

// ---------------------------------------------------------------------------
// Entry-path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the entry JS file path for a specific binding of a package.
 *
 * Resolution order:
 *   1. {corpusDir}/{packageName}/lib/{binding}.js  (standard node_modules layout)
 *   2. {corpusDir}/{packageName}-VERSION/lib/{binding}.js (versioned fixture layout)
 *      Directories are sorted for determinism (e.g. validator-13.15.35).
 *
 * Returns undefined when no matching file is found.
 *
 * @param packageName - NPM package name (e.g. "validator").
 * @param binding     - Named binding (e.g. "isEmail").
 * @param corpusDir   - Root of the corpus (node_modules or fixture dir).
 */
export function resolveEntryPath(
  packageName: string,
  binding: string,
  corpusDir: string,
): string | undefined {
  // Attempt 1: standard node_modules layout.
  const standard = join(corpusDir, packageName, "lib", `${binding}.js`);
  if (existsSync(standard)) {
    return normalize(standard);
  }

  // Attempt 2: versioned fixture layout -- {packageName}-{version}/lib/{binding}.js.
  let entries: string[];
  try {
    entries = readdirSync(corpusDir);
  } catch {
    return undefined;
  }

  const prefix = `${packageName}-`;
  const versionedDirs = entries.filter((e) => e.startsWith(prefix)).sort();

  for (const dir of versionedDirs) {
    const candidate = join(corpusDir, dir, "lib", `${binding}.js`);
    if (existsSync(candidate)) {
      return normalize(candidate);
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Background worker (DEC-WI508-S2-ENTRY-ROOT-COMPOSITION-001)
// ---------------------------------------------------------------------------

/**
 * Run the shave pipeline for a specific entry path and persist atoms.
 *
 * Uses shave() from @yakcc/shave with intentStrategy:"static" and foreignPolicy:"allow".
 * DEC-WI508-S2-PERSIST-VIA-MAYBE-PERSIST-001: persistence flows through
 *   universalize({persist:true}) -> maybePersistNovelGlueAtom. No direct storeBlock calls.
 */
async function runShaveWorker(entryPath: string, registry: Registry): Promise<readonly string[]> {
  const { shave } = await import("@yakcc/shave");
  const registryAsShaveView = registry as Parameters<typeof shave>[1];
  const result = await shave(entryPath, registryAsShaveView, {
    intentStrategy: "static",
    foreignPolicy: "allow",
  });
  return result.atoms
    .filter((a) => a.merkleRoot !== undefined)
    .map((a) => (a.merkleRoot as string).slice(0, 8));
}

// ---------------------------------------------------------------------------
// Telemetry helpers (DEC-WI508-S2-TELEMETRY-OUTCOME-ADDITIVE-001)
// ---------------------------------------------------------------------------

function emitShaveOnMissTelemetry(
  outcome: "shave-on-miss-enqueued" | "shave-on-miss-completed" | "shave-on-miss-error",
  intent: string,
  extraData?: {
    readonly atomsCreated?: readonly string[];
    readonly errorMsg?: string;
  },
): void {
  import("./telemetry.js")
    .then(({ appendTelemetryEvent, hashIntent, resolveSessionId, resolveTelemetryDir }) => {
      try {
        const event = {
          t: Date.now(),
          intentHash: hashIntent(intent),
          toolName: "Write" as const,
          candidateCount: 0,
          topScore: null as number | null,
          substituted: false,
          substitutedAtomHash: null as string | null,
          latencyMs: 0,
          outcome,
          ...(extraData?.atomsCreated !== undefined
            ? { atomsCreated: extraData.atomsCreated }
            : {}),
        };
        // biome-ignore lint/suspicious/noExplicitAny: outcome union extension (DEC-WI508-S2-TELEMETRY-OUTCOME-ADDITIVE-001)
        appendTelemetryEvent(event as any, resolveSessionId(), resolveTelemetryDir());
      } catch {
        // Telemetry write failure -- swallow.
      }
    })
    .catch(() => {
      // Telemetry import failure -- swallow.
    });
}

// ---------------------------------------------------------------------------
// Primary API
// ---------------------------------------------------------------------------

/**
 * Enqueue a background shave for a package binding on the first miss.
 *
 * Returns immediately with shaveOnMissEnqueued=true on the first occurrence.
 * On subsequent calls (already queued or completed), returns shaveOnMissEnqueued=false.
 *
 * DEC-WI508-S2-ASYNC-BACKGROUND-001: hook emission is never blocked.
 * DEC-WI508-S2-REGISTRY-IS-CANONICAL-001: same registry as query path.
 *
 * @param packageName - NPM package name (e.g. "validator").
 * @param binding     - Named binding from the import (e.g. "isEmail").
 * @param ctx         - Emission context (for telemetry intentHash).
 * @param registry    - Registry instance (must have storeBlock for persistence).
 */
export function applyShaveOnMiss(
  packageName: string,
  binding: string,
  ctx: { readonly intent: string },
  registry: Registry,
): ShaveOnMissResult {
  const corpusDir = resolveCorpusDir();
  const entryPath = resolveEntryPath(packageName, binding, corpusDir);

  if (entryPath === undefined) {
    emitShaveOnMissTelemetry("shave-on-miss-error", ctx.intent, {
      errorMsg: `unresolvable-entry-path: ${packageName}/${binding}`,
    });
    return { shaveOnMissEnqueued: false, entryResolved: false, atomsCreated: [] };
  }

  const key = makeQueueKey(packageName, entryPath);
  const existing = _queue.get(key);

  if (existing !== undefined) {
    if (existing.state === "completed") {
      return { shaveOnMissEnqueued: false, entryResolved: true, atomsCreated: existing.atomsCreated };
    }
    return { shaveOnMissEnqueued: false, entryResolved: true, atomsCreated: [] };
  }

  emitShaveOnMissTelemetry("shave-on-miss-enqueued", ctx.intent);

  let resolveDrain!: () => void;
  const drainPromise = new Promise<void>((resolve) => {
    resolveDrain = resolve;
  });
  _queue.set(key, { state: "pending", drain: drainPromise });

  // Start the background worker. Deliberately not awaited.
  // DEC-WI508-S2-ASYNC-BACKGROUND-001.
  void (async () => {
    try {
      const atomsCreated = await runShaveWorker(entryPath, registry);
      _queue.set(key, { state: "completed", atomsCreated });
      emitShaveOnMissTelemetry("shave-on-miss-completed", ctx.intent, { atomsCreated });
    } catch (err) {
      _queue.set(key, { state: "error", error: err });
      const errorMsg = err instanceof Error ? err.message : String(err);
      emitShaveOnMissTelemetry("shave-on-miss-error", ctx.intent, { errorMsg });
    } finally {
      resolveDrain();
    }
  })();

  return { shaveOnMissEnqueued: true, entryResolved: true, atomsCreated: [] };
}

// ---------------------------------------------------------------------------
// Test-only sync surface
// ---------------------------------------------------------------------------

/**
 * Await all pending shave-on-miss drain promises.
 * Test-only -- production callers do not need to await.
 * @param timeoutMs - Maximum wait time in ms (default: 60000).
 */
export async function awaitShaveOnMissDrain(timeoutMs = 60_000): Promise<void> {
  const drains: Promise<void>[] = [];
  for (const status of _queue.values()) {
    if (status.state === "pending") {
      drains.push(status.drain);
    }
  }

  if (drains.length === 0) return;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(drains),
      new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => {
          const queueState = [..._queue.entries()].map(([k, v]) => `${k}=${v.state}`).join(", ");
          reject(
            new Error(
              `awaitShaveOnMissDrain timed out after ${timeoutMs}ms. Queue: [${queueState}]`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/** Reset the module-scope queue. Test-only. */
export function _resetShaveOnMissQueue(): void {
  _queue.clear();
}
