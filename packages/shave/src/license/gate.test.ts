/**
 * Tests for licenseGate() — WI-013-01.
 *
 * All tests construct synthetic LicenseDetection objects inline; detectLicense()
 * is intentionally NOT called here (see detector.test.ts for that surface).
 */

import { describe, expect, it } from "vitest";
import { licenseGate } from "./gate.js";
import type { LicenseDetection } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function det(identifier: string, source: LicenseDetection["source"] = "spdx-comment"): LicenseDetection {
  return { identifier, source };
}

// ---------------------------------------------------------------------------
// 1. Accepted licenses — all 8 must pass through
// ---------------------------------------------------------------------------

describe("licenseGate — accepted licenses", () => {
  const cases: Array<{ identifier: string; expected: string }> = [
    { identifier: "Unlicense", expected: "Unlicense" },
    { identifier: "MIT", expected: "MIT" },
    { identifier: "BSD-2-Clause", expected: "BSD-2-Clause" },
    { identifier: "BSD-3-Clause", expected: "BSD-3-Clause" },
    { identifier: "Apache-2.0", expected: "Apache-2.0" },
    { identifier: "ISC", expected: "ISC" },
    { identifier: "0BSD", expected: "0BSD" },
    { identifier: "public-domain", expected: "public-domain" },
  ];

  for (const { identifier, expected } of cases) {
    it(`accepts ${identifier}`, () => {
      const detection = det(identifier);
      const result = licenseGate(detection);
      expect(result.accepted).toBe(true);
      if (result.accepted) {
        expect(result.license).toBe(expected);
        expect(result.detection).toBe(detection);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Rejected licenses — copyleft / proprietary
// ---------------------------------------------------------------------------

describe("licenseGate — copyleft/proprietary rejections", () => {
  const cases = [
    "GPL-3.0-or-later",
    "AGPL-3.0",
    "LGPL-2.1",
    "BUSL-1.1",
    "Proprietary",
  ];

  for (const identifier of cases) {
    it(`rejects ${identifier} with copyleft/proprietary reason`, () => {
      const result = licenseGate(det(identifier));
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        // reason must mention copyleft or proprietary
        const lower = result.reason.toLowerCase();
        expect(lower.includes("copyleft") || lower.includes("proprietary")).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Unknown detection (identifier === "unknown", source === "no-signal")
// ---------------------------------------------------------------------------

it("rejects unknown detection with 'no recognizable license identifier' reason", () => {
  const detection: LicenseDetection = { identifier: "unknown", source: "no-signal" };
  const result = licenseGate(detection);
  expect(result.accepted).toBe(false);
  if (!result.accepted) {
    expect(result.reason).toContain("no recognizable license identifier");
    expect(result.detection).toBe(detection);
  }
});

// ---------------------------------------------------------------------------
// 4. Unrecognized identifier (not on accepted or rejected list)
// ---------------------------------------------------------------------------

it("rejects unrecognized WTFPL identifier", () => {
  const result = licenseGate(det("WTFPL"));
  expect(result.accepted).toBe(false);
  if (!result.accepted) {
    expect(result.reason.toLowerCase()).toContain("unrecognized license identifier");
  }
});

// ---------------------------------------------------------------------------
// 5. Case-insensitive normalization — all should resolve to Apache-2.0
// ---------------------------------------------------------------------------

describe("licenseGate — normalization for Apache-2.0 variants", () => {
  const variants = [
    "apache-2.0",
    "APACHE 2.0",
    "Apache 2.0",
    "(Apache-2.0)",
  ];

  for (const variant of variants) {
    it(`normalizes "${variant}" → accepted as Apache-2.0`, () => {
      const result = licenseGate(det(variant, "header-text"));
      expect(result.accepted).toBe(true);
      if (result.accepted) {
        expect(result.license).toBe("Apache-2.0");
      }
    });
  }
});
