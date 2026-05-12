// @decision DEC-HOOKS-BASE-VITEST-CONFIG-001 — workspace-source aliases.
// See DEC-REGISTRY-VITEST-CONFIG-001 for rationale.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@yakcc/contracts": resolve(__dirname, "../contracts/src/index.ts"),
      "@yakcc/registry": resolve(__dirname, "../registry/src/index.ts"),
      // @yakcc/shave + @yakcc/ir aliased to src/ to remove the CI dependency on
      // a built `dist/` (which is gitignored). Matches the workspace-source alias
      // pattern established in PR #356 for contracts/registry. Vitest uses
      // vite/esbuild for module loading, so the TS types pre-existing in shave's
      // source don't need to compile cleanly — only runtime imports must resolve.
      // @decision DEC-HOOK-ATOM-CAPTURE-001 (shave dist alias) — updated: now
      // workspace-source alias for shave + ir, matching #356 pattern.
      // @decision DEC-HOOKS-BASE-VITEST-SHAVE-SRC-001 — shave/ir aliased to src/
      // to remove CI dependency on built dist.
      "@yakcc/shave": resolve(__dirname, "../shave/src/index.ts"),
      "@yakcc/ir": resolve(__dirname, "../ir/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    pool: "forks",
  },
});
