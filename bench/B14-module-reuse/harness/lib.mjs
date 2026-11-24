// SPDX-License-Identifier: MIT
// B14 harness core: scoring in the sandbox (with or without a reused module in scope), the
// prompts of each arm, and the arms themselves. Clients are injected; nothing here calls a
// model or the network.
import vm from "node:vm";
import { transpile } from "../../B11-reuse-economics/harness/lib.mjs";
import { bareContext, freshModule, taggedEqual } from "../../B12-need-to-code/harness/sandbox.mjs";

export const SCORE_TIMEOUT_MS = 2000;

/** What a client may see of a task: never the held-out cases or check. */
export function clientView(t) {
  return {
    id: t.id,
    spec: t.spec,
    lib: t.lib,
    referenceGlue: t.referenceGlue,
    referenceScratch: t.referenceScratch,
  };
}

/** Extract the first fenced code block, or the whole text. */
export function extractCode(text) {
  const m = /```(?:ts|typescript|js|javascript)?\n([\s\S]*?)```/.exec(text);
  return (m ? m[1] : text).trim();
}

/**
 * Score a candidate against a task's held-out test. With `reuse` ({ file, name }), the candidate
 * runs inside a fresh context of that corpus module, with `lib.<name>` bound, so glue and module
 * share one realm. Without it, the candidate runs in a bare context.
 */
export function scoreSolution(task, code, reuse = null) {
  let context;
  if (reuse) {
    const m = freshModule(reuse.file, reuse.name);
    if (m === null)
      return { pass: false, error: `reused module ${reuse.file}#${reuse.name} did not load` };
    context = m.context;
    context.lib = { [reuse.name]: m.binding };
  } else context = bareContext();
  let js;
  try {
    js = transpile(code);
  } catch (err) {
    return { pass: false, error: `transpile: ${String(err.message).slice(0, 200)}` };
  }
  try {
    vm.runInContext(
      `(function(){ var module = { exports: {} }; var exports = module.exports; ${js}\n; globalThis.__solve = module.exports.solve; })()`,
      context,
      { timeout: SCORE_TIMEOUT_MS },
    );
  } catch (err) {
    return { pass: false, error: `load: ${String(err.message).slice(0, 200)}` };
  }
  if (vm.runInContext("typeof __solve", context) !== "function")
    return { pass: false, error: "no exported solve" };
  try {
    for (const c of task.cases ?? []) {
      context.__args = JSON.stringify(c.args);
      const r = JSON.parse(
        vm.runInContext(
          "JSON.stringify((function(){ try { return { ok: true, v: __enc(__solve.apply(undefined, __dec(JSON.parse(__args)))) }; } catch (e) { return { ok: false, e: String(e && e.message) }; } })())",
          context,
          { timeout: SCORE_TIMEOUT_MS },
        ),
      );
      if (c.throws === true) {
        if (r.ok)
          return {
            pass: false,
            error: `expected a throw for ${JSON.stringify(c.args).slice(0, 80)}`,
          };
      } else if (!r.ok)
        return { pass: false, error: `threw ${r.e} for ${JSON.stringify(c.args).slice(0, 80)}` };
      else if (!taggedEqual(r.v, c.returns))
        return {
          pass: false,
          error: `got ${JSON.stringify(r.v).slice(0, 80)} for ${JSON.stringify(c.args).slice(0, 80)}`,
        };
    }
    if (task.check)
      vm.runInContext(`(function(fn){${task.check}\n})(__solve)`, context, {
        timeout: SCORE_TIMEOUT_MS,
      });
    return { pass: true, error: null };
  } catch (err) {
    return { pass: false, error: String(err.message).slice(0, 200) };
  }
}

const CODE_RULES =
  "Return only the TypeScript code in one fenced block. Use only the ECMAScript standard library: no imports, no Node or browser APIs.";

export function scratchPrompt(task) {
  return `Task: ${task.spec}\n\n${CODE_RULES}`;
}

export function needPrompt(task) {
  return `Task: ${task.spec}\n\nBefore writing any code, say what reusable library module would do the heavy lifting for this task, as one or two sentences for a code search: the capability, its inputs and outputs, the behavior that matters. No code. If the task is small enough that no library would help, reply NONE.`;
}

export function confirmPrompt(task, need, candidates) {
  const lines = [
    `Task: ${task.spec}`,
    "",
    `You searched a module library for: ${need}`,
    "",
    "Candidates:",
    ...candidates.map((c, i) => `${i + 1}. ${c.text.split("\n").join("\n   ")}`),
    "",
    'Which candidate would you reuse to do the heavy lifting? Reply with one JSON object and nothing else: {"pick": candidate number}, or {"pick": 0} if none fits.',
  ];
  return lines.join("\n");
}

export function gluePrompt(task, name, rootSource) {
  return [
    `Task: ${task.spec}`,
    "",
    `A library function is already in scope as \`lib.${name}\` (do not import or redefine it). Its definition:`,
    "```js",
    rootSource.length > 4000 ? `${rootSource.slice(0, 4000)}\n// … (truncated)` : rootSource,
    "```",
    "",
    `Write the task's code, calling \`lib.${name}\` for the heavy lifting. ${CODE_RULES}`,
  ].join("\n");
}

/** The pick from a confirm reply (an integer), or null when unreadable. */
export function parsePick(text) {
  const end = text.lastIndexOf("}");
  for (let s = text.lastIndexOf("{", end); s >= 0; s = text.lastIndexOf("{", s - 1)) {
    try {
      const v = JSON.parse(text.slice(s, end + 1));
      const n = Number(v?.pick);
      return v?.pick !== undefined && v?.pick !== null && Number.isInteger(n) ? n : null;
    } catch {}
    if (s === 0) break;
  }
  return null;
}

/** Whether a module index entry is a task's target module. */
export const isTargetEntry = (task, e) =>
  e.sourceFile === task.lib.file && e.name === task.lib.name;

/** The scratch arm: one call, the model writes everything. */
export async function runScratch({ task, client }) {
  const t0 = Date.now();
  const r = await client.complete(scratchPrompt(task));
  const score = scoreSolution(task, extractCode(r.text));
  return {
    arm: "scratch",
    task: task.id,
    ...score,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    turns: 1,
    ms: Date.now() - t0,
  };
}

/**
 * The reuse arm: the model names the capability it needs; the library shows the top k modules;
 * the model picks one or none; with a pick, it writes glue around `lib.<name>`, which the
 * scorer binds to the picked module; with none (or NONE), it writes everything itself.
 */
export async function runReuse({ task, client, search, rootSourceOf, k = 5 }) {
  const t0 = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  const call = async (prompt) => {
    const r = await client.complete(prompt);
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    turns++;
    return r.text;
  };
  const needText = (await call(needPrompt(task))).trim();
  let picked = null;
  let shown = [];
  if (!/^NONE\b/i.test(needText)) {
    shown = await search(needText, k);
    const pick = parsePick(await call(confirmPrompt(task, needText, shown)));
    if (pick !== null && pick >= 1 && pick <= shown.length) picked = shown[pick - 1];
  }
  let code;
  let score;
  if (picked) {
    code = extractCode(await call(gluePrompt(task, picked.name, rootSourceOf(picked.id))));
    score = scoreSolution(task, code, { file: picked.sourceFile, name: picked.name });
  } else {
    code = extractCode(await call(scratchPrompt(task)));
    score = scoreSolution(task, code);
  }
  return {
    arm: "reuse",
    task: task.id,
    ...score,
    inputTokens,
    outputTokens,
    turns,
    ms: Date.now() - t0,
    need: needText.slice(0, 300),
    targetShown: shown.some((e) => isTargetEntry(task, e)),
    picked: picked?.id ?? null,
    pickedTarget: picked ? isTargetEntry(task, picked) : false,
  };
}

/** Per-arm summary: pass rate, mean tokens, cost at a (input, output) price per million. */
export function summarize(rows, price) {
  const out = {};
  for (const arm of [...new Set(rows.map((r) => r.arm))]) {
    const rs = rows.filter((r) => r.arm === arm);
    const mean = (f) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
    const cost = (r) => (r.inputTokens * price[0] + r.outputTokens * price[1]) / 1e6;
    out[arm] = {
      n: rs.length,
      passRate: rs.filter((r) => r.pass).length / rs.length,
      meanInputTokens: mean((r) => r.inputTokens),
      meanOutputTokens: mean((r) => r.outputTokens),
      meanTurns: mean((r) => r.turns),
      meanDollars: mean(cost),
      dollarsPerPass: rs.some((r) => r.pass)
        ? rs.reduce((s, r) => s + cost(r), 0) / rs.filter((r) => r.pass).length
        : null,
      ...(arm === "reuse"
        ? {
            reuseRate: rs.filter((r) => r.picked).length / rs.length,
            targetShown: rs.filter((r) => r.targetShown).length / rs.length,
            pickedTarget: rs.filter((r) => r.pickedTarget).length / rs.length,
          }
        : {}),
    };
  }
  return out;
}
