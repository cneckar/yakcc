// SPDX-License-Identifier: MIT
//
// bench/B1-latency/integer-math/ts-baseline/run.ts
//
// @decision DEC-BENCH-B1-TSNODE-001
// @title TypeScript/Node.js baseline uses Node crypto.createHash("sha256") (OpenSSL-backed)
// @status accepted
// @rationale
//   Node.js crypto.createHash("sha256") delegates to OpenSSL, which uses hardware
//   SHA-NI on x86-64. This gives the Node V8 baseline a fair comparison point:
//   both Rust and Node use hardware-accelerated SHA-256, with the overhead difference
//   being the JS/Node call overhead vs native Rust. The yakcc-as WASM comparator
//   uses a pure-software WASM SHA-256 implementation with no hardware acceleration,
//   making the Rust comparator the load-bearing pass/kill bar.
//
// Reads corpus from argv[2] (tsx passes argv differently), runs 100 warm-up +
// 1000 measured SHA-256 iterations, prints JSON to stdout.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const WARMUP = 100;
const MEASURED = 1000;

const corpusPath = process.argv[2];
if (!corpusPath) {
  process.stderr.write("Usage: tsx run.ts <corpus-path>\n");
  process.exit(1);
}

const buf = readFileSync(corpusPath);
const sizeMb = buf.length / (1024 * 1024);
const totalIters = WARMUP + MEASURED;

const latenciesMs: number[] = [];

for (let i = 0; i < totalIters; i++) {
  const start = performance.now();
  createHash("sha256").update(buf).digest();
  const elapsed = performance.now() - start;
  if (i >= WARMUP) {
    latenciesMs.push(elapsed);
  }
}

// Compute statistics
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
};
process.stdout.write(JSON.stringify(result) + "\n");
