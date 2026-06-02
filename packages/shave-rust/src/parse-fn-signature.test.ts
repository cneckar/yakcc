// SPDX-License-Identifier: Apache-2.0
//
// parse-fn-signature.test.ts -- unit tests for extractFunctionSignatures (WI-868 slice 1).

import { describe, expect, it } from "vitest";
import { SignatureRaiseError, extractFunctionSignatures } from "./parse-fn-signature.js";
import type { RustAstParseResult } from "./rust-ast-parser.js";

function envelope(fns: RustAstParseResult["functions"]): RustAstParseResult {
  return { version: 1, crateName: "stdin.rs", functions: fns };
}

describe("extractFunctionSignatures", () => {
  it("raises a simple pub fn with two i32 params and i32 return", () => {
    const sigs = extractFunctionSignatures(
      envelope([
        {
          name: "add",
          isPub: true,
          params: [
            { name: "a", rustType: "i32" },
            { name: "b", rustType: "i32" },
          ],
          returnType: "i32",
          bodySource: "a + b",
        },
      ]),
    );
    expect(sigs).toHaveLength(1);
    const sig = sigs[0];
    if (!sig) throw new Error("expected sigs[0] to be defined");
    expect(sig.name).toBe("add");
    expect(sig.rustName).toBe("add");
    expect(sig.isPub).toBe(true);
    expect(sig.params).toHaveLength(2);
    expect(sig.params[0]).toMatchObject({ name: "a", tsType: "number", rustType: "i32" });
    expect(sig.params[1]).toMatchObject({ name: "b", tsType: "number", rustType: "i32" });
    expect(sig.returnType).toBe("number");
    expect(sig.bodySource).toBe("a + b");
  });

  it("normalizes snake_case function and param names to camelCase", () => {
    const sigs = extractFunctionSignatures(
      envelope([
        {
          name: "get_user_id",
          isPub: true,
          params: [{ name: "user_name", rustType: "String" }],
          returnType: "i32",
          bodySource: "0",
        },
      ]),
    );
    expect(sigs[0]?.name).toBe("getUserId");
    expect(sigs[0]?.rustName).toBe("get_user_id");
    expect(sigs[0]?.params[0]?.name).toBe("userName");
  });

  it("maps void return (empty returnType string) to 'void'", () => {
    const sigs = extractFunctionSignatures(
      envelope([
        {
          name: "noop",
          isPub: true,
          params: [],
          returnType: "",
          bodySource: "",
        },
      ]),
    );
    expect(sigs[0]?.returnType).toBe("void");
    expect(sigs[0]?.rustReturnType).toBe("");
  });

  it("maps () return type to 'void'", () => {
    const sigs = extractFunctionSignatures(
      envelope([
        {
          name: "noop",
          isPub: true,
          params: [],
          returnType: "()",
          bodySource: "",
        },
      ]),
    );
    expect(sigs[0]?.returnType).toBe("void");
  });

  it("raises non-pub private function with isPub=false", () => {
    const sigs = extractFunctionSignatures(
      envelope([
        {
          name: "internal_add",
          isPub: false,
          params: [
            { name: "a", rustType: "i32" },
            { name: "b", rustType: "i32" },
          ],
          returnType: "i32",
          bodySource: "a + b",
        },
      ]),
    );
    expect(sigs[0]?.isPub).toBe(false);
    expect(sigs[0]?.name).toBe("internalAdd");
  });

  it("maps Vec<i32> parameter to number[]", () => {
    const sigs = extractFunctionSignatures(
      envelope([
        {
          name: "sum_vec",
          isPub: true,
          params: [{ name: "xs", rustType: "Vec<i32>" }],
          returnType: "i32",
          bodySource: "0",
        },
      ]),
    );
    expect(sigs[0]?.params[0]?.tsType).toBe("number[]");
  });

  it("maps Option<String> return to 'string | null'", () => {
    const sigs = extractFunctionSignatures(
      envelope([
        {
          name: "get_first",
          isPub: true,
          params: [{ name: "xs", rustType: "Vec<String>" }],
          returnType: "Option<String>",
          bodySource: "None",
        },
      ]),
    );
    expect(sigs[0]?.returnType).toBe("string | null");
  });

  it("handles empty functions list", () => {
    const sigs = extractFunctionSignatures(envelope([]));
    expect(sigs).toHaveLength(0);
  });

  it("throws SignatureRaiseError for unsupported param type", () => {
    expect(() =>
      extractFunctionSignatures(
        envelope([
          {
            name: "bad_fn",
            isPub: true,
            params: [{ name: "x", rustType: "HashMap<String, i32>" }],
            returnType: "i32",
            bodySource: "0",
          },
        ]),
      ),
    ).toThrow(SignatureRaiseError);
  });

  it("throws SignatureRaiseError for unsupported return type", () => {
    expect(() =>
      extractFunctionSignatures(
        envelope([
          {
            name: "bad_return",
            isPub: true,
            params: [],
            returnType: "HashMap<String, i32>",
            bodySource: "todo!()",
          },
        ]),
      ),
    ).toThrow(SignatureRaiseError);
  });
});
