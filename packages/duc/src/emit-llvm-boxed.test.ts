// SPDX-License-Identifier: Apache-2.0
// The native lowering beyond the typed subset (#1292, DEC-DUC-NATIVE-RUNTIME-001): NaN-boxed values
// and the runtime. Each program is lifted, lowered to LLVM IR, compiled by llc, linked with the
// runtime (compiled by clang) into a C harness, and run on generated inputs of every value kind
// the slice covers; its results must be the source's, as Node computes them, exactly. One program
// also runs on AArch64, ARMv7 and RISC-V under QEMU.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { canRun, harness, same } from "./__fixtures__/native-harness.js";
import { emitLlvmBoxed } from "./emit-llvm-boxed.js";
import { LlvmEmitError } from "./emit-llvm.js";
import { liftAtom } from "./lift.js";

const work = mkdtempSync(join(tmpdir(), "yakcc-boxed-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Every value kind the slice covers, with the awkward ones each coercion has. */
const scalar = fc.oneof(
  fc.double(),
  fc.integer({ min: -1000, max: 1000 }),
  fc.constantFrom(
    0,
    -0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1e21,
    1e21,
    0.1,
    1e-7,
    123e-20,
    2 ** 53,
  ),
  fc.string({ maxLength: 6 }),
  fc.string({ unit: "binary", maxLength: 4 }),
  fc.constantFrom(
    "",
    " ",
    " 12 ",
    "0x1F",
    "0b101",
    "0o17",
    "1e3",
    "-0",
    "Infinity",
    "-Infinity",
    "12px",
    ".5",
    "5.",
    "+.5e-3",
    " 12 ",
    "a",
    "abc",
    "ab,c",
  ),
  fc.boolean(),
  fc.constantFrom(null, undefined),
);
const value = fc.oneof(
  { weight: 4, arbitrary: scalar },
  { weight: 1, arbitrary: fc.array(scalar, { maxLength: 4 }) },
);

/** The source as Node runs it. */
function reference(source: string): (...a: unknown[]) => unknown {
  return new Function(`${source.replace(/^export /, "")}; return f;`)() as (
    ...a: unknown[]
  ) => unknown;
}

/** Runs the program natively and in Node on the same inputs; returns the disagreements. */
function disagreements(
  source: string,
  inputs: readonly unknown[][],
  target = "x86_64-linux",
): string[] {
  const run = harness(emitLlvmBoxed(liftAtom(source)), work, target);
  // The reference may throw (a method on a value without it): those inputs are not compared here.
  const ref = reference(source);
  const kept: { args: unknown[]; want: unknown }[] = [];
  for (const args of inputs) {
    try {
      kept.push({ args: structuredClone(args), want: ref(...structuredClone(args)) });
    } catch {}
  }
  const { results, stderr } = run(kept.map((k) => k.args));
  if (results.length !== kept.length) return [`ran ${results.length} of ${kept.length}: ${stderr}`];
  return kept.flatMap((k, i) =>
    same(results[i], k.want)
      ? []
      : [
          `${JSON.stringify(k.args)} → native ${JSON.stringify(results[i])}, node ${JSON.stringify(k.want)}`,
        ],
  );
}

const PROGRAMS: [string, string, number][] = [
  [
    "deep recursion throws V8's RangeError, which a catch sees, and the program goes on (#1361 P2)",
    "export function f(a, b) { const down = (n) => down(n + 1); let e1; try { down(0); } catch (e) { e1 = [e instanceof RangeError, e.name, e.message]; } let depth = 0; const count = () => { depth++; count(); }; try { count(); } catch (e) { } return [e1, depth > 1000, String(a) + String(b)]; }",
    2,
  ],
  [
    "large Maps and Sets (their hash index): mixed keys, -0 and NaN, deletes and re-adds, order, clear (#1370)",
    "export function f(a, b) { const m = new Map(); const objs = []; for (let i = 0; i < 300; i++) { const o = { i }; objs.push(o); m.set(i % 3 === 0 ? i : i % 3 === 1 ? 'k' + i : o, i); } m.set(-0, 'zero'); m.set(NaN, 'nan'); m.set(10n, 'big'); m.set(a, 'a'); m.set(b, 'b'); const got = [m.get(0), m.get(+0), m.get(NaN), m.get(0 / 0), m.get(10n), m.get('k4'), m.get(objs[2]), m.get({ i: 2 }), m.get(a), m.get(b), m.size]; for (let i = 0; i < 300; i += 7) m.delete(i % 3 === 0 ? i : i % 3 === 1 ? 'k' + i : objs[i]); const after = [m.size, m.has(7), m.has('k7'), m.has(objs[14]), m.get(3), [...m.keys()].slice(0, 12).map(String)]; m.set(7, 'back'); m.set('k7', 'back'); const order = [...m.entries()].slice(-4).map(([k, v]) => String(k) + '=' + v); const s = new Set(); for (let i = 0; i < 200; i++) s.add(i % 50 === 0 ? 'x' + i : i * 2); for (let i = 0; i < 400; i += 3) s.delete(i); s.add(-0); const sres = [s.size, s.has(0), s.has(4), s.has(6), s.has('x50'), [...s].slice(0, 10).map(String), [...s.union(new Set([1, 2, 3, 4]))].length]; m.clear(); m.set('again', 1); return [got, after, order, sres, m.size, m.get('again'), m.get('k4')]; }",
    2,
  ],
  [
    "named writes and reads with their site caches: setters along the chain, own accessors, shadowing, objects of other shapes at one site (#1370)",
    "export function f(a, b) { const log = []; const proto = { set x(v) { log.push('set ' + v); }, get y() { return 'proto y'; } }; const objs = [Object.create(proto), { x: 1, y: 2 }, { y: 3, x: 4, z: 5 }, Object.create(proto), { get x() { return 'getter'; }, set x(v) { log.push('own ' + v); } }]; const out = []; for (let i = 0; i < objs.length; i++) { const o = objs[i]; o.x = String(a) + i; out.push([o.x, o.y, o.z, Object.keys(o)]); } const shapes = [{ k: 1 }, { j: 0, k: 2 }, { k: 3 }, { i: 0, j: 0, k: 4 }]; let s = 0; for (const o of shapes) { s += o.k; o.k = o.k * 10; } return [out, log, s, shapes.map((o) => o.k), b]; }",
    2,
  ],
  [
    "strings built a piece at a time (ropes, #1370): every read of the result, and of its parts",
    "export function f(a, b) { let out = ''; const parts = []; for (let i = 0; i < 3000; i++) { out += String(i % 7 === 0 ? a : b) + ','; if (i % 1000 === 999) parts.push(out); } let mid = 'x'.repeat(300); mid = mid + 'é' + mid; const o = {}; o[out] = 1; const keyed = o[parts[2]]; let sum = 0; for (let i = 0; i < out.length; i += 97) sum += out.charCodeAt(i); return [out.length, parts.map((p) => p.length), out.slice(0, 40), out.slice(-20), out[5], out[out.length - 1], out.charCodeAt(1), sum, out === parts[2], parts[0] === parts[1].slice(0, parts[0].length), out.indexOf(String(b) + ',' + String(b)), out.startsWith(String(a)), keyed, JSON.stringify(mid).length, mid.length, mid[300], (mid + mid).split('é').length, [...(mid + 'z')].length, `${mid}${out}`.length]; }",
    2,
  ],
  [
    "Set's union, intersection, difference, symmetricDifference and the three tests, on sets and set-likes (#1370)",
    "export function f(a, b) { const t = (g) => { try { return g(); } catch (e) { return e.name + ': ' + e.message; } }; const s = new Set([1, 2, 3, a, -0]); const o = new Set([3, 4, b, 2, 0]); const big = new Set([1, 2, 3, 4, 5, 6, 7, 8, a, b]); const like = { size: 2, has: (x) => x === 2 || x === 9, keys: () => [9, 2][Symbol.iterator]() }; const all = (x) => [[...s.union(x)], [...s.intersection(x)], [...s.difference(x)], [...s.symmetricDifference(x)], s.isSubsetOf(x), s.isSupersetOf(x), s.isDisjointFrom(x)]; return [all(o), all(big), all(like), all(new Set()), new Set([2]).isSubsetOf(like), t(() => s.union(5)), t(() => s.union({ size: NaN, has() {}, keys() {} })), t(() => s.union({ size: -1, has() {}, keys() {} })), t(() => s.intersection({ size: 1, has: 1, keys() {} })), t(() => s.union({ size: 1, has() {}, keys() { return 5; } }))]; }",
    2,
  ],
  [
    "toFixed, toPrecision and toExponential: exact digits, ties to the larger, their ranges (#1370)",
    "export function f(a, b) { const t = (g) => { try { return g(); } catch (e) { return e.name + ': ' + e.message; } }; const xs = [typeof a === 'number' ? a : 1.5, typeof b === 'number' ? b : -2.5, 0, -0, 0.5, 1.5, 2.5, 1.005, 0.005, 0.0005, 123.456, -0.004, 1e21, 1.23e-7, 5e-324, 1.7976931348623157e308, 999.995, 0.1, NaN, -Infinity, 12345678901234567890]; return [xs.map((x) => [x.toFixed(), x.toFixed(2), x.toFixed(0), x.toFixed(20), x.toPrecision(), x.toPrecision(1), x.toPrecision(3), x.toPrecision(21), x.toExponential(), x.toExponential(0), x.toExponential(4)]), t(() => (1).toFixed(101)), t(() => (1).toPrecision(0)), t(() => (1).toExponential(-1)), (1.45).toFixed(1), (8.345).toFixed(2), (25).toPrecision(1), (0.000001).toPrecision(2), (0.0000001).toPrecision(2)]; }",
    2,
  ],
  [
    "substring, charAt, trimLeft/trimRight, isWellFormed/toWellFormed and Annex B's HTML methods (#1370)",
    "export function f(a, b) { const s = String(a) + ' abc\\ud800def ' + String(b); const t = (g) => { try { return g(); } catch (e) { return e.name; } }; return [s.substring(2), s.substring(5, 2), s.substring(-3, 4), s.substring(NaN, 3), s.substring(3, Infinity), s.charAt(0), s.charAt(-1), s.charAt(99), s.charAt(2.7), s.trimLeft(), s.trimRight(), s.isWellFormed(), 'ok'.isWellFormed(), s.toWellFormed(), '\\udc00x\\ud83d\\ude00'.toWellFormed(), 'x'.anchor('a\"b'), 'x'.bold(), 'x'.link(a), 'x'.fontsize(b), 'x'.sub(), t(() => s.substring.call(null))]; }",
    2,
  ],
  [
    "substr (Annex B): start relative, length clamped (#1370)",
    "export function f(a, b) { const s = String(a) + 'abcdef' + String(b); return [s.substr(2), s.substr(-3), s.substr(1, 3), s.substr(-4, 2), s.substr(2, -1), s.substr(0, Infinity), s.substr(NaN, 2), s.substr(100), s.substr(-100, 3), s.substr(typeof a === 'number' ? a : 1, typeof b === 'number' ? b : 2)]; }",
    2,
  ],
  [
    "templates with no substitutions: their cooked strings, escapes and line continuations (#1370)",
    "export function f(a, b) { return [`\\${configDir}`, `a\\nb\\t\\x41\\u0042\\u{1F600}\\0\\\\\\``, `line\\\nnext`, `\\'\\\"`, `${a}` + `-` + String(b)]; }",
    2,
  ],
  // + with ToPrimitive, string concatenation and Number::toString's shortest digits.
  ["+ on every pair of kinds", "export function f(a, b) { return a + b; }", 2],
  [
    "Date on fixed time values, the weak collections, WeakRef, the other error kinds, RegExp's copy (#1331)",
    "export function f(a, b) { const t = (g) => { try { return g(); } catch (e) { return e.name; } }; const ms = typeof a === 'number' && Number.isFinite(a) ? Math.trunc(a * 1e9) % 8.64e15 : 1700000000123; const d = new Date(ms); const parsed = ['2024-02-29T13:45:30.123Z', '2024-02-29', '+012345-01-01T00:00:00Z', '2024-13-01', 'nope'].map((x) => Date.parse(x)); const s = new Date(Date.UTC(2020, 1, 29, 23, 59, 58, 7)); s.setUTCMonth(11, 31); const k = {}; const wm = new WeakMap([[k, 1]]); const ws = new WeakSet([k]); const r = new WeakRef(k); const ag = new AggregateError([new TypeError('x'), 2], 'many'); const re = new RegExp(/a(b)/g); return [d.getTime(), t(() => d.toISOString()), d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCDay(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(), parsed, s.toISOString(), s.getTime(), new Date(NaN).getTime(), t(() => new Date(NaN).toISOString()), String(new Date(NaN)), Date.UTC(99, 0), wm.get(k), wm.has({}), ws.has(k), r.deref() === k, ag.name, ag.message, ag.errors.length, new EvalError('e').name, new ReferenceError('r').message, new URIError().name, re.source, re.flags, re.exec('xab')[1], typeof Date.now(), JSON.stringify(new Date(0).toJSON())]; }",
    2,
  ],
  [
    "toUpperCase and toLowerCase: full Unicode mappings and final sigma, as Node (#1331)",
    "export function f(a, b) { const xs = [String(a), String(b), 'straße ŉ ﬀ İ ǅ', 'ΟΔΥΣΣΕΥΣ Σ ΑΣ. ΑΣ\\u0301 ΑΣΑ', 'Привет Ǆ ǈ', '\\ud801\\udc00\\ud801\\udc28 ᾳ ﬆ ΐ', 'Σ', 'aΣ', 'aΣb']; return xs.map((x) => [x.toUpperCase(), x.toLowerCase(), x.toLocaleUpperCase(), x.toLocaleLowerCase()]); }",
    2,
  ],
  [
    "URI handling, escape/unescape, and built-in functions' names (#1331)",
    "export function f(a, b) { const t = (g) => { try { return g(); } catch (e) { return e.name; } }; const x = String(a) + ' é/?#[]&=' + String(b) + '\\ud83d\\ude00'; const e1 = encodeURIComponent(x), e2 = encodeURI(x); return [e1, e2, decodeURIComponent(e1) === x, decodeURI(e2) === x, decodeURI('%3B%2F%41%e2%82%ac'), t(() => decodeURIComponent('%')), t(() => decodeURIComponent('%E0%A4%A')), t(() => decodeURIComponent('%C0%80')), t(() => encodeURIComponent('\\ud800')), escape(x), unescape(escape(x)) === x, unescape('%u0041%41%zz'), decodeURI.name, [].join.name, Array.name, Object.keys.name, String.prototype.slice.name]; }",
    2,
  ],
  [
    "the intrinsics: uncurryThis as primordials makes it, descriptors, ownKeys, prototypes, apply and bind (#1331)",
    "export function f(a, b) { const { apply, bind, call } = Function.prototype; const uncurryThis = bind.bind(call); const join = uncurryThis(Array.prototype.join); const slice = uncurryThis(String.prototype.slice); const hasOwn = uncurryThis(Object.prototype.hasOwnProperty); const sym = Symbol('s'); const o = { x: 1, [sym]: 2 }; Object.defineProperty(o, 'g', { get() { return this.x + 10; }, enumerable: true, configurable: true }); const d = Object.getOwnPropertyDescriptor(o, 'x'); const gd = Object.getOwnPropertyDescriptor(o, 'g'); const n = Object.create(null); n.k = String(a); const max = (...xs) => xs.length; const bound = function (p, q) { return [this.tag, p, q]; }.bind({ tag: 't' }, b); return [join([1, 2, a], '-'), slice(String(a) + 'xyz', 1), hasOwn(o, 'x'), hasOwn(o, 'nope'), Reflect.ownKeys(o).length, typeof Reflect.ownKeys(o)[2], d.value, d.writable, typeof gd.get, o.g, Object.getPrototypeOf([]) === Array.prototype, Object.getPrototypeOf(Object.prototype), Object.getPrototypeOf(n), typeof n.toString, Object.keys(n), ({}).toString(), Object.prototype.toString.call([]), [].join === Array.prototype.join, typeof globalThis.Array, globalThis.globalThis === globalThis, apply.call(max, null, [1, 2, 3]), bound('q'), Reflect.apply(max, null, [a, b]), Reflect.getPrototypeOf(Map.prototype) === Object.prototype, 'x' in o, Reflect.has(o, 'toString'), Object.hasOwn(o, 'g')]; }",
    2,
  ],
  [
    "symbols: identity, description, Symbol.for, symbol keys, typeof, ToString throwing (#1331)",
    "export function f(a, b) { const t = (g) => { try { return g(); } catch (e) { return e.name; } }; const s1 = Symbol(String(a)), s2 = Symbol(String(a)), s3 = Symbol(); const o = { [s1]: 1, plain: 2 }; o[s2] = b; const copy = { ...o }; return [s1 === s2, s1.description, s3.description, s1.toString(), String(s2), typeof s1, Symbol.for('k') === Symbol.for('k'), Symbol.keyFor(Symbol.for('k')), Symbol.keyFor(s1), o[s1], o[s2], Object.keys(o), JSON.stringify(o), copy[s1], s1 in o, t(() => '' + s1), t(() => `${s1}`), typeof Symbol.iterator, Symbol.iterator.description, t(() => new Symbol())]; }",
    2,
  ],
  [
    "the iteration protocol: an object's [Symbol.iterator] in for...of, spread, Array.from; return() on break (#1331)",
    "export function f(a, b) { const log = []; const n = typeof a === 'number' && a > 0 && a < 6 ? Math.floor(a) : 3; const range = { [Symbol.iterator]() { let i = 0; return { next: () => (i < n ? { value: i++ * 2, done: false } : { value: 'end', done: true }), return: () => { log.push('closed'); return { done: true }; } }; } }; const seen = []; for (const x of range) seen.push(x); for (const x of range) { if (x >= 2) break; } class Bag { constructor() { this.items = ['x', b]; } *[Symbol.iterator]() { yield* this.items; } } return [seen, [...range], log, [...new Bag()], Array.from(range)]; }",
    2,
  ],
  [
    "super(...spread) and Math.random (#1331)",
    "export function f(a, b) { class A { constructor(...xs) { this.n = xs.length; this.s = xs.join('-'); } } class B extends A { constructor(...ys) { super(...ys, 'end'); this.k = 'b'; } } const o = new B(a, b); const rs = [Math.random(), Math.random(), Math.random()]; return [o.n, o.s, o.k, rs.every((r) => typeof r === 'number' && r >= 0 && r < 1), rs[0] !== rs[1] || rs[1] !== rs[2]]; }",
    2,
  ],
  [
    "Math's approximated functions are V8's atoms (#1362), and ** is pow's; BigInt ** is exact",
    "export function f(a, b) { const t = (g) => { try { return g(); } catch (e) { return e.name; } }; const x = typeof a === 'object' ? 0.5 : a; return [Math.sin(x), Math.cos(b), Math.tan(x), Math.exp(x), Math.log(b), Math.atan2(x, b), Math.pow(x, b), x ** b, Math.cbrt(x), Math.sinh(x), Math.expm1(b), Math.log1p(x), t(() => 3n ** 40n), t(() => (-2n) ** 63n), t(() => 2n ** -1n), t(() => 2n ** 2), 10 ** -2]; }",
    2,
  ],
  [
    "object literals: __proto__ sets the prototype and defines no key; computed method keys (#1331)",
    "export function f(a, b) { const base = { greet() { return 'hi ' + this.name; }, kind: 'base' }; const o = { __proto__: base, name: String(a) }; const n = { __proto__: null, value: b }; const k = 'm' + typeof a; const c = { [k]() { return k + '!'; }, ['x' + 1]: 2 }; return [o.greet(), o.kind, Object.keys(o), JSON.stringify(n), Object.keys(n), n.value, c[k](), Object.keys(c), 'kind' in o]; }",
    2,
  ],
  [
    "the other operators and their coercions",
    "export function f(a, b) { return [a == b, a === b, a != b, a < b, a >= b, a > b, a <= b, typeof a, !a, a - b, a * b, a / b, a % b, -a, +b, a && b, a || b]; }",
    2,
  ],
  [
    "template literals and number formatting",
    "export function f(a, b) { return `${a}|${b}|${a / 3}|${b * 1e21}|${a * 1e-7}`; }",
    2,
  ],
  [
    "strings: length, index, charCodeAt, slice, indexOf",
    "export function f(s, i) { if (typeof s !== 'string') return null; return [s.length, s[i], s.charCodeAt(i), s.slice(i), s.slice(-2, i), s.indexOf('a', i), s.indexOf(s.slice(1))]; }",
    2,
  ],
  [
    "arrays: a loop, push, index, join, indexOf, slice",
    "export function f(xs, v) { if (typeof xs !== 'object' || xs === null) return xs; const out = []; let i = 0; while (i < xs.length) { out.push(xs[i] + v); i = i + 1; } out.push(xs.length); return [out.join('|'), out.indexOf(v), out.slice(-2), out[0], out[99], xs.join()]; }",
    2,
  ],
  [
    "the exact Math on any value",
    "export function f(a, b) { return [Math.floor(a), Math.round(a), Math.sign(b), Math.min(a, b), Math.max(a, b, -0), Math.abs(a), Math.trunc(b), Math.sqrt(a)]; }",
    2,
  ],
  [
    "objects: literals, computed keys, reads and writes, own methods with this",
    "export function f(a, b) { const k = typeof a === 'string' ? a : 'z'; const o = { x: a, [k]: b, n: 0, bump() { this.n = this.n + 1; return this; } }; o.y = o.x + b; o[b] = 1; o.bump().bump(); return [o, o.n, o.missing, o[k], o.y == a + b]; }",
    2,
  ],
  [
    "closures: captures, a counter cell, recursion, functions as values",
    "export function f(a, b) { let count = 0; const add = (x) => { count = count + 1; return x + a; }; const fact = (n) => (n > 1 ? n * fact(n - 1) : 1); const pick = typeof b === 'number' ? add : fact; return [add(b), add(add(1)), count, fact(6), pick(3), typeof pick, add]; }",
    2,
  ],
  [
    "array callbacks: map, filter, reduce, some, every, find, findIndex, includes, sort",
    "export function f(xs, v) { if (typeof xs !== 'object' || xs === null) return xs; const ns = xs.map((x, i) => (typeof x === 'number' && x === x ? x : i)); return [ns.filter((x) => x > 0), ns.reduce((s, x) => s + x, v), ns.some((x) => x === v), ns.every((x) => x === x), ns.find((x) => x < 0), ns.findIndex((x) => x > 1), xs.includes(v), ns.slice().sort((p, q) => p - q), xs.map(String).sort()]; }",
    2,
  ],
  [
    "strings: split, includes, startsWith, endsWith, trim",
    "export function f(s, t) { if (typeof s !== 'string') return null; const u = typeof t === 'string' ? t : 'a'; return [s.split(u), s.split(''), s.split(), s.includes(u), s.startsWith(u), s.endsWith(u), s.trim(), s.split(u).join('+')]; }",
    2,
  ],
  [
    "valueOf and toString an object defines",
    "export function f(a, b) { const v = { valueOf() { return a; } }; const t = { toString() { return 'T' + b; } }; return [v + 1, `${t}`, t + '', v == a, v < 5, String(1) + t]; }",
    2,
  ],
  [
    "classes: constructor, methods, getters and setters, statics, class-self, instanceof",
    "export function f(a, b) { class Acc { constructor(x) { this.x = x; this.log = []; } get twice() { return this.x * 2; } set twice(v) { this.x = v / 2; } add(y) { this.x = this.x + y; this.log.push(y); return this; } static of(v) { return new Acc(v); } } const acc = Acc.of(typeof a === 'number' ? a : 1).add(1).add(2); acc.twice = 10; return [acc.x, acc.twice, acc.log, acc instanceof Acc, typeof Acc, Object.keys(acc)]; }",
    2,
  ],
  [
    "ES5 constructors and prototypes",
    "export function f(a, b) { function Pt(x, y) { this.x = x; this.y = y; } Pt.prototype.sum = function () { return this.x + this.y; }; Pt.prototype.kind = 'pt'; const p = new Pt(a, b); return [p.sum(), p.kind, p instanceof Pt, Object.keys(p), p.missing]; }",
    2,
  ],
  [
    "spread: arrays, calls, objects; accessors in literals; delete",
    "export function f(a, b) { const xs = [a, ...(typeof b === 'string' ? b : [b]), a]; const join = (...parts) => parts.join('/'); const o = { first: 1, ...(typeof b === 'object' && b !== null ? b : {}), last: a, get both() { return [this.first, this.last]; } }; delete o.first; delete o['nope']; return [xs, join(...xs), xs.length, Object.keys(o), o.both, Math.max(...xs.filter((x) => typeof x === 'number'), -1)]; }",
    2,
  ],
  [
    "derived classes: super calls, super getters, static super, super in an arrow, default constructors (#1294)",
    "export function f(a, b) { class Shape { constructor(n) { this.n = n; } area() { return 0; } describe() { return this.n + ':' + this.area(); } get label() { return 'shape ' + this.n; } static make(n) { return new this(n); } } class Sq extends Shape { constructor(s) { super('sq'); this.s = s; } area() { return this.s * this.s; } describe() { return '[' + super.describe() + ']'; } get label() { return super.label + '!'; } static make(s) { return super.make(s * 2); } } class Big extends Sq { area() { const up = () => super.area() * 10; return up(); } } class Plain extends Shape {} const q = new Sq(a); const g = new Big(b); const p = new Plain(a); return [q.describe(), q.label, g.describe(), g.label, g instanceof Sq, g instanceof Shape, q instanceof Big, Sq.make(3).s, Big.make(2).area(), Object.keys(g), p.n, p.describe(), p instanceof Shape]; }",
    2,
  ],
  [
    "regular expressions: test, replace, match, split (the matcher read as ECMAScript, #1310)",
    "export function f(a, b) { const s = typeof a === 'string' ? a : String(a); const t = typeof b === 'string' ? b : 'x, y,z'; return [/^[0-9a-f]+$/.test(s), s.replace(/\\s+/g, ' ').trim(), s.replace(/[^A-Za-z0-9_]/g, '_'), (s.match(/[a-z]+/g) || []).length, t.split(/,\\s*/), -s.length]; }",
    2,
  ],
  [
    "an Error subclass: thrown, caught, its name, message and instanceof (#1294)",
    "export function f(a, b) { class Bad extends Error { constructor(m, code) { super(m); this.name = 'Bad'; this.code = code; } } class Worse extends Bad {} try { if (typeof a === 'number' && a > 0) throw new Worse('too big: ' + a, b); throw new Bad(String(a), 1); } catch (e) { return [e.message, e.name, e.code, e instanceof Bad, e instanceof Worse, e instanceof Error, e instanceof TypeError, String(e)]; } }",
    2,
  ],
  [
    "class fields, static fields and blocks, computed names, field order in a derived class (#1330)",
    "export function f(a, b) { const k = 'm' + typeof a; class P { base = 'p'; constructor(n) { this.n = n; } } class A extends P { x = 1; y = this.x + this.n; static z = 3; static { this.z = this.z + 10; } static after = A.z * 2; [k]() { return this.y; } get ['g' + 1]() { return this.base; } static ['s' + 1] = 4; ['a-b'] = 5; 7() { return 7; } constructor(n) { super(n === undefined ? 0 : String(n).length); this.c = this.y + 1; } } class B extends A { d = this.c * 10; } const o = new A(a); const q = new B(b); return [o[k](), o.g1, A.z, A.after, A.s1, o['a-b'], o[7](), Object.keys(o), Object.keys(q), q.d]; }",
    2,
  ],
  [
    "keys are evaluated at definition, in member order; initializers when an instance is made (#1330)",
    "export function f(a) { const log = []; class G { [(log.push('a'), 'a')] = log.push('init' + typeof a); static [(log.push('b'), 'b')] = log.push('static'); } const before = [...log]; new G(); return [before, log]; }",
    1,
  ],
  [
    "super[key], read and called, and o[k](..) with o as its receiver (#1330)",
    "export function f(a, b) { const kA = 'k' + typeof a; class P { [kA](n) { return n + this.base; } get g() { return 'pk' + this.base; } } class C extends P { constructor() { super(); this.base = typeof b; } [kA](n) { return super[kA](n) + '!'; } read(k) { return [super[k], (() => super[kA](1))()]; } } const c = new C(); const o = { base: 5, m(n) { return n + this.base; } }; const m = 'm'; return [c[kA](1), c.read('g'), o[m](1), o?.[m](2)]; }",
    2,
  ],
  [
    "private names: fields, statics, methods, accessors, brand checks, per class and per evaluation (#1330)",
    "export function f(a, b) { class A { #x = a; static #n = 0; ['#x'] = 'public'; #inc() { this.#x = typeof this.#x === 'number' ? this.#x + 1 : this.#x + '+'; A.#n++; return this; } get #g() { return this.#x; } set #g(v) { this.#x = v; } bump(v) { this.#inc(); const before = this.#g; this.#g = v; return [before, this.#g, A.#n, #x in this, this['#x']]; } static has(o) { return #x in o; } read(o) { return o.#x; } } class B { #x = 'b'; } const o = new A(); let crossed; try { o.read(new B()); } catch (e) { crossed = e.name; } class Outer { #secret = b; make() { const self = this; return class { peek() { return self.#secret; } }; } } const I = new Outer().make(); const mk = () => class { #v = 1; static check(o) { return #v in o; } }; const C1 = mk(), C2 = mk(); return [o.bump(b), A.has(o), A.has({}), Object.keys(o), crossed, new I().peek(), C1.check(new C1()), C2.check(new C1())]; }",
    2,
  ],
  [
    "a spread is copied where it is in order, before what follows writes the array (#1330)",
    "export function f(a, b) { const log = [a]; const before = [...log]; log.push(b); const after = [...log]; log.push(3); function* g() { yield a; yield b; } return [before, after, log.length, [0, ...g()], [...'ab']]; }",
    2,
  ],
  [
    "a try that yields, in a generator: next, throw and return reach its blocks, yield* passes them on (#1330)",
    "export function f(a, b) { const log = []; function* g(n) { try { for (let i = 0; i < n; i++) { const got = yield i; log.push('got ' + got); if (i === 2) throw new Error('two'); } } catch (e) { log.push('caught ' + e.message); yield -1; } finally { log.push('finally'); } return 'end'; } const k = typeof a === 'number' && a >= 0 && a < 6 ? Math.floor(a) : 4; const it = g(k); const out = []; let r = it.next(); while (!r.done) { out.push(r.value); r = it.next(b); } function* h() { try { yield 1; return 'early'; } catch (e) { yield 'c:' + e; } } const t = h(); const thrown = [t.next(), t.throw(b), t.next()]; function* inner() { try { yield 1; yield 2; } finally { log.push('inner done'); } } function* outer() { try { yield* inner(); } finally { log.push('outer done'); } } const o = outer(); o.next(); const ret = o.return(b); const brk = []; for (const x of outer()) { brk.push(x); break; } return [out, r.value, log, thrown, ret, brk]; }",
    2,
  ],
  [
    "array, string, Map and Set iterators: next, their prototypes and tags, partial iteration, Array.prototype's on an array-like (#1331)",
    "export function f(a, b) { const xs = [a, b, 'z']; const it = xs.values(); const first = it.next(); const rest = [...it]; const after = it.next(); const m = new Map([[a, 1], ['k', b]]); const s = new Set([a, b, a]); const mi = m.entries(); const one = mi.next().value; const ks = []; for (const k of m.keys()) ks.push(k); const si = 'a\\u{1F600}b'[Symbol.iterator](); const chars = [si.next().value, si.next().value.length, si.next().value, si.next().done]; const AIP = Object.getPrototypeOf([][Symbol.iterator]()); const IP = Object.getPrototypeOf(AIP); const like = { length: 2, 0: 'p', 1: 'q' }; const fromLike = [...Array.prototype.entries.call(like)]; let broke = []; const it2 = xs.keys(); for (const k of it2) { broke.push(k); break; } broke.push(it2.next().value); return [first.value, first.done, rest, after.done, after.value, one, ks, [...s.values()], [...s.entries()].length, [...m.values()], chars, Object.prototype.toString.call(xs.values()), Object.prototype.toString.call(m.keys()), Object.prototype.toString.call(s.values()), Object.prototype.toString.call(si), IP[Symbol.iterator].call(it) === it, typeof AIP.next, Object.getPrototypeOf(IP) === Object.prototype, fromLike, broke, Array.from(xs.entries()).length, [...Array.prototype.keys.call(Array.prototype)].length]; }",
    2,
  ],
  [
    "classes extending Map, Set, WeakMap and Promise: the instance is one, a subclass's set override is what the constructor calls (#1331)",
    "export function f(a, b) { class M extends Map { constructor(i) { super(i); this.tag = 'm'; } double(k) { return this.get(k) * 2; } set(k, v) { return super.set(k, typeof v === 'number' ? v + 1 : v); } } class S extends Set {} class W extends WeakMap {} class P extends Promise {} const m = new M([[1, 2], ['a', a]]); m.set(3, 4); m.set('b', b); const s = new S([a, b, a]); const w = new W(); const k = {}; w.set(k, 5); const p = new P((r) => r(7)); return [m.double(1), m.get(3), m.get('a'), m.get('b'), m.size, m.tag, m instanceof Map, m instanceof M, [...m.keys()], s.size, s.has(a), [...s].length, w.get(k), w.has({}), p instanceof Promise, p instanceof P, Object.prototype.toString.call(m), Object.prototype.toString.call(s), new Map() instanceof M, Object.getPrototypeOf(M.prototype) === Map.prototype]; }",
    2,
  ],
  [
    "a function's arguments: length, indexes, beyond the parameters, spread, in a nested arrow (#1330)",
    "export function f(a, b) { function g(x) { const inner = () => arguments.length; return [arguments.length, arguments[0] === x, arguments[1], arguments[2], [...arguments].length, inner(), Array.prototype.slice.call(arguments, 1)]; } return [g(a), g(a, b), g(), g(1, 2, 3, 4)]; }",
    2,
  ],
  [
    "%TypedArray% and its prototype, ArrayBuffer's and DataView's; a class extending Uint8Array (#1331)",
    "export function f(a, b) { const TA = Object.getPrototypeOf(Uint8Array); const u = new Uint8Array([1, 2, typeof a === 'number' ? a : 3]); const len = Object.getOwnPropertyDescriptor(TA.prototype, 'length').get; const tag = Object.getOwnPropertyDescriptor(TA.prototype, Symbol.toStringTag).get; class FB extends Uint8Array { hello() { return 'hi' + this.length; } toString() { return 'FB:' + this.join('-'); } } const fb = new FB(4); fb[1] = 9; const sub = TA.prototype.slice.call(fb, 1, 3); let abstract = ''; try { new TA(); } catch (e) { abstract = e.name; } return [typeof TA, TA.name, Object.getPrototypeOf(Uint8Array.prototype) === TA.prototype, len.call(u), tag.call(u), tag.call({}), Object.prototype.toString.call(u), fb.hello(), String(fb), fb instanceof Uint8Array, fb instanceof FB, sub.length, sub[0], abstract, Uint8Array.prototype.BYTES_PER_ELEMENT, Object.getPrototypeOf(new ArrayBuffer(2)) === ArrayBuffer.prototype, Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get.call(new ArrayBuffer(5)), Object.prototype.toString.call(new DataView(new ArrayBuffer(2))), [...u.values()], TA.prototype[Symbol.iterator] === TA.prototype.values, u.constructor === Uint8Array, Object.getPrototypeOf(Float64Array) === TA]; }",
    2,
  ],
  [
    "Array.prototype's methods on an array the lowering does not know: the copying ones, flat, splice, reverse and the rest (#1331)",
    'export function f(a0, b0) { const t = (g) => { try { return g(); } catch (e) { return "THREW " + e.message; } }; const a = [3, 1, 2]; return [t(() => a.toSorted()), t(() => a.toSorted((x, y) => y - x)), t(() => a.toReversed()), t(() => a.with(1, 9)), t(() => a.with(-1, 7)), t(() => a.with(5, 0)), t(() => a.toSpliced(1, 1, "x", "y")), t(() => a.toSpliced(1)), a, t(() => a.findLast((x) => x > 1)), t(() => a.findLastIndex((x) => x > 5)), t(() => a.at(-1)), t(() => a.flat()), t(() => [[1, [2]], 3].flat(Infinity)), t(() => a.flatMap((x) => [x, x])), t(() => a.reduceRight((s, x) => s + x, "")), t(() => a.lastIndexOf(1)), t(() => a.copyWithin(0, 1)), t(() => [1, 2, 3].fill(0, 1)), t(() => [1, 2].concat([3], 4)), t(() => Array.of(1, 2))]; }',
    2,
  ],
  [
    "Array.prototype's core methods through the runtime: splice, reverse, sort, the callbacks (#1331)",
    'export function f(a0, b0) { const t = (g) => { try { return g(); } catch (e) { return "THREW " + e.message; } }; const mk = () => [3, 1, 2]; return [t(() => { const a = mk(); return [a.splice(1, 1, 9, 8), a]; }), t(() => { const a = mk(); return [a.reverse(), a]; }), t(() => mk().sort()), t(() => mk().map((x) => x * 2)), t(() => mk().filter((x) => x > 1)), t(() => mk().every((x) => x > 0)), t(() => mk().some((x) => x > 2)), t(() => mk().includes(2)), t(() => mk().join("-")), t(() => mk().slice(1)), t(() => mk().indexOf(2)), t(() => mk().find((x) => x < 3)), t(() => mk().findIndex((x) => x === 2)), t(() => mk().forEach(() => 0)), t(() => mk().reduce((s, x) => s + x)), t(() => { const a = mk(); a.push(4); return a.pop(); }), t(() => { const a = mk(); return [a.shift(), a.unshift(0), a]; }), t(() => mk().toString()), t(() => mk().toLocaleString()), t(() => Array.isArray(mk())), t(() => Array.from({ length: 2 }, (_, i) => i))]; }',
    2,
  ],
  [
    "tagged templates: the strings, their raw text, the substitutions, a member's receiver, one template object per site (#1331)",
    "export function f(a, b) { const tag = (s, ...v) => [s.length, [...s], [...s.raw], v, Object.isFrozen(s) || true]; const site = () => tag`q${a}`; const o = { k: 7, m(s, x) { return [this.k, s[0], x]; } }; return [tag`x${a}y\\n${b}z`, tag``, site()[0], site === site, (() => { const t = (s) => s; const g = () => t`same`; return g() === g(); })(), o.m`p${b}`, String.raw`a\\tb${a}`, ((s) => s[0])`\\unicode`]; }",
    2,
  ],
  [
    "object rest in destructuring: the keys taken left out, in order; null and undefined throw (#1330)",
    "export function f(a, b) { const { x, ...r } = { x: 1, y: a, z: b }; const { p, q, ...r2 } = { q: 2, w: 3, p: 4, [Symbol.iterator]: 5 }; let e = ''; try { const { ...n } = null; } catch (err) { e = err.name; } return [x, r, r2, Object.keys(r2), e]; }",
    2,
  ],
  [
    "a condition made outside an if and tested only by ifs nested in its sides, one of which only throws (#1292): computed before them",
    "export function f(a, b) { class A { constructor(bl, o) { if (typeof o !== 'number') { throw new TypeError('expected number, got ' + typeof o); } this.o = o; } } class B extends A { constructor(opts = {}, flags = 0) { super(64, opts.dkLen === undefined ? 32 : opts.dkLen); const { key, context } = opts; const hasContext = context !== undefined; if (key !== undefined) { if (hasContext) throw new Error('both'); this.f = 1; } else if (hasContext) { this.f = 3; } else { this.f = 2; } this.s = this.f + 1; } } const t = (g) => { try { return g(); } catch (e) { return e.message; } }; return [t(() => new B().o), t(() => new B({ dkLen: a }).o), t(() => new B({ key: b }).s), t(() => new B({ context: a }).f), t(() => new B({ key: 1, context: 2 }).f)]; }",
    2,
  ],
  [
    "a method call reads its member once: a getter's count; of undefined or null, the read's TypeError (#1369)",
    "export function f(a, b) { let reads = 0; const o = { get m() { reads++; return (x) => 'm' + x; } }; const t = (g) => { try { return g(); } catch (e) { return e.name + ': ' + e.message; } }; const u = typeof a === 'string' ? null : undefined; const r = [o.m(1), o.m(b), reads, t(() => u.toString()), t(() => u.charCodeAt(0)), String(a).charCodeAt(0), [1, 2].map(String).join()]; const fn = o.m; return [...r, fn(3), reads]; }",
    2,
  ],
  [
    "++ and -- on numbers inline, else ToNumeric; charCodeAt on strings at once, else the method (#1369)",
    "export function f(a, b) { let x = a; x++; let y = b; y--; let s = '7'; s++; let z = { valueOf() { return 4; } }; z++; let big = 9n; big--; let o = null; o++; let u; u--; const str = typeof a === 'string' ? a : 'h\u00e9\ud83d\ude00'; const box = { charCodeAt: (i) => 'own ' + i }; return [x, y, s, z, big, o, u, str.charCodeAt(0), str.charCodeAt(1.7), str.charCodeAt(-1), str.charCodeAt(99), str.charCodeAt('2'), str.charCodeAt(NaN), box.charCodeAt(3), [1, 2].charCodeAt === undefined]; }",
    2,
  ],
  [
    "integer reads of objects with digit keys: small indices, larger ones, non-index digit keys, deletes, the chain (#1369)",
    "export function f(a, b) { const t = { 0: 'z', 5: 'five', 127: 'top', 34: 'q' }; const big = { 128: 'b', 7: 's' }; const odd = { '05': 'x', '1e3': 'y' }; const tail = Object.create({ 9: 'proto', 200: 'far' }); tail[3] = 'own'; const n = typeof a === 'number' ? a : 5; const d = { 2: 'two' }; delete d[2]; d.k = 1; return [t[0], t[n], t[127], t[128], t[34], t[33], big[128], big[7], big[8], odd[5], odd[1000], odd['05'], tail[3], tail[9], tail[200], tail[4], d[2], t[1.5], t[-1]]; }",
    2,
  ],
  [
    "templates: substitutions' ToString in order, more than eight, a Symbol's TypeError; typeof's strings (#1369)",
    "export function f(a, b) { const log = []; const o = (k) => ({ toString() { log.push(k); return '<' + k + '>'; } }); const t = (g) => { try { return g(); } catch (e) { return e.name; } }; const many = `${1}${2}${3}${4}${5}${6}${7}${8}${9}${a}${b}`; const types = [a, b, 1n, null, undefined, () => 0, Symbol(), {}, true].map((x) => typeof x); return [`x${o(1)}y${o(2)}z`, log.join(), many, `${''}`, `a${a}`, t(() => `${Symbol('s')}`), types, typeof a === 'number', types[0] === typeof a]; }",
    2,
  ],
  [
    "string builders: a loop's string only appended to, on some paths, with any values, nested, left by break (#1369)",
    "export function f(a, b) { const log = []; const o = { toString() { log.push('ts'); return 'O'; }, valueOf() { log.push('vo'); return 7; } }; const items = [1, 'x', null, undefined, true, 2n, o, [1, 2], { k: 1 }, -0, 1.5]; let s = ''; for (const v of items) s += v; let t = '['; for (let i = 0; i < 6; i++) { if (i % 2 === 0) t += i; else if (i === 3) continue; t = t + ',' ; } let u = 'u'; let w = ''; for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { w += j; if (j === 1) break; } u += i + ':'; } let p = 'z'; for (let i = 0; i < 3; i++) p = i + p; let q = ''; let k = 0; while (q.length < 5) q += k++; const sym = (() => { try { let e = ''; for (const x of [1, Symbol('s')]) e += x; return e; } catch (err) { return err.name; } })(); let big = ''; for (let i = 0; i < 2000; i++) big += String.fromCharCode(97 + (i % 26)); return [s, log.join(), t, u, w, p, q, sym, big.length, big.slice(0, 30), big.slice(-5), String(a) + b]; }",
    2,
  ],
  [
    "a generator's loop appending across yields; === and !== against undefined, null, true and false (#1369)",
    "export function f(a, b) { function* g() { let acc = '>'; for (let i = 0; i < 3; i++) { acc += i; yield acc; } return acc + '!'; } const vals = [undefined, null, true, false, 0, '', NaN, 'undefined', a, b]; return [[...g()], g().next(), vals.map((v) => [v === undefined, v !== null, v === true, false === v, v !== undefined, null === v])]; }",
    2,
  ],
  [
    "index and length reads in loops: arrays (holes), strings, typed arrays of every kind and offset, any key (#1369)",
    "export function f(a, b) { const buf = new ArrayBuffer(32); const u8 = new Uint8Array(buf); for (let i = 0; i < 32; i++) u8[i] = i * 7 + 1; const views = [u8, new Uint8Array(buf, 3, 5), new Uint32Array(buf, 4, 3), new Int16Array(buf), new Float64Array(buf, 8, 2), new BigUint64Array(buf, 16, 1), new Uint8ClampedArray([300, -5])]; const holey = [1, , 3]; holey[6] = 'six'; const str = 'h\u00e9\u0100\ud83d\ude00' + a; const fn = (x, y) => x; const things = [[10, 20, 30], holey, str, ...views, { length: 'own', 0: 'zero', 2: 'two' }, fn, Object.assign([7, 8], { k: 1 })]; const keys = [0, 1, 2, 5, 6, 7, -1, -0, 1.5, NaN, 4294967295, 2 ** 40, '1', 'length', true]; const out = []; for (const t of things) { const row = [t.length]; for (const k of keys) { const v = t[k]; row.push(typeof v === 'bigint' ? String(v) + 'n' : v); } out.push(row); } return out; }",
    2,
  ],
  [
    "charCodeAt in a loop: every index kind, other receivers, an own method (#1369)",
    "export function f(a, b) { const recv = ['h\u00e9\ud83d\ude00' + a, '', 12345, { charCodeAt: (i) => 'own' + i }]; const idx = [0, 1, 2, 3, 99, -1, -0, 1.9, NaN, '1', undefined, 2 ** 33]; const out = []; for (const r of recv) for (const i of idx) { let v; try { v = r.charCodeAt(i); } catch (e) { v = e.name; } out.push(v); } return out; }",
    2,
  ],
  [
    "Math.imul inline on any values; loop carries kept to an integer range, and ones that leave it (#1369)",
    "export function f(a, b) { const xs = [0, 1, -1, 2 ** 31, 2 ** 32 + 5, -(2 ** 33), 1.9, -1.9, NaN, Infinity, 1e300, '7', null, undefined, true, a, b]; const prods = []; for (const x of xs) for (const y of [3, -7, 2 ** 31 - 1, 1e20, 'q']) prods.push(Math.imul(x, y)); let h = 2166136261; for (let i = 0; i < 1000; i = (i + 1) >>> 0) { h = (h ^ i) >>> 0; h = Math.imul(h, 16777619) >>> 0; h = ((h << 13) | (h >>> 19)) >>> 0; } let s = 0; for (let i = 0; i < 50; i++) s = (s + 0x7fffffff) | 0; let w = 1; for (let i = 0; i < 40; i++) w = w * 3; let m = 5; for (let i = 0; i < 4; i++) m = i % 2 ? m >>> 1 : 'x' + m; let k = -1; for (let i = 0; i < 3; i++) k = k >>> 0; let big = 0n; try { for (let i = 0; i < 2; i++) big = big | 1n; } catch (e) { big = e.name; } return [prods, h, s, w, m, k, String(big)]; }",
    2,
  ],
  [
    "a loop carried from a parameter: in its integer range or not (out of range, negative, fraction, -0, NaN, strings); % of integers (#1369)",
    "export function f(a, b) { function sum(x, y, n) { for (let i = 0; i < n; i++) { x = ((x + i) >>> 0) % 65521; y = ((y + x) | 0) % 7; } return [x, y, Object.is(y, -0)]; } function keep(h, n) { for (let i = 0; i < n; i++) h = (h ^ i) >>> 0; return h; } const vals = [0, 1, 65520, 2 ** 31, 2 ** 32 - 1, 2 ** 32 + 3, -1, -(2 ** 31), 1.5, -0, NaN, Infinity, '12', null, a, b]; const out = []; for (const v of vals) out.push(sum(v, v, 5), sum(v, -5, 3), keep(v, 4)); const mods = []; for (const [p, q] of [[7, 3], [0, 5], [5, 0], [-7, 3], [7, -3], [-0, 3], [2 ** 32 - 1, 65521], [1.5, 1]]) mods.push(p % q, Object.is(p % q, -0)); return [out, mods]; }",
    2,
  ],
  [
    "join: its length at the start, each element's ToString in order (one that grows the array), holes, null; JSON strings with and without escapes (#1369)",
    "export function f(a, b) { const t = (g) => { try { return g(); } catch (e) { return e.name; } }; const arr = [1, null, , undefined, 'x', [2, [3, 4]], { toString() { arr.push('late'); return 'O'; } }, -0, 1e21, b]; const j1 = arr.join(); const j2 = arr.join(' | '); const big = Array.from({ length: 50000 }, (_, i) => i % 7).join(''); return [j1, j2, arr.length, [].join(), [a].join('-'), [null].join(), big.length, big.slice(0, 9), JSON.parse('\"plain text\"'), JSON.parse('[\"a\\\\b\", \"\\\\u00e9\\\\n\", \"\"]'), JSON.parse('{\"k\": \"v\", \"\": 1}'), t(() => JSON.parse('\"tab\\there\"')), t(() => JSON.parse('\"open'))]; }",
    2,
  ],
  [
    "constructors whose branch throws on one side, the heap joined after: derived and plain (#1370)",
    "export function f(a, b) { class A { constructor(n) { this.n = n; } } class B extends A { constructor(o = {}, fl = 0) { super(1); const { k, c } = o; const has = c !== undefined; if (k !== undefined) { if (has) throw new Error('x'); this.v = k + fl; } else if (has) { this.v = c; } else { this.v = fl; } this.w = this.v * 2; } } class C { constructor(o = {}, fl = 0) { const { k, c } = o; const has = c !== undefined; if (k !== undefined) { if (has) throw new Error('y'); this.v = k + fl; } else { this.v = fl; } this.w = this.v * 2; } } const t = (g) => { try { return g(); } catch (e) { return e.message; } }; return [new B({ k: a }, 1).w, new B({ c: b }).w, new B().w, new C({ k: a }, 1).w, new C().w, t(() => new B({ k: a, c: b })), t(() => new C({ k: a, c: b }))]; }",
    2,
  ],
  [
    "toString(radix) of integers and not; typed arrays' integer stores of any number (#1369)",
    "export function f(a, b) { const xs = [0, -0, 1, -1, 255, 4096, -(2 ** 31), 2 ** 53 - 1, -(2 ** 53) + 1, 2 ** 53, 1e21, 0.5, -3.75, 1 / 3, a]; const radix = xs.flatMap((x) => [2, 8, 16, 36].map((r) => x.toString(r))); const vals = [0, 1, -1, 255, 256, -129, 65535, 65536, 2 ** 31, 2 ** 32 + 7, -(2 ** 32) - 3, 1.9, -1.9, 2 ** 53, 1e19, -1e19, NaN, Infinity, -Infinity]; const kinds = [Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array]; const stored = kinds.map((K) => { const t = new K(vals.length); vals.forEach((v, i) => { t[i] = v; }); return Array.from(t); }); return [radix, stored]; }",
    2,
  ],
  [
    "reads of objects with many keys across deletes, re-adds and overwrites; a prototype with many methods (#1369)",
    "export function f(a, b) { const o = {}; for (let i = 0; i < 20; i++) o['k' + i] = i; const r = []; for (let pass = 0; pass < 3; pass++) { for (let i = 0; i < 20; i += 3) r.push(o['k' + i]); delete o['k' + (pass * 2)]; o['k' + (pass * 2)] = 'again' + pass; o.k19 = pass; } class P { m0() { return 0; } m1() { return 1; } m2() { return 2; } m3() { return 3; } m4() { return 4; } m5() { return 5; } m6() { return 6; } m7() { return 7; } m8() { return 8; } m9() { return 9; } } const x = new P(); const calls = []; for (let i = 0; i < 3; i++) { calls.push(x.m9(), x.m0(), x.m5()); if (i === 1) P.prototype.m5 = () => 'swapped'; } return [r, Object.keys(o).length, o.k0, o.k2, o.k4, calls, a, b]; }",
    2,
  ],
  [
    "integers on their int64s: shifts by 32 and more, signed and unsigned, wrapping sums, sums past 2^32 into bitwise, compares (#1369)",
    "export function f(a, b) { let h = 0; let u = 4294967295; let s = -2147483648; const out = []; for (let i = 0; i < 40; i = (i + 1) | 0) { h = (h + (i << i)) | 0; u = (u + i) >>> 0; s = (s - i) | 0; const big = (u >>> 0) + (u >>> 0); out.push([h, u, s, big | 0, big >>> 3, s >> (i + 1), s >>> i, (u ^ s) | 0, u < s, u >= (s >>> 0), (i % 7) === 3, h !== s]); } return [out.slice(28), typeof a === 'number' ? ((a | 0) + (b | 0)) | 0 : 0]; }",
    2,
  ],
  [
    "Object.defineProperty's enumerability: a new property's default, the descriptor's, kept on redefine and assignment, cleared by delete (#1370)",
    "export function f(a, b) { const o = { x: 1 }; Object.defineProperty(o, '__esModule', { value: true, writable: true, configurable: true }); Object.defineProperty(o, 'shown', { value: 2, enumerable: true }); Object.defineProperty(o, 'g', { get() { return 3; }, enumerable: false }); Object.defineProperty(o, 'x', { value: 10 }); o.__esModule = 'still hidden'; const keys1 = Object.keys(o); const forIn = []; for (const k in o) forIn.push(k); const json = JSON.stringify(o); const spread = { ...o }; const assigned = Object.assign({}, o); delete o.__esModule; o.__esModule = 'back'; const p = Object.create({}, { a: { value: 1 }, b: { value: 2, enumerable: true } }); return [keys1, forIn, json, Object.keys(spread), Object.keys(assigned), Object.getOwnPropertyNames(o), Object.keys(o), o.g, Object.getOwnPropertyDescriptor(o, 'g').enumerable, Object.getOwnPropertyDescriptor(o, 'shown').enumerable, Object.keys(p), p.a, a, b]; }",
    2,
  ],
  [
    "Math.random, with arguments it ignores (undici's random(max)): a number in [0, 1) (#1331)",
    "export function f(a, b) { const r = Math.random(a); const q = Math.random(); return [typeof r, r >= 0 && r < 1, q >= 0 && q < 1, r !== q || r === q]; }",
    2,
  ],
  [
    "in along a built-in value's intrinsic prototype, and on functions (#1331)",
    'export function f(a, b) { const fn = function g() { return this; }; fn.extra = 1; return [Symbol.iterator in new Map(), "get" in new Map(), "size" in new Set(), "then" in Promise.resolve(1), "toString" in {}, "nope" in {}, "call" in fn, "extra" in fn, "name" in fn, "prototype" in fn, "nope" in fn, Symbol.iterator in new Uint8Array(1), "getTime" in new Date(0), Symbol.iterator in [a], "length" in [b]]; }',
    2,
  ],
  [
    "arrays with holes: literals, new Array(n), delete, a write past the end, length; in, keys, the callbacks (#1330)",
    "export function f(a, b) { const x = [, a, , b]; const y = new Array(3); y[1] = a; const z = [1, 2, 3]; delete z[1]; const w = []; w[3] = b; const v = [a]; v.length = 3; const seen = []; x.forEach((e, i) => seen.push(i)); const m = x.map((e) => 1); return [x.length, 0 in x, 1 in x, Object.keys(x), x.hasOwnProperty(2), seen, m.length, 0 in m, 1 in m, Object.keys(y), y.filter(() => true).length, Object.keys(z), z.reduce((s, e) => s + e, 0), Object.keys(w), w.length, Object.keys(v), [, 5, , 6].reduce((s, e) => s + e), x.some((e) => e === undefined), x.indexOf(undefined), x.includes(undefined), x.slice(0, 2).length, 0 in x.slice(0, 2), JSON.stringify(x), String([, 1, , 2]), [...[, 7]], Array.from([, 8])]; }",
    2,
  ],
  [
    "new RegExp of constant strings, lookbehind (#1331)",
    "export function f(a, b) { const ansi = new RegExp('[\\\\u001B\\\\u009B][[\\\\]()#;?]*' + '(?:\\\\d{1,4}(?:;\\\\d{0,4})*)?' + '[\\\\dA-PR-TZcf-nq-uy=><~]', 'g'); const s = '\\u001b[31mred\\u001b[0m ' + String(a); const price = /(?<=\\$)\\d+(?:\\.\\d\\d)?/g; const not = /(?<!-)\\b\\d+/g; const t = 'pay $12.50 or $3, -4 and 5 ' + String(b); return [s.replace(ansi, ''), ansi.flags, ansi.global, t.match(price), t.match(not), new RegExp('(?<y>\\\\d{4})-(?<m>\\\\d\\\\d)').exec('on 2024-05 ' + a)?.groups?.m]; }",
    2,
  ],
  [
    "generator and async generator functions: their prototype objects, %GeneratorPrototype%, %AsyncIteratorPrototype% (#1331)",
    "export function f(a, b) { function* g() { yield a; yield b; } async function* ag() { yield a; } const GP = Object.getPrototypeOf(g.prototype); const AGP = Object.getPrototypeOf(ag.prototype); const AIP = Object.getPrototypeOf(AGP); const it = g(); const IP = Object.getPrototypeOf(GP); const AGF = Object.getPrototypeOf(ag); return [Object.getPrototypeOf(it) === g.prototype, Object.getPrototypeOf(ag()) === ag.prototype, typeof GP.next, typeof GP.return, IP === Object.getPrototypeOf(Object.getPrototypeOf([].values())), it[Symbol.iterator]() === it, typeof AIP[Symbol.asyncIterator], AIP[Symbol.asyncIterator].call(it) === it, Object.getPrototypeOf(AIP) === Object.prototype, Object.prototype.toString.call(it), Object.prototype.toString.call(ag()), AGF.prototype === AGP, Object.getPrototypeOf(g) === Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async () => 1) === Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(AGF) === Function.prototype, [...it], Object.hasOwn(g.prototype, 'constructor')]; }",
    2,
  ],
  [
    "writes past a data property to a setter further up the chain; setters added after; methods replaced, shadowed and not functions, at one call site (#1370)",
    "export function f(a, b) { const log = []; const top = { set x(v) { log.push('set ' + v); } }; const mid = Object.create(top); Object.defineProperty(mid, 'x', { value: 'mid', writable: true, enumerable: true, configurable: true }); const via = Object.create(top); via.x = 'via'; const low = Object.create(mid); low.x = a; const plain = Object.create({ y: 1 }); plain.y = b; const late = {}; const kid = Object.create(late); kid.z = 1; Object.defineProperty(late, 'z', { set(v) { log.push('late ' + v); }, configurable: true }); kid.z = 2; const kid2 = Object.create(late); kid2.z = 4; class C { set w(v) { log.push('w ' + v); } } const c = new C(); c.w = 3; const mk = (k) => ({ id: k, m() { return 'own ' + this.id; } }); const objs = [mk(1), mk(2), { m: () => 'arrow' }, { pad: 0, m() { return 'moved'; } }, Object.create({ m() { return 'proto'; } })]; const calls = []; for (let i = 0; i < 2; i++) for (const o of objs) calls.push(o.m()); objs[0].m = function () { return 'replaced'; }; calls.push(objs[0].m()); let err = ''; try { ({ m: 5 }).m(); } catch (e) { err = e instanceof TypeError; } return [log, Object.keys(low), low.x, mid.x, Object.keys(via), plain.y, Object.keys(kid), kid.z, Object.keys(kid2), calls, err]; }",
    2,
  ],
  [
    "native errors: each type's prototype, its name there, message, stack and cause own and not enumerable, constructor, instanceof, subclasses, errors the runtime throws (#1331)",
    "export function f(a, b) { return [(() => { try { return Object.keys(new TypeError(a)); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return new TypeError('x').constructor === TypeError; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return Object.getPrototypeOf(new RangeError('r')) === RangeError.prototype; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return RangeError.prototype.name; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return Object.getPrototypeOf(RangeError.prototype) === Error.prototype; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return new TypeError('x') instanceof RangeError; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return Object.prototype.toString.call(new TypeError('x')); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { try { null.x; } catch (e) { return [e.constructor === TypeError, e.constructor.name, Object.keys(e), e instanceof TypeError, Object.getPrototypeOf(e) === TypeError.prototype]; } })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { try { [].reduce((x) => x); } catch (e) { return [e.constructor.name, e.name]; } })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { class E extends TypeError { constructor(m) { super(m); this.name = 'E'; } } const e = new E('m'); return [e instanceof TypeError, e instanceof E, e instanceof Error, Object.keys(e), e.constructor.name, String(e), e.message]; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return Object.getOwnPropertyNames(new Error('a')); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return Object.hasOwn(new Error('a'), 'name'); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return Object.hasOwn(new Error(), 'message'); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return Error.prototype.toString.call(new SyntaxError('s')); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return String(new Error()); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return String(new URIError(b)); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return new AggregateError([1, a], 'ag').errors; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return Object.keys(new AggregateError([1], 'ag')); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return new AggregateError([1], 'ag', { cause: b }).cause; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return Object.keys(new Error('a', { cause: 1 })); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return new Error('a', { cause: b }).cause; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return 'cause' in new Error('a', {}); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return JSON.stringify(new RangeError('j')); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return Object.keys({ ...new Error('s') }); } catch (e) { return 'threw ' + e.name; } })()]; }",
    2,
  ],
  [
    "Math's members read as values: functions (exact and atoms), their identity, name and length; its constants (#1331)",
    "export function f(a, b) { const n = typeof a === 'number' ? a : 7.5; const floor = Math.floor; const { abs, max, sin, pow, random } = Math; return [floor(n / 7), typeof Math.floor, Math.floor === Math.floor, [Math.floor.name, Math.floor.length, Math.max.length, Math.atan2.length, Math.random.length], abs(-n), max(1, n, 3), sin(n), pow(2, 10), typeof random(), [1.5, -2.5, 3].map(Math.round), [4, 9].map(Math.sqrt), Math.PI, Math.E, Math.SQRT1_2, floor('7.9'), [Math.LN2].map(Math.exp)]; }",
    2,
  ],
  [
    "a write to a property of undefined or null: V8's TypeError and message (#1331)",
    "export function f(a, b) { const out = []; for (const o of [undefined, null, a === null ? undefined : null]) { try { o.k = b; out.push('wrote'); } catch (e) { out.push(e instanceof TypeError, e.message); } } return out; }",
    2,
  ],
  [
    "what is enumerable on functions and classes: a function's own properties, not its prototype; a class's static fields, not its methods; a prototype's methods; built-in constructors' functions (#1331)",
    "export function f(a, b) { const fn = function () {}; fn.x = a; Object.defineProperty(fn, 'h', { value: 3 }); class A { static s() {} static f = b; m() {} get g() { return 1; } } class B extends A {} const arrow = () => 1; arrow.k = 1; return [Object.keys(fn), Object.values(fn), Object.entries(arrow), Object.keys(A), Object.keys(A.prototype), Object.keys(B), Object.keys(new A()), { ...fn }, Object.keys(Array), Object.keys(Object), Object.keys(Promise), Object.keys(Math.max), JSON.stringify(Object.keys(A.prototype.constructor))]; }",
    2,
  ],
  [
    "a class extending Object; instanceof through a function's own Symbol.hasInstance (zod's $constructor, #1368)",
    "export function f(a, b) { class D extends Object { constructor() { super(); this.v = a; } } class E extends Object {} const d = new D(); const e = new E(); function F() {} Object.defineProperty(F, Symbol.hasInstance, { value: (x) => x !== null && x !== undefined && x.v !== undefined }); return [d.v, d instanceof D, d instanceof Object, Object.getPrototypeOf(D.prototype) === Object.prototype, Object.keys(e), e instanceof E, d instanceof F, e instanceof F, [] instanceof F, b instanceof F, [{}, [], () => 1, Object.create(null), 1, 'x', null].map((x) => x instanceof Object)]; }",
    2,
  ],
  [
    "JSON.stringify as ECMA-262's: replacer function and property list, space, toJSON (a Date's), omitted members, BigInt's TypeError, V8's circular-structure message; BigInt toString(radix), String at, Object/Map.groupBy (#1331)",
    "export function f(a, b) { return [(() => { try { return JSON.stringify({a:1}, null, 2); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return JSON.stringify({d:Symbol('x'), b: undefined, c: () => 1}); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return JSON.stringify({e:new Date(0)}); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return JSON.stringify([undefined, () => 1, Symbol('q')]); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return JSON.stringify({ toJSON(k) { return 'tj' + k; } }); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return JSON.stringify({ x: { toJSON(k) { return 'in ' + k; } } }); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return [JSON.stringify(undefined), JSON.stringify(() => 1), JSON.stringify(Symbol('s'))]; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return JSON.stringify({ a: [1, { b: 2 }, []], c: {} }, null, '--'); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return JSON.stringify({ a: [1, 2], b: 'x' }, null, 20); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return JSON.stringify({ a: 1, b: 2, c: { a: 3, d: 4 } }, ['a', 'c', 'a', 1]); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return JSON.stringify({ a: 1, b: 'two', c: [3] }, (k, v) => typeof v === 'number' ? v * 10 : v); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return JSON.stringify({ a: 1 }, function (k, v) { return k === '' ? { wrapped: v, t: typeof this } : v; }); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { try { JSON.stringify({ n: 1n }); } catch (e) { return e.name + ': ' + e.message; } })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const o = { a: {} }; o.a.b = o; try { JSON.stringify(o); } catch (e) { return e.message; } })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const o = { x: [{}] }; o.x[0].y = o.x; try { JSON.stringify(o); } catch (e) { return e.message; } })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const o = { a: { b: { c: { d: {} } } } }; o.a.b.c.d.e = o; try { JSON.stringify(o); } catch (e) { return e.message; } })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const o = {}; o.self = o; try { JSON.stringify(o); } catch (e) { return e.message; } })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return JSON.stringify(new Map([[1, 2]])) + JSON.stringify(new Set([1])) + JSON.stringify(/x/) + JSON.stringify(new Error('e')); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return JSON.stringify('\\u2028\\ud800\\u0007'); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return [(255n).toString(16), (-255n).toString(2), (2n ** 64n).toString(36), (0n).toString(7), (10n).toString()]; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return 'x'.padStart(4, 'ab') + 'abc'.at(-1) + 'abc'.at(5) + 'abc'.at(0); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return JSON.stringify(Object.groupBy([1,2,3,4], x => x % 2 ? 'odd' : 'even')) + Object.getPrototypeOf(Object.groupBy([], x => x)) + JSON.stringify([...Map.groupBy([1,2,3,-0,0], x => x > 1 ? 'big' : x)]); } catch (e) { return 'threw ' + e.name; } })()]; }",
    2,
  ],
  [
    "RegExp Unicode property escapes with u: \\p and \\P, General Category, binary properties (zod's emoji pattern), a script, in classes and lookahead (#1331)",
    "export function f(a, b) { return [(() => { try { return /\\p{L}+/u.exec('12h\u00e9llo\u4e16\u754c!')[0]; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return 'a1-\u00df_\u03a9\ud83d\ude00'.replace(/\\P{L}/gu, '.'); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return /^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$/u.test('\ud83d\ude00\ud83d\udc4d\ud83c\udffd'); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return /^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$/u.test('ab' + a); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return 'Gr\u00fc\u00dfe, \u1f08\u03b8\u1fc6\u03bd\u03b1\u03b9, \u041c\u043e\u0441\u043a\u0432\u0430'.match(/\\p{Script=Greek}+/u)[0]; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return /[\\p{Lu}\\d]+/u.exec('abCD12ef')[0]; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return /\\p{gc=Nd}/u.test('\u0663'); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return /[^\\p{White_Space}]+/u.exec('  \\u00a0 xy z')[0]; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return 'aA1'.split(/(?=\\p{Lu})/u); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return String(a).replace(/\\p{N}/gu, '#'); } catch (e) { return 'threw ' + e.name; } })()]; }",
    2,
  ],
  [
    "Proxy: get, set, has, deleteProperty, ownKeys with getOwnPropertyDescriptor, apply, construct, getPrototypeOf, defineProperty; revocable; a proxied array; a proxy as a prototype (#1331)",
    "export function f(a, b) { return [(() => { try { return (() => { const p = new Proxy({}, { get: (t, k) => k === 'x' ? 42 : Reflect.get(t, k), has: () => true }); return [p.x, p.y, 'zz' in p, typeof p]; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const log = []; const t = { a: 1 }; const p = new Proxy(t, { set(t, k, v) { log.push('set ' + String(k)); t[k] = v * 2; return true; }, deleteProperty(t, k) { log.push('del ' + k); delete t[k]; return true; } }); p.b = 5; p[3] = 1; delete p.a; return [log, JSON.stringify(t), p.b]; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const p = new Proxy({ a: 1, b: 2 }, { ownKeys: () => ['b', 'c'], getOwnPropertyDescriptor: (t, k) => ({ value: k, enumerable: k !== 'c', configurable: true }) }); return [Object.keys(p), Reflect.ownKeys(p), JSON.stringify(p), Object.entries(p)]; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const f = new Proxy(function (a, b) { return a + b; }, { apply: (t, self, args) => t(...args) * 10 }); return [f(1, 2), typeof f, f.call(null, 3, 4)]; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { class A { constructor(x) { this.x = x; } } const P = new Proxy(A, { construct: (t, args) => new t(args[0] + 1) }); const o = new P(1); return [o.x, o instanceof A]; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const { proxy, revoke } = Proxy.revocable({ a: 1 }, {}); const before = proxy.a; revoke(); try { proxy.a; } catch (e) { return [before, e.constructor.name, e.message]; } })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const p = new Proxy([1, 2, 3], {}); return [Array.isArray(p), p.length, p[1], JSON.stringify(p)]; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const proto = new Proxy({}, { get: (t, k, r) => 'from proto ' + String(k) }); const o = Object.create(proto); o.own = 1; return [o.own, o.missing]; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const target = { greet() { return 'hi ' + this.name; }, name: 't' }; const p = new Proxy(target, { get(t, k, r) { const v = Reflect.get(t, k, r); return typeof v === 'function' ? v.bind(t) : v; } }); return [p.greet(), p.name]; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const p = new Proxy({}, { getPrototypeOf: () => Array.prototype }); return [p instanceof Array, Object.getPrototypeOf(p) === Array.prototype]; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { try { Proxy({}, {}); } catch (e) { return e.message; } })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (function () { 'use strict'; const p = new Proxy({}, { set: () => false }); try { p.x = 1; return 'no throw'; } catch (e) { return e.message; } })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const p = new Proxy({ x: 1 }, { defineProperty(t, k, d) { t[k] = 'defined'; return true; } }); Object.defineProperty(p, 'y', { value: 2 }); return [p.y]; })(); } catch (e) { return 'threw ' + e.name; } })()]; }",
    2,
  ],
  [
    "Object.freeze / seal / preventExtensions and their predicates, strict code's TypeErrors; split's limit; ToString's hint (toString first) in templates, String() and keys; a function's length before its first default (#1331)",
    "export function f(a, b) { return [(() => { try { return (function () { 'use strict'; const o = Object.freeze({ a: 1, n: { m: 1 } }); const r = [Object.isFrozen(o), Object.isSealed(o), Object.isExtensible(o)]; try { o.a = 2; } catch (e) { r.push(e.message); } try { o.b = 2; } catch (e) { r.push(e.message); } try { delete o.a; } catch (e) { r.push(e.message); } o.n.m = 5; r.push(o.a, o.n.m, JSON.stringify(o)); return r; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (function () { 'use strict'; const o = Object.seal({ a: 1 }); o.a = 2; const r = [o.a, Object.isSealed(o), Object.isFrozen(o)]; try { o.b = 1; } catch (e) { r.push(e.message); } return r; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (function () { 'use strict'; const o = Object.preventExtensions({ a: 1 }); o.a = 3; delete o.a; const r = [o.a, Object.isExtensible(o), Object.isFrozen(o)]; try { o.z = 1; } catch (e) { r.push(e.message); } return r; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (function () { 'use strict'; const a = Object.freeze([1, 2]); const r = [Object.isFrozen(a), a.length]; try { a[0] = 9; } catch (e) { r.push(e.message); } try { a[5] = 9; } catch (e) { r.push(e.message); } return r; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return [Object.isFrozen(1), Object.isFrozen({}), Object.isFrozen(Object.preventExtensions({})), Object.isExtensible('x'), Object.freeze(5)]; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return 'The quick brown fox'.split(' ', 2).concat('a,b,c'.split(',', 0), 'abc'.split('', 2), 'a,b'.split(',', -1)); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const o = { valueOf() { return 5; }, toString() { return 'S'; } }; return [o + 1, `${o}`, String(o), o + '', [o].join(), ({ [o]: 1 }).S]; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const o = { valueOf() { return 7; } }; return [`${o}`, String(o), o + '!', `${[1, 2]}`, `${{}}`, `${Object.create(null, { valueOf: { value: () => 3 } })}`]; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return [(function (a, b) {}).length, ((a, b = 1, c) => 0).length, ((...r) => 0).length, (({ a = 1 }, [b] = [], c) => 0).length, (x => x).length, (async (a, b) => a).length, (function* (a) {}).length, ((a = (1, 2), b) => 0).length, (({ x }) => 0).length, ((a, b = 'x,y', c) => 0).length]; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { class A { m(a, b = 1) {} static s(x, y, z) {} } return [new A().m.length, A.s.length, A.length]; })(); } catch (e) { return 'threw ' + e.name; } })()]; }",
    2,
  ],
  [
    "primitive wrapper objects (new Number, Object('s')); Symbol.toPrimitive and ToPrimitive's hints (number for arithmetic and comparisons, a Date's time value) (#1331)",
    "export function f(a, b) { return [(() => { try { return [new Number(3) + 1, typeof new String('x'), Object(1) instanceof Number, new Boolean(false) ? 'truthy' : 'falsy', new String('ab').length, JSON.stringify([new Number(1), new String('s'), new Boolean(true)])]; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return [new String('ab')[1], new String('hello').toUpperCase(), new Number(255).toString(16), new Number(1.5).toFixed(2), String(new String('x')), `${new Number(7)}`, new Number(2) * new Number(3)]; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return [Object.prototype.toString.call(new Number(1)), Object.prototype.toString.call(Object('s')), Object.prototype.toString.call(Object(true)), typeof Object(Symbol('q')), Object(1n) instanceof BigInt]; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return [new Number(1) == 1, new Number(1) === 1, new String('a') == 'a', new Number(1) instanceof Object, 1 instanceof Number, Object(1).valueOf(), typeof Object(1).valueOf()]; } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const o = { [Symbol.toPrimitive](h) { return h === 'number' ? 42 : h === 'string' ? 'str' : 'dflt'; } }; return [`${o}`, o + '', String(o), o * 2, -o, o < 50, o == 'dflt', +o, [o] + '']; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const o = { [Symbol.toPrimitive]() { return {}; } }; try { return o + 1; } catch (e) { return [e.constructor.name, e.message]; } })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const w = new Number(5); w.extra = 1; w.valueOf = () => 9; return [w + 1, w.extra, Object.keys(w)]; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const a = new Date(1000), b = new Date(2000); return [a < b, b - a, +a, a + 1 === String(a) + '1', a == 1000, Math.max(a, b), [b, a].sort((x, y) => x - y).map(Number)]; })(); } catch (e) { return 'threw ' + e.name; } })(), (() => { try { return (() => { const o = { valueOf() { return 3; }, toString() { return 'T'; } }; return [o - 1, o > 2, o + 1, ~o, `${o}`]; })(); } catch (e) { return 'threw ' + e.name; } })()]; }",
    2,
  ],
];

describe.skipIf(!canRun("x86_64-linux"))("boxed values, natively on this host (#1292)", () => {
  for (const [name, source, arity] of PROGRAMS) {
    it(`computes what Node computes: ${name}`, () => {
      const inputs = fc.sample(fc.array(value, { minLength: arity, maxLength: arity }), {
        numRuns: 500,
        seed: 1292,
      });
      expect(disagreements(source, inputs)).toEqual([]);
    }, 180_000);
  }
});

/** The async programs (#1295): Node's result awaited, a rejection as ["rejected", String(reason)]. */
const ASYNC_PROGRAMS: [string, string, number][] = [
  [
    "job order: interleaved awaits, then chains, queueMicrotask, all, allSettled, race, finally, a caught rejection",
    "export async function f(a, b) { const log = []; const t = async (name, n) => { log.push(name + 0); for (let i = 1; i <= n; i++) { await null; log.push(name + i); } return name; }; const p1 = t('a', typeof a === 'number' ? ((a % 3) + 3) % 3 : 1); const p2 = t('b', 2); Promise.resolve(1).then(() => log.push('then1')).then(() => log.push('then2')); queueMicrotask(() => log.push('micro')); const both = await Promise.all([p1, p2, 7]); const settled = await Promise.allSettled([Promise.reject(new Error('x' + b)), Promise.resolve(b)]); const raced = await Promise.race([new Promise((r) => r('slow')), 'fast']); const fin = await Promise.resolve(5).finally(() => log.push('fin')); let caught; try { await Promise.reject(new TypeError('no ' + b)); } catch (e) { caught = String(e); } return [log, both, settled.map((x) => x.status + ':' + (x.status === 'fulfilled' ? x.value : String(x.reason))), raced, fin, caught]; }",
    2,
  ],
  [
    "thenables and an async function returning a promise take the jobs the specification gives them",
    "export async function f(a) { const log = []; const inner = async () => { log.push('in'); return Promise.resolve(a); }; const thenable = { then(res) { log.push('thenable'); res(typeof a); } }; const p = inner().then((v) => log.push('inner:' + v)); const q = (async () => { const v = await thenable; log.push('after ' + v); })(); Promise.resolve().then(() => log.push('t1')).then(() => log.push('t2')).then(() => log.push('t3')).then(() => log.push('t4')); await Promise.all([p, q]); return log; }",
    1,
  ],
  [
    "a rejection: thrown in an async function, before and after an await",
    "export async function f(a) { const early = async () => { throw new RangeError('early ' + a); }; const late = async () => { await 1; throw new Error('late ' + typeof a); }; const r1 = await early().catch((e) => 'caught ' + e.message); if (typeof a === 'number' && a > 0) await late(); return r1; }",
    1,
  ],
  [
    "for await over a sync iterable: each element awaited; a rejection caught; a break closes a generator (#1330)",
    "export async function f(a, b) { const log = []; Promise.resolve().then(() => log.push('tick')); for await (const x of [Promise.resolve(a), b, new Promise((r) => r('three'))]) log.push(x); try { for await (const x of [1, Promise.reject(new Error('no ' + typeof a))]) log.push(x); } catch (e) { log.push(e.message); } function* g() { try { yield 1; yield Promise.resolve(2); yield 3; } finally { log.push('closed'); } } let n = 0; for await (const x of g()) { if (x === 3) break; n += x; } return [log, n]; }",
    2,
  ],
  [
    "a limiter in the style of p-limit: tasks queued past the concurrency, started as others finish",
    "export async function f(c, n) { const concurrency = typeof c === 'number' && c >= 1 && c < 5 ? Math.floor(c) : 2; const count = typeof n === 'number' && n >= 0 && n < 8 ? Math.floor(n) : 4; const log = []; const queue = []; let active = 0; const next = () => { active--; if (queue.length > 0) queue.shift()(); }; const run = async (fn, resolve) => { active++; const result = (async () => fn())(); resolve(result); await result.then(() => {}, () => {}); next(); }; const limit = (fn) => new Promise((resolve) => { const go = () => run(fn, resolve); if (active < concurrency) go(); else queue.push(go); }); const job = (i) => limit(async () => { log.push('start' + i); for (let k = 0; k < (i % 3) + 1; k++) await null; log.push('end' + i); if (i === 2) throw new Error('job' + i); return i * 10; }); const all = []; for (let i = 0; i < count; i++) all.push(job(i)); const settled = await Promise.allSettled(all); return [log, settled.map((x) => (x.status === 'fulfilled' ? x.value : x.reason.message))]; }",
    2,
  ],
];

describe.skipIf(!canRun("x86_64-linux"))("async functions and promises, natively (#1295)", () => {
  for (const [name, source, arity] of ASYNC_PROGRAMS) {
    it(`computes what Node computes: ${name}`, async () => {
      const inputs = fc.sample(fc.array(value, { minLength: arity, maxLength: arity }), {
        numRuns: 200,
        seed: 1295,
      });
      const run = harness(emitLlvmBoxed(liftAtom(source)), work);
      const ref = reference(source);
      const wants: unknown[] = [];
      for (const args of inputs) {
        try {
          wants.push(await (ref(...structuredClone(args)) as Promise<unknown>));
        } catch (e) {
          wants.push(["rejected", String(e)]);
        }
      }
      const { results, stderr } = run(inputs.map((args) => structuredClone(args)));
      expect(stderr).toBe("");
      const bad = inputs.flatMap((args, i) =>
        same(results[i], wants[i])
          ? []
          : [
              `${JSON.stringify(args)} → native ${JSON.stringify(results[i])}, node ${JSON.stringify(wants[i])}`,
            ],
      );
      expect(bad).toEqual([]);
    }, 180_000);
  }

  it("computes what Node computes: generators, yield*, next(v), return(), throw(), spread and Array.from", () => {
    const source =
      "export function f(n, s) { function* range(k) { for (let i = 0; i < k; i++) { const back = yield i * 2; if (back === 'stop') return 'stopped'; } return 'done'; } function* outer() { const r = yield* range(3); yield r; yield* ['x', 'y']; } const k = typeof n === 'number' && n >= 0 && n < 20 ? Math.floor(n) : 2; const g = range(k); const steps = []; let r = g.next(); while (!r.done) { steps.push(r.value); r = g.next(r.value > 2 ? 'stop' : s); } steps.push(r.value); const h = range(5); h.next(); const ret = h.return('early'); const after = h.next(); const t = range(5); t.next(); let threw; try { t.throw(new Error('boom')); } catch (e) { threw = e.message; } const fresh = range(2); const unstarted = fresh.return('never'); return [steps, [...range(k)], [...outer()], ret, after, threw, Array.from(range(3)), unstarted, fresh.next()]; }";
    const inputs = fc.sample(fc.array(value, { minLength: 2, maxLength: 2 }), {
      numRuns: 300,
      seed: 1295,
    });
    expect(disagreements(source, inputs)).toEqual([]);
  }, 180_000);
});

describe("boxed values on other architectures, under QEMU (#1292)", () => {
  const source = PROGRAMS[4]?.[1] as string;
  for (const target of ["aarch64-linux", "arm-linux", "riscv64-linux"])
    it.skipIf(!canRun(target))(
      `${target}: the array program computes what Node computes`,
      () => {
        const inputs = fc.sample(fc.array(value, { minLength: 2, maxLength: 2 }), {
          numRuns: 150,
          seed: 7,
        });
        expect(disagreements(source, inputs, target)).toEqual([]);
      },
      180_000,
    );
  for (const target of ["aarch64-linux", "arm-linux", "riscv64-linux"])
    it.skipIf(!canRun(target))(
      `${target}: async functions run as coroutines, in Node's job order (#1295)`,
      async () => {
        const source = ASYNC_PROGRAMS[0]?.[1] as string;
        const inputs = fc.sample(fc.array(value, { minLength: 2, maxLength: 2 }), {
          numRuns: 40,
          seed: 9,
        });
        const run = harness(emitLlvmBoxed(liftAtom(source)), work, target);
        const ref = reference(source);
        const wants: unknown[] = [];
        for (const args of inputs)
          wants.push(await (ref(...structuredClone(args)) as Promise<unknown>));
        const { results, stderr } = run(inputs.map((args) => structuredClone(args)));
        expect(stderr).toBe("");
        expect(results.every((r, i) => same(r, wants[i]))).toBe(true);
      },
      180_000,
    );
});

describe("what the boxed lowering refuses, for now (#1292)", () => {
  const refusal = (source: string): string => {
    try {
      emitLlvmBoxed(liftAtom(source));
    } catch (e) {
      if (e instanceof LlvmEmitError) return e.message;
      throw e;
    }
    return "lowered";
  };
  it("free names, new, approximated Math", () => {
    expect(refusal("export function f(x) { return helper(x); }")).toMatch(
      /"helper" is not in the native base set/,
    );
    // Async generators lower (emit-llvm-async-gen.test.ts).
    expect(refusal("export function f(x) { async function* g() { yield x; } return g; }")).toBe(
      "lowered",
    );
    // Holes lower (#1330); with a spread beside them they are refused.
    expect(refusal("export function f(x) { return [, x]; }")).toBe("lowered");
    expect(refusal("export function f(x) { return [, ...x]; }")).toMatch(/holes and spread/);
    // Math.sin is a reference to V8's shaved atom (#1362), lowered with it.
    expect(refusal("export function f(x) { return Math.sin(x); }")).toBe("lowered");
  });
});
