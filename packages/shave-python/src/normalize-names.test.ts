// SPDX-License-Identifier: MIT
//
// Tests for normalize-names.ts — snake_case→camelCase identifier normalization
// (WI-782 slice 3).
//
// @decision DEC-POLYGLOT-SHAVE-PY-NORMALIZE-TEST-001 (WI-782 slice 3)
// @title normalizeIdentifier edge-case table drives specification
// @status accepted (WI-782 slice 3)
// @rationale
//   The normalization rules have several nuanced edge cases (leading underscore,
//   dunder, ALL_CAPS, numeric suffix).  A table-driven test suite makes the
//   contract explicit and prevents regressions when the function is extended.

import { describe, expect, it } from "vitest";
import {
  buildParamRenameMap,
  normalizeBodyNames,
  normalizeExprNames,
  normalizeIdentifier,
  normalizeSignatureNames,
} from "./normalize-names.js";
import type { FunctionSignature, RaisedParam } from "./parse-fn-signature.js";
import type { WireStmt } from "./raise-body.js";

// ---------------------------------------------------------------------------
// normalizeIdentifier — comprehensive edge-case table
// ---------------------------------------------------------------------------

describe("normalizeIdentifier — core rules", () => {
  // Rule 5: snake_case → camelCase
  const snakeCaseCases: [string, string][] = [
    ["calc_total", "calcTotal"],
    ["calc_total_sum", "calcTotalSum"],
    ["my_value", "myValue"],
    ["get_http_response", "getHttpResponse"],
    ["a_b_c", "aBC"],
  ];

  it.each(snakeCaseCases)("snake_case '%s' → camelCase '%s'", (input, expected) => {
    expect(normalizeIdentifier(input)).toBe(expected);
  });

  // Rule 4: single-word (no underscore) — unchanged
  const singleWordCases: [string, string][] = [
    ["total", "total"],
    ["x", "x"],
    ["value", "value"],
    ["calcTotal", "calcTotal"], // already camelCase
    ["myFunc", "myFunc"],
  ];

  it.each(singleWordCases)("single-word '%s' → unchanged '%s'", (input, expected) => {
    expect(normalizeIdentifier(input)).toBe(expected);
  });

  // Rule 1: dunder — __foo__ preserved
  const dunterCases: [string, string][] = [
    ["__dunder__", "__dunder__"],
    ["__init__", "__init__"],
    ["__class__", "__class__"],
    ["__my_attr__", "__my_attr__"],
  ];

  it.each(dunterCases)("dunder '%s' → preserved '%s'", (input, expected) => {
    expect(normalizeIdentifier(input)).toBe(expected);
  });

  // Rule 2: leading underscore — prefix kept, remainder normalized
  const leadingUnderscoreCases: [string, string][] = [
    ["_private", "_private"],
    ["_calc_total", "_calcTotal"],
    ["_my_value", "_myValue"],
    ["_x", "_x"],
  ];

  it.each(leadingUnderscoreCases)("leading underscore '%s' → '%s'", (input, expected) => {
    expect(normalizeIdentifier(input)).toBe(expected);
  });

  // Rule 3: ALL_CAPS constant — preserved
  const allCapsCases: [string, string][] = [
    ["MAX_SIZE", "MAX_SIZE"],
    ["HTTP_TIMEOUT", "HTTP_TIMEOUT"],
    ["MAX_RETRY_COUNT", "MAX_RETRY_COUNT"],
    ["A_B", "A_B"],
  ];

  it.each(allCapsCases)("ALL_CAPS '%s' → preserved '%s'", (input, expected) => {
    expect(normalizeIdentifier(input)).toBe(expected);
  });

  // Numeric suffix
  const numericSuffixCases: [string, string][] = [
    ["value_1", "value1"],
    ["item_2", "item2"],
    ["calc_total_3", "calcTotal3"],
  ];

  it.each(numericSuffixCases)("numeric suffix '%s' → '%s'", (input, expected) => {
    expect(normalizeIdentifier(input)).toBe(expected);
  });

  // Empty / edge inputs
  it("returns empty string unchanged", () => {
    expect(normalizeIdentifier("")).toBe("");
  });

  it("single underscore returns unchanged", () => {
    expect(normalizeIdentifier("_")).toBe("_");
  });
});

// ---------------------------------------------------------------------------
// Required dispatch-contract cases (verbatim from spec)
// ---------------------------------------------------------------------------

describe("normalizeIdentifier — dispatch contract cases", () => {
  it("_private → _private", () => {
    expect(normalizeIdentifier("_private")).toBe("_private");
  });

  it("__dunder__ → __dunder__", () => {
    expect(normalizeIdentifier("__dunder__")).toBe("__dunder__");
  });

  it("MAX_SIZE → MAX_SIZE", () => {
    expect(normalizeIdentifier("MAX_SIZE")).toBe("MAX_SIZE");
  });

  it("total → total (single-word, unchanged)", () => {
    expect(normalizeIdentifier("total")).toBe("total");
  });

  it("x → x (single-char, unchanged)", () => {
    expect(normalizeIdentifier("x")).toBe("x");
  });

  it("calc_total_sum → calcTotalSum", () => {
    expect(normalizeIdentifier("calc_total_sum")).toBe("calcTotalSum");
  });

  it("value_1 → value1 (numeric suffix)", () => {
    expect(normalizeIdentifier("value_1")).toBe("value1");
  });

  it("calc_total → calcTotal", () => {
    expect(normalizeIdentifier("calc_total")).toBe("calcTotal");
  });
});

// ---------------------------------------------------------------------------
// normalizeSignatureNames
// ---------------------------------------------------------------------------

describe("normalizeSignatureNames", () => {
  function makeSig(overrides: Partial<FunctionSignature> = {}): FunctionSignature {
    return {
      name: "fn",
      params: [],
      returnType: "void",
      pythonReturnAnnotation: "None",
      bodyPythonSource: "",
      ...overrides,
    };
  }

  it("normalizes function name from snake_case", () => {
    const sig = makeSig({ name: "calc_total" });
    const result = normalizeSignatureNames(sig);
    expect(result.name).toBe("calcTotal");
  });

  it("normalizes parameter names from snake_case", () => {
    const sig = makeSig({
      name: "compute",
      params: [
        { name: "my_value", tsType: "number", pythonAnnotation: "int" },
        { name: "base_rate", tsType: "number", pythonAnnotation: "float" },
      ],
    });
    const result = normalizeSignatureNames(sig);
    expect(result.params[0]?.name).toBe("myValue");
    expect(result.params[1]?.name).toBe("baseRate");
  });

  it("preserves tsType unchanged (not a name)", () => {
    const sig = makeSig({
      params: [{ name: "my_val", tsType: "number | null", pythonAnnotation: "Optional[int]" }],
    });
    const result = normalizeSignatureNames(sig);
    expect(result.params[0]?.tsType).toBe("number | null");
  });

  it("preserves pythonAnnotation unchanged", () => {
    const sig = makeSig({
      params: [{ name: "p", tsType: "string", pythonAnnotation: "str" }],
    });
    const result = normalizeSignatureNames(sig);
    expect(result.params[0]?.pythonAnnotation).toBe("str");
  });

  it("preserves returnType unchanged", () => {
    const sig = makeSig({ returnType: "Record<string, number>" });
    const result = normalizeSignatureNames(sig);
    expect(result.returnType).toBe("Record<string, number>");
  });

  it("preserves dunder function name", () => {
    const sig = makeSig({ name: "__init__" });
    const result = normalizeSignatureNames(sig);
    expect(result.name).toBe("__init__");
  });

  it("preserves ALL_CAPS function name (constant)", () => {
    const sig = makeSig({ name: "MAX_VALUE" });
    // ALL_CAPS single segment is not treated as constant (no underscore → single word rule)
    // MAX_VALUE has underscore → check ALL_CAPS rule
    const result = normalizeSignatureNames(sig);
    expect(result.name).toBe("MAX_VALUE");
  });

  it("does not mutate the original signature", () => {
    const originalParams: RaisedParam[] = [
      { name: "my_value", tsType: "number", pythonAnnotation: "int" },
    ];
    const sig = makeSig({ name: "calc_total", params: originalParams });
    normalizeSignatureNames(sig);
    // Original must be unchanged
    expect(sig.name).toBe("calc_total");
    expect(sig.params[0]?.name).toBe("my_value");
  });
});

// ---------------------------------------------------------------------------
// buildParamRenameMap
// ---------------------------------------------------------------------------

describe("buildParamRenameMap", () => {
  it("maps snake_case params to camelCase", () => {
    const params: RaisedParam[] = [
      { name: "my_value", tsType: "number", pythonAnnotation: "int" },
      { name: "base_rate", tsType: "number", pythonAnnotation: "float" },
    ];
    const map = buildParamRenameMap(params);
    expect(map.get("my_value")).toBe("myValue");
    expect(map.get("base_rate")).toBe("baseRate");
  });

  it("omits params that normalize to the same name", () => {
    const params: RaisedParam[] = [
      { name: "x", tsType: "number", pythonAnnotation: "int" },
      { name: "total", tsType: "number", pythonAnnotation: "int" },
    ];
    const map = buildParamRenameMap(params);
    expect(map.has("x")).toBe(false);
    expect(map.has("total")).toBe(false);
    expect(map.size).toBe(0);
  });

  it("returns empty map for empty params", () => {
    expect(buildParamRenameMap([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// normalizeExprNames
// ---------------------------------------------------------------------------

describe("normalizeExprNames", () => {
  it("renames Name nodes present in rename map", () => {
    const map = new Map([["my_value", "myValue"]]);
    const expr = { type: "Name" as const, name: "my_value" };
    const result = normalizeExprNames(expr, map);
    expect(result).toEqual({ type: "Name", name: "myValue" });
  });

  it("leaves Name nodes absent from rename map unchanged", () => {
    const map = new Map([["my_value", "myValue"]]);
    const expr = { type: "Name" as const, name: "other" };
    const result = normalizeExprNames(expr, map);
    expect(result).toEqual({ type: "Name", name: "other" });
  });

  it("recurses into BinaryOp left and right", () => {
    const map = new Map([["my_val", "myVal"]]);
    const expr = {
      type: "BinaryOp" as const,
      op: "+",
      left: { type: "Name" as const, name: "my_val" },
      right: { type: "Integer" as const, value: "1" },
    };
    const result = normalizeExprNames(expr, map);
    expect(result.type).toBe("BinaryOp");
    if (result.type === "BinaryOp") {
      expect(result.left).toEqual({ type: "Name", name: "myVal" });
      expect(result.right).toEqual({ type: "Integer", value: "1" });
    }
  });

  it("leaves string literals unchanged", () => {
    const map = new Map([["hello", "hello2"]]);
    const expr = { type: "String" as const, value: "hello" };
    // String value is data, not an identifier — must NOT be renamed
    const result = normalizeExprNames(expr, map);
    expect(result).toEqual({ type: "String", value: "hello" });
  });

  it("leaves Integer literals unchanged", () => {
    const map = new Map([["42", "renamed"]]);
    const expr = { type: "Integer" as const, value: "42" };
    const result = normalizeExprNames(expr, map);
    expect(result).toEqual({ type: "Integer", value: "42" });
  });
});

// ---------------------------------------------------------------------------
// normalizeBodyNames
// ---------------------------------------------------------------------------

describe("normalizeBodyNames", () => {
  it("renames Name in Return value", () => {
    const map = new Map([["my_value", "myValue"]]);
    const body: WireStmt[] = [{ type: "Return", value: { type: "Name", name: "my_value" } }];
    const result = normalizeBodyNames(body, map);
    expect(result[0]).toEqual({
      type: "Return",
      value: { type: "Name", name: "myValue" },
    });
  });

  it("handles bare Return (null value) without error", () => {
    const map = new Map<string, string>();
    const body: WireStmt[] = [{ type: "Return", value: null }];
    const result = normalizeBodyNames(body, map);
    expect(result[0]).toEqual({ type: "Return", value: null });
  });

  it("passes Pass statements through unchanged", () => {
    const map = new Map([["x", "y"]]);
    const body: WireStmt[] = [{ type: "Pass" }];
    const result = normalizeBodyNames(body, map);
    expect(result[0]).toEqual({ type: "Pass" });
  });

  it("handles empty body", () => {
    expect(normalizeBodyNames([], new Map())).toEqual([]);
  });

  it("renames Name in BinaryOp inside Return", () => {
    const map = new Map([
      ["my_val", "myVal"],
      ["base", "base"],
    ]);
    const body: WireStmt[] = [
      {
        type: "Return",
        value: {
          type: "BinaryOp",
          op: "+",
          left: { type: "Name", name: "my_val" },
          right: { type: "Name", name: "base" },
        },
      },
    ];
    const result = normalizeBodyNames(body, map);
    const ret = result[0];
    expect(ret?.type).toBe("Return");
    if (ret?.type === "Return" && ret.value?.type === "BinaryOp") {
      expect(ret.value.left).toEqual({ type: "Name", name: "myVal" });
      expect(ret.value.right).toEqual({ type: "Name", name: "base" });
    }
  });

  it("does not mutate original body array", () => {
    const map = new Map([["x", "xRenamed"]]);
    const body: WireStmt[] = [{ type: "Return", value: { type: "Name", name: "x" } }];
    const original = body[0];
    normalizeBodyNames(body, map);
    // Original WireStmt should not be mutated
    expect(original).toEqual({ type: "Return", value: { type: "Name", name: "x" } });
  });

  // ---------------------------------------------------------------------------
  // #958 regression: param rename must reach all statement / expression types
  // ---------------------------------------------------------------------------

  it("#958 param-in-if-test: renames Name in If.test (#958 substitute_xml pattern)", () => {
    // def f(make_quoted_attribute: bool): if make_quoted_attribute: return True
    // Bug: normalizeStmtNames didn't handle If — test remained snake_case.
    const map = new Map([["make_quoted_attribute", "makeQuotedAttribute"]]);
    const body: WireStmt[] = [
      {
        type: "If",
        test: { type: "Name", name: "make_quoted_attribute" },
        body: [{ type: "Return", value: { type: "Bool", value: true } }],
        orelse: [],
      },
    ];
    const result = normalizeBodyNames(body, map);
    const ifStmt = result[0];
    expect(ifStmt?.type).toBe("If");
    if (ifStmt?.type === "If") {
      expect(ifStmt.test).toEqual({ type: "Name", name: "makeQuotedAttribute" });
    }
  });

  it("#958 param-in-if-body: renames Name in nested If body statements", () => {
    // def f(n: int): if n > 0: return n
    const map = new Map([["n", "nRenamed"]]);
    const body: WireStmt[] = [
      {
        type: "If",
        test: {
          type: "BinaryOp",
          op: ">",
          left: { type: "Name", name: "n" },
          right: { type: "Integer", value: "0" },
        },
        body: [{ type: "Return", value: { type: "Name", name: "n" } }],
        orelse: [{ type: "Return", value: { type: "Integer", value: "0" } }],
      },
    ];
    const result = normalizeBodyNames(body, map);
    const ifStmt = result[0];
    expect(ifStmt?.type).toBe("If");
    if (ifStmt?.type === "If") {
      // test expr
      const test = ifStmt.test;
      expect(test.type).toBe("BinaryOp");
      if (test.type === "BinaryOp") {
        expect(test.left).toEqual({ type: "Name", name: "nRenamed" });
      }
      // return in body
      const bodyRet = ifStmt.body[0];
      expect(bodyRet?.type).toBe("Return");
      if (bodyRet?.type === "Return") {
        expect(bodyRet.value).toEqual({ type: "Name", name: "nRenamed" });
      }
    }
  });

  it("#958 param-in-assign: renames Name in Assign.value", () => {
    // def f(x: int): y = x + 1
    const map = new Map([["x", "xRenamed"]]);
    const body: WireStmt[] = [
      {
        type: "Assign",
        target: "y",
        value: {
          type: "BinaryOp",
          op: "+",
          left: { type: "Name", name: "x" },
          right: { type: "Integer", value: "1" },
        },
      },
    ];
    const result = normalizeBodyNames(body, map);
    const assign = result[0];
    expect(assign?.type).toBe("Assign");
    if (assign?.type === "Assign") {
      expect(assign.target).toBe("y"); // target (local var) not renamed
      const val = assign.value;
      expect(val.type).toBe("BinaryOp");
      if (val.type === "BinaryOp") {
        expect(val.left).toEqual({ type: "Name", name: "xRenamed" });
      }
    }
  });

  it("#958 param-in-subscript: renames Name in Subscript value and slice", () => {
    // def f(d: dict, k: str): return d[k]
    const map = new Map([
      ["d", "dRenamed"],
      ["k", "kRenamed"],
    ]);
    const body: WireStmt[] = [
      {
        type: "Return",
        value: {
          type: "Subscript",
          value: { type: "Name", name: "d" },
          slice: { type: "Name", name: "k" },
        },
      },
    ];
    const result = normalizeBodyNames(body, map);
    const ret = result[0];
    expect(ret?.type).toBe("Return");
    if (ret?.type === "Return") {
      const sub = ret.value;
      expect(sub?.type).toBe("Subscript");
      if (sub?.type === "Subscript") {
        expect(sub.value).toEqual({ type: "Name", name: "dRenamed" });
        expect(sub.slice).toEqual({ type: "Name", name: "kRenamed" });
      }
    }
  });

  it("#958 param-in-comparison: renames Name in BinaryOp comparison (x == y)", () => {
    // def f(x: int, y: int) -> bool: return x == y
    const map = new Map([
      ["x", "xRenamed"],
      ["y", "yRenamed"],
    ]);
    const body: WireStmt[] = [
      {
        type: "Return",
        value: {
          type: "BinaryOp",
          op: "==",
          left: { type: "Name", name: "x" },
          right: { type: "Name", name: "y" },
        },
      },
    ];
    const result = normalizeBodyNames(body, map);
    const ret = result[0];
    expect(ret?.type).toBe("Return");
    if (ret?.type === "Return") {
      const binop = ret.value;
      expect(binop?.type).toBe("BinaryOp");
      if (binop?.type === "BinaryOp") {
        expect(binop.left).toEqual({ type: "Name", name: "xRenamed" });
        expect(binop.right).toEqual({ type: "Name", name: "yRenamed" });
      }
    }
  });

  it("#958 param-in-boolop: renames Name in BoolOp operands", () => {
    // def f(a: bool, b: bool): return a and b
    const map = new Map([
      ["a", "aRenamed"],
      ["b", "bRenamed"],
    ]);
    const body: WireStmt[] = [
      {
        type: "Return",
        value: {
          type: "BoolOp",
          op: "and",
          left: { type: "Name", name: "a" },
          right: { type: "Name", name: "b" },
        },
      },
    ];
    const result = normalizeBodyNames(body, map);
    const ret = result[0];
    expect(ret?.type).toBe("Return");
    if (ret?.type === "Return") {
      const boolop = ret.value;
      expect(boolop?.type).toBe("BoolOp");
      if (boolop?.type === "BoolOp") {
        expect(boolop.left).toEqual({ type: "Name", name: "aRenamed" });
        expect(boolop.right).toEqual({ type: "Name", name: "bRenamed" });
      }
    }
  });

  it("#958 param-in-unaryop: renames Name in UnaryOp operand", () => {
    // def f(x: int): return -x
    const map = new Map([["x", "xRenamed"]]);
    const body: WireStmt[] = [
      {
        type: "Return",
        value: { type: "UnaryOp", op: "-", operand: { type: "Name", name: "x" } },
      },
    ];
    const result = normalizeBodyNames(body, map);
    const ret = result[0];
    expect(ret?.type).toBe("Return");
    if (ret?.type === "Return") {
      const unary = ret.value;
      expect(unary?.type).toBe("UnaryOp");
      if (unary?.type === "UnaryOp") {
        expect(unary.operand).toEqual({ type: "Name", name: "xRenamed" });
      }
    }
  });

  it("#958 param-in-raise: renames Name in Raise message", () => {
    // def f(msg: str): raise ValueError(msg)
    const map = new Map([["msg", "msgRenamed"]]);
    const body: WireStmt[] = [
      {
        type: "Raise",
        excClass: "ValueError",
        message: { type: "Name", name: "msg" },
      },
    ];
    const result = normalizeBodyNames(body, map);
    const raise = result[0];
    expect(raise?.type).toBe("Raise");
    if (raise?.type === "Raise") {
      expect(raise.message).toEqual({ type: "Name", name: "msgRenamed" });
    }
  });
});
