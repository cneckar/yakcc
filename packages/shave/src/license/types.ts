/**
 * Public type surface for the license gate subsystem (WI-013-01).
 *
 * These types are re-exported from packages/shave/src/index.ts and form the
 * stable public API for downstream consumers. The gate implementation lives
 * in gate.ts; the detector lives in detector.ts.
 */

/**
 * The set of license identifiers the license gate accepts.
 * Source: MASTER_PLAN.md v0.7 stage spec.
 */
export type AcceptedLicense =
  | "Unlicense"
  | "MIT"
  | "BSD-2-Clause"
  | "BSD-3-Clause"
  | "Apache-2.0"
  | "ISC"
  | "0BSD"
  | "public-domain";

/** Outcome of license detection on a source string or directory. */
export interface LicenseDetection {
  /**
   * The detected SPDX-style license identifier, or "unknown" when no
   * conclusive signal was found.
   */
  readonly identifier: string;
  /**
   * Where the detection signal came from.
   */
  readonly source:
    | "spdx-comment" // `// SPDX-License-Identifier: MIT`
    | "package-json" // package.json `license` field
    | "header-text" // recognized license header pattern in comments
    | "dedication" // public-domain dedication phrase
    | "no-signal"; // nothing detected
  /** The matched substring that produced the signal, for diagnostics. */
  readonly evidence?: string;
}

/** Outcome of running the license gate on a detection. */
export type LicenseGateResult =
  | {
      readonly accepted: true;
      readonly license: AcceptedLicense;
      readonly detection: LicenseDetection;
    }
  | { readonly accepted: false; readonly reason: string; readonly detection: LicenseDetection };
