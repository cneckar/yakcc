// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/harness/llm-baseline.mjs
//
// @decision DEC-B10-LLM-BASELINE-001
// @title Arm B prompt — same vanilla prompt as B9/B4; dry-run reads B9 fixtures in Slice 1
// @status accepted
// @rationale
//   PROMPT PARITY WITH B9/B4
//   Using the same locked vanilla system prompt as B9 (DEC-V0-MIN-SURFACE-003) and B4
//   (DEC-BENCH-B4-HARNESS-001) ensures cross-benchmark comparability. Any wording change
//   measurably shifts what the model emits and how large its surface is.
//
//   LOCKED SYSTEM PROMPT (verbatim from B4/B9):
//   "You are an expert TypeScript developer. When given a coding task, implement it
//   in a single TypeScript file. Output only the implementation code in a
//   ```typescript code block. Do not include explanation before or after the code block."
//
//   LOCKED USER PROMPT TEMPLATE:
//   "Implement a TypeScript function with this signature: function {signature}\n\n
//   Behavior:\n{behavior}\n\nError conditions:\n{error_conditions_numbered}\n\n
//   Throw appropriate Error subclasses (SyntaxError or RangeError) for invalid input."
//
//   MODEL / SAMPLING (matching B9):
//   claude-sonnet-4-6, max_tokens=2048, temperature=1.0, N=3 reps per task
//
//   DRY-RUN PATH (Slice 1)
//   In Slice 1 the B10 corpus is empty (tasks: []). The smoke run operates against
//   the B9 task corpus. Dry-run reads B9's committed fixture files:
//     bench/B9-min-surface/fixtures/<task>/arm-b-response.json
//   These are read-only; B10 does NOT copy or modify them.
//   This keeps Slice 1's dry-run fully offline and validates the Arm B measurement
//   path end-to-end on real fixture responses.
//
//   LIVE-RUN PATH
//   Requires ANTHROPIC_API_KEY env var. Harness aborts with a clear error if absent.
//   Live run exits the B6 air-gap by design — documented in README.md.
//
//   NO-NETWORK PATH
//   --no-network skips Arm B entirely; result carries network_required: true.
//
//   EMIT EXTRACTION
//   The model's response is expected to contain a single ```typescript code block.
//   Content between the first ``` fence pair is extracted verbatim.
//   Extraction failure is recorded as an error in the result (not a harness abort).
//
//   Cross-references:
//   DEC-V0-MIN-SURFACE-003 — bench/B9-min-surface/harness/llm-baseline.mjs (B9 analog)
//   DEC-IRT-B10-METRIC-001 — harness/measure-transitive-surface.mjs (what measures Arm B output)
//   DEC-B10-S1-LAYOUT-001  — harness/run.mjs
//
// Usage:
//   node bench/B10-import-replacement/harness/llm-baseline.mjs \
//     [--task <taskId>] \
//     [--dry-run] [--no-network] \
//     [--output <path>]

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B10_ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Repo / B9 root resolution
// ---------------------------------------------------------------------------

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const p = JSON.parse(readFileSync(pkg, "utf8"));
        if (p.name === "yakcc") return dir;
      } catch (_) {}
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(BENCH_B10_ROOT, "..", "..");
}

const REPO_ROOT = process.env.YAKCC_REPO_ROOT ?? findRepoRoot(resolve(BENCH_B10_ROOT, "..", ".."));
const BENCH_B9_ROOT = join(REPO_ROOT, "bench", "B9-min-surface");

// ---------------------------------------------------------------------------
// Locked system prompt (verbatim from B4/B9 — DEC-V0-MIN-SURFACE-003)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are an expert TypeScript developer. When given a coding task, implement it " +
  "in a single TypeScript file. Output only the implementation code in a " +
  "```typescript code block. Do not include explanation before or after the code block.";

/**
 * Build the locked user prompt for a task spec.
 *
 * @param {{ signature: string, behavior: string, errorConditions?: string[] }} spec
 * @returns {string}
 */
function buildUserPrompt(spec) {
  const errorLines = (spec.errorConditions ?? [])
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");
  return (
    `Implement a TypeScript function with this signature: ${spec.signature}\n\n` +
    `Behavior:\n${spec.behavior}` +
    (errorLines ? `\n\nError conditions:\n${errorLines}` : "") +
    "\n\nThrow appropriate Error subclasses (SyntaxError or RangeError) for invalid input."
  );
}

/**
 * Compute sha256 of combined prompt (system + "\n\n" + user), matching B9 discipline.
 */
function promptSha256(systemPrompt, userPrompt) {
  return createHash("sha256")
    .update(systemPrompt + "\n\n" + userPrompt, "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Emit extraction from model response
// ---------------------------------------------------------------------------

/**
 * Extract TypeScript source from a model response containing a ```typescript block.
 * Returns null if no fence found.
 *
 * Accepts all realistic LLM fence variants:
 *   - ```typescript\ncode``` (standard)
 *   - ```typescript foo\ncode``` (with trailing annotation on language line)
 *   - ```ts\ncode```
 *   - ```\ncode``` (bare fence)
 *
 * @decision DEC-B10-FENCE-REGEX-001
 * @title Loosen fence open-line to accept trailing tokens after language tag
 * @status accepted
 * @rationale
 *   Some LLM responses emit ` ```typescript foo\n` (trailing annotation on the
 *   language tag line). The original `\s*\n` required an immediate newline after
 *   optional whitespace, so any non-whitespace trailing token caused extract_failed.
 *   New form: `(?:(?:typescript|ts)[^\n]*)?\n` — when the language tag is present
 *   it may be followed by any non-newline chars; the mandatory `\n` is preserved.
 *   A bare ` ``` ` fence (no language tag) still matches (optional group absent).
 *   A `python` fence still rejects: `python` doesn't match `typescript|ts` so the
 *   optional group is absent, and the `\n` won't match the `p` in `python`.
 *   This is the minimum change that fixes the live-mode failure without becoming
 *   a "treat anything as emit" fallback.
 *   See: plans/wi-679-b10-fence-regex.md, #679.
 *
 * @param {string} responseText
 * @returns {string|null}
 */
function extractEmitFromResponse(responseText) {
  // Accepts: ```typescript[anything]\ncode```, ```ts[anything]\ncode```, ```\ncode```.
  // Rejects: ```python\ncode``` because `python` doesn't match `typescript|ts` and
  // the mandatory `\n` immediately after ` ``` ` won't match the `p` in `python`.
  const fenceRe = /```(?:(?:typescript|ts)[^\n]*)?\n([\s\S]*?)```/;
  const m = fenceRe.exec(responseText);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Dry-run: read B9 fixture (Slice 1 path)
// ---------------------------------------------------------------------------

/**
 * Load the canned Arm B response from B9's fixture for the given task.
 * B10 reads these read-only — does NOT copy or modify B9 fixtures.
 *
 * @param {string} taskId
 * @returns {{ response_text: string, source: "b9-fixture" }}
 */
function loadB9Fixture(taskId) {
  // B10 may also have its own fixtures for import-heavy tasks (Slice 2+)
  const b10FixturePath = join(BENCH_B10_ROOT, "fixtures", taskId, "arm-b-response.json");
  if (existsSync(b10FixturePath)) {
    const raw = JSON.parse(readFileSync(b10FixturePath, "utf8"));
    const responseText = raw.content?.[0]?.text ?? raw.response_text ?? raw.text ?? "";
    return { response_text: responseText, source: "b10-fixture" };
  }

  // Fall back to B9 fixture (Slice 1 smoke corpus)
  const b9FixturePath = join(BENCH_B9_ROOT, "fixtures", taskId, "arm-b-response.json");
  if (!existsSync(b9FixturePath)) {
    throw new Error(
      `No fixture found for task '${taskId}'.\n` +
      `  B10 path (S2+): ${b10FixturePath}\n` +
      `  B9 fallback:    ${b9FixturePath}`
    );
  }
  const raw = JSON.parse(readFileSync(b9FixturePath, "utf8"));
  // B9 fixture shape: { content: [{ text: "..." }], ... }
  const responseText = raw.content?.[0]?.text ?? raw.response_text ?? raw.text ?? "";
  return { response_text: responseText, source: "b9-fixture" };
}

// ---------------------------------------------------------------------------
// Live run: call Anthropic API
// ---------------------------------------------------------------------------

async function callAnthropicApi(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY env var not set. " +
      "Live Arm B run exits the B6 air-gap by design. " +
      "Use --dry-run for offline mode."
    );
  }

  // Lazy-load @anthropic-ai/sdk
  const sdkPath = join(BENCH_B10_ROOT, "node_modules", "@anthropic-ai", "sdk", "index.js");
  let AnthropicClass;
  if (existsSync(sdkPath)) {
    const mod = await import(pathToFileURL(sdkPath).href);
    AnthropicClass = (mod.default?.default ?? mod.default ?? mod).Anthropic ?? mod.default ?? mod;
  } else {
    try {
      const mod = await import("@anthropic-ai/sdk");
      AnthropicClass = mod.default ?? mod;
    } catch (_) {
      throw new Error(
        "@anthropic-ai/sdk not found. Run: npm install --prefix bench/B10-import-replacement @anthropic-ai/sdk"
      );
    }
  }

  const client = new AnthropicClass({ apiKey });
  const message = await client.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 2048,
    temperature: 1.0,
    system:     systemPrompt,
    messages:   [{ role: "user", content: userPrompt }],
  });

  const responseText = message.content?.[0]?.text ?? "";
  const inputTokens  = message.usage?.input_tokens  ?? 0;
  const outputTokens = message.usage?.output_tokens ?? 0;
  // Approximate cost: claude-sonnet-4-6 pricing
  const costUsd = (inputTokens * 3.0 / 1_000_000) + (outputTokens * 15.0 / 1_000_000);

  return { response_text: responseText, input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: costUsd };
}

// ---------------------------------------------------------------------------
// Run one Arm B rep for a task
// ---------------------------------------------------------------------------

/**
 * Run (or load) one Arm B response for a task.
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {{ signature: string, behavior: string, errorConditions?: string[] }} opts.taskSpec
 * @param {boolean} opts.dryRun
 * @param {boolean} opts.noNetwork
 * @param {string} [opts.outputDir]  - directory to write emit .mjs into
 * @param {number} [opts.rep]        - rep index (0-based), default 0
 * @returns {Promise<object>} result descriptor
 */
export async function runArmBRep({ taskId, taskSpec, dryRun, noNetwork, outputDir, rep = 0 }) {
  if (noNetwork) {
    return {
      task_id: taskId,
      rep,
      source:           "skipped",
      network_required: true,
      emit_path:        null,
      emit_text:        null,
      error:            null,
    };
  }

  const userPrompt    = buildUserPrompt(taskSpec);
  const prompt_sha256 = promptSha256(SYSTEM_PROMPT, userPrompt);

  let responseText;
  let source;
  let apiMeta = {};

  if (dryRun) {
    const fixture = loadB9Fixture(taskId);
    responseText = fixture.response_text;
    source       = fixture.source;
  } else {
    const live = await callAnthropicApi(SYSTEM_PROMPT, userPrompt);
    responseText = live.response_text;
    source       = "live-api";
    apiMeta      = {
      input_tokens:  live.input_tokens,
      output_tokens: live.output_tokens,
      cost_usd:      live.cost_usd,
    };
  }

  const emitText = extractEmitFromResponse(responseText);
  let emitPath = null;

  if (emitText && outputDir) {
    mkdirSync(outputDir, { recursive: true });
    emitPath = join(outputDir, `arm-b-rep${rep}.mjs`);
    writeFileSync(emitPath, emitText, "utf8");
  }

  // When extraction fails (and the run was not skipped), dump the raw response to a
  // tmp diagnostic file so the next investigator can inspect the exact format returned.
  // @decision DEC-B10-FENCE-DIAG-001
  // @title Write raw response to tmp diagnostic file on extract_failed
  // @status accepted
  // @rationale
  //   extract_failed is silent by default — the result records the error string but
  //   the raw LLM response is discarded, making root-cause analysis impossible without
  //   a live re-run ($0.09/re-run, zero evidence). Writing to tmp/B10-import-replacement/
  //   preserves the evidence for offline inspection without touching fixture or result
  //   files. Unix timestamp suffix prevents collisions across concurrent reps. The dump
  //   is skipped on the no-network path (responseText is undefined/empty). Dump failures
  //   are caught and warned — a tmp write error must not mask the underlying extract_failed.
  //   See: plans/wi-679-b10-fence-regex.md, #679.
  let extractFailedDumpPath = null;
  if (emitText == null && source !== "skipped") {
    try {
      const diagDir = join(REPO_ROOT, "tmp", "B10-import-replacement");
      mkdirSync(diagDir, { recursive: true });
      const ts = Date.now();
      extractFailedDumpPath = join(diagDir, `extract-failed-${taskId}-rep${rep}-${ts}.txt`);
      writeFileSync(extractFailedDumpPath, responseText, "utf8");
    } catch (dumpErr) {
      console.warn(`[llm-baseline] warn: extract_failed dump write failed: ${dumpErr.message}`);
    }
  }

  return {
    task_id:                 taskId,
    rep,
    source,
    prompt_sha256,
    emit_path:               emitPath,
    emit_text:               emitText,
    extract_failed_dump_path: extractFailedDumpPath,
    error:                   emitText == null ? "extract_failed: no ```typescript fence in response" : null,
    ...apiMeta,
  };
}

// ---------------------------------------------------------------------------
// CLI (standalone)
// ---------------------------------------------------------------------------

const { values: cliArgs } = parseArgs({
  args: process.argv.slice(2),
  options: {
    task:         { type: "string" },
    "dry-run":    { type: "boolean", default: false },
    "no-network": { type: "boolean", default: false },
    output:       { type: "string" },
    json:         { type: "boolean", default: false },
  },
  strict: false,
  allowPositionals: false,
});

const isMain = process.argv[1] &&
  (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) ||
   process.argv[1].endsWith("llm-baseline.mjs"));

if (isMain) {
  const taskId = cliArgs["task"] ?? "parse-int-list";
  // Minimal inline spec for CLI smoke use — real specs come from corpus-spec.json in run.mjs
  const FALLBACK_SPECS = {
    "parse-int-list":   { signature: "function listOfInts(input: string): readonly number[]",
                          behavior:  "Parse a comma-separated list of integers." },
    "kebab-to-camel":   { signature: "function kebabToCamel(input: string): string",
                          behavior:  "Convert kebab-case to camelCase." },
    "digits-to-sum":    { signature: "function digitsToSum(input: string): number",
                          behavior:  "Sum the digits of a non-negative integer string." },
    "even-only-filter": { signature: "function evenOnlyFilter(input: readonly number[]): readonly number[]",
                          behavior:  "Return only even integers from the array." },
    "parse-coord-pair": { signature: "function parseCoordPair(input: string): [number, number]",
                          behavior:  "Parse a coordinate pair like '1.5,2.3'." },
    "csv-row-narrow":   { signature: "function parseCsvRowNarrow(input: string): readonly string[]",
                          behavior:  "Parse a single CSV row." },
  };
  const taskSpec = FALLBACK_SPECS[taskId] ?? FALLBACK_SPECS["parse-int-list"];
  const outputDir = cliArgs["output"] ?? join(REPO_ROOT, "tmp", "B10-import-replacement", taskId);

  try {
    const result = await runArmBRep({
      taskId,
      taskSpec,
      dryRun:    cliArgs["dry-run"],
      noNetwork: cliArgs["no-network"],
      outputDir,
      rep:       0,
    });
    if (cliArgs["json"]) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      console.log(`task:         ${result.task_id}`);
      console.log(`source:       ${result.source}`);
      console.log(`emit_path:    ${result.emit_path ?? "none"}`);
      console.log(`prompt_sha:   ${result.prompt_sha256?.slice(0, 16) ?? "N/A"}...`);
      if (result.error) console.warn(`error:        ${result.error}`);
      if (result.extract_failed_dump_path) console.warn(`dump:         ${result.extract_failed_dump_path}`);
    }
  } catch (err) {
    console.error(`[llm-baseline] Fatal: ${err.message}`);
    process.exit(1);
  }
}
