// @decision DEC-PROOF-VERIFIER-VITEST-CONFIG-001
// title: vitest alias for @yakcc/contracts source entry
// status: decided (mirrors DEC-REGISTRY-VITEST-CONFIG-001 pattern)
// rationale:
//   @yakcc/contracts exports dist/index.js which may not exist before build.
//   The source alias avoids requiring a pre-build step for tests; same pattern
//   used by registry and variance packages.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@yakcc/contracts": resolve(__dirname, "../contracts/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
