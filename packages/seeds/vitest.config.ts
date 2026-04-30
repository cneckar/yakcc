import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    testTimeout: 60_000, // 60s — accommodates canonicalAstHash compute under turbo concurrency
    hookTimeout: 60_000, // 60s — same; seeded corpora invoke ts-morph for every block
  },
});
