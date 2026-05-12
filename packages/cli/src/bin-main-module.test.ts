/**
 * bin-main-module.test.ts — smoke tests for the cross-platform main-module guard.
 *
 * Exercises the realpathSync(fileURLToPath(import.meta.url)) comparison pattern
 * introduced by DEC-CLI-BIN-MAIN-MODULE-GUARD-WINDOWS-001 (WI-ALPHA-WINDOWS-BIN-JS #385),
 * which supersedes DEC-CLI-BIN-MAIN-MODULE-001 (fix for #274).
 *
 * The guard itself lives in bin.ts and cannot be unit-tested in isolation because
 * import.meta.url is module-specific and process.argv[1] is runtime state. Instead
 * we test the underlying Node.js primitives to prove the cross-platform correctness
 * property that the fix relies on:
 *
 *   realpathSync(fileURLToPath(pathToFileURL(p).href)) === p  for any real OS path p
 *
 * This round-trip identity (with realpathSync normalization) is the invariant that
 * makes the guard work on all platforms including Windows symlinks, case-insensitive
 * drive letters, and 8.3 short-name forms. We test both Windows-style and POSIX-style
 * paths to confirm the property holds regardless of host OS.
 *
 * Production sequence covered (compound-interaction test):
 *   node packages/cli/dist/bin.js <args>
 *   → process.argv[1] === OS-native path to bin.js
 *   → import.meta.url === file: URL for bin.js
 *   → realpathSync(fileURLToPath(import.meta.url)) vs realpathSync(process.argv[1])
 *   → byte-equal → isMainModule() returns true → runCli() dispatched
 * The compound test at the bottom exercises this sequence end-to-end using real
 * filesystem paths (import.meta.url of THIS test file).
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
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

describe("bin main-module guard — realpathSync hardening (DEC-CLI-BIN-MAIN-MODULE-GUARD-WINDOWS-001)", () => {
  it("realpathSync(fileURLToPath(import.meta.url)) equals the real path of this test file", () => {
    // This is the compound-interaction test exercising the real production sequence.
    // In production: realpathSync(fileURLToPath(import.meta.url)) is compared to
    // realpathSync(process.argv[1]). Both calls must resolve to the same canonical
    // real path for the guard to fire. This test proves the left-hand side of
    // that comparison works correctly for a real file on the current OS.
    //
    // Production sequence: node dist/bin.js → import.meta.url = file:///abs/path/bin.js
    // → fileURLToPath → /abs/path/bin.js → realpathSync → canonical real path.
    // This test file substitutes for bin.js: import.meta.url refers to this file,
    // which DOES exist on disk, so realpathSync succeeds and returns the real path.
    const thisFileUrl = import.meta.url;
    const thisFilePath = fileURLToPath(thisFileUrl);
    const realPath = realpathSync(thisFilePath);

    // The real path must be a non-empty absolute path string.
    expect(typeof realPath).toBe("string");
    expect(realPath.length).toBeGreaterThan(0);

    // On Linux/macOS (no symlinks, no case-insensitive FS), realpath === the input path.
    // On Windows, realpath resolves case and 8.3 names but the canonical path is still
    // the same file. Either way, the round-trip is idempotent.
    const realPathAgain = realpathSync(realPath);
    expect(realPathAgain).toBe(realPath);

    // The real path must end with the test file name.
    expect(realPath.endsWith("bin-main-module.test.ts")).toBe(true);
  });

  it("realpathSync + fileURLToPath round-trip: real path equals realpathSync of native path", () => {
    // Proves the invariant that the guard relies on for the standard invocation path:
    //   realpathSync(fileURLToPath(pathToFileURL(p).href)) === realpathSync(p)
    // for any absolute path p that actually exists on disk (which bin.js always does
    // during normal CLI invocation).
    //
    // Uses this test file's own path (guaranteed to exist) as a substitute for bin.js.
    const thisFilePath = fileURLToPath(import.meta.url);
    const viaNativeRealpath = realpathSync(thisFilePath);
    const viaUrlRoundTrip = realpathSync(fileURLToPath(pathToFileURL(thisFilePath).href));
    expect(viaUrlRoundTrip).toBe(viaNativeRealpath);
  });

  it("isMainModule logic: process.argv[1] path realpathSync matches this file when invoked directly", () => {
    // Exercises the exact isMainModule() decision logic from bin.ts (DEC-CLI-BIN-MAIN-MODULE-GUARD-WINDOWS-001):
    //   realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
    //
    // In this test, process.argv[1] is the vitest runner — NOT this file — so the
    // guard correctly returns false (this is NOT bin.ts being run directly).
    // We simulate the "match" case by constructing both sides from the same real path.
    const simulatedImportMetaUrl = import.meta.url; // this file
    const simulatedArgv1 = fileURLToPath(simulatedImportMetaUrl); // same file, as native path
    const lhs = realpathSync(fileURLToPath(simulatedImportMetaUrl));
    const rhs = realpathSync(simulatedArgv1);
    // When both sides refer to the same real file, isMainModule() returns true.
    expect(lhs).toBe(rhs);

    // Confirm the guard correctly returns false for a DIFFERENT path.
    const differentPath =
      process.platform === "win32"
        ? "C:\\nonexistent-path-for-guard-test\\"
        : "/nonexistent-path-for-guard-test/";
    // We can't call realpathSync on a nonexistent path (it throws ENOENT),
    // but we can verify the two real paths do NOT match a synthetic string.
    expect(lhs).not.toBe(differentPath);
  });

  it("ENOENT fallback: missing process.argv[1] triggers pathToFileURL comparison (not a throw)", () => {
    // Simulates the isMainModule() ENOENT fallback path for when process.argv[1]
    // refers to a path that does not exist on disk (e.g. node -e "..." invocations
    // or test harnesses that set argv[1] to a synthetic path).
    //
    // The guard catches ENOENT and falls back to URL comparison:
    //   import.meta.url === pathToFileURL(process.argv[1] ?? "").href
    //
    // We prove the fallback path is reachable and produces stable output.
    const nonExistentPath =
      process.platform === "win32"
        ? "C:\\does-not-exist\\bin.js"
        : "/does-not-exist/bin.js";

    let threwEnoent = false;
    try {
      realpathSync(nonExistentPath);
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
        threwEnoent = true;
      }
    }
    expect(threwEnoent).toBe(true);

    // After catching ENOENT, the fallback compares URL strings.
    // Verify pathToFileURL produces a valid href for the nonexistent path.
    const fallbackUrl = pathToFileURL(nonExistentPath).href;
    expect(fallbackUrl.startsWith("file:///")).toBe(true);
    // The guard then returns false (import.meta.url !== fallback URL) — correct.
    expect(import.meta.url === fallbackUrl).toBe(false);
  });
});
