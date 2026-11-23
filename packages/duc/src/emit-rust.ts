// SPDX-License-Identifier: Apache-2.0
/**
 * Lowering a DUC graph to Rust (#1278, vision 2: the graph is lowered directly to each target).
 *
 * As in Go (emit-go.ts), every value is dynamic (`V`, see RUST_PRELUDE) and keeps JavaScript's
 * meaning. Each value is a `let mut` binding declared once; a join is declared before its `if` and
 * assigned on each side; a loop's carried values are assigned together at the end of an iteration;
 * a closure is a `V::Fun` over its own copies of what it captures. A name is read by cloning it
 * (an `Rc` for shared values).
 *
 * Anything else is refused with a reason (`RustEmitError`), never guessed.
 */
import { bodyPathOf, isPrefix, joinOwners, printLineForm, sidePath } from "./line-form.js";
import { loweringView } from "./ordering.js";
import { isRestParam, paramIndex } from "./params.js";
import type { DucBranch, DucGraph, DucLoop, DucNode, NodeId, ValueId } from "./types.js";

export { RUST_PRELUDE } from "./rust-prelude.js";

/** A table's own entry for a key: never one of Object.prototype's (`hasOwnProperty`, `constructor`). */
function entry<T>(table: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

export class RustEmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RustEmitError";
  }
}

const U = "V::Undef";
/** A missing argument: undefined, written apart from an undefined passed, so the raiser keeps arity. */
const NONE = "NONE";
const vec = (xs: readonly string[]): string => `vec![${xs.join(", ")}]`;

const METHODS: Record<string, (recv: string, args: readonly string[]) => string> = {
  trim: (r) => `trim(${r})`,
  toUpperCase: (r) => `to_upper(${r})`,
  toLowerCase: (r) => `to_lower(${r})`,
  startsWith: (r, a) => `starts_with(${r}, ${a[0] ?? NONE})`,
  endsWith: (r, a) => `ends_with(${r}, ${a[0] ?? NONE})`,
  includes: (r, a) => `includes(${r}, ${a[0] ?? NONE})`,
  indexOf: (r, a) => `index_of(${r}, ${a[0] ?? NONE})`,
  slice: (r, a) => `slice(${r}, ${a[0] ?? NONE}, ${a[1] ?? NONE})`,
  split: (r, a) => `split(${r}, ${a[0] ?? NONE})`,
  join: (r, a) => `join(${r}, ${a[0] ?? NONE})`,
  push: (r, a) => `push(${r}, ${vec(a)})`,
  map: (r, a) => `map_arr(${r}, ${a[0] ?? NONE})`,
  filter: (r, a) => `filter_arr(${r}, ${a[0] ?? NONE})`,
  some: (r, a) => `some_arr(${r}, ${a[0] ?? NONE})`,
  every: (r, a) => `every_arr(${r}, ${a[0] ?? NONE})`,
  reduce: (r, a) => `reduce_arr(${r}, ${vec(a)})`,
  toString: (r: string, a: readonly string[]) => `to_string_m(${r}, ${vec(a)})`,
  replace: (r, a) => `replace_str(${r}, ${a[0] ?? NONE}, ${a[1] ?? NONE})`,
  concat: (r, a) => `concat(${r}, ${vec(a)})`,
  substring: (r, a) => `substring(${r}, ${a[0] ?? NONE}, ${a[1] ?? NONE})`,
  forEach: (r, a) => `for_each_arr(${r}, ${a[0] ?? NONE})`,
  find: (r, a) => `find_arr(${r}, ${a[0] ?? NONE})`,
  findIndex: (r, a) => `find_index_arr(${r}, ${a[0] ?? NONE})`,
  charAt: (r, a) => `char_at(${r}, ${a[0] ?? NONE})`,
  charCodeAt: (r, a) => `char_code_at(${r}, ${a[0] ?? NONE})`,
  at: (r, a) => `at(${r}, ${a[0] ?? NONE})`,
  pop: (r) => `pop(${r})`,
  test: (r, a) => `re_test(${r}, ${a[0] ?? NONE})`,
  match: (r, a) => `match_str(${r}, ${a[0] ?? NONE})`,
  shift: (r) => `shift(${r})`,
  reverse: (r) => `reverse(${r})`,
};

const mathOf =
  (fn: string) =>
  (a: readonly string[]): string =>
    `math_${fn}(${a[0] ?? NONE})`;

const AMBIENT_MEMBERS: Record<string, Record<string, (args: readonly string[]) => string>> = {
  Math: {
    abs: mathOf("abs"),
    floor: mathOf("floor"),
    ceil: mathOf("ceil"),
    trunc: mathOf("trunc"),
    sqrt: mathOf("sqrt"),
    round: (a) => `round(${a[0] ?? NONE})`,
    max: (a) => `math_max(${vec(a)})`,
    min: (a) => `math_min(${vec(a)})`,
    pow: (a) => `math_pow(${a[0] ?? NONE}, ${a[1] ?? NONE})`,
  },
  Object: {
    keys: (a) => `object_keys(${a[0] ?? NONE})`,
    // Freezing changes nothing a lowered function can observe without a write to the frozen value.
    freeze: (a) => `freeze(${a[0] ?? NONE})`,
  },
  Array: { isArray: (a) => `is_array(${a[0] ?? NONE})` },
  Number: {
    isFinite: (a) => `is_finite_number(${a[0] ?? NONE})`,
    isInteger: (a) => `is_integer_number(${a[0] ?? NONE})`,
    isNaN: (a) => `is_nan_number(${a[0] ?? NONE})`,
  },
};

const AMBIENT_CALLS: Record<string, (args: readonly string[]) => string> = {
  __yakccTry: (a) => `try_catch(${vec(a)})`,
  String: (a) => `str_v(${a[0] ?? 's("")'})`,
  Number: (a) => `number_of(${a[0] ?? "n(0.0)"})`,
  Boolean: (a) => `boolean_of(${a[0] ?? NONE})`,
  parseInt: (a) => `parse_int(${a[0] ?? NONE}, ${a[1] ?? NONE})`,
  isNaN: (a) => `global_is_nan(${a[0] ?? NONE})`,
  isFinite: (a) => `global_is_finite(${a[0] ?? NONE})`,
  RegExp: (a) => `re_call(${a[0] ?? NONE}, ${a[1] ?? NONE})`,
};

const PLATFORM_VALUES: Record<string, string> = {
  parseInt: "fn_parse_int()",
  String: "fn_string()",
  Number: "fn_number()",
  Boolean: "fn_boolean()",
  Infinity: "n(f64::INFINITY)",
  NaN: "n(f64::NAN)",
};

const ERRORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError"]);

const isMemberRead = (label: string): boolean =>
  (label.startsWith(".") || label.startsWith("?.")) && !label.endsWith("=") && label !== "...";

/** A Rust string literal: the text's characters, escaped. */
function rustString(text: string): string {
  let out = '"';
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (ch === '"' || ch === "\\") out += `\\${ch}`;
    else if (c < 0x20 || c === 0x7f) out += `\\u{${c.toString(16)}}`;
    else out += ch;
  }
  return `${out}"`;
}

function literal(label: string): string {
  if (label.startsWith("/") && label.lastIndexOf("/") > 0) {
    const end = label.lastIndexOf("/");
    const body = label.slice(1, end);
    const flags = label.slice(end + 1);
    // The prelude's matcher reads JavaScript's syntax but for lookbehind, property escapes and
    // named back references; a sticky or unicode-sets regex is refused too.
    if (/\(\?<[=!]|\\[pPk]/.test(body) || /[yv]/.test(flags))
      throw new RustEmitError(`the regular expression ${label} has no Rust form here`);
    return `re(${rustString(body)}, ${rustString(flags)})`;
  }
  if (label === "true" || label === "false") return `B(${label})`;
  if (label === "null") return "V::Null";
  if (label === "undefined" || label === "Uninitialized") return U;
  if (label.startsWith('"')) return `s(${rustString(JSON.parse(label) as string)})`;
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(label)) {
    const f = Number(label);
    return Number.isInteger(f) && Math.abs(f) < 1e21 ? `n(${f}.0)` : `n(${label})`;
  }
  throw new RustEmitError(`the literal ${label} has no Rust form here`);
}

/** The Rust function a reference's linked implementation is bound to: `Ref_<symbol>`. */
export function referenceName(symbol: string): string {
  return `Ref_${symbol.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/** Lowers a graph to Rust source (to follow RUST_PRELUDE) defining `fn f(args: Vec<V>) -> V`. */
export function emitRust(g: DucGraph): string {
  try {
    printLineForm(g);
  } catch (e) {
    throw new RustEmitError(e instanceof Error ? e.message : String(e));
  }
  if (g.mode !== undefined) throw new RustEmitError(`an ${g.mode} function has no form here`);
  const { body } = rustFunction(g, "", []);
  return ["pub fn f(args: Vec<V>) -> V {", ...indent(body), "}", ""].join("\n");
}

const indent = (lines: readonly string[]): string[] => lines.map((l) => `    ${l}`);

function rustFunction(
  source: DucGraph,
  prefix: string,
  bound: readonly string[],
): { body: string[] } {
  // The heap token orders the statements and is not written (#1285).
  const { graph: g, after } = loweringView(source);
  if (g.obs.length > 1) throw new RustEmitError("more than one observation");
  const branches = g.branches ?? [];
  const producer = new Map<ValueId, DucNode>();
  const consumers = new Map<ValueId, DucNode[]>();
  for (const node of g.nodes) {
    for (const v of node.outputs) producer.set(v, node);
    for (const v of node.inputs) consumers.set(v, [...(consumers.get(v) ?? []), node]);
  }
  const owners = joinOwners(g);
  const loops = g.nodes.filter((n) => n.kind === "loop");
  const invariantOuter = new Map<ValueId, ValueId>();
  for (const loop of loops) {
    const rec = loop.loop as DucLoop;
    const offset = rec.carry.length + (rec.iterate !== undefined ? 1 : 0);
    rec.invariant.forEach((v, j) => invariantOuter.set(v, loop.inputs[offset + j] as ValueId));
  }
  const outerOf = (v: ValueId): ValueId => {
    const outer = invariantOuter.get(v);
    return outer === undefined ? v : outerOf(outer);
  };

  const nameOf = (v: ValueId): string => {
    const outer = invariantOuter.get(v);
    if (outer !== undefined) return nameOf(outer);
    const p = producer.get(v);
    if (p?.kind === "param-source" && paramIndex(p.label) < bound.length)
      return bound[paramIndex(p.label)] as string;
    if (p?.kind === "diamond-source" && p.diamond !== undefined) {
      if (p.diamond.reason === "platform-primitive") return `@${p.diamond.symbol}`;
      // A reference is a link: the function its linked implementation is bound to gives it.
      return `&${referenceName(p.diamond.symbol)}()`;
    }
    return `${prefix}${v}`;
  };

  const inline = new Set<NodeId>();
  const lazyBranches = new Set<string>();
  for (const node of g.nodes) {
    if (node.kind === "literal-source" && node.label !== "Uninitialized") inline.add(node.id);
    if (node.kind !== "op") continue;
    const label = node.label ?? "";
    if (label === "...") inline.add(node.id);
    if (label === "," && producer.get(node.inputs[0] as ValueId)?.kind === "literal-source") {
      const users = consumers.get(node.outputs[0] as ValueId) ?? [];
      if (
        users.length === 1 &&
        users[0]?.label === "CallExpression" &&
        users[0].inputs[0] === node.outputs[0]
      )
        inline.add(node.id);
    }
    if (isMemberRead(label)) {
      const users = consumers.get(node.outputs[0] as ValueId) ?? [];
      const only = users[0];
      if (
        users.length === 1 &&
        only !== undefined &&
        (only.label === "CallExpression" || only.label === "NewExpression") &&
        only.inputs[0] === node.outputs[0] &&
        only.inputs.indexOf(node.outputs[0] as ValueId, 1) === -1
      ) {
        inline.add(node.id);
      }
    }
  }
  for (const loop of loops) {
    const rec = loop.loop as DucLoop;
    if (rec.cond === undefined) continue;
    const body = bodyPathOf(loop);
    const mark = (v: ValueId, region: string): void => {
      const p = producer.get(v);
      if (
        p === undefined ||
        p.kind === "carry-source" ||
        p.kind === "diamond-source" ||
        p.kind === "literal-source"
      )
        return;
      if (p.region !== region)
        throw new RustEmitError(
          `the condition of loop ${loop.id} is not computed at the top of its body`,
        );
      if (new Set(consumers.get(v) ?? []).size > (v === rec.cond ? 0 : 1))
        throw new RustEmitError(`the condition of loop ${loop.id} shares a value with the body`);
      inline.add(p.id);
      const owner = owners.get(p.id);
      if (p.kind === "sel" && owner !== undefined && owner.cond === p.inputs[0]) {
        lazyBranches.add(owner.id);
        mark(p.inputs[0] as ValueId, region);
        if (p.inputs[1] !== p.inputs[0]) mark(p.inputs[1] as ValueId, sidePath(owner, "t"));
        if (p.inputs[2] !== p.inputs[0]) mark(p.inputs[2] as ValueId, sidePath(owner, "e"));
        return;
      }
      for (const input of p.inputs) mark(input, region);
    };
    mark(rec.cond, body);
  }

  const ref = (v: ValueId): string => {
    const p = producer.get(v);
    if (p === undefined || !inline.has(p.id)) {
      const name = nameOf(v);
      if (name === "@arguments" && bound.length === 0) return "arr(args.clone())";
      const platformValue = name.startsWith("@")
        ? entry(PLATFORM_VALUES, name.slice(1))
        : undefined;
      if (platformValue !== undefined) return platformValue;
      if (name.startsWith("@"))
        throw new RustEmitError(
          `the platform name ${name.slice(1)} is used as a value; Rust has no form for it here`,
        );
      if (name.startsWith("&")) return name.slice(1);
      return `${name}.clone()`;
    }
    return render(p);
  };

  const ambientMember = (callee: ValueId): { ns: string; member: string } | undefined => {
    const p = producer.get(callee);
    if (p === undefined || !inline.has(p.id) || !isMemberRead(p.label ?? "")) return undefined;
    const base = producer.get(outerOf(p.inputs[0] as ValueId));
    if (base?.kind !== "diamond-source" || base.diamond?.reason !== "platform-primitive")
      return undefined;
    return { ns: base.diamond.symbol, member: (p.label ?? "").replace(/^\??\./, "") };
  };

  const render = (node: DucNode): string => {
    if (node.kind === "literal-source") return literal(node.label ?? "");
    if (node.kind === "sel") {
      const [c, a, b] = node.inputs as [ValueId, ValueId, ValueId];
      if (lazyBranches.has(owners.get(node.id)?.id ?? "")) {
        if (b === c) return `lazy_and(${ref(c)}, || ${ref(a)})`;
        if (a === c) return `lazy_or(${ref(c)}, || ${ref(b)})`;
        return `lazy_sel(${ref(c)}, || ${ref(a)}, || ${ref(b)})`;
      }
      return `sel(truthy(&${ref(c)}), ${ref(a)}, ${ref(b)})`;
    }
    if (node.kind !== "op") throw new RustEmitError(`a ${node.kind} is not an expression`);
    const label = node.label ?? "";
    const ins = node.inputs;
    const arg = (i: number): string => ref(ins[i] as ValueId);
    if (ins.length === 2) {
      const binary: Record<string, string> = {
        "+": "add",
        "-": "sub",
        "*": "mul",
        "/": "div",
        "%": "rem",
        "**": "pow",
        "&&": "and",
        "||": "or",
        "??": "nullish",
        "&": "band",
        "|": "bor",
        "^": "bxor",
        "<<": "shl",
        ">>": "shr",
        ">>>": "ushr",
        in: "has_key",
        "<": "lt",
        ">": "gt",
        "<=": "le",
        ">=": "ge",
        "===": "seq",
        "!==": "sne",
      };
      const fn = entry(binary, label);
      if (fn !== undefined) return `${fn}(${arg(0)}, ${arg(1)})`;
      if (label === "==" && producer.get(ins[1] as ValueId)?.label === "null")
        return `B(is_nullish(&${arg(0)}))`;
      if (label === "ElementAccess") return `idx(${arg(0)}, ${arg(1)})`;
      if (label === "ElementAccess?.") return `idx_opt(${arg(0)}, ${arg(1)})`;
      if (label === ",") return `comma(${arg(0)}, ${arg(1)})`;
    }
    if (ins.length === 1) {
      if (label === "!") return `not(${arg(0)})`;
      if (label === "~") return `bnot(${arg(0)})`;
      if (label === "-") return `neg(${arg(0)})`;
      if (label === "+") return `pos(${arg(0)})`;
      if (label === "TypeOfExpression") return `type_of(${arg(0)})`;
      if (label === "VoidExpression") return `void_of(${arg(0)})`;
      if (isMemberRead(label))
        return `${label.startsWith("?.") ? "get_opt" : "get"}(${arg(0)}, ${rustString(label.replace(/^\??\./, ""))})`;
    }
    if (label === "CallExpression" || label === "CallExpression?." || label === "NewExpression") {
      let callee = ins[0] as ValueId;
      const viaComma = producer.get(callee);
      // (0, f)(args): f called with no receiver.
      let detached = false;
      if (
        viaComma?.label === "," &&
        producer.get(viaComma.inputs[0] as ValueId)?.kind === "literal-source" &&
        inline.has(viaComma.id)
      ) {
        callee = viaComma.inputs[1] as ValueId;
        detached = true;
      }
      const args = ins.slice(1).map((v) => ref(v));
      const amb = ambientMember(callee);
      if (amb !== undefined) {
        const fn = entry(entry(AMBIENT_MEMBERS, amb.ns), amb.member);
        if (fn === undefined)
          throw new RustEmitError(`${amb.ns}.${amb.member} has no Rust form here`);
        return fn(args);
      }
      const platform = producer.get(outerOf(callee));
      if (
        platform?.kind === "diamond-source" &&
        platform.diamond?.reason === "platform-primitive"
      ) {
        const sym = platform.diamond.symbol;
        if (sym === "RegExp" && label === "NewExpression")
          return `re_new(${args[0] ?? NONE}, ${args[1] ?? NONE})`;
        if (ERRORS.has(sym))
          return `${label === "NewExpression" ? "new_error" : "call_error"}(${rustString(sym)}, ${args[0] ?? NONE})`;
        const call = entry(AMBIENT_CALLS, sym);
        if (call === undefined) throw new RustEmitError(`${sym}(...) has no Rust form here`);
        return call(args);
      }
      const cp = producer.get(callee);
      if (cp !== undefined && inline.has(cp.id) && isMemberRead(cp.label ?? "")) {
        if ((cp.label ?? "").startsWith("?."))
          throw new RustEmitError("an optional method call has no Rust form here");
        const method = (cp.label ?? "").replace(/^\??\./, "");
        const fn = entry(METHODS, method);
        if (fn === undefined) throw new RustEmitError(`the method ${method} has no Rust form here`);
        return fn(ref(cp.inputs[0] as ValueId), args);
      }
      if (label === "NewExpression")
        throw new RustEmitError("new of a value other than an Error has no Rust form here");
      if (label === "CallExpression?.") return `call_opt(${ref(callee)}, ${vec(args)})`;
      return `${detached ? "call_detached" : "call"}(${ref(callee)}, ${vec(args)})`;
    }
    if (label === "ArrayLiteral") {
      if (!ins.some((v) => producer.get(v)?.label === "..."))
        return `arr(${vec(ins.map((v) => ref(v)))})`;
      const parts = ins.map((v) => {
        const p = producer.get(v);
        return p !== undefined && p.label === "..."
          ? `values(${ref(p.inputs[0] as ValueId)})`
          : `vec![${ref(v)}]`;
      });
      return `spread(${vec(parts)})`;
    }
    if (label.startsWith("object:")) {
      const entries = JSON.parse(label.slice("object:".length)) as unknown[];
      let at = 0;
      const next = (): string => ref(ins[at++] as ValueId);
      const parts = entries.map((entry) => {
        if (entry === null) return `Entry::Spread(${next()})`;
        if (typeof entry === "string")
          return `Entry::Key(${rustString(entry)}.to_string(), ${next()})`;
        if (entry === 1) {
          const key = next();
          return `Entry::Key(str_of(&${key}), ${next()})`;
        }
        throw new RustEmitError("an object with a method or an accessor has no Rust form here");
      });
      return `obj(${vec(parts)})`;
    }
    if (label.startsWith("template:")) {
      const texts = JSON.parse(label.slice("template:".length)) as string[];
      return `template(&[${texts.map(rustString).join(", ")}], ${vec(ins.map((v) => ref(v)))})`;
    }
    throw new RustEmitError(`the operation "${label}" has no Rust form`);
  };

  const declare = (name: string, expr: string): string[] => [`let mut ${name}: V = ${expr};`];

  const statementsOf = (node: DucNode): string[] => {
    const out = node.outputs[0];
    const label = node.label ?? "";
    if (node.kind === "literal-source") return declare(nameOf(out as ValueId), "uninit()");
    if (node.kind === "sel") return declare(nameOf(out as ValueId), render(node));
    if (node.kind !== "op") throw new RustEmitError(`a ${node.kind} is not a statement`);
    const arg = (i: number): string => ref(node.inputs[i] as ValueId);
    if (label === "throw") return [`throw(${arg(0)});`];
    if (out === undefined) return [`let _ = ${render(node)};`];
    const name = nameOf(out);
    if (node.closure !== undefined) {
      if (label !== "closure" && label !== "function")
        throw new RustEmitError(
          `a closure that is ${label.replace(/ closure$/, "")} has no form here`,
        );
      if (label === "function")
        throw new RustEmitError("a function with its own receiver (this) has no Rust form here");
      // The closure owns copies of what it captures: each a clone, so the names outside stay.
      const captured = node.inputs.map((_, i) => `${prefix}${node.id}_c${i}`);
      const inner = rustFunction(node.closure, `${prefix}${node.id}_`, captured);
      return [
        `let mut ${name}: V = {`,
        ...indent(node.inputs.map((v, i) => `let ${captured[i]}: V = ${ref(v)};`)),
        "    fun(move |args: Vec<V>| -> V {",
        ...indent(indent(inner.body)),
        "    })",
        "};",
      ];
    }
    // A compound assignment and a step are operations of their own, as the graph has them.
    const compound: Record<string, string> = {
      "+=": "add_assign",
      "-=": "sub_assign",
      "*=": "mul_assign",
      "/=": "div_assign",
      "%=": "rem_assign",
    };
    const fn = entry(compound, label);
    if (fn !== undefined) return declare(name, `${fn}(${arg(0)}, ${arg(1)})`);
    const steps: Record<string, string> = {
      "++": "pre_inc",
      "post++": "post_inc",
      "--": "pre_dec",
      "post--": "post_dec",
    };
    const step = entry(steps, label);
    if (step !== undefined) return declare(name, `${step}(${arg(0)})`);
    if (label.startsWith(".") && label.endsWith("="))
      return declare(name, `put_member(${arg(0)}, ${rustString(label.slice(1, -1))}, ${arg(1)})`);
    if (label === "[]=") return declare(name, `put(${arg(0)}, ${arg(1)}, ${arg(2)})`);
    return declare(name, render(node));
  };

  const nodeIndex = new Map(g.nodes.map((n, i) => [n.id, i] as const));
  /** The values of the inline nodes a statement writes inside it. */
  const inlined = (node: DucNode): ValueId[] =>
    node.inputs.flatMap((v) => {
      const p = producer.get(v);
      return p !== undefined && inline.has(p.id) && p.kind === "op"
        ? [...p.outputs, ...inlined(p)]
        : [];
    });
  const needs = (node: DucNode): ValueId[] => [
    ...node.inputs.flatMap((v) => {
      const p = producer.get(v);
      return p !== undefined && inline.has(p.id) ? needs(p) : [v];
    }),
    // An order edge to an inline operation waits for the statement that writes it.
    ...(after.get(node.id) ?? []).flatMap((v) => {
      const p = producer.get(v);
      return p !== undefined && inline.has(p.id) ? [v, ...needs(p)] : [v];
    }),
  ];
  /** The values made inside a region (a branch side or a loop body), nested regions included. */
  const madeWithin = (path: string): ValueId[] =>
    g.nodes.filter((n) => isPrefix(path, n.region)).flatMap((n) => n.outputs);
  /** What the nodes inside a region need from outside it, their order included. */
  const neededBy = (paths: readonly string[]): ValueId[] => {
    const inside = new Set(paths.flatMap(madeWithin));
    return g.nodes
      .filter((n) => paths.some((path) => isPrefix(path, n.region)))
      .flatMap((n) => [...n.inputs, ...(after.get(n.id) ?? [])])
      .filter((v) => !inside.has(v));
  };

  const emitBranch = (b: DucBranch): string[] => {
    const joins = g.nodes.filter((n) => owners.get(n.id)?.id === b.id);
    const before: string[] = [];
    const thenAssign: string[] = [];
    const elseAssign: string[] = [];
    for (const j of joins) {
      const [, t, e] = j.inputs as [ValueId, ValueId, ValueId];
      const name = nameOf(j.outputs[0] as ValueId);
      before.push(`let mut ${name}: V = ${U};`);
      thenAssign.push(`${name} = ${ref(t)};`);
      elseAssign.push(`${name} = ${ref(e)};`);
    }
    const thenLines = [...emitScope(sidePath(b, "t")), ...thenAssign];
    const elseLines = [...emitScope(sidePath(b, "e")), ...elseAssign];
    return [
      ...before,
      `if truthy(&${ref(b.cond)}) {`,
      ...indent(thenLines),
      ...(elseLines.length > 0 ? ["} else {", ...indent(elseLines)] : []),
      "}",
    ];
  };

  const emitLoop = (loop: DucNode): string[] => {
    const rec = loop.loop as DucLoop;
    const count = rec.carry.length;
    const carried = rec.carry.map((v) => nameOf(v));
    const before = carried.map(
      (name, i) => `let mut ${name}: V = ${ref(loop.inputs[i] as ValueId)};`,
    );
    const header =
      rec.iterate !== undefined
        ? `for ${nameOf(rec.iterate.element)} in ${rec.iterate.of === "values" ? "values" : "keys"}(${ref(loop.inputs[count] as ValueId)}) {`
        : `while truthy(&${ref(rec.cond as ValueId)}) {`;
    const body = emitScope(bodyPathOf(loop));
    // An iterating loop's condition stops it before an element's body (#1276).
    const guard =
      rec.iterate !== undefined && rec.cond !== undefined
        ? [`if !truthy(&${ref(rec.cond)}) {`, "    break;", "}"]
        : [];
    // The next values are computed together, then assigned.
    const next =
      carried.length > 0
        ? [
            `let next: (${carried.map(() => "V").join(", ")},) = (${rec.next.map((v) => ref(v)).join(", ")},);`,
            ...carried.map((name, i) => `${name} = next.${i};`),
          ]
        : [];
    const after = loop.outputs.map((v, i) => `let mut ${nameOf(v)}: V = ${carried[i]}.clone();`);
    return [...before, header, ...indent([...guard, ...body, ...next]), "}", ...after];
  };

  function emitScope(scope: string | undefined): string[] {
    interface Item {
      readonly first: number;
      readonly last: number;
      readonly produces: readonly ValueId[];
      readonly requires: readonly ValueId[];
      readonly lines: () => string[];
    }
    const items: Item[] = [];
    for (const node of g.nodes) {
      if (node.region !== scope || owners.has(node.id) || inline.has(node.id)) continue;
      if (
        node.kind === "param-source" ||
        node.kind === "diamond-source" ||
        node.kind === "carry-source" ||
        node.kind === "loop"
      )
        continue;
      items.push({
        first: nodeIndex.get(node.id) as number,
        last: node.label === "throw" ? 2 : 0,
        // A heap operation written inline (a spread) is done by the statement that writes it.
        produces: [...node.outputs, ...inlined(node)],
        requires: needs(node),
        lines: () => statementsOf(node),
      });
    }
    for (const loop of loops) {
      if (loop.region !== scope) continue;
      const body = bodyPathOf(loop);
      items.push({
        first: nodeIndex.get(loop.id) as number,
        last: 0,
        produces: [...loop.outputs, ...madeWithin(body)],
        requires: [
          ...new Set([...loop.inputs, ...(after.get(loop.id) ?? []), ...neededBy([body])]),
        ],
        lines: () => emitLoop(loop),
      });
    }
    for (const b of branches) {
      if (b.within !== scope || lazyBranches.has(b.id)) continue;
      const subtree = g.nodes.filter(
        (n) => isPrefix(sidePath(b, "t"), n.region) || isPrefix(sidePath(b, "e"), n.region),
      );
      const joins = g.nodes.filter((n) => owners.get(n.id)?.id === b.id);
      const innerValues = new Set(subtree.flatMap((n) => n.outputs));
      const requires = [
        b.cond,
        ...neededBy([sidePath(b, "t"), sidePath(b, "e")]),
        ...joins.flatMap((n) => n.inputs),
      ];
      items.push({
        first: Math.min(
          g.nodes.length,
          ...[...subtree, ...joins].map((n) => nodeIndex.get(n.id) as number),
        ),
        last: subtree.some((n) => n.label === "throw") ? 1 : 0,
        produces: [...joins.flatMap((n) => n.outputs), ...innerValues],
        requires: [...new Set(requires)].filter((v) => !innerValues.has(v)),
        lines: () => emitBranch(b),
      });
    }
    items.sort((a, b) => (a.last === b.last ? a.first - b.first : a.last - b.last));
    const producedBy = new Map<ValueId, number>();
    for (const [i, item] of items.entries()) for (const v of item.produces) producedBy.set(v, i);
    const done = new Set<number>();
    const lines: string[] = [];
    while (done.size < items.length) {
      const ready = (item: Item, i: number): boolean =>
        !done.has(i) &&
        item.requires.every((v) => {
          const p = producedBy.get(v);
          return p === undefined || p === i || done.has(p);
        });
      const rank = Math.min(...items.filter(ready).map((item) => item.last));
      const next = items.findIndex((item, i) => ready(item, i) && item.last === rank);
      if (next === -1) throw new RustEmitError("the graph has a cycle");
      done.add(next);
      lines.push(...(items[next] as Item).lines());
    }
    return lines;
  }

  const own = g.nodes
    .filter((n) => n.kind === "param-source" && paramIndex(n.label) >= bound.length)
    .sort((a, b) => paramIndex(a.label) - paramIndex(b.label));
  // A rest parameter is the arguments from its place on, as an array.
  const bindings = own.map(
    (n, i) =>
      `let mut ${nameOf(n.outputs[0] as ValueId)}: V = ${isRestParam(n.label) ? "rest_args" : "arg"}(&args, ${i});`,
  );
  // A free or ambient name that nothing uses is still part of the atom: it is read on its own.
  const used = new Set<ValueId>([...g.obs, ...branches.map((b) => b.cond)]);
  for (const node of g.nodes) for (const v of node.inputs) used.add(v);
  const unread = g.nodes
    .filter((n) => n.kind === "diamond-source" && !used.has(n.outputs[0] as ValueId))
    .map((n) => {
      const d = n.diamond as { reason: string; symbol: string };
      return d.reason === "platform-primitive"
        ? `let _ = platform(${rustString(d.symbol)});`
        : `let _ = ${referenceName(d.symbol)}();`;
    });
  const body = [...bindings, ...unread, ...emitScope(undefined)];
  const obs = g.obs[0];
  // No observation: the function computes nothing it returns (NONE, not an undefined returned).
  body.push(obs !== undefined ? `return ${ref(obs)};` : "return NONE;");
  return { body };
}
