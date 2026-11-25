// SPDX-License-Identifier: Apache-2.0
// musl's libc beyond strings, shaved down to the leaves (#1365): mallocng (malloc, free, realloc,
// malloc_usable_size, calloc) over the system-call leaf. The shaved closure runs in the memory
// leaves with the system call in JavaScript (createCSystem); the oracle is the same sources
// compiled natively (the leaves as a few lines of C over the host's syscall). A random sequence of
// allocations, reallocations and frees runs on both; each step's result (the usable size, the
// alignment, every live block still holding its own bytes) must be the same.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { type Fn, link } from "./__fixtures__/c-link.js";
import { buildMuslNative, shaveMusl, withMuslInit } from "./__fixtures__/c-musl.js";
import { createCMemory, createCSystem } from "./raise-c.js";

const hasClang = (() => {
  try {
    execFileSync("clang", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-c-libc-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const ROOTS = [
  "__libc_malloc_impl",
  "__libc_free",
  "__libc_realloc",
  "malloc_usable_size",
  "calloc",
];

describe.skipIf(!hasClang)("musl's mallocng, shaved down to the system-call leaf", () => {
  const closure = withMuslInit(shaveMusl(ROOTS));

  it("the closure shaves with no refusal, and stops only at the leaves", () => {
    expect(closure.refused).toEqual([]);
    // calloc's own call of the public malloc is the one name outside mallocng's closure.
    expect(closure.missing.filter((m) => m !== "malloc")).toEqual([]);
    for (const r of ROOTS) expect(closure.atoms.has(r), r).toBe(true);
  });

  /** One step: [kind, slot, size]. */
  type Op = ["m" | "r" | "f", number, number];
  const ops = (seed: number): Op[] =>
    fc.sample(
      fc.tuple(
        fc.constantFrom<"m" | "r" | "f">("m", "m", "r", "f"),
        fc.integer({ min: 0, max: 31 }),
        fc.oneof(
          fc.integer({ min: 0, max: 64 }),
          fc.integer({ min: 0, max: 4096 }),
          fc.integer({ min: 4096, max: 300000 }),
        ),
      ),
      { numRuns: 400, seed },
    ) as Op[];

  // The native side: the closure's files compiled from the same sources, with the leaves in C.
  let exe = "";
  const build = (): void => {
    exe = buildMuslNative(
      closure.units,
      work,
      "malloc",
      `#include <stdio.h>
#include <stdint.h>
#include <string.h>
void *__libc_malloc_impl(size_t);
void __libc_free(void *);
void *__libc_realloc(void *, size_t);
size_t malloc_usable_size(void *);
void yk_musl_init(void);
static unsigned char *slot[32]; static size_t len[32];
static int intact(void) {
  for (int i = 0; i < 32; i++) for (size_t j = 0; j < len[i]; j++) if (slot[i][j] != (unsigned char)(i * 31 + j)) return 0;
  return 1;
}
int main(void) {
  yk_musl_init();
  char k; int s; size_t n;
  while (scanf(" %c %d %zu", &k, &s, &n) == 3) {
    if (k == 'f') { __libc_free(slot[s]); slot[s] = 0; len[s] = 0; }
    else {
      unsigned char *p = k == 'm' ? __libc_malloc_impl(n) : __libc_realloc(slot[s], n);
      if (k == 'm') __libc_free(slot[s]);
      if (p) { for (size_t j = (k == 'r' && len[s] < n ? len[s] : (k == 'r' ? n : 0)); j < n; j++) p[j] = (unsigned char)(s * 31 + j); }
      slot[s] = p; len[s] = p ? n : 0;
    }
    printf("%zu %d %d\\n", slot[s] ? malloc_usable_size(slot[s]) : 0, slot[s] ? (int)((uintptr_t)slot[s] % 16) : -1, intact());
  }
  return 0;
}
`,
    );
  };

  /** The same steps on the shaved atoms. */
  const runShaved = (
    env: Record<string, Fn>,
    m: ReturnType<typeof createCMemory>,
    seq: Op[],
  ): string[] => {
    const slot = new Array<number>(32).fill(0);
    const len = new Array<number>(32).fill(0);
    const out: string[] = [];
    const intact = (): boolean =>
      slot.every(
        (p, i) =>
          len[i] === 0 || m.get(p, len[i] as number).every((b, j) => b === ((i * 31 + j) & 255)),
      );
    for (const [k, s, n] of seq) {
      if (k === "f") {
        env.__libc_free?.(slot[s]);
        slot[s] = 0;
        len[s] = 0;
      } else {
        const p = (
          k === "m" ? env.__libc_malloc_impl?.(BigInt(n)) : env.__libc_realloc?.(slot[s], BigInt(n))
        ) as number;
        if (k === "m") env.__libc_free?.(slot[s]);
        if (p !== 0) {
          const from = k === "r" ? Math.min(len[s] as number, n) : 0;
          for (let j = from; j < n; j++) m.leaves.__ykStore8(p + j, (s * 31 + j) & 255);
        }
        slot[s] = p;
        len[s] = p !== 0 ? n : 0;
      }
      const p = slot[s] as number;
      const usable = p !== 0 ? (env.malloc_usable_size?.(p) as bigint) : 0n;
      out.push(`${usable} ${p !== 0 ? p % 16 : -1} ${intact() ? 1 : 0}`);
    }
    return out;
  };

  for (const lowered of [false, true]) {
    it(`a sequence of allocations equals mallocng compiled natively (${lowered ? "lifted to a graph and lowered" : "as raised"})`, () => {
      if (!lowered) build();
      const seq = ops(lowered ? 1365 : 13650);
      const native = execFileSync(exe, {
        input: `${seq.map(([k, s, n]) => `${k} ${s} ${n}`).join("\n")}\n`,
        encoding: "utf8",
        maxBuffer: 1 << 26,
      })
        .trim()
        .split("\n");
      const memory = createCMemory();
      const system = createCSystem(memory);
      const env = link(
        closure.atoms,
        lowered,
        memory,
        closure.units,
        system.leaves as unknown as Record<string, Fn>,
      );
      env.yk_musl_init?.();
      const shaved = runShaved(env, memory, seq);
      const bad = shaved.flatMap((x, i) =>
        x === native[i] ? [] : [`step ${i} ${seq[i]?.join(" ")}: shaved ${x}, C ${native[i]}`],
      );
      expect(bad.slice(0, 8)).toEqual([]);
      expect(shaved.every((x) => x.endsWith(" 1"))).toBe(true);
    }, 900_000);
  }

  it("calloc returns zeroed memory, also where malloc had written before", () => {
    const memory = createCMemory();
    const system = createCSystem(memory);
    const env = link(closure.atoms, false, memory, closure.units, {
      ...(system.leaves as unknown as Record<string, Fn>),
      malloc: (n: unknown) => env.__libc_malloc_impl?.(n),
    } as never);
    env.yk_musl_init?.();
    for (const n of [1, 16, 100, 5000, 100000]) {
      const p = env.__libc_malloc_impl?.(BigInt(n)) as number;
      for (let j = 0; j < n; j++) memory.leaves.__ykStore8(p + j, 0xab);
      env.__libc_free?.(p);
      const q = env.calloc?.(BigInt(n), 1n) as number;
      expect(memory.get(q, n).every((b) => b === 0)).toBe(true);
    }
  });
});
