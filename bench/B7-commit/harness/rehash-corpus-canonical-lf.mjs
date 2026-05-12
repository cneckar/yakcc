/**
 * rehash-corpus-canonical-lf.mjs
 *
 * One-shot maintenance utility: recomputes SHA-256 hashes for every file listed
 * in corpus-spec.json using LF-canonical bytes (CRLF → LF before hashing), then
 * writes the updated hashes back to corpus-spec.json.
 *
 * Run this whenever a corpus *.ts file is legitimately edited:
 *
 *   node bench/B7-commit/harness/rehash-corpus-canonical-lf.mjs
 *
 * @decision DEC-BENCH-B7-CORPUS-CANONICAL-LF-001
 * @title Canonical-LF SHA-256 hashing for B7 corpus integrity
 * @status accepted
 * @rationale Hashes stored in corpus-spec.json are computed from LF-normalized
 *   bytes. This makes them reproducible across Windows (CRLF checkout) and Linux
 *   (LF checkout) CI environments. The harness always normalizes CRLF→LF before
 *   hashing on read, so the stored hash equals what every platform sees. The
 *   original bug was that corpus-spec.json stored Windows CRLF-byte hashes while
 *   Linux CI checked out LF bytes, making verification always fail on CI.
 *   Maintenance escape hatch: re-run this script after any legitimate corpus edit.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname, "..", "corpus");
const CORPUS_SPEC_PATH = join(__dirname, "..", "corpus-spec.json");

/**
 * Normalize CRLF → LF and return a Buffer with LF-only line endings.
 * This is the canonical form used for hashing — matches what Linux CI sees.
 * @param {Buffer} rawBytes
 * @returns {Buffer}
 */
function toCanonicalLf(rawBytes) {
  return Buffer.from(rawBytes.toString("binary").replace(/\r\n/g, "\n"), "binary");
}

/**
 * Compute SHA-256 of LF-canonical bytes.
 * @param {Buffer} rawBytes
 * @returns {string} hex digest
 */
function sha256CanonicalLf(rawBytes) {
  const lfBytes = toCanonicalLf(rawBytes);
  return createHash("sha256").update(lfBytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const spec = JSON.parse(readFileSync(CORPUS_SPEC_PATH, "utf8"));
let updated = 0;

console.log(`[rehash] Processing ${spec.files.length} corpus files (canonical-LF hashing)...\n`);

for (const entry of spec.files) {
  const filePath = join(CORPUS_DIR, entry.filename);
  const rawBytes = readFileSync(filePath);
  const newHash = sha256CanonicalLf(rawBytes);
  const changed = newHash !== entry.sha256;

  if (changed) {
    console.log(`  [UPDATED] ${entry.filename}`);
    console.log(`    old: ${entry.sha256}`);
    console.log(`    new: ${newHash}`);
    entry.sha256 = newHash;
    updated++;
  } else {
    console.log(`  [OK]      ${entry.filename} — ${newHash.slice(0, 16)}... (unchanged)`);
  }
}

writeFileSync(CORPUS_SPEC_PATH, JSON.stringify(spec, null, 2) + "\n", "utf8");

console.log(`\n[rehash] Done. ${updated} hash(es) updated, ${spec.files.length - updated} unchanged.`);
console.log(`[rehash] corpus-spec.json written.`);
