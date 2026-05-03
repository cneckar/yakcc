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
//
// @decision DEC-COMPILE-VITEST-CONFIG-002
// title: vitest alias for @yakcc/shave source entry (WI-018)
// status: decided (WI-018)
// rationale:
//   @yakcc/shave's package.json exports field points to dist/index.js, but the
//   shave package is not pre-built in the workspace (no dist/ directory). The
//   compile package's tests resolve @yakcc/shave through a pnpm workspace symlink
//   pointing at the source tree. Without this alias, vitest fails to resolve the
//   "." export and assemble-candidate.test.ts cannot load.
//   Same pattern as @yakcc/seeds (DEC-COMPILE-VITEST-CONFIG-001). Does not affect
//   production builds.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Redirect @yakcc/seeds to its source so that import.meta.url in seed.ts
      // resolves to src/seed.ts (where src/blocks/ exists) not dist/seed.js.
      "@yakcc/seeds": resolve(__dirname, "../seeds/src/index.ts"),
      // Redirect @yakcc/shave to its source entry point (no dist/ in the workspace).
      // See DEC-COMPILE-VITEST-CONFIG-002 above.
      "@yakcc/shave": resolve(__dirname, "../shave/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // forks isolation: better-sqlite3 uses native bindings; isolation avoids
    // SQLite handle conflicts between test files.
    pool: "forks",
  },
});
