// @mock-exempt: node:fs/promises rename is mocked via vi.mock() to simulate
// Windows EPERM/EBUSY error codes that cannot be produced by real filesystem
// operations on macOS/Linux. The OS/filesystem layer is an external boundary;
// mocking is the only way to deterministically exercise the retry policy on
// any platform. The plan (plans/wi-525-cache-eperm.md §4.4) and Evaluation
// Contract mandate this approach explicitly. Pool is "forks" so this mock is
// fully isolated to this file's process and does not cascade to cache.test.ts
// or any other test file.

/**
 * Unit tests for renameWithRetry() — the atomic-rename helper that wraps
 * fs.rename with bounded EPERM/EBUSY retry for Windows transient lock
 * contention.
 *
 * Production trigger: writeIntent() calls renameWithRetry(tmpPath, filePath)
 * as the final step of an atomic cache write. On Windows, two concurrent
 * writeIntent() calls racing on the same destination path may each receive
 * EPERM from MoveFileEx. This test suite deterministically exercises that
 * retry policy on any platform via vi.mock("node:fs/promises").
 *
 * Compound-interaction note: cache.test.ts "concurrent writes to same key"
 * is the real end-to-end integration assertion; these tests verify the
 * discrete retry policy (counts, codes, exhaustion) that makes that test
 * deterministic on Windows.
 *
 * ESM note: vi.spyOn() cannot redefine properties on native ESM module
 * namespaces (non-configurable). vi.mock() with a hoisted factory is the
 * correct ESM-compatible approach. With pool="forks" each test file runs in
 * its own process, so the mock is fully contained here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renameWithRetry } from "./atomic-write.js";

// ---------------------------------------------------------------------------
// Mock setup — must be at module top-level for vitest hoisting.
// The factory returns a mock rename; we grab the mock fn in beforeEach.
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises", () => ({
  rename: vi.fn(),
}));

// Import after mock declaration so the module under test sees the mocked version.
const { rename: mockRename } = await import("node:fs/promises");
const renameMock = vi.mocked(mockRename);

describe("renameWithRetry()", () => {
  beforeEach(() => {
    renameMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  it("resolves immediately when rename succeeds on the first attempt", async () => {
    renameMock.mockResolvedValueOnce(undefined);

    await expect(renameWithRetry("src.tmp", "dst.json")).resolves.toBeUndefined();
    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(renameMock).toHaveBeenCalledWith("src.tmp", "dst.json");
  });

  // ---------------------------------------------------------------------------
  // Retryable codes — EPERM / EBUSY (Windows transient lock)
  // ---------------------------------------------------------------------------

  it("retries on EPERM then succeeds (call count = 2)", async () => {
    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
    renameMock.mockRejectedValueOnce(eperm).mockResolvedValueOnce(undefined);

    await expect(renameWithRetry("src.tmp", "dst.json")).resolves.toBeUndefined();
    expect(renameMock).toHaveBeenCalledTimes(2);
  });

  it("retries on EBUSY then succeeds (call count = 2)", async () => {
    const ebusy = Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    renameMock.mockRejectedValueOnce(ebusy).mockResolvedValueOnce(undefined);

    await expect(renameWithRetry("src.tmp", "dst.json")).resolves.toBeUndefined();
    expect(renameMock).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // Retry exhaustion — persistent EPERM throws after MAX_ATTEMPTS (5)
  // ---------------------------------------------------------------------------

  it("rethrows the original EPERM error after exhausting 5 attempts", async () => {
    const eperm = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    // Reject on every call (persistent failure)
    renameMock.mockRejectedValue(eperm);

    // Must reject with the *same* error object (not a wrapper)
    await expect(renameWithRetry("src.tmp", "dst.json")).rejects.toBe(eperm);
    // Must have tried exactly MAX_ATTEMPTS = 5 times
    expect(renameMock).toHaveBeenCalledTimes(5);
  });

  // ---------------------------------------------------------------------------
  // Non-retryable codes — rethrow immediately on first attempt
  // ---------------------------------------------------------------------------

  it("rethrows EISDIR immediately without retrying (call count = 1)", async () => {
    // This mirrors cache.test.ts:190 where writeIntent is called with the
    // destination already existing as a directory. renameWithRetry must surface
    // the EISDIR error unchanged so the caller's cleanup branch fires.
    const eisdir = Object.assign(new Error("EISDIR: illegal operation on a directory"), {
      code: "EISDIR",
    });
    renameMock.mockRejectedValueOnce(eisdir);

    await expect(renameWithRetry("src.tmp", "dst.json")).rejects.toBe(eisdir);
    expect(renameMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows ENOENT immediately without retrying (call count = 1)", async () => {
    const enoent = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });
    renameMock.mockRejectedValueOnce(enoent);

    await expect(renameWithRetry("src.tmp", "dst.json")).rejects.toBe(enoent);
    expect(renameMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows ENOSPC immediately without retrying (call count = 1)", async () => {
    const enospc = Object.assign(new Error("ENOSPC: no space left on device"), {
      code: "ENOSPC",
    });
    renameMock.mockRejectedValueOnce(enospc);

    await expect(renameWithRetry("src.tmp", "dst.json")).rejects.toBe(enospc);
    expect(renameMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows an error with no code immediately (call count = 1)", async () => {
    // Errors without a code property are treated as non-retryable.
    const bare = new Error("something unexpected");
    renameMock.mockRejectedValueOnce(bare);

    await expect(renameWithRetry("src.tmp", "dst.json")).rejects.toBe(bare);
    expect(renameMock).toHaveBeenCalledTimes(1);
  });
});
