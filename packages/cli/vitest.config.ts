// @decision DEC-CLI-VITEST-CONFIG-001: vitest.config.ts mirrors the compile package's
// alias pattern, redirecting @yakcc/seeds to its source tree so that import.meta.url
// in seed.ts resolves to src/seed.ts (where src/blocks/ exists) and not dist/seed.js.
// Status: implemented (WI-007)
// Rationale: CLI integration tests call seedRegistry() via the seed command and compile
// command paths. Without this alias, vitest resolves @yakcc/seeds to dist/seed.js where
// src/blocks/ is absent, causing ENOENT at runtime. The include pattern prevents vitest
// from picking up any compiled output in dist/ (double-discovery bug seen in WI-002/WI-006).
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Redirect @yakcc/seeds to its source so that import.meta.url in seed.ts
      // resolves to src/seed.ts (where src/blocks/ exists) not dist/seed.js.
      "@yakcc/seeds": resolve(__dirname, "../seeds/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    // forks isolation: better-sqlite3 uses native bindings; isolation avoids
    // SQLite handle conflicts between test files.
    pool: "forks",
  },
});
