/**
 * @decision DEC-LICENSE-GATE-001
 * title: Signal-based license gate for the yakcc registry (WI-013-01)
 * status: decided
 * rationale:
 *   - Accepted-license set is locked to MASTER_PLAN.md v0.7 stage spec.
 *   - Detection is signal-based (not crypto-authoritative); a sophisticated
 *     false signal in a comment could mislabel a file. The gate is the
 *     second-line defense — known-bad identifiers are refused regardless of
 *     detection source.
 *   - Copyleft/proprietary prefix rejection (GPL, AGPL, LGPL, BUSL) runs
 *     before canonical-form matching so even unrecognized variants of those
 *     families are caught.
 *   - Normalization: trim → strip enclosing parens → collapse internal spaces
 *     to hyphens → uppercase. This handles common variants like "Apache 2.0"
 *     and "apache-2.0" without a full SPDX expression parser.
 */

import type { AcceptedLicense, LicenseDetection, LicenseGateResult } from "./types.js";

// Rejected license prefixes (copyleft / proprietary).
const REJECTED_PREFIXES = ["GPL-", "AGPL-", "LGPL-", "BUSL-"];
const REJECTED_EXACT = ["PROPRIETARY", "COMMERCIAL"];

// Mapping from normalized identifier to canonical AcceptedLicense form.
const CANONICAL_MAP: Record<string, AcceptedLicense> = {
  UNLICENSE: "Unlicense",
  MIT: "MIT",
  "BSD-2-CLAUSE": "BSD-2-Clause",
  "BSD-2": "BSD-2-Clause",
  "BSD-3-CLAUSE": "BSD-3-Clause",
  "BSD-3": "BSD-3-Clause",
  "APACHE-2.0": "Apache-2.0",
  "APACHE-2": "Apache-2.0",
  ISC: "ISC",
  "0BSD": "0BSD",
  "PUBLIC-DOMAIN": "public-domain",
};

/**
 * Normalize a license identifier for comparison.
 *
 * Steps:
 *   1. Trim whitespace.
 *   2. Strip a single pair of enclosing parentheses if present.
 *   3. Replace one or more internal spaces with a hyphen.
 *   4. Uppercase.
 */
function normalize(id: string): string {
  let s = id.trim();
  if (s.startsWith("(") && s.endsWith(")")) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/\s+/g, "-");
  return s.toUpperCase();
}

/**
 * Run the license gate on a detection result.
 *
 * @param detection - The output of detectLicense() (or a manually constructed
 *   LicenseDetection for testing).
 * @returns LicenseGateResult — accepted with canonical form, or rejected with
 *   a human-readable reason.
 */
export function licenseGate(detection: LicenseDetection): LicenseGateResult {
  // 1. Unknown identifier — no signal to evaluate.
  if (detection.identifier === "unknown") {
    return {
      accepted: false,
      reason: "no recognizable license identifier",
      detection,
    };
  }

  const originalId = detection.identifier;
  const normed = normalize(originalId);

  // 2. Reject copyleft / proprietary families.
  for (const prefix of REJECTED_PREFIXES) {
    if (normed.startsWith(prefix)) {
      return {
        accepted: false,
        reason: `copyleft/proprietary license detected: ${originalId} — yakcc registry accepts only permissive licenses`,
        detection,
      };
    }
  }
  if (REJECTED_EXACT.includes(normed)) {
    return {
      accepted: false,
      reason: `copyleft/proprietary license detected: ${originalId} — yakcc registry accepts only permissive licenses`,
      detection,
    };
  }

  // 3. Match against canonical accepted forms.
  const canonical = CANONICAL_MAP[normed];
  if (canonical !== undefined) {
    return { accepted: true, license: canonical, detection };
  }

  // 4. Unrecognized.
  return {
    accepted: false,
    reason: `unrecognized license identifier: ${originalId}`,
    detection,
  };
}
