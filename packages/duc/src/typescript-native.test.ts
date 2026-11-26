// SPDX-License-Identifier: Apache-2.0
/**
 * TypeScript's compiler, natively (#1370): typescript.js lifted statement by statement (its bundler
 * wrapper unwrapped, #1458), built by the native toolchain, and transpileModule run on sources of
 * this package, and a program type-checked and emitted over an in-memory host with the real
 * lib.es5.d.ts: the output is Node's TypeScript's, byte for byte. About 16 minutes (an 11-minute
 * record, a 5-minute build), so it runs when YAKCC_TS_NATIVE=1; with YAKCC_TS_NATIVE_CROSS=1 too,
 * on AArch64, RISC-V and ARMv7 as well, under QEMU.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { canRun } from "./__fixtures__/native-harness.js";
import { buildRecord } from "./build.js";
import { programRecord } from "./program.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/** The fixture's --check arguments: TypeScript's lib.es5.d.ts and its references (in parts: an
 * argument is at most 128 KiB), then each source. */
function checkArguments(sources: Readonly<Record<string, string>>): string[] {
  const lib = dirname(createRequire(import.meta.url).resolve("typescript"));
  const out = ["--check"];
  for (const f of ["lib.es5.d.ts", "lib.decorators.d.ts", "lib.decorators.legacy.d.ts"]) {
    const text = readFileSync(join(lib, f), "utf8");
    for (let i = 0; i < text.length; i += 60_000)
      out.push(i === 0 ? f : "+", text.slice(i, i + 60_000));
  }
  out.push("--");
  for (const [name, text] of Object.entries(sources)) out.push(name, text);
  return out;
}
const work = mkdtempSync(join(tmpdir(), "yakcc-ts-native-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!canRun("x86_64-linux") || process.env.YAKCC_TS_NATIVE !== "1")(
  "TypeScript's compiler, natively (#1370)",
  () => {
    it("transpileModule natively gives Node's TypeScript's output, byte for byte", () => {
      const entry = here("./__fixtures__/program/typescript/transpile.cjs");
      const record = programRecord(entry, here("../../.."));
      expect(record.modules.reduce((n, m) => n + m.statements.length, 0)).toBeGreaterThan(5000);
      const exe = join(work, "tsc-native");
      buildRecord(record, exe);
      const sources = [
        "enum E { A, B } let x: number = 1; class C<T> { m(a?: T) { return a ?? 3; } }",
        readFileSync(here("./program.ts"), "utf8"),
        readFileSync(here("./acceptance.ts"), "utf8"),
      ];
      const run = spawnSync(exe, sources, {
        encoding: "utf8",
        maxBuffer: 1 << 26,
        timeout: 300_000,
      });
      expect([run.status, run.stderr]).toEqual([0, ""]);
      const ts = createRequire(import.meta.url)("typescript") as {
        transpileModule: (t: string, o: unknown) => { outputText: string };
      };
      const want = sources.map((t) =>
        JSON.stringify(
          ts.transpileModule(t, { compilerOptions: { target: 99, module: 99 } }).outputText,
        ),
      );
      expect(run.stdout.split("\n").slice(0, -1)).toEqual(want);
      // The checker: a program over an in-memory host with the real lib.es5.d.ts, its diagnostics,
      // variables' types and emitted JavaScript and declarations, as Node's TypeScript gives them.
      const check = checkArguments({
        "main.ts": [
          'import { greet, type Shape } from "./util";',
          'const n: number = greet("x");',
          'const s: string = greet("y");',
          'let sh: Shape = { kind: "circle", r: 1 };',
          'sh = { kind: "square", side: "2" };',
          "const xs = [1, 2, 3].map((x) => x.toFixed(1)).filter((v) => v.length > 2);",
          "export class Box<T> { constructor(private v: T) {} get(): T { return this.v; } }",
          'new Box<number>("no").get().toUpperCase();',
        ].join("\n"),
        "util.ts": [
          "export function greet(name: string): string { return `hi ${name}`; }",
          'export type Shape = { kind: "circle"; r: number } | { kind: "square"; side: number };',
        ].join("\n"),
      });
      const checked = spawnSync(exe, check, {
        encoding: "utf8",
        maxBuffer: 1 << 26,
        timeout: 300_000,
      });
      const reference = spawnSync(process.execPath, [entry, ...check], { encoding: "utf8" });
      expect([checked.status, checked.stderr]).toEqual([0, ""]);
      expect(JSON.parse(reference.stdout).diagnostics).toHaveLength(4);
      expect(checked.stdout).toBe(reference.stdout);
      // The cross targets, with no C library, under QEMU (YAKCC_TS_NATIVE_CROSS=1: ~20 minutes more).
      if (process.env.YAKCC_TS_NATIVE_CROSS === "1")
        for (const [target, qemu] of [
          ["aarch64-linux", "qemu-aarch64"],
          ["riscv64-linux", "qemu-riscv64"],
          ["arm-linux", "qemu-arm"],
        ] as const) {
          if (!canRun(target)) continue;
          const cross = join(work, `tsc-native-${target}`);
          buildRecord(record, cross, { target, noLibc: true });
          const r = spawnSync(qemu, [cross, sources[0] as string], {
            encoding: "utf8",
            timeout: 900_000,
          });
          expect([target, r.status, r.stderr, r.stdout]).toEqual([target, 0, "", `${want[0]}\n`]);
        }
    }, 7_000_000);
  },
);
