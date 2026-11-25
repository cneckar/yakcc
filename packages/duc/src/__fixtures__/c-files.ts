// SPDX-License-Identifier: Apache-2.0
// A C library of several files (zlib) shaved from roots, as a static link takes it: each
// function from the file that defines it (by the symbols each file's object defines), each
// file its own unit; the functions and statics they reach, in turn. What none of the files
// defines is left external (the C library's, shaved apart).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type ShavedUnit, shaveCUnit } from "../raise-c.js";

export interface ShavedFiles {
  readonly atoms: Map<string, { source: string; externals: readonly string[] }>;
  readonly units: ShavedUnit[];
  readonly refused: string[];
  /** Functions no file defines (the C library's). */
  readonly externals: string[];
}

/** The symbols each file defines, by its object's symbol table: name -> file. */
function definitions(files: readonly string[], args: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const work = mkdtempSync(join(tmpdir(), "yakcc-c-files-"));
  try {
    for (const f of files) {
      const obj = join(work, `${basename(f)}.o`);
      execFileSync("clang", [...args, "-c", f, "-o", obj]);
      const syms = execFileSync("nm", ["--defined-only", obj], { encoding: "utf8" });
      for (const line of syms.split("\n")) {
        const m = /^[0-9a-f]+ [TDRBC] (\w+)$/.exec(line.trim());
        if (m !== null && !out.has(m[1] as string)) out.set(m[1] as string, f);
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
  args: readonly string[],
): ShavedFiles {
  const defs = definitions(files, args);
  const atoms = new Map<string, { source: string; externals: readonly string[] }>();
  const units: ShavedUnit[] = [];
  const refused: string[] = [];
  const externals = new Set<string>();
  const seen = new Set<string>();
  const todo = [...roots];
  const definedStatics = new Set<string>();
  while (todo.length > 0) {
    const name = todo.pop() as string;
    if (seen.has(name) || atoms.has(name)) continue;
    seen.add(name);
    const file = defs.get(name);
    if (file === undefined) {
      externals.add(name);
      continue;
    }
    const unit = shaveCUnit(file, [name], args, "clang", basename(file));
    units.push(unit);
    for (const [k, r] of unit.refused) refused.push(`${k} (${basename(file)}): ${r}`);
    for (const [k, a] of unit.atoms) {
      if (!atoms.has(k)) atoms.set(k, a);
      for (const x of a.externals) if (!atoms.has(x)) todo.push(x);
    }
    for (const d of unit.statics.values())
      for (const item of d.init) if ("fn" in item && !atoms.has(item.fn)) todo.push(item.fn);
    // Statics this unit uses that another file defines (zlib's tables): their definitions.
    for (const key of unit.staticRefs) {
      if (key.includes(":") || definedStatics.has(key)) continue;
      definedStatics.add(key);
      const f = defs.get(key);
      if (f === undefined) continue;
      const defining = shaveCUnit(f, [], args, "clang", basename(f), [key]);
      units.push(defining);
      for (const [k, r] of defining.refused) refused.push(`${k} (${basename(f)}): ${r}`);
      for (const [k, a] of defining.atoms) {
        if (!atoms.has(k)) atoms.set(k, a);
        for (const x of a.externals) if (!atoms.has(x)) todo.push(x);
      }
    }
  }
  return { atoms, units, refused, externals: [...externals] };
}
