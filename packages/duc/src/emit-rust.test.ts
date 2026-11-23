// SPDX-License-Identifier: Apache-2.0
/**
 * Lowering to Rust (#1278): each source's graph lowered to Rust computes, on the same inputs, what
 * the source computes in JavaScript (conformance), built with the system's rustc and run. The cases
 * are compiled together, one module each, into one program.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMIT_CASES } from "./__fixtures__/emit-cases.js";
import { runnable } from "./__fixtures__/runnable.js";
import { graphIdentity } from "./canonical.js";
import { RUST_PRELUDE, RustEmitError, emitRust } from "./emit-rust.js";
import { emitTypeScript } from "./emit-ts.js";
import { liftAtom } from "./lift.js";
import { raiseRust } from "./raise-rust.js";

/** Reads `case<TAB>json args` lines, prints each result as JSON (a value, or what was thrown). */
const DRIVER = String.raw`
struct P<'a> { s: &'a [u8], i: usize }
impl<'a> P<'a> {
    fn ws(&mut self) { while self.i < self.s.len() && (self.s[self.i] as char).is_whitespace() { self.i += 1; } }
    fn value(&mut self) -> V {
        self.ws();
        let c = self.s[self.i] as char;
        match c {
            '[' => {
                self.i += 1; let mut items = Vec::new(); self.ws();
                if self.s[self.i] == b']' { self.i += 1; return arr(items); }
                loop { items.push(self.value()); self.ws(); let d = self.s[self.i]; self.i += 1; if d == b']' { break; } }
                arr(items)
            }
            '{' => {
                self.i += 1; let mut es = Vec::new(); self.ws();
                if self.s[self.i] == b'}' { self.i += 1; return obj(es); }
                loop {
                    self.ws(); let k = match self.value() { V::Str(t) => t.to_string(), _ => panic!("key") };
                    self.ws(); self.i += 1; let v = self.value(); es.push(Entry::Key(k, v));
                    self.ws(); let d = self.s[self.i]; self.i += 1; if d == b'}' { break; }
                }
                obj(es)
            }
            '"' => {
                self.i += 1; let mut out = String::new();
                loop {
                    let ch = self.s[self.i] as char; self.i += 1;
                    if ch == '"' { break; }
                    if ch == '\\' {
                        let e = self.s[self.i] as char; self.i += 1;
                        match e {
                            'n' => out.push('\n'), 't' => out.push('\t'), 'r' => out.push('\r'),
                            'u' => { let h = std::str::from_utf8(&self.s[self.i..self.i + 4]).unwrap(); self.i += 4; out.push(char::from_u32(u32::from_str_radix(h, 16).unwrap()).unwrap_or('?')); }
                            other => out.push(other),
                        }
                    } else {
                        let start = self.i - 1; let mut end = self.i;
                        while end < self.s.len() && (self.s[end] & 0xC0) == 0x80 { end += 1; }
                        out.push_str(std::str::from_utf8(&self.s[start..end]).unwrap()); self.i = end;
                    }
                }
                s(&out)
            }
            't' => { self.i += 4; B(true) }
            'f' => { self.i += 5; B(false) }
            'n' => { self.i += 4; V::Null }
            _ => {
                let start = self.i;
                while self.i < self.s.len() && "+-.0123456789eE".contains(self.s[self.i] as char) { self.i += 1; }
                n(std::str::from_utf8(&self.s[start..self.i]).unwrap().parse().unwrap())
            }
        }
    }
}

fn quote(t: &str) -> String {
    let mut o = String::from("\"");
    for c in t.chars() {
        match c { '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"), '\n' => o.push_str("\\n"), c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)), c => o.push(c) }
    }
    o.push('"'); o
}

fn encode(x: &V) -> String {
    match x {
        V::Undef => "{\"$undefined\":true}".to_string(),
        V::Null => "null".to_string(),
        V::Bool(b) => b.to_string(),
        V::Num(f) => if f.is_finite() { num_str(*f) } else { "null".to_string() },
        V::Str(t) => quote(t),
        V::Arr(a) => format!("[{}]", a.borrow().iter().map(encode).collect::<Vec<_>>().join(",")),
        V::Obj(o) => { let o = o.borrow(); format!("{{{}}}", o.keys.iter().map(|k| format!("{}:{}", quote(k), encode(&o.vals[k]))).collect::<Vec<_>>().join(",")) }
        _ => "null".to_string(),
    }
}

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let mut input = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut input).unwrap();
    for line in input.lines() {
        let (case, json) = line.split_once('\t').unwrap();
        let args = match (P { s: json.as_bytes(), i: 0 }).value() { V::Arr(a) => a.borrow().clone(), _ => vec![] };
        let f = CASES[case.parse::<usize>().unwrap()];
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(args))) {
            Ok(v) => println!("{{\"value\":{}}}", encode(&v)),
            Err(p) => {
                let t = take_thrown(p);
                let msg = match &t { V::Err(e) => format!("{}: {}", e.kind, e.message), other => str_of(other) };
                println!("{{\"threw\":{}}}", quote(&msg));
            }
        }
    }
}
`;

function runRust(codes: readonly string[], inputs: readonly [number, unknown[]][]): unknown[] {
  const dir = mkdtempSync(join(tmpdir(), "duc-rust-"));
  const modules = codes.map((code, i) => `mod case${i} {\n    use super::*;\n${code}\n}`);
  const table = `const CASES: [fn(Vec<V>) -> V; ${codes.length}] = [${codes.map((_, i) => `case${i}::f`).join(", ")}];`;
  writeFileSync(
    join(dir, "main.rs"),
    `${RUST_PRELUDE}\n${modules.join("\n")}\n${table}\n${DRIVER}`,
  );
  execFileSync(
    "rustc",
    ["--edition", "2021", "-O", "-o", join(dir, "prog"), join(dir, "main.rs")],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const out = execFileSync(join(dir, "prog"), {
    input: inputs.map(([c, a]) => `${c}\t${JSON.stringify(a)}`).join("\n"),
    encoding: "utf8",
  });
  return out
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as unknown);
}

const UNDEF = { $undefined: true };
const toJson = (x: unknown): unknown => {
  if (x === undefined) return UNDEF;
  if (Array.isArray(x)) return x.map(toJson);
  if (x !== null && typeof x === "object")
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, toJson(v)]));
  if (typeof x === "number" && !Number.isFinite(x)) return null;
  return x;
};

function runJs(source: string, args: unknown[]): unknown {
  const code = emitTypeScript(liftAtom(source));
  const f = new Function(`${runnable(code)}; return f;`)() as (...a: unknown[]) => unknown;
  try {
    return { value: toJson(f(...structuredClone(args))) };
  } catch (e) {
    return { threw: `${(e as Error).name}: ${(e as Error).message}` };
  }
}

const rustc = (() => {
  try {
    execFileSync("rustc", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

const MORE: [string, string, unknown[][]][] = [
  [
    "string methods",
    "export function f(s: string) { return s.trim().toUpperCase() + s.indexOf('b') + s.slice(1, 3); }",
    [["  abc "], ["b"]],
  ],
  [
    "remainder, division and number formatting",
    "export function f(a: number, b: number) { return [a % b, a / b, -a % b, '' + a / b]; }",
    [
      [7, 3],
      [7, 0],
      [-7, 2],
      [1, 3e7],
    ],
  ],
  [
    "strict equality and truthiness",
    "export function f(x: unknown) { return [x === 0, x === '0', !x, x ?? 'none']; }",
    [[0], ["0"], [""], [null]],
  ],
  [
    "a closure",
    "export function f(k: number) { const add = (y: number) => y + k; return add(1) * add(2); }",
    [[0], [3]],
  ],
  [
    "break and continue",
    "export function f(n: number) { let s = 0; for (let i = 0; i < n; i = i + 1) { if (i % 2 === 0) continue; if (s > 10) break; s = s + i; } return s; }",
    [[0], [7], [30]],
  ],
  [
    "a throw on some paths",
    "export function f(x: number) { if (x < 0) throw new RangeError('negative'); return Math.floor(x / 2); }",
    [[5], [-1]],
  ],
  [
    "a switch",
    "export function f(k: string) { switch (k) { case 'a': return 1; case 'b': case 'c': return 2; default: return 3; } }",
    [["a"], ["c"], ["z"]],
  ],
  [
    "map, filter and reduce",
    "export function f(xs: number[]) { return xs.map((x) => x * 2).filter((x) => x > 2).reduce((a, b) => a + b, 0); }",
    [[[1, 2, 3]], [[]]],
  ],
  [
    "bitwise operators",
    "export function f(a: number, b: number) { return [a & b, a | b, a ^ b, a << b, a >> b, a >>> b, ~a]; }",
    [
      [5, 3],
      [-9, 2],
      [4294967297, 33],
    ],
  ],
  [
    "try, catch and finally",
    "export function f(x: any) { let log = []; try { if (x) throw new Error('boom'); log.push('ok'); } catch (e) { log.push(e.message); } finally { log.push('done'); } return log; }",
    [[0], [1]],
  ],
  [
    "regular expressions",
    "export function f(s: string) { return [/^a+b/.test(s), s.replace(/a(b)/g, '[$1]'), s.replace('a', '$$'), s.match(/(a)(x)?/), s.match(/a/g), /^[\\w.]+@(?:x|y)\\.com$/i.test(s), s.replace(/\\b(\\w)(\\w*)/g, (m: string, h: string, t: string) => h.toUpperCase() + t)]; }",
    [["aab"], ["xabab"], [""], ["Jo.e@Y.COM"], ["hello big world"]],
  ],
  [
    "a regular expression made at run time",
    "export function f(p: string, s: string) { return new RegExp(p, 'g').test(s) && s.replace(new RegExp(p, 'g'), '_'); }",
    [
      ["a.", "xabyacz"],
      ["q", "abc"],
    ],
  ],
  [
    "a read of a property of undefined throws a TypeError",
    "export function f(o: any) { return o.a.b; }",
    [[{ a: { b: 1 } }], [{}]],
  ],
];

describe.skipIf(!rustc)("lowering to Rust: conformance (#1278)", () => {
  const cases = [
    ...EMIT_CASES.map((c) => [c.name, c.source, c.args] as const),
    ...MORE.map(([name, source, args]) => [name, source, args] as const),
  ];
  // Each case's Rust, or the reason Rust refuses it.
  const lowered = cases.map(([, source]) => {
    try {
      return emitRust(liftAtom(source));
    } catch (e) {
      if (e instanceof RustEmitError) return e;
      throw e;
    }
  });
  const codes = lowered.filter((x): x is string => typeof x === "string");
  const at = new Map<number, number>();
  lowered.forEach((x, i) => {
    if (typeof x === "string") at.set(i, at.size);
  });
  const inputs: [number, unknown[]][] = [];
  cases.forEach(([, , args], i) => {
    const k = at.get(i);
    if (k !== undefined) for (const a of args) inputs.push([k, a as unknown[]]);
  });
  let results: unknown[] | undefined;
  const resultsFor = (i: number): unknown[] => {
    results ??= runRust(codes, inputs);
    const k = at.get(i) as number;
    let offset = 0;
    for (const [c] of inputs) {
      if (c === k) break;
      offset++;
    }
    return results.slice(offset, offset + (cases[i]?.[2].length ?? 0));
  };

  it("lowers every case", () => {
    const refused = lowered.flatMap((x, i) =>
      x instanceof RustEmitError ? [`${cases[i]?.[0]}: ${x.message}`] : [],
    );
    expect(refused).toEqual([]);
  });

  cases.forEach(([name, source, args], i) => {
    it.skipIf(!at.has(i))(
      `computes what the source computes: ${name}`,
      { timeout: 300_000 },
      () => {
        expect(resultsFor(i), lowered[i] as string).toEqual(
          args.map((a) => runJs(source, a as unknown[])),
        );
      },
    );
  });
});

describe("lowering to Rust: refusals (#1278)", () => {
  it("an unknown method is refused with a reason", () => {
    expect(() =>
      emitRust(
        liftAtom("export function f(xs: number[]) { return xs.reduceRight((a, b) => a + b, 0); }"),
      ),
    ).toThrow(RustEmitError);
  });
});

describe("raising the Rust lowering: round trip (#1278)", () => {
  const cases = [
    ...EMIT_CASES.map((c) => [c.name, c.source] as const),
    ...MORE.map(([name, source]) => [name, source] as const),
    [
      "operations the lowering keeps apart",
      "export function f(o: any, xs: number[], k: string) { let n = 0; n += xs.length; n++; const t = `a${n}b`; o.k = t; o[k] = n; const e = new Error('x'); const c = Error('y'); return [o?.k, xs?.[0], (0, o.g)?.(1), String(n), n.toString(16), Object.freeze(o), void n, (n, k), Math.pow(n, 2), n ** 2, /a+b/gi.test(k), e, c]; }",
    ] as const,
    ["an unread free name, and nothing returned", "const g = strict ? a : b;"] as const,
  ];
  for (const [name, source] of cases) {
    it(`lowers, raises and lifts to the same identity: ${name}`, () => {
      const g = liftAtom(source);
      const rust = emitRust(g);
      const ts = raiseRust(rust);
      expect(graphIdentity(liftAtom(ts)), `${rust}\n${ts}`).toBe(graphIdentity(g));
    });
  }
});
