// SPDX-License-Identifier: Apache-2.0
// Operations as references (DEC-DUC-OPERATIONS-AS-ATOMS-001 step 2, #1362): `Math.sin(x)` lifts as
// the operation `Math.sin`, linked to the root of the atom shaved from V8's ieee754.cc; the atoms run
// as lifted graphs, lowered to TypeScript over the leaves' reference implementations, and equal
// Node's Math bit for bit. Needs no clang: the shaved atoms are committed (`atoms/math.ts`), and a
// test checks them against a fresh shave when clang is present.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { ts } from "ts-morph";
import { afterAll, describe, expect, it } from "vitest";
import { canRun, harness } from "./__fixtures__/native-harness.js";
import { MATH_ATOM_SOURCES } from "./atoms/math.js";
import { shaveMathAtoms } from "./atoms/shave-math.js";
import { graphIdentity } from "./canonical.js";
import { closureOf } from "./closure.js";
import { emitLlvmBoxed } from "./emit-llvm-boxed.js";
import { emitTypeScript } from "./emit-ts.js";
import { liftFidelity } from "./fidelity.js";
import { LEAF_FUNCTIONS, isLeafFunction, leafFunctionsJs } from "./leaves.js";
import { liftAtom } from "./lift.js";
import { printLineForm } from "./line-form.js";
import {
  OPERATION_REFERENCES,
  atomCallees,
  atomGraph,
  atomNames,
  atomRoot,
  atomSource,
  linkedAtomGraph,
  operationRoot,
} from "./operations.js";
import { packGraph } from "./store.js";
import type { DucGraph } from "./types.js";

const hasClang = (() => {
  try {
    execFileSync("clang++", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const labels = (g: DucGraph): string[] =>
  g.nodes.flatMap((n) => [
    ...(n.label !== undefined ? [n.label] : []),
    ...(n.closure !== undefined ? labels(n.closure) : []),
  ]);

describe("lifting Math's functions as operations that reference atoms", () => {
  it("Math.sin(x) is the operation Math.sin, pure, with no read of Math", () => {
    const g = liftAtom("export function f(x: number): number { return Math.sin(x); }");
    expect(printLineForm(g).trimEnd()).toBe("param v0\nop Math.sin v0 -> v1\nout v1");
  });

  it("each operation reference, at its arity", () => {
    for (const ref of OPERATION_REFERENCES.values()) {
      const params = Array.from({ length: ref.arity }, (_, i) => `x${i}`);
      const g = liftAtom(
        `export function f(${params.map((p) => `${p}: number`).join(", ")}): number { return ${ref.label}(${params.join(", ")}); }`,
      );
      expect(labels(g), ref.label).toEqual([...params.map((_, i) => String(i)), ref.label]);
    }
  });

  it("a Math that is not the platform's, a spread, or another arity is a call as before", () => {
    for (const source of [
      "export function f(Math: any, x: number): number { return Math.sin(x); }",
      "export function f(x: number): number { const Math = { sin: (y: number) => y }; return Math.sin(x); }",
      "export function f(xs: number[]): number { return Math.sin(...xs); }",
      "export function f(x: number): number { return Math.sin(x, x); }",
      "export function f(x: number): number { return Math.max(x, 1); }",
    ])
      expect(
        labels(liftAtom(source)).some((l) => l.startsWith("Math.")),
        source,
      ).toBe(false);
  });

  it("the TypeScript lowering writes the call back, and the round trip keeps the identity", () => {
    const g = liftAtom(
      "export function f(x: number, y: number): number { return Math.pow(Math.sin(x), 2) + Math.atan2(y, x); }",
    );
    const ts = emitTypeScript(g);
    expect(ts).toContain("Math.sin(");
    expect(ts).toContain("Math.atan2(");
    expect(graphIdentity(liftAtom(ts))).toBe(graphIdentity(g));
  });

  it("the lift is faithful: the reference counts as the source's read of Math", () => {
    for (const source of [
      "return row.score * Math.pow(0.5, halfLives);",
      "export function f(n: number, d: number): number { return Math.log(1 + (n - d) / d); }",
    ]) {
      const fidelity = liftFidelity(source, liftAtom(source));
      expect(fidelity, source).toEqual({ holds: true, missing: [], extra: [] });
    }
  });

  it("inside a closure too", () => {
    const g = liftAtom(
      "export function f(xs: number[]): number[] { return xs.map((x) => Math.cos(x)); }",
    );
    expect(labels(g)).toContain("Math.cos");
    expect(closureOf(g).linked).toEqual(["Math.cos"]);
  });
});

describe("links: an operation reference is linked to its atom's root", () => {
  it("the stored links carry the operation and the root of its atom", () => {
    const packed = packGraph(
      liftAtom("export function f(x: number): number { return Math.exp(x) + Math.log(x); }"),
    );
    expect(packed.links).toEqual([
      { reason: "operation", symbol: "Math.exp", spec: atomRoot("exp") },
      { reason: "operation", symbol: "Math.log", spec: atomRoot("log") },
    ]);
  });

  it("the root commits to the operation's implementation; the identity does not", () => {
    const sin = liftAtom("export function f(x: number): number { return Math.sin(x); }");
    const cos = liftAtom("export function f(x: number): number { return Math.cos(x); }");
    // The labels are structure, so the identities differ; the same graph's root is the same.
    expect(graphIdentity(sin)).not.toBe(graphIdentity(cos));
    expect(packGraph(sin).root).toBe(packGraph(sin).root);
    expect(operationRoot("Math.sin")).toBe(atomRoot("sin"));
  });

  it("an atom's root commits to its callees' roots", () => {
    expect(atomCallees("sin")).toEqual(["__ieee754_rem_pio2", "__kernel_cos", "__kernel_sin"]);
    const links = packGraph(linkedAtomGraph("sin")).links;
    expect(links).toContainEqual({
      reason: "free-identifier",
      symbol: "__kernel_sin",
      spec: atomRoot("__kernel_sin"),
    });
    // scalbn is libc's, linked to the atom shaved from musl.
    expect(atomCallees("__kernel_rem_pio2")).toContain("scalbn");
  });

  it("every root is a 64-hex BLAKE3 digest; atoms share a root only when their graphs are equal", () => {
    const byRoot = new Map<string, string[]>();
    for (const name of atomNames()) {
      const r = atomRoot(name);
      expect(r).toMatch(/^[0-9a-f]{64}$/);
      byRoot.set(r, [...(byRoot.get(r) ?? []), name]);
    }
    const shared = [...byRoot.values()].filter((names) => names.length > 1);
    // numeric_limits<double>::quiet_NaN() and signaling_NaN() both raise to `return NaN`.
    expect(shared).toEqual([["quiet_NaN", "signaling_NaN"]]);
    for (const names of shared)
      expect(new Set(names.map((n) => graphIdentity(atomGraph(n)))).size).toBe(1);
  }, 60_000);
});

describe("the atom library: every atom lifts whole and is closed over leaves and atoms", () => {
  it("36 atoms: V8's 21 functions, their kernels and header code, and musl's scalbn", () => {
    expect(atomNames()).toHaveLength(36);
    for (const ref of OPERATION_REFERENCES.values()) expect(atomNames()).toContain(ref.atom);
  });

  it("no atom lifts to an opaque summary, and every free name is a leaf or an atom", () => {
    for (const name of atomNames()) {
      const g = atomGraph(name);
      expect(
        labels(g).filter((l) => /#[0-9a-f]{16}$/.test(l)),
        name,
      ).toEqual([]);
      const report = closureOf(g, { linked: new Set(atomNames()) });
      expect(report.unlinked, name).toEqual([]);
      for (const leaf of report.leaves) expect(isLeafFunction(leaf)).toBe(true);
    }
  });
});

type Fn = (...a: unknown[]) => unknown;

/** The atoms as functions, each lifted to its graph and lowered to TypeScript, over the leaves. */
function lowerLibrary(): Record<string, Fn> {
  const leaves = leafFunctionsJs() as unknown as Record<string, Fn>;
  const env: Record<string, Fn> = { ...leaves };
  const names = [...Object.keys(leaves), ...atomNames()];
  for (const atom of atomNames()) {
    const js = ts
      .transpileModule(emitTypeScript(atomGraph(atom)), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      })
      .outputText.replace(/^export /m, "");
    env[atom] = new Function(...names, `${js}; return f;`)(
      ...names.map(
        (n) =>
          (...x: unknown[]) =>
            env[n]?.(...x),
      ),
    ) as Fn;
  }
  return env;
}

const doubleOf = (b: bigint): number => {
  const v = new DataView(new ArrayBuffer(8));
  v.setBigUint64(0, BigInt.asUintN(64, b));
  return v.getFloat64(0);
};

describe("the atoms, as lowered graphs, are Node's Math bit for bit", () => {
  const lib = lowerLibrary();
  const edges = [
    0,
    -0,
    1,
    -1,
    0.5,
    2,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MIN_VALUE,
    1e300,
  ];
  const sample = [
    ...edges,
    ...fc.sample(
      fc.oneof(
        fc.double(),
        fc.double({ min: -10, max: 10 }),
        fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }).map(doubleOf),
      ),
      { numRuns: 300, seed: 1362 },
    ),
  ];
  const math = Math as unknown as Record<string, Fn>;
  for (const ref of OPERATION_REFERENCES.values())
    it(ref.label, () => {
      const atom = lib[ref.atom] as Fn;
      const native = math[ref.atom] as Fn;
      const bad: string[] = [];
      for (const [i, x] of sample.entries()) {
        const args = ref.arity === 1 ? [x] : [x, sample[(i * 7 + 3) % sample.length] as number];
        const got = atom(...args);
        const want = native(...args);
        if (!Object.is(got, want))
          bad.push(`${ref.label}(${args.join(", ")}) = ${got}, not ${want}`);
      }
      expect(bad.slice(0, 5)).toEqual([]);
    });
});

describe.skipIf(!canRun("x86_64-linux"))(
  "the atoms, lowered natively, are Node's Math bit for bit (#1362)",
  () => {
    const work = mkdtempSync(join(tmpdir(), "yakcc-math-"));
    afterAll(() => rmSync(work, { recursive: true, force: true }));
    const edges = [
      0,
      -0,
      1,
      -1,
      0.5,
      2,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MIN_VALUE,
      1e300,
    ];
    const sample = [
      ...edges,
      ...fc.sample(
        fc.oneof(
          fc.double(),
          fc.double({ min: -10, max: 10 }),
          fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }).map(doubleOf),
        ),
        { numRuns: 300, seed: 1370 },
      ),
    ];
    const math = Math as unknown as Record<string, Fn>;
    for (const ref of OPERATION_REFERENCES.values())
      it(ref.label, () => {
        const params = ref.arity === 1 ? "x" : "x, y";
        const g = liftAtom(`export function f(${params}) { return ${ref.label}(${params}); }`);
        const calls = sample.map((x, i) =>
          ref.arity === 1 ? [x] : [x, sample[(i * 7 + 3) % sample.length] as number],
        );
        const { results } = harness(emitLlvmBoxed(g), work)(calls);
        const native = math[ref.atom] as Fn;
        const bad = calls
          .map((args, i) => [args, results[i], native(...args)] as const)
          .filter(([, got, want]) => !Object.is(got, want))
          .map(
            ([args, got, want]) => `${ref.label}(${args.join(", ")}) = ${String(got)}, not ${want}`,
          );
        expect(bad.slice(0, 5)).toEqual([]);
      }, 120_000);
  },
);

describe("the leaves' reference implementations", () => {
  it("every leaf function the registry names has a reference implementation", () => {
    const impl = leafFunctionsJs();
    for (const name of LEAF_FUNCTIONS.keys()) expect(typeof impl[name], name).toBe("function");
  });

  it("memory: allocation, little-endian loads and stores, unsigned loads", () => {
    const m = leafFunctionsJs() as unknown as Record<string, Fn>;
    const call = (name: string, ...a: unknown[]): unknown => (m[name] as Fn)(...a);
    const p = call("__ykAlloc", 16, 8) as number;
    expect(p).toBeGreaterThan(0);
    expect(p % 8).toBe(0);
    call("__ykStore32", p, 0x11223344);
    expect(call("__ykLoad8", p)).toBe(0x44);
    expect(call("__ykLoad16", p + 2)).toBe(0x1122);
    call("__ykStore8", p + 4, -1);
    expect(call("__ykLoad8", p + 4)).toBe(255);
    call("__ykStore64", p + 8, -2n);
    expect(call("__ykLoad64", p + 8)).toBe(2n ** 64n - 2n);
    call("__ykStoreF64", p + 8, Math.PI);
    expect(call("__ykLoadF64", p + 8)).toBe(Math.PI);
    call("__ykStoreF32", p, 0.1);
    expect(call("__ykLoadF32", p)).toBe(Math.fround(0.1));
  });

  it("memory: an access outside every block, or a free of anything else, traps", () => {
    const m = leafFunctionsJs() as unknown as Record<string, Fn>;
    const p = (m.__ykAlloc as Fn)(4, 4) as number;
    // A block's size is rounded up to 16 bytes; past it is outside.
    expect(() => (m.__ykLoad32 as Fn)(p + 16)).toThrow();
    expect(() => (m.__ykLoad8 as Fn)(0)).toThrow();
    expect(() => (m.__ykFree as Fn)(p + 1)).toThrow();
    (m.__ykFree as Fn)(p);
    expect(() => (m.__ykLoad8 as Fn)(p)).toThrow();
  });
});

describe.skipIf(!hasClang)("the committed atoms are a fresh shave of their sources", () => {
  it("atoms/math.ts equals shaving ieee754.cc and scalbn.c now", () => {
    const { atoms, refused } = shaveMathAtoms();
    expect([...refused]).toEqual([]);
    expect(Object.fromEntries(atoms)).toEqual(MATH_ATOM_SOURCES);
    expect(atomSource("sin")).toBe(atoms.get("sin")?.source);
  }, 120_000);
});
