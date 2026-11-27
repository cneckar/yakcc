// SPDX-License-Identifier: Apache-2.0
/**
 * The hand-written native runtime, inventoried (#1516): each section of `runtime/*` and what it
 * is. #1516's target is a runtime that is the leaf table's implementation alone (`leaves.ts`), with
 * the control primitives the graph's structure needs. Everything else in it is scaffolding to
 * delete, each part as the atom shaved from its source replaces it:
 *
 * - `leaf`: the leaf table's implementation (`leaves.ts`): float64 and fixed-width integers, a
 *   float64's bits, byte-addressed memory, function references, the system-call leaf;
 * - `control`: the control primitives the graph's structure needs: unwinding a throw to its
 *   handler, a coroutine's switch;
 * - `object-model`: the value representation and the object model above the leaves (property maps,
 *   prototype chains, closures, site caches): #1366's DEC decides how V8's lives in the graph's heap;
 * - `collector`: the garbage collector (V8's heap, shaved, or atoms over the memory leaves);
 * - `builtin`: ECMAScript's built-ins, shaved from V8's sources (Torque, CSA, C++; #1366, #1332);
 * - `node`: Node's C++ (its bindings, its bootstrap's view of the process), shaved from node/src
 *   over V8's API as atoms (#1367);
 * - `libc`: the C library the runtime uses with no libc linked, shaved from musl (#1365);
 * - `host`: the test harnesses' boundary (values in a text form), outside a program's closure.
 *
 * The metric is the hand-written lines that are not `leaf` or `control`: #1516 drives it to zero.
 * `runtime-inventory.test.ts` checks that every section is classified, and that the count only falls.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type RuntimeKind =
  | "leaf"
  | "control"
  | "object-model"
  | "collector"
  | "builtin"
  | "node"
  | "libc"
  | "host";

export interface RuntimeSection {
  /** The file, under runtime/. */
  readonly file: string;
  /** Its header comment's start (a section runs to the next one), or "" for the file's opening. */
  readonly marker: string;
  readonly kind: RuntimeKind;
  /** What replaces it: the source it is shaved from, or the leaf it implements. */
  readonly source: string;
}

const s = (file: string, marker: string, kind: RuntimeKind, source: string): RuntimeSection => ({
  file,
  marker,
  kind,
  source,
});

const YK = "yk.c";
const NOLIBC = "nolibc.h";

/** Every section of the runtime, in each file's order. */
export const RUNTIME_SECTIONS: readonly RuntimeSection[] = [
  s(YK, "", "object-model", "V8's tagged values (src/objects/objects.h, smi.h): #1366's DEC"),
  s(
    YK,
    "/* --- The heap and its collector",
    "collector",
    "V8's heap (src/heap/), or atoms over the memory leaves",
  ),
  s(YK, "/* --- arrays ---", "object-model", "src/objects/js-array.h, elements.cc"),
  s(
    YK,
    "/* --- ToString ---",
    "builtin",
    "src/numbers/conversions.cc, src/base/numbers/dtoa.cc; ConsString (src/objects/string.cc)",
  ),
  s(YK, "/* --- symbols", "builtin", "src/objects/symbol.h, src/builtins/builtins-symbol.cc"),
  s(YK, "/* --- ToNumber ---", "builtin", "src/numbers/conversions.cc (StringToDouble)"),
  s(
    YK,
    "/* --- operators ---",
    "builtin",
    "src/objects/objects.cc (Object::Add, Compare, Equals), src/builtins/number.tq",
  ),
  s(
    YK,
    "/* --- properties ---",
    "object-model",
    "src/objects/lookup.cc, src/ic/ (the site caches)",
  ),
  s(YK, "/* --- objects ---", "object-model", "src/objects/js-objects.cc"),
  s(
    YK,
    "/* --- accessors, prototypes, classes ---",
    "object-model",
    "src/objects/js-objects.cc, src/runtime/runtime-classes.cc",
  ),
  s(YK, "/* --- private names", "object-model", "src/runtime/runtime-classes.cc, private symbols"),
  s(YK, "/* --- exceptions:", "control", "a throw unwound to its handler (the graph's try)"),
  s(YK, "/* --- the intrinsics", "builtin", "src/init/bootstrapper.cc (the intrinsic objects)"),
  s(
    YK,
    "/* --- reflection",
    "builtin",
    "src/builtins/builtins-reflect.cc, builtins-object.cc, builtins-function.cc",
  ),
  s(YK, "/* --- keys, in the order", "object-model", "src/objects/keys.cc"),
  s(
    YK,
    "/* --- iteration:",
    "builtin",
    "src/builtins/builtins-iterator-gen.cc, array-iterator; src/runtime/runtime-forin.cc",
  ),
  s(
    YK,
    "/* --- functions ---",
    "object-model",
    "src/objects/js-function.h, src/builtins/builtins-function.cc",
  ),
  s(
    YK,
    "/* --- bitwise operators",
    "builtin",
    "src/objects/objects.cc, src/numbers/conversions.cc (ToInt32)",
  ),
  s(YK, "/* --- BigInt", "builtin", "src/bigint/, src/objects/bigint.cc, src/builtins/bigint.tq"),
  s(YK, "/* --- the leaves ---", "leaf", "leaves.ts: integers and a float64's bits"),
  s(
    YK,
    "/* --- Map and Set:",
    "builtin",
    "src/builtins/builtins-collections-gen.cc, src/objects/ordered-hash-table.cc",
  ),
  s(YK, "/* --- JSON.stringify ---", "builtin", "src/json/json-stringifier.cc"),
  s(
    YK,
    "/* --- Array.from, Array.isArray",
    "builtin",
    "src/builtins/array-from.tq, builtins-object.cc, builtins-collections-gen.cc",
  ),
  s(YK, "/* --- RegExp:", "builtin", "src/regexp/ (Irregexp), src/builtins/regexp-*.tq"),
  s(YK, "/* --- the global functions, as values ---", "builtin", "src/init/bootstrapper.cc"),
  s(
    YK,
    "/* --- WeakMap, WeakSet",
    "builtin",
    "src/builtins/builtins-weak-refs.cc, builtins-collections-gen.cc",
  ),
  s(YK, "/* --- Date", "builtin", "src/builtins/builtins-date.cc, src/date/"),
  s(
    YK,
    "/* --- case mapping",
    "builtin",
    "src/builtins/builtins-string.cc, src/strings/unicode.cc",
  ),
  s(YK, "/* --- URI handling", "builtin", "src/strings/uri.cc, src/builtins/builtins-global.cc"),
  s(
    YK,
    "/* --- promises, async functions and generators",
    "builtin",
    "src/builtins/promise-*.tq, builtins-microtask-queue-gen.cc",
  ),
  s(
    YK,
    "/* --- coroutines ---",
    "control",
    "a coroutine's switch (a generator's or an async function's own stack)",
  ),
  s(YK, "/* --- async functions ---", "builtin", "src/builtins/builtins-async-function-gen.cc"),
  s(YK, "/* --- async generators", "builtin", "src/builtins/builtins-async-generator-gen.cc"),
  s(YK, "/* --- generators ---", "builtin", "src/builtins/builtins-generator-gen.cc"),
  s(
    YK,
    "/* --- the methods of promises and generators ---",
    "builtin",
    "src/builtins/promise-*.tq, builtins-generator-gen.cc",
  ),
  s(
    YK,
    "/* --- the Promise constructor and its statics ---",
    "builtin",
    "src/builtins/promise-constructor.tq, promise-all.tq, promise-race.tq, promise-any.tq",
  ),
  s(
    YK,
    "/* --- ArrayBuffer, the typed arrays",
    "builtin",
    "src/builtins/typed-array-*.tq, builtins-arraybuffer.cc, builtins-dataview.cc; TextEncoder: node/src/encoding_binding.cc",
  ),
  s(
    YK,
    "/* --- a program's entry: process, console",
    "node",
    "node/src's process and console, over V8's API (#1367)",
  ),
  s(YK, "/* --- JSON.parse", "builtin", "src/json/json-parser.cc"),
  s(YK, "/* --- C's memory:", "leaf", "leaves.ts: byte-addressed memory and function references"),
  s(
    YK,
    "/* --- The system-call leaf",
    "leaf",
    "leaves.ts: the system-call leaf and the thread pointer",
  ),
  s(
    YK,
    "/* --- the runtime's own internalBinding layer",
    "node",
    "node/src's bindings, over V8's API as atoms (#1367)",
  ),
  s(YK, "/* --- Proxy", "builtin", "src/builtins/proxy-*.tq, src/objects/js-proxy.h"),
  s(
    YK,
    "/* --- spread:",
    "builtin",
    "src/builtins/builtins-call-gen.cc (CallWithSpread), iteration",
  ),
  s(
    YK,
    "/* --- Math, with JavaScript's results ---",
    "builtin",
    "src/builtins/math.tq, src/base/ieee754.cc (#1362's Math atoms)",
  ),
  s(YK, "/* --- the host boundary:", "host", "the test harnesses' text form of values"),
  s(
    "rx.h",
    "",
    "builtin",
    "src/regexp/ (Irregexp's parser): new RegExp(string) compiled at run time",
  ),
  s("rx.h", "/* --- matching ---", "builtin", "src/regexp/ (Irregexp's backtracking matcher)"),
  s("case.h", "", "builtin", "src/strings/unicode.cc (unibrow's case tables)"),
  s("lengths.h", "", "builtin", "each built-in's length, as src/init/bootstrapper.cc installs it"),
  s(NOLIBC, "", "libc", "musl's headers (#1365)"),
  s(
    NOLIBC,
    "/* ---------------------------------------------------------------- system calls",
    "leaf",
    "leaves.ts: the system-call leaf, per architecture",
  ),
  s(
    NOLIBC,
    "/* ---------------------------------------------------------------- memory and strings",
    "libc",
    "musl: src/string/ (#1365)",
  ),
  s(
    NOLIBC,
    "/* ---------------------------------------------------------------- process",
    "libc",
    "musl: src/exit/, src/env/ (#1365)",
  ),
  s(
    NOLIBC,
    "/* ---------------------------------------------------------------- the allocator",
    "libc",
    "musl: src/malloc/ (#1365)",
  ),
  s(
    NOLIBC,
    "/* ---------------------------------------------------------------- big integers",
    "libc",
    "musl: src/stdio/vfprintf.c, src/internal/floatscan.c (#1365)",
  ),
  s(
    NOLIBC,
    "/* ---------------------------------------------------------------- doubles' bits",
    "libc",
    "musl: src/math/ (#1365)",
  ),
  s(
    NOLIBC,
    "/* ---------------------------------------------------------------- exact decimal digits",
    "libc",
    "musl: src/stdio/vfprintf.c (#1365)",
  ),
  s(
    NOLIBC,
    "/* ---------------------------------------------------------------- formatted output",
    "libc",
    "musl: src/stdio/vfprintf.c (#1365)",
  ),
  s(
    NOLIBC,
    "/* ---------------------------------------------------------------- strtod, exact",
    "libc",
    "musl: src/internal/floatscan.c (#1365)",
  ),
  s(
    NOLIBC,
    "/* ---------------------------------------------------------------- stdio",
    "libc",
    "musl: src/stdio/ (#1365)",
  ),
  s(
    NOLIBC,
    "/* ---------------------------------------------------------------- setjmp",
    "control",
    "setjmp and a coroutine's switch, per architecture",
  ),
  s(
    NOLIBC,
    "/* ---------------------------------------------------------------- the program's ELF segments",
    "collector",
    "the collector's roots: the program's writable segments",
  ),
  s(
    NOLIBC,
    "/* ---------------------------------------------------------------- the entry",
    "leaf",
    "the process's entry (_start), per architecture",
  ),
];

/** The kinds #1516's target keeps. */
export const KEPT_KINDS: ReadonlySet<RuntimeKind> = new Set(["leaf", "control"]);

export interface RuntimeSectionLines extends RuntimeSection {
  /** Its first line (1-based) and its lines, comments and blank lines included. */
  readonly line: number;
  readonly lines: number;
}

/** A file's sections' headers: each line that opens one (a top-level `/* ---` comment). */
const isHeader = (line: string): boolean => line.startsWith("/* ---");

/**
 * Each section of the runtime's files with its lines. Throws when a file has a header no section
 * names, or a section names a header the file does not have: the inventory is the whole runtime.
 */
export function runtimeInventory(dir: string): RuntimeSectionLines[] {
  const out: RuntimeSectionLines[] = [];
  for (const file of [...new Set(RUNTIME_SECTIONS.map((x) => x.file))]) {
    const text = readFileSync(join(dir, file), "utf8").split("\n");
    if (text[text.length - 1] === "") text.pop();
    const sections = RUNTIME_SECTIONS.filter((x) => x.file === file);
    const starts: { at: number; section: RuntimeSection }[] = [];
    const opening = sections.find((x) => x.marker === "");
    if (opening === undefined) throw new Error(`runtime/${file}: no section for its opening`);
    starts.push({ at: 0, section: opening });
    for (let i = 0; i < text.length; i++) {
      const l = text[i] as string;
      if (!isHeader(l)) continue;
      const named = sections.filter((x) => x.marker !== "" && l.startsWith(x.marker));
      if (named.length !== 1)
        throw new Error(
          `runtime/${file}:${i + 1}: ${named.length === 0 ? "a section no inventory entry names" : "a section named twice"}: ${l.slice(0, 80)}`,
        );
      starts.push({ at: i, section: named[0] as RuntimeSection });
    }
    for (const x of sections)
      if (!starts.some((st) => st.section === x))
        throw new Error(`runtime/${file}: no section "${x.marker}"`);
    starts.forEach((st, k) => {
      const end = k + 1 < starts.length ? (starts[k + 1] as { at: number }).at : text.length;
      out.push({ ...st.section, line: st.at + 1, lines: end - st.at });
    });
  }
  return out;
}

/** The lines by kind, and the metric: those not of a kind #1516 keeps. */
export function inventoryTotals(sections: readonly RuntimeSectionLines[]): {
  readonly byKind: Readonly<Record<RuntimeKind, number>>;
  readonly total: number;
  readonly toReplace: number;
} {
  const byKind = {
    leaf: 0,
    control: 0,
    "object-model": 0,
    collector: 0,
    builtin: 0,
    node: 0,
    libc: 0,
    host: 0,
  } satisfies Record<RuntimeKind, number>;
  for (const x of sections) byKind[x.kind] += x.lines;
  const total = sections.reduce((n, x) => n + x.lines, 0);
  const toReplace = sections
    .filter((x) => !KEPT_KINDS.has(x.kind))
    .reduce((n, x) => n + x.lines, 0);
  return { byKind, total, toReplace };
}

/** The inventory as a Markdown table (docs/duc/runtime-inventory-1516.md's). */
export function inventoryMarkdown(sections: readonly RuntimeSectionLines[]): string {
  const t = inventoryTotals(sections);
  const kinds = Object.entries(t.byKind)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `| ${k} | ${n} |`);
  const rows = sections.map(
    (x) =>
      `| \`${x.file}:${x.line}\` | ${x.marker === "" ? "(the file's opening)" : x.marker.replace(/^\/\* -+ ?/, "").replace(/[\s:-]+$/, "").replace(/\|/g, "\\|")} | ${x.lines} | ${x.kind} | ${x.source.replace(/\|/g, "\\|")} |`,
  );
  return [
    "# The native runtime, inventoried (#1516)",
    "",
    "Generated by `packages/duc/src/runtime-inventory.ts`; `runtime-inventory.test.ts` checks it is current",
    "(`YAKCC_UPDATE_INVENTORY=1` rewrites it).",
    "",
    "#1516's target: `packages/duc/runtime/` is the leaf table's implementation (`leaves.ts`) and the",
    "control primitives the graph's structure needs, nothing else. Every other section is hand-written",
    "scaffolding, deleted as the atom shaved from its source replaces it.",
    "",
    `**Lines to replace: ${t.toReplace}** of ${t.total} (kept: leaf ${t.byKind.leaf}, control ${t.byKind.control}).`,
    "",
    "Also hand-written, outside `runtime/`: the boot program's `runtime.*` bindings in",
    "`packages/duc/src/program.ts` (contextify, task_queue, async_wrap, messaging, worker, …), V8's and",
    "node/src's part of Node's bindings, replaced as #1367 shaves node/src over V8's API.",
    "",
    "| kind | lines |",
    "|---|---|",
    ...kinds,
    "",
    "| where | section | lines | kind | replaced by |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
