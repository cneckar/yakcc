// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-AST-BINDING-001: hand-authored property-test corpus
// for @yakcc/ir ast-binding.ts. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the harness.
// Status: accepted (WI-87-fill-ir)
// Rationale: extractBindingShape is a pure function (no I/O, deterministic) with
// well-defined in-scope / out-of-scope boundaries documented in DEC-HOOK-PHASE-2-001.
// Property tests exercise: null-return boundaries, binding name extraction,
// argument extraction, type annotation capture, determinism, and result-shape.

// ---------------------------------------------------------------------------
// Property-test corpus for ast-binding.ts
//
// Function covered (1 exported function):
//   extractBindingShape (B1.1) — pure ts-morph-based binding extractor
//
// Atoms:
//   B1.1a — returns null for empty/whitespace snippets
//   B1.1b — returns null for non-binding snippets (bare expressions, function decls)
//   B1.1c — returns null for multiple variable statements
//   B1.1d — returns null for destructuring patterns
//   B1.1e — returns null for non-call initializers (literals, binary, new)
//   B1.1f — correctly extracts name + atomName + args for simple bindings
//   B1.1g — captures returnType from type-annotated bindings
//   B1.1h — is deterministic: two calls on identical input produce identical results
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { type BindingShape, extractBindingShape } from "./ast-binding.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Simple identifier names that are valid TypeScript identifiers. */
// Full set of TypeScript reserved words and contextual keywords that would cause
// parse errors when used as identifiers. Includes JS reserved words (ECMA-262 §12.1),
// TypeScript-specific keywords, and strict-mode reserved words.
const TS_RESERVED = new Set([
  // ES reserved words
  "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "export", "extends", "false", "finally",
  "for", "function", "if", "import", "in", "instanceof", "new", "null",
  "return", "super", "switch", "this", "throw", "true", "try", "typeof",
  "var", "void", "while", "with", "yield",
  // Strict mode reserved words
  "let", "static", "implements", "interface", "package", "private",
  "protected", "public",
  // TypeScript keywords
  "abstract", "as", "async", "await", "declare", "enum", "from", "get",
  "infer", "is", "keyof", "module", "namespace", "never", "of", "override",
  "readonly", "require", "set", "satisfies", "type", "unique", "unknown",
]);

const identifierArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,7}$/).filter(
  // Exclude reserved words that would cause parse errors
  (s) => !TS_RESERVED.has(s),
);

/**
 * Arbitrary for valid simple binding snippets:
 * `const <name> = <fn>(<args>)`.
 * These should always produce a non-null BindingShape.
 */
const simpleBindingArb: fc.Arbitrary<string> = fc
  .tuple(
    identifierArb, // binding name
    identifierArb, // atom function name
    fc.array(fc.constantFrom("1", "2", '"hello"', "true", "false"), {
      minLength: 0,
      maxLength: 3,
    }),
  )
  .map(([name, fn, args]) => `const ${name} = ${fn}(${args.join(", ")});`);

/**
 * Arbitrary for snippets that should always return null:
 * bare expressions, class declarations, function declarations, empty strings.
 */
const nullSnippetArb: fc.Arbitrary<string> = fc.constantFrom(
  "", // empty
  "   ", // whitespace only
  "\t\n", // tabs/newlines
  "console.log('hello');", // bare expression statement — no binding
  "functionDeclaration()", // bare call expression — no binding
  "function foo(): void {}", // function declaration — not a binding
  "class Foo {}", // class declaration
  "42;", // numeric expression
  "true;", // boolean expression
  "'hello';", // string expression
  "import { foo } from './bar';", // import statement
);

/**
 * Arbitrary for multi-statement snippets (two variable declarations).
 * These should always return null per v1 scope (ambiguous target).
 */
const multiStatementArb: fc.Arbitrary<string> = fc
  .tuple(identifierArb, identifierArb)
  .filter(([a, b]) => a !== b)
  .map(([a, b]) => `const ${a} = fn1();\nconst ${b} = fn2();`);

/**
 * Arbitrary for destructuring-pattern snippets.
 * These should always return null per v1 scope.
 */
const destructuringArb: fc.Arbitrary<string> = fc.constantFrom(
  "const { a, b } = fn();",
  "const { x } = getData();",
  "const [first, second] = getList();",
  "const { name: alias } = getObj();",
);

/**
 * Arbitrary for snippets with non-call initializers.
 * These should always return null per v1 scope.
 */
const nonCallInitializerArb: fc.Arbitrary<string> = fc.constantFrom(
  "const x = 42;", // numeric literal
  "const y = 'hello';", // string literal
  "const z = true;", // boolean literal
  "const w = a + b;", // binary expression (identifiers not in scope but parseable)
  "const v = null;", // null literal
  "const u = undefined;", // undefined identifier
);

// ---------------------------------------------------------------------------
// B1.1a: Returns null for empty / whitespace-only snippets
// ---------------------------------------------------------------------------

/**
 * prop_extractBindingShape_null_for_empty_snippets
 *
 * For any empty or whitespace-only string, extractBindingShape returns null.
 *
 * Invariant: the first guard in extractBindingShape is `if (!code.trim()) return null`,
 * which rejects all empty-after-trim inputs before touching ts-morph.
 */
export const prop_extractBindingShape_null_for_empty_snippets = fc.property(
  fc.constantFrom("", "   ", "\t", "\n", "\r\n", "\t\n   "),
  (code) => {
    const result = extractBindingShape(code);
    return result === null;
  },
);

// ---------------------------------------------------------------------------
// B1.1b: Returns null for non-binding snippets
// ---------------------------------------------------------------------------

/**
 * prop_extractBindingShape_null_for_non_binding_snippets
 *
 * For snippets that contain no variable declarations (bare expressions,
 * function declarations, class declarations), extractBindingShape returns null.
 *
 * Invariant: the `varStatements.length === 0` guard fires for all non-binding
 * top-level statements.
 */
export const prop_extractBindingShape_null_for_non_binding_snippets = fc.property(
  nullSnippetArb,
  (code) => {
    const result = extractBindingShape(code);
    // Empty/whitespace always null; non-binding statements also null
    return result === null;
  },
);

// ---------------------------------------------------------------------------
// B1.1c: Returns null for multiple variable statements
// ---------------------------------------------------------------------------

/**
 * prop_extractBindingShape_null_for_multiple_statements
 *
 * For snippets containing two or more variable statements, extractBindingShape
 * returns null regardless of what the individual statements look like.
 *
 * Invariant: the `varStatements.length > 1` guard fires.
 * This is the v1 scope boundary: multi-statement snippets are out of scope.
 */
export const prop_extractBindingShape_null_for_multiple_statements = fc.property(
  multiStatementArb,
  (code) => {
    const result = extractBindingShape(code);
    return result === null;
  },
);

// ---------------------------------------------------------------------------
// B1.1d: Returns null for destructuring patterns
// ---------------------------------------------------------------------------

/**
 * prop_extractBindingShape_null_for_destructuring
 *
 * For snippets using destructuring binding patterns (`const { a } = fn()`
 * or `const [a] = fn()`), extractBindingShape returns null.
 *
 * Invariant: the `!Node.isIdentifier(nameNode)` guard fires for destructuring
 * bindings — they are ObjectBindingPattern or ArrayBindingPattern, not Identifier.
 */
export const prop_extractBindingShape_null_for_destructuring = fc.property(
  destructuringArb,
  (code) => {
    const result = extractBindingShape(code);
    return result === null;
  },
);

// ---------------------------------------------------------------------------
// B1.1e: Returns null for non-call initializers
// ---------------------------------------------------------------------------

/**
 * prop_extractBindingShape_null_for_non_call_initializers
 *
 * For variable declarations whose initializer is a literal (number, string,
 * boolean, null), binary expression, or other non-call form, extractBindingShape
 * returns null.
 *
 * Invariant: the `!Node.isCallExpression(initializer)` guard fires for non-call
 * initializers.
 */
export const prop_extractBindingShape_null_for_non_call_initializers = fc.property(
  nonCallInitializerArb,
  (code) => {
    const result = extractBindingShape(code);
    return result === null;
  },
);

// ---------------------------------------------------------------------------
// B1.1f: Correctly extracts name, atomName, args for simple bindings
// ---------------------------------------------------------------------------

/**
 * prop_extractBindingShape_extracts_name_and_atom
 *
 * For any simple binding `const <name> = <fn>(...)`, extractBindingShape:
 *   - returns a non-null BindingShape
 *   - shape.name equals the declared binding name
 *   - shape.atomName equals the called function name
 *   - shape.args is an Array
 *
 * Invariant: the happy-path extraction path correctly reads the Identifier name
 * node and the call expression's function name from the ts-morph AST.
 */
export const prop_extractBindingShape_extracts_name_and_atom = fc.property(
  fc.tuple(identifierArb, identifierArb).filter(([name, fn]) => name !== fn),
  ([name, fn]) => {
    const code = `const ${name} = ${fn}();`;
    const result = extractBindingShape(code);
    if (result === null) return false;
    if (result.name !== name) return false;
    if (result.atomName !== fn) return false;
    if (!Array.isArray(result.args)) return false;
    return true;
  },
);

/**
 * prop_extractBindingShape_args_count_matches_call
 *
 * For a simple binding with N arguments, shape.args has exactly N elements
 * and each element is a non-empty string.
 *
 * Invariant: the `initializer.getArguments().map(arg => arg.getText())` path
 * preserves argument count and produces non-empty text strings for all literal args.
 */
export const prop_extractBindingShape_args_count_matches_call = fc.property(
  fc
    .tuple(
      identifierArb,
      identifierArb,
      fc.array(fc.constantFrom("1", "2", "3", '"a"', '"b"', "true", "false"), {
        minLength: 0,
        maxLength: 4,
      }),
    )
    .filter(([name, fn]) => name !== fn),
  ([name, fn, args]) => {
    const code = `const ${name} = ${fn}(${args.join(", ")});`;
    const result = extractBindingShape(code);
    if (result === null) return false;
    // Argument count must match
    if (result.args.length !== args.length) return false;
    // Each arg must be a non-empty string (getText() never produces empty for literals)
    for (const arg of result.args) {
      if (typeof arg !== "string" || arg.length === 0) return false;
    }
    return true;
  },
);

// ---------------------------------------------------------------------------
// B1.1g: Captures returnType from type-annotated bindings
// ---------------------------------------------------------------------------

/**
 * prop_extractBindingShape_captures_return_type
 *
 * For type-annotated bindings `const x: T = fn()`, shape.returnType equals
 * the annotation text. For unannotated bindings, shape.returnType is undefined.
 *
 * Invariant: `decl.getTypeNode()` returns the type annotation node; its getText()
 * produces the annotation text. When absent, typeNode is undefined and returnType
 * is not set on the result.
 */
export const prop_extractBindingShape_captures_return_type = fc.property(
  fc.constantFrom(
    { code: "const x: number = fn();", expectedType: "number" },
    { code: "const x: string = fn();", expectedType: "string" },
    { code: "const x: boolean = fn();", expectedType: "boolean" },
    { code: "const r: string[] = fn();", expectedType: "string[]" },
    { code: "const v = fn();", expectedType: undefined },
  ),
  ({ code, expectedType }) => {
    const result = extractBindingShape(code);
    if (result === null) return false;
    return result.returnType === expectedType;
  },
);

// ---------------------------------------------------------------------------
// B1.1h: Determinism — two calls on identical input produce identical results
// ---------------------------------------------------------------------------

/**
 * prop_extractBindingShape_deterministic
 *
 * For any snippet from the combined corpus (valid bindings, null-returning
 * snippets), two consecutive calls to extractBindingShape return identical
 * results: both null, or both non-null with the same name/atomName/args/returnType.
 *
 * Invariant: extractBindingShape creates a fresh ts-morph Project per call;
 * no shared mutable state exists between calls. The function is deterministic
 * and side-effect-free with respect to observable outputs.
 */
export const prop_extractBindingShape_deterministic = fc.property(
  fc.oneof(simpleBindingArb, nullSnippetArb, destructuringArb, nonCallInitializerArb),
  (code) => {
    const r1 = extractBindingShape(code);
    const r2 = extractBindingShape(code);

    if (r1 === null && r2 === null) return true;
    if (r1 === null || r2 === null) return false;

    // Both non-null: compare shape fields
    if (r1.name !== r2.name) return false;
    if (r1.atomName !== r2.atomName) return false;
    if (r1.returnType !== r2.returnType) return false;
    if (r1.args.length !== r2.args.length) return false;
    for (let i = 0; i < r1.args.length; i++) {
      if (r1.args[i] !== r2.args[i]) return false;
    }
    return true;
  },
);

/**
 * prop_extractBindingShape_result_shape_invariant
 *
 * For any snippet that returns non-null, the BindingShape has all required
 * fields with correct types: name (string), atomName (string), args (array of
 * strings). returnType is either a string or undefined — never null or other type.
 *
 * Invariant: the return statement in extractBindingShape always constructs a
 * complete BindingShape object with no missing required fields.
 */
export const prop_extractBindingShape_result_shape_invariant = fc.property(
  simpleBindingArb,
  (code) => {
    const result = extractBindingShape(code);
    // simpleBindingArb may or may not yield null depending on filter; check defensively
    if (result === null) return true; // vacuously OK — constraint is on non-null results

    // Required fields
    if (typeof result.name !== "string" || result.name.length === 0) return false;
    if (typeof result.atomName !== "string" || result.atomName.length === 0) return false;
    if (!Array.isArray(result.args)) return false;
    for (const arg of result.args) {
      if (typeof arg !== "string") return false;
    }

    // returnType must be string | undefined, never null
    const rt = (result as BindingShape).returnType;
    if (rt !== undefined && typeof rt !== "string") return false;

    return true;
  },
);
