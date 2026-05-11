// SPDX-License-Identifier: MIT
//
// bench/B1-latency/http-routing/ts-baseline/run.ts
//
// @decision DEC-BENCH-B1-HTTP-TSNODE-001
// @title TypeScript/Node.js baseline: hand-rolled u32-keyed trie, timed match phase
// @status accepted
// @rationale
//   Hand-rolled trie matching parametric and wildcard routes. Segment strings are
//   hashed to u32 outside the timing loop (same djb2-variant as all other comparators)
//   so the inner trie walk is u32-keyed — identical workload to yakcc-as.
//   The timing loop covers only the 100K-query trie walk (pre-built trie excluded).
//
// Usage: node --experimental-strip-types --no-warnings ts-baseline/run.ts <table-path> <query-path>

import { readFileSync } from "node:fs";

const WARMUP   = 100;
const MEASURED = 1000;

const tablePath = process.argv[2];
const queryPath = process.argv[3];
if (!tablePath || !queryPath) {
  process.stderr.write("Usage: node run.ts <table-path> <query-path>\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Segment hashing — djb2 variant over UTF-8 bytes
// ---------------------------------------------------------------------------
const PARAM_SENTINEL    = 0x00000001;
const WILDCARD_SENTINEL = 0x00000002;

function hashSegment(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  // Reserve 1 and 2 for sentinels
  if (h < 3) h += 3;
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Trie node
// ---------------------------------------------------------------------------
interface TrieNode {
  children: Map<number, TrieNode>; // u32 key → child node
  handlerId: number;               // -1 = no route
  isWildcard: boolean;             // this node is a wildcard terminal
}

function makeNode(): TrieNode {
  return { children: new Map(), handlerId: -1, isWildcard: false };
}

// ---------------------------------------------------------------------------
// Build trie from routing table (excluded from timing)
// ---------------------------------------------------------------------------
type Rule = { type: string; pattern: string; handler_id: number };

function buildTrie(rules: Rule[]): TrieNode {
  const root = makeNode();
  for (const rule of rules) {
    const rawSegs = rule.pattern.split("/").filter(s => s.length > 0);
    let node = root;
    for (let i = 0; i < rawSegs.length; i++) {
      const seg = rawSegs[i]!;
      let key: number;
      let isWild = false;
      if (seg.startsWith(":")) {
        key = PARAM_SENTINEL;
      } else if (seg.startsWith("*")) {
        key = WILDCARD_SENTINEL;
        isWild = true;
      } else {
        key = hashSegment(seg);
      }
      let child = node.children.get(key);
      if (!child) {
        child = makeNode();
        child.isWildcard = isWild;
        node.children.set(key, child);
      }
      node = child;
    }
    node.handlerId = rule.handler_id;
  }
  return root;
}

// ---------------------------------------------------------------------------
// Pre-hash query paths (excluded from timing)
// ---------------------------------------------------------------------------
function prehashPath(path: string): number[] {
  return path.split("/").filter(s => s.length > 0).map(hashSegment);
}

// ---------------------------------------------------------------------------
// Trie match — returns { matched: boolean, captures: number }
// captures = number of param slots filled
// ---------------------------------------------------------------------------
function matchPath(root: TrieNode, hashedSegs: number[]): { matched: boolean; captures: number } {
  let node = root;
  let captures = 0;

  for (let i = 0; i < hashedSegs.length; i++) {
    const segHash = hashedSegs[i]!;

    // 1. Exact match
    const exactChild = node.children.get(segHash);
    if (exactChild) {
      node = exactChild;
      continue;
    }

    // 2. Param match
    const paramChild = node.children.get(PARAM_SENTINEL);
    if (paramChild) {
      captures++;
      node = paramChild;
      continue;
    }

    // 3. Wildcard match (consumes remaining segments)
    const wildcardChild = node.children.get(WILDCARD_SENTINEL);
    if (wildcardChild) {
      captures++;
      return { matched: wildcardChild.handlerId >= 0, captures };
    }

    return { matched: false, captures };
  }

  return { matched: node.handlerId >= 0, captures };
}

// ---------------------------------------------------------------------------
// Load corpora
// ---------------------------------------------------------------------------
const rules: Rule[] = JSON.parse(readFileSync(tablePath, "utf8")) as Rule[];
const queries: string[] = JSON.parse(readFileSync(queryPath, "utf8")) as string[];

// Build trie once — excluded from timing
const root = buildTrie(rules);

// Pre-hash all queries — excluded from timing
const hashedQueries: number[][] = queries.map(prehashPath);

const totalIters = WARMUP + MEASURED;
const latenciesMs: number[] = [];
let lastMatchedCount = 0;
let lastTotalCaptures = 0;

for (let iter = 0; iter < totalIters; iter++) {
  let matchedCount = 0;
  let totalCaptures = 0;

  const t0 = performance.now();
  for (let q = 0; q < hashedQueries.length; q++) {
    const r = matchPath(root, hashedQueries[q]!);
    if (r.matched) matchedCount++;
    totalCaptures += r.captures;
  }
  const elapsed = performance.now() - t0;

  lastMatchedCount = matchedCount;
  lastTotalCaptures = totalCaptures;
  if (iter >= WARMUP) {
    latenciesMs.push(elapsed);
  }
}

latenciesMs.sort((a, b) => a - b);
const p50  = latenciesMs[Math.floor(MEASURED * 0.50)]!;
const p95  = latenciesMs[Math.floor(MEASURED * 0.95)]!;
const p99  = latenciesMs[Math.floor(MEASURED * 0.99)]!;
const mean = latenciesMs.reduce((s, v) => s + v, 0) / MEASURED;
const queriesPerSec = (queries.length / (mean / 1000));

const result = {
  comparator: "ts-node",
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
