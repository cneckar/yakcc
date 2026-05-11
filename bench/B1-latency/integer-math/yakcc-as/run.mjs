// SPDX-License-Identifier: MIT
//
// bench/B1-latency/integer-math/yakcc-as/run.mjs
//
// @decision DEC-BENCH-B1-AS-RUN-001
// @title yakcc-as runner invokes asc.js directly (same mechanism as assemblyScriptBackend)
// @status accepted
// @rationale
//   The assemblyScriptBackend() in packages/compile/src/as-backend.ts compiles atoms by
//   invoking asc.js (the AssemblyScript compiler) via execFileSync. This runner uses the
//   exact same asc.js path (resolved from node_modules/assemblyscript) and the same
//   compilation flags (--runtime stub, --optimize, --exportMemory, --initialMemory).
//
//   The sha256() kernel in source.ts is written in flat-memory AssemblyScript —
//   the same substrate protocol that the AS-backend supports (u32 arithmetic, load<u8>/
//   store<u32>, no GC, no managed types). This is the production-representative path:
//   a yakcc atom compiled via the AS-backend would go through this same asc pipeline.
//
//   Memory layout:
//     DATA_BASE_PTR = 65536       (page 1 — corpus buffer copied here by host)
//     W_PTR         = 67108864    (page 1024 — SHA-256 schedule scratch)
//     OUT_PTR       = 67109120    (W_PTR + 256 — digest output: 8 x u32)
//     K_PTR         = 67174400    (OUT_PTR + 65280 — SHA-256 K constants)
//     SCRATCH_PTR   = K_PTR + 256 (padding scratch: up to 128 bytes)
//
//   Required memory: 1 (AS stub header) + 1600 (100MB corpus) + 2 (scratch pages)
//   = 1603 pages minimum. We allocate 1700 pages (108MB) for safety headroom.
//
//   The host copies the 100MB corpus into WASM memory at DATA_BASE_PTR before
//   each measurement iteration. sha256(DATA_BASE_PTR, CORPUS_SIZE) is called;
//   the digest is written to OUT_PTR (not verified per iteration for timing purity).
//
// Usage: node bench/B1-latency/integer-math/yakcc-as/run.mjs <corpus-path>

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WARMUP = 100;
const MEASURED = 1000;

// ---------------------------------------------------------------------------
// Resolve asc.js — same logic as assemblyScriptBackend.resolveAsc()
// ---------------------------------------------------------------------------

function resolveAsc() {
  // Walk up from this file's directory to find the workspace root containing
  // node_modules with the assemblyscript package.
  // pnpm uses a virtual store: node_modules/.pnpm/assemblyscript@X.Y.Z/node_modules/assemblyscript/
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    // Direct hoisted path (npm/yarn style)
    const direct = join(dir, "node_modules", "assemblyscript", "bin", "asc.js");
    if (existsSync(direct)) return direct;

    // pnpm virtual store: scan for assemblyscript@* subdirectory
    const pnpmStore = join(dir, "node_modules", ".pnpm");
    if (existsSync(pnpmStore)) {
      try {
        const entries = readdirSync(pnpmStore);
        for (const entry of entries) {
          if (entry.startsWith("assemblyscript@")) {
            const candidate = join(pnpmStore, entry, "node_modules", "assemblyscript", "bin", "asc.js");
            if (existsSync(candidate)) return candidate;
          }
        }
      } catch (_) {}
    }

    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not resolve assemblyscript/bin/asc.js from " + __dirname);
}

// ---------------------------------------------------------------------------
// Compile source.ts → WASM via asc
// ---------------------------------------------------------------------------

function compileSourceTs() {
  const ascJs = resolveAsc();
  const sourcePath = join(__dirname, "source.ts");
  const workDir = join(tmpdir(), `b1-bench-as-${randomUUID()}`);
  mkdirSync(workDir, { recursive: true });
  const outPath = join(workDir, "sha256.wasm");

  try {
    execFileSync(process.execPath, [
      ascJs,
      sourcePath,
      "--outFile", outPath,
      "--optimize",
      "--runtime", "stub",
      "--exportMemory",
      "--initialMemory", "1700",  // 1700 × 64KB = ~108MB: covers 100MB corpus + scratch
      "--maximumMemory", "1700",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "buffer",
      timeout: 60000,
    });

    const wasmBytes = readFileSync(outPath);
    return wasmBytes;
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const corpusPath = process.argv[2];
if (!corpusPath) {
  process.stderr.write("Usage: node yakcc-as/run.mjs <corpus-path>\n");
  process.exit(1);
}

const corpusBuf = readFileSync(corpusPath);
const sizeMb = corpusBuf.length / (1024 * 1024);
const CORPUS_SIZE = corpusBuf.length; // 104857600

// DATA_BASE_PTR: page 1 start (same as source.ts)
const DATA_BASE_PTR = 65536;
// OUT_PTR: where the digest is written (must match source.ts OUT_PTR = W_PTR + 256)
// W_PTR = 104988672 (page 1602), OUT_PTR = 104988928
const OUT_PTR = 104988928;

// Compile the WASM module
let wasmBytes;
try {
  wasmBytes = compileSourceTs();
} catch (err) {
  process.stderr.write(`SCOPE-BLOCKER: asc compilation failed for yakcc-as SHA-256 kernel.\n`);
  process.stderr.write(`Error: ${err.message}\n`);
  process.stderr.write(`\nThis means the AS-backend cannot yet compile the bit-shift/byte-array\n`);
  process.stderr.write(`idioms required by SHA-256. See issue #185 for next steps.\n`);
  process.exit(2);
}

// Instantiate the WASM module (reused across all iterations)
const wasmModule = new WebAssembly.Module(wasmBytes);
const wasmInstance = new WebAssembly.Instance(wasmModule, {});
const { sha256, memory } = wasmInstance.exports;

if (typeof sha256 !== "function") {
  process.stderr.write("SCOPE-BLOCKER: sha256 export not found in compiled WASM module.\n");
  process.exit(2);
}
if (!memory) {
  process.stderr.write("SCOPE-BLOCKER: memory export not found — check --exportMemory flag.\n");
  process.exit(2);
}

// Copy corpus into WASM memory at DATA_BASE_PTR
// We copy once and reuse the same memory for all iterations (the hash function
// is read-only with respect to the input buffer — it does not modify data_ptr).
const wasmMem = new Uint8Array(memory.buffer);
wasmMem.set(corpusBuf, DATA_BASE_PTR);

const latenciesMs = [];
const totalIters = WARMUP + MEASURED;

for (let i = 0; i < totalIters; i++) {
  const start = performance.now();
  sha256(DATA_BASE_PTR, CORPUS_SIZE);
  const elapsed = performance.now() - start;
  if (i >= WARMUP) {
    latenciesMs.push(elapsed);
  }
}

// Compute statistics
latenciesMs.sort((a, b) => a - b);
const p50 = latenciesMs[Math.floor(MEASURED * 0.50)];
const p95 = latenciesMs[Math.floor(MEASURED * 0.95)];
const p99 = latenciesMs[Math.floor(MEASURED * 0.99)];
const mean = latenciesMs.reduce((s, v) => s + v, 0) / MEASURED;
const throughputMbPerSec = sizeMb / (mean / 1000);

const result = {
  comparator: "yakcc-as",
  p50_ms: p50,
  p95_ms: p95,
  p99_ms: p99,
  mean_ms: mean,
  throughput_mb_per_sec: throughputMbPerSec,
  iterations: MEASURED,
};
process.stdout.write(JSON.stringify(result) + "\n");
