// SPDX-License-Identifier: MIT
/**
 * native-package.test.ts — shaved npm packages compiled to native code (#1292, #1290).
 *
 * Production sequence: shavePackage(fixture) → collectForestSlicePlans → each entry lifted
 *   (liftAtom, atomShape) → a module record per file → emitNativeModules → llc (compileObject) +
 *   clang (compileRuntime) → linked by `cc` with a C harness → each call's result compared with
 *   what Node's own `require` of the real package computes.
 *
 * Skipped where llc, clang or cc is missing, or the host is not x86-64 Linux.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  type NativeModule,
  atomShape,
  compileObject,
  compileRuntime,
  emitNativeModules,
  liftAtom,
} from "@yakcc/duc";
import { collectForestSlicePlans, shavePackage, slice } from "@yakcc/shave";
import { afterAll, describe, expect, it } from "vitest";

const FIXTURES = resolve(__dirname, "../../shave/src/__fixtures__/module-graph");
const has = (tool: string): boolean => spawnSync(tool, ["--version"]).status === 0;
const TOOLS =
  has("llc") && has("clang") && has("cc") && process.platform === "linux" && process.arch === "x64";
const work = mkdtempSync(join(tmpdir(), "yakcc-native-pkg-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A package shaved into module records, as the receiver takes them (#1290). */
async function modulesOf(pkg: string): Promise<NativeModule[]> {
  const registry = { findByCanonicalAstHash: async () => [] };
  const forest = await shavePackage(join(FIXTURES, pkg), { registry });
  const plans = await collectForestSlicePlans(forest, slice, registry);
  return plans.map(({ filePath, slicePlan }) => {
    const statements = slicePlan.entries.flatMap((e) => {
      if (e.kind !== "novel-glue" || typeof e.source !== "string") return [];
      const shape = atomShape(e.source);
      return [
        {
          kind: shape.kind,
          declares:
            shape.kind === "function"
              ? shape.name !== undefined
                ? [shape.name]
                : []
              : shape.names,
          graph: liftAtom(e.source),
        },
      ];
    });
    const requires: Record<string, string> = {};
    for (const e of slicePlan.entries) {
      if (typeof e.source !== "string") continue;
      for (const m of e.source.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
        const spec = m[1] as string;
        const base = resolve(dirname(filePath), spec);
        const hit = [base, `${base}.js`, join(base, "index.js")].find(
          (f) => existsSync(f) && plans.some((p) => p.filePath === f),
        );
        if (hit !== undefined) requires[spec] = relative(join(FIXTURES, pkg), hit);
      }
    }
    return { id: relative(join(FIXTURES, pkg), filePath), statements, requires };
  });
}

const encode = (v: unknown): string => {
  if (typeof v === "number") {
    const d = new DataView(new ArrayBuffer(8));
    d.setFloat64(0, v);
    return `n${d.getBigUint64(0).toString(16).padStart(16, "0")}`;
  }
  if (typeof v === "string")
    return `s${v.length}:${Array.from({ length: v.length }, (_, i) => v.charCodeAt(i).toString(16).padStart(4, "0")).join("")}`;
  if (Array.isArray(v)) return [`a${v.length}`, ...v.map(encode)].join(" ");
  if (v !== null && typeof v === "object")
    return [
      `o${Object.keys(v).length}`,
      ...Object.entries(v).flatMap(([k, x]) => [encode(k), encode(x)]),
    ].join(" ");
  return v === undefined ? "u" : v === null ? "l" : v === true ? "t" : "f";
};
const decode = (text: string): unknown => {
  let at = 0;
  const read = (): unknown => {
    while (text[at] === " ") at++;
    const c = text[at++];
    const count = (): number => {
      let end = at;
      while (/[0-9]/.test(text[end] as string)) end++;
      const n = Number(text.slice(at, end));
      at = end;
      return n;
    };
    if (c === "n") {
      const d = new DataView(new ArrayBuffer(8));
      d.setBigUint64(0, BigInt(`0x${text.slice(at, at + 16)}`));
      at += 16;
      return d.getFloat64(0);
    }
    if (c === "s") {
      const n = count();
      at++;
      let s = "";
      for (let i = 0; i < n; i++, at += 4)
        s += String.fromCharCode(Number.parseInt(text.slice(at, at + 4), 16));
      return s;
    }
    if (c === "a") return Array.from({ length: count() }, read);
    if (c === "o") {
      const o: Record<string, unknown> = {};
      for (let i = count(); i > 0; i--) o[read() as string] = read();
      return o;
    }
    return { u: undefined, l: null, t: true, f: false }[c as "u" | "l" | "t" | "f"];
  };
  return read();
};

const HARNESS = `#include <stdio.h>
#include <stdint.h>
#include <string.h>
typedef uint64_t yk;
yk yk_read(FILE *); void yk_write(FILE *, yk);
yk yk_call(yk, yk, uint64_t, const yk *); yk yk_call_method(yk, const char *, uint64_t, uint64_t, const yk *);
extern yk ENTRY(void);
int main(void) {
  yk exports = ENTRY();
  char member[64]; unsigned argc;
  while (scanf("%63s %u", member, &argc) == 2) {
    yk argv[8];
    for (unsigned i = 0; i < argc; i++) argv[i] = yk_read(stdin);
    yk r = strcmp(member, "-") == 0 ? yk_call(exports, 0, argc, argv) : yk_call_method(exports, member, strlen(member), argc, argv);
    yk_write(stdout, r); fputc('\\n', stdout); fflush(stdout);
  }
  return 0;
}
`;

/** The package compiled and linked; each call is (member or "-" for the exports itself, args). */
async function nativePackage(pkg: string, entry: string) {
  const { ir, symbols } = emitNativeModules(await modulesOf(pkg));
  const dir = join(work, pkg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pkg.o"), compileObject({ ir, symbol: "", params: [], result: "i64" }));
  writeFileSync(join(dir, "yk.o"), compileRuntime());
  writeFileSync(join(dir, "h.c"), HARNESS);
  const cc = spawnSync(
    "cc",
    [`-DENTRY=${symbols[entry]}`, "h.c", "pkg.o", "yk.o", "-lm", "-o", "run"],
    { cwd: dir },
  );
  if (cc.status !== 0) throw new Error(cc.stderr.toString());
  return (calls: readonly [string, unknown[]][]): { results: unknown[]; stderr: string } => {
    const input = calls
      .map(([m, args]) => `${m} ${args.length} ${args.map(encode).join(" ")}`)
      .join("\n");
    const run = spawnSync(join(dir, "run"), [], { input: `${input}\n` });
    const lines = run.stdout
      .toString()
      .split("\n")
      .filter((l) => l !== "");
    return { results: lines.map(decode), stderr: run.stderr.toString() };
  };
}

/** What Node's own require of the real package gives for each call: a value, or what it throws. */
function reference(pkg: string, entry: string, calls: readonly [string, unknown[]][]): unknown[] {
  const real = createRequire(__filename)(join(FIXTURES, pkg, entry)) as Record<
    string,
    (...a: unknown[]) => unknown
  > &
    ((...a: unknown[]) => unknown);
  return calls.map(([m, args]) => {
    try {
      const r = m === "-" ? real(...args) : (real[m] as (...a: unknown[]) => unknown)(...args);
      // A typed array is an array of numbers to the native runtime, which has no Uint8Array.
      return ArrayBuffer.isView(r) ? Array.from(r as Uint8Array) : r;
    } catch (e) {
      return { threw: String(e) };
    }
  });
}

describe.skipIf(!TOOLS)("shaved npm packages compiled to native code (#1292)", () => {
  const CASES: [string, string, [string, unknown[]][]][] = [
    [
      "three-module-pkg",
      "index.js",
      [
        ["-", ["421"]],
        ["-", [42, { long: true }]],
        ["-", [42]],
        ["-", ["abc"]],
      ],
    ],
    [
      "circular-pkg",
      "a.js",
      [
        ["fromA", [5]],
        ["fromA", ["3"]],
      ],
    ],
    [
      "base64-js-1.5.1",
      "index.js",
      [
        ["byteLength", ["SGVsbG8sIHdvcmxkIQ=="]],
        ["byteLength", ["QQ=="]],
        ["toByteArray", ["SGVsbG8sIHdvcmxkIQ=="]],
        ["toByteArray", ["-_-_"]],
        ["toByteArray", [""]],
        ["fromByteArray", [[72, 101, 108, 108, 111, 0, 255, 128]]],
        ["fromByteArray", [Array.from({ length: 100 }, (_, i) => (i * 37) % 256)]],
        ["fromByteArray", [[]]],
      ],
    ],
    [
      "toposort-2.0.2",
      "index.js",
      [
        [
          "-",
          [
            [
              ["shirt", "tie"],
              ["tie", "jacket"],
              ["pants", "shoes"],
              ["underpants", "pants"],
              ["socks", "shoes"],
              ["pants", "belt"],
              ["belt", "jacket"],
              ["shirt", "belt"],
            ],
          ],
        ],
        [
          "array",
          [
            ["a", "b", "c", "d"],
            [
              ["b", "a"],
              ["c", "b"],
            ],
          ],
        ],
        ["-", [[["x", "y"]]]],
      ],
    ],
  ];
  for (const [pkg, entry, calls] of CASES) {
    it(`${pkg}: every call computes what Node's require of the package computes`, async () => {
      const run = await nativePackage(pkg, entry);
      const { results, stderr } = run(calls);
      expect(stderr).toBe("");
      expect(results).toEqual(reference(pkg, entry, calls));
    }, 300_000);
  }

  it("toposort: a cycle throws the package's own error, uncaught, as Node's does", async () => {
    const calls: [string, unknown[]][] = [
      [
        "-",
        [
          [
            ["a", "b"],
            ["b", "a"],
          ],
        ],
      ],
    ];
    const run = await nativePackage("toposort-2.0.2", "index.js");
    const { stderr } = run(calls);
    const [want] = reference("toposort-2.0.2", "index.js", calls) as [{ threw: string }];
    expect(stderr.trim()).toBe(`Uncaught ${want.threw}`);
  }, 300_000);
});
