import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/types.ts",
      ],
      thresholds: {
        // 99.23% actual; threshold pinned at 99 for a 1pp safety margin.
        lines: 99,
        // 96.75% actual; uncovered line is the structurally-unreachable module-load
        // weight invariant guard (index.ts:121) — a defensive throw that fires only
        // when DIMENSION_WEIGHTS is mutated at compile time, never in valid test runs.
        statements: 96,
        // 93.02% actual; the ~7 uncovered branches are ternary/optional-chain arms
        // in covered lines (e.g., `?? []` defaults) — not reachable by callers who
        // always supply well-formed SpecYak objects.
        branches: 92,
        // 100% actual; threshold pinned at 99 for a 1pp safety margin.
        functions: 99,
      },
    },
  },
});
