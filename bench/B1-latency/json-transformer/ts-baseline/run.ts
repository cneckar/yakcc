// SPDX-License-Identifier: MIT
//
// bench/B1-latency/json-transformer/ts-baseline/run.ts
//
// @decision DEC-BENCH-B1-JSON-TSNODE-001
// @title TypeScript/Node.js baseline uses JSON.parse + recursive DFS sum-of-numeric-leaves
// @status accepted
// @rationale
//   Node.js JSON.parse is V8's built-in C++ parser, which may use SIMD on some platforms.
//   JSON.parse is called once outside the timing loop. The timing loop covers only the
//   recursive DFS accumulation — equivalent to what yakcc-as times (DFS over a
//   pre-parsed binary tree). This gives a fair comparison: parse cost is excluded
//   from timing for all comparators that have a pre-parse step.
//
// Usage: node --experimental-strip-types --no-warnings ts-baseline/run.ts <corpus-path>

import { readFileSync } from "node:fs";

const WARMUP = 100;
const MEASURED = 1000;

const corpusPath = process.argv[2];
if (!corpusPath) {
  process.stderr.write("Usage: node run.ts <corpus-path>\n");
  process.exit(1);
}

const jsonStr = readFileSync(corpusPath, "utf8");
const sizeMb = Buffer.byteLength(jsonStr, "utf8") / (1024 * 1024);

// Parse once outside timing loop
type JsonValue = number | string | boolean | null | JsonValue[] | { [k: string]: JsonValue };
const tree: JsonValue = JSON.parse(jsonStr) as JsonValue;

function sumNumericLeaves(v: JsonValue): number {
  if (typeof v === "number") return v;
  if (Array.isArray(v)) {
    let sum = 0;
    for (const item of v) sum += sumNumericLeaves(item);
    return sum;
  }
  if (v !== null && typeof v === "object") {
    let sum = 0;
    for (const val of Object.values(v)) sum += sumNumericLeaves(val);
    return sum;
  }
  return 0;
}

const totalIters = WARMUP + MEASURED;
const latenciesMs: number[] = [];
let lastSum = 0;

for (let i = 0; i < totalIters; i++) {
  const start = performance.now();
  const sum = sumNumericLeaves(tree);
  const elapsed = performance.now() - start;
  lastSum = sum;
  if (i >= WARMUP) {
    latenciesMs.push(elapsed);
  }
}

latenciesMs.sort((a, b) => a - b);
const p50 = latenciesMs[Math.floor(MEASURED * 0.50)]!;
const p95 = latenciesMs[Math.floor(MEASURED * 0.95)]!;
const p99 = latenciesMs[Math.floor(MEASURED * 0.99)]!;
const mean = latenciesMs.reduce((s, v) => s + v, 0) / MEASURED;
const throughputMbPerSec = sizeMb / (mean / 1000);

const result = {
  comparator: "ts-node",
  p50_ms: p50,
  p95_ms: p95,
  p99_ms: p99,
  mean_ms: mean,
  throughput_mb_per_sec: throughputMbPerSec,
  iterations: MEASURED,
  checksum: lastSum,
};
process.stdout.write(JSON.stringify(result) + "\n");
