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
//
// WI-889: threads LowerWarning from mapPythonType onto RaisedParam.warnings
// and FunctionSignature.returnWarnings.
//
// @decision DEC-WI889-009
// @title RaisedParam.warnings + FunctionSignature.returnWarnings (per-param + per-return)
// @status accepted
// @rationale
//   Locality — each warning ties to the annotation that produced it.
//   Consumers can union warnings when needed.  Additive fields: downstream
//   consumers (raise-function.ts, purity-check.ts) continue to typecheck
//   against the new fields without behavioral change.

import type { LibcstParseResult } from "./libcst-parser.js";
import { ImpureFunctionError } from "./purity-check.js";
import type { WireStmt } from "./raise-body.js";
import { type LowerWarning, UnsupportedTypeError, mapPythonType } from "./type-map.js";

export interface RaisedParam {
  /** Parameter name as written in Python (no normalization yet — slice 3). */
  readonly name: string;
  /** TS-subset IR type after applying the Python → TS mapping. */
  readonly tsType: string;
  /** The raw Python annotation text (for diagnostics). */
  readonly pythonAnnotation: string;
  /**
   * Warnings emitted during type mapping for this parameter's annotation.
   * Empty (or absent) for lossless mappings; non-empty when the annotation
   * required widening (e.g. Any -> unknown).  WI-889 / DEC-WI889-009.
   * Optional to preserve backwards compatibility with existing construction
   * sites in normalize-names.ts and test helpers (DEC-WI889-010 additive-only).
   */
  readonly warnings?: readonly LowerWarning[];
}

/**
 * WI-890: kind of method extracted from a class body.
 * Absent on module-level functions (preserves byte-equivalence for all
 * pre-WI-890 callers).
 *
 * - "static"   — decorated with @staticmethod; treated as a pure module-level fn
 * - "class"    — decorated with @classmethod; cls param; purity check allows it
 * - "instance" — no decorator; self param; always rejected as impure
 */
export type MethodKind = "static" | "class" | "instance";

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
  /**
   * Warnings emitted during return-type mapping.
   * Empty (or absent) for lossless return types.  WI-889 / DEC-WI889-009.
   * Optional to preserve backwards compatibility with existing construction
   * sites in raise-function.test.ts and normalize-names.test.ts.
   */
  readonly returnWarnings?: readonly LowerWarning[];
  /**
   * WI-890: present only for methods extracted from a class body.
   * Absent for module-level functions (undefined).
   *
   * @decision DEC-WI890-002 — methodKind optional on FunctionSignature
   * @title methodKind absent for module-level fns, present for class methods
   * @status accepted
   * @rationale Absent (undefined) is the natural representation for "not a
   *   class method" — avoids a sentinel value and preserves backward compat
   *   with all pre-WI-890 callers that construct FunctionSignature directly.
   */
  readonly methodKind?: MethodKind;
}

/**
 * A failed per-function extraction record — returned by `extractFunctionSignaturesAll`
 * for functions that could not be fully raised.
 *
 * @decision DEC-SHAVE-PY-PARSE-SIG-899
 * @title Per-function extraction failure record
 * @status accepted (#899)
 * @rationale
 *   extractFunctionSignatures used .map() which threw on the first failure,
 *   aborting extraction of all remaining functions (#899).  The fix wraps each
 *   extractOne() call in try/catch.  Failed entries are exposed via
 *   extractFunctionSignaturesAll so callers that want the full picture (e.g.
 *   exploration scripts, batch tools) can inspect per-function errors.
 *   extractFunctionSignatures preserves its existing return type (FunctionSignature[])
 *   for backward compatibility with integration.test.ts and other callers not in scope.
 */
export interface ExtractionFailure {
  /** Python function name from the envelope. */
  readonly name: string;
  /** The error that caused extraction to fail for this function. */
  readonly error: Error;
}

/**
 * Return shape of `extractFunctionSignaturesAll` — separates successes from
 * per-function failures.
 */
export interface ExtractionResult {
  /** Successfully extracted function signatures. */
  readonly ok: readonly FunctionSignature[];
  /** Functions that failed extraction, with their errors. */
  readonly failed: readonly ExtractionFailure[];
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
  /** WI-890: present only for class-body methods. */
  methodKind?: MethodKind;
}

/**
 * Walk the libcst envelope and return a typed `FunctionSignature[]` — one
 * entry per successfully extracted top-level `def`.
 *
 * Unlike the pre-#899 implementation, this function does NOT throw on the
 * first per-function failure.  Each function is extracted independently; if
 * one fails (e.g. unsupported type annotation), it is silently skipped and
 * extraction continues for the remaining functions.
 *
 * Callers that need the full picture (successes AND per-function failures)
 * should use `extractFunctionSignaturesAll` instead.
 *
 * Return type is preserved as `FunctionSignature[]` for backward compatibility
 * with existing callers.
 */
export function extractFunctionSignatures(envelope: LibcstParseResult): FunctionSignature[] {
  return extractFunctionSignaturesAll(envelope).ok as FunctionSignature[];
}

/**
 * Walk the libcst envelope and return an `ExtractionResult` with both
 * successfully extracted signatures and per-function failures.
 *
 * Each function is extracted independently via try/catch so a single
 * failure (unsupported annotation, missing annotation, etc.) does not
 * abort extraction of the remaining functions in the module (#899).
 */
export function extractFunctionSignaturesAll(envelope: LibcstParseResult): ExtractionResult {
  const moduleRecord = envelope.module as unknown as { functions?: EnvelopeFunction[] };
  const fns = moduleRecord.functions ?? [];

  const ok: FunctionSignature[] = [];
  const failed: ExtractionFailure[] = [];

  for (const fn of fns) {
    try {
      ok.push(extractOne(fn));
    } catch (err) {
      failed.push({
        name: fn.name,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  return { ok, failed };
}

function extractOne(fn: EnvelopeFunction): FunctionSignature {
  // WI-890: short-circuit instance methods BEFORE annotation checks so that
  // "self has no type annotation" doesn't mask the real rejection reason.
  //
  // @decision DEC-WI890-003 — instance method short-circuit before annotation checks
  // @title ImpureFunctionError("instance_method") fires before MissingTypeAnnotationError
  // @status accepted
  // @rationale The plan requires rejection to fire in extract + purity, not in
  //   raise-body.  Instance methods always have an implicit self param without
  //   annotation; without this gate the error message would be
  //   "parameter 'self' lacks type annotation" which is confusing.
  if (fn.methodKind === "instance") {
    throw new ImpureFunctionError(
      fn.name,
      "instance_method",
      "instance method 'self' implies mutable state",
    );
  }

  // #939 (reverts #923 cls-drop): for @classmethod, keep the first parameter
  // named "cls" but auto-inject `tsType: "unknown"` when it lacks an annotation.
  // This restores body integrity so that `cls.X` references in the body resolve
  // via the parameter.  The body can reference `cls.CONSTANT`, `cls.METHOD(...)`,
  // etc. which are valid attribute accesses on the auto-typed `unknown` parameter.
  //
  // @decision DEC-939-001 — cls kept with auto-injected unknown annotation
  // @title First param "cls" of a classmethod is kept in FunctionSignature.params
  //   with tsType:"unknown" when no annotation is present (reverts DEC-923-001 drop).
  // @status accepted (#939)
  // @rationale Body references to cls.X were silently broken after #923 dropped cls:
  //   the TS arrow had no cls parameter, but the body emitted `cls.CONSTANT` etc.
  //   Keeping cls with `unknown` restores body integrity at the cost of a slightly
  //   less informative type.  When the original annotation is present it is mapped
  //   normally; when absent an auto-typed `typeof ClassName` / `unknown` is injected.
  //   Class name piping: the function name has shape "ClassName.method_name" when
  //   methodKind==="class"; we extract the class name to produce the more informative
  //   annotation `typeof ClassName` instead of the bare `unknown`.
  const rawParams = fn.params;

  const params: RaisedParam[] = rawParams.map((p, idx) => {
    // Special handling: for classmethods, the first param named "cls" with no annotation
    // gets auto-injected type information instead of throwing MissingTypeAnnotationError.
    if (fn.methodKind === "class" && idx === 0 && p.name === "cls" && p.annotation === null) {
      // Derive the class name from fn.name ("ClassName.method_name" → "ClassName").
      // Fall back to "unknown" if the name is not dotted.
      const dotIdx = fn.name.indexOf(".");
      const className = dotIdx > 0 ? fn.name.slice(0, dotIdx) : null;
      const tsType = className !== null ? `typeof ${className}` : "unknown";
      return {
        name: "cls",
        pythonAnnotation: "(auto-injected classmethod receiver)",
        tsType,
        // No LowerWarning emitted: adding a new warning code would require editing
        // type-map.ts (out of scope).  The auto-injection is visible to callers
        // via the synthetic pythonAnnotation text and tsType value.
        warnings: [],
      };
    }
    if (p.annotation === null) {
      throw new MissingTypeAnnotationError(fn.name, p.name);
    }
    try {
      const { tsType, warnings } = mapPythonType(p.annotation);
      return {
        name: p.name,
        pythonAnnotation: p.annotation,
        tsType,
        warnings,
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
  let returnWarnings: readonly LowerWarning[];
  if (fn.return_annotation === null) {
    throw new MissingTypeAnnotationError(fn.name, null);
  }
  try {
    const result = mapPythonType(fn.return_annotation);
    returnType = result.tsType;
    returnWarnings = result.warnings;
  } catch (err) {
    if (err instanceof UnsupportedTypeError) {
      throw new UnsupportedTypeError(
        err.pythonType,
        `Function '${fn.name}' return type: ${err.message}`,
      );
    }
    throw err;
  }

  const sig: FunctionSignature = {
    name: fn.name,
    params,
    returnType,
    pythonReturnAnnotation: fn.return_annotation,
    bodyPythonSource: fn.body_source,
    returnWarnings,
  };
  // WI-890: only set methodKind when present (absent for module-level fns)
  if (fn.methodKind !== undefined) {
    return { ...sig, methodKind: fn.methodKind };
  }
  return sig;
}

// ---------------------------------------------------------------------------
// WI-934: Class envelope types and extractor
// ---------------------------------------------------------------------------
//
// @decision DEC-WI934-001 — extractClassEnvelopes is a pure type-narrowing pass
// @title Walk module.classes[] and return typed EnvelopeClass[]; no rejection logic here
// @status accepted
// @rationale The WI-890 extractOne short-circuit for instance methods stays
//   unchanged — it fires for methods arriving via module.functions[] flat list.
//   Classes arriving via module.classes[] are a separate path; raise-class.ts
//   owns all structural validation and rejection for this path.

/**
 * Wire-shape for a single init assignment from libcst-parse.py.
 * target = attribute name (string); value = wire expression.
 */
export interface EnvelopeInitAssignment {
  readonly target: string;
  /** Wire expression from libcst-parse.py — untyped JSON shape. */
  readonly value: unknown;
}

/**
 * Wire-shape for a single init param from libcst-parse.py.
 */
export interface EnvelopeInitParam {
  readonly name: string;
  readonly annotation: string | null;
}

/**
 * Wire-shape for a class variable from libcst-parse.py.
 */
export interface EnvelopeClassVar {
  readonly name: string;
  /** Wire expression from libcst-parse.py. */
  readonly value: unknown;
}

/**
 * Wire-shape for a single method inside a class envelope from libcst-parse.py.
 */
export interface EnvelopeMethod {
  readonly name: string;
  readonly params: readonly EnvelopeInitParam[];
  readonly return_annotation: string | null;
  readonly body_source: string;
  readonly body: readonly WireStmt[];
  readonly methodKind: MethodKind;
}

/**
 * Structural class envelope as emitted by libcst-parse.py module.classes[].
 *
 * Used exclusively by raise-class.ts. The existing flat module.functions[]
 * list (WI-890) continues to be populated in parallel.
 *
 * @decision DEC-WI934-001 — additive classes[] alongside flat functions[]
 */
export interface EnvelopeClass {
  readonly name: string;
  readonly bases: readonly string[];
  readonly decorators: readonly string[];
  readonly metaclass: string | null;
  readonly init_params: readonly EnvelopeInitParam[];
  readonly init_assignments: readonly EnvelopeInitAssignment[];
  readonly methods: readonly EnvelopeMethod[];
  readonly class_vars: readonly EnvelopeClassVar[];
  /** Python-side first-pass raise blockers. Empty = no blockers detected. */
  readonly raise_blockers: readonly string[];
}

/**
 * Walk `module.classes[]` in the libcst envelope and return a typed
 * `EnvelopeClass[]` — one entry per class in the Python source.
 *
 * This is a pure type-narrowing pass: no rejection logic, no purity checks,
 * no annotation mapping. The result feeds directly into `raiseClass()`.
 *
 * The WI-890 `extractOne` instance-method short-circuit is NOT affected:
 * methods arriving via `module.functions[]` flat list continue to reject with
 * `ImpureFunctionError`. Classes arriving via `module.classes[]` flow through
 * `raise-class.ts` only.
 *
 * @decision DEC-WI934-011 — backward compatibility: WI-890 short-circuit retained
 * @title module.functions[] instance-method path unchanged; module.classes[] is a new fork
 * @status accepted
 */
export function extractClassEnvelopes(envelope: LibcstParseResult): EnvelopeClass[] {
  const moduleRecord = envelope.module as unknown as { classes?: unknown[] };
  const classes = moduleRecord.classes ?? [];
  // Narrow each entry to EnvelopeClass — trust the libcst-parse.py wire contract.
  return classes as EnvelopeClass[];
}
