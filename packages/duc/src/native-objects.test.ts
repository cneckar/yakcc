// SPDX-License-Identifier: Apache-2.0
// Native objects for every (architecture, format) pair (#1296, #1292 criterion 4): each object the
// lowering emits is byte-identical across two lowerings, is the format its target names, defines
// the exported symbol, and is accepted by that format's stock linker (lld's ELF, Mach-O and COFF
// flavours). The runtime object, built by clang, is checked the same way where the target's system
// headers are here: the Linux targets. A pair whose tool is missing is skipped, naming the tool.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { emitLlvmBoxed } from "./emit-llvm-boxed.js";
import { liftAtom } from "./lift.js";
import { compileObject, compileRuntime } from "./native.js";

const work = mkdtempSync(join(tmpdir(), "yakcc-objects-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const has = (tool: string, ...args: string[]): boolean =>
  spawnSync(tool, args.length > 0 ? args : ["--version"]).status === 0;
const run = (tool: string, args: string[]): { status: number | null; out: string } => {
  const r = spawnSync(tool, args, { cwd: work });
  return { status: r.status, out: `${r.stdout.toString()}${r.stderr.toString()}` };
};

/** Each pair: the object format llvm-objdump names, the exported symbol, and how its linker links. */
const PAIRS: Record<
  string,
  { format: RegExp; symbol: string; link: (objs: string[], out: string) => [string, string[]] }
> = {
  "x86_64-linux": { format: /elf64-x86-64/, symbol: "f", link: elf },
  "aarch64-linux": { format: /elf64-littleaarch64/, symbol: "f", link: elf },
  "arm-linux": { format: /elf32-littlearm/, symbol: "f", link: elf },
  "riscv64-linux": { format: /elf64-littleriscv/, symbol: "f", link: elf },
  "x86_64-macos": { format: /mach-o 64-bit x86-64/, symbol: "_f", link: macho("x86_64") },
  "aarch64-macos": { format: /mach-o arm64/, symbol: "_f", link: macho("arm64") },
  "x86_64-windows": { format: /coff-x86-64/, symbol: "f", link: coff("x64") },
  "aarch64-windows": { format: /coff-arm64/, symbol: "f", link: coff("arm64") },
};
function elf(objs: string[], out: string): [string, string[]] {
  return ["ld.lld", ["-shared", ...objs, "-o", out]];
}
function macho(arch: string) {
  // lld's Mach-O flavour, which ld64.lld names. The runtime's symbols resolve when an executable
  // links the library with it.
  return (objs: string[], out: string): [string, string[]] => [
    "lld",
    [
      "-flavor",
      "darwin",
      "-arch",
      arch,
      "-platform_version",
      "macos",
      "11.0",
      "11.0",
      "-dylib",
    ].concat(["-undefined", "dynamic_lookup", ...objs, "-o", out]),
  ];
}
function coff(machine: string) {
  return (objs: string[], out: string): [string, string[]] => [
    "lld-link",
    [
      "/dll",
      "/noentry",
      "/force:unresolved",
      `/machine:${machine}`,
      "/export:f",
      ...objs,
      `/out:${out}`,
    ],
  ];
}

const PROGRAM = emitLlvmBoxed(
  liftAtom("export function f(a, b) { const xs = [a, b]; return xs.map((x) => x + 1).join(','); }"),
);
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
const TOOLS = has("llc") && has("llvm-objdump");

describe.skipIf(!TOOLS)("native objects for every architecture and format (#1296)", () => {
  for (const [target, pair] of Object.entries(PAIRS)) {
    const [linker] = pair.link([], "x");
    it.skipIf(!has(linker, ...(linker === "lld" ? ["-flavor", "gnu", "--version"] : [])))(
      `${target}: the program object is deterministic, ${pair.format.source}, defines ${pair.symbol}, and ${linker} links it`,
      () => {
        const first = compileObject(PROGRAM, { target });
        expect(same(first, compileObject(PROGRAM, { target }))).toBe(true);
        const obj = join(work, `f-${target}.o`);
        writeFileSync(obj, first);
        expect(run("llvm-objdump", ["-f", obj]).out).toMatch(pair.format);
        expect(run("llvm-objdump", ["--syms", obj]).out).toMatch(
          new RegExp(`\\s${pair.symbol}$`, "m"),
        );
        const objs = [obj];
        // The runtime too, where clang has the target's headers (the Linux targets here).
        if (target.endsWith("-linux") && has("clang")) {
          const rt = compileRuntime({ target });
          expect(same(rt, compileRuntime({ target }))).toBe(true);
          const rtPath = join(work, `yk-${target}.o`);
          writeFileSync(rtPath, rt);
          expect(run("llvm-objdump", ["-f", rtPath]).out).toMatch(pair.format);
          objs.push(rtPath);
        }
        const [tool, args] = pair.link(objs, join(work, `out-${target}`));
        const linked = run(tool, args);
        expect(linked.status, linked.out).toBe(0);
        expect(run("llvm-objdump", ["-f", join(work, `out-${target}`)]).out).toMatch(pair.format);
      },
      3_600_000,
    );
  }
});
