/**
 * Tests for locateProjectRoot() — the upward-walk function that anchors the
 * intent cache directory under the monorepo root.
 *
 * Production trigger: universalize() calls locateProjectRoot() on every
 * invocation to derive the default cacheDir when ShaveOptions.cacheDir is
 * absent. These tests verify both the happy path (pnpm-workspace.yaml found)
 * and the graceful fallback (no workspace file → returns start).
 */

import { mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locateProjectRoot } from "./locate-root.js";

let tmpBase: string;

beforeEach(async () => {
  const unique = Math.random().toString(36).slice(2);
  tmpBase = join(os.tmpdir(), `locate-root-test-${unique}`);
  await mkdir(tmpBase, { recursive: true });
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

describe("locateProjectRoot()", () => {
  it("returns the ancestor that contains pnpm-workspace.yaml", async () => {
    // Create: tmpBase/pnpm-workspace.yaml + tmpBase/inner/
    await writeFile(join(tmpBase, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    const innerDir = join(tmpBase, "inner", "deep");
    await mkdir(innerDir, { recursive: true });

    const result = await locateProjectRoot(innerDir);
    expect(result).toBe(tmpBase);
  });

  it("returns the start path as fallback when no workspace file is found", async () => {
    // No pnpm-workspace.yaml anywhere in this tree.
    const unrelated = join(tmpBase, "unrelated");
    await mkdir(unrelated, { recursive: true });

    const result = await locateProjectRoot(unrelated);
    expect(result).toBe(unrelated);
  });

  it("returns the start path itself when pnpm-workspace.yaml is in start", async () => {
    await writeFile(join(tmpBase, "pnpm-workspace.yaml"), "packages:\n  - '*'\n");
    const result = await locateProjectRoot(tmpBase);
    expect(result).toBe(tmpBase);
  });

  it("walks multiple levels up to find the workspace file", async () => {
    // Create deep/nested/structure and put pnpm-workspace.yaml at root
    await writeFile(join(tmpBase, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    const deepDir = join(tmpBase, "a", "b", "c", "d");
    await mkdir(deepDir, { recursive: true });

    const result = await locateProjectRoot(deepDir);
    expect(result).toBe(tmpBase);
  });
});
