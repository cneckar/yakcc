// SPDX-License-Identifier: MIT
/**
 * shave-on-miss-state.test.ts -- Unit tests for WI-508 Slice 3 state management.
 *
 * Tests cover:
 *   1. resolveStatePath -- env-var override and default path
 *   2. loadShaveOnMissState -- empty state from nonexistent file
 *   3. loadShaveOnMissState -- reads state from file
 *   4. saveShaveOnMissState -- writes state to file; round-trip
 *   5. withCompletion -- adds binding key to completedBindings (idempotent)
 *   6. withHitIncrement -- increments hitCounts[key]
 *   7. withMissIncrement -- increments missCounts[packageName]
 *   8. resolveSkipShaveHitThreshold -- env-var override and default
 *   9. resolvePreemptiveMissThreshold -- env-var override and default
 *  10. listPackageBindings -- standard and versioned fixture layout
 *  11. recordImportHit -- increments hit count and persists
 *  12. makeBindingKey -- correct format
 *
 * @decision DEC-WI508-S3-STATE-PERSIST-001
 * @decision DEC-WI508-S3-KEY-FORMAT-001
 * @decision DEC-WI508-S3-SKIP-HIT-THRESHOLD-001
 * @decision DEC-WI508-S3-PREEMPTIVE-MISS-THRESHOLD-001
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetShaveOnMissState,
  getState,
  listPackageBindings,
  loadShaveOnMissState,
  makeBindingKey,
  recordImportHit,
  resolvePreemptiveMissThreshold,
  resolveSkipShaveHitThreshold,
  resolveStatePath,
  saveShaveOnMissState,
  updateState,
  withCompletion,
  withHitIncrement,
  withMissIncrement,
} from "../src/shave-on-miss-state.js";

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../shave/src/__fixtures__/module-graph",
);

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `shave-on-miss-state-test-${process.pid}-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  // Reset the in-memory state cache between tests.
  _resetShaveOnMissState();
});

afterEach(() => {
  _resetShaveOnMissState();
  // Remove temp dir.
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  // Restore env vars.
  // biome-ignore lint/performance/noDelete: env-var removal is intentional
  delete process.env.YAKCC_SHAVE_ON_MISS_STATE_PATH;
  // biome-ignore lint/performance/noDelete: env-var removal is intentional
  delete process.env.YAKCC_SKIP_SHAVE_HIT_THRESHOLD;
  // biome-ignore lint/performance/noDelete: env-var removal is intentional
  delete process.env.YAKCC_PREEMPTIVE_SHAVE_MISS_THRESHOLD;
});

// ---------------------------------------------------------------------------
// §1: resolveStatePath
// ---------------------------------------------------------------------------

describe("resolveStatePath", () => {
  it("returns YAKCC_SHAVE_ON_MISS_STATE_PATH when set", () => {
    process.env.YAKCC_SHAVE_ON_MISS_STATE_PATH = "/custom/state.json";
    expect(resolveStatePath()).toBe("/custom/state.json");
  });

  it("returns a default path ending with shave-on-miss-state.json when env var not set", () => {
    // biome-ignore lint/performance/noDelete: env-var removal is intentional
    delete process.env.YAKCC_SHAVE_ON_MISS_STATE_PATH;
    const path = resolveStatePath();
    expect(path).toMatch(/shave-on-miss-state\.json$/);
  });
});

// ---------------------------------------------------------------------------
// §2: loadShaveOnMissState -- nonexistent file
// ---------------------------------------------------------------------------

describe("loadShaveOnMissState -- nonexistent file", () => {
  it("returns empty state when file does not exist", () => {
    const path = join(tempDir, "does-not-exist.json");
    const state = loadShaveOnMissState(path);
    expect(state.version).toBe(1);
    expect(state.completedBindings).toHaveLength(0);
    expect(state.hitCounts).toEqual({});
    expect(state.missCounts).toEqual({});
  });

  it("returns empty state when file contains invalid JSON", () => {
    const path = join(tempDir, "invalid.json");
    writeFileSync(path, "not json", "utf-8");
    const state = loadShaveOnMissState(path);
    expect(state.completedBindings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §3: loadShaveOnMissState -- existing file
// ---------------------------------------------------------------------------

describe("loadShaveOnMissState -- existing file", () => {
  it("reads completedBindings, hitCounts, missCounts from file", () => {
    const path = join(tempDir, "state.json");
    const stored = {
      version: 1,
      completedBindings: ["validator::isEmail"],
      hitCounts: { "validator::isEmail": 5 },
      missCounts: { validator: 2 },
    };
    writeFileSync(path, JSON.stringify(stored), "utf-8");

    const state = loadShaveOnMissState(path);
    expect(state.completedBindings).toContain("validator::isEmail");
    expect(state.hitCounts["validator::isEmail"]).toBe(5);
    expect(state.missCounts["validator"]).toBe(2);
  });

  it("handles missing optional fields gracefully (partial state)", () => {
    const path = join(tempDir, "partial.json");
    writeFileSync(path, JSON.stringify({ version: 1, completedBindings: ["a::b"] }), "utf-8");
    const state = loadShaveOnMissState(path);
    expect(state.completedBindings).toContain("a::b");
    expect(state.hitCounts).toEqual({});
    expect(state.missCounts).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// §4: saveShaveOnMissState -- round-trip
// ---------------------------------------------------------------------------

describe("saveShaveOnMissState", () => {
  it("writes state to file and can be read back", () => {
    const path = join(tempDir, "state.json");
    const state = {
      version: 1 as const,
      completedBindings: ["validator::isEmail", "validator::isURL"],
      hitCounts: { "validator::isEmail": 3 },
      missCounts: { validator: 1 },
    };
    saveShaveOnMissState(state, path);
    expect(existsSync(path)).toBe(true);

    const loaded = loadShaveOnMissState(path);
    expect(loaded.completedBindings).toEqual(state.completedBindings);
    expect(loaded.hitCounts["validator::isEmail"]).toBe(3);
    expect(loaded.missCounts["validator"]).toBe(1);
  });

  it("creates parent directories as needed", () => {
    const deepPath = join(tempDir, "deep", "nested", "state.json");
    const state = {
      version: 1 as const,
      completedBindings: [],
      hitCounts: {},
      missCounts: {},
    };
    saveShaveOnMissState(state, deepPath);
    expect(existsSync(deepPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §5: withCompletion
// ---------------------------------------------------------------------------

describe("withCompletion", () => {
  it("adds a new binding key to completedBindings", () => {
    const base = { version: 1 as const, completedBindings: [], hitCounts: {}, missCounts: {} };
    const updated = withCompletion(base, "validator::isEmail");
    expect(updated.completedBindings).toContain("validator::isEmail");
  });

  it("is idempotent -- adding the same key twice does not duplicate", () => {
    const base = {
      version: 1 as const,
      completedBindings: ["validator::isEmail"],
      hitCounts: {},
      missCounts: {},
    };
    const updated = withCompletion(base, "validator::isEmail");
    expect(updated.completedBindings.filter((k) => k === "validator::isEmail")).toHaveLength(1);
  });

  it("does not mutate the original state", () => {
    const base = { version: 1 as const, completedBindings: [], hitCounts: {}, missCounts: {} };
    withCompletion(base, "validator::isEmail");
    expect(base.completedBindings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §6: withHitIncrement
// ---------------------------------------------------------------------------

describe("withHitIncrement", () => {
  it("increments hitCounts[key] from 0", () => {
    const base = { version: 1 as const, completedBindings: [], hitCounts: {}, missCounts: {} };
    const updated = withHitIncrement(base, "validator::isEmail");
    expect(updated.hitCounts["validator::isEmail"]).toBe(1);
  });

  it("increments hitCounts[key] from existing value", () => {
    const base = {
      version: 1 as const,
      completedBindings: [],
      hitCounts: { "validator::isEmail": 4 },
      missCounts: {},
    };
    const updated = withHitIncrement(base, "validator::isEmail");
    expect(updated.hitCounts["validator::isEmail"]).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// §7: withMissIncrement
// ---------------------------------------------------------------------------

describe("withMissIncrement", () => {
  it("increments missCounts[packageName] from 0", () => {
    const base = { version: 1 as const, completedBindings: [], hitCounts: {}, missCounts: {} };
    const updated = withMissIncrement(base, "validator");
    expect(updated.missCounts["validator"]).toBe(1);
  });

  it("increments missCounts[packageName] from existing value", () => {
    const base = {
      version: 1 as const,
      completedBindings: [],
      hitCounts: {},
      missCounts: { validator: 2 },
    };
    const updated = withMissIncrement(base, "validator");
    expect(updated.missCounts["validator"]).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// §8: resolveSkipShaveHitThreshold
// ---------------------------------------------------------------------------

describe("resolveSkipShaveHitThreshold", () => {
  it("returns default 2 when env var not set", () => {
    // biome-ignore lint/performance/noDelete: env-var removal is intentional
    delete process.env.YAKCC_SKIP_SHAVE_HIT_THRESHOLD;
    expect(resolveSkipShaveHitThreshold()).toBe(2);
  });

  it("returns parsed value from YAKCC_SKIP_SHAVE_HIT_THRESHOLD", () => {
    process.env.YAKCC_SKIP_SHAVE_HIT_THRESHOLD = "5";
    expect(resolveSkipShaveHitThreshold()).toBe(5);
  });

  it("falls back to default on invalid env var", () => {
    process.env.YAKCC_SKIP_SHAVE_HIT_THRESHOLD = "not-a-number";
    expect(resolveSkipShaveHitThreshold()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §9: resolvePreemptiveMissThreshold
// ---------------------------------------------------------------------------

describe("resolvePreemptiveMissThreshold", () => {
  it("returns default 3 when env var not set", () => {
    // biome-ignore lint/performance/noDelete: env-var removal is intentional
    delete process.env.YAKCC_PREEMPTIVE_SHAVE_MISS_THRESHOLD;
    expect(resolvePreemptiveMissThreshold()).toBe(3);
  });

  it("returns parsed value from YAKCC_PREEMPTIVE_SHAVE_MISS_THRESHOLD", () => {
    process.env.YAKCC_PREEMPTIVE_SHAVE_MISS_THRESHOLD = "10";
    expect(resolvePreemptiveMissThreshold()).toBe(10);
  });

  it("falls back to default on invalid env var", () => {
    process.env.YAKCC_PREEMPTIVE_SHAVE_MISS_THRESHOLD = "abc";
    expect(resolvePreemptiveMissThreshold()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// §10: listPackageBindings
// ---------------------------------------------------------------------------

describe("listPackageBindings", () => {
  it("returns binding names from versioned fixture layout", () => {
    const bindings = listPackageBindings("validator", FIXTURE_DIR);
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings).toContain("isEmail");
    expect(bindings).toContain("isURL");
    expect(bindings).toContain("isUUID");
    expect(bindings).toContain("isAlphanumeric");
  });

  it("returns empty array when package not in corpus", () => {
    const bindings = listPackageBindings("totally-unknown-package", FIXTURE_DIR);
    expect(bindings).toHaveLength(0);
  });

  it("returns empty array when corpus dir does not exist", () => {
    const bindings = listPackageBindings("validator", "/nonexistent/path");
    expect(bindings).toHaveLength(0);
  });

  it("returns binding names from standard layout (non-versioned)", () => {
    // Standard layout: corpusDir/{packageName}/lib/*.js
    // The versioned fixture dir acts as a standard layout package named "validator-13.15.35".
    const bindings = listPackageBindings("validator-13.15.35", FIXTURE_DIR);
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings).toContain("isEmail");
  });
});

// ---------------------------------------------------------------------------
// §11: recordImportHit
// ---------------------------------------------------------------------------

describe("recordImportHit", () => {
  it("increments hit count for a binding and persists to state path", () => {
    const statePath = join(tempDir, "hits.json");
    process.env.YAKCC_SHAVE_ON_MISS_STATE_PATH = statePath;

    recordImportHit("validator", "isEmail");

    const loaded = loadShaveOnMissState(statePath);
    expect(loaded.hitCounts["validator::isEmail"]).toBe(1);
  });

  it("accumulates hit counts across multiple calls", () => {
    const statePath = join(tempDir, "hits2.json");
    process.env.YAKCC_SHAVE_ON_MISS_STATE_PATH = statePath;

    recordImportHit("validator", "isEmail");
    _resetShaveOnMissState(); // simulate re-load from disk
    recordImportHit("validator", "isEmail");

    const loaded = loadShaveOnMissState(statePath);
    expect(loaded.hitCounts["validator::isEmail"]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §12: makeBindingKey
// ---------------------------------------------------------------------------

describe("makeBindingKey", () => {
  it("produces packageName::binding format", () => {
    expect(makeBindingKey("validator", "isEmail")).toBe("validator::isEmail");
    expect(makeBindingKey("zod", "z")).toBe("zod::z");
  });
});

// ---------------------------------------------------------------------------
// §13: getState + updateState cache
// ---------------------------------------------------------------------------

describe("getState / updateState cache", () => {
  it("getState returns empty state when no file exists", () => {
    process.env.YAKCC_SHAVE_ON_MISS_STATE_PATH = join(tempDir, "nope.json");
    const state = getState();
    expect(state.completedBindings).toHaveLength(0);
  });

  it("updateState updates the cache and saves to disk", () => {
    const statePath = join(tempDir, "cache.json");
    process.env.YAKCC_SHAVE_ON_MISS_STATE_PATH = statePath;

    const newState = {
      version: 1 as const,
      completedBindings: ["validator::isEmail"],
      hitCounts: {},
      missCounts: {},
    };
    updateState(newState);

    // Cache reflects the update.
    expect(getState().completedBindings).toContain("validator::isEmail");
    // Disk reflects the update.
    const loaded = loadShaveOnMissState(statePath);
    expect(loaded.completedBindings).toContain("validator::isEmail");
  });
});
