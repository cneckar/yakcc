// SPDX-License-Identifier: Apache-2.0
/**
 * Which operations are heap operations (#1285): those whose place among the others is structure.
 * The lifter orders them by the heap token, and the line form threads the token through those a
 * program writes without one (#1288).
 */
import { ecmaScriptLabel, jsOperation } from "./ops.js";

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

/**
 * The operations that convert an operand with ToPrimitive, ToNumeric or ToString (#1370): on an
 * object they call its `valueOf`, `toString` or `Symbol.toPrimitive`, and they throw on a Symbol,
 * or on a BigInt mixed with a Number. `template` is a template literal with substitutions.
 */
export const TO_PRIMITIVE_OPERATIONS = new Set([
  "js.add",
  "js.sub",
  "js.mul",
  "js.div",
  "js.rem",
  "js.pow",
  "js.lt",
  "js.gt",
  "js.le",
  "js.ge",
  "js.loose_eq",
  "js.loose_ne",
  "js.shl",
  "js.sar",
  "js.shr",
  "js.bitand",
  "js.bitor",
  "js.bitxor",
  "js.neg",
  "js.tonumber",
  "js.bitnot",
  "js.inc",
  "js.dec",
  "js.postinc",
  "js.postdec",
  "js.add_assign",
  "js.sub_assign",
  "js.mul_assign",
  "js.div_assign",
  "js.rem_assign",
  "js.pow_assign",
  "js.shl_assign",
  "js.sar_assign",
  "js.shr_assign",
  "js.bitand_assign",
  "js.bitor_assign",
  "js.bitxor_assign",
  "template",
]);

/**
 * Operations whose result is a primitive no operator throws on (a number, string or boolean, never
 * a BigInt or Symbol), whatever their operands: comparisons, `typeof`, `!`, `+x` (a Number, or a
 * throw).
 */
const SAFE_RESULTS = new Set([
  "js.lt",
  "js.gt",
  "js.le",
  "js.ge",
  "js.loose_eq",
  "js.loose_ne",
  "js.strict_eq",
  "js.strict_ne",
  "js.not",
  "js.typeof",
  "js.void",
  "js.in",
  "js.instanceof",
  "js.tonumber",
]);

/**
 * Whether an operation's result is certainly a primitive no operator converts by calling code or
 * throws on (#1370): a SAFE_RESULTS operation, a template, or an arithmetic one whose operands are
 * such primitives (on BigInts its result is a BigInt, which a Number operand throws on).
 */
export function primitiveResult(label: string, operandsPrimitive: () => boolean): boolean {
  if (label.startsWith("template:") || SAFE_RESULTS.has(label)) return true;
  return TO_PRIMITIVE_OPERATIONS.has(label) && operandsPrimitive();
}

/**
 * Whether a literal's label is such a primitive: a string, a number, a boolean, null or undefined;
 * not a BigInt (`1n`) nor a regular expression (`/a/`, an object).
 */
export function primitiveLiteral(label: string | undefined): boolean {
  if (label === undefined) return false;
  if (label.startsWith("/")) return false;
  if (/^(?:0[xXoObB])?[0-9a-fA-F_]+n$/.test(label)) return false;
  return label !== "Uninitialized";
}

/**
 * Whether an operator may run user code where it is (#1370): one that converts an operand that may
 * be an object, whose `valueOf`, `toString` or `Symbol.toPrimitive` then runs. It is ordered with
 * the heap operations. `x == null` and `x != null` convert nothing: null and undefined are loosely
 * equal only to each other. The lifter and the line form decide by this one rule.
 */
export function mayCallUserCode<V>(
  label: string,
  operands: readonly V[],
  isPrimitive: (v: V) => boolean,
  isNullish: (v: V) => boolean,
): boolean {
  const name = label.startsWith("template:") ? "template" : jsOperation(label, operands.length);
  if (!TO_PRIMITIVE_OPERATIONS.has(name)) return false;
  if ((name === "js.loose_eq" || name === "js.loose_ne") && operands.some(isNullish)) return false;
  return operands.some((v) => !isPrimitive(v));
}
