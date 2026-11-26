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
import { Node, Project, type SourceFile, type Statement, SyntaxKind, ts } from "ts-morph";
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
/** A module with no ECMAScript import or export, in a .js or .cjs file: CommonJS. */
function isCommonJs(sf: SourceFile, file: string): boolean {
  if (!/\.c?js$/.test(file)) return false;
  return !sf
    .getStatements()
    .some(
      (st) =>
        Node.isImportDeclaration(st) ||
        Node.isExportDeclaration(st) ||
        Node.isExportAssignment(st) ||
        (Node.isModifierable(st) && st.hasModifier(SyntaxKind.ExportKeyword)),
    );
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
    const sf = project.createSourceFile(`/m/${modules.size}.ts`, text, { overwrite: true });
    // import() and import.meta, as syntax (a string or comment that mentions them is neither): an
    // import() of a string literal is the module's link, as a require is; of anything else, or
    // import.meta, not in the subset yet.
    const dynamic: string[] = [];
    if (/\bimport\s*[(.]/.test(text))
      sf.forEachDescendant((n) => {
        if (Node.isCallExpression(n) && n.getExpression().getKind() === SyntaxKind.ImportKeyword) {
          const arg = n.getArguments()[0];
          if (arg === undefined || !Node.isStringLiteral(arg))
            throw new ProgramError(
              `an import() of a computed specifier is not in the native subset yet (${id})`,
            );
          if (!dynamic.includes(arg.getLiteralValue())) dynamic.push(arg.getLiteralValue());
        }
        if (n.getKind() === SyntaxKind.MetaProperty && n.getText().startsWith("import"))
          throw new ProgramError(`import.meta is not in the native subset yet (${id})`);
      });
    /** The import() specifiers that resolve, each its module's (visited after this one). */
    const linkDynamic = (requires: Record<string, string>, targets: string[]): void => {
      for (const spec of dynamic) {
        if (
          spec.startsWith("node:") ||
          (!spec.startsWith(".") && !spec.startsWith("/") && isBuiltin(spec))
        )
          continue;
        let target: string;
        try {
          target = resolveSpecifier(spec, file);
        } catch {
          continue;
        }
        requires[spec] = idOf(target);
        targets.push(target);
      }
    };
    if (isCommonJs(sf, file)) {
      // A CommonJS module (an npm package's, TypeScript's): each require of a specifier that
      // resolves is its module's; a platform module's or one that does not resolve stays unlinked,
      // and throws when it runs (an optional dependency required in a try).
      const parsed = commonJsModuleOf(project, text, id);
      const requires: Record<string, string> = {};
      const targets: string[] = [];
      for (const spec of Object.keys(parsed.module.requires ?? {})) {
        if (
          spec.startsWith("node:") ||
          (!spec.startsWith(".") && !spec.startsWith("/") && isBuiltin(spec))
        ) {
          // Node's module: named as node:<id>, which no module of the record is, so it stays
          // unresolved here and a boot program over Node's library gives its own (#1361 P2).
          requires[spec] = spec.startsWith("node:") ? spec : `node:${spec}`;
          continue;
        }
        let target: string;
        try {
          target = resolveSpecifier(spec, file);
        } catch {
          continue;
        }
        requires[spec] = idOf(target);
        targets.push(target);
      }
      linkDynamic(requires, targets);
      modules.set(id, { ...parsed.module, requires });
      for (const t of targets) visit(t);
      return;
    }
    const parsed = moduleOf(sf, file, id, (spec) => idOf(resolveSpecifier(spec, file)));
    const requires: Record<string, string> = { ...(parsed.module.requires ?? {}) };
    const targets: string[] = [];
    linkDynamic(requires, targets);
    modules.set(id, targets.length > 0 ? { ...parsed.module, requires } : parsed.module);
    for (const spec of parsed.specifiers) visit(resolveSpecifier(spec, file));
    for (const t of targets) visit(t);
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

/** The library modules a user program requires: each specifier none of its modules resolves to. */
function builtinRequires(user: ProgramRecord | undefined): string[] {
  if (user === undefined) return [];
  const ids = new Set(user.modules.map((m) => m.id));
  const out = new Set<string>();
  for (const m of user.modules)
    for (const [spec, target] of Object.entries(m.requires ?? {}))
      if (!ids.has(target) && target.startsWith("node:")) out.add(target.slice(5));
  return [...out].filter((id) => !id.startsWith("internal/") && !id.startsWith("."));
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
    /**
     * A user program to run once the library is set up (#1361 P2): its modules join the record, its
     * entry is required last, and each require its modules do not resolve is the library's module
     * of that name (`node:` or not) when users may require it.
     */
    readonly user?: ProgramRecord;
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
    // process.emitWarning's (bootstrap/node.js), loaded at its first warning.
    "internal/process/warning",
    // process.nextTick's (bootstrap/node.js's setupTaskQueue), and process as an EventEmitter.
    "internal/process/task_queues",
    "events",
    // A warning's writer (internal/process/warning's writeOut).
    "internal/console/global",
  ])
    visit(id);
  visit(main.id, main.source);
  for (const id of options.include ?? []) visit(id);
  for (const id of builtinRequires(options.user))
    if (existsSync(resolve(lib, `${id}.js`))) visit(id);
  // Node's lazily loaded globals (bootstrap/node.js): the module that gives one, when a module names it.
  const lazyGlobals = LAZY_GLOBALS.filter(([name]) =>
    [...texts.values()].some((t) => new RegExp(`\\b${name}\\b`).test(t)),
  );
  for (const [, id] of lazyGlobals) visit(id);
  // Modules a library module requires by a name it computes (no top-level require shows them).
  for (const [id, deps] of Object.entries(COMPUTED_REQUIRES))
    if (texts.has(id)) for (const d of deps) visit(d);

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
  modules.unshift(
    lifted(
      NODE_BOOT,
      nodeBootSource(main.id, options.bindings?.id, lazyGlobals, options.user?.entry),
    ),
  );
  if (options.user !== undefined) modules.push(...options.user.modules);
  return { entry: NODE_BOOT, modules };
}

/** The boot program's entry module. */
export const NODE_BOOT = "yakcc:node-boot";

/** The runtime's `Math` value, made by the boot module before any library code runs. */
const MATH_VALUE =
  '// Math as a value (primordials copies its members): each member Math\'s own operation, the\n// approximated ones V8\'s shaved atoms (#1362); hypot, approximated with no atom yet, is absent.\nconst MathObject = {\n  E: Math.E,\n  LN10: Math.LN10,\n  LN2: Math.LN2,\n  LOG10E: Math.LOG10E,\n  LOG2E: Math.LOG2E,\n  PI: Math.PI,\n  SQRT1_2: Math.SQRT1_2,\n  SQRT2: Math.SQRT2,\n  abs: (a0) => Math.abs(a0),\n  acos: (a0) => Math.acos(a0),\n  acosh: (a0) => Math.acosh(a0),\n  asin: (a0) => Math.asin(a0),\n  asinh: (a0) => Math.asinh(a0),\n  atan: (a0) => Math.atan(a0),\n  atanh: (a0) => Math.atanh(a0),\n  atan2: (a0, a1) => Math.atan2(a0, a1),\n  ceil: (a0) => Math.ceil(a0),\n  cbrt: (a0) => Math.cbrt(a0),\n  expm1: (a0) => Math.expm1(a0),\n  cos: (a0) => Math.cos(a0),\n  cosh: (a0) => Math.cosh(a0),\n  exp: (a0) => Math.exp(a0),\n  floor: (a0) => Math.floor(a0),\n  log: (a0) => Math.log(a0),\n  log1p: (a0) => Math.log1p(a0),\n  log2: (a0) => Math.log2(a0),\n  log10: (a0) => Math.log10(a0),\n  max: (...a) => Math.max(...a),\n  min: (...a) => Math.min(...a),\n  pow: (a0, a1) => Math.pow(a0, a1),\n  random: () => Math.random(),\n  round: (a0) => Math.round(a0),\n  sign: (a0) => Math.sign(a0),\n  sin: (a0) => Math.sin(a0),\n  sinh: (a0) => Math.sinh(a0),\n  sqrt: (a0) => Math.sqrt(a0),\n  tan: (a0) => Math.tan(a0),\n  tanh: (a0) => Math.tanh(a0),\n  trunc: (a0) => Math.trunc(a0),\n  // Exact, so given here: ToUint32\'s leading zeros; Int32 multiplication; the nearest float32.\n  clz32: (x) => {\n    let v = x >>> 0;\n    if (v === 0) return 32;\n    let n = 0;\n    while ((v & 0x80000000) === 0) {\n      v = v << 1;\n      n++;\n    }\n    return n;\n  },\n  imul: (a, b) => {\n    const ah = (a >>> 16) & 0xffff;\n    const al = a & 0xffff;\n    const bh = (b >>> 16) & 0xffff;\n    const bl = b & 0xffff;\n    return (al * bl + (((ah * bl + al * bh) << 16) >>> 0)) | 0;\n  },\n  fround: (x) => new Float32Array([x])[0],\n};\nObject.defineProperty(MathObject, Symbol.toStringTag, { value: "Math", configurable: true });\n__yakccDefineGlobal("Math", MathObject);\n';

/** Async hooks' provider types (src/async_wrap.h's NODE_ASYNC_PROVIDER_TYPES), as Node v22.23.5 numbers them. */
const ASYNC_PROVIDERS: Readonly<Record<string, number>> = Object.fromEntries(
  "NONE DIRHANDLE DNSCHANNEL ELDHISTOGRAM FILEHANDLE FILEHANDLECLOSEREQ BLOBREADER FSEVENTWRAP FSREQCALLBACK FSREQPROMISE GETADDRINFOREQWRAP GETNAMEINFOREQWRAP HEAPSNAPSHOT HTTP2SESSION HTTP2STREAM HTTP2PING HTTP2SETTINGS HTTPINCOMINGMESSAGE HTTPCLIENTREQUEST JSSTREAM JSUDPWRAP MESSAGEPORT PIPECONNECTWRAP PIPESERVERWRAP PIPEWRAP PROCESSWRAP PROMISE QUERYWRAP QUIC_ENDPOINT QUIC_LOGSTREAM QUIC_PACKET QUIC_SESSION QUIC_STREAM QUIC_UDP SHUTDOWNWRAP SIGNALWRAP STATWATCHER STREAMPIPE TCPCONNECTWRAP TCPSERVERWRAP TCPWRAP TTYWRAP UDPSENDWRAP UDPWRAP SIGINTWATCHDOG WORKER WORKERCPUPROFILE WORKERCPUUSAGE WORKERHEAPSNAPSHOT WORKERHEAPSTATISTICS WRITEWRAP ZLIB CHECKPRIMEREQUEST PBKDF2REQUEST KEYPAIRGENREQUEST KEYGENREQUEST KEYEXPORTREQUEST CIPHERREQUEST DERIVEBITSREQUEST HASHREQUEST RANDOMBYTESREQUEST RANDOMPRIMEREQUEST SCRYPTREQUEST SIGNREQUEST TLSWRAP VERIFYREQUEST"
    .split(" ")
    .map((name, i) => [name, i]),
);

/** The boot module's source: Node's realm set up over the table, then `main` loaded. */
/** A library module's requires of a computed name: every module the name can be. */
const COMPUTED_REQUIRES: Readonly<Record<string, readonly string[]>> = {
  // require(`internal/cluster/${childOrPrimary}`)
  cluster: ["internal/cluster/primary", "internal/cluster/child"],
};

/** Globals Node's bootstrap/node.js defines lazily: each its name, its module, and the export. */
const LAZY_GLOBALS: readonly (readonly [string, string, string])[] = [
  ["Buffer", "buffer", "Buffer"],
];

function nodeBootSource(
  main: string,
  bindings: string | undefined,
  lazyGlobals: readonly (readonly [string, string, string])[] = [],
  user?: string,
): string {
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
// The microtask queue and the tick callback (src/node_task_queue.cc), V8's and Node's C++'s parts of
// process.nextTick (#1361 P2): the microtasks are the runtime's jobs; the tick callback is run when
// the runtime's jobs are done and again after (__yakccSetTickHook), as Node runs it after a callback.
let tickCallback;
runtime.task_queue = {
  tickInfo: new Int32Array(2),
  runMicrotasks: () => __yakccRunMicrotasks(),
  setTickCallback: (f) => { tickCallback = f; },
  enqueueMicrotask: (f) => queueMicrotask(f),
  promiseRejectEvents: {
    kPromiseRejectWithNoHandler: 0,
    kPromiseHandlerAddedAfterReject: 1,
    kPromiseRejectAfterResolved: 2,
    kPromiseResolveAfterResolved: 3,
  },
  setPromiseRejectCallback: () => {},
};
// Async hooks' state (src/async_wrap.cc, Environment::AsyncHooks): the fields and the stack of
// [execution id, trigger id] pairs, as Node keeps them; the main script runs as id 1, triggered by 0.
const asyncFields = new Uint32Array(9);
asyncFields[6] = 1; // kCheck
const asyncIds = new Float64Array(4);
asyncIds[0] = 1; // kExecutionAsyncId: the main script's
asyncIds[2] = 1; // kAsyncIdCounter
asyncIds[3] = -1; // kDefaultTriggerAsyncId
const asyncIdsStack = new Float64Array(16 * 2);
const asyncResources = [];
const asyncStackMore = [];
const asyncHooksSetUp = {};
runtime.async_wrap = {
  async_hook_fields: asyncFields,
  async_id_fields: asyncIds,
  async_ids_stack: asyncIdsStack,
  execution_async_resources: asyncResources,
  constants: {
    kInit: 0, kBefore: 1, kAfter: 2, kDestroy: 3, kPromiseResolve: 4, kTotals: 5, kCheck: 6, kStackLength: 7,
    kUsesExecutionAsyncResource: 8, kExecutionAsyncId: 0, kTriggerAsyncId: 1, kAsyncIdCounter: 2,
    kDefaultTriggerAsyncId: 3,
  },
  Providers: ${JSON.stringify(ASYNC_PROVIDERS)},
  // AsyncHooks::push_async_context, past the stack the library writes itself.
  pushAsyncContext: (asyncId, triggerId, resource) => {
    const offset = asyncFields[7];
    if (offset * 2 < asyncIdsStack.length) {
      asyncIdsStack[offset * 2] = asyncIds[0];
      asyncIdsStack[offset * 2 + 1] = asyncIds[1];
    } else asyncStackMore[offset] = [asyncIds[0], asyncIds[1]];
    asyncFields[7] = offset + 1;
    asyncIds[0] = asyncId;
    asyncIds[1] = triggerId;
    if (resource !== undefined) asyncResources[offset] = resource;
  },
  // AsyncHooks::pop_async_context: whether the stack is still not empty.
  popAsyncContext: (asyncId) => {
    if (asyncFields[7] === 0) return false;
    if (asyncFields[6] > 0 && asyncIds[0] !== asyncId)
      throw new Error("async hook stack has become corrupted (actual: " + asyncIds[0] + ", expected: " + asyncId + ")");
    const offset = asyncFields[7] - 1;
    if (offset * 2 < asyncIdsStack.length) {
      asyncIds[0] = asyncIdsStack[offset * 2];
      asyncIds[1] = asyncIdsStack[offset * 2 + 1];
    } else {
      asyncIds[0] = asyncStackMore[offset][0];
      asyncIds[1] = asyncStackMore[offset][1];
    }
    asyncFields[7] = offset;
    asyncResources.length = Math.min(asyncResources.length, offset);
    return offset > 0;
  },
  executionAsyncResource: (index) => asyncResources[index],
  clearAsyncIdStack: () => {
    asyncIds[0] = 0;
    asyncIds[1] = 0;
    asyncFields[7] = 0;
    asyncResources.length = 0;
  },
  setupHooks: (hooks) => { Object.assign(asyncHooksSetUp, hooks); },
  setCallbackTrampoline: () => {},
  // A destroy hook is called for an id queued, once the runtime's jobs are done.
  queueDestroyAsyncId: (asyncId) => {
    if (typeof asyncHooksSetUp.destroy === "function") queueMicrotask(() => asyncHooksSetUp.destroy(asyncId));
  },
  registerDestroyHook: () => {},
  // Promise hooks need the runtime's promises to call them: none are set yet.
  getPromiseHooks: () => [undefined, undefined, undefined, undefined],
  setPromiseHooks: () => {},
};
// V8's continuation-preserved embedder data (--experimental-async-context-frame, off by default).
let continuationData;
runtime.async_context_frame = {
  getContinuationPreservedEmbedderData: () => continuationData,
  setContinuationPreservedEmbedderData: (v) => { continuationData = v; },
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
// process as an EventEmitter (bootstrap/node.js's setupProcessObject): its prototype one that
// inherits EventEmitter's; 'warning' heard as pre_execution.js has it; 'exit' emitted when the
// runtime's jobs are done (per_thread.js), the exit code process.exitCode's.
{
  const EventEmitter = loaders.requireBuiltin("events");
  Object.setPrototypeOf(process, Object.create(EventEmitter.prototype));
  EventEmitter.call(process);
  Object.defineProperty(process, Symbol.toStringTag, {
    enumerable: false,
    writable: true,
    configurable: false,
    value: "process",
  });
  // stdout and stderr as streams to Node's Console: the runtime's writes, synchronous as
  // fs.SyncWriteStream's are, with an emitter's events. (Node's own tty.WriteStream and
  // SyncWriteStream need the tty_wrap and fs bindings: #1367.)
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write;
    Object.setPrototypeOf(stream, Object.create(EventEmitter.prototype));
    EventEmitter.call(stream);
    stream.write = (chunk, encoding, callback) => {
      write(typeof chunk === "string" ? chunk : String(chunk));
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") process.nextTick(done, null);
      return true;
    };
    stream.writable = true;
    stream.isTTY = false;
  }
  // Node's global console bound to them, as pre_execution.js binds it (a library module's console,
  // internal/console/global: warnings are written through it).
  loaders
    .requireBuiltin("internal/console/constructor")
    .initializeGlobalConsole(loaders.requireBuiltin("internal/console/global"));
  process._exiting = false;
  process.on("warning", (...args) => loaders.requireBuiltin("internal/process/warning").onWarning(...args));
  __yakccOnExit(() => {
    if (process._exiting) return;
    process._exiting = true;
    process.emit("exit", process.exitCode || 0);
  });
}
// process.nextTick, as bootstrap/node.js sets it up: internal/process/task_queues', its tick
// callback run when the runtime's jobs are done (and again after, while ticks are scheduled).
{
  const { setupTaskQueue } = loaders.requireBuiltin("internal/process/task_queues");
  const { nextTick, runNextTicks } = setupTaskQueue();
  process.nextTick = nextTick;
  process._tickCallback = runNextTicks;
  const tickInfo = runtime.task_queue.tickInfo;
  __yakccSetTickHook(() => {
    if ((tickInfo[0] === 1 || tickInfo[1] === 1) && tickCallback !== undefined) tickCallback();
  });
}
// process.emitWarning, as bootstrap/node.js sets it: internal/process/warning's, loaded when first used.
process.emitWarning = (...args) => loaders.requireBuiltin("internal/process/warning").emitWarning(...args);
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
${lazyGlobals.map(([name, id, key]) => `__yakccDefineGlobal(${JSON.stringify(name)}, () => loaders.requireBuiltin(${JSON.stringify(id)})[${JSON.stringify(key)}], true);\n`).join("")}loaders.requireBuiltin(${JSON.stringify(main)});
${
  user === undefined
    ? ""
    : `// A user program's require of a module it does not have: the library's, if users may require it.
__yakccSetBuiltinRequire((id) => {
  const name = id.startsWith("node:") ? id.slice(5) : id;
  if (!table.has(name) || name.startsWith("internal/")) return undefined;
  return loaders.requireBuiltin(name);
});
require(${JSON.stringify(user)});
`
}`;
}

/** The names a statement list declares at its own level (var, let, const, function, class). */
function declaredNames(statements: readonly ts.Statement[]): Set<string> {
  const out = new Set<string>();
  const bind = (b: ts.BindingName): void => {
    if (ts.isIdentifier(b)) out.add(b.text);
    else for (const e of b.elements) if (!ts.isOmittedExpression(e)) bind(e.name);
  };
  const hoisted = (n: ts.Node): void => {
    // var declarations anywhere in the function's own body (not in nested functions) are its.
    if (ts.isVariableStatement(n) && (n.declarationList.flags & ts.NodeFlags.BlockScoped) === 0)
      for (const d of n.declarationList.declarations) bind(d.name);
    if (ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n)) {
      const init = n.initializer;
      if (
        init !== undefined &&
        ts.isVariableDeclarationList(init) &&
        (init.flags & ts.NodeFlags.BlockScoped) === 0
      )
        for (const d of init.declarations) bind(d.name);
    }
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    ts.forEachChild(n, hoisted);
  };
  for (const st of statements) {
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) bind(d.name);
    else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name !== undefined)
      out.add(st.name.text);
    else hoisted(st);
  }
  return out;
}

/**
 * A module whose code is one immediately called function (a bundler's wrapper, as TypeScript's
 * `typescript.js` is: `((module) => { ...5,000 statements... })({ ... })`), with its body's statements
 * as the module's own, so each lifts as a statement rather than the whole as one (#1370). The
 * parameters become bindings of the arguments (renamed apart: an argument may read a name a
 * parameter has). Undefined, and the module left as it is, when that could mean anything else: a
 * `return`, `this` or `arguments` of the function itself, a parameter that is not a plain name or is
 * declared again inside, or a name the body declares that the module's other code also uses.
 */
export function unwrapModuleFunction(text: string): string | undefined {
  const sf = ts.createSourceFile("m.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const at = sf.statements.findIndex(
    (st) => ts.isExpressionStatement(st) && st.end - st.pos > text.length / 2,
  );
  const st = sf.statements[at];
  if (st === undefined || !ts.isExpressionStatement(st)) return undefined;
  let call: ts.Expression = st.expression;
  while (ts.isParenthesizedExpression(call)) call = call.expression;
  if (!ts.isCallExpression(call)) return undefined;
  let fn: ts.Expression = call.expression;
  while (ts.isParenthesizedExpression(fn)) fn = fn.expression;
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return undefined;
  if (!ts.isBlock(fn.body)) return undefined;
  if (ts.isFunctionExpression(fn) && (fn.name !== undefined || fn.asteriskToken !== undefined))
    return undefined;
  if (fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return undefined;
  if (call.arguments.some(ts.isSpreadElement) || call.arguments.length > fn.parameters.length)
    return undefined;
  const params: string[] = [];
  for (const p of fn.parameters) {
    if (!ts.isIdentifier(p.name) || p.initializer !== undefined || p.dotDotDotToken !== undefined)
      return undefined;
    params.push(p.name.text);
  }
  const body = fn.body;
  const own = declaredNames(body.statements);
  if (params.some((p) => own.has(p))) return undefined;
  // The function's own return, this and arguments (not a nested function's); any declaration of a
  // parameter's name inside; and the parameters' references, to rename.
  const isArrow = ts.isArrowFunction(fn);
  const renames: { pos: number; end: number; text: string }[] = [];
  let refused = false;
  const fresh = (p: string): string => `__yk_wrapped_${p}`;
  const walk = (n: ts.Node, inFunction: boolean, inArrowOnly: boolean): void => {
    if (refused) return;
    if (!inFunction && ts.isReturnStatement(n)) refused = true;
    if (
      !isArrow &&
      inArrowOnly &&
      (n.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(n) && n.text === "arguments"))
    )
      refused = true;
    if (ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.NewKeyword && !inFunction)
      refused = true;
    if (ts.isIdentifier(n) && params.includes(n.text)) {
      const p = n.parent;
      const declaration =
        (ts.isVariableDeclaration(p) ||
          ts.isParameter(p) ||
          ts.isFunctionDeclaration(p) ||
          ts.isFunctionExpression(p) ||
          ts.isClassDeclaration(p) ||
          ts.isClassExpression(p) ||
          ts.isBindingElement(p) ||
          ts.isImportSpecifier(p) ||
          ts.isCatchClause(p)) &&
        (p as { name?: ts.Node }).name === n;
      if (declaration) refused = true;
      else if (ts.isPropertyAccessExpression(p) && p.name === n) {
      } else if (
        (ts.isPropertyAssignment(p) ||
          ts.isMethodDeclaration(p) ||
          ts.isPropertyDeclaration(p) ||
          ts.isGetAccessorDeclaration(p) ||
          ts.isSetAccessorDeclaration(p) ||
          ts.isEnumMember(p)) &&
        p.name === n
      ) {
      } else if (ts.isShorthandPropertyAssignment(p))
        renames.push({ pos: n.getStart(sf), end: n.end, text: `${n.text}: ${fresh(n.text)}` });
      else if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) {
      } else renames.push({ pos: n.getStart(sf), end: n.end, text: fresh(n.text) });
    }
    const fnHere = ts.isFunctionLike(n) || ts.isClassStaticBlockDeclaration(n);
    ts.forEachChild(n, (c) =>
      walk(c, inFunction || fnHere, inArrowOnly && (!fnHere || ts.isArrowFunction(n))),
    );
  };
  for (const s0 of body.statements) walk(s0, false, true);
  if (refused) return undefined;
  // What the module's other code (its other statements and the arguments) names, as text: none of it
  // may be a name the body now declares at the module's level.
  const outside = new Set<string>();
  const names = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) outside.add(n.text);
    ts.forEachChild(n, names);
  };
  sf.statements.forEach((s0, i) => {
    if (i !== at) names(s0);
  });
  for (const a of call.arguments) names(a);
  if ([...own].some((x) => outside.has(x) || params.some((p) => fresh(p) === x))) return undefined;
  // The body's text, its directive prologue left out and each parameter's reference renamed.
  let first = 0;
  while (
    first < body.statements.length &&
    ts.isExpressionStatement(body.statements[first] as ts.Statement) &&
    ts.isStringLiteral((body.statements[first] as ts.ExpressionStatement).expression)
  )
    first++;
  const start =
    first < body.statements.length
      ? (body.statements[first] as ts.Statement).getStart(sf)
      : body.end - 1;
  const end = body.end - 1;
  let inner = "";
  let cursor = start;
  for (const r of renames
    .filter((r) => r.pos >= start && r.end <= end)
    .sort((a, b) => a.pos - b.pos)) {
    inner += text.slice(cursor, r.pos) + r.text;
    cursor = r.end;
  }
  inner += text.slice(cursor, end);
  const bindings = params
    .map((p, i) => {
      const a = call.arguments[i];
      return `var ${fresh(p)} = ${a === undefined ? "void 0" : a.getText(sf)};\n`;
    })
    .join("");
  return `${text.slice(0, st.getStart(sf))}${bindings}${inner}\n${text.slice(st.end)}`;
}

/**
 * A CommonJS module's statements, and its requires: every one, and those its top level makes. Read
 * with the compiler's own parser, not ts-morph's wrappers: ts-morph keeps a wrapper of every node it
 * visits, millions for a 9 MB module (TypeScript's), all held while its statements lift (#1370).
 */
function commonJsModuleOf(
  _project: Project,
  text0: string,
  id: string,
): { module: NativeModule; topLevel: string[] } {
  const text = unwrapModuleFunction(text0) ?? text0;
  const sf = ts.createSourceFile("m.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const requires: Record<string, string> = {};
  const topLevel: string[] = [];
  const visit = (n: ts.Node, inFunction: boolean): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const arg = n.arguments[0];
      if (
        ts.isIdentifier(callee) &&
        callee.text === "require" &&
        arg !== undefined &&
        ts.isStringLiteral(arg)
      ) {
        const spec = arg.text;
        requires[spec] = spec;
        if (!inFunction && !topLevel.includes(spec)) topLevel.push(spec);
      }
    }
    const fn =
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n);
    ts.forEachChild(n, (c) => visit(c, inFunction || fn));
  };
  visit(sf, false);
  const statements: NativeModuleStatement[] = [];
  for (const st of sf.statements) {
    if (ts.isEmptyStatement(st)) continue;
    const textOf = st.getText(sf);
    const shape = atomShape(textOf);
    try {
      statements.push({
        kind: shape.kind,
        declares:
          shape.kind === "function" ? (shape.name !== undefined ? [shape.name] : []) : shape.names,
        graph: liftAtom(textOf),
      });
    } catch (e) {
      const line = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1;
      throw new ProgramError(
        `${id}: a statement at line ${line} does not lift: ${(e as Error).message}`,
      );
    }
  }
  return { module: { id, statements, requires }, topLevel };
}
