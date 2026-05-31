// SPDX-License-Identifier: MIT
// SemVer range satisfaction — subset of node-semver spec.

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function parseSemVer(v: string): SemVer {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) throw new TypeError(`Invalid semver: "${v}"`);
  return { major: parseInt(m[1]!, 10), minor: parseInt(m[2]!, 10), patch: parseInt(m[3]!, 10) };
}

function cmp(a: SemVer, op: string, b: SemVer): boolean {
  const diff = a.major !== b.major ? a.major - b.major
    : a.minor !== b.minor ? a.minor - b.minor
    : a.patch - b.patch;
  switch (op) {
    case '>':  return diff > 0;
    case '>=': return diff >= 0;
    case '<':  return diff < 0;
    case '<=': return diff <= 0;
    case '=':  return diff === 0;
    default:   throw new TypeError(`Unknown comparator operator: ${op}`);
  }
}

type Comparator = (v: SemVer) => boolean;

function parseComparator(token: string): Comparator {
  token = token.trim();

  if (token === '*' || token === '') return () => true;

  // Tilde range
  if (token.startsWith('~')) {
    const ver = token.slice(1).trim();
    const parts = ver.split('.').map(Number);
    if (parts.length === 3) {
      const lo = { major: parts[0]!, minor: parts[1]!, patch: parts[2]! };
      const hi = { major: parts[0]!, minor: parts[1]! + 1, patch: 0 };
      return (v) => cmp(v, '>=', lo) && cmp(v, '<', hi);
    }
    if (parts.length === 2) {
      const lo = { major: parts[0]!, minor: parts[1]!, patch: 0 };
      const hi = { major: parts[0]!, minor: parts[1]! + 1, patch: 0 };
      return (v) => cmp(v, '>=', lo) && cmp(v, '<', hi);
    }
    // ~1 → >=1.0.0 <2.0.0
    const lo = { major: parts[0]!, minor: 0, patch: 0 };
    const hi = { major: parts[0]! + 1, minor: 0, patch: 0 };
    return (v) => cmp(v, '>=', lo) && cmp(v, '<', hi);
  }

  // Caret range — CRITICAL: 0.x.y semantics differ from 1.x.y
  if (token.startsWith('^')) {
    const ver = token.slice(1).trim();
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(ver);
    if (!m) throw new TypeError(`Invalid caret range: "${token}"`);
    const [, Mj, Mn, Pa] = m;
    const major = parseInt(Mj!, 10);
    const minor = parseInt(Mn!, 10);
    const patch = parseInt(Pa!, 10);
    const lo = { major, minor, patch };

    let hi: SemVer;
    if (major !== 0) {
      // ^1.2.3 → <2.0.0
      hi = { major: major + 1, minor: 0, patch: 0 };
    } else if (minor !== 0) {
      // ^0.2.3 → <0.3.0
      hi = { major: 0, minor: minor + 1, patch: 0 };
    } else {
      // ^0.0.3 → <0.0.4; ^0.0.0 → <0.0.1
      hi = { major: 0, minor: 0, patch: patch + 1 };
    }
    return (v) => cmp(v, '>=', lo) && cmp(v, '<', hi);
  }

  // Simple comparators: >=, <=, >, <, =, or bare version
  const opMatch = /^(>=|<=|>|<|=)(.*)$/.exec(token);
  if (opMatch) {
    const op = opMatch[1]!;
    const semver = parseSemVer(opMatch[2]!);
    return (v) => cmp(v, op, semver);
  }

  // Bare version: exact match
  const semver = parseSemVer(token);
  return (v) => cmp(v, '=', semver);
}

type AndSet = Comparator[];

function parseAndSet(andStr: string): AndSet {
  return andStr.trim().split(/\s+/).filter(Boolean).map(parseComparator);
}

function satisfiesAndSet(v: SemVer, andSet: AndSet): boolean {
  return andSet.every((c) => c(v));
}

export class SemVerRange {
  private readonly orSets: AndSet[];

  constructor(range: string) {
    // Split by || (OR), then each part is an AND set of space-separated comparators
    this.orSets = range.split('||').map(parseAndSet);
    if (this.orSets.length === 0) {
      throw new TypeError(`Empty range: "${range}"`);
    }
  }

  satisfies(version: string): boolean {
    const v = parseSemVer(version);
    return this.orSets.some((andSet) => satisfiesAndSet(v, andSet));
  }
}
