// SPDX-License-Identifier: MIT
/**
 * telemetry-config.test.ts — Unit tests for resolveTelemetryConfig().
 *
 * Covers all 7 env-var precedence cases from DEC-TELEMETRY-EXPORT-CONFIG-002.
 * Tests inject env as a plain object so process.env is never mutated.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_TELEMETRY_ENDPOINT, resolveTelemetryConfig } from "../src/telemetry-config.js";

// ---------------------------------------------------------------------------
// Case 1: YAKCC_TELEMETRY_DISABLED=1 → disabled (terminal)
// ---------------------------------------------------------------------------

describe("DEC-TELEMETRY-EXPORT-CONFIG-002 — case 1: YAKCC_TELEMETRY_DISABLED=1", () => {
  it("returns disabled:true regardless of other vars", () => {
    const cfg = resolveTelemetryConfig({ YAKCC_TELEMETRY_DISABLED: "1" });
    expect(cfg.disabled).toBe(true);
  });

  it("DISABLED=1 takes precedence over an https endpoint", () => {
    const cfg = resolveTelemetryConfig({
      YAKCC_TELEMETRY_DISABLED: "1",
      YAKCC_TELEMETRY_ENDPOINT: "https://other.example.com",
    });
    expect(cfg.disabled).toBe(true);
  });

  it("DISABLED=1 takes precedence over endpoint=off", () => {
    const cfg = resolveTelemetryConfig({
      YAKCC_TELEMETRY_DISABLED: "1",
      YAKCC_TELEMETRY_ENDPOINT: "off",
    });
    expect(cfg.disabled).toBe(true);
  });

  it("DISABLED=0 (non-1 string) does NOT disable", () => {
    const cfg = resolveTelemetryConfig({ YAKCC_TELEMETRY_DISABLED: "0" });
    expect(cfg.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case 2: YAKCC_TELEMETRY_ENDPOINT="off" → disabled
// ---------------------------------------------------------------------------

describe("DEC-TELEMETRY-EXPORT-CONFIG-002 — case 2: endpoint=off", () => {
  it("returns disabled:true when endpoint is 'off'", () => {
    const cfg = resolveTelemetryConfig({ YAKCC_TELEMETRY_ENDPOINT: "off" });
    expect(cfg.disabled).toBe(true);
  });

  it("'OFF' (uppercase) does NOT disable — value is case-sensitive", () => {
    const cfg = resolveTelemetryConfig({ YAKCC_TELEMETRY_ENDPOINT: "OFF" });
    expect(cfg.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case 3: YAKCC_TELEMETRY_ENDPOINT="file://<path>" → FileSink only
// ---------------------------------------------------------------------------

describe("DEC-TELEMETRY-EXPORT-CONFIG-002 — case 3: endpoint=file://", () => {
  it("returns disabled:false and preserves file:// endpoint", () => {
    const cfg = resolveTelemetryConfig({
      YAKCC_TELEMETRY_ENDPOINT: "file:///tmp/my-telemetry",
    });
    expect(cfg.disabled).toBe(false);
    expect(cfg.endpoint).toBe("file:///tmp/my-telemetry");
  });
});

// ---------------------------------------------------------------------------
// Case 4/5: YAKCC_TELEMETRY_ENDPOINT="https://<host>" → Composite
// ---------------------------------------------------------------------------

describe("DEC-TELEMETRY-EXPORT-CONFIG-002 — cases 4/5: https endpoint", () => {
  it("case 4: non-default https endpoint is returned as-is", () => {
    const cfg = resolveTelemetryConfig({
      YAKCC_TELEMETRY_ENDPOINT: "https://custom.metrics.example.com",
    });
    expect(cfg.disabled).toBe(false);
    expect(cfg.endpoint).toBe("https://custom.metrics.example.com");
  });

  it("case 5: default endpoint (metrics.yakcc.com) is accepted as-is", () => {
    const cfg = resolveTelemetryConfig({
      YAKCC_TELEMETRY_ENDPOINT: DEFAULT_TELEMETRY_ENDPOINT,
    });
    expect(cfg.disabled).toBe(false);
    expect(cfg.endpoint).toBe(DEFAULT_TELEMETRY_ENDPOINT);
  });
});

// ---------------------------------------------------------------------------
// Case 6: YAKCC_TELEMETRY_ENDPOINT absent or empty → default endpoint
// ---------------------------------------------------------------------------

describe("DEC-TELEMETRY-EXPORT-CONFIG-002 — case 6: endpoint absent/empty", () => {
  it("endpoint absent → defaults to metrics.yakcc.com", () => {
    const cfg = resolveTelemetryConfig({});
    expect(cfg.disabled).toBe(false);
    expect(cfg.endpoint).toBe(DEFAULT_TELEMETRY_ENDPOINT);
  });

  it("endpoint empty string → defaults to metrics.yakcc.com", () => {
    const cfg = resolveTelemetryConfig({ YAKCC_TELEMETRY_ENDPOINT: "" });
    expect(cfg.disabled).toBe(false);
    expect(cfg.endpoint).toBe(DEFAULT_TELEMETRY_ENDPOINT);
  });
});

// ---------------------------------------------------------------------------
// Case 7: YAKCC_TELEMETRY_FULL_INTENT=1 → fullIntent: true
// ---------------------------------------------------------------------------

describe("DEC-TELEMETRY-EXPORT-CONFIG-002 — case 7: FULL_INTENT", () => {
  it("fullIntent is false by default", () => {
    const cfg = resolveTelemetryConfig({});
    expect(cfg.fullIntent).toBe(false);
  });

  it("FULL_INTENT=1 sets fullIntent:true", () => {
    const cfg = resolveTelemetryConfig({ YAKCC_TELEMETRY_FULL_INTENT: "1" });
    expect(cfg.fullIntent).toBe(true);
  });

  it("FULL_INTENT=1 is preserved even when disabled", () => {
    // fullIntent is parsed regardless; callers should check disabled first
    const cfg = resolveTelemetryConfig({
      YAKCC_TELEMETRY_DISABLED: "1",
      YAKCC_TELEMETRY_FULL_INTENT: "1",
    });
    expect(cfg.disabled).toBe(true);
    expect(cfg.fullIntent).toBe(true);
  });

  it("FULL_INTENT=0 does not set fullIntent", () => {
    const cfg = resolveTelemetryConfig({ YAKCC_TELEMETRY_FULL_INTENT: "0" });
    expect(cfg.fullIntent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_TELEMETRY_ENDPOINT constant
// ---------------------------------------------------------------------------

describe("DEFAULT_TELEMETRY_ENDPOINT", () => {
  it("is the canonical metrics endpoint", () => {
    expect(DEFAULT_TELEMETRY_ENDPOINT).toBe("https://metrics.yakcc.com");
  });
});
