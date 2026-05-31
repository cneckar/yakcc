// @decision DEC-MCP-VITEST-CONFIG-009
// title: mcp-registry vitest config — workspace source aliases for retrieval-quality test
// status: updated (wi-1006-resolve-semantic-embedding)
// rationale:
//   WI-1006 added a retrieval-quality integration test that imports directly from
//   @yakcc/contracts (createLocalEmbeddingProvider) and @yakcc/registry (openRegistry).
//   Without dist/ in the worktree, vitest resolves workspace packages via pnpm symlinks
//   to dist/index.js, which does not exist. Adding source aliases (mirrors
//   DEC-REGISTRY-VITEST-CONFIG-001) points vitest at the TypeScript source entries so
//   the retrieval-quality test can run without a prior `pnpm -r build`.
//
//   The existing mocked unit tests in resolve.test.ts are unaffected: they vi.mock()
//   @yakcc/contracts and @yakcc/registry, so the alias is never exercised for them.
//   The alias is only exercised when a test imports the real workspace module.
//
//   @yakcc/hooks-base is also aliased for symmetry and future-proofing (used by resolve.ts
//   at import time if any test breaks the mock boundary).
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@yakcc/contracts": resolve(__dirname, "../contracts/src/index.ts"),
      "@yakcc/hooks-base": resolve(__dirname, "../hooks-base/src/index.ts"),
      "@yakcc/registry": resolve(__dirname, "../registry/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
