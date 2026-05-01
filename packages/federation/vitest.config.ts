import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Only pick up tests from src/ — prevents vitest from doubling test count
    // by also discovering compiled .test.js files in dist/.
    include: ["src/**/*.test.ts"],
    // No native-binding deps; forks isolation kept for consistency with siblings.
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    passWithNoTests: true,
  },
});
