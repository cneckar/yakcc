// SPDX-License-Identifier: Apache-2.0
// A program record's modules (#1333): import() and import.meta are refused as syntax, not as text, so
// a module that only mentions them (TypeScript's own diagnostics do) is read.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProgramError, programRecord } from "./program.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

describe("program records: what the native subset refuses (#1333)", () => {
  it("a module that only mentions import() and import.meta in strings and comments is read", () => {
    const record = programRecord(here("./__fixtures__/program/syntax/mentions.js"), here(".."));
    expect(record.modules.map((m) => m.id)).toEqual([
      "src/__fixtures__/program/syntax/mentions.js",
    ]);
  });
  it("a dynamic import() is refused", () => {
    expect(() =>
      programRecord(here("./__fixtures__/program/syntax/dynamic.js"), here("..")),
    ).toThrow(ProgramError);
  });
});
