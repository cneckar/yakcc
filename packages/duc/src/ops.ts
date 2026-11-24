// SPDX-License-Identifier: Apache-2.0
/**
 * Operations named by meaning (DEC-DUC-CROSS-LANGUAGE-OPS-001, #1310).
 *
 * A graph's operation labels name what an operation means, not the symbol a language writes for it:
 * generic wherever the meaning is shared across languages (`f64.add`, `str.concat`, `mod.floored`),
 * per-language only where it is unique (`js.add`, ECMAScript's `+` on operands of unknown type).
 *
 * A lowering that implements ECMAScript's semantics reads a graph through `ecmaScriptView`: each
 * operation becomes the ECMAScript operator it is a case of, written as ECMAScript writes it
 * (`js.add`, `f64.add` and `str.concat` are each a case of `+`), so the lowering keeps working as the
 * vocabulary grows. A lowering that implements a generic operation natively reads the graph as it is.
 */
import type { DucGraph, DucNode } from "./types.js";

/**
 * ECMAScript's operators as the graph names them: symbol (as ECMAScript writes it, or the lifter's
 * own name for it), arity, operation. The symbol is never stored; a lowering reads it back through
 * `ecmaScriptView`.
 */
const JS_OPERATORS: readonly (readonly [string, 1 | 2, string])[] = [
  ["+", 2, "js.add"],
  ["-", 2, "js.sub"],
  ["*", 2, "js.mul"],
  ["/", 2, "js.div"],
  ["%", 2, "js.rem"],
  ["**", 2, "js.pow"],
  ["==", 2, "js.loose_eq"],
  ["!=", 2, "js.loose_ne"],
  ["===", 2, "js.strict_eq"],
  ["!==", 2, "js.strict_ne"],
  ["<", 2, "js.lt"],
  [">", 2, "js.gt"],
  ["<=", 2, "js.le"],
  [">=", 2, "js.ge"],
  ["&", 2, "js.bitand"],
  ["|", 2, "js.bitor"],
  ["^", 2, "js.bitxor"],
  ["<<", 2, "js.shl"],
  [">>", 2, "js.sar"],
  [">>>", 2, "js.shr"],
  ["&&", 2, "js.and"],
  ["||", 2, "js.or"],
  ["??", 2, "js.nullish"],
  ["in", 2, "js.in"],
  ["instanceof", 2, "js.instanceof"],
  // A compound assignment's value: `x += e` is the operation, then a write of its result.
  ["+=", 2, "js.add_assign"],
  ["-=", 2, "js.sub_assign"],
  ["*=", 2, "js.mul_assign"],
  ["/=", 2, "js.div_assign"],
  ["%=", 2, "js.rem_assign"],
  ["**=", 2, "js.pow_assign"],
  ["&=", 2, "js.bitand_assign"],
  ["|=", 2, "js.bitor_assign"],
  ["^=", 2, "js.bitxor_assign"],
  ["<<=", 2, "js.shl_assign"],
  [">>=", 2, "js.sar_assign"],
  [">>>=", 2, "js.shr_assign"],
  ["&&=", 2, "js.and_assign"],
  ["||=", 2, "js.or_assign"],
  ["??=", 2, "js.nullish_assign"],
  ["!", 1, "js.not"],
  ["~", 1, "js.bitnot"],
  ["-", 1, "js.neg"],
  ["+", 1, "js.tonumber"],
  ["++", 1, "js.inc"],
  ["--", 1, "js.dec"],
  ["post++", 1, "js.postinc"],
  ["post--", 1, "js.postdec"],
  ["TypeOfExpression", 1, "js.typeof"],
  ["VoidExpression", 1, "js.void"],
];

const JS_NAME = new Map(JS_OPERATORS.map(([symbol, arity, name]) => [`${arity}${symbol}`, name]));

/**
 * The generic operations (#1310, step 2b), each with the ECMAScript operator it is a case of on the
 * operands it is chosen for. `byMeaning` chooses them; nothing else writes them from ECMAScript.
 */
export const GENERIC_OPERATIONS: ReadonlyMap<string, string> = new Map([
  ["f64.add", "+"],
  ["f64.sub", "-"],
  ["f64.mul", "*"],
  ["f64.div", "/"],
  ["f64.neg", "-"],
  ["f64.eq", "==="],
  ["f64.ne", "!=="],
  ["f64.lt", "<"],
  ["f64.gt", ">"],
  ["f64.le", "<="],
  ["f64.ge", ">="],
  ["rem.truncated", "%"],
  ["str.concat", "+"],
  ["str.eq", "==="],
  ["str.ne", "!=="],
  ["bool.not", "!"],
  ["bool.eq", "==="],
  ["bool.ne", "!=="],
  ["str.length.units16", ".length"],
  ["list.length", ".length"],
  ["list.get", "ElementAccess"],
]);

const ECMASCRIPT_OF: ReadonlyMap<string, string> = new Map([
  ...JS_OPERATORS.map(([symbol, , name]) => [name, symbol] as const),
  ...GENERIC_OPERATIONS,
]);

/**
 * The operation ECMAScript's operator `symbol` is when applied to `arity` operands, of types not
 * known: `js.add` for binary `+`, `js.neg` for unary `-`. A label that is not one of ECMAScript's
 * operators is returned as it is.
 */
export function jsOperation(symbol: string, arity: number): string {
  return JS_NAME.get(`${arity}${symbol}`) ?? symbol;
}

/** The ECMAScript operator a label is a case of, as ECMAScript writes it: itself, for any other label. */
export function ecmaScriptLabel(label: string): string {
  return ECMASCRIPT_OF.get(label) ?? label;
}

/**
 * The graph as a lowering of ECMAScript's semantics reads it: every operation as the ECMAScript
 * operator it is a case of, closures included. The same graph object when nothing changes.
 */
export function ecmaScriptView(g: DucGraph): DucGraph {
  let changed = false;
  const nodes = g.nodes.map((n): DucNode => {
    const label = n.kind === "op" && n.label !== undefined ? ecmaScriptLabel(n.label) : n.label;
    const closure = n.closure !== undefined ? ecmaScriptView(n.closure) : undefined;
    if (label === n.label && closure === n.closure) return n;
    changed = true;
    return {
      ...n,
      ...(label !== undefined ? { label } : {}),
      ...(closure !== undefined ? { closure } : {}),
    };
  });
  return changed ? { ...g, nodes } : g;
}

/**
 * A node with its ECMAScript operator symbol named as an operation (`+` on two operands is `js.add`),
 * its closure's too: for a graph written by hand or by a model in ECMAScript's symbols. The same node
 * when nothing changes.
 */
export function namedOperation(n: DucNode): DucNode {
  // An ordered operation's last input is the heap token, not an operand.
  const arity = n.inputs.length - (n.order === 1 ? 1 : 0);
  const label = n.kind === "op" && n.label !== undefined ? jsOperation(n.label, arity) : n.label;
  const closure = n.closure !== undefined ? namedOperations(n.closure) : undefined;
  if (label === n.label && closure === n.closure) return n;
  return {
    ...n,
    ...(label !== undefined ? { label } : {}),
    ...(closure !== undefined ? { closure } : {}),
  };
}

/** The graph with every node's operator named, as `namedOperation`. The same graph when unchanged. */
export function namedOperations(g: DucGraph): DucGraph {
  const nodes = g.nodes.map(namedOperation);
  return nodes.some((n, i) => n !== g.nodes[i]) ? { ...g, nodes } : g;
}
