import { isHeapLabel } from "./heap-labels.js";
import { parseType, typeToTypeScript } from "./infer-types.js";
// SPDX-License-Identifier: Apache-2.0
/**
 * Lowering to TypeScript (#1275, decision 5A): a graph is emitted as a TypeScript function whose
 * lifted graph has the same identity. The graph is the authority; this is its TypeScript form.
 *
 * The code is generated, not written for people: one statement per node, in single-assignment
 * style. Values are named by their ids (`$v3`). An `if` is a block whose joins are variables
 * assigned on each side; a loop is a `while`, `for...of` or `for...in` block whose carried values
 * are variables. Member reads that are called, spreads and array holes are written inline, so a
 * method call keeps its receiver.
 *
 * The graph does not hold types, so the code is untyped. A graph the line form cannot express, or
 * that holds an opaque node (a closure, a class, a construct summarized by its text), or the return
 * state of returns on some paths, has no TypeScript form here: `emitTypeScript` throws EmitError.
 */
import {
  COMPLETES,
  DECLARES,
  RETURNED_NAME,
  RETURN_VALUE_NAME,
  completionOf,
  declaredNamesOf,
} from "./lift.js";
import { bodyPathOf, isPrefix, joinOwners, printLineForm, sidePath } from "./line-form.js";
import { operationReference } from "./operations.js";
import { ecmaScriptView } from "./ops.js";
import { loweringView } from "./ordering.js";
import { isDefaultedParam, isRestParam, paramIndex } from "./params.js";
import { RUNTIME_MODULE } from "./runtime.js";
import type { DucBranch, DucGraph, DucLoop, DucNode, NodeId, ValueId } from "./types.js";

export class EmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmitError";
  }
}

const BINARY = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "<",
  ">",
  "<=",
  ">=",
  "==",
  "!=",
  "===",
  "!==",
  "&",
  "|",
  "^",
  "<<",
  ">>",
  ">>>",
  "&&",
  "||",
  "??",
  "in",
  "instanceof",
]);
const COMPOUND = new Set([
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "&=",
  "|=",
  "^=",
  "<<=",
  ">>=",
  ">>>=",
  "&&=",
  "||=",
  "??=",
]);
const PREFIX = new Set(["!", "-", "+", "~"]);
const CALLS = new Set(["CallExpression", "CallExpression?.", "NewExpression"]);

/** A value as a template's literal text: the characters a template would read otherwise escaped. */
function templateText(value: string): string {
  return value.replace(/\\|`|\$\{|\r/g, (m) =>
    m === "\r" ? "\\r" : m === "${" ? "\\${" : `\\${m}`,
  );
}

const isMemberRead = (label: string): boolean =>
  (label !== "..." && (label.startsWith(".") || label.startsWith("?.")) && !label.endsWith("=")) ||
  label.startsWith("super.") ||
  label === "super[]" ||
  label === "ElementAccess" ||
  label === "ElementAccess?.";

/** The contract's interface types, as the contract writes them (T1, #1277). */
export interface EmitSignature {
  readonly inputs: readonly string[];
  readonly output?: string;
}

/**
 * Emits a graph as a TypeScript function, `f` unless `options.name` names it. With a signature, the
 * parameters and the result are
 * annotated from the contract; the types inside are TypeScript's to infer. Throws EmitError for a
 * graph it cannot express.
 */
export function emitTypeScript(
  input: DucGraph,
  signature?: EmitSignature,
  options: { readonly name?: string } = {},
): string {
  // TypeScript is ECMAScript: every operation is written as the operator it is a case of (#1310).
  const g = ecmaScriptView(input);
  // The structure must be expressible: the line form's checks hold here too, closures included.
  try {
    printLineForm(g);
  } catch (e) {
    throw new EmitError(e instanceof Error ? e.message : String(e));
  }
  const imports = new Map<string, Set<string>>();
  // A module statement's graph is a module: its statements, then the names it declares (#1290).
  const asModule =
    (declaredNamesOf(g) !== undefined || completionOf(g) !== undefined) &&
    !g.nodes.some((n) => n.kind === "param-source");
  const { params, body } = emitFunction(g, "", [], imports, asModule);
  const importLines = [...imports.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([module, symbols]) =>
        `import { ${[...symbols].sort().join(", ")} } from ${JSON.stringify(module)};`,
    );
  const typed =
    signature === undefined
      ? params
      : params.map((p, i) => {
          const t = signature.inputs[i];
          return t === undefined ? p : `${p}: ${typeToTypeScript(parseType(t))}`;
        });
  const result =
    signature?.output !== undefined ? `: ${typeToTypeScript(parseType(signature.output))}` : "";
  if (asModule) return [...importLines, ...body, ""].join("\n");
  return [
    ...importLines,
    `export ${modeHead(g.mode)}${options.name ?? "f"}(${typed.join(", ")})${result} {`,
    ...body.map((l) => `  ${l}`),
    "}",
    "",
  ].join("\n");
}

/**
 * Where each entry of an object literal's label takes its inputs: a computed key's input, then the
 * value's. A method or accessor (`{method|get|set: key}`) is a member written in place.
 */
function objectSlots(
  entries: readonly unknown[],
): { value: number; key?: number; name?: string; spread?: true; member?: string }[] {
  let at = 0;
  return entries.map((entry) => {
    if (entry === null) return { value: at++, spread: true as const };
    if (entry === 1) {
      const key = at++;
      return { key, value: at++ };
    }
    if (typeof entry === "string") return { value: at++, name: entry };
    const [kind, k] = Object.entries(entry as Record<string, unknown>)[0] ?? [];
    const member = kind === "method" || kind === "get" || kind === "set" ? kind : undefined;
    if (k === 1) {
      const key = at++;
      return { key, value: at++, ...(member !== undefined ? { member } : {}) };
    }
    return { value: at++, name: String(k), ...(member !== undefined ? { member } : {}) };
  });
}

/** The words before a function's name: `function`, `async function`, `function*`. */
function modeHead(mode: DucGraph["mode"]): string {
  if (mode === undefined) return "function ";
  return `${mode.startsWith("async") ? "async " : ""}function${mode.endsWith("generator") ? "*" : ""} `;
}

/**
 * The parameters and body of one function: the atom, or a closure inside it. A closure's captures
 * are its first parameters; `bound` names them as the enclosing function's values. `prefix` keeps
 * a closure's names apart from the names around it.
 */
function emitFunction(
  source: DucGraph,
  prefix: string,
  bound: readonly string[],
  imports: Map<string, Set<string>>,
  asModule = false,
  selfName = "Fn_",
): { params: string[]; body: string[] } {
  // The heap token orders the statements and is not written (#1285).
  const { graph: g, after } = loweringView(source);
  if (g.obs.length > 1 && !asModule) throw new EmitError("more than one observation");

  const branches = g.branches ?? [];
  const producer = new Map<ValueId, DucNode>();
  const consumers = new Map<ValueId, DucNode[]>();
  for (const node of g.nodes) {
    for (const v of node.outputs) producer.set(v, node);
    for (const v of node.inputs) consumers.set(v, [...(consumers.get(v) ?? []), node]);
  }
  const owners = joinOwners(g);
  const loops = g.nodes.filter((n) => n.kind === "loop");

  // Invariant sources stand for outer values, and are written as those values.
  const invariantOuter = new Map<ValueId, ValueId>();
  for (const loop of loops) {
    const rec = loop.loop as DucLoop;
    const offset = rec.carry.length + (rec.iterate !== undefined ? 1 : 0);
    rec.invariant.forEach((v, j) => invariantOuter.set(v, loop.inputs[offset + j] as ValueId));
  }

  const nameOf = (v: ValueId): string => {
    const outer = invariantOuter.get(v);
    if (outer !== undefined) return nameOf(outer);
    const p = producer.get(v);
    if (p?.kind === "param-source" && paramIndex(p.label) < bound.length)
      return bound[paramIndex(p.label)] as string;
    if (p?.kind === "diamond-source" && p.diamond !== undefined) {
      if (p.diamond.reason === "unlinked-reference") {
        const module = p.diamond.module;
        if (module === undefined)
          throw new EmitError(`imported binding ${p.diamond.symbol} has no module`);
        imports.set(module, new Set([...(imports.get(module) ?? []), p.diamond.symbol]));
      }
      // A runtime primitive (a try statement's call) is imported from the DUC runtime (#1276).
      if (p.diamond.reason === "platform-primitive" && p.diamond.symbol.startsWith("__yakccTry"))
        imports.set(
          RUNTIME_MODULE,
          new Set([...(imports.get(RUNTIME_MODULE) ?? []), p.diamond.symbol]),
        );
      return p.diamond.symbol;
    }
    return `$${prefix}${v}`;
  };

  // Nodes written inline, inside the expression that uses them, not as statements of their own.
  const inline = new Set<NodeId>();
  // Branches written as the `&&`, `||` or `?:` of the select that joins them.
  const lazyBranches = new Set<string>();
  // Loops whose condition is written in the body: `while (true) { ..c..; if (!(c)) break; ... }`.
  const guardLoops = new Set<NodeId>();
  // A class's members are written inside the class, not as statements of their own (#1276).
  const classMembers = new Set<NodeId>();
  for (const node of g.nodes) {
    if (!(node.label ?? "").startsWith("class:")) continue;
    const extending = (node.label ?? "").startsWith('class:[["extends"]');
    for (const v of node.inputs.slice(extending ? 1 : 0)) {
      const p = producer.get(v);
      if (p?.closure !== undefined && (consumers.get(v) ?? []).length === 1) classMembers.add(p.id);
    }
  }
  // So are an object literal's methods and accessors.
  for (const node of g.nodes) {
    if (!(node.label ?? "").startsWith("object:")) continue;
    for (const slot of objectSlots(JSON.parse((node.label ?? "").slice("object:".length)))) {
      if (slot.member === undefined) continue;
      const v = node.inputs[slot.value] as ValueId;
      const p = producer.get(v);
      if (p?.closure !== undefined && (consumers.get(v) ?? []).length === 1) classMembers.add(p.id);
    }
  }
  for (const node of g.nodes) {
    // A literal is a constant, written where it is used.
    if (node.kind === "literal-source" && node.label !== "Uninitialized") inline.add(node.id);
    if (node.kind !== "op") continue;
    const label = node.label ?? "";
    if (label === "..." || label.startsWith("OmittedExpression#")) inline.add(node.id);
    if (isMemberRead(label)) {
      const out = node.outputs[0] as ValueId;
      const users = consumers.get(out) ?? [];
      const only = users[0];
      if (
        users.length === 1 &&
        only !== undefined &&
        CALLS.has(only.label ?? "") &&
        only.inputs[0] === out &&
        only.inputs.indexOf(out, 1) === -1
      ) {
        inline.add(node.id);
      }
    }
  }
  // A while condition is written in the loop's header, so its nodes are inline. A branch inside it
  // that only computes an arm of `&&`, `||` or `?:` is written as that operator.
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
        throw new EmitError(
          `the condition of loop ${loop.id} is not computed at the top of its body`,
        );
      // The condition itself is used only by the loop; a value inside it only by the condition.
      if (new Set(consumers.get(v) ?? []).size > (v === rec.cond ? 0 : 1)) {
        throw new EmitError(`the condition of loop ${loop.id} shares a value with the body`);
      }
      // A closure or a class is written as a statement of its own, never inside an expression: the
      // condition is then written at the top of the body (#1368: `while (xs.some((x) => !x.done))`).
      if (p.closure !== undefined || (p.label ?? "").startsWith("class:"))
        throw new EmitError(`the condition of loop ${loop.id} makes a closure`);
      inline.add(p.id);
      const owner = owners.get(p.id);
      if (p.kind === "sel" && owner !== undefined && owner.cond === p.inputs[0]) {
        const joins = g.nodes.filter((n) => owners.get(n.id)?.id === owner.id);
        if (joins.length !== 1)
          throw new EmitError(`the condition of loop ${loop.id} assigns a name`);
        lazyBranches.add(owner.id);
        mark(p.inputs[0] as ValueId, region);
        // An arm that is the condition itself (`c && t` keeps c when it is false) is already marked.
        if (p.inputs[1] !== p.inputs[0]) mark(p.inputs[1] as ValueId, sidePath(owner, "t"));
        if (p.inputs[2] !== p.inputs[0]) mark(p.inputs[2] as ValueId, sidePath(owner, "e"));
        const inside = g.nodes.filter(
          (n) =>
            isPrefix(sidePath(owner, "t"), n.region) || isPrefix(sidePath(owner, "e"), n.region),
        );
        if (inside.some((n) => !inline.has(n.id)))
          throw new EmitError(`the condition of loop ${loop.id} has a statement in a branch`);
        return;
      }
      for (const input of p.inputs) mark(input, region);
    };
    // A condition that cannot be written in the loop's header (it shares a value with the body,
    // or assigns a name) is written at the top of the body, before `if (!(c)) break;` (#1276).
    const inlineBefore = new Set(inline);
    const lazyBefore = new Set(lazyBranches);
    try {
      mark(rec.cond, body);
    } catch (e) {
      if (!(e instanceof EmitError) || rec.iterate !== undefined) throw e;
      for (const id of [...inline]) if (!inlineBefore.has(id)) inline.delete(id);
      for (const id of [...lazyBranches]) if (!lazyBefore.has(id)) lazyBranches.delete(id);
      guardLoops.add(loop.id);
    }
  }

  /** The nodes written inline in a value's expression, the value's own producer included. */
  const inlineWithin = (v: ValueId | undefined): DucNode[] => {
    const p = v === undefined ? undefined : producer.get(v);
    if (p === undefined || !inline.has(p.id)) return [];
    return [p, ...p.inputs.flatMap((i) => inlineWithin(i))];
  };
  /** Whether a heap operation written inline in `a` is ordered after one written inline in `b`. */
  const orderedAfter = (a: ValueId | undefined, b: ValueId | undefined): boolean => {
    const made = new Set(inlineWithin(b).flatMap((n) => n.outputs));
    return inlineWithin(a).some((n) => (after.get(n.id) ?? []).some((v) => made.has(v)));
  };
  /** A value as an expression: its name, or its inline expression. */
  const ref = (v: ValueId): string => {
    const p = producer.get(v);
    if (p === undefined || !inline.has(p.id)) return nameOf(v);
    const label = p.label ?? "";
    const expr = render(p);
    if (p.kind === "literal-source") return /^[0-9.]/.test(expr) ? `(${expr})` : expr;
    return label === "..." || label.startsWith("OmittedExpression#") || isMemberRead(label)
      ? expr
      : `(${expr})`;
  };

  /** An operation, literal or select, as an expression. */
  const render = (node: DucNode): string => {
    if (node.kind === "literal-source") {
      return node.label ?? "";
    }
    if (node.kind === "sel") {
      const [c, a, b] = node.inputs as [ValueId, ValueId, ValueId];
      if (lazyBranches.has(owners.get(node.id)?.id ?? "")) {
        if (b === c) return `${ref(c)} && ${ref(a)}`;
        if (a === c) return `${ref(c)} || ${ref(b)}`;
      }
      return `${ref(c)} ? ${ref(a)} : ${ref(b)}`;
    }
    if (node.kind !== "op") throw new EmitError(`a ${node.kind} is not an expression`);
    const label = node.label ?? "";
    const ins = node.inputs;
    const arg = (i: number): string => ref(ins[i] as ValueId);
    if (BINARY.has(label) && ins.length === 2) {
      // `===` and `!==` have their operands in canonical order, not in the order they are read: an
      // operand written inline whose heap operation comes after one in the other operand is
      // written second, so the reads run in their order (#1292).
      if ((label === "===" || label === "!==") && orderedAfter(ins[0], ins[1]))
        return `${arg(1)} ${label} ${arg(0)}`;
      return `${arg(0)} ${label} ${arg(1)}`;
    }
    if (label === "," && ins.length === 2) return `(${arg(0)}, ${arg(1)})`;
    if (PREFIX.has(label) && ins.length === 1) return `${label}${arg(0)}`;
    if (label === "TypeOfExpression") return `typeof ${arg(0)}`;
    if (label === "import()") return `import(${ins.map((v) => ref(v)).join(", ")})`;
    if (label.startsWith("in:#")) return `(${label.slice("in:".length)} in ${arg(0)})`;
    if (label === "VoidExpression") return `void ${arg(0)}`;
    // A binding outside the atom, read by its name (#1276).
    if (label === "binding") return arg(0);
    // A derived constructor's `super(..)`: its value is the receiver it makes (#1276).
    if (label === "super") return `super(${ins.map((v) => ref(v)).join(", ")})`;
    // An operation that is a reference to an atom, written as the source writes it (#1362).
    if (operationReference(label) !== undefined)
      return `${label}(${ins.map((v) => ref(v)).join(", ")})`;
    // An object rest, as the runtime's call the lifter reads back (#1330).
    if (label.startsWith("ObjectRest:")) {
      imports.set(
        RUNTIME_MODULE,
        new Set([...(imports.get(RUNTIME_MODULE) ?? []), "__yakccObjectRest"]),
      );
      return `__yakccObjectRest(${arg(0)}, ${label.slice("ObjectRest:".length)})`;
    }
    if (label === "AwaitExpression") return `(await ${arg(0)})`;
    if (label === "YieldExpression") return ins.length === 0 ? "(yield)" : `(yield ${arg(0)})`;
    if (label === "YieldExpression*") return `(yield* ${arg(0)})`;
    if (isMemberRead(label)) {
      if (label === "ElementAccess") return `${arg(0)}[${arg(1)}]`;
      if (label === "ElementAccess?.") return `${arg(0)}?.[${arg(1)}]`;
      // The parent's member: its input is the receiver `super` reads with, written as `super`.
      if (label.startsWith("super.")) return label;
      if (label === "super[]") return `super[${arg(1)}]`;
      return `${arg(0)}${label}`;
    }
    if (CALLS.has(label)) {
      const callee = arg(0);
      const args = ins
        .slice(1)
        .map((v) => ref(v))
        .join(", ");
      if (label === "NewExpression") return `new ${callee}(${args})`;
      return label === "CallExpression?." ? `${callee}?.(${args})` : `${callee}(${args})`;
    }
    if (label === "ArrayLiteral") return `[${ins.map((v) => ref(v)).join(", ")}]`;
    if (label.startsWith("array-with-holes:")) {
      // The holes at their positions, the elements in the rest; a last hole needs its own comma.
      const holes = new Set(JSON.parse(label.slice("array-with-holes:".length)) as number[]);
      const parts: string[] = [];
      let next = 0;
      for (let i = 0; parts.length < ins.length + holes.size; i++)
        parts.push(holes.has(i) ? "" : ref(ins[next++] as ValueId));
      return `[${parts.join(", ")}${holes.has(parts.length - 1) ? "," : ""}]`;
    }
    if (label === "...") return `...${arg(0)}`;
    if (label.startsWith("OmittedExpression#")) return "";
    if (label === "this" || label.startsWith("ThisKeyword#")) return "this";
    if (label.startsWith("delete.")) return `delete ${arg(0)}.${label.slice("delete.".length)}`;
    if (label === "delete[]") return `delete ${arg(0)}[${arg(1)}]`;
    // The class a member belongs to: the class expression's own name (#1276).
    if (label === "class-self") return "Self_";
    // The function this graph is: the function expression's own name, or for an arrow the const it
    // initializes (#1276, #1173).
    if (label === "function-self") return selfName;
    if (label.startsWith("object:")) {
      const entries = JSON.parse(label.slice("object:".length)) as unknown[];
      let at = 0;
      const next = (): string => ref(ins[at++] as ValueId);
      const parts = entries.map((entry) => {
        if (entry === null) return `...${next()}`;
        if (entry === 1) {
          const key = next();
          return `[${key}]: ${next()}`;
        }
        if (typeof entry === "string") return `${JSON.stringify(entry)}: ${next()}`;
        throw new EmitError("an object method or accessor has no TypeScript form here");
      });
      return `{ ${parts.join(", ")} }`;
    }
    if (label.startsWith("template:") || label.startsWith("tagged:")) {
      const tagged = label.startsWith("tagged:");
      // A template's parts are values, written back with what a template needs escaped; a tagged
      // template's are written as their raw text, which the tag sees (#1303).
      const parts = tagged
        ? (JSON.parse(label.slice("tagged:".length)) as [string | null, string][]).map(
            ([, raw]) => raw,
          )
        : (JSON.parse(label.slice("template:".length)) as string[]).map(templateText);
      const exprs = tagged ? ins.slice(1) : ins;
      let text = `\`${parts[0] ?? ""}`;
      exprs.forEach((v, i) => {
        text += `\${${ref(v)}}${parts[i + 1] ?? ""}`;
      });
      text += "`";
      return tagged ? `${arg(0)}${text}` : text;
    }
    throw new EmitError(`the operation "${label}" has no TypeScript form`);
  };

  /** The statements of one node. */
  const statementsOf = (node: DucNode): string[] => {
    const out = node.outputs[0];
    const label = node.label ?? "";
    if (node.kind === "literal-source") {
      if (label === "Uninitialized") return [`let ${nameOf(out as ValueId)};`];
      return [`const ${nameOf(out as ValueId)} = ${render(node)};`];
    }
    if (node.kind === "sel") return [`const ${nameOf(out as ValueId)} = ${render(node)};`];
    if (node.kind !== "op") throw new EmitError(`a ${node.kind} is not a statement`);
    const arg = (i: number): string => ref(node.inputs[i] as ValueId);
    if (label === "throw") return [`throw ${arg(0)};`];
    // A module statement's one result: written below, as its declared names.
    if (label.startsWith(DECLARES) || label.startsWith(COMPLETES)) return [];
    // A write to a binding outside the atom: `name = value` (#1276).
    if (label === "binding=") {
      const written = node.outputs[0];
      return [
        `${arg(0)} = ${arg(1)};`,
        ...(written !== undefined ? [`const ${nameOf(written)} = ${arg(1)};`] : []),
      ];
    }
    if (out === undefined) throw new EmitError(`the statement "${label}" has no TypeScript form`);
    const name = nameOf(out);
    if (
      label.startsWith("object:") &&
      objectSlots(JSON.parse(label.slice(7))).some((x) => x.member)
    ) {
      // `{ "k": v, name(..) {..}, get name() {..}, [key]: v }`: a member is written in place (#1276).
      const lines = [`const ${name} = {`];
      for (const slot of objectSlots(JSON.parse(label.slice("object:".length)))) {
        const value = node.inputs[slot.value] as ValueId;
        const key =
          slot.key !== undefined
            ? `[${ref(node.inputs[slot.key] as ValueId)}]`
            : JSON.stringify(slot.name);
        if (slot.member === undefined) {
          lines.push(slot.spread ? `  ...${ref(value)},` : `  ${key}: ${ref(value)},`);
          continue;
        }
        const c = producer.get(value);
        if (c?.closure === undefined || !classMembers.has(c.id))
          throw new EmitError(`member ${slot.name} of object ${node.id} is not its own closure`);
        const inner = emitFunction(
          c.closure,
          `${prefix}${c.id}_`,
          c.inputs.map((v) => ref(v)),
          imports,
        );
        const own = c.label ?? "";
        const mode = `${own.startsWith("async ") ? "async " : ""}${own.endsWith("*") ? "*" : ""}`;
        const head = slot.member === "method" ? `${mode}${key}` : `${slot.member} ${key}`;
        lines.push(
          `  ${head}(${inner.params.join(", ")}) {`,
          ...inner.body.map((l) => `    ${l}`),
          "  },",
        );
      }
      lines.push("};");
      return lines;
    }
    if (label.startsWith("class:")) {
      // `class Self_ { constructor(..) {..} [static] name(..) {..} get name() {..} }`, and the
      // fields and static blocks of #1330. A computed name's key is the input before the member's.
      const members = JSON.parse(label.slice("class:".length)) as [
        string,
        (string | null)?,
        boolean?,
      ][];
      // `class Self_ extends P {`: the parent is the first input (#1276).
      const lines = [
        `const ${name} = class Self_${members[0]?.[0] === "extends" ? ` extends ${arg(0)}` : ""} {`,
      ];
      let at = 0;
      for (const [kind, member, isStatic] of members) {
        if (kind === "extends") {
          at++;
          continue;
        }
        const key =
          kind !== "constructor" && kind !== "block" && member === null
            ? `[${ref(node.inputs[at++] as ValueId)}]`
            : (member ?? "");
        const c = producer.get(node.inputs[at] as ValueId);
        if (c?.closure === undefined || !classMembers.has(c.id))
          throw new EmitError(`member ${at} of class ${node.id} is not its own closure`);
        at++;
        const inner = emitFunction(
          c.closure,
          `${prefix}${c.id}_`,
          c.inputs.map((v) => ref(v)),
          imports,
        );
        const body = inner.body.map((l) => `    ${l}`);
        if (kind === "field") {
          // The initializer runs with the instance (or the class) as `this`, as the arrow sees it.
          lines.push(
            `  ${isStatic === true ? "static " : ""}${key} = (() => {`,
            ...body,
            "  })();",
          );
          continue;
        }
        if (kind === "block") {
          lines.push(
            "  static {",
            "    (() => {",
            ...body.map((l) => `  ${l}`),
            "    })();",
            "  }",
          );
          continue;
        }
        // A method's `async` and `*` are in its closure's label.
        const own = c.label ?? "";
        const mode = `${own.startsWith("async ") ? "async " : ""}${own.endsWith("*") ? "*" : ""}`;
        const head =
          kind === "constructor"
            ? "constructor"
            : `${isStatic === true ? "static " : ""}${kind === "method" ? mode : `${kind} `}${key}`;
        lines.push(`  ${head}(${inner.params.join(", ")}) {`, ...body, "  }");
      }
      lines.push("};");
      return lines;
    }
    if (node.closure !== undefined) {
      const recursive = node.closure.nodes.some((n) => n.label === "function-self");
      const arrow = label === "closure" || label === "async closure";
      // A capture is a value: a loop's carried variable is reassigned, so the closure captures a const
      // of its value where it is made (#1330), as a for loop's header binding is captured per pass.
      const snapshots: string[] = [];
      const captured = node.inputs.map((v, i) => {
        const r = ref(v);
        if (!carriedNames.has(r)) return r;
        snapshots.push(`const ${name}_c${i} = ${r};`);
        return `${name}_c${i}`;
      });
      // A recursive arrow is the const it initializes, and reads itself by that name, as written.
      const inner = emitFunction(
        node.closure,
        `${prefix}${node.id}_`,
        captured,
        imports,
        false,
        recursive && arrow ? name : "Fn_",
      );
      // A function sees its caller's receiver; an arrow sees the enclosing one, as a capture. A
      // function that reads itself is named, `function Fn_(..)`, and reads that name.
      // `async`, and a generator's `*`, are in the label (#1276); a generator is always a function.
      const isAsync = label.startsWith("async ");
      const base = isAsync ? label.slice("async ".length) : label;
      const fn = `${isAsync ? "async " : ""}function${base === "function*" ? "*" : ""}`;
      const params = inner.params.join(", ");
      const head =
        recursive && !arrow
          ? `${fn} Fn_(${params}) {`
          : base === "closure"
            ? `${isAsync ? "async " : ""}(${params}) => {`
            : `${fn} (${params}) {`;
      return [...snapshots, `const ${name} = ${head}`, ...inner.body.map((l) => `  ${l}`), "};"];
    }
    // A reassigned variable is a temporary, and the value's own name is a const: a closure that
    // captures the value then captures a name that is never assigned again.
    const t = `${name}$`;
    if (COMPOUND.has(label))
      return [`let ${t} = ${arg(0)};`, `${t} ${label} ${arg(1)};`, `const ${name} = ${t};`];
    if (label === "++" || label === "--")
      return [`let ${t} = ${arg(0)};`, `${label}${t};`, `const ${name} = ${t};`];
    if (label === "post++" || label === "post--") {
      return [`let ${t} = ${arg(0)};`, `${t}${label.slice(4)};`, `const ${name} = ${t};`];
    }
    if (label.startsWith(".") && label.endsWith("=")) {
      return [
        `let ${t} = ${arg(0)};`,
        `${t}${label.slice(0, -1)} = ${arg(1)};`,
        `const ${name} = ${t};`,
      ];
    }
    if (label === "[]=")
      return [`let ${t} = ${arg(0)};`, `${t}[${arg(1)}] = ${arg(2)};`, `const ${name} = ${t};`];
    return [`const ${name} = ${render(node)};`];
  };

  const indent = (lines: string[]): string[] => lines.map((l) => `  ${l}`);
  const nodeIndex = new Map(g.nodes.map((n, i) => [n.id, i] as const));

  /** The values a node needs, through the inline nodes it writes. */
  const needs = (node: DucNode): ValueId[] =>
    [...node.inputs, ...(after.get(node.id) ?? [])].flatMap((v) => {
      const p = producer.get(v);
      // A class needs what its members capture. A heap-ordered inline value (a spread) is still
      // needed itself: the statement that writes it is where it is made.
      if (p === undefined || !(inline.has(p.id) || classMembers.has(p.id))) return [v];
      return heapOrdered(p) ? [v, ...needs(p)] : needs(p);
    });
  /** A node ordered among the heap operations: its place is structure (#1285). */
  const heapOrdered = (n: DucNode): boolean =>
    isHeapLabel(n.label ?? "") || (after.get(n.id)?.length ?? 0) > 0;
  /**
   * The values of the heap-ordered inline nodes a node writes (a spread), through the inline nodes
   * it writes: a statement ordered after one of them comes after the statement that writes it.
   */
  const writtenInline = (node: DucNode): ValueId[] =>
    node.inputs.flatMap((v) => {
      const p = producer.get(v);
      if (p === undefined || !inline.has(p.id)) return [];
      return [...(heapOrdered(p) ? p.outputs : []), ...writtenInline(p)];
    });
  /** The values made inside a region (a branch side or a loop body), nested regions included. */
  const madeWithin = (path: string): ValueId[] =>
    g.nodes.filter((n) => isPrefix(path, n.region)).flatMap((n) => n.outputs);
  /** What the nodes inside a region need from outside it, their order included. */
  const neededBy = (paths: readonly string[]): ValueId[] => {
    const inside = new Set(paths.flatMap(madeWithin));
    return [
      ...g.nodes
        .filter((n) => paths.some((path) => isPrefix(path, n.region)))
        .flatMap((n) => [...n.inputs, ...(after.get(n.id) ?? [])]),
      // A branch inside tests its condition there: a value from outside it is needed first too
      // (an arrow's default, tested in a side after an early return, #1292).
      ...branches.filter((b) => paths.some((path) => isPrefix(path, b.within))).map((b) => b.cond),
    ].filter((v) => !inside.has(v));
  };

  const emitBranch = (b: DucBranch): string[] => {
    const thenPath = sidePath(b, "t");
    const elsePath = sidePath(b, "e");
    const inside = (v: ValueId): boolean => {
      const region = producer.get(v)?.region;
      return isPrefix(thenPath, region) || isPrefix(elsePath, region);
    };
    const joins = g.nodes.filter((n) => owners.get(n.id)?.id === b.id);
    const before: string[] = [];
    const thenAssign: string[] = [];
    const elseAssign: string[] = [];
    const after: string[] = [];
    for (const j of joins) {
      const [cond, t, e] = j.inputs as [ValueId, ValueId, ValueId];
      // The join's variable starts from a value from before the if, so the binding adds no node.
      // When both sides compute theirs, it starts unassigned, and each side assigns it.
      const start = !inside(e) ? e : !inside(t) ? t : undefined;
      const name = nameOf(j.outputs[0] as ValueId);
      const temp = `${name}$`;
      before.push(start !== undefined ? `let ${temp} = ${ref(start)};` : `let ${temp};`);
      if (t !== start) thenAssign.push(`${temp} = ${ref(t)};`);
      if (e !== start) elseAssign.push(`${temp} = ${ref(e)};`);
      after.push(`const ${name} = ${temp};`);
    }
    const thenLines = [...emitScope(thenPath), ...thenAssign];
    const elseLines = [...emitScope(elsePath), ...elseAssign];
    return [
      ...before,
      `if (${ref(b.cond)}) {`,
      ...indent(thenLines),
      ...(elseLines.length > 0 ? ["} else {", ...indent(elseLines)] : []),
      "}",
      ...after,
    ];
  };

  /** The names of loops' carried variables: assigned at the end of each pass. */
  const carriedNames = new Set<string>();

  const emitLoop = (loop: DucNode): string[] => {
    const rec = loop.loop as DucLoop;
    const count = rec.carry.length;
    const carried = rec.carry.map((v) => nameOf(v));
    for (const c of carried) carriedNames.add(c);
    const before = carried.map((name, i) => `let ${name} = ${ref(loop.inputs[i] as ValueId)};`);
    const guarded = guardLoops.has(loop.id);
    const header =
      rec.iterate !== undefined
        ? `for ${rec.iterate.of === "async values" ? "await " : ""}(const ${nameOf(rec.iterate.element)} ${rec.iterate.of === "keys" ? "in" : "of"} ${ref(loop.inputs[count] as ValueId)}) {`
        : guarded
          ? "while (true) {"
          : `while (${ref(rec.cond as ValueId)}) {`;
    // An iterating loop's condition stops it before an element's body (#1276).
    const guard =
      rec.iterate !== undefined && rec.cond !== undefined
        ? [`if (!(${ref(rec.cond)})) break;`]
        : [];
    // A condition written in the body: what it needs, then the test, then the rest (#1276).
    const body = emitScope(
      bodyPathOf(loop),
      guarded
        ? { cond: rec.cond as ValueId, line: `if (!(${ref(rec.cond as ValueId)})) break;` }
        : undefined,
    );
    // An invariant the body never uses (the condition of a branch left empty, `if (x) {}`) is still
    // read in the body: lifted again, the read is the same invariant (#1292).
    const unused = rec.invariant
      .filter((v) => (consumers.get(v) ?? []).length === 0)
      .map((v) => `${ref(v)};`);
    body.unshift(...unused);
    // A carried value the body never reads (only the header's condition does), whose next value is
    // made outside the body (a constant, an outer value), is assigned as the pass starts, not as it
    // ends (#1292): the same loop, and nothing in the body (a branch that throws, whose join would
    // otherwise take it) can come between. Lifted again, its next value is that value either way.
    const bodyText = body.join("\n");
    const declaredInBody = (text: string): boolean =>
      new RegExp(`(?:const|let) ${text.replace(/\$/g, "\\$")}\\b`).test(bodyText);
    const nextValues = rec.next.map((v) => ref(v));
    const early = rec.next.map((v, i) => {
      const name = carried[i] as string;
      const value = ref(v);
      const read =
        new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(bodyText) ||
        nextValues.some((other, j) => j !== i && other === name);
      const outside = !/^[\w$]+$/.test(value) || /^\d/.test(value) || !declaredInBody(value);
      return !read && outside && value !== name;
    });
    body.unshift(...rec.next.flatMap((v, i) => (early[i] ? [`${carried[i]} = ${ref(v)};`] : [])));
    // The carries take their next values together: a next value that is another carry's current
    // value is read into a temporary first, before any carry is assigned (#1292).
    const late = rec.next.flatMap((v, i) =>
      early[i] ? [] : [[carried[i] as string, ref(v)] as const],
    );
    const lateNames = new Set(late.map(([name]) => name));
    const held = late.filter(([, value]) => lateNames.has(value));
    const next = [
      ...held.map(([name, value]) => `const ${name}$next = ${value};`),
      ...late.map(([name, value]) =>
        lateNames.has(value) ? `${name} = ${name}$next;` : `${name} = ${value};`,
      ),
    ];
    // Tested again after the pass, on the carried values the next pass starts from, so a stop
    // leaves before the next element is pulled (#1330). Only a condition over the carried values
    // alone can be tested there.
    const names = guard.length > 0 ? (guard[0]?.match(/\$[\w$]+/g) ?? []) : [];
    const retest = guard.length > 0 && names.every((name) => carried.includes(name)) ? guard : [];
    const after = loop.outputs.map((v, i) => `const ${nameOf(v)} = ${carried[i]};`);
    return [...before, header, ...indent([...guard, ...body, ...next, ...retest]), "}", ...after];
  };

  /** The statements of one scope, each after the values it needs. */
  function emitScope(
    scope: string | undefined,
    guard?: { readonly cond: ValueId; readonly line: string },
  ): string[] {
    interface Item {
      readonly first: number;
      /** 0 for a statement, 1 for a branch that may throw, 2 for a throw: each waits for the ones before. */
      readonly last: number;
      readonly produces: readonly ValueId[];
      readonly requires: readonly ValueId[];
      readonly lines: () => string[];
    }
    const items: Item[] = [];
    for (const node of g.nodes) {
      if (
        node.region !== scope ||
        owners.has(node.id) ||
        inline.has(node.id) ||
        classMembers.has(node.id)
      )
        continue;
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
        // What it writes inline is made where it is: a heap token of an inline spread orders what
        // follows after this statement.
        produces: [...node.outputs, ...writtenInline(node)],
        requires: needs(node).filter((v) => !writtenInline(node).includes(v)),
        lines: () => statementsOf(node),
      });
    }
    for (const loop of loops) {
      if (loop.region !== scope) continue;
      const body = bodyPathOf(loop);
      items.push({
        first: nodeIndex.get(loop.id) as number,
        // A statement ordered after one inside the body comes after the loop.
        produces: [...loop.outputs, ...madeWithin(body)],
        requires: [
          ...new Set([...loop.inputs, ...(after.get(loop.id) ?? []), ...neededBy([body])]),
        ],
        lines: () => emitLoop(loop),
        last: 0,
      });
    }
    for (const b of branches) {
      if (b.within !== scope || lazyBranches.has(b.id)) continue;
      const thenPath = sidePath(b, "t");
      const elsePath = sidePath(b, "e");
      const subtree = g.nodes.filter(
        (n) => isPrefix(thenPath, n.region) || isPrefix(elsePath, n.region),
      );
      const joins = g.nodes.filter((n) => owners.get(n.id)?.id === b.id);
      const innerValues = new Set(subtree.flatMap((n) => n.outputs));
      const requires = [
        b.cond,
        ...neededBy([thenPath, elsePath]),
        ...joins.flatMap((n) => n.inputs),
      ];
      items.push({
        first: Math.min(
          g.nodes.length,
          ...[...subtree, ...joins].map((n) => nodeIndex.get(n.id) as number),
        ),
        // A side that throws leaves the function: what does not depend on the branch comes first,
        // as it came before the if in the source (the rest of a function is inside its sides).
        last: subtree.some((n) => n.label === "throw") ? 1 : 0,
        // A statement ordered after one inside a side comes after the branch.
        produces: [...joins.flatMap((n) => n.outputs), ...innerValues],
        requires: [...new Set(requires)].filter((v) => !innerValues.has(v)),
        lines: () => emitBranch(b),
      });
    }
    // A throw ends its scope, so it comes after everything else there.
    items.sort((a, b) => (a.last === b.last ? a.first - b.first : a.last - b.last));
    const producedBy = new Map<ValueId, number>();
    for (const [i, item] of items.entries()) for (const v of item.produces) producedBy.set(v, i);
    const done = new Set<number>();
    const lines: string[] = [];
    // With a guard: first the items the condition needs (its cone), then the test, then the rest.
    const cone = new Set<number>();
    if (guard !== undefined) {
      const visit = (v: ValueId): void => {
        const i = producedBy.get(v);
        if (i === undefined || cone.has(i)) return;
        cone.add(i);
        for (const r of (items[i] as Item).requires) visit(r);
      };
      visit(guard.cond);
    }
    const schedule = (allowed: (i: number) => boolean): void => {
      for (;;) {
        const ready = (item: Item, i: number): boolean =>
          allowed(i) &&
          !done.has(i) &&
          item.requires.every((v) => {
            const p = producedBy.get(v);
            return p === undefined || done.has(p);
          });
        if (!items.some(ready)) return;
        // The earliest rank that has a ready item: a later rank waits while an earlier one can run.
        const rank = Math.min(...items.filter(ready).map((item) => item.last));
        const next = items.findIndex((item, i) => ready(item, i) && item.last === rank);
        done.add(next);
        lines.push(...(items[next] as Item).lines());
      }
    };
    if (guard !== undefined) {
      schedule((i) => cone.has(i));
      lines.push(guard.line);
    }
    schedule(() => true);
    if (done.size < items.length) throw new EmitError("the graph has a cycle");
    return lines;
  }

  // A free or ambient name that nothing uses is still part of the atom: it is read on its own.
  const used = new Set<ValueId>([...g.obs, ...branches.map((b) => b.cond)]);
  for (const node of g.nodes) for (const v of node.inputs) used.add(v);
  const unread = g.nodes
    .filter((n) => n.kind === "diamond-source" && !used.has(n.outputs[0] as ValueId))
    .map((n) => `${nameOf(n.outputs[0] as ValueId)};`);

  const params = g.nodes
    .filter((n) => n.kind === "param-source" && paramIndex(n.label) >= bound.length)
    .sort((a, b) => paramIndex(a.label) - paramIndex(b.label))
    .map(
      (n) =>
        `${isRestParam(n.label) ? "..." : ""}${nameOf(n.outputs[0] as ValueId)}${isDefaultedParam(n.label) ? " = undefined" : ""}`,
    );
  const body = [...unread, ...emitScope(undefined)];
  if (asModule) {
    // Each declared name is a module-level name, given its value at the end; the statements are in
    // a block, so the emitter's temporaries are not the module's (#1290, #1292).
    // A completion record (#1297) is written as two more module names, before the declared ones:
    // whether the fragment returned, and what (lifted again, they are the record's first inputs).
    const completion = completionOf(g);
    const names =
      completion !== undefined
        ? [RETURNED_NAME, RETURN_VALUE_NAME, ...completion]
        : (declaredNamesOf(g) as string[]);
    const declares = g.nodes.find((n) => n.outputs.includes(g.obs[0] as ValueId)) as DucNode;
    // `default` is not a variable: its value is held by the lowering's own name, exported as default.
    const local = (name: string): string => (name === "default" ? "__yakccExportDefault" : name);
    // A name exported as it is (`export { parse };` of a name the statement does not define) is
    // the free name itself: no module-level name of its own, which would shadow it.
    const itself = (name: string, k: number): boolean => {
      const source = g.nodes.find((n) => n.outputs.includes(declares.inputs[k] as ValueId));
      return (
        source?.kind === "diamond-source" &&
        source.diamond?.reason === "free-identifier" &&
        source.diamond.symbol === name
      );
    };
    const held = names.flatMap((name, k) => (itself(name, k) ? [] : [[name, k] as const]));
    // A declared name the statements also read free (a function bound where it stands, read above
    // its declaration) must not be in scope above it: the values are carried out of the block in
    // the lowering's own names and declared after it.
    const readFree = new Set(
      g.nodes.flatMap((n) =>
        n.kind === "diamond-source" && n.diamond?.reason === "free-identifier"
          ? [n.diamond.symbol]
          : [],
      ),
    );
    const after = held.some(([name]) => readFree.has(name));
    const carrier = (name: string, k: number): string =>
      after ? `__yakccDeclared${k}` : local(name);
    return {
      params,
      body: [
        ...(held.length > 0
          ? [`let ${held.map(([name, k]) => carrier(name, k)).join(", ")};`]
          : []),
        "{",
        ...body.map((l) => `  ${l}`),
        ...held.map(
          ([name, k]) => `  ${carrier(name, k)} = ${ref(declares.inputs[k] as ValueId)};`,
        ),
        "}",
        ...(after ? held.map(([name, k]) => `let ${local(name)} = ${carrier(name, k)};`) : []),
        // Every declared name exported, in order: lifted again, the same names in the same order.
        ...names.map((name) =>
          name === "default" ? "export default __yakccExportDefault;" : `export { ${name} };`,
        ),
      ],
    };
  }
  const obs = g.obs[0];
  if (obs !== undefined) body.push(`return ${ref(obs)};`);
  return { params, body };
}
