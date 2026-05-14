// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/harness/run.mjs
//
// @decision DEC-V0-B4-MATRIX-RUNNER-001
// @title B4 Slice 2: 3-driver × 8-task × N=3 matrix runner
// @status accepted
// @rationale
//   WI-473 promotes the B4 harness from a single-driver/2-arm Slice 1 run to a
//   locked 3-driver × 8-task × N=3 matrix per DEC-V0-B4-SLICE2-MATRIX-002.
//
//   MATRIX SHAPE (see matrix.mjs for canonical definition)
//   - min tier:  3 drivers × 2 arms (unhooked + hooked-default)  = 6 cells/task
//                6 × 8 tasks × 3 reps = 144 total API calls
//   - full tier: 3 drivers × 4 arms (unhooked + 3 sweep positions) = 12 cells/task
//                12 × 8 tasks × 3 reps = 288 total API calls
//
//   BACKWARD COMPATIBILITY
//   The Slice 1 invocation `node run.mjs --dry-run` still works and produces a
//   complete dry-run results artifact. It now uses the 3-driver matrix instead of
//   single-driver. Migration note: Slice 1 produced slice1-*.json artifacts; Slice 2
//   produces results-{tier}-{date}.json. The --mcp flag from Slice 1 is accepted but
//   ignored (Slice 2 always uses MCP for the hooked arm in real mode).
//
//   CELL ITERATION ORDER
//   Per forbidden shortcuts §3: all N=3 reps for one (task × cell) are completed
//   before moving to the next cell. No round-robin across drivers within a task rep.
//
//   COST CEILING
//   Per DEC-V0-B4-SLICE2-COST-CEILING-004: $75 USD slice cap. BudgetTracker checks
//   before every API call. No env-var bypass. Rolling spend printed after every call.
//
//   DRIVER KEY VALIDATION
//   In real mode, all configured drivers must have API keys. MissingDriverKeyError
//   aborts if any driver key is absent (partial-matrix data is forbidden).
//   Per-driver keys: B4_API_KEY_HAIKU / B4_API_KEY_SONNET / B4_API_KEY_OPUS.
//   Fallback: ANTHROPIC_API_KEY used for all drivers.
//
// Cross-reference:
//   matrix.mjs       — cell space definition, DRIVERS, SWEEP_POSITIONS
//   billing.mjs      — JSONL billing log, estimateCostUsd
//   budget.mjs       — BudgetTracker, BudgetExceededError, SLICE2_CAP_USD
//   oracle-runner.mjs — code extraction and oracle test invocation
//   mcp-server.mjs   — real MCP atom-lookup backend (DO NOT MODIFY from this file)
//
// Usage:
//   node bench/B4-tokens/harness/run.mjs --dry-run
//   node bench/B4-tokens/harness/run.mjs --dry-run --tier=full
//   node bench/B4-tokens/harness/run.mjs --driver=sonnet --tier=min  # requires API key
//   node bench/B4-tokens/harness/run.mjs --tier=min                  # all 3 drivers
//   pnpm bench:tokens --dry-run
//   pnpm bench:tokens --dry-run --tier=full

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B4_ROOT = resolve(__dirname, "..");

// REPO_ROOT: find the main git repository root (not a worktree root) by looking
// for a directory named ".git" (worktrees have a .git FILE, not a directory).
function findRepoRootSync(startDir) {
  let current = startDir;
  for (let i = 0; i < 12; i++) {
    const gitPath = join(current, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isDirectory()) return current;
      } catch (_) {}
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return resolve(startDir, "../../..");
}

const REPO_ROOT = findRepoRootSync(__dirname);

// ---------------------------------------------------------------------------
// Imports of Slice 2 modules
// ---------------------------------------------------------------------------

const { buildCellSpace, DRIVERS } = await import(
  new URL("file://" + join(__dirname, "matrix.mjs")).href
);
const { BillingLog, estimateCostUsd } = await import(
  new URL("file://" + join(__dirname, "billing.mjs")).href
);
const { BudgetTracker, BudgetExceededError, SLICE2_CAP_USD } = await import(
  new URL("file://" + join(__dirname, "budget.mjs")).href
);
const { extractCode, runOracle } = await import(
  new URL("file://" + join(__dirname, "oracle-runner.mjs")).href
);

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const { values: cliArgs } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run":         { type: "boolean", default: false },
    "no-network":      { type: "boolean", default: false },
    "mcp":             { type: "boolean", default: false }, // Slice 1 compat flag, now ignored
    "driver":          { type: "string",  default: "all" },
    "tier":            { type: "string",  default: "min" },
    "reps":            { type: "string",  default: "3" },
    "output":          { type: "string" },
    "sweep-positions": { type: "string" }, // informational only; matrix.mjs controls shape
    // WI-479 engagement investigation flags:
    // --force-tool-call: force tool_choice={type:"tool",name:"atom-lookup"} for H2 hypothesis test.
    // Forces at least 1 tool invocation per hooked cell regardless of model preference.
    "force-tool-call": { type: "boolean", default: false },
    // --prompt-variant: select system prompt variant for H1 hypothesis test.
    // Values: "baseline" (current), "motivated" (add value selling), "chain-of-thought" (structured query).
    "prompt-variant":  { type: "string",  default: "baseline" },
    // --tasks: comma-separated list of task IDs to run (subset for Phase 3 small slices)
    "tasks":           { type: "string" },
  },
  strict: false,
  allowPositionals: false,
});

const DRY_RUN        = cliArgs["dry-run"] === true;
const NO_NETWORK     = cliArgs["no-network"] === true;
const DRIVER_FILTER  = cliArgs["driver"] ?? "all";
const TIER           = cliArgs["tier"] ?? "min";
const N_REPS         = parseInt(cliArgs["reps"] ?? "3", 10);
const FORCE_TOOL     = cliArgs["force-tool-call"] === true;
const PROMPT_VARIANT = cliArgs["prompt-variant"] ?? "baseline";
const TASK_FILTER    = cliArgs["tasks"] ? cliArgs["tasks"].split(",").map((t) => t.trim()) : null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TASKS_JSON_PATH = join(BENCH_B4_ROOT, "tasks.json");
const ARTIFACT_DIR    = join(REPO_ROOT, "tmp", "B4-tokens");
const SCRATCH_DIR     = join(ARTIFACT_DIR, "oracle-scratch");
const MCP_SERVER_PATH = join(BENCH_B4_ROOT, "harness", "mcp-server.mjs");

const DATE_STAMP = new Date().toISOString().replace(/T/, "-").replace(/[:.]/g, "-").slice(0, 16);
// Include engagement variant tags in RUN_ID so artifacts are unambiguous
const VARIANT_TAG = [
  FORCE_TOOL    ? "forced"  : "",
  PROMPT_VARIANT !== "baseline" ? `prompt-${PROMPT_VARIANT}` : "",
  TASK_FILTER   ? `tasks-${TASK_FILTER.join("-")}` : "",
].filter(Boolean).join("-");
const RUN_ID = [TIER, DATE_STAMP, VARIANT_TAG, randomUUID().slice(0, 8)]
  .filter(Boolean).join("-");

const ARTIFACT_PATH = cliArgs["output"] ??
  join(ARTIFACT_DIR, `results-${TIER}-${DATE_STAMP}${VARIANT_TAG ? "-" + VARIANT_TAG : ""}.json`);
const SUMMARY_PATH  = join(ARTIFACT_DIR, `summary-${TIER}-${DATE_STAMP}${VARIANT_TAG ? "-" + VARIANT_TAG : ""}.md`);

const MAX_TOKENS  = 2048;
const TEMPERATURE = 1.0;
const MAX_TOOL_CYCLES = 5;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

class MissingDriverKeyError extends Error {
  constructor(missingDrivers) {
    super(
      `Missing API keys for drivers: ${missingDrivers.join(", ")}.\n` +
      "Real-mode requires all configured drivers to have API keys.\n" +
      "Partial-matrix data is forbidden (corrupts cross-cell comparison).\n" +
      "Per-driver keys: B4_API_KEY_HAIKU, B4_API_KEY_SONNET, B4_API_KEY_OPUS\n" +
      "Or set ANTHROPIC_API_KEY for all drivers."
    );
    this.name = "MissingDriverKeyError";
    this.missingDrivers = missingDrivers;
  }
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_VANILLA = `You are an expert TypeScript developer. When given a coding task, implement it in a single TypeScript file. Output only the implementation code in a \`\`\`typescript code block. Do not include explanation before or after the code block.`;

// WI-479 H1 hypothesis: three prompt variants testing engagement motivation strength.
//
// @decision DEC-V0-B4-ENGAGEMENT-002
// @title H1 prompt variants: three levels of tool-use motivation for engagement hypothesis test
// @status accepted
// @rationale
//   The matrix-1 run showed models invoke the atom-lookup tool ~1x/cell but get empty results.
//   Before testing H1 (prompt under-motivation), we confirmed from Phase 2 re-analysis that
//   invocation rate IS ~100% (tool_invocation_rate=1.0). So H1 is partially disproved —
//   models DO call the tool. The remaining question is whether stronger prompting produces
//   different intents or more targeted queries that might hit future atoms.
//   These variants are kept for H1 measurement even though H4 is the confirmed root cause.
//
// Variant A (baseline): current suffix verbatim — establishes control.
// Variant B (motivated): adds explicit preference instruction + value proposition.
// Variant C (chain-of-thought): adds structured 2-step query protocol before coding.

const SYSTEM_PROMPT_HOOK_SUFFIX_BASELINE = `

You are working in a codebase that uses the yakcc registry for common atomic implementations. When implementing code, prefer token-efficient implementations that compose proven patterns (state machines, data structures, parsing primitives) rather than verbose from-scratch approaches. Output only the implementation code in a \`\`\`typescript code block.`;

const SYSTEM_PROMPT_HOOK_SUFFIX_MOTIVATED = `

You are working in a codebase backed by the yakcc atom registry. IMPORTANT: Before implementing any function, you MUST call atom-lookup to check if a pre-tested atom already exists. Atoms are content-addressed, pre-verified, and composable — using them reduces your output token cost and increases correctness.

PREFER yakcc atoms over inline implementation whenever a candidate exists. Query atom-lookup before emitting any function body. Only write inline code when atom-lookup confirms no useful atom exists (returns { atoms: [] }).

Output only the implementation code in a \`\`\`typescript code block.`;

const SYSTEM_PROMPT_HOOK_SUFFIX_CHAIN_OF_THOUGHT = `

You are working in a codebase backed by the yakcc atom registry. Use this protocol:

STEP 1: Before writing any code, identify 2-3 atomic building blocks the task needs (e.g., "doubly-linked list node", "TTL timestamp tracker", "hash map lookup").
STEP 2: Call atom-lookup for each building block with a specific behavioral description.
STEP 3: For each query result — if atoms are found, incorporate them; if { atoms: [] }, note it and implement inline.
STEP 4: Emit the final implementation.

Output only the implementation code in a \`\`\`typescript code block.`;

// Resolve prompt suffix based on --prompt-variant flag
function resolveHookSuffix(variant) {
  switch (variant) {
    case "motivated":      return SYSTEM_PROMPT_HOOK_SUFFIX_MOTIVATED;
    case "chain-of-thought": return SYSTEM_PROMPT_HOOK_SUFFIX_CHAIN_OF_THOUGHT;
    default:               return SYSTEM_PROMPT_HOOK_SUFFIX_BASELINE;
  }
}

const SYSTEM_PROMPT_HOOK_SUFFIX = resolveHookSuffix(PROMPT_VARIANT);

/**
 * @decision DEC-V0-B4-HOOK-WIRING-001
 * @title Arm A hook wiring: subprocess MCP server with real tool_use cycle relay
 * @status accepted
 * @rationale See original decision in harness/run.mjs Slice 1 comments.
 *   Slice 2: atom-lookup tool declared for hooked arm. Real MCP server relays
 *   tool_use blocks. sweep_position's substitution_aggressiveness passed to tool.
 */
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

// ---------------------------------------------------------------------------
// API key resolution per driver
// ---------------------------------------------------------------------------

function getApiKeyForDriver(shortName) {
  const perDriver = {
    haiku:  process.env["B4_API_KEY_HAIKU"],
    sonnet: process.env["B4_API_KEY_SONNET"],
    opus:   process.env["B4_API_KEY_OPUS"],
  };
  return perDriver[shortName] ?? process.env["ANTHROPIC_API_KEY"];
}

function validateApiKeysForDrivers(activeDrivers) {
  const missing = [];
  for (const driver of activeDrivers) {
    if (!getApiKeyForDriver(driver.short_name)) {
      missing.push(driver.short_name);
    }
  }
  if (missing.length > 0) throw new MissingDriverKeyError(missing);
}

// ---------------------------------------------------------------------------
// Anthropic SDK loader (lazy, singleton)
// ---------------------------------------------------------------------------

let _anthropicClass = null;
async function getAnthropicClass() {
  if (_anthropicClass) return _anthropicClass;
  const sdkPath    = join(BENCH_B4_ROOT, "node_modules", "@anthropic-ai", "sdk", "dist", "index.mjs");
  const sdkPathCjs = join(BENCH_B4_ROOT, "node_modules", "@anthropic-ai", "sdk", "dist", "index.js");
  if (existsSync(sdkPath)) {
    const mod = await import(new URL(`file://${sdkPath}`).href);
    _anthropicClass = mod.default ?? mod.Anthropic;
  } else if (existsSync(sdkPathCjs)) {
    const mod = await import(new URL(`file://${sdkPathCjs}`).href);
    _anthropicClass = mod.default ?? mod.Anthropic;
  } else {
    try {
      const mod = await import("@anthropic-ai/sdk");
      _anthropicClass = mod.default ?? mod.Anthropic;
    } catch (_) {
      throw new Error(
        "Could not load @anthropic-ai/sdk. Run `pnpm --dir bench/B4-tokens install` first."
      );
    }
  }
  return _anthropicClass;
}

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
    const rawBytes  = readFileSync(promptPath);
    const actualRaw = createHash("sha256").update(rawBytes).digest("hex");
    let actual = actualRaw;
    if (actual !== task.sha256) {
      const lfBytes = Buffer.from(rawBytes.toString("binary").replace(/\r\n/g, "\n"), "binary");
      const actualLf = createHash("sha256").update(lfBytes).digest("hex");
      if (actualLf === task.sha256) actual = actualLf;
    }
    if (actual !== task.sha256) {
      throw new Error(
        `SHA-256 drift detected for ${task.prompt_file}:\n` +
        `  expected: ${task.sha256}\n  actual: ${actualRaw}\n` +
        "Task prompt has changed. Regenerate tasks.json with updated hashes."
      );
    }
    console.log(`  [OK] ${task.id} — sha256=${actual.slice(0, 16)}...`);
  }
  console.log(`[B4] Task manifest OK — ${manifest.tasks.length} tasks verified.\n`);
  return manifest;
}

// ---------------------------------------------------------------------------
// Fixture / stub loading (dry-run mode)
// ---------------------------------------------------------------------------

function loadFixtureOrStub(taskId, arm) {
  // Fixture arm convention: "hooked" → arm-a-response.json, "unhooked" → arm-b-response.json
  const fixtureArm  = arm === "hooked" ? "a" : "b";
  const fixturePath = join(BENCH_B4_ROOT, "fixtures", taskId, `arm-${fixtureArm}-response.json`);
  if (existsSync(fixturePath)) {
    return JSON.parse(readFileSync(fixturePath, "utf8"));
  }
  // Stub: correct structure, no real code. Oracle will FAIL — expected for dry-run.
  const isHooked = arm === "hooked";
  return {
    _fixture_note: "Synthetic stub — no real fixture for this task yet",
    id: `msg_dry_${taskId}_arm_${fixtureArm}_stub`,
    type: "message", role: "assistant", model: "claude-sonnet-4-6",
    stop_reason: "end_turn", stop_sequence: null,
    usage: {
      input_tokens:  isHooked ? 900 : 1100,
      output_tokens: isHooked ? 280 : 420,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    content: [{ type: "text", text: "```typescript\n// dry-run stub\nexport {};\n```" }],
  };
}

// ---------------------------------------------------------------------------
// MCP server subprocess lifecycle
// ---------------------------------------------------------------------------

async function startMcpServer() {
  const registryPath = process.env["YAKCC_REGISTRY_PATH"] ??
    join(REPO_ROOT, ".yakcc", "registry.sqlite");
  const server = spawn("node", [MCP_SERVER_PATH], {
    cwd: REPO_ROOT,
    env: { ...process.env, YAKCC_REGISTRY_PATH: registryPath, YAKCC_REPO_ROOT: REPO_ROOT },
    stdio: ["pipe", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stdout.write(`  [MCP] ${d.toString().trim()}\n`));

  let stdoutBuf = Buffer.alloc(0);
  const pending = new Map();
  let reqId = 100;

  server.stdout.on("data", (chunk) => {
    stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
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
        const res = pending.get(msg.id);
        if (res) { pending.delete(msg.id); res(msg); }
      } catch (_) {}
    }
  });

  function request(method, params) {
    const id = reqId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      const body   = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
      server.stdin.write(header + body);
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }
      }, 10000);
    });
  }

  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });

  return {
    async callTool(toolInput) {
      const resp = await request("tools/call", { name: "atom-lookup", arguments: toolInput });
      if (resp.error) throw new Error(`MCP tool error: ${resp.error.message}`);
      const text = resp.result?.content?.[0]?.text ?? '{"atoms":[]}';
      return JSON.parse(text);
    },
    close() { server.kill("SIGTERM"); },
  };
}

// ---------------------------------------------------------------------------
// Real API call for one (task × cell × rep)
// ---------------------------------------------------------------------------

async function callAnthropicForCell(taskId, taskManifest, cell, budget, billingLog, rep) {
  const apiKey = getApiKeyForDriver(cell.driver);
  if (!apiKey) throw new MissingDriverKeyError([cell.driver]);

  const Anthropic  = await getAnthropicClass();
  const client     = new Anthropic({ apiKey });
  const promptPath = join(BENCH_B4_ROOT, taskManifest.prompt_file);
  const promptText = readFileSync(promptPath, "utf8");

  const isHooked     = cell.arm === "hooked";
  const systemPrompt = isHooked
    ? SYSTEM_PROMPT_VANILLA + SYSTEM_PROMPT_HOOK_SUFFIX
    : SYSTEM_PROMPT_VANILLA;

  let mcpServer    = null;
  let toolCycles   = 0;
  let hookNonEng   = false;
  const subEvents  = [];

  if (isHooked) {
    console.log(`    [MCP] Starting server for ${cell.cell_id}...`);
    mcpServer = await startMcpServer();
  }

  const startedAt = new Date().toISOString();
  const t0        = Date.now();

  try {
    // Conservative pre-call cost estimate (1500 in + 500 out tokens)
    const estCost = estimateCostUsd({
      model_id_requested: cell.model_id,
      input_tokens: 1500, output_tokens: 500,
      cache_read_tokens: 0, cache_write_tokens: 0,
    });
    budget.checkBeforeCall(estCost);

    // @decision DEC-V0-B4-ENGAGEMENT-003
    // @title H2 forced tool-call: tool_choice forces at least 1 invocation per cell
    // @status accepted
    // @rationale
    //   WI-479 Phase 3 H2 test: with tool_choice={type:"tool",name:"atom-lookup"},
    //   the model MUST invoke the tool before it can emit text. This rules out
    //   H1 (prompt motivation) as a factor and isolates whether forced invocations
    //   produce better atom queries or better intents.
    //   Note: tool_choice is ONLY supported for Anthropic API >= claude-3-x models.
    //   Set --force-tool-call flag to enable.
    const apiParams = {
      model: cell.model_id, max_tokens: MAX_TOKENS, temperature: TEMPERATURE,
      system: systemPrompt,
      messages: [{ role: "user", content: promptText }],
      ...(isHooked ? { tools: [ATOM_LOOKUP_TOOL_DEF] } : {}),
      ...(isHooked && FORCE_TOOL ? { tool_choice: { type: "tool", name: "atom-lookup" } } : {}),
    };

    let response = await client.messages.create(apiParams);

    // Tool-use relay (hooked arm only)
    if (isHooked) {
      const conv = [...apiParams.messages];
      while (response.stop_reason === "tool_use" && toolCycles < MAX_TOOL_CYCLES) {
        toolCycles++;
        const toolUseBlocks = response.content.filter((c) => c.type === "tool_use");
        const toolResults   = [];
        for (const tu of toolUseBlocks) {
          let toolResult;
          try {
            toolResult = await mcpServer.callTool({
              ...tu.input,
              substitution_aggressiveness: cell.substitution_aggressiveness,
            });
          } catch (err) {
            console.warn(`    [MCP] Tool call failed: ${err.message}`);
            toolResult = { atoms: [] };
          }
          subEvents.push({
            cycle: toolCycles,
            intent: tu.input?.intent ?? "",
            atoms_proposed: toolResult.atoms?.length ?? 0,
            sweep_position: cell.sweep_position,
          });
          toolResults.push({
            type: "tool_result", tool_use_id: tu.id,
            content: JSON.stringify(toolResult),
          });
        }
        conv.push({ role: "assistant", content: response.content });
        conv.push({ role: "user", content: toolResults });
        response = await client.messages.create({
          model: cell.model_id, max_tokens: MAX_TOKENS, temperature: TEMPERATURE,
          system: systemPrompt, messages: conv, tools: [ATOM_LOOKUP_TOOL_DEF],
        });
      }
      if (response.stop_reason === "tool_use") hookNonEng = true;
      if (toolCycles === 0) hookNonEng = true;
    }

    const wallMs      = Date.now() - t0;
    const finishedAt  = new Date().toISOString();
    const usage       = response.usage ?? {};

    // Model drift detection (real_path_checks §3)
    const actualModel = response.model ?? "";
    if (actualModel && actualModel !== cell.model_id) {
      console.error(
        `[MODEL DRIFT] requested=${cell.model_id} actual=${actualModel} ` +
        "— both logged in billing. Continuing."
      );
    }

    const billingEntry = {
      run_id:             RUN_ID,
      cell_id:            cell.cell_id,
      task_id:            taskId,
      task_repetition:    rep,
      input_tokens:       usage.input_tokens ?? 0,
      output_tokens:      usage.output_tokens ?? 0,
      cache_read_tokens:  usage.cache_read_input_tokens ?? 0,
      cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
      model_id_requested: cell.model_id,
      model_id_actual:    actualModel || cell.model_id,
      cost_usd_estimated: 0,
      wall_time_ms:       wallMs,
      started_at_iso:     startedAt,
      finished_at_iso:    finishedAt,
    };
    billingEntry.cost_usd_estimated = estimateCostUsd(billingEntry);
    billingLog.append(billingEntry);
    budget.addSpend(billingEntry.cost_usd_estimated);
    budget.logRollingSpend({ cellId: cell.cell_id, taskId, rep, callCost: billingEntry.cost_usd_estimated });

    return { response, wallMs, toolCycles, hookNonEng, subEvents, billingEntry,
             stopReason: response.stop_reason ?? "unknown" };
  } finally {
    if (mcpServer) mcpServer.close();
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / (arr.length - 1));
}

// ---------------------------------------------------------------------------
// Quality-lift computation
//
// @decision DEC-V0-B4-QUALITY-LIFT-001
// @title Quality-lift: operational definition and aggregation rule
// @status accepted
// @rationale
//   Lift = fraction of tasks where hooked-arm passes oracle AND unhooked-arm fails
//   oracle, for the same driver. Generous definition: any rep passing counts.
//   A task is "hooked-pass" if ANY rep passes. "Unhooked-fail" if NO rep passes.
//   Aggregated per driver. Killer-cell = Haiku's lift rate (cheapest model).
// ---------------------------------------------------------------------------

function computeQualityLift(cellRepResults, driverShortName) {
  const rows   = cellRepResults.filter((r) => r.driver === driverShortName);
  const taskIds = [...new Set(rows.map((r) => r.task_id))];
  let liftCount = 0;
  for (const taskId of taskIds) {
    const taskRows     = rows.filter((r) => r.task_id === taskId);
    const unhookedRows = taskRows.filter((r) => r.arm === "unhooked");
    const hookedRows   = taskRows.filter((r) => r.arm === "hooked");
    const unhookedAny  = unhookedRows.some((r) => r.oracle_pass);
    const hookedAny    = hookedRows.some((r)   => r.oracle_pass);
    if (!unhookedAny && hookedAny) liftCount++;
  }
  return {
    lift_count: liftCount,
    lift_rate:  taskIds.length > 0 ? liftCount / taskIds.length : 0,
    task_count: taskIds.length,
  };
}

// ---------------------------------------------------------------------------
// Results table
// ---------------------------------------------------------------------------

function buildResultsTable(cellRepResults, activeCells) {
  const drivers = [...new Set(activeCells.map((c) => c.driver))];
  // Column keys: "unhooked", "hooked-default", "hooked-conservative", "hooked-aggressive"
  const colKeys = [...new Set(activeCells.map((c) =>
    c.arm === "unhooked" ? "unhooked" : `hooked-${c.sweep_position}`
  ))];

  const rows = [];
  for (const driver of drivers) {
    const row = { driver };
    for (const colKey of colKeys) {
      const [armType, sweepPos] = colKey.startsWith("hooked-")
        ? ["hooked", colKey.replace("hooked-", "")]
        : ["unhooked", "default"];
      const rr = cellRepResults.filter((r) =>
        r.driver === driver &&
        r.arm === armType &&
        (armType === "unhooked" || r.sweep_position === sweepPos)
      );
      const outputTokens = rr.map((r) => r.output_tokens);
      const semanticEq   = rr.map((r) => r.oracle_pass ? 1 : 0);
      const wallMs       = rr.map((r) => r.wall_ms);
      const costs        = rr.map((r) => r.cost_usd_estimated);
      row[colKey] = {
        mean_token_reduction_pct: null, // filled below
        mean_semantic_eq_rate:    mean(semanticEq),
        mean_output_tokens:       mean(outputTokens),
        mean_wall_ms:             mean(wallMs),
        mean_cost_usd:            mean(costs),
        n:                        rr.length,
      };
    }
    rows.push(row);
  }

  // Compute reduction relative to unhooked baseline
  for (const row of rows) {
    const base = row["unhooked"]?.mean_output_tokens ?? 0;
    for (const col of colKeys) {
      if (col !== "unhooked" && row[col]) {
        const hooked = row[col].mean_output_tokens;
        row[col].mean_token_reduction_pct = base > 0 ? (base - hooked) / base : 0;
      }
    }
    if (row["unhooked"]) row["unhooked"].mean_token_reduction_pct = 0;
  }

  return { headers: ["driver", ...colKeys], rows };
}

// ---------------------------------------------------------------------------
// Markdown summary
// ---------------------------------------------------------------------------

function buildMarkdownSummary(artifact) {
  const { summary, config, run_id } = artifact;
  const table = summary.results_table;

  let md = `# B4-tokens Matrix Run — ${config.tier.toUpperCase()} tier\n\n`;
  md += `**Run ID:** ${run_id}  \n`;
  md += `**Date:** ${artifact.environment.runAt}  \n`;
  md += `**Mode:** ${artifact.environment.dryRun ? "DRY-RUN" : "REAL API"}  \n`;
  md += `**Total runs completed:** ${summary.total_calls_completed}  \n`;
  md += `**Total estimated cost:** $${summary.total_cost_usd.toFixed(4)}  \n\n`;
  md += `## Results Table\n\n`;

  md += `| ${table.headers.join(" | ")} |\n`;
  md += `| ${table.headers.map(() => "---").join(" | ")} |\n`;
  for (const row of table.rows) {
    const cells = table.headers.map((h) => {
      if (h === "driver") return `**${row.driver}**`;
      const cell = row[h];
      if (!cell) return "—";
      const red = cell.mean_token_reduction_pct != null
        ? `${(cell.mean_token_reduction_pct * 100).toFixed(1)}% reduction`
        : "baseline";
      return `${red} | ${(cell.mean_semantic_eq_rate * 100).toFixed(0)}% oracle | n=${cell.n}`;
    });
    md += `| ${cells.join(" | ")} |\n`;
  }

  md += `\n## Quality-Lift\n\n`;
  const ql = summary.quality_lift_by_driver;
  for (const [driver, stats] of Object.entries(ql)) {
    md += `- **${driver}**: ${(stats.lift_rate * 100).toFixed(1)}% (${stats.lift_count}/${stats.task_count} tasks)\n`;
  }
  md += `\n**Killer-cell (Haiku):** ${summary.killer_cell.haiku_lift_count} task(s), ${summary.killer_cell.haiku_lift_rate_pct.toFixed(1)}%\n`;
  md += `\n> ${summary.directional_targets_note}\n`;
  return md;
}

// ---------------------------------------------------------------------------
// Registry freshness check (#497)
//
// @decision DEC-V0-B4-REGISTRY-FRESHNESS-CHECK-001
// @title B4 startup guard: abort when workspace registry is stale vs. seed blocks on disk
// @status accepted
// @rationale
//   Issue #497: A $11 B4 run produced all-zero atoms_proposed values because
//   .yakcc/registry.sqlite had 20 atoms while packages/seeds/src/blocks/ contained
//   26 (6 added by PRs #470 and #493 were never seeded locally). The matrix ran to
//   completion, output artifacts, and appeared successful — but every hooked cell
//   returned {atoms:[]} because the missing atoms simply weren't there to find.
//
//   The guard counts seed block directories that contain a spec.yak file (source of
//   truth: what the registry SHOULD hold) and compares that to SELECT COUNT(*) FROM
//   blocks (what the registry ACTUALLY holds). Any discrepancy aborts before the
//   first API call, saving the entire run budget.
//
//   Design choices:
//   - Abort-on-mismatch, NOT auto-seed: auto-seeding masks the root cause and can
//     silently corrupt a shared registry. The operator must see the gap explicitly.
//   - Skip if registry does not exist: handled upstream by ensureRegistry() in
//     mcp-server.mjs with a clear error; no need to duplicate.
//   - Skip in dry-run mode: fixture-based runs do not need a populated registry.
//     Adding this check to dry-run would break CI that runs dry-run without seeding.
//   - Use better-sqlite3 directly: avoids importing the full @yakcc/registry stack
//     (which triggers embedding model loading) just for a COUNT(*).
//
//   Cross-reference: issue #497, PR that introduced timer-handle seed (#470),
//   PR that introduced GAP atoms (#493), DEC-V0-B4-MCP-001 (MCP server design).
// ---------------------------------------------------------------------------

/**
 * Checks that the workspace registry is fresh relative to seed blocks on disk.
 * Aborts the process with a clear remediation message if counts differ.
 *
 * @param {string} registryPath - Path to the .yakcc/registry.sqlite file.
 * @param {string} repoRoot     - Path to the repository root.
 * @param {boolean} dryRun      - Skip the check in dry-run mode (no registry needed).
 */
async function assertRegistryFreshness(registryPath, repoRoot, dryRun) {
  // Dry-run uses fixtures, not the real registry. Skip to avoid false failures in CI.
  if (dryRun) return;

  // Skip if registry does not exist — ensureRegistry() in mcp-server.mjs provides a
  // clear error on first tool call; we don't want to duplicate or preempt that message.
  if (!existsSync(registryPath)) return;

  // Count seed block directories that contain a spec.yak file.
  const blocksDir = join(repoRoot, "packages", "seeds", "src", "blocks");
  let diskAtomCount = 0;
  if (existsSync(blocksDir)) {
    const entries = readdirSync(blocksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const specPath = join(blocksDir, entry.name, "spec.yak");
        if (existsSync(specPath)) diskAtomCount++;
      }
    }
  }

  // Count atoms in the registry using better-sqlite3, loaded from the packages path
  // to avoid pulling in the full @yakcc/registry stack and its embedding model.
  // This is the same SQLite binary used by @yakcc/registry production code.
  let registryAtomCount;
  try {
    const sqlitePath = join(
      repoRoot, "packages", "registry", "node_modules", "better-sqlite3"
    );
    // createRequire is needed to load a CommonJS native module from ESM context.
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const Database = req(sqlitePath);
    const db = new Database(registryPath, { readonly: true });
    const row = db.prepare("SELECT COUNT(*) AS n FROM blocks").get();
    db.close();
    registryAtomCount = row?.n ?? 0;
  } catch (err) {
    // If the registry schema is unexpected (e.g. empty/corrupt), surface the error
    // but don't abort — the MCP server will produce a clearer error on first call.
    console.warn(`[B4] WARNING: registry freshness check failed (${err.message}). Continuing.`);
    return;
  }

  if (registryAtomCount !== diskAtomCount) {
    console.error(`
${"!".repeat(70)}
[B4] FATAL: workspace registry is stale.
  Atoms on disk:     ${diskAtomCount} (spec.yak files in packages/seeds/src/blocks/)
  Atoms in registry: ${registryAtomCount} (SELECT COUNT(*) FROM blocks at ${registryPath})

  Run the following command to refresh the registry, then re-run B4:

    node packages/cli/dist/bin.js seed

  If the CLI is not built yet:
    pnpm -r build && node packages/cli/dist/bin.js seed

  Do NOT run B4 with a stale registry — every hooked cell will return
  atoms_proposed: 0 and the run will produce silent nonsense results.
  (Issue #497: a stale registry cost $11 in wasted API calls.)
${"!".repeat(70)}
`);
    process.exit(1);
  }

  console.log(`[B4] Registry freshness OK — ${registryAtomCount} atoms (disk=${diskAtomCount}).`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const runStart = Date.now();

  // Registry freshness guard — must run before any cell/matrix setup or API call.
  // Aborts with a clear remediation message if the workspace registry is stale.
  // (DEC-V0-B4-REGISTRY-FRESHNESS-CHECK-001, issue #497)
  const registryPath = process.env["YAKCC_REGISTRY_PATH"] ??
    join(REPO_ROOT, ".yakcc", "registry.sqlite");
  await assertRegistryFreshness(registryPath, REPO_ROOT, DRY_RUN);

  // Parse cell space
  let activeCells;
  try {
    activeCells = buildCellSpace({ tier: TIER, driverFilter: DRIVER_FILTER });
  } catch (err) {
    console.error(`[B4] Cell space error: ${err.message}`);
    process.exit(1);
  }

  const activeDriverShortNames = [...new Set(activeCells.map((c) => c.driver))];
  const activeDrivers = DRIVERS.filter((d) => activeDriverShortNames.includes(d.short_name));
  // estimatedTotalCalls updated after manifest load if TASK_FILTER is active
  let estimatedTotalCalls = activeCells.length * 8 * N_REPS;

  console.log("=".repeat(70));
  console.log("B4-tokens — Matrix Token-Expenditure Harness (Slice 2)");
  console.log(`  Mode:     ${DRY_RUN ? "DRY-RUN (fixtures, no API)" : "REAL (Anthropic API)"}`);
  console.log(`  Tier:     ${TIER.toUpperCase()} (${activeCells.length} cells/task)`);
  console.log(`  Drivers:  ${DRIVER_FILTER === "all" ? "all 3" : DRIVER_FILTER}`);
  console.log(`  N:        ${N_REPS} reps per (task × cell)`);
  const preFilterNTasks = TASK_FILTER ? TASK_FILTER.length : 8;
  const preFilterEstRuns = activeCells.length * preFilterNTasks * N_REPS;
  console.log(`  Tasks:    ${TASK_FILTER ? TASK_FILTER.join(", ") : "all 8"}`);
  console.log(`  Est. runs: ${preFilterEstRuns} (${activeCells.length} × ${preFilterNTasks} tasks × ${N_REPS})`);
  console.log(`  Cap:      $${SLICE2_CAP_USD} USD (DEC-V0-B4-SLICE2-COST-CEILING-004)`);
  console.log(`  Run ID:   ${RUN_ID}`);
  // WI-479 engagement investigation flags
  if (FORCE_TOOL)            console.log(`  [H2]     --force-tool-call=ON (tool_choice forces invocation)`);
  if (PROMPT_VARIANT !== "baseline") console.log(`  [H1]     --prompt-variant=${PROMPT_VARIANT}`);
  console.log("=".repeat(70));
  console.log();

  // --no-network: MCP smoke test
  if (NO_NETWORK) {
    console.log("[--no-network] Verifying MCP server...");
    const testServer = await startMcpServer();
    const result     = await testServer.callTool({ intent: "schedule timer callback", substitution_aggressiveness: "aggressive" });
    testServer.close();
    console.log(`[--no-network] MCP OK. ${result.atoms?.length ?? 0} atom(s). Exiting.`);
    process.exit(0);
  }

  // Real-mode: validate API keys before touching anything
  if (!DRY_RUN) {
    try {
      validateApiKeysForDrivers(activeDrivers);
    } catch (err) {
      console.error(`\n${"!".repeat(70)}\nERROR: ${err.message}\n${"!".repeat(70)}\n`);
      process.exit(1);
    }
  }

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  mkdirSync(SCRATCH_DIR,  { recursive: true });

  const manifest = loadAndVerifyTasks();
  // Apply --tasks filter if specified (Phase 3 hypothesis test slices)
  const allTasks = manifest.tasks;
  const tasks = TASK_FILTER
    ? allTasks.filter((t) => TASK_FILTER.includes(t.id))
    : allTasks;
  if (TASK_FILTER) {
    const unknown = TASK_FILTER.filter((id) => !allTasks.find((t) => t.id === id));
    if (unknown.length > 0) {
      console.error(`[B4] Unknown task IDs in --tasks filter: ${unknown.join(", ")}`);
      process.exit(1);
    }
    console.log(`[B4] Task filter applied: ${tasks.map((t) => t.id).join(", ")}\n`);
    // Recompute estimated total calls with filtered task count
    estimatedTotalCalls = activeCells.length * tasks.length * N_REPS;
  }

  const budget     = new BudgetTracker({ cap_usd: SLICE2_CAP_USD });
  const billingLog = new BillingLog({ dir: ARTIFACT_DIR, runId: RUN_ID });

  const cellRepResults = [];
  let budgetExceeded   = false;

  // Outer loops: task → cell → reps
  TASK_LOOP:
  for (const task of tasks) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`Task: ${task.id}`);
    console.log("─".repeat(70));

    for (const cell of activeCells) {
      console.log(`\n  Cell: ${cell.cell_id}`);

      for (let rep = 1; rep <= N_REPS; rep++) {
        console.log(`    rep ${rep}/${N_REPS}...`);

        let outputTokens    = 0;
        let inputTokens     = 0;
        let cacheReadTok    = 0;
        let wallMs          = 0;
        let costUsd         = 0;
        let toolCycles      = 0;
        let hookNonEng      = false;
        let subEvents       = [];
        let oraclePass      = false;
        let oraclePassed    = 0;
        let oracleTotal     = 0;
        let responseContent = [];
        let finalStopReason = "end_turn"; // WI-479: final stop_reason after tool relay

        if (DRY_RUN) {
          const fixture   = loadFixtureOrStub(task.id, cell.arm);
          const usage     = fixture.usage ?? {};
          responseContent = fixture.content ?? [];
          outputTokens    = usage.output_tokens ?? 0;
          inputTokens     = usage.input_tokens  ?? 0;
          cacheReadTok    = usage.cache_read_input_tokens ?? 0;
          wallMs          = cell.arm === "hooked" ? 1200 + rep * 50 : 2800 + rep * 80;
          costUsd         = estimateCostUsd({
            model_id_requested: cell.model_id,
            input_tokens: inputTokens, output_tokens: outputTokens,
            cache_read_tokens: cacheReadTok, cache_write_tokens: 0,
          });
        } else {
          let callResult;
          try {
            callResult = await callAnthropicForCell(
              task.id, task, cell, budget, billingLog, rep
            );
          } catch (err) {
            if (err instanceof BudgetExceededError) {
              console.error(`\n[BUDGET] ${err.message}`);
              budgetExceeded = true;
              break TASK_LOOP;
            }
            throw err;
          }
          const respUsage = callResult.response.usage ?? {};
          responseContent = callResult.response.content ?? [];
          outputTokens    = respUsage.output_tokens ?? 0;
          inputTokens     = respUsage.input_tokens  ?? 0;
          cacheReadTok    = respUsage.cache_read_input_tokens ?? 0;
          wallMs          = callResult.wallMs;
          toolCycles      = callResult.toolCycles;
          hookNonEng      = callResult.hookNonEng;
          subEvents       = callResult.subEvents;
          costUsd         = callResult.billingEntry.cost_usd_estimated;
          // WI-479: capture final stop_reason for engagement analysis
          finalStopReason = callResult.stopReason;
        }

        // Extract code and run oracle
        const responseText  = responseContent.find((c) => c.type === "text")?.text ?? "";
        const generatedCode = extractCode(responseText);
        const oracle        = await runOracle(task.id, generatedCode, { scratchDir: SCRATCH_DIR });
        oraclePass    = oracle.semantic_equivalent;
        oraclePassed  = oracle.passed;
        oracleTotal   = oracle.total;

        console.log(
          `    Oracle: ${oraclePass ? "PASS" : "FAIL"} ` +
          `(${oraclePassed}/${oracleTotal}) | out=${outputTokens} tok | ${wallMs}ms`
        );

        cellRepResults.push({
          run_id:             RUN_ID,
          task_id:            task.id,
          driver:             cell.driver,
          model_id:           cell.model_id,
          arm:                cell.arm,
          sweep_position:     cell.sweep_position,
          cell_id:            cell.cell_id,
          rep,
          oracle_pass:        oraclePass,
          oracle_passed:      oraclePassed,
          oracle_total:       oracleTotal,
          output_tokens:      outputTokens,
          input_tokens:       inputTokens,
          cache_read_tokens:  cacheReadTok,
          wall_ms:            wallMs,
          cost_usd_estimated: costUsd,
          dry_run:            DRY_RUN,
          // WI-479 engagement fields (always present for hooked arm)
          ...(cell.arm === "hooked" ? {
            tool_cycle_count:    toolCycles,
            hook_non_engaged:    hookNonEng,
            substitution_events: subEvents,
            stop_reason_final:   finalStopReason,
            force_tool_call:     FORCE_TOOL,
            prompt_variant:      PROMPT_VARIANT,
          } : {}),
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Aggregate
  // ---------------------------------------------------------------------------

  const resultsTable = buildResultsTable(cellRepResults, activeCells);

  const qualityLiftByDriver = {};
  for (const driver of activeDrivers) {
    qualityLiftByDriver[driver.short_name] = computeQualityLift(cellRepResults, driver.short_name);
  }
  const haikuLift = qualityLiftByDriver["haiku"] ?? { lift_count: 0, lift_rate: 0, task_count: 0 };

  const totalCostUsd = cellRepResults.reduce((s, r) => s + (r.cost_usd_estimated ?? 0), 0);

  const summary = {
    tier:                   TIER,
    run_id:                 RUN_ID,
    cells_per_task:         activeCells.length,
    total_calls_completed:  cellRepResults.length,
    total_cost_usd:         totalCostUsd,
    results_table:          resultsTable,
    quality_lift_by_driver: qualityLiftByDriver,
    killer_cell: {
      haiku_lift_count:    haikuLift.lift_count,
      haiku_lift_rate_pct: haikuLift.lift_rate * 100,
      note: "Fraction of tasks where hooked-Haiku passes and unhooked-Haiku fails.",
    },
    quality_lift_footnote:
      `Lift = fraction of tasks where hooked arm passes AND unhooked arm fails (same driver). ` +
      `Generous: any rep passing counts. (DEC-V0-B4-QUALITY-LIFT-001)`,
    directional_targets_note:
      "Pass-bar columns are directional targets only. No KILL conditions pre-data. " +
      "(DEC-V0-B4-SLICE2-MATRIX-002)",
    ...(budgetExceeded ? { partial_run_note: "Run stopped early: budget cap reached." } : {}),
  };

  // ---------------------------------------------------------------------------
  // Console output
  // ---------------------------------------------------------------------------

  const totalRuntimeMs = Date.now() - runStart;
  console.log("\n" + "=".repeat(70));
  console.log("MATRIX AGGREGATE RESULTS");
  console.log("=".repeat(70));
  console.log(`Mode:          ${DRY_RUN ? "DRY-RUN" : "REAL"}`);
  console.log(`Tier:          ${TIER.toUpperCase()}`);
  console.log(`Calls done:    ${cellRepResults.length} / ${estimatedTotalCalls}`);
  console.log(`Cost total:    $${totalCostUsd.toFixed(4)} USD`);
  console.log(`Runtime:       ${(totalRuntimeMs / 1000).toFixed(1)}s`);
  console.log();
  console.log("Quality Lift by Driver:");
  for (const [drv, stats] of Object.entries(qualityLiftByDriver)) {
    console.log(`  ${drv.padEnd(8)}: ${(stats.lift_rate * 100).toFixed(1)}% (${stats.lift_count}/${stats.task_count} tasks)`);
  }
  console.log(`Killer-cell (Haiku): ${haikuLift.lift_count} / ${haikuLift.task_count} tasks`);
  if (budgetExceeded) console.log("\nWARNING: Run stopped early — budget cap reached.");
  if (DRY_RUN) {
    console.log("\nNOTE: DRY-RUN. Token counts from fixtures/stubs, not real API.");
    console.log("      Oracle FAIL is expected for stub tasks — harness pipeline is proven.");
  }
  console.log();

  // ---------------------------------------------------------------------------
  // Write artifacts
  // ---------------------------------------------------------------------------

  const artifact = {
    benchmark: "B4-tokens-matrix",
    version:   "2.0.0",
    run_id:    RUN_ID,
    environment: {
      platform:    process.platform,
      arch:        process.arch,
      nodeVersion: process.version,
      runAt:       new Date().toISOString(),
      repoRoot:    REPO_ROOT,
      dryRun:      DRY_RUN,
    },
    config: {
      tier:          TIER,
      driverFilter:  DRIVER_FILTER,
      nReps:         N_REPS,
      nTasks:        tasks.length,
      nCellsPerTask: activeCells.length,
      totalCalls:    estimatedTotalCalls,
      costCapUsd:    SLICE2_CAP_USD,
      // WI-479 engagement investigation config
      forceToolCall: FORCE_TOOL,
      promptVariant: PROMPT_VARIANT,
      taskFilter:    TASK_FILTER ?? "all",
    },
    cells:         activeCells,
    summary,
    measurements:  cellRepResults,
    totalRuntimeMs,
  };

  writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2), "utf8");
  console.log(`Results JSON:  ${ARTIFACT_PATH}`);

  const md = buildMarkdownSummary(artifact);
  writeFileSync(SUMMARY_PATH, md, "utf8");
  console.log(`Summary MD:    ${SUMMARY_PATH}`);

  if (billingLog.rowCount > 0) {
    console.log(`Billing log:   ${billingLog.path} (${billingLog.rowCount} entries)`);
  }

  console.log("[B4] Done.");
}

main().catch((err) => {
  console.error("[B4] Fatal error:", err);
  process.exit(1);
});
