// SPDX-License-Identifier: Apache-2.0
/**
 * A parameter's label is its index in the interface; a rest parameter's (`...xs`, the arguments
 * from there on as an array) is its index then `...` (#1276).
 */

/**
 * The mark of a parameter declared a primitive (`0:prim`, #1370): an operator on it converts no
 * object, so it is not ordered. It comes after the index and before `...` or `=`.
 */
export const PRIMITIVE_PARAM = ":prim";

/** How a lowering to JavaScript writes the mark after the parameter's name (a Flow comment type). */
export const PRIMITIVE_COMMENT = "/*: primitive */";

/** Whether a parameter is declared a primitive. */
export function isPrimitiveParam(label: string | undefined): boolean {
  return label?.includes(PRIMITIVE_PARAM) === true;
}

/** The index of a parameter, from its label. */
export function paramIndex(label: string | undefined): number {
  return Number.parseInt(label ?? "", 10);
}

/** Whether a parameter is a rest parameter. */
export function isRestParam(label: string | undefined): boolean {
  return label?.endsWith("...") === true;
}

/**
 * Whether a parameter has a default (`b = 1`): its index then `=` (#1370). The default itself is in
 * the body, applied when the argument is undefined; the mark is what a function's `length` needs.
 */
export function isDefaultedParam(label: string | undefined): boolean {
  return label?.endsWith("=") === true;
}

/**
 * ExpectedArgumentCount (ECMA-262 15.1.5), a function's `length`: its own parameters (those after
 * the `captures` it is made with) before the first that has a default or is a rest parameter.
 */
export function expectedArgumentCount(
  params: readonly { readonly label?: string }[],
  captures: number,
): number {
  const own = params
    .filter((p) => paramIndex(p.label) >= captures)
    .sort((a, b) => paramIndex(a.label) - paramIndex(b.label));
  const first = own.findIndex((p) => isRestParam(p.label) || isDefaultedParam(p.label));
  return first < 0 ? own.length : first;
}
