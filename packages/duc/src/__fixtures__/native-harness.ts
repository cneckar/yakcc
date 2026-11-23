// SPDX-License-Identifier: Apache-2.0
// Test support for the native lowering of boxed values (#1292): a C harness around an object and the
// runtime, built natively or cross-linked against a target's glibc and run under QEMU; and the text
// form the runtime reads and writes values in (`yk_read`, `yk_write`).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlvmModule } from "../emit-llvm.js";
import { compileObject, compileRuntime } from "../native.js";

export const has = (tool: string, ...args: string[]): boolean =>
  spawnSync(tool, args.length > 0 ? args : ["--version"]).status === 0;

const sysrootFlags = (triple: string): string[] => [
  "--sysroot=/",
  "-isystem",
  `/usr/${triple}/include`,
];

interface Target {
  readonly cflags: readonly string[];
  readonly link: readonly string[];
  readonly run: (exe: string) => [string, string[]];
  readonly cc: string;
}
const CROSS_TRIPLES: Readonly<Record<string, string>> = {
  "aarch64-linux": "aarch64-linux-gnu",
  "arm-linux": "arm-linux-gnueabihf",
  "riscv64-linux": "riscv64-linux-gnu",
};
const CROSS_FLAGS: Readonly<Record<string, readonly string[]>> = {
  "arm-linux": ["-march=armv7-a", "-mfloat-abi=hard", "-mfpu=vfpv3-d16"],
  "riscv64-linux": ["-march=rv64gc", "-mabi=lp64d"],
};
const QEMU: Readonly<Record<string, string>> = {
  "aarch64-linux": "qemu-aarch64",
  "arm-linux": "qemu-arm",
  "riscv64-linux": "qemu-riscv64",
};

function targetOf(target: string): Target {
  if (target === "x86_64-linux") return { cflags: [], link: [], run: (exe) => [exe, []], cc: "cc" };
  const triple = CROSS_TRIPLES[target] as string;
  return {
    cflags: sysrootFlags(triple),
    link: [
      `--target=${triple}`,
      ...sysrootFlags(triple),
      ...(CROSS_FLAGS[target] ?? []),
      `-L/usr/${triple}/lib`,
      "-fuse-ld=lld",
      "-static",
    ],
    run: (exe) => [QEMU[target] as string, [exe]],
    cc: "clang",
  };
}

/** Whether the tools to build and run a target's harness are here. */
export function canRun(target: string): boolean {
  if (!has("llc") || !has("clang")) return false;
  if (target === "x86_64-linux")
    return has("cc") && process.platform === "linux" && process.arch === "x64";
  const triple = CROSS_TRIPLES[target];
  return (
    triple !== undefined &&
    has(QEMU[target] as string, "--version") &&
    spawnSync("test", ["-d", `/usr/${triple}/lib`]).status === 0
  );
}

/** A JavaScript value in the runtime's text form. */
export function encode(v: unknown): string {
  if (typeof v === "number") {
    const d = new DataView(new ArrayBuffer(8));
    d.setFloat64(0, v);
    return `n${d.getBigUint64(0).toString(16).padStart(16, "0")}`;
  }
  if (typeof v === "string") {
    let units = "";
    for (let i = 0; i < v.length; i++) units += v.charCodeAt(i).toString(16).padStart(4, "0");
    return `s${v.length}:${units}`;
  }
  if (Array.isArray(v)) return [`a${v.length}`, ...v.map(encode)].join(" ");
  if (v !== null && typeof v === "object")
    return [
      `o${Object.keys(v).length}`,
      ...Object.entries(v).flatMap(([k, x]) => [encode(k), encode(x)]),
    ].join(" ");
  if (v === undefined) return "u";
  if (v === null) return "l";
  if (v === true) return "t";
  if (v === false) return "f";
  throw new Error(`no text form for ${typeof v}`);
}

/** The runtime's text form read back as a JavaScript value. */
export function decode(text: string): unknown {
  let at = 0;
  const read = (): unknown => {
    while (text[at] === " ") at++;
    const c = text[at++];
    if (c === "n") {
      const d = new DataView(new ArrayBuffer(8));
      d.setBigUint64(0, BigInt(`0x${text.slice(at, at + 16)}`));
      at += 16;
      return d.getFloat64(0);
    }
    if (c === "s") {
      const colon = text.indexOf(":", at);
      const len = Number(text.slice(at, colon));
      at = colon + 1;
      let s = "";
      for (let i = 0; i < len; i++, at += 4)
        s += String.fromCharCode(Number.parseInt(text.slice(at, at + 4), 16));
      return s;
    }
    if (c === "a") {
      let end = at;
      while (/[0-9]/.test(text[end] as string)) end++;
      const len = Number(text.slice(at, end));
      at = end;
      return Array.from({ length: len }, read);
    }
    if (c === "o") {
      let end = at;
      while (/[0-9]/.test(text[end] as string)) end++;
      const len = Number(text.slice(at, end));
      at = end;
      const o: Record<string, unknown> = {};
      for (let i = 0; i < len; i++) {
        const k = read() as string;
        o[k] = read();
      }
      return o;
    }
    if (c === "F") return FUNCTION;
    return { u: undefined, l: null, t: true, f: false }[c as "u" | "l" | "t" | "f"];
  };
  return read();
}

/** What the runtime writes for a function: its value has no text form. */
export const FUNCTION = Symbol("function");

/**
 * Two values the same: Object.is for primitives, element by element for arrays, key by key (in
 * order) for objects; a function is any function.
 */
export function same(a: unknown, b: unknown): boolean {
  if (a === FUNCTION || b === FUNCTION) return typeof (a === FUNCTION ? b : a) === "function";
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every(
        (k, i) =>
          k === kb[i] && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return Object.is(a, b);
}

let built = 0;

/**
 * The module and the runtime linked into a harness for the target. The harness reads each call's
 * arguments and writes its result, one line each; a call that throws ends the run with the error.
 */
export function harness(
  m: LlvmModule,
  work: string,
  target = "x86_64-linux",
): (calls: readonly unknown[][]) => { results: unknown[]; stderr: string } {
  const t = targetOf(target);
  const dir = join(work, `h${built++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "f.o"), compileObject(m, { target }));
  writeFileSync(join(dir, "yk.o"), compileRuntime({ target, cflags: t.cflags }));
  const n = m.params.length;
  writeFileSync(
    join(dir, "h.c"),
    [
      "#include <stdio.h>",
      "#include <stdint.h>",
      "typedef uint64_t yk;",
      `extern yk ${m.symbol}(${Array(n).fill("yk").join(", ") || "void"});`,
      "yk yk_read(FILE *); void yk_write(FILE *, yk);",
      `int main(void) { setvbuf(stdout, NULL, _IOFBF, 1 << 16); for (;;) { ${Array.from({ length: n }, (_, i) => `yk a${i} = yk_read(stdin);`).join(" ")} yk_write(stdout, ${m.symbol}(${Array.from({ length: n }, (_, i) => `a${i}`).join(", ")})); fputc('\\n', stdout); fflush(stdout); } }`,
    ].join("\n"),
  );
  const cc = spawnSync(t.cc, [...t.link, "-O0", "h.c", "f.o", "yk.o", "-lm", "-o", "run"], {
    cwd: dir,
  });
  if (cc.status !== 0) throw new Error(`${t.cc} failed: ${cc.stderr.toString()}`);
  return (calls) => {
    const input = calls.map((args) => args.map(encode).join(" ")).join("\n");
    const [exe, args] = t.run(join(dir, "run"));
    const run = spawnSync(exe, args, { input: `${input}\n`, maxBuffer: 1 << 26 });
    const lines = run.stdout
      .toString()
      .split("\n")
      .filter((l) => l !== "");
    return { results: lines.map(decode), stderr: run.stderr.toString() };
  };
}
