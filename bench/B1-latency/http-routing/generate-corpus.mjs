// SPDX-License-Identifier: MIT
//
// bench/B1-latency/http-routing/generate-corpus.mjs
//
// One-off setup script that generates the deterministic HTTP routing corpora:
//   1. routing-table-10k.json — 10,000 route rules
//   2. query-set-100k.json   — 100,000 paths to match
//
// Both are content-addressed via SHA-256 and the spec is written to corpus-spec.json.
// Run: node bench/B1-latency/http-routing/generate-corpus.mjs

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname, "corpus");
const TABLE_PATH = join(CORPUS_DIR, "routing-table-10k.json");
const QUERY_PATH = join(CORPUS_DIR, "query-set-100k.json");
const SPEC_PATH  = join(__dirname, "corpus-spec.json");

// ---------------------------------------------------------------------------
// xorshift32 PRNG
// ---------------------------------------------------------------------------

function makeRng(seed) {
  let state = (seed >>> 0) || 1;
  return function next() {
    state ^= (state << 13) >>> 0;
    state ^= (state >>> 17) >>> 0;
    state ^= (state << 5)  >>> 0;
    state = state >>> 0;
    return state;
  };
}

// ---------------------------------------------------------------------------
// Route rule generation (seed 0xF00DCAFE)
// ---------------------------------------------------------------------------

const TABLE_SEED  = 0xF00DCAFE;
const QUERY_SEED  = 0xBEEFF00D;
const TABLE_COUNT = 10000;
const QUERY_COUNT = 100000;

// Segment pools for generating realistic path components
const STATIC_SEGMENTS = [
  "api", "v1", "v2", "v3", "users", "posts", "comments", "tags",
  "health", "status", "metrics", "admin", "auth", "login", "logout",
  "profile", "settings", "notifications", "dashboard", "reports",
  "orgs", "teams", "projects", "issues", "labels", "milestones",
  "files", "uploads", "assets", "images", "thumbnails", "docs",
  "search", "feed", "timeline", "events", "webhooks", "hooks",
  "billing", "invoices", "subscriptions", "plans", "tokens",
];

const PARAM_NAMES = [
  "id", "userId", "postId", "commentId", "orgId", "teamId",
  "projectId", "issueId", "fileId", "tagId", "labelId",
  "slug", "handle", "name", "ref", "sha",
];

const WILDCARD_NAMES = ["path", "rest", "glob", "tail", "file"];

/**
 * Generate a deterministic route rule.
 * @param {number} idx - Rule index (0-9999)
 * @param {Function} rng - Random number generator
 * @returns {{ type: string, pattern: string, handler_id: number }}
 */
function generateRule(idx, rng) {
  // Distribution: 50% static, 30% single-param, 15% multi-param, 5% wildcard
  const roll = rng() % 100;
  let type;
  if (roll < 50) type = "static";
  else if (roll < 80) type = "single-param";
  else if (roll < 95) type = "multi-param";
  else type = "wildcard";

  // Depth: 2–6 segments
  const depth = 2 + (rng() % 5); // 2,3,4,5,6

  const segments = [];

  if (type === "static") {
    for (let i = 0; i < depth; i++) {
      segments.push(STATIC_SEGMENTS[rng() % STATIC_SEGMENTS.length]);
    }
    // Append idx to guarantee uniqueness
    segments[segments.length - 1] = `${segments[segments.length - 1]}-${idx}`;
    return { type, pattern: "/" + segments.join("/"), handler_id: idx };
  }

  if (type === "single-param") {
    // Prefix: 1–3 static segments, then :param, then optional suffix
    const prefixLen = 1 + (rng() % Math.min(3, depth - 1));
    for (let i = 0; i < prefixLen; i++) {
      segments.push(STATIC_SEGMENTS[rng() % STATIC_SEGMENTS.length]);
    }
    const paramName = PARAM_NAMES[rng() % PARAM_NAMES.length];
    segments.push(`:${paramName}`);
    // Optional static suffix
    for (let i = prefixLen + 1; i < depth; i++) {
      segments.push(STATIC_SEGMENTS[rng() % STATIC_SEGMENTS.length]);
    }
    segments[0] = `${segments[0]}-${idx}`;
    return { type, pattern: "/" + segments.join("/"), handler_id: idx };
  }

  if (type === "multi-param") {
    // Interleave static and param segments
    const paramCount = 2;
    // e.g. /orgs/:org/users/:id
    for (let i = 0; i < depth; i++) {
      if (i % 2 === 0) {
        segments.push(STATIC_SEGMENTS[rng() % STATIC_SEGMENTS.length]);
      } else {
        const paramName = PARAM_NAMES[rng() % PARAM_NAMES.length];
        segments.push(`:${paramName}`);
      }
    }
    segments[0] = `${segments[0]}-${idx}`;
    return { type, pattern: "/" + segments.join("/"), handler_id: idx };
  }

  // wildcard
  const prefixLen = 1 + (rng() % Math.max(1, depth - 1));
  for (let i = 0; i < prefixLen; i++) {
    segments.push(STATIC_SEGMENTS[rng() % STATIC_SEGMENTS.length]);
  }
  const wildcardName = WILDCARD_NAMES[rng() % WILDCARD_NAMES.length];
  segments.push(`*${wildcardName}`);
  segments[0] = `${segments[0]}-${idx}`;
  return { type, pattern: "/" + segments.join("/"), handler_id: idx };
}

// ---------------------------------------------------------------------------
// Query set generation (seed 0xBEEFF00D)
// ---------------------------------------------------------------------------

/**
 * Generate a query path from a route table.
 * @param {Array} rules - Array of route rules
 * @param {Function} rng
 * @returns {string}
 */
function generateQuery(rules, rng) {
  // Distribution: 70% static hit, 25% param hit, 5% miss
  const roll = rng() % 100;

  if (roll < 70) {
    // Static hit: pick a static rule and use its exact pattern
    const staticRules = rules.filter(r => r.type === "static");
    const rule = staticRules[rng() % staticRules.length];
    return rule.pattern;
  }

  if (roll < 95) {
    // Param hit: pick a param/multi-param/wildcard rule and fill in concrete values
    const paramRules = rules.filter(r => r.type !== "static");
    if (paramRules.length === 0) {
      // Fallback to static
      const staticRules = rules.filter(r => r.type === "static");
      return staticRules[rng() % staticRules.length].pattern;
    }
    const rule = paramRules[rng() % paramRules.length];
    // Replace :param and *wildcard with concrete values
    const concreteId = (rng() % 999983) + 1;  // prime-ish range
    const path = rule.pattern
      .replace(/:[a-zA-Z]+/g, () => String(concreteId))
      .replace(/\*[a-zA-Z]+$/, () => `file-${concreteId}.txt`);
    return path;
  }

  // Miss: generate a path that won't match any rule
  const depth = 2 + (rng() % 4);
  const segs = ["miss"];
  for (let i = 1; i < depth; i++) {
    segs.push(`unknown-${rng() % 10000}`);
  }
  return "/" + segs.join("/");
}

// ---------------------------------------------------------------------------
// Main generation
// ---------------------------------------------------------------------------

mkdirSync(CORPUS_DIR, { recursive: true });

console.log(`Generating ${TABLE_COUNT} routing rules (seed 0x${TABLE_SEED.toString(16)})...`);
const tableRng = makeRng(TABLE_SEED);
const rules = [];
for (let i = 0; i < TABLE_COUNT; i++) {
  rules.push(generateRule(i, tableRng));
}

// Deduplicate patterns (collisions can occur; later rule wins — append index suffix ensures uniqueness)
const seen = new Set();
const deduped = [];
for (const rule of rules) {
  if (!seen.has(rule.pattern)) {
    seen.add(rule.pattern);
    deduped.push(rule);
  }
}
if (deduped.length < TABLE_COUNT) {
  console.warn(`  Warning: ${TABLE_COUNT - deduped.length} duplicate patterns removed. Using ${deduped.length} unique rules.`);
}

const tableJson = JSON.stringify(deduped, null, 0);
writeFileSync(TABLE_PATH, tableJson, "utf8");
const tableSha = createHash("sha256").update(tableJson, "utf8").digest("hex");
console.log(`  SHA-256: ${tableSha}`);
console.log(`  Size: ${(tableJson.length / 1024).toFixed(1)} KB`);
console.log(`  Static: ${deduped.filter(r => r.type === "static").length}`);
console.log(`  Single-param: ${deduped.filter(r => r.type === "single-param").length}`);
console.log(`  Multi-param: ${deduped.filter(r => r.type === "multi-param").length}`);
console.log(`  Wildcard: ${deduped.filter(r => r.type === "wildcard").length}`);

console.log(`\nGenerating ${QUERY_COUNT} query paths (seed 0x${QUERY_SEED.toString(16)})...`);
const queryRng = makeRng(QUERY_SEED);
const queries = [];
for (let i = 0; i < QUERY_COUNT; i++) {
  queries.push(generateQuery(deduped, queryRng));
}

const queryJson = JSON.stringify(queries, null, 0);
writeFileSync(QUERY_PATH, queryJson, "utf8");
const querySha = createHash("sha256").update(queryJson, "utf8").digest("hex");
console.log(`  SHA-256: ${querySha}`);
console.log(`  Size: ${(queryJson.length / 1024).toFixed(1)} KB`);

// Update corpus-spec.json with actual SHA-256 hashes
const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
spec.routing_table.sha256 = tableSha;
spec.routing_table.actual_rule_count = deduped.length;
spec.query_set.sha256 = querySha;
spec.query_set.actual_query_count = QUERY_COUNT;
writeFileSync(SPEC_PATH, JSON.stringify(spec, null, 2) + "\n", "utf8");

console.log(`\nCorpora written to ${CORPUS_DIR}`);
console.log(`Spec updated: ${SPEC_PATH}`);
