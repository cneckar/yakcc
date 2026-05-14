/**
 * copy-triplets.mjs
 *
 * Post-build script: copies non-TypeScript triplet files from src/blocks into
 * dist/blocks so the compiled CLI binary can enumerate seed-block triplets at
 * runtime without relying on vitest path aliases that redirect to src/.
 *
 * Files copied per block:
 *   src/blocks/<name>/spec.yak          → dist/blocks/<name>/spec.yak
 *   src/blocks/<name>/impl.ts           → dist/blocks/<name>/impl.ts
 *   src/blocks/<name>/proof/manifest.json    → dist/blocks/<name>/proof/manifest.json
 *   src/blocks/<name>/proof/tests.fast-check.ts → dist/blocks/<name>/proof/tests.fast-check.ts
 *
 * Only files that actually exist in src/ are copied; missing optional files
 * produce a warning but do not abort the script.
 *
 * Exit codes:
 *   0 — all required files copied successfully
 *   1 — at least one required file (spec.yak or proof/manifest.json) was missing
 *
 * @decision DEC-SEEDS-COPY-001
 * title: Post-build triplet copy ensures compiled binary can enumerate seed blocks
 * status: accepted
 * rationale: tsc copies only .ts→.js; non-TS source files (spec.yak,
 *   manifest.json) must be explicitly copied so the CLI binary's seeder path
 *   works without vitest path-alias redirects. Using a plain node script (no
 *   new deps, cross-platform) keeps the build chain simple and verifiable.
 *   Script lives under src/_scripts/ (in scope per WI-T06 scope manifest) and
 *   is excluded from tsc compilation via tsconfig.json exclude array addition.
 */

import { access, copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Package root is two directories up from src/_scripts/
const PKG_ROOT = resolve(__dirname, "../../");
const SRC_BLOCKS = join(PKG_ROOT, "src", "blocks");
const DIST_BLOCKS = join(PKG_ROOT, "dist", "blocks");

/**
 * Files copied per block.
 * "required: true" → exit 1 if absent in src/
 * "required: false" → log a warning but continue
 */
const COPY_TARGETS = [
  { rel: "spec.yak", required: true },
  { rel: "impl.ts", required: false },
  { rel: "proof/manifest.json", required: true },
  { rel: "proof/tests.fast-check.ts", required: false },
];

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  let hasError = false;

  // Enumerate block directories in src/blocks/
  let blockNames;
  try {
    const entries = await readdir(SRC_BLOCKS, { withFileTypes: true });
    // Sort for deterministic iteration order (aligns with "sort before iterate"
    // convention used throughout the codebase; cosmetic here but prevents
    // platform-readdir-order surprises in log output and future callers).
    blockNames = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    process.stderr.write(`[copy-triplets] ERROR: cannot read ${SRC_BLOCKS}: ${err.message}\n`);
    process.exit(1);
  }

  if (blockNames.length === 0) {
    process.stderr.write("[copy-triplets] WARNING: no block directories found in src/blocks/\n");
  }

  for (const name of blockNames) {
    const srcDir = join(SRC_BLOCKS, name);
    const distDir = join(DIST_BLOCKS, name);

    for (const { rel, required } of COPY_TARGETS) {
      const srcFile = join(srcDir, rel);
      const distFile = join(distDir, rel);

      if (!(await fileExists(srcFile))) {
        if (required) {
          process.stderr.write(`[copy-triplets] ERROR: required file missing: ${srcFile}\n`);
          hasError = true;
        } else {
          process.stderr.write(
            `[copy-triplets] WARN: optional file absent, skipping: ${srcFile}\n`,
          );
        }
        continue;
      }

      // Ensure destination directory exists (handles proof/ subdirectory)
      await mkdir(dirname(distFile), { recursive: true });
      await copyFile(srcFile, distFile);
      process.stdout.write(`[copy-triplets] copied ${join(name, rel)}\n`);
    }
  }

  if (hasError) {
    process.stderr.write("[copy-triplets] FAILED — one or more required files were missing\n");
    process.exit(1);
  }

  process.stdout.write(`[copy-triplets] done — ${blockNames.length} block(s) processed\n`);
}

main().catch((err) => {
  process.stderr.write(`[copy-triplets] FATAL: ${err.message}\n`);
  process.exit(1);
});
