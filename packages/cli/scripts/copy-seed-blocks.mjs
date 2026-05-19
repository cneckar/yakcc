#!/usr/bin/env node
/**
 * copy-seed-blocks.mjs
 *
 * Post-bundle step for the published @yakcc/cli package.
 *
 * After tsup inlines @yakcc/seeds into dist/bin.js + dist/index.js, the
 * `seedRegistry` function (originally seed.ts) still resolves the blocks
 * directory via `dirname(fileURLToPath(import.meta.url)) + "/blocks"`. Once
 * bundled into cli/dist/bin.js, that path resolves to cli/dist/blocks/ — which
 * does not exist until this script copies the triplet sources there.
 *
 * We copy the same file set that packages/seeds/src/_scripts/copy-triplets.mjs
 * copies (spec.yak, impl.ts, proof/manifest.json, proof/tests.fast-check.ts),
 * so the cli's runtime seed loader behaves identically to the in-monorepo path.
 *
 * Exit 1 if any required file is missing from the source tree.
 */

import { access, copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(CLI_ROOT, "..", "..");
const SRC_BLOCKS = join(REPO_ROOT, "packages", "seeds", "src", "blocks");
const DEST_BLOCKS = join(CLI_ROOT, "dist", "blocks");

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

async function copyBootstrapCorpus() {
  const REPO_ROOT_BOOTSTRAP = resolve(REPO_ROOT, "bootstrap");
  const DEST_BOOTSTRAP = join(CLI_ROOT, "dist", "bootstrap");
  const items = [
    { src: "yakcc.registry.sqlite", required: true },
    { src: "expected-roots.json", required: false },
    { src: "expected-failures.json", required: false },
  ];
  let copied = 0;
  for (const { src, required } of items) {
    const srcPath = join(REPO_ROOT_BOOTSTRAP, src);
    if (!(await fileExists(srcPath))) {
      if (required) {
        process.stderr.write(`[copy-seed-blocks] ERROR: required bootstrap asset missing: ${srcPath}\n`);
        process.exit(1);
      }
      continue;
    }
    const destPath = join(DEST_BOOTSTRAP, src);
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(srcPath, destPath);
    copied++;
  }
  process.stdout.write(`[copy-seed-blocks] copied ${copied} bootstrap asset(s) to ${DEST_BOOTSTRAP}\n`);
}

async function main() {
  let hasError = false;

  let blockNames;
  try {
    const entries = await readdir(SRC_BLOCKS, { withFileTypes: true });
    blockNames = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (err) {
    process.stderr.write(`[copy-seed-blocks] ERROR: cannot read ${SRC_BLOCKS}: ${err.message}\n`);
    process.exit(1);
  }

  if (blockNames.length === 0) {
    process.stderr.write("[copy-seed-blocks] ERROR: no block directories found\n");
    process.exit(1);
  }

  let filesCopied = 0;
  for (const name of blockNames) {
    const srcDir = join(SRC_BLOCKS, name);
    const destDir = join(DEST_BLOCKS, name);

    for (const { rel, required } of COPY_TARGETS) {
      const srcFile = join(srcDir, rel);
      const destFile = join(destDir, rel);

      if (!(await fileExists(srcFile))) {
        if (required) {
          process.stderr.write(`[copy-seed-blocks] ERROR: required file missing: ${srcFile}\n`);
          hasError = true;
        }
        continue;
      }

      await mkdir(dirname(destFile), { recursive: true });
      await copyFile(srcFile, destFile);
      filesCopied++;
    }
  }

  process.stdout.write(
    `[copy-seed-blocks] copied ${filesCopied} files across ${blockNames.length} blocks to ${DEST_BLOCKS}\n`,
  );

  if (hasError) {
    process.exit(1);
  }

  await copyBootstrapCorpus();
}

main().catch((err) => {
  process.stderr.write(`[copy-seed-blocks] FATAL: ${err.message}\n`);
  process.exit(1);
});
