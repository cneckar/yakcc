// SPDX-License-Identifier: Apache-2.0
/**
 * A parameter's label is its index in the interface; a rest parameter's (`...xs`, the arguments
 * from there on as an array) is its index then `...` (#1276).
 */

/** The index of a parameter, from its label. */
export function paramIndex(label: string | undefined): number {
  return Number.parseInt(label ?? "", 10);
}

/** Whether a parameter is a rest parameter. */
export function isRestParam(label: string | undefined): boolean {
  return label?.endsWith("...") === true;
}
