import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Only pick up tests from src/ — prevents vitest from doubling test count
    // by also discovering compiled .test.js files in dist/.
    include: ["src/**/*.test.ts"],
    // Use pool: "forks" to get isolated Node.js processes per file, which
    // avoids ONNX runtime singleton pollution between test files.
    pool: "forks",
  },
});
