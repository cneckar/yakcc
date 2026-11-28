// SPDX-License-Identifier: Apache-2.0
/**
 * The atoms the native runtime calls (#1516): V8's BigInt library (`atoms/v8-bigint.ts`, shaved
 * from V8 12.4's src/bigint) and its number conversions (`atoms/v8-numbers.ts`, shaved from
 * src/numbers/conversions.cc and src/base/numbers), with the C library's they call (musl's),
 * lowered as one module whose exports are its functions. The runtime evaluates the module once and calls its functions
 * by name, where it has replaced its own code with V8's.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { V8_BIGINT_ATOM_SOURCES, V8_BIGINT_STATICS } from "./atoms/v8-bigint.js";
import { V8_NUMBERS_ATOM_SOURCES, V8_NUMBERS_STATICS } from "./atoms/v8-numbers.js";
import { emitNativeModules } from "./emit-llvm-boxed.js";
import { liftAtom } from "./lift.js";
import { withStatics } from "./native-statics.js";
import type { StaticDef } from "./raise-c.js";

/** The module's id; its entry is the symbol the runtime calls (`YK_V8_BIGINT_ENTRY`). */
const ID = "yk_v8_bigint.js";

const big = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? `${v}n` : v);

let memo: { ir: string; entry: string } | undefined;
/** The atoms' module: its LLVM IR and its entry's symbol. */
export function runtimeAtomsModule(): { ir: string; entry: string } {
  if (memo !== undefined) return memo;
  // The libraries' atoms, one function each: a name both have (musl's memcpy) is the same atom.
  const sources = new Map<string, string>();
  const statics = new Map<string, StaticDef>();
  for (const [atoms, defs] of [
    [V8_BIGINT_ATOM_SOURCES, V8_BIGINT_STATICS],
    [V8_NUMBERS_ATOM_SOURCES, V8_NUMBERS_STATICS],
  ] as const) {
    for (const [n, a] of Object.entries(atoms)) {
      const known = sources.get(n);
      if (known !== undefined && known !== a.source)
        throw new Error(`the runtime's atoms: two definitions of ${n}`);
      sources.set(n, a.source);
    }
    for (const [k, d] of Object.entries(defs)) {
      const known = statics.get(k);
      if (known !== undefined && JSON.stringify(known, big) !== JSON.stringify(d, big))
        throw new Error(`the runtime's atoms: two definitions of the static ${k}`);
      statics.set(k, d);
    }
  }
  const names = [...sources.keys()];
  const statements = [
    ...names.map((n) => ({
      kind: "function" as const,
      declares: [n],
      graph: liftAtom(sources.get(n) as string),
    })),
    {
      kind: "statement" as const,
      declares: [],
      graph: liftAtom(`module.exports = { ${names.join(", ")} };`),
    },
  ];
  const { ir, symbols } = emitNativeModules(withStatics([{ id: ID, statements }], statics));
  memo = { ir: ownSymbols(ir, symbols[ID] as string), entry: symbols[ID] as string };
  return memo;
}

/**
 * The module's own symbols prefixed (`ykv8.`): a module's functions, constants and strings are named
 * as every program's are (m0_s0, m0.init, .str3); its entry and the definitions every module shares
 * (linkonce_odr: the leaves) and LLVM's own (`llvm.global_ctors`) keep their names.
 */
function ownSymbols(ir: string, entry: string): string {
  const own = new Set<string>();
  for (const m of ir.matchAll(
    /^(?:@("[^"]+"|[\w.$]+) = (?!linkonce_odr|external)|define (?!linkonce_odr)[^@]*@("[^"]+"|[\w.$]+)\()/gm,
  )) {
    const name = (m[1] ?? m[2]) as string;
    // (LLVM's own, `llvm.global_ctors`: the key constructor's registration, by its name.)
    if (name !== entry && !name.startsWith("llvm.")) own.add(name);
  }
  return ir.replace(/@("[^"]+"|[\w.$]+)/g, (whole, name: string) => {
    if (!own.has(name)) return whole;
    return name.startsWith('"') ? `@"ykv8.${name.slice(1)}` : `@"ykv8.${name}"`;
  });
}

/** The atoms' module's entry: its id's (the emitter names a module's entry by its id). */
export const RUNTIME_ATOMS_ENTRY = "yk_module_yk_v8_bigint_js";

/**
 * What the atoms' object is made of: the libraries' atoms, and the lowering's own code (every
 * source of this package that is not a test), for a key that needs no lowering to compute.
 */
let sourcesKey: string | undefined;
function atomsSourcesKey(): string {
  if (sourcesKey !== undefined) return sourcesKey;
  const h = createHash("sha256");
  h.update(JSON.stringify([V8_BIGINT_ATOM_SOURCES, V8_NUMBERS_ATOM_SOURCES], big));
  h.update(JSON.stringify([V8_BIGINT_STATICS, V8_NUMBERS_STATICS], big));
  const src = dirname(fileURLToPath(import.meta.url));
  for (const f of readdirSync(src).sort())
    if (/\.(ts|js)$/.test(f) && !/\.test\.|^scratch/.test(f))
      h.update(f).update(readFileSync(join(src, f)));
  sourcesKey = h.digest("hex");
  return sourcesKey;
}

/**
 * The atoms' object for a target, cached on disk by what makes it (atomsSourcesKey) and the
 * target: lowering and compiling it takes minutes, and it is the same for every program.
 */
export function runtimeAtomsObject(
  triple: string,
  compile: (ir: string) => Uint8Array,
): Uint8Array {
  return cachedObject(`${triple}\0${atomsSourcesKey()}`, () => {
    const atoms = runtimeAtomsModule();
    if (atoms.entry !== RUNTIME_ATOMS_ENTRY)
      throw new Error(`the runtime's atoms' entry is ${atoms.entry}, not ${RUNTIME_ATOMS_ENTRY}`);
    return compile(atoms.ir);
  });
}

/** An object cached on disk by a key's hash. */
function cachedObject(what: string, compile: () => Uint8Array): Uint8Array {
  const dir = join(tmpdir(), "yakcc-native-cache");
  const key = createHash("sha256").update(what).digest("hex");
  const path = join(dir, `${key}.o`);
  if (existsSync(path)) return new Uint8Array(readFileSync(path));
  const obj = compile();
  mkdirSync(dir, { recursive: true });
  const part = `${path}.${process.pid}.part`;
  writeFileSync(part, obj);
  renameSync(part, path);
  return obj;
}
