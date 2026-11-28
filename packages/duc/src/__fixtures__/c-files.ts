// SPDX-License-Identifier: Apache-2.0
// A C library of several files (zlib) shaved from roots, as a static link takes it: each
// function from the file that defines it (by the symbols each file's object defines), each
// file its own unit; the functions and statics they reach, in turn. What none of the files
// defines is left external (the C library's, shaved apart).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type ShavedUnit, isV8Api, shaveCUnit } from "../raise-c.js";

export interface ShavedFiles {
  readonly atoms: Map<string, { source: string; externals: readonly string[] }>;
  readonly units: ShavedUnit[];
  readonly refused: string[];
  /** Functions no file defines (the C library's). */
  readonly externals: string[];
}

/** The symbols each file defines, by its object's symbol table: name -> file (the first file's). */
/** A file's arguments: one list for all, or each file's own (Node's src/ and its ICU, for one). */
export type FileArgs = readonly string[] | ((file: string) => readonly string[]);
const argsFor = (args: FileArgs, file: string): readonly string[] =>
  typeof args === "function" ? args(file) : args;

function definitions(
  files: readonly string[],
  args: FileArgs,
  clang = "clang",
): Map<string, string> {
  const out = new Map<string, string>();
  const work = mkdtempSync(join(tmpdir(), "yakcc-c-files-"));
  try {
    // Compiled in parallel (one object per file, named by its index), then read in the files' order.
    const q = (x: string): string => `'${x.replaceAll("'", "'\\''")}'`;
    const script = join(work, "cc.sh");
    writeFileSync(
      script,
      files
        .map(
          (f, i) =>
            `clang ${argsFor(args, f).map(q).join(" ")} -c ${q(f)} -o ${q(join(work, `${i}.o`))} 2>/dev/null`,
        )
        .join("\n"),
    );
    execFileSync("sh", ["-c", `xargs -d '\\n' -P "$(nproc)" -I{} sh -c {} < ${q(script)}`], {
      stdio: "ignore",
    });
    for (const [i] of files.entries()) {
      const obj = join(work, `${i}.o`);
      if (!existsSync(obj)) throw new Error(`clang could not compile ${files[i]}`);
      const syms = execFileSync("nm", ["--defined-only", obj], { encoding: "utf8" });
      for (const line of syms.split("\n")) {
        // (Weak ones too, `W`/`V`: a template's instance, an inline function, a class's vtable.)
        const m = /^[0-9a-f]+ [TDRBCWV] (\w+)$/.exec(line.trim());
        if (m !== null && !out.has(m[1] as string)) out.set(m[1] as string, files[i] as string);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return out;
}

export function shaveCFiles(
  files: readonly string[],
  roots: readonly string[],
  args: FileArgs,
  /** The compiler: clang (C), clang++ (C++, whose functions link by their mangled names). */
  clang = "clang",
  /** Statics the caller's own units use, for these files to define (by their keys). */
  statics: readonly string[] = [],
): ShavedFiles {
  const defs = definitions(files, args, clang);
  const cxx = /\+\+$/.test(clang);
  const atoms = new Map<string, { source: string; externals: readonly string[] }>();
  const units: ShavedUnit[] = [];
  const refused: string[] = [];
  const externals = new Set<string>();
  const seen = new Set<string>();
  const todo = [...roots];
  const definedStatics = new Set<string>();
  const take = (unit: ShavedUnit, file: string): void => {
    units.push(unit);
    for (const [k, r] of unit.refused) refused.push(`${k} (${basename(file)}): ${r}`);
    for (const [k, a] of unit.atoms) {
      if (!atoms.has(k)) atoms.set(k, a);
      for (const x of a.externals) if (!atoms.has(x)) todo.push(x);
    }
    for (const d of unit.statics.values())
      for (const item of d.init) if ("fn" in item && !atoms.has(item.fn)) todo.push(item.fn);
    // Statics this unit uses that another file defines (zlib's tables, OpenSSL's constants):
    // their definitions, in the next pass (a unit shaved for its statics uses others too).
    for (const key of unit.statics.keys()) definedStatics.add(key);
    for (const key of unit.staticRefs) {
      if (key.includes(":") || definedStatics.has(key)) continue;
      definedStatics.add(key);
      const f = defs.get(key);
      if (f !== undefined) pendingStatics.set(f, [...(pendingStatics.get(f) ?? []), key]);
    }
  };
  const pendingStatics = new Map<string, string[]>();
  for (const key of statics) {
    if (key.includes(":") || definedStatics.has(key)) continue;
    definedStatics.add(key);
    const f = defs.get(key);
    if (f !== undefined) pendingStatics.set(f, [...(pendingStatics.get(f) ?? []), key]);
  }
  // In waves: each file shaved once a wave, for every function of it the closure has reached (a
  // file's parse is most of a unit's cost).
  while (todo.length > 0 || pendingStatics.size > 0) {
    const byFile = new Map<string, string[]>();
    while (todo.length > 0) {
      const name = todo.pop() as string;
      if (seen.has(name) || atoms.has(name)) continue;
      seen.add(name);
      // (V8's API, which every C++ file of node/src defines inline: the runtime's leaves.)
      if (isV8Api(name)) {
        externals.add(name);
        continue;
      }
      // (A complete object's constructor or destructor, `C1`/`D1`, that code generation emits
      // only as the base object's, `C2`/`D2`: the file of that one.)
      const file = defs.get(name) ?? defs.get(name.replace(/([CD])1(E|I)/, "$12$2")) ?? undefined;
      if (file === undefined) {
        externals.add(name);
        continue;
      }
      byFile.set(file, [...(byFile.get(file) ?? []), name]);
    }
    if (process.env.YAKCC_PROGRESS !== undefined)
      console.error(
        `c-files: wave of ${byFile.size} files, ${[...byFile.values()].flat().length} names; ${atoms.size} atoms so far`,
      );
    for (const [file, names] of byFile) {
      const t = Date.now();
      let unit: ShavedUnit;
      try {
        unit = shaveCUnit(file, names, argsFor(args, file), clang, basename(file), [], cxx);
      } catch (e) {
        // (A unit that fails as a whole, a static it cannot lay out: refused, and the rest on.)
        refused.push(`${names.join(", ")} (${basename(file)}): ${(e as Error).message}`);
        continue;
      }
      take(unit, file);
      if (
        process.env.YAKCC_PROGRESS !== undefined &&
        (Date.now() - t > 10_000 || process.memoryUsage().heapUsed > 3 * 2 ** 30)
      )
        console.error(
          `c-files: ${basename(file)} took ${Date.now() - t} ms, heap ${Math.round(process.memoryUsage().heapUsed / 2 ** 20)} MB`,
        );
    }
    const staticsByFile = new Map(pendingStatics);
    pendingStatics.clear();
    for (const [f, keys] of staticsByFile) {
      try {
        take(shaveCUnit(f, [], argsFor(args, f), clang, basename(f), keys, cxx), f);
      } catch (e) {
        refused.push(`${keys.join(", ")} (${basename(f)}): ${(e as Error).message}`);
      }
    }
  }
  return { atoms, units, refused, externals: [...externals] };
}
