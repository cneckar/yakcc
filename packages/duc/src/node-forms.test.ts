// SPDX-License-Identifier: Apache-2.0
/**
 * The last forms of Node's library that lifted to an opaque summary (#1330, #1361 M3). Each now lifts
 * with no opaque summary, its TypeScript lowering computes what the source computes, and the round
 * trip holds:
 * - a closure capturing a name that another function's own binding of the same name reassigns;
 * - a `continue` of a loop, inside a switch in it;
 * - a yielding `try` in a method that reads `this`;
 * - a `for...of` that stops: it leaves before the next element is pulled;
 * - a derived constructor's arrow made before `super(..)` that reads `this` when it runs;
 * - `super(..)` inside a `try`.
 */
import { ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import { runnable } from "./__fixtures__/runnable.js";
import { graphIdentity } from "./canonical.js";
import { emitTypeScript } from "./emit-ts.js";
import { liftFidelity } from "./fidelity.js";
import { liftAtom } from "./lift.js";
import type { DucGraph } from "./types.js";

type Fn = (...a: unknown[]) => unknown;

const opaque = (g: DucGraph): string[] =>
  g.nodes.flatMap((n) => [
    ...(/#[0-9a-f]{16}$/.test(n.label ?? "") ? [n.label as string] : []),
    ...(n.closure !== undefined ? opaque(n.closure) : []),
  ]);

const source = (code: string): Fn =>
  new Function(
    `${ts
      .transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
      .outputText.replace(/^export /m, "")}; return f;`,
  )() as Fn;

const outcome = (fn: Fn, args: unknown[]): string => {
  try {
    return `= ${JSON.stringify(fn(...args)) ?? "undefined"}`;
  } catch (e) {
    return `throws ${(e as Error).constructor.name}`;
  }
};

function agrees(code: string, inputs: unknown[][]): void {
  const g = liftAtom(code);
  expect(opaque(g), code).toEqual([]);
  const lowered = emitTypeScript(g);
  const b = new Function(`${runnable(lowered)}; return f;`)() as Fn;
  const a = source(code);
  for (const args of inputs)
    expect(outcome(b, args), `${code} on ${JSON.stringify(args)}`).toBe(outcome(a, args));
  expect(graphIdentity(liftAtom(lowered)), code).toBe(graphIdentity(g));
}

describe("Node's last opaque forms (#1330)", () => {
  it("a closure captures a name another function's parameter of the same name reassigns", () => {
    agrees(
      `export function f(req: any, err: any) {
  const log: string[] = [];
  function done(req: any, err: any) { if (!err) { err = 'hang up'; } log.push(String(err)); }
  const later = (er: any) => { if (er === 'x') { er = null; } done(req, er || err); };
  later('x'); later('y'); done(req, err);
  return log;
}`,
      [
        [{}, null],
        [{}, "boom"],
      ],
    );
  });

  it("a continue of the loop, inside a switch in it", () => {
    const inputs = [[""], ["a"], ["abc"], ["aab"], ["xyzzy"], ["zzzz"], ["baab"], ["qxz"]];
    agrees(
      "export function f(s: string) { let n = 0; for (let i = 0; i < s.length; i++) { switch (s[i]) { case 'a': n++; break; case 'b': continue; default: continue; } n += 10; } return n; }",
      inputs,
    );
    agrees(
      "export function f(s: string) { let n = 0, i = 0; while (i < s.length) { const c = s[i++]; switch (c) { case 'x': n += 100; case 'y': n += 1; break; case 'z': { if (n > 2) continue; n += 5; break; } default: n -= 1; continue; } n *= 2; } return n; }",
      inputs,
    );
    // A continue in a loop inside a case is that loop's.
    agrees(
      "export function f(s: string) { let n = 0; for (const c of s) { switch (c) { case 'a': for (let j = 0; j < 3; j++) { if (j === 1) continue; n += j; } break; default: n += 7; } } return n; }",
      inputs,
    );
  });

  it("a for...of that stops leaves before the next element is pulled", () => {
    agrees(
      `export function f(items: any[]) {
  let pulled = 0;
  function* gen() { for (const x of items) { pulled++; yield x; } }
  const out: any[] = [];
  for (const x of gen()) { out.push(x); if (x === 'stop') break; }
  return [out, pulled];
}`,
      [[[]], [[1, 2, 3]], [["a", "stop", "b", "c"]]],
    );
  });

  it("a yielding try in a method that reads this", () => {
    agrees(
      `export function f(items: any[]) {
  const log: string[] = [];
  class D {
    #i = 0;
    #items: any[];
    constructor(xs: any[]) { this.#items = xs; }
    #read() { return this.#i < this.#items.length ? this.#items[this.#i++] : null; }
    *entries() {
      try { while (true) { const r = this.#read(); if (r === null) { break; } yield r; } }
      finally { log.push('closed:' + this.#i); }
    }
  }
  const out: any[] = [];
  for (const x of new D(items).entries()) { out.push(x); if (x === 'stop') break; }
  return [out, log];
}`,
      [[[]], [[1, 2, 3]], [["a", "stop", "b"]]],
    );
  });

  it("an arrow made before super(..) reads this when it runs", () => {
    agrees(
      `export function f(n: number) {
  class Base { tag: string; constructor(o: any) { this.tag = o.tag; } }
  class Sock extends Base {
    count = 0;
    close: () => number;
    constructor(k: number) {
      const handle: any = {};
      handle.close = () => this.bump(k);
      super({ tag: 'sock' + k });
      this.close = handle.close;
    }
    bump(k: number) { this.count += k; return this.count; }
  }
  const s = new Sock(n);
  return [s.tag, s.close(), s.close()];
}`,
      [[1], [5]],
    );
  });

  it("super(..) inside a try", () => {
    agrees(
      `export function f(code: string) {
  class Base { code: string; constructor(c: string) { if (c === 'bad') throw new TypeError('bad'); this.code = c; } }
  class Script extends Base {
    constructor(c: string) {
      try { super(c); } catch (e) { throw e; }
      this.code = this.code + '!';
    }
  }
  try { return new Script(code).code; } catch (e) { return 'caught ' + (e as Error).message; }
}`,
      [["ok"], ["bad"]],
    );
  });
});

describe("hoisting over a let or const (#1330)", () => {
  it("a function declaration reads a const declared above it, which its own initializer passes", () => {
    agrees(
      `export function f(n: number) {
  const calls: number[] = [];
  const emit = make(n, deprecated);
  function deprecated(k: number) { emit(k); return k * 2; }
  function make(m: number, fn: (k: number) => number) { return (k: number) => calls.push(m + k + fn.length); }
  return [deprecated(3), deprecated(4), calls];
}`,
      [[1], [10]],
    );
  });

  it("a closure in a const's own initializer reads the const when it runs", () => {
    agrees(
      `export function f(flag: boolean) {
  const log: string[] = [];
  function eos(cb: () => void) { return () => { log.push('cleaned'); cb(); }; }
  const cleanup: () => void = eos(() => { if (flag && log.length < 3) { cleanup(); } });
  const run = () => cleanup();
  run();
  return log;
}`,
      [[true], [false]],
    );
  });
});

describe("a write to an outer name that a function expression of the same name shadows (#1330)", () => {
  it("`transcode = function transcode(..) {..}` keeps the write", () => {
    for (const source of [
      "transcode = function transcode(x) { return x; };",
      "if (c) { transcode = function transcode(x) { return transcode; }; }",
    ]) {
      const g = liftAtom(source);
      expect(liftFidelity(source, g), source).toEqual({ holds: true, missing: [], extra: [] });
      const code = emitTypeScript(g);
      expect(code, source).toMatch(/\btranscode = /);
      expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
    }
  });
});

describe("a switch that yields, in a generator's loop (#1330)", () => {
  it("each case's yield is the generator's", () => {
    agrees(
      `export function f(items: string[]) {
  function* report(xs: string[]) {
    yield 'start';
    for (const x of xs) {
      switch (x) {
        case 'a': { yield 'A'; yield 'a2'; break; }
        case 'skip': continue;
        default: yield x.toUpperCase();
      }
      yield '-';
    }
  }
  return [...report(items)];
}`,
      [[[]], [["a", "b"]], [["skip", "a", "c"]]],
    );
  });
});

describe("a function declared in a block after a statement that may throw (#1330)", () => {
  it("is bound on the side the rest is lifted on", () => {
    agrees(
      `export function f(i: boolean, t: boolean) {
  const out: number[] = [];
  if (i) { if (!t) { throw new RangeError('no'); } }
  if (t) { out.push(1); } else { function g() { return 7; } out.push(g()); }
  return out;
}`,
      [
        [false, false],
        [false, true],
        [true, true],
        [true, false],
      ],
    );
  });
});

describe("a function declaration reading a class declared in its scope (#1330)", () => {
  it("reads the class, whichever is written first", () => {
    agrees(
      `export function f(n: number) {
  class P { static make(k: number) { return new P(k); } v: number; constructor(k: number) { this.v = k * 2; } }
  function init(k: number) { return () => P.make(k).v; }
  function later(k: number) { return Q.twice(k); }
  class Q { static twice(k: number) { return k * 2; } }
  return [init(n)(), later(n)];
}`,
      [[1], [5]],
    );
  });
});

describe("an object rest (#1330)", () => {
  it("lowers to the runtime's call and lifts back to the same operation", () => {
    agrees(
      `export function f(o: any) {
  const { prototype, a, ...rest } = o;
  return [Object.keys(rest), rest.b, prototype === undefined, a];
}`,
      [[{ prototype: 1, a: 2, b: 3, c: 4 }], [{ b: 9 }], [null]],
    );
  });
});

describe("a join of two equal arms, one on a side of a branch (#1330)", () => {
  it("emits, runs and round-trips", () => {
    agrees(
      `export function f(p: any, a: number) {
  if (p) { if (!(p.s > 0)) { throw new RangeError('s'); } }
  if (p) { return [a, p.s]; }
  return [a];
}`,
      [
        [null, 1],
        [{ s: 2 }, 3],
        [{ s: -1 }, 4],
      ],
    );
  });
});

describe("a switch in a closure, inside a switch (#1368)", () => {
  it("the closure's rewrite does not replace its parent's", () => {
    agrees(
      `export function f(kind: number, xs: number[]) {
  switch (kind) {
    case 1: {
      let state = 0;
      xs.forEach((n) => { switch (n) { case 2: state = 2; return; case 3: state = 3; return; } });
      return state;
    }
  }
  return -1;
}`,
      [
        [1, [2, 3, 4]],
        [1, [3, 2]],
        [1, []],
        [2, [2]],
      ],
    );
  });
});

describe("a switch in a loop that continues and returns (#1368)", () => {
  it("an arm that ends in a continue does not fall into the next", () => {
    agrees(
      `export function f(xs: number[]) {
  const out: number[] = [];
  let last = -1;
  for (let i = 0; i < xs.length; i++) {
    const next = xs[i];
    switch (Math.sign(next - last)) {
      case 0:
        continue;
      case -1:
        return ["unsorted", i];
    }
    out.push(last = next);
  }
  return out;
}`,
      [[[1, 2, 2, 3]], [[1, 3, 2]], [[]], [[5, 5, 5]]],
    );
  });

  it("a clause that returns on one side falls into the next on the other", () => {
    agrees(
      `export function f(node: any, stop: boolean) {
  while (true) {
    switch (node.kind) {
      case 1:
        node = node.left;
        continue;
      case 2:
        if (stop) {
          return ["stopped", node.kind];
        }
      case 3:
      case 4:
        node = node.expression;
        continue;
    }
    return node;
  }
}`,
      [
        [{ kind: 1, left: { kind: 3, expression: { kind: 9 } } }, false],
        [{ kind: 2, expression: { kind: 4, expression: 7 } }, false],
        [{ kind: 2, expression: 1 }, true],
        [{ kind: 0 }, true],
      ],
    );
  });
});

describe("a labelled jump to an outer loop, from a switch (#1368)", () => {
  it("leaves the switch, then the inner loop", () => {
    agrees(
      `export function f(as: number[], bs: number[]) {
  const result: number[] = [];
  loopB:
    for (let offsetA = 0, offsetB = 0; offsetB < bs.length; offsetB++) {
      loopA:
        for (const startA = offsetA; offsetA < as.length; offsetA++) {
          switch (Math.sign(bs[offsetB] - as[offsetA])) {
            case -1:
              result.push(bs[offsetB]);
              continue loopB;
            case 0:
              continue loopB;
            case 1:
              continue loopA;
          }
        }
    }
  return result;
}`,
      [
        [
          [1, 3, 5],
          [0, 1, 2, 3, 6],
        ],
        [[], [1]],
        [[2], []],
        [
          [1, 2, 3],
          [1, 2, 3],
        ],
      ],
    );
  });

  it("a labelled break of the loop the switch is in", () => {
    agrees(
      `export function f(text: string, trailing: boolean) {
  let pos = 0;
  let lines = 0;
  scan:
    while (pos < text.length) {
      const ch = text.charCodeAt(pos);
      switch (ch) {
        case 10:
          pos++;
          lines++;
          if (trailing) {
            break scan;
          }
          continue;
        case 32:
          pos++;
          continue;
        default:
          break scan;
      }
    }
  return [pos, lines];
}`,
      [
        ["  \n \nx", false],
        ["  \n \nx", true],
        ["", false],
        ["x", true],
      ],
    );
  });

  it("a return from a switch in an inner loop", () => {
    agrees(
      `export function f(rows: number[][]) {
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      switch (row[i]) {
        case 7:
          return ["seven", i];
        case 0:
          break;
      }
    }
  }
  return "none";
}`,
      [
        [
          [
            [1, 2],
            [0, 7],
          ],
        ],
        [[[1]]],
        [[]],
      ],
    );
  });
});

describe("a debugger statement (#1368)", () => {
  it("does nothing where no debugger is attached", () => {
    const code = `export function f(x: number) {
  if (x < 0) {
    debugger;
  }
  return x + 1;
}`;
    agrees(code, [[1], [-1]]);
    expect(liftFidelity(code, liftAtom(code)).holds).toBe(true);
  });
});

describe("a return from a loop in a clause that falls through (#1368)", () => {
  it("leaves the loop, then the pass", () => {
    agrees(
      `export function f(text: string, ch: number) {
  let pos = 0;
  switch (ch) {
    case 48:
      if (text.length === 0) {
        return "empty";
      }
    case 49:
      pos++;
    case 117:
      for (; pos < text.length; pos++) {
        if (text[pos] === "!") {
          return text.substring(0, pos);
        }
      }
      return "end " + pos;
    default:
      return String.fromCharCode(ch);
  }
}`,
      [
        ["", 48],
        ["ab!c", 48],
        ["ab!c", 49],
        ["abc", 117],
        ["x", 65],
      ],
    );
  });
});

describe("two blocks, each a function hoisted over its own const of the same name (#1331)", () => {
  it("each function reads its own block's const", () => {
    agrees(
      `export function f(a: number[], b: number[]) {
  const out: unknown[] = [];
  for (let i = 0; i < a.length; i++) {
    const op = a[i] * 2;
    function fn() { return op + 1; }
    out.push(fn());
  }
  for (let i = 0; i < b.length; i++) {
    const op = b[i] * 3;
    function fn() { return [op]; }
    out.push(fn());
  }
  return out;
}`,
      [
        [[1, 2], [3]],
        [[], [1, 2]],
      ],
    );
  });
});

describe("a switch on property reads whose clause declares a name another clause reads as a property (#1368)", () => {
  it("the property's name is not the binding", () => {
    agrees(
      `export function f(codes: any, code: number, decl: any) {
  switch (code) {
    case codes.a.code:
      if (!decl.type) return 0;
      return [decl.type];
    case codes.b.code:
      const type = decl.other;
      if (!type) return -1;
      return [type, "b"];
  }
  return undefined;
}`,
      [
        [{ a: { code: 1 }, b: { code: 2 } }, 1, { type: 5 }],
        [{ a: { code: 1 }, b: { code: 2 } }, 1, {}],
        [{ a: { code: 1 }, b: { code: 2 } }, 2, { other: 7 }],
        [{ a: { code: 1 }, b: { code: 2 } }, 2, {}],
        [{ a: { code: 1 }, b: { code: 2 } }, 3, {}],
      ],
    );
  });
});

describe("a switch lowered to a pass, inside an if, returning from an inner switch (#1368)", () => {
  it("the if takes the rest of the function", () => {
    agrees(
      `export function f(node: any) {
  if (node) {
    switch (node.kind) {
      case 1:
        if (node.skip) {
          return "skipped";
        }
      default:
        switch (node.parent) {
          case 2:
            if (node.name) {
              return ["named", node.name];
            }
            break;
          case 3: {
            const { init } = node;
            if (init) {
              return ["init", init];
            }
            break;
          }
          default:
            if (node.parent > 5) {
              return "big";
            }
        }
    }
  }
}`,
      [
        [null],
        [{ kind: 1, skip: true }],
        [{ kind: 1, parent: 2, name: "n" }],
        [{ kind: 0, parent: 3, init: 4 }],
        [{ kind: 0, parent: 3 }],
        [{ kind: 0, parent: 9 }],
        [{ kind: 0, parent: 4 }],
      ],
    );
  });
});

describe("a class's static block assigning a name outside the class (#1368)", () => {
  it("the name is a cell the block writes, as a closure's would be", () => {
    agrees(
      `export function f(n: number) {
  let decorators: number[] = [];
  const C = class A {
    static {
      decorators = [n, n + 1];
    }
    static get d() {
      return decorators;
    }
  };
  return [decorators, C.d];
}`,
      [[1], [5]],
    );
  });
});

describe("a loop whose body is one jump, unbraced (#1368)", () => {
  it("for...of, for and while", () => {
    agrees(
      `export function f(xs: number[], n: number) {
  for (const x of xs)
    if (x > n) return ["of", x];
  for (let i = 0; i < n; i++)
    return ["for", i];
  while (n < 0)
    return ["while", n];
  return "none";
}`,
      [
        [[1, 5], 2],
        [[1], 3],
        [[], 0],
        [[], -1],
      ],
    );
  });
});

describe("the round trip on yakcc's own sources (#1292)", () => {
  it("a comparison's operands are read in their order, not in canonical order", () => {
    agrees(
      `export function f(node: any, boundary: any) {
  let found;
  for (let p = node.parent; p !== undefined && p.id !== boundary.id; p = p.parent)
    if (p.isTry) found = p;
  return found?.id;
}`,
      [
        [{ parent: { id: 1, isTry: true, parent: { id: 2, parent: { id: 3 } } } }, { id: 3 }],
        [{ parent: { id: 1 } }, { id: 1 }],
      ],
    );
  });

  it("a read after an iterating loop whose body makes no heap operation comes after the loop", () => {
    agrees(
      `export function f(values: number[]) {
  if (values.length === 0) return Number.NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}`,
      [[[1, 2, 3]], [[]]],
    );
  });

  it("a throw in a for loop's body, with the loop's update after it", () => {
    agrees(
      `export function f(body: string, inClass: boolean) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (inClass) {
      i += 1;
    } else if (body[i] === "(" && body.startsWith("(?<=", i)) throw new RangeError("lookbehind");
    out += body[i] ?? "";
  }
  return out;
}`,
      [
        ["ab(c", false],
        ["(?<=x)", false],
        ["abcdef", true],
      ],
    );
  });

  it("a closure reads its own block's const, not a later one of the same name outside", () => {
    agrees(
      `export function f(t: string, a: number[], s: string) {
  if (t === "nums") {
    const r: number[] = [];
    a.forEach((e) => r.push(e * 2));
    return r;
  }
  const r = s.length;
  return r;
}`,
      [
        ["nums", [1, 2], ""],
        ["str", [], "abc"],
      ],
    );
  });

  it("two equal outer values a loop reads, told apart by how its body uses them", () => {
    agrees(
      `export function f(fns: any[]) {
  const ok: unknown[] = [];
  const failed: unknown[] = [];
  for (const fn of fns) {
    try {
      ok.push(fn());
    } catch (err) {
      failed.push(String(err));
    }
  }
  return { ok, failed };
}`,
      [[[]]],
    );
  });

  it("a binding outside the atom keeps being the binding after one of its members is written", () => {
    const code = `export function f(idx: number) {
  if (idx < 0) {
    stack.length = 0;
  } else {
    domain.emit("error", idx);
  }
  stack = orig;
}`;
    const g = liftAtom(code);
    expect(graphIdentity(liftAtom(emitTypeScript(g)))).toBe(graphIdentity(g));
    expect(liftFidelity(code, g).holds).toBe(true);
  });

  it("a named class expression's name inside it is the class, not a name read outside", () => {
    const code = `export const make = (exports2: unknown) => {
  const FileLike = class _FileLike {
    get size() {
      return check(this, _FileLike);
    }
  };
  return FileLike;
};`;
    const g = liftAtom(code);
    expect(graphIdentity(liftAtom(emitTypeScript(g)))).toBe(graphIdentity(g));
    expect(liftFidelity(code, g).holds).toBe(true);
  });

  it("an arrow reading `this` through a name and through `super` captures the receiver once", () => {
    agrees(
      `export function f(n: number) {
  class P { start() { return "started"; } }
  class C extends P {
    effective = n;
    onRemove = () => {
      const self = this;
      if (self.effective > 0) return [super.start(), self.effective];
      return null;
    };
  }
  return new C().onRemove();
}`,
      [[1], [0]],
    );
  });

  it("a getter's return inside a branch is the getter's, not an exit of the branch", () => {
    agrees(
      `export function f(e: number | null) {
  let extra: object = {};
  if (e != null) {
    extra = {
      get x() {
        return [e, "got"];
      },
    };
  }
  const out = { y: 1, ...extra };
  return Object.keys(out);
}`,
      [[1], [null]],
    );
  });

  it("a closure reading a platform name through a local is its own source of the name", () => {
    agrees(
      `export function f(v: number) {
  const object = Math;
  const read = () => object.abs(v);
  return read();
}`,
      [[-3], [2]],
    );
  });

  it("an iterating loop that throws and returns, emitted with its written condition, lifts back", () => {
    agrees(
      `export function f(xs: number[], n: number, stop: boolean) {
  for (const v of xs) {
    if (stop) {
      throw new RangeError("stopped");
    }
    if (n <= v) {
      return ["at", v];
    }
  }
  return "none";
}`,
      [
        [[1, 5, 9], 4, false],
        [[1], 0, true],
        [[], 0, false],
      ],
    );
  });

  it("a constructor's parameter properties are parameters assigned to the receiver", () => {
    agrees(
      `export function f(message: string, code: number) {
  class Failure extends Error {
    constructor(
      message: string,
      public readonly code: number,
      private readonly hint = "none",
    ) {
      super(message);
      this.name = "Failure";
    }
    get detail() {
      return [this.name, this.message, this.code, this.hint];
    }
  }
  class Plain {
    constructor(public x: number) {}
  }
  return [new Failure(message, code).detail, new Plain(code).x];
}`,
      [
        ["bad", 2],
        ["", 0],
      ],
    );
  });

  it("a dynamic import is the operation that loads the module", () => {
    const code = `export async function f(spec: unknown) {
  const { contractId } = await import("./contract-id.js");
  return { status: "accepted", id: contractId(spec) };
}`;
    const g = liftAtom(code);
    expect(opaque(g)).toEqual([]);
    expect(g.nodes.some((n) => n.label === "import()")).toBe(true);
    expect(graphIdentity(liftAtom(emitTypeScript(g)))).toBe(graphIdentity(g));
    expect(liftFidelity(code, g).holds).toBe(true);
  });

  it("a class that implements an interface is not a derived class: its constructor makes its receiver", () => {
    agrees(
      `interface Sink { send(e: number): void }
export function f(xs: number[]) {
  class Composite implements Sink {
    private readonly seen: number[];
    constructor(seen: number[]) {
      this.seen = seen;
    }
    send(e: number): void {
      for (const x of xs) {
        try {
          if (x === e) throw new RangeError("same");
          this.seen.push(x + e);
        } catch {
          this.seen.push(-1);
        }
      }
    }
  }
  const c = new Composite([]);
  c.send(2);
  return xs.length;
}`,
      [[[1, 2, 3]], [[]]],
    );
  });

  it("a throw inside a switch a pass's clause holds ends its path", () => {
    agrees(
      `export function f(kind: string, sub: string, x: number) {
  switch (kind) {
    case "name":
      return ["name", x];
    case "lit": {
      switch (sub) {
        case "int":
          return ["int", x];
        default: {
          throw new RangeError("lit " + sub);
        }
      }
    }
    case "neg":
      if (x > 0) {
        throw new RangeError("neg " + x);
      }
      return ["neg", -x];
  }
  return null;
}`,
      [
        ["name", "", 1],
        ["lit", "int", 2],
        ["lit", "x", 2],
        ["neg", "", 3],
        ["neg", "", -3],
        ["other", "", 0],
      ],
    );
  });

  it("a for header's let a closure in the body rebinds is the pass's own, copied on to the next", () => {
    agrees(
      `export function f(xs: number[]) {
  const later: (() => number)[] = [];
  let seen = 0;
  for (let changed = true, i = 0; changed && i < 10; i++) {
    changed = false;
    if (i % 3 === 2) continue;
    xs.forEach((x) => { if (x > i) { changed = true; seen += x; } });
    later.push(() => { i += 100; return i; });
  }
  const outs = later.map((g) => g());
  return [seen, outs, later.map((g) => g())];
}`,
      [[[1, 2, 3]], [[]], [[5, 0, 7]]],
    );
  });

  it("a clause whose try returns from its catch falls into the next: the pass's flag is a cell", () => {
    agrees(
      `export function f(kind: string, x: any) {
  const log: string[] = [];
  switch (kind) {
    case "char":
      try {
        log.push(String(x.code.length));
      } catch {
        return ["caught", log];
      }
    case "str":
      log.push("str");
    default:
      log.push("end");
  }
  return ["done", log];
}`,
      [
        ["char", { code: "ab" }],
        ["char", {}],
        ["str", null],
        ["other", null],
      ],
    );
  });

  it("an arrow's capture of its function's arguments stays a capture: the arrow has none of its own", () => {
    const g = liftAtom(
      "export function f(a: any) { function g(x: any) { const inner = () => arguments.length; return inner(); } return g(a, a); }",
    );
    const fn = g.nodes.find((n) => n.closure !== undefined)?.closure;
    const arrow = fn?.nodes.find((n) => n.closure !== undefined);
    expect(arrow?.inputs.length).toBe(1);
    expect(arrow?.closure?.nodes.some((n) => n.kind === "diamond-source")).toBe(false);
  });

  it("a member write's object and key are read before the value written, once (#1292)", () => {
    agrees(
      `export function f(b: number, n: number) {
  const o: any = { a: 1, b };
  let k = "a";
  const g = () => { k = "b"; return n; };
  const log: string[] = [];
  const at = (key: string) => { log.push(key); return key; };
  o[k] = g();
  k = "a";
  o[k] += g();
  k = "a";
  const h = () => { k = "b"; return o; };
  h()[k]++;
  let i = 0;
  const xs = [1, 2, 3];
  xs[i++] += 10;
  xs[i++]++;
  o[at("c")] = at("v");
  return [o, k, xs, i, log];
}`,
      [
        [2, 5],
        [0, 1],
      ],
    );
  });

  it("an if whose only exits are throws takes no tail: the rest is lifted once, however long", () => {
    const program = (rest: number) =>
      `export function f(c: boolean, x: number) {
  const log: number[] = [];
  if (c) {
    if (x > 2) {
      throw new RangeError("big " + x);
    }
    log.push(x);
  }
${Array.from({ length: rest }, (_, i) => `  log.push(x + ${i});`).join("\n")}
  return log;
}`;
    for (const rest of [1, 200]) {
      const code = program(rest);
      const g = liftAtom(code);
      expect(g.nodes.filter((n) => n.origin?.kind === "ReturnSelect").length, code).toBe(0);
      expect(g.nodes.filter((n) => n.label === ".push").length, code).toBe(rest + 1);
      agrees(code, [
        [true, 1],
        [true, 3],
        [false, 5],
      ]);
    }
  }, 60_000);

  it("a class named as a platform global is itself in a closure inside it, as Node's URL is", () => {
    agrees(
      `export function f(p: string) {
  class URL {
    path: string;
    constructor(path: string) {
      if (path === "bad") throw new TypeError("bad");
      this.path = path;
    }
    get origin() {
      try {
        const out = new URL(this.path + "/o");
        return out instanceof URL ? out.path : "platform";
      } catch {
        return null;
      }
    }
  }
  return [new URL(p).origin, new URL(p + "x").origin];
}`,
      [["a"], ["b"]],
    );
  });

  it("a closure's captures that the outer graph cannot tell apart are ordered by their use inside a loop (#1292)", () => {
    agrees(
      `export function f(k: any, n: number) {
  function go(c: any, n: number): number {
    let out = 0;
    while (n-- > 0) {
      const r = c[kA][c[kB]];
      if (c[kC].p === "s" && c[kD] !== r.s) {
        c[kE]?.d(new IE("x" + c[kF]), () => {
          c[kE] = null;
          again(c, 0);
        });
      }
      out += r.v;
    }
    return out;
  }
  function again(c: any, n: number): number {
    return go(c, n);
  }
  var { kA, kB, kC, kD, kE, kF } = k;
  var IE = Error;
  const log: string[] = [];
  const c: any = {
    a: [{ s: "t", v: 2 }, { s: "s", v: 3 }],
    b: 1,
    c: { p: "s" },
    d: "u",
    e: { d: (err: Error, cb: () => void) => { log.push(err.message); cb(); } },
    f: 7,
  };
  return [go(c, n), c.e, log];
}`,
      [
        [{ kA: "a", kB: "b", kC: "c", kD: "d", kE: "e", kF: "f" }, 2],
        [{ kA: "a", kB: "b", kC: "c", kD: "d", kE: "e", kF: "f" }, 0],
      ],
    );
  });

  it("a for loop with a continue runs its update before each continue and at its body's end (#1292)", () => {
    agrees(
      `export function f(xs: string[], skip: string) {
  let out = "";
  for (let i = 0, j = 0; i < xs.length; i++, j += 2) {
    const c = xs[i] as string;
    if (c === skip) continue;
    if (c === "(") {
      out += "<" + j;
      i += 1;
    } else if (c === "!") throw new RangeError("bang at " + i);
    else out += c;
  }
  return out;
}`,
      [
        [["a", "(", "b", "c", "x", "d"], "x"],
        [["a", "!", "b"], "q"],
        [[], ""],
      ],
    );
  });

  it("a switch pass whose clauses throw and fall through round-trips: carries by declaration (#1292)", () => {
    agrees(
      `export function f(e: any, file = "stdin.go") {
  switch (e.type) {
    case "BasicLit": {
    }
    case "ChanRecv":
      throw new RangeError("chan " + file + ":" + e.line);
    case "SliceLit": {
      return "[" + e.elems + "]";
    }
    case "Unsupported":
      throw new TypeError(e.reason + " at " + e.col);
  }
  return null;
}`,
      [
        [{ type: "BasicLit", line: 3 }],
        [{ type: "ChanRecv", line: 4 }, "a.go"],
        [{ type: "SliceLit", elems: "1,2" }],
        [{ type: "Unsupported", reason: "x", col: 9 }],
        [{ type: "Other" }],
      ],
    );
  });
});
