// SPDX-License-Identifier: Apache-2.0
// Node's HdrHistogram (#1367: vendor/node/deps/histogram, perf_hooks.createHistogram's), shaved
// from its C source over musl shaved to the leaves. Against Node itself: values recorded into a
// histogram of a range and precision give the same count, exceeding count, min, max, mean and
// standard deviation (their bits), percentiles and percentiles iteration as Node's
// createHistogram; and the whole result (its memory size too) equals the same source compiled
// natively.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHistogram } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { shaveCFiles } from "./__fixtures__/c-files.js";
import { type Fn, link } from "./__fixtures__/c-link.js";
import { shaveMusl, withMuslInit } from "./__fixtures__/c-musl.js";
import { createCMemory, createCSystem, shaveCUnit } from "./raise-c.js";

const hasClang = (() => {
  try {
    execFileSync("clang", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const HIST = fileURLToPath(new URL("../vendor/node/deps/histogram/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/node-histogram.c", import.meta.url));
const ARGS = ["-std=gnu11", `-I${HIST}include`, `-I${HIST}src`];
const FILES = [join(HIST, "src/hdr_histogram.c")];
const PS = [50, 90, 99, 99.9, 100, 0.1, 25];

type Case = { values: bigint[]; lowest: bigint; highest: bigint; figures: number };
const MAX = BigInt(Number.MAX_SAFE_INTEGER);

const bits = (v: number): string => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v);
  return b.toString("hex");
};
/** (A NaN's sign and payload are the machine's: x86's 0.0 / 0.0 is negative; V8 canonicalizes.) */
const nan = (s: string): string => s.replace(/\b(7ff8|fff8)000000000000\b/g, "NaN");

/** Node's createHistogram, written as the fixture writes it (less its memory size). */
const node = (c: Case): string => {
  const h = createHistogram({ lowest: c.lowest, highest: c.highest, figures: c.figures });
  for (const v of c.values) h.record(v);
  let s = `count ${h.count} exceeds ${h.exceeds} min ${h.minBigInt} max ${h.maxBigInt} mean ${bits(h.mean)} stddev ${bits(h.stddev)}`;
  PS.forEach((p, i) => {
    s += ` p${i}=${h.percentileBigInt(p)}`;
  });
  for (const [k, v] of h.percentiles) s += ` ${bits(k)}=${v}`;
  return s;
};

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-c-node-histogram-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasClang)("Node's HdrHistogram, shaved from C, against perf_hooks", () => {
  const fixture = shaveCUnit(FIXTURE, ["yk_histogram"], ARGS, "clang", "node-histogram.c");
  const roots = [...new Set([...fixture.atoms.values()].flatMap((a) => a.externals))];
  const hist = shaveCFiles(FILES, roots, ARGS);
  const libc = [...new Set([...hist.externals, ...roots])].filter(
    (x) => !fixture.atoms.has(x) && !hist.atoms.has(x),
  );
  const musl = withMuslInit(shaveMusl(libc));

  it("HdrHistogram shaves with no refusal, its C library down to the leaves", () => {
    expect([...fixture.refused]).toEqual([]);
    expect(hist.refused).toEqual([]);
    expect(musl.refused).toEqual([]);
    expect(musl.missing).toEqual([]);
  });

  const all: Case[] = [
    { values: [], lowest: 1n, highest: MAX, figures: 3 },
    { values: [1n], lowest: 1n, highest: MAX, figures: 3 },
    ...fc.sample(
      fc
        .record({
          lowest: fc.constantFrom(1n, 1n, 10n, 1000n),
          span: fc.constantFrom(1n << 20n, 1n << 40n, MAX),
          figures: fc.integer({ min: 1, max: 4 }),
          values: fc.array(
            fc.oneof(
              fc.bigInt({ min: 1n, max: 2000n }),
              fc.bigInt({ min: 1n, max: 1n << 20n }),
              fc.bigInt({ min: 1n, max: 1n << 40n }),
              fc.bigInt({ min: 1n, max: MAX }),
            ),
            { maxLength: 300 },
          ),
        })
        .map(({ lowest, span, figures, values }) => ({
          lowest,
          highest: span < 2n * lowest ? 2n * lowest : span,
          figures,
          values,
        })),
      { numRuns: 40, seed: 1367 },
    ),
  ];

  const native = (): string[] => {
    const driver = join(work, "driver.c");
    writeFileSync(
      driver,
      `#include <stdio.h>
#include <stdlib.h>
long yk_histogram(const long long *, long, long long, long long, int, const double *, long, char *, long);
static long long vals[1 << 12];
int main(void) {
  static char line[1 << 16], out[1 << 18];
  const double ps[] = {${PS.join(", ")}};
  while (fgets(line, sizeof line, stdin)) {
    char *p = line;
    long long lo = strtoll(p, &p, 10), hi = strtoll(p, &p, 10);
    int fig = (int)strtol(p, &p, 10);
    long n = 0;
    while (*p && *p != '\\n') { char *q; long long v = strtoll(p, &q, 10); if (q == p) break; vals[n++] = v; p = q; }
    long r = yk_histogram(vals, n, lo, hi, fig, ps, ${PS.length}, out, sizeof out);
    fwrite(out, 1, r > 0 ? r : 0, stdout);
    putchar('\\n');
  }
  return 0;
}
`,
    );
    const exe = join(work, "histogram");
    execFileSync("clang", [...ARGS, "-O1", driver, FIXTURE, ...FILES, "-lm", "-o", exe]);
    const input = all
      .map((c) => `${c.lowest} ${c.highest} ${c.figures} ${c.values.join(" ")}`)
      .join("\n");
    return execFileSync(exe, { input: `${input}\n`, encoding: "utf8", maxBuffer: 1 << 26 })
      .split("\n")
      .slice(0, all.length);
  };

  for (const lowered of [false, true])
    it(`each histogram's results equal Node's createHistogram, and native (${lowered ? "lifted to a graph and lowered" : "as raised"})`, () => {
      const want = native();
      const memory = createCMemory();
      const system = createCSystem(memory);
      const env = link(
        new Map([...musl.atoms, ...hist.atoms, ...fixture.atoms]),
        lowered,
        memory,
        [...musl.units, ...hist.units, fixture],
        system.leaves as unknown as Record<string, Fn>,
      );
      env.yk_musl_init?.();
      const cap = 1 << 18;
      const out = memory.leaves.__ykAlloc(cap, 16);
      const ps = memory.leaves.__ykAlloc(8 * PS.length, 8);
      PS.forEach((p, i) => memory.leaves.__ykStoreF64(ps + 8 * i, p));
      const bad: string[] = [];
      all.forEach((c, i) => {
        let got: string;
        try {
          const v = memory.leaves.__ykAlloc(8 * Math.max(1, c.values.length), 8);
          c.values.forEach((x, j) => memory.leaves.__ykStore64(v + 8 * j, x));
          const n = Number(
            (env.yk_histogram as Fn)(
              v,
              BigInt(c.values.length),
              c.lowest,
              c.highest,
              c.figures,
              ps,
              BigInt(PS.length),
              out,
              BigInt(cap),
            ),
          );
          got = Buffer.from(memory.get(out, Math.max(0, n))).toString("utf8");
        } catch (e) {
          got = `trap: ${(e as Error).message}`;
        }
        const label = `${c.lowest}..${c.highest} figures ${c.figures}, ${c.values.length} values`;
        if (got !== want[i])
          bad.push(`${label}\n  shaved ${got.slice(0, 300)}\n  C      ${want[i]?.slice(0, 300)}`);
        const n = node(c);
        const mine = nan(got.replace(/ size \d+$/, ""));
        if (mine !== nan(n))
          bad.push(`${label}\n  shaved ${mine.slice(0, 300)}\n  Node   ${n.slice(0, 300)}`);
      });
      expect(bad.slice(0, 5)).toEqual([]);
    }, 1_800_000);
});
