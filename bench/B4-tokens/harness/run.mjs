// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/harness/run.mjs
//
// @decision DEC-BENCH-B4-HARNESS-001
// @title B4 harness: token-expenditure A/B orchestrator
// @status accepted
// @rationale
//   CAPTURE POINTS
//   Each LLM response provides:
//     output_tokens     — from response.usage.output_tokens (primary measurement)
//     input_tokens      — from response.usage.input_tokens (for context accounting)
//     inference_passes  — always 1 per call in Slice 1 (no multi-turn, no retries)
//     wall_ms           — Date.now() delta from API call start to response received
//   output_tokens is the primary metric for the B4 hypothesis (≥70% reduction Arm A vs B).
//
//   ORACLE METHODOLOGY
//   For each LLM response:
//   1. Extract TypeScript code from fenced code block in response text.
//   2. Write extracted code to a temp .ts file under tmp/B4-tokens/oracle-scratch/.
//   3. Run the task's oracle.test.ts against the temp file via vitest subprocess.
//      IMPL_PATH env var points vitest to the temp file (see oracle.test.ts imports).
//   4. semantic_equivalent = (vitest exit code 0 AND all tests passed).
//   The oracle is NEVER mocked. Real code execution is mandatory (issue #402 contract).
//
//   DRY-RUN SEMANTICS
//   When --dry-run is passed:
//   - The Anthropic API is NOT called.
//   - Canned response fixtures from bench/B4-tokens/fixtures/<task>/<arm>-response.json
//     are loaded instead. These capture real Anthropic Messages API response shapes.
//   - Telemetry capture (output_tokens, input_tokens, wall_ms) runs against fixture data.
//   - Oracle invocation runs against the code extracted from fixture responses.
//   - The aggregate + verdict logic runs normally.
//   This proves the full harness pipeline without spending API budget.
//
//   REAL-MODE
//   When run without --dry-run:
//   - ANTHROPIC_API_KEY must be set. Harness aborts with clear error if absent.
//   - Each (task × arm × rep) makes one real Anthropic Messages API call.
//   - N=3 reps per (task × arm) in Slice 1 = 18 calls minimum.
//   - arm A: claude-sonnet model + yakcc hook system-prompt enabled.
//   - arm B: same model, no hook system-prompt text.
//   This is the one benchmark in the suite that exits the B6 air-gap.
//   See README.md for B6 air-gap caveat documentation.
//
//   ARM A TOOL DECLARATION — WHY REMOVED IN SLICE 1 (issue #450 fix)
//   @decision DEC-BENCH-B4-HARNESS-002
//   @title Slice 1 must NOT declare yakccResolve as a callable tool
//   @status accepted
//   @rationale
//     The original Slice 1 implementation declared a `yakccResolve` tool in the Arm A
//     API call. The intent was to simulate hook-assisted generation using only a system
//     prompt suffix. However, declaring a tool in the Anthropic API means the model CAN
//     call it — and claude-sonnet-4-5 does call it aggressively on CSV/parsing tasks.
//     When the model issues a tool_use block (stop_reason: "tool_use"), the response has
//     no text content block. extractCode("") returns "". The oracle-scratch file has no
//     exports. All oracle tests fail with "must export parseCSV".
//
//     Root cause: Slice 1 has no real MCP server to service tool calls. The declared
//     tool is unserviceable. The model calling it produces an incomplete response.
//
//     Fix: Remove the `tools` array from Arm A's API call. The system prompt suffix
//     already communicates the yakcc hook context. Slice 1 measures "hook system prompt
//     presence vs absence" — real tool infrastructure belongs in Slice 2 when the MCP
//     server is wired (see issue #188 Slice 2 spec).
//
//     Observed failure (2026-05-13 run): Arm A reps 2 and 3 for csv-parser-quoted had
//     stop_reason=tool_use, 65-71 output tokens, 0/39 oracle tests passing. Arm A rep 1
//     (end_turn, 1036 tokens) passed 36/39. After fix, all Arm A reps should produce
//     TypeScript code directly (end_turn) with semantic_eq ≥ Arm B baseline.
//
//   WHY 3 TASKS (SLICE 1 FLOOR)
//   3 tasks provides minimum statistical surface to detect signal:
//   - Enough variance to distinguish systematic hook benefit from per-task coincidence.
//   - Covers 3 distinct implementation patterns (class, pure function, HOF).
//   - Each task has a distinct adversarial framing that stresses hook atoms differently.
//   Slice 2 scales to 5–10 tasks per #188 spec.
//
// Cross-reference:
//   DEC-BENCH-B4-CORPUS-001 (TASKS_RATIONALE.md) — per-task selection rationale
//   bench/B4-tokens/tasks.json — frozen task manifest with SHA-256 per prompt
//   bench/B4-tokens/harness/oracle-runner.mjs — code extraction + vitest invocation
//   bench/B6-airgap/ — air-gap CI gate (NOT regressed by B4; see README.md §Air-Gap)
//
// Usage:
//   node bench/B4-tokens/harness/run.mjs --dry-run
//   node bench/B4-tokens/harness/run.mjs          # requires ANTHROPIC_API_KEY
//   pnpm bench:tokens --dry-run
//   pnpm bench:tokens

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B4_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(__dirname, "../../..");

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const { values: cliArgs } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    "reps": { type: "string", default: "3" },
    "output": { type: "string" },
  },
  strict: false,
  allowPositionals: false,
});

const DRY_RUN = cliArgs["dry-run"] === true;
const N_REPS = parseInt(cliArgs["reps"] ?? "3", 10);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TASKS_JSON_PATH = join(BENCH_B4_ROOT, "tasks.json");
const ARTIFACT_DIR = join(REPO_ROOT, "tmp", "B4-tokens");
const SCRATCH_DIR = join(ARTIFACT_DIR, "oracle-scratch");
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const ARTIFACT_PATH = cliArgs["output"] ?? join(ARTIFACT_DIR, `slice1-${DRY_RUN ? "dry-" : ""}${TIMESTAMP}.json`);

// Verdict gates per #188 / issue #402
const VERDICT_PASS_STRETCH_THRESHOLD = 0.80; // >=80% reduction
const VERDICT_PASS_THRESHOLD = 0.70;          // >=70% reduction
const VERDICT_WARN_THRESHOLD = 0.40;          // 40-70% = WARN
const VERDICT_SEMANTIC_EQ_MIN = 0.90;         // <90% semantic-eq on arm A = KILL regardless

// Model configuration (same for both arms — only hook integration differs)
const MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 2048;
const TEMPERATURE = 1.0;

// System prompt for Arm B (vanilla — no hook integration)
const SYSTEM_PROMPT_VANILLA = `You are an expert TypeScript developer. When given a coding task, implement it in a single TypeScript file. Output only the implementation code in a \`\`\`typescript code block. Do not include explanation before or after the code block.`;

// Additional system prompt text for Arm A (hook-enabled).
// Represents the context injected by the yakcc hook layer.
// Slice 1 measures system-prompt presence only — no real MCP tool is declared.
// Slice 2 will wire real MCP tool calls when the MCP server is ready (issue #188).
//
// NOTE (issue #450): The previous version declared a real `yakccResolve` Anthropic
// tool here. This caused the model to call the tool (stop_reason=tool_use), producing
// no code output and failing all oracle tests. Removed — see DEC-BENCH-B4-HARNESS-002.
const SYSTEM_PROMPT_HOOK_SUFFIX = `

You are working in a codebase that uses the yakcc registry for common atomic implementations. When implementing code, prefer token-efficient implementations that compose proven patterns (state machines, data structures, parsing primitives) rather than verbose from-scratch approaches. Output only the implementation code in a \`\`\`typescript code block.`;

// ---------------------------------------------------------------------------
// Task manifest loading and SHA-256 verification
// ---------------------------------------------------------------------------

function loadAndVerifyTasks() {
  console.log("[B4] Loading and verifying task manifest...");

  if (!existsSync(TASKS_JSON_PATH)) {
    throw new Error(`tasks.json not found at ${TASKS_JSON_PATH}`);
  }

  const manifest = JSON.parse(readFileSync(TASKS_JSON_PATH, "utf8"));

  for (const task of manifest.tasks) {
    const promptPath = join(BENCH_B4_ROOT, task.prompt_file);
    if (!existsSync(promptPath)) {
      throw new Error(`Task prompt not found: ${promptPath}`);
    }

    // SHA-256 verification — mirrors B7/B6 discipline
    // Try raw bytes first, then LF-normalized (handles Windows CRLF git checkout)
    const rawBytes = readFileSync(promptPath);
    const actualRaw = createHash("sha256").update(rawBytes).digest("hex");
    let actual = actualRaw;

    if (actual !== task.sha256) {
      const lfBytes = Buffer.from(rawBytes.toString("binary").replace(/\r\n/g, "\n"), "binary");
      const actualLf = createHash("sha256").update(lfBytes).digest("hex");
      if (actualLf === task.sha256) {
        actual = actualLf; // CRLF expansion — content is identical
      }
    }

    if (actual !== task.sha256) {
      throw new Error(
        `SHA-256 drift detected for ${task.prompt_file}:\n` +
        `  expected: ${task.sha256}\n` +
        `  actual:   ${actualRaw}\n` +
        "Task prompt has changed. Regenerate tasks.json with updated hashes before running."
      );
    }

    console.log(`  [OK] ${task.id} — sha256=${actual.slice(0, 16)}...`);
  }

  console.log(`[B4] Task manifest OK — ${manifest.tasks.length} tasks verified.\n`);
  return manifest;
}

// ---------------------------------------------------------------------------
// Fixture loading (dry-run mode)
// ---------------------------------------------------------------------------

function loadFixture(taskId, arm) {
  const fixturePath = join(BENCH_B4_ROOT, "fixtures", taskId, `arm-${arm.toLowerCase()}-response.json`);
  if (!existsSync(fixturePath)) {
    throw new Error(
      `Dry-run fixture not found: ${fixturePath}\n` +
      `Expected fixture at bench/B4-tokens/fixtures/${taskId}/arm-${arm.toLowerCase()}-response.json`
    );
  }
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  return fixture;
}

// ---------------------------------------------------------------------------
// Real API call (requires ANTHROPIC_API_KEY)
// ---------------------------------------------------------------------------

async function callAnthropicAPI(taskId, taskManifest, arm) {
  // Guard: real mode requires API key
  if (!process.env["ANTHROPIC_API_KEY"]) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is not set.\n" +
      "Real-run mode requires an API key. To run without API calls, use --dry-run.\n" +
      "Example: pnpm bench:tokens --dry-run"
    );
  }

  const promptPath = join(BENCH_B4_ROOT, taskManifest.prompt_file);
  const promptText = readFileSync(promptPath, "utf8");

  // Lazy import Anthropic SDK (only in real mode)
  // The SDK is bench-local dep in bench/B4-tokens/package.json
  let Anthropic;
  const sdkPath = join(BENCH_B4_ROOT, "node_modules", "@anthropic-ai", "sdk", "dist", "index.mjs");
  const sdkPathCjs = join(BENCH_B4_ROOT, "node_modules", "@anthropic-ai", "sdk", "dist", "index.js");

  if (existsSync(sdkPath)) {
    const mod = await import(new URL(`file://${sdkPath}`).href);
    Anthropic = mod.default ?? mod.Anthropic;
  } else if (existsSync(sdkPathCjs)) {
    const mod = await import(new URL(`file://${sdkPathCjs}`).href);
    Anthropic = mod.default ?? mod.Anthropic;
  } else {
    // Try workspace-resolved import (if running via pnpm in workspace context)
    try {
      const mod = await import("@anthropic-ai/sdk");
      Anthropic = mod.default ?? mod.Anthropic;
    } catch (_) {
      throw new Error(
        "Could not load @anthropic-ai/sdk. Run `pnpm --dir bench/B4-tokens install` first."
      );
    }
  }

  const client = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });

  const systemPrompt = arm === "A"
    ? SYSTEM_PROMPT_VANILLA + SYSTEM_PROMPT_HOOK_SUFFIX
    : SYSTEM_PROMPT_VANILLA;

  // Slice 1: No tool declarations. Arm A vs B difference is system-prompt text only.
  // Slice 2 will add real yakccResolve tool with MCP server wiring (issue #188).
  // See DEC-BENCH-B4-HARNESS-002 for why declaring tools in Slice 1 caused semantic_eq=0.

  const t0 = Date.now();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: promptText,
      },
    ],
  });
  const wallMs = Date.now() - t0;

  // Defensive: if the model calls a tool despite no tool declaration, warn loudly.
  // This should not happen in Slice 1 (no tools declared), but is a belt-and-suspenders
  // guard for future Slice 2 integration when tools are re-introduced.
  if (response.stop_reason === "tool_use") {
    console.warn(
      `  [WARN] ${arm} got stop_reason=tool_use despite no tool declaration. ` +
      "This indicates a harness configuration error. The code extraction will produce " +
      "an empty file and oracle will fail. Check DEC-BENCH-B4-HARNESS-002 in run.mjs."
    );
  }

  return { response, wallMs };
}

// ---------------------------------------------------------------------------
// Response processing: extract telemetry
// ---------------------------------------------------------------------------

function extractTelemetry(response, wallMs) {
  const usage = response.usage ?? {};
  return {
    output_tokens: usage.output_tokens ?? 0,
    input_tokens: usage.input_tokens ?? 0,
    inference_passes: 1, // Slice 1: single-turn, no retries
    wall_ms: wallMs,
    model: response.model ?? MODEL,
    stop_reason: response.stop_reason ?? "unknown",
  };
}

function extractResponseText(response) {
  const content = response.content ?? [];
  const textBlock = content.find((c) => c.type === "text");
  return textBlock?.text ?? "";
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  const variance = arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

// ---------------------------------------------------------------------------
// Verdict computation (per #188 / issue #402)
// ---------------------------------------------------------------------------

function computeVerdict(meanReductionPct, meanSemanticEqA) {
  // KILL conditions
  if (meanSemanticEqA < VERDICT_SEMANTIC_EQ_MIN) {
    return {
      string: "KILL",
      reason: `semantic_eq_A (${(meanSemanticEqA * 100).toFixed(1)}%) < ${(VERDICT_SEMANTIC_EQ_MIN * 100).toFixed(0)}% threshold`,
    };
  }
  if (meanReductionPct < VERDICT_WARN_THRESHOLD) {
    return {
      string: "KILL",
      reason: `mean_reduction_pct (${(meanReductionPct * 100).toFixed(1)}%) < ${(VERDICT_WARN_THRESHOLD * 100).toFixed(0)}%`,
    };
  }
  if (meanReductionPct >= VERDICT_PASS_STRETCH_THRESHOLD) {
    return { string: "PASS-stretch", reason: `mean_reduction_pct ${(meanReductionPct * 100).toFixed(1)}% >= ${(VERDICT_PASS_STRETCH_THRESHOLD * 100).toFixed(0)}%` };
  }
  if (meanReductionPct >= VERDICT_PASS_THRESHOLD) {
    return { string: "PASS", reason: `mean_reduction_pct ${(meanReductionPct * 100).toFixed(1)}% >= ${(VERDICT_PASS_THRESHOLD * 100).toFixed(0)}%` };
  }
  return {
    string: "WARN",
    reason: `mean_reduction_pct ${(meanReductionPct * 100).toFixed(1)}% in [${(VERDICT_WARN_THRESHOLD * 100).toFixed(0)}%, ${(VERDICT_PASS_THRESHOLD * 100).toFixed(0)}%)`,
  };
}

// ---------------------------------------------------------------------------
// Single arm run (one task, one arm, N reps)
// ---------------------------------------------------------------------------

async function runArm(task, arm, nReps, dryRun) {
  const results = [];

  for (let rep = 1; rep <= nReps; rep++) {
    console.log(`  [${arm}] ${task.id} rep ${rep}/${nReps}...`);

    let response;
    let wallMs;

    if (dryRun) {
      // Load canned fixture
      const fixture = loadFixture(task.id, arm);
      response = fixture;
      // Simulate wall_ms from fixture (deterministic for dry-run)
      wallMs = arm === "A" ? 1200 + rep * 50 : 2800 + rep * 80;
    } else {
      // Real API call
      const result = await callAnthropicAPI(task.id, task, arm);
      response = result.response;
      wallMs = result.wallMs;
    }

    const telemetry = extractTelemetry(response, wallMs);
    const responseText = extractResponseText(response);

    // Extract code and run oracle
    const { extractCode, runOracle } = await import(
      new URL("file://" + join(__dirname, "oracle-runner.mjs")).href
    );
    const generatedCode = extractCode(responseText);

    console.log(`    Extracted ${generatedCode.length} chars of code. Running oracle...`);

    const oracleResult = await runOracle(task.id, generatedCode, {
      scratchDir: SCRATCH_DIR,
    });

    console.log(
      `    Oracle: ${oracleResult.semantic_equivalent ? "PASS" : "FAIL"} ` +
      `(${oracleResult.passed}/${oracleResult.total} tests passed)`
    );

    results.push({
      rep,
      arm,
      task_id: task.id,
      telemetry,
      oracle: oracleResult,
      dry_run: dryRun,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main harness
// ---------------------------------------------------------------------------

async function main() {
  const runStart = Date.now();

  console.log("=".repeat(70));
  console.log("B4-tokens — Slice 1: Token-Expenditure A/B Harness");
  console.log(`  Mode: ${DRY_RUN ? "DRY-RUN (canned fixtures, no API calls)" : "REAL (API calls required)"}`);
  console.log(`  N=${N_REPS} reps per (task × arm) | 3 tasks | ${3 * 2 * N_REPS} total calls`);
  console.log("=".repeat(70));
  console.log();

  // Real-mode guard: abort early with clear error if no API key
  if (!DRY_RUN && !process.env["ANTHROPIC_API_KEY"]) {
    console.error(
      "\n" + "!".repeat(70) + "\n" +
      "ERROR: ANTHROPIC_API_KEY is not set.\n\n" +
      "Real-run mode requires an Anthropic API key to make LLM calls.\n" +
      "This will incur API costs (18+ calls at claude-sonnet-4-5 pricing).\n\n" +
      "Options:\n" +
      "  1. Set ANTHROPIC_API_KEY and re-run for real A/B measurement (Slice 2)\n" +
      "  2. Run with --dry-run to validate the harness without API calls:\n" +
      "       pnpm bench:tokens --dry-run\n" +
      "!".repeat(70) + "\n"
    );
    process.exit(1);
  }

  // Step 0: Verify task manifest SHA-256 integrity
  const manifest = loadAndVerifyTasks();
  const tasks = manifest.tasks;

  // Step 1: Prepare output directories
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  mkdirSync(SCRATCH_DIR, { recursive: true });

  // Step 2: Run A/B for each task
  const allResults = [];
  const perTaskSummaries = [];

  for (const task of tasks) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`Task: ${task.id}`);
    console.log("─".repeat(70));

    const armAResults = await runArm(task, "A", N_REPS, DRY_RUN);
    const armBResults = await runArm(task, "B", N_REPS, DRY_RUN);

    allResults.push(...armAResults, ...armBResults);

    // Aggregate per task
    const armAOutputTokens = armAResults.map((r) => r.telemetry.output_tokens);
    const armBOutputTokens = armBResults.map((r) => r.telemetry.output_tokens);
    const armASemanticEq = armAResults.map((r) => r.oracle.semantic_equivalent ? 1 : 0);
    const armBSemanticEq = armBResults.map((r) => r.oracle.semantic_equivalent ? 1 : 0);
    const armAWallMs = armAResults.map((r) => r.telemetry.wall_ms);
    const armBWallMs = armBResults.map((r) => r.telemetry.wall_ms);

    const meanATokens = mean(armAOutputTokens);
    const meanBTokens = mean(armBOutputTokens);
    const reductionPct = meanBTokens > 0 ? (meanBTokens - meanATokens) / meanBTokens : 0;

    const summary = {
      task_id: task.id,
      arm_A: {
        mean_output_tokens: meanATokens,
        std_output_tokens: stddev(armAOutputTokens),
        mean_semantic_eq_rate: mean(armASemanticEq),
        mean_wall_ms: mean(armAWallMs),
        reps: armAResults.length,
      },
      arm_B: {
        mean_output_tokens: meanBTokens,
        std_output_tokens: stddev(armBOutputTokens),
        mean_semantic_eq_rate: mean(armBSemanticEq),
        mean_wall_ms: mean(armBWallMs),
        reps: armBResults.length,
      },
      reduction_pct: reductionPct,
    };

    perTaskSummaries.push(summary);

    console.log(`\n  [${task.id}] A/B Summary:`);
    console.log(`    Arm A: mean_output_tokens=${meanATokens.toFixed(1)} std=${stddev(armAOutputTokens).toFixed(1)}`);
    console.log(`    Arm B: mean_output_tokens=${meanBTokens.toFixed(1)} std=${stddev(armBOutputTokens).toFixed(1)}`);
    console.log(`    reduction_pct: ${(reductionPct * 100).toFixed(1)}%`);
    console.log(`    semantic_eq A: ${(mean(armASemanticEq) * 100).toFixed(0)}%  B: ${(mean(armBSemanticEq) * 100).toFixed(0)}%`);
  }

  // Step 3: Aggregate across tasks
  const meanReductionPct = mean(perTaskSummaries.map((s) => s.reduction_pct));
  const meanSemanticEqA = mean(perTaskSummaries.map((s) => s.arm_A.mean_semantic_eq_rate));
  const meanSemanticEqB = mean(perTaskSummaries.map((s) => s.arm_B.mean_semantic_eq_rate));

  const verdictResult = computeVerdict(meanReductionPct, meanSemanticEqA);

  const aggregate = {
    mean_reduction_pct: meanReductionPct,
    mean_semantic_eq_A: meanSemanticEqA,
    mean_semantic_eq_B: meanSemanticEqB,
    verdict: verdictResult.string,
    verdict_reason: verdictResult.reason,
    n_tasks: tasks.length,
    n_reps_per_arm: N_REPS,
    total_calls: allResults.length,
  };

  const runEnd = Date.now();
  const totalRuntimeMs = runEnd - runStart;

  // Step 4: Print summary
  console.log("\n" + "=".repeat(70));
  console.log("AGGREGATE RESULTS");
  console.log("=".repeat(70));
  console.log();
  console.log(`Mode:               ${DRY_RUN ? "DRY-RUN" : "REAL"}`);
  console.log(`Tasks:              ${tasks.length}`);
  console.log(`Reps per arm:       ${N_REPS}`);
  console.log(`Total measurements: ${allResults.length}`);
  console.log(`Total runtime:      ${(totalRuntimeMs / 1000).toFixed(1)}s`);
  console.log();
  console.log("Per-task reduction:");
  for (const s of perTaskSummaries) {
    console.log(
      `  ${s.task_id.padEnd(30)} A=${s.arm_A.mean_output_tokens.toFixed(0).padStart(5)} tok  ` +
      `B=${s.arm_B.mean_output_tokens.toFixed(0).padStart(5)} tok  ` +
      `reduction=${(s.reduction_pct * 100).toFixed(1).padStart(6)}%  ` +
      `semantic_eq_A=${(s.arm_A.mean_semantic_eq_rate * 100).toFixed(0)}%`
    );
  }
  console.log();
  console.log(`mean_reduction_pct:  ${(meanReductionPct * 100).toFixed(1)}%`);
  console.log(`mean_semantic_eq_A:  ${(meanSemanticEqA * 100).toFixed(1)}%`);
  console.log(`mean_semantic_eq_B:  ${(meanSemanticEqB * 100).toFixed(1)}%`);
  console.log();
  console.log(`VERDICT: ${verdictResult.string}`);
  console.log(`  Reason: ${verdictResult.reason}`);
  console.log();

  if (DRY_RUN) {
    console.log("NOTE: This was a DRY-RUN. Token counts are from canned fixtures, not real LLM calls.");
    console.log("      The reduction % and verdict are illustrative, not empirical.");
    console.log("      Run without --dry-run (with ANTHROPIC_API_KEY) for real A/B measurement.");
    console.log();
  }

  // Step 5: Write artifact
  const artifact = {
    benchmark: "B4-tokens-slice1",
    version: "1.0.0",
    environment: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      runAt: new Date().toISOString(),
      repoRoot: REPO_ROOT,
      dryRun: DRY_RUN,
    },
    config: {
      model: MODEL,
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      nReps: N_REPS,
      nTasks: tasks.length,
      verdictGates: {
        passStretch: VERDICT_PASS_STRETCH_THRESHOLD,
        pass: VERDICT_PASS_THRESHOLD,
        warn: VERDICT_WARN_THRESHOLD,
        semanticEqMin: VERDICT_SEMANTIC_EQ_MIN,
      },
    },
    tasks: perTaskSummaries,
    aggregate,
    measurements: allResults,
    totalRuntimeMs,
  };

  writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2), "utf8");
  console.log(`Artifact written to: ${ARTIFACT_PATH}`);

  console.log("[B4] Done.");
}

main().catch((err) => {
  console.error("[B4] Fatal error:", err);
  process.exit(1);
});
