// @decision DEC-COMPILE-VITEST-CONFIG-001/002 — workspace-source aliases.
// Original -001 (seeds), -002 (shave); -003 extends to other workspace packages
// per #352 follow-up. See packages/registry/vitest.config.ts DEC-REGISTRY-VITEST-CONFIG-001
// for full rationale on @yakcc/contracts.
// DEC-WI508-INTERCEPT-CLASSIFIER-SHARED-001: add deep-path alias for import-classifier.ts
// so vitest can resolve the shared classifier without a dist build.
// @yakcc/variance aliased to src/ — same workspace-source pattern as hooks-base/vitest.config.ts.
// variance has no dist/ in the worktree (gitignored) and is imported transitively by
// packages/shave/src/universalize/variance-rank.ts via the @yakcc/shave alias above.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@yakcc/contracts": resolve(__dirname, "../contracts/src/index.ts"),
      "@yakcc/registry": resolve(__dirname, "../registry/src/index.ts"),
      "@yakcc/ir": resolve(__dirname, "../ir/src/index.ts"),
      "@yakcc/seeds": resolve(__dirname, "../seeds/src/index.ts"),
      "@yakcc/shave": resolve(__dirname, "../shave/src/index.ts"),
      "@yakcc/variance": resolve(__dirname, "../variance/src/index.ts"),
      "@yakcc/hooks-base/src/import-classifier.js": resolve(
        __dirname,
        "../hooks-base/src/import-classifier.ts",
      ),
      "@yakcc/hooks-base": resolve(__dirname, "../hooks-base/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    pool: "forks",
    // @decision DEC-INFRA-VITEST-FORK-CAP-001 — cap workers at 2 to match CI baseline.
    maxWorkers: 2,
    minWorkers: 1,
  },
});
