// SPDX-License-Identifier: MIT
// bench/B4-tokens-v5/tasks-hard/vitest.config.mjs
// Vitest config for the hard/large-atom oracle tests (#1049).
// Mirrors bench/B4-tokens-v5/vitest.config.mjs conventions; scoped to tasks-hard/.

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
    include: [
      "bench/B4-tokens-v5/tasks-hard/**/oracle.test.ts",
      "bench/B4-tokens-v5/tasks-hard/size-delta.test.mjs",
    ],
    environment: "node",
    reporter: ["dot"],
  },
};
