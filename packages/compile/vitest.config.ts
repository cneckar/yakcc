// @decision DEC-COMPILE-VITEST-CONFIG-001: vitest.config.ts sets resolve.alias for
// @yakcc/seeds to point at the seeds package's source tree rather than its dist/
// directory. This is required because seed.ts reads block .ts source files from
// disk at runtime using import.meta.url — when invoked via the compiled dist/seed.js,
// the path resolves to dist/blocks/ which contains only .js files (no .ts).
// Pointing vitest at the source src/index.ts means import.meta.url resolves to
// src/seed.ts and the correct src/blocks/ directory is found.
// Status: implemented (WI-005)
// Rationale: The seeds package is a devDependency of compile. Modifying seeds
// is out of scope (packages/seeds/** is forbidden). The vitest alias is the
// minimal, compile-scoped fix. It does not affect the runtime or production build.
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
