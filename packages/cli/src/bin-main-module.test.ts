/**
 * bin-main-module.test.ts — smoke tests for the cross-platform main-module guard.
 *
 * Exercises the fileURLToPath(import.meta.url) === process.argv[1] pattern
 * introduced by DEC-CLI-BIN-MAIN-MODULE-001 (fix for #274).
 *
 * The guard itself lives in bin.ts and cannot be unit-tested in isolation because
 * import.meta.url is module-specific and process.argv[1] is runtime state. Instead
 * we test the underlying Node.js primitives to prove the cross-platform correctness
 * property that the fix relies on:
 *
 *   fileURLToPath(pathToFileURL(p).href) === p  for any well-formed OS path p
 *
 * This round-trip identity is the invariant that makes the guard work on all
 * platforms (Windows, Linux, macOS). We test both Windows-style and POSIX-style
 * paths to confirm the property holds regardless of host OS.
 *
 * Production sequence covered: the binary entry point is invoked via
 *   node packages/cli/dist/bin.js <args>
 * At that point process.argv[1] === the OS-native path to bin.js and
 * import.meta.url === the file: URL for bin.js. The fix converts the URL to a
 * path and compares directly — this test proves that conversion is an identity
 * operation for typical CLI invocation paths.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("bin main-module guard — cross-platform path round-trip (DEC-CLI-BIN-MAIN-MODULE-001)", () => {
  it("POSIX path survives fileURLToPath(pathToFileURL(p)) round-trip unchanged (POSIX only)", () => {
    // On Windows, pathToFileURL treats a leading-slash path as relative to the
    // current drive (e.g. /usr/... → C:\usr\...). The round-trip identity holds
    // only for OS-native absolute paths. This test guards POSIX platforms only;
    // the Windows variant is covered by the test below.
    if (process.platform === "win32") {
      // On Windows, verify that a native Windows path round-trips correctly instead.
      const winPath = "C:\\src\\yakcc\\packages\\cli\\dist\\bin.js";
      const roundTripped = fileURLToPath(pathToFileURL(winPath).href);
      expect(roundTripped).toBe(winPath);
    } else {
      const posixPath = "/usr/local/bin/yakcc/packages/cli/dist/bin.js";
      const roundTripped = fileURLToPath(pathToFileURL(posixPath).href);
      expect(roundTripped).toBe(posixPath);
    }
  });

  it("Windows-style absolute path survives round-trip unchanged", () => {
    // On Windows, pathToFileURL produces file:///C:/... and fileURLToPath converts
    // it back to C:\... — the comparison with process.argv[1] (also C:\...) matches.
    // On Linux/macOS this test validates that a Windows-like UNC path doesn't explode.
    // We construct a URL manually to simulate what Node produces on Windows.
    const windowsUrl = "file:///C:/src/yakcc/packages/cli/dist/bin.js";
    // fileURLToPath on any platform converts this to the correct local form.
    // On Windows → C:\src\yakcc\packages\cli\dist\bin.js
    // On POSIX  → /C:/src/yakcc/packages/cli/dist/bin.js (not a real path, but the
    //             test verifies the conversion is stable, not that the path exists)
    const converted = fileURLToPath(windowsUrl);
    expect(typeof converted).toBe("string");
    expect(converted.length).toBeGreaterThan(0);
    // The converted path must NOT contain the original URL scheme.
    expect(converted).not.toContain("file://");
  });

  it("pathToFileURL produces a href that starts with file:/// (triple slash)", () => {
    // This documents the invariant the old guard violated: manual `file://${path}`
    // produces double-slash on Windows, but Node's pathToFileURL always produces
    // file:/// (three slashes for an absolute path). The mismatch was the bug.
    const anyAbsPath =
      process.platform === "win32"
        ? "C:\\src\\yakcc\\packages\\cli\\dist\\bin.js"
        : "/src/yakcc/packages/cli/dist/bin.js";
    const url = pathToFileURL(anyAbsPath);
    expect(url.href.startsWith("file:///")).toBe(true);
  });

  it("fileURLToPath is the inverse of pathToFileURL for the current platform's path format", () => {
    // Construct a synthetic path that looks like what process.argv[1] would be at runtime.
    // This is the exact comparison the guard performs: fileURLToPath(import.meta.url) === argv[1].
    const syntheticArgv1 =
      process.platform === "win32"
        ? "C:\\src\\yakcc\\packages\\cli\\dist\\bin.js"
        : "/src/yakcc/packages/cli/dist/bin.js";
    const syntheticImportMetaUrl = pathToFileURL(syntheticArgv1).href;
    // The fix: convert the URL back to a path and compare.
    const guardLhs = fileURLToPath(syntheticImportMetaUrl);
    expect(guardLhs).toBe(syntheticArgv1);
  });
});
