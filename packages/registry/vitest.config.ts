// @decision DEC-REGISTRY-VITEST-CONFIG-001
// title: vitest alias for @yakcc/contracts source entry
// status: decided (2026-05-11, follow-up to #352 merge CI failures)
// rationale:
//   @yakcc/contracts's package.json exports field points to dist/index.js. Vitest
//   resolves workspace packages through the pnpm symlink in node_modules; without
//   a pre-existing dist/ directory the "." export fails to resolve. The pr-ci.yml
//   test-advisory job (#320 Slice B) doesn't run `pnpm -r build` before tests, so
//   every value-import from @yakcc/contracts breaks at test load.
//   Same pattern as compile's DEC-COMPILE-VITEST-CONFIG-001/002.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@yakcc/contracts": resolve(__dirname, "../contracts/src/index.ts"),
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
