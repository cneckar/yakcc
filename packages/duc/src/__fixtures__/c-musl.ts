// SPDX-License-Identifier: Apache-2.0
// The C front end's musl harness (raise-c*.test.ts): a closure of musl functions shaved from the
// vendored sources (#1365). Each root, each function its atoms call, and each static they use is
// found in musl's own src/ and shaved, to a fixpoint; what is left is the leaves.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ShavedUnit, shaveCUnit } from "../raise-c.js";

export const MUSL = fileURLToPath(new URL("../../vendor/musl/", import.meta.url));

/** musl's own include order (as its Makefile), the yakcc headers first; long double is double. */
export const MUSL_ARGS = [
  "-std=c99",
  "-nostdinc",
  "-ffreestanding",
  "-D_XOPEN_SOURCE=700",
  "-D_GNU_SOURCE",
  "-mlong-double-64",
  `-I${MUSL}yakcc`,
  `-I${MUSL}arch/x86_64`,
  `-I${MUSL}arch/generic`,
  `-I${MUSL}src/include`,
  `-I${MUSL}src/internal`,
  `-I${MUSL}obj/include`,
  `-I${MUSL}include`,
];

/**
 * Where musl defines a name that its file name does not say: mallocng's functions are renamed by
 * macro (`#define free __libc_free` in glue.h), and a strong definition wins over lite_malloc's
 * weak one.
 */
const OVERRIDES: Readonly<Record<string, string>> = {
  __libc_malloc_impl: "src/malloc/mallocng/malloc.c",
  __libc_free: "src/malloc/mallocng/free.c",
  __libc_realloc: "src/malloc/mallocng/realloc.c",
  __malloc_context: "src/malloc/mallocng/malloc.c",
  __malloc_size_classes: "src/malloc/mallocng/malloc.c",
  __libc: "src/internal/libc.c",
};

/** The leaves a closure stops at: the system call and the thread pointer. */
export const MUSL_LEAVES = new Set(["__yk_syscall", "__yk_tp"]);

const ARCHES =
  /\/(aarch64|arm|i386|loongarch64|m68k|microblaze|mips\w*|or1k|powerpc\w*|riscv\w*|s390x|sh|x32)\//;
let sources: string[] | undefined;
const allSources = (): string[] => {
  if (sources === undefined) {
    sources = [];
    const walk = (d: string): void => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        if (f.isDirectory()) walk(`${d}/${f.name}`);
        else if (f.name.endsWith(".c")) (sources as string[]).push(`${d}/${f.name}`);
      }
    };
    walk(`${MUSL}src`);
    sources = sources.filter((f) => !ARCHES.test(f.slice(MUSL.length)));
  }
  return sources;
};

/** The musl source file that defines a function or a variable. */
export function definingFile(name: string, variable = false): string | undefined {
  const o = OVERRIDES[name];
  if (o !== undefined) return `${MUSL}${o}`;
  const all = allSources();
  if (!variable) {
    const byName = all.find((f) => f.endsWith(`/${name}.c`));
    if (byName !== undefined) return byName;
  }
  const esc = name.replace(/\$/g, "\\$");
  const re = variable
    ? new RegExp(`^(?!extern)[A-Za-z_][\\w \\t\\*]*\\b${esc}\\s*(\\[[^\\]]*\\])?\\s*(=|;)`, "m")
    : new RegExp(
        `(^|\\n)[^\\n;()]*\\b${esc}\\s*\\([^;]*\\)\\s*\\{|(weak|strong)_alias\\(\\w+,\\s*${esc}\\)`,
      );
  return all.find((f) => re.test(readFileSync(f, "utf8")));
}

/** A closure of musl shaved from `roots`: its atoms (aliases mapped) and units, and what failed. */
export function shaveMusl(roots: readonly string[]): {
  atoms: Map<string, { source: string; externals: readonly string[] }>;
  units: ShavedUnit[];
  refused: string[];
  missing: string[];
} {
  const atoms = new Map<string, { source: string; externals: readonly string[] }>();
  const units: ShavedUnit[] = [];
  const refused: string[] = [];
  const missing = new Set<string>();
  const seen = new Set<string>();
  const todo = [...roots];
  const unitName = (f: string): string => f.slice(MUSL.length);
  while (todo.length > 0) {
    const name = todo.pop() as string;
    if (seen.has(name) || atoms.has(name) || MUSL_LEAVES.has(name)) continue;
    seen.add(name);
    const file = definingFile(name);
    if (file === undefined || !existsSync(file)) {
      missing.add(name);
      continue;
    }
    const alias = new RegExp(`weak_alias\\((\\w+),\\s*${name}\\)`).exec(
      readFileSync(file, "utf8"),
    )?.[1];
    const unit = shaveCUnit(file, [alias ?? name], MUSL_ARGS, "clang", unitName(file));
    units.push(unit);
    for (const [k, r] of unit.refused) refused.push(`${k} (${unitName(file)}): ${r}`);
    for (const [k, a] of unit.atoms) {
      if (!atoms.has(k)) atoms.set(k, a);
      for (const x of a.externals) if (!atoms.has(x)) todo.push(x);
    }
    if (alias !== undefined && unit.atoms.has(alias))
      atoms.set(name, unit.atoms.get(alias) as never);
    // Statics this unit uses that another unit defines: shave their definitions.
    const defined = new Set(units.flatMap((u) => [...u.statics.keys()]));
    for (const key of unit.staticRefs) {
      if (defined.has(key) || key.includes(":")) continue;
      const f = definingFile(key, true);
      if (f === undefined) {
        missing.add(key);
        continue;
      }
      units.push(shaveCUnit(f, [], MUSL_ARGS, "clang", unitName(f), [key]));
      defined.add(key);
    }
  }
  return { atoms, units, refused, missing: [...missing] };
}
