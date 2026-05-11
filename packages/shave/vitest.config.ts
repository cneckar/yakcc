// @decision DEC-SHAVE-VITEST-CONFIG-001 — workspace-source aliases.
// See packages/registry/vitest.config.ts DEC-REGISTRY-VITEST-CONFIG-001 for rationale.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@yakcc/contracts": resolve(__dirname, "../contracts/src/index.ts"),
      "@yakcc/registry": resolve(__dirname, "../registry/src/index.ts"),
      "@yakcc/ir": resolve(__dirname, "../ir/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    maxWorkers: 2,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/cache/**", "src/intent/**"],
      exclude: [
        "**/*.test.ts",
        "**/types.ts",
        "**/*.integration.test.ts",
        "**/anthropic-client.ts",
      ],
      thresholds: {
        lines: 99,
        statements: 99,
        branches: 90,
        functions: 85,
      },
    },
  },
});
