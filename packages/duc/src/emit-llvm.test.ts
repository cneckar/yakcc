// SPDX-License-Identifier: Apache-2.0
// Native object files from the graph (#1292): the typed subset lowered to LLVM IR, compiled by `llc`
// to the relocatable object a compiler writes, linked by stock linkers. On this host (x86-64 Linux)
// the object is linked with `cc` into a C harness and run: it computes what the source computes,
// compared bit for bit (NaN and -0 included). The other targets are compiled and linked, and their
// headers checked. Skipped where the tools are not installed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { Project, ts } from "ts-morph";
import { afterAll, describe, expect, it } from "vitest";
import { EMIT_CASES } from "./__fixtures__/emit-cases.js";
import { runnable } from "./__fixtures__/runnable.js";
import { LlvmEmitError, type LlvmModule, type NativeSignature, emitLlvm } from "./emit-llvm.js";
import { liftAtom } from "./lift.js";
import { NATIVE_TARGETS, compileObject } from "./native.js";

const has = (tool: string, ...args: string[]): boolean =>
  spawnSync(tool, args.length > 0 ? args : ["--version"]).status === 0;
const TOOLS = has("llc") && has("cc") && process.platform === "linux" && process.arch === "x64";

function signatureOf(source: string): NativeSignature {
  const sf = new Project({ useInMemoryFileSystem: true }).createSourceFile("s.ts", source);
  const fn = sf.getFunctions()[0];
  if (fn === undefined) throw new Error("no function");
  const output = fn.getReturnTypeNode()?.getText();
  return {
    inputs: fn.getParameters().map((p) => p.getTypeNode()?.getText() ?? "unknown"),
    ...(output !== undefined ? { output } : {}),
  };
}

function runSource(source: string, args: readonly unknown[]): unknown {
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return (new Function(`${runnable(js)}; return f;`)() as (...a: unknown[]) => unknown)(...args);
}

const work = mkdtempSync(join(tmpdir(), "yakcc-native-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
let built = 0;

const bits = (x: number): string => {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  return v.getBigUint64(0).toString(16).padStart(16, "0");
};
const fromBits = (h: string): number => {
  const v = new DataView(new ArrayBuffer(8));
  v.setBigUint64(0, BigInt(`0x${h}`));
  return v.getFloat64(0);
};

/** How a harness is built and run for a target: natively, or cross-linked and run under QEMU. */
interface Runner {
  readonly link: () => [string, string[]];
  readonly run: (exe: string) => [string, string[]];
}
const crossLink =
  (triple: string, extra: string[] = []): Runner["link"] =>
  () => [
    "clang",
    [
      `--target=${triple}`,
      "--sysroot=/",
      "-isystem",
      `/usr/${triple}/include`,
      `-L/usr/${triple}/lib`,
      "-fuse-ld=lld",
      "-static",
      ...extra,
      "-O0",
      "h.c",
      "f.o",
      "-lm",
      "-o",
      "run",
    ],
  ];
const RUNNERS: Record<string, Runner> = {
  "x86_64-linux": {
    link: () => ["cc", ["-O0", "h.c", "f.o", "-lm", "-o", "run"]],
    run: (exe) => [exe, []],
  },
  "aarch64-linux": { link: crossLink("aarch64-linux-gnu"), run: (exe) => ["qemu-aarch64", [exe]] },
  "arm-linux": {
    link: crossLink("arm-linux-gnueabihf", [
      "-march=armv7-a",
      "-mfloat-abi=hard",
      "-mfpu=vfpv3-d16",
    ]),
    run: (exe) => ["qemu-arm", [exe]],
  },
  "riscv64-linux": {
    link: crossLink("riscv64-linux-gnu", ["-march=rv64gc", "-mabi=lp64d"]),
    run: (exe) => ["qemu-riscv64", [exe]],
  },
};

/** The module linked into a C harness for the target: one call per input line, its result exact. */
function linked(
  m: LlvmModule,
  target = "x86_64-linux",
): (inputs: readonly unknown[][]) => unknown[] {
  const runner = RUNNERS[target] as Runner;
  const dir = join(work, String(built++));
  spawnSync("mkdir", ["-p", dir]);
  writeFileSync(join(dir, "f.o"), compileObject(m, { target }));
  const ctype = (t: string): string => (t === "i1" ? "_Bool" : "double");
  const read = m.params
    .map((t, i) =>
      t === "i1"
        ? `int b${i}; if (scanf("%d", &b${i}) != 1) return 0; _Bool a${i} = b${i};`
        : `char h${i}[32]; if (scanf("%31s", h${i}) != 1) return 0; double a${i} = d(h${i});`,
    )
    .join(" ");
  const print =
    m.result === "i1"
      ? 'printf("%d\\n", r ? 1 : 0);'
      : 'uint64_t u; memcpy(&u, &r, 8); printf("%016llx\\n", (unsigned long long)u);';
  writeFileSync(
    join(dir, "h.c"),
    [
      "#include <stdio.h>",
      "#include <string.h>",
      "#include <stdint.h>",
      `extern ${ctype(m.result)} ${m.symbol}(${m.params.map(ctype).join(", ") || "void"});`,
      'static double d(const char *h) { unsigned long long u; sscanf(h, "%llx", &u); double x; memcpy(&x, &u, 8); return x; }',
      `int main(void) { for (;;) { ${read} ${ctype(m.result)} r = ${m.symbol}(${m.params.map((_, i) => `a${i}`).join(", ")}); ${print} } }`,
    ].join("\n"),
  );
  const [cc, ccArgs] = runner.link();
  const made = spawnSync(cc, ccArgs, { cwd: dir });
  if (made.status !== 0) throw new Error(`${cc} failed: ${made.stderr.toString()}`);
  return (inputs) => {
    const text = inputs
      .map((args) =>
        args.map((a, i) => (m.params[i] === "i1" ? (a ? "1" : "0") : bits(Number(a)))).join(" "),
      )
      .join("\n");
    const [exe, exeArgs] = runner.run(join(dir, "run"));
    const out = spawnSync(exe, exeArgs, { input: `${text}\n` })
      .stdout.toString()
      .trim();
    return out
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => (m.result === "i1" ? l === "1" : fromBits(l)));
  };
}

describe.skipIf(!TOOLS)(
  "native object files on this host: x86-64 ELF, linked by cc (#1292)",
  () => {
    it("the emit cases that fit the subset compute what the source computes", () => {
      let fits = 0;
      for (const tc of EMIT_CASES) {
        let m: LlvmModule;
        try {
          m = emitLlvm(liftAtom(tc.source), signatureOf(tc.source));
        } catch (e) {
          if (e instanceof LlvmEmitError) continue;
          throw e;
        }
        fits++;
        const results = linked(m)(tc.args as unknown[][]);
        tc.args.forEach((args, i) =>
          expect(
            Object.is(results[i], runSource(tc.source, args)),
            `${tc.name} ${JSON.stringify(args)}`,
          ).toBe(true),
        );
      }
      expect(fits).toBeGreaterThanOrEqual(3);
    }, 120_000);

    const PROGRAMS: [string, string, fc.Arbitrary<unknown[]>][] = [
      [
        "arithmetic, remainder, comparison and selection",
        "export function f(a: number, b: number): number { const m = a < b ? a : b; return (m * 3 - b / 2) % 7; }",
        fc.tuple(fc.double(), fc.double()),
      ],
      [
        "a loop with an early exit",
        "export function f(n: number, k: number): number { let i = 0; let s = 0; while (i < n) { if (s > k) break; s = s + i * i; i = i + 1; } return s; }",
        fc.tuple(fc.integer({ min: -5, max: 200 }), fc.integer({ min: -10, max: 100000 })),
      ],
      [
        "a loop inside a branch, nested loops",
        "export function f(n: number): number { let t = 0; if (n > 0) { let i = 0; while (i < n) { let j = 0; while (j < i) { t = t + j; j = j + 1; } i = i + 1; } } else { t = -n; } return t; }",
        fc.tuple(fc.integer({ min: -50, max: 40 })),
      ],
      [
        "booleans and JavaScript's truthiness",
        "export function f(a: number, b: boolean): boolean { return (!a && b) || (a !== a) === b || (a > 0 && !b); }",
        fc.tuple(fc.oneof(fc.double(), fc.constantFrom(0, -0, Number.NaN)), fc.boolean()),
      ],
      [
        "exact Math: floor, ceil, abs, min, max, round, sqrt, sign, constants",
        "export function f(x: number, y: number): number { return Math.floor(x) - Math.ceil(y) + Math.abs(x - y) + Math.min(x, y, 3) + Math.max(-0, x) + Math.round(y) + Math.sqrt(Math.abs(x)) + Math.sign(x) + Math.PI; }",
        fc.tuple(fc.double(), fc.double()),
      ],
      [
        "round's ties and zeros, min and max of zeros and NaN",
        "export function f(x: number, y: number): number { return 1 / Math.round(x) + 1 / Math.min(x, y) + 1 / Math.max(x, y); }",
        fc.tuple(
          fc.oneof(
            fc.double(),
            fc.constantFrom(0, -0, 0.5, -0.5, 0.49999999999999994, -0.4, Number.NaN),
          ),
          fc.oneof(fc.double(), fc.constantFrom(0, -0, Number.NaN)),
        ),
      ],
      [
        "early returns",
        "export function f(x: number): number { if (x !== x) return -1; if (x < 0) return x * -2; if (x === 0) return 1 / x; return x - 0.5; }",
        fc.tuple(fc.oneof(fc.double(), fc.constantFrom(0, -0, Number.NaN))),
      ],
    ];
    for (const [name, source, inputs] of PROGRAMS) {
      it(`agrees with the source on generated inputs, bit for bit: ${name}`, () => {
        const run = linked(emitLlvm(liftAtom(source), signatureOf(source)));
        const samples = fc.sample(inputs, { numRuns: 400, seed: 1292 });
        const results = run(samples);
        expect(results).toHaveLength(samples.length);
        samples.forEach((args, i) =>
          expect(Object.is(results[i], runSource(source, args)), JSON.stringify(args)).toBe(true),
        );
      }, 120_000);
    }

    it("is deterministic: the same graph and target give byte-identical objects", () => {
      const source = PROGRAMS[1]?.[1] as string;
      const m = emitLlvm(liftAtom(source), signatureOf(source));
      expect(Buffer.from(compileObject(m)).equals(Buffer.from(compileObject(m)))).toBe(true);
      expect(emitLlvm(liftAtom(source), signatureOf(source)).ir).toBe(m.ir);
    });
  },
);

describe.skipIf(!has("llc"))("native object files for the other targets (#1292)", () => {
  const source =
    "export function f(x: number, y: boolean): number { let s = 0; let i = 0; while (i < x) { s = s + (y ? Math.floor(i / 2) : Math.min(i, 3)) % 5; i = i + 1; } return s; }";
  const m = emitLlvm(liftAtom(source), signatureOf(source));
  // The object format and machine each target's object declares, read from its header.
  const header = (o: Uint8Array): string => {
    const b = Buffer.from(o);
    if (b.readUInt32BE(0) === 0x7f454c46) return `elf:${b.readUInt16LE(18)}`;
    if (b.readUInt32LE(0) === 0xfeedfacf) return `macho:${b.readUInt32LE(4).toString(16)}`;
    return `coff:${b.readUInt16LE(0).toString(16)}`;
  };
  const EXPECTED: Record<string, string> = {
    "x86_64-linux": "elf:62",
    "aarch64-linux": "elf:183",
    "arm-linux": "elf:40",
    "riscv64-linux": "elf:243",
    "x86_64-macos": "macho:1000007",
    "aarch64-macos": "macho:100000c",
    "x86_64-windows": "coff:8664",
    "aarch64-windows": "coff:aa64",
  };
  const LINK: Record<string, (o: string, out: string) => [string, string[]]> = {
    linux: (o, out) => ["ld.lld", ["-shared", o, "-o", out]],
    macos: (o, out) => [
      "ld64.lld-18",
      [
        "-arch",
        o.includes("x86_64") ? "x86_64" : "arm64",
        "-dylib",
        "-platform_version",
        "macos",
        "11.0",
        "11.0",
        "-undefined",
        "dynamic_lookup",
        o,
        "-o",
        out,
      ],
    ],
    windows: (o, out) => [
      "lld-link",
      [
        "/dll",
        "/noentry",
        `/machine:${o.includes("x86_64") ? "x64" : "arm64"}`,
        "/export:f",
        "/force:unresolved",
        `/out:${out}`,
        o,
      ],
    ],
  };
  for (const target of Object.keys(NATIVE_TARGETS)) {
    it(`${target}: a relocatable object of the target's format and machine, taken by its stock linker`, () => {
      const o = compileObject(m, { target });
      expect(header(o)).toBe(EXPECTED[target]);
      const os = target.split("-")[1] as string;
      const path = join(work, `${target}.o`);
      writeFileSync(path, o);
      const [tool, args] = (LINK[os] as (o: string, out: string) => [string, string[]])(
        path,
        join(work, `${target}.linked`),
      );
      if (!has(tool, "--version") && !has(tool, "/?")) return;
      const run = spawnSync(tool, args);
      expect(run.status, run.stderr.toString()).toBe(0);
      expect(readFileSync(join(work, `${target}.linked`)).length).toBeGreaterThan(0);
    });
  }
});

const CROSS =
  has("llc") &&
  has("clang") &&
  ["qemu-aarch64", "qemu-arm", "qemu-riscv64"].every((q) => has(q, "--version")) &&
  ["aarch64-linux-gnu", "arm-linux-gnueabihf", "riscv64-linux-gnu"].every(
    (t) => spawnSync("test", ["-d", `/usr/${t}/lib`]).status === 0,
  );

describe.skipIf(!CROSS)(
  "native object files on other architectures, run under QEMU (#1292)",
  () => {
    // Branches, a loop, booleans, `%` (fmod, from the target's libm), and the exact Math.
    const source =
      "export function f(x: number, y: boolean): number { let s = 0; let i = 0; while (i < x) { s = s + (y ? Math.floor(i / 2) : Math.min(i, 3)) % 5; i = i + 1; } return s + Math.round(x / 3) + Math.ceil(-x / 7) + Math.max(-0, Math.sign(x)); }";
    const inputs = fc.tuple(
      fc.oneof(
        fc.integer({ min: -20, max: 60 }),
        fc.double({ min: -50, max: 50 }),
        fc.constantFrom(0, -0, Number.NaN),
      ),
      fc.boolean(),
    );
    for (const target of ["aarch64-linux", "arm-linux", "riscv64-linux"]) {
      it(`${target}: linked against the target's glibc, run under QEMU, bit for bit with the source`, () => {
        const run = linked(emitLlvm(liftAtom(source), signatureOf(source)), target);
        const samples = fc.sample(inputs, { numRuns: 200, seed: 1292 });
        const results = run(samples);
        expect(results).toHaveLength(samples.length);
        samples.forEach((args, i) =>
          expect(Object.is(results[i], runSource(source, args)), JSON.stringify(args)).toBe(true),
        );
      }, 120_000);
    }
  },
);

describe("what the native lowering refuses (#1292)", () => {
  const refusal = (source: string): string => {
    try {
      emitLlvm(liftAtom(source), signatureOf(source));
    } catch (e) {
      if (e instanceof LlvmEmitError) return e.message;
      throw e;
    }
    return "lowered";
  };
  it("strings, arrays and free names, as the wasm lowering does", () => {
    expect(refusal("export function f(s: string): number { return s.length; }")).toMatch(
      /not a number or a boolean/,
    );
    expect(refusal("export function f(x: number): number { return helper(x); }")).toMatch(
      /"helper" is not in the native base set/,
    );
  });
  it("what ECMAScript lets an engine approximate: a libm need not give the reference's last bit", () => {
    expect(refusal("export function f(x: number): number { return Math.sin(x); }")).toMatch(
      /implementation-approximated/,
    );
    expect(refusal("export function f(x: number, y: number): number { return x ** y; }")).toMatch(
      /implementation-approximated/,
    );
  });
  it("a symbol a linker would not take", () => {
    expect(() =>
      emitLlvm(
        liftAtom("export function f(x: number): number { return x; }"),
        signatureOf("export function f(x: number): number { return x; }"),
        "not a symbol",
      ),
    ).toThrow(/not a symbol/);
  });
});
