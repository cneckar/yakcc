import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Only pick up tests from src/ — prevents vitest from doubling test count
    // by also discovering compiled .test.js files in dist/.
    include: ["src/**/*.test.ts"],
    // Use pool: "forks" for isolated Node.js processes per file.
    // better-sqlite3 uses native bindings; forks isolation prevents state
    // bleed between test files and avoids SQLite handle conflicts.
    pool: "forks",
    testTimeout: 60_000, // 60s — accommodates canonicalAstHash compute under turbo concurrency
    hookTimeout: 60_000, // 60s — same; seeded corpora invoke ts-morph for every block
  },
});
