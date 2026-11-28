// SPDX-License-Identifier: Apache-2.0
// A program record's modules (#1333): import() and import.meta are found as syntax, not as text, so a
// module that only mentions them (TypeScript's own diagnostics do) is read; an import() of a string
// literal is a link, of anything else refused.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProgramError, programRecord, unwrapModuleFunction } from "./program.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

describe("program records: what the native subset refuses (#1333)", () => {
  it("a module that only mentions import() and import.meta in strings and comments is read", () => {
    const record = programRecord(here("./__fixtures__/program/syntax/mentions.js"), here(".."));
    expect(record.modules.map((m) => m.id)).toEqual([
      "src/__fixtures__/program/syntax/mentions.js",
    ]);
  });
  it("an import() of a computed specifier links nothing: it is resolved when it runs (#1370)", () => {
    const record = programRecord(here("./__fixtures__/program/syntax/dynamic.js"), here(".."));
    expect(record.modules.map((m) => m.id)).toEqual(["src/__fixtures__/program/syntax/dynamic.js"]);
  });
});

describe("a module that is one function called at once, a bundler's wrapper (#1370)", () => {
  const wrap = (body: string, arg = "{}", param = "module", rest = "var api = {};") =>
    `${rest}\n((${param}) => {\n"use strict";\n${body}\n})(${arg});\n`;
  const big = "var a = 1; function f(x) { return x + a; } const o = { module: 1, f };";
  it("has its body's statements as its own, the parameter renamed apart and bound to the argument", () => {
    const out = unwrapModuleFunction(
      wrap(
        `${big} module.exports = { f, short: { module }, m: o.module };`,
        "{ get exports() { return module.exports; } }",
      ),
    );
    expect(out).toBeDefined();
    const text = out as string;
    expect(text).toContain(
      "var __yk_wrapped_module = { get exports() { return module.exports; } };",
    );
    expect(text).toContain(
      "__yk_wrapped_module.exports = { f, short: { module: __yk_wrapped_module }, m: o.module };",
    );
    expect(text).toContain("const o = { module: 1, f };");
    expect(text).not.toContain('"use strict"');
    // The same values, run.
    const run = (src: string) => {
      const m = { exports: {} as Record<string, unknown> };
      new Function("module", src)(m);
      return m;
    };
    const arg = "{ set exports(v) { module.exports = v; } }";
    const a = run(
      wrap(`${big} module.exports = { r: f(2), s: { module }.module === module };`, arg),
    );
    const b = run(
      unwrapModuleFunction(
        wrap(`${big} module.exports = { r: f(2), s: { module }.module === module };`, arg),
      ) as string,
    );
    expect(b.exports).toEqual(a.exports);
    expect(b.exports).toEqual({ r: 3, s: true });
  });
  it("is left as it is when unwrapping could change what it means", () => {
    // A return of the function's own.
    expect(unwrapModuleFunction(wrap(`${big} if (a) return; a = 2;`))).toBeUndefined();
    // The parameter declared again inside.
    expect(
      unwrapModuleFunction(wrap(`${big} function g(module) { return module; }`)),
    ).toBeUndefined();
    // A name the body declares that the module's other code uses.
    expect(
      unwrapModuleFunction(wrap(big, "{}", "module", "var api = {}; var a = 5;")),
    ).toBeUndefined();
    // A function expression's this or arguments.
    expect(
      unwrapModuleFunction(`var api = {};\n(function (module) {\n${big} var t = this;\n})({});\n`),
    ).toBeUndefined();
    expect(
      unwrapModuleFunction(
        `var api = {};\n(function (module) {\n${big} var t = arguments;\n})({});\n`,
      ),
    ).toBeUndefined();
    // A destructured parameter.
    expect(unwrapModuleFunction(wrap(big, "{}", "{ exports }"))).toBeUndefined();
  });
  it("a nested function's own return, this and arguments are its own", () => {
    expect(
      unwrapModuleFunction(
        `var api = {};\n(function (module) {\n${big} function g() { return this === arguments; }\n})({});\n`,
      ),
    ).toBeDefined();
  });
});
