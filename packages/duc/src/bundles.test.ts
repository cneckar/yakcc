// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { unwrapBundles } from "./bundles.js";

/** A script's result: its text run with `module`, returning `out`. */
function run(text: string): unknown {
  const module = { exports: {} as Record<string, unknown> };
  return new Function("module", `let out;\n${text}\nreturn out;`)(module);
}

describe("bundle wrappers, unwrapped into module statements (#1361)", () => {
  it("an arrow bundle passed CommonJS's `module`: its body is the module's statements", () => {
    // The TypeScript compiler's shape: `var ts = {}; ((module) => { … })({ get exports() … })`.
    const text = `var api = {}; ((module) => {
"use strict";
var count = 1;
function next() { return ++count; }
module.exports = { next, get count() { return count; } };
})({ get exports() { return api; }, set exports(v) { api = v; if (typeof module !== "undefined" && module.exports) { module.exports = v; } } });
out = [api.next(), api.next(), api.count, module.exports === api];`;
    const unwrapped = unwrapBundles(text);
    expect(unwrapped).not.toBe(text);
    expect(unwrapped).not.toMatch(/\(\(module\) =>/);
    expect(run(unwrapped)).toEqual(run(text));
    expect(run(unwrapped)).toEqual([2, 3, 3, true]);
  });

  it("a TypeScript enum: the parameter is renamed, the argument keeps the outer name", () => {
    const text = `var E;
(function (E) { E[E["A"] = 0] = "A"; E[E["B"] = 1] = "B"; })(E || (E = {}));
out = [E.A, E.B, E[1]];`;
    const unwrapped = unwrapBundles(text);
    expect(unwrapped).not.toBe(text);
    expect(run(unwrapped)).toEqual([0, 1, "B"]);
  });

  it("a shorthand property of a parameter keeps its key", () => {
    const text = "((m) => { var o = { m }; out = [o.m, Object.keys(o)]; })(5);";
    const unwrapped = unwrapBundles(text);
    expect(unwrapped).not.toBe(text);
    expect(run(unwrapped)).toEqual([5, ["m"]]);
  });

  it("extra arguments are still evaluated, and a missing one is undefined", () => {
    const text = "var log = []; ((a, b) => { out = [a, b, log]; })(log.push(1), );";
    const more = "var log = []; ((a) => { out = [a, log.slice()]; })(log.push(1), log.push(2));";
    expect(run(unwrapBundles(text))).toEqual(run(text));
    expect(unwrapBundles(more)).not.toBe(more);
    expect(run(unwrapBundles(more))).toEqual(run(more));
  });

  it("leaves a wrapper nothing outside could tell from its body only when that holds", () => {
    for (const text of [
      // A name the body declares is used outside: hoisted, it would be the body's.
      "var x = 1; (() => { var x = 2; })(); out = x;",
      // A function declared in the body, read outside before the call.
      "out = typeof f; (() => { function f() {} })();",
      // A return of its own.
      "(() => { if (out) return; out = 1; })();",
      // A function expression's own receiver and arguments.
      "(function () { this.a = 1; })();",
      "(function () { out = arguments.length; })(1, 2);",
      // A parameter declared again inside.
      "((m) => { function f(m) { return m; } out = f(m); })(1);",
      // Async, a generator, a named function expression, a default parameter, a spread argument.
      "(async () => { out = 1; })();",
      "(function* () { out = 1; })();",
      "(function named() { out = 1; })();",
      "((a = 1) => { out = a; })();",
      "((a) => { out = a; })(...[1]);",
    ])
      expect(unwrapBundles(text), text).toBe(text);
  });

  it("a `var` in a block of the body, or an arrow's `this`, are the body's as they were", () => {
    const text =
      "var self = this; ((m) => { if (true) { var inner = m + 1; } out = [inner, this === self]; })(1);";
    const unwrapped = unwrapBundles(text);
    expect(unwrapped).not.toBe(text);
    expect(new Function(`let out;\n${unwrapped}\nreturn out;`).call({ me: 1 })).toEqual(
      new Function(`let out;\n${text}\nreturn out;`).call({ me: 1 }),
    );
  });
});
