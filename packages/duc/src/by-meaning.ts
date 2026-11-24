// SPDX-License-Identifier: Apache-2.0
/**
 * Operations chosen by meaning (DEC-DUC-CROSS-LANGUAGE-OPS-001, #1310 step 2).
 *
 * ECMAScript's `a + b` is `f64.add` when both operands are numbers, `str.concat` when both are
 * strings, and `js.add` otherwise. Which it is depends on the operands' types, so the choice is made
 * from the contract's types alone, by the type inference over the graph (#1277): the same graph and
 * the same contract always give the same operations, and a receiver checks a graph by choosing again.
 *
 * Closures keep ECMAScript's operations for now: a closure's types are inferred at each call, not
 * once.
 */
import { canonicalizeGraph } from "./canonical.js";
import { type DucType, type Signature, inferTypes, parseType } from "./infer-types.js";
import { ecmaScriptLabel, ecmaScriptView, jsOperation } from "./ops.js";
import type { DucGraph, DucNode, ValueId } from "./types.js";

type Kind = "num" | "string" | "boolean" | "array";

/** The type of a value when it is exactly one of the kinds generic operations are chosen for. */
function kindOf(t: DucType | undefined): Kind | undefined {
  if (t === undefined) return undefined;
  return t.k === "num" || t.k === "string" || t.k === "boolean" || t.k === "array"
    ? t.k
    : undefined;
}

/** Binary operators: ECMAScript's symbol, the operands' kind, the generic operation. */
const BINARY: Readonly<Record<string, Partial<Record<Kind, string>>>> = {
  "+": { num: "f64.add", string: "str.concat" },
  "-": { num: "f64.sub" },
  "*": { num: "f64.mul" },
  "/": { num: "f64.div" },
  "%": { num: "rem.truncated" },
  "===": { num: "f64.eq", string: "str.eq", boolean: "bool.eq" },
  "!==": { num: "f64.ne", string: "str.ne", boolean: "bool.ne" },
  "<": { num: "f64.lt" },
  ">": { num: "f64.gt" },
  "<=": { num: "f64.le" },
  ">=": { num: "f64.ge" },
};

/** Unary operators and member reads: ECMAScript's label, the operand's kind, the generic operation. */
const UNARY: Readonly<Record<string, Partial<Record<Kind, string>>>> = {
  "-": { num: "f64.neg" },
  "!": { boolean: "bool.not" },
  ".length": { string: "str.length.units16", array: "list.length" },
};

/** The generic operation an ECMAScript operation is on operands of these types, if there is one. */
function meaningOf(label: string, operands: readonly (Kind | undefined)[]): string | undefined {
  const [a, b] = operands;
  if (a === undefined) return undefined;
  if (operands.length === 1) return UNARY[label]?.[a];
  if (operands.length !== 2 || b === undefined) return undefined;
  if (label === "ElementAccess") return a === "array" && b === "num" ? "list.get" : undefined;
  return a === b ? BINARY[label]?.[a] : undefined;
}

/**
 * The graph with each operation named by its meaning on the operand types the contract gives, and
 * every other operation as ECMAScript's (`js.add`). The same graph and contract give the same graph,
 * whichever of these names it was given in: choosing is idempotent.
 */
export function byMeaning(input: DucGraph, sig: Signature): DucGraph {
  const g = ecmaScriptView(input);
  const { types } = inferTypes(g, sig);
  const kind = (v: ValueId): Kind | undefined => kindOf(types.get(v));
  let changed = false;
  const nodes = input.nodes.map((n): DucNode => {
    if (n.kind !== "op" || n.label === undefined || n.closure !== undefined) return n;
    const symbol = ecmaScriptLabel(n.label);
    // An ordered operation's last input is the heap token, not an operand.
    const operands = n.inputs.slice(0, n.inputs.length - (n.order === 1 ? 1 : 0));
    const generic = meaningOf(symbol, operands.map(kind));
    // Not generic on these operands: ECMAScript's own operation, whatever it was given as.
    const label = generic ?? jsOperation(symbol, operands.length);
    if (label === n.label) return n;
    changed = true;
    return { ...n, label };
  });
  if (!changed) return input;
  const graph = canonicalizeGraph(nodes, input.obs, input.branches ?? []);
  return input.mode !== undefined ? { ...graph, mode: input.mode } : graph;
}

/** A contract's interface as the inference reads it: its input types, and its output's when it has one. */
export function contractSignature(spec: {
  readonly inputs: readonly { readonly type: string }[];
  readonly outputs: readonly { readonly type: string }[];
}): Signature {
  const output = spec.outputs[0]?.type;
  return {
    inputs: spec.inputs.map((p) => parseType(p.type)),
    ...(output !== undefined ? { output: parseType(output) } : {}),
  };
}
