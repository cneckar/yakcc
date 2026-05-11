// @decision DEC-FEDERATION-VITEST-CONFIG-001 — workspace-source aliases.
// See packages/registry/vitest.config.ts DEC-REGISTRY-VITEST-CONFIG-001 for rationale.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@yakcc/contracts": resolve(__dirname, "../contracts/src/index.ts"),
      "@yakcc/registry": resolve(__dirname, "../registry/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    passWithNoTests: true,
  },
});
