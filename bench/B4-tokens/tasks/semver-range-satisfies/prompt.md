# Task: Semver Range Satisfies

Implement three TypeScript functions for semantic versioning (a subset of the semver.org specification):

```typescript
function parseSemver(version: string): SemverVersion | null;
function parseRange(range: string): SemverRange | null;
function satisfies(version: string, range: string): boolean;

interface SemverVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;  // empty string if none; the raw prerelease string after the first "-"
}

interface SemverRange {
  comparators: Comparator[][];  // outer = OR groups (||), inner = AND comparators
}

interface Comparator {
  operator: ">=" | "<=" | ">" | "<" | "=" | "" ; // "" means exact match (same as "=")
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}
```

## Requirements

### `parseSemver(version: string): SemverVersion | null`

1. Parse a semver string in the format `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-PRERELEASE`.
2. MAJOR, MINOR, PATCH must be non-negative integers with no leading zeros (except `0` itself).
3. PRERELEASE (if present) is everything after the first `-` in the version string.
4. Return `null` for invalid input (non-numeric parts, leading zeros, missing parts).

### `parseRange(range: string): SemverRange | null`

1. Parse a range string consisting of one or more OR groups separated by `||`.
2. Each OR group is one or more comparators separated by whitespace.
3. Each comparator is an optional operator (`>=`, `<=`, `>`, `<`, `=`) followed by a semver version.
4. A comparator with no operator is an exact match (equivalent to `=`).
5. Tilde (`~`) and caret (`^`) operators are NOT required — return `null` if encountered.
6. Return `null` for invalid input.

### `satisfies(version: string, range: string): boolean`

1. Parse both version and range; return `false` if either is invalid.
2. A version satisfies a range if it satisfies ANY of the OR groups.
3. A version satisfies an OR group if it satisfies ALL comparators in that group.
4. Comparison rules:
   - Compare major, then minor, then patch numerically.
   - A version with a prerelease identifier is less than the equivalent version without prerelease (e.g., `1.0.0-alpha < 1.0.0`).
   - When comparing two versions with prerelease identifiers of the same base version, compare the prerelease strings lexicographically.
   - For the `=` or `""` operator: if the comparator has a prerelease, it must match exactly; if the comparator has no prerelease, only the numeric parts must match.

## Export

Export all three functions and all interfaces as named exports:

```typescript
export { parseSemver, parseRange, satisfies };
export type { SemverVersion, SemverRange, Comparator };
```

## Notes

- Do not use external libraries. Pure TypeScript, no dependencies.
- The implementation must be a single `.ts` file.
- This is a SUBSET of the full semver.org spec — tilde/caret ranges, build metadata, and wildcards are NOT required.
