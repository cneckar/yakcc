// @decision DEC-CLI-HOOK-INTERCEPT-CONTINUE-PKG-001 — workspace-source aliases.
// Mirrors hooks-cline/vitest.config.ts. The re-export package has one test
// that verifies the symbol identity between @yakcc/hooks-continue and @yakcc/hooks-cline.
// Aliases point to workspace source to avoid building dependent packages before running tests.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@yakcc/contracts": resolve(__dirname, "../contracts/src/index.ts"),
      "@yakcc/registry": resolve(__dirname, "../registry/src/index.ts"),
      "@yakcc/hooks-base": resolve(__dirname, "../hooks-base/src/index.ts"),
      // Self-alias: the test imports from @yakcc/hooks-continue; resolve to src/index.ts
      "@yakcc/hooks-continue": resolve(__dirname, "src/index.ts"),
      // hooks-cline: the package this one re-exports; resolve to its source
      "@yakcc/hooks-cline": resolve(__dirname, "../hooks-cline/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    env: {
      YAKCC_HOOK_DISABLE_INTENT_GATE: "1",
    },
  },
});
