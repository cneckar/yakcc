// SPDX-License-Identifier: MIT
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ModuleRecord, type PackageRecord, ReferenceResolver, isImportBinding, moduleScopeOf } from "./reference-resolver.js";

/** A package on disk (resolution goes through Node's resolver), with its atoms given per module. */
function packageOf(name: string, files: Record<string, { source: string; atoms: string[] }>, entry = "index.js"): PackageRecord {
  const root = mkdtempSync(join(tmpdir(), "resolver-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, main: entry }));
  const modules: ModuleRecord[] = [];
  for (const [rel, m] of Object.entries(files)) {
    const filePath = join(root, rel);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, m.source);
    modules.push({ filePath, source: m.source, atoms: m.atoms });
  }
  return { name, root, entryPath: join(root, entry), modules };
}

describe("reference resolution (#1281)", () => {
  const helper = "function helper(x) { return x + 1; }";
  const user = "function main(y) { return helper(y) * 2; }";
  const lib = packageOf("lib", {
    "index.js": {
      source: `const parse = require('./parse');\nconst fs = require('fs');\n${helper}\n${user}\nmodule.exports = { main, parse };\n`,
      atoms: ["const parse = require('./parse');", "const fs = require('fs');", helper, user],
    },
    "parse.js": { source: "module.exports = function parse(s) { return s.trim(); };\n", atoms: ["module.exports = function parse(s) { return s.trim(); };"] },
    "esm.js": {
      source: "import { main as m } from './index.js';\nexport function twice(v) { return m(m(v)); }\nexport * from './parse.js';\n",
      atoms: ["export function twice(v) { return m(m(v)); }"],
    },
  });
  const app = packageOf("app", {
    "index.js": {
      source: "const { main } = require('lib');\nconst jws = require('jws');\nfunction run(z) { return main(z) + jws.sign(z); }\n",
      atoms: ["const { main } = require('lib');", "const jws = require('jws');", "function run(z) { return main(z) + jws.sign(z); }"],
    },
  });
  const resolver = new ReferenceResolver([lib, app]);
  const file = (p: PackageRecord, rel: string): string => join(p.root, rel);

  it("a name declared by another atom of the module links to that atom", () => {
    expect(resolver.resolve(file(lib, "index.js"), "helper")).toEqual({ kind: "atom", filePath: file(lib, "index.js"), atom: 2 });
  });

  it("a require of a module of the package links to the atom that is its export", () => {
    expect(resolver.resolve(file(lib, "index.js"), "parse")).toEqual({ kind: "atom", filePath: file(lib, "parse.js"), atom: 0 });
  });

  it("a Node builtin is a platform module", () => {
    expect(resolver.resolve(file(lib, "index.js"), "fs")).toEqual({ kind: "platform", module: "fs" });
  });

  it("an ESM import follows the export to its declaring atom", () => {
    expect(resolver.resolve(file(lib, "esm.js"), "m")).toEqual({ kind: "atom", filePath: file(lib, "index.js"), atom: 3 });
  });

  it("a destructured require of another package of the store follows its entry's exports", () => {
    expect(resolver.resolve(file(app, "index.js"), "main")).toEqual({ kind: "atom", filePath: file(lib, "index.js"), atom: 3 });
  });

  it("a package that is not in the store is a hole", () => {
    expect(resolver.resolve(file(app, "index.js"), "jws")).toMatchObject({ kind: "hole", cause: "external-package" });
  });

  it("a name the module does not declare is a hole", () => {
    expect(resolver.resolve(file(lib, "index.js"), "nowhere")).toMatchObject({ kind: "hole", cause: "undeclared" });
  });

  it("exports and module are the module's own object", () => {
    expect(resolver.resolve(file(lib, "index.js"), "exports")).toEqual({ kind: "module-self" });
  });

  it("require resolves when each specifier in the atom does", () => {
    expect(resolver.resolve(file(lib, "index.js"), "require", "function f() { return require('./parse')('x'); }")).toMatchObject({ kind: "module" });
    expect(resolver.resolve(file(lib, "index.js"), "require", "function f(n) { return require(n); }")).toMatchObject({ kind: "hole", cause: "dynamic-require" });
  });

  it("an import statement is a binding, not an atom", () => {
    expect(isImportBinding("const a = require('a'), b = require('b').c;")).toBe(true);
    expect(isImportBinding("import { x } from 'y';")).toBe(true);
    expect(isImportBinding("const a = require('a'); a();")).toBe(false);
  });

  it("the module scope records CommonJS export forms", () => {
    const scope = moduleScopeOf({
      filePath: "/x.js",
      source: "function a() {}\nexports.b = a;\nmodule.exports.c = require('./c');\n",
      atoms: ["function a() {}"],
    });
    expect(scope.exports.get("b")).toEqual({ kind: "local", local: "a" });
    expect(scope.exports.get("c")).toEqual({ kind: "reexport", specifier: "./c", imported: "*" });
    expect(scope.declarations.get("a")).toBe(0);
  });
});
