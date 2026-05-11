// SPDX-License-Identifier: MIT
//
// bench/B1-latency/integer-math/generate-corpus.mjs
//
// One-off setup script that produces the deterministic 100MB byte buffer
// used as the SHA-256 benchmark corpus.
//
// Algorithm: xorshift32 PRNG with fixed seed 0xDEADBEEF.
// The resulting 100MB buffer is content-addressed by its SHA-256 hash.
// corpus-spec.json records the expected hash and generator parameters.
//
// Run: node bench/B1-latency/integer-math/generate-corpus.mjs

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname, "corpus");
const CORPUS_PATH = join(CORPUS_DIR, "input-100MB.bin");
const SPEC_PATH = join(__dirname, "corpus-spec.json");

const SIZE_BYTES = 104857600; // 100 * 1024 * 1024

// xorshift32 PRNG — deterministic, fast, no dependencies.
// Same algorithm used by C xorshift32 implementations.
function xorshift32Seed(seed) {
  let state = seed >>> 0; // ensure 32-bit unsigned
  return function next() {
    state ^= (state << 13) >>> 0;
    state ^= (state >>> 17) >>> 0;
    state ^= (state << 5) >>> 0;
    state = state >>> 0;
    return state;
  };
}

console.log(`Generating ${SIZE_BYTES} byte corpus (xorshift32, seed=0xDEADBEEF)...`);

const buf = Buffer.alloc(SIZE_BYTES);
const prng = xorshift32Seed(0xDEADBEEF);

// Fill 4 bytes at a time for speed
let offset = 0;
while (offset + 4 <= SIZE_BYTES) {
  const val = prng();
  buf.writeUInt32LE(val, offset);
  offset += 4;
}
// Fill any remaining bytes (SIZE_BYTES is divisible by 4, so this is a no-op)
while (offset < SIZE_BYTES) {
  buf[offset++] = prng() & 0xff;
}

const sha256 = createHash("sha256").update(buf).digest("hex");

mkdirSync(CORPUS_DIR, { recursive: true });
writeFileSync(CORPUS_PATH, buf);
console.log(`Written: ${CORPUS_PATH}`);
console.log(`SHA-256:  ${sha256}`);
console.log(`Size:     ${SIZE_BYTES} bytes`);

// Write or verify corpus-spec.json
const spec = {
  algorithm: "xorshift32",
  seed: "0xDEADBEEF",
  seed_decimal: 3735928559,
  size_bytes: SIZE_BYTES,
  sha256,
  generated_at: new Date().toISOString(),
  note: "Deterministic: regenerating with same algorithm+seed always produces the same buffer and hash.",
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
