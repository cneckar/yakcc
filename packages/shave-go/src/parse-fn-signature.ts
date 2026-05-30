// SPDX-License-Identifier: MIT
//
// parse-fn-signature.ts -- extract structured FunctionSignature objects from
// the go/ast JSON envelope (WI-870 slice 1).
//
// The go/ast envelope ships per-function detail (name, params with type
// strings, return types, generics type params, body source text).  This module
// narrows the untyped envelope into a typed `FunctionSignature[]` and applies
// the type-map.ts mapping so callers get TS-ready signatures.
//
// Out of scope for slice 1: body translation (slice 2), purity inference
// (slice 2), Go -> camelCase normalization (slice 3, but Go names are already
// camelCase-compatible so this is mostly a no-op).

import type { GoAstParseResult } from "./go-ast-parser.js";
import { InvalidIdentifierError, normalizeGoName } from "./name-normalize.js";
import { UnsupportedTypeError, mapGoType } from "./type-map.js";

export interface RaisedParam {
  /** Parameter name as written in Go (normalized via name-normalize). */
  readonly name: string;
  /** TS-subset IR type after applying the Go -> TS mapping. */
  readonly tsType: string;
  /** The raw Go type string (for diagnostics). */
  readonly goType: string;
}

export interface RaisedTypeParam {
  /** Generic type parameter name (e.g. "T"). */
  readonly name: string;
  /** Constraint as a Go type string (e.g. "comparable", "any"). */
  readonly constraint: string;
}

export interface FunctionSignature {
  /** Function name after normalization. */
  readonly name: string;
  /** Generic type parameters (Go 1.18+); empty for non-generic functions. */
  readonly typeParams: readonly RaisedTypeParam[];
  /** Typed parameters in declaration order. */
  readonly params: readonly RaisedParam[];
  /**
   * TS return types.  Go allows multiple return values; they are represented
   * here as an array.  Single-return functions have a one-element array.
   * Void functions (no return) have an empty array.
   */
  readonly returnTypes: readonly string[];
  /**
   * Raw Go return type strings (for diagnostics), parallel to returnTypes.
   */
  readonly goReturnTypes: readonly string[];
  /** Verbatim Go body text (for slice 2 body raiser). May be null. */
  readonly bodySource: string | null;
  /** Receiver type string for methods, or null for top-level functions. */
  readonly receiver: string | null;
}

/**
 * Thrown when a function in the envelope cannot be raised -- unsupported type,
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
 * Walk the go/ast envelope and return a typed `FunctionSignature[]` -- one
 * entry per top-level function declaration.  Each function's type annotations
 * are validated and mapped to TS-subset IR types via `mapGoType`.
 *
 * Throws `SignatureRaiseError` on the first unraiseable function encountered.
 * Callers that want all errors should walk the envelope themselves.
 */
export function extractFunctionSignatures(envelope: GoAstParseResult): FunctionSignature[] {
  return envelope.functions.map((fn) => {
    const name = fn.name;
    try {
      normalizeGoName(name);
    } catch (err) {
      if (err instanceof InvalidIdentifierError) {
        throw new SignatureRaiseError(name, err);
      }
      throw err;
    }

    const typeParams: RaisedTypeParam[] = fn.typeParams.map((tp) => ({
      name: tp.name,
      constraint: tp.constraint,
    }));

    // Build the set of generic type parameter names in scope for this function
    // (WI-963).  mapGoType uses this set to emit type-param identifiers verbatim
    // rather than looking them up in the primitive table.
    const typeParamNames: ReadonlySet<string> =
      typeParams.length > 0 ? new Set(typeParams.map((tp) => tp.name)) : new Set();
    const typeMapOpts = typeParams.length > 0 ? { typeParams: typeParamNames } : undefined;

    const params: RaisedParam[] = fn.params.map((p) => {
      try {
        const tsType = typeMapOpts ? mapGoType(p.goType, typeMapOpts).tsType : mapGoType(p.goType);
        return {
          name: p.name,
          goType: p.goType,
          tsType,
        };
      } catch (err) {
        if (err instanceof UnsupportedTypeError) {
          throw new SignatureRaiseError(
            name,
            err,
            `Function '${name}' parameter '${p.name}': ${err.message}`,
          );
        }
        throw err;
      }
    });

    const returnTypes: string[] = [];
    const goReturnTypes: string[] = [];
    for (const r of fn.results) {
      try {
        const tsType = typeMapOpts ? mapGoType(r.goType, typeMapOpts).tsType : mapGoType(r.goType);
        returnTypes.push(tsType);
        goReturnTypes.push(r.goType);
      } catch (err) {
        if (err instanceof UnsupportedTypeError) {
          throw new SignatureRaiseError(
            name,
            err,
            `Function '${name}' return type: ${err.message}`,
          );
        }
        throw err;
      }
    }

    return {
      name,
      typeParams,
      params,
      returnTypes,
      goReturnTypes,
      bodySource: fn.bodySource,
      receiver: fn.receiver,
    };
  });
}
