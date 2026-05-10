// SPDX-License-Identifier: MIT
// Vitest harness for static-pick.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./static-pick.props.js";

describe("static-pick.ts — Path A property corpus", () => {
  // -------------------------------------------------------------------------
  // SP1 — Priority 1: export default function
  // -------------------------------------------------------------------------
  it("property: SP1 — export default function selected at Priority 1", () => {
    fc.assert(Props.prop_pick_priority1_export_default_function, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // SP2 — Priority 1: export default FunctionExpression
  // -------------------------------------------------------------------------
  it("property: SP2 — export default anonymous function expression selected at Priority 1", () => {
    fc.assert(Props.prop_pick_priority1_export_default_function_expression, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // SP3 — Priority 1: export default ArrowFunction returns VariableStatement
  // -------------------------------------------------------------------------
  it("property: SP3 — export default arrow const returns defined node (DEC-INTENT-STATIC-001)", () => {
    fc.assert(Props.prop_pick_priority1_arrow_const_default_returns_vs, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // SP4 — Priority 1: bare export default ArrowFunction
  // -------------------------------------------------------------------------
  it("property: SP4 — bare export default arrow function returns defined node", () => {
    fc.assert(Props.prop_pick_priority1_bare_default_arrow_returns_arrow_function, {
      numRuns: 50,
    });
  });

  // -------------------------------------------------------------------------
  // SP5 — Priority 1: non-function default falls through
  // -------------------------------------------------------------------------
  it("property: SP5 — export default object expression falls through to Priority 2", () => {
    fc.assert(Props.prop_pick_priority1_non_function_default_skips_to_lower, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // SP6 — Priority 2: first exported FunctionDeclaration wins
  // -------------------------------------------------------------------------
  it("property: SP6 — first exported FunctionDeclaration wins over later exported and non-exported", () => {
    fc.assert(Props.prop_pick_priority2_first_exported_function_wins, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // SP7 — Priority 2: exported arrow-const returns VariableStatement
  // -------------------------------------------------------------------------
  it("property: SP7 — exported arrow-const returns VariableStatement at Priority 2 (DEC-INTENT-STATIC-001)", () => {
    fc.assert(Props.prop_pick_priority2_exported_arrow_const_returns_variable_statement, {
      numRuns: 50,
    });
  });

  // -------------------------------------------------------------------------
  // SP8 — Priority 2: exported function-expr-const returns VariableStatement
  // -------------------------------------------------------------------------
  it("property: SP8 — exported FunctionExpression const returns VariableStatement at Priority 2", () => {
    fc.assert(Props.prop_pick_priority2_exported_function_expr_const_returns_variable_statement, {
      numRuns: 50,
    });
  });

  // -------------------------------------------------------------------------
  // SP9 — Priority 2: exported non-function const skipped
  // -------------------------------------------------------------------------
  it("property: SP9 — exported const with literal initializer is skipped at Priority 2", () => {
    fc.assert(Props.prop_pick_priority2_exported_non_function_const_skipped, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // SP10 — Priority 3: first non-exported FunctionDeclaration
  // -------------------------------------------------------------------------
  it("property: SP10 — first non-exported FunctionDeclaration selected at Priority 3", () => {
    fc.assert(Props.prop_pick_priority3_first_non_exported_function, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // SP11 — Priority 4: non-exported arrow-const returns VariableStatement
  // -------------------------------------------------------------------------
  it("property: SP11 — non-exported arrow-const returns VariableStatement at Priority 4", () => {
    fc.assert(Props.prop_pick_priority4_non_exported_arrow_const, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // SP12 — Priority 4: non-exported function-expr-const returns VariableStatement
  // -------------------------------------------------------------------------
  it("property: SP12 — non-exported FunctionExpression const returns VariableStatement at Priority 4", () => {
    fc.assert(Props.prop_pick_priority4_non_exported_function_expr_const, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // SP13 — Priority 4: non-exported non-function const skipped
  // -------------------------------------------------------------------------
  it("property: SP13 — non-exported const with literal initializer skipped at Priority 4", () => {
    fc.assert(Props.prop_pick_priority4_non_function_const_skipped, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // SP14 — Priority 5: first method of first ClassDeclaration
  // -------------------------------------------------------------------------
  it("property: SP14 — first method of first ClassDeclaration selected at Priority 5", () => {
    fc.assert(Props.prop_pick_priority5_first_class_method, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // SP15 — Priority 5: empty class skips to undefined
  // -------------------------------------------------------------------------
  it("property: SP15 — empty ClassDeclaration with no methods returns undefined", () => {
    fc.assert(Props.prop_pick_priority5_empty_class_returns_undefined, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // SP16 — Priority 6: expression-only source returns undefined
  // -------------------------------------------------------------------------
  it("property: SP16 — expression-only source returns undefined at Priority 6", () => {
    fc.assert(Props.prop_pick_priority6_expression_only_returns_undefined, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // SP17 — Priority 6: empty source returns undefined
  // -------------------------------------------------------------------------
  it("property: SP17 — empty source returns undefined at Priority 6", () => {
    fc.assert(Props.prop_pick_priority6_empty_source_returns_undefined, { numRuns: 10 });
  });

  // -------------------------------------------------------------------------
  // SP18 — isExported correctness
  // -------------------------------------------------------------------------
  it("property: SP18 — isExported partitions exported vs non-exported correctly", () => {
    fc.assert(Props.prop_pick_isexported_selects_exported_over_earlier_nonexported, {
      numRuns: 50,
    });
  });

  // -------------------------------------------------------------------------
  // SP19 — getFirstInitializer: non-function initializer skipped
  // -------------------------------------------------------------------------
  it("property: SP19 — getFirstInitializer skips non-function initializers", () => {
    fc.assert(Props.prop_pick_getFirstInitializer_non_function_init_skipped, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // Compound interaction: full priority chain traversal
  // -------------------------------------------------------------------------
  it("property: compound — Priority 1 beats Priority 2 beats Priority 4 in mixed source", () => {
    fc.assert(Props.prop_pick_compound_priority_chain_with_mixed_source, { numRuns: 50 });
  });
});
