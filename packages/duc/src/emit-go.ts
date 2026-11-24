import { regexToPython } from "./emit-py.js";
import { bodyPathOf, isPrefix, joinOwners, printLineForm, sidePath } from "./line-form.js";
import { ecmaScriptView } from "./ops.js";
import { loweringView } from "./ordering.js";
// SPDX-License-Identifier: Apache-2.0
/**
 * Lowering a DUC graph to Go (#1278, vision 2: the graph is lowered directly to each target).
 *
 * The graph's operations keep JavaScript's meaning; the runtime (`GO_PRELUDE`) carries it. Every
 * value is dynamic (`any`), so the lowering needs no type to be right; the inferred types (#1277)
 * are a refinement for later, where a typed Go value is wanted. Each value is a variable declared
 * once; a join is declared before its `if` and assigned on each side; a loop's carried values are
 * assigned together at the end of an iteration; a closure is a `func(args ...any) any`.
 *
 * Anything else is refused with a reason (`GoEmitError`), never guessed.
 */
import { isRestParam, paramIndex } from "./params.js";
import type { DucBranch, DucGraph, DucLoop, DucNode, NodeId, ValueId } from "./types.js";

export { GO_PRELUDE } from "./go-prelude.js";

/** A table's own entry for a key: never one of Object.prototype's (`hasOwnProperty`, `constructor`). */
function entry<T>(table: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

export class GoEmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoEmitError";
  }
}

/** A missing argument: undefined, written apart from an undefined passed, so the raiser keeps arity. */
const NONE = "NONE";

const METHODS: Record<string, (recv: string, args: readonly string[]) => string> = {
  trim: (r) => `trim(${r})`,
  toUpperCase: (r) => `toUpper(${r})`,
  toLowerCase: (r) => `toLower(${r})`,
  startsWith: (r, a) => `startsWith(${r}, ${a[0] ?? NONE})`,
  endsWith: (r, a) => `endsWith(${r}, ${a[0] ?? NONE})`,
  includes: (r, a) => `includes(${r}, ${a[0] ?? NONE})`,
  indexOf: (r, a) => `indexOf(${r}, ${a[0] ?? NONE})`,
  slice: (r, a) => `slice(${r}, ${a[0] ?? NONE}, ${a[1] ?? NONE})`,
  split: (r, a) => `split(${r}, ${a[0] ?? NONE})`,
  join: (r, a) => `join(${r}, ${a[0] ?? NONE})`,
  push: (r, a) => `push(${[r, ...a].join(", ")})`,
  map: (r, a) => `mapArr(${r}, ${a[0] ?? NONE})`,
  filter: (r, a) => `filterArr(${r}, ${a[0] ?? NONE})`,
  some: (r, a) => `someArr(${r}, ${a[0] ?? NONE})`,
  every: (r, a) => `everyArr(${r}, ${a[0] ?? NONE})`,
  reduce: (r, a) => `reduceArr(${[r, ...a].join(", ")})`,
  toString: (r: string, a: readonly string[]) => `toStringM(${[r, ...a].join(", ")})`,
  test: (r, a) => `reTest(${r}, ${a[0] ?? NONE})`,
  replace: (r, a) => `replace(${r}, ${a[0] ?? NONE}, ${a[1] ?? NONE})`,
  concat: (r, a) => `concat(${[r, ...a].join(", ")})`,
  substring: (r, a) => `substring(${r}, ${a[0] ?? NONE}, ${a[1] ?? NONE})`,
  forEach: (r, a) => `forEachArr(${r}, ${a[0] ?? NONE})`,
  find: (r, a) => `findArr(${r}, ${a[0] ?? NONE})`,
  findIndex: (r, a) => `findIndexArr(${r}, ${a[0] ?? NONE})`,
  charAt: (r, a) => `charAt(${r}, ${a[0] ?? NONE})`,
  charCodeAt: (r, a) => `charCodeAt(${r}, ${a[0] ?? NONE})`,
  at: (r, a) => `at(${r}, ${a[0] ?? NONE})`,
  match: (r, a) => `match(${r}, ${a[0] ?? NONE})`,
  pop: (r) => `pop(${r})`,
  shift: (r) => `shift(${r})`,
  reverse: (r) => `reverse(${r})`,
};

const AMBIENT_MEMBERS: Record<string, Record<string, (args: readonly string[]) => string>> = {
  Math: {
    abs: (a) => `mathAbs(${a[0] ?? NONE})`,
    floor: (a) => `mathFloor(${a[0] ?? NONE})`,
    ceil: (a) => `mathCeil(${a[0] ?? NONE})`,
    trunc: (a) => `mathTrunc(${a[0] ?? NONE})`,
    round: (a) => `round(${a[0] ?? NONE})`,
    sqrt: (a) => `mathSqrt(${a[0] ?? NONE})`,
    max: (a) => `mathMax(${a.join(", ")})`,
    min: (a) => `mathMin(${a.join(", ")})`,
    pow: (a) => `mathPow(${a[0] ?? NONE}, ${a[1] ?? NONE})`,
  },
  Object: {
    keys: (a) => `objectKeys(${a[0] ?? NONE})`,
    // Freezing changes nothing a lowered function can observe without a write to the frozen value.
    freeze: (a) => `freeze(${a[0] ?? NONE})`,
  },
  Array: { isArray: (a) => `isArrayV(${a[0] ?? NONE})` },
  JSON: {
    stringify: (a) => {
      if (a.length > 1)
        throw new GoEmitError("JSON.stringify with a replacer or an indent has no Go form here");
      return `jsonStringify(${a[0] ?? NONE})`;
    },
  },
  Number: {
    // Number.parseInt is the global parseInt (ECMA-262 21.1.2.13).
    parseInt: (a) => `parseInt(${a[0] ?? NONE}, ${a[1] ?? NONE})`,
    isFinite: (a) => `isFiniteNumber(${a[0] ?? NONE})`,
    isInteger: (a) => `isIntegerNumber(${a[0] ?? NONE})`,
    isNaN: (a) => `isNaNNumber(${a[0] ?? NONE})`,
  },
};

const AMBIENT_CALLS: Record<string, (args: readonly string[]) => string> = {
  __yakccTry: (a) => `tryCatch(${a.join(", ")})`,
  String: (a) => `stringOf(${a.join(", ")})`,
  Number: (a) => `numberOf(${a.join(", ")})`,
  Boolean: (a) => `booleanOf(${a[0] ?? NONE})`,
  parseInt: (a) => `parseInt(${a[0] ?? NONE}, ${a[1] ?? NONE})`,
  isNaN: (a) => `globalIsNaN(${a[0] ?? NONE})`,
  isFinite: (a) => `globalIsFinite(${a[0] ?? NONE})`,
};

const PLATFORM_VALUES: Record<string, string> = {
  parseInt: "fnParseInt",
  String: "fnString",
  Number: "fnNumber",
  Boolean: "fnBoolean",
  Infinity: "jsInfinity",
  NaN: "jsNaN",
};

/** A regular expression literal as Go's RE2, where the two mean the same (see regexToPython). */
function regexToGo(text: string): { pattern: string; global: boolean } {
  let py: ReturnType<typeof regexToPython>;
  try {
    py = regexToPython(text);
  } catch (e) {
    throw new GoEmitError(e instanceof Error ? e.message : String(e));
  }
  const body = text.slice(1, text.lastIndexOf("/"));
  if (/\(\?[=!]|\\[1-9]/.test(body))
    throw new GoEmitError("lookahead and backreferences have no Go (RE2) form");
  const pattern = py.pattern.replace(/\\Z/g, "\\z").replace(/\\u([0-9a-fA-F]{4})/g, "\\x{$1}");
  return {
    pattern: `${py.flags.includes("IGNORECASE") ? "(?i)" : ""}${pattern}`,
    global: py.global,
  };
}

const ERRORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError"]);

const isMemberRead = (label: string): boolean =>
  (label.startsWith(".") || label.startsWith("?.")) && !label.endsWith("=") && label !== "...";

function literal(label: string): string {
  if (label.startsWith("/") && label.lastIndexOf("/") > 0) {
    const r = regexToGo(label);
    // The JavaScript literal is kept beside its RE2 form, for the raiser.
    return `reJs(${JSON.stringify(label)}, ${JSON.stringify(r.pattern)}, ${r.global})`;
  }
  if (label === "true" || label === "false") return `any(${label})`;
  if (label === "null") return "any(nil)";
  if (label === "undefined" || label === "Uninitialized") return "Undefined";
  if (label.startsWith('"')) return `any(${JSON.stringify(JSON.parse(label) as string)})`;
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(label)) return `any(float64(${label}))`;
  throw new GoEmitError(`the literal ${label} has no Go form here`);
}

/** Lowers a graph to Go source (to follow GO_PRELUDE in package main) defining `f`. */
export function emitGo(input: DucGraph): string {
  // ECMAScript's operations: each generic operation as the case of them it is (#1310).
  const g = ecmaScriptView(input);
  try {
    printLineForm(g);
  } catch (e) {
    throw new GoEmitError(e instanceof Error ? e.message : String(e));
  }
  if (g.mode !== undefined) throw new GoEmitError(`an ${g.mode} function has no form here`);
  const { body } = goFunction(g, "", []);
  return ["func f(args ...any) any {", ...indent(body), "}", ""].join("\n");
}

const indent = (lines: readonly string[]): string[] => lines.map((l) => `\t${l}`);

function goFunction(
  source: DucGraph,
  prefix: string,
  bound: readonly string[],
): { body: string[] } {
  // The heap token orders the statements and is not written (#1285).
  const { graph: g, after } = loweringView(source);
  if (g.obs.length > 1) throw new GoEmitError("more than one observation");
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
      // A reference is a link: the package-level name its linked implementation is bound to.
      return `Ref_${p.diamond.symbol.replace(/[^A-Za-z0-9_]/g, "_")}`;
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
        throw new GoEmitError(
          `the condition of loop ${loop.id} is not computed at the top of its body`,
        );
      if (new Set(consumers.get(v) ?? []).size > (v === rec.cond ? 0 : 1))
        throw new GoEmitError(`the condition of loop ${loop.id} shares a value with the body`);
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
      if (name === "@arguments" && bound.length === 0) return "argumentsOf(args)";
      const platformValue = name.startsWith("@")
        ? entry(PLATFORM_VALUES, name.slice(1))
        : undefined;
      if (platformValue !== undefined) return platformValue;
      if (name.startsWith("@"))
        throw new GoEmitError(
          `the platform name ${name.slice(1)} is used as a value; Go has no form for it here`,
        );
      return name;
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
        if (b === c) return `lazyAnd(${ref(c)}, func() any { return ${ref(a)} })`;
        if (a === c) return `lazyOr(${ref(c)}, func() any { return ${ref(b)} })`;
        return `lazySel(${ref(c)}, func() any { return ${ref(a)} }, func() any { return ${ref(b)} })`;
      }
      return `sel(truthy(${ref(c)}), ${ref(a)}, ${ref(b)})`;
    }
    if (node.kind !== "op") throw new GoEmitError(`a ${node.kind} is not an expression`);
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
        in: "hasKey",
      };
      const fn = entry(binary, label);
      if (fn !== undefined) return `${fn}(${arg(0)}, ${arg(1)})`;
      const compare: Record<string, string> = {
        "<": "lt",
        ">": "gt",
        "<=": "le",
        ">=": "ge",
        "===": "seq",
      };
      const cmp = entry(compare, label);
      if (cmp !== undefined) return `any(${cmp}(${arg(0)}, ${arg(1)}))`;
      if (label === "!==") return `sne(${arg(0)}, ${arg(1)})`;
      if (label === "==" && producer.get(ins[1] as ValueId)?.label === "null")
        return `any(isNullish(${arg(0)}))`;
      if (label === "ElementAccess") return `idx(${arg(0)}, ${arg(1)})`;
      if (label === "ElementAccess?.") return `idxOpt(${arg(0)}, ${arg(1)})`;
      if (label === ",") return `comma(${arg(0)}, ${arg(1)})`;
    }
    if (ins.length === 1) {
      if (label === "!") return `not(${arg(0)})`;
      if (label === "~") return `bnot(${arg(0)})`;
      if (label === "-") return `neg(${arg(0)})`;
      if (label === "+") return `pos(${arg(0)})`;
      if (label === "TypeOfExpression") return `any(typeOf(${arg(0)}))`;
      if (label === "VoidExpression") return `voidOf(${arg(0)})`;
      if (isMemberRead(label))
        return `${label.startsWith("?.") ? "getOpt" : "get"}(${arg(0)}, ${JSON.stringify(label.replace(/^\??\./, ""))})`;
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
        if (fn === undefined) throw new GoEmitError(`${amb.ns}.${amb.member} has no Go form here`);
        return fn(args);
      }
      const platform = producer.get(outerOf(callee));
      if (
        platform?.kind === "diamond-source" &&
        platform.diamond?.reason === "platform-primitive"
      ) {
        const sym = platform.diamond.symbol;
        if (ERRORS.has(sym))
          return `${label === "NewExpression" ? "newError" : "callError"}(${JSON.stringify(sym)}, ${args[0] ?? NONE})`;
        const call = entry(AMBIENT_CALLS, sym);
        if (call === undefined) throw new GoEmitError(`${sym}(...) has no Go form here`);
        return call(args);
      }
      const cp = producer.get(callee);
      if (cp !== undefined && inline.has(cp.id) && isMemberRead(cp.label ?? "")) {
        if ((cp.label ?? "").startsWith("?."))
          throw new GoEmitError("an optional method call has no Go form here");
        const method = (cp.label ?? "").replace(/^\??\./, "");
        const fn = entry(METHODS, method);
        if (fn === undefined) throw new GoEmitError(`the method ${method} has no Go form here`);
        return fn(ref(cp.inputs[0] as ValueId), args);
      }
      if (label === "NewExpression")
        throw new GoEmitError("new of a value other than an Error has no Go form here");
      if (label === "CallExpression?.") return `callOpt(${[ref(callee), ...args].join(", ")})`;
      return `${detached ? "callDetached" : "call"}(${[ref(callee), ...args].join(", ")})`;
    }
    if (label === "ArrayLiteral") {
      if (!ins.some((v) => producer.get(v)?.label === "..."))
        return `arr(${ins.map((v) => ref(v)).join(", ")})`;
      const parts = ins.map((v) => {
        const p = producer.get(v);
        return p !== undefined && p.label === "..."
          ? `values(${ref(p.inputs[0] as ValueId)})`
          : `[]any{${ref(v)}}`;
      });
      return `spread(${parts.join(", ")})`;
    }
    if (label.startsWith("object:")) {
      const entries = JSON.parse(label.slice("object:".length)) as unknown[];
      let at = 0;
      const next = (): string => ref(ins[at++] as ValueId);
      const parts = entries.map((entry) => {
        if (entry === null) return `objSpread{${next()}}`;
        if (typeof entry === "string") return `${JSON.stringify(entry)}, ${next()}`;
        throw new GoEmitError(
          "an object with a computed key, a method or an accessor has no Go form here",
        );
      });
      return `obj(${parts.join(", ")})`;
    }
    if (label.startsWith("template:")) {
      const texts = JSON.parse(label.slice("template:".length)) as string[];
      return `template([]string{${texts.map((t) => JSON.stringify(t)).join(", ")}}${ins.map((v) => `, ${ref(v)}`).join("")})`;
    }
    throw new GoEmitError(`the operation "${label}" has no Go form`);
  };

  const declare = (name: string, expr: string): string[] => [
    `var ${name} any = ${expr}`,
    `_ = ${name}`,
  ];

  const statementsOf = (node: DucNode): string[] => {
    const out = node.outputs[0];
    const label = node.label ?? "";
    if (node.kind === "literal-source") return declare(nameOf(out as ValueId), "uninit()");
    if (node.kind === "sel") return declare(nameOf(out as ValueId), render(node));
    if (node.kind !== "op") throw new GoEmitError(`a ${node.kind} is not a statement`);
    const arg = (i: number): string => ref(node.inputs[i] as ValueId);
    if (label === "throw") return [`throw(${arg(0)})`];
    if (out === undefined) return [`_ = ${render(node)}`];
    const name = nameOf(out);
    if (node.closure !== undefined) {
      if (label !== "closure" && label !== "function")
        throw new GoEmitError(
          `a closure that is ${label.replace(/ closure$/, "")} has no form here`,
        );
      if (label === "function")
        throw new GoEmitError("a function with its own receiver (this) has no Go form here");
      const inner = goFunction(
        node.closure,
        `${prefix}${node.id}_`,
        node.inputs.map((v) => ref(v)),
      );
      return [
        `var ${name} any = func(args ...any) any {`,
        ...indent(inner.body),
        "}",
        `_ = ${name}`,
      ];
    }
    // A compound assignment and a step are operations of their own, as the graph has them.
    const compound: Record<string, string> = {
      "+=": "addAssign",
      "-=": "subAssign",
      "*=": "mulAssign",
      "/=": "divAssign",
      "%=": "remAssign",
    };
    const fn = entry(compound, label);
    if (fn !== undefined) return declare(name, `${fn}(${arg(0)}, ${arg(1)})`);
    const steps: Record<string, string> = {
      "++": "preInc",
      "post++": "postInc",
      "--": "preDec",
      "post--": "postDec",
    };
    const step = entry(steps, label);
    if (step !== undefined) return declare(name, `${step}(${arg(0)})`);
    if (label.startsWith(".") && label.endsWith("="))
      return declare(
        name,
        `putMember(${arg(0)}, ${JSON.stringify(label.slice(1, -1))}, ${arg(1)})`,
      );
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
      before.push(`var ${name} any`, `_ = ${name}`);
      thenAssign.push(`${name} = ${ref(t)}`);
      elseAssign.push(`${name} = ${ref(e)}`);
    }
    const thenLines = [...emitScope(sidePath(b, "t")), ...thenAssign];
    const elseLines = [...emitScope(sidePath(b, "e")), ...elseAssign];
    return [
      ...before,
      `if truthy(${ref(b.cond)}) {`,
      ...indent(thenLines),
      ...(elseLines.length > 0 ? ["} else {", ...indent(elseLines)] : []),
      "}",
    ];
  };

  const emitLoop = (loop: DucNode): string[] => {
    const rec = loop.loop as DucLoop;
    // #1330: `for await` is not in this lowering; core's change forced this one line.
    if (rec.iterate?.of === "async values")
      throw new GoEmitError("for await is not in the subset yet");
    const count = rec.carry.length;
    const carried = rec.carry.map((v) => nameOf(v));
    const before = carried.flatMap((name, i) => [
      `var ${name} any = ${ref(loop.inputs[i] as ValueId)}`,
      `_ = ${name}`,
    ]);
    const header =
      rec.iterate !== undefined
        ? `for _, ${nameOf(rec.iterate.element)} := range ${rec.iterate.of === "values" ? "values" : "keys"}(${ref(loop.inputs[count] as ValueId)}) {`
        : `for truthy(${ref(rec.cond as ValueId)}) {`;
    const body = emitScope(bodyPathOf(loop));
    const element = rec.iterate !== undefined ? [`_ = ${nameOf(rec.iterate.element)}`] : [];
    // An iterating loop's condition stops it before an element's body (#1276).
    const guard =
      rec.iterate !== undefined && rec.cond !== undefined
        ? [`if !truthy(${ref(rec.cond)}) {`, "\tbreak", "}"]
        : [];
    const next =
      carried.length > 0
        ? [`${carried.join(", ")} = ${rec.next.map((v) => ref(v)).join(", ")}`]
        : [];
    const after = loop.outputs.flatMap((v, i) => [
      `var ${nameOf(v)} any = ${carried[i]}`,
      `_ = ${nameOf(v)}`,
    ]);
    return [...before, header, ...indent([...element, ...guard, ...body, ...next]), "}", ...after];
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
        // A statement ordered after one inside the body comes after the loop.
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
        // A statement ordered after one inside a side comes after the branch.
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
      if (next === -1) throw new GoEmitError("the graph has a cycle");
      done.add(next);
      lines.push(...(items[next] as Item).lines());
    }
    return lines;
  }

  const own = g.nodes
    .filter((n) => n.kind === "param-source" && paramIndex(n.label) >= bound.length)
    .sort((a, b) => paramIndex(a.label) - paramIndex(b.label));
  // A rest parameter is the arguments from its place on, as an array.
  const bindings = own.flatMap((n, i) => [
    isRestParam(n.label)
      ? `var ${nameOf(n.outputs[0] as ValueId)} any = restArgs(args, ${i})`
      : `var ${nameOf(n.outputs[0] as ValueId)} any = arg(args, ${i})`,
    `_ = ${nameOf(n.outputs[0] as ValueId)}`,
  ]);
  // A free or ambient name that nothing uses is still part of the atom: it is read on its own.
  const used = new Set<ValueId>([...g.obs, ...branches.map((b) => b.cond)]);
  for (const node of g.nodes) for (const v of node.inputs) used.add(v);
  const unread = g.nodes
    .filter((n) => n.kind === "diamond-source" && !used.has(n.outputs[0] as ValueId))
    .map((n) => {
      const d = n.diamond as { reason: string; symbol: string };
      return d.reason === "platform-primitive"
        ? `_ = platform(${JSON.stringify(d.symbol)})`
        : `_ = ${nameOf(n.outputs[0] as ValueId)}`;
    });
  const body = [...bindings, ...unread, ...emitScope(undefined)];
  const obs = g.obs[0];
  // No observation: the function computes nothing it returns (NONE, not an undefined returned).
  body.push(obs !== undefined ? `return ${ref(obs)}` : "return NONE");
  return { body };
}
