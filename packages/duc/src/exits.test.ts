// SPDX-License-Identifier: Apache-2.0
/**
 * Exits (#1276): a return or a throw leaves the function, so what follows it runs only on the paths
 * that have not left. An `if` that exits on some paths takes the rest of the function onto both
 * sides, and the exits join in one total `if`. Falling off the end returns undefined.
 */
import { describe, expect, it } from "vitest";
import { graphIdentity } from "./canonical.js";
import { emitTypeScript } from "./emit-ts.js";
import { liftAtom } from "./lift.js";

const id = (src: string): string => graphIdentity(liftAtom(src));
const regionOfCall = (src: string, callee: string): string | undefined => {
  const g = liftAtom(src);
  const sym = g.nodes.find((n) => n.diamond?.symbol === callee)?.outputs[0];
  return g.nodes.find((n) => n.label === "CallExpression" && n.inputs[0] === sym)?.region;
};

describe("conditions that assign, and postfix values (#1276)", () => {
  const cases: [string, unknown[]][] = [
    [
      "export function f(xs: number[]) { const out = []; let r; let i = 0; while ((r = xs[i]) !== undefined) { out.push(r * 2); i = i + 1; } return [out, r]; }",
      [[1, 2, 3]],
    ],
    [
      "export function f(n: number) { let s = 0; let i = n; while (i--) { s = s + i; } return [s, i]; }",
      [4],
    ],
    [
      "export function f(n: number) { let i = -n; let c = 0; do { c = c + 1; } while (++i); return [c, i]; }",
      [3],
    ],
    [
      "export function f(xs: number[]) { let k = 0; for (let j = 0; (k = xs[j]) > 0; j++) {} return k; }",
      [[3, 2, 0, 5]],
    ],
    [
      "export function f(n: number) { let i = n; const a = i++; const b = i--; return [a, b, i]; }",
      [5],
    ],
    [
      "export function f(xs: number[], t: number) { let i = 0; let v; while ((v = xs[i++]) !== undefined) { if (v === t) return i; } return -1; }",
      [[4, 5, 6], 5],
    ],
  ];
  for (const [src, args] of cases) {
    it(`computes what the source computes and lifts back the same: ${src.slice(22, 80)}`, () => {
      const g = liftAtom(src);
      const code = emitTypeScript(g);
      const lifted = new Function(`${code.replace("export ", "")}; return f;`)() as (
        ...a: unknown[]
      ) => unknown;
      const source = new Function(
        `${src.replace("export ", "").replace(/: number(\[\])?/g, "")}; return f;`,
      )() as (...a: unknown[]) => unknown;
      expect(lifted(...structuredClone(args))).toEqual(source(...structuredClone(args)));
      expect(graphIdentity(liftAtom(code))).toBe(graphIdentity(g));
    });
  }
});

describe("iterating over an existing name (#1276)", () => {
  const cases: [string, unknown[]][] = [
    [
      "export function f(o: any) { let i; let n = 0; for (i in o) { n = n + o[i]; } return [n, i]; }",
      [{ a: 1, b: 2 }],
    ],
    ['export function f(o: any) { let i = "none"; for (i in o) {} return i; }', [{}]],
    [
      "export function f(xs: number[]) { let x = -1; for (x of xs) { if (x > 2) break; } return x; }",
      [[1, 3, 5]],
    ],
  ];
  for (const [src, args] of cases) {
    it(`assigns each element to the name, which the loop carries: ${src.slice(22, 70)}`, () => {
      const g = liftAtom(src);
      expect(g.nodes.some((n) => (n.label ?? "").includes("#"))).toBe(false);
      const code = emitTypeScript(g);
      const run = (text: string): unknown =>
        (new Function(`${text}; return f;`)() as (...a: unknown[]) => unknown)(
          ...structuredClone(args),
        );
      expect(run(code.replace("export ", ""))).toEqual(
        run(src.replace("export ", "").replace(/: (any|number\[\])/g, "")),
      );
      expect(graphIdentity(liftAtom(code))).toBe(graphIdentity(g));
    });
  }
});

describe("delete (#1276)", () => {
  it("delete is a heap operation on the object, its value delete's result, and lifts back the same", () => {
    const src =
      "export function f(o: any, k: string) { const had = delete o[k]; delete o.extra; return [had, Object.keys(o)]; }";
    const g = liftAtom(src);
    expect(g.nodes.some((n) => (n.label ?? "").startsWith("DeleteExpression#"))).toBe(false);
    const code = emitTypeScript(g);
    const run = new Function(`${code.replace("export ", "")}; return f;`)() as (
      o: unknown,
      k: string,
    ) => unknown;
    expect(run({ a: 1, b: 2, extra: 3 }, "a")).toEqual([true, ["b"]]);
    expect(graphIdentity(liftAtom(code))).toBe(graphIdentity(g));
  });
});

describe("exits (#1276)", () => {
  it("what follows a throw on some paths runs only on the other paths", () => {
    // The call is inside the branch's else side, not at the top level where it would always run.
    expect(
      regionOfCall(
        "export function f(c: boolean, x: number) { if (c) throw new Error('no'); log(x); }",
        "log",
      ),
    ).toMatch(/^b\d+\.e$/);
  });

  it("a throw after two returns is only on the path neither return takes", () => {
    const src =
      "export function f(v: any) { if (typeof v === 'string') { return parse(v); } else if (typeof v === 'number') { return show(v); } throw new Error('bad'); }";
    const g = liftAtom(src);
    const thrown = g.nodes.find((n) => n.label === "throw");
    expect(thrown?.region).toMatch(/\.e\/b\d+\.e$/);
  });

  it("falling off the end, return; and return undefined are one program", () => {
    const a = id("export function f(x: number) { log(x); }");
    expect(id("export function f(x: number) { log(x); return; }")).toBe(a);
    expect(id("export function f(x: number) { log(x); return undefined; }")).toBe(a);
  });

  it("nothing after a return is lifted", () => {
    expect(id("export function f(x: number) { return x; log(x); }")).toBe(
      id("export function f(x: number) { return x; }"),
    );
  });

  it("an exit inside a nested if takes the rest of the function onto every path", () => {
    const g = liftAtom(
      "export function f(c: boolean, x: number) { if (c) { if (x > 0) { return 1; } } log(x); return x; }",
    );
    // log runs on two paths (c false; c true and x <= 0), never at the top level.
    const calls = g.nodes.filter((n) => n.label === "CallExpression");
    expect(calls.length).toBe(2);
    expect(calls.every((n) => n.region !== undefined)).toBe(true);
  });

  it("a loop whose body throws lifts, with the rest of its body on the side that does not throw", () => {
    const src =
      "export function f(xs: number[]) { let s = 0; for (const x of xs) { if (x < 0) throw new Error('neg'); s = s + x; } return s; }";
    const g = liftAtom(src);
    expect(g.nodes.some((n) => n.kind === "loop" && n.loop !== undefined)).toBe(true);
    const thrown = g.nodes.find((n) => n.label === "throw");
    const added = g.nodes.find((n) => n.label === "+");
    expect(thrown?.region).toMatch(/\.t$/);
    expect(added?.region).toMatch(/\.e$/);
    const code = emitTypeScript(g);
    const run = new Function(`${code.replace("export ", "")}; return f;`)() as (
      xs: number[],
    ) => number;
    expect(run([1, 2, 3])).toBe(6);
    expect(() => run([1, -1, 3])).toThrow("neg");
    expect(graphIdentity(liftAtom(code))).toBe(graphIdentity(g));
  });

  it("a join whose sides hold the same new value takes it, and a side that throws does not join", () => {
    expect(
      id(
        "export function f(c: boolean, y: number) { let x = 0; if (c) { x = y; } else { x = y; } return x; }",
      ),
    ).toBe(id("export function f(c: boolean, y: number) { return y; }"));
    // The throwing side never reaches the join: the counter is the incremented one on every path.
    const g = liftAtom(
      "export function f(n: number, a: boolean, b: boolean) { let i = 0; let s = 0; while (i < n) { const j = i + 1; if (a) { s = 1; } else if (b) { throw new Error('b'); } else { s = 2; } i = j; } return [i, s]; }",
    );
    const sels = g.nodes.filter((n) => n.kind === "sel");
    const plus = g.nodes.find((n) => n.label === "+")?.outputs[0];
    expect(sels.some((n) => n.inputs.includes(plus as string))).toBe(false);
  });

  it("loops lift with continues and throws in for-of, nested exits, and a throw in an inner loop", () => {
    const cases: [string, unknown[][]][] = [
      [
        "export function f(xs: any[]) { const out: any[] = []; for (const x of xs) { if (x === null) continue; if (typeof x !== 'number') throw new TypeError('bad ' + x); out.push(x * 2); } return out; }",
        [[[1, null, 3]], [[1, "a"]]],
      ],
      [
        "export function f(o: any) { let n = 0; for (const k in o) { if (k === 'skip') continue; n = n + o[k]; } return n; }",
        [[{ a: 1, skip: 5, b: 2 }]],
      ],
      [
        "export function f(rows: number[][]) { let s = 0; for (let i = 0; i < rows.length; i++) { let j = 0; while (j < rows[i].length) { if (rows[i][j] < 0) break; s = s + rows[i][j]; j = j + 1; } if (s > 100) break; } return s; }",
        [[[[1, 2, -1, 9], [3]]], [[[200], [5]]]],
      ],
      [
        "export function f(rows: number[][]) { let s = 0; for (const r of rows) { for (const v of r) { if (v < 0) throw new RangeError('negative'); s = s + v; } } return s; }",
        [[[[1, 2], [3]]], [[[1], [-2]]]],
      ],
    ];
    for (const [src, inputs] of cases) {
      const g = liftAtom(src);
      expect(
        g.nodes.filter((n) => n.kind === "loop").every((n) => n.loop !== undefined),
        src,
      ).toBe(true);
      const code = emitTypeScript(g);
      const lifted = new Function(`${code.replace("export ", "")}; return f;`)() as (
        ...a: unknown[]
      ) => unknown;
      const source = new Function(
        `${src.replace("export ", "").replace(/: [a-z]+(\[\])*(\[\])?/g, "")}; return f;`,
      )() as (...a: unknown[]) => unknown;
      for (const args of inputs) {
        const outcome = (fn: (...a: unknown[]) => unknown): unknown => {
          try {
            return { value: fn(...structuredClone(args)) };
          } catch (e) {
            return { threw: String(e) };
          }
        };
        expect(outcome(lifted), code).toEqual(outcome(source));
      }
      expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
    }
  });

  it("the emitter writes what does not depend on a throwing branch before it", () => {
    const src =
      "export function f(a: string, b: string) { check(a); check(b); if (b in table) { return table[b](a); } throw new Error('unknown ' + b); }";
    const code = emitTypeScript(liftAtom(src));
    const lastCheck = Math.max(...[...code.matchAll(/check\(/g)].map((m) => m.index ?? -1));
    const branch = code.indexOf("if (");
    expect(lastCheck).toBeGreaterThan(-1);
    expect(lastCheck).toBeLessThan(branch);
    expect(graphIdentity(liftAtom(code))).toBe(graphIdentity(liftAtom(src)));
  });

  it("a select of one value on both sides is that value, and one inside its own condition takes its arm", () => {
    expect(id("export function f(c: boolean, x: number) { return c ? x : x; }")).toBe(
      id("export function f(c: boolean, x: number) { return x; }"),
    );
    expect(
      id("export function f(c: boolean, x: number, y: number) { return c ? x : (c ? 0 : y); }"),
    ).toBe(id("export function f(c: boolean, x: number, y: number) { return c ? x : y; }"));
  });
});

describe("arms that run only when chosen (#1276)", () => {
  it("a call in a ternary arm runs only in its branch", () => {
    expect(
      regionOfCall("export function f(c: boolean, x: number) { return c ? a(x) : b(x); }", "a"),
    ).toMatch(/^b\d+\.t$/);
    expect(
      regionOfCall("export function f(c: boolean, x: number) { return c ? a(x) : b(x); }", "b"),
    ).toMatch(/^b\d+\.e$/);
  });

  it("the right side of && and || is evaluated only on its path", () => {
    expect(regionOfCall("export function f(x: any) { return x && g(x); }", "g")).toMatch(
      /^b\d+\.t$/,
    );
    expect(regionOfCall("export function f(x: any) { return x || g(x); }", "g")).toMatch(
      /^b\d+\.e$/,
    );
    expect(regionOfCall("export function f(x: any) { return x ?? g(x); }", "g")).toMatch(
      /^b\d+\.t$/,
    );
  });

  it("a member read guarded by && is not read when the guard fails", () => {
    const g = liftAtom("export function f(s: any) { return s && s.length; }");
    expect(g.nodes.find((n) => n.label === ".length")?.region).toMatch(/^b\d+\.t$/);
  });

  it("a ternary of values is still a select (D3)", () => {
    const g = liftAtom("export function f(c: boolean, x: number) { return c ? x + 1 : x - 1; }");
    expect(g.branches).toBeUndefined();
  });

  it("a lazy arm emits and lifts back to the same structure", () => {
    for (const src of [
      "export function f(c: boolean, x: number) { return c ? a(x) : b(x); }",
      "export function f(x: any) { return x && x.length > 0; }",
      "export function f(x: any, d: number) { return x ?? g(d); }",
    ]) {
      const g = liftAtom(src);
      expect(graphIdentity(liftAtom(emitTypeScript(g))), src).toBe(graphIdentity(g));
    }
  });
});

describe("switch (#1276)", () => {
  const src = (body: string) => `export function f(k: string, x: number) { ${body} }`;

  it("a switch whose clauses end in break, return or throw is its if chain", () => {
    const sw = id(
      src(
        "switch (k) { case 'a': return x + 1; case 'b': case 'c': return x - 1; default: throw new Error(k); }",
      ),
    );
    const chain = id(
      src(
        "const s = k; if (s === 'a') { return x + 1; } else if (s === 'b' || s === 'c') { return x - 1; } else { throw new Error(k); }",
      ),
    );
    expect(sw).toBe(chain);
  });

  it("break ends a clause, and what follows the switch runs after it", () => {
    const g = liftAtom(
      src("let r = 0; switch (k) { case 'a': r = x; break; default: r = 2; } return r * 3;"),
    );
    expect(g.nodes.some((n) => n.label?.startsWith("SwitchStatement#"))).toBe(false);
    const code = emitTypeScript(g);
    const run = (k: string, x: number): unknown =>
      new Function(`${code.replace("export ", "")}; return f(${JSON.stringify(k)}, ${x});`)();
    expect(run("a", 5)).toBe(15);
    expect(run("z", 5)).toBe(6);
  });

  it("a clause that falls into the next runs the next clause's statements too", () => {
    const g = liftAtom(
      src("let r = 0; switch (k) { case 'a': r = 1; case 'b': r = r + 1; break; } return r;"),
    );
    expect(g.nodes.some((n) => n.label?.startsWith("SwitchStatement#"))).toBe(false);
    const code = emitTypeScript(g);
    const run = (k: string): unknown =>
      new Function(`${code.replace("export ", "")}; return f(${JSON.stringify(k)}, 0);`)();
    expect([run("a"), run("b"), run("z")]).toEqual([2, 1, 0]);
  });

  it("a switch with a continue inside (and so its loop), or clauses sharing a name, stays opaque", () => {
    const opaque = (body: string): boolean =>
      liftAtom(src(body)).nodes.some((n) =>
        /^(SwitchStatement|ForOfStatement)#/.test(n.label ?? ""),
      );
    expect(
      opaque(
        "let r = 0; for (const c of [k]) { switch (c) { case 'a': if (x) continue; r = 1; case 'b': r = r + 2; } } return r;",
      ),
    ).toBe(true);
    expect(
      opaque("switch (k) { case 'a': const y = 1; case 'b': return y; default: return x; }"),
    ).toBe(true);
  });
});

describe("destructuring and defaults (#1276)", () => {
  const run = (src: string, ...args: unknown[]): unknown => {
    const code = emitTypeScript(liftAtom(src));
    return new Function(`${code.replace("export ", "")}; return f(...${JSON.stringify(args)});`)();
  };

  it("each name of an object pattern reads its own member", () => {
    const src =
      "export function f(o: any) { const { a, b: c, d = 7 } = o; return a !== c ? a + c + d : 0; }";
    expect(run(src, { a: 1, b: 2 })).toBe(10);
    expect(run(src, { a: 1, b: 1, d: 1 })).toBe(0);
  });

  it("an array pattern reads by index, with a rest", () => {
    const src =
      "export function f(xs: number[]) { const [x, , y, ...more] = xs; return x + y + more.length; }";
    expect(run(src, [1, 2, 3, 4, 5])).toBe(6);
  });

  it("a parameter default applies when the argument is undefined", () => {
    const src = "export function f(a: number, offset = 10) { return a + offset; }";
    expect(run(src, 1)).toBe(11);
    expect(run(src, 1, 2)).toBe(3);
  });

  it("a default that calls runs only when it is needed", () => {
    expect(
      regionOfCall("export function f(o: any) { const { a = make() } = o; return a; }", "make"),
    ).toMatch(/^b\d+\.t$/);
  });

  it("a pattern in a loop binds each element's members", () => {
    const src =
      "export function f(o: any) { let s = 0; for (const [k, v] of Object.entries(o)) { s = s + v; } return s; }";
    expect(run(src, { x: 2, y: 3 })).toBe(5);
  });
});

describe("loops that break, continue and return (#1276)", () => {
  const run = (src: string, ...args: unknown[]): unknown => {
    const code = emitTypeScript(liftAtom(src));
    return new Function(`${code.replace("export ", "")}; return f(...${JSON.stringify(args)});`)();
  };
  const cases: [string, string, unknown[][]][] = [
    [
      "break",
      "export function f(n: number) { let i = 0; let s = 0; while (i < n) { if (s > 10) break; s = s + i; i = i + 1; } return s * 100 + i; }",
      [[0], [3], [20]],
    ],
    [
      "continue",
      "export function f(n: number) { let s = 0; for (let i = 0; i < n; i = i + 1) { if (i % 2 === 0) continue; s = s + i; } return s; }",
      [[0], [7]],
    ],
    [
      "break in a for keeps its counter",
      "export function f(n: number) { let i = 0; for (i = 0; i < n; i = i + 1) { if (i * i > 20) break; } return i; }",
      [[3], [10]],
    ],
    [
      "return",
      "export function f(xs: number[], k: number) { let i = 0; while (i < xs.length) { if (xs[i] === k) return i; i = i + 1; } return -1; }",
      [
        [[4, 5, 6], 5],
        [[4, 5, 6], 9],
        [[], 1],
      ],
    ],
    [
      "return and break",
      "export function f(n: number) { let i = 0; while (true) { if (i === 3) return 'three'; if (i > n) break; i = i + 1; } return i; }",
      [[1], [5]],
    ],
  ];
  for (const [name, src, inputs] of cases) {
    it(`${name}: lifts as a loop, and the emitted code computes the same and lifts back`, () => {
      const g = liftAtom(src);
      expect(g.nodes.some((n) => n.kind === "loop" && n.loop !== undefined)).toBe(true);
      const code = emitTypeScript(g);
      const original = new Function(
        `${src.replace("export ", "").replace(/: [a-z\[\]]+/g, "")}; return f;`,
      )() as (...a: unknown[]) => unknown;
      for (const args of inputs)
        expect(run(src, ...args), `${name} ${JSON.stringify(args)}`).toEqual(original(...args));
      expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
    });
  }
});

describe("do loops (#1276)", () => {
  const cases: [string, string, unknown[][]][] = [
    [
      "runs once before it tests",
      "export function f(n: number) { let i = 0; let s = 0; do { s = s + 10; i = i + 1; } while (i < n); return s * 100 + i; }",
      [[0], [1], [3]],
    ],
    [
      "a lazy condition is not run on the first pass",
      "export function f(xs: number[]) { let i = 0; do { i = i + 1; } while (i < xs.length && xs[i] > 0); return i; }",
      [[[]], [[5, 4, 0, 2]]],
    ],
    [
      "break and continue",
      "export function f(n: number) { let i = 0; let s = 0; do { i = i + 1; if (i % 2 === 0) continue; if (i > 7) break; s = s + i; } while (i < n); return s; }",
      [[1], [5], [20]],
    ],
  ];
  for (const [name, src, inputs] of cases) {
    it(`${name}: lifts as a loop, computes the same, and lifts back`, () => {
      const g = liftAtom(src);
      expect(g.nodes.some((n) => n.kind === "loop" && n.loop !== undefined)).toBe(true);
      const code = emitTypeScript(g);
      const run = (c: string, args: unknown[]): unknown =>
        new Function(
          `${c.replace("export ", "").replace(/: [a-z[\]]+/g, "")}; return f(...${JSON.stringify(args)});`,
        )();
      for (const args of inputs)
        expect(run(code, args), `${name} ${JSON.stringify(args)}`).toEqual(run(src, args));
      expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
    });
  }

  describe("a block with a jump, and names elsewhere in the body (#1276)", () => {
    it("a sibling block's own declaration, or a property name, does not keep the loop opaque", () => {
      const g = liftAtom(
        "export function f(xs: any[], o: any) { let n = 0; for (const x of xs) { if (x > 1) { const err = x * 2; if (err > 10) continue; n = n + err; } { const err = o.info; n = n + err; } } return n; }",
      );
      expect(g.nodes.some((n) => (n.label ?? "").includes("#"))).toBe(false);
      expect(graphIdentity(liftAtom(emitTypeScript(g)))).toBe(graphIdentity(g));
    });
  });
});
