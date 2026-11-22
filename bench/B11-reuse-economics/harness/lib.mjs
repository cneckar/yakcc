// SPDX-License-Identifier: MIT
// B11 reuse-economics harness: arms, prompts, sandboxed scoring, metrics.
// Scoring transpiles the candidate TypeScript and runs the task's held-out check in a
// fresh vm context. Nothing here touches the network except the explicit Anthropic client.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

/** Load every task JSON in a directory, sorted by id. */
export function loadTasks(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

/** Transpile TypeScript to JavaScript (types erased). */
export function transpile(source) {
  const out = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  const diagnostics = out.diagnostics ?? [];
  if (diagnostics.length > 0) {
    throw new SyntaxError(ts.flattenDiagnosticMessageText(diagnostics[0].messageText, "\n"));
  }
  return out.outputText;
}

/** Extract the code block a model returned: the first fenced block, or the whole text. */
export function extractCode(text) {
  const fenced = /```(?:ts|typescript|js|javascript)?\n([\s\S]*?)```/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Score a candidate against a task's held-out check. Returns { pass, error }.
 * The candidate must export a function named by the task's `entry` (default: the id
 * with dashes camel-cased). The held-out check receives it as `fn`.
 */
export function scoreSolution(task, candidateTs) {
  const entry = task.entry ?? task.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  let js;
  try {
    js = transpile(candidateTs);
  } catch (err) {
    return { pass: false, error: `transpile: ${err.message}` };
  }
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    RangeError,
    Error,
    Math,
    Number,
    JSON,
    String,
    Array,
    Object,
  });
  try {
    vm.runInContext(js, context, { timeout: 2000 });
  } catch (err) {
    return { pass: false, error: `load: ${err.message}` };
  }
  const fn = module.exports[entry];
  if (typeof fn !== "function") return { pass: false, error: `no exported function ${entry}` };
  try {
    vm.runInContext(`(function(fn){${task.heldOut}\n})`, context, { timeout: 2000 })(fn);
    return { pass: true, error: null };
  } catch (err) {
    return { pass: false, error: err.message };
  }
}

/** Build the prompt for an arm. `slice` is the retrieved context (possibly empty). */
export function buildPrompt(task, arm, slice = []) {
  const lines = [`Task: ${task.spec}`, "Return only the TypeScript code in one fenced block."];
  if (arm !== "scratch" && slice.length > 0) {
    lines.push("", "Kept work from the registry (cite it if you use it):");
    for (const c of slice)
      lines.push(
        `- ${c.citation.sourceFile}:${c.citation.lineStart}-${c.citation.lineEnd}: ${c.text}`,
      );
  }
  return lines.join("\n");
}

/**
 * Run one arm on one task with an injected model client. The client is
 * { complete(prompt) -> { text, inputTokens, outputTokens } }. Returns the measured row.
 */
export async function runArm({ arm, task, client, slice = [] }) {
  const prompt = buildPrompt(task, arm, slice);
  const t0 = Date.now();
  const reply = await client.complete(prompt);
  const ms = Date.now() - t0;
  const score = scoreSolution(task, extractCode(reply.text));
  return {
    arm,
    task: task.id,
    pass: score.pass,
    error: score.error,
    inputTokens: reply.inputTokens,
    outputTokens: reply.outputTokens,
    turns: 1,
    ms,
  };
}

/** Aggregate rows per arm: pass rate, total and mean tokens, mean time. */
export function summarize(rows) {
  const byArm = {};
  for (const r of rows) {
    const a = (byArm[r.arm] ??= { n: 0, passes: 0, inputTokens: 0, outputTokens: 0, ms: 0 });
    a.n++;
    if (r.pass) a.passes++;
    a.inputTokens += r.inputTokens;
    a.outputTokens += r.outputTokens;
    a.ms += r.ms;
  }
  for (const a of Object.values(byArm)) {
    a.passRate = a.n === 0 ? 0 : a.passes / a.n;
    a.meanTokens = a.n === 0 ? 0 : (a.inputTokens + a.outputTokens) / a.n;
    a.meanMs = a.n === 0 ? 0 : a.ms / a.n;
  }
  return byArm;
}
