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
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
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
