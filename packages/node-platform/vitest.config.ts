// Workspace-source aliases, as packages/variance's vitest config does.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@yakcc/shave": resolve(__dirname, "../shave/src/index.ts"),
      "@yakcc/duc": resolve(__dirname, "../duc/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    testTimeout: 600_000,
  },
});
