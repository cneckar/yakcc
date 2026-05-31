// SPDX-License-Identifier: MIT
// bench/B4-tokens-v5/vitest.config.mjs
// Vitest configuration for B4-tokens-v5 unit + derivation tests.
// Mirrors bench/B4-tokens-v4/vitest.config.mjs.
// Root set to repo root so oracle tests under tasks/ are visible from any vitest binary.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

export default {
  root: REPO_ROOT,
  test: {
    watch: false,
    testTimeout: 30_000,
    isolate: true,
    pool: 'forks',
    include: [
      'bench/B4-tokens-v5/harness/harness-unit.test.mjs',
      'bench/B4-tokens-v5/tasks/**/oracle.test.ts',
    ],
    environment: 'node',
    reporter: ['verbose'],
  },
};
