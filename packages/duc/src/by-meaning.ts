// SPDX-License-Identifier: Apache-2.0
/**
 * Operations chosen by meaning (DEC-DUC-CROSS-LANGUAGE-OPS-001, #1310 step 2).
 *
 * ECMAScript's `a + b` is `f64.add` when both operands are numbers, `str.concat` when both are
 * strings, and `js.add` otherwise. Which it is depends on the operands' types, so the choice is made
 * from the contract's types alone, by the type inference over the graph (#1277): the same graph and
 * the same contract always give the same operations, and a receiver checks a graph by choosing again.
 *
 * A closure is chosen under the types it is made with: its captures' types, and its own parameters'
 * when every use of it is a call whose arguments' types are known (`closureSignature`).
 */
import { canonicalizeGraph } from "./canonical.js";
import { type DucType, type Signature, inferTypes, parseType, union } from "./infer-types.js";
import { ecmaScriptLabel, ecmaScriptView, jsOperation } from "./ops.js";
import { isRestParam } from "./params.js";
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
  const uses = usesOf(input);
  // Values read other than as a node's input: returned, carried to a loop's next pass, a condition.
  const outside = new Set<ValueId>([
    ...input.obs,
    ...(input.branches ?? []).map((b) => b.cond),
    ...input.nodes.flatMap((n) =>
      n.loop !== undefined
        ? [...n.loop.next, ...(n.loop.cond !== undefined ? [n.loop.cond] : [])]
        : [],
    ),
  ]);
  const nodes = input.nodes.map((n): DucNode => {
    if (n.closure !== undefined) {
      // A closure is chosen under the types it is made and called with (#1310).
      const closure = byMeaning(n.closure, closureSignature(n, n.closure, types, uses, outside));
      if (closure === n.closure) return n;
      changed = true;
      return { ...n, closure };
    }
    if (n.kind !== "op" || n.label === undefined) return n;
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

const UNKNOWN: DucType = { k: "unknown" };
const UNDEFINED: DucType = { k: "undefined" };
const INTEGER: DucType = { k: "num", n: "integer" };

/** Array methods whose callback is called with (element, index, array). */
const CALLBACK_METHODS = new Set([
  ".map",
  ".filter",
  ".forEach",
  ".some",
  ".every",
  ".find",
  ".findIndex",
  ".findLast",
  ".findLastIndex",
  ".flatMap",
]);

type Uses = ReadonlyMap<ValueId, readonly DucNode[]>;

/** The nodes that read each value as an input. */
function usesOf(g: DucGraph): Uses {
  const uses = new Map<ValueId, DucNode[]>();
  for (const n of g.nodes)
    for (const v of new Set(n.inputs)) {
      const list = uses.get(v) ?? [];
      list.push(n);
      uses.set(v, list);
    }
  return uses;
}

/**
 * The types a closure is chosen under: first its captures' (the types of its node's inputs), then
 * its own parameters'. A parameter's type is the union of what every call passes it, when every use
 * of the closure is a call: called directly, or as an array method's callback on an array whose
 * element type is known (element, index, array), reached through loop invariants. Any other use
 * (the closure stored, returned, passed elsewhere), a rest parameter, or a call of itself from
 * inside leaves its own parameters unknown: the types of all its calls are not known here.
 */
function closureSignature(
  node: DucNode,
  closure: DucGraph,
  types: ReadonlyMap<ValueId, DucType>,
  uses: Uses,
  outside: ReadonlySet<ValueId>,
): Signature {
  const captures = node.inputs.map((v) => types.get(v) ?? UNKNOWN);
  const params = closure.nodes.filter((p) => p.kind === "param-source");
  const own = params.length - captures.length;
  const unknown = (): Signature => ({
    inputs: [...captures, ...Array.from({ length: Math.max(own, 0) }, () => UNKNOWN)],
  });
  const out = node.outputs[0];
  if (own <= 0 || out === undefined) return { inputs: captures };
  if (params.some((p) => isRestParam(p.label))) return unknown();
  if (closure.nodes.some((p) => p.label === "function-self")) return unknown();
  const passed: DucType[][] = Array.from({ length: own }, () => []);
  const producer = new Map<ValueId, DucNode>();
  for (const [, users] of uses)
    for (const u of users) for (const v of u.outputs) producer.set(v, u);
  const record = (args: readonly DucType[]): void => {
    for (let k = 0; k < own; k++) passed[k]?.push(args[k] ?? UNDEFINED);
  };
  const reach = (v: ValueId, seen: Set<ValueId>): boolean => {
    if (seen.has(v)) return true;
    seen.add(v);
    if (outside.has(v)) return false;
    for (const user of uses.get(v) ?? []) {
      const operands = user.inputs.slice(0, user.inputs.length - (user.order === 1 ? 1 : 0));
      const label = ecmaScriptLabel(user.label ?? "");
      for (const [i, input] of operands.entries()) {
        if (input !== v) continue;
        const call =
          user.kind === "op" && (label === "CallExpression" || label === "CallExpression?.");
        if (call && i === 0) {
          record(operands.slice(1).map((a) => types.get(a) ?? UNKNOWN));
          continue;
        }
        const member = call && i === 1 ? producer.get(operands[0] as ValueId) : undefined;
        const receiver = member?.inputs[0];
        const array = receiver !== undefined ? types.get(receiver) : undefined;
        if (
          member !== undefined &&
          member.kind === "op" &&
          CALLBACK_METHODS.has(member.label ?? "") &&
          array?.k === "array" &&
          array.of !== undefined
        ) {
          record([array.of, INTEGER, array]);
          continue;
        }
        const loop = user.loop;
        if (user.kind === "loop" && loop !== undefined) {
          const offset = loop.carry.length + (loop.iterate !== undefined ? 1 : 0);
          const inner = loop.invariant[i - offset];
          if (i >= offset && inner !== undefined && reach(inner, seen)) continue;
        }
        return false;
      }
    }
    return true;
  };
  if (!reach(out, new Set()) || passed.every((p) => p.length === 0)) return unknown();
  return { inputs: [...captures, ...passed.map((p) => union(p))] };
}
