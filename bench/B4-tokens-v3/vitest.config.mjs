// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v3/vitest.config.mjs
//
// Vitest configuration for B4-tokens-v3 oracle tests.
// Mirrors bench/B4-tokens/vitest.config.mjs; root set to repo root so oracle
// tests under bench/B4-tokens-v3/tasks/ are visible from any vitest binary.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

/** @type {import('vitest/config').UserConfig} */
export default {
  root: REPO_ROOT,
  test: {
    watch: false,
    testTimeout: 15_000,
    isolate: true,
    pool: 'forks',
    include: ['bench/B4-tokens-v3/tasks/**/oracle.test.ts'],
    environment: 'node',
    reporter: ['verbose'],
  },
};
