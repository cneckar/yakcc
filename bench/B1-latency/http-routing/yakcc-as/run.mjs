// SPDX-License-Identifier: MIT
//
// bench/B1-latency/http-routing/yakcc-as/run.mjs
//
// @decision DEC-BENCH-B1-HTTP-AS-RUN-001
// @title yakcc-as runner: pre-flatten trie to Uint32Array, time WASM u32 trie walk
// @status accepted
// @rationale
//   AS-backend --runtime stub has no managed strings. Resolution: all comparators
//   hash path segments to u32 OUTSIDE the timing loop. This runner:
//     1. Loads routing table + query set
//     2. Builds a JS trie from the routing table (excluded from timing)
//     3. Flattens the trie to two Uint32Arrays: nodes[] and edges[] (excluded)
//     4. Pre-hashes all query paths to u32[] arrays (excluded)
//     5. Writes nodes, edges, queries into WASM linear memory (excluded)
//     6. Times matchAll() over all 100K queries per iteration
//
//   Flat memory layout written into WASM:
//     NODES_BASE = 65536        (page 1)
//     EDGES_BASE = NODES_BASE + nodes.byteLength  (rounded to 4-byte align)
//     QUERIES_BASE = EDGES_BASE + edges.byteLength (rounded to 4-byte align)
//
//   Each node: 8 x u32 = 32 bytes
//     [0] edge_count
//     [1] edges_start_idx  (index into edges array)
//     [2] handler_id       (0xFFFFFFFF = none)
//     [3] flags            (bit0=is_wildcard, bit1=is_param)
//     [4..7] padding
//
//   Each edge: 2 x u32 = 8 bytes
//     [0] key              (segment hash, PARAM_SENTINEL=1, WILDCARD_SENTINEL=2)
//     [1] target_node_idx
//
//   Query stream: for each query: u32 seg_count, then seg_count x u32 hashes
//
// Usage: node bench/B1-latency/http-routing/yakcc-as/run.mjs <table-path> <query-path>

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WARMUP   = 100;
const MEASURED = 1000;

const PARAM_SENTINEL    = 0x00000001;
const WILDCARD_SENTINEL = 0x00000002;
const NO_HANDLER        = 0xFFFFFFFF;
const NODES_BASE        = 65536; // page 1

// ---------------------------------------------------------------------------
// Segment hashing — djb2 variant (must match ts-baseline and Rust)
// ---------------------------------------------------------------------------
function hashSegment(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  if (h < 3) h += 3;
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Build JS trie from routing table
// ---------------------------------------------------------------------------
function buildTrie(rules) {
  // Each node: { edgeKeys: u32[], edgeTargets: u32[], handlerId: number, nodeIdx: number }
  const nodes = [];

  function makeNode() {
    const idx = nodes.length;
    const node = { edgeKeys: [], edgeTargets: [], handlerId: NO_HANDLER, nodeIdx: idx };
    nodes.push(node);
    return node;
  }

  const root = makeNode();

  for (const rule of rules) {
    const rawSegs = rule.pattern.split("/").filter(s => s.length > 0);
    let node = root;
    for (const seg of rawSegs) {
      let key;
      if (seg.startsWith(":")) {
        key = PARAM_SENTINEL;
      } else if (seg.startsWith("*")) {
        key = WILDCARD_SENTINEL;
      } else {
        key = hashSegment(seg);
      }
      const existingIdx = node.edgeKeys.indexOf(key);
      if (existingIdx >= 0) {
        node = nodes[node.edgeTargets[existingIdx]];
      } else {
        const child = makeNode();
        node.edgeKeys.push(key);
        node.edgeTargets.push(child.nodeIdx);
        node = child;
      }
    }
    node.handlerId = rule.handler_id;
  }

  return { root, nodes };
}

// ---------------------------------------------------------------------------
// Flatten trie to typed arrays — edges SORTED ascending by key
// ---------------------------------------------------------------------------
// Sorted edges enable O(log n) binary search in the WASM kernel instead of
// O(n) linear scan. The root node has ~5K children; linear scan would be
// catastrophically slow (254ms observed). Binary search reduces to ~13
// comparisons per root lookup.
//
// PARAM_SENTINEL=1 and WILDCARD_SENTINEL=2 sort before all real hashes (≥3),
// so the WASM kernel can probe edge[0]/edge[1] for sentinels directly before
// binary-searching the sorted hash range.
function flattenTrie(nodes) {
  const edgeKeys    = [];
  const edgeTargets = [];

  // Node array: 8 u32s per node
  const nodeData = new Uint32Array(nodes.length * 8);

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    // Sort edges ascending by key before appending — enables binary search in WASM
    const edgePairs = node.edgeKeys.map((k, j) => [k, node.edgeTargets[j]]);
    edgePairs.sort((a, b) => a[0] - b[0]);

    const edgesStart = edgeKeys.length;
    for (const [k, t] of edgePairs) {
      edgeKeys.push(k);
      edgeTargets.push(t);
    }
    nodeData[i * 8 + 0] = node.edgeKeys.length;  // edge_count
    nodeData[i * 8 + 1] = edgesStart;             // edges_start_idx
    nodeData[i * 8 + 2] = node.handlerId >>> 0;   // handler_id
    nodeData[i * 8 + 3] = 0;                       // flags
    // [4..7] padding = 0
  }

  // Edge array: 2 u32s per edge
  const edgeData = new Uint32Array(edgeKeys.length * 2);
  for (let e = 0; e < edgeKeys.length; e++) {
    edgeData[e * 2 + 0] = edgeKeys[e];
    edgeData[e * 2 + 1] = edgeTargets[e];
  }

  return { nodeData, edgeData };
}

// ---------------------------------------------------------------------------
// Pre-hash queries to packed Uint32Array stream
// ---------------------------------------------------------------------------
function prehashQueries(queries) {
  // Format: [segCount, hash0, hash1, ...] per query, packed sequentially
  let totalU32s = 0;
  const segArrays = queries.map(path => {
    const segs = path.split("/").filter(s => s.length > 0).map(hashSegment);
    totalU32s += 1 + segs.length;
    return segs;
  });

  const buf = new Uint32Array(totalU32s);
  let off = 0;
  for (const segs of segArrays) {
    buf[off++] = segs.length;
    for (const h of segs) buf[off++] = h;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Resolve asc.js
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
  return null;
}

// ---------------------------------------------------------------------------
// Compile AssemblyScript source to WASM
// ---------------------------------------------------------------------------
function compileWasm(ascPath) {
  const sourceFile = join(__dirname, "source.ts");
  const tmpDir = join(tmpdir(), `http-routing-as-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  const wasmOut = join(tmpDir, "http-routing.wasm");

  try {
    execFileSync(process.execPath, [
      ascPath,
      sourceFile,
      "--target", "release",
      "--runtime", "stub",
      "--outFile", wasmOut,
      "--optimizeLevel", "3",
      "--shrinkLevel", "0",
      "--noAssert",
    ], { stdio: "pipe", timeout: 120000 });
  } catch (err) {
    const stderr = err.stderr?.toString() || "";
    process.stderr.write(`asc compilation failed:\n${stderr}\n`);
    rmSync(tmpDir, { recursive: true, force: true });
    return null;
  }

  const wasmBytes = readFileSync(wasmOut);
  rmSync(tmpDir, { recursive: true, force: true });
  return wasmBytes;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const tablePath = process.argv[2];
const queryPath = process.argv[3];
if (!tablePath || !queryPath) {
  process.stderr.write("Usage: node run.mjs <table-path> <query-path>\n");
  process.exit(1);
}

const rules   = JSON.parse(readFileSync(tablePath, "utf8"));
const queries = JSON.parse(readFileSync(queryPath, "utf8"));

// Build and flatten trie — excluded from timing
const { nodes }          = buildTrie(rules);
const { nodeData, edgeData } = flattenTrie(nodes);
const queryBuf           = prehashQueries(queries);

// Resolve and compile AssemblyScript
const ascPath = resolveAsc();
if (!ascPath) {
  process.stdout.write(JSON.stringify({
    comparator: "yakcc-as",
    _blocker: "asc not found",
    matched_count: null,
    total_captures: null,
  }) + "\n");
  process.exit(0);
}

const wasmBytes = compileWasm(ascPath);
if (!wasmBytes) {
  process.stdout.write(JSON.stringify({
    comparator: "yakcc-as",
    _blocker: "asc compilation failed",
    matched_count: null,
    total_captures: null,
  }) + "\n");
  process.exit(0);
}

// Instantiate WASM
// @decision DEC-BENCH-B1-HTTP-AS-MEM-001
// AS --runtime stub exports its own WebAssembly.Memory with 0 initial pages.
// It does NOT import memory from the host. We must:
//   1. Instantiate with an empty imports object (no env.memory)
//   2. Use the exported `memory` object
//   3. Call memory.grow() to allocate the pages we need before writing data
// Injecting a host memory (as in some other AS setups) causes a trap because
// the exported memory handle would be a different object — writes via the host
// handle would not be visible to the WASM linear-memory reads.
const wasmModule = new WebAssembly.Module(wasmBytes);

// Calculate memory requirements
const ALIGN4 = n => (n + 3) & ~3;
const nodesBytes   = nodeData.byteLength;
const edgesBase    = NODES_BASE + ALIGN4(nodesBytes);
const edgesBytes   = edgeData.byteLength;
const queriesBase  = edgesBase + ALIGN4(edgesBytes);
const queriesBytes = queryBuf.byteLength;
const totalBytes   = queriesBase + queriesBytes + 65536; // headroom
const pageCount    = Math.ceil(totalBytes / 65536) + 2;

// Instantiate without injecting memory — use the WASM's exported memory
const wasmInstance = new WebAssembly.Instance(wasmModule, {});
const { matchAll, memory } = wasmInstance.exports;

if (typeof matchAll !== "function") {
  process.stdout.write(JSON.stringify({
    comparator: "yakcc-as",
    _blocker: "matchAll export not found in WASM",
  }) + "\n");
  process.exit(0);
}

if (!memory) {
  process.stdout.write(JSON.stringify({
    comparator: "yakcc-as",
    _blocker: "memory export not found in WASM",
  }) + "\n");
  process.exit(0);
}

// Grow the exported memory to fit our data
const currentPages = memory.buffer.byteLength / 65536;
if (pageCount > currentPages) {
  memory.grow(pageCount - currentPages);
}

// Write pre-flattened data into WASM memory — excluded from timing
const memU32 = new Uint32Array(memory.buffer);

// Write nodes
const nodesOff = NODES_BASE >> 2; // u32 offset
memU32.set(nodeData, nodesOff);

// Write edges
const edgesOff = edgesBase >> 2;
memU32.set(edgeData, edgesOff);

// Write queries
const queriesOff = queriesBase >> 2;
memU32.set(queryBuf, queriesOff);

const nodesCount   = nodes.length;
const edgesCount   = edgeData.length / 2;
const queryCount   = queries.length;

// Timing loop
const totalIters = WARMUP + MEASURED;
const latenciesMs = [];
let lastMatchedCount   = 0;
let lastTotalCaptures  = 0;

for (let iter = 0; iter < totalIters; iter++) {
  const t0 = performance.now();
  const packed = matchAll(
    NODES_BASE, nodesCount,
    edgesBase,  edgesCount,
    queriesBase, queryCount,
  );
  const elapsed = performance.now() - t0;

  // packed is a BigInt (i64) — split into high/low 32 bits
  const matchedCount  = Number(BigInt(packed) >> 32n);
  const totalCaptures = Number(BigInt(packed) & 0xFFFFFFFFn);

  lastMatchedCount  = matchedCount;
  lastTotalCaptures = totalCaptures;

  if (iter >= WARMUP) {
    latenciesMs.push(elapsed);
  }
}

latenciesMs.sort((a, b) => a - b);
const p50  = latenciesMs[Math.floor(MEASURED * 0.50)];
const p95  = latenciesMs[Math.floor(MEASURED * 0.95)];
const p99  = latenciesMs[Math.floor(MEASURED * 0.99)];
const mean = latenciesMs.reduce((s, v) => s + v, 0) / MEASURED;
const queriesPerSec = (queries.length / (mean / 1000));

const result = {
  comparator: "yakcc-as",
  p50_ms: p50,
  p95_ms: p95,
  p99_ms: p99,
  mean_ms: mean,
  queries_per_sec: queriesPerSec,
  iterations: MEASURED,
  matched_count: lastMatchedCount,
  total_captures: lastTotalCaptures,
};
process.stdout.write(JSON.stringify(result) + "\n");
