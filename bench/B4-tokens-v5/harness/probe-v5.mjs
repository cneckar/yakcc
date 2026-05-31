// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/harness/probe-v5.mjs
//
// @decision DEC-BENCH-B4-V5-PROBE-001
// @title $0 production-resolve probe — satisfies PROTOCOL.md §6.1
// @status accepted
// @rationale
//   PROTOCOL.md §6.1 requires a per-task hit-rate table proving the production
//   server actually spawns and resolves end-to-end BEFORE the $11.51 paid matrix
//   run.  This script calls yakcc_resolve once per task using the REAL production
//   @yakcc/mcp-registry server (DEC-BENCH-B4-V5-RESOLVE-SERVER-001) and records
//   {task_id, top1_score, tier_returned, gap_to_2nd, n_candidates,
//    n_above_threshold_092, n_above_threshold_085} to a JSONL report.
//
//   Makes ZERO Anthropic API calls.  Validate for $0 against an existing registry:
//     YAKCC_REGISTRY_PATH=<path>/registry.sqlite node harness/probe-v5.mjs
//
// Usage:
//   YAKCC_REGISTRY_PATH=/path/to/registry.sqlite node harness/probe-v5.mjs
//   YAKCC_REGISTRY_PATH=... node harness/probe-v5.mjs --out results/probe-v5-run.jsonl

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, "..");
const RESULTS_DIR = join(BENCH_ROOT, "results");

// Resolve the true repo root that has packages installed.
// In a git worktree, node_modules live only in the main repo; the worktree
// tree has no node_modules in packages/*.  Walk up until we find the root
// that has packages/mcp-registry/dist/index.js AND packages/registry/node_modules.
// YAKCC_REPO_ROOT env var overrides (set by the caller for production runs).
function findRepoRoot() {
  const envRoot = process.env.YAKCC_REPO_ROOT;
  if (envRoot && existsSync(join(envRoot, "packages", "mcp-registry", "dist", "index.js"))) {
    return envRoot;
  }
  let candidate = resolve(__dirname, "../../..");
  for (let i = 0; i < 4; i++) {
    const mcpDist = join(candidate, "packages", "mcp-registry", "dist", "index.js");
    const regNm = join(candidate, "packages", "registry", "node_modules", "better-sqlite3");
    if (existsSync(mcpDist) && existsSync(regNm)) return candidate;
    candidate = resolve(candidate, "..");
  }
  return resolve(__dirname, "../../..");
}

const REPO_ROOT = findRepoRoot();

// Production mcp-registry binary (DEC-BENCH-B4-V5-RESOLVE-SERVER-001)
const PRODUCTION_MCP_REGISTRY_JS = join(REPO_ROOT, "packages", "mcp-registry", "dist", "index.js");

// Thresholds mirrored from PROTOCOL.md §3.2 / resolve.ts
const THRESH_PRODUCTION = 0.92;
const THRESH_DOC = 0.85;

// ─── Task intent cards (one per task, derived from tasks.json descriptions) ───
// These are the real intent strings that an agent would pass to yakcc_resolve.
const TASK_INTENTS = [
  {
    task_id: "crc32c",
    intent: {
      title: "CRC-32C checksum class",
      description:
        "Compute CRC-32C (Castagnoli, polynomial 0x82F63B78) checksums. " +
        "Named class with update(data), digest(), reset(), clone() methods. " +
        "Must NOT use CRC-32 (Ethernet) polynomial 0xEDB88320.",
      signature:
        "class CRC32C { update(data: string | Uint8Array): this; digest(): number; reset(): this; clone(): CRC32C }",
    },
  },
  {
    task_id: "utf8-codec",
    intent: {
      title: "UTF-8 encoder and decoder without TextEncoder/TextDecoder",
      description:
        "Pure-TypeScript UTF-8 encode/decode handling 1/2/3/4-byte sequences, " +
        "surrogate pairs converted to 4-byte sequences, overlong encoding rejection in decode(). " +
        "Forbidden: TextEncoder, TextDecoder, Buffer.",
      signature:
        "class Utf8Codec { encode(text: string): Uint8Array; decode(bytes: Uint8Array): string }",
    },
  },
  {
    task_id: "base32-rfc4648",
    intent: {
      title: "RFC 4648 Base32 encode/decode",
      description:
        "Base32 using A-Z2-7 alphabet (NOT Base32Hex 0-9A-V, NOT Base64). " +
        "Padding with =, case-insensitive decode, throws TypeError on invalid character or invalid length.",
      signature:
        "class Base32Codec { encode(data: Uint8Array): string; decode(text: string): Uint8Array }",
    },
  },
  {
    task_id: "lru-ttl-cache",
    intent: {
      title: "LRU cache with per-entry TTL",
      description:
        "Fixed-capacity LRU cache with lazy TTL expiry. " +
        "Expired entries not counted toward capacity, ttlMs=0 defers to defaultTtlMs, Infinity=never expires.",
      signature:
        "class LRUTTLCache<K,V> { get(key:K):V|undefined; set(key:K,value:V,ttlMs?:number):void; has(key:K):boolean; delete(key:K):boolean; readonly size:number }",
    },
  },
  {
    task_id: "semver-range",
    intent: {
      title: "SemVer range satisfaction",
      description:
        "Check if a semver version satisfies a range string. " +
        "Supports ^, ~, >=, <=, >, <, =, *, || (OR), space (AND). " +
        "Critical: ^0.x.y semantics differ from ^1.x.y.",
      signature: "class SemVerRange { satisfies(version: string): boolean }",
    },
  },
  {
    task_id: "ring-buffer",
    intent: {
      title: "Fixed-capacity ring buffer",
      description:
        "Pre-allocated ring buffer with push (returns evicted item when full), " +
        "shift, peek, get with negative index support, Symbol.iterator, size/capacity, clear.",
      signature:
        "class RingBuffer<T> { push(item: T): T | undefined; shift(): T | undefined; peek(): T | undefined; get(index: number): T; readonly size: number; readonly capacity: number }",
    },
  },
];

// ─── CLI flags ────────────────────────────────────────────────────────────────

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    out: { type: "string", default: "" },
  },
  strict: false,
});

// ─── Production MCP server spawner (mirrors phase2-v5.mjs) ───────────────────

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

  const stderrLines = [];
  server.stderr.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) {
      stderrLines.push(msg);
      if (process.env.YAKCC_DEBUG === "1") process.stdout.write(`  [MCP-PROD] ${msg}\n`);
    }
  });

  // NDJSON transport: MCP SDK v1.29+ uses newline-delimited JSON (not Content-Length framing).
  let stdoutNdjson = "";
  const pending = new Map();
  let reqId = 300;

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
    clientInfo: { name: "probe-v5", version: "0.0.1" },
  });
  // Required initialized notification (MCP SDK v1.29+ protocol)
  server.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );

  const toolsListResp = await mcpRequest("tools/list", {});
  const resolveToolPresent =
    toolsListResp.result?.tools?.some((t) => t.name === "yakcc_resolve") ?? false;

  return {
    resolveToolPresent,
    stderrLines,
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

// ─── Envelope parser — extract per-task metrics ───────────────────────────────

function parseEnvelope(taskId, envelope) {
  const tier = envelope.confidence_tier ?? "no_candidates";
  const candidates = Array.isArray(envelope.candidates) ? envelope.candidates : [];
  const n = candidates.length;

  // Scores: the production resolve.ts returns candidates with a `score` field.
  const scores = candidates
    .map((c) => (typeof c.score === "number" ? c.score : 0))
    .sort((a, b) => b - a); // descending

  const top1Score = scores[0] ?? null;
  const gapTo2nd = scores.length >= 2 ? (scores[0] ?? 0) - (scores[1] ?? 0) : null;
  const nAbove092 = scores.filter((s) => s > THRESH_PRODUCTION).length;
  const nAbove085 = scores.filter((s) => s > THRESH_DOC).length;

  return {
    task_id: taskId,
    tier_returned: tier,
    top1_score: top1Score,
    gap_to_2nd: gapTo2nd,
    n_candidates: n,
    n_above_threshold_092: nAbove092,
    n_above_threshold_085: nAbove085,
    airgapped: envelope.airgapped ?? true,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const yakccRegistryPath = process.env.YAKCC_REGISTRY_PATH;
  if (!yakccRegistryPath) {
    process.stderr.write(
      "ERROR: YAKCC_REGISTRY_PATH is required.\n" +
        "  Example: YAKCC_REGISTRY_PATH=tmp/B4-tokens-v3/phase1-.../registry.sqlite node harness/probe-v5.mjs\n",
    );
    process.exit(1);
  }
  if (!existsSync(yakccRegistryPath)) {
    process.stderr.write(`ERROR: Registry not found: ${yakccRegistryPath}\n`);
    process.exit(1);
  }

  console.log("B4-tokens-v5 probe-v5 — $0 production-resolve probe");
  console.log(`Registry: ${yakccRegistryPath}`);
  console.log(`MCP server: ${PRODUCTION_MCP_REGISTRY_JS}`);
  console.log(`Tasks: ${TASK_INTENTS.length}`);
  console.log("YAKCC_AIRGAPPED=1 (no Anthropic API calls)\n");

  // Spawn the production MCP server once, shared across all task probes.
  let server;
  try {
    server = await startProductionMcpServer(yakccRegistryPath);
  } catch (err) {
    process.stderr.write(`ERROR: Failed to start production MCP server: ${err.message}\n`);
    process.exit(1);
  }

  if (!server.resolveToolPresent) {
    server.close();
    process.stderr.write("ERROR: yakcc_resolve tool not found in server tools/list response.\n");
    process.exit(1);
  }
  console.log("Production MCP server started. yakcc_resolve tool confirmed present.\n");

  const rows = [];
  let anyError = false;

  for (const { task_id, intent } of TASK_INTENTS) {
    process.stdout.write(`  Probing task: ${task_id} ...`);
    try {
      const envelope = await server.callResolve(intent);
      const row = parseEnvelope(task_id, envelope);
      rows.push(row);

      // Human-readable line
      const top1Str = row.top1_score !== null ? row.top1_score.toFixed(4) : "  n/a";
      const gapStr = row.gap_to_2nd !== null ? row.gap_to_2nd.toFixed(4) : "  n/a";
      console.log(
        ` tier=${row.tier_returned.padEnd(14)} top1=${top1Str}  gap=${gapStr}  n=${String(row.n_candidates).padStart(3)}  >=0.92=${row.n_above_threshold_092}  >=0.85=${row.n_above_threshold_085}`,
      );
    } catch (err) {
      console.log(` ERROR: ${err.message}`);
      rows.push({ task_id, tier_returned: "error", error: err.message });
      anyError = true;
    }
  }

  server.close();

  // ── Print PROTOCOL §6.1 hit-rate table ──────────────────────────────────────
  console.log("\n=== PROTOCOL §6.1 Per-task hit-rate table ===\n");
  console.log("task_id          tier              top1    gap     n   >=0.92  >=0.85");
  console.log("-".repeat(72));
  for (const r of rows) {
    if (r.error) {
      console.log(`${r.task_id.padEnd(16)} ERROR: ${r.error}`);
      continue;
    }
    const top1 = r.top1_score !== null ? r.top1_score.toFixed(4) : "  n/a";
    const gap = r.gap_to_2nd !== null ? r.gap_to_2nd.toFixed(4) : "  n/a";
    console.log(
      `${r.task_id.padEnd(16)} ${r.tier_returned.padEnd(16)} ${top1}  ${gap}  ${String(r.n_candidates).padStart(3)}     ${r.n_above_threshold_092}      ${r.n_above_threshold_085}`,
    );
  }
  console.log("-".repeat(72));
  console.log(
    `\n${anyError ? "Some tasks had errors (see above)." : "All tasks resolved without errors."}`,
  );
  console.log("ZERO Anthropic API calls made.\n");

  // ── Write JSONL report ───────────────────────────────────────────────────────
  const defaultOut = join(
    RESULTS_DIR,
    `probe-v5-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.jsonl`,
  );
  const outPath = flags.out || defaultOut;
  mkdirSync(dirname(outPath), { recursive: true });

  const meta = {
    _type: "probe_meta",
    registry_path: yakccRegistryPath,
    ts: new Date().toISOString(),
    n_tasks: TASK_INTENTS.length,
    thresh_production: THRESH_PRODUCTION,
    thresh_doc: THRESH_DOC,
  };
  const lines = [
    JSON.stringify(meta),
    ...rows.map((r) => JSON.stringify({ _type: "probe_row", ...r })),
  ];
  writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`Report written: ${outPath}`);
  process.exit(anyError ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
