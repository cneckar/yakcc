// SPDX-License-Identifier: Apache-2.0
/**
 * Differential testing of lowerings against the TypeScript reference (#1299). A graph lowered to a
 * target is run on generated inputs, and each result is compared with what `emitTypeScript` of the
 * same graph computes, exactly.
 *
 * Exactness is carried by one canonical encoding that every driver prints byte for byte:
 * - a number is its float64 bits (`{"$n":"<16 hex>"}`, NaN canonical), so equal text is
 *   `Object.is` (NaN equals NaN, 0 and -0 differ). A Python integer a float64 cannot hold exactly
 *   is `{"$big":…}`, which equals nothing JavaScript computes;
 * - a string is its UTF-16 code units (`{"$s":[…]}`), JavaScript's own string model;
 * - an object is its entries in order (`{"$o":[[k,v],…]}`), arrays are arrays, `undefined` is
 *   `{"$u":1}`, a function `{"$f":1}`, an Error `{"$e":<"name: message">}`;
 * - a result is `{"v":…}`, a thrown value `{"t":…}`; a host failure that is not a JavaScript throw
 *   is `{"crash":…}` and never equals the reference.
 * Inputs reach the drivers as JSON with numbers as `{"$n":…}` and undefined as `{"$u":1}`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PY_PRELUDE } from "../emit-py.js";
import { emitTypeScript } from "../emit-ts.js";
import { GO_PRELUDE } from "../go-prelude.js";
import { RUST_PRELUDE } from "../rust-prelude.js";
import type { DucGraph } from "../types.js";
import { runnable } from "./runnable.js";

// ---------------------------------------------------------------------------------------------
// Input generation
// ---------------------------------------------------------------------------------------------

/** An input type: what the generator draws a value of. */
export type InputSpec =
  | "num"
  | "int"
  | "idx"
  | "byte"
  | "bool"
  | "str"
  | "any"
  | { readonly str: string; readonly max: number }
  | { readonly lit: readonly unknown[] }
  | { readonly arr: InputSpec; readonly max: number }
  | { readonly obj: Readonly<Record<string, InputSpec>>; readonly opt?: readonly string[] }
  | { readonly opt: InputSpec }
  | { readonly union: readonly InputSpec[] };

const NUM_EDGES = [
  0,
  -0,
  1,
  -1,
  0.5,
  -2.5,
  3,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  2 ** 53,
  2 ** 53 + 2,
  2 ** 31,
  1e21,
  1e-7,
  0.1 + 0.2,
  123.456,
  Number.MAX_VALUE,
  5e-324,
  -1e300,
];
const INT_EDGES = [0, 1, -1, 2, 7, 10, 100, -100, 2 ** 31 - 1, 2 ** 31, 2 ** 53];

/** mulberry32: a small seeded generator, so the inputs are the same on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)] as T;
}

function genString(r: () => number, alphabet: string, max: number): string {
  const chars = [...alphabet];
  const n = Math.floor(r() * (max + 1));
  let s = "";
  for (let i = 0; i < n; i++) s += pick(r, chars);
  return s;
}

function gen(spec: InputSpec, r: () => number, depth = 0): unknown {
  if (spec === "num")
    return r() < 0.5 ? pick(r, NUM_EDGES) : (r() - 0.5) * 10 ** Math.floor(r() * 8);
  if (spec === "int") return r() < 0.4 ? pick(r, INT_EDGES) : Math.floor((r() - 0.5) * 2000);
  if (spec === "idx") return r() < 0.15 ? pick(r, [-1, 100]) : Math.floor(r() * 12);
  if (spec === "byte") return Math.floor(r() * 256);
  if (spec === "bool") return r() < 0.5;
  if (spec === "str") return genString(r, "ab Z0é😀\n", 8);
  if (spec === "any") {
    const k = Math.floor(r() * (depth > 1 ? 5 : 8));
    if (k === 0) return null;
    if (k === 1) return undefined;
    if (k === 2) return gen("num", r);
    if (k === 3) return gen("str", r);
    if (k === 4) return gen("bool", r);
    if (k === 5) return Array.from({ length: Math.floor(r() * 3) }, () => gen("any", r, depth + 1));
    const o: Record<string, unknown> = {};
    for (const key of ["code", "a", "artifacts"])
      if (r() < 0.4)
        o[key] = gen(key === "code" ? { lit: ["ENOENT", "EPERM"] } : "any", r, depth + 1);
    return o;
  }
  if ("str" in spec) return genString(r, spec.str, spec.max);
  if ("lit" in spec) return pick(r, spec.lit);
  if ("arr" in spec)
    return Array.from({ length: Math.floor(r() * (spec.max + 1)) }, () =>
      gen(spec.arr, r, depth + 1),
    );
  if ("obj" in spec) {
    const o: Record<string, unknown> = {};
    for (const [k, s] of Object.entries(spec.obj)) {
      if (spec.opt?.includes(k) === true && r() < 0.3) continue;
      o[k] = gen(s, r, depth + 1);
    }
    return o;
  }
  if ("opt" in spec) return r() < 0.3 ? undefined : gen(spec.opt, r, depth);
  return gen(pick(r, spec.union), r, depth);
}

/** `count` distinct argument lists for `specs`; trailing undefined arguments are left out. */
export function generateInputs(specs: readonly InputSpec[], seed: number, count = 40): unknown[][] {
  const r = rng(seed);
  const out: unknown[][] = [];
  const seen = new Set<string>();
  for (let tries = 0; out.length < count && tries < count * 20; tries++) {
    const args = specs.map((s) => gen(s, r));
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
    const key = encodeInput(args);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(args);
  }
  return out;
}

/** A stable seed from a name. */
export function seedOf(name: string): number {
  let h = 2166136261;
  for (const c of name) h = Math.imul(h ^ (c.codePointAt(0) ?? 0), 16777619);
  return h >>> 0;
}

// ---------------------------------------------------------------------------------------------
// Encodings
// ---------------------------------------------------------------------------------------------

function bitsOf(x: number): string {
  if (Number.isNaN(x)) return "7ff8000000000000";
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  return v.getBigUint64(0).toString(16).padStart(16, "0");
}

export function numberOfBits(hex: string): number {
  const v = new DataView(new ArrayBuffer(8));
  v.setBigUint64(0, BigInt(`0x${hex}`));
  return v.getFloat64(0);
}

const units = (s: string): number[] => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

/** The input form the drivers read. */
export function encodeInput(args: readonly unknown[]): string {
  const enc = (x: unknown): unknown => {
    if (x === undefined) return { $u: 1 };
    if (typeof x === "number") return { $n: bitsOf(x) };
    if (Array.isArray(x)) return x.map(enc);
    if (x !== null && typeof x === "object")
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, enc(v)]));
    return x;
  };
  return JSON.stringify(enc(args));
}

/** The canonical result form of a JavaScript value. */
export function encodeValue(x: unknown): unknown {
  if (x === undefined) return { $u: 1 };
  if (x === null || typeof x === "boolean") return x;
  if (typeof x === "number") return { $n: bitsOf(x) };
  if (typeof x === "string") return { $s: units(x) };
  if (typeof x === "function") return { $f: 1 };
  if (Array.isArray(x)) return x.map(encodeValue);
  if (x instanceof Error) return { $e: encodeValue(`${x.name}: ${x.message}`) };
  if (x instanceof Map)
    return { $m: [...x.entries()].map(([k, v]) => [encodeValue(k), encodeValue(v)]) };
  if (x instanceof Set) return { $set: [...x].map(encodeValue) };
  if (typeof x === "object") {
    const proto = Object.getPrototypeOf(x);
    if (proto !== Object.prototype && proto !== null)
      return { $x: `js:${proto?.constructor?.name ?? "?"}` };
    return { $o: Object.entries(x).map(([k, v]) => [encodeValue(k), encodeValue(v)]) };
  }
  return { $x: `js:${typeof x}` };
}

/** A canonical result line, decoded for a human: numbers and strings back to JavaScript text. */
export function showResult(line: string): string {
  const dec = (x: unknown): string => {
    if (x === null) return "null";
    if (typeof x === "boolean") return String(x);
    if (Array.isArray(x)) return `[${x.map(dec).join(", ")}]`;
    const o = x as Record<string, unknown>;
    if ("$u" in o) return "undefined";
    if ("$n" in o)
      return Object.is(numberOfBits(o.$n as string), -0)
        ? "-0"
        : String(numberOfBits(o.$n as string));
    if ("$big" in o) return `${o.$big as string}n`;
    if ("$s" in o) return JSON.stringify(String.fromCharCode(...(o.$s as number[])));
    if ("$o" in o)
      return `{${(o.$o as [unknown, unknown][]).map(([k, v]) => `${dec(k)}: ${dec(v)}`).join(", ")}}`;
    if ("$e" in o) return `Error(${dec(o.$e)})`;
    if ("v" in o) return dec(o.v);
    if ("t" in o) return `throws ${dec(o.t)}`;
    return JSON.stringify(o);
  };
  try {
    return dec(JSON.parse(line));
  } catch {
    return line;
  }
}

// ---------------------------------------------------------------------------------------------
// The reference
// ---------------------------------------------------------------------------------------------

/** Runs `emitTypeScript(g)` on each input; one canonical result line per input. */
export function runReference(g: DucGraph, inputs: readonly unknown[][]): string[] {
  const code = emitTypeScript(g);
  const f = new Function(`${runnable(code)}; return f;`)() as (...a: unknown[]) => unknown;
  return inputs.map((args) => {
    try {
      return JSON.stringify({ v: encodeValue(f(...structuredClone(args))) });
    } catch (e) {
      return JSON.stringify({ t: encodeValue(e) });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------------------------

const PY_DRIVER = String.raw`
import json as _json, struct as _struct, sys as _sys

def _dec(x):
    if isinstance(x, dict):
        if len(x) == 1 and "$u" in x:
            return UNDEFINED
        if len(x) == 1 and "$n" in x:
            v = _struct.unpack(">d", bytes.fromhex(x["$n"]))[0]
            if v == v and not math.isinf(v) and v == int(v) and abs(v) < 2 ** 53 and not (v == 0 and math.copysign(1.0, v) < 0):
                return int(v)
            return v
        return {k: _dec(e) for k, e in x.items()}
    if isinstance(x, list):
        return [_dec(e) for e in x]
    return x

def _units(s):
    b = s.encode("utf-16-le", "surrogatepass")
    return [int.from_bytes(b[i:i + 2], "little") for i in range(0, len(b), 2)]

def _enc(x):
    if x is UNDEFINED:
        return {"$u": 1}
    if x is None or isinstance(x, bool):
        return x
    if isinstance(x, int):
        if float(x) != x:
            return {"$big": str(x)}
        x = float(x)
    if isinstance(x, float):
        if x != x:
            return {"$n": "7ff8000000000000"}
        return {"$n": _struct.pack(">d", x).hex()}
    if isinstance(x, str):
        return {"$s": _units(x)}
    if isinstance(x, list):
        return [_enc(e) for e in x]
    if isinstance(x, dict):
        return {"$o": [[_enc(k), _enc(v)] for k, v in x.items()]}
    if isinstance(x, JsError):
        return {"$e": _enc(x.kind + ": " + x.message)}
    if callable(x):
        return {"$f": 1}
    return {"$x": "py:" + type(x).__name__}

for _line in _sys.stdin:
    _args = _dec(_json.loads(_line))
    try:
        _out = {"v": _enc(f(*_args))}
    except JsThrow as _e:
        _out = {"t": _enc(_e.value)}
    except JsError as _e:
        _out = {"t": _enc(_e)}
    except Exception as _e:
        _out = {"crash": type(_e).__name__ + ": " + str(_e)}
    print(_json.dumps(_out, separators=(",", ":")))
`;

export function runPython(code: string, inputs: readonly unknown[][]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "duc-diff-py-"));
  const file = join(dir, "m.py");
  writeFileSync(file, `${PY_PRELUDE}\n\n${code}\n${PY_DRIVER}`);
  const out = execFileSync("python3", [file], {
    input: `${inputs.map(encodeInput).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  return out.trim().split("\n");
}

// ---------------------------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------------------------

const GO_DRIVER = String.raw`
func dDecode(dec *json.Decoder) any {
	tok, err := dec.Token()
	if err != nil {
		panic(err)
	}
	switch t := tok.(type) {
	case json.Delim:
		if t == '[' {
			a := &Array{Items: []any{}}
			for dec.More() {
				a.Items = append(a.Items, dDecode(dec))
			}
			dec.Token()
			return a
		}
		o := NewObject()
		for dec.More() {
			k, _ := dec.Token()
			o.Set(k.(string), dDecode(dec))
		}
		dec.Token()
		if len(o.Keys) == 1 && o.Keys[0] == "$u" {
			return Undefined
		}
		if len(o.Keys) == 1 && o.Keys[0] == "$n" {
			b, _ := strconv.ParseUint(o.Vals["$n"].(string), 16, 64)
			return math.Float64frombits(b)
		}
		return o
	case json.Number:
		f, _ := t.Float64()
		return f
	}
	return tok
}

func dUnits(s string) string {
	parts := []string{}
	for _, u := range utf16.Encode([]rune(s)) {
		parts = append(parts, strconv.Itoa(int(u)))
	}
	return "{\"$s\":[" + strings.Join(parts, ",") + "]}"
}

func dEncode(x any) string {
	switch v := x.(type) {
	case undefinedT:
		return "{\"$u\":1}"
	case nil:
		return "null"
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64:
		if math.IsNaN(v) {
			return "{\"$n\":\"7ff8000000000000\"}"
		}
		return fmt.Sprintf("{\"$n\":\"%016x\"}", math.Float64bits(v))
	case string:
		return dUnits(v)
	case *Array:
		parts := []string{}
		for _, e := range v.Items {
			parts = append(parts, dEncode(e))
		}
		return "[" + strings.Join(parts, ",") + "]"
	case *Object:
		parts := []string{}
		for _, k := range v.Keys {
			parts = append(parts, "["+dUnits(k)+","+dEncode(v.Vals[k])+"]")
		}
		return "{\"$o\":[" + strings.Join(parts, ",") + "]}"
	case *JsError:
		return "{\"$e\":" + dUnits(v.Kind+": "+v.Message) + "}"
	}
	if x != nil && reflect.TypeOf(x).Kind() == reflect.Func {
		return "{\"$f\":1}"
	}
	b, _ := json.Marshal(fmt.Sprintf("go:%T", x))
	return "{\"$x\":" + string(b) + "}"
}

func dRun(line string) (out string) {
	defer func() {
		if r := recover(); r != nil {
			if t, ok := r.(*JsThrow); ok {
				out = "{\"t\":" + dEncode(t.Value) + "}"
				return
			}
			b, _ := json.Marshal(fmt.Sprint(r))
			out = "{\"crash\":" + string(b) + "}"
		}
	}()
	dec := json.NewDecoder(strings.NewReader(line))
	dec.UseNumber()
	args := dDecode(dec).(*Array)
	return "{\"v\":" + dEncode(f(args.Items...)) + "}"
}

func main() {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	for sc.Scan() {
		fmt.Println(dRun(sc.Text()))
	}
}
`;

/** Go's build cache, shared by every build in this process. */
const GO_CACHE = join(tmpdir(), "duc-go-cache");

export function runGo(code: string, inputs: readonly unknown[][]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "duc-diff-go-"));
  mkdirSync(GO_CACHE, { recursive: true });
  const prelude = GO_PRELUDE.replace(
    "import (\n",
    'import (\n\t"bufio"\n\t"encoding/json"\n\t"fmt"\n\t"os"\n\t"reflect"\n\t"unicode/utf16"\n',
  );
  writeFileSync(join(dir, "main.go"), `${prelude}\n${code}\n${GO_DRIVER}`);
  writeFileSync(join(dir, "go.mod"), "module duc\n\ngo 1.21\n");
  execFileSync("go", ["build", "-o", "prog", "."], {
    cwd: dir,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, GOFLAGS: "-mod=mod", GOCACHE: GO_CACHE },
  });
  const out = execFileSync(join(dir, "prog"), {
    input: `${inputs.map(encodeInput).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  return out.trim().split("\n");
}

// ---------------------------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------------------------

const RUST_DRIVER = String.raw`
struct DP<'a> { s: &'a [u8], i: usize }
impl<'a> DP<'a> {
    fn ws(&mut self) { while self.i < self.s.len() && (self.s[self.i] as char).is_whitespace() { self.i += 1; } }
    fn string(&mut self) -> String {
        self.i += 1; let mut units: Vec<u16> = Vec::new();
        loop {
            let ch = self.s[self.i]; self.i += 1;
            if ch == b'"' { break; }
            if ch == b'\\' {
                let e = self.s[self.i] as char; self.i += 1;
                match e {
                    'n' => units.push(10), 't' => units.push(9), 'r' => units.push(13), 'b' => units.push(8), 'f' => units.push(12),
                    'u' => { let h = std::str::from_utf8(&self.s[self.i..self.i + 4]).unwrap(); self.i += 4; units.push(u16::from_str_radix(h, 16).unwrap()); }
                    other => { let mut b = [0u16; 2]; units.extend_from_slice(other.encode_utf16(&mut b)); }
                }
            } else {
                let start = self.i - 1; let mut end = self.i;
                while end < self.s.len() && (self.s[end] & 0xC0) == 0x80 { end += 1; }
                units.extend(std::str::from_utf8(&self.s[start..end]).unwrap().encode_utf16()); self.i = end;
            }
        }
        String::from_utf16_lossy(&units)
    }
    fn value(&mut self) -> V {
        self.ws();
        match self.s[self.i] {
            b'[' => {
                self.i += 1; let mut items = Vec::new(); self.ws();
                if self.s[self.i] == b']' { self.i += 1; return arr(items); }
                loop { items.push(self.value()); self.ws(); let d = self.s[self.i]; self.i += 1; if d == b']' { break; } }
                arr(items)
            }
            b'{' => {
                self.i += 1; let mut es: Vec<(String, V)> = Vec::new(); self.ws();
                if self.s[self.i] == b'}' { self.i += 1; return obj(vec![]); }
                loop {
                    self.ws(); let k = self.string();
                    self.ws(); self.i += 1; let v = self.value(); es.push((k, v));
                    self.ws(); let d = self.s[self.i]; self.i += 1; if d == b'}' { break; }
                }
                if es.len() == 1 && es[0].0 == "$u" { return V::Undef; }
                if es.len() == 1 && es[0].0 == "$n" {
                    if let V::Str(h) = &es[0].1 { return n(f64::from_bits(u64::from_str_radix(h, 16).unwrap())); }
                }
                obj(es.into_iter().map(|(k, v)| Entry::Key(k, v)).collect())
            }
            b'"' => { let t = self.string(); s(&t) }
            b't' => { self.i += 4; B(true) }
            b'f' => { self.i += 5; B(false) }
            b'n' => { self.i += 4; V::Null }
            _ => {
                let start = self.i;
                while self.i < self.s.len() && "+-.0123456789eE".contains(self.s[self.i] as char) { self.i += 1; }
                n(std::str::from_utf8(&self.s[start..self.i]).unwrap().parse().unwrap())
            }
        }
    }
}

fn d_quote(t: &str) -> String {
    let mut o = String::from("\"");
    for c in t.chars() {
        match c { '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"), c if (c as u32) < 0x20 || (c as u32) > 0x7e => { let mut b = [0u16; 2]; for u in c.encode_utf16(&mut b) { o.push_str(&format!("\\u{:04x}", u)); } }, c => o.push(c) }
    }
    o.push('"'); o
}

fn d_units(t: &str) -> String {
    format!("{{\"$s\":[{}]}}", t.encode_utf16().map(|u| u.to_string()).collect::<Vec<_>>().join(","))
}

fn d_encode(x: &V) -> String {
    match x {
        V::Undef => "{\"$u\":1}".to_string(),
        V::Null => "null".to_string(),
        V::Bool(b) => b.to_string(),
        V::Num(f) => if f.is_nan() { "{\"$n\":\"7ff8000000000000\"}".to_string() } else { format!("{{\"$n\":\"{:016x}\"}}", f.to_bits()) },
        V::Str(t) => d_units(t),
        V::Arr(a) => format!("[{}]", a.borrow().iter().map(d_encode).collect::<Vec<_>>().join(",")),
        V::Obj(o) => { let o = o.borrow(); format!("{{\"$o\":[{}]}}", o.keys.iter().map(|k| format!("[{},{}]", d_units(k), d_encode(&o.vals[k]))).collect::<Vec<_>>().join(",")) }
        V::Fun(_) => "{\"$f\":1}".to_string(),
        V::Err(e) => format!("{{\"$e\":{}}}", d_units(&format!("{}: {}", e.kind, e.message))),
        V::Re(_) => "{\"$x\":\"rust:RegExp\"}".to_string(),
    }
}

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let mut input = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut input).unwrap();
    for line in input.lines() {
        let (case, json) = line.split_once('\t').unwrap();
        let args = match (DP { s: json.as_bytes(), i: 0 }).value() { V::Arr(a) => a.borrow().clone(), _ => vec![] };
        let f = CASES[case.parse::<usize>().unwrap()];
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(args))) {
            Ok(v) => println!("{{\"v\":{}}}", d_encode(&v)),
            Err(p) => {
                if p.is::<JsThrow>() {
                    let t = take_thrown(p);
                    println!("{{\"t\":{}}}", d_encode(&t));
                } else {
                    let msg = p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "panic".to_string());
                    println!("{{\"crash\":{}}}", d_quote(&msg));
                }
            }
        }
    }
}
`;

/** Compiles the lowered modules into one program (a module per case) and runs each case's inputs. */
export function runRust(
  codes: readonly string[],
  inputs: readonly (readonly unknown[][])[],
): string[][] {
  const dir = mkdtempSync(join(tmpdir(), "duc-diff-rust-"));
  const modules = codes.map(
    (code, i) => `#[allow(unused)]\nmod case${i} {\n    use super::*;\n${code}\n}`,
  );
  const table = `const CASES: [fn(Vec<V>) -> V; ${codes.length}] = [${codes.map((_, i) => `case${i}::f`).join(", ")}];`;
  writeFileSync(
    join(dir, "main.rs"),
    `${RUST_PRELUDE}\n${modules.join("\n")}\n${table}\n${RUST_DRIVER}`,
  );
  execFileSync(
    "rustc",
    ["--edition", "2021", "-O", "-A", "warnings", "-o", join(dir, "prog"), join(dir, "main.rs")],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const lines = inputs.flatMap((ins, c) => ins.map((a) => `${c}\t${encodeInput(a)}`));
  const out = execFileSync(join(dir, "prog"), {
    input: `${lines.join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  })
    .trim()
    .split("\n");
  const per: string[][] = [];
  let at = 0;
  for (const ins of inputs) {
    per.push(out.slice(at, at + ins.length));
    at += ins.length;
  }
  return per;
}
