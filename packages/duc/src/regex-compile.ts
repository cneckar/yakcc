// SPDX-License-Identifier: Apache-2.0
/**
 * Regular expression literals for the bytecode lowerings (#1311): a pattern compiled, as the
 * lowering runs, to a program of a backtracking matcher that a runtime atom runs
 * (`__ykReRun`, `regex-atoms.ts`). The matcher follows ECMA-262 22.2.2's semantics: alternatives
 * and quantifiers tried in order (greedy or lazy), a quantified atom's captures reset at each
 * iteration, an iteration past the minimum that matches the empty string a failure, lookaheads
 * atomic, and a backreference to a group that did not participate the empty string.
 *
 * The subset is exact or refused: no `u`, `v` or `d` flag, no lookbehind, no named groups, no
 * modifiers; with `i`, only patterns whose characters are ASCII (an input character is then
 * canonicalized only when it is ASCII: Canonicalize never maps a non-ASCII character to an ASCII
 * one) and no backreferences; and none of Annex B's ambiguous forms (an octal escape, `{` not a
 * quantifier, an identity escape of a letter or digit, a class escape as a range's end).
 */

/** A pattern outside the subset, with the reason. */
export class RegexError extends Error {}

/**
 * The matcher's instructions; each is its opcode then its operands (pcs absolute). A program starts
 * with a header of five numbers (groups, registers, i, g, y); its code at 5.
 */
export const CODE_START = 5;
export const OP = {
  /** CHAR c: the code unit c (canonical, with i). */
  char: 0,
  /** CLASS n lo hi...: a code unit in one of n inclusive ranges (canonical ASCII, with i). */
  cls: 1,
  /** NCLASS n lo hi...: a code unit in none of them. */
  ncls: 2,
  /** A code unit that is not a line terminator. */
  anyNoNl: 3,
  /** Any code unit. */
  any: 4,
  /** SPLIT a b: a, and on failure b. */
  split: 5,
  /** JMP a. */
  jmp: 6,
  /** SAVE k: capture slot k is the position. */
  save: 7,
  /** RESET k0 k1: capture slots k0..k1 undefined (a quantified atom's, at each iteration). */
  reset: 8,
  /** SETREG r: register r is the position (an iteration's start). */
  setReg: 9,
  /** CHECK r: fail if the position is register r's (an empty iteration past the minimum). */
  check: 10,
  bol: 11,
  eol: 12,
  /** ^ and $ with m: also after and before a line terminator. */
  mbol: 13,
  meol: 14,
  wordB: 15,
  notWordB: 16,
  /** BACKREF n: what group n matched, or nothing if it did not participate. */
  backref: 17,
  match: 18,
  /** LOOK neg len: the lookahead's program (len slots, ending in MATCH) follows. */
  look: 19,
} as const;

/** A compiled pattern: its program, its count of capture groups and registers, and its flags. */
export interface CompiledRegex {
  readonly program: readonly number[];
  readonly groups: number;
  readonly registers: number;
  readonly global: boolean;
  readonly sticky: boolean;
  readonly ignoreCase: boolean;
}

type Range = [number, number];
type Node =
  | { k: "char"; c: number }
  | { k: "class"; ranges: Range[]; negate: boolean }
  | { k: "dot" }
  | { k: "seq"; items: Node[] }
  | { k: "alt"; alts: Node[] }
  | { k: "group"; index: number | undefined; body: Node }
  | { k: "look"; negate: boolean; body: Node }
  | { k: "assert"; what: "bol" | "eol" | "wordB" | "notWordB" }
  | { k: "backref"; n: number }
  | { k: "repeat"; body: Node; min: number; max: number; greedy: boolean };

const DIGIT: Range[] = [[48, 57]];
const WORD: Range[] = [
  [48, 57],
  [65, 90],
  [95, 95],
  [97, 122],
];
// WhiteSpace and LineTerminator (ECMA-262 12.2, 12.3): TAB, VT, FF, SP, NBSP, ZWNBSP, the Zs
// category, and LF, CR, LS, PS.
const SPACE: Range[] = [
  [9, 13],
  [32, 32],
  [160, 160],
  [5760, 5760],
  [8192, 8202],
  [8232, 8233],
  [8239, 8239],
  [8287, 8287],
  [12288, 12288],
  [65279, 65279],
];

function normalize(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}
function complement(ranges: Range[]): Range[] {
  const out: Range[] = [];
  let next = 0;
  for (const [lo, hi] of normalize(ranges)) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= 0xffff) out.push([next, 0xffff]);
  return out;
}
/** A class's ranges with i: the ASCII part canonical (a-z as A-Z), the rest as it is. */
function canonicalRanges(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const [lo, hi] of normalize(ranges)) {
    for (let c = lo; c <= Math.min(hi, 127); c++) {
      const u = c >= 97 && c <= 122 ? c - 32 : c;
      out.push([u, u]);
    }
    if (hi > 127) out.push([Math.max(lo, 128), hi]);
  }
  return normalize(out);
}

class Parser {
  private i = 0;
  groupCount = 0;
  constructor(
    private readonly src: string,
    private readonly totalGroups: number,
    private readonly ignoreCase: boolean,
  ) {}

  parse(): Node {
    const n = this.disjunction();
    if (this.i < this.src.length) throw new RegexError(`an unmatched ")" in /${this.src}/`);
    return n;
  }
  private peek(): string | undefined {
    return this.src[this.i];
  }
  private eat(s: string): boolean {
    if (this.src.startsWith(s, this.i)) {
      this.i += s.length;
      return true;
    }
    return false;
  }
  private disjunction(): Node {
    const alts = [this.alternative()];
    while (this.eat("|")) alts.push(this.alternative());
    return alts.length === 1 ? (alts[0] as Node) : { k: "alt", alts };
  }
  private alternative(): Node {
    const items: Node[] = [];
    while (this.i < this.src.length && this.peek() !== "|" && this.peek() !== ")")
      items.push(this.term());
    return { k: "seq", items };
  }
  private term(): Node {
    const c = this.peek();
    if (this.eat("^")) return { k: "assert", what: "bol" };
    if (this.eat("$")) return { k: "assert", what: "eol" };
    if (this.eat("\\b")) return { k: "assert", what: "wordB" };
    if (this.eat("\\B")) return { k: "assert", what: "notWordB" };
    if (this.eat("(?=") || this.eat("(?!")) {
      const negate = this.src[this.i - 1] === "!";
      const body = this.disjunction();
      if (!this.eat(")")) throw new RegexError("an unterminated lookahead");
      if (this.quantifierAhead())
        throw new RegexError("a quantified lookahead (Annex B) is not in the subset");
      return { k: "look", negate, body };
    }
    if (c === "*" || c === "+" || c === "?")
      throw new RegexError(`nothing to repeat in /${this.src}/`);
    const atom = this.atom();
    return this.quantified(atom);
  }
  private quantifierAhead(): boolean {
    const c = this.peek();
    return c === "*" || c === "+" || c === "?" || (c === "{" && this.braces() !== undefined);
  }
  /** A {n}, {n,} or {n,m} quantifier at the position, without consuming it. */
  private braces(): { min: number; max: number; len: number } | undefined {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.i));
    if (m === null) return undefined;
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] === "" ? Number.POSITIVE_INFINITY : Number(m[3]);
    return { min, max, len: m[0].length };
  }
  private quantified(atom: Node): Node {
    let min: number;
    let max: number;
    if (this.eat("*")) [min, max] = [0, Number.POSITIVE_INFINITY];
    else if (this.eat("+")) [min, max] = [1, Number.POSITIVE_INFINITY];
    else if (this.eat("?")) [min, max] = [0, 1];
    else {
      const b = this.peek() === "{" ? this.braces() : undefined;
      if (b === undefined) return atom;
      this.i += b.len;
      [min, max] = [b.min, b.max];
      if (max < min) throw new RegexError("numbers out of order in a {} quantifier");
    }
    const greedy = !this.eat("?");
    return { k: "repeat", body: atom, min, max, greedy };
  }
  private atom(): Node {
    const c = this.peek() as string;
    if (this.eat(".")) return { k: "dot" };
    if (this.eat("(?:")) {
      const body = this.disjunction();
      if (!this.eat(")")) throw new RegexError("an unterminated group");
      return { k: "group", index: undefined, body };
    }
    if (this.src.startsWith("(?", this.i))
      throw new RegexError(
        "lookbehind, named groups and modifiers are not in the subset of regular expressions yet",
      );
    if (this.eat("(")) {
      const index = ++this.groupCount;
      const body = this.disjunction();
      if (!this.eat(")")) throw new RegexError("an unterminated group");
      return { k: "group", index, body };
    }
    if (this.eat("[")) return this.cls();
    if (c === "\\") return this.atomEscape();
    if (c === "{") throw new RegexError("a { that is not a quantifier (Annex B) is not in the subset");
    this.i++;
    return this.char(c.charCodeAt(0));
  }
  private char(code: number): Node {
    if (this.ignoreCase && code > 127)
      throw new RegexError("a non-ASCII character with the i flag is not in the subset yet");
    return { k: "char", c: this.ignoreCase && code >= 97 && code <= 122 ? code - 32 : code };
  }
  private atomEscape(): Node {
    this.i++;
    const c = this.peek();
    if (c === undefined) throw new RegexError("\\ at the end of a pattern");
    const set = this.classEscape();
    if (set !== undefined) return { k: "class", ranges: set, negate: false };
    if (/[1-9]/.test(c)) {
      const m = /^\d+/.exec(this.src.slice(this.i)) as RegExpExecArray;
      const n = Number(m[0]);
      if (n > this.totalGroups)
        throw new RegexError("an octal or identity escape (Annex B) is not in the subset");
      if (this.ignoreCase)
        throw new RegexError("a backreference with the i flag is not in the subset yet");
      this.i += m[0].length;
      return { k: "backref", n };
    }
    return this.char(this.characterEscape());
  }
  /** \d \D \s \S \w \W, as ranges; undefined for any other escape (not consumed). */
  private classEscape(): Range[] | undefined {
    const c = this.peek();
    const sets: Record<string, Range[]> = {
      d: DIGIT,
      D: complement(DIGIT),
      s: SPACE,
      S: complement(SPACE),
      w: WORD,
      W: complement(WORD),
    };
    const set = c === undefined ? undefined : sets[c];
    if (set !== undefined) this.i++;
    return set;
  }
  /** A CharacterEscape (after the \): its code unit. */
  private characterEscape(): number {
    const c = this.peek() as string;
    const simple: Record<string, number> = { t: 9, n: 10, v: 11, f: 12, r: 13 };
    if (simple[c] !== undefined) {
      this.i++;
      return simple[c] as number;
    }
    if (c === "c") {
      const l = this.src[this.i + 1];
      if (l === undefined || !/[A-Za-z]/.test(l))
        throw new RegexError("\\c without a letter (Annex B) is not in the subset");
      this.i += 2;
      return l.charCodeAt(0) % 32;
    }
    if (c === "0") {
      if (/[0-9]/.test(this.src[this.i + 1] ?? ""))
        throw new RegexError("an octal escape (Annex B) is not in the subset");
      this.i++;
      return 0;
    }
    if (c === "x") {
      const m = /^x([0-9A-Fa-f]{2})/.exec(this.src.slice(this.i));
      if (m === null) throw new RegexError("\\x without two hex digits (Annex B) is not in the subset");
      this.i += 3;
      return Number.parseInt(m[1] as string, 16);
    }
    if (c === "u") {
      const m = /^u([0-9A-Fa-f]{4})/.exec(this.src.slice(this.i));
      if (m === null) throw new RegexError("\\u without four hex digits (Annex B) is not in the subset");
      this.i += 5;
      return Number.parseInt(m[1] as string, 16);
    }
    if (/[A-Za-z0-9]/.test(c))
      throw new RegexError(`the escape \\${c} (Annex B's identity escape) is not in the subset`);
    // An identity escape of a character that is not a letter or digit: the character.
    this.i++;
    return c.charCodeAt(0);
  }
  private cls(): Node {
    const negate = this.eat("^");
    const ranges: Range[] = [];
    while (!this.eat("]")) {
      if (this.i >= this.src.length) throw new RegexError("an unterminated character class");
      const lo = this.classAtom();
      if (this.peek() === "-" && this.src[this.i + 1] !== "]" && this.i + 1 < this.src.length) {
        this.i++;
        const hi = this.classAtom();
        if (typeof lo !== "number" || typeof hi !== "number")
          throw new RegexError("a class escape as a range's end (Annex B) is not in the subset");
        if (hi < lo) throw new RegexError("a range out of order in a character class");
        if (this.ignoreCase && hi > 127)
          throw new RegexError("a non-ASCII character with the i flag is not in the subset yet");
        ranges.push([lo, hi]);
      } else if (typeof lo === "number") {
        if (this.ignoreCase && lo > 127)
          throw new RegexError("a non-ASCII character with the i flag is not in the subset yet");
        ranges.push([lo, lo]);
      } else ranges.push(...lo);
    }
    return { k: "class", ranges: normalize(ranges), negate };
  }
  /** A class's atom: a code unit, or a class escape's ranges. */
  private classAtom(): number | Range[] {
    const c = this.peek() as string;
    if (c !== "\\") {
      this.i++;
      return c.charCodeAt(0);
    }
    this.i++;
    const set = this.classEscape();
    if (set !== undefined) return set;
    const e = this.peek();
    if (e === "b") {
      this.i++;
      return 8;
    }
    if (e === "-") {
      this.i++;
      return 45;
    }
    if (e !== undefined && /[1-9]/.test(e))
      throw new RegexError("an octal escape in a class (Annex B) is not in the subset");
    return this.characterEscape();
  }
}

/** The count of capture groups in a pattern (for deciding \n's meaning, as the parse does). */
function countGroups(src: string): number {
  let n = 0;
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (inClass) inClass = c !== "]";
    else if (c === "[") inClass = true;
    else if (c === "(" && src[i + 1] !== "?") n++;
  }
  return n;
}

/** The capture groups a node contains, as a range of group indices [first, last]. */
function groupsIn(n: Node): [number, number] | undefined {
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  const walk = (x: Node): void => {
    if (x.k === "group") {
      if (x.index !== undefined) {
        lo = Math.min(lo, x.index);
        hi = Math.max(hi, x.index);
      }
      walk(x.body);
    } else if (x.k === "seq") x.items.forEach(walk);
    else if (x.k === "alt") x.alts.forEach(walk);
    else if (x.k === "look" || x.k === "repeat") walk(x.body);
  };
  walk(n);
  return hi === 0 ? undefined : [lo, hi];
}

/** The most instructions a pattern may compile to (a {n,m} is written out n..m times). */
const MAX_PROGRAM = 20000;

/** Compile a regular expression literal (`/pattern/flags`). */
export function compileRegex(literal: string): CompiledRegex {
  const end = literal.lastIndexOf("/");
  const src = literal.slice(1, end);
  const flags = literal.slice(end + 1);
  for (const f of flags)
    if (!"gimsy".includes(f))
      throw new RegexError(`the regular expression flag ${f} is not in the subset yet`);
  const ignoreCase = flags.includes("i");
  const multiline = flags.includes("m");
  const dotAll = flags.includes("s");
  const parser = new Parser(src, countGroups(src), ignoreCase);
  const tree = parser.parse();
  // The header: the counts of groups and registers, and the i, g and y flags (filled in last).
  const prog: number[] = [0, 0, 0, 0, 0];
  let registers = 0;
  const emit = (...xs: number[]): number => {
    prog.push(...xs);
    if (prog.length > MAX_PROGRAM) throw new RegexError("a regular expression too large to write out");
    return prog.length - xs.length;
  };
  const gen = (n: Node): void => {
    switch (n.k) {
      case "char":
        emit(OP.char, n.c);
        return;
      case "class": {
        const rs = ignoreCase ? canonicalRanges(n.ranges) : normalize(n.ranges);
        emit(n.negate ? OP.ncls : OP.cls, rs.length, ...rs.flat());
        return;
      }
      case "dot":
        emit(dotAll ? OP.any : OP.anyNoNl);
        return;
      case "seq":
        n.items.forEach(gen);
        return;
      case "alt": {
        // SPLIT a1, next; a1; JMP end; next: SPLIT a2, next2; ...
        const jumps: number[] = [];
        n.alts.forEach((a, i) => {
          if (i < n.alts.length - 1) {
            const s = emit(OP.split, 0, 0);
            prog[s + 1] = prog.length;
            gen(a);
            jumps.push(emit(OP.jmp, 0));
            prog[s + 2] = prog.length;
          } else gen(a);
        });
        for (const j of jumps) prog[j + 1] = prog.length;
        return;
      }
      case "group":
        if (n.index === undefined) gen(n.body);
        else {
          emit(OP.save, 2 * n.index);
          gen(n.body);
          emit(OP.save, 2 * n.index + 1);
        }
        return;
      case "look": {
        const at = emit(OP.look, n.negate ? 1 : 0, 0);
        gen(n.body);
        emit(OP.match);
        prog[at + 2] = prog.length - (at + 3);
        return;
      }
      case "assert": {
        const ops = {
          bol: multiline ? OP.mbol : OP.bol,
          eol: multiline ? OP.meol : OP.eol,
          wordB: OP.wordB,
          notWordB: OP.notWordB,
        };
        emit(ops[n.what]);
        return;
      }
      case "backref":
        emit(OP.backref, n.n);
        return;
      case "repeat": {
        const groups = groupsIn(n.body);
        const reset = (): void => {
          if (groups !== undefined) emit(OP.reset, 2 * groups[0], 2 * groups[1] + 2);
        };
        // The mandatory iterations: each resets its captures; none is checked for emptiness.
        for (let k = 0; k < n.min; k++) {
          reset();
          gen(n.body);
        }
        if (n.max === n.min) return;
        const r = registers++;
        // An optional iteration: tried first if greedy; one that matches empty fails.
        const optional = (): number => {
          const s = emit(OP.split, 0, 0);
          reset();
          emit(OP.setReg, r);
          gen(n.body);
          emit(OP.check, r);
          return s;
        };
        if (n.max === Number.POSITIVE_INFINITY) {
          const s = optional();
          emit(OP.jmp, s);
          const exit = prog.length;
          if (n.greedy) {
            prog[s + 1] = s + 3;
            prog[s + 2] = exit;
          } else {
            prog[s + 1] = exit;
            prog[s + 2] = s + 3;
          }
          return;
        }
        const splits: number[] = [];
        for (let k = n.min; k < n.max; k++) splits.push(optional());
        const exit = prog.length;
        for (const s of splits) {
          if (n.greedy) {
            prog[s + 1] = s + 3;
            prog[s + 2] = exit;
          } else {
            prog[s + 1] = exit;
            prog[s + 2] = s + 3;
          }
        }
        return;
      }
    }
  };
  gen(tree);
  emit(OP.save, 1);
  emit(OP.match);
  prog[0] = parser.groupCount;
  prog[1] = registers;
  prog[2] = ignoreCase ? 1 : 0;
  prog[3] = flags.includes("g") ? 1 : 0;
  prog[4] = flags.includes("y") ? 1 : 0;
  return {
    program: prog,
    groups: parser.groupCount,
    registers,
    global: flags.includes("g"),
    sticky: flags.includes("y"),
    ignoreCase,
  };
}
