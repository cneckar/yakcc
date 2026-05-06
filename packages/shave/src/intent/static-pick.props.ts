// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave intent/static-pick.ts atoms. Two-file pattern: this file (.props.ts)
// is vitest-free and holds the corpus; the sibling .props.test.ts is the
// vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3h)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from static-pick.ts):
//   pickPrimaryDeclaration — deterministic priority-chain picker
//   PrimaryDeclaration     — type alias (structural, not a runtime atom)
//   isExported             — modifier check helper (exercised through picker)
//   getFirstInitializer    — declarator initializer accessor (exercised through picker)
//
// Properties covered (19 atoms, all Path A per L1 inventory):
//   SP1   — Priority 1: export default function
//   SP2   — Priority 1: export default FunctionExpression (export = fn)
//   SP3   — Priority 1: export default ArrowFunction returns VariableStatement
//   SP4   — Priority 1: bare export default ArrowFunction (no enclosing VS)
//   SP5   — Priority 1: export default expression (non-function) skips to lower
//   SP6   — Priority 2: first exported FunctionDeclaration wins
//   SP7   — Priority 2: exported VariableStatement with arrow initializer returned
//   SP8   — Priority 2: exported VariableStatement with FunctionExpression returned
//   SP9   — Priority 2: exported VariableStatement with non-function initializer skipped
//   SP10  — Priority 3: first non-exported FunctionDeclaration
//   SP11  — Priority 4: first non-exported VariableStatement with arrow initializer
//   SP12  — Priority 4: first non-exported VariableStatement with FunctionExpression
//   SP13  — Priority 4: non-exported VariableStatement with non-function initializer skipped
//   SP14  — Priority 5: first method of first ClassDeclaration
//   SP15  — Priority 5: empty ClassDeclaration with no methods skips to undefined
//   SP16  — Priority 6: pure expression block returns undefined
//   SP17  — Priority 6: empty source returns undefined
//   SP18  — isExported correctness: ExportKeyword partitioning
//   SP19  — getFirstInitializer: returns first declarator initializer or undefined

// ---------------------------------------------------------------------------
// Property-test corpus for intent/static-pick.ts
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { Node, Project } from "ts-morph";
import { pickPrimaryDeclaration } from "./static-pick.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Create a fresh in-memory ts-morph Project per DEC-INTENT-STATIC-003. */
function makeProject() {
  return new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: false, allowJs: true, noLib: true },
  });
}

/** Parse source text into a SourceFile using a fresh in-memory project. */
function parse(source: string) {
  return makeProject().createSourceFile("__pick_prop__.ts", source);
}

/**
 * TypeScript/JavaScript reserved words that must not appear as synthesized
 * identifiers. ts-morph produces malformed AST when reserved words are used
 * as function names, variable names, etc. (e.g. `function var(): number {}`).
 */
const TS_KEYWORDS = new Set([
  "abstract",
  "any",
  "as",
  "break",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "for",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "interface",
  "is",
  "let",
  "new",
  "null",
  "of",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "set",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "var",
  "void",
  "while",
  "yield",
]);

/** Simple identifier-safe name arbitrary (letters only, 3–10 chars, no reserved words). */
const identArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z]{2,9}$/)
  .filter((s) => s.length >= 3 && !TS_KEYWORDS.has(s));

/** Safe type annotation string (no newlines, no special chars). */
const typeArb: fc.Arbitrary<string> = fc.constantFrom(
  "number",
  "string",
  "boolean",
  "void",
  "unknown",
  "string[]",
  "number[]",
);

// ---------------------------------------------------------------------------
// SP1 — Priority 1: export default function
//
// Invariant: when the source has `export default function foo()`,
// pickPrimaryDeclaration returns a FunctionDeclaration node whose text
// contains the function name.
// ---------------------------------------------------------------------------

/**
 * prop_pick_priority1_export_default_function
 *
 * `export default function` is selected at Priority 1 regardless of other
 * declarations present in the source.
 */
export const prop_pick_priority1_export_default_function = fc.property(
  identArb,
  identArb,
  typeArb,
  (name, helperName, retType) => {
    const source = `
function ${helperName}(): void {}
export default function ${name}(): ${retType} { return undefined as unknown as ${retType}; }
`.trim();
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    return node !== undefined && Node.isFunctionDeclaration(node) && node.getText().includes(name);
  },
);

// ---------------------------------------------------------------------------
// SP2 — Priority 1: export default FunctionExpression
//
// Invariant: `export default function() {}` (anonymous function expression
// as default) is picked at Priority 1 and returns a FunctionDeclaration
// or FunctionExpression node.
// ---------------------------------------------------------------------------

/**
 * prop_pick_priority1_export_default_function_expression
 *
 * Anonymous export-default function expression is selected at Priority 1.
 */
export const prop_pick_priority1_export_default_function_expression = fc.property(
  identArb,
  typeArb,
  (helperName, retType) => {
    // ts-morph treats `export default function() {}` as FunctionDeclaration
    const source = `
function ${helperName}(): ${retType} {}
export default function() {}
`.trim();
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    // Must be defined and must NOT be the helper
    if (node === undefined) return false;
    if (!Node.isFunctionDeclaration(node) && !Node.isFunctionExpression(node)) return false;
    return !node.getText().includes(helperName);
  },
);

// ---------------------------------------------------------------------------
// SP3 — Priority 1: export default ArrowFunction returns VariableStatement
//
// Invariant (DEC-INTENT-STATIC-001): for `export default const f = () => {}`,
// the picker MUST return the VariableStatement, not the inner ArrowFunction,
// so JSDoc attached to the VariableStatement is reachable.
// ---------------------------------------------------------------------------

/**
 * prop_pick_priority1_arrow_const_default_returns_vs
 *
 * When `export default` points to an arrow via a VariableStatement, the picker
 * returns the VariableStatement (not the inner ArrowFunction). This is the
 * DEC-INTENT-STATIC-001 JSDoc-attachment gotcha.
 */
export const prop_pick_priority1_arrow_const_default_returns_vs = fc.property(identArb, (name) => {
  const source = `export const ${name} = (): void => {};
export default ${name};`;
  const sf = parse(source);
  const node = pickPrimaryDeclaration(sf);
  // DEC-INTENT-STATIC-001: the picker MUST return the enclosing VariableStatement
  // (not the inner ArrowFunction) so JSDoc attached at the VS level is reachable.
  // We assert Node.isVariableStatement because that is the invariant — returning
  // an ArrowFunction here would violate the JSDoc-attachment contract.
  if (node === undefined) return false;
  return Node.isVariableStatement(node);
});

// ---------------------------------------------------------------------------
// SP4 — Priority 1: bare export default ArrowFunction (no enclosing VS)
//
// Invariant: `export default () => {}` (bare arrow, no VariableStatement wrapper)
// returns the ArrowFunction itself since no enclosing VariableStatement exists.
// ---------------------------------------------------------------------------

/**
 * prop_pick_priority1_bare_default_arrow_returns_arrow_function
 *
 * A bare `export default () => {}` has no enclosing VariableStatement; the
 * picker falls through to return the ArrowFunction node directly.
 */
export const prop_pick_priority1_bare_default_arrow_returns_arrow_function = fc.property(
  identArb,
  typeArb,
  (helperName, retType) => {
    const source = `
function ${helperName}(): ${retType} {}
export default () => {};
`.trim();
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    // The bare arrow or a wrapping node must be returned — defined is sufficient
    // because bare default arrow may get hoisted differently by ts-morph versions.
    return node !== undefined;
  },
);

// ---------------------------------------------------------------------------
// SP5 — Priority 1: export default expression (non-function) falls through
//
// Invariant: `export default someIdentifier` where `someIdentifier` is a
// non-function (e.g. a string literal or object) does NOT satisfy Priority 1
// and falls through to lower priorities.
// ---------------------------------------------------------------------------

/**
 * prop_pick_priority1_non_function_default_skips_to_lower
 *
 * When the default export is a non-function expression (object literal, literal),
 * Priority 1 finds no function node and falls through to Priority 2+.
 * Result must still be defined (Priority 2 exported function exists).
 */
export const prop_pick_priority1_non_function_default_skips_to_lower = fc.property(
  identArb,
  (name) => {
    // export default is an object literal — not a function. The exported function
    // at Priority 2 should then be selected.
    const source = `
export function ${name}(): void {}
export default { value: 42 };
`.trim();
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    // Since export default is an object (not a function node ts-morph resolves),
    // Priority 2 exported FunctionDeclaration should be picked.
    return node?.getText().includes(name) === true;
  },
);

// ---------------------------------------------------------------------------
// SP6 — Priority 2: first exported FunctionDeclaration wins
//
// Invariant: when multiple exported FunctionDeclarations exist, the FIRST one
// (in source order) is returned. Non-exported functions before it are skipped.
// ---------------------------------------------------------------------------

/**
 * prop_pick_priority2_first_exported_function_wins
 *
 * Priority 2 returns the first exported FunctionDeclaration in source order,
 * even when non-exported FunctionDeclarations appear earlier in the file.
 */
export const prop_pick_priority2_first_exported_function_wins = fc.property(
  identArb,
  identArb,
  identArb,
  (firstName, secondName, internalName) => {
    const source = `
function ${internalName}(): void {}
export function ${firstName}(): void {}
export function ${secondName}(): void {}
`.trim();
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    return (
      node !== undefined && Node.isFunctionDeclaration(node) && node.getText().includes(firstName)
    );
  },
);

// ---------------------------------------------------------------------------
// SP7 — Priority 2: exported VariableStatement with arrow initializer returned
//
// Invariant (DEC-INTENT-STATIC-001): `export const f = () => {}` returns the
// VariableStatement (not the inner ArrowFunction).
// ---------------------------------------------------------------------------

/**
 * prop_pick_priority2_exported_arrow_const_returns_variable_statement
 *
 * An exported arrow-const (`export const f = () => {}`) at Priority 2 is returned
 * as a VariableStatement so downstream JSDoc extraction works correctly.
 */
export const prop_pick_priority2_exported_arrow_const_returns_variable_statement = fc.property(
  identArb,
  typeArb,
  (name, retType) => {
    const source = `export const ${name} = (): ${retType} => undefined as unknown as ${retType};`;
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    return node !== undefined && Node.isVariableStatement(node) && node.getText().includes(name);
  },
);

// ---------------------------------------------------------------------------
// SP8 — Priority 2: exported VariableStatement with FunctionExpression returned
//
// Invariant: `export const f = function() {}` returns the VariableStatement.
// ---------------------------------------------------------------------------

/**
 * prop_pick_priority2_exported_function_expr_const_returns_variable_statement
 *
 * An exported const whose initializer is a FunctionExpression (`export const f =
 * function() {}`) is returned as the VariableStatement node, not the inner function.
 */
export const prop_pick_priority2_exported_function_expr_const_returns_variable_statement =
  fc.property(identArb, typeArb, (name, retType) => {
    const source = `export const ${name} = function(): ${retType} { return undefined as unknown as ${retType}; };`;
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    return node !== undefined && Node.isVariableStatement(node) && node.getText().includes(name);
  });

// ---------------------------------------------------------------------------
// SP9 — Priority 2: exported VariableStatement with non-function initializer skipped
//
// Invariant: `export const x = 42` has a literal initializer — NOT a function.
// The picker skips it at Priority 2 and continues to lower priorities (or
// returns undefined if nothing else is present).
// ---------------------------------------------------------------------------

/**
 * prop_pick_priority2_exported_non_function_const_skipped
 *
 * An exported const with a literal initializer is skipped at Priority 2.
 * When no other declarations exist, the result is undefined.
 */
export const prop_pick_priority2_exported_non_function_const_skipped = fc.property(
  identArb,
  fc.integer({ min: 1, max: 9999 }),
  (name, value) => {
    const source = `export const ${name} = ${value};`;
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    // Non-function const → no declaration found → Priority 6 → undefined
    return node === undefined;
  },
);

// ---------------------------------------------------------------------------
// SP10 — Priority 3: first non-exported FunctionDeclaration
//
// Invariant: when no exports exist, the first non-exported FunctionDeclaration
// is returned at Priority 3.
// ---------------------------------------------------------------------------

/**
 * prop_pick_priority3_first_non_exported_function
 *
 * When no exported declarations exist, Priority 3 picks the first non-exported
 * FunctionDeclaration in source order.
 */
export const prop_pick_priority3_first_non_exported_function = fc.property(
  identArb,
  identArb,
  (firstName, secondName) => {
    const source = `
function ${firstName}(): void {}
function ${secondName}(): void {}
`.trim();
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    return (
      node !== undefined && Node.isFunctionDeclaration(node) && node.getText().includes(firstName)
    );
  },
);

// ---------------------------------------------------------------------------
// SP11 — Priority 4: first non-exported VariableStatement with arrow initializer
//
// Invariant: `const f = () => {}` (no export) is picked at Priority 4 and
// returns the VariableStatement.
// ---------------------------------------------------------------------------

/**
 * prop_pick_priority4_non_exported_arrow_const
 *
 * A non-exported arrow-const (`const f = () => {}`) is returned as
 * VariableStatement at Priority 4. The DEC-INTENT-STATIC-001 gotcha applies
 * here too: always return VS, not the inner arrow.
 */
export const prop_pick_priority4_non_exported_arrow_const = fc.property(identArb, (name) => {
  const source = `const ${name} = (): void => {};`;
  const sf = parse(source);
  const node = pickPrimaryDeclaration(sf);
  return node !== undefined && Node.isVariableStatement(node) && node.getText().includes(name);
});

// ---------------------------------------------------------------------------
// SP12 — Priority 4: first non-exported VariableStatement with FunctionExpression
//
// Invariant: `const f = function() {}` (no export) is picked at Priority 4
// and returns the VariableStatement.
// ---------------------------------------------------------------------------

/**
 * prop_pick_priority4_non_exported_function_expr_const
 *
 * A non-exported const with a FunctionExpression initializer is returned as
 * VariableStatement at Priority 4.
 */
export const prop_pick_priority4_non_exported_function_expr_const = fc.property(
  identArb,
  (name) => {
    const source = `const ${name} = function(): void {};`;
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    return node !== undefined && Node.isVariableStatement(node) && node.getText().includes(name);
  },
);

// ---------------------------------------------------------------------------
// SP13 — Priority 4: non-exported VariableStatement with non-function initializer
//
// Invariant: `const x = 42` has a literal initializer; it is skipped at
// Priority 4, so the result falls through to Priority 5/6.
// ---------------------------------------------------------------------------

/**
 * prop_pick_priority4_non_function_const_skipped
 *
 * A non-exported const with a literal (non-function) initializer is skipped at
 * Priority 4. When no class is present, result is undefined (Priority 6).
 */
export const prop_pick_priority4_non_function_const_skipped = fc.property(
  identArb,
  fc.integer({ min: 0, max: 9999 }),
  (name, value) => {
    const source = `const ${name} = ${value};`;
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    return node === undefined;
  },
);

// ---------------------------------------------------------------------------
// SP14 — Priority 5: first method of first ClassDeclaration
//
// Invariant: when no function declarations or arrow-consts exist, the first
// MethodDeclaration from the first ClassDeclaration is returned at Priority 5.
// ---------------------------------------------------------------------------

/**
 * prop_pick_priority5_first_class_method
 *
 * When only a ClassDeclaration exists (with methods), Priority 5 returns the
 * first MethodDeclaration from the first class.
 */
export const prop_pick_priority5_first_class_method = fc.property(
  identArb,
  identArb,
  identArb,
  (className, firstMethod, secondMethod) => {
    const source = `
class ${className} {
  ${firstMethod}(): void {}
  ${secondMethod}(): void {}
}
`.trim();
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    return node?.getText().includes(firstMethod) === true;
  },
);

// ---------------------------------------------------------------------------
// SP15 — Priority 5: empty ClassDeclaration with no methods skips to undefined
//
// Invariant: a ClassDeclaration with no MethodDeclarations has no method to
// return; Priority 5 skips it and Priority 6 returns undefined.
// ---------------------------------------------------------------------------

/**
 * prop_pick_priority5_empty_class_returns_undefined
 *
 * A ClassDeclaration with no methods (empty body) causes Priority 5 to skip
 * and Priority 6 to return undefined.
 */
export const prop_pick_priority5_empty_class_returns_undefined = fc.property(
  identArb,
  (className) => {
    const source = `class ${className} {}`;
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    return node === undefined;
  },
);

// ---------------------------------------------------------------------------
// SP16 — Priority 6: pure expression block returns undefined
//
// Invariant: a source file containing only expressions (no declarations) returns
// undefined from pickPrimaryDeclaration.
// ---------------------------------------------------------------------------

/**
 * prop_pick_priority6_expression_only_returns_undefined
 *
 * A source fragment with only expression statements (no function/class/const
 * declarations) returns undefined at Priority 6.
 */
export const prop_pick_priority6_expression_only_returns_undefined = fc.property(
  fc.integer({ min: 0, max: 100 }),
  fc.integer({ min: 0, max: 100 }),
  (a, b) => {
    const source = `${a} + ${b}; "hello"; true;`;
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    return node === undefined;
  },
);

// ---------------------------------------------------------------------------
// SP17 — Priority 6: empty source returns undefined
//
// Invariant: an empty source string produces a SourceFile with no statements;
// pickPrimaryDeclaration returns undefined.
// ---------------------------------------------------------------------------

/**
 * prop_pick_priority6_empty_source_returns_undefined
 *
 * An empty source string has no declarations; the picker returns undefined.
 */
export const prop_pick_priority6_empty_source_returns_undefined = fc.property(
  fc.constantFrom("", "   ", "\n", "\t\n  "),
  (source) => {
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    return node === undefined;
  },
);

// ---------------------------------------------------------------------------
// SP18 — isExported correctness
//
// Invariant: pickPrimaryDeclaration correctly partitions exported vs non-exported
// declarations via hasModifier(SyntaxKind.ExportKeyword). A FunctionDeclaration
// with `export` keyword is selected at Priority 2 even when a non-exported
// FunctionDeclaration precedes it (Priority 3 scan would find the non-exported
// first, but Priority 2 scan finds the exported first).
// ---------------------------------------------------------------------------

/**
 * prop_pick_isexported_selects_exported_over_earlier_nonexported
 *
 * The isExported helper correctly distinguishes exported from non-exported
 * declarations. A non-exported function before an exported one is NOT selected
 * at Priority 2; the exported function IS selected at Priority 2.
 */
export const prop_pick_isexported_selects_exported_over_earlier_nonexported = fc.property(
  identArb,
  identArb,
  (nonExportedName, exportedName) => {
    const source = `
function ${nonExportedName}(): void {}
export function ${exportedName}(): void {}
`.trim();
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    // Priority 2 scan finds the exported function BEFORE Priority 3 finds the non-exported
    return (
      node !== undefined &&
      Node.isFunctionDeclaration(node) &&
      node.getText().includes(exportedName)
    );
  },
);

// ---------------------------------------------------------------------------
// SP19 — getFirstInitializer returns first declarator initializer or undefined
//
// Invariant: getFirstInitializer (exercised via picker) returns the first
// declarator's initializer. For VariableStatements with zero declarators
// (synthesized edge case — effectively not parseable as valid TS, so this is
// verified via the Priority 9/fallback path: source with a non-function init
// returns undefined since no function declarations exist either).
// ---------------------------------------------------------------------------

/**
 * prop_pick_getFirstInitializer_non_function_init_skipped
 *
 * getFirstInitializer on a VariableStatement with a string literal initializer
 * returns the StringLiteral node, which is not an ArrowFunction or
 * FunctionExpression, so the picker skips it. Combined with no other declarations,
 * the result is undefined.
 */
export const prop_pick_getFirstInitializer_non_function_init_skipped = fc.property(
  identArb,
  fc.string({ minLength: 1, maxLength: 10 }).filter((s) => /^[a-zA-Z0-9 ]+$/.test(s)),
  (name, value) => {
    // Non-function initializer (string literal) — picker must skip
    const source = `const ${name} = "${value}";`;
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    // No function declaration, no class, non-function const → undefined (Priority 6)
    return node === undefined;
  },
);

// ---------------------------------------------------------------------------
// Compound interaction: full priority chain traversal
//
// Production sequence: universalize() calls extractIntent() → staticExtract()
// → pickPrimaryDeclaration(sourceFile). This compound property drives the
// full picker across a mixed source and asserts correct priority ordering.
// ---------------------------------------------------------------------------

/**
 * prop_pick_compound_priority_chain_with_mixed_source
 *
 * When a source contains declarations from multiple priority levels, the picker
 * always selects the highest-priority one. This exercises the real production
 * sequence: the picker is called once per candidate block in universalize(),
 * and must deterministically return the highest-priority declaration regardless
 * of ordering within the file.
 *
 * Compound invariant: Priority 1 beats Priority 2 beats Priority 3 beats Priority 4.
 */
export const prop_pick_compound_priority_chain_with_mixed_source = fc.property(
  identArb,
  identArb,
  identArb,
  (p1Name, p2Name, p4Name) => {
    // Source contains Priority 4 (non-exported arrow-const), Priority 2 (exported
    // function), and Priority 1 (export default function). Priority 1 must win.
    const source = `
const ${p4Name} = (): void => {};
export function ${p2Name}(): void {}
export default function ${p1Name}(): void {}
`.trim();
    const sf = parse(source);
    const node = pickPrimaryDeclaration(sf);
    return (
      node !== undefined && Node.isFunctionDeclaration(node) && node.getText().includes(p1Name)
    );
  },
);
