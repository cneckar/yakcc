// SPDX-License-Identifier: MIT
//
// Tests for the Python -> TS-subset IR type mapping (WI-782 slice 2 + WI-889).
//
// WI-889 changes mapPythonType to return { tsType, warnings } instead of
// string.  ALL existing assertions are migrated to destructure .tsType.
// New describe blocks cover: Any, quoted forward references, Callable,
// ModuleType, dict[Any,V], and real bs4 regressions from #889.

import { describe, expect, it } from "vitest";
import { type LowerWarning, UnsupportedTypeError, mapPythonType } from "./type-map.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert the result has no warnings and the expected TS type. */
function expectClean(annotation: string, expectedTs: string) {
  const result = mapPythonType(annotation);
  expect(result.tsType).toBe(expectedTs);
  expect(result.warnings).toHaveLength(0);
}

/** Assert the result has exactly one warning with the given code. */
function expectOneWarning(result: ReturnType<typeof mapPythonType>, code: LowerWarning["code"]) {
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]?.code).toBe(code);
}

// ---------------------------------------------------------------------------
// Existing primitive tests — migrated to destructure .tsType (no behaviour change)
// ---------------------------------------------------------------------------

describe("mapPythonType — primitives", () => {
  it.each([
    ["int", "number"],
    ["float", "number"],
    ["str", "string"],
    ["bool", "boolean"],
    ["bytes", "Uint8Array"],
    ["None", "null"],
    ["NoneType", "null"],
  ])("maps %s -> %s", (py, ts) => {
    expectClean(py as string, ts as string);
  });

  it("tolerates leading/trailing whitespace", () => {
    expect(mapPythonType("  int  ").tsType).toBe("number");
  });

  it("rejects empty annotation", () => {
    expect(() => mapPythonType("")).toThrow(UnsupportedTypeError);
  });
});

// ---------------------------------------------------------------------------
// Existing container tests — migrated to destructure .tsType
// ---------------------------------------------------------------------------

describe("mapPythonType — containers", () => {
  it("list[int] -> number[]", () => {
    expectClean("list[int]", "number[]");
  });
  it("List[int] (legacy typing module) -> number[]", () => {
    expectClean("List[int]", "number[]");
  });
  it("list[list[str]] -> string[][]", () => {
    expectClean("list[list[str]]", "string[][]");
  });
  it("dict[str, int] -> Record<string, number>", () => {
    expectClean("dict[str, int]", "Record<string, number>");
  });
  it("Dict[str, list[bool]] -> Record<string, boolean[]>", () => {
    expectClean("Dict[str, list[bool]]", "Record<string, boolean[]>");
  });
  it("dict with non-str, non-Any key rejects", () => {
    expect(() => mapPythonType("dict[int, str]")).toThrow(/dict key must be 'str'/);
  });
  it("dict with wrong arity rejects", () => {
    expect(() => mapPythonType("dict[str]")).toThrow(/exactly 2 type args/);
  });
  it("tuple[str, int] -> [string, number]", () => {
    expectClean("tuple[str, int]", "[string, number]");
  });
});

// ---------------------------------------------------------------------------
// Existing Optional/Union/PEP 604 tests — migrated
// ---------------------------------------------------------------------------

describe("mapPythonType — Optional / Union / PEP 604", () => {
  it("Optional[int] -> number | null", () => {
    expectClean("Optional[int]", "number | null");
  });
  it("Union[int, str] -> number | string", () => {
    expectClean("Union[int, str]", "number | string");
  });
  it("PEP 604: int | None -> number | null", () => {
    expectClean("int | None", "number | null");
  });
  it("PEP 604: int | str | bool -> number | string | boolean", () => {
    expectClean("int | str | bool", "number | string | boolean");
  });
});

// ---------------------------------------------------------------------------
// Existing unsupported tests — migrated
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// WI-889 W-3: Any / typing.Any widening (DEC-WI889-001)
// ---------------------------------------------------------------------------

describe("mapPythonType — Any widening", () => {
  it("Any -> unknown with any-widened warning", () => {
    const result = mapPythonType("Any");
    expect(result.tsType).toBe("unknown");
    expectOneWarning(result, "any-widened");
    expect(result.warnings[0]?.pythonFragment).toBe("Any");
  });

  it("typing.Any -> unknown with any-widened warning", () => {
    const result = mapPythonType("typing.Any");
    expect(result.tsType).toBe("unknown");
    expectOneWarning(result, "any-widened");
    expect(result.warnings[0]?.pythonFragment).toBe("typing.Any");
  });

  it("warning has a non-empty message", () => {
    const result = mapPythonType("Any");
    expect(result.warnings[0]?.message).toBeTruthy();
  });

  it("Optional[Any] -> unknown | null with any-widened warning propagated", () => {
    const result = mapPythonType("Optional[Any]");
    expect(result.tsType).toBe("unknown | null");
    expectOneWarning(result, "any-widened");
  });

  it("list[Any] -> unknown[] with any-widened warning", () => {
    const result = mapPythonType("list[Any]");
    expect(result.tsType).toBe("unknown[]");
    expectOneWarning(result, "any-widened");
  });

  it("Union[int, Any] -> number | unknown with any-widened warning", () => {
    const result = mapPythonType("Union[int, Any]");
    expect(result.tsType).toBe("number | unknown");
    expectOneWarning(result, "any-widened");
  });
});

// ---------------------------------------------------------------------------
// WI-889 W-2: Quoted forward references (DEC-WI889-002)
// ---------------------------------------------------------------------------

describe("mapPythonType — quoted forward references", () => {
  it('double-quoted known type strips quotes and maps: "int" -> number', () => {
    const result = mapPythonType('"int"');
    expect(result.tsType).toBe("number");
    expect(result.warnings).toHaveLength(0);
  });

  it("single-quoted known type strips quotes and maps: 'str' -> string", () => {
    const result = mapPythonType("'str'");
    expect(result.tsType).toBe("string");
    expect(result.warnings).toHaveLength(0);
  });

  it('double-quoted unsupported type throws with inner name in error: "_IncomingMarkup"', () => {
    try {
      mapPythonType('"_IncomingMarkup"');
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedTypeError);
      // Error message must reference the inner (unquoted) name, not the quoted form.
      expect((err as Error).message).toContain("_IncomingMarkup");
      expect((err as Error).message).not.toContain('"_IncomingMarkup"');
    }
  });

  it("single-quoted unsupported type throws with inner name: '_IncomingMarkup'", () => {
    try {
      mapPythonType("'_IncomingMarkup'");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedTypeError);
      expect((err as Error).message).toContain("_IncomingMarkup");
    }
  });

  it('double-quoted Any strips and maps to unknown: "Any"', () => {
    const result = mapPythonType('"Any"');
    expect(result.tsType).toBe("unknown");
    expectOneWarning(result, "any-widened");
  });

  it("empty string after quote strip throws", () => {
    expect(() => mapPythonType('""')).toThrow(UnsupportedTypeError);
    expect(() => mapPythonType("''")).toThrow(UnsupportedTypeError);
  });

  it("mixed quotes are NOT stripped (only matching open+close quotes qualify)", () => {
    // "int' has mismatched quotes — not a forward-ref, should throw as unknown type.
    expect(() => mapPythonType("\"int'")).toThrow(UnsupportedTypeError);
  });

  it("inner whitespace is trimmed after stripping: ' int ' -> number", () => {
    const result = mapPythonType("' int '");
    expect(result.tsType).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// WI-889 W-6: Callable three-form support (DEC-WI889-003)
// ---------------------------------------------------------------------------

describe("mapPythonType — Callable", () => {
  it("bare Callable -> (...args: unknown[]) => unknown with callable-widened warning", () => {
    const result = mapPythonType("Callable");
    expect(result.tsType).toBe("(...args: unknown[]) => unknown");
    expectOneWarning(result, "callable-widened");
  });

  it("Callable[..., int] -> (...args: unknown[]) => number with callable-widened warning", () => {
    const result = mapPythonType("Callable[..., int]");
    expect(result.tsType).toBe("(...args: unknown[]) => number");
    expectOneWarning(result, "callable-widened");
  });

  it("Callable[..., str] return type is mapped", () => {
    const result = mapPythonType("Callable[..., str]");
    expect(result.tsType).toBe("(...args: unknown[]) => string");
  });

  it("Callable[[int, str], bool] -> (arg0: number, arg1: string) => boolean, no warning", () => {
    const result = mapPythonType("Callable[[int, str], bool]");
    expect(result.tsType).toBe("(arg0: number, arg1: string) => boolean");
    expect(result.warnings).toHaveLength(0);
  });

  it("Callable[[int], int] single-arg explicit -> (arg0: number) => number, no warning", () => {
    const result = mapPythonType("Callable[[int], int]");
    expect(result.tsType).toBe("(arg0: number) => number");
    expect(result.warnings).toHaveLength(0);
  });

  it("Callable[[], str] zero-arg -> () => string, no warning", () => {
    const result = mapPythonType("Callable[[], str]");
    expect(result.tsType).toBe("() => string");
    expect(result.warnings).toHaveLength(0);
  });

  it("Callable[[Any], Any] -> (arg0: unknown) => unknown with 2 any-widened warnings", () => {
    const result = mapPythonType("Callable[[Any], Any]");
    expect(result.tsType).toBe("(arg0: unknown) => unknown");
    // Both the param and the return type produce any-widened warnings.
    const codes = result.warnings.map((w) => w.code);
    expect(codes.filter((c) => c === "any-widened")).toHaveLength(2);
  });

  it("Callable warning has a non-empty message and pythonFragment", () => {
    const result = mapPythonType("Callable");
    expect(result.warnings[0]?.message).toBeTruthy();
    expect(result.warnings[0]?.pythonFragment).toBe("Callable");
  });

  it("nested Callable[[Callable[[int], int]], int] recurses correctly", () => {
    const result = mapPythonType("Callable[[Callable[[int], int]], int]");
    expect(result.tsType).toBe("(arg0: (arg0: number) => number) => number");
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// WI-889 W-4: ModuleType widening (DEC-WI889-004)
// ---------------------------------------------------------------------------

describe("mapPythonType — ModuleType", () => {
  it("ModuleType -> unknown with module-type-widened warning", () => {
    const result = mapPythonType("ModuleType");
    expect(result.tsType).toBe("unknown");
    expectOneWarning(result, "module-type-widened");
    expect(result.warnings[0]?.pythonFragment).toBe("ModuleType");
  });

  it("types.ModuleType -> unknown with module-type-widened warning", () => {
    const result = mapPythonType("types.ModuleType");
    expect(result.tsType).toBe("unknown");
    expectOneWarning(result, "module-type-widened");
    expect(result.warnings[0]?.pythonFragment).toBe("types.ModuleType");
  });

  it("ModuleType warning has a non-empty message", () => {
    const result = mapPythonType("ModuleType");
    expect(result.warnings[0]?.message).toBeTruthy();
  });

  it("Optional[ModuleType] -> unknown | null with module-type-widened warning propagated", () => {
    const result = mapPythonType("Optional[ModuleType]");
    expect(result.tsType).toBe("unknown | null");
    expectOneWarning(result, "module-type-widened");
  });
});

// ---------------------------------------------------------------------------
// WI-889 W-5: dict[Any, V] relaxation (DEC-WI889-005)
// ---------------------------------------------------------------------------

describe("mapPythonType — dict[Any, V]", () => {
  it("dict[Any, str] -> Record<string, string> with dict-any-key-widened warning", () => {
    const result = mapPythonType("dict[Any, str]");
    expect(result.tsType).toBe("Record<string, string>");
    const keyWarnings = result.warnings.filter((w) => w.code === "dict-any-key-widened");
    expect(keyWarnings).toHaveLength(1);
  });

  it("dict[Any, int] -> Record<string, number> with dict-any-key-widened warning", () => {
    const result = mapPythonType("dict[Any, int]");
    expect(result.tsType).toBe("Record<string, number>");
    expectOneWarning(result, "dict-any-key-widened");
  });

  it("dict[Any, Any] -> Record<string, unknown> with both key and value warnings", () => {
    const result = mapPythonType("dict[Any, Any]");
    expect(result.tsType).toBe("Record<string, unknown>");
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("dict-any-key-widened");
    expect(codes).toContain("any-widened");
  });

  it("typing.Any as key also triggers dict-any-key-widened", () => {
    const result = mapPythonType("dict[typing.Any, str]");
    expect(result.tsType).toBe("Record<string, string>");
    expect(result.warnings.some((w) => w.code === "dict-any-key-widened")).toBe(true);
  });

  it("dict[int, str] still throws UnsupportedTypeError (non-Any non-str key)", () => {
    expect(() => mapPythonType("dict[int, str]")).toThrow(/dict key must be 'str'/);
  });

  it("dict[Any, V] warning has non-empty message and pythonFragment", () => {
    const result = mapPythonType("dict[Any, str]");
    const w = result.warnings.find((w) => w.code === "dict-any-key-widened");
    expect(w?.message).toBeTruthy();
    expect(w?.pythonFragment).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// WI-889 W-10: Real bs4 regression tests — all 7 annotations from #889
// ---------------------------------------------------------------------------

describe("mapPythonType — real bs4 regressions from #889", () => {
  // bs4 case 1: Callable[[Any], Any] — was UnsupportedTypeError
  it("bs4 #1: Callable[[Any], Any] maps to (arg0: unknown) => unknown", () => {
    const result = mapPythonType("Callable[[Any], Any]");
    expect(result.tsType).toBe("(arg0: unknown) => unknown");
    const codes = result.warnings.map((w) => w.code);
    expect(codes.filter((c) => c === "any-widened")).toHaveLength(2);
  });

  // bs4 case 2: bare Callable — was UnsupportedTypeError
  it("bs4 #2: bare Callable maps to (...args: unknown[]) => unknown with callable-widened", () => {
    const result = mapPythonType("Callable");
    expect(result.tsType).toBe("(...args: unknown[]) => unknown");
    expectOneWarning(result, "callable-widened");
  });

  // bs4 case 3: "_IncomingMarkup" double-quoted forward ref
  // Quote handling is fixed (no longer throws on the quote form).
  // The inner symbol _IncomingMarkup is genuinely unsupported — the UnsupportedTypeError
  // must reference the inner name, not the outer quoted form.
  it('bs4 #3: "_IncomingMarkup" strips quotes and throws on inner _IncomingMarkup', () => {
    try {
      mapPythonType('"_IncomingMarkup"');
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedTypeError);
      expect((err as Error).message).toContain("_IncomingMarkup");
      expect((err as Error).message).not.toContain('"_IncomingMarkup"');
    }
  });

  // bs4 case 4: "_IncomingMarkup" again (lxml_trace path) — same as case 3
  it('bs4 #4 (lxml_trace): "_IncomingMarkup" same as case 3 — error references inner name', () => {
    try {
      mapPythonType('"_IncomingMarkup"');
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedTypeError);
      expect((err as UnsupportedTypeError).pythonType).toBe("_IncomingMarkup");
    }
  });

  // bs4 case 5: dict[Any, str] — was throwing "dict key must be 'str'"
  it("bs4 #5: dict[Any, str] -> Record<string, string> with dict-any-key-widened warning", () => {
    const result = mapPythonType("dict[Any, str]");
    expect(result.tsType).toBe("Record<string, string>");
    expect(result.warnings.some((w) => w.code === "dict-any-key-widened")).toBe(true);
  });

  // bs4 case 6: ModuleType — was UnsupportedTypeError
  it("bs4 #6: ModuleType -> unknown with module-type-widened warning", () => {
    const result = mapPythonType("ModuleType");
    expect(result.tsType).toBe("unknown");
    expectOneWarning(result, "module-type-widened");
  });

  // bs4 case 7: Any (from __getattr__) — was UnsupportedTypeError
  it("bs4 #7: Any (__getattr__ return) -> unknown with any-widened warning", () => {
    const result = mapPythonType("Any");
    expect(result.tsType).toBe("unknown");
    expectOneWarning(result, "any-widened");
  });
});
