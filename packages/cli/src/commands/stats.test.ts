// SPDX-License-Identifier: MIT
//
// stats.test.ts — real-fs integration tests for `yakcc stats` (WI-764 T-1..T-11 + WI-768 T-TIER2)
//
// All tests use mkdtempSync + real .jsonl fixture files (Sacred Practice #1).
// No fs mocks, no reader stubs. CollectingLogger captures output.
//
// Tests cover the Evaluation Contract T-1..T-11 (Tier-1), T-TIER2-1..T-TIER2-8 (Tier-2/3
// integration from the stats() command handler perspective), plus index.ts dispatch wiring.
//
// @decision DEC-CLI-STATS-SCOPE-001 — Tier-1 only metrics verified in T-1..T-11.
// @decision DEC-CLI-STATS-COMMAND-001 — command shape, --since, --json verified here.
// @decision DEC-CLI-STATS-READER-SEAM-001 — single reader authority; stats.ts has no JSON.parse over telemetry lines.
// @decision DEC-CLI-STATS-TIER-2-001 — Tier-2 + Tier-3 integration verified in T-TIER2 section.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalize,
  blockMerkleRoot as computeBlockMerkleRoot,
  createOfflineEmbeddingProvider,
  canonicalAstHash as deriveCanonicalAstHash,
  specHash as deriveSpecHash,
} from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import { type CanonicalAstHash, openRegistry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger, runCli } from "../index.js";
import { stats } from "./stats.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid TelemetryEvent JSON line. */
function makeEvent(overrides: {
  t?: number;
  toolName?: string;
  outcome?: string;
  candidateCount?: number;
  topScore?: number | null;
}): string {
  const event = {
    t: overrides.t ?? Date.now(),
    intentHash: "aabbccdd",
    toolName: overrides.toolName ?? "Edit",
    candidateCount: overrides.candidateCount ?? 0,
    topScore: overrides.topScore ?? null,
    substituted: false,
    substitutedAtomHash: null,
    latencyMs: 10,
    outcome: overrides.outcome ?? "passthrough",
  };
  return JSON.stringify(event);
}

// ---------------------------------------------------------------------------
// Test fixture + environment setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let telemetryDir: string;
let origEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-stats-test-"));
  telemetryDir = join(tmpDir, "telemetry");
  origEnv = process.env.YAKCC_TELEMETRY_DIR;
  process.env.YAKCC_TELEMETRY_DIR = telemetryDir;
});

afterEach(() => {
  if (origEnv === undefined) {
    Reflect.deleteProperty(process.env, "YAKCC_TELEMETRY_DIR");
  } else {
    process.env.YAKCC_TELEMETRY_DIR = origEnv;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// T-1: Empty dir (non-existent) → graceful no-data message, exit 0
// ---------------------------------------------------------------------------
describe("T-1: empty dir (non-existent)", () => {
  it("prints friendly no-data message and exits 0", async () => {
    // telemetryDir does not exist at this point
    const logger = new CollectingLogger();
    const code = await stats([], logger);
    expect(code).toBe(0);
    const output = logger.logLines.join("\n");
    expect(output).toMatch(/no telemetry/i);
    expect(logger.errLines).toHaveLength(0);
  });

  it("--json: zero-state object, exit 0", async () => {
    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);
    expect(logger.logLines).toHaveLength(1);
    const parsed = JSON.parse(logger.logLines[0] as string);
    expect(parsed.summary.totalEvents).toBe(0);
    expect(parsed.summary.sessionCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T-2: Empty-but-present dir → graceful no-data message, exit 0
// ---------------------------------------------------------------------------
describe("T-2: empty-but-present dir", () => {
  it("prints friendly no-data message and exits 0", async () => {
    mkdirSync(telemetryDir, { recursive: true });
    const logger = new CollectingLogger();
    const code = await stats([], logger);
    expect(code).toBe(0);
    const output = logger.logLines.join("\n");
    expect(output).toMatch(/no telemetry/i);
  });
});

// ---------------------------------------------------------------------------
// T-3: Files exist but are empty (zero events) → no-data message, exit 0
// ---------------------------------------------------------------------------
describe("T-3: files exist but zero events", () => {
  it("prints friendly no-data message and exits 0", async () => {
    mkdirSync(telemetryDir, { recursive: true });
    writeFileSync(join(telemetryDir, "session-empty.jsonl"), "", "utf-8");
    writeFileSync(join(telemetryDir, "session-blank.jsonl"), "\n\n", "utf-8");

    const logger = new CollectingLogger();
    const code = await stats([], logger);
    expect(code).toBe(0);
    const output = logger.logLines.join("\n");
    expect(output).toMatch(/no telemetry/i);
  });
});

// ---------------------------------------------------------------------------
// T-4: Single-session arithmetic — exact counts and percentages
// ---------------------------------------------------------------------------
describe("T-4: single-session arithmetic", () => {
  it("reports exact outcome counts, per-tool hit rates", async () => {
    mkdirSync(telemetryDir, { recursive: true });

    // 4 Edit events: 1 registry-hit, 2 passthrough, 1 synthesis-required
    // 2 Write events: both passthrough
    // 1 MultiEdit event: 1 registry-hit
    const lines = [
      makeEvent({ toolName: "Edit", outcome: "registry-hit" }),
      makeEvent({ toolName: "Edit", outcome: "passthrough" }),
      makeEvent({ toolName: "Edit", outcome: "passthrough" }),
      makeEvent({ toolName: "Edit", outcome: "synthesis-required" }),
      makeEvent({ toolName: "Write", outcome: "passthrough" }),
      makeEvent({ toolName: "Write", outcome: "passthrough" }),
      makeEvent({ toolName: "MultiEdit", outcome: "registry-hit" }),
    ];
    writeFileSync(join(telemetryDir, "session-s4.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    const logger = new CollectingLogger();
    const code = await stats([], logger);
    expect(code).toBe(0);

    const output = logger.logLines.join("\n");

    // Total events
    expect(output).toContain("7");

    // Outcome breakdown — registry-hit: 2 of 7 ≈ 28.6%
    expect(output).toContain("28.6%");

    // synthesis-required: 1 of 7 ≈ 14.3%
    expect(output).toContain("14.3%");

    // passthrough: 4 of 7 ≈ 57.1%
    expect(output).toContain("57.1%");
  });

  it("--json: correct counts in JSON output", async () => {
    mkdirSync(telemetryDir, { recursive: true });

    const lines = [
      makeEvent({ toolName: "Edit", outcome: "registry-hit" }),
      makeEvent({ toolName: "Edit", outcome: "passthrough" }),
      makeEvent({ toolName: "Write", outcome: "passthrough" }),
    ];
    writeFileSync(join(telemetryDir, "session-s4j.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);

    const parsed = JSON.parse(logger.logLines[0] as string);
    expect(parsed.summary.totalEvents).toBe(3);
    expect(parsed.outcomeBreakdown.registryHit).toBe(1);
    expect(parsed.outcomeBreakdown.passthrough).toBe(2);
    expect(parsed.perToolBreakdown.Edit.total).toBe(2);
    expect(parsed.perToolBreakdown.Edit.registryHits).toBe(1);
    expect(parsed.perToolBreakdown.Write.total).toBe(1);
    expect(parsed.perToolBreakdown.Write.registryHits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T-5: Multi-session aggregation — totals are sums; days-active counts distinct days
// ---------------------------------------------------------------------------
describe("T-5: multi-session aggregation", () => {
  it("sums totals across sessions and counts distinct calendar days", async () => {
    mkdirSync(telemetryDir, { recursive: true });

    // Session A: 2 events on day 2025-01-01
    const dayA = new Date("2025-01-01T10:00:00Z").getTime();
    const sessionA = [
      makeEvent({ t: dayA, toolName: "Edit", outcome: "passthrough" }),
      makeEvent({ t: dayA + 1000, toolName: "Write", outcome: "passthrough" }),
    ];
    writeFileSync(join(telemetryDir, "session-a.jsonl"), `${sessionA.join("\n")}\n`, "utf-8");

    // Session B: 3 events on day 2025-01-02
    const dayB = new Date("2025-01-02T12:00:00Z").getTime();
    const sessionB = [
      makeEvent({ t: dayB, toolName: "Edit", outcome: "registry-hit" }),
      makeEvent({ t: dayB + 1000, toolName: "MultiEdit", outcome: "passthrough" }),
      makeEvent({ t: dayB + 2000, toolName: "Edit", outcome: "synthesis-required" }),
    ];
    writeFileSync(join(telemetryDir, "session-b.jsonl"), `${sessionB.join("\n")}\n`, "utf-8");

    // Session C: 1 event also on day 2025-01-01 (same day as A — must not double-count)
    const sessionC = [
      makeEvent({ t: dayA + 3_600_000, toolName: "Write", outcome: "passthrough" }),
    ];
    writeFileSync(join(telemetryDir, "session-c.jsonl"), `${sessionC.join("\n")}\n`, "utf-8");

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);

    const parsed = JSON.parse(logger.logLines[0] as string);
    expect(parsed.summary.totalEvents).toBe(6); // 2 + 3 + 1
    expect(parsed.summary.sessionCount).toBe(3);
    expect(parsed.summary.daysActive).toBe(2); // 2025-01-01 and 2025-01-02 only
    expect(parsed.outcomeBreakdown.passthrough).toBe(4);
    expect(parsed.outcomeBreakdown.registryHit).toBe(1);
    expect(parsed.outcomeBreakdown.synthesisRequired).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T-6: Corrupt-line skip — valid events still counted, skippedLines reported
// ---------------------------------------------------------------------------
describe("T-6: corrupt-line skip", () => {
  it("skips malformed JSON and structurally-invalid objects; counts valid events", async () => {
    mkdirSync(telemetryDir, { recursive: true });

    const lines = [
      makeEvent({ toolName: "Edit", outcome: "passthrough" }),
      "this is not json at all",
      makeEvent({ toolName: "Write", outcome: "registry-hit" }),
      '{"t": 999}', // missing required toolName / outcome
      makeEvent({ toolName: "Edit", outcome: "passthrough" }),
      '{"t": 1, "outcome": "passthrough"', // truncated (unclosed brace)
    ];
    writeFileSync(
      join(telemetryDir, "session-corrupt.jsonl"),
      lines.join("\n"), // no trailing newline — extra robustness
      "utf-8",
    );

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);

    const parsed = JSON.parse(logger.logLines[0] as string);
    // 3 valid events (lines 1, 3, 5)
    expect(parsed.summary.totalEvents).toBe(3);
    // 3 skipped: "not json", missing-toolName object, truncated line
    expect(parsed.summary.skippedLines).toBe(3);
  });

  it("human output reports skipped-line count", async () => {
    mkdirSync(telemetryDir, { recursive: true });

    const lines = [
      makeEvent({ toolName: "Edit", outcome: "passthrough" }),
      "bad line",
      makeEvent({ toolName: "Write", outcome: "passthrough" }),
    ];
    writeFileSync(join(telemetryDir, "session-skip.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    const logger = new CollectingLogger();
    const code = await stats([], logger);
    expect(code).toBe(0);
    expect(logger.logLines.join("\n")).toMatch(/malformed line/i);
  });
});

// ---------------------------------------------------------------------------
// T-7: --since windowing
// ---------------------------------------------------------------------------
describe("T-7: --since windowing", () => {
  it("counts only events at/after the given ISO date", async () => {
    mkdirSync(telemetryDir, { recursive: true });

    const before = new Date("2025-01-01T00:00:00Z").getTime();
    const after = new Date("2025-06-01T00:00:00Z").getTime();

    const lines = [
      makeEvent({ t: before, outcome: "passthrough" }), // excluded
      makeEvent({ t: after, outcome: "registry-hit" }), // included (t === sinceMs boundary)
      makeEvent({ t: after + 1000, outcome: "passthrough" }), // included
    ];
    writeFileSync(join(telemetryDir, "session-since.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    const logger = new CollectingLogger();
    const code = await stats(["--since", "2025-06-01", "--json"], logger);
    expect(code).toBe(0);

    const parsed = JSON.parse(logger.logLines[0] as string);
    expect(parsed.summary.totalEvents).toBe(2);
    expect(parsed.outcomeBreakdown.registryHit).toBe(1);
    expect(parsed.outcomeBreakdown.passthrough).toBe(1);
  });

  it("lifetime default (no --since) counts all events", async () => {
    mkdirSync(telemetryDir, { recursive: true });

    const lines = [
      makeEvent({ t: new Date("2024-01-01").getTime(), outcome: "passthrough" }),
      makeEvent({ t: new Date("2025-01-01").getTime(), outcome: "passthrough" }),
    ];
    writeFileSync(join(telemetryDir, "session-all.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);
    const parsed = JSON.parse(logger.logLines[0] as string);
    expect(parsed.summary.totalEvents).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T-8: --since with invalid date → exit 1 with usage hint
// ---------------------------------------------------------------------------
describe("T-8: --since invalid date", () => {
  it("exits 1 with a usage hint for a non-parseable date string", async () => {
    const logger = new CollectingLogger();
    const code = await stats(["--since", "not-a-date"], logger);
    expect(code).toBe(1);
    const errOutput = logger.errLines.join("\n");
    expect(errOutput).toMatch(/iso-8601/i);
  });

  it("exits 1 with a usage hint for a clearly non-parseable string", async () => {
    // Note: "banana-2025" parses as a valid date on Node 22 (lenient Date.parse).
    // Use a string that is definitively unparseable on all Node versions.
    const logger = new CollectingLogger();
    const code = await stats(["--since", "not-a-real-date-at-all-xyz"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toMatch(/iso-8601/i);
  });
});

// ---------------------------------------------------------------------------
// T-9: --json shape validation
// ---------------------------------------------------------------------------
describe("T-9: --json shape", () => {
  it("emits exactly one log line of valid JSON with required top-level keys", async () => {
    mkdirSync(telemetryDir, { recursive: true });
    const lines = [makeEvent({ toolName: "Edit", outcome: "passthrough" })];
    writeFileSync(join(telemetryDir, "session-j.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);

    // Exactly one log line, no error lines
    expect(logger.logLines).toHaveLength(1);
    expect(logger.errLines).toHaveLength(0);

    // Valid JSON
    const parsed = JSON.parse(logger.logLines[0] as string);

    // Required top-level keys (additive-forward schema — DEC-CLI-STATS-COMMAND-001)
    expect(parsed).toHaveProperty("version");
    expect(parsed).toHaveProperty("generatedAt");
    expect(parsed).toHaveProperty("window");
    expect(parsed).toHaveProperty("summary");
    expect(parsed).toHaveProperty("outcomeBreakdown");
    expect(parsed).toHaveProperty("perToolBreakdown");
    expect(parsed).toHaveProperty("matchQuality");
    expect(parsed).toHaveProperty("sessions");

    // summary sub-keys
    expect(parsed.summary).toHaveProperty("totalEvents");
    expect(parsed.summary).toHaveProperty("sessionCount");
    expect(parsed.summary).toHaveProperty("daysActive");
    expect(parsed.summary).toHaveProperty("firstEventMs");
    expect(parsed.summary).toHaveProperty("lastEventMs");
    expect(parsed.summary).toHaveProperty("skippedLines");
  });

  it("zero-state --json is a well-formed object with zero counts", async () => {
    // No telemetry dir at all (T-1 empty-dir case via --json)
    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);
    expect(logger.logLines).toHaveLength(1);
    const parsed = JSON.parse(logger.logLines[0] as string);
    expect(parsed.summary.totalEvents).toBe(0);
    expect(parsed.outcomeBreakdown.registryHit).toBe(0);
    expect(parsed.matchQuality.scoredEvents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T-10: Unknown outcome resilience — grouped under "other", no crash
// ---------------------------------------------------------------------------
describe("T-10: unknown-outcome resilience", () => {
  it("groups unknown outcome under 'other'; all known counts still correct; no crash", async () => {
    mkdirSync(telemetryDir, { recursive: true });

    const lines = [
      makeEvent({ outcome: "passthrough" }),
      makeEvent({ outcome: "future-outcome-not-in-schema-yet" }),
      makeEvent({ outcome: "registry-hit" }),
    ];
    writeFileSync(join(telemetryDir, "session-unk.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);

    const parsed = JSON.parse(logger.logLines[0] as string);
    expect(parsed.summary.totalEvents).toBe(3);
    expect(parsed.outcomeBreakdown.other).toBe(1);
    expect(parsed.outcomeBreakdown.passthrough).toBe(1);
    expect(parsed.outcomeBreakdown.registryHit).toBe(1);
  });

  it("human output contains percentage markers and does not throw", async () => {
    mkdirSync(telemetryDir, { recursive: true });

    const lines = [
      makeEvent({ outcome: "passthrough" }),
      makeEvent({ outcome: "completely-unknown-future-value" }),
    ];
    writeFileSync(join(telemetryDir, "session-unk2.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    const logger = new CollectingLogger();
    const code = await stats([], logger);
    expect(code).toBe(0);
    // Percentages must appear (50.0% for each)
    expect(logger.logLines.join("\n")).toMatch(/%/);
  });
});

// ---------------------------------------------------------------------------
// T-11: Cosine distance bucket counts and median
// ---------------------------------------------------------------------------
describe("T-11: cosine distance buckets", () => {
  it("assigns scores to correct buckets and computes correct median", async () => {
    mkdirSync(telemetryDir, { recursive: true });

    // 2 excellent (<0.10), 1 good (0.10–0.20), 1 acceptable (0.20–0.30), 1 borderline (≥0.30)
    const lines = [
      makeEvent({ topScore: 0.05, outcome: "registry-hit" }), // excellent
      makeEvent({ topScore: 0.08, outcome: "registry-hit" }), // excellent
      makeEvent({ topScore: 0.15, outcome: "registry-hit" }), // good
      makeEvent({ topScore: 0.25, outcome: "registry-hit" }), // acceptable
      makeEvent({ topScore: 0.4, outcome: "registry-hit" }), // borderline
    ];
    writeFileSync(join(telemetryDir, "session-buckets.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);

    const parsed = JSON.parse(logger.logLines[0] as string);
    expect(parsed.matchQuality.buckets.excellent).toBe(2);
    expect(parsed.matchQuality.buckets.good).toBe(1);
    expect(parsed.matchQuality.buckets.acceptable).toBe(1);
    expect(parsed.matchQuality.buckets.borderline).toBe(1);
    expect(parsed.matchQuality.scoredEvents).toBe(5);

    // Median of [0.05, 0.08, 0.15, 0.25, 0.40] sorted = 0.15
    expect(parsed.matchQuality.medianTopScore).toBeCloseTo(0.15, 5);
  });

  it("human output shows 'no scored events' when all topScore values are null", async () => {
    mkdirSync(telemetryDir, { recursive: true });

    // Phase-1 passthrough events with null topScore (production reality)
    const lines = [
      makeEvent({ topScore: null, outcome: "passthrough" }),
      makeEvent({ topScore: null, outcome: "passthrough" }),
    ];
    writeFileSync(join(telemetryDir, "session-noscore.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    const logger = new CollectingLogger();
    const code = await stats([], logger);
    expect(code).toBe(0);
    expect(logger.logLines.join("\n")).toMatch(/no scored events/i);
  });
});

// ---------------------------------------------------------------------------
// Drift-alert sentinel exclusion (plan §2.6 — candidateCount === -1 are not real intercepts)
// ---------------------------------------------------------------------------
describe("drift-alert sentinel exclusion", () => {
  it("excludes drift-alert events (candidateCount=-1) from intercept tallies", async () => {
    mkdirSync(telemetryDir, { recursive: true });

    const lines = [
      makeEvent({ outcome: "passthrough", candidateCount: 0 }),
      // drift-alert sentinel per DEC-HOOK-ENF-LAYER5-TELEMETRY-001
      JSON.stringify({
        t: Date.now(),
        intentHash: "drift:passthrough_rate:abc12345",
        toolName: "Edit",
        candidateCount: -1,
        topScore: null,
        substituted: false,
        substitutedAtomHash: null,
        latencyMs: 0,
        outcome: "drift-alert",
      }),
      makeEvent({ outcome: "passthrough", candidateCount: 0 }),
    ];
    writeFileSync(join(telemetryDir, "session-drift.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);

    const parsed = JSON.parse(logger.logLines[0] as string);
    // Only 2 real events — drift-alert sentinel is excluded
    expect(parsed.summary.totalEvents).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T-TIER2: Tier-2 + Tier-3 integration tests for `stats --json` atoms block
//
// These tests exercise the full pipeline: file → readTelemetrySessions →
// collectAtomReuse → printJsonOutput → atoms key in --json.
//
// Registry is driven through degraded mode (YAKCC_REGISTRY_PATH set to a
// non-existent path) for all tests that don't need grain enrichment.
// That is sufficient to prove the additive-forward invariant (Tier-1 keys
// unchanged) and the empty-state / mixed-outcome behaviour defined in the
// planner's Evaluation Contract.
//
// Note: the narrowing hit definition (outcome=registry-hit && substituted=true
// && substitutedAtomHash !== null) is verified here at the integration level;
// the unit-level percentile / tiebreak math is in stats-atoms.test.ts.
// ---------------------------------------------------------------------------

/** Build a minimal registry-hit event with the Tier-2 narrow hit criteria met. */
function makeHitEvent(overrides: {
  t?: number;
  substitutedAtomHash?: string;
  toolName?: string;
}): string {
  const event = {
    t: overrides.t ?? Date.now(),
    intentHash: "aabbccdd",
    toolName: overrides.toolName ?? "Edit",
    candidateCount: 1,
    topScore: 0.05,
    substituted: true,
    substitutedAtomHash: overrides.substitutedAtomHash ?? "deadbeef0001",
    latencyMs: 10,
    outcome: "registry-hit",
  };
  return JSON.stringify(event);
}

// Helper: set YAKCC_REGISTRY_PATH to a path whose *parent directory* does not
// exist. better-sqlite3's `new Database(path)` creates the file when the dir
// exists (auto-create), but throws ENOENT when the parent directory is absent.
// This reliably triggers the degraded-mode path in collectAtomReuse without
// requiring a real registry SQLite file.
function useAbsentRegistry(): void {
  process.env.YAKCC_REGISTRY_PATH = join(tmpDir, "no-such-dir", "registry.db");
}

describe("T-TIER2-1: empty telemetry → atoms zero-shaped block present in --json", () => {
  it("--json zero-state: atoms key present, top=[], hitRateP50=null, hitRateP90=null", async () => {
    // No telemetry at all (dir absent)
    useAbsentRegistry();
    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);
    const parsed = JSON.parse(logger.logLines[0] as string);

    // atoms block must be present (additive-forward: key always emitted)
    expect(parsed).toHaveProperty("atoms");
    const { atoms } = parsed;
    expect(atoms.top).toEqual([]);
    expect(atoms.hitRateP50).toBeNull();
    expect(atoms.hitRateP90).toBeNull();
    // When there are zero hit events the empty-state path returns grainHistogram + locSaved
    // (non-degraded zero-shape, per stats-atoms.ts line 172-180).
    expect(atoms.degraded).toBe(false);
    expect(atoms.grainHistogram).toEqual({ L0: 0, L1: 0, L2: 0, L3: 0, unknown: 0 });
    expect(atoms.locSaved).toEqual({ total: 0, byAtom: [] });
  });
});

describe("T-TIER2-2: Tier-1 keys unchanged when Tier-2 is computed (additive-forward invariant)", () => {
  it("--json with hit events: Tier-1 keys outcomeBreakdown/perToolBreakdown/matchQuality/sessions all intact", async () => {
    mkdirSync(telemetryDir, { recursive: true });
    useAbsentRegistry();

    // Mix of hit and non-hit events
    const lines = [
      makeHitEvent({ substitutedAtomHash: "atom0001" }), // hit
      makeHitEvent({ substitutedAtomHash: "atom0001" }), // hit (same atom)
      makeEvent({ toolName: "Write", outcome: "passthrough" }), // non-hit
      makeEvent({ toolName: "Edit", outcome: "synthesis-required" }), // non-hit
    ];
    writeFileSync(
      join(telemetryDir, "session-t2-additive.jsonl"),
      `${lines.join("\n")}\n`,
      "utf-8",
    );

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);
    const parsed = JSON.parse(logger.logLines[0] as string);

    // Tier-1 keys all present and correct
    expect(parsed).toHaveProperty("version");
    expect(parsed).toHaveProperty("generatedAt");
    expect(parsed).toHaveProperty("window");
    expect(parsed).toHaveProperty("summary");
    expect(parsed).toHaveProperty("outcomeBreakdown");
    expect(parsed).toHaveProperty("perToolBreakdown");
    expect(parsed).toHaveProperty("matchQuality");
    expect(parsed).toHaveProperty("sessions");

    // Tier-1 correctness: 4 total events (2 hits + 1 passthrough + 1 synthesis-required)
    expect(parsed.summary.totalEvents).toBe(4);
    expect(parsed.outcomeBreakdown.registryHit).toBe(2);
    expect(parsed.outcomeBreakdown.passthrough).toBe(1);
    expect(parsed.outcomeBreakdown.synthesisRequired).toBe(1);

    // Tier-2 atoms block also present
    expect(parsed).toHaveProperty("atoms");
  });
});

describe("T-TIER2-3: mixed outcomes — only narrow hits contribute to atoms.top", () => {
  it("passthrough/synthesis-required events do not appear in atoms.top", async () => {
    mkdirSync(telemetryDir, { recursive: true });
    useAbsentRegistry();

    const lines = [
      // Narrow hit (qualifies)
      makeHitEvent({ substitutedAtomHash: "qualifyHash001" }),
      // registry-hit but substituted=false (does NOT qualify — misses narrow definition)
      JSON.stringify({
        t: Date.now(),
        intentHash: "aabb",
        toolName: "Edit",
        candidateCount: 1,
        topScore: 0.05,
        substituted: false,
        substitutedAtomHash: "shouldNotAppear",
        latencyMs: 10,
        outcome: "registry-hit",
      }),
      // registry-hit but substitutedAtomHash=null (does NOT qualify)
      JSON.stringify({
        t: Date.now(),
        intentHash: "aabb",
        toolName: "Edit",
        candidateCount: 1,
        topScore: 0.05,
        substituted: true,
        substitutedAtomHash: null,
        latencyMs: 10,
        outcome: "registry-hit",
      }),
      // passthrough — does not qualify
      makeEvent({ toolName: "Write", outcome: "passthrough" }),
      // synthesis-required — does not qualify
      makeEvent({ toolName: "Edit", outcome: "synthesis-required" }),
    ];
    writeFileSync(join(telemetryDir, "session-t2-narrow.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);
    const parsed = JSON.parse(logger.logLines[0] as string);

    // Only "qualifyHash001" should appear
    expect(parsed.atoms.top).toHaveLength(1);
    expect(parsed.atoms.top[0].atomHash).toBe("qualifyHash001");
    expect(parsed.atoms.top[0].hits).toBe(1);
    // Tier-1 totalEvents still counts all 5 non-drift events
    expect(parsed.summary.totalEvents).toBe(5);
  });
});

describe("T-TIER2-4: degraded mode (registry absent) — top populated, grain fields null", () => {
  it("atoms.degraded=true, atoms.top entries have level=null, lines=null; no crash", async () => {
    mkdirSync(telemetryDir, { recursive: true });
    useAbsentRegistry();

    const lines = [
      makeHitEvent({ substitutedAtomHash: "atomXXX" }),
      makeHitEvent({ substitutedAtomHash: "atomXXX" }),
      makeHitEvent({ substitutedAtomHash: "atomYYY" }),
    ];
    writeFileSync(
      join(telemetryDir, "session-t2-degraded.jsonl"),
      `${lines.join("\n")}\n`,
      "utf-8",
    );

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);
    const parsed = JSON.parse(logger.logLines[0] as string);

    expect(parsed.atoms.degraded).toBe(true);
    expect(parsed.atoms.degradedReason).toBe("registry-not-found");
    // top is present; grain enrichment is null
    expect(parsed.atoms.top.length).toBeGreaterThanOrEqual(1);
    for (const entry of parsed.atoms.top) {
      expect(entry.level).toBeNull();
      expect(entry.lines).toBeNull();
    }
    // grainHistogram and locSaved are absent when degraded
    expect(parsed.atoms).not.toHaveProperty("grainHistogram");
    expect(parsed.atoms).not.toHaveProperty("locSaved");
  });
});

describe("T-TIER2-5: top-N ordering — descending hits, ascending atomHash tiebreak", () => {
  it("atom with 3 hits ranks above atom with 2 hits; equal-hit tie broken by asc hash", async () => {
    mkdirSync(telemetryDir, { recursive: true });
    useAbsentRegistry();

    const lines = [
      makeHitEvent({ substitutedAtomHash: "zzz-atom" }), // 2 hits
      makeHitEvent({ substitutedAtomHash: "zzz-atom" }),
      makeHitEvent({ substitutedAtomHash: "aaa-atom" }), // 3 hits
      makeHitEvent({ substitutedAtomHash: "aaa-atom" }),
      makeHitEvent({ substitutedAtomHash: "aaa-atom" }),
      makeHitEvent({ substitutedAtomHash: "mmm-atom" }), // 2 hits (tie with zzz-atom)
      makeHitEvent({ substitutedAtomHash: "mmm-atom" }),
    ];
    writeFileSync(join(telemetryDir, "session-t2-order.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);
    const parsed = JSON.parse(logger.logLines[0] as string);

    const top = parsed.atoms.top as Array<{ atomHash: string; hits: number }>;
    expect(top).toHaveLength(3);
    // First: highest hits
    expect(top[0]?.atomHash).toBe("aaa-atom");
    expect(top[0]?.hits).toBe(3);
    // Second: tiebreak asc hash: "mmm-atom" < "zzz-atom"
    expect(top[1]?.atomHash).toBe("mmm-atom");
    expect(top[1]?.hits).toBe(2);
    // Third
    expect(top[2]?.atomHash).toBe("zzz-atom");
    expect(top[2]?.hits).toBe(2);
  });
});

describe("T-TIER2-6: hitRateP50 / hitRateP90 with multiple distinct atoms", () => {
  it("P50 and P90 over per-atom hit counts match nearest-rank formula", async () => {
    mkdirSync(telemetryDir, { recursive: true });
    useAbsentRegistry();

    // 4 distinct atoms with hit counts: [1, 2, 3, 4] (sorted asc for percentile)
    // nearest-rank P50 of [1,2,3,4]: ceil(0.5*4)-1 = idx 1 → 2
    // nearest-rank P90 of [1,2,3,4]: ceil(0.9*4)-1 = idx 3 → 4
    const atoms = ["atom-p-1", "atom-p-2", "atom-p-3", "atom-p-4"] as const;
    const lines: string[] = [];
    for (const [i, hash] of atoms.entries()) {
      for (let j = 0; j <= i; j++) {
        lines.push(makeHitEvent({ substitutedAtomHash: hash }));
      }
    }
    writeFileSync(join(telemetryDir, "session-t2-pct.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);
    const parsed = JSON.parse(logger.logLines[0] as string);

    expect(parsed.atoms.hitRateP50).toBe(2);
    expect(parsed.atoms.hitRateP90).toBe(4);
  });
});

describe("T-TIER2-7: drift-alert sentinels excluded from atoms even when substitutedAtomHash present", () => {
  it("drift-alert candidateCount=-1 events do not contribute to atoms.top hits", async () => {
    mkdirSync(telemetryDir, { recursive: true });
    useAbsentRegistry();

    const driftEvent = JSON.stringify({
      t: Date.now(),
      intentHash: "drift:passthrough_rate:abc12345",
      toolName: "Edit",
      candidateCount: -1,
      topScore: null,
      substituted: true,
      substitutedAtomHash: "drift-hash-should-not-count",
      latencyMs: 0,
      outcome: "drift-alert",
    });
    const realHit = makeHitEvent({ substitutedAtomHash: "real-hit-atom" });
    writeFileSync(
      join(telemetryDir, "session-t2-drift.jsonl"),
      `${driftEvent}\n${realHit}\n`,
      "utf-8",
    );

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);
    const parsed = JSON.parse(logger.logLines[0] as string);

    // Only real-hit-atom should appear
    expect(parsed.atoms.top).toHaveLength(1);
    expect(parsed.atoms.top[0].atomHash).toBe("real-hit-atom");
    // Tier-1 also excludes drift-alert: only 1 real event
    expect(parsed.summary.totalEvents).toBe(1);
  });
});

describe("T-TIER2-8: compound production-sequence with Tier-2 — full file→output pipeline", () => {
  it("end-to-end: multiple sessions, mixed outcomes, atoms block in --json alongside all Tier-1 blocks", async () => {
    mkdirSync(telemetryDir, { recursive: true });
    useAbsentRegistry();

    const dayA = new Date("2026-01-01T10:00:00Z").getTime();
    const dayB = new Date("2026-01-02T12:00:00Z").getTime();

    // Session A: 2 hits on atom-A, 1 passthrough
    const sessionA = [
      makeHitEvent({ t: dayA, substitutedAtomHash: "atom-A" }),
      makeHitEvent({ t: dayA + 500, substitutedAtomHash: "atom-A" }),
      makeEvent({ t: dayA + 1000, toolName: "Write", outcome: "passthrough" }),
    ];
    writeFileSync(
      join(telemetryDir, "session-compound-a.jsonl"),
      `${sessionA.join("\n")}\n`,
      "utf-8",
    );

    // Session B: 1 hit on atom-B, 1 synthesis-required
    const sessionB = [
      makeHitEvent({ t: dayB, substitutedAtomHash: "atom-B" }),
      makeEvent({ t: dayB + 1000, toolName: "Edit", outcome: "synthesis-required" }),
    ];
    writeFileSync(
      join(telemetryDir, "session-compound-b.jsonl"),
      `${sessionB.join("\n")}\n`,
      "utf-8",
    );

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);
    expect(logger.logLines).toHaveLength(1);
    const parsed = JSON.parse(logger.logLines[0] as string);

    // --- Tier-1 correctness ---
    expect(parsed.summary.totalEvents).toBe(5);
    expect(parsed.summary.sessionCount).toBe(2);
    expect(parsed.summary.daysActive).toBe(2);
    expect(parsed.outcomeBreakdown.registryHit).toBe(3);
    expect(parsed.outcomeBreakdown.passthrough).toBe(1);
    expect(parsed.outcomeBreakdown.synthesisRequired).toBe(1);

    // --- Tier-2 correctness ---
    // Only narrow hits qualify: atom-A (2 hits), atom-B (1 hit)
    expect(parsed.atoms.top).toHaveLength(2);
    // atom-A has more hits → first
    expect(parsed.atoms.top[0].atomHash).toBe("atom-A");
    expect(parsed.atoms.top[0].hits).toBe(2);
    expect(parsed.atoms.top[1].atomHash).toBe("atom-B");
    expect(parsed.atoms.top[1].hits).toBe(1);

    // Percentiles: sorted hit counts = [1, 2]
    // P50 nearest-rank: ceil(0.5*2)-1 = idx 0 → 1
    // P90 nearest-rank: ceil(0.9*2)-1 = idx 1 → 2
    expect(parsed.atoms.hitRateP50).toBe(1);
    expect(parsed.atoms.hitRateP90).toBe(2);

    // Degraded (absent registry) → no grainHistogram / locSaved
    expect(parsed.atoms.degraded).toBe(true);

    // All Tier-1 keys present and account for registry-hit events in both tiers
    expect(parsed).toHaveProperty("version");
    expect(parsed).toHaveProperty("matchQuality");
    expect(parsed).toHaveProperty("sessions");
  });
});

// ---------------------------------------------------------------------------
// Index.ts dispatch wiring — compound integration test proving the full
// production sequence: runCli → case "stats" → stats() → output
// (Evaluation Contract: "exercised end-to-end through index.ts dispatch")
// ---------------------------------------------------------------------------
describe("index.ts dispatch wiring (compound production-sequence test)", () => {
  it("runCli(['stats']) dispatches to stats command (empty-state)", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["stats"], logger);
    expect(code).toBe(0);
    expect(logger.logLines.join("\n")).toMatch(/no telemetry/i);
  });

  it("runCli(['stats', '--json']) dispatches to stats command (empty-state JSON)", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["stats", "--json"], logger);
    expect(code).toBe(0);
    expect(logger.logLines).toHaveLength(1);
    const parsed = JSON.parse(logger.logLines[0] as string);
    expect(parsed.summary.totalEvents).toBe(0);
  });

  it("runCli(['stats']) with real fixture data: full pipeline from file → output", async () => {
    mkdirSync(telemetryDir, { recursive: true });
    const lines = [
      makeEvent({ toolName: "Edit", outcome: "registry-hit" }),
      makeEvent({ toolName: "Write", outcome: "passthrough" }),
    ];
    writeFileSync(join(telemetryDir, "session-dispatch.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    const logger = new CollectingLogger();
    const code = await runCli(["stats", "--json"], logger);
    expect(code).toBe(0);
    const parsed = JSON.parse(logger.logLines[0] as string);
    expect(parsed.summary.totalEvents).toBe(2);
    expect(parsed.outcomeBreakdown.registryHit).toBe(1);
  });

  it("runCli(['--help']) output contains 'stats' in COMMANDS block", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["--help"], logger);
    expect(code).toBe(0);
    expect(logger.logLines.join("\n")).toContain("stats");
  });
});
