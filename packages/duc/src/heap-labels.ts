// SPDX-License-Identifier: Apache-2.0
/**
 * Which operations are heap operations (#1285): those whose place among the others is structure.
 * The lifter orders them by the heap token, and the line form threads the token through those a
 * program writes without one (#1288).
 */
import { ecmaScriptLabel } from "./ops.js";

const HEAP_LABELS = new Set([
  "delete[]",
  "CallExpression",
  "CallExpression?.",
  "NewExpression",
  "ElementAccess",
  "[]=",
  "in",
  "instanceof",
  "...",
  "AwaitExpression",
  "YieldExpression",
  "YieldExpression*",
  "TaggedTemplateExpression",
  "DeleteExpression",
]);

/**
 * Whether an operation reads or writes shared state, so its place among the others is structure: a
 * call, `new`, a member read or write, `in`, a spread, an opaque summary (its label has a hash).
 */
export function isHeapLabel(named: string): boolean {
  const label = ecmaScriptLabel(named);
  return (
    HEAP_LABELS.has(label) ||
    label.includes("#") ||
    label.startsWith("?.") ||
    label.startsWith("delete.") ||
    label.startsWith("super.") ||
    label === "super[]" ||
    label.startsWith("ElementAccess") ||
    (label.startsWith(".") && label.length > 1)
  );
}
