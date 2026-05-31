// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/harness/phase2-v5.mjs
//
// @decision DEC-BENCH-B4-V5-PHASE2-001
// @title B4-v5 Phase 2 runner -- production-path instrumented re-measurement
// @status accepted
// @rationale
//   Forked from bench/B4-tokens-v4/harness/phase2-v4.mjs.
//   Production-path upgrades (PROTOCOL.md s1):
//     U1: yakcc_resolve tool with production confidence-tier envelope
//     U2: Real discovery system prompt from docs/system-prompts/yakcc-discovery.md
//     U3: #954 miss-path -- model emits triplet on no_candidates
//     U4: Honest substitution oracle on auto_accept
//     U5: Reuses v4 Opus-built corpus registry (DEC-BENCH-B4-V5-CORPUS-001)
//   REQ-TOKENS: per-turn usage summed across ALL turns (fixes v4 undercount bug).
//   DEC-BENCH-B4-V5-RESOLVE-SERVER-001: spawn production @yakcc/mcp-registry server.
//   DEC-BENCH-B4-V5-PROMPT-CACHE-001: measure cache_off and cache_on sub-conditions.
//
// Invocation:
//   node harness/phase2-v5.mjs --dry-run
//   YAKCC_REGISTRY_PATH=... node harness/phase2-v5.mjs
//   node harness/phase2-v5.mjs --cell=F --task=crc32c
//   node harness/phase2-v5.mjs --smoke

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, "..");
const REPO_ROOT = process.env.YAKCC_REPO_ROOT ?? resolve(__dirname, "../../..");
const RESULTS_DIR = join(BENCH_ROOT, "results");

// Production mcp-registry binary path (DEC-BENCH-B4-V5-RESOLVE-SERVER-001)
const PRODUCTION_MCP_REGISTRY_JS = join(REPO_ROOT, "packages", "mcp-registry", "dist", "index.js");

// Lazy-load harness modules
const { PHASE2_CELLS } = await import(new URL(`file://${join(__dirname, "matrix-v5.mjs")}`).href);
const { extractCode, runOracle, runOracleOnFile } = await import(
  new URL(`file://${join(__dirname, "oracle-runner.mjs")}`).href
);
const { fetchAtomImplSource, countRegistryAtoms } = await import(
  new URL(`file://${join(__dirname, "atom-fetch.mjs")}`).href
);
const { BillingLog, estimateCostUsd } = await import(
  new URL(`file://${join(__dirname, "billing.mjs")}`).href
);
const { BudgetTracker, BudgetExceededError, V5_CAP_USD } = await import(
  new URL(`file://${join(__dirname, "budget.mjs")}`).href
);
const { verifyTaskManifest } = await import(
  new URL(`file://${join(__dirname, "verify-v5.mjs")}`).href
);
const { TraceWriter, deriveMetrics } = await import(
  new URL(`file://${join(__dirname, "telemetry-v5.mjs")}`).href
);

// CLI flags
const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    "n-reps": { type: "string", default: "3" },
    task: { type: "string", default: "all" },
    cell: { type: "string", default: "all" },
    smoke: { type: "boolean", default: false },
  },
  strict: false,
});

const DRY_RUN = flags["dry-run"];
const SMOKE = flags.smoke ?? false;
const N_REPS = SMOKE ? 1 : Number.parseInt(flags["n-reps"] ?? "3", 10);
const TASK_ID = SMOKE ? "crc32c" : (flags.task ?? "all");
const CELL_ID = SMOKE ? "E" : (flags.cell ?? "all");

const PHASE2_CAP_USD = V5_CAP_USD;
const MAX_TOOL_CYCLES = 5;
const MAX_TOKENS = 4096;
const TEMPERATURE = 1.0;

// U2: Real discovery system prompt (PROTOCOL.md s1 U2)
const DISCOVERY_PROMPT_PATH = join(REPO_ROOT, "docs", "system-prompts", "yakcc-discovery.md");
if (!existsSync(DISCOVERY_PROMPT_PATH)) {
  process.stderr.write(`ERROR: Discovery prompt not found: ${DISCOVERY_PROMPT_PATH}\n`);
  process.exit(1);
}
const DISCOVERY_PROMPT_TEXT = readFileSync(DISCOVERY_PROMPT_PATH, "utf8");
const DISCOVERY_PROMPT_HASH = createHash("sha256").update(DISCOVERY_PROMPT_TEXT).digest("hex");

const SYSTEM_PROMPT_VANILLA =
  "You are an expert TypeScript developer. When given a coding task, implement it in a " +
  "single TypeScript file. Output only the implementation code in a ```typescript code " +
  "block. Do not include explanation before or after the code block.";

// U1: yakcc_resolve tool definition -- name matches production resolve.ts
const YAKCC_RESOLVE_TOOL_DEF = {
  name: "yakcc_resolve",
  description: [
    "Discover yakcc atoms that match the agent's intent BEFORE emitting code.",
    "The returned confidence_tier tells you what to do next:",
    "  - 'auto_accept' => emit `yakcc compile <atom_id>` and skip writing the code.",
    "  - 'candidate_list' => review candidates; pick one or emit a full triplet.",
    "  - 'no_candidates' => emit a fully-formed atom triplet for a novel atom.",
  ].join("\n"),
  input_schema: {
    type: "object",
    required: ["intent"],
    properties: {
      intent: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string", minLength: 1 },
          description: { type: "string" },
          signature: { type: "string" },
          examples: { type: "array", items: { type: "string" } },
        },
      },
      limit: { type: "number", minimum: 1, maximum: 100, default: 10 },
    },
  },
};

// Production MCP server spawner (DEC-BENCH-B4-V5-RESOLVE-SERVER-001)
async function startProductionMcpServer(yakccRegistryPath) {
  if (!existsSync(PRODUCTION_MCP_REGISTRY_JS)) {
    throw new Error(
      `Production mcp-registry dist not found: ${PRODUCTION_MCP_REGISTRY_JS}\nRun: pnpm -r build (from repo root)`,
    );
  }

  const server = spawn("node", [PRODUCTION_MCP_REGISTRY_JS], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      YAKCC_REGISTRY_PATH: yakccRegistryPath,
      YAKCC_REPO_ROOT: REPO_ROOT,
      YAKCC_AIRGAPPED: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  server.stderr.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg && process.env.YAKCC_DEBUG === "1") process.stdout.write(`    [MCP-PROD] ${msg}\n`);
  });

  // NDJSON transport: MCP SDK v1.29+ uses newline-delimited JSON (not Content-Length framing).
  let stdoutNdjson = "";
  const pending = new Map();
  let reqId = 200;

  server.stdout.on("data", (chunk) => {
    stdoutNdjson += chunk.toString("utf8");
    for (;;) {
      const nl = stdoutNdjson.indexOf("\n");
      if (nl === -1) break;
      const line = stdoutNdjson.slice(0, nl).trim();
      stdoutNdjson = stdoutNdjson.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const res = pending.get(msg.id);
        if (res) {
          pending.delete(msg.id);
          res(msg);
        }
      } catch (_) {}
    }
  });

  function mcpRequest(method, params) {
    const id = reqId++;
    return new Promise((res, rej) => {
      pending.set(id, res);
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rej(new Error(`MCP timeout: ${method}`));
        }
      }, 15_000);
    });
  }

  await mcpRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "phase2-v5", version: "0.0.1" },
  });
  // Required initialized notification (MCP SDK v1.29+ protocol)
  server.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );

  const toolsListResp = await mcpRequest("tools/list", {});
  const resolveToolDef =
    toolsListResp.result?.tools?.find((t) => t.name === "yakcc_resolve") ?? null;
  const toolSchemaVersion = resolveToolDef
    ? createHash("sha256")
        .update(
          JSON.stringify({ name: resolveToolDef.name, inputSchema: resolveToolDef.inputSchema }),
        )
        .digest("hex")
        .slice(0, 16)
    : "unknown";

  return {
    toolSchemaVersion,
    async callResolve(intentCard) {
      const resp = await mcpRequest("tools/call", {
        name: "yakcc_resolve",
        arguments: { intent: intentCard },
      });
      if (resp.error) throw new Error(`MCP tool error: ${JSON.stringify(resp.error)}`);
      const text =
        resp.result?.content?.[0]?.text ??
        '{"confidence_tier":"no_candidates","candidates":[],"airgapped":true}';
      try {
        return JSON.parse(text);
      } catch (_) {
        return { confidence_tier: "no_candidates", candidates: [], airgapped: true };
      }
    },
    close() {
      server.kill("SIGTERM");
    },
  };
}

// Dry-run cost projection (DEC-BENCH-B4-V5-COST-GATE-001)
function printDryRunPlan(tasks, cells, nReps) {
  console.log("\n=== B4-v5 Dry-Run Cost Projection ===\n");
  const UNHOOKED_EST = { input_tokens: 2000, output_tokens: 1000 };
  const HOOKED_EST = { input_tokens: 3500, output_tokens: 2000 };
  let grandTotal = 0;
  const rows = [];
  for (const cell of cells) {
    const isHooked = cell.arm === "hooked";
    const est = isHooked ? HOOKED_EST : UNHOOKED_EST;
    const costPerRep = estimateCostUsd({ model_id: cell.model_id, ...est });
    const totalRuns = tasks.length * nReps;
    const cellCost = costPerRep * totalRuns;
    grandTotal += cellCost;
    rows.push([
      cell.cell_id.padEnd(4),
      cell.driver.padEnd(8),
      cell.arm.padEnd(10),
      cell.cache_condition.padEnd(10),
      String(totalRuns).padEnd(5),
      `$${costPerRep.toFixed(4)}`.padEnd(10),
      `$${cellCost.toFixed(4)}`,
    ]);
  }
  console.log("Cell Model    Arm        Cache      Runs  CostPerRep CellTotal");
  console.log("-".repeat(72));
  for (const r of rows) console.log(r.join(" "));
  console.log("-".repeat(72));
  console.log(`Grand total estimate: $${grandTotal.toFixed(4)}  (cap: $${PHASE2_CAP_USD})`);
  console.log(
    `Matrix: ${tasks.length} tasks x ${cells.length} cells x ${nReps} reps = ${tasks.length * cells.length * nReps} runs`,
  );
  console.log("\nREMINDER: ZERO API calls made in --dry-run mode.");
  console.log("Operator must confirm budget before live run (DEC-BENCH-B4-V5-COST-GATE-001).\n");
}

// Main
async function main() {
  console.log("B4-tokens-v5 Phase 2 -- Production-Path Instrumented Re-Measurement");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN ($0)" : "REAL RUN"}`);
  console.log(`N_REPS=${N_REPS}  Task=${TASK_ID}  Cell=${CELL_ID}`);
  console.log(`Discovery prompt: ${DISCOVERY_PROMPT_PATH}`);
  console.log(`prompt_version_hash: ${DISCOVERY_PROMPT_HASH.slice(0, 16)}...`);
  console.log(`Budget cap: $${PHASE2_CAP_USD}`);
  console.log("");

  const manifest = JSON.parse(readFileSync(join(BENCH_ROOT, "tasks.json"), "utf8"));
  const tasks = manifest.tasks.filter((t) => TASK_ID === "all" || t.id === TASK_ID);
  const cells = PHASE2_CELLS.filter(
    (c) => CELL_ID === "all" || c.cell_id === CELL_ID.toUpperCase(),
  );

  if (tasks.length === 0) {
    console.error(`No tasks matched '${TASK_ID}'`);
    process.exit(1);
  }
  if (cells.length === 0) {
    console.error(`No cells matched '${CELL_ID}'`);
    process.exit(1);
  }

  console.log(
    `Planned: ${tasks.length} tasks x ${cells.length} cells x ${N_REPS} reps = ${tasks.length * cells.length * N_REPS} runs`,
  );

  if (DRY_RUN) {
    printDryRunPlan(tasks, cells, N_REPS);
    for (const task of tasks) {
      for (const cell of cells) {
        console.log(
          `[DRY RUN] Task=${task.id}  Cell=${cell.cell_id} (${cell.driver}:${cell.arm}:${cell.cache_condition})  N=${N_REPS}`,
        );
      }
    }
    console.log(
      `\n[DRY RUN] ${tasks.length * cells.length * N_REPS} runs planned. $0 spent. Awaiting operator approval.\n`,
    );
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ERROR: ANTHROPIC_API_KEY is required for live runs.");
    process.exit(1);
  }

  const YAKCC_REGISTRY_PATH = process.env.YAKCC_REGISTRY_PATH;
  if (!YAKCC_REGISTRY_PATH) {
    console.error("ERROR: YAKCC_REGISTRY_PATH is required. Set it to the v4 Opus-built registry.");
    process.exit(1);
  }
  if (!existsSync(YAKCC_REGISTRY_PATH)) {
    console.error(`ERROR: Registry not found: ${YAKCC_REGISTRY_PATH}`);
    process.exit(1);
  }

  verifyTaskManifest(manifest, BENCH_ROOT);

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  mkdirSync(RESULTS_DIR, { recursive: true });

  const runId = SMOKE
    ? `phase2-v5-smoke-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`
    : `phase2-v5-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const resultsFile = join(RESULTS_DIR, `${runId}.json`);

  const budget = new BudgetTracker({ cap_usd: PHASE2_CAP_USD });
  const billingLog = new BillingLog({ dir: RESULTS_DIR, runId });
  const traceWriter = new TraceWriter({ dir: RESULTS_DIR, runId });

  const taskResults = [];
  let budgetExceeded = false;

  TASK_LOOP: for (const task of tasks) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Task: ${task.id}`);
    console.log("─".repeat(60));
    const promptText = readFileSync(join(BENCH_ROOT, task.prompt_file), "utf8");
    const cellResults = [];

    for (const cell of cells) {
      console.log(`\n  Cell: ${cell.cell_id} (${cell.driver}:${cell.arm}:${cell.cache_condition})`);
      const isHooked = cell.arm === "hooked";
      const cacheOn = cell.cache_condition === "cache_on";
      const reps = [];

      for (let rep = 1; rep <= N_REPS; rep++) {
        console.log(`    rep ${rep}/${N_REPS}...`);

        const estCost = estimateCostUsd({
          model_id: cell.model_id,
          input_tokens: 3500,
          output_tokens: 2000,
        });
        try {
          budget.checkBeforeCall(estCost);
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            console.error(`\n[BUDGET] ${err.message}`);
            budgetExceeded = true;
            break TASK_LOOP;
          }
          throw err;
        }

        let mcpServer = null;
        let toolSchemaVersion = "none";
        if (isHooked) {
          try {
            mcpServer = await startProductionMcpServer(YAKCC_REGISTRY_PATH);
            toolSchemaVersion = mcpServer.toolSchemaVersion;
          } catch (err) {
            console.error(`    [MCP] Server start failed: ${err.message}`);
          }
        }

        // Build system prompt (DEC-BENCH-B4-V5-PROMPT-CACHE-001)
        let systemPromptContent;
        if (!isHooked) {
          systemPromptContent = SYSTEM_PROMPT_VANILLA;
        } else if (cacheOn) {
          systemPromptContent = [
            { type: "text", text: DISCOVERY_PROMPT_TEXT, cache_control: { type: "ephemeral" } },
          ];
        } else {
          systemPromptContent = DISCOVERY_PROMPT_TEXT;
        }

        const systemPromptHash = isHooked
          ? DISCOVERY_PROMPT_HASH
          : createHash("sha256").update(SYSTEM_PROMPT_VANILLA).digest("hex");

        // REQ-TOKENS: collect ALL turns (v4 fix -- v4 only logged the final turn)
        const allTurns = [];
        let toolCycles = 0;
        const repStartMs = Date.now();
        const messages = [{ role: "user", content: promptText }];

        const baseRequestOpts = {
          model: cell.model_id,
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          system: systemPromptContent,
          ...(isHooked ? { tools: [YAKCC_RESOLVE_TOOL_DEF] } : {}),
        };

        try {
          let turnIndex = 0;
          let turnStartMs = Date.now();
          let response = await client.messages.create({ ...baseRequestOpts, messages });
          let turnWallMs = Date.now() - turnStartMs;

          const recordTurn = (r, toolResults = []) => {
            const line = {
              run_id: runId,
              task_id: task.id,
              cell_id: cell.cell_id,
              model_id: cell.model_id,
              arm: cell.arm,
              rep,
              turn_index: turnIndex,
              request: {
                system_prompt_hash: systemPromptHash.slice(0, 16),
                tools_present: isHooked,
                max_tokens: MAX_TOKENS,
                temperature: TEMPERATURE,
                messages_digest: createHash("sha256")
                  .update(JSON.stringify(messages))
                  .digest("hex")
                  .slice(0, 16),
              },
              response: {
                stop_reason: r.stop_reason,
                content_blocks: r.content,
                usage: {
                  input_tokens: r.usage?.input_tokens ?? 0,
                  output_tokens: r.usage?.output_tokens ?? 0,
                  cache_read_input_tokens: r.usage?.cache_read_input_tokens ?? 0,
                  cache_creation_input_tokens: r.usage?.cache_creation_input_tokens ?? 0,
                },
              },
              tool_results: toolResults,
              wall_ms: turnWallMs,
              ts: new Date().toISOString(),
            };
            allTurns.push(line);
            traceWriter.appendTurn(line);
          };

          recordTurn(response);

          while (
            response.stop_reason === "tool_use" &&
            isHooked &&
            mcpServer &&
            toolCycles < MAX_TOOL_CYCLES
          ) {
            toolCycles++;
            turnIndex++;

            const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
            const toolResultConts = [];
            const toolResultsLog = [];

            for (const tu of toolUseBlocks) {
              let envelope;
              try {
                const intentArg = tu.input?.intent ?? tu.input ?? {};
                envelope = await mcpServer.callResolve(intentArg);
              } catch (err) {
                console.warn(`    [MCP] resolve failed: ${err.message}`);
                envelope = { confidence_tier: "no_candidates", candidates: [], airgapped: true };
              }
              toolResultConts.push({
                type: "tool_result",
                tool_use_id: tu.id,
                content: JSON.stringify(envelope),
              });
              toolResultsLog.push({
                tool_use_id: tu.id,
                intent: tu.input?.intent?.title ?? "",
                envelope,
              });
            }

            messages.push({ role: "assistant", content: response.content });
            messages.push({ role: "user", content: toolResultConts });

            turnStartMs = Date.now();
            response = await client.messages.create({ ...baseRequestOpts, messages });
            turnWallMs = Date.now() - turnStartMs;
            recordTurn(response, toolResultsLog);
          }
        } catch (err) {
          if (mcpServer) mcpServer.close();
          console.error(`    ERROR: ${err.message}`);
          reps.push({ rep, cell_id: cell.cell_id, error: err.message });
          continue;
        }
        if (mcpServer) mcpServer.close();

        const repWallMs = Date.now() - repStartMs;

        // REQ-TOKENS: sum across ALL turns (the v4 fix)
        let totalInput = 0;
        let totalOutput = 0;
        let totalCacheRd = 0;
        let totalCacheCr = 0;
        for (const t of allTurns) {
          totalInput += t.response.usage.input_tokens;
          totalOutput += t.response.usage.output_tokens;
          totalCacheRd += t.response.usage.cache_read_input_tokens;
          totalCacheCr += t.response.usage.cache_creation_input_tokens;
        }

        const costUsd = estimateCostUsd({
          model_id: cell.model_id,
          input_tokens: totalInput,
          output_tokens: totalOutput,
          cache_read_input_tokens: totalCacheRd,
          cache_creation_input_tokens: totalCacheCr,
        });
        budget.addSpend(costUsd);
        budget.logRollingSpend({ phase: 2, taskId: task.id, rep, callCost: costUsd });

        billingLog.append({
          run_id: runId,
          phase: 2,
          task_id: task.id,
          cell_id: cell.cell_id,
          driver: cell.driver,
          arm: cell.arm,
          model_id: cell.model_id,
          cache_condition: cell.cache_condition,
          rep,
          input_tokens: totalInput,
          output_tokens: totalOutput,
          cache_read_input_tokens: totalCacheRd,
          cache_creation_input_tokens: totalCacheCr,
          cost_usd: costUsd,
          cumulative_cost_usd: budget.cumulativeUsd,
          wall_ms: repWallMs,
          ts: new Date().toISOString(),
          tool_cycles: toolCycles,
        });

        const derived = deriveMetrics({ turns: allTurns, arm: cell.arm });

        // Oracle (U4: honest substitution oracle + standard oracle)
        const lastBlocks = allTurns[allTurns.length - 1].response.content_blocks ?? [];
        const allText = lastBlocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        const compileAtomId = allText.match(/yakcc\s+compile\s+([\w\-./:@]+)/)?.[1] ?? null;

        // U4: Honest substitution oracle (DEC-BENCH-B4-V5-ATOM-FETCH-001)
        // When model emits `yakcc compile <atom_id>`, fetch the real impl body from
        // the registry SQLite (same SELECT as storage.ts#getBlock) and run the oracle
        // on it.  A stub comment caused every auto_accept rep to be mislabeled
        // `substituted_but_failed`, corrupting the hot-hit category.
        let oracle;
        if (compileAtomId && derived.tier_returned === "auto_accept") {
          derived.substituted = true;
          derived.substituted_atom_id = compileAtomId;

          const fetchResult = fetchAtomImplSource(YAKCC_REGISTRY_PATH, compileAtomId);
          if (fetchResult.error) {
            // Explicit failure — never silently pass or fail (DEC-BENCH-B4-V5-ATOM-FETCH-001).
            derived.failure_class = fetchResult.failure_class ?? "atom_fetch_failed";
            derived.substitution_fetch_error = fetchResult.error;
            oracle = {
              oracle_passed: false,
              oracle_pass_count: 0,
              oracle_total: 0,
              oracle_failures: [fetchResult.error],
              stdout: "",
              stderr: "",
              exitCode: null,
              error: fetchResult.error,
            };
          } else {
            // Write fetched impl to tmp/ and run the real oracle on it.
            const scratchDir = join(REPO_ROOT, "tmp", "B4-tokens-v5", "oracle-scratch");
            mkdirSync(scratchDir, { recursive: true });
            const atomHash = createHash("sha256").update(compileAtomId).digest("hex").slice(0, 12);
            const implFile = join(scratchDir, `subst-${task.id}-${atomHash}.ts`);
            writeFileSync(implFile, fetchResult.implSource, "utf8");
            oracle = await runOracleOnFile(task.id, implFile);
            try {
              rmSync(implFile);
            } catch (_) {}
          }
          derived.substitution_oracle_passed = oracle.oracle_passed;
          if (!oracle.oracle_passed && !derived.failure_class) {
            derived.failure_class = "substituted_but_failed";
          }
        } else {
          const generatedCode = extractCode(allText);
          oracle = await runOracle(task.id, generatedCode || "// no code found");
        }

        // Triplet miss-path (U3: #954)
        if (derived.tier_returned === "no_candidates") {
          const hasTripletMarkers = /spec\.yak|impl\.ts|proof\/|emit-atom/.test(allText);
          derived.triplet_wellformed = hasTripletMarkers;
          derived.triplet_emit_exit_code = hasTripletMarkers ? 0 : 1;
          derived.triplet_oracle_passed = hasTripletMarkers ? oracle.oracle_passed : false;
          if (!hasTripletMarkers) derived.failure_class = "triplet_malformed";
        }

        // Fix 3: populate registry_atom_count (PROTOCOL.md §3.4 — was always missing)
        const registryAtomCount = isHooked ? countRegistryAtoms(YAKCC_REGISTRY_PATH) : null;
        traceWriter.appendRepMeta({
          run_id: runId,
          task_id: task.id,
          cell_id: cell.cell_id,
          model_id: cell.model_id,
          arm: cell.arm,
          rep,
          cache_condition: cell.cache_condition,
          prompt_version_hash: DISCOVERY_PROMPT_HASH,
          registry_path: YAKCC_REGISTRY_PATH,
          registry_atom_count: registryAtomCount,
          tool_schema_version: toolSchemaVersion,
          temperature: TEMPERATURE,
          max_tokens: MAX_TOKENS,
          airgapped: true,
          prompt_caching_enabled: cacheOn,
          harness_git_sha: process.env.HARNESS_GIT_SHA ?? "unknown",
        });

        console.log(
          `    Oracle: ${oracle.oracle_passed ? "PASS" : "FAIL"} (${oracle.oracle_pass_count}/${oracle.oracle_total}) | in=${totalInput} out=${totalOutput} turns=${allTurns.length} | $${costUsd.toFixed(4)}${isHooked ? ` | MCP=${toolCycles} tier=${derived.tier_returned}` : ""}`,
        );

        reps.push({
          rep,
          cell_id: cell.cell_id,
          driver: cell.driver,
          arm: cell.arm,
          cache_condition: cell.cache_condition,
          input_tokens: totalInput,
          output_tokens: totalOutput,
          cache_read_input_tokens: totalCacheRd,
          cache_creation_input_tokens: totalCacheCr,
          cost_usd: costUsd,
          wall_ms: repWallMs,
          turns_count: allTurns.length,
          tool_cycles: toolCycles,
          oracle_passed: oracle.oracle_passed,
          oracle_pass_count: oracle.oracle_pass_count,
          oracle_total: oracle.oracle_total,
          oracle_failures: oracle.oracle_failures,
          derived,
        });
      }

      cellResults.push({
        cell_id: cell.cell_id,
        driver: cell.driver,
        arm: cell.arm,
        model_id: cell.model_id,
        cache_condition: cell.cache_condition,
        reps,
      });
    }

    taskResults.push({ task_id: task.id, cells: cellResults });
  }

  const summary = {
    run_id: runId,
    phase: 2,
    smoke: SMOKE,
    n_tasks: tasks.length,
    n_cells: cells.length,
    n_reps: N_REPS,
    total_cost_usd: budget.cumulativeUsd,
    cap_usd: PHASE2_CAP_USD,
    discovery_prompt_hash: DISCOVERY_PROMPT_HASH,
    completed_at: new Date().toISOString(),
    ...(budgetExceeded ? { partial_run_note: "Run stopped early: budget cap reached." } : {}),
    tasks: taskResults,
  };
  writeFileSync(resultsFile, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\nPhase 2 complete. Total cost: $${budget.cumulativeUsd.toFixed(4)}`);
  console.log(`Results: ${resultsFile}`);
  console.log(`Trace:   ${traceWriter.path}`);
  console.log(`Billing: ${billingLog.path}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
