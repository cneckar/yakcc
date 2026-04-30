/**
 * @decision DEC-LICENSE-GATE-001
 * title: Signal-based license detection for the yakcc registry gate (WI-013-01)
 * status: decided
 * rationale:
 *   - Accepted-license set is locked to MASTER_PLAN.md v0.7 stage spec.
 *   - Detection is signal-based (not crypto-authoritative); a sophisticated
 *     false signal in a comment could mislabel a file. The gate is the
 *     second-line defense — known-bad identifiers are refused regardless of
 *     detection source.
 *   - Header-text patterns are canonical preamble fragments from the OSI text;
 *     no fuzzy matching is used.
 *   - Detection precedence: SPDX comment > public-domain dedication > header
 *     text > no-signal. First match wins.
 */

import type { LicenseDetection } from "./types.js";

// SPDX-License-Identifier or @license tag (with or without colon).
const SPDX_RE = /(?:SPDX-License-Identifier|@license)\s*:?\s*([A-Za-z0-9.\-+ ]+)/i;

// Public-domain dedication phrases (checked in order of specificity).
const UNLICENSE_PHRASE = "This is free and unencumbered software released into the public domain";
const PUBLIC_DOMAIN_PHRASE = "public domain";

// Header-text patterns: [phrase, identifier] pairs, checked in order.
// 0BSD must appear before ISC because its preamble is a superset of ISC's
// distinct phrase ("or without fee" is the distinguishing prefix).
const HEADER_PATTERNS: Array<[string, string]> = [
  ["Permission is hereby granted, free of charge", "MIT"],
  ["Apache License, Version 2.0", "Apache-2.0"],
  ["http://www.apache.org/licenses/LICENSE-2.0", "Apache-2.0"],
  ["https://www.apache.org/licenses/LICENSE-2.0", "Apache-2.0"],
  // 0BSD before ISC — 0BSD preamble contains "or without fee"
  [
    "Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee",
    "0BSD",
  ],
  ["Permission to use, copy, modify, and/or distribute this software for any purpose", "ISC"],
  // BSD variants: check for the "Neither the name of" clause to distinguish.
  // We use a sentinel phrase for BSD-2-Clause that appears in both, then
  // refine by checking for the BSD-3 "Neither the name of" clause.
  ["Redistribution and use in source and binary forms", "BSD"],
];

/**
 * Detect the license of a source string using a precedence chain of signals.
 *
 * @param source - Raw source text to inspect (file contents or license text).
 * @returns LicenseDetection with identifier, source type, and optional evidence.
 */
export function detectLicense(
  source: string,
  _options?: Record<string, unknown>,
): LicenseDetection {
  // --- 1. SPDX comment ---
  const spdxMatch = SPDX_RE.exec(source);
  if (spdxMatch !== null) {
    const identifier = (spdxMatch[1] ?? "").trim();
    return {
      identifier,
      source: "spdx-comment",
      evidence: spdxMatch[0],
    };
  }

  // --- 2. Public-domain dedication ---
  const lower = source.toLowerCase();

  if (source.toLowerCase().includes(UNLICENSE_PHRASE.toLowerCase())) {
    const idx = source.toLowerCase().indexOf(UNLICENSE_PHRASE.toLowerCase());
    return {
      identifier: "Unlicense",
      source: "dedication",
      evidence: source.slice(idx, idx + UNLICENSE_PHRASE.length),
    };
  }

  if (lower.includes(PUBLIC_DOMAIN_PHRASE)) {
    const idx = lower.indexOf(PUBLIC_DOMAIN_PHRASE);
    return {
      identifier: "public-domain",
      source: "dedication",
      evidence: source.slice(idx, idx + PUBLIC_DOMAIN_PHRASE.length),
    };
  }

  // --- 3. Header-text patterns ---
  for (const [phrase, id] of HEADER_PATTERNS) {
    const phraseIdx = source.toLowerCase().indexOf(phrase.toLowerCase());
    if (phraseIdx !== -1) {
      if (id === "BSD") {
        // Distinguish BSD-2-Clause from BSD-3-Clause.
        const hasThirdClause = source.toLowerCase().includes("neither the name of");
        return {
          identifier: hasThirdClause ? "BSD-3-Clause" : "BSD-2-Clause",
          source: "header-text",
          evidence: source.slice(phraseIdx, phraseIdx + phrase.length),
        };
      }
      return {
        identifier: id,
        source: "header-text",
        evidence: source.slice(phraseIdx, phraseIdx + phrase.length),
      };
    }
  }

  // --- 4. No signal ---
  return { identifier: "unknown", source: "no-signal" };
}
