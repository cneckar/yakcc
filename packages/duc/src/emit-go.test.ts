// SPDX-License-Identifier: Apache-2.0
/**
 * Lowering to Go (#1278): each source's graph lowered to Go computes, on the same inputs, what the
 * source computes in JavaScript (conformance), built and run with the system's go toolchain.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMIT_CASES } from "./__fixtures__/emit-cases.js";
import { GO_PRELUDE, GoEmitError, emitGo } from "./emit-go.js";
import { emitTypeScript } from "./emit-ts.js";
import { liftAtom } from "./lift.js";

/** Reads one JSON array of arguments per line, keeps object key order, prints each result as JSON. */
const DRIVER = `
func decode(dec *json.Decoder) any {
	tok, err := dec.Token()
	if err != nil {
		panic(err)
	}
	switch t := tok.(type) {
	case json.Delim:
		if t == '[' {
			a := &Array{}
			for dec.More() {
				a.Items = append(a.Items, decode(dec))
			}
			dec.Token()
			return a
		}
		o := NewObject()
		for dec.More() {
			k, _ := dec.Token()
			o.Set(k.(string), decode(dec))
		}
		dec.Token()
		return o
	case json.Number:
		f, _ := t.Float64()
		return f
	}
	return tok
}

func encode(x any) string {
	switch v := x.(type) {
	case undefinedT:
		return "{\\"$undefined\\":true}"
	case nil:
		return "null"
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return "null"
		}
		b, _ := json.Marshal(v)
		return string(b)
	case string:
		b, _ := json.Marshal(v)
		return string(b)
	case *Array:
		parts := []string{}
		for _, e := range v.Items {
			parts = append(parts, encode(e))
		}
		return "[" + strings.Join(parts, ",") + "]"
	case *Object:
		parts := []string{}
		for _, k := range v.Keys {
			kb, _ := json.Marshal(k)
			parts = append(parts, string(kb)+":"+encode(v.Vals[k]))
		}
		return "{" + strings.Join(parts, ",") + "}"
	}
	return "null"
}

func runOne(line string) (out string) {
	defer func() {
		if r := recover(); r != nil {
			t, ok := r.(*JsThrow)
			if !ok {
				panic(r)
			}
			if e, ok := t.Value.(*JsError); ok {
				b, _ := json.Marshal(e.Kind + ": " + e.Message)
				out = "{\\"threw\\":" + string(b) + "}"
				return
			}
			b, _ := json.Marshal(str(t.Value))
			out = "{\\"threw\\":" + string(b) + "}"
		}
	}()
	dec := json.NewDecoder(strings.NewReader(line))
	dec.UseNumber()
	args := decode(dec).(*Array)
	return "{\\"value\\":" + encode(f(args.Items...)) + "}"
}

func main() {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		fmt.Println(runOne(sc.Text()))
	}
}
`;

function runGo(code: string, inputs: readonly unknown[][]): unknown[] {
  const dir = mkdtempSync(join(tmpdir(), "duc-go-"));
  mkdirSync(join(dir, "cache"), { recursive: true });
  const prelude = GO_PRELUDE.replace(
    "import (\n",
    'import (\n\t"bufio"\n\t"encoding/json"\n\t"fmt"\n\t"os"\n',
  );
  writeFileSync(join(dir, "main.go"), `${prelude}\n${code}\n${DRIVER}`);
  writeFileSync(join(dir, "go.mod"), "module duc\n\ngo 1.21\n");
  execFileSync("go", ["build", "-o", "prog", "."], {
    cwd: dir,
    env: { ...process.env, GOFLAGS: "-mod=mod", GOCACHE: join(tmpdir(), "duc-go-cache") },
  });
  const out = execFileSync(join(dir, "prog"), {
    input: inputs.map((a) => JSON.stringify(a)).join("\n"),
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

function runJs(source: string, inputs: readonly unknown[][]): unknown[] {
  const code = emitTypeScript(liftAtom(source));
  const f = new Function(`${code.replace("export ", "")}; return f;`)() as (
    ...a: unknown[]
  ) => unknown;
  return inputs.map((args) => {
    try {
      return { value: toJson(f(...structuredClone(args))) };
    } catch (e) {
      return { threw: `${(e as Error).name}: ${(e as Error).message}` };
    }
  });
}

const go = (() => {
  try {
    execFileSync("go", ["version"]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!go)("lowering to Go: conformance (#1278)", () => {
  for (const tc of EMIT_CASES) {
    it(`computes what the source computes: ${tc.name}`, { timeout: 120_000 }, () => {
      const code = emitGo(liftAtom(tc.source));
      expect(runGo(code, tc.args), code).toEqual(runJs(tc.source, tc.args));
    });
  }

  const more: [string, string, unknown[][]][] = [
    [
      "string methods",
      "export function f(s: string) { return s.trim().toUpperCase() + s.indexOf('b') + s.slice(1, 3); }",
      [["  abc "], ["b"]],
    ],
    [
      "remainder and division",
      "export function f(a: number, b: number) { return [a % b, a / b, -a % b]; }",
      [
        [7, 3],
        [7, 0],
        [-7, 2],
      ],
    ],
    [
      "strict equality and truthiness",
      "export function f(x: unknown) { return [x === 0, x === '0', !x, x ?? 'none']; }",
      [[0], ["0"], [""], [null]],
    ],
    [
      "lazy && with a member read",
      "export function f(s: any) { return s && s.length; }",
      [["abc"], [null], [""]],
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
      "a return from a loop",
      "export function f(xs: number[], k: number) { let i = 0; while (i < xs.length) { if (xs[i] === k) return i; i = i + 1; } return -1; }",
      [
        [[4, 5, 6], 5],
        [[4, 5, 6], 9],
      ],
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
      "destructuring with defaults",
      "export function f(o: any) { const { a, b = 7 } = o; return a + b; }",
      [[{ a: 1 }], [{ a: 1, b: 2 }]],
    ],
    [
      "map, filter and reduce",
      "export function f(xs: number[]) { return xs.map((x) => x * 2).filter((x) => x > 2).reduce((a, b) => a + b, 0); }",
      [[[1, 2, 3]], [[]]],
    ],
    [
      "a do loop",
      "export function f(n: number) { let i = 0; do { i = i + 1; } while (i < n); return i; }",
      [[0], [4]],
    ],
    [
      "regular expressions",
      "export function f(s: string) { return [/^a+b/.test(s), s.replace(/a(b)/g, '[$1]'), s.replace('a', '$$')]; }",
      [["aab"], ["xabab"], [""]],
    ],
    [
      "concat, substring and arguments",
      "export function f(a: string, b: string) { return a.concat(b).substring(1, 4) + arguments.length; }",
      [
        ["hello", "world"],
        ["a", "b"],
      ],
    ],
    [
      "platform functions as callbacks",
      "export function f(xs: string[]) { return [xs.map(Number), xs.map(String), xs.filter(Boolean).length, xs.find((x) => x === '2'), xs.findIndex((x) => x === '9')]; }",
      [[["1", "2", ""]], [[]]],
    ],
  ];
  for (const [name, src, inputs] of more) {
    it(`computes what the source computes: ${name}`, { timeout: 120_000 }, () => {
      const code = emitGo(liftAtom(src));
      expect(runGo(code, inputs), code).toEqual(runJs(src, inputs));
    });
  }
});

describe("lowering to Go: refusals (#1278)", () => {
  it("an unknown method is refused with a reason", () => {
    expect(() =>
      emitGo(
        liftAtom("export function f(xs: number[]) { return xs.reduceRight((a, b) => a + b, 0); }"),
      ),
    ).toThrow(GoEmitError);
  });
});
