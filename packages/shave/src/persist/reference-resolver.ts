// SPDX-License-Identifier: MIT
//
// @decision DEC-DUC-LINK-RESOLVE-001 (#1281)
// A reference an atom makes is resolved from the module it was shaved from, never from text
// the atom carries (D5: no external code). The module's top-level scope says what a free name
// is: a declaration in the same module, an import, or the module's own `exports` / `module`.
// An import is followed to the module that exports it: a platform module of the target
// (a Node builtin), a module of the same package, or a module of another package in the
// store. The end of the chain is the atom that declares the exported value, and the
// reference links to that atom's contract. Anything the chain cannot reach is a hole, with
// its cause.
//
// An import statement is not an atom of its own: it binds a name, and the binding is the link.

import { builtinModules, createRequire } from "node:module";
import { ts } from "ts-morph";

/** One module of a shaved package: its path, its source, and the atoms shaved from it. */
export interface ModuleRecord {
  readonly filePath: string;
  readonly source: string;
  readonly atoms: readonly string[];
}

/** A shaved package: its name, its root directory, its entry module, and its modules. */
export interface PackageRecord {
  readonly name: string;
  readonly root: string;
  readonly entryPath: string;
  readonly modules: readonly ModuleRecord[];
}

/** Where an import name comes from: a specifier, and the name it imports there. */
interface ImportBinding {
  readonly specifier: string;
  /** An export name; `*` is the whole module (a namespace, or a CommonJS `require`). */
  readonly imported: string;
}

/** What a module exports under one name. */
type ExportTarget =
  | { readonly kind: "local"; readonly local: string }
  | { readonly kind: "atom"; readonly atom: number }
  | { readonly kind: "reexport"; readonly specifier: string; readonly imported: string }
  /** Written in a statement that no atom holds. */
  | { readonly kind: "unshaved" };

/** The top-level scope of a module. */
export interface ModuleScope {
  /** Names declared at top level, with the index of the atom that declares each. */
  readonly declarations: ReadonlyMap<string, number | undefined>;
  readonly imports: ReadonlyMap<string, ImportBinding>;
  readonly exports: ReadonlyMap<string, ExportTarget>;
  /** `export * from` specifiers. */
  readonly starExports: readonly string[];
  /** Names declared inside the module's functions and blocks, not at its top level. */
  readonly innerNames: ReadonlySet<string>;
}

export type HoleCause =
  | "external-package"
  | "unresolved-module"
  | "missing-export"
  /** Declared at the module's top level by a statement that no atom holds (shave kept it as glue). */
  | "not-shaved"
  /** A local of a function the atom was shaved out of: the atom is a piece of that function. */
  | "enclosing-scope"
  | "undeclared"
  | "dynamic-require";

export type Resolution =
  /** The atom that declares the value: the reference links to its contract. */
  | { readonly kind: "atom"; readonly filePath: string; readonly atom: number }
  /** A whole module of the store, imported as a namespace. */
  | { readonly kind: "module"; readonly filePath: string }
  /** A module of the target platform. */
  | { readonly kind: "platform"; readonly module: string }
  /** The module's own `exports` or `module` object. */
  | { readonly kind: "module-self" }
  | { readonly kind: "hole"; readonly cause: HoleCause; readonly detail: string };

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const parse = (text: string): ts.SourceFile => ts.createSourceFile("m.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** A `require("<literal>")` call, or undefined. */
function requireSpecifier(node: ts.Node | undefined): string | undefined {
  if (node === undefined || !ts.isCallExpression(node)) return undefined;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "require" || node.arguments.length !== 1) return undefined;
  const arg = node.arguments[0] as ts.Expression;
  return ts.isStringLiteralLike(arg) ? arg.text : undefined;
}

/** Interop helpers compilers wrap a require in, and the name the wrapped value stands for. */
const INTEROP: Record<string, string> = {
  _interopRequireDefault: "default",
  __importDefault: "default",
  _interopRequireWildcard: "*",
  __importStar: "*",
};

/** `require("s")`, `require("s").name`, or an interop helper around a require: the specifier, and the name imported. */
function requireBinding(init: ts.Expression | undefined): ImportBinding | undefined {
  if (init === undefined) return undefined;
  const direct = requireSpecifier(init);
  if (direct !== undefined) return { specifier: direct, imported: "*" };
  if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text in INTEROP && init.arguments.length === 1) {
    const spec = requireSpecifier(init.arguments[0]);
    if (spec !== undefined) return { specifier: spec, imported: INTEROP[init.expression.text] as string };
  }
  if (ts.isPropertyAccessExpression(init)) {
    const spec = requireSpecifier(init.expression);
    if (spec !== undefined) return { specifier: spec, imported: init.name.text };
  }
  return undefined;
}

/** `exports.x`, `module.exports.x`, or `module.exports`: the export name (`*` for the whole). */
function exportsTarget(node: ts.Expression): string | undefined {
  const isModuleExports = (e: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "module" && e.name.text === "exports";
  if (isModuleExports(node)) return "*";
  if (ts.isPropertyAccessExpression(node)) {
    const base = node.expression;
    if ((ts.isIdentifier(base) && base.text === "exports") || isModuleExports(base)) return node.name.text;
  }
  return undefined;
}

/** The names a statement declares at top level, and the import bindings among them. */
function declaredBy(stmt: ts.Statement, imports: Map<string, ImportBinding>): string[] {
  const names: string[] = [];
  const bindName = (name: ts.BindingName, binding: ImportBinding | undefined): void => {
    if (ts.isIdentifier(name)) {
      names.push(name.text);
      if (binding !== undefined) imports.set(name.text, binding);
      return;
    }
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue;
      if (ts.isObjectBindingPattern(name) && binding !== undefined && binding.imported === "*" && el.dotDotDotToken === undefined) {
        const key = el.propertyName !== undefined && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : undefined;
        bindName(el.name, key !== undefined ? { specifier: binding.specifier, imported: key } : undefined);
      } else {
        bindName(el.name, undefined);
      }
    }
  };
  if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
    if (stmt.name !== undefined) names.push(stmt.name.text);
  } else if (ts.isVariableStatement(stmt)) {
    for (const d of stmt.declarationList.declarations) bindName(d.name, requireBinding(d.initializer));
  } else if (ts.isEnumDeclaration(stmt)) {
    names.push(stmt.name.text);
  } else if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.importClause !== undefined && !stmt.importClause.isTypeOnly) {
    const specifier = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (clause.name !== undefined) {
      names.push(clause.name.text);
      imports.set(clause.name.text, { specifier, imported: "default" });
    }
    const nb = clause.namedBindings;
    if (nb !== undefined && ts.isNamespaceImport(nb)) {
      names.push(nb.name.text);
      imports.set(nb.name.text, { specifier, imported: "*" });
    } else if (nb !== undefined) {
      for (const el of nb.elements) {
        if (el.isTypeOnly) continue;
        names.push(el.name.text);
        imports.set(el.name.text, { specifier, imported: (el.propertyName ?? el.name).text });
      }
    }
  }
  return names;
}

/** The top-level scope of a module, and which of its atoms declares each name. */
export function moduleScopeOf(mod: ModuleRecord): ModuleScope {
  const imports = new Map<string, ImportBinding>();
  const exports = new Map<string, ExportTarget>();
  const starExports: string[] = [];
  const declared = new Set<string>();
  const sf = parse(mod.source);
  for (const stmt of sf.statements) {
    for (const n of declaredBy(stmt, imports)) declared.add(n);
    const exported = ts.canHaveModifiers(stmt) && (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = ts.canHaveModifiers(stmt) && (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    // `var x = exports.x = value`: a declaration that is also an export.
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && init !== undefined && ts.isBinaryExpression(init) && init.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const target = exportsTarget(init.left);
          if (target !== undefined && target !== "*") exports.set(target, { kind: "local", local: d.name.text });
        }
      }
    }
    if (exported) {
      if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name !== undefined) {
        exports.set(isDefault ? "default" : stmt.name.text, { kind: "local", local: stmt.name.text });
      } else if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name)) exports.set(d.name.text, { kind: "local", local: d.name.text });
      }
    }
    if (ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression)) exports.set("default", { kind: "local", local: stmt.expression.text });
    if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly) {
      const from = stmt.moduleSpecifier !== undefined && ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : undefined;
      const clause = stmt.exportClause;
      if (clause === undefined && from !== undefined) starExports.push(from);
      else if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          const local = (el.propertyName ?? el.name).text;
          exports.set(el.name.text, from !== undefined ? { kind: "reexport", specifier: from, imported: local } : { kind: "local", local });
        }
      } else if (clause !== undefined && ts.isNamespaceExport(clause) && from !== undefined) {
        exports.set(clause.name.text, { kind: "reexport", specifier: from, imported: "*" });
      }
    }
    // CommonJS: `module.exports = X`, `exports.a = X`, `module.exports = { a, b: c }`.
    if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression) && stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = exportsTarget(stmt.expression.left);
      const value = stmt.expression.right;
      if (target === undefined) continue;
      const spec = requireBinding(value);
      if (spec !== undefined) {
        exports.set(target, { kind: "reexport", specifier: spec.specifier, imported: spec.imported });
      } else if (ts.isIdentifier(value)) {
        exports.set(target, { kind: "local", local: value.text });
      } else if (target === "*" && ts.isObjectLiteralExpression(value)) {
        for (const p of value.properties) {
          if (ts.isShorthandPropertyAssignment(p)) exports.set(p.name.text, { kind: "local", local: p.name.text });
          else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
            exports.set(p.name.text, { kind: "local", local: p.initializer.text });
          } else if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
            const spec2 = requireBinding(p.initializer);
            if (spec2 !== undefined) exports.set(p.name.text, { kind: "reexport", specifier: spec2.specifier, imported: spec2.imported });
            else {
              // A value written in the export object itself: the statement's atom holds it.
              const atom = atomContaining(mod, stmt.getText(sf));
              exports.set(p.name.text, atom !== undefined ? { kind: "atom", atom } : { kind: "unshaved" });
            }
          }
        }
      } else {
        const atom = atomContaining(mod, stmt.getText(sf));
        if (atom !== undefined) exports.set(target, { kind: "atom", atom });
      }
    }
  }
  // Which atom declares each name: the atom whose own top-level statements declare it.
  const declarations = new Map<string, number | undefined>();
  for (const n of declared) declarations.set(n, undefined);
  mod.atoms.forEach((atom, i) => {
    const scratch = new Map<string, ImportBinding>();
    for (const stmt of parse(atom).statements) for (const n of declaredBy(stmt, scratch)) if (declarations.has(n) && declarations.get(n) === undefined) declarations.set(n, i);
  });
  // Every name declared anywhere in the module; one that is not a top-level declaration is inner.
  const innerNames = new Set<string>();
  const visit = (n: ts.Node): void => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name)) innerNames.add(n.name.text);
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name !== undefined) innerNames.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { declarations, imports, exports, starExports, innerNames };
}

/** The atom whose text contains a statement of the module, or the statement's start. */
function atomContaining(mod: ModuleRecord, text: string): number | undefined {
  const exact = mod.atoms.findIndex((a) => a.trim() === text.trim() || text.includes(a.trim()));
  return exact === -1 ? undefined : exact;
}

/** Whether an atom only binds imports: each of its statements is an import or a `require` binding. */
export function isImportBinding(atom: string): boolean {
  const statements = parse(atom).statements;
  if (statements.length === 0) return false;
  return statements.every(
    (s) =>
      ts.isImportDeclaration(s) ||
      (ts.isVariableStatement(s) && s.declarationList.declarations.every((d) => requireBinding(d.initializer) !== undefined)),
  );
}

/** The store: the packages shaved so far, indexed for resolution. */
export class ReferenceResolver {
  private readonly modules = new Map<string, { pkg: PackageRecord; mod: ModuleRecord; scope?: ModuleScope }>();
  private readonly packages = new Map<string, PackageRecord>();

  constructor(packages: readonly PackageRecord[]) {
    for (const pkg of packages) {
      this.packages.set(pkg.name, pkg);
      for (const mod of pkg.modules) this.modules.set(mod.filePath, { pkg, mod });
    }
  }

  private scopeOf(filePath: string): ModuleScope | undefined {
    const entry = this.modules.get(filePath);
    if (entry === undefined) return undefined;
    if (entry.scope === undefined) entry.scope = moduleScopeOf(entry.mod);
    return entry.scope;
  }

  /** The file a specifier names from a module, or a platform module, or why neither. */
  private resolveSpecifier(from: string, specifier: string): { file: string } | { platform: string } | { hole: HoleCause } {
    if (BUILTINS.has(specifier)) return { platform: specifier.replace(/^node:/, "") };
    const tryResolve = (base: string, spec: string): string | undefined => {
      const req = createRequire(base);
      for (const s of [spec, `${spec}.js`, `${spec}.ts`, `${spec}/index.js`, `${spec}.cjs`, `${spec}.mjs`]) {
        try {
          const file = req.resolve(s);
          if (this.modules.has(file)) return file;
        } catch {
          // Not this candidate.
        }
      }
      return undefined;
    };
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const file = tryResolve(from, specifier);
      return file !== undefined ? { file } : { hole: "unresolved-module" };
    }
    // A bare specifier: a package of the store, or its subpath.
    const parts = specifier.split("/");
    const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
    const sub = specifier.slice(name.length);
    const pkg = this.packages.get(name);
    if (pkg === undefined) return { hole: "external-package" };
    if (sub === "") return this.modules.has(pkg.entryPath) ? { file: pkg.entryPath } : { hole: "unresolved-module" };
    const file = tryResolve(`${pkg.root}/package.json`, `.${sub}`);
    return file !== undefined ? { file } : { hole: "unresolved-module" };
  }

  /** What a module exports under `name`, followed to its atom. */
  private resolveExport(file: string, name: string, seen = new Set<string>()): Resolution {
    const key = `${file}#${name}`;
    if (seen.has(key)) return { kind: "hole", cause: "missing-export", detail: `cycle at ${name}` };
    seen.add(key);
    const scope = this.scopeOf(file);
    if (scope === undefined) return { kind: "hole", cause: "unresolved-module", detail: file };
    const target = scope.exports.get(name);
    if (target === undefined) {
      if (name === "*" || name === "default") {
        // A whole module: a namespace of its exports, or a CommonJS module with no single value.
        if (name === "default" && scope.exports.has("*")) return this.resolveExport(file, "*", seen);
        return { kind: "module", filePath: file };
      }
      // A CommonJS module whose whole export is one value: the name is a member of that value.
      const whole = scope.exports.get("*");
      if (whole !== undefined) return this.resolveExport(file, "*", seen);
      for (const star of scope.starExports) {
        const at = this.resolveSpecifier(file, star);
        if ("file" in at) {
          const r = this.resolveExport(at.file, name, seen);
          if (r.kind !== "hole") return r;
        }
      }
      return { kind: "hole", cause: "missing-export", detail: `${name} in ${file}` };
    }
    if (target.kind === "atom") return { kind: "atom", filePath: file, atom: target.atom };
    if (target.kind === "unshaved") return { kind: "hole", cause: "not-shaved", detail: `${name} in ${file}` };
    if (target.kind === "local") return this.resolveName(file, target.local, seen);
    return this.resolveImport(file, { specifier: target.specifier, imported: target.imported }, seen);
  }

  private resolveImport(file: string, binding: ImportBinding, seen: Set<string>): Resolution {
    const at = this.resolveSpecifier(file, binding.specifier);
    if ("platform" in at) return { kind: "platform", module: at.platform };
    if ("hole" in at) return { kind: "hole", cause: at.hole, detail: binding.specifier };
    return this.resolveExport(at.file, binding.imported, seen);
  }

  /** A top-level name of a module, followed to the atom that declares it. */
  private resolveName(file: string, name: string, seen = new Set<string>()): Resolution {
    const scope = this.scopeOf(file);
    if (scope === undefined) return { kind: "hole", cause: "unresolved-module", detail: file };
    if (name === "exports" || name === "module") return { kind: "module-self" };
    const binding = scope.imports.get(name);
    if (binding !== undefined) return this.resolveImport(file, binding, seen);
    if (!scope.declarations.has(name)) {
      return { kind: "hole", cause: scope.innerNames.has(name) ? "enclosing-scope" : "undeclared", detail: name };
    }
    const atom = scope.declarations.get(name);
    if (atom === undefined) return { kind: "hole", cause: "not-shaved", detail: name };
    return { kind: "atom", filePath: file, atom };
  }

  /**
   * Resolve a name that an atom of `file` references. `require` resolves when every call to it in
   * the atom has a literal specifier that resolves.
   */
  resolve(file: string, name: string, atomSource?: string): Resolution {
    if (name === "require" && atomSource !== undefined) {
      const specs: (string | undefined)[] = [];
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "require") specs.push(requireSpecifier(n));
        ts.forEachChild(n, visit);
      };
      visit(parse(atomSource));
      if (specs.length === 0 || specs.some((s) => s === undefined)) return { kind: "hole", cause: "dynamic-require", detail: "require" };
      for (const s of specs as string[]) {
        const at = this.resolveSpecifier(file, s);
        if ("hole" in at) return { kind: "hole", cause: at.hole, detail: s };
      }
      return { kind: "module", filePath: file };
    }
    return this.resolveName(file, name);
  }
}
