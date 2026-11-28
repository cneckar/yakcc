// SPDX-License-Identifier: Apache-2.0
// The C front end's test harness (raise-c*.test.ts): atoms linked by name over one memory, as
// raised or as lifted to a graph and lowered back to TypeScript.
import { ts } from "ts-morph";
import { expect } from "vitest";
import { emitTypeScript } from "../emit-ts.js";
import { liftAtom } from "../lift.js";
import { C_LEAVES_JS, type ShavedUnit, createCMemory } from "../raise-c.js";
import type { DucGraph } from "../types.js";

export type Fn = (...a: unknown[]) => unknown;
export type CMemory = ReturnType<typeof createCMemory>;

/** The opaque summaries in a graph: a shaved atom must have none. */
export const opaque = (g: DucGraph): string[] =>
  g.nodes.flatMap((n) => [
    ...(/#[0-9a-f]{16}$/.test(n.label ?? "") ? [n.label as string] : []),
    ...(n.closure !== undefined ? opaque(n.closure) : []),
  ]);

export const hex = (b: Uint8Array | readonly number[]): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * The atoms as functions over one memory, calling one another by name. Each name is one function
 * value (so a function's address, `__ykFnAddr`, is the same from every atom). The units' statics
 * (module state) are defined in the memory, their function references resolved by name.
 */
export function link(
  atoms: ReadonlyMap<string, { source: string }>,
  lowered: boolean,
  memory: CMemory = createCMemory(),
  units: readonly Pick<ShavedUnit, "statics">[] = [],
  /** More leaves (the system call and the thread pointer: createCSystem). */
  extra: Readonly<Record<string, Fn>> = {},
): Record<string, Fn> {
  const leaves = {
    ...(C_LEAVES_JS as unknown as Record<string, Fn>),
    ...(memory.leaves as unknown as Record<string, Fn>),
    ...extra,
  };
  const env: Record<string, Fn> = { ...leaves };
  const names = [...Object.keys(leaves), ...atoms.keys()];
  const fns = new Map<string, Fn>(
    names.map((n) => [n, (...x: unknown[]) => (env[n] as Fn)(...x)] as const),
  );
  for (const [key, atom] of atoms) {
    let source = atom.source;
    if (lowered) {
      const g = liftAtom(source);
      expect(opaque(g), key).toEqual([]);
      source = emitTypeScript(g);
    }
    const js = ts
      .transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
      .outputText.replace(/^export /m, "");
    env[key] = new Function(...names, `${js}; return f;`)(...names.map((n) => fns.get(n))) as Fn;
  }
  for (const u of units) for (const [k, d] of u.statics) memory.defineStatic(k, d);
  memory.resolveFunctions((name) => fns.get(name));
  return new Proxy(env, { get: (t, p: string) => fns.get(p) ?? t[p] });
}

/**
 * C++: the units' initializer atoms (their globals constructed, ShavedUnit.initializers), each
 * unit's in its order, as a program's startup runs them after the C library's (yk_musl_init).
 */
export function runInitializers(
  env: Record<string, Fn>,
  units: readonly Pick<ShavedUnit, "initializers">[],
): void {
  for (const u of units) for (const k of u.initializers ?? []) (env[k] as Fn)();
}
