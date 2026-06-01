// SPDX-License-Identifier: MIT
// bench/B4-tokens-v5/reference-emit/vitest.config.mjs
// Vitest config for the reference-emit offline measurement tests.
// Mirrors bench/B4-tokens-v5/vitest.config.mjs conventions.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

export default {
  root: REPO_ROOT,
  test: {
    watch: false,
    testTimeout: 60_000,
    isolate: true,
    pool: "forks",
    include: ["bench/B4-tokens-v5/reference-emit/measure.test.mjs"],
    environment: "node",
    reporter: ["verbose"],
  },
};
