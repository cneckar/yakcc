// SPDX-License-Identifier: Apache-2.0
/**
 * Programs, natively (#1333, #1361): an entry module and every module it imports, ECMAScript
 * modules linked (live bindings, re-exports, `export *`, evaluation order), lowered, linked with the
 * runtime, and called. The interim acceptance's program: @yakcc/contracts' canonicalize and
 * contract id, with BLAKE3 from @noble/hashes, from their sources; its results must be Node's.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      },
      900_000,
    );
});
