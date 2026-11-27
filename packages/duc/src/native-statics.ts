// SPDX-License-Identifier: Apache-2.0
/**
 * Statics natively (#1369): C's and C++'s variables with static storage (globals, file-scope and
 * function-local statics, vtables), which raised atoms reach through the `__ykStatic(key)` leaf.
 * Each static a program's atoms reach becomes, in the module that reaches them, a cell and a getter
 * written over the memory leaves (as raise-c's JavaScript `__ykStatic` defines them): its block
 * allocated at its first use, its address kept before its initializer runs (an initializer may
 * point at its own static), each initial item stored. Each `__ykStatic(key)` call is rewritten to
 * its getter's. Nothing is added to the runtime: the getters are atoms, lowered as the rest are.
 */
import type { NativeModule, NativeModuleStatement } from "./emit-llvm-boxed.js";
import { LlvmEmitError } from "./emit-llvm.js";
import { liftAtom } from "./lift.js";
import type { StaticDef } from "./raise-c.js";
import type { DucGraph, DucNode, ValueId } from "./types.js";

const STORE: Readonly<Record<string, string>> = {
  i8: "__ykStore8",
  u8: "__ykStore8",
  i16: "__ykStore16",
  u16: "__ykStore16",
  i32: "__ykStore32",
  u32: "__ykStore32",
  i64: "__ykStore64",
  u64: "__ykStore64",
  f64: "__ykStoreF64",
  f32: "__ykStoreF32",
};

const numberLiteral = (x: number): string =>
  Object.is(x, -0)
    ? "-0"
    : Number.isNaN(x)
      ? "NaN"
      : x === Number.POSITIVE_INFINITY
        ? "Infinity"
        : x === Number.NEGATIVE_INFINITY
          ? "-Infinity"
          : String(x);
const valueLiteral = (x: number | bigint, big: boolean): string =>
  big ? `${BigInt(x)}n` : numberLiteral(Number(x));

/** The key a node reads, when it is a `__ykStatic("key")` call. */
function staticKey(g: DucGraph, n: DucNode): string | undefined {
  if (n.kind !== "op" || n.label !== "CallExpression" || n.inputs.length !== 2) return undefined;
  const by = (v: ValueId): DucNode | undefined => g.nodes.find((x) => x.outputs.includes(v));
  const callee = by(n.inputs[0] as ValueId);
  if (callee?.kind !== "diamond-source" || callee.diamond?.symbol !== "__ykStatic")
    return undefined;
  const arg = by(n.inputs[1] as ValueId);
  const text = arg?.kind === "literal-source" ? (arg.label ?? "") : "";
  return text.startsWith('"') ? (JSON.parse(text) as string) : undefined;
}

/**
 * The modules with their statics: each static they reach (and each one those reach) a cell and a
 * getter in the one module that reaches them, each `__ykStatic(key)` call its getter's.
 */
export function withStatics(
  modules: readonly NativeModule[],
  statics: ReadonlyMap<string, StaticDef>,
): NativeModule[] {
  const used = modules.map((mod) => {
    const keys = new Set<string>();
    for (const st of mod.statements)
      for (const n of st.graph.nodes) {
        const k = staticKey(st.graph, n);
        if (k !== undefined) keys.add(k);
      }
    return keys;
  });
  const owners = used.flatMap((k, i) => (k.size > 0 ? [i] : []));
  if (owners.length === 0) return [...modules];
  if (owners.length > 1)
    throw new LlvmEmitError("statics reached from more than one module are not in the subset yet");
  const owner = owners[0] as number;
  // The statics reached, through their initializers' references too.
  const keys = [...(used[owner] as Set<string>)];
  for (let i = 0; i < keys.length; i++)
    for (const item of statics.get(keys[i] as string)?.init ?? [])
      if ("static" in item && !keys.includes(item.static)) keys.push(item.static);
  const cell = new Map(keys.map((k, i) => [k, `yk$static$${i}`] as const));
  const getter = (k: string): string => `${cell.get(k) as string}$get`;
  const added: NativeModuleStatement[] = [];
  for (const k of keys) {
    added.push({
      kind: "statement",
      declares: [cell.get(k) as string],
      graph: liftAtom(`let ${cell.get(k) as string} = 0;`),
    });
  }
  for (const k of keys) {
    const def = statics.get(k);
    const c = cell.get(k) as string;
    let body: string;
    if (def === undefined)
      body = `throw new Error(${JSON.stringify(`memory trap: no definition of the static ${k}`)});`;
    else if (def.at !== undefined) body = `return ${def.at};`;
    else {
      const items = def.init.map((item) => {
        const at = `(a + ${item.offset})`;
        if ("value" in item) {
          const store = STORE[item.kind];
          if (store === undefined) throw new LlvmEmitError(`a static item of kind ${item.kind}`);
          return `${store}(${at}, ${valueLiteral(item.value, item.kind === "i64" || item.kind === "u64")});`;
        }
        if ("static" in item)
          return `__ykStore64(${at}, __ykNumToBig(${getter(item.static)}() + ${item.addend}));`;
        if ("fn" in item) return `__ykStore64(${at}, __ykNumToBig(__ykFnAddr(${item.fn})));`;
        const big = item.data.kind === "i64" || item.data.kind === "u64";
        return `__ykStore64(${at}, __ykNumToBig(__ykData(${JSON.stringify(item.data.kind)}, [${item.data.values.map((x) => valueLiteral(x, big)).join(", ")}])));`;
      });
      body = `if (${c} !== 0) return ${c}; const a = __ykAlloc(${def.size}, ${def.align}); ${c} = a; ${items.join(" ")} return a;`;
    }
    added.push({
      kind: "function",
      declares: [getter(k)],
      graph: liftAtom(`export function f(): number { ${body} }`),
    });
  }
  const rewrite = (g: DucGraph): DucGraph => {
    const calls = g.nodes.flatMap((n) => {
      const k = staticKey(g, n);
      return k === undefined ? [] : [[n, k] as const];
    });
    if (calls.length === 0) return g;
    const extra: DucNode[] = [];
    const replaced = new Map<string, DucNode>();
    calls.forEach(([n, k], j) => {
      const v = `vstatic${j}` as ValueId;
      extra.push({
        id: `nstatic${j}`,
        kind: "diamond-source",
        inputs: [],
        outputs: [v],
        diamond: { reason: "free-identifier", symbol: getter(k) },
      } as unknown as DucNode);
      replaced.set(n.id, { ...n, inputs: [v] });
    });
    return { ...g, nodes: [...g.nodes.map((n) => replaced.get(n.id) ?? n), ...extra] };
  };
  return modules.map((mod, i) =>
    i !== owner
      ? mod
      : {
          ...mod,
          statements: [
            ...added.filter((s) => s.kind === "statement"),
            ...added.filter((s) => s.kind === "function"),
            ...mod.statements.map((st) => ({ ...st, graph: rewrite(st.graph) })),
          ],
        },
  );
}
