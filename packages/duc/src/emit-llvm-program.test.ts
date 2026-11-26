// SPDX-License-Identifier: Apache-2.0
/**
 * Programs, natively (#1333, #1361): an entry module and every module it imports, ECMAScript
 * modules linked (live bindings, re-exports, `export *`, evaluation order), lowered, linked with the
 * runtime, and called. The interim acceptance's program: @yakcc/contracts' canonicalize and
 * contract id, with BLAKE3 from @noble/hashes, from their sources; its results must be Node's.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalizeText } from "../../contracts/src/canonicalize.js";
import { contractId } from "../../contracts/src/contract-id.js";
import { canRun, decode, encode, same } from "./__fixtures__/native-harness.js";
import { buildProgram } from "./build.js";
import { emitNativeModules } from "./emit-llvm-boxed.js";
import { compileObject, compileRuntime } from "./native.js";
import { programRecord } from "./program.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const work = mkdtempSync(join(tmpdir(), "yakcc-program-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const HARNESS = `#include <stdio.h>
#include <stdint.h>
#include <string.h>
typedef uint64_t yk;
yk yk_read(FILE *); void yk_write(FILE *, yk);
yk yk_call_method(yk, const char *, uint64_t, uint64_t, const yk *);
extern yk ENTRY(void);
int main(void) {
  yk exports = ENTRY();
  char member[128]; unsigned argc;
  while (scanf("%127s %u", member, &argc) == 2) {
    yk argv[8];
    for (unsigned i = 0; i < argc; i++) argv[i] = yk_read(stdin);
    yk_write(stdout, yk_call_method(exports, member, strlen(member), argc, argv));
    fputc('\\n', stdout); fflush(stdout);
  }
  return 0;
}
`;

/** A program built natively; a runner of (export, arguments) calls. */
function nativeProgram(
  name: string,
  entry: string,
): (calls: readonly [string, unknown[]][]) => unknown[] {
  const program = programRecord(entry, here("../../.."));
  const { ir, symbols } = emitNativeModules(program.modules);
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "p.o"), compileObject({ ir, symbol: "", params: [], result: "i64" }));
  writeFileSync(join(dir, "yk.o"), compileRuntime());
  writeFileSync(join(dir, "h.c"), HARNESS);
  const cc = spawnSync(
    "cc",
    [`-DENTRY=${symbols[program.entry]}`, "h.c", "p.o", "yk.o", "-lm", "-o", "run"],
    {
      cwd: dir,
    },
  );
  if (cc.status !== 0) throw new Error(cc.stderr.toString());
  return (calls) => {
    const input = calls.map(([m, a]) => `${m} ${a.length} ${a.map(encode).join(" ")}`).join("\n");
    const run = spawnSync(join(dir, "run"), [], { input: `${input}\n`, maxBuffer: 1 << 26 });
    const got = run.stdout
      .toString()
      .split("\n")
      .filter((l) => l !== "")
      .map(decode);
    if (got.length !== calls.length)
      throw new Error(`ran ${got.length} of ${calls.length}: ${run.stderr.toString()}`);
    return got;
  };
}

const spec = fc.record({
  inputs: fc.array(
    fc.record({
      name: fc.string({ minLength: 1, maxLength: 16 }),
      type: fc.string({ minLength: 1, maxLength: 32 }),
    }),
    { maxLength: 3 },
  ),
  outputs: fc.array(
    fc.record({
      name: fc.string({ minLength: 1, maxLength: 16 }),
      type: fc.string({ minLength: 1, maxLength: 32 }),
    }),
    { maxLength: 3 },
  ),
  behavior: fc.string({ minLength: 1, maxLength: 200 }),
  guarantees: fc.array(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 16 }),
      description: fc.string({ minLength: 1, maxLength: 100 }),
    }),
    { maxLength: 3 },
  ),
  errorConditions: fc.array(
    fc.record({ description: fc.string({ minLength: 1, maxLength: 100 }) }),
    { maxLength: 2 },
  ),
  nonFunctional: fc.record({
    purity: fc.constantFrom("pure", "io"),
    threadSafety: fc.constantFrom("safe", "unsafe"),
  }),
  propertyTests: fc.array(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 16 }),
      description: fc.string({ minLength: 1, maxLength: 100 }),
    }),
    { maxLength: 2 },
  ),
});

describe.skipIf(!canRun("x86_64-linux"))("programs, natively (#1333)", () => {
  it("ECMAScript modules: live bindings, renames, re-exports, export *, namespaces, defaults, order, a cycle", async () => {
    const entry = here("./__fixtures__/program/esm/entry.ts");
    const run = nativeProgram("esm", entry);
    // The reference: Node's own linking of the same modules.
    const ref = (await import("./__fixtures__/program/esm/entry.js")) as unknown as {
      probe: (k: number) => unknown;
      increment: (k: number) => void;
    };
    const calls: [string, unknown[]][] = [
      ["probe", [3]],
      ["probe", [4]],
      ["increment", [5]],
      ["probe", [0]],
    ];
    const got = run(calls);
    const want = calls.map(([m, a]) =>
      (ref as unknown as Record<string, (...x: unknown[]) => unknown>)[m]?.(...a),
    );
    expect(got.map((g, i) => same(g, want[i]) || [calls[i], g, want[i]])).toEqual(
      calls.map(() => true),
    );
  }, 600_000);

  it("record results: a function's object literal read by key without being made (#1369)", async () => {
    const run = nativeProgram("records", here("./__fixtures__/program/records/entry.ts"));
    const calls: [string, unknown[]][] = [
      ["sums", [0]],
      ["sums", [500]],
      ["mixed", [3, 4]],
      ["mixed", ["a", 2]],
      ["mixed", [null, undefined]],
      ["hashLoop", [0, 50]],
      ["hashLoop", [4294967295, 50]],
      ["hashLoop", [-5, 9]],
      ["hashLoop", [2 ** 40, 9]],
      ["hashLoop", [1.5, 9]],
      ["hashLoop", ["q", 9]],
      ["hashLoop", [Number.NaN, 3]],
      ["hashLoop", [-0, 3]],
      [
        "stepAll",
        [[1, 4294967295, -3, 2 ** 31, -(2 ** 31) - 1, 1.5, "z", Number.NaN, -0, null, 7]],
      ],
      ["rounds", [[1, 4294967295, -3, 2 ** 31, 1.5, "z", Number.NaN, -0, null, 7, "12"], 5]],
      ["rounds", [[3, 9, 2 ** 40], "3"]],
      ["named", [21]],
      ["views", [7]],
      ["views", [-123456]],
    ];
    const got = run(calls);
    const ref = (await import("./__fixtures__/program/records/entry.js")) as unknown as Record<
      string,
      (...x: unknown[]) => unknown
    >;
    const want = calls.map(([m, a]) => ref[m]?.(...a));
    expect(got.map((g, i) => same(g, want[i]) || [calls[i], g, want[i]])).toEqual(
      calls.map(() => true),
    );
  }, 600_000);

  it("CommonJS modules: required by path, an optional dependency that does not resolve (#1370)", () => {
    const run = nativeProgram("cjs", here("./__fixtures__/program/cjs/entry.cjs"));
    const ref = createRequire(import.meta.url)("./__fixtures__/program/cjs/entry.cjs") as {
      probe: (n: number) => unknown;
    };
    const calls: [string, unknown[]][] = [
      ["probe", [3]],
      ["probe", [10]],
    ];
    const got = run(calls);
    const want = calls.map(([, a]) => ref.probe(a[0] as number));
    expect(got.map((g, i) => same(g, want[i]) || [calls[i], g, want[i]])).toEqual(
      calls.map(() => true),
    );
  }, 600_000);

  it("import(): a module loaded in a job, its namespace the promise's; a missing one rejects (#1370)", () => {
    const entry = here("./__fixtures__/program/dynamic/entry.js");
    const exe = join(work, "dynamic-run");
    buildProgram(entry, exe, { root: here("../../..") });
    const native = spawnSync(exe, [], { encoding: "utf8", timeout: 60_000 });
    const node = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 60_000 });
    expect(native.stderr).toBe("");
    expect(native.stdout).toBe(node.stdout);
  }, 600_000);

  it("promise rejections: handled ones end nothing; one nothing handles ends the program, exit 1; an async try's jobs (#1361 P2)", () => {
    for (const name of ["handled", "unhandled", "try-order"]) {
      const entry = here(`./__fixtures__/program/rejections/${name}.js`);
      const exe = join(work, `rejections-${name}`);
      buildProgram(entry, exe, { root: here("../../..") });
      const native = spawnSync(exe, [], { encoding: "utf8", timeout: 60_000 });
      const node = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 60_000 });
      expect(native.stdout).toBe(node.stdout);
      expect(native.status).toBe(node.status);
      // Node prints the error's stack (frames the runtime does not keep): its name and message.
      if (name === "unhandled") expect(native.stderr).toBe("Uncaught RangeError: nobody listens\n");
      else expect(native.stderr).toBe("");
    }
  }, 600_000);

  it("top-level await: an awaiting module and its importers evaluated asynchronously, in order; import() waits (#1361 P2)", () => {
    const entry = here("./__fixtures__/program/tla/entry.mjs");
    const exe = join(work, "tla-run");
    buildProgram(entry, exe, { root: here("../../..") });
    const native = spawnSync(exe, [], { encoding: "utf8", timeout: 60_000 });
    const node = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 60_000 });
    expect(native.stderr).toBe("");
    expect(native.stdout).toBe(node.stdout);
    expect(native.status).toBe(0);
  }, 600_000);

  it("zod 4 (yakcc's closure): schemas built, parsed and refused as Node's (#1368, #1361 P2)", () => {
    const entry = here("./__fixtures__/program/zod/entry.mjs");
    const exe = join(work, "zod-run");
    buildProgram(entry, exe, { root: here("../../..") });
    const native = spawnSync(exe, [], { encoding: "utf8", timeout: 60_000 });
    const node = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 60_000 });
    expect(native.stderr).toBe("");
    expect(native.stdout).toBe(node.stdout);
    expect(native.status).toBe(0);
  }, 1_200_000);

  it("@yakcc/contracts' canonicalize and contract id (BLAKE3 from @noble/hashes), from their sources, equal Node's", () => {
    const run = nativeProgram("contract-id", here("./__fixtures__/program/contract-id-entry.ts"));
    const specs = fc.sample(spec, { numRuns: 100, seed: 1333 });
    const calls: [string, unknown[]][] = specs.flatMap((s) => [
      ["textOf", [s]] as [string, unknown[]],
      ["idOf", [s]] as [string, unknown[]],
    ]);
    const got = run(calls);
    const bad: string[] = [];
    specs.forEach((s, i) => {
      const t = canonicalizeText(s as never);
      const id = contractId(s as never);
      if (!same(got[2 * i], t) && bad.length < 3)
        bad.push(`text: ${JSON.stringify(got[2 * i])} vs ${JSON.stringify(t)}`);
      if (!same(got[2 * i + 1], id) && bad.length < 3)
        bad.push(`id: ${JSON.stringify(got[2 * i + 1])} vs ${id}`);
    });
    expect(bad).toEqual([]);
  }, 600_000);

  it("yakcc build --native: the acceptance command, built into an executable, prints what Node does", () => {
    const exe = join(work, "bin", "contract-id");
    const built = buildProgram(here("./__fixtures__/program/contract-id-cli.ts"), exe, {
      root: here("../../.."),
    });
    expect(built.modules.some((m) => m.endsWith("@noble/hashes/blake3.js"))).toBe(true);
    const specs = fc.sample(spec, { numRuns: 40, seed: 1361 });
    const run = spawnSync(
      exe,
      specs.map((s) => JSON.stringify(s)),
      { maxBuffer: 1 << 24 },
    );
    expect(run.stderr.toString()).toBe("");
    expect(run.status).toBe(0);
    const want = specs.map(
      (s) => `${contractId(s as never)} ${canonicalizeText(s as never).length}`,
    );
    expect(run.stdout.toString().split("\n").slice(0, -1)).toEqual(want);
    // No argument: the usage on stderr, exit code 2; malformed JSON: an uncaught SyntaxError, exit 1.
    const none = spawnSync(exe, []);
    expect([none.status, none.stdout.toString(), none.stderr.toString()]).toEqual([
      2,
      "",
      "usage: contract-id <spec.json>...\n",
    ]);
    const bad = spawnSync(exe, ["{not json"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr.toString()).toMatch(/SyntaxError/);
  }, 600_000);

  it("yakcc build --native with no C library: the acceptance command, static on system calls alone, prints what Node does", () => {
    const exe = join(work, "bin", "contract-id-nolibc");
    buildProgram(here("./__fixtures__/program/contract-id-cli.ts"), exe, {
      root: here("../../.."),
      noLibc: true,
    });
    // Static, no interpreter, and none of a C library's symbols.
    const headers = spawnSync("readelf", ["-lW", exe]).stdout.toString();
    expect(headers).not.toMatch(/INTERP|DYNAMIC/);
    const symbols = spawnSync("nm", [exe]).stdout.toString();
    expect(symbols).not.toMatch(/__libc_start_main|GLIBC|__libc_/);
    const specs = fc.sample(spec, { numRuns: 40, seed: 1370 });
    const run = spawnSync(
      exe,
      specs.map((s) => JSON.stringify(s)),
      { maxBuffer: 1 << 24 },
    );
    expect([run.status, run.stderr.toString()]).toEqual([0, ""]);
    const want = specs.map(
      (s) => `${contractId(s as never)} ${canonicalizeText(s as never).length}`,
    );
    expect(run.stdout.toString().split("\n").slice(0, -1)).toEqual(want);
    const none = spawnSync(exe, []);
    expect([none.status, none.stdout.toString(), none.stderr.toString()]).toEqual([
      2,
      "",
      "usage: contract-id <spec.json>...\n",
    ]);
    const bad = spawnSync(exe, ["{not json"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr.toString()).toMatch(/SyntaxError/);
  }, 600_000);

  // #1333's acceptance: the same command on AArch64, ARMv7 and RISC-V (run under QEMU).
  for (const [target, qemu] of [
    ["aarch64-linux", "qemu-aarch64"],
    ["arm-linux", "qemu-arm"],
    ["riscv64-linux", "qemu-riscv64"],
  ] as const)
    it.skipIf(!canRun(target))(
      `yakcc build --native --target ${target}: the acceptance command prints what Node does`,
      () => {
        const exe = join(work, "bin", `contract-id-${target}`);
        buildProgram(here("./__fixtures__/program/contract-id-cli.ts"), exe, {
          root: here("../../.."),
          target,
        });
        const specs = fc.sample(spec, { numRuns: 12, seed: 1369 });
        const run = spawnSync(qemu, [exe, ...specs.map((s) => JSON.stringify(s))], {
          maxBuffer: 1 << 24,
        });
        expect([run.status, run.stderr.toString()]).toEqual([0, ""]);
        const want = specs.map(
          (s) => `${contractId(s as never)} ${canonicalizeText(s as never).length}`,
        );
        expect(run.stdout.toString().split("\n").slice(0, -1)).toEqual(want);
        // With no C library: static on the target's system calls alone, the same output.
        const bare = join(work, "bin", `contract-id-${target}-nolibc`);
        buildProgram(here("./__fixtures__/program/contract-id-cli.ts"), bare, {
          root: here("../../.."),
          target,
          noLibc: true,
        });
        expect(spawnSync("readelf", ["-lW", bare]).stdout.toString()).not.toMatch(/INTERP|DYNAMIC/);
        const nolibc = spawnSync(qemu, [bare, ...specs.map((s) => JSON.stringify(s))], {
          maxBuffer: 1 << 24,
        });
        expect([nolibc.status, nolibc.stderr.toString()]).toEqual([0, ""]);
        expect(nolibc.stdout.toString().split("\n").slice(0, -1)).toEqual(want);
      },
      900_000,
    );
});
