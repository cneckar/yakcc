// @decision DEC-MCP-VITEST-CONFIG-009
// title: mcp-registry vitest config — no workspace aliases needed
// status: decided (wi-944, bite 1)
// rationale:
//   @yakcc/mcp-registry has no workspace package dependencies (only
//   @modelcontextprotocol/sdk, a published npm dep). No dist-alias workaround
//   is required. Pattern mirrors registry/vitest.config.ts but without aliases.
//   DEC-REGISTRY-VITEST-CONFIG-001 explains why aliases are needed when workspace
//   deps are present; absence of workspace deps means absence of that problem.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
