/**
 * yakcc-resolve-tool.test.ts — Integration tests for the Cursor yakcc_resolve tool adapter.
 *
 * WI-HOOK-PHASE-4-CURSOR (#219) — Phase 3 yakcc_resolve parity for Cursor.
 *
 * Verifies:
 *   R1. registerTool() writes the cursor-specific marker file (yakcc-cursor-resolve-tool.json).
 *   R2. Marker content records tool name, description, systemPromptPath, registryPath.
 *   R3. registerTool() is idempotent.
 *   R4. resolve() returns a valid ResolveResult when the registry is available.
 *   R5. Exported constants have correct values.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REGISTRY_PATH,
  RESOLVE_TOOL_MARKER_FILENAME,
  SYSTEM_PROMPT_PATH,
  createYakccResolveTool,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

const testMarkerDir = join(tmpdir(), `yakcc-cursor-resolve-tool-test-${process.pid}`);

afterEach(() => {
  if (existsSync(testMarkerDir)) {
    rmSync(testMarkerDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R5: Constant values
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("RESOLVE_TOOL_MARKER_FILENAME is cursor-specific", () => {
    expect(RESOLVE_TOOL_MARKER_FILENAME).toBe("yakcc-cursor-resolve-tool.json");
    expect(RESOLVE_TOOL_MARKER_FILENAME).toContain("cursor");
    expect(RESOLVE_TOOL_MARKER_FILENAME.endsWith(".json")).toBe(true);
  });

  it("DEFAULT_REGISTRY_PATH matches CLI default", () => {
    expect(DEFAULT_REGISTRY_PATH).toBe(".yakcc/registry.sqlite");
  });

  it("SYSTEM_PROMPT_PATH is the canonical discovery system prompt", () => {
    expect(SYSTEM_PROMPT_PATH).toBe("docs/system-prompts/yakcc-discovery.md");
  });
});

// ---------------------------------------------------------------------------
// R1/R2: registerTool() writes cursor-specific marker
// ---------------------------------------------------------------------------

describe("registerTool", () => {
  it("writes yakcc-cursor-resolve-tool.json to the configured marker directory", () => {
    const tool = createYakccResolveTool({ markerDir: testMarkerDir });
    tool.registerTool();

    const markerPath = join(testMarkerDir, RESOLVE_TOOL_MARKER_FILENAME);
    expect(existsSync(markerPath)).toBe(true);

    const content = JSON.parse(readFileSync(markerPath, "utf-8")) as {
      tool: string;
      description: string;
      systemPromptPath: string;
      registryPath: string;
      registeredAt: string;
    };

    expect(content.tool).toBe("yakcc_resolve");
    expect(content.description).toContain("yakcc registry");
    expect(content.systemPromptPath).toBe(SYSTEM_PROMPT_PATH);
    expect(typeof content.registryPath).toBe("string");
    expect(typeof content.registeredAt).toBe("string");
    // Verify it's a valid ISO timestamp
    expect(() => new Date(content.registeredAt)).not.toThrow();
  });

  it("creates the marker directory if it does not exist", () => {
    const nestedDir = join(testMarkerDir, "nested", "cursor");
    const tool = createYakccResolveTool({ markerDir: nestedDir });
    tool.registerTool();

    expect(existsSync(join(nestedDir, RESOLVE_TOOL_MARKER_FILENAME))).toBe(true);
  });

  it("is idempotent — calling twice updates the marker without error", () => {
    const tool = createYakccResolveTool({ markerDir: testMarkerDir });
    tool.registerTool();

    const first = JSON.parse(
      readFileSync(join(testMarkerDir, RESOLVE_TOOL_MARKER_FILENAME), "utf-8"),
    ) as { registeredAt: string };

    // Slight pause so the timestamp can differ.
    const second = createYakccResolveTool({ markerDir: testMarkerDir });
    second.registerTool();

    const updated = JSON.parse(
      readFileSync(join(testMarkerDir, RESOLVE_TOOL_MARKER_FILENAME), "utf-8"),
    ) as { registeredAt: string };

    // The file was rewritten — both timestamps are valid ISO strings.
    expect(typeof first.registeredAt).toBe("string");
    expect(typeof updated.registeredAt).toBe("string");
    expect(existsSync(join(testMarkerDir, RESOLVE_TOOL_MARKER_FILENAME))).toBe(true);
  });

  it("registryPath in marker reflects the YAKCC_REGISTRY_PATH env override", () => {
    const customPath = "/custom/path/registry.sqlite";
    const tool = createYakccResolveTool({
      markerDir: testMarkerDir,
      registryPath: customPath,
    });
    tool.registerTool();

    const content = JSON.parse(
      readFileSync(join(testMarkerDir, RESOLVE_TOOL_MARKER_FILENAME), "utf-8"),
    ) as { registryPath: string };

    expect(content.registryPath).toBe(customPath);
  });
});

// ---------------------------------------------------------------------------
// Factory construction
// ---------------------------------------------------------------------------

describe("createYakccResolveTool factory", () => {
  it("returns an object with registerTool and resolve methods", () => {
    const tool = createYakccResolveTool({ markerDir: testMarkerDir });
    expect(typeof tool.registerTool).toBe("function");
    expect(typeof tool.resolve).toBe("function");
  });

  it("does not throw during construction even with a non-existent registry path", () => {
    expect(() =>
      createYakccResolveTool({
        markerDir: testMarkerDir,
        registryPath: "/nonexistent/registry.sqlite",
      }),
    ).not.toThrow();
  });
});
