// SPDX-License-Identifier: MIT
//
// parse-fn-signature.ts — extract structured FunctionSignature objects from
// the libcst JSON envelope (WI-782 slice 2).
//
// The libcst envelope ships per-function detail (name, params with
// annotations, return annotation, body source).  This module narrows the
// untyped envelope into a typed `FunctionSignature[]` and applies the
// type-map.ts mapping so callers get a TS-ready signature.
//
// Out of scope for slice 2: body translation (slice 2b), purity inference
// (slice 3), snake_case → camelCase normalization (slice 3).

import type { LibcstParseResult } from "./libcst-parser.js";
import { UnsupportedTypeError, mapPythonType } from "./type-map.js";

export interface RaisedParam {
  /** Parameter name as written in Python (no normalization yet — slice 3). */
  readonly name: string;
  /** TS-subset IR type after applying the Python → TS mapping. */
  readonly tsType: string;
  /** The raw Python annotation text (for diagnostics). */
  readonly pythonAnnotation: string;
}

export interface FunctionSignature {
  /** Function name as written in Python (no normalization yet — slice 3). */
  readonly name: string;
  /** Typed parameters in declaration order. */
  readonly params: readonly RaisedParam[];
  /** TS return type after mapping. `"void"` when no annotation is present. */
  readonly returnType: string;
  /** Raw Python return annotation text, or null if absent. */
  readonly pythonReturnAnnotation: string | null;
  /** Verbatim Python body text (for slice 2b's body raise). */
  readonly bodyPythonSource: string;
}

/**
 * Thrown when a function in the envelope cannot be raised — missing required
 * annotation, unsupported type, etc.  Slice 4 will rewrap these as
 * `CannotRaiseToIRError` from `@yakcc/contracts`.
 */
export class MissingTypeAnnotationError extends Error {
  constructor(
    public readonly functionName: string,
    public readonly paramName: string | null,
    message?: string,
  ) {
    super(
      message ??
        (paramName !== null
          ? `Function '${functionName}' parameter '${paramName}' lacks a type annotation. MVP requires all parameters to be annotated.`
          : `Function '${functionName}' lacks a return type annotation. MVP requires return types.`),
    );
    this.name = "MissingTypeAnnotationError";
  }
}

interface EnvelopeParam {
  name: string;
  annotation: string | null;
}

interface EnvelopeFunction {
  name: string;
  params: EnvelopeParam[];
  return_annotation: string | null;
  body_source: string;
}

/**
 * Walk the libcst envelope and return a typed `FunctionSignature[]` — one
 * entry per top-level `def`.  Each function's annotations are validated and
 * mapped to TS-subset IR types via `mapPythonType`.
 *
 * Throws on the first error encountered (missing annotation or unsupported
 * type).  Callers that want all errors should walk the envelope themselves.
 */
export function extractFunctionSignatures(envelope: LibcstParseResult): FunctionSignature[] {
  const moduleRecord = envelope.module as unknown as { functions?: EnvelopeFunction[] };
  const fns = moduleRecord.functions ?? [];
  return fns.map((fn) => extractOne(fn));
}

function extractOne(fn: EnvelopeFunction): FunctionSignature {
  const params: RaisedParam[] = fn.params.map((p) => {
    if (p.annotation === null) {
      throw new MissingTypeAnnotationError(fn.name, p.name);
    }
    try {
      return {
        name: p.name,
        pythonAnnotation: p.annotation,
        tsType: mapPythonType(p.annotation),
      };
    } catch (err) {
      if (err instanceof UnsupportedTypeError) {
        // Re-throw with function/param context for actionable diagnostics.
        throw new UnsupportedTypeError(
          err.pythonType,
          `Function '${fn.name}' parameter '${p.name}': ${err.message}`,
        );
      }
      throw err;
    }
  });

  let returnType: string;
  if (fn.return_annotation === null) {
    throw new MissingTypeAnnotationError(fn.name, null);
  }
  try {
    returnType = mapPythonType(fn.return_annotation);
  } catch (err) {
    if (err instanceof UnsupportedTypeError) {
      throw new UnsupportedTypeError(
        err.pythonType,
        `Function '${fn.name}' return type: ${err.message}`,
      );
    }
    throw err;
  }

  return {
    name: fn.name,
    params,
    returnType,
    pythonReturnAnnotation: fn.return_annotation,
    bodyPythonSource: fn.body_source,
  };
}
