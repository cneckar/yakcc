// @decision DEC-HOOKS-BASE-VITEST-CONFIG-001 — workspace-source aliases.
// See DEC-REGISTRY-VITEST-CONFIG-001 for rationale.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@yakcc/contracts": resolve(__dirname, "../contracts/src/index.ts"),
      "@yakcc/registry": resolve(__dirname, "../registry/src/index.ts"),
      // @yakcc/shave is aliased to its pre-built dist because the shave package
      // has a tsc error in types.props.ts that prevents building from source.
      // The dist is committed and valid. Tests that stub atomizeEmission bypass
      // the shave runtime entirely; tests that exercise it end-to-end use the dist.
      // @decision DEC-HOOK-ATOM-CAPTURE-001 (shave dist alias)
      "@yakcc/shave": resolve(__dirname, "../shave/dist/index.js"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    pool: "forks",
  },
});
