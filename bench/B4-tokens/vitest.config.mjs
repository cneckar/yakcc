// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/vitest.config.mjs
//
// Vitest configuration for B4-tokens oracle tests.
// Runs TypeScript oracle test files against reference implementations.
// The IMPL_PATH env var is set by oracle-runner.mjs to point to the file under test.
//
// NOTE: This config is intentionally minimal (no imports from vitest/config) so that
// it can be loaded by any vitest binary regardless of which package's node_modules
// hosts it. The config object shape is stable across vitest 2.x and 4.x.
//
// Root is set to the repo root (two levels up from this config's directory) so that
// oracle test files under bench/B4-tokens/tasks/ are visible regardless of which
// package's vitest binary is used to run them.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B4_ROOT = __dirname;
const REPO_ROOT = resolve(__dirname, "../..");

/** @type {import('vitest/config').UserConfig} */
export default {
  root: REPO_ROOT,
  test: {
    watch: false,
    testTimeout: 10_000,
    isolate: true,
    pool: "forks",
    include: ["bench/B4-tokens/tasks/**/oracle.test.ts"],
    environment: "node",
    reporter: ["verbose"],
  },
};
