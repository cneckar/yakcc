// SPDX-License-Identifier: Apache-2.0
// The lifter against test262 (#1361, #1370): each test of `test/language` is run as written, and as its
// lifted graph printed back to TypeScript (`emitTypeScript`, made runnable as the lift-semantics probes
// are), both in a fresh realm with test262's harness. A test that passes as written must pass lifted;
// one that does not is a place where the lift changes meaning. Each test is the body of a function `f`
// (strict for `onlyStrict`), so both sides see the same wrapping; a test that fails as written so
// wrapped is not counted. Negative, module, async and raw tests are skipped. Run after building:
//   node scripts/sweep-test262.mjs <test262 dir> <report.json> [path filter] [workers]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import vm from "node:vm";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const ts = createRequire(import.meta.url)("typescript");
const LIFT_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 5_000;

/** A test's frontmatter: its flags, includes, and whether it is negative. */
function meta(text) {
  const m = text.match(/\/\*---([\s\S]*?)---\*\//);
  const y = m ? m[1] : "";
  const list = (key) => {
    const inline = y.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m"));
    if (inline) return inline[1].split(",").map((s) => s.trim()).filter(Boolean);
    const block = y.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s*.*\\n?)+)`, "m"));
    return block ? [...block[1].matchAll(/-\s*(\S+)/g)].map((x) => x[1]) : [];
  };
  return { flags: list("flags"), includes: list("includes"), negative: /^negative:/m.test(y) };
}

if (isMainThread) {
  const [dir, out, filter = "", workersArg] = process.argv.slice(2);
  const WORKERS = Number(workersArg ?? 6);
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js") && !e.name.includes("_FIXTURE") && p.includes(filter)) files.push(p);
    }
  };
  walk(join(dir, "test/language"));
  files.sort();
  const results = {};
  let next = 0;
  let done = 0;
  const started = Date.now();
  const spawn = () =>
    new Promise((resolveAll) => {
      let worker;
      let current;
      let timer;
      const start = () => {
        worker = new Worker(new URL(import.meta.url), { workerData: { dir } });
        worker.on("message", (r) => {
          clearTimeout(timer);
          results[relative(dir, current)] = r;
          step();
        });
        worker.on("error", (e) => {
          clearTimeout(timer);
          results[relative(dir, current)] = { status: "crash", msg: String(e?.message ?? e).slice(0, 300) };
          start();
          step();
        });
      };
      const step = () => {
        if (++done > 0 && done % 500 === 0)
          process.stderr.write(`${done}/${files.length} ${Math.round((Date.now() - started) / 1000)}s\n`);
        dispatch();
      };
      const dispatch = () => {
        if (next >= files.length) {
          worker.terminate();
          resolveAll();
          return;
        }
        current = files[next++];
        timer = setTimeout(() => {
          results[relative(dir, current)] = { status: "timeout" };
          worker.removeAllListeners();
          worker.terminate();
          start();
          step();
        }, LIFT_TIMEOUT_MS);
        worker.postMessage(current);
      };
      start();
      done--; // the first dispatch is not a completion
      step();
    });
  await Promise.all(Array.from({ length: WORKERS }, spawn));
  // Grouped by status, and failures by their message without particulars.
  const norm = (s) =>
    String(s ?? "")
      .replace(/"[^"]*"/g, '"…"')
      .replace(/'[^']*'/g, "'…'")
      .replace(/\b\d+\b/g, "N")
      .slice(0, 160);
  const counts = {};
  const groups = {};
  for (const [file, r] of Object.entries(results)) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (r.status === "pass" || r.status === "skip" || r.status === "orig-fail") continue;
    const key = `${r.status}: ${norm(r.msg)}`;
    (groups[key] ??= []).push(file);
  }
  const byCount = Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, fs]) => ({ key, count: fs.length, examples: fs.slice(0, 5) }));
  writeFileSync(out, JSON.stringify({ counts, groups: byCount, results }, null, 1));
  console.log(JSON.stringify(counts));
  for (const g of byCount.slice(0, 40)) console.log(String(g.count).padStart(5), g.key, "|", g.examples[0]);
  console.log(`elapsed ${Math.round((Date.now() - started) / 1000)}s`);
} else {
  const { dir } = workerData;
  const { liftAtom, emitTypeScript } = await import("@yakcc/duc");
  // The probes' runnable form, from its source, so the runtime it inlines is the one the tests use.
  const runnableSrc = readFileSync(new URL("../src/__fixtures__/runnable.ts", import.meta.url), "utf8");
  const { runnable } = await import(
    `data:text/javascript,${encodeURIComponent(
      ts.transpileModule(runnableSrc, { compilerOptions: { target: 99, module: 99 } }).outputText,
    )}`
  );
  const harnessCache = new Map();
  const harness = (name) => {
    let t = harnessCache.get(name);
    if (t === undefined) harnessCache.set(name, (t = readFileSync(join(dir, "harness", name), "utf8")));
    return t;
  };
  const opaque = (g) =>
    g.nodes.flatMap((n) => [
      ...(/#[0-9a-f]{16}$/.test(n.label ?? "") ? [n.label] : []),
      ...(n.closure !== undefined ? opaque(n.closure) : []),
    ]);
  /** The script's outcome in a fresh realm: "pass", or what it threw. */
  const run = (prelude, code) => {
    const ctx = vm.createContext({}, { microtaskMode: "afterEvaluate" });
    try {
      vm.runInContext(`${prelude}\n${code}\nf();`, ctx, { timeout: RUN_TIMEOUT_MS });
      return { ok: true };
    } catch (e) {
      const name = e?.constructor?.name ?? typeof e;
      return { ok: false, msg: `${name}: ${String(e?.message ?? e).split("\n")[0].slice(0, 200)}` };
    }
  };
  parentPort.on("message", (file) => {
    const text = readFileSync(file, "utf8");
    const m = meta(text);
    if (
      m.negative ||
      m.flags.some((f) => f === "module" || f === "async" || f === "raw" || f === "CanBlockIsTrue")
    ) {
      parentPort.postMessage({ status: "skip" });
      return;
    }
    const prelude = ["assert.js", "sta.js", ...m.includes].map(harness).join("\n");
    const strict = m.flags.includes("onlyStrict") ? '"use strict";\n' : "";
    const source = `export function f() {\n${strict}${text}\n}`;
    const orig = run(prelude, source.replace(/^export /, ""));
    if (!orig.ok) {
      parentPort.postMessage({ status: "orig-fail", msg: orig.msg });
      return;
    }
    let g;
    try {
      g = liftAtom(source);
    } catch (e) {
      parentPort.postMessage({ status: "lift-error", msg: String(e?.message ?? e).split("\n")[0].slice(0, 200) });
      return;
    }
    const op = opaque(g);
    let emitted;
    try {
      emitted = runnable(emitTypeScript(g));
    } catch (e) {
      parentPort.postMessage({ status: "emit-error", msg: String(e?.message ?? e).split("\n")[0].slice(0, 200) });
      return;
    }
    let js;
    try {
      // As a module, so nothing is added (CommonJS output would make the script strict).
      js = ts.transpileModule(emitted, { compilerOptions: { target: 99, module: 99 } }).outputText;
      if (/^\s*(import|export)\b/m.test(js)) throw new Error("emitted code imports or exports");
    } catch (e) {
      parentPort.postMessage({ status: "emit-error", msg: `transpile: ${String(e?.message ?? e).slice(0, 200)}` });
      return;
    }
    const lifted = run(prelude, js);
    if (lifted.ok) parentPort.postMessage({ status: op.length === 0 ? "pass" : "pass-opaque" });
    else parentPort.postMessage({ status: "mismatch", msg: lifted.msg, opaque: op.length });
  });
}
