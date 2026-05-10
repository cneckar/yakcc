// SPDX-License-Identifier: MIT
// Vitest harness for license/detector.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_detector_0bsd_preferredOverIsc,
  prop_detector_apacheHeader_yieldsCorrectDetection,
  prop_detector_bsd2_whenNoThirdClause,
  prop_detector_bsd3_distinguishedFromBsd2,
  prop_detector_detectLicense_alwaysReturnsDetectionShape,
  prop_detector_detectLicense_isTotalFunction,
  prop_detector_iscHeader_yieldsCorrectDetection,
  prop_detector_licenseTag_yieldsSpdxCommentSource,
  prop_detector_mitHeader_yieldsCorrectDetection,
  prop_detector_noSignal_yieldsUnknownDetection,
  prop_detector_publicDomainPhrase_yieldsCorrectDetection,
  prop_detector_spdxComment_takesPrecedence,
  prop_detector_spdxEvidence_matchesMatchedSubstring,
  prop_detector_unlicenseDedication_yieldsCorrectDetection,
} from "./detector.props.js";

const opts = { numRuns: 100 };

it("property: detectLicense — always returns a LicenseDetection-shaped object", () => {
  fc.assert(prop_detector_detectLicense_alwaysReturnsDetectionShape, opts);
});

it("property: detectLicense — SPDX comment takes precedence over all other signals", () => {
  fc.assert(prop_detector_spdxComment_takesPrecedence, opts);
});

it("property: detectLicense — @license tag yields spdx-comment source", () => {
  fc.assert(prop_detector_licenseTag_yieldsSpdxCommentSource, opts);
});

it("property: detectLicense — Unlicense dedication phrase yields correct detection", () => {
  fc.assert(prop_detector_unlicenseDedication_yieldsCorrectDetection, opts);
});

it("property: detectLicense — public-domain phrase yields correct detection", () => {
  fc.assert(prop_detector_publicDomainPhrase_yieldsCorrectDetection, opts);
});

it("property: detectLicense — MIT header text yields correct detection", () => {
  fc.assert(prop_detector_mitHeader_yieldsCorrectDetection, opts);
});

it("property: detectLicense — Apache-2.0 header text yields correct detection", () => {
  fc.assert(prop_detector_apacheHeader_yieldsCorrectDetection, opts);
});

it("property: detectLicense — ISC header text yields correct detection", () => {
  fc.assert(prop_detector_iscHeader_yieldsCorrectDetection, opts);
});

it("property: detectLicense — no-signal input yields unknown/no-signal detection", () => {
  fc.assert(prop_detector_noSignal_yieldsUnknownDetection, opts);
});

it("property: detectLicense — SPDX evidence field matches matched substring", () => {
  fc.assert(prop_detector_spdxEvidence_matchesMatchedSubstring, opts);
});

it("property: detectLicense — 0BSD header preferred over ISC (precedence ordering)", () => {
  fc.assert(prop_detector_0bsd_preferredOverIsc, opts);
});

it("property: detectLicense — BSD-3 distinguished from BSD-2 by neither-the-name-of clause", () => {
  fc.assert(prop_detector_bsd3_distinguishedFromBsd2, opts);
});

it("property: detectLicense — BSD-2 detected when third-clause is absent", () => {
  fc.assert(prop_detector_bsd2_whenNoThirdClause, opts);
});

it("property: detectLicense — total function: arbitrary strings never throw (compound)", () => {
  fc.assert(prop_detector_detectLicense_isTotalFunction, opts);
});
