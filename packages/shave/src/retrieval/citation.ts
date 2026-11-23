// SPDX-License-Identifier: MIT
//
// @decision DEC-RETRIEVAL-CITATION-001 (wi-reuse B5, GH #1262)
// Deterministic citation check for intent-card behavior claims (SEAM: "each checked
// against a source quote", mechanized). A behavior string is cited when it appears in
// the unit source, modulo whitespace and JSDoc decoration (leading `*`). The check is
// pure and needs no model. It returns the line span of the citation, or a recorded
// failure. A failure is never dropped silently.
//
// Two uses. First, verify a freshly extracted claim is grounded in its source. Second,
// verify a CACHED claim is still grounded in the current source. A stale cache entry
// fails the check, because its behavior no longer appears in the source it was keyed to.
// A truncated behavior (ending in "...") is checked on its prefix.

export type CitationResult =
  | { readonly status: "cited"; readonly lineStart: number; readonly lineEnd: number }
  | { readonly status: "uncited"; readonly reason: "empty-claim" | "not-found" };

interface Normalized {
  readonly text: string;
  /** For each character of `text`, the 1-based source line it came from. */
  readonly lineOf: readonly number[];
}

/**
 * Normalize source for matching: per line, drop leading whitespace and a JSDoc `*`,
 * collapse internal whitespace to one space, and join lines with one space. Each output
 * character keeps the line it came from.
 */
function normalize(source: string): Normalized {
  const parts: string[] = [];
  const lineOf: number[] = [];
  source.split("\n").forEach((rawLine, index) => {
    const line = rawLine
      .replace(/^\s*\*?\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line.length === 0) return;
    if (parts.length > 0) {
      parts.push(" ");
      lineOf.push(index + 1);
    }
    for (const ch of line) {
      parts.push(ch);
      lineOf.push(index + 1);
    }
  });
  return { text: parts.join(""), lineOf };
}

/** The claim as it should be matched: whitespace collapsed, a trailing "..." removed. */
function claimForMatch(behavior: string): string {
  const trimmed = behavior.replace(/\s+/g, " ").trim();
  const withoutEllipsis = trimmed.endsWith("...") ? trimmed.slice(0, -3).trimEnd() : trimmed;
  return withoutEllipsis;
}

/** Check that a behavior claim is grounded in `unitSource`, returning its line span. */
export function citeBehavior(unitSource: string, behavior: string): CitationResult {
  const claim = claimForMatch(behavior);
  if (claim.length === 0) return { status: "uncited", reason: "empty-claim" };
  const { text, lineOf } = normalize(unitSource);
  const at = text.indexOf(claim);
  if (at < 0) return { status: "uncited", reason: "not-found" };
  const first = lineOf[at] ?? 1;
  const last = lineOf[at + claim.length - 1] ?? first;
  return { status: "cited", lineStart: first, lineEnd: last };
}
