// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v4/harness/phase2-v4.mjs
//
// @decision DEC-BENCH-B4-V4-PHASE2-001
// @title B4-v4 Phase 2 runner — 6-cell matrix exploit with composite-atom corpus
// @status accepted
// @rationale
//   Mirrors B4-v3 phase2.mjs with v4 module references. The registry used here is
//   the one produced by phase1-v4.mjs, which contains BOTH fine-grained L0 atoms AND
//   whole-impl coarse atoms (DEC-B4-V4-CORPUS-COMPOSITE-001). The MCP server
//   (mcp-server.mjs, path-agnostic) serves both atom shapes transparently to hooked
//   cells. The experiment tests whether Haiku hooked (cell F) can use a whole-impl
//   coarse atom from the registry to solve a task it fails unhooked (cell E).
//
//   Invocation:
//     node bench/B4-tokens-v4/harness/phase2-v4.mjs --dry-run
//     node bench/B4-tokens-v4/harness/phase2-v4.mjs --cell=F --task=crc32c
//     node bench/B4-tokens-v4/harness/phase2-v4.mjs          (all cells, requires ANTHROPIC_API_KEY)
//     node bench/B4-tokens-v4/harness/phase2-v4.mjs --smoke   (cell E × 1 task × N=1)
//
//   Budget: $50 of $75 total (DEC-V0-B4-SLICE2-COST-CEILING-004)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, '..');
const REPO_ROOT = process.env['YAKCC_REPO_ROOT'] ?? resolve(__dirname, '../../..');
const RESULTS_DIR = join(BENCH_ROOT, 'results');
const MCP_SERVER_PATH = join(__dirname, 'mcp-server.mjs');

const YAKCC_REGISTRY_PATH = process.env['YAKCC_REGISTRY_PATH'];
if (!YAKCC_REGISTRY_PATH) {
  process.stderr.write(
    'ERROR [B4-v4 Phase 2]: YAKCC_REGISTRY_PATH is required.\n' +
    '  Set it to the per-run registry produced by phase1-v4.mjs:\n' +
    '    export YAKCC_REGISTRY_PATH=tmp/B4-tokens-v4/<run-id>/registry.sqlite\n',
  );
  process.exit(1);
}

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'dry-run': { type: 'boolean', default: false },
    'n-reps':  { type: 'string',  default: '3' },
    'task':    { type: 'string',  default: 'all' },
    'cell':    { type: 'string',  default: 'all' },
    'smoke':   { type: 'boolean', default: false },
  },
  strict: false,
});

const DRY_RUN = flags['dry-run'];
const SMOKE   = flags['smoke'] ?? false;
const N_REPS  = SMOKE ? 1 : parseInt(flags['n-reps'] ?? '3', 10);
const TASK_ID = SMOKE ? 'crc32c' : (flags['task'] ?? 'all');
const CELL_ID = SMOKE ? 'E'      : (flags['cell'] ?? 'all');

const PHASE2_CAP_USD = 50;
const MAX_TOOL_CYCLES = 5;

const { PHASE2_CELLS } = await import(
  new URL('file://' + join(__dirname, 'matrix-v4.mjs')).href
);
const { extractCode, runOracle } = await import(
  new URL('file://' + join(__dirname, 'oracle-runner.mjs')).href
);
const { BillingLog, estimateCostUsd } = await import(
  new URL('file://' + join(__dirname, 'billing.mjs')).href
);
const { BudgetTracker, BudgetExceededError } = await import(
  new URL('file://' + join(__dirname, 'budget.mjs')).href
);
const { verifyTaskManifest } = await import(
  new URL('file://' + join(__dirname, 'verify-v4.mjs')).href
);

const SYSTEM_PROMPT_VANILLA =
  'You are an expert TypeScript developer. When given a coding task, implement it in a ' +
  'single TypeScript file. Output only the implementation code in a ```typescript code ' +
  'block. Do not include explanation before or after the code block.';

const SYSTEM_PROMPT_HOOK_SUFFIX =
  '\n\nYou are working in a codebase that uses the yakcc registry for common atomic ' +
  'implementations. Before generating any code, query the atom registry for relevant ' +
  'primitives using the atom-lookup tool. Incorporate retrieved atoms into your solution ' +
  'rather than re-implementing them. When you call atom-lookup, pass specific behavioral ' +
  'intent text describing the primitive you need.';

const ATOM_LOOKUP_TOOL_DEF = {
  name: 'atom-lookup',
  description:
    'Query the yakcc atom registry for candidate implementations matching an intent. ' +
    'Returns atoms with atom_id, atom_signature, match_confidence, atom_body_sha256. ' +
    'Returns { atoms: [] } when no candidates match -- generate the implementation directly.',
  input_schema: {
    type: 'object',
    properties: {
      intent: { type: 'string', description: 'Behavioral description of the desired atom.' },
      substitution_aggressiveness: {
        type: 'string', enum: ['conservative', 'default', 'aggressive'],
        description: 'Threshold mode: conservative=0.95, default=0.7, aggressive=all.',
        default: 'default',
      },
    },
    required: ['intent'],
  },
};

async function startMcpServer() {
  const server = spawn('node', [MCP_SERVER_PATH], {
    cwd: REPO_ROOT,
    env: { ...process.env, YAKCC_REGISTRY_PATH, YAKCC_REPO_ROOT: REPO_ROOT },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  server.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) process.stdout.write(`    [MCP] ${msg}\n`);
  });

  let stdoutBuf = Buffer.alloc(0);
  const pending = new Map();
  let reqId = 100;

  server.stdout.on('data', (chunk) => {
    stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
    while (true) {
      const hEnd = stdoutBuf.indexOf('\r\n\r\n');
      if (hEnd === -1) break;
      const hText = stdoutBuf.slice(0, hEnd).toString('utf8');
      const m = hText.match(/Content-Length:\s*(\d+)/i);
      if (!m) { stdoutBuf = stdoutBuf.slice(hEnd + 4); break; }
      const cl = parseInt(m[1], 10);
      const bStart = hEnd + 4;
      if (stdoutBuf.length < bStart + cl) break;
      const body = stdoutBuf.slice(bStart, bStart + cl).toString('utf8');
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
      const body   = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
      server.stdin.write(header + body);
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }
      }, 10_000);
    });
  }

  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });

  return {
    async callTool(toolInput) {
      const resp = await request('tools/call', { name: 'atom-lookup', arguments: toolInput });
      if (resp.error) throw new Error(`MCP tool error: ${resp.error.message}`);
      const text = resp.result?.content?.[0]?.text ?? '{"atoms":[]}';
      return JSON.parse(text);
    },
    close() { server.kill('SIGTERM'); },
  };
}

async function main() {
  if (SMOKE) {
    console.log('B4-tokens-v4 Phase 2 — SMOKE TEST (1 task × cell E × N=1)');
  } else {
    console.log('B4-tokens-v4 Phase 2 — Corpus Exploit (6-cell matrix A–F, composite corpus)');
  }
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'REAL RUN'}`);
  console.log(`N_REPS: ${N_REPS}, Task filter: ${TASK_ID}, Cell filter: ${CELL_ID}`);
  console.log(`Budget cap: $${PHASE2_CAP_USD} USD`);
  console.log('');

  const manifest = JSON.parse(readFileSync(join(BENCH_ROOT, 'tasks.json'), 'utf8'));
  const tasks = manifest.tasks.filter(
    (t) => TASK_ID === 'all' || t.id === TASK_ID,
  );
  const cells = PHASE2_CELLS.filter(
    (c) => CELL_ID === 'all' || c.cell_id === CELL_ID.toUpperCase(),
  );

  if (tasks.length === 0) {
    console.error(`No tasks matched filter '${TASK_ID}'`);
    process.exit(1);
  }
  if (cells.length === 0) {
    console.error(`No cells matched filter '${CELL_ID}'`);
    process.exit(1);
  }

  const totalRuns = tasks.length * cells.length * N_REPS;
  console.log(`Planned: ${tasks.length} tasks × ${cells.length} cells × ${N_REPS} reps = ${totalRuns} runs`);

  if (DRY_RUN) {
    for (const task of tasks) {
      for (const cell of cells) {
        console.log(`[DRY RUN] Task=${task.id}  Cell=${cell.cell_id} (${cell.driver}:${cell.arm})  N=${N_REPS}`);
      }
    }
    console.log('');
    console.log(`[DRY RUN] ${totalRuns} total runs (no API calls). Phase 2 dry run complete.`);
    return;
  }

  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('ERROR: ANTHROPIC_API_KEY is required for Phase 2 runs.');
    process.exit(1);
  }

  if (!existsSync(YAKCC_REGISTRY_PATH)) {
    console.error(`ERROR: Registry not found: ${YAKCC_REGISTRY_PATH}\nRun phase1-v4.mjs first.`);
    process.exit(1);
  }

  verifyTaskManifest(manifest, BENCH_ROOT);

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });

  mkdirSync(RESULTS_DIR, { recursive: true });

  const runId = SMOKE
    ? `phase2-smoke-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
    : `phase2-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const resultsFile = join(RESULTS_DIR, `${runId}.json`);

  const budget = new BudgetTracker({ cap_usd: PHASE2_CAP_USD });
  const billingLog = new BillingLog({ dir: RESULTS_DIR, runId });

  const taskResults = [];
  let budgetExceeded = false;

  TASK_LOOP:
  for (const task of tasks) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Task: ${task.id}`);
    console.log('─'.repeat(60));

    const promptText = readFileSync(join(BENCH_ROOT, task.prompt_file), 'utf8');
    const cellResults = [];

    for (const cell of cells) {
      console.log(`\n  Cell: ${cell.cell_id} (${cell.driver}:${cell.arm})`);
      const isHooked = cell.arm === 'hooked';
      const systemPrompt = isHooked
        ? SYSTEM_PROMPT_VANILLA + SYSTEM_PROMPT_HOOK_SUFFIX
        : SYSTEM_PROMPT_VANILLA;
      const reps = [];

      for (let rep = 1; rep <= N_REPS; rep++) {
        console.log(`    rep ${rep}/${N_REPS}...`);

        const estCost = estimateCostUsd({ model_id: cell.model_id, input_tokens: 2000, output_tokens: 1000 });
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
        let toolCycles = 0;
        const substitutionEvents = [];

        if (isHooked) {
          try { mcpServer = await startMcpServer(); } catch (err) {
            console.error(`    [MCP] Server start failed: ${err.message}`);
          }
        }

        const startMs = Date.now();
        let response;
        try {
          const requestOpts = {
            model: cell.model_id, max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: promptText }],
            ...(isHooked ? { tools: [ATOM_LOOKUP_TOOL_DEF] } : {}),
          };
          response = await client.messages.create(requestOpts);

          if (isHooked && mcpServer) {
            const conv = [{ role: 'user', content: promptText }];
            while (response.stop_reason === 'tool_use' && toolCycles < MAX_TOOL_CYCLES) {
              toolCycles++;
              const toolUseBlocks = response.content.filter((c) => c.type === 'tool_use');
              const toolResultContents = [];
              for (const tu of toolUseBlocks) {
                let toolResult;
                try { toolResult = await mcpServer.callTool({ ...tu.input }); }
                catch (err) { console.warn(`    [MCP] Tool call failed: ${err.message}`); toolResult = { atoms: [] }; }
                substitutionEvents.push({ cycle: toolCycles, intent: tu.input?.intent ?? '', atoms_proposed: toolResult.atoms?.length ?? 0 });
                toolResultContents.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(toolResult) });
              }
              conv.push({ role: 'assistant', content: response.content });
              conv.push({ role: 'user', content: toolResultContents });
              response = await client.messages.create({ model: cell.model_id, max_tokens: 4096, system: systemPrompt, messages: conv, tools: [ATOM_LOOKUP_TOOL_DEF] });
            }
          }
        } catch (err) {
          if (mcpServer) mcpServer.close();
          console.error(`    ERROR: ${err.message}`);
          reps.push({ rep, cell_id: cell.cell_id, error: err.message });
          continue;
        }
        if (mcpServer) mcpServer.close();

        const wallMs = Date.now() - startMs;
        const inputTokens  = response.usage?.input_tokens  ?? 0;
        const outputTokens = response.usage?.output_tokens ?? 0;
        const costUsd = estimateCostUsd({ model_id: cell.model_id, input_tokens: inputTokens, output_tokens: outputTokens });
        budget.addSpend(costUsd);
        budget.logRollingSpend({ phase: 2, taskId: task.id, rep, callCost: costUsd });

        billingLog.append({
          run_id: runId, phase: 2, task_id: task.id, cell_id: cell.cell_id,
          driver: cell.driver, arm: cell.arm, model_id: cell.model_id, rep,
          input_tokens: inputTokens, output_tokens: outputTokens,
          cost_usd: costUsd, cumulative_cost_usd: budget.cumulativeUsd,
          wall_ms: wallMs, ts: new Date().toISOString(), tool_cycles: toolCycles,
        });

        const responseText = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        const generatedCode = extractCode(responseText);
        const oracle = await runOracle(task.id, generatedCode);

        console.log(
          `    Oracle: ${oracle.oracle_passed ? 'PASS' : 'FAIL'} ` +
          `(${oracle.oracle_pass_count}/${oracle.oracle_total}) | ` +
          `in=${inputTokens} out=${outputTokens} | $${costUsd.toFixed(4)}` +
          (isHooked ? ` | MCP cycles=${toolCycles}` : ''),
        );

        reps.push({
          rep, cell_id: cell.cell_id, driver: cell.driver, arm: cell.arm,
          input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: costUsd,
          wall_ms: wallMs, oracle_passed: oracle.oracle_passed,
          oracle_pass_count: oracle.oracle_pass_count, oracle_total: oracle.oracle_total,
          oracle_failures: oracle.oracle_failures,
          tool_cycles: toolCycles, substitution_events: substitutionEvents,
        });
      }

      cellResults.push({ cell_id: cell.cell_id, driver: cell.driver, arm: cell.arm, model_id: cell.model_id, reps });
    }

    taskResults.push({ task_id: task.id, cells: cellResults });
  }

  const summary = {
    run_id: runId, phase: 2, smoke: SMOKE,
    n_tasks: tasks.length, n_cells: cells.length, n_reps: N_REPS,
    total_cost_usd: budget.cumulativeUsd, cap_usd: PHASE2_CAP_USD,
    completed_at: new Date().toISOString(),
    ...(budgetExceeded ? { partial_run_note: 'Run stopped early: budget cap reached.' } : {}),
    tasks: taskResults,
  };
  writeFileSync(resultsFile, JSON.stringify(summary, null, 2), 'utf8');
  console.log('');
  console.log(`Phase 2 complete. Total cost: $${budget.cumulativeUsd.toFixed(4)}`);
  console.log(`Results: ${resultsFile}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
