#!/usr/bin/env node
/**
 * sync-publish-assets.mjs
 *
 * Copies repo-root publish-time assets (LICENSE, LICENSE-ATOMS) into the
 * cli package directory so `npm pack` / `pnpm publish` includes them in the
 * tarball. README.md is maintained directly under packages/cli/ (the npm
 * registry shows the package-local README, not the repo-root one).
 */

import { copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(CLI_ROOT, "..", "..");

const ASSETS = ["LICENSE", "LICENSE-ATOMS"];

for (const name of ASSETS) {
  await copyFile(join(REPO_ROOT, name), join(CLI_ROOT, name));
  process.stdout.write(`[sync-publish-assets] copied ${name}\n`);
}
