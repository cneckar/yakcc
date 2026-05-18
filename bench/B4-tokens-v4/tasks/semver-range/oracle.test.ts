// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v4/tasks/semver-range/oracle.test.ts
//
// Oracle tests for the semver-range task (B4-v4).
// Critical discriminator: ^0.x.y semantics (Haiku uses ^1.x.y semantics for all).

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const implPath = process.env['IMPL_PATH']
  ? resolve(process.env['IMPL_PATH'])
  : resolve(__dirname, 'reference-impl.ts');
const implUrl = pathToFileURL(implPath).href;

let SemVerRange: new (r: string) => { satisfies(v: string): boolean };

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  SemVerRange = mod.SemVerRange;
  if (typeof SemVerRange !== 'function') {
    throw new Error(`Implementation must export SemVerRange as a named class`);
  }
});

describe('semver-range — simple comparators', () => {
  it('>1.0.0 accepts 1.0.1', () => expect(new SemVerRange('>1.0.0').satisfies('1.0.1')).toBe(true));
  it('>1.0.0 rejects 1.0.0', () => expect(new SemVerRange('>1.0.0').satisfies('1.0.0')).toBe(false));
  it('>=1.0.0 accepts 1.0.0', () => expect(new SemVerRange('>=1.0.0').satisfies('1.0.0')).toBe(true));
  it('<2.0.0 accepts 1.9.9', () => expect(new SemVerRange('<2.0.0').satisfies('1.9.9')).toBe(true));
  it('<2.0.0 rejects 2.0.0', () => expect(new SemVerRange('<2.0.0').satisfies('2.0.0')).toBe(false));
  it('<=2.0.0 accepts 2.0.0', () => expect(new SemVerRange('<=2.0.0').satisfies('2.0.0')).toBe(true));
  it('=1.2.3 accepts 1.2.3', () => expect(new SemVerRange('=1.2.3').satisfies('1.2.3')).toBe(true));
  it('=1.2.3 rejects 1.2.4', () => expect(new SemVerRange('=1.2.3').satisfies('1.2.4')).toBe(false));
  it('bare 1.2.3 is exact match', () => expect(new SemVerRange('1.2.3').satisfies('1.2.3')).toBe(true));
  it('* accepts any version', () => {
    expect(new SemVerRange('*').satisfies('0.0.1')).toBe(true);
    expect(new SemVerRange('*').satisfies('9.99.999')).toBe(true);
  });
});

describe('semver-range — AND (space-separated)', () => {
  it('>=1.0.0 <2.0.0 accepts 1.5.0', () =>
    expect(new SemVerRange('>=1.0.0 <2.0.0').satisfies('1.5.0')).toBe(true));
  it('>=1.0.0 <2.0.0 rejects 2.0.0', () =>
    expect(new SemVerRange('>=1.0.0 <2.0.0').satisfies('2.0.0')).toBe(false));
  it('>=1.0.0 <2.0.0 rejects 0.9.9', () =>
    expect(new SemVerRange('>=1.0.0 <2.0.0').satisfies('0.9.9')).toBe(false));
});

describe('semver-range — OR (||)', () => {
  it('^1.0.0 || ^2.0.0 accepts 1.5.0', () =>
    expect(new SemVerRange('^1.0.0 || ^2.0.0').satisfies('1.5.0')).toBe(true));
  it('^1.0.0 || ^2.0.0 accepts 2.3.4', () =>
    expect(new SemVerRange('^1.0.0 || ^2.0.0').satisfies('2.3.4')).toBe(true));
  it('^1.0.0 || ^2.0.0 rejects 3.0.0', () =>
    expect(new SemVerRange('^1.0.0 || ^2.0.0').satisfies('3.0.0')).toBe(false));
});

describe('semver-range — tilde ranges', () => {
  it('~1.2.3 accepts 1.2.9', () => expect(new SemVerRange('~1.2.3').satisfies('1.2.9')).toBe(true));
  it('~1.2.3 rejects 1.3.0', () => expect(new SemVerRange('~1.2.3').satisfies('1.3.0')).toBe(false));
  it('~1.2.3 rejects 1.2.2', () => expect(new SemVerRange('~1.2.3').satisfies('1.2.2')).toBe(false));
  it('~1.2 accepts 1.2.5', () => expect(new SemVerRange('~1.2').satisfies('1.2.5')).toBe(true));
  it('~1.2 rejects 1.3.0', () => expect(new SemVerRange('~1.2').satisfies('1.3.0')).toBe(false));
  it('~1 accepts 1.9.9', () => expect(new SemVerRange('~1').satisfies('1.9.9')).toBe(true));
  it('~1 rejects 2.0.0', () => expect(new SemVerRange('~1').satisfies('2.0.0')).toBe(false));
});

describe('semver-range — caret ranges (non-zero major)', () => {
  it('^1.2.3 accepts 1.2.3', () => expect(new SemVerRange('^1.2.3').satisfies('1.2.3')).toBe(true));
  it('^1.2.3 accepts 1.99.99', () => expect(new SemVerRange('^1.2.3').satisfies('1.99.99')).toBe(true));
  it('^1.2.3 rejects 2.0.0', () => expect(new SemVerRange('^1.2.3').satisfies('2.0.0')).toBe(false));
  it('^1.2.3 rejects 1.2.2', () => expect(new SemVerRange('^1.2.3').satisfies('1.2.2')).toBe(false));
  it('^2.0.0 accepts 2.5.0', () => expect(new SemVerRange('^2.0.0').satisfies('2.5.0')).toBe(true));
  it('^2.0.0 rejects 3.0.0', () => expect(new SemVerRange('^2.0.0').satisfies('3.0.0')).toBe(false));
});

describe('semver-range — caret ranges (zero major) — critical Haiku discriminator', () => {
  // ^0.2.3 → >=0.2.3 <0.3.0  (NOT <1.0.0)
  it('^0.2.3 accepts 0.2.5', () => expect(new SemVerRange('^0.2.3').satisfies('0.2.5')).toBe(true));
  it('^0.2.3 rejects 0.3.0', () => expect(new SemVerRange('^0.2.3').satisfies('0.3.0')).toBe(false));
  it('^0.2.3 rejects 1.0.0 (NOT same as ^1.0.0)', () =>
    expect(new SemVerRange('^0.2.3').satisfies('1.0.0')).toBe(false));
  it('^0.2.3 rejects 0.2.2', () => expect(new SemVerRange('^0.2.3').satisfies('0.2.2')).toBe(false));

  // ^0.0.3 → >=0.0.3 <0.0.4  (locks patch)
  it('^0.0.3 accepts only 0.0.3', () => expect(new SemVerRange('^0.0.3').satisfies('0.0.3')).toBe(true));
  it('^0.0.3 rejects 0.0.4', () => expect(new SemVerRange('^0.0.3').satisfies('0.0.4')).toBe(false));
  it('^0.0.3 rejects 0.1.0', () => expect(new SemVerRange('^0.0.3').satisfies('0.1.0')).toBe(false));
  it('^0.0.3 rejects 1.0.0', () => expect(new SemVerRange('^0.0.3').satisfies('1.0.0')).toBe(false));

  // ^0.0.0 → >=0.0.0 <0.0.1
  it('^0.0.0 accepts 0.0.0', () => expect(new SemVerRange('^0.0.0').satisfies('0.0.0')).toBe(true));
  it('^0.0.0 rejects 0.0.1', () => expect(new SemVerRange('^0.0.0').satisfies('0.0.1')).toBe(false));
});

describe('semver-range — numeric comparison (no lexicographic confusion)', () => {
  it('1.10.0 > 1.9.0', () => expect(new SemVerRange('>1.9.0').satisfies('1.10.0')).toBe(true));
  it('1.9.0 is not > 1.10.0', () => expect(new SemVerRange('>1.9.0').satisfies('1.9.0')).toBe(false));
  it('^1.9.0 accepts 1.10.0', () => expect(new SemVerRange('^1.9.0').satisfies('1.10.0')).toBe(true));
});

describe('semver-range — error cases', () => {
  it('satisfies() throws TypeError for invalid version', () => {
    expect(() => new SemVerRange('>=1.0.0').satisfies('not-a-version')).toThrow(TypeError);
  });
  it('satisfies() throws TypeError for partial version', () => {
    expect(() => new SemVerRange('>=1.0.0').satisfies('1.0')).toThrow(TypeError);
  });
});
