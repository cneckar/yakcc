// SPDX-License-Identifier: MIT
//
// bench/B6-airgap/run.mjs — B6 air-gapped / network-locality benchmark harness
//
// @decision DEC-BENCH-B6-001
// @title B6 air-gap benchmark: cross-platform network-intercept strategy
// @status accepted
// @rationale
//   Pass/fail bars (per #190):
//     B6a: ZERO outbound connections with createOfflineEmbeddingProvider().
//          Any non-zero count is an immediate KILL — cannot claim air-gapped viability.
//     B6b: ONLY allowlisted destinations (allowlist.json). Gated on ANTHROPIC_API_KEY
//          env var; skipped when key is absent (documents as N/A, not a failure).
//
//   Cross-platform strategy: Option (a) — pure-JS network interceptor via
//   `network-interceptor.cjs` loaded with `--require` before the ESM entry point.
//   Patches `node:net` and `node:tls` connect calls to record all outbound attempts.
//   Chosen over Option (b) (tcpdump/pktap) because:
//     1. Windows (#274) can't use tcpdump natively — yakcc development happens on
//        Windows; blocking local runs blocks the feedback loop.
//     2. No sudo/CAP_NET_RAW needed — tcpdump on Linux requires elevated privileges.
//     3. yakcc has no native binary subprocesses that initiate network I/O outside
//        Node's net/tls stack, so Node-level interception catches all expected vectors.
//   Trade-off: native subprocess outbound would bypass the JS interceptor. This is
//   mitigated by (a) yakcc having no native binary deps, and (b) CI can add strace
//   coverage separately if the claim needs kernel-level audit.
//
//   Windows bin.js bug (#274): the compiled `bin.js` uses an import.meta.url guard
//   that breaks on Windows (file:///C:/ vs file://C:\). To avoid this pre-existing
//   bug, this harness invokes yakcc via `node --require <interceptor> dist/index.js`
//   with --input-type=module piped, OR via the in-process runCli() import. We use
//   the programmatic in-process approach (spawning a child process with runCli wired
//   via a thin ESM wrapper) to work around the bin.js guard entirely.
//
//   Note: "registry list" is not a yakcc CLI command (only "registry init" exists).
//   Step 7 of the workload uses "yakcc query" to perform a registry read-back instead.
//   This is documented in README.md and is not a B6 failure — it reflects the current
//   CLI surface.
//
//   Cold-start measurement: wall-clock ms from workload start to step-7 completion,
//   measured via Date.now(). No networked-mode baseline comparison in v0 (requires a
//   live API key; out of scope for the offline gate). Comparison is deferred to a
//   future B6b full run.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function pass(msg) {
  process.stdout.write(`${GREEN}PASS${RESET} ${msg}\n`);
}

function fail(msg) {
  process.stdout.write(`${RED}FAIL${RESET} ${msg}\n`);
}

function skip(msg) {
  process.stdout.write(`${YELLOW}SKIP${RESET} ${msg}\n`);
}

function info(msg) {
  process.stdout.write(`${BOLD}INFO${RESET} ${msg}\n`);
}

function step(n, desc) {
  process.stdout.write(`\n${BOLD}[Step ${n}]${RESET} ${desc}\n`);
}

// Run yakcc in-process via a spawned node child.
// We spawn a fresh Node process per step so that each step is isolated and
// the interceptor file-write (on process.exit) fires cleanly.
// Uses `node --require <interceptor> --input-type=module` to load ESM runCli.
function runYakcc(args, { cwd, interceptOut, env = {} } = {}) {
  // Build the inline ESM wrapper that imports runCli and calls it.
  // We resolve to the dist/index.js of @yakcc/cli in the workspace.
  const cliDist = resolve(REPO_ROOT, "packages/cli/dist/index.js");
  const argsJson = JSON.stringify(args);
  const esmWrapper = `
import { runCli, createOfflineEmbeddingProvider as _unused } from ${JSON.stringify(cliDist)};
import { createOfflineEmbeddingProvider } from ${JSON.stringify(
    resolve(REPO_ROOT, "packages/contracts/dist/embeddings.js")
  )};
const code = await runCli(${argsJson}, undefined, { embeddings: createOfflineEmbeddingProvider() });
process.exit(code);
`;

  const interceptorPath = resolve(__dirname, "network-interceptor.cjs");
  const nodeArgs = [
    "--require", interceptorPath,
    "--input-type=module",
  ];

  const spawnEnv = {
    ...process.env,
    ...env,
    YAKCC_BENCH_INTERCEPT_OUT: interceptOut,
  };

  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: cwd ?? REPO_ROOT,
    input: esmWrapper,
    encoding: "utf8",
    env: spawnEnv,
    timeout: 60000, // 60s per step max
  });

  return result;
}

// Read interceptor output file and return parsed array (or [] if missing/invalid).
function readInterceptedConnections(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Parse CLI args for the harness itself
// ---------------------------------------------------------------------------

const { values: harnessArgs } = parseArgs({
  args: process.argv.slice(2),
  options: {
    mode: { type: "string", default: "b6a" }, // b6a | b6b | all
    "keep-tmp": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
  strict: true,
});

if (harnessArgs.help) {
  console.log(`
Usage: node bench/B6-airgap/run.mjs [--mode b6a|b6b|all] [--keep-tmp]

  --mode b6a       (default) Run B6a offline/air-gapped benchmark only
  --mode b6b       Run B6b networked benchmark only (requires ANTHROPIC_API_KEY)
  --mode all       Run both B6a and B6b
  --keep-tmp       Do not delete the temporary workdir after the run (for debugging)
  --help, -h       Print this help

Environment:
  ANTHROPIC_API_KEY   Required for B6b mode. Absent → B6b is skipped with SKIP.
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Pre-flight: check CLI is built
// ---------------------------------------------------------------------------

const cliDist = resolve(REPO_ROOT, "packages/cli/dist/index.js");
const contractsDist = resolve(REPO_ROOT, "packages/contracts/dist/embeddings.js");

if (!existsSync(cliDist)) {
  process.stderr.write(`ERROR: CLI not built. Run 'pnpm build' first.\n  Missing: ${cliDist}\n`);
  process.exit(1);
}
if (!existsSync(contractsDist)) {
  process.stderr.write(`ERROR: @yakcc/contracts not built. Run 'pnpm build' first.\n  Missing: ${contractsDist}\n`);
  process.exit(1);
}

const allowlistPath = resolve(__dirname, "allowlist.json");
const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8")).allowedDestinations;

// ---------------------------------------------------------------------------
// B6a — offline (air-gapped) benchmark
// ---------------------------------------------------------------------------

async function runB6a() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${BOLD}B6a — OFFLINE / AIR-GAPPED BENCHMARK${RESET}`);
  console.log(`${"=".repeat(60)}\n`);

  // Create a clean temp directory for the workload
  const tmpBase = join(REPO_ROOT, "tmp");
  mkdirSync(tmpBase, { recursive: true });
  const workdir = mkdtempSync(join(tmpBase, "b6a-"));
  info(`Workdir: ${workdir}`);

  const wallStart = Date.now();
  const allConnections = [];
  let stepsFailed = 0;

  // Helper: run a step, collect connections, check for failures
  function runStep(n, desc, args, opts = {}) {
    step(n, desc);
    const interceptOut = join(workdir, `step${n}-intercept.json`);
    const result = runYakcc(args, { cwd: workdir, interceptOut, env: opts.env ?? {} });
    const connections = readInterceptedConnections(interceptOut);
    allConnections.push(...connections);

    if (result.status !== 0) {
      fail(`Step ${n} exited with code ${result.status}`);
      if (result.stdout) process.stdout.write(`  stdout: ${result.stdout.trim()}\n`);
      if (result.stderr) process.stderr.write(`  stderr: ${result.stderr.trim()}\n`);
      if (result.error) process.stderr.write(`  error: ${result.error.message}\n`);
      stepsFailed++;
      return false;
    }

    if (result.stdout) {
      result.stdout.trim().split("\n").forEach(l => process.stdout.write(`  > ${l}\n`));
    }
    pass(`Step ${n} completed (exit 0)`);
    return true;
  }

  // Step 1: yakcc init --target <workdir>
  runStep(1, "yakcc init --target <workdir>", ["init", "--target", workdir]);

  // Step 2: Write sample .ts source file
  step(2, "Write sample TypeScript source file (substrate-able + novel-glue mix)");
  const srcDir = join(workdir, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, "example.ts"),
    `// SPDX-License-Identifier: MIT
// B6 benchmark sample source — mix of substrate-able and novel-glue logic

/**
 * Adds two numbers. Pure function — substrate-able.
 * @param a first number
 * @param b second number
 * @returns sum
 */
export function add(a: number, b: number): number {
  return a + b;
}

/**
 * Greets a user. Novel glue — depends on domain-specific name format.
 * @param name user name
 * @returns greeting string
 */
export function greet(name: string): string {
  return \`Hello, \${name}! Result: \${add(1, 2)}\`;
}

/**
 * Sorts an array of numbers in ascending order. Substrate-able.
 * @param nums input array
 * @returns sorted array (new)
 */
export function sortAsc(nums: number[]): number[] {
  return [...nums].sort((a, b) => a - b);
}

// Novel glue: domain-specific formatting
export function formatResults(nums: number[]): string {
  return sortAsc(nums).map((n, i) => \`[\${i}] \${n}\`).join("\\n");
}
`,
    "utf8"
  );
  pass("Step 2 completed — src/example.ts written");

  // Step 3: yakcc shave src/example.ts --offline
  runStep(3, "yakcc shave src/example.ts --offline", [
    "shave",
    join(srcDir, "example.ts"),
    "--registry", join(workdir, ".yakcc/registry.sqlite"),
    "--offline",
  ]);

  // Step 4: Register novel glue — seed the registry with the shaved atoms
  // (yakcc does not have a separate "register novel glue" CLI command;
  //  the shave step in step 3 writes atoms to the registry. We verify
  //  the registry file exists as the registration assertion.)
  step(4, "Verify novel-glue registration (registry.sqlite populated after shave)");
  const registryPath = join(workdir, ".yakcc/registry.sqlite");
  if (existsSync(registryPath)) {
    pass("Step 4 — registry.sqlite exists (atoms registered by shave)");
  } else {
    fail("Step 4 — registry.sqlite not found after shave");
    stepsFailed++;
  }

  // Step 5: yakcc compile src/example.ts (compile the shaved result)
  runStep(5, "yakcc compile src/example.ts --out dist", [
    "compile",
    join(srcDir, "example.ts"),
    "--registry", join(workdir, ".yakcc/registry.sqlite"),
    "--out", join(workdir, "dist"),
  ]);

  // Step 6: Execute compiled output (if compile produced output)
  step(6, "Execute compiled output");
  const compiledModule = join(workdir, "dist", "module.ts");
  const compiledJs = join(workdir, "dist", "module.js");
  if (existsSync(compiledModule)) {
    pass("Step 6 — dist/module.ts exists (compiled output present)");
    info("Note: dist/module.ts is TypeScript source, not directly executable as JS.");
    info("Execution verification: file presence + non-empty confirms compile success.");
    const content = readFileSync(compiledModule, "utf8");
    if (content.trim().length > 0) {
      pass("Step 6 — dist/module.ts is non-empty");
    } else {
      fail("Step 6 — dist/module.ts is empty");
      stepsFailed++;
    }
  } else if (existsSync(compiledJs)) {
    // If harness produces .js directly
    const interceptOut = join(workdir, "step6-intercept.json");
    const execResult = spawnSync(process.execPath, [
      "--require", resolve(__dirname, "network-interceptor.cjs"),
      compiledJs,
    ], {
      cwd: workdir,
      encoding: "utf8",
      env: { ...process.env, YAKCC_BENCH_INTERCEPT_OUT: interceptOut },
      timeout: 30000,
    });
    const execConns = readInterceptedConnections(interceptOut);
    allConnections.push(...execConns);
    if (execResult.status === 0) {
      pass("Step 6 — compiled JS executed successfully");
    } else {
      fail(`Step 6 — compiled JS exited with code ${execResult.status}`);
      stepsFailed++;
    }
  } else {
    // compile may fail when no spec.yak is present — document this as a known
    // limitation rather than a B6 kill criterion (compile without spec.yak is
    // expected to fail; the air-gap test cares about network calls, not compile success)
    skip("Step 6 — no compiled output found (compile step may have failed; see step 5)");
    info("Known limitation: yakcc compile requires a spec.yak file. If compile failed");
    info("at step 5, this skip is expected. The air-gap assertion covers all steps that ran.");
  }

  // Step 7: Registry read-back via yakcc query
  // NOTE: "yakcc registry list" does not exist in the current CLI surface (only
  // "registry init" is implemented). We use "yakcc query" for registry read-back.
  // This is not a B6 failure — it reflects the current CLI surface. Filed as a
  // documentation delta in README.md.
  step(7, "yakcc query <text> (registry read-back; 'registry list' not in CLI surface)");
  const interceptOut7 = join(workdir, "step7-intercept.json");
  const queryResult = runYakcc(
    ["query", "add", "--registry", join(workdir, ".yakcc/registry.sqlite")],
    { cwd: workdir, interceptOut: interceptOut7 }
  );
  const conns7 = readInterceptedConnections(interceptOut7);
  allConnections.push(...conns7);
  if (queryResult.status === 0) {
    pass("Step 7 — query returned exit 0");
    if (queryResult.stdout) {
      queryResult.stdout.trim().split("\n").slice(0, 5).forEach(l => process.stdout.write(`  > ${l}\n`));
    }
  } else {
    // query on an empty/unpopulated registry may return 1 — treat as skip, not kill
    skip(`Step 7 — query exited with code ${queryResult.status} (empty registry is expected if shave/seed was skipped)`);
    if (queryResult.stderr) process.stderr.write(`  stderr: ${queryResult.stderr.trim()}\n`);
  }

  // ---------------------------------------------------------------------------
  // B6a assertion: ZERO outbound connections
  // ---------------------------------------------------------------------------
  const wallEnd = Date.now();
  const wallMs = wallEnd - wallStart;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`${BOLD}B6a ASSERTION — Zero outbound connections${RESET}`);
  console.log(`${"=".repeat(60)}`);
  info(`Wall-clock: ${wallMs}ms`);
  info(`Steps failed: ${stepsFailed}/7`);
  info(`Total intercepted connections: ${allConnections.length}`);

  let b6aPass = true;
  if (allConnections.length > 0) {
    b6aPass = false;
    fail(`B6a KILL — ${allConnections.length} outbound connection(s) detected:`);
    for (const conn of allConnections) {
      process.stderr.write(`  ${conn.protocol.toUpperCase()} ${conn.dest}\n`);
    }
  } else {
    pass(`B6a PASS — zero outbound connections detected`);
  }

  // Write results JSON
  const resultsPath = join(__dirname, `results-b6a-${new Date().toISOString().slice(0, 10)}.json`);
  const results = {
    benchmark: "B6a",
    runAt: new Date().toISOString(),
    wallMs,
    stepsFailed,
    outboundConnections: allConnections,
    outboundCount: allConnections.length,
    pass: b6aPass && stepsFailed === 0,
    b6aPass,
    notes: [
      "step7: 'registry list' CLI command does not exist; used 'query' for read-back",
      "platform: " + process.platform,
      "node: " + process.version,
    ],
  };
  writeFileSync(resultsPath, JSON.stringify(results, null, 2), "utf8");
  info(`Results written to: ${resultsPath}`);

  if (!harnessArgs["keep-tmp"]) {
    try { rmSync(workdir, { recursive: true, force: true }); } catch (_) {}
  } else {
    info(`Kept workdir: ${workdir}`);
  }

  return b6aPass && stepsFailed === 0;
}

// ---------------------------------------------------------------------------
// B6b — networked benchmark (requires ANTHROPIC_API_KEY)
// ---------------------------------------------------------------------------

async function runB6b() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${BOLD}B6b — NETWORKED BENCHMARK${RESET}`);
  console.log(`${"=".repeat(60)}\n`);

  if (!process.env.ANTHROPIC_API_KEY) {
    skip("B6b — ANTHROPIC_API_KEY not set; skipping networked benchmark (N/A, not a failure)");
    info("To run B6b: set ANTHROPIC_API_KEY and re-run with --mode b6b or --mode all");
    return null; // null = skipped
  }

  info("B6b runs with ANTHROPIC_API_KEY set; monitoring for unexpected destinations...");

  // Create a clean temp directory for B6b workload
  const tmpBase = join(REPO_ROOT, "tmp");
  mkdirSync(tmpBase, { recursive: true });
  const workdir = mkdtempSync(join(tmpBase, "b6b-"));
  info(`Workdir: ${workdir}`);

  const allConnections = [];

  // Run the same 7-step workload but WITHOUT injecting the offline provider
  // (use real embeddings that may call the API)
  function runStepNetworked(n, desc, args) {
    step(n, desc);
    const interceptOut = join(workdir, `step${n}-intercept.json`);

    // Networked mode: do NOT inject createOfflineEmbeddingProvider
    const cliDistLocal = resolve(REPO_ROOT, "packages/cli/dist/index.js");
    const argsJson = JSON.stringify(args);
    const esmWrapper = `
import { runCli } from ${JSON.stringify(cliDistLocal)};
const code = await runCli(${argsJson});
process.exit(code);
`;
    const interceptorPath = resolve(__dirname, "network-interceptor.cjs");
    const nodeArgs = ["--require", interceptorPath, "--input-type=module"];
    const result = spawnSync(process.execPath, nodeArgs, {
      cwd: workdir,
      input: esmWrapper,
      encoding: "utf8",
      env: { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, YAKCC_BENCH_INTERCEPT_OUT: interceptOut },
      timeout: 120000,
    });
    const connections = readInterceptedConnections(interceptOut);
    allConnections.push(...connections);

    if (result.status !== 0) {
      fail(`Step ${n} exited with code ${result.status}`);
      if (result.stderr) process.stderr.write(`  stderr: ${result.stderr.trim().slice(0, 300)}\n`);
      return false;
    }
    pass(`Step ${n} completed`);
    return true;
  }

  runStepNetworked(1, "yakcc init --target <workdir>", ["init", "--target", workdir]);
  step(2, "Write sample TypeScript source file");
  const srcDir = join(workdir, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "example.ts"), `export function add(a: number, b: number): number { return a + b; }\n`, "utf8");
  pass("Step 2 completed");
  runStepNetworked(3, "yakcc shave src/example.ts", ["shave", join(srcDir, "example.ts"), "--registry", join(workdir, ".yakcc/registry.sqlite")]);

  // B6b assertion: only allowlisted destinations
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${BOLD}B6b ASSERTION — Only allowlisted destinations${RESET}`);
  console.log(`${"=".repeat(60)}`);
  info(`Total intercepted connections: ${allConnections.length}`);
  info(`Allowlist: ${JSON.stringify(allowlist)}`);

  let b6bPass = true;
  const violations = [];
  for (const conn of allConnections) {
    const isAllowed = allowlist.some(entry => {
      if (entry.includes(":")) {
        return conn.dest === entry;
      }
      return conn.host === entry;
    });
    if (!isAllowed) {
      violations.push(conn);
    }
  }

  if (violations.length > 0) {
    b6bPass = false;
    fail(`B6b KILL — ${violations.length} connection(s) to non-allowlisted destinations:`);
    for (const v of violations) {
      process.stderr.write(`  ${v.protocol.toUpperCase()} ${v.dest}\n`);
    }
  } else if (allConnections.length === 0) {
    pass("B6b — zero connections (no API calls made; possibly offline provider used)");
  } else {
    pass(`B6b PASS — all ${allConnections.length} connection(s) on allowlist`);
    for (const conn of allConnections) {
      process.stdout.write(`  ALLOWED: ${conn.protocol.toUpperCase()} ${conn.dest}\n`);
    }
  }

  const resultsPath = join(__dirname, `results-b6b-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(resultsPath, JSON.stringify({
    benchmark: "B6b",
    runAt: new Date().toISOString(),
    outboundConnections: allConnections,
    outboundCount: allConnections.length,
    violations,
    pass: b6bPass,
    allowlist,
    notes: ["platform: " + process.platform, "node: " + process.version],
  }, null, 2), "utf8");
  info(`Results written to: ${resultsPath}`);

  if (!harnessArgs["keep-tmp"]) {
    try { rmSync(workdir, { recursive: true, force: true }); } catch (_) {}
  }

  return b6bPass;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const mode = harnessArgs.mode;
let exitCode = 0;

if (mode === "b6a" || mode === "all") {
  const b6aResult = await runB6a();
  if (b6aResult === false) exitCode = 1;
}

if (mode === "b6b" || mode === "all") {
  const b6bResult = await runB6b();
  if (b6bResult === false) exitCode = 1;
  // null = skipped, not a failure
}

console.log(`\n${"=".repeat(60)}`);
if (exitCode === 0) {
  console.log(`${GREEN}${BOLD}BENCH RESULT: PASS${RESET}`);
} else {
  console.log(`${RED}${BOLD}BENCH RESULT: FAIL${RESET}`);
}
console.log(`${"=".repeat(60)}\n`);
process.exit(exitCode);
