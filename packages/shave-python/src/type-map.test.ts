// SPDX-License-Identifier: MIT
//
// Tests for the Python → TS-subset IR type mapping (WI-782 slice 2).

import { describe, expect, it } from "vitest";
import { UnsupportedTypeError, mapPythonType } from "./type-map.js";

describe("mapPythonType — primitives", () => {
  it.each([
    ["int", "number"],
    ["float", "number"],
    ["str", "string"],
    ["bool", "boolean"],
    ["bytes", "Uint8Array"],
    ["None", "null"],
    ["NoneType", "null"],
  ])("maps %s → %s", (py, ts) => {
    expect(mapPythonType(py)).toBe(ts);
  });

  it("tolerates leading/trailing whitespace", () => {
    expect(mapPythonType("  int  ")).toBe("number");
  });

  it("rejects empty annotation", () => {
    expect(() => mapPythonType("")).toThrow(UnsupportedTypeError);
  });
});

describe("mapPythonType — containers", () => {
  it("list[int] → number[]", () => {
    expect(mapPythonType("list[int]")).toBe("number[]");
  });
  it("List[int] (legacy typing module) → number[]", () => {
    expect(mapPythonType("List[int]")).toBe("number[]");
  });
  it("list[list[str]] → string[][]", () => {
    expect(mapPythonType("list[list[str]]")).toBe("string[][]");
  });
  it("dict[str, int] → Record<string, number>", () => {
    expect(mapPythonType("dict[str, int]")).toBe("Record<string, number>");
  });
  it("Dict[str, list[bool]] → Record<string, boolean[]>", () => {
    expect(mapPythonType("Dict[str, list[bool]]")).toBe("Record<string, boolean[]>");
  });
  it("dict with non-str key rejects", () => {
    expect(() => mapPythonType("dict[int, str]")).toThrow(/dict key must be 'str'/);
  });
  it("dict with wrong arity rejects", () => {
    expect(() => mapPythonType("dict[str]")).toThrow(/exactly 2 type args/);
  });
  it("tuple[str, int] → [string, number]", () => {
    expect(mapPythonType("tuple[str, int]")).toBe("[string, number]");
  });
});

describe("mapPythonType — Optional / Union / PEP 604", () => {
  it("Optional[int] → number | null", () => {
    expect(mapPythonType("Optional[int]")).toBe("number | null");
  });
  it("Union[int, str] → number | string", () => {
    expect(mapPythonType("Union[int, str]")).toBe("number | string");
  });
  it("PEP 604: int | None → number | null", () => {
    expect(mapPythonType("int | None")).toBe("number | null");
  });
  it("PEP 604: int | str | bool → number | string | boolean", () => {
    expect(mapPythonType("int | str | bool")).toBe("number | string | boolean");
  });
});

describe("mapPythonType — unsupported", () => {
  it("rejects unknown primitive", () => {
    try {
      mapPythonType("Decimal");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedTypeError);
      expect((err as Error).message).toContain("Decimal");
      expect((err as Error).message).toContain("slice-2 mapping table");
    }
  });
  it("rejects unknown container", () => {
    expect(() => mapPythonType("MyContainer[int]")).toThrow(UnsupportedTypeError);
  });
  it("carries the offending type on the thrown error", () => {
    try {
      mapPythonType("bigint");
    } catch (err) {
      expect((err as UnsupportedTypeError).pythonType).toBe("bigint");
    }
  });
});
