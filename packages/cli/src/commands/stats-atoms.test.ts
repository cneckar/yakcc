// SPDX-License-Identifier: MIT
//
// stats-atoms.test.ts — Tier-2 + Tier-3 tests for collectAtomReuse()
//                       Evaluation Contract: T-TIER2-1..T-TIER2-8
//
// All registry tests use real temp SQLite files via openRegistry (Sacred Practice #5).
// No mocks — grain and LoC values come from real storeBlock() calls.
//
// @decision DEC-CLI-STATS-TIER-2-001 — Tier-2/3 implementation verified here.
// @decision DEC-CLI-STATS-READER-SEAM-001 — T-TIER2-7 (reader-seam invariant) included.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalize,
  blockMerkleRoot as computeBlockMerkleRoot,
  createOfflineEmbeddingProvider,
  canonicalAstHash as deriveCanonicalAstHash,
  specHash as deriveSpecHash,
} from "@yakcc/contracts";
import type { TelemetryEvent } from "@yakcc/hooks-base/telemetry.js";
import { type BlockTripletRow, type CanonicalAstHash, openRegistry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectAtomReuse } from "./stats-atoms.js";

// ---------------------------------------------------------------------------
// Shared offline embedding provider (no network needed)
// ---------------------------------------------------------------------------

const offlineProvider = createOfflineEmbeddingProvider();

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-stats-atoms-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid TelemetryEvent representing a Tier-2 qualifying hit.
 * substituted=true, substitutedAtomHash=<provided>, outcome="registry-hit".
 */
function makeHitEvent(atomHash: string, overrides?: Partial<TelemetryEvent>): TelemetryEvent {
  return {
    t: Date.now(),
    intentHash: "aabbccdd",
    toolName: "Edit",
    candidateCount: 1,
    topScore: 0.05,
    substituted: true,
    substitutedAtomHash: atomHash,
    latencyMs: 10,
    outcome: "registry-hit",
    ...overrides,
  } as TelemetryEvent;
}

/** Build a non-hit event (passthrough, synthesis-required, etc.). */
function makeNonHitEvent(outcome: string): TelemetryEvent {
  return {
    t: Date.now(),
    intentHash: "aabbccdd",
    toolName: "Edit",
    candidateCount: 0,
    topScore: null,
    substituted: false,
    substitutedAtomHash: null,
    latencyMs: 10,
    outcome,
  } as TelemetryEvent;
}

/**
 * Build a BlockTripletRow with controlled level and implSource.
 * implSource is constructed to have a known line count.
 */
function makeBlock(opts: {
  name: string;
  level: "L0" | "L1" | "L2" | "L3";
  implLines: number;
}): BlockTripletRow {
  // Build implSource with exactly implLines lines.
  const lines = [`export function ${opts.name}(x: string): string {`];
  for (let i = 1; i < opts.implLines - 1; i++) {
    lines.push(`  // line ${i}`);
  }
  lines.push("  return x; }");
  const implSource = lines.join("\n");

  const spec = {
    name: opts.name,
    behavior: `Behavior for ${opts.name}`,
    inputs: [{ name: "x", type: "string" }],
    outputs: [{ name: "y", type: "string" }],
    preconditions: [] as string[],
    postconditions: [] as string[],
    invariants: [] as string[],
    effects: [] as string[],
    level: opts.level,
  };
  const manifest = { artifacts: [] as never[] };
  const artifacts = new Map<string, Uint8Array>();
  const root = computeBlockMerkleRoot({ spec, implSource, manifest, artifacts });
  const sh = deriveSpecHash(spec);
  const canonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);

  return {
    blockMerkleRoot: root,
    specHash: sh,
    specCanonicalBytes: canonicalBytes,
    implSource,
    proofManifestJson: JSON.stringify(manifest),
    level: opts.level,
    createdAt: Date.now(),
    canonicalAstHash: deriveCanonicalAstHash(implSource) as CanonicalAstHash,
    artifacts,
  };
}

/**
 * Seed a temp registry with the given blocks and return the db path.
 * Also returns the blockMerkleRoot for each block (for use as atomHash in telemetry).
 */
async function seedRegistryWithBlocks(
  blocks: BlockTripletRow[],
): Promise<{ dbPath: string; hashes: string[] }> {
  const dbPath = join(tmpDir, "test-registry.sqlite");
  mkdirSync(tmpDir, { recursive: true });
  const reg = await openRegistry(dbPath, { embeddings: offlineProvider });
  for (const block of blocks) {
    await reg.storeBlock(block);
  }
  await reg.close();
  return {
    dbPath,
    hashes: blocks.map((b) => b.blockMerkleRoot),
  };
}

// ---------------------------------------------------------------------------
// T-TIER2-1: Top-N atoms by hit count, stable tie-break
// ---------------------------------------------------------------------------
describe("T-TIER2-1: top-N atoms by hit count, stable tie-break", () => {
  it("orders atoms by descending hit count; ties break by ascending atomHash", async () => {
    // 4 distinct synthetic atom hashes — we use hex strings directly.
    // The hit counts are: atomA=5, atomB=3, atomC=3, atomD=1.
    // Use no-registry path (registry absent) to verify pure-telemetry ordering.
    const atomA = "aaaa0000000000000000000000000000000000000000000000000000000000000000";
    const atomB = "bbbb0000000000000000000000000000000000000000000000000000000000000000";
    const atomC = "cccc0000000000000000000000000000000000000000000000000000000000000000";
    const atomD = "dddd0000000000000000000000000000000000000000000000000000000000000000";

    const events: TelemetryEvent[] = [
      ...Array.from({ length: 5 }, () => makeHitEvent(atomA)),
      ...Array.from({ length: 3 }, () => makeHitEvent(atomB)),
      ...Array.from({ length: 3 }, () => makeHitEvent(atomC)),
      makeHitEvent(atomD),
    ];

    // Use a non-existent registry path — will degrade gracefully.
    const result = await collectAtomReuse(events, {
      registryPath: join(tmpDir, "nonexistent.sqlite"),
      topN: 10,
    });

    expect(result.top).toHaveLength(4);

    // atomA first (5 hits)
    expect(result.top[0]?.atomHash).toBe(atomA);
    expect(result.top[0]?.hits).toBe(5);

    // atomB before atomC by lex tiebreak (bbbb < cccc)
    expect(result.top[1]?.atomHash).toBe(atomB);
    expect(result.top[1]?.hits).toBe(3);
    expect(result.top[2]?.atomHash).toBe(atomC);
    expect(result.top[2]?.hits).toBe(3);

    // atomD last
    expect(result.top[3]?.atomHash).toBe(atomD);
    expect(result.top[3]?.hits).toBe(1);
  });

  it("respects topN limit — emits at most topN entries", async () => {
    const atoms = Array.from({ length: 15 }, (_, i) => `${i.toString(16).padStart(64, "0")}`);
    const events = atoms.map((h) => makeHitEvent(h));

    const result = await collectAtomReuse(events, {
      registryPath: join(tmpDir, "nonexistent.sqlite"),
      topN: 5,
    });

    expect(result.top).toHaveLength(5);
  });

  it("emits fewer than topN when fewer distinct atoms exist", async () => {
    const atomA = "aa".padEnd(64, "0");
    const atomB = "bb".padEnd(64, "0");
    const events = [makeHitEvent(atomA), makeHitEvent(atomA), makeHitEvent(atomB)];

    const result = await collectAtomReuse(events, {
      registryPath: join(tmpDir, "nonexistent.sqlite"),
      topN: 10,
    });

    expect(result.top).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// T-TIER2-2: Hit-rate percentiles
// ---------------------------------------------------------------------------
describe("T-TIER2-2: hit-rate percentiles", () => {
  it("computes P50 and P90 correctly for hit counts [1,3,3,5]", async () => {
    // Sorted hit counts: [1, 3, 3, 5] → P50 index=ceil(50/100*4)-1 = 1 → value=3
    //                                  → P90 index=ceil(90/100*4)-1 = 3 → value=5
    const atomA = "aaaa".padEnd(64, "0");
    const atomB = "bbbb".padEnd(64, "0");
    const atomC = "cccc".padEnd(64, "0");
    const atomD = "dddd".padEnd(64, "0");

    const events: TelemetryEvent[] = [
      ...Array.from({ length: 5 }, () => makeHitEvent(atomA)),
      ...Array.from({ length: 3 }, () => makeHitEvent(atomB)),
      ...Array.from({ length: 3 }, () => makeHitEvent(atomC)),
      makeHitEvent(atomD),
    ];

    const result = await collectAtomReuse(events, {
      registryPath: join(tmpDir, "nonexistent.sqlite"),
    });

    expect(result.hitRateP50).toBe(3);
    expect(result.hitRateP90).toBe(5);
  });

  it("returns null for both percentiles when no hits exist", async () => {
    const result = await collectAtomReuse([], {
      registryPath: join(tmpDir, "nonexistent.sqlite"),
    });

    expect(result.hitRateP50).toBeNull();
    expect(result.hitRateP90).toBeNull();
  });

  it("P50 = P90 = single value when only one distinct atom", async () => {
    const atomA = "aaaa".padEnd(64, "0");
    const events = Array.from({ length: 7 }, () => makeHitEvent(atomA));

    const result = await collectAtomReuse(events, {
      registryPath: join(tmpDir, "nonexistent.sqlite"),
    });

    expect(result.hitRateP50).toBe(7);
    expect(result.hitRateP90).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// T-TIER2-3: Atom-grain histogram from registry join
// ---------------------------------------------------------------------------
describe("T-TIER2-3: atom-grain histogram from registry join", () => {
  it("populates grainHistogram from real registry block levels", async () => {
    // Two L1 blocks + one L2 block → histogram = {L0:0, L1:2, L2:1, L3:0, unknown:0}
    const blockL1a = makeBlock({ name: "funcL1a", level: "L1", implLines: 5 });
    const blockL1b = makeBlock({ name: "funcL1b", level: "L1", implLines: 8 });
    const blockL2 = makeBlock({ name: "funcL2", level: "L2", implLines: 12 });

    const { dbPath, hashes } = await seedRegistryWithBlocks([blockL1a, blockL1b, blockL2]);
    const [hashL1a, hashL1b, hashL2] = hashes as [string, string, string];

    // 3 hits to L1a, 2 hits to L1b, 1 hit to L2
    const events: TelemetryEvent[] = [
      ...Array.from({ length: 3 }, () => makeHitEvent(hashL1a)),
      ...Array.from({ length: 2 }, () => makeHitEvent(hashL1b)),
      makeHitEvent(hashL2),
    ];

    const result = await collectAtomReuse(events, { registryPath: dbPath });

    expect(result.degraded).toBe(false);
    expect(result.grainHistogram).toEqual({ L0: 0, L1: 2, L2: 1, L3: 0, unknown: 0 });
  });

  it("puts unknown-hash atoms in the 'unknown' bucket, non-fatal", async () => {
    // Registry has one L1 block; telemetry also references a hash not in the registry.
    const blockL1 = makeBlock({ name: "funcKnown", level: "L1", implLines: 5 });
    const { dbPath, hashes } = await seedRegistryWithBlocks([blockL1]);
    const [knownHash] = hashes as [string];
    const unknownHash = "ffff".padEnd(64, "0");

    const events: TelemetryEvent[] = [makeHitEvent(knownHash), makeHitEvent(unknownHash)];

    const result = await collectAtomReuse(events, { registryPath: dbPath });

    expect(result.degraded).toBe(false);
    expect(result.grainHistogram?.L1).toBe(1);
    expect(result.grainHistogram?.unknown).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T-TIER2-4: LoC-saved fold-in (Tier-3)
// ---------------------------------------------------------------------------
describe("T-TIER2-4: LoC-saved fold-in", () => {
  it("computes locSaved.total as sum of lines×hits for each atom", async () => {
    // L1 block: 10 lines, hit 5 times → 50 LOC saved
    // L2 block: 22 lines, hit 3 times → 66 LOC saved
    // Total: 116
    const blockL1 = makeBlock({ name: "funcA", level: "L1", implLines: 10 });
    const blockL2 = makeBlock({ name: "funcB", level: "L2", implLines: 22 });

    const { dbPath, hashes } = await seedRegistryWithBlocks([blockL1, blockL2]);
    const [hashL1, hashL2] = hashes as [string, string];

    const events: TelemetryEvent[] = [
      ...Array.from({ length: 5 }, () => makeHitEvent(hashL1)),
      ...Array.from({ length: 3 }, () => makeHitEvent(hashL2)),
    ];

    const result = await collectAtomReuse(events, { registryPath: dbPath });

    expect(result.degraded).toBe(false);
    expect(result.locSaved?.total).toBe(116);

    // byAtom sorted descending by saved: L2 (66 saved) first, L1 (50 saved) second
    expect(result.locSaved?.byAtom[0]?.atomHash).toBe(hashL2);
    expect(result.locSaved?.byAtom[0]?.saved).toBe(66);
    expect(result.locSaved?.byAtom[1]?.atomHash).toBe(hashL1);
    expect(result.locSaved?.byAtom[1]?.saved).toBe(50);
  });

  it("locSaved.total is 0 when no hits", async () => {
    const result = await collectAtomReuse([], { registryPath: join(tmpDir, "nonexistent.sqlite") });
    expect(result.locSaved?.total).toBe(0);
    expect(result.locSaved?.byAtom).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T-TIER2-5: Tier-1 additive-forward invariant — no Tier-2 data when all
//            events are pre-WI-831 (substituted=false, substitutedAtomHash=null)
// ---------------------------------------------------------------------------
describe("T-TIER2-5: Tier-1 additive-forward invariant", () => {
  it("returns empty Tier-2 block when all events have substituted=false", async () => {
    const events: TelemetryEvent[] = [
      makeNonHitEvent("passthrough"),
      makeNonHitEvent("synthesis-required"),
      makeNonHitEvent("passthrough"),
    ];

    const result = await collectAtomReuse(events, {
      registryPath: join(tmpDir, "nonexistent.sqlite"),
    });

    expect(result.top).toHaveLength(0);
    expect(result.hitRateP50).toBeNull();
    expect(result.hitRateP90).toBeNull();
    expect(result.grainHistogram).toEqual({ L0: 0, L1: 0, L2: 0, L3: 0, unknown: 0 });
    expect(result.locSaved?.total).toBe(0);
    expect(result.locSaved?.byAtom).toHaveLength(0);
    expect(result.degraded).toBe(false);
  });

  it("returns empty Tier-2 block when events list is empty", async () => {
    const result = await collectAtomReuse([], {
      registryPath: join(tmpDir, "nonexistent.sqlite"),
    });

    expect(result.top).toHaveLength(0);
    expect(result.hitRateP50).toBeNull();
    expect(result.hitRateP90).toBeNull();
    expect(result.grainHistogram).toEqual({ L0: 0, L1: 0, L2: 0, L3: 0, unknown: 0 });
    expect(result.locSaved?.total).toBe(0);
    expect(result.degraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-TIER2-6: Registry-missing graceful degrade
// ---------------------------------------------------------------------------
describe("T-TIER2-6: registry-missing graceful degrade", () => {
  it("sets degraded=true with 'registry-not-found' reason when SQLite is absent", async () => {
    const atomA = "aaaa".padEnd(64, "0");
    const events = Array.from({ length: 3 }, () => makeHitEvent(atomA));

    const result = await collectAtomReuse(events, {
      registryPath: join(tmpDir, "does-not-exist", "registry.sqlite"),
    });

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe("registry-not-found");
    // top is populated from telemetry (no grain enrichment)
    expect(result.top).toHaveLength(1);
    expect(result.top[0]?.atomHash).toBe(atomA);
    expect(result.top[0]?.hits).toBe(3);
    expect(result.top[0]?.level).toBeNull();
    expect(result.top[0]?.lines).toBeNull();
    // grainHistogram and locSaved absent when degraded
    expect(result.grainHistogram).toBeUndefined();
    expect(result.locSaved).toBeUndefined();
    // percentiles still computed from telemetry alone
    expect(result.hitRateP50).toBe(3);
    expect(result.hitRateP90).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// T-TIER2-7: Reader-seam invariant (static)
// ---------------------------------------------------------------------------
describe("T-TIER2-7: reader-seam invariant (no direct JSONL parsing)", () => {
  it("stats-atoms.ts contains no JSON.parse over telemetry lines", async () => {
    // Verify stats-atoms.ts source code does not contain JSON.parse or readFileSync.
    // This is a static check — the production sequence only reaches stats-atoms.ts
    // via collectAtomReuse(events, ...) where events is already TelemetryEvent[].
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join: pathJoin } = await import("node:path");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(pathJoin(__dirname, "stats-atoms.ts"), "utf-8");

    // No direct JSONL parser in stats-atoms.ts
    expect(src).not.toMatch(/JSON\.parse\s*\(/);
    // No readFileSync over jsonl files
    expect(src).not.toMatch(/readFileSync[^)]*\.jsonl/);
  });

  it("stats.ts contains no JSON.parse over telemetry lines", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join: pathJoin } = await import("node:path");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(pathJoin(__dirname, "stats.ts"), "utf-8");

    // stats.ts must not contain a JSONL reader
    expect(src).not.toMatch(/JSON\.parse\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// T-TIER2-8: Drift-alert exclusion preserved in Tier-2
// ---------------------------------------------------------------------------
describe("T-TIER2-8: drift-alert exclusion preserved", () => {
  it("excludes drift-alert events (candidateCount=-1) even if they carry a non-null atomHash", async () => {
    const atomA = "aaaa".padEnd(64, "0");

    // A real qualifying hit
    const realHit = makeHitEvent(atomA);

    // A drift-alert sentinel shaped to look like a hit (non-null substitutedAtomHash)
    // These are the sentinel shapes per DEC-HOOK-ENF-LAYER5-TELEMETRY-001
    const driftAlert1: TelemetryEvent = {
      t: Date.now(),
      intentHash: "drift:passthrough_rate:abc12345",
      toolName: "Edit",
      candidateCount: -1, // sentinel marker
      topScore: null,
      substituted: true, // even if true
      substitutedAtomHash: atomA, // even if non-null
      latencyMs: 0,
      outcome: "drift-alert",
    } as TelemetryEvent;

    const driftAlert2: TelemetryEvent = {
      t: Date.now(),
      intentHash: "aabbccdd",
      toolName: "Write",
      candidateCount: -1,
      topScore: null,
      substituted: true,
      substitutedAtomHash: atomA,
      latencyMs: 0,
      outcome: "drift-alert",
    } as TelemetryEvent;

    const events: TelemetryEvent[] = [realHit, driftAlert1, driftAlert2];

    const result = await collectAtomReuse(events, {
      registryPath: join(tmpDir, "nonexistent.sqlite"),
    });

    // Only the real hit should count — drift-alert events excluded
    expect(result.top).toHaveLength(1);
    expect(result.top[0]?.hits).toBe(1);
  });

  it("excludes events with outcome=registry-hit but substituted=false", async () => {
    // A registry-hit without actual substitution (pre-WI-831 shape)
    const atomA = "aaaa".padEnd(64, "0");
    const falseHit: TelemetryEvent = {
      t: Date.now(),
      intentHash: "aabbccdd",
      toolName: "Edit",
      candidateCount: 1,
      topScore: 0.05,
      substituted: false, // no substitution
      substitutedAtomHash: atomA, // non-null but substituted=false
      latencyMs: 10,
      outcome: "registry-hit",
    } as TelemetryEvent;

    const result = await collectAtomReuse([falseHit], {
      registryPath: join(tmpDir, "nonexistent.sqlite"),
    });

    expect(result.top).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Compound production-sequence test:
// Full pipeline: telemetry events → collectAtomReuse → real registry enrichment
// Crosses multiple internal components (hit filter + registry open + getBlock +
// grain histogram + LoC accumulation + top-N sort).
// ---------------------------------------------------------------------------
describe("compound production-sequence: full Tier-2 + Tier-3 pipeline with real registry", () => {
  it("drives the full sequence from filtered events through registry enrichment to atoms output", async () => {
    // Setup: three blocks at different levels with known implSource line counts.
    const blockL0 = makeBlock({ name: "atomZero", level: "L0", implLines: 3 });
    const blockL1 = makeBlock({ name: "atomOne", level: "L1", implLines: 10 });
    const blockL2 = makeBlock({ name: "atomTwo", level: "L2", implLines: 20 });

    const { dbPath, hashes } = await seedRegistryWithBlocks([blockL0, blockL1, blockL2]);
    const [hashL0, hashL1, hashL2] = hashes as [string, string, string];

    // Mix: hits + non-hits + drift-alerts.
    // Expected hits: hashL0×1, hashL1×4, hashL2×2
    const events: TelemetryEvent[] = [
      // Real hits
      makeHitEvent(hashL0), // 1 hit
      ...Array.from({ length: 4 }, () => makeHitEvent(hashL1)), // 4 hits
      ...Array.from({ length: 2 }, () => makeHitEvent(hashL2)), // 2 hits
      // Non-hits (must be excluded from Tier-2)
      makeNonHitEvent("passthrough"),
      makeNonHitEvent("synthesis-required"),
      // Drift-alert sentinel (must be excluded)
      {
        t: Date.now(),
        intentHash: "drift:x",
        toolName: "Edit",
        candidateCount: -1,
        topScore: null,
        substituted: true,
        substitutedAtomHash: hashL0,
        latencyMs: 0,
        outcome: "drift-alert",
      } as TelemetryEvent,
    ];

    const result = await collectAtomReuse(events, { registryPath: dbPath, topN: 10 });

    // Not degraded
    expect(result.degraded).toBe(false);

    // top-N: hashL1 (4 hits) > hashL2 (2 hits) > hashL0 (1 hit)
    expect(result.top).toHaveLength(3);
    expect(result.top[0]?.atomHash).toBe(hashL1);
    expect(result.top[0]?.hits).toBe(4);
    expect(result.top[0]?.level).toBe("L1");
    expect(result.top[0]?.lines).toBe(10);

    expect(result.top[1]?.atomHash).toBe(hashL2);
    expect(result.top[1]?.hits).toBe(2);
    expect(result.top[1]?.level).toBe("L2");
    expect(result.top[1]?.lines).toBe(20);

    expect(result.top[2]?.atomHash).toBe(hashL0);
    expect(result.top[2]?.hits).toBe(1);
    expect(result.top[2]?.level).toBe("L0");
    expect(result.top[2]?.lines).toBe(3);

    // Grain histogram: L0×1, L1×1, L2×1, L3×0, unknown×0
    expect(result.grainHistogram).toEqual({ L0: 1, L1: 1, L2: 1, L3: 0, unknown: 0 });

    // Hit counts sorted: [1, 2, 4]
    // P50: ceil(50/100*3)-1 = ceil(1.5)-1 = 2-1 = 1 → sorted[1] = 2
    // P90: ceil(90/100*3)-1 = ceil(2.7)-1 = 3-1 = 2 → sorted[2] = 4
    expect(result.hitRateP50).toBe(2);
    expect(result.hitRateP90).toBe(4);

    // LoC-saved:
    //   hashL0: 3 lines × 1 hit = 3
    //   hashL1: 10 lines × 4 hits = 40
    //   hashL2: 20 lines × 2 hits = 40
    //   total = 83
    expect(result.locSaved?.total).toBe(83);

    // byAtom sorted descending by saved: L1(40) and L2(40) — tiebreak by saved=40 each
    // Both show saved=40, total=83
    const byAtomSaved = result.locSaved?.byAtom.map((e) => e.saved) ?? [];
    expect(byAtomSaved[0]).toBe(40);
    expect(byAtomSaved[1]).toBe(40);
    expect(byAtomSaved[2]).toBe(3);
  });
});
