// @decision DEC-DUC-VITEST-CONFIG-001 — @yakcc/duc is a leaf package with no
// workspace source deps, so (unlike @yakcc/variance) it needs no source alias.
// Coverage thresholds mirror the project floor (see packages/variance/vitest.config.ts).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/types.ts", "src/index.ts", "src/testkit.ts"],
      thresholds: {
        lines: 99,
        statements: 96,
        branches: 92,
        functions: 99,
      },
    },
  },
});
