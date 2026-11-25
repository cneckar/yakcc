// SPDX-License-Identifier: Apache-2.0
/**
 * A program record (#1333): an entry module and every module it imports, transitively, each as the
 * ordered statements the native lowering links (`emitNativeModules`), with its ECMAScript linking:
 * what each import names, what each export is, and the modules evaluated before it. Module
 * specifiers resolve as Node resolves them (relative files, a `.js` specifier to its `.ts` source,
 * packages through `node_modules` and their `exports`).
 *
 * A module's statements are its top-level statements, each lifted on its own:
 * - a function declaration is a function record of its name;
 * - any other statement (a class, a variable, an expression) is a statement record of the names it
 *   declares;
 * - import and export declarations are not statements: they are the linking;
 * - `export default <expression>` is a statement that declares the default export's binding;
 * - type-only declarations (interfaces, type aliases, `import type`, `declare`) are erased.
 *
 * Refused, with the reason: dynamic `import()`, `import.meta`, and a specifier that does not resolve.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { Node, Project, type SourceFile, type Statement } from "ts-morph";
import type {
  NativeEsm,
  NativeImport,
  NativeModule,
  NativeModuleStatement,
} from "./emit-llvm-boxed.js";
import { atomShape, liftAtom } from "./lift.js";

export class ProgramError extends Error {}

/** The binding `export default <expression>` declares. */
export const DEFAULT_BINDING = "__yk_default";

/** A program: its modules (the entry's id first), each with its ECMAScript linking. */
export interface ProgramRecord {
  readonly entry: string;
  readonly modules: readonly NativeModule[];
}

/** Where a module specifier, imported by a file, resolves to. */
function resolveSpecifier(spec: string, from: string): string {
  if (
    spec.startsWith("node:") ||
    (!spec.startsWith(".") && !spec.startsWith("/") && isBuiltin(spec))
  )
    throw new ProgramError(
      `the platform module ${spec} is not in the native base set yet (imported by ${from})`,
    );
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const base = resolve(dirname(from), spec);
    const candidates = [
      base,
      base.replace(/\.js$/, ".ts"),
      base.replace(/\.mjs$/, ".mts"),
      `${base}.ts`,
      `${base}.js`,
      resolve(base, "index.ts"),
      resolve(base, "index.js"),
    ];
    const hit = candidates.find((c) => existsSync(c) && !c.endsWith("/"));
    if (hit === undefined) throw new ProgramError(`${spec} does not resolve (imported by ${from})`);
    return hit;
  }
  try {
    return createRequire(from).resolve(spec);
  } catch {
    throw new ProgramError(`${spec} does not resolve (imported by ${from})`);
  }
}
function isBuiltin(spec: string): boolean {
  return createRequire(import.meta.url)("node:module").builtinModules.includes(spec.split("/")[0]);
}

const hasModifier = (st: Statement, kind: "export" | "default" | "declare"): boolean =>
  Node.isModifierable(st) && st.getModifiers().some((m) => m.getText() === kind);

/** A statement's text without its export modifiers (`export`, `export default`). */
const withoutExport = (text: string): string => text.replace(/^export\s+(default\s+)?/, "");

/** The ECMAScript program of an entry file: every module it reaches, in a fixed order. */
export function programRecord(entryFile: string, root = process.cwd()): ProgramRecord {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const idOf = (file: string): string => relative(root, file).replace(/\\/g, "/");
  const modules = new Map<string, NativeModule>();
  const visit = (file: string): void => {
    const id = idOf(file);
    if (modules.has(id)) return;
    // A placeholder first: a cycle sees the module as known.
    modules.set(id, { id, statements: [] });
    const text = readFileSync(file, "utf8");
    if (/\bimport\s*\(/.test(text) && /(^|[^.\w])import\s*\(/m.test(text))
      throw new ProgramError(`a dynamic import() is not in the native subset yet (${id})`);
    if (/\bimport\.meta\b/.test(text))
      throw new ProgramError(`import.meta is not in the native subset yet (${id})`);
    const sf = project.createSourceFile(`/m/${modules.size}.ts`, text, { overwrite: true });
    const parsed = moduleOf(sf, file, id, (spec) => idOf(resolveSpecifier(spec, file)));
    modules.set(id, parsed.module);
    for (const spec of parsed.specifiers) visit(resolveSpecifier(spec, file));
  };
  visit(resolve(entryFile));
  return { entry: idOf(resolve(entryFile)), modules: [...modules.values()] };
}

/** One module's statements and linking, with the specifiers it names (to visit). */
function moduleOf(
  sf: SourceFile,
  file: string,
  id: string,
  target: (spec: string) => string,
): { module: NativeModule; specifiers: string[] } {
  const statements: NativeModuleStatement[] = [];
  const imports: Record<string, NativeImport> = {};
  const exports: Record<string, { local: string } | NativeImport> = {};
  const stars: string[] = [];
  const deps: string[] = [];
  const specifiers: string[] = [];
  const dep = (spec: string): string => {
    const t = target(spec);
    if (!deps.includes(t)) deps.push(t);
    specifiers.push(spec);
    return t;
  };
  const lift = (text: string, what: string): NativeModuleStatement => {
    const shape = atomShape(text);
    try {
      return {
        kind: shape.kind,
        declares:
          shape.kind === "function" ? (shape.name !== undefined ? [shape.name] : []) : shape.names,
        graph: liftAtom(text),
      };
    } catch (e) {
      throw new ProgramError(`${id}: ${what} does not lift: ${(e as Error).message}`);
    }
  };
  for (const st of sf.getStatements()) {
    if (Node.isImportDeclaration(st)) {
      if (st.isTypeOnly()) continue;
      const from = dep(st.getModuleSpecifierValue());
      const def = st.getDefaultImport();
      if (def !== undefined) imports[def.getText()] = { module: from, name: "default" };
      const ns = st.getNamespaceImport();
      if (ns !== undefined) imports[ns.getText()] = { module: from, name: "*" };
      for (const el of st.getNamedImports()) {
        if (el.isTypeOnly()) continue;
        const local = (el.getAliasNode() ?? el.getNameNode()).getText();
        imports[local] = { module: from, name: el.getNameNode().getText() };
      }
      continue;
    }
    if (Node.isExportDeclaration(st)) {
      if (st.isTypeOnly()) continue;
      const spec = st.getModuleSpecifierValue();
      const from = spec !== undefined ? dep(spec) : undefined;
      const ns = st.getNamespaceExport();
      if (from !== undefined && !st.hasNamedExports() && ns === undefined) {
        stars.push(from);
        continue;
      }
      if (from !== undefined && ns !== undefined) {
        exports[ns.getName()] = { module: from, name: "*" };
        continue;
      }
      for (const el of st.getNamedExports()) {
        if (el.isTypeOnly()) continue;
        const name = (el.getAliasNode() ?? el.getNameNode()).getText();
        const local = el.getNameNode().getText();
        exports[name] = from !== undefined ? { module: from, name: local } : { local };
      }
      continue;
    }
    if (Node.isExportAssignment(st)) {
      if (st.isExportEquals()) throw new ProgramError(`${id}: export = is not ECMAScript`);
      statements.push(
        lift(`const ${DEFAULT_BINDING} = ${st.getExpression().getText()};`, "export default"),
      );
      exports.default = { local: DEFAULT_BINDING };
      continue;
    }
    if (
      Node.isInterfaceDeclaration(st) ||
      Node.isTypeAliasDeclaration(st) ||
      hasModifier(st, "declare") ||
      Node.isEmptyStatement(st)
    )
      continue;
    const exported = hasModifier(st, "export");
    const isDefault = hasModifier(st, "default");
    const record = lift(
      withoutExport(st.getText()),
      `a statement at line ${st.getStartLineNumber()}`,
    );
    statements.push(record);
    if (!exported) continue;
    if (isDefault) {
      const name = record.declares[0];
      if (name === undefined)
        throw new ProgramError(`${id}: an anonymous default export is not in the subset yet`);
      exports.default = { local: name };
    } else for (const name of record.declares) exports[name] = { local: name };
  }
  const esm: NativeEsm = { imports, exports, stars, deps };
  void file;
  return { module: { id, statements, esm }, specifiers };
}

/** A module given as source: an id and its CommonJS text. */
export interface SourceModule {
  readonly id: string;
  readonly source: string;
}

/**
 * The wrapper's names Node binds for a module of its library (`exports`, `require` and `module` are
 * the module record's own): bound here by a first statement that takes them from the environment
 * module `yakcc:node-env` (DEC-DUC-NODE-BASE-SET-001, section 3).
 */
export const NODE_ENV = "yakcc:node-env";
const NODE_PRELUDE = `const { primordials, internalBinding, process } = require("${NODE_ENV}");`;

/**
 * A program of Node's library (#1331, P2): the entry, then each builtin module it requires at its
 * top level, transitively, read from `lib` (one file per builtin id), each a CommonJS module with
 * the wrapper's names bound (NODE_PRELUDE). `extra` modules (the environment, and anything a test
 * provides) are taken as given. A require inside a function names a module only when it runs: one
 * outside the program then fails there, as a missing module does; `include` names such modules
 * (and theirs, transitively) to put in the program all the same.
 */
export function nodeLibraryProgram(
  lib: string,
  entry: SourceModule,
  extra: readonly SourceModule[] = [],
  include: readonly string[] = [],
): ProgramRecord {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const given = new Map([entry, ...extra].map((m) => [m.id, m.source] as const));
  const modules = new Map<string, NativeModule>();
  const visit = (id: string): void => {
    if (modules.has(id)) return;
    modules.set(id, { id, statements: [] });
    let text = given.get(id);
    if (text === undefined) {
      const file = resolve(lib, `${id}.js`);
      if (!existsSync(file)) throw new ProgramError(`no module ${id} in ${lib}`);
      text = `${NODE_PRELUDE}\n${readFileSync(file, "utf8")}`;
    }
    const parsed = commonJsModuleOf(project, text, id);
    modules.set(id, parsed.module);
    for (const dep of parsed.topLevel) visit(dep);
  };
  visit(entry.id);
  for (const id of include) visit(id);
  return { entry: entry.id, modules: [...modules.values()] };
}

/** The table of Node's library modules a boot program holds: id → its compiled wrapper function. */
export const NODE_BUILTINS = "yakcc:builtins";
/** The bindings a boot program is given beyond the runtime's (a module exporting name → binding). */
export const NODE_BINDINGS = "yakcc:bindings";

/**
 * Each wrapper's parameters, as Node's BuiltinLoader::LookupAndCompile gives them: the per-context
 * scripts', the realm bootstrapper's, and every other module's.
 */
function wrapperParameters(id: string): string {
  if (id.startsWith("internal/per_context/"))
    return "exports, primordials, privateSymbols, perIsolateSymbols";
  if (id === "internal/bootstrap/realm")
    return "process, getLinkedBinding, getInternalBinding, primordials";
  if (id.startsWith("internal/main/") || id.startsWith("internal/bootstrap/"))
    return "process, require, internalBinding, primordials";
  return "exports, require, module, process, internalBinding, primordials";
}

/** The specifiers a module's text requires outside any function: what loading it loads. */
function topLevelRequires(project: Project, text: string, id: string): string[] {
  const sf = project.createSourceFile(`/scan/${id.replace(/[^A-Za-z0-9]/g, "_")}.js`, text, {
    overwrite: true,
  });
  const out: string[] = [];
  sf.forEachDescendant((n) => {
    if (!Node.isCallExpression(n)) return;
    const callee = n.getExpression();
    const arg = n.getArguments()[0];
    if (!Node.isIdentifier(callee) || !["require", "requireBuiltin"].includes(callee.getText()))
      return;
    if (arg === undefined || !Node.isStringLiteral(arg)) return;
    const inFunction = n.getAncestors().some((a) => Node.isFunctionLikeDeclaration(a));
    if (!inFunction && !out.includes(arg.getLiteralValue())) out.push(arg.getLiteralValue());
  });
  return out;
}

/**
 * Node's library booted as Node boots it (#1331, #1361 P2), in a program record:
 * - each library module is its wrapper function, the module text as its body, with the
 *   parameters Node's loader gives it (`wrapperParameters`);
 * - `yakcc:builtins` holds them, by id: the `builtins` binding's module table (`compileFunction`);
 * - the entry, `yakcc:node-boot`, runs the per-context scripts on a fresh primordials object, then
 *   `internal/bootstrap/realm` with the bindings (the runtime's own, `builtins`, and those of
 *   `yakcc:bindings` when given), then loads `main` through realm's `requireBuiltin`.
 *
 * The modules are `main` (given as source, loaded as a library module is) and every module loading
 * it loads, transitively, plus `include` (modules required only inside functions) and theirs.
 * A module outside the table fails when it is required: realm's "Missing internal module".
 */
export function nodeBootProgram(
  lib: string,
  main: SourceModule,
  options: {
    readonly bindings?: SourceModule;
    readonly include?: readonly string[];
    /** A directory of lifted modules by their source's hash, for repeated builds while the lifter is unchanged. */
    readonly liftCache?: string;
  } = {},
): ProgramRecord {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const texts = new Map<string, string>();
  const visit = (id: string, given?: string): void => {
    if (texts.has(id)) return;
    let text = given;
    if (text === undefined) {
      const file = resolve(lib, `${id}.js`);
      if (!existsSync(file)) throw new ProgramError(`no module ${id} in ${lib}`);
      text = readFileSync(file, "utf8");
    }
    texts.set(id, text);
    for (const dep of topLevelRequires(project, text, id)) visit(dep);
  };
  for (const id of [
    "internal/per_context/primordials",
    "internal/per_context/domexception",
    "internal/per_context/messageport",
    "internal/bootstrap/realm",
    // realm's setupPrepareStackTrace loads it while realm runs.
    "internal/errors",
  ])
    visit(id);
  visit(main.id, main.source);
  for (const id of options.include ?? []) visit(id);

  const modules: NativeModule[] = [];
  const lifted = (id: string, source: string): NativeModule => {
    const cache = options.liftCache;
    const file =
      cache === undefined
        ? undefined
        : join(
            cache,
            `${createHash("sha256").update(id).update("\0").update(source).digest("hex")}.json`,
          );
    if (file !== undefined && existsSync(file))
      return JSON.parse(readFileSync(file, "utf8")) as NativeModule;
    const parsed = commonJsModuleOf(project, source, id);
    if (file !== undefined) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(parsed.module));
    }
    return parsed.module;
  };
  for (const [id, text] of texts)
    modules.push(lifted(id, `module.exports = function (${wrapperParameters(id)}) {\n${text}\n};`));
  const ids = [...texts.keys()];
  modules.push(
    lifted(
      NODE_BUILTINS,
      `module.exports = new Map([\n${ids.map((id) => `  [${JSON.stringify(id)}, require(${JSON.stringify(id)})],`).join("\n")}\n]);`,
    ),
  );
  if (options.bindings !== undefined)
    modules.push(lifted(options.bindings.id, options.bindings.source));
  modules.unshift(lifted(NODE_BOOT, nodeBootSource(main.id, options.bindings?.id)));
  return { entry: NODE_BOOT, modules };
}

/** The boot program's entry module. */
export const NODE_BOOT = "yakcc:node-boot";

/** The runtime's `Math` value, made by the boot module before any library code runs. */
const MATH_VALUE =
  '// Math as a value (primordials copies its members): each member Math\'s own operation, the\n// approximated ones V8\'s shaved atoms (#1362); hypot, approximated with no atom yet, is absent.\nconst MathObject = {\n  E: Math.E,\n  LN10: Math.LN10,\n  LN2: Math.LN2,\n  LOG10E: Math.LOG10E,\n  LOG2E: Math.LOG2E,\n  PI: Math.PI,\n  SQRT1_2: Math.SQRT1_2,\n  SQRT2: Math.SQRT2,\n  abs: (a0) => Math.abs(a0),\n  acos: (a0) => Math.acos(a0),\n  acosh: (a0) => Math.acosh(a0),\n  asin: (a0) => Math.asin(a0),\n  asinh: (a0) => Math.asinh(a0),\n  atan: (a0) => Math.atan(a0),\n  atanh: (a0) => Math.atanh(a0),\n  atan2: (a0, a1) => Math.atan2(a0, a1),\n  ceil: (a0) => Math.ceil(a0),\n  cbrt: (a0) => Math.cbrt(a0),\n  expm1: (a0) => Math.expm1(a0),\n  cos: (a0) => Math.cos(a0),\n  cosh: (a0) => Math.cosh(a0),\n  exp: (a0) => Math.exp(a0),\n  floor: (a0) => Math.floor(a0),\n  log: (a0) => Math.log(a0),\n  log1p: (a0) => Math.log1p(a0),\n  log2: (a0) => Math.log2(a0),\n  log10: (a0) => Math.log10(a0),\n  max: (...a) => Math.max(...a),\n  min: (...a) => Math.min(...a),\n  pow: (a0, a1) => Math.pow(a0, a1),\n  random: () => Math.random(),\n  round: (a0) => Math.round(a0),\n  sign: (a0) => Math.sign(a0),\n  sin: (a0) => Math.sin(a0),\n  sinh: (a0) => Math.sinh(a0),\n  sqrt: (a0) => Math.sqrt(a0),\n  tan: (a0) => Math.tan(a0),\n  tanh: (a0) => Math.tanh(a0),\n  trunc: (a0) => Math.trunc(a0),\n  // Exact, so given here: ToUint32\'s leading zeros; Int32 multiplication; the nearest float32.\n  clz32: (x) => {\n    let v = x >>> 0;\n    if (v === 0) return 32;\n    let n = 0;\n    while ((v & 0x80000000) === 0) {\n      v = v << 1;\n      n++;\n    }\n    return n;\n  },\n  imul: (a, b) => {\n    const ah = (a >>> 16) & 0xffff;\n    const al = a & 0xffff;\n    const bh = (b >>> 16) & 0xffff;\n    const bl = b & 0xffff;\n    return (al * bl + (((ah * bl + al * bh) << 16) >>> 0)) | 0;\n  },\n  fround: (x) => new Float32Array([x])[0],\n};\nObject.defineProperty(MathObject, Symbol.toStringTag, { value: "Math", configurable: true });\n__yakccDefineGlobal("Math", MathObject);\n';

/** The boot module's source: Node's realm set up over the table, then `main` loaded. */
function nodeBootSource(main: string, bindings: string | undefined): string {
  return `${MATH_VALUE}const table = require(${JSON.stringify(NODE_BUILTINS)});
const given = ${bindings !== undefined ? `require(${JSON.stringify(bindings)})` : "{}"};
const primordials = { __proto__: null };
const privateSymbols = {
  arrow_message_private_symbol: Symbol("node:arrowMessage"),
  contextify_context_private_symbol: Symbol("node:contextify:context"),
  decorated_private_symbol: Symbol("node:decorated"),
  transfer_mode_private_symbol: Symbol("node:transfer_mode"),
  host_defined_option_symbol: Symbol("node:host_defined_option_symbol"),
  js_transferable_wrapper_private_symbol: Symbol("node:js_transferable_wrapper"),
  entry_point_module_private_symbol: Symbol("node:entry_point_module"),
  entry_point_promise_private_symbol: Symbol("node:entry_point_promise"),
  module_source_private_symbol: Symbol("node:module_source"),
  module_export_names_private_symbol: Symbol("node:module_export_names"),
  module_circular_visited_private_symbol: Symbol("node:module_circular_visited"),
  module_export_private_symbol: Symbol("node:module_export"),
  module_parent_private_symbol: Symbol("node:module_parent"),
  module_first_parent_private_symbol: Symbol("node:module_first_parent"),
  napi_type_tag: Symbol("node:napi:type_tag"),
  napi_wrapper: Symbol("node:napi:wrapper"),
  untransferable_object_private_symbol: Symbol("node:untransferableObject"),
  exit_info_private_symbol: Symbol("node:exit_info_private_symbol"),
  promise_trace_id: Symbol("node:promise_trace_id"),
  source_map_data_private_symbol: Symbol("node:source_map_data_private_symbol"),
};
const perIsolateSymbols = {
  fs_use_promises_symbol: Symbol("fs_use_promises_symbol"),
  async_id_symbol: Symbol("async_id_symbol"),
  handle_onclose_symbol: Symbol("handle_onclose"),
  no_message_symbol: Symbol("no_message_symbol"),
  messaging_deserialize_symbol: Symbol("messaging_deserialize_symbol"),
  messaging_transfer_symbol: Symbol("messaging_transfer_symbol"),
  messaging_clone_symbol: Symbol("messaging_clone_symbol"),
  messaging_transfer_list_symbol: Symbol("messaging_transfer_list_symbol"),
  oninit_symbol: Symbol("oninit"),
  owner_symbol: Symbol("owner_symbol"),
  onpskexchange_symbol: Symbol("onpskexchange"),
  resource_symbol: Symbol("resource_symbol"),
  trigger_async_id_symbol: Symbol("trigger_async_id_symbol"),
  vm_dynamic_import_default_internal: Symbol("vm_dynamic_import_default_internal"),
  vm_dynamic_import_main_context_default: Symbol("vm_dynamic_import_main_context_default"),
  vm_dynamic_import_missing_flag: Symbol("vm_dynamic_import_missing_flag"),
  vm_dynamic_import_no_callback: Symbol("vm_dynamic_import_no_callback"),
  vm_context_no_contextify: Symbol("vm_context_no_contextify"),
  entry_point_module_private_symbol: Symbol("entry_point_module"),
  entry_point_promise_private_symbol: Symbol("entry_point_promise"),
};
const exportsOfContext = {};
for (const id of ["internal/per_context/primordials", "internal/per_context/domexception", "internal/per_context/messageport"])
  table.get(id)(exportsOfContext, primordials, privateSymbols, perIsolateSymbols);
let loaders;
const runtime = {
  // The module table: the program's library modules, each its wrapper function.
  builtins: {
    builtinIds: [...table.keys()],
    compileFunction: (id) => table.get(id),
    setInternalLoaders: (internalBinding, requireBuiltin) => { loaders = { internalBinding, requireBuiltin }; },
    hasCachedBuiltins: () => true,
    natives: {},
  },
  // This binary's build configuration: no ICU and no OpenSSL in it yet.
  config: {
    hasIntl: false,
    hasSmallICU: false,
    hasInspector: false,
    hasOpenSSL: false,
    openSSLIsBoringSSL: false,
    fipsMode: false,
    hasNodeOptions: true,
    noBrowserGlobals: false,
    isDebugBuild: false,
    bits: 64,
  },
  // Startup snapshots are out of scope (#1361 "later"): this program is never building one.
  mksnapshot: {
    setSerializeCallback: () => {},
    setDeserializeCallback: () => {},
    setDeserializeMainFunction: () => {},
    isBuildingSnapshotBuffer: new Uint8Array(1),
  },
  // Tracing is out of scope (#1361 "later"): every category off.
  trace_events: {
    getCategoryEnabledBuffer: () => new Uint8Array(1),
    trace: () => {},
    isTraceCategoryEnabled: () => false,
    setTraceCategoryStateUpdateHandler: () => {},
    getEnabledCategories: () => "",
  },
  // Ports between threads (#1361 later); DOMException is per_context/domexception's.
  messaging: {
    setDeserializerCreateObjectFunction: () => {},
    DOMException: exportsOfContext.DOMException,
  },
  // ES module linking: not yet (#1361 P2).
  module_wrap: { ModuleWrap: class ModuleWrap {}, kInstantiated: 2, kEvaluated: 4, kErrored: 5 },
  // Stack traces: the runtime keeps none yet; the callbacks are kept.
  errors: {
    setPrepareStackTraceCallback: () => {},
    setEnhanceStackForFatalException: () => {},
    setGetSourceMapErrorSource: () => {},
    setSourceMapsEnabled: () => {},
    setMaybeCacheGeneratedSourceMap: () => {},
    noSideEffectsToString: (v) => String(v),
    triggerUncaughtException: (e) => { throw e; },
    exitCodes: { kNoFailure: 0, kGenericUserError: 1 },
  },
};
// env_properties.h's symbols: the util binding's private ones, and the symbols binding.
runtime.symbols = perIsolateSymbols;
runtime.util = { privateSymbols };
// A binding is the runtime's members (V8's role, and the boot's own) with the given ones (node/src's,
// shaved) beside them.
const made = { __proto__: null };
function getInternalBinding(name) {
  if (made[name] !== undefined) return made[name];
  const parts = [given[name], runtime[name], __yakccRuntimeBinding(name)].filter((p) => p !== undefined);
  if (parts.length === 0) throw new Error("No such binding: " + name);
  if (parts.length === 1) return (made[name] = parts[0]);
  const b = {};
  for (const p of parts) for (const k of Reflect.ownKeys(p)) b[k] = k === "constants" && b.constants !== undefined ? { ...b.constants, ...p.constants } : p[k];
  return (made[name] = b);
}
function getLinkedBinding(name) {
  throw new Error("No such binding: " + name);
}
table.get("internal/bootstrap/realm")(process, getLinkedBinding, getInternalBinding, primordials);
// console, as Node's prints: each line formatted by internal/util/inspect's formatWithOptions.
let inspectModule;
const formatLine = (args) =>
  (inspectModule ??= loaders.requireBuiltin("internal/util/inspect")).formatWithOptions({}, ...args) + "\\n";
const toStdout = (...args) => process.stdout.write(formatLine(args));
const toStderr = (...args) => process.stderr.write(formatLine(args));
__yakccDefineGlobal("console", {
  log: toStdout,
  info: toStdout,
  debug: toStdout,
  error: toStderr,
  warn: toStderr,
  trace: toStderr,
  dir: (value, options) => {
    inspectModule ??= loaders.requireBuiltin("internal/util/inspect");
    process.stdout.write(inspectModule.inspect(value, { customInspect: false, ...options }) + "\\n");
  },
});
loaders.requireBuiltin(${JSON.stringify(main)});
`;
}

/** A CommonJS module's statements, and its requires: every one, and those its top level makes. */
function commonJsModuleOf(
  project: Project,
  text: string,
  id: string,
): { module: NativeModule; topLevel: string[] } {
  const sf = project.createSourceFile(`/cjs/${id.replace(/[^A-Za-z0-9]/g, "_")}.js`, text, {
    overwrite: true,
  });
  const requires: Record<string, string> = {};
  const topLevel: string[] = [];
  sf.forEachDescendant((n) => {
    if (!Node.isCallExpression(n)) return;
    const callee = n.getExpression();
    const arg = n.getArguments()[0];
    if (!Node.isIdentifier(callee) || callee.getText() !== "require") return;
    if (arg === undefined || !Node.isStringLiteral(arg)) return;
    const spec = arg.getLiteralValue();
    requires[spec] = spec;
    const inFunction = n.getAncestors().some((a) => Node.isFunctionLikeDeclaration(a));
    if (!inFunction && !topLevel.includes(spec)) topLevel.push(spec);
  });
  const statements: NativeModuleStatement[] = [];
  for (const st of sf.getStatements()) {
    if (Node.isEmptyStatement(st)) continue;
    const textOf = st.getText();
    const shape = atomShape(textOf);
    try {
      statements.push({
        kind: shape.kind,
        declares:
          shape.kind === "function" ? (shape.name !== undefined ? [shape.name] : []) : shape.names,
        graph: liftAtom(textOf),
      });
    } catch (e) {
      throw new ProgramError(
        `${id}: a statement at line ${st.getStartLineNumber()} does not lift: ${(e as Error).message}`,
      );
    }
  }
  return { module: { id, statements, requires }, topLevel };
}
