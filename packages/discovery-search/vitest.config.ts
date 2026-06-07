// @decision DEC-1117-VITEST-CONFIG-001
// @title vitest alias for workspace packages (source-level resolution)
// @status decided (2026-06-06, mirrors DEC-REGISTRY-VITEST-CONFIG-001)
// @rationale
//   @yakcc/contracts and @yakcc/registry exports point to dist/. Without a prior
//   `pnpm -r build`, dist/ is absent and test imports fail with MODULE_NOT_FOUND.
//   Aliasing to src/index.ts lets vitest resolve workspace packages at source level,
//   matching the pattern established in packages/registry/vitest.config.ts.
//   The alias only applies to test runs; the build still uses the dist/ exports.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@yakcc/contracts": resolve(__dirname, "../contracts/src/index.ts"),
      "@yakcc/registry": resolve(__dirname, "../registry/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
