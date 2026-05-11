// SPDX-License-Identifier: MIT
//
// bench/B1-latency/json-transformer/generate-corpus.mjs
//
// One-off setup script that produces the deterministic ~100MB JSON corpus
// used as the json-transformer benchmark input.
//
// Algorithm:
//   - xorshift32 PRNG with fixed seed 0xCAFEF00D (distinct from Slice 1's 0xDEADBEEF)
//   - Recursive tree builder: objects, arrays, strings, numbers, booleans, nulls
//   - Type distribution: ~30% objects, ~20% arrays, ~15% numbers, ~20% strings,
//     ~10% booleans, ~5% nulls
//   - Tree depth: average 8-12 levels, max 20
//   - Generates until JSON serialization is >= TARGET_SIZE_BYTES (~100MB)
//
// Run: node bench/B1-latency/json-transformer/generate-corpus.mjs

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname, "corpus");
const CORPUS_PATH = join(CORPUS_DIR, "input-100MB.json");
const SPEC_PATH = join(__dirname, "corpus-spec.json");

// Target size: ~100MB of serialized JSON
const TARGET_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

// xorshift32 PRNG — same algorithm as Slice 1, different seed
function xorshift32Seed(seed) {
  let state = seed >>> 0;
  return function next() {
    state ^= (state << 13) >>> 0;
    state ^= (state >>> 17) >>> 0;
    state ^= (state << 5) >>> 0;
    state = state >>> 0;
    return state;
  };
}

// A small dictionary of varied-casing key names to simulate real-world API objects.
// About 50% need camelCase transformation (snake_case, kebab-case, SCREAMING_CASE).
const KEY_POOL = [
  // snake_case (need transform)
  "user_id", "first_name", "last_name", "created_at", "updated_at",
  "total_count", "page_size", "is_active", "error_message", "retry_count",
  "max_attempts", "base_url", "api_key", "request_id", "status_code",
  "response_body", "content_type", "auth_token", "expires_in", "access_level",
  // kebab-case (need transform)
  "event-type", "trace-id", "span-id", "parent-id", "service-name",
  "host-name", "port-number", "health-check", "rate-limit", "feature-flag",
  // camelCase (no transform needed)
  "userId", "firstName", "lastName", "createdAt", "updatedAt",
  "totalCount", "pageSize", "isActive", "errorMessage", "retryCount",
  // SCREAMING_CASE (need transform)
  "MAX_SIZE", "MIN_VALUE", "DEFAULT_TIMEOUT", "ERROR_CODE", "STATUS_OK",
  // short keys for density
  "id", "ts", "v", "ok", "n", "t", "s", "x", "y", "z",
];

// Sample string pool for values
const STRING_POOL = [
  "pending", "active", "inactive", "error", "success",
  "GET", "POST", "PUT", "DELETE", "PATCH",
  "application/json", "text/plain", "application/xml",
  "https://api.example.com", "https://events.example.org",
  "us-east-1", "eu-west-2", "ap-southeast-1",
  "trace-abc123", "span-xyz789", "session-00001",
  "2026-01-01T00:00:00Z", "2026-05-10T12:34:56.789Z",
  "admin", "user", "guest", "service-account",
  "v1", "v2", "v3", "stable", "beta", "canary",
];

function buildTree(prng, depth, maxDepth) {
  // Type distribution via PRNG:
  //   0-29: object (30%)
  //   30-49: array (20%)
  //   50-64: number (15%)
  //   65-84: string (20%)
  //   85-94: boolean (10%)
  //   95-99: null (5%)
  const roll = prng() % 100;

  if (depth >= maxDepth) {
    // Force a leaf at max depth
    const leafRoll = prng() % 45;
    if (leafRoll < 15) return (prng() % 1000000) / 100.0;
    if (leafRoll < 35) return STRING_POOL[prng() % STRING_POOL.length];
    if (leafRoll < 45) return (prng() % 2) === 0;
    return null;
  }

  if (roll < 30) {
    // Object: 2-8 keys
    const numKeys = 2 + (prng() % 7);
    const obj = {};
    for (let k = 0; k < numKeys; k++) {
      const key = KEY_POOL[prng() % KEY_POOL.length];
      // Deduplicate by appending index if already present
      const finalKey = obj.hasOwnProperty(key) ? `${key}_${k}` : key;
      obj[finalKey] = buildTree(prng, depth + 1, maxDepth);
    }
    return obj;
  } else if (roll < 50) {
    // Array: 2-10 items
    const numItems = 2 + (prng() % 9);
    const arr = [];
    for (let i = 0; i < numItems; i++) {
      arr.push(buildTree(prng, depth + 1, maxDepth));
    }
    return arr;
  } else if (roll < 65) {
    // Number: signed, may be float
    const isFloat = (prng() % 2) === 0;
    if (isFloat) {
      return ((prng() % 2000000) - 1000000) / 1000.0;
    }
    return (prng() % 2000000) - 1000000;
  } else if (roll < 85) {
    // String
    return STRING_POOL[prng() % STRING_POOL.length];
  } else if (roll < 95) {
    // Boolean
    return (prng() % 2) === 0;
  } else {
    // Null
    return null;
  }
}

console.log(`Generating ~${TARGET_SIZE_BYTES} byte JSON corpus (xorshift32, seed=0xCAFEF00D)...`);

const prng = xorshift32Seed(0xCAFEF00D);

// Generate a large top-level array of subtrees.
// We grow it until the serialized JSON hits ~100MB.
const chunks = [];
let approxSize = 2; // "[]" base

while (approxSize < TARGET_SIZE_BYTES) {
  // Each top-level entry is an object with depth 8-12
  const maxDepth = 8 + (prng() % 5);
  const entry = buildTree(prng, 0, maxDepth);
  const serialized = JSON.stringify(entry);
  chunks.push(serialized);
  approxSize += serialized.length + 2; // +2 for ", " or "[" "," leading chars
}

// Build final JSON array
const jsonStr = "[" + chunks.join(",") + "]";
const actualSize = Buffer.byteLength(jsonStr, "utf8");
const sha256 = createHash("sha256").update(jsonStr).digest("hex");

console.log(`Actual size: ${actualSize} bytes (${(actualSize / 1024 / 1024).toFixed(1)}MB)`);
console.log(`SHA-256: ${sha256}`);

mkdirSync(CORPUS_DIR, { recursive: true });
writeFileSync(CORPUS_PATH, jsonStr, "utf8");
console.log(`Written: ${CORPUS_PATH}`);

// Write or verify corpus-spec.json
const spec = {
  algorithm: "xorshift32",
  seed: "0xCAFEF00D",
  seed_decimal: 0xCAFEF00D >>> 0,
  target_size_bytes: TARGET_SIZE_BYTES,
  actual_size_bytes: actualSize,
  sha256,
  generated_at: new Date().toISOString(),
  note: "Deterministic: regenerating with same algorithm+seed always produces the same JSON and hash.",
};

if (existsSync(SPEC_PATH)) {
  const existing = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
  if (existing.sha256 !== sha256) {
    console.error(`ERROR: regenerated hash ${sha256} differs from spec ${existing.sha256}`);
    process.exit(1);
  }
  console.log("corpus-spec.json matches — corpus is content-addressed correctly.");
} else {
  writeFileSync(SPEC_PATH, JSON.stringify(spec, null, 2) + "\n", "utf8");
  console.log(`Written: ${SPEC_PATH}`);
}

console.log("Corpus generation complete.");
