// SPDX-License-Identifier: MIT
//
// @decision DEC-V0-B4-SEED-semver-component-parser-001
// @title semver-component-parser: version-string parser for MAJOR.MINOR.PATCH[-pre][+build]
// @status accepted
// @rationale
//   The semver-range-satisfies B4 task requires parsing version strings into
//   their numeric and string components before any range comparison. This atom
//   implements the parsing primitive so the range-comparison logic can operate
//   on structured data rather than raw strings.
//
//   Design decisions:
//   (A) SPLIT THEN PARSE: The implementation splits the input string rather
//       than using a hand-rolled character-position parser. The split approach
//       is more readable and the O(n) allocation cost is acceptable for version
//       strings, which are short (typically < 30 chars). A position-based
//       parser would save zero allocations in practice at the cost of
//       significant code complexity.
//
//   (B) BUILD BEFORE PRERELEASE: The '+' (build metadata) separator is handled
//       AFTER splitting on '-' (prerelease). If the patch field contains '+',
//       we split again. This correctly handles '1.0.0-beta+sha' where '-beta'
//       is prerelease and 'sha' is build metadata appended to the patch field.
//       Order matters: split on '-' first, then on '+'.
//
//   (C) NO SEMANTIC VALIDATION OF IDENTIFIERS: Prerelease and build identifier
//       characters are not validated (the spec only requires capturing them as
//       strings). Full validation per semver.org spec section 9-10 would add
//       complexity without benefit for the B4 task's comparator use-case.
//
//   (D) EXPLICIT GUARD FOR ARRAY INDEXING: After verifying parts.length === 3
//       via SyntaxError throw, TypeScript still types parts[n] as
//       string | undefined. We use explicit string coercion ("" fallback via
//       ?? "") to satisfy the type checker while maintaining the invariant
//       that the value is always defined at this point in the code.
//
//   Reference: Semantic Versioning 2.0.0 specification (semver.org),
//   sections 2-10. Tom Preston-Werner, original author.

/** Parsed components of a semver version string. */
export interface SemverComponents {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string | null;
  readonly build: string | null;
}

/**
 * Parse a semver version string into its numeric and string components.
 *
 * Handles the full MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD] grammar.
 * Prerelease and build identifiers are captured as raw strings without
 * further validation.
 *
 * @param input - Version string to parse.
 * @returns Parsed SemverComponents.
 * @throws SyntaxError if input does not match MAJOR.MINOR.PATCH structure.
 */
export function parseSemver(input: string): SemverComponents {
  if (input.length === 0) {
    throw new SyntaxError("parseSemver: empty input");
  }

  // Separate prerelease suffix (everything after first '-')
  let prerelease: string | null = null;
  let build: string | null = null;

  // Find build metadata first ('+' in the original string)
  const plusIndex = input.indexOf("+");
  let versionWithPre = input;
  if (plusIndex !== -1) {
    build = input.slice(plusIndex + 1);
    versionWithPre = input.slice(0, plusIndex);
  }

  // Find prerelease ('-' in the version-without-build string)
  const dashIndex = versionWithPre.indexOf("-");
  let coreVersion = versionWithPre;
  if (dashIndex !== -1) {
    prerelease = versionWithPre.slice(dashIndex + 1);
    coreVersion = versionWithPre.slice(0, dashIndex);
  }

  // Parse MAJOR.MINOR.PATCH
  const parts = coreVersion.split(".");
  if (parts.length !== 3) {
    throw new SyntaxError(
      `parseSemver: expected MAJOR.MINOR.PATCH, got ${JSON.stringify(coreVersion)}`,
    );
  }

  // After the length guard above, parts[0..2] are always defined.
  // The ?? "" fallback satisfies TypeScript's string | undefined narrowing
  // while being unreachable in practice.
  const majorStr = parts[0] ?? "";
  const minorStr = parts[1] ?? "";
  const patchStr = parts[2] ?? "";

  const major = Number.parseInt(majorStr, 10);
  const minor = Number.parseInt(minorStr, 10);
  const patch = Number.parseInt(patchStr, 10);

  if (Number.isNaN(major) || major < 0) {
    throw new SyntaxError(`parseSemver: invalid MAJOR component ${JSON.stringify(majorStr)}`);
  }
  if (Number.isNaN(minor) || minor < 0) {
    throw new SyntaxError(`parseSemver: invalid MINOR component ${JSON.stringify(minorStr)}`);
  }
  if (Number.isNaN(patch) || patch < 0) {
    throw new SyntaxError(`parseSemver: invalid PATCH component ${JSON.stringify(patchStr)}`);
  }

  return { major, minor, patch, prerelease, build };
}
