import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    // See DEC-INFRA-VITEST-FORK-CAP-001 in packages/compile/vitest.config.ts
    // for the canonical reference. Capping at 2 matches CI's 2-vCPU baseline
    // and prevents the multi-core pool-storm flake (~6000s vs ~40s on 10+ core
    // hardware). Uses vitest 4.x top-level maxWorkers/minWorkers.
    maxWorkers: 2,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/cache/**", "src/intent/**"],
      exclude: [
        "**/*.test.ts",
        "**/types.ts",
        "**/*.integration.test.ts",
        // createDefaultAnthropicClient wraps the Anthropic SDK — requires live
        // credentials that are not available in unit tests. The AnthropicLikeClient
        // interface and the mock injection path are exercised in extract.test.ts;
        // only the SDK adapter itself is excluded.
        "**/anthropic-client.ts",
      ],
      thresholds: {
        // Lines/statements at 99%: one uncovered path is the `createDefaultAnthropicClient`
        // branch in extract.ts that requires ANTHROPIC_API_KEY + no mock client.
        lines: 99,
        statements: 99,
        // Branches at 90%: branches threshold from the dispatch requirement.
        branches: 90,
        // Functions at 85%: three anonymous `.catch(() => {})` callbacks in
        // file-cache.ts and extract.ts are defensive best-effort stubs. They
        // cannot be exercised via vi.spyOn because ESM native module namespaces
        // are not configurable (vi.spyOn throws TypeError: Cannot redefine property).
        // All production logic reachable without live credentials is covered.
        functions: 85,
      },
    },
  },
});
