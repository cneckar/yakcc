// @decision DEC-HOOKS-CLINE-VITEST-CONFIG-001 — workspace-source aliases.
// Mirrors hooks-cursor/vitest.config.ts. Tests live in both src/ (property tests)
// and test/ (integration suites mirroring hooks-cursor). Aliases point to workspace
// source to avoid building dependent packages before running tests.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@yakcc/contracts": resolve(__dirname, "../contracts/src/index.ts"),
      "@yakcc/registry": resolve(__dirname, "../registry/src/index.ts"),
      "@yakcc/hooks-base": resolve(__dirname, "../hooks-base/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    pool: "forks",
    // wi-579 S1: disable the Layer 1 intent-specificity gate globally in tests.
    // IDE-adapter tests use short fixture intents that predate Layer 1 and test
    // adapter mechanics, not intent validation. Mirrors hooks-base/vitest.config.ts pattern.
    env: {
      YAKCC_HOOK_DISABLE_INTENT_GATE: "1",
    },
  },
});
