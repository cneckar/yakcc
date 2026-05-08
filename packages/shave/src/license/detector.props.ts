// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave license/detector.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3-license)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (from detector.ts):
//   detectLicense          (D1.1) — pure function: string → LicenseDetection.
//
// Properties covered:
//   D1.1  detectLicense always returns a LicenseDetection-shaped object.
//   D1.2  SPDX comment takes precedence over all other signals.
//   D1.3  Unlicense dedication phrase yields identifier="Unlicense", source="dedication".
//   D1.4  Public-domain phrase yields identifier="public-domain", source="dedication".
//   D1.5  Header-text patterns yield the correct identifier and source="header-text".
//   D1.6  No-signal input yields identifier="unknown", source="no-signal".
//   D1.7  SPDX evidence matches the matched substring (non-empty string).
//   D1.8  0BSD header is preferred over ISC header (precedence ordering).
//   D1.9  BSD-3 is distinguished from BSD-2 by "neither the name of" clause.
//   D1.10 detectLicense is total: arbitrary strings never throw.

// ---------------------------------------------------------------------------
// Property-test corpus for license/detector.ts
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { detectLicense } from "./detector.js";
import type { LicenseDetection } from "./types.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 60 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary SPDX identifier (realistic but broad). */
const spdxIdArb: fc.Arbitrary<string> = fc.constantFrom(
  "MIT",
  "Apache-2.0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Unlicense",
  "GPL-3.0-only",
  "AGPL-3.0-or-later",
  "LGPL-2.1-or-later",
  "BUSL-1.1",
  "PROPRIETARY",
);

/** Source text containing an SPDX-License-Identifier comment. */
const spdxCommentSourceArb: fc.Arbitrary<string> = spdxIdArb.map(
  (id) => `// SPDX-License-Identifier: ${id}\n// some source code`,
);

/** Source text containing a @license tag. */
const licenseTagSourceArb: fc.Arbitrary<string> = spdxIdArb.map(
  (id) => `/* @license ${id} */\nsome code`,
);

/** Source text with no recognizable license signal. */
const noSignalSourceArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 80 })
  .filter(
    (s) =>
      !/(SPDX-License-Identifier|@license)/i.test(s) &&
      !s.toLowerCase().includes("public domain") &&
      !s.toLowerCase().includes("permission is hereby granted") &&
      !s.toLowerCase().includes("apache license") &&
      !s.toLowerCase().includes("redistribution and use in source") &&
      !s.toLowerCase().includes("permission to use, copy, modify"),
  );

// ---------------------------------------------------------------------------
// Helper type guard
// ---------------------------------------------------------------------------

function isLicenseDetectionShaped(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.identifier === "string" && typeof v.source === "string";
}

// ---------------------------------------------------------------------------
// D1.1: detectLicense always returns a LicenseDetection-shaped object
// ---------------------------------------------------------------------------

/**
 * prop_detector_detectLicense_alwaysReturnsDetectionShape
 *
 * detectLicense(s) always returns an object with identifier: string and
 * source: string for any input string. The evidence field may be absent.
 *
 * Invariant (D1.1): detectLicense is a total function — it must never throw
 * or return a malformed shape. The gate (licenseGate) reads identifier and
 * source unconditionally; a missing field would be a silent contract break.
 */
export const prop_detector_detectLicense_alwaysReturnsDetectionShape: fc.IPropertyWithHooks<
  [string]
> = fc.property(fc.string(), (source) => {
  const result = detectLicense(source);
  return isLicenseDetectionShaped(result);
});

// ---------------------------------------------------------------------------
// D1.2: SPDX comment takes precedence over all other signals
// ---------------------------------------------------------------------------

/**
 * prop_detector_spdxComment_takesPrecedence
 *
 * A string containing an SPDX-License-Identifier comment is always detected
 * with source="spdx-comment", regardless of any other text present.
 *
 * Invariant (D1.2): detection precedence: SPDX comment > public-domain >
 * header text > no-signal. First match wins. This property ensures an SPDX
 * comment at the top of a file is not overridden by body text.
 */
export const prop_detector_spdxComment_takesPrecedence: fc.IPropertyWithHooks<[string, string]> =
  fc.property(spdxIdArb, nonEmptyStr, (id, suffix) => {
    const source = `// SPDX-License-Identifier: ${id}\n${suffix}`;
    const result = detectLicense(source);
    return result.source === "spdx-comment" && result.identifier === id.trim();
  });

// ---------------------------------------------------------------------------
// D1.3: @license tag also yields spdx-comment source
// ---------------------------------------------------------------------------

/**
 * prop_detector_licenseTag_yieldsSpdxCommentSource
 *
 * A string beginning with a @license tag is detected with source="spdx-comment".
 *
 * Invariant (D1.2): the SPDX_RE pattern matches both SPDX-License-Identifier
 * and @license tags. This property ensures the tag variant is not missed.
 */
export const prop_detector_licenseTag_yieldsSpdxCommentSource: fc.IPropertyWithHooks<[string]> =
  fc.property(spdxIdArb, (id) => {
    const source = `/* @license ${id} */\n// code`;
    const result = detectLicense(source);
    return result.source === "spdx-comment";
  });

// ---------------------------------------------------------------------------
// D1.4: Unlicense dedication phrase → identifier="Unlicense", source="dedication"
// ---------------------------------------------------------------------------

/**
 * prop_detector_unlicenseDedication_yieldsCorrectDetection
 *
 * A string containing the canonical Unlicense dedication phrase is detected as
 * identifier="Unlicense" with source="dedication".
 *
 * Invariant (D1.3): the Unlicense phrase is checked before the generic
 * public-domain phrase. This property verifies the specific Unlicense path.
 */
export const prop_detector_unlicenseDedication_yieldsCorrectDetection: fc.IPropertyWithHooks<
  [string]
> = fc.property(nonEmptyStr, (suffix) => {
  const phrase = "This is free and unencumbered software released into the public domain";
  const source = `${phrase}\n${suffix}`;
  const result = detectLicense(source);
  return result.identifier === "Unlicense" && result.source === "dedication";
});

// ---------------------------------------------------------------------------
// D1.5: Public-domain phrase → identifier="public-domain", source="dedication"
// ---------------------------------------------------------------------------

/**
 * prop_detector_publicDomainPhrase_yieldsCorrectDetection
 *
 * A string containing "public domain" (but not the full Unlicense phrase) is
 * detected as identifier="public-domain" with source="dedication".
 *
 * Invariant (D1.4): the generic public-domain phrase is the fallback after the
 * Unlicense-specific phrase. This property covers the generic path.
 */
export const prop_detector_publicDomainPhrase_yieldsCorrectDetection: fc.IPropertyWithHooks<
  [string]
> = fc.property(nonEmptyStr, (suffix) => {
  // Use a public-domain phrase that is NOT the full Unlicense dedication.
  const source = `Released into the public domain. ${suffix}`;
  const result = detectLicense(source);
  return result.identifier === "public-domain" && result.source === "dedication";
});

// ---------------------------------------------------------------------------
// D1.6: MIT header text → identifier="MIT", source="header-text"
// ---------------------------------------------------------------------------

/**
 * prop_detector_mitHeader_yieldsCorrectDetection
 *
 * A string containing the MIT permission preamble is detected as identifier="MIT"
 * with source="header-text".
 *
 * Invariant (D1.5): header-text patterns are checked in order after SPDX and
 * dedication signals. The MIT preamble is the first entry in HEADER_PATTERNS.
 */
export const prop_detector_mitHeader_yieldsCorrectDetection: fc.IPropertyWithHooks<[string]> =
  fc.property(nonEmptyStr, (suffix) => {
    const source = `Permission is hereby granted, free of charge, to any person obtaining a copy. ${suffix}`;
    const result = detectLicense(source);
    return result.identifier === "MIT" && result.source === "header-text";
  });

// ---------------------------------------------------------------------------
// D1.7: Apache-2.0 header text → identifier="Apache-2.0", source="header-text"
// ---------------------------------------------------------------------------

/**
 * prop_detector_apacheHeader_yieldsCorrectDetection
 *
 * A string containing "Apache License, Version 2.0" is detected as
 * identifier="Apache-2.0" with source="header-text".
 *
 * Invariant (D1.5): the Apache-2.0 entry in HEADER_PATTERNS must match the
 * canonical header text. This property exercises that specific pattern.
 */
export const prop_detector_apacheHeader_yieldsCorrectDetection: fc.IPropertyWithHooks<[string]> =
  fc.property(nonEmptyStr, (suffix) => {
    const source = `Apache License, Version 2.0. ${suffix}`;
    const result = detectLicense(source);
    return result.identifier === "Apache-2.0" && result.source === "header-text";
  });

// ---------------------------------------------------------------------------
// D1.8: ISC header text → identifier="ISC", source="header-text"
// ---------------------------------------------------------------------------

/**
 * prop_detector_iscHeader_yieldsCorrectDetection
 *
 * A string containing the ISC permission phrase (without the 0BSD-specific
 * "or without fee" prefix) is detected as identifier="ISC" with source="header-text".
 *
 * Invariant (D1.5): 0BSD must be checked before ISC because 0BSD's phrase is a
 * superset. A plain ISC preamble (without "or without fee") hits the ISC entry.
 */
export const prop_detector_iscHeader_yieldsCorrectDetection: fc.IPropertyWithHooks<[string]> =
  fc.property(nonEmptyStr, (suffix) => {
    // ISC phrase WITHOUT the "or without fee" prefix that distinguishes 0BSD.
    const source = `Permission to use, copy, modify, and/or distribute this software for any purpose is granted. ${suffix}`;
    const result = detectLicense(source);
    return result.identifier === "ISC" && result.source === "header-text";
  });

// ---------------------------------------------------------------------------
// D1.9: No-signal input → identifier="unknown", source="no-signal"
// ---------------------------------------------------------------------------

/**
 * prop_detector_noSignal_yieldsUnknownDetection
 *
 * A string with no recognizable license signal is detected as
 * identifier="unknown" with source="no-signal" and no evidence field.
 *
 * Invariant (D1.6): the no-signal fallback is the last step in the precedence
 * chain. Any input that reaches it must produce exactly this shape, with no
 * evidence field set. Downstream consumers use identifier==="unknown" to
 * short-circuit the gate.
 */
export const prop_detector_noSignal_yieldsUnknownDetection: fc.IPropertyWithHooks<[string]> =
  fc.property(noSignalSourceArb, (source) => {
    const result = detectLicense(source);
    return (
      result.identifier === "unknown" && result.source === "no-signal" && !("evidence" in result)
    );
  });

// ---------------------------------------------------------------------------
// D1.10: SPDX evidence field matches the matched SPDX substring
// ---------------------------------------------------------------------------

/**
 * prop_detector_spdxEvidence_matchesMatchedSubstring
 *
 * When detectLicense returns source="spdx-comment", the evidence field is
 * present and is a non-empty string (it is the matched SPDX comment text).
 *
 * Invariant (D1.7): the evidence field is for diagnostics — it must be the
 * actual matched text, not a synthetic string. This property verifies it is
 * always non-empty when set for the SPDX path.
 */
export const prop_detector_spdxEvidence_matchesMatchedSubstring: fc.IPropertyWithHooks<[string]> =
  fc.property(spdxCommentSourceArb, (source) => {
    const result = detectLicense(source);
    if (result.source !== "spdx-comment") return false;
    return typeof result.evidence === "string" && result.evidence.length > 0;
  });

// ---------------------------------------------------------------------------
// D1.11: 0BSD header is preferred over ISC header (precedence)
// ---------------------------------------------------------------------------

/**
 * prop_detector_0bsd_preferredOverIsc
 *
 * A string containing the 0BSD preamble (which includes "or without fee") is
 * detected as identifier="0BSD", not "ISC".
 *
 * Invariant (D1.8): HEADER_PATTERNS places 0BSD before ISC because the 0BSD
 * preamble is a superset of ISC's distinct phrase. A regression in ordering
 * would mislabel 0BSD as ISC.
 */
export const prop_detector_0bsd_preferredOverIsc: fc.IPropertyWithHooks<[string]> = fc.property(
  nonEmptyStr,
  (suffix) => {
    const source = `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted. ${suffix}`;
    const result = detectLicense(source);
    return result.identifier === "0BSD" && result.source === "header-text";
  },
);

// ---------------------------------------------------------------------------
// D1.12: BSD-3 is distinguished from BSD-2 by "neither the name of" clause
// ---------------------------------------------------------------------------

/**
 * prop_detector_bsd3_distinguishedFromBsd2
 *
 * A string containing the BSD redistribution preamble AND the "neither the
 * name of" clause is detected as BSD-3-Clause, not BSD-2-Clause.
 *
 * Invariant (D1.9): the BSD family is detected by a shared sentinel phrase,
 * then refined by checking for the BSD-3 "Neither the name of" clause. This
 * property verifies the refinement works correctly.
 */
export const prop_detector_bsd3_distinguishedFromBsd2: fc.IPropertyWithHooks<[string]> =
  fc.property(nonEmptyStr, (suffix) => {
    const source = `Redistribution and use in source and binary forms, with or without modification, are permitted. Neither the name of the author nor the names of contributors may be used. ${suffix}`;
    const result = detectLicense(source);
    return result.identifier === "BSD-3-Clause" && result.source === "header-text";
  });

// ---------------------------------------------------------------------------
// D1.13: BSD-2 detected when "neither the name of" clause is absent
// ---------------------------------------------------------------------------

/**
 * prop_detector_bsd2_whenNoThirdClause
 *
 * A string containing the BSD redistribution preamble but WITHOUT the
 * "neither the name of" clause is detected as BSD-2-Clause.
 *
 * Invariant (D1.9): complement of D1.12 — absence of the third clause
 * selects BSD-2-Clause.
 */
export const prop_detector_bsd2_whenNoThirdClause: fc.IPropertyWithHooks<[string]> = fc.property(
  noSignalSourceArb,
  (suffix) => {
    // Construct a clean BSD preamble with no "neither" clause.
    // Use suffix that also won't contain "neither the name of".
    const cleanSuffix = suffix.toLowerCase().includes("neither the name of")
      ? "some other text"
      : suffix;
    const source = `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met: ${cleanSuffix}`;
    const result = detectLicense(source);
    return result.identifier === "BSD-2-Clause" && result.source === "header-text";
  },
);

// ---------------------------------------------------------------------------
// D1.14: detectLicense is total — arbitrary strings never throw (compound)
// ---------------------------------------------------------------------------

/**
 * prop_detector_detectLicense_isTotalFunction
 *
 * detectLicense(s) never throws for any string input. This is the compound
 * end-to-end property: it exercises the full detection pipeline (SPDX →
 * dedication → header-text → no-signal) across arbitrary strings and asserts
 * both non-throwing and correct return shape.
 *
 * Invariant (D1.10): detectLicense must be unconditionally safe to call from
 * the pipeline. A throw on any input would halt corpus scanning.
 */
export const prop_detector_detectLicense_isTotalFunction: fc.IPropertyWithHooks<[string]> =
  fc.property(fc.string(), (source) => {
    let result: LicenseDetection | undefined;
    try {
      result = detectLicense(source);
    } catch {
      return false;
    }
    return isLicenseDetectionShaped(result);
  });
