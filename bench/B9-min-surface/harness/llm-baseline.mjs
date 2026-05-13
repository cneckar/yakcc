// SPDX-License-Identifier: MIT
//
// bench/B9-min-surface/harness/llm-baseline.mjs
//
// @decision DEC-V0-MIN-SURFACE-003
// @title Arm B prompt template — locked verbatim; frozen at this DEC
// @status accepted
// @rationale
//   PROMPT IS EXPERIMENTAL APPARATUS
//   A change to wording — even a word like "carefully" or "robust" — measurably
//   shifts what the model emits and how big its surface is. B4 learned this; B9
//   reuses B4's exact vanilla system prompt for cross-benchmark comparability.
//   Temperature=1.0 matches B4: we measure the distribution, not a deterministic best.
//
//   LOCKED SYSTEM PROMPT (verbatim from B4's frozen vanilla prompt — re-used for
//   cross-bench comparability):
//   "You are an expert TypeScript developer. When given a coding task, implement it
//   in a single TypeScript file. Output only the implementation code in a
//   ```typescript code block. Do not include explanation before or after the code block."
//
//   LOCKED USER PROMPT TEMPLATE:
//   "Implement a TypeScript function with this signature: function listOfInts(input: string): readonly number[]\n\n
//   Behavior:\n{behavior}\n\nError conditions:\n{error_conditions_numbered}\n\n
//   Throw appropriate Error subclasses (SyntaxError or RangeError) for invalid input."
//
//   Where behavior = spec.yak behavior field,
//   error_conditions_numbered = spec.yak errorConditions[*].description rendered as
//   numbered list.
//
//   PROMPT SHA256 (combined system+user for parse-int-list):
//   75137b6a1812bb493ca925ff8275e2328f48515be499708b9e6c659254ffc0d5
//   Recorded in corpus-spec.json. Harness verifies on startup.
//
//   MODEL: claude-sonnet-4-6 (updated from 4-5; locked at suite amendment 2026-05-13)
//   SAMPLING: max_tokens=2048, temperature=1.0
//   N REPS: 3 per task per DEC (amended per #446 Gap 7 — "Anthropic API does not currently
//   expose seed; therefore raise N=3 per arm in Slice 1 and report median + range.
//   Single-point measurements are explicitly rejected.")
//
//   DRY-RUN PATH:
//   --dry-run loads bench/B9-min-surface/fixtures/parse-int-list/arm-b-response.json
//   (a canned Anthropic response). Mirrors B4 dry-run discipline. CI can run without
//   burning API budget. Dry-run fixture provenance is documented in the fixture file.
//
//   REAL-RUN MODE:
//   Requires ANTHROPIC_API_KEY env var. Harness aborts with clear error if absent.
//   This run exits the B6 air-gap by design — documented in bench/B9-min-surface/README.md.
//
//   CROSS-REFERENCES:
//   DEC-BENCH-B4-HARNESS-001 (B4's vanilla prompt — re-used verbatim here)
//   bench/B4-tokens/harness/run.mjs (precedent dry-run + fingerprint discipline)
//
//   PROMPT FINGERPRINT VERIFICATION:
//   The harness computes sha256 over the full combined prompt (system + "\n\n" + user)
//   and verifies it matches corpus-spec.json prompt_sha256. Drift => hard abort.
//
// Usage:
//   node bench/B9-min-surface/harness/llm-baseline.mjs \
//     [--task parse-int-list] \
//     [--dry-run] \
//     [--output <path>]
//   Writes emitted TypeScript to <output> (default: tmp/B9-min-surface/arm-b-emit.ts)
//   Prints JSON: { source_of: 'fixture'|'live-api', emit_path, prompt_sha256, model, ... }

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B9_ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: cliArgs } = parseArgs({
  args: process.argv.slice(2),
  options: {
    task: { type: "string", default: "parse-int-list" },
    "dry-run": { type: "boolean", default: false },
    output: { type: "string" },
    json: { type: "boolean", default: false },
    reps: { type: "string", default: "3" },
  },
  strict: false,
  allowPositionals: false,
});

const TASK_ID = cliArgs["task"] ?? "parse-int-list";
const DRY_RUN = cliArgs["dry-run"] === true;
const JSON_ONLY = cliArgs["json"] === true;
const N_REPS = parseInt(cliArgs["reps"] ?? "3", 10);

// ---------------------------------------------------------------------------
// Locked prompts (DEC-V0-MIN-SURFACE-003 — do not modify without updating sha256)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert TypeScript developer. When given a coding task, implement it in a single TypeScript file. Output only the implementation code in a \`\`\`typescript code block. Do not include explanation before or after the code block.`;

// Per DEC-V0-MIN-SURFACE-003, the user prompt for parse-int-list is derived from
// the spec.yak behavior + errorConditions fields. These are locked via sha256.
const TASK_PROMPTS = {
  "parse-int-list": {
    signature: "function listOfInts(input: string): readonly number[]",
    behavior: "Parse a string of the form '[i1,i2,...,iN]' where each element is a non-negative decimal integer. Surrounding whitespace around elements is allowed. Returns the parsed numbers as a readonly array. Throws SyntaxError on malformed input and RangeError on non-ASCII input.",
    error_conditions: [
      "Input does not start with '['. (SyntaxError)",
      "Input contains non-ASCII characters. (RangeError)",
      "List elements are not valid non-negative integers. (SyntaxError)",
      "Trailing characters after closing ']'. (SyntaxError)",
      "Input ends before closing ']'. (SyntaxError)",
    ],
  },
  "parse-coord-pair": {
    signature: "function parseCoordPair(input: string): readonly [number, number]",
    behavior: "Parse a string of the form '(x,y)' where x and y are non-negative decimal integers. Returns a readonly tuple [x, y]. Throws SyntaxError on malformed input and RangeError on non-ASCII input.",
    error_conditions: [
      "Input does not start with '('. (SyntaxError)",
      "Input contains non-ASCII characters. (RangeError)",
      "Coordinate values are not valid non-negative integers. (SyntaxError)",
      "Missing comma separator between coordinates. (SyntaxError)",
      "Input does not end with ')'. (SyntaxError)",
      "Trailing characters after closing ')'. (SyntaxError)",
    ],
  },
  "csv-row-narrow": {
    signature: "function parseCsvRowNarrow(input: string): readonly [string, string, string]",
    behavior: "Parse a CSV row with exactly 3 unquoted fields separated by commas. Fields may contain only ASCII printable characters (codes 32-126) and no commas. Returns a readonly 3-tuple of the field strings (trimmed of surrounding whitespace). Throws SyntaxError on wrong number of fields or disallowed characters, and RangeError on non-ASCII input.",
    error_conditions: [
      "Input contains non-ASCII characters (code > 127). (RangeError)",
      "Input does not contain exactly 2 commas (not exactly 3 fields). (SyntaxError)",
      "Input contains control characters (code < 32). (SyntaxError)",
    ],
  },
  "kebab-to-camel": {
    signature: "function kebabToCamel(input: string): string",
    behavior: "Convert a kebab-case string to camelCase. The input must match /^[a-z]+(-[a-z]+)*$/. Returns the camelCase equivalent (e.g., 'foo-bar-baz' becomes 'fooBarBaz'). Throws SyntaxError for inputs that do not match the pattern.",
    error_conditions: [
      "Input is empty. (SyntaxError)",
      "Input contains characters outside [a-z-]. (SyntaxError)",
      "Input starts or ends with a hyphen. (SyntaxError)",
      "Input contains consecutive hyphens. (SyntaxError)",
    ],
  },
  "digits-to-sum": {
    signature: "function digitsToSum(input: string): number",
    behavior: "Sum the digits of a non-empty string of decimal digits. The input must match /^\\d+$/. Returns the sum of all digit characters as a number (e.g., '123' returns 6). Throws SyntaxError for non-digit input.",
    error_conditions: [
      "Input is empty. (SyntaxError)",
      "Input contains non-digit characters (anything outside 0-9). (SyntaxError)",
      "Input contains non-ASCII characters. (SyntaxError)",
    ],
  },
  "even-only-filter": {
    signature: "function evenOnlyFilter(input: readonly number[]): readonly number[]",
    behavior: "Filter a readonly array of numbers to return only the even integers, in order. The input must be a readonly array of numbers, each of which must be a safe integer (Number.isSafeInteger). Maximum input length is 256 elements. Returns a readonly array containing only the even elements.",
    error_conditions: [
      "Input array exceeds 256 elements. (RangeError)",
      "Any element is not a safe integer (NaN, Infinity, float, too large). (TypeError)",
    ],
  },
};

function buildUserPrompt(task) {
  const def = TASK_PROMPTS[task];
  if (!def) throw new Error(`Unknown task: ${task}`);
  const errorList = def.error_conditions.map((e, i) => `${i + 1}. ${e}`).join("\n");
  return (
    `Implement a TypeScript function with this signature: ${def.signature}\n\n` +
    `Behavior:\n${def.behavior}\n\n` +
    `Error conditions:\n${errorList}\n\n` +
    `Throw appropriate Error subclasses (SyntaxError or RangeError) for invalid input.`
  );
}

// ---------------------------------------------------------------------------
// Prompt sha256 verification
// ---------------------------------------------------------------------------

const EXPECTED_PROMPT_SHA256 = "75137b6a1812bb493ca925ff8275e2328f48515be499708b9e6c659254ffc0d5";

function verifyPromptSha256(systemPrompt, userPrompt) {
  const combined = systemPrompt + "\n\n" + userPrompt;
  const actual = createHash("sha256").update(combined, "utf8").digest("hex");
  if (actual !== EXPECTED_PROMPT_SHA256) {
    throw new Error(
      `Prompt sha256 drift detected!\n` +
      `  expected: ${EXPECTED_PROMPT_SHA256}\n` +
      `  actual:   ${actual}\n` +
      "The Arm B prompt template has changed. Per DEC-V0-MIN-SURFACE-003, the prompt is\n" +
      "locked verbatim. Update the sha256 in corpus-spec.json AND this file if you\n" +
      "intentionally changed the prompt, and document the reason in a new DEC entry."
    );
  }
  return actual;
}

// ---------------------------------------------------------------------------
// Code extraction from LLM response (mirrors B4 pattern)
// ---------------------------------------------------------------------------

function extractCode(responseText) {
  // Match ```typescript...``` or ```ts...``` blocks
  const fenced = responseText.match(/```(?:typescript|ts)\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  // Fallback: strip markdown and return raw text
  return responseText.trim();
}

// ---------------------------------------------------------------------------
// Fixture loading (dry-run mode)
// ---------------------------------------------------------------------------

function loadFixture(taskId) {
  const fixturePath = join(BENCH_B9_ROOT, "fixtures", taskId, "arm-b-response.json");
  if (!existsSync(fixturePath)) {
    throw new Error(
      `Dry-run fixture not found: ${fixturePath}\n` +
      `Expected fixture at bench/B9-min-surface/fixtures/${taskId}/arm-b-response.json\n` +
      `The fixture is a canned Anthropic Messages API response for the locked Arm B prompt.`
    );
  }
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  return fixture;
}

// ---------------------------------------------------------------------------
// Real API call
// ---------------------------------------------------------------------------

async function callAnthropicAPI(systemPrompt, userPrompt) {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is not set.\n" +
      "Real-run mode requires an Anthropic API key.\n" +
      "To run without API calls: --dry-run\n" +
      "See bench/B9-min-surface/README.md §API Key for env-var injection pattern."
    );
  }

  // Lazy import Anthropic SDK (bench-local dep)
  let Anthropic;
  const localSdkPaths = [
    join(BENCH_B9_ROOT, "node_modules", "@anthropic-ai", "sdk", "dist", "index.mjs"),
    join(BENCH_B9_ROOT, "node_modules", "@anthropic-ai", "sdk", "dist", "index.js"),
  ];

  for (const p of localSdkPaths) {
    if (existsSync(p)) {
      const mod = await import(pathToFileURL(p).href);
      Anthropic = mod.default ?? mod.Anthropic;
      break;
    }
  }

  if (!Anthropic) {
    try {
      const mod = await import("@anthropic-ai/sdk");
      Anthropic = mod.default ?? mod.Anthropic;
    } catch (_) {
      throw new Error(
        "Could not load @anthropic-ai/sdk. Run: pnpm --dir bench/B9-min-surface install"
      );
    }
  }

  const client = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });

  const t0 = Date.now();
  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 2048,
    temperature: 1.0,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const wallMs = Date.now() - t0;

  return { response, wallMs };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function getLlmBaselineRep({ taskId, dryRun, outputPath, repIndex = 0 } = {}) {
  const _taskId = taskId ?? TASK_ID;
  const _dryRun = dryRun ?? DRY_RUN;

  const userPrompt = buildUserPrompt(_taskId);

  // Verify sha256 only for parse-int-list (locked task)
  let promptSha256 = null;
  if (_taskId === "parse-int-list") {
    promptSha256 = verifyPromptSha256(SYSTEM_PROMPT, userPrompt);
  }

  let responseData;
  let wallMs = 0;
  let sourceOf;

  if (_dryRun) {
    responseData = loadFixture(_taskId);
    sourceOf = "fixture";
    wallMs = 0;
  } else {
    const result = await callAnthropicAPI(SYSTEM_PROMPT, userPrompt);
    responseData = result.response;
    wallMs = result.wallMs;
    sourceOf = "live-api";
  }

  // Extract code
  const content = responseData.content ?? [];
  const textBlock = content.find((c) => c.type === "text");
  const responseText = textBlock?.text ?? "";
  const emittedCode = extractCode(responseText);

  // Write to output path — include rep index in filename to avoid overwrites
  const REPO_ROOT = resolve(BENCH_B9_ROOT, "..", "..");
  const repSuffix = repIndex > 0 ? `-rep${repIndex}` : "";
  const defaultOutputPath = join(REPO_ROOT, "tmp", "B9-min-surface", `arm-b-${_taskId}${repSuffix}.ts`);
  const _outputPath = outputPath ?? (cliArgs["output"] ? cliArgs["output"].replace(".ts", `${repSuffix}.ts`) : defaultOutputPath);

  mkdirSync(dirname(_outputPath), { recursive: true });
  writeFileSync(_outputPath, emittedCode, "utf8");

  return {
    source_of: sourceOf,
    task_id: _taskId,
    rep_index: repIndex,
    emit_path: _outputPath,
    prompt_sha256: promptSha256,
    model: responseData.model ?? "claude-sonnet-4-6",
    wall_ms: wallMs,
    usage: responseData.usage ?? null,
    stop_reason: responseData.stop_reason ?? "unknown",
    emit_length_bytes: Buffer.byteLength(emittedCode, "utf8"),
    emit_loc: emittedCode.split("\n").length,
    dry_run: _dryRun,
  };
}

/**
 * Get N reps of Arm B baseline for a task. Returns array of N rep results.
 * In dry-run mode, N=1 (fixture is used once; multiple reps would be identical).
 * In live mode, N reps are run sequentially to avoid API throttling.
 *
 * Per DEC-V0-MIN-SURFACE-003: N=3 per task in Slice 1. Single-point measurements rejected.
 */
async function getLlmBaseline({ taskId, dryRun, outputPath, nReps } = {}) {
  const _dryRun = dryRun ?? DRY_RUN;
  const _nReps = _dryRun ? 1 : (nReps ?? N_REPS); // dry-run: 1 rep (fixture is deterministic)

  const reps = [];
  for (let i = 0; i < _nReps; i++) {
    const rep = await getLlmBaselineRep({ taskId, dryRun: _dryRun, outputPath, repIndex: i });
    reps.push(rep);
  }

  // Aggregate N reps: compute median + range for usage and wall_ms
  const wallMsList = reps.map(r => r.wall_ms).filter(v => v > 0);
  const sortedWall = [...wallMsList].sort((a, b) => a - b);
  const medianWall = sortedWall.length > 0
    ? sortedWall[Math.floor(sortedWall.length / 2)]
    : 0;

  return {
    task_id: reps[0].task_id,
    n_reps: _nReps,
    dry_run: _dryRun,
    reps,
    median_wall_ms: medianWall,
    wall_ms_range: sortedWall.length > 0 ? [sortedWall[0], sortedWall[sortedWall.length - 1]] : null,
    // For backward compat: expose last rep's emit_path as the primary emit path
    emit_path: reps[reps.length - 1].emit_path,
    source_of: reps[0].source_of,
    model: reps[0].model,
    prompt_sha256: reps[0].prompt_sha256,
    // All reps for downstream consumers (classify-arm-b.mjs, measure-axis5.mjs)
    all_reps: reps,
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main() {
  if (!JSON_ONLY) {
    console.log("=== Arm B: LLM Baseline ===");
    console.log(`  task: ${TASK_ID}`);
    console.log(`  mode: ${DRY_RUN ? "DRY-RUN (fixture)" : "LIVE API"}`);
    console.log(`  n_reps: ${DRY_RUN ? "1 (fixture is deterministic)" : N_REPS}`);
    if (!DRY_RUN) {
      console.log("  NOTE: This run exits the B6 air-gap by design. See README.md §Air-Gap.");
    }
    console.log();
  }

  const result = await getLlmBaseline();

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    console.log(`  source_of: ${result.source_of}`);
    console.log(`  n_reps: ${result.n_reps}`);
    console.log(`  emit_path (last rep): ${result.emit_path}`);
    console.log(`  prompt_sha256: ${result.prompt_sha256 ?? "N/A (non-fingerprinted task)"}`);
    if (result.median_wall_ms > 0) {
      console.log(`  median_wall_ms: ${result.median_wall_ms}`);
    }
    for (let i = 0; i < result.reps.length; i++) {
      const rep = result.reps[i];
      console.log(`  rep[${i}]: loc=${rep.emit_loc} bytes=${rep.emit_length_bytes} wall_ms=${rep.wall_ms}`);
    }
    console.log();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }

  return result;
}

// Export for use by run.mjs
export { getLlmBaseline };

// Run standalone if executed directly
const isMain = process.argv[1] &&
  (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) ||
   process.argv[1].endsWith("llm-baseline.mjs"));
if (isMain) {
  main().catch((err) => {
    console.error("[llm-baseline] Fatal:", err.message);
    process.exit(1);
  });
}
