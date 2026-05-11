// @decision DEC-CLI-VITEST-CONFIG-002 — workspace-source aliases.
// Original -001 covered @yakcc/seeds; -002 extends to all workspace deps per
// #352 follow-up. See packages/registry/vitest.config.ts DEC-REGISTRY-VITEST-CONFIG-001
// for full rationale on @yakcc/contracts.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@yakcc/contracts": resolve(__dirname, "../contracts/src/index.ts"),
      "@yakcc/registry": resolve(__dirname, "../registry/src/index.ts"),
      "@yakcc/ir": resolve(__dirname, "../ir/src/index.ts"),
      "@yakcc/compile": resolve(__dirname, "../compile/src/index.ts"),
      "@yakcc/seeds": resolve(__dirname, "../seeds/src/index.ts"),
      "@yakcc/shave": resolve(__dirname, "../shave/src/index.ts"),
      "@yakcc/federation": resolve(__dirname, "../federation/src/index.ts"),
      "@yakcc/hooks-base": resolve(__dirname, "../hooks-base/src/index.ts"),
      "@yakcc/hooks-claude-code": resolve(__dirname, "../hooks-claude-code/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
