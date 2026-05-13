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
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B4_ROOT = resolve(__dirname, "..");

// REPO_ROOT: find the main git repository root (not a worktree root) by looking
// for a directory named ".git" (worktrees have a .git FILE, not a directory).
// This correctly handles both main repo and feature worktree invocations.
import { statSync } from "node:fs";

function findRepoRootSync(startDir) {
  let current = startDir;
  for (let i = 0; i < 12; i++) {
    const gitPath = join(current, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isDirectory()) {
          // This is the main git repo (not a worktree)
          return current;
        }
        // .git is a file (worktree) — keep walking up
      } catch (_) {}
    }
    const parent = resolve(current, "..");
    if (parent === current) break; // filesystem root
    current = parent;
  }
  // Fallback: ../../.. from harness dir
  return resolve(startDir, "../../..");
}

const REPO_ROOT = findRepoRootSync(__dirname);

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const { values: cliArgs } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    "no-network": { type: "boolean", default: false },
    "mcp": { type: "boolean", default: false },
    "reps": { type: "string", default: "3" },
    "output": { type: "string" },
  },
  strict: false,
  allowPositionals: false,
});

const DRY_RUN = cliArgs["dry-run"] === true;
const NO_NETWORK = cliArgs["no-network"] === true;
const N_REPS = parseInt(cliArgs["reps"] ?? "3", 10);

// MCP_ENABLED: when true, Arm A uses the real MCP atom-lookup tool instead of
// the system-prompt-suffix-only approach from Slice 1. Enables substitution
// aggressiveness as a real sweep dimension (DEC-V0-B4-HOOK-WIRING-001).
const MCP_ENABLED = cliArgs["mcp"] === true;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TASKS_JSON_PATH = join(BENCH_B4_ROOT, "tasks.json");
const ARTIFACT_DIR = join(REPO_ROOT, "tmp", "B4-tokens");
const SCRATCH_DIR = join(ARTIFACT_DIR, "oracle-scratch");
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const ARTIFACT_PATH = cliArgs["output"] ?? join(ARTIFACT_DIR, `slice1-${DRY_RUN ? "dry-" : ""}${TIMESTAMP}.json`);
const MCP_SERVER_PATH = join(BENCH_B4_ROOT, "harness", "mcp-server.mjs");

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
// MCP subprocess: start, query, and stop the atom-lookup server
//
// @decision DEC-V0-B4-HOOK-WIRING-001
// @title Arm A hook wiring: subprocess MCP server with real tool_use cycle relay
// @status accepted
// @rationale
//   Slice 2 Arm A declares `atom-lookup` as a real Anthropic tool (not a phantom).
//   When the model issues a tool_use block (stop_reason=tool_use), the harness:
//     1. Parses the tool input from the response content block.
//     2. Sends the query to the MCP server subprocess via JSON-RPC over stdin.
//     3. Reads the MCP response from stdout.
//     4. Returns the tool result to the Anthropic API as a follow-up messages call.
//   This relay continues until stop_reason=end_turn (model produces TypeScript code)
//   or until MAX_TOOL_CYCLES is reached (hook_non_engaged: true logged).
//
//   WHY SUBPROCESS (not in-process):
//   The MCP spec requires the server to be a distinct process communicating over
//   stdio. This matches the production MCP pattern and avoids embedding the SQLite
//   registry in the harness's address space (which would require different build
//   configuration). The subprocess starts once per (task × rep) and is reused
//   for all tool_use cycles in that rep.
//
//   EMPTY RESULT HANDLING:
//   When the MCP server returns { atoms: [] }, the harness returns the empty result
//   to the model (no phantom substitution). The model then generates the code
//   directly. This is correct behavior — a miss in the registry is not a harness
//   error. Documented as hook_non_engaged: true in the rep result.
//
//   REPLACING THE PHANTOM TOOL:
//   Slice 1 cut the yakccResolve tool entirely (DEC-BENCH-B4-HARNESS-002) because
//   it had no real backend. Slice 2 re-introduces the tool via the real MCP server.
//   The tool is now named "atom-lookup" (not "yakccResolve") to avoid confusion.
// ---------------------------------------------------------------------------

/** Maximum tool_use cycles per rep before declaring hook_non_engaged. */
const MAX_TOOL_CYCLES = 5;

/** Anthropic tool definition for the MCP atom-lookup server. */
const ATOM_LOOKUP_TOOL_DEF = {
  name: "atom-lookup",
  description:
    "Query the yakcc atom registry for candidate implementations matching an intent. " +
    "Returns atoms with atom_id, atom_signature, match_confidence, atom_body_sha256. " +
    "Returns { atoms: [] } when no candidates match -- generate the implementation directly.",
  input_schema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        description: "Behavioral description of the desired atom.",
      },
      substitution_aggressiveness: {
        type: "string",
        enum: ["conservative", "default", "aggressive"],
        description: "Threshold mode: conservative=0.95, default=0.7, aggressive=all.",
        default: "default",
      },
    },
    required: ["intent"],
  },
};

/**
 * Start the MCP server subprocess and return a handle for querying it.
 * The handle's close() method terminates the server.
 */
async function startMcpServer() {
  // Pass REPO_ROOT as YAKCC_REGISTRY_PATH env so the MCP server finds the correct
  // registry regardless of whether it's running from the main worktree or a feature
  // worktree. The registry lives at REPO_ROOT/.yakcc/registry.sqlite.
  const registryPath = process.env["YAKCC_REGISTRY_PATH"]
    ?? join(REPO_ROOT, ".yakcc", "registry.sqlite");

  const server = spawn("node", [MCP_SERVER_PATH], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      YAKCC_REGISTRY_PATH: registryPath,
      YAKCC_REPO_ROOT: REPO_ROOT,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  server.stderr.on("data", (d) => {
    console.log(`  [MCP] ${d.toString().trim()}`);
  });

  let stdoutBuf = Buffer.alloc(0);
  let pendingResolves = new Map();
  let reqId = 100;

  server.stdout.on("data", (chunk) => {
    stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
    // Parse Content-Length framed messages
    while (true) {
      const hEnd = stdoutBuf.indexOf("\r\n\r\n");
      if (hEnd === -1) break;
      const hText = stdoutBuf.slice(0, hEnd).toString("utf8");
      const m = hText.match(/Content-Length:\s*(\d+)/i);
      if (!m) { stdoutBuf = stdoutBuf.slice(hEnd + 4); break; }
      const cl = parseInt(m[1], 10);
      const bStart = hEnd + 4;
      if (stdoutBuf.length < bStart + cl) break;
      const body = stdoutBuf.slice(bStart, bStart + cl).toString("utf8");
      stdoutBuf = stdoutBuf.slice(bStart + cl);
      try {
        const msg = JSON.parse(body);
        const resolve = pendingResolves.get(msg.id);
        if (resolve) {
          pendingResolves.delete(msg.id);
          resolve(msg);
        }
      } catch (_) {}
    }
  });

  function sendMcpRequest(method, params) {
    const id = reqId++;
    return new Promise((resolve, reject) => {
      pendingResolves.set(id, resolve);
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
      server.stdin.write(header + body);
      // Timeout after 10s
      setTimeout(() => {
        if (pendingResolves.has(id)) {
          pendingResolves.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 10000);
    });
  }

  // Handshake
  await sendMcpRequest("initialize", { protocolVersion: "2024-11-05", capabilities: {} });

  return {
    async callTool(toolInput) {
      const response = await sendMcpRequest("tools/call", {
        name: "atom-lookup",
        arguments: toolInput,
      });
      if (response.error) {
        throw new Error(`MCP tool error: ${response.error.message}`);
      }
      const text = response.result?.content?.[0]?.text ?? '{"atoms":[]}';
      return JSON.parse(text);
    },
    close() {
      server.kill("SIGTERM");
    },
  };
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

  // Arm A with MCP enabled: start the MCP server and declare the real atom-lookup tool.
  // Arm A without MCP (Slice 1 mode): system-prompt suffix only, no tool declaration.
  // Arm B: vanilla system prompt, no tool.
  // See DEC-V0-B4-HOOK-WIRING-001 for the full relay decision.
  const useRealMcp = arm === "A" && MCP_ENABLED;

  let mcpServer = null;
  let toolCycleCount = 0;
  let hookNonEngaged = false;
  const substitutionEvents = []; // Records which atoms were proposed per cycle

  if (useRealMcp) {
    console.log("  [MCP] Starting atom-lookup MCP server...");
    mcpServer = await startMcpServer();
    console.log("  [MCP] Server ready.");
  }

  try {
    const t0 = Date.now();

    // Build initial API call parameters
    const apiParams = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      system: systemPrompt,
      messages: [{ role: "user", content: promptText }],
      ...(useRealMcp ? { tools: [ATOM_LOOKUP_TOOL_DEF] } : {}),
    };

    let response = await client.messages.create(apiParams);

    // Tool-use relay loop (Slice 2 Arm A with MCP only)
    // Per DEC-V0-B4-HOOK-WIRING-001: relay tool_use cycles back to MCP server.
    if (useRealMcp) {
      const conversationMessages = [...apiParams.messages];

      while (response.stop_reason === "tool_use" && toolCycleCount < MAX_TOOL_CYCLES) {
        toolCycleCount++;
        console.log(`  [MCP] tool_use cycle ${toolCycleCount} detected.`);

        // Collect all tool_use blocks from the response
        const toolUseBlocks = response.content.filter((c) => c.type === "tool_use");
        const toolResults = [];

        for (const toolUse of toolUseBlocks) {
          console.log(`  [MCP] Model called tool: ${toolUse.name} with intent="${JSON.stringify(toolUse.input).slice(0, 80)}..."`);

          let toolResult;
          try {
            toolResult = await mcpServer.callTool(toolUse.input);
          } catch (err) {
            console.warn(`  [MCP] Tool call failed: ${err.message}. Returning empty result.`);
            toolResult = { atoms: [] };
          }

          // Record substitution event
          substitutionEvents.push({
            cycle: toolCycleCount,
            tool_name: toolUse.name,
            intent: toolUse.input?.intent ?? "",
            atoms_proposed: toolResult.atoms?.length ?? 0,
            atoms: toolResult.atoms ?? [],
          });

          if (!toolResult.atoms || toolResult.atoms.length === 0) {
            console.log("  [MCP] No atoms returned (registry miss or below threshold) -- model will generate directly.");
          } else {
            console.log(`  [MCP] ${toolResult.atoms.length} atom(s) returned to model.`);
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(toolResult),
          });
        }

        // Extend conversation with assistant response + tool results
        conversationMessages.push({ role: "assistant", content: response.content });
        conversationMessages.push({ role: "user", content: toolResults });

        // Continue the conversation
        response = await client.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          system: systemPrompt,
          messages: conversationMessages,
          tools: [ATOM_LOOKUP_TOOL_DEF],
        });
      }

      // If we still have tool_use after max cycles, log hook_non_engaged
      if (response.stop_reason === "tool_use") {
        console.warn(`  [MCP] Reached MAX_TOOL_CYCLES (${MAX_TOOL_CYCLES}). Force-stopping tool relay.`);
        hookNonEngaged = true;
      }

      // If model never called the tool at all, log hook_non_engaged
      if (toolCycleCount === 0) {
        console.log("  [MCP] Model did not call atom-lookup tool (hook_non_engaged: true).");
        hookNonEngaged = true;
      }
    } else {
      // Slice 1 mode: no MCP server. Defensive guard for unexpected tool_use.
      if (response.stop_reason === "tool_use") {
        console.warn(
          `  [WARN] ${arm} got stop_reason=tool_use despite no tool declaration. ` +
          "This indicates a harness configuration error. The code extraction will produce " +
          "an empty file and oracle will fail. Check DEC-BENCH-B4-HARNESS-002 in run.mjs."
        );
      }
    }

    const wallMs = Date.now() - t0;
    return { response, wallMs, toolCycleCount, hookNonEngaged, substitutionEvents };

  } finally {
    if (mcpServer !== null) {
      mcpServer.close();
    }
  }
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

    let toolCycleCount = 0;
    let hookNonEngaged = false;
    let substitutionEvents = [];

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
      toolCycleCount = result.toolCycleCount ?? 0;
      hookNonEngaged = result.hookNonEngaged ?? false;
      substitutionEvents = result.substitutionEvents ?? [];
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

    // Log hook engagement status for MCP mode
    if (MCP_ENABLED && arm === "A") {
      if (hookNonEngaged) {
        console.log(`    hook_non_engaged: true (tool called ${toolCycleCount} times)`);
      } else if (toolCycleCount > 0) {
        console.log(`    hook_engaged: true (${toolCycleCount} tool cycle(s), ${substitutionEvents.reduce((s, e) => s + e.atoms_proposed, 0)} atoms proposed)`);
      }
    }

    results.push({
      rep,
      arm,
      task_id: task.id,
      telemetry,
      oracle: oracleResult,
      dry_run: dryRun,
      // MCP Slice 2 fields (undefined in Slice 1 / non-MCP mode)
      ...(MCP_ENABLED && arm === "A" ? {
        tool_cycle_count: toolCycleCount,
        hook_non_engaged: hookNonEngaged,
        substitution_events: substitutionEvents,
      } : {}),
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
  console.log("B4-tokens — Token-Expenditure A/B Harness");
  console.log(`  Mode: ${DRY_RUN ? "DRY-RUN (canned fixtures, no API calls)" : NO_NETWORK ? "NO-NETWORK (MCP server smoke test only)" : "REAL (API calls required)"}`);
  console.log(`  MCP: ${MCP_ENABLED ? "ENABLED (Slice 2 — real atom-lookup tool for Arm A)" : "DISABLED (Slice 1 — system-prompt suffix only)"}`);
  console.log(`  N=${N_REPS} reps per (task × arm) | tasks loaded from tasks.json`);
  console.log("=".repeat(70));
  console.log();

  // --no-network: verify MCP server starts and responds, then exit (no API calls)
  if (NO_NETWORK) {
    console.log("[--no-network] Verifying MCP server starts and responds...");
    const testServer = await startMcpServer();
    const result = await testServer.callTool({ intent: "schedule timer callback with cancel", substitution_aggressiveness: "aggressive" });
    testServer.close();
    console.log(`[--no-network] MCP server OK. ${result.atoms?.length ?? 0} candidate(s) returned for test query.`);
    console.log("[--no-network] Smoke test passed. Exiting without API calls.");
    process.exit(0);
  }

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
