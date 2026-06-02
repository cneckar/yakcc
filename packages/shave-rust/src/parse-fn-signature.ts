// SPDX-License-Identifier: Apache-2.0
//
// parse-fn-signature.ts -- extract structured FunctionSignature objects from
// the syn JSON envelope (WI-868 slice 1).
//
// The syn envelope ships per-function detail (name, isPub, params with type
// strings, return type string, body source text).  This module narrows the
// untyped envelope into a typed `FunctionSignature[]` and applies
// type-map.ts and name-normalize.ts so callers get TS-ready signatures.
//
// Out of scope for slice 1: body translation (slice 2), purity inference
// (slice 2).  Lifetimes in type strings are stripped by type-map.ts before
// mapping.
//
// @decision DEC-POLYGLOT-RUST-SIGNATURE-001 (WI-868 slice 1)
// @title parse-fn-signature extracts typed signatures from the syn envelope
// @status accepted (WI-868 slice 1)
// @rationale
//   Mirrors shave-go's parse-fn-signature.ts exactly: a thin typed adapter
//   between the raw wire envelope (RustAstParseResult) and the raise-function
//   composition layer.  Type mapping (mapRustType) and name normalization
//   (normalizeRustName) are the two Rust-specific transformations applied here.
//   Keeping them separate from the subprocess seam allows independent testing
//   of each concern.

import type { RustAstParseResult } from "./rust-ast-parser.js";
import { InvalidIdentifierError, normalizeRustName } from "./name-normalize.js";
import { UnsupportedTypeError, mapRustType } from "./type-map.js";

export interface RaisedParam {
  /** Parameter name normalized to camelCase. */
  readonly name: string;
  /** TS-subset IR type after applying the Rust -> TS mapping. */
  readonly tsType: string;
  /** The raw Rust type string (for diagnostics). */
  readonly rustType: string;
}

export interface FunctionSignature {
  /** Function name normalized to camelCase. */
  readonly name: string;
  /** Original Rust function name (before normalization). */
  readonly rustName: string;
  /** Whether the function was declared `pub` in Rust. */
  readonly isPub: boolean;
  /** Typed parameters in declaration order. */
  readonly params: readonly RaisedParam[];
  /**
   * TS return type string.  `"void"` for functions with no explicit return
   * (Rust `()` return).  Single concrete type for normal returns.
   */
  readonly returnType: string;
  /** Raw Rust return type string (for diagnostics).  Empty string means `()`. */
  readonly rustReturnType: string;
  /** Verbatim Rust body text (for slice 2 body raiser).  May be null. */
  readonly bodySource: string | null;
}

/**
 * Thrown when a function in the envelope cannot be raised — unsupported type,
 * invalid identifier, etc.  Slice 4 will rewrap as `CannotRaiseToIRError`
 * from `@yakcc/contracts`.
 */
export class SignatureRaiseError extends Error {
  constructor(
    public readonly functionName: string,
    public readonly cause_: Error,
    message?: string,
  ) {
    super(message ?? `Function '${functionName}': ${cause_.message}`);
    this.name = "SignatureRaiseError";
  }
}

/**
 * Walk the syn envelope and return a typed `FunctionSignature[]` — one entry
 * per top-level function declaration.  Each function's type annotations are
 * validated and mapped to TS-subset IR types via `mapRustType`.
 *
 * Names are normalized via `normalizeRustName` (snake_case -> camelCase).
 *
 * Throws `SignatureRaiseError` on the first unraiseable function encountered.
 * Callers that want all errors should walk the envelope themselves.
 */
export function extractFunctionSignatures(envelope: RustAstParseResult): FunctionSignature[] {
  return envelope.functions.map((fn) => {
    const rustName = fn.name;
    let normalizedName: string;
    try {
      normalizedName = normalizeRustName(rustName);
    } catch (err) {
      if (err instanceof InvalidIdentifierError) {
        throw new SignatureRaiseError(rustName, err);
      }
      throw err;
    }

    const params: RaisedParam[] = fn.params.map((p) => {
      try {
        const tsType = mapRustType(p.rustType);
        let paramName: string;
        try {
          paramName = normalizeRustName(p.name);
        } catch (nameErr) {
          // Param names that fail normalization fall back to the raw name
          // with a best-effort sanitization (replace _ -> keep as-is for
          // simple cases; the validator handles truly broken names).
          paramName = p.name;
        }
        return {
          name: paramName,
          rustType: p.rustType,
          tsType,
        };
      } catch (err) {
        if (err instanceof UnsupportedTypeError) {
          throw new SignatureRaiseError(
            rustName,
            err,
            `Function '${rustName}' parameter '${p.name}': ${err.message}`,
          );
        }
        throw err;
      }
    });

    // Return type: empty string in the envelope means no explicit return (unit ()).
    const rustReturnType = fn.returnType;
    let returnType: string;
    if (rustReturnType === "" || rustReturnType === "()") {
      returnType = "void";
    } else {
      try {
        returnType = mapRustType(rustReturnType);
      } catch (err) {
        if (err instanceof UnsupportedTypeError) {
          throw new SignatureRaiseError(
            rustName,
            err,
            `Function '${rustName}' return type: ${err.message}`,
          );
        }
        throw err;
      }
    }

    return {
      name: normalizedName,
      rustName,
      isPub: fn.isPub,
      params,
      returnType,
      rustReturnType,
      bodySource: fn.bodySource,
    };
  });
}
