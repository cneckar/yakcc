// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/csv-parser-quoted/oracle.test.ts
//
// @decision DEC-BENCH-B4-HARNESS-001
// @title B4 harness oracle: CSV parser with quoted-field handling
// @status accepted
// @rationale
//   Oracle tests for semantic-equivalence verification. Must pass against reference-impl.ts
//   before Slice 2 measures LLM-generated implementations. Tests cover RFC 4180 corner
//   cases brutally: escaped quotes, embedded newlines, CRLF/LF, BOM, ragged rows.
//   A broken implementation cannot pass by accident.
//
// Usage:
//   vitest run --config bench/B4-tokens/vitest.config.mjs bench/B4-tokens/tasks/csv-parser-quoted/oracle.test.ts

import { describe, expect, it, beforeEach } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const implPath = process.env["IMPL_PATH"]
  ? resolve(process.env["IMPL_PATH"])
  : resolve(__dirname, "reference-impl.ts");

const implUrl = pathToFileURL(implPath).href;

let parseCSV: (input: string, options?: { delimiter?: string; quote?: string; newline?: string }) => string[][];

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  parseCSV = mod.parseCSV ?? mod.default;
  if (typeof parseCSV !== "function") {
    throw new Error(
      `Implementation at ${implPath} must export parseCSV as a named or default export function`
    );
  }
});

describe("parseCSV — basic cases", () => {
  it("empty string returns empty array", () => {
    expect(parseCSV("")).toEqual([]);
  });

  it("single row no newline", () => {
    expect(parseCSV("a,b,c")).toEqual([["a", "b", "c"]]);
  });

  it("single row with trailing LF — no spurious empty row", () => {
    expect(parseCSV("a,b,c\n")).toEqual([["a", "b", "c"]]);
  });

  it("single row with trailing CRLF — no spurious empty row", () => {
    expect(parseCSV("a,b,c\r\n")).toEqual([["a", "b", "c"]]);
  });

  it("two rows LF separated", () => {
    expect(parseCSV("a,b\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("two rows CRLF separated", () => {
    expect(parseCSV("a,b\r\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("numeric-looking fields are returned as strings", () => {
    expect(parseCSV("1,2,3\n4,5,6")).toEqual([["1", "2", "3"], ["4", "5", "6"]]);
  });
});

describe("parseCSV — quoted fields", () => {
  it("simple quoted field", () => {
    expect(parseCSV('"hello"')).toEqual([["hello"]]);
  });

  it("quoted field containing delimiter", () => {
    expect(parseCSV('"a,b",c')).toEqual([["a,b", "c"]]);
  });

  it("empty quoted field is empty string", () => {
    expect(parseCSV('""')).toEqual([[""]]);
  });

  it("empty quoted field between delimiters", () => {
    expect(parseCSV('a,"",b')).toEqual([["a", "", "b"]]);
  });

  it("quoted field at end of row", () => {
    expect(parseCSV('a,"end"')).toEqual([["a", "end"]]);
  });

  it("all fields quoted", () => {
    expect(parseCSV('"a","b","c"')).toEqual([["a", "b", "c"]]);
  });
});

describe("parseCSV — escaped quotes (RFC 4180 §2.7)", () => {
  it('two consecutive quotes inside quoted field = one literal quote', () => {
    // "He said ""hello""" -> He said "hello"
    expect(parseCSV('"He said ""hello"""')).toEqual([['He said "hello"']]);
  });

  it("quote at start and end of quoted content", () => {
    // """"  -> one quote character
    expect(parseCSV('""""')).toEqual([['"']]);
  });

  it("multiple escaped quotes in one field", () => {
    // "a""b""c" -> a"b"c
    expect(parseCSV('"a""b""c"')).toEqual([['a"b"c']]);
  });

  it("escaped quote with surrounding content", () => {
    // "before ""quote"" after" -> before "quote" after
    expect(parseCSV('"before ""quote"" after"')).toEqual([['before "quote" after']]);
  });

  it("field with only escaped quotes", () => {
    // """""" -> ""  (three pairs = two quotes... wait: 6 quote chars = 3 pairs)
    // Actually: open-quote, pair, pair, close = ""
    // Let's use 4 quotes: """" = open-quote, double-quote-escape, close-quote -> "
    expect(parseCSV('""""')).toEqual([['"']]);
  });
});

describe("parseCSV — embedded newlines inside quoted fields", () => {
  it("LF inside quoted field is preserved verbatim", () => {
    expect(parseCSV('"line1\nline2"')).toEqual([["line1\nline2"]]);
  });

  it("CRLF inside quoted field is preserved verbatim", () => {
    expect(parseCSV('"line1\r\nline2"')).toEqual([["line1\r\nline2"]]);
  });

  it("multiple newlines inside quoted field", () => {
    expect(parseCSV('"a\nb\nc"')).toEqual([["a\nb\nc"]]);
  });

  it("embedded newline field followed by more rows", () => {
    const input = '"multi\nline",end\nnext,row';
    expect(parseCSV(input)).toEqual([
      ["multi\nline", "end"],
      ["next", "row"],
    ]);
  });

  it("quoted field with embedded CRLF followed by another field", () => {
    const input = '"a\r\nb",c';
    expect(parseCSV(input)).toEqual([["a\r\nb", "c"]]);
  });
});

describe("parseCSV — CRLF vs LF line endings", () => {
  it("mixed CRLF and LF in same file", () => {
    // Some systems produce mixed line endings
    expect(parseCSV("a,b\r\nc,d\ne,f")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
  });

  it("CRLF trailing newline suppressed", () => {
    expect(parseCSV("a,b\r\nc,d\r\n")).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("LF trailing newline suppressed", () => {
    expect(parseCSV("a,b\nc,d\n")).toEqual([["a", "b"], ["c", "d"]]);
  });
});

describe("parseCSV — trailing empty fields and ragged rows", () => {
  it("trailing delimiter creates empty final field", () => {
    // "a,b," -> ["a","b",""]
    expect(parseCSV("a,b,")).toEqual([["a", "b", ""]]);
  });

  it("leading delimiter creates empty first field", () => {
    expect(parseCSV(",b,c")).toEqual([["", "b", "c"]]);
  });

  it("ragged rows: different column counts per row", () => {
    expect(parseCSV("a,b,c\nd,e\nf")).toEqual([
      ["a", "b", "c"],
      ["d", "e"],
      ["f"],
    ]);
  });

  it("row with only delimiter: single empty field row", () => {
    expect(parseCSV(",")).toEqual([["", ""]]);
  });
});

describe("parseCSV — BOM handling", () => {
  it("strips leading UTF-8 BOM (U+FEFF)", () => {
    // BOM is ﻿ prepended to the string
    const withBom = "﻿a,b,c";
    expect(parseCSV(withBom)).toEqual([["a", "b", "c"]]);
  });

  it("BOM-only input returns empty array", () => {
    expect(parseCSV("﻿")).toEqual([]);
  });
});

describe("parseCSV — options: custom delimiter", () => {
  it("tab-separated values", () => {
    expect(parseCSV("a\tb\tc", { delimiter: "\t" })).toEqual([["a", "b", "c"]]);
  });

  it("semicolon delimiter", () => {
    expect(parseCSV("a;b;c", { delimiter: ";" })).toEqual([["a", "b", "c"]]);
  });

  it("pipe delimiter with quoted field containing pipe", () => {
    expect(parseCSV('"a|b"|c', { delimiter: "|" })).toEqual([["a|b", "c"]]);
  });
});

describe("parseCSV — whitespace significance", () => {
  it("whitespace in unquoted fields is preserved (NOT trimmed)", () => {
    expect(parseCSV("  a ,  b  ")).toEqual([["  a ", "  b  "]]);
  });

  it("whitespace inside quoted field is preserved", () => {
    expect(parseCSV('"  spaces  "')).toEqual([["  spaces  "]]);
  });
});

describe("parseCSV — multi-row with mixed quoting", () => {
  it("realistic CSV with headers and data", () => {
    const csv = [
      "name,age,bio",
      '"Alice","30","loves ""coding"""',
      '"Bob","25","line1\nline2"',
    ].join("\n");

    expect(parseCSV(csv)).toEqual([
      ["name", "age", "bio"],
      ["Alice", "30", 'loves "coding"'],
      ["Bob", "25", "line1\nline2"],
    ]);
  });

  it("all-empty rows (just newlines)", () => {
    // "\n\n" = empty-field LF empty-field LF(trailing-suppressed) = 2 rows
    // The trailing newline suppression means the final \n does not produce a third row.
    expect(parseCSV("\n\n")).toEqual([[""], [""]]);
    // Three actual data rows require three newlines where the last is trailing:
    expect(parseCSV("\n\n\n")).toEqual([[""], [""], [""]]);
  });
});
