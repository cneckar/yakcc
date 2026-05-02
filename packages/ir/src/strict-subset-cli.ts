// SPDX-License-Identifier: MIT
// @decision DEC-IR-CLI-002: strict-subset CLI updated for directory-based triplet authoring (WI-T02).
// Status: implemented (WI-T02)
// Rationale: The old CLI validated individual .ts files against the strict-subset banlist.
// WI-T02 replaces the inline-CONTRACT single-file shape with directory triplets
// (spec.yak, impl.ts, proof/manifest.json). The CLI now accepts a triplet directory
// as its argument and delegates to parseBlockTriplet, which validates spec.yak,
// manifest.json, and impl.ts (strict-subset) in one call. Exit codes are unchanged:
// 0=clean, 1=validation errors. When no argument is supplied, the CLI defaults to
// scanning packages/seeds/src/blocks/ as before, expecting each subdirectory to be
// a block triplet. Explicit directory argument overrides the default.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BlockTripletParseResult, parseBlockTriplet } from "./block-parser.js";

// ---------------------------------------------------------------------------
// Directory discovery
// ---------------------------------------------------------------------------

/** Walk a directory one level deep and collect subdirectory entries. */
function collectTripletDirs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Resolve the default block triplet root relative to the project root.
 *  The CLI lives in packages/ir/dist/strict-subset-cli.js, so the project root
 *  is four levels up: dist → ir → packages → <worktree-root>. */
function defaultBlockDir(): string {
  const cliFile = fileURLToPath(import.meta.url);
  const projectRoot = resolve(cliFile, "..", "..", "..", "..");
  return join(projectRoot, "packages", "seeds", "src", "blocks");
}

/**
 * Validate a single triplet directory via parseBlockTriplet.
 * Returns true if validation is clean; writes errors to stderr and returns false otherwise.
 */
function validateTripletDir(dir: string): boolean {
  let result: BlockTripletParseResult;
  try {
    result = parseBlockTriplet(dir);
  } catch (err) {
    process.stderr.write(
      `strict-subset: ${dir}: schema validation failed — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }

  if (!result.validation.ok) {
    for (const e of result.validation.errors) {
      process.stderr.write(`${e.file}:${e.line}:${e.column} ${e.rule}: ${e.message}\n`);
    }
    return false;
  }

  return true;
}

function main(): void {
  const args = process.argv.slice(2);

  let dirs: string[];

  if (args.length > 0) {
    // Caller supplied an explicit triplet directory — validate it directly.
    dirs = args;
  } else {
    // Default: scan packages/seeds/src/blocks/ subdirectories as triplet dirs.
    const blockDir = defaultBlockDir();
    if (!existsSync(blockDir)) {
      process.stdout.write(
        `strict-subset: no block triplets found at ${blockDir} (this is expected before WI-006 lands)\n`,
      );
      process.exit(0);
    }
    dirs = collectTripletDirs(blockDir);
    if (dirs.length === 0) {
      process.stdout.write(
        `strict-subset: block directory exists but contains no triplet subdirectories at ${blockDir}\n`,
      );
      process.exit(0);
    }
  }

  let failed = false;
  for (const dir of dirs) {
    if (!validateTripletDir(dir)) {
      failed = true;
    }
  }

  if (failed) {
    process.exit(1);
  }

  process.stdout.write(`strict-subset: ${dirs.length} triplet(s) validated OK\n`);
}

main();
