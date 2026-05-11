// SPDX-License-Identifier: MIT
//
// bench/B1-latency/json-transformer/yakcc-as/run.mjs
//
// @decision DEC-BENCH-B1-JSON-AS-RUN-001
// @title yakcc-as runner: pre-serialize JSON to binary tagged-union, time DFS in WASM
// @status accepted
// @rationale
//   The AS-backend uses --runtime stub (no GC, no managed strings). The camelCase
//   transform requires managed string operations incompatible with this constraint.
//   Fallback: sum-of-all-numeric-leaves over a pre-parsed binary tree.
//
//   Pre-parse contract:
//     The host serializes the JSON corpus into a flat binary tagged-union format
//     (documented in source.ts) OUTSIDE the timing loop. The WASM kernel receives
//     a pointer to this binary buffer and times only the DFS traversal.
//
//   This is equivalent to the Rust comparator (which also calls JSON.parse once
//   outside timing, then times the DFS sum loop) and the ts-node comparator
//   (same discipline). All four comparators time DFS-over-pre-parsed-tree.
//
//   Memory layout:
//     TREE_BASE_PTR = 65536  (page 1 start — binary tree written here)
//     pages allocated = ceil(binarySize / 65536) + 2  (headroom)
//
// Usage: node bench/B1-latency/json-transformer/yakcc-as/run.mjs <corpus-path>

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WARMUP = 100;
const MEASURED = 1000;

// Tag constants — must match source.ts
const TAG_NUMBER = 1;
const TAG_STRING = 2;
const TAG_BOOL   = 3;
const TAG_NULL   = 4;
const TAG_ARRAY  = 5;
const TAG_OBJECT = 6;

// ---------------------------------------------------------------------------
// Serializer: JSON value → flat binary tagged-union buffer
// ---------------------------------------------------------------------------

function measureTree(v) {
  if (v === null) return 1;
  if (typeof v === "boolean") return 2;
  if (typeof v === "number") return 9; // 1 tag + 8 f64
  if (typeof v === "string") {
    const bytes = Buffer.byteLength(v, "utf8");
    return 1 + 4 + bytes; // tag + u32 len + utf8
  }
  if (Array.isArray(v)) {
    let size = 1 + 4; // tag + u32 count
    for (const item of v) size += measureTree(item);
    return size;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v);
    let size = 1 + 4; // tag + u32 count
    for (const [k, val] of entries) {
      size += measureTree(k);   // key as TAG_STRING
      size += measureTree(val); // value
    }
    return size;
  }
  return 1; // fallback null
}

function serializeTree(v, buf, offset) {
  if (v === null) {
    buf[offset++] = TAG_NULL;
    return offset;
  }
  if (typeof v === "boolean") {
    buf[offset++] = TAG_BOOL;
    buf[offset++] = v ? 1 : 0;
    return offset;
  }
  if (typeof v === "number") {
    buf[offset++] = TAG_NUMBER;
    buf.writeDoubleLE(v, offset); // f64 little-endian — WASM is LE
    return offset + 8;
  }
  if (typeof v === "string") {
    buf[offset++] = TAG_STRING;
    const strBytes = Buffer.from(v, "utf8");
    buf.writeUInt32LE(strBytes.length, offset); offset += 4;
    strBytes.copy(buf, offset); offset += strBytes.length;
    return offset;
  }
  if (Array.isArray(v)) {
    buf[offset++] = TAG_ARRAY;
    buf.writeUInt32LE(v.length, offset); offset += 4;
    for (const item of v) offset = serializeTree(item, buf, offset);
    return offset;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v);
    buf[offset++] = TAG_OBJECT;
    buf.writeUInt32LE(entries.length, offset); offset += 4;
    for (const [k, val] of entries) {
      offset = serializeTree(k, buf, offset);   // key
      offset = serializeTree(val, buf, offset); // value
    }
    return offset;
  }
  // fallback null
  buf[offset++] = TAG_NULL;
  return offset;
}

function buildBinaryTree(jsonValue) {
  const size = measureTree(jsonValue);
  const buf = Buffer.allocUnsafe(size);
  const end = serializeTree(jsonValue, buf, 0);
  if (end !== size) {
    throw new Error(`Binary tree size mismatch: measured ${size}, wrote ${end}`);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Resolve asc.js — same logic as integer-math runner
// ---------------------------------------------------------------------------

function resolveAsc() {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const direct = join(dir, "node_modules", "assemblyscript", "bin", "asc.js");
    if (existsSync(direct)) return direct;
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
// Compile source.ts → WASM
// ---------------------------------------------------------------------------

function compileSourceTs(initialMemoryPages) {
  const ascJs = resolveAsc();
  const sourcePath = join(__dirname, "source.ts");
  const workDir = join(tmpdir(), `b1-bench-json-as-${randomUUID()}`);
  mkdirSync(workDir, { recursive: true });
  const outPath = join(workDir, "json-transformer.wasm");

  try {
    execFileSync(process.execPath, [
      ascJs,
      sourcePath,
      "--outFile", outPath,
      "--optimize",
      "--runtime", "stub",
      "--exportMemory",
      "--initialMemory", String(initialMemoryPages),
      "--maximumMemory", String(initialMemoryPages),
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "buffer",
      timeout: 60000,
    });
    return readFileSync(outPath);
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

// Read and parse JSON corpus (outside timing loop)
const jsonStr = readFileSync(corpusPath, "utf8");
const sizeMb = Buffer.byteLength(jsonStr, "utf8") / (1024 * 1024);
const jsonValue = JSON.parse(jsonStr);

// Pre-serialize to binary flat tree (outside timing loop)
const binaryTree = buildBinaryTree(jsonValue);
const binaryTreeSize = binaryTree.length;

// WASM memory layout:
//   Page 0:      WASM stub header (64KB)
//   Page 1+:     Binary tree (TREE_BASE_PTR = 65536)
const TREE_BASE_PTR = 65536;
const pagesForTree = Math.ceil((TREE_BASE_PTR + binaryTreeSize) / 65536);
const initialMemoryPages = pagesForTree + 2; // 2 pages headroom

// Compile WASM
let wasmBytes;
try {
  wasmBytes = compileSourceTs(initialMemoryPages);
} catch (err) {
  process.stderr.write(`SCOPE-BLOCKER: asc compilation failed for yakcc-as JSON kernel.\n`);
  process.stderr.write(`Error: ${err.message}\n`);
  process.stderr.write(`\nThe AS-backend cannot compile this kernel. See issue #185.\n`);
  process.exit(2);
}

// Instantiate WASM
const wasmModule = new WebAssembly.Module(wasmBytes);
const wasmInstance = new WebAssembly.Instance(wasmModule, {});
const { sumNumericLeaves, memory } = wasmInstance.exports;

if (typeof sumNumericLeaves !== "function") {
  process.stderr.write("SCOPE-BLOCKER: sumNumericLeaves export not found in compiled WASM module.\n");
  process.exit(2);
}
if (!memory) {
  process.stderr.write("SCOPE-BLOCKER: memory export not found — check --exportMemory flag.\n");
  process.exit(2);
}

// Copy binary tree into WASM memory at TREE_BASE_PTR
const wasmMem = new Uint8Array(memory.buffer);
wasmMem.set(binaryTree, TREE_BASE_PTR);

// ---------------------------------------------------------------------------
// Timing loop — times only DFS traversal (pre-parse is outside loop)
// ---------------------------------------------------------------------------

const latenciesMs = [];
const totalIters = WARMUP + MEASURED;
let lastSum = 0;

for (let i = 0; i < totalIters; i++) {
  const start = performance.now();
  const result = sumNumericLeaves(TREE_BASE_PTR, binaryTreeSize);
  const elapsed = performance.now() - start;
  lastSum = result;
  if (i >= WARMUP) {
    latenciesMs.push(elapsed);
  }
}

latenciesMs.sort((a, b) => a - b);
const p50 = latenciesMs[Math.floor(MEASURED * 0.50)];
const p95 = latenciesMs[Math.floor(MEASURED * 0.95)];
const p99 = latenciesMs[Math.floor(MEASURED * 0.99)];
const mean = latenciesMs.reduce((s, v) => s + v, 0) / MEASURED;
const throughputMbPerSec = sizeMb / (mean / 1000);

const result2 = {
  comparator: "yakcc-as",
  p50_ms: p50,
  p95_ms: p95,
  p99_ms: p99,
  mean_ms: mean,
  throughput_mb_per_sec: throughputMbPerSec,
  iterations: MEASURED,
  checksum: lastSum,
};
process.stdout.write(JSON.stringify(result2) + "\n");
