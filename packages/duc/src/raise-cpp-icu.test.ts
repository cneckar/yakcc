// SPDX-License-Identifier: Apache-2.0
// Node's ICU (#1367: vendor/node/deps/icu-small, 78.3, full-icu as Node configures it, Node's
// icu-generic.gyp defines), shaved from its C++ sources (each file a unit, linked by their symbols)
// over musl shaved to the leaves, with ICU's data, the bytes Node links in, given by
// udata_setCommonData. Against Node's own: locale case mapping (toLocaleUpperCase,
// toLocaleLowerCase), normalization (normalize), collation (Intl.Collator's compare) and decimal
// formatting (Intl.NumberFormat's format) give the same results.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { shaveCFiles } from "./__fixtures__/c-files.js";
import { type Fn, link } from "./__fixtures__/c-link.js";
import { shaveMusl, withMuslInit } from "./__fixtures__/c-musl.js";
import { createCMemory, createCSystem, shaveCUnit } from "./raise-c.js";

const hasClang = (() => {
  try {
    execFileSync("clang++", ["--version"], { stdio: "ignore" });
    execFileSync("bunzip2", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const ICU = fileURLToPath(new URL("../vendor/node/deps/icu-small/source/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/node-icu.cpp", import.meta.url));
const RUNTIME = fileURLToPath(new URL("./__fixtures__/c/cxx-runtime.cpp", import.meta.url));
/** tools/icu/icu-generic.gyp's (icu_uconfig and icu_implementation). */
const DEFINES = [
  "-std=c++17",
  "-DUCONFIG_NO_SERVICE=1",
  "-DU_ENABLE_DYLOAD=0",
  "-DU_STATIC_IMPLEMENTATION=1",
  "-DU_HAVE_STD_STRING=1",
  "-DUCONFIG_NO_BREAK_ITERATION=0",
  "-DU_ATTRIBUTE_DEPRECATED=",
  "-Wno-deprecated-declarations",
  `-I${ICU}common`,
  `-I${ICU}i18n`,
];
const ARGS = [...DEFINES, "-DU_COMMON_IMPLEMENTATION=1", "-DU_I18N_IMPLEMENTATION=1"];
const FILES = [
  ...["common", "i18n"].flatMap((d) =>
    readdirSync(`${ICU}${d}`)
      .filter((f) => f.endsWith(".cpp"))
      .sort()
      .map((f) => `${ICU}${d}/${f}`),
  ),
  `${ICU}stubdata/stubdata.cpp`,
  RUNTIME,
];

const LOCALES = ["en", "tr", "az", "lt", "el", "de", "fr", "nl", "sv", "ja", "ar", "hi"];
const SAMPLES = [
  "",
  "istanbul İSTANBUL ıi",
  "Straße STRASSE",
  "ΟΔΥΣΣΕΥΣ Σίσυφος",
  "Iì Įį̇ Ji̇",
  "ĲSSELMEER ĳsselmeer",
  "ﬁ ﬀ ① ｶ ㌀",
  "é é Å Å ḱ",
  "한국어 ㅎㅏㄴ",
  "naïve café résumé",
];

describe.skipIf(!hasClang)("Node's ICU, shaved from C++, against Node's Intl and String", () => {
  const fixture = shaveCUnit(
    FIXTURE,
    ["yk_icu_init", "yk_icu_case", "yk_icu_norm", "yk_icu_coll", "yk_icu_num"],
    DEFINES,
    "clang++",
    "node-icu.cpp",
    [],
    true,
  );
  const roots = [...new Set([...fixture.atoms.values()].flatMap((a) => a.externals))];
  const icu = shaveCFiles(FILES, roots, ARGS, "clang++");
  const libc = [...new Set([...icu.externals, ...roots])].filter(
    (x) => !fixture.atoms.has(x) && !icu.atoms.has(x),
  );
  const musl = withMuslInit(shaveMusl([...libc, "malloc", "free"]));

  it("ICU shaves with no refusal, its C library down to the leaves", () => {
    expect([...fixture.refused]).toEqual([]);
    expect(icu.refused.slice(0, 40)).toEqual([]);
    expect(musl.refused).toEqual([]);
    expect(musl.missing).toEqual([]);
  });

  it("case mapping, normalization, collation and decimal formatting equal Node's (as raised)", () => {
    const memory = createCMemory();
    const system = createCSystem(memory);
    const env = link(
      new Map([...musl.atoms, ...icu.atoms, ...fixture.atoms]),
      false,
      memory,
      [...musl.units, ...icu.units, fixture],
      system.leaves as unknown as Record<string, Fn>,
    );
    env.yk_musl_init?.();
    // ICU's data, as Node links it in.
    const data = execFileSync("bunzip2", ["-c", `${ICU}data/in/icudt78l.dat.bz2`], {
      maxBuffer: 1 << 27,
    });
    const call = (f: string, ...a: unknown[]): number => Number((env[f] as Fn)(...a));
    expect(call("yk_icu_init", memory.put(data))).toBe(0);
    const CAP = 1 << 14;
    const out = memory.leaves.__ykAlloc(CAP * 2, 16);
    const u16 = (s: string): number => {
      const b = Buffer.alloc(Math.max(2, s.length * 2));
      for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), i * 2);
      return memory.put(b);
    };
    const str = (s: string): number => memory.put(Buffer.from(`${s}\0`, "latin1"));
    const text = (n: number): string => {
      if (n < 0) return `error ${-n}`;
      const b = Buffer.from(memory.get(out, n * 2));
      return Array.from({ length: n }, (_, i) => String.fromCharCode(b.readUInt16LE(i * 2))).join(
        "",
      );
    };
    const bad: string[] = [];
    const check = (label: string, shaved: () => string, node: () => string): void => {
      let g: string;
      try {
        g = shaved();
      } catch (e) {
        g = `trap: ${(e as Error).message}`;
      }
      const w = node();
      if (g !== w)
        bad.push(`${label}\n  shaved ${JSON.stringify(g)}\n  Node   ${JSON.stringify(w)}`);
    };
    for (const s of SAMPLES)
      for (const loc of LOCALES) {
        check(
          `upper ${loc} ${s}`,
          () => text(call("yk_icu_case", 0, str(loc), u16(s), s.length, out, CAP)),
          () => s.toLocaleUpperCase(loc),
        );
        check(
          `lower ${loc} ${s}`,
          () => text(call("yk_icu_case", 1, str(loc), u16(s), s.length, out, CAP)),
          () => s.toLocaleLowerCase(loc),
        );
      }
    const FORMS = ["NFC", "NFD", "NFKC", "NFKD"] as const;
    for (const s of SAMPLES)
      FORMS.forEach((form, i) =>
        check(
          `${form} ${s}`,
          () => text(call("yk_icu_norm", i, u16(s), s.length, out, CAP)),
          () => s.normalize(form),
        ),
      );
    const words = [
      "",
      "a",
      "A",
      "ä",
      "z",
      "Z",
      "ö",
      "o",
      "ß",
      "ss",
      "é",
      "e",
      "1",
      "10",
      "-",
      "ı",
      "i",
      "č",
      "c",
    ];
    for (const loc of ["en", "de", "sv", "tr", "cs", "fr"])
      for (const a of words)
        for (const b of words)
          check(
            `collate ${loc} ${a} ${b}`,
            () => String(call("yk_icu_coll", str(loc), u16(a), a.length, u16(b), b.length)),
            () => String(Math.sign(new Intl.Collator(loc).compare(a, b))),
          );
    const values = [
      0,
      -0,
      1,
      -1,
      1234567.891,
      0.000123,
      1e21,
      -987654.3219,
      42,
      1.23456,
      1e-7,
      123456789012,
      ...fc.sample(fc.double({ min: -1e9, max: 1e9, noNaN: true }), { numRuns: 20, seed: 1367 }),
    ];
    for (const loc of ["en", "de", "fr", "en-IN", "ar", "hi", "ja"])
      for (const v of values)
        check(
          `format ${loc} ${v}`,
          () => text(call("yk_icu_num", str(loc), v, out, CAP)),
          () => new Intl.NumberFormat(loc).format(v),
        );
    expect(bad.slice(0, 10)).toEqual([]);
  }, 7_200_000);
});
