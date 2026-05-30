// SPDX-License-Identifier: MIT
//
// raise-class.ts — raise a Python class to TS-subset IR via uncurry-to-free-function.
//
// WI-934: instance methods on classes with pure-derivable __init__ are raised as
// free functions `ClassName_methodName(self: ClassNameState, ...)` rather than
// rejected with ImpureFunctionError.  This is the bridge between the Python adapter
// and the substrate's existing decomposition pipeline:
//
//   Python class → raise-class.ts → TS-subset IR → @yakcc/shave decompose()
//
// The adapter raises; the substrate decomposes.  No adapter-side decomposition.
//
// Pipeline inside raiseClass():
//   1. Validate class shape (reject unsupported shapes with CannotRaiseToIRError)
//   2. Derive state interface (ClassNameState) from __init__ assignments
//   3. Emit factory function (ClassName_create)
//   4. For each instance method: rewrite body + emit as free function
//   5. Aggregate warnings; return RaisedClass
//
// @decision DEC-WI934-007 — Failure-mode error class: CannotRaiseToIRError
// @title Use CannotRaiseToIRError from @yakcc/contracts for structural rejections
// @status accepted
// @rationale CannotRaiseToIRError (construct + SourceLocation) already exists at
//   packages/contracts/src/polyglot-errors.ts:34-46 with the right shape.
//   ImpureFunctionError is reserved for genuine purity violations (I/O, mutable
//   globals, self.field mutation outside __init__).  CannotRaiseToIRError is for
//   structural/envelope-out-of-range rejections (metaclasses, multiple inheritance,
//   properties, etc.).  Conflating the two would make the error taxonomy ambiguous.
//   Cross-reference: DEC-WI933-003, PLAN.md §2.11 Alt D.
//
// @decision DEC-WI934-001 — libcst envelope additive: module.classes[] alongside functions[]
// @title module.classes[] is purely additive; module.functions[] unchanged
// @status accepted
// @rationale WI-890 callers remain byte-equivalent.
//
// @decision DEC-WI934-003 — Method uncurry naming: ClassName_methodName
// @title ClassName preserved verbatim; methodName goes through normalizeIdentifier
// @status accepted
// @rationale Consistent with existing normalize-names.ts Rule 2 (leading underscore
//   preserved).  State interface: ClassNameState.  Factory: ClassName_create.
//   DEC-WI934-008: leading underscore preserved (_PrivateClass_doThing).
//
// @decision DEC-WI934-004 — Constructor lowers to ClassName_create() → ClassNameState
// @title Pure factory; no Object.freeze(); readonly fields on the interface
// @status accepted
// @rationale Object.freeze() would raise IR envelope questions; the substrate handles
//   immutability via the readonly discipline.
//
// @decision DEC-WI934-005 — Method-to-method calls rewired via wire-AST traversal
// @title self.method(args) → ClassName_method(self, args) via recursive descent
// @status accepted
// @rationale Wire-AST rewrite is pure (no I/O, no state beyond class/method context).
//   Handles nested calls and arbitrary expression positions.
//
// @decision DEC-WI934-006 — self.field reads OK; self.field writes reject
// @title self.attr reads rewrite to self.camelAttr; self.attr writes → ImpureFunctionError
// @status accepted
// @rationale The uncurry-to-free-function correctness depends on no mutation of
//   self.field outside __init__.  self.field = value in __init__ is handled by the
//   init_assignments path (step 2).  self.field = value elsewhere is a purity violation.
//   ImpureFunctionError(kind:"instance_method") is the appropriate error (reusing the
//   existing kind per DEC-WI934-006 notes — do NOT add a new kind value unless
//   trivially scoped; the existing "instance_method" label is correct).
//
// @decision DEC-WI934-009 — Chained self.foo().bar() is MVP-allowed
// @title Inner self.foo() rewrites; outer .bar() is regular Attribute access on result
// @status accepted
// @rationale Don't pre-reject in raise-class — let raise-body or substrate catch it.
//   Known MVP edge; documented here.
//
// @decision DEC-WI934-011 — WI-890 short-circuit path retained
// @title module.functions[] instance-method path unchanged; module.classes[] is a new fork
// @status accepted
// @rationale Static/classmethod methods flow via module.functions[] (WI-890 path).
//   Instance methods on raisable classes flow via raise-class.  The two paths are
//   not in conflict — each method appears exactly once in the appropriate path.

import { CannotRaiseToIRError, type SourceLocation } from "@yakcc/contracts";
import { normalizeIdentifier } from "./normalize-names.js";
import type { EnvelopeClass, EnvelopeInitParam, EnvelopeMethod } from "./parse-fn-signature.js";
import { ImpureFunctionError } from "./purity-check.js";
import type { WireExpr, WireStmt } from "./raise-body.js";
import { renderBody } from "./raise-body.js";
import { type LowerWarning, mapPythonType } from "./type-map.js";

// ---------------------------------------------------------------------------
// WI-934 wire extension: AttributeRef
// ---------------------------------------------------------------------------
//
// @decision DEC-WI934-013 — AttributeRef wire node for self.field reads
// @title libcst-parse.py emits Attribute as {type:"AttributeRef",obj:<Expr>,attr:"name"}
// @status accepted
// @rationale The MVP wire format (raise-body.ts) has no Attribute expression type —
//   attribute access was previously emitted as Unsupported("Attribute").  For the
//   raise-class path, we need to distinguish self.field reads from other Unsupported
//   nodes so the rewriter can convert them to self.camelField Name nodes.
//
//   This extension is LOCAL to raise-class.ts — raise-body.ts is NOT modified.
//   The rewriter MUST fully resolve all AttributeRef nodes before passing the
//   rewritten body to renderBody().  Any AttributeRef that survives to renderBody
//   would be treated as Unsupported and throw.  This constraint is enforced by
//   the exhaustive rewriteExpr switch.
//
//   For non-self attribute refs (e.g. module.CONSTANT), the rewriter emits
//   a Name node with the dotted form "module.camelConst" — which renders
//   as a valid TS identifier token (no dot splitting needed since the substrate
//   will parse it as a plain Name in the TS source).
//
//   Self-method calls via attribute-call (libcst.Call with libcst.Attribute func)
//   arrive as Call{func:"self.method",...} via _callee_name — handled separately.

/** Extended wire expression including WI-934's AttributeRef node. */
type WireExprExt =
  | WireExpr
  | { readonly type: "AttributeRef"; readonly obj: WireExprExt; readonly attr: string };

const UNKNOWN_LOCATION: SourceLocation = { file: "<python-source>", line: 0, col: 0 };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of raising a single Python class to TS-subset IR text fragments.
 *
 * Each fragment is a self-contained TS declaration string.  Callers assemble
 * the final module by joining them (stateInterfaceTs, factoryTs, ...methodsTs).
 */
export interface RaisedClass {
  /** Class name as written in Python. */
  readonly name: string;
  /** `interface ClassNameState { readonly field: T; ... }` as TS source. */
  readonly stateInterfaceTs: string;
  /** `export function ClassName_create(...): ClassNameState { return { ... }; }` */
  readonly factoryTs: string;
  /** One TS free-function string per instance method (methodKind:"instance"). */
  readonly methodsTs: readonly string[];
  /** Warnings aggregated from type-mapping and body-rendering passes. */
  readonly warnings: readonly LowerWarning[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Derive the state interface name from the class name. */
function stateInterfaceName(className: string): string {
  return `${className}State`;
}

/** Derive the factory function name from the class name. */
function factoryFunctionName(className: string): string {
  return `${className}_create`;
}

/** Derive the free-function name for a method (ClassName_camelMethodName). */
function methodFunctionName(className: string, methodName: string): string {
  return `${className}_${normalizeIdentifier(methodName)}`;
}

// ---------------------------------------------------------------------------
// Wire-AST body rewriter (DEC-WI934-005, DEC-WI934-006)
// ---------------------------------------------------------------------------
//
// Recursive descent over WireExpr and WireStmt.  The rewriter:
//
//   1. `Attribute(value=Name("self"), attr=X)` read → normalize attr to camelCase
//      (DEC-WI934-006 read path).
//
//   2. `Call(func=Attribute(value=Name("self"), attr=X), args=[...])` →
//      `Call(func=ClassName_normalizedX, args=[Name("self"), ...args])`
//      (DEC-WI934-005).  Note: in the wire AST `Call.func` is a string (dotted
//      name), and `Attribute` calls arrive as a plain `Call` node with func being
//      the dotted form e.g. "self.check_length".  We detect this pattern.
//
//   3. `Assign(target=self.attr, ...)` via Unsupported "attribute Assign" →
//      reject with ImpureFunctionError (DEC-WI934-006 write path).
//      libcst-parse.py emits attribute Assign as Unsupported("attribute Assign")
//      per the WI-907 comment in _stmt_inner; we detect that sentinel.
//
// The rewriter does NOT implement decomposition — it is a pure emit-time
// transformation of the source-to-IR boundary.

/**
 * Rewrite a WireExprExt node: self.attr reads (AttributeRef) and self.method calls.
 *
 * AttributeRef{obj:Name("self"),attr:X} → Name("self.camelX")
 *   (DEC-WI934-006, DEC-WI934-013)
 * AttributeRef{obj:other,attr:X} → Name("rendered_obj.X") via recursive descent.
 * Call{func:"self.method",args:[...]} → Call{func:"ClassName_method",args:[self,...]}
 *   (DEC-WI934-005)
 *
 * The rewriter MUST convert all AttributeRef nodes to plain WireExpr before
 * the result is passed to renderBody().  Any AttributeRef surviving to
 * renderBody would be treated as Unsupported and throw UnsupportedAstError.
 *
 * @param expr      Wire expression (may include AttributeRef extension).
 * @param className Python class name (for free-function names).
 * @returns         Plain WireExpr (no AttributeRef nodes remain).
 */
function rewriteExpr(expr: WireExprExt, className: string): WireExpr {
  // Handle the WI-934 AttributeRef extension first (not in the base WireExpr union).
  if (expr.type === "AttributeRef") {
    const obj = expr.obj;
    const attr = expr.attr;
    if (obj.type === "Name" && obj.name === "self") {
      // self.field read → Name("self.camelField")
      // renderExpr(Name("self.maxLength")) → "self.maxLength" which is valid TS
      // field access on the `self: ClassNameState` parameter.
      return { type: "Name", name: `self.${normalizeIdentifier(attr)}` };
    }
    // Non-self attribute access: recursively rewrite the object, then
    // produce a dotted-name Name node (e.g. "module.CONSTANT").
    const rewrittenObj = rewriteExpr(obj, className);
    // Build a dotted-form Name by extracting the rendered name from the obj
    // (safe for Name nodes; for complex expressions, fall back to Unsupported).
    if (rewrittenObj.type === "Name") {
      return { type: "Name", name: `${rewrittenObj.name}.${attr}` };
    }
    // Complex obj (not a plain Name) — cannot fold to a Name; pass through as Unsupported
    // so renderBody throws a clear UnsupportedAstError rather than silently corrupting output.
    return { type: "Unsupported", reason: `AttributeRef on complex object (${rewrittenObj.type})` };
  }

  switch (expr.type) {
    case "Name":
    case "Integer":
    case "Float":
    case "String":
    case "Bool":
    case "None":
      return expr;

    case "Call": {
      // Detect self.method(args) — the func string will be "self.methodName"
      // when the call was `self.check_length(email)` in Python.
      // libcst-parse.py emits Call.func as a dotted string for simple calls.
      const funcStr = expr.func;
      if (funcStr.startsWith("self.")) {
        const methodPart = funcStr.slice("self.".length);
        const freeFnName = methodFunctionName(className, methodPart);
        // Prepend Name("self") as first arg (DEC-WI934-005)
        const rewrittenArgs: WireExpr[] = [
          { type: "Name", name: "self" },
          ...expr.args.map((a) => rewriteExpr(a as WireExprExt, className)),
        ];
        return { type: "Call", func: freeFnName, args: rewrittenArgs };
      }
      // Regular call: recurse into args only
      return {
        type: "Call",
        func: funcStr,
        args: expr.args.map((a) => rewriteExpr(a as WireExprExt, className)),
      };
    }

    case "BinaryOp":
      return {
        type: "BinaryOp",
        op: expr.op,
        left: rewriteExpr(expr.left as WireExprExt, className),
        right: rewriteExpr(expr.right as WireExprExt, className),
      };

    case "BoolOp":
      return {
        type: "BoolOp",
        op: expr.op,
        left: rewriteExpr(expr.left as WireExprExt, className),
        right: rewriteExpr(expr.right as WireExprExt, className),
      };

    case "UnaryOp":
      return {
        type: "UnaryOp",
        op: expr.op,
        operand: rewriteExpr(expr.operand as WireExprExt, className),
      };

    case "IfExp":
      return {
        type: "IfExp",
        test: rewriteExpr(expr.test as WireExprExt, className),
        body: rewriteExpr(expr.body as WireExprExt, className),
        orelse: rewriteExpr(expr.orelse as WireExprExt, className),
      };

    case "LenCall":
      return { type: "LenCall", arg: rewriteExpr(expr.arg as WireExprExt, className) };

    case "Subscript":
      return {
        type: "Subscript",
        value: rewriteExpr(expr.value as WireExprExt, className),
        slice: rewriteExpr(expr.slice as WireExprExt, className),
      };

    case "Tuple":
      return {
        type: "Tuple",
        elements: expr.elements.map((e) => rewriteExpr(e as WireExprExt, className)),
      };

    case "ListComp": {
      if (expr.kind === "map") {
        return {
          ...expr,
          iter: rewriteExpr(expr.iter as WireExprExt, className),
          elt: rewriteExpr(expr.elt as WireExprExt, className),
        };
      }
      if (expr.kind === "filter") {
        return {
          ...expr,
          iter: rewriteExpr(expr.iter as WireExprExt, className),
          cond: rewriteExpr(expr.cond as WireExprExt, className),
        };
      }
      // filter_map
      return {
        ...expr,
        iter: rewriteExpr(expr.iter as WireExprExt, className),
        cond: rewriteExpr(expr.cond as WireExprExt, className),
        elt: rewriteExpr(expr.elt as WireExprExt, className),
      };
    }

    case "GeneratorExp": {
      if (expr.kind === "map") {
        return {
          ...expr,
          iter: rewriteExpr(expr.iter as WireExprExt, className),
          elt: rewriteExpr(expr.elt as WireExprExt, className),
        };
      }
      // filter_map
      return {
        ...expr,
        iter: rewriteExpr(expr.iter as WireExprExt, className),
        cond: rewriteExpr(expr.cond as WireExprExt, className),
        elt: rewriteExpr(expr.elt as WireExprExt, className),
      };
    }

    case "DictComp":
      return {
        ...expr,
        iter: rewriteExpr(expr.iter as WireExprExt, className),
        keyElt: rewriteExpr(expr.keyElt as WireExprExt, className),
        valElt: rewriteExpr(expr.valElt as WireExprExt, className),
        cond: expr.cond !== null ? rewriteExpr(expr.cond as WireExprExt, className) : null,
      };

    case "SetComp": {
      if (expr.kind === "map") {
        return {
          ...expr,
          iter: rewriteExpr(expr.iter as WireExprExt, className),
          elt: rewriteExpr(expr.elt as WireExprExt, className),
        };
      }
      // filter_map
      return {
        ...expr,
        iter: rewriteExpr(expr.iter as WireExprExt, className),
        cond: rewriteExpr(expr.cond as WireExprExt, className),
        elt: rewriteExpr(expr.elt as WireExprExt, className),
      };
    }

    case "Attribute":
      // WI-931: bare obj.attr expression (added to WireExpr after raise-class.ts started).
      return {
        type: "Attribute",
        value: rewriteExpr(expr.value as WireExprExt, className),
        attr: expr.attr,
      };

    case "Unsupported":
      // Passthrough — renderBody will handle or throw
      return expr;
  }
}

/**
 * Rewrite a WireStmt: recurse into expressions and detect self-mutation.
 *
 * Self-mutation detection (DEC-WI934-006): libcst-parse.py emits attribute
 * Assign (`self.x = value`) as `{type:"Unsupported", reason:"attribute Assign"}`.
 * We detect this sentinel and throw ImpureFunctionError.
 */
function rewriteStmt(stmt: WireStmt, className: string, methodName: string): WireStmt {
  switch (stmt.type) {
    case "Return":
      return {
        type: "Return",
        value: stmt.value !== null ? rewriteExpr(stmt.value as WireExprExt, className) : null,
      };

    case "Pass":
    case "Docstring":
      return stmt;

    case "Raise":
      return {
        type: "Raise",
        excClass: stmt.excClass,
        message: stmt.message !== null ? rewriteExpr(stmt.message as WireExprExt, className) : null,
      };

    case "ImpureStatement":
      // Passthrough — renderBody will throw ImpureFunctionError at render time
      return stmt;

    case "If":
      return {
        type: "If",
        test: rewriteExpr(stmt.test as WireExprExt, className),
        body: stmt.body.map((s) => rewriteStmt(s, className, methodName)),
        orelse: stmt.orelse.map((s) => rewriteStmt(s, className, methodName)),
      };

    case "Assign":
      // Single-name target Assign: `x = expr` — recurse into value only.
      // Attribute Assign arrives as Unsupported (see below).
      return {
        type: "Assign",
        target: stmt.target,
        value: rewriteExpr(stmt.value as WireExprExt, className),
      };

    case "Unsupported": {
      // DEC-WI934-006: detect `self.field = value` (emitted as attribute Assign).
      // libcst-parse.py _stmt_inner emits {"type":"Unsupported","reason":"attribute Assign"}
      // for any `obj.attr = value` assignment.  Inside a class method, this is almost
      // always a self-mutation; reject with ImpureFunctionError.
      if (stmt.reason === "attribute Assign") {
        throw new ImpureFunctionError(
          methodName,
          "instance_method",
          "self mutation outside __init__ — instance method mutates self.field; " +
            "only reads are allowed in raisable instance methods",
        );
      }
      // Other Unsupported nodes pass through — renderBody will handle or throw UnsupportedAstError
      return stmt;
    }
  }
}

// ---------------------------------------------------------------------------
// State derivation (DEC-WI934-002)
// ---------------------------------------------------------------------------

interface StateField {
  readonly pyName: string; // original Python name (snake_case)
  readonly tsName: string; // camelCase TS name
  readonly tsType: string;
  readonly warnings: readonly LowerWarning[];
}

/**
 * Derive the state fields from __init__ assignments.
 *
 * Accepts only `self.x = param` patterns where `x` is a simple identifier and
 * `param` is a Name that appears in `init_params` with a type annotation.
 *
 * @decision DEC-WI934-002 — State-type derivation from simple __init__ self.foo = foo patterns
 * @title Walk __init__.body; reject computed assignments with CannotRaiseToIRError
 * @status accepted
 */
function deriveStateFields(
  className: string,
  initParams: readonly EnvelopeInitParam[],
  initAssignments: readonly { target: string; value: unknown }[],
): StateField[] {
  const paramMap = new Map<string, string | null>();
  for (const p of initParams) {
    paramMap.set(p.name, p.annotation);
  }

  const fields: StateField[] = [];
  for (const assignment of initAssignments) {
    const rhs = assignment.value as { type?: string; name?: string } | null;
    if (!rhs || rhs.type !== "Name" || typeof rhs.name !== "string") {
      // Non-Name RHS: computed expression — cannot derive type
      throw new CannotRaiseToIRError(
        "non_trivial_init",
        UNKNOWN_LOCATION,
        `Class '${className}': __init__ assignment self.${assignment.target} = <expr> uses a non-parameter RHS — cannot derive state type. Only self.x = param patterns are supported.`,
      );
    }
    const paramName = rhs.name;
    if (!paramMap.has(paramName)) {
      // RHS name does not match any init param
      throw new CannotRaiseToIRError(
        "non_trivial_init",
        UNKNOWN_LOCATION,
        `Class '${className}': __init__ assignment self.${assignment.target} = ${paramName} — RHS name does not match any __init__ parameter.`,
      );
    }
    const annotation = paramMap.get(paramName) ?? null;
    if (annotation === null) {
      throw new CannotRaiseToIRError(
        "missing_init_annotation",
        UNKNOWN_LOCATION,
        `Class '${className}': __init__ param '${paramName}' lacks a type annotation — cannot derive state field type.`,
      );
    }
    const { tsType, warnings } = mapPythonType(annotation);
    fields.push({
      pyName: assignment.target,
      tsName: normalizeIdentifier(assignment.target),
      tsType,
      warnings,
    });
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Emit helpers
// ---------------------------------------------------------------------------

function emitStateInterface(className: string, fields: readonly StateField[]): string {
  const stName = stateInterfaceName(className);
  if (fields.length === 0) {
    return `export interface ${stName} {}`;
  }
  const fieldLines = fields.map((f) => `  readonly ${f.tsName}: ${f.tsType};`).join("\n");
  return `export interface ${stName} {\n${fieldLines}\n}`;
}

function emitFactory(
  className: string,
  fields: readonly StateField[],
  initParams: readonly EnvelopeInitParam[],
): string {
  const stName = stateInterfaceName(className);
  const factoryName = factoryFunctionName(className);

  // Build param list from init_params (skip self; normalize names; map types)
  const paramParts: string[] = [];
  const warnings: LowerWarning[] = [];
  for (const p of initParams) {
    if (p.name === "self") continue;
    const annotation = p.annotation;
    if (annotation === null) {
      throw new CannotRaiseToIRError(
        "missing_init_annotation",
        UNKNOWN_LOCATION,
        `Class '${className}': __init__ param '${p.name}' lacks a type annotation.`,
      );
    }
    const { tsType, warnings: w } = mapPythonType(annotation);
    warnings.push(...w);
    paramParts.push(`${normalizeIdentifier(p.name)}: ${tsType}`);
  }

  const paramList = paramParts.join(", ");

  // Build object literal from fields
  const fieldAssigns = fields
    .map((f) => {
      // The factory parameter name is the normalized version of the Python param
      // that was assigned to this field in __init__.
      // We use the field's tsName directly because deriveStateFields maps
      // init param names → field names.
      return `${f.tsName}: ${f.tsName}`;
    })
    .join(", ");

  const body = fields.length === 0 ? "  return {};" : `  return { ${fieldAssigns} };`;

  return `export function ${factoryName}(${paramList}): ${stName} {\n${body}\n}`;
}

function emitMethod(
  className: string,
  method: EnvelopeMethod,
  stateInterfaceTsName: string,
  allWarnings: LowerWarning[],
): string {
  const freeFnName = methodFunctionName(className, method.name);

  // Build param list: self: ClassNameState first, then the rest
  const paramParts: string[] = [`self: ${stateInterfaceTsName}`];
  for (const p of method.params) {
    if (p.name === "self") continue; // already added
    if (p.annotation === null) {
      throw new CannotRaiseToIRError(
        "missing_method_annotation",
        UNKNOWN_LOCATION,
        `Class '${className}' method '${method.name}': ` +
          `param '${p.name}' lacks a type annotation.`,
      );
    }
    const normalized = normalizeIdentifier(p.name);
    const { tsType, warnings } = mapPythonType(p.annotation);
    allWarnings.push(...warnings);
    paramParts.push(`${normalized}: ${tsType}`);
  }

  // Return type
  let returnType = "void";
  if (method.return_annotation !== null) {
    const { tsType, warnings } = mapPythonType(method.return_annotation);
    allWarnings.push(...warnings);
    returnType = tsType;
  }

  const paramList = paramParts.join(", ");

  // Rewrite the body: self.field reads and self.method calls
  const rewrittenBody = method.body.map((s) => rewriteStmt(s, className, method.name));

  // Filter docstrings for void-0 fallback check (mirrors raise-function.ts DEC-WI888-008)
  const visibleStmts = rewrittenBody.filter((s) => s.type !== "Docstring");
  // #948 (DEC-948-001): seed seenNames with param names (including "self") so that
  // body-level re-assignment to a parameter emits bare `param = expr;` not `let param = ...`.
  const paramNames = new Set(["self", ...method.params.map((p) => p.name)]);
  const bodyText =
    visibleStmts.length === 0
      ? "  void 0;"
      : renderBody(visibleStmts, "  ", freeFnName, paramNames);

  return `export function ${freeFnName}(${paramList}): ${returnType} {\n${bodyText}\n}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Raise a single Python class (from the libcst structural envelope) to TS-subset IR.
 *
 * Returns a `RaisedClass` whose text fragments can be assembled into a TS module
 * and fed to `@yakcc/shave`'s decompose() pipeline.
 *
 * Throws `CannotRaiseToIRError` for unsupported class shapes.
 * Throws `ImpureFunctionError` for self-mutation inside method bodies.
 *
 * @decision DEC-WI934-007 — Failure-mode error class: CannotRaiseToIRError
 * @decision DEC-WI934-002 — State-type derivation from simple __init__ self.x = x patterns
 * @decision DEC-WI934-003 — Method uncurry naming: ClassName_methodName
 * @decision DEC-WI934-004 — Constructor → ClassName_create factory returning ClassNameState
 * @decision DEC-WI934-005 — self.method(args) rewrite via wire-AST traversal
 * @decision DEC-WI934-006 — self.field reads OK; self.field writes → ImpureFunctionError
 */
export function raiseClass(envelope: EnvelopeClass): RaisedClass {
  const { name: className, raise_blockers } = envelope;

  // Step 1: Validate class shape — check raise_blockers from the Python layer.
  // These are the structural rejection signals (DEC-WI934-007).
  if (raise_blockers.length > 0) {
    const blocker = raise_blockers[0] ?? "unknown_blocker";
    throw new CannotRaiseToIRError(
      blocker,
      UNKNOWN_LOCATION,
      `Class '${className}': cannot raise to IR — ${blocker}. Only plain classes with a simple __init__ and instance methods are supported.`,
    );
  }

  const allWarnings: LowerWarning[] = [];

  // Step 2: Derive state shape from __init__ assignments.
  const stateFields = deriveStateFields(className, envelope.init_params, envelope.init_assignments);
  for (const f of stateFields) {
    allWarnings.push(...f.warnings);
  }

  // Step 3: Emit ClassNameState interface.
  const stateInterfaceTs = emitStateInterface(className, stateFields);
  const stName = stateInterfaceName(className);

  // Step 4: Emit ClassName_create factory.
  const factoryTs = emitFactory(className, stateFields, envelope.init_params);

  // Step 5: Emit each instance method as a free function.
  const methodsTs: string[] = [];
  for (const method of envelope.methods) {
    if (method.methodKind !== "instance") {
      // static / class methods flow via module.functions[] (WI-890 path) — skip here.
      // DEC-WI934-011: WI-890 short-circuit path retained.
      continue;
    }
    const methodTs = emitMethod(className, method, stName, allWarnings);
    methodsTs.push(methodTs);
  }

  return {
    name: className,
    stateInterfaceTs,
    factoryTs,
    methodsTs,
    warnings: allWarnings,
  };
}
