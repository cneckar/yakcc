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

/** The exported function a task's held-out check calls: `entry`, or the id camel-cased. */
export function entryName(task) {
  return task.entry ?? task.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * What a model client may see of a task: its id and spec, plus the reference solution for
 * the offline validation client. The held-out check is never part of it, so no client can
 * read the answer key it is scored by.
 */
export function clientView(task) {
  return { id: task.id, spec: task.spec, reference: task.reference };
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
  const entry = entryName(task);
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
    // The check is called inside the context, so the timeout bounds the candidate's run too.
    context.__candidate = fn;
    vm.runInContext(`(function(fn){${task.heldOut}\n})(__candidate)`, context, { timeout: 2000 });
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
    for (const c of slice) {
      const where = `${c.citation.sourceFile}:${c.citation.lineStart}-${c.citation.lineEnd}`;
      // One-line candidates stay inline; corpus source spans go in a fenced block.
      if (c.text.includes("\n")) lines.push(`- ${where}:`, "```js", c.text, "```");
      else lines.push(`- ${where}: ${c.text}`);
    }
  }
  return lines.join("\n");
}

/**
 * Run one arm on one task with an injected model client. The client is
 * { complete(prompt) -> { text, inputTokens, outputTokens } }. Returns the measured row.
 */
export async function runArm({ arm, task, client, slice = [], model }) {
  const prompt = buildPrompt(task, arm === "scratch" ? "scratch" : "slice", slice);
  const t0 = Date.now();
  const reply = await client.complete(prompt);
  const ms = Date.now() - t0;
  const score = stopFailure(reply) ?? scoreSolution(task, extractCode(reply.text));
  return {
    arm,
    task: task.id,
    ...(model !== undefined ? { model } : {}),
    pass: score.pass,
    error: score.error,
    inputTokens: reply.inputTokens,
    outputTokens: reply.outputTokens,
    turns: 1,
    ms,
    ...(reply.stopReason !== undefined ? { stopReason: reply.stopReason } : {}),
  };
}

/**
 * A reply that stopped for a reason other than finishing (a refusal, or the token cap) has
 * no complete answer to score. It fails with that reason, so it is counted, not hidden.
 */
export function stopFailure(reply) {
  if (reply.stopReason === undefined || reply.stopReason === "end_turn") return null;
  return { pass: false, error: `stop_reason: ${reply.stopReason}` };
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

/** summarize, split by a row key (for example the task's difficulty class). */
export function summarizeBy(rows, keyOf) {
  const groups = {};
  for (const r of rows) {
    const k = keyOf(r);
    groups[k] = [...(groups[k] ?? []), r];
  }
  return Object.fromEntries(Object.entries(groups).map(([k, rs]) => [k, summarize(rs)]));
}

/**
 * The closure holes in a candidate: names it uses that nothing declares, against the
 * ES2022 library only (the scoring sandbox has no host APIs). This is the gap signal the
 * fallback arm uses (#1263). It reads only the candidate, never the held-out check.
 */
export function closureHoles(candidateTs) {
  const name = "candidate.ts";
  const options = {
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    noEmit: true,
    types: [],
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, lang, ...rest) =>
    file === name
      ? ts.createSourceFile(name, candidateTs, lang)
      : getSourceFile(file, lang, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (file) => file === name || fileExists(file);
  const program = ts.createProgram([name], options, host);
  const names = new Set();
  for (const d of program.getSemanticDiagnostics(program.getSourceFile(name))) {
    // "Cannot find name 'x'", with or without a "Did you mean" or "install types" hint.
    const m = /^Cannot find name '([^']+)'/.exec(
      ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    );
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

/** The second-turn prompt after a closure hole: the slice prompt, the reply, and the names. */
export function buildRepairPrompt(task, slice, previousCode, holes) {
  return [
    buildPrompt(task, "slice", slice),
    "",
    "Your previous answer:",
    "```ts",
    previousCode,
    "```",
    `It uses names that nothing defines: ${holes.join(", ")}. The code runs with only the ECMAScript built-ins.`,
    "Define what is missing or remove the uses. Return the complete corrected code in one fenced block.",
  ].join("\n");
}

/**
 * The gap-gated fallback arm (#1263, DEC-RETRIEVAL-GAP-GATE-001). Synthesis runs only on a
 * measured gap, and every trigger is logged with its reason:
 *   - near-miss-only: no slice candidate reaches the strong threshold. The slice is not
 *     worth its tokens, so the model writes from the spec alone (one turn).
 *   - unexplained-residual: a strong candidate exists, so the model composes from the slice,
 *     but its reply has closure holes. One more turn gives it the missing names.
 *   - no trigger: a strong candidate, and a reply with no holes. One turn, no synthesis.
 * The gap is measured on the candidate and the slice scores only, never on the held-out check.
 * `decide` is `decideFallback` from @yakcc/shave (injected, so this file needs no build).
 */
/** The confirm-gate prompt: the task, then the numbered slice candidates; reply with indexes. */
export function buildConfirmPrompt(task, slice) {
  const lines = [
    `Task: ${task.spec}`,
    "",
    "A code registry retrieved these candidates. Which of them would you reuse, in whole or in part, to write the task's code? Judge by what each does, not by its name.",
    'Reply with one JSON object and nothing else: {"use": [candidate numbers]}, or {"use": []} if none helps.',
    "",
  ];
  slice.forEach((c, i) => {
    const where = `${c.citation.sourceFile}:${c.citation.lineStart}-${c.citation.lineEnd}`;
    if (c.text.includes("\n")) lines.push(`${i + 1}. ${where}:`, "```js", c.text, "```");
    else lines.push(`${i + 1}. ${where}: ${c.text}`);
  });
  return lines.join("\n");
}

/** The indexes a confirm reply chose (1-based, in range), or null when it is not readable. */
export function parseConfirm(text, n) {
  const end = text.lastIndexOf("}");
  for (
    let start = text.lastIndexOf("{", end);
    start >= 0;
    start = text.lastIndexOf("{", start - 1)
  ) {
    try {
      const v = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(v?.use))
        return [...new Set(v.use.map(Number))]
          .filter((i) => Number.isInteger(i) && i >= 1 && i <= n)
          .sort((a, b) => a - b);
    } catch {}
    if (start === 0) break;
  }
  return null;
}

/**
 * The gap-gated fallback arm. Two gates decide whether the slice is worth composing from:
 *   - "confirm" (default; B12's finding): a reading turn asks the model which candidates it
 *     would reuse. None: write from the spec alone (trigger "none-confirmed"). Some: compose
 *     from only those. Retrieval scores are not used, because B11 showed they do not
 *     separate relevant slices from irrelevant ones.
 *   - "score": the earlier rule. A candidate at or above the strong threshold, or else
 *     synthesize (trigger "near-miss-only").
 * Under either gate, a composed reply with closure holes gets one repair turn (trigger
 * "unexplained-residual"). Every trigger is logged with its reason. The held-out check is
 * never read.
 */
export async function runFallbackArm(args) {
  if ((args.gate ?? "confirm") === "confirm") return runConfirmFallback(args);
  return runScoreFallback(args);
}

async function runConfirmFallback({ task, client, slice, model }) {
  const t0 = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let stopped = null;
  const stopReasons = [];
  const call = async (prompt) => {
    const reply = await client.complete(prompt);
    inputTokens += reply.inputTokens;
    outputTokens += reply.outputTokens;
    if (reply.stopReason !== undefined) stopReasons.push(reply.stopReason);
    return reply;
  };
  const confirm =
    slice.length === 0 ? { text: '{"use": []}' } : await call(buildConfirmPrompt(task, slice));
  const chosen = parseConfirm(confirm.text, slice.length) ?? [];
  const used = chosen.map((i) => slice[i - 1]);
  let turns = slice.length === 0 ? 0 : 1;
  let trigger = null;
  const ask = async (prompt) => {
    const reply = await call(prompt);
    turns++;
    stopped = stopFailure(reply);
    return extractCode(reply.text);
  };
  let code;
  if (used.length === 0) {
    trigger = { reason: "none-confirmed", shown: slice.length };
    code = await ask(buildPrompt(task, "scratch", []));
  } else {
    code = await ask(buildPrompt(task, "slice", used));
    const holes = stopped === null ? closureHoles(code) : [];
    if (holes.length > 0) {
      trigger = { reason: "unexplained-residual", used: chosen, holes };
      code = await ask(buildRepairPrompt(task, used, code, holes));
    }
  }
  const ms = Date.now() - t0;
  const score = stopped ?? scoreSolution(task, code);
  return {
    arm: "fallback",
    task: task.id,
    ...(model !== undefined ? { model } : {}),
    gate: "confirm",
    pass: score.pass,
    error: score.error,
    inputTokens,
    outputTokens,
    turns,
    ms,
    decision: used.length > 0 && trigger === null ? "compose" : "synthesize",
    confirmed: used.map((c) => c.id),
    trigger,
    ...(stopReasons.length > 0 ? { stopReasons } : {}),
  };
}

async function runScoreFallback({ task, client, slice, strongThreshold, decide, model }) {
  const scores = task.slice.map((c) => c.score);
  const first = decide({ scores, strongThreshold, unexplainedCount: 0 });
  const bestScore = scores.length === 0 ? null : Math.max(...scores);
  const t0 = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let stopped = null;
  const stopReasons = [];
  const ask = async (prompt) => {
    const reply = await client.complete(prompt);
    inputTokens += reply.inputTokens;
    outputTokens += reply.outputTokens;
    if (reply.stopReason !== undefined) stopReasons.push(reply.stopReason);
    stopped = stopFailure(reply);
    return extractCode(reply.text);
  };
  let code;
  let turns = 1;
  let trigger = null;
  if (first.action === "synthesize") {
    trigger = { reason: first.reason, bestScore };
    code = await ask(buildPrompt(task, "scratch", []));
  } else {
    code = await ask(buildPrompt(task, "slice", slice));
    // An unfinished reply is scored as it stopped; its holes are not a measured gap.
    const holes = stopped === null ? closureHoles(code) : [];
    const second = decide({ scores, strongThreshold, unexplainedCount: holes.length });
    if (second.action === "synthesize") {
      trigger = { reason: second.reason, bestScore, holes };
      turns = 2;
      code = await ask(buildRepairPrompt(task, slice, code, holes));
    }
  }
  const ms = Date.now() - t0;
  const score = stopped ?? scoreSolution(task, code);
  return {
    arm: "fallback",
    task: task.id,
    ...(model !== undefined ? { model } : {}),
    pass: score.pass,
    error: score.error,
    inputTokens,
    outputTokens,
    turns,
    ms,
    gate: "score",
    decision: first.action === "reuse" && trigger === null ? "compose" : "synthesize",
    trigger,
    ...(stopReasons.length > 0 ? { stopReasons } : {}),
  };
}

/** Count fallback rows by trigger reason, with the synthesis rate (#1263). */
export function tallyTriggers(rows) {
  const fallback = rows.filter((r) => r.arm === "fallback");
  const byReason = {};
  for (const r of fallback) {
    const k = r.trigger?.reason ?? "none";
    byReason[k] = (byReason[k] ?? 0) + 1;
  }
  const triggered = fallback.filter((r) => r.trigger !== null).length;
  return {
    rows: fallback.length,
    byReason,
    synthesisRate: fallback.length === 0 ? 0 : triggered / fallback.length,
  };
}

/**
 * Break-even against a baseline arm, as a function of reuse count. With a baseline cost C_s
 * per task, an arm cost C_r per task and a one-time setup cost S, the arm pays once
 * n * (C_s - C_r) > S, so n* = ceil(S / (C_s - C_r)) and never when C_r >= C_s. Costs are
 * mean tokens per task, and also tokens per passing task, which charges an arm for failures.
 * S is not measured by this harness, so n* is reported over a grid of S.
 */
export function breakEven(
  summary,
  { baseline = "scratch", setupGrid = [0, 1000, 10000, 100000] } = {},
) {
  const base = summary[baseline];
  if (base === undefined) return {};
  const perPass = (a) => (a.passes === 0 ? null : (a.inputTokens + a.outputTokens) / a.passes);
  const nStar = (saving) =>
    Object.fromEntries(
      setupGrid.map((S) => [S, saving !== null && saving > 0 ? Math.ceil(S / saving) : null]),
    );
  const out = {};
  for (const [arm, a] of Object.entries(summary)) {
    if (arm === baseline) continue;
    const savingPerTask = base.meanTokens - a.meanTokens;
    const bp = perPass(base);
    const ap = perPass(a);
    const savingPerPass = bp === null || ap === null ? null : bp - ap;
    out[arm] = {
      savingPerTask,
      savingPerPass,
      passRateDelta: a.passRate - base.passRate,
      nStarByTask: nStar(savingPerTask),
      nStarByPass: nStar(savingPerPass),
    };
  }
  return out;
}

/** Total tokens per model across every row (rows from several models add up). */
export function tokensByModel(rows) {
  const out = {};
  for (const r of rows) {
    const k = r.model ?? "unknown";
    const m = out[k] ?? { inputTokens: 0, outputTokens: 0, calls: 0 };
    out[k] = {
      inputTokens: m.inputTokens + r.inputTokens,
      outputTokens: m.outputTokens + r.outputTokens,
      calls: m.calls + r.turns,
    };
  }
  return out;
}
