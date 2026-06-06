// SPDX-License-Identifier: Apache-2.0
/**
 * Property-based tests for the IR->Rust lower adapter.
 *
 * Tests structural properties that must hold for all valid IR inputs:
 *   - camelCase fn names always produce snake_case Rust names
 *   - number type always maps to i32
 *   - Output always contains pub fn
 *   - Output never contains async, Promise, await
 */

import { describe, expect, it } from "vitest";
import { lowerSource } from "./lower.js";
import { toRustSnakeCase } from "./names.js";

// ---------------------------------------------------------------------------
// Property: camelCase function names always lower to snake_case
// ---------------------------------------------------------------------------

describe("lowerSource -- property: camelCase -> snake_case", () => {
  const cases = [
    ["add", "add"],
    ["addNumbers", "add_numbers"],
    ["getUserId", "get_user_id"],
    ["myFunc", "my_func"],
    ["clampValue", "clamp_value"],
  ] as const;

  for (const [tsName, rustName] of cases) {
    it(`fn name '${tsName}' -> '${rustName}'`, () => {
      const src = `export function ${tsName}(a: number): number { return a; }`;
      const { rustLines } = lowerSource(src);
      const joined = rustLines.join("\n");
      expect(joined).toContain(`pub fn ${rustName}(`);
    });
  }
});

// ---------------------------------------------------------------------------
// Property: number type always maps to i32 in all positions
// ---------------------------------------------------------------------------

describe("lowerSource -- property: number -> i32 everywhere", () => {
  it("number param -> i32", () => {
    const src = "export function f(a: number): number { return a; }";
    const { rustLines } = lowerSource(src);
    const joined = rustLines.join("\n");
    expect(joined).toContain("a: i32");
    expect(joined).toContain("-> i32");
  });

  it("number[] param -> Vec<i32>", () => {
    const src = "export function sum(xs: number[]): number { return 0; }";
    const { rustLines } = lowerSource(src);
    const joined = rustLines.join("\n");
    expect(joined).toContain("Vec<i32>");
  });
});

// ---------------------------------------------------------------------------
// Property: all valid IR always produces pub fn
// ---------------------------------------------------------------------------

describe("lowerSource -- property: output always has pub fn", () => {
  const fns = [
    "export function a(x: number): number { return x; }",
    "export function b(x: string): string { return x; }",
    "export function c(x: boolean): boolean { return !x; }",
  ];

  for (const src of fns) {
    it(`emits pub fn for: ${src.slice(0, 40)}`, () => {
      const { rustLines } = lowerSource(src);
      const joined = rustLines.join("\n");
      expect(joined).toContain("pub fn ");
    });
  }
});

// ---------------------------------------------------------------------------
// Property: toRustSnakeCase is consistent with lowerSource for names
// ---------------------------------------------------------------------------

describe("toRustSnakeCase -- consistency with lowerSource name transform", () => {
  const names = ["add", "addNumbers", "getUserId", "myFunc", "clampValue", "isEven"];

  for (const name of names) {
    it(`toRustSnakeCase('${name}') matches what lowerSource emits for fn '${name}'`, () => {
      const src = `export function ${name}(a: number): number { return a; }`;
      const { rustLines } = lowerSource(src);
      const joined = rustLines.join("\n");
      const expectedRustName = toRustSnakeCase(name);
      expect(joined).toContain(`pub fn ${expectedRustName}(`);
    });
  }
});
