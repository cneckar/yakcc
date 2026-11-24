// SPDX-License-Identifier: MIT
// B16 scoring: run a solution on every held-out case of a task and count the passes, in the
// B12 vm sandbox (no host APIs; a timeout on every call). With `reuse` ({ file, name }), the
// solution runs inside a fresh context of that corpus module with `lib.<name>` bound, as in
// B14; without it, in a bare context, so scratch code cannot reach a module.
//
// pass = every case passed (and the task's custom check, if any): pass@1 is computed from it.
// passed / total = the share of cases passed, which shows how wrong a failing solution is.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { transpile } from "../../B11-reuse-economics/harness/lib.mjs";
import { bareContext, freshModule, taggedEqual } from "../../B12-need-to-code/harness/sandbox.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const CASES_DIR = resolve(here, "..", "cases");
export const CALL_TIMEOUT_MS = 2000;

/** A task's held-out cases: its hand-written ones plus the built ones in cases/<id>.json. */
export function casesOf(task) {
  const file = join(CASES_DIR, `${task.id}.json`);
  const built = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).cases : [];
  return [...(task.cases ?? []), ...built];
}

/** Load a solution's `solve` into a context (with the module bound when reusing). */
export function loadSolution(code, reuse = null) {
  let context;
  if (reuse) {
    const m = freshModule(reuse.file, reuse.name);
    if (m === null) return { error: `reused module ${reuse.file}#${reuse.name} did not load` };
    context = m.context;
    context.lib = { [reuse.name]: m.binding };
  } else context = bareContext();
  let js;
  try {
    js = transpile(code);
  } catch (err) {
    return { error: `transpile: ${String(err.message).slice(0, 200)}` };
  }
  try {
    vm.runInContext(
      `(function(){ var module = { exports: {} }; var exports = module.exports; ${js}\n; globalThis.__solve = module.exports.solve; })()`,
      context,
      { timeout: CALL_TIMEOUT_MS },
    );
  } catch (err) {
    return { error: `load: ${String(err.message).slice(0, 200)}` };
  }
  if (vm.runInContext("typeof __solve", context) !== "function")
    return { error: "no exported solve" };
  return { context };
}

/** Call the loaded solve on tagged arguments: { ok, value } or { ok: false, error }. */
export function callSolve(context, args) {
  context.__args = JSON.stringify(args);
  try {
    return JSON.parse(
      vm.runInContext(
        "JSON.stringify((function(){ try { return { ok: true, value: __enc(__solve.apply(undefined, __dec(JSON.parse(__args)))) }; } catch (e) { return { ok: false, error: String(e && e.message) }; } })())",
        context,
        { timeout: CALL_TIMEOUT_MS },
      ),
    );
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message ?? err),
      timeout: /timed out/i.test(err?.message),
    };
  }
}

/** Score a solution on all of a task's cases. */
export function scoreSolution(task, code, reuse = null, cases = casesOf(task)) {
  const loaded = loadSolution(code, reuse);
  const total = cases.length + (task.check ? 1 : 0);
  if (loaded.error) return { pass: false, passed: 0, total, error: loaded.error };
  const { context } = loaded;
  let passed = 0;
  let firstError = null;
  for (const c of cases) {
    const r = callSolve(context, c.args);
    let ok;
    if (c.throws === true) ok = !r.ok && !r.timeout;
    else ok = r.ok && taggedEqual(r.value, c.returns);
    if (ok) passed++;
    else
      firstError ??= r.ok
        ? `got ${JSON.stringify(r.value).slice(0, 80)} for ${JSON.stringify(c.args).slice(0, 80)}`
        : `${r.timeout ? "timed out" : `threw ${r.error}`} for ${JSON.stringify(c.args).slice(0, 80)}`;
    if (r.timeout) break; // one hang is enough to fail; do not spend 2 s on every case
  }
  if (task.check) {
    try {
      vm.runInContext(`(function(fn){${task.check}\n})(__solve)`, context, {
        timeout: CALL_TIMEOUT_MS,
      });
      passed++;
    } catch (err) {
      firstError ??= `check: ${String(err.message).slice(0, 160)}`;
    }
  }
  return { pass: passed === total, passed, total, error: firstError };
}
