// SPDX-License-Identifier: Apache-2.0
// The C front end's musl harness (raise-c*.test.ts): a closure of musl functions shaved from the
// vendored sources (#1365). Each root, each function its atoms call, and each static they use is
// found in musl's own src/ and shaved, to a fixpoint; what is left is the leaves.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ShavedUnit, shaveCUnit } from "../raise-c.js";

export const MUSL = fileURLToPath(new URL("../../vendor/musl/", import.meta.url));

/** musl's own include order (as its Makefile), the yakcc headers first; long double is double. */
export const MUSL_ARGS = [
  "-std=c99",
  "-nostdinc",
  "-ffreestanding",
  "-D_XOPEN_SOURCE=700",
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
/**
 * The public allocator's names, which mallocng's glue.h renames by macro (`#define malloc
 * __libc_malloc_impl`): each is its implementation's atom.
 */
const RENAMED: Readonly<Record<string, string>> = {
  malloc: "__libc_malloc_impl",
  free: "__libc_free",
  realloc: "__libc_realloc",
};

const OVERRIDES: Readonly<Record<string, string>> = {
  __libc_malloc_impl: "src/malloc/mallocng/malloc.c",
  __libc_free: "src/malloc/mallocng/free.c",
  __libc_realloc: "src/malloc/mallocng/realloc.c",
  __malloc_context: "src/malloc/mallocng/malloc.c",
  __malloc_size_classes: "src/malloc/mallocng/malloc.c",
  __malloc_lock: "src/malloc/mallocng/malloc.c", // by a macro, LOCK_OBJ_DEF
  __libc: "src/internal/libc.c",
};

/**
 * The weak symbols a static link defines only for what is in the program (`exit`'s bounds of
 * `.fini_array`, empty in a program without C++ static destructors there): undefined, so at 0.
 */
const LINKER_WEAK = new Set(["__fini_array_start", "__fini_array_end"]);

/** The leaves a closure stops at: the system call and the thread pointer. */
export const MUSL_LEAVES = new Set(["__yk_syscall", "__yk_tp", "__yk_cpuid"]);

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
export function definingFile(
  name: string,
  variable = false,
  /** A file found not to define it (qsort.c defines __qsort_r; qsort is qsort_nr.c's). */
  not?: string,
): string | undefined {
  const o = OVERRIDES[name];
  if (o !== undefined) return `${MUSL}${o}`;
  const all = allSources();
  if (!variable) {
    const byName = all.find((f) => f.endsWith(`/${name}.c`) && f !== not);
    if (byName !== undefined) return byName;
  }
  const esc = name.replace(/\$/g, "\\$");
  const re = variable
    ? new RegExp(`^(?!extern)[A-Za-z_][\\w \\t\\*]*\\b${esc}\\s*(\\[[^\\]]*\\])?\\s*(=|;)`, "m")
    : new RegExp(
        `(^|\\n)[^\\n;()]*\\b${esc}\\s*\\([^;]*\\)\\s*\\{|(weak|strong)_alias\\(\\w+,\\s*${esc}\\)`,
      );
  return all.find((f) => f !== not && re.test(readFileSync(f, "utf8")));
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
  const weakIn = new Map<string, string>();
  const notIn = new Map<string, string>(); // a function -> the file of its name, which does not define it
  const todo = [...roots];
  const unitName = (f: string): string => f.slice(MUSL.length);
  while (todo.length > 0) {
    const name = todo.pop() as string;
    if (seen.has(name) || atoms.has(name) || MUSL_LEAVES.has(name)) continue;
    const renamed = RENAMED[name];
    if (renamed !== undefined) {
      seen.add(name);
      todo.push(renamed);
      continue;
    }
    seen.add(name);
    // A weak alias in a file already shaved (`weak_alias(dummy, __aio_close)`) is what a static
    // link uses when nothing else brings the strong definition in; mallocng's are overrides.
    const file =
      (OVERRIDES[name] === undefined ? weakIn.get(name) : undefined) ??
      definingFile(name, false, notIn.get(name));
    if (file === undefined || !existsSync(file)) {
      missing.add(name);
      continue;
    }
    const alias = new RegExp(`weak_alias\\((\\w+),\\s*${name}\\)`).exec(
      readFileSync(file, "utf8"),
    )?.[1];
    const unit = shaveCUnit(file, [alias ?? name], MUSL_ARGS, "clang", unitName(file));
    // (The file of its name does not define it: the one that does.)
    if (!unit.atoms.has(alias ?? name) && unit.refused.size === 0) {
      const other = definingFile(name, false, file);
      if (other !== undefined && other !== file) {
        todo.push(name);
        seen.delete(name);
        notIn.set(name, file);
        continue;
      }
    }
    for (const m of readFileSync(file, "utf8").matchAll(/weak_alias\(\w+,\s*(\w+)\)/g))
      if (!weakIn.has(m[1] as string)) weakIn.set(m[1] as string, file);
    units.push(unit);
    for (const [k, r] of unit.refused) refused.push(`${k} (${unitName(file)}): ${r}`);
    for (const [k, a] of unit.atoms) {
      if (!atoms.has(k)) atoms.set(k, a);
      for (const x of a.externals) if (!atoms.has(x)) todo.push(x);
    }
    if (alias !== undefined && unit.atoms.has(alias))
      atoms.set(name, unit.atoms.get(alias) as never);
    // Functions that statics' initializers name (a FILE's write and seek).
    const follow = (u: ShavedUnit): void => {
      for (const [k, a] of u.atoms) if (!atoms.has(k)) atoms.set(k, a);
      for (const d of u.statics.values())
        for (const item of d.init) if ("fn" in item && !atoms.has(item.fn)) todo.push(item.fn);
    };
    follow(unit);
    // Statics this unit uses that another unit defines: shave their definitions.
    const defined = new Set(units.flatMap((u) => [...u.statics.keys()]));
    for (const key of unit.staticRefs) {
      if (defined.has(key) || key.includes(":")) continue;
      if (LINKER_WEAK.has(key)) {
        // (Defined where the link puts it: at 0, no object defining it.)
        units.push({ statics: new Map([[key, { size: 0, align: 1, init: [], at: 0 }]]) } as never);
        defined.add(key);
        continue;
      }
      const f = definingFile(key, true);
      if (f === undefined) {
        missing.add(key);
        continue;
      }
      const defining = shaveCUnit(f, [], MUSL_ARGS, "clang", unitName(f), [key]);
      units.push(defining);
      for (const [k, r] of defining.refused) refused.push(`${k} (${unitName(f)}): ${r}`);
      follow(defining);
      for (const a of defining.atoms.values())
        for (const x of a.externals) if (!atoms.has(x)) todo.push(x);
      defined.add(key);
    }
  }
  for (const [name, impl] of Object.entries(RENAMED))
    if (seen.has(name) && atoms.has(impl)) atoms.set(name, atoms.get(impl) as never);
  return { atoms, units, refused, missing: [...missing] };
}

/** What musl's process start sets up (the auxiliary vector, the page size), as a C function. */
export const MUSL_INIT = fileURLToPath(new URL("./c/musl-init.c", import.meta.url));

/** The leaves in C over the host: the system call (brk and mremap refused, as createCSystem). */
const NATIVE_LEAVES = `#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <unistd.h>
#include <sys/syscall.h>
long __yk_syscall(long n, long a, long b, long c, long d, long e, long f) {
  if (n == SYS_brk) return 0; /* as the JavaScript leaf: no break, so malloc maps */
  if (n == SYS_mremap) return -12;
  long r = syscall(n, a, b, c, d, e, f);
  return r == -1 ? -(long)errno : r;
}
int *___errno_location(void) { return &errno; } /* musl's internal name for errno */
static _Alignas(64) unsigned char tp[4096];
uintptr_t __yk_tp(void) { *(uintptr_t *)tp = (uintptr_t)tp; return (uintptr_t)tp; }
`;

/**
 * The oracle for a shaved closure: the same musl sources compiled natively (they take the host
 * libc's names over), the leaves in C, and a driver (`main`, which writes with write(2) only).
 * errno stays the host's (musl's would replace it for the whole process). Returns the program.
 */
export function buildMuslNative(
  units: readonly Pick<ShavedUnit, "file">[],
  work: string,
  name: string,
  driver: string,
): string {
  const files = [...new Set(units.map((u) => u.file))].filter(
    (f) => f !== undefined && !f.endsWith("__errno_location.c"),
  );
  const objs = files.map((f, i) => {
    const o = join(work, `${name}-${i}.o`);
    execFileSync("clang", [...MUSL_ARGS, "-O0", "-fno-builtin", "-fwrapv", "-c", f, "-o", o]);
    return o;
  });
  const leaves = join(work, `${name}-leaves.c`);
  writeFileSync(leaves, NATIVE_LEAVES);
  const main = join(work, `${name}-driver.c`);
  writeFileSync(main, driver);
  const exe = join(work, name);
  // Names the shaved side has as builtins (fabsl) are calls natively: add their musl files.
  for (let round = 0; ; round++) {
    try {
      execFileSync("clang", ["-std=c11", "-O0", "-fno-builtin", main, leaves, ...objs, "-o", exe], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      return exe;
    } catch (e) {
      const err = String((e as { stderr?: unknown }).stderr ?? e);
      const names = [
        ...new Set(
          [...err.matchAll(/undefined reference to `([^']+)'/g)].map((m) => m[1] as string),
        ),
      ];
      const more = names
        .map((n) => definingFile(n))
        .filter((f): f is string => f !== undefined && !files.includes(f));
      if (round > 8 || more.length === 0) throw e;
      for (const f of new Set(more)) {
        files.push(f);
        const o = join(work, `${name}-${files.length}.o`);
        execFileSync("clang", [...MUSL_ARGS, "-O0", "-fno-builtin", "-fwrapv", "-c", f, "-o", o]);
        objs.push(o);
      }
    }
  }
}

/** A closure with musl's startup added (`yk_musl_init`, and what it calls), as a process has it. */
export function withMuslInit<C extends ReturnType<typeof shaveMusl>>(closure: C): C {
  const init = shaveCUnit(MUSL_INIT, ["yk_musl_init"], MUSL_ARGS, "clang", "musl-init.c");
  for (const [k, a] of init.atoms) if (!closure.atoms.has(k)) closure.atoms.set(k, a);
  closure.units.push(init);
  return closure;
}
