import { liftAtom } from "./lift.js";
// SPDX-License-Identifier: Apache-2.0
/**
 * Regular expressions as graphs (#1292, DEC-DUC-REGEX-GRAPH-001): a regex literal is compiled into a
 * matcher specialised to its pattern — JavaScript source with only the constructs the pattern uses —
 * and lifted like any other code, so a lowering emits that matcher and no general engine. The stored
 * graph keeps the literal; the matcher is made where a lowering needs it, deterministically.
 *
 * The matcher is `function f(s, start, sticky)`: the first match at or after `start` (only at
 * `start` when sticky), as `[start, end, group1Start, group1End, …]` (-1 for a group that did not
 * take part), or null. It backtracks as ECMAScript's pattern semantics say: alternatives in order,
 * greedy and lazy quantifiers, the empty check, captures reset on each repetition, lookahead,
 * backreferences.
 *
 * Covered: flags g, i (ASCII and Latin-1 case folding), m, s, u (code points), y, d; alternation,
 * groups (capturing, named, non-capturing), quantifiers (*, +, ?, {n,m}, lazy), classes and their
 * escapes (\d \w \s and negations), anchors and \b \B, lookahead, backreferences (numbered and
 * named), the character escapes. Refused, with the reason: lookbehind, Unicode property escapes
 * (\p{…}), case folding beyond Latin-1, a dynamic `new RegExp(…)`.
 */
import type { DucGraph } from "./types.js";

export class RegexCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegexCompileError";
  }
}

type Range = readonly [number, number];
type Node =
  | { t: "char"; c: number }
  | { t: "any" }
  | { t: "class"; negate: boolean; ranges: Range[] }
  | { t: "seq"; items: Node[] }
  | { t: "alt"; alts: Node[] }
  | { t: "group"; index: number | undefined; body: Node }
  | { t: "repeat"; min: number; max: number; greedy: boolean; body: Node }
  | { t: "bol" }
  | { t: "eol" }
  | { t: "boundary"; negate: boolean }
  | { t: "look"; negate: boolean; body: Node }
  | { t: "backref"; index: number; name?: string };

const DIGIT: Range[] = [[48, 57]];
const WORD: Range[] = [
  [48, 57],
  [65, 90],
  [95, 95],
  [97, 122],
];
const SPACE: Range[] = [
  [9, 13],
  [32, 32],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];
const MAX = 0x10ffff;

/** The complement of a set of ranges within 0 .. MAX. */
function complement(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  let at = 0;
  for (const [lo, hi] of sorted) {
    if (lo > at) out.push([at, lo - 1]);
    at = Math.max(at, hi + 1);
  }
  if (at <= MAX) out.push([at, MAX]);
  return out;
}

export interface ParsedRegex {
  readonly node: Node;
  readonly groups: number;
  /** Each group's name, in order (undefined for an unnamed group). */
  readonly names: readonly (string | undefined)[];
}

/** A regex's pattern parsed (ECMAScript syntax; with `u`, code points and stricter escapes). */
export function parseRegex(pattern: string, flags: string): ParsedRegex {
  const unicode = flags.includes("u") || flags.includes("v");
  if (flags.includes("v")) throw new RegexCompileError("the v flag is not in the subset yet");
  let at = 0;
  let groups = 0;
  const names: (string | undefined)[] = [];
  const pendingNamedRefs: { node: { t: "backref"; index: number; name?: string } }[] = [];
  // Group numbers come from the left parentheses in order, even before their groups close.
  const peek = (): string | undefined => pattern[at];
  const fail = (why: string): never => {
    throw new RegexCompileError(`/${pattern}/: ${why}`);
  };
  const codePointAt = (): number => {
    const c = pattern.codePointAt(at) as number;
    at += unicode && c > 0xffff ? 2 : 1;
    return c;
  };
  const hex = (n: number): number => {
    const h = pattern.slice(at, at + n);
    if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(h)) return -1;
    at += n;
    return Number.parseInt(h, 16);
  };
  /** A character escape after `\` (not a class escape or backreference): its code point. */
  const charEscape = (inClass: boolean): number => {
    const e = pattern[at++] as string;
    const simple: Record<string, number> = { t: 9, n: 10, v: 11, f: 12, r: 13 };
    if (simple[e] !== undefined) return simple[e] as number;
    if (e === "0" && !/[0-9]/.test(peek() ?? "")) return 0;
    if (e === "b" && inClass) return 8;
    if (e === "c") {
      const l = peek();
      if (l !== undefined && /[A-Za-z]/.test(l)) {
        at++;
        return l.charCodeAt(0) % 32;
      }
      at--;
      return 92; // `\` itself, then `c` read as a character
    }
    if (e === "x") {
      const v = hex(2);
      return v >= 0 ? v : unicode ? fail("a bad \\x escape") : 0x78;
    }
    if (e === "u") {
      if (unicode && peek() === "{") {
        const close = pattern.indexOf("}", at);
        const v = Number.parseInt(pattern.slice(at + 1, close), 16);
        if (close < 0 || Number.isNaN(v) || v > MAX) fail("a bad \\u{…} escape");
        at = close + 1;
        return v;
      }
      const v = hex(4);
      if (v < 0) return unicode ? fail("a bad \\u escape") : 0x75;
      // A surrogate pair written as two \u escapes is one code point with `u`.
      if (unicode && v >= 0xd800 && v <= 0xdbff && pattern.startsWith("\\u", at)) {
        const save = at;
        at += 2;
        const lo = hex(4);
        if (lo >= 0xdc00 && lo <= 0xdfff) return 0x10000 + ((v - 0xd800) << 10) + (lo - 0xdc00);
        at = save;
      }
      return v;
    }
    if (e === "p" || e === "P") {
      if (unicode) fail("Unicode property escapes are not in the subset yet");
      return e.charCodeAt(0);
    }
    if (unicode && !/[\^$\\.*+?()[\]{}|/-]/.test(e)) fail(`\\${e} is not an escape with u`);
    at--;
    return codePointAt();
  };
  const classEscape = (e: string): Range[] | undefined => {
    if (e === "d") return DIGIT;
    if (e === "D") return complement(DIGIT);
    if (e === "w") return WORD;
    if (e === "W") return complement(WORD);
    if (e === "s") return SPACE;
    if (e === "S") return complement(SPACE);
    return undefined;
  };
  const parseClass = (): Node => {
    const negate = peek() === "^";
    if (negate) at++;
    const ranges: Range[] = [];
    const atom = (): Range[] | number => {
      if (peek() === "\\") {
        at++;
        const set = classEscape(peek() as string);
        if (set !== undefined) {
          at++;
          return set;
        }
        return charEscape(true);
      }
      return codePointAt();
    };
    while (peek() !== "]") {
      if (at >= pattern.length) fail("an unterminated class");
      const a = atom();
      if (peek() === "-" && pattern[at + 1] !== "]" && at + 1 < pattern.length) {
        at++;
        const b = atom();
        if (typeof a === "number" && typeof b === "number") {
          if (b < a) fail("a class range out of order");
          ranges.push([a, b]);
          continue;
        }
        if (unicode) fail("a class range with a class escape");
        // Without u, `\d-x` is three atoms: the set, '-', and x.
        if (typeof a === "number") ranges.push([a, a]);
        else ranges.push(...a);
        ranges.push([45, 45]);
        if (typeof b === "number") ranges.push([b, b]);
        else ranges.push(...b);
        continue;
      }
      if (typeof a === "number") ranges.push([a, a]);
      else ranges.push(...a);
    }
    at++;
    return { t: "class", negate, ranges };
  };
  /** Consumes one character and gives `v`. */
  const step = <T>(v: T): T => {
    at++;
    return v;
  };
  const parseQuantifier = (): { min: number; max: number } | undefined => {
    const c = peek();
    if (c === "*") return step({ min: 0, max: Number.POSITIVE_INFINITY });
    if (c === "+") return step({ min: 1, max: Number.POSITIVE_INFINITY });
    if (c === "?") return step({ min: 0, max: 1 });
    if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(at));
      if (m === null) {
        if (unicode) fail("a lone {");
        return undefined;
      }
      at += m[0].length;
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === "" ? Number.POSITIVE_INFINITY : Number(m[3]);
      if (max < min) fail("numbers out of order in a quantifier");
      return { min, max };
    }
    return undefined;
  };
  const parseAtom = (): Node | undefined => {
    const c = peek();
    if (c === undefined || c === "|" || c === ")") return undefined;
    if (c === "^") return step({ t: "bol" });
    if (c === "$") return step({ t: "eol" });
    if (c === ".") return step({ t: "any" });
    if (c === "[") {
      at++;
      return parseClass();
    }
    if (c === "(") {
      at++;
      if (pattern.startsWith("?:", at)) {
        at += 2;
        const body = parseAlt();
        if (pattern[at++] !== ")") fail("an unterminated group");
        return { t: "group", index: undefined, body };
      }
      if (pattern.startsWith("?=", at) || pattern.startsWith("?!", at)) {
        const negate = pattern[at + 1] === "!";
        at += 2;
        const body = parseAlt();
        if (pattern[at++] !== ")") fail("an unterminated lookahead");
        return { t: "look", negate, body };
      }
      if (pattern.startsWith("?<=", at) || pattern.startsWith("?<!", at))
        fail("lookbehind is not in the subset yet");
      let name: string | undefined;
      if (pattern.startsWith("?<", at)) {
        const close = pattern.indexOf(">", at);
        name = pattern.slice(at + 2, close);
        if (close < 0 || !/^[A-Za-z_$][\w$]*$/.test(name)) fail("a bad group name");
        at = close + 1;
      }
      const index = ++groups;
      names[index - 1] = name;
      const body = parseAlt();
      if (pattern[at++] !== ")") fail("an unterminated group");
      return { t: "group", index, body };
    }
    if (c === "\\") {
      at++;
      const e = peek() as string;
      if (e === "b" || e === "B") return step({ t: "boundary", negate: e === "B" });
      const set = classEscape(e);
      if (set !== undefined) return step({ t: "class", negate: false, ranges: set });
      if (/[1-9]/.test(e)) {
        const m = /^\d+/.exec(pattern.slice(at)) as RegExpExecArray;
        at += m[0].length;
        return { t: "backref", index: Number(m[0]) };
      }
      if (e === "k" && pattern[at + 1] === "<") {
        const close = pattern.indexOf(">", at);
        const ref: { t: "backref"; index: number; name?: string } = {
          t: "backref",
          index: 0,
          name: pattern.slice(at + 2, close),
        };
        at = close + 1;
        pendingNamedRefs.push({ node: ref });
        return ref;
      }
      return { t: "char", c: charEscape(false) };
    }
    if (c === "*" || c === "+" || c === "?") fail("nothing to repeat");
    if (unicode && (c === "{" || c === "}" || c === "]")) fail(`a lone ${c}`);
    return { t: "char", c: codePointAt() };
  };
  const parseSeq = (): Node => {
    const items: Node[] = [];
    for (;;) {
      const atom = parseAtom();
      if (atom === undefined) break;
      const q = parseQuantifier();
      if (q === undefined) {
        items.push(atom);
        continue;
      }
      if (
        atom.t === "bol" ||
        atom.t === "eol" ||
        atom.t === "boundary" ||
        (unicode && atom.t === "look")
      )
        fail("nothing to repeat");
      const greedy = peek() !== "?";
      if (!greedy) at++;
      items.push({ t: "repeat", min: q.min, max: q.max, greedy, body: atom });
    }
    return items.length === 1 ? (items[0] as Node) : { t: "seq", items };
  };
  const parseAlt = (): Node => {
    const alts = [parseSeq()];
    while (peek() === "|") {
      at++;
      alts.push(parseSeq());
    }
    return alts.length === 1 ? (alts[0] as Node) : { t: "alt", alts };
  };
  const node = parseAlt();
  if (at < pattern.length) fail(`an unexpected ${pattern[at]}`);
  for (const { node: ref } of pendingNamedRefs) {
    const index = names.indexOf(ref.name);
    if (index < 0) fail(`no group named ${ref.name}`);
    ref.index = index + 1;
  }
  return { node, groups, names };
}

/** The groups a node contains, by index. */
function groupsWithin(node: Node, into: number[] = []): number[] {
  if (node.t === "group" && node.index !== undefined) into.push(node.index);
  if (node.t === "seq") for (const n of node.items) groupsWithin(n, into);
  if (node.t === "alt") for (const n of node.alts) groupsWithin(n, into);
  if (node.t === "group" || node.t === "repeat" || node.t === "look") groupsWithin(node.body, into);
  return into;
}

/**
 * Whether case folding a class beyond Latin-1 could matter: some character in it (outside Latin-1)
 * whose single-character upper or lower case is outside the class. The matcher folds only Latin-1,
 * so such a class would match differently from ECMAScript; a class that holds both cases of every
 * such character (a wide range) matches the same. Very wide classes (a negation) are taken as they are.
 */
function classFoldsBeyondLatin1(ranges: readonly Range[]): boolean {
  const inClass = (c: number): boolean => ranges.some(([lo, hi]) => c >= lo && c <= hi);
  // What the matcher matches: a character, or its Latin-1 case counterpart, in the class.
  const matched = (c: number): boolean => inClass(c) || inClass(lower(c)) || inClass(upper(c));
  // ECMAScript's Canonicalize without u: toUpperCase when it is one character, and never from
  // outside ASCII into it.
  const canon = (c: number): number => {
    const u = String.fromCodePoint(c).toUpperCase();
    const cp = u.codePointAt(0) as number;
    return [...u].length !== 1 || (c >= 128 && cp < 128) ? c : cp;
  };
  let budget = 0x30000;
  for (const [lo, hi] of ranges) {
    if (hi <= 0xff) continue;
    for (let c = Math.max(lo, 0x100); c <= hi; c++) {
      if (--budget < 0) return false;
      // Every character that ECMAScript folds together with c must be matched as c is.
      const k = canon(c);
      const lowerOf = String.fromCodePoint(k).toLowerCase().codePointAt(0) as number;
      for (const x of [k, lowerOf]) if (x !== c && canon(x) === k && !matched(x)) return true;
    }
  }
  return false;
}

/** ASCII and Latin-1 simple lower-casing: the counterpart of `upper`. */
function lower(c: number): number {
  if (c >= 65 && c <= 90) return c + 32;
  if (c >= 0xc0 && c <= 0xde && c !== 0xd7) return c + 32;
  if (c === 0x178) return 0xff;
  return c;
}

/** ASCII and Latin-1 simple upper-casing: Canonicalize for the i flag, as far as this subset goes. */
function upper(c: number): number {
  if (c >= 97 && c <= 122) return c - 32;
  if (c >= 0xe0 && c <= 0xfe && c !== 0xf7) return c - 32;
  if (c === 0xff) return 0x178;
  if (c === 0xb5) return 0x39c;
  return c;
}

/**
 * The matcher's source: one function per node, in continuation-passing style. `nK(i, k)` tries node
 * K at index i and, for each way it matches up to j, asks k(j); it is true when the whole match is.
 */
export function regexMatcherSource(
  pattern: string,
  flags: string,
): { source: string; parsed: ParsedRegex } {
  const parsed = parseRegex(pattern, flags);
  const unicode = flags.includes("u");
  const fold = flags.includes("i");
  const multiline = flags.includes("m");
  const dotAll = flags.includes("s");
  if (fold) {
    // Case folding beyond Latin-1 is refused rather than done differently.
    const beyond = (n: Node): boolean =>
      n.t === "char"
        ? n.c > 0xff &&
          upper(n.c) === n.c &&
          n.c !== 0x39c &&
          n.c !== 0x178 &&
          String.fromCodePoint(n.c).toLowerCase() !== String.fromCodePoint(n.c)
        : n.t === "class"
          ? classFoldsBeyondLatin1(n.ranges)
          : n.t === "seq"
            ? n.items.some(beyond)
            : n.t === "alt"
              ? n.alts.some(beyond)
              : n.t === "group" || n.t === "repeat" || n.t === "look"
                ? beyond(n.body)
                : false;
    if (beyond(parsed.node))
      throw new RegexCompileError(
        `/${pattern}/${flags}: case folding beyond Latin-1 is not in the subset yet`,
      );
  }
  const fns: string[] = [];
  let count = 0;
  const caps = 2 * (parsed.groups + 1);
  // The code point (or code unit) at i, and its width.
  const read = unicode
    ? "const c = s.codePointAt(i); const w = c > 65535 ? 2 : 1;"
    : "const c = s.charCodeAt(i); const w = 1;";
  const canon = (c: string): string => (fold ? `up(${c})` : c);
  const rangesTest = (v: string, ranges: readonly Range[]): string =>
    ranges.length === 0
      ? "false"
      : ranges
          .map(([lo, hi]) => (lo === hi ? `${v} === ${lo}` : `(${v} >= ${lo} && ${v} <= ${hi})`))
          .join(" || ");
  const emit = (node: Node): string => {
    const name = `n${count++}`;
    let body: string;
    switch (node.t) {
      case "char": {
        const want = fold ? upper(node.c) : node.c;
        body = `if (i >= n) return false; ${read} if (${canon("c")} !== ${want}) return false; return k(i + w);`;
        break;
      }
      case "any":
        body = `if (i >= n) return false; ${read} ${dotAll ? "" : "if (c === 10 || c === 13 || c === 8232 || c === 8233) return false;"} return k(i + w);`;
        break;
      case "class": {
        let test = `(${rangesTest("c", node.ranges)})`;
        if (fold)
          test = `(${test} || ${rangesTest("lo(c)", node.ranges)} || ${rangesTest("up(c)", node.ranges)})`;
        body = `if (i >= n) return false; ${read} if (${node.negate ? "" : "!"}${test}) return false; return k(i + w);`;
        break;
      }
      case "seq": {
        if (node.items.length === 0) {
          body = "return k(i);";
          break;
        }
        const parts = node.items.map(emit);
        let chain = "k";
        for (let p = parts.length - 1; p > 0; p--)
          chain = `(j${p}) => ${parts[p]}(j${p}, ${chain})`;
        body = `return ${parts[0]}(i, ${chain});`;
        break;
      }
      case "alt":
        body = `return ${node.alts.map((a) => `${emit(a)}(i, k)`).join(" || ")};`;
        break;
      case "group": {
        const inner = emit(node.body);
        if (node.index === undefined) {
          body = `return ${inner}(i, k);`;
          break;
        }
        const s0 = 2 * node.index;
        body = `return ${inner}(i, (j) => { const qs = caps[${s0}]; const qe = caps[${s0 + 1}]; caps[${s0}] = i; caps[${s0 + 1}] = j; if (k(j)) return true; caps[${s0}] = qs; caps[${s0 + 1}] = qe; return false; });`;
        break;
      }
      case "repeat": {
        const inner = emit(node.body);
        const reset = groupsWithin(node.body);
        const save = reset
          .map(
            (g) =>
              `const a${g} = caps[${2 * g}]; const b${g} = caps[${2 * g + 1}]; caps[${2 * g}] = -1; caps[${2 * g + 1}] = -1;`,
          )
          .join(" ");
        const restore = reset
          .map((g) => `caps[${2 * g}] = a${g}; caps[${2 * g + 1}] = b${g};`)
          .join(" ");
        const max = Number.isFinite(node.max) ? String(node.max) : "-1";
        // One more iteration: its captures cleared first, restored if it fails; an empty
        // iteration once the minimum is met fails (the empty check).
        body = `return ${name}r(i, 0, k);`;
        fns.push(
          `function ${name}r(i, count, k) { if (${max} >= 0 && count >= ${max}) return k(i); const more = () => { ${save} if (${inner}(i, (j) => (j === i && count >= ${node.min} ? false : ${name}r(j, count + 1, k)))) return true; ${restore} return false; }; if (count < ${node.min}) return more(); ${node.greedy ? "return more() || k(i);" : "return k(i) || more();"} }`,
        );
        break;
      }
      case "bol":
        body = `if (i === 0${multiline ? " || lt(s.charCodeAt(i - 1))" : ""}) return k(i); return false;`;
        break;
      case "eol":
        body = `if (i === n${multiline ? " || lt(s.charCodeAt(i))" : ""}) return k(i); return false;`;
        break;
      case "boundary":
        body = `const a = i > 0 && word(s.charCodeAt(i - 1)); const b = i < n && word(s.charCodeAt(i)); if ((a !== b) === ${!node.negate}) return k(i); return false;`;
        break;
      case "look": {
        const inner = emit(node.body);
        const reset = groupsWithin(node.body);
        const restore = reset.map((g) => `caps[${2 * g}] = -1; caps[${2 * g + 1}] = -1;`).join(" ");
        body = node.negate
          ? `if (${inner}(i, (j) => true)) { ${restore} return false; } return k(i);`
          : `if (!${inner}(i, (j) => true)) return false; return k(i);`;
        break;
      }
      case "backref": {
        const s0 = 2 * node.index;
        body = `const a = caps[${s0}]; const b = caps[${s0 + 1}]; if (a < 0 || b < 0) return k(i); const len = b - a; if (i + len > n) return false; let t = 0; while (t < len) { if (${canon("s.charCodeAt(a + t)")} !== ${canon("s.charCodeAt(i + t)")}) return false; t = t + 1; } return k(i + len);`;
        break;
      }
    }
    fns.push(`function ${name}(i, k) { ${body} }`);
    return name;
  };
  const root = emit(parsed.node);
  const helpers = [
    "function lt(c) { return c === 10 || c === 13 || c === 8232 || c === 8233; }",
    "function word(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122); }",
    ...(fold
      ? [
          "function up(c) { if (c >= 97 && c <= 122) return c - 32; if (c >= 224 && c <= 254 && c !== 247) return c - 32; if (c === 255) return 376; if (c === 181) return 924; return c; }",
          "function lo(c) { if (c >= 65 && c <= 90) return c + 32; if (c >= 192 && c <= 222 && c !== 215) return c + 32; if (c === 376) return 255; return c; }",
        ]
      : []),
  ];
  const source = [
    "function f(s, start, sticky) {",
    "  const n = s.length;",
    `  const caps = [${Array(caps).fill("-1").join(", ")}];`,
    ...helpers.map((h) => `  ${h}`),
    ...fns.map((f) => `  ${f}`),
    "  let pos = start;",
    "  while (pos <= n) {",
    `    let c0 = 0; while (c0 < ${caps}) { caps[c0] = -1; c0 = c0 + 1; }`,
    "    let found = -1;",
    `    if (${root}(pos, (j) => { found = j; return true; })) { caps[0] = pos; caps[1] = found; return caps.slice(); }`,
    "    if (sticky) return null;",
    `    pos = pos + ${unicode ? "(pos < n && s.codePointAt(pos) > 65535 ? 2 : 1)" : "1"};`,
    "  }",
    "  return null;",
    "}",
  ].join("\n");
  return { source, parsed };
}

/** A regex literal's matcher, as a graph: what a lowering emits for `/pattern/flags`. */
export function regexMatcherGraph(literal: string): {
  graph: DucGraph;
  parsed: ParsedRegex;
  pattern: string;
  flags: string;
} {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(literal);
  if (m === null) throw new RegexCompileError(`${literal} is not a regex literal`);
  const pattern = m[1] as string;
  const flags = m[2] as string;
  const { source, parsed } = regexMatcherSource(pattern, flags);
  return { graph: liftAtom(source), parsed, pattern, flags };
}
