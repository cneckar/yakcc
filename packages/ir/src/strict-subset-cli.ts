// @decision DEC-IR-CLI-001: strict-subset CLI defaults to packages/seeds/src/blocks/**/*.ts.
// Status: implemented (WI-004)
// Rationale: The strict-subset validator is meant to validate BLOCK sources (seed
// contract implementations), NOT the IR toolchain itself. The CLI defaults to the
// canonical block directory so `pnpm strict-subset` is meaningful without args.
// When the block directory doesn't exist yet (before WI-006), the CLI exits 0 with
// a clear message rather than erroring — this prevents CI breakage during the
// WI-005/WI-006 gap. Explicit file/glob arguments override the default.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateStrictSubsetFile } from "./strict-subset.js";

// ---------------------------------------------------------------------------
// Path discovery
// ---------------------------------------------------------------------------

/** Walk a directory recursively and collect .ts files (excluding .d.ts). */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Resolve the default block directory relative to the project root.
 *  The CLI lives in packages/ir/dist/strict-subset-cli.js, so the project root
 *  is four levels up: dist → ir → packages → <worktree-root>. */
function defaultBlockDir(): string {
  const cliFile = fileURLToPath(import.meta.url);
  // dist/strict-subset-cli.js → go up four levels to reach the worktree root.
  const projectRoot = resolve(cliFile, "..", "..", "..", "..");
  return join(projectRoot, "packages", "seeds", "src", "blocks");
}

function main(): void {
  const explicit = process.argv.slice(2);
  let files: string[];

  if (explicit.length > 0) {
    // Caller supplied explicit paths — use them directly.
    files = explicit;
  } else {
    // Default: scan packages/seeds/src/blocks/**/*.ts
    const blockDir = defaultBlockDir();
    if (!existsSync(blockDir)) {
      process.stdout.write(
        `strict-subset: no block sources found at ${blockDir} (this is expected before WI-006 lands)\n`,
      );
      process.exit(0);
    }
    files = collectTsFiles(blockDir);
    if (files.length === 0) {
      process.stdout.write(
        `strict-subset: block directory exists but contains no .ts files at ${blockDir}\n`,
      );
      process.exit(0);
    }
  }

  let failed = false;
  for (const f of files) {
    const result = validateStrictSubsetFile(f);
    if (!result.ok) {
      for (const e of result.errors) {
        process.stderr.write(`${e.file}:${e.line}:${e.column} ${e.rule}: ${e.message}\n`);
      }
      failed = true;
    }
  }

  if (failed) {
    process.exit(1);
  }

  process.stdout.write(`strict-subset: ${files.length} file(s) validated OK\n`);
}

main();
