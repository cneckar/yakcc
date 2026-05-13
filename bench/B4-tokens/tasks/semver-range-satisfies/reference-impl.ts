// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/semver-range-satisfies/reference-impl.ts
//
// @decision DEC-V0-B4-TASKS-EXPAND-001
// @title B4 Slice 2 task corpus: semver-range-satisfies reference implementation
// @status accepted
// @rationale
//   Reference implementation for oracle validation. Proves oracle tests correctly
//   distinguish correct from broken semver range implementations. Hand-written;
//   not LLM-generated (DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001).
//
//   Adversarial trap: range grammar composition requires three atoms (parseSemver,
//   parseRange, compare) composed correctly. || = OR, whitespace = AND within a group.
//   Prerelease ordering: 1.0.0-alpha < 1.0.0 (prerelease < no-prerelease at same base).

export interface SemverVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

export interface Comparator {
  operator: ">=" | "<=" | ">" | "<" | "=" | "";
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

export interface SemverRange {
  comparators: Comparator[][];
}

// Regex: MAJOR.MINOR.PATCH[-PRERELEASE]
// No leading zeros (except 0 itself), no build metadata in this subset.
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\s\S]*))?$/;

/**
 * Parse a semver string into a SemverVersion object.
 * Returns null for invalid input.
 */
export function parseSemver(version: string): SemverVersion | null {
  const m = SEMVER_RE.exec(version.trim());
  if (!m) return null;
  return {
    major: parseInt(m[1]!, 10),
    minor: parseInt(m[2]!, 10),
    patch: parseInt(m[3]!, 10),
    prerelease: m[4] ?? "",
  };
}

/**
 * Parse a single comparator token (e.g., ">=1.2.3", "1.2.3", "=0.1.0").
 * Returns null if the comparator is invalid or uses unsupported operators.
 */
function parseComparator(token: string): Comparator | null {
  token = token.trim();
  if (!token) return null;

  let operator: Comparator["operator"] = "";
  let versionStr = token;

  // Check for two-char operators first, then single-char
  if (token.startsWith(">=")) {
    operator = ">=";
    versionStr = token.slice(2);
  } else if (token.startsWith("<=")) {
    operator = "<=";
    versionStr = token.slice(2);
  } else if (token.startsWith(">")) {
    operator = ">";
    versionStr = token.slice(1);
  } else if (token.startsWith("<")) {
    operator = "<";
    versionStr = token.slice(1);
  } else if (token.startsWith("=")) {
    operator = "=";
    versionStr = token.slice(1);
  } else if (token.startsWith("~") || token.startsWith("^")) {
    // Tilde/caret not supported in this subset
    return null;
  }

  const v = parseSemver(versionStr);
  if (!v) return null;

  return { operator, ...v };
}

/**
 * Parse a range string into a SemverRange object.
 * Returns null for invalid input or unsupported operators.
 */
export function parseRange(range: string): SemverRange | null {
  if (typeof range !== "string") return null;

  // Split into OR groups by ||
  const orGroups = range.split("||");
  const comparators: Comparator[][] = [];

  for (const group of orGroups) {
    const trimmed = group.trim();
    if (!trimmed) {
      // Empty OR group (e.g., from "||" at start/end) — treat as wildcard? No: invalid.
      return null;
    }

    // Split each OR group into AND comparators by whitespace
    const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
    const andComparators: Comparator[] = [];

    for (const token of tokens) {
      const comp = parseComparator(token);
      if (!comp) return null;
      andComparators.push(comp);
    }

    if (andComparators.length === 0) return null;
    comparators.push(andComparators);
  }

  if (comparators.length === 0) return null;
  return { comparators };
}

/**
 * Compare two semver versions.
 * Returns: negative if a < b, 0 if a === b, positive if a > b.
 */
function compareVersions(a: SemverVersion, b: SemverVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // Prerelease comparison:
  // - A version with prerelease < same base without prerelease
  // - Two versions with prerelease at same base: compare prerelease lexicographically
  if (a.prerelease === "" && b.prerelease === "") return 0;
  if (a.prerelease !== "" && b.prerelease === "") return -1; // a has pre, b doesn't: a < b
  if (a.prerelease === "" && b.prerelease !== "") return 1;  // b has pre, a doesn't: a > b
  return a.prerelease < b.prerelease ? -1 : a.prerelease > b.prerelease ? 1 : 0;
}

/**
 * Check if a parsed version satisfies a single comparator.
 */
function satisfiesComparator(version: SemverVersion, comp: Comparator): boolean {
  const compVersion: SemverVersion = {
    major: comp.major,
    minor: comp.minor,
    patch: comp.patch,
    prerelease: comp.prerelease,
  };

  const cmp = compareVersions(version, compVersion);

  switch (comp.operator) {
    case "":
    case "=":
      if (comp.prerelease === "") {
        // Exact major.minor.patch match, any prerelease
        return version.major === comp.major &&
               version.minor === comp.minor &&
               version.patch === comp.patch;
      }
      return cmp === 0;
    case ">=": return cmp >= 0;
    case "<=": return cmp <= 0;
    case ">":  return cmp > 0;
    case "<":  return cmp < 0;
  }
}

/**
 * Check if a version string satisfies a range string.
 *
 * @param version - Semver version string (e.g., "1.2.3" or "1.2.3-alpha")
 * @param range - Range string (e.g., ">=1.0.0 <2.0.0" or "^1.2.3")
 * @returns true if the version satisfies the range, false otherwise or if either is invalid
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (!v) return false;

  const r = parseRange(range);
  if (!r) return false;

  // Version satisfies range if it satisfies ANY OR group
  for (const andGroup of r.comparators) {
    // Version satisfies this group if it satisfies ALL comparators
    if (andGroup.every((comp) => satisfiesComparator(v, comp))) {
      return true;
    }
  }

  return false;
}
