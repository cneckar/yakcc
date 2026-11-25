// SPDX-License-Identifier: Apache-2.0
/**
 * The operations that are references (DEC-DUC-OPERATIONS-AS-ATOMS-001, #1362), by label: the table
 * alone, with nothing of the atom library it names. A graph's links (`root.ts`) read it, and so does
 * everything that only asks whether a label is a reference; the atoms themselves are `operations.ts`.
 */
/** An operation a graph names by a label that is a reference to an atom. */
export interface OperationReference {
  /** The label, as a graph writes it: `Math.sin`. */
  readonly label: string;
  /** The atom implementing it, by its name in the atom library. */
  readonly atom: string;
  /** The number of arguments the operation takes. */
  readonly arity: number;
}

const UNARY_MATH = [
  "acos",
  "acosh",
  "asin",
  "asinh",
  "atan",
  "atanh",
  "cbrt",
  "cos",
  "cosh",
  "exp",
  "expm1",
  "log",
  "log1p",
  "log10",
  "log2",
  "sin",
  "sinh",
  "tan",
  "tanh",
];
const BINARY_MATH = ["atan2", "pow"];

/** Every operation reference, by label. */
export const OPERATION_REFERENCES: ReadonlyMap<string, OperationReference> = new Map(
  [
    ...UNARY_MATH.map((f) => ({ label: `Math.${f}`, atom: f, arity: 1 })),
    ...BINARY_MATH.map((f) => ({ label: `Math.${f}`, atom: f, arity: 2 })),
  ].map((r) => [r.label, r]),
);

/** The operation a label references, or undefined for any other label. */
export function operationReference(label: string | undefined): OperationReference | undefined {
  return label === undefined ? undefined : OPERATION_REFERENCES.get(label);
}

/** The operation `Math.<member>` called with `arity` arguments is, if it is a reference. */
export function mathOperation(member: string, arity: number): OperationReference | undefined {
  const ref = OPERATION_REFERENCES.get(`Math.${member}`);
  return ref !== undefined && ref.arity === arity ? ref : undefined;
}
