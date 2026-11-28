// SPDX-License-Identifier: Apache-2.0
/**
 * Statics natively (#1369): C's and C++'s variables with static storage (globals, file-scope and
 * function-local statics, vtables), which raised atoms reach through the `__ykStatic(key)` leaf.
 * Each static a program's atoms reach becomes, in the module that reaches them, a cell and a getter
 * written over the memory leaves (as raise-c's JavaScript `__ykStatic` defines them): its block
 * allocated at its first use, its address kept before its initializer runs (an initializer may
 * point at its own static), each initial item stored. The module records each key's getter, and
 * the lowering calls it where `__ykStatic(key)` is called. Nothing is added to the runtime: the getters are atoms, lowered as the rest are.
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

/** The keys a graph's `__ykStatic("key")` calls read (a call inside a loop, its callee an invariant). */
function staticKeys(g: DucGraph): string[] {
  const producer = new Map<ValueId, DucNode>();
  for (const n of g.nodes) for (const v of n.outputs) producer.set(v, n);
  const alias = new Map<ValueId, ValueId>();
  for (const n of g.nodes) {
    const rec = n.loop;
    if (n.kind !== "loop" || rec === undefined) continue;
    const offset = rec.carry.length + (rec.iterate !== undefined ? 1 : 0);
    rec.invariant.forEach((v, j) => alias.set(v, n.inputs[offset + j] as ValueId));
  }
  const resolve = (v: ValueId): ValueId => {
    const a = alias.get(v);
    return a === undefined ? v : resolve(a);
  };
  const keys: string[] = [];
  for (const n of g.nodes) {
    // Its callee and key (an ordered call's last input is its heap token).
    if (n.kind !== "op" || n.label !== "CallExpression" || n.inputs.length < 2) continue;
    const callee = producer.get(resolve(n.inputs[0] as ValueId));
    if (callee?.kind !== "diamond-source" || callee.diamond?.symbol !== "__ykStatic") continue;
    const arg = producer.get(resolve(n.inputs[1] as ValueId));
    const text = arg?.kind === "literal-source" ? (arg.label ?? "") : "";
    if (text.startsWith('"')) keys.push(JSON.parse(text) as string);
  }
  return keys;
}

/**
 * The modules with their statics: each static they reach (and each one those reach) a cell and a
 * getter in the one module that reaches them, the module's `statics` naming each key's getter.
 */
export function withStatics(
  modules: readonly NativeModule[],
  statics: ReadonlyMap<string, StaticDef>,
): NativeModule[] {
  const used = modules.map((mod) => {
    const keys = new Set<string>();
    for (const st of mod.statements) for (const k of staticKeys(st.graph)) keys.add(k);
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
  return modules.map((mod, i) =>
    i !== owner
      ? mod
      : {
          ...mod,
          statements: [
            ...added.filter((s) => s.kind === "statement"),
            ...added.filter((s) => s.kind === "function"),
            ...mod.statements,
          ],
          statics: Object.fromEntries(keys.map((k) => [k, getter(k)])),
        },
  );
}
