// SPDX-License-Identifier: MIT
// Load a corpus module in a vm context and call its top-level functions by name, so a
// candidate can be checked by running it. The corpus is vendored repository source, and vm
// is not a security boundary: the context only keeps host APIs (process, fs, network) out
// of reach of the code, and a timeout bounds every call.
//
// A module is transpiled to CommonJS (so ESM files load too) and evaluated with a require
// that resolves only relative paths inside its own fixture package. Node built-ins and bare
// package names are refused, so a module that needs them does not load. After the module
// body runs, its top-level bindings are picked by name: internal helpers that the module
// never exports are callable too, which is what a shaved atom is.
//
// Values cross the context boundary as tagged JSON (encode / decode below), so arrays,
// Dates, Maps, Sets, byte arrays, undefined and NaN compare by value, not by realm.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
export const FIXTURES = join(repo, "packages/shave/src/__fixtures__/module-graph");
const ts = createRequire(join(repo, "packages/shave/package.json"))("typescript");

/** Per-call time limit, in milliseconds. */
export const CALL_TIMEOUT_MS = 200;

// The tagged-value codec, as source, so the same code runs inside every context.
const CODEC = `
var __enc = function enc(v, depth) {
  depth = depth || 0;
  if (depth > 20) return { $type: "deep" };
  if (v === undefined) return { $type: "undefined" };
  if (typeof v === "number") {
    if (Number.isNaN(v)) return { $type: "NaN" };
    if (v === Infinity) return { $type: "Infinity" };
    if (v === -Infinity) return { $type: "-Infinity" };
    if (Object.is(v, -0)) return 0;
    return v;
  }
  if (typeof v === "bigint") return { $bigint: String(v) };
  if (typeof v === "function") return { $type: "function" };
  if (typeof v === "symbol") return { $type: "symbol" };
  if (v === null || typeof v !== "object") return v;
  if (typeof v.then === "function") {
    try { v.then(null, function () {}); } catch (e) {}
    return { $type: "promise" };
  }
  if (v instanceof Date) return { $date: Number.isNaN(v.getTime()) ? "Invalid" : v.toISOString() };
  if (ArrayBuffer.isView(v)) return { $bytes: Array.from(v) };
  if (v instanceof Map) return { $map: Array.from(v, function (e) { return [enc(e[0], depth + 1), enc(e[1], depth + 1)]; }) };
  if (v instanceof Set) return { $set: Array.from(v, function (e) { return enc(e, depth + 1); }) };
  if (v instanceof RegExp) return { $regexp: String(v) };
  if (v instanceof Error) return { $error: v.name };
  if (Array.isArray(v)) return v.map(function (e) { return enc(e, depth + 1); });
  var out = {};
  Object.keys(v).sort().forEach(function (k) { out[k] = enc(v[k], depth + 1); });
  return out;
};
var __dec = function dec(v) {
  if (Array.isArray(v)) return v.map(dec);
  if (v === null || typeof v !== "object") return v;
  if (v.$type === "undefined") return undefined;
  if (v.$type === "NaN") return NaN;
  if (v.$type === "Infinity") return Infinity;
  if (v.$type === "-Infinity") return -Infinity;
  if ("$date" in v) return new Date(v.$date);
  if ("$bytes" in v) return Uint8Array.from(v.$bytes);
  if ("$map" in v) return new Map(v.$map.map(function (e) { return [dec(e[0]), dec(e[1])]; }));
  if ("$set" in v) return new Set(v.$set.map(dec));
  if ("$bigint" in v) return BigInt(v.$bigint);
  var out = {};
  Object.keys(v).forEach(function (k) { out[k] = dec(v[k]); });
  return out;
};
`;

const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      allowJs: true,
      esModuleInterop: true,
    },
  }).outputText;

/** The top-level declared names of a module, so they can be picked after it runs. */
export function topLevelNames(source) {
  const sf = ts.createSourceFile("m.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const names = [];
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name)
      names.push(st.name.text);
    else if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name)) names.push(d.name.text);
  }
  return names;
}

function resolveInPackage(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  const pkgRoot = join(FIXTURES, relative(FIXTURES, fromFile).split("/")[0]);
  if (relative(pkgRoot, base).startsWith("..")) return null;
  // TypeScript sources import "./x.js" for a file that is "./x.ts".
  const tsTwin = base.endsWith(".js") ? `${base.slice(0, -3)}.ts` : null;
  const candidates = [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.mjs`,
    `${base}.ts`,
    join(base, "index.js"),
    join(base, "index.ts"),
  ];
  if (tsTwin) candidates.push(tsTwin);
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** A fresh sandbox context with the codec and nothing from the host (for tests). */
export function bareContext() {
  const context = vm.createContext({});
  vm.runInContext(CODEC, context);
  return context;
}

/** A context holding one corpus module and its relative dependencies. */
function loadModule(file) {
  const context = vm.createContext({});
  vm.runInContext(CODEC, context);
  const cache = new Map();
  const load = (path) => {
    if (cache.has(path)) return cache.get(path).exports;
    const source = readFileSync(path, "utf8");
    const module = { exports: {} };
    cache.set(path, module);
    const names = topLevelNames(source);
    const pick = names
      .map(
        (n) =>
          `${JSON.stringify(n)}: (function(){ try { return ${n}; } catch (e) { return undefined; } })()`,
      )
      .join(",");
    const wrapped = `(function (exports, require, module, __filename, __dirname) {\n${transpile(source)}\n;module.__picked = {${pick}};\n})`;
    const fn = vm.runInContext(wrapped, context, { filename: path, timeout: 2000 });
    const req = (spec) => {
      const target = resolveInPackage(path, spec);
      if (target === null) throw new Error(`sandbox: require("${spec}") is not available`);
      return load(target);
    };
    fn(module.exports, req, module, path, dirname(path));
    return module.exports;
  };
  load(file);
  return { context, picked: cache.get(file).__picked ?? {} };
}

const modules = new Map();

/**
 * The callable for a definition: its top-level binding in its module, or a reason it has
 * none (the module did not load, or the name is not a top-level function).
 */
export function resolveCallable(sourceFile, name) {
  const file = join(FIXTURES, sourceFile);
  let mod = modules.get(file);
  if (mod === undefined) {
    try {
      mod = { ok: true, ...loadModule(file) };
    } catch (err) {
      mod = {
        ok: false,
        reason: `load: ${String(err?.message ?? err)
          .split("\n")[0]
          .slice(0, 100)}`,
      };
    }
    modules.set(file, mod);
  }
  if (!mod.ok) return { callable: false, reason: mod.reason };
  const fn = mod.picked[name];
  if (typeof fn !== "function") return { callable: false, reason: "not a top-level function" };
  if (/^class\b/.test(Function.prototype.toString.call(fn)))
    return { callable: false, reason: "class" };
  return { callable: true, context: mod.context, fn, arity: fn.length };
}

/**
 * Call a resolved callable with tagged-JSON arguments. Returns { ok: true, value } with the
 * tagged result, or { ok: false, error } when it threw or ran out of time.
 */
export function callTagged(callable, args) {
  const { context, fn } = callable;
  context.__fn = fn;
  context.__argsJson = JSON.stringify(args);
  try {
    const out = vm.runInContext(
      `JSON.stringify((function(){ try { return { ok: true, value: __enc(__fn.apply(undefined, __dec(JSON.parse(__argsJson)))) }; } catch (e) { return { ok: false, error: (e && e.name) || "Error" }; } })())`,
      context,
      { timeout: CALL_TIMEOUT_MS },
    );
    return JSON.parse(out);
  } catch (err) {
    return { ok: false, error: /timed out/i.test(String(err?.message)) ? "timeout" : "host" };
  }
}

/** Deep equality of tagged values; numbers within a relative 1e-9. */
export function taggedEqual(a, b) {
  if (typeof a === "number" && typeof b === "number")
    return a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => taggedEqual(x, b[i]));
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && taggedEqual(a[k], b[k]));
}

/**
 * A fresh, uncached context holding one corpus module, with the named top-level binding (a
 * function or a class) picked out. Task code that reuses the module runs in this same context,
 * so values never cross realms (instanceof Date, Array prototypes) between glue and module.
 * Returns null when the module does not load or the name is not top level.
 */
export function freshModule(sourceFile, name) {
  try {
    const mod = loadModule(join(FIXTURES, sourceFile));
    const binding = mod.picked[name];
    if (binding === undefined) return null;
    return { context: mod.context, binding };
  } catch {
    return null;
  }
}
