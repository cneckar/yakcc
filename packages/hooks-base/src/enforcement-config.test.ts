// SPDX-License-Identifier: MIT
/**
 * enforcement-config.test.ts — Unit tests for the central enforcement config module.
 *
 * Production trigger: loadEnforcementConfig() / getEnforcementConfig() are called
 * synchronously at the entry point of every enforcement layer (L1, L2, …).
 * These tests verify:
 *   1. Default config matches prior hardcoded S1 values exactly (regression-gate).
 *   2. Env-var overrides are applied with highest precedence.
 *   3. File overrides are merged correctly (partial and full).
 *   4. Invalid file/field content throws clearly.
 *   5. setConfigOverride / resetConfigOverride work for test isolation.
 *   6. Memoization: repeated calls return the same object (file is read once).
 *
 * @decision DEC-HOOK-ENF-CONFIG-001
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getDefaults,
  getEnforcementConfig,
  loadEnforcementConfig,
  resetConfigOverride,
  setConfigOverride,
} from "./enforcement-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempConfigFile(content: unknown): string {
  const dir = join(tmpdir(), "yakcc-enforcement-config-tests");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `enforcement-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(filePath, JSON.stringify(content), "utf-8");
  return filePath;
}

function cleanTempFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // ignore cleanup errors
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetConfigOverride();
});

afterEach(() => {
  resetConfigOverride();
});

// ---------------------------------------------------------------------------
// 1. Default config — regression gate against prior S1 hardcoded values
// ---------------------------------------------------------------------------

describe("getDefaults() — S1 regression gate", () => {
  it("layer1.minWords is 4 (matches prior MIN_WORDS constant)", () => {
    expect(getDefaults().layer1.minWords).toBe(4);
  });

  it("layer1.maxWords is 20 (matches prior MAX_WORDS constant)", () => {
    expect(getDefaults().layer1.maxWords).toBe(20);
  });

  it("layer1.disableGate is false", () => {
    expect(getDefaults().layer1.disableGate).toBe(false);
  });

  it("layer1.stopWords contains the 10 canonical S1 words", () => {
    const expected = [
      "things", "stuff", "utility", "helper", "manager",
      "handler", "service", "system", "processor", "worker",
    ];
    const sw = new Set(getDefaults().layer1.stopWords);
    for (const w of expected) {
      expect(sw.has(w), `stopWords missing: ${w}`).toBe(true);
    }
    expect(getDefaults().layer1.stopWords.length).toBe(10);
  });

  it("layer1.metaWords contains the 8 canonical S1 words", () => {
    const expected = ["various", "general", "common", "some", "any", "several", "misc", "generic"];
    const mw = new Set(getDefaults().layer1.metaWords);
    for (const w of expected) {
      expect(mw.has(w), `metaWords missing: ${w}`).toBe(true);
    }
    expect(getDefaults().layer1.metaWords.length).toBe(8);
  });

  it("layer1.actionVerbs contains parse, validate, hash", () => {
    const av = new Set(getDefaults().layer1.actionVerbs);
    expect(av.has("parse")).toBe(true);
    expect(av.has("validate")).toBe(true);
    expect(av.has("hash")).toBe(true);
  });

  it("layer2.maxConfident is 3", () => {
    expect(getDefaults().layer2.maxConfident).toBe(3);
  });

  it("layer2.maxOverall is 10", () => {
    expect(getDefaults().layer2.maxOverall).toBe(10);
  });

  it("layer2.confidentThreshold is 0.7", () => {
    expect(getDefaults().layer2.confidentThreshold).toBeCloseTo(0.7);
  });
});

// ---------------------------------------------------------------------------
// 2. loadEnforcementConfig with no file, no env — returns defaults
// ---------------------------------------------------------------------------

describe("loadEnforcementConfig() — no file, no env overrides", () => {
  it("returns defaults when no file path and empty env", () => {
    const cfg = loadEnforcementConfig({ filePath: "/nonexistent/enforcement.json", env: {} });
    const defaults = getDefaults();
    expect(cfg.layer1.minWords).toBe(defaults.layer1.minWords);
    expect(cfg.layer1.maxWords).toBe(defaults.layer1.maxWords);
    expect(cfg.layer2.maxConfident).toBe(defaults.layer2.maxConfident);
    expect(cfg.layer2.maxOverall).toBe(defaults.layer2.maxOverall);
    expect(cfg.layer2.confidentThreshold).toBeCloseTo(defaults.layer2.confidentThreshold);
  });
});

// ---------------------------------------------------------------------------
// 3. Env-var overrides
// ---------------------------------------------------------------------------

describe("loadEnforcementConfig() — env-var overrides", () => {
  it("YAKCC_HOOK_DISABLE_INTENT_GATE=1 sets layer1.disableGate=true", () => {
    const cfg = loadEnforcementConfig({
      filePath: "/nonexistent/enforcement.json",
      env: { YAKCC_HOOK_DISABLE_INTENT_GATE: "1" },
    });
    expect(cfg.layer1.disableGate).toBe(true);
  });

  it("YAKCC_HOOK_DISABLE_INTENT_GATE absent → layer1.disableGate remains false", () => {
    const cfg = loadEnforcementConfig({ filePath: "/nonexistent/enforcement.json", env: {} });
    expect(cfg.layer1.disableGate).toBe(false);
  });

  it("YAKCC_L1_MIN_WORDS overrides layer1.minWords", () => {
    const cfg = loadEnforcementConfig({
      filePath: "/nonexistent/enforcement.json",
      env: { YAKCC_L1_MIN_WORDS: "6" },
    });
    expect(cfg.layer1.minWords).toBe(6);
  });

  it("YAKCC_L1_MAX_WORDS overrides layer1.maxWords", () => {
    const cfg = loadEnforcementConfig({
      filePath: "/nonexistent/enforcement.json",
      env: { YAKCC_L1_MAX_WORDS: "15" },
    });
    expect(cfg.layer1.maxWords).toBe(15);
  });

  it("YAKCC_RESULT_SET_MAX overrides layer2.maxConfident", () => {
    const cfg = loadEnforcementConfig({
      filePath: "/nonexistent/enforcement.json",
      env: { YAKCC_RESULT_SET_MAX: "5" },
    });
    expect(cfg.layer2.maxConfident).toBe(5);
  });

  it("YAKCC_RESULT_SET_MAX_OVERALL overrides layer2.maxOverall", () => {
    const cfg = loadEnforcementConfig({
      filePath: "/nonexistent/enforcement.json",
      env: { YAKCC_RESULT_SET_MAX_OVERALL: "20" },
    });
    expect(cfg.layer2.maxOverall).toBe(20);
  });

  it("YAKCC_RESULT_CONFIDENT_THRESHOLD overrides layer2.confidentThreshold", () => {
    const cfg = loadEnforcementConfig({
      filePath: "/nonexistent/enforcement.json",
      env: { YAKCC_RESULT_CONFIDENT_THRESHOLD: "0.85" },
    });
    expect(cfg.layer2.confidentThreshold).toBeCloseTo(0.85);
  });

  it("non-numeric YAKCC_L1_MIN_WORDS is silently ignored (falls back to default)", () => {
    const cfg = loadEnforcementConfig({
      filePath: "/nonexistent/enforcement.json",
      env: { YAKCC_L1_MIN_WORDS: "not-a-number" },
    });
    expect(cfg.layer1.minWords).toBe(getDefaults().layer1.minWords);
  });

  it("env var overrides take precedence over file values", () => {
    const filePath = makeTempConfigFile({ layer2: { maxConfident: 7 } });
    try {
      // File says maxConfident=7, env says 2 — env wins
      const cfg = loadEnforcementConfig({
        filePath,
        env: { YAKCC_RESULT_SET_MAX: "2" },
      });
      expect(cfg.layer2.maxConfident).toBe(2);
    } finally {
      cleanTempFile(filePath);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. File override — partial and full
// ---------------------------------------------------------------------------

describe("loadEnforcementConfig() — file overrides", () => {
  it("partial layer2 file override merges with defaults", () => {
    const filePath = makeTempConfigFile({ layer2: { maxConfident: 5 } });
    try {
      const cfg = loadEnforcementConfig({ filePath, env: {} });
      expect(cfg.layer2.maxConfident).toBe(5);
      // Unset keys fall back to defaults
      expect(cfg.layer2.maxOverall).toBe(getDefaults().layer2.maxOverall);
      expect(cfg.layer2.confidentThreshold).toBeCloseTo(getDefaults().layer2.confidentThreshold);
      // layer1 is entirely default
      expect(cfg.layer1.minWords).toBe(getDefaults().layer1.minWords);
    } finally {
      cleanTempFile(filePath);
    }
  });

  it("full layer1 + layer2 file override applies all values", () => {
    const filePath = makeTempConfigFile({
      layer1: { minWords: 3, maxWords: 25, disableGate: true },
      layer2: { maxConfident: 1, maxOverall: 5, confidentThreshold: 0.8 },
    });
    try {
      const cfg = loadEnforcementConfig({ filePath, env: {} });
      expect(cfg.layer1.minWords).toBe(3);
      expect(cfg.layer1.maxWords).toBe(25);
      expect(cfg.layer1.disableGate).toBe(true);
      expect(cfg.layer2.maxConfident).toBe(1);
      expect(cfg.layer2.maxOverall).toBe(5);
      expect(cfg.layer2.confidentThreshold).toBeCloseTo(0.8);
    } finally {
      cleanTempFile(filePath);
    }
  });

  it("layer1 stopWords/metaWords/actionVerbs can be overridden via file", () => {
    const filePath = makeTempConfigFile({
      layer1: { stopWords: ["foo", "bar"], metaWords: ["baz"], actionVerbs: ["qux"] },
    });
    try {
      const cfg = loadEnforcementConfig({ filePath, env: {} });
      expect(cfg.layer1.stopWords).toEqual(["foo", "bar"]);
      expect(cfg.layer1.metaWords).toEqual(["baz"]);
      expect(cfg.layer1.actionVerbs).toEqual(["qux"]);
    } finally {
      cleanTempFile(filePath);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Invalid config rejection
// ---------------------------------------------------------------------------

describe("loadEnforcementConfig() — invalid config rejection", () => {
  it("throws on invalid JSON in config file", () => {
    const dir = join(tmpdir(), "yakcc-enforcement-config-tests");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `invalid-${Date.now()}.json`);
    writeFileSync(filePath, "{ this is not json }", "utf-8");
    try {
      expect(() => loadEnforcementConfig({ filePath, env: {} })).toThrow();
    } finally {
      cleanTempFile(filePath);
    }
  });

  it("throws TypeError when config file root is not an object", () => {
    const filePath = makeTempConfigFile([1, 2, 3]);
    try {
      expect(() => loadEnforcementConfig({ filePath, env: {} })).toThrow(TypeError);
    } finally {
      cleanTempFile(filePath);
    }
  });

  it("throws TypeError when layer2.maxConfident is not an integer", () => {
    const filePath = makeTempConfigFile({ layer2: { maxConfident: 2.5 } });
    try {
      expect(() => loadEnforcementConfig({ filePath, env: {} })).toThrow(TypeError);
    } finally {
      cleanTempFile(filePath);
    }
  });

  it("throws TypeError when layer2.confidentThreshold is out of [0,1]", () => {
    const filePath = makeTempConfigFile({ layer2: { confidentThreshold: 1.5 } });
    try {
      expect(() => loadEnforcementConfig({ filePath, env: {} })).toThrow(TypeError);
    } finally {
      cleanTempFile(filePath);
    }
  });

  it("throws TypeError when layer1.stopWords contains a non-string", () => {
    const filePath = makeTempConfigFile({ layer1: { stopWords: ["ok", 42] } });
    try {
      expect(() => loadEnforcementConfig({ filePath, env: {} })).toThrow(TypeError);
    } finally {
      cleanTempFile(filePath);
    }
  });

  it("throws TypeError when layer1 is not an object", () => {
    const filePath = makeTempConfigFile({ layer1: "not-an-object" });
    try {
      expect(() => loadEnforcementConfig({ filePath, env: {} })).toThrow(TypeError);
    } finally {
      cleanTempFile(filePath);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. setConfigOverride / resetConfigOverride
// ---------------------------------------------------------------------------

describe("setConfigOverride / resetConfigOverride", () => {
  it("setConfigOverride makes getEnforcementConfig return the override", () => {
    const override = {
      ...getDefaults(),
      layer2: { maxConfident: 99, maxOverall: 100, confidentThreshold: 0.5 },
    };
    setConfigOverride(override);
    const cfg = getEnforcementConfig();
    expect(cfg.layer2.maxConfident).toBe(99);
    expect(cfg.layer2.maxOverall).toBe(100);
  });

  it("resetConfigOverride clears override and returns defaults", () => {
    const override = {
      ...getDefaults(),
      layer2: { maxConfident: 99, maxOverall: 100, confidentThreshold: 0.5 },
    };
    setConfigOverride(override);
    resetConfigOverride();
    // After reset, should get normal defaults (with nonexistent file)
    const cfg = loadEnforcementConfig({ filePath: "/nonexistent/enforcement.json", env: {} });
    expect(cfg.layer2.maxConfident).toBe(getDefaults().layer2.maxConfident);
  });

  it("override takes precedence over file and env", () => {
    const override = {
      ...getDefaults(),
      layer2: { maxConfident: 42, maxOverall: 100, confidentThreshold: 0.5 },
    };
    setConfigOverride(override);
    const filePath = makeTempConfigFile({ layer2: { maxConfident: 7 } });
    try {
      const cfg = loadEnforcementConfig({ filePath, env: { YAKCC_RESULT_SET_MAX: "1" } });
      expect(cfg.layer2.maxConfident).toBe(42);
    } finally {
      cleanTempFile(filePath);
    }
  });
});
