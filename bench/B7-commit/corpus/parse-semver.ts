// SPDX-License-Identifier: MIT

/** Parsed representation of a semantic version string (SemVer 2.0.0). */
export interface SemverParsed {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  buildMetadata: string | null;
}

/**
 * Parse a semantic version string into major, minor, patch, prerelease, and
 * build-metadata components per SemVer 2.0.0. Accepts "MAJOR.MINOR.PATCH[-pre][+build]"
 * where each numeric part has no leading zeros. Returns null for invalid input.
 *
 * @param version - Semver string, e.g. "1.2.3-beta.1+build.42".
 * @returns Parsed SemverParsed object, or null if the string is not valid semver.
 */
export function parseSemver(version: string): SemverParsed | null {
  if (typeof version !== "string" || version.length === 0) return null;
  const plusIdx = version.indexOf("+");
  const buildMetadata = plusIdx !== -1 ? version.slice(plusIdx + 1) : null;
  const withoutBuild = plusIdx !== -1 ? version.slice(0, plusIdx) : version;
  const dashIdx = withoutBuild.indexOf("-");
  const prerelease = dashIdx !== -1 ? withoutBuild.slice(dashIdx + 1) : null;
  const corePart = dashIdx !== -1 ? withoutBuild.slice(0, dashIdx) : withoutBuild;
  const coreParts = corePart.split(".");
  if (coreParts.length !== 3) return null;
  const nums: number[] = [];
  for (const p of coreParts) {
    if (!/^\d+$/.test(p)) return null;
    if (p.length > 1 && p[0] === "0") return null;
    nums.push(Number(p));
  }
  if (prerelease !== null) {
    if (prerelease.length === 0) return null;
    for (const id of prerelease.split(".")) {
      if (id.length === 0 || !/^[0-9A-Za-z-]+$/.test(id)) return null;
    }
  }
  return { major: nums[0]!, minor: nums[1]!, patch: nums[2]!, prerelease, buildMetadata };
}
