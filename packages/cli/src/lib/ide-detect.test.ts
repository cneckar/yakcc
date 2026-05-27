/**
 * ide-detect.test.ts — unit tests for the IDE-detection library.
 *
 * Production sequence exercised:
 *   detectInstalledIdes(fakeHome)
 *   → buildCandidatePaths(home) → existsSync(configDir) → DetectedIde[]
 *
 * Test strategy (DEC-CLI-IDE-DETECT-SEMANTICS-001, DEC-CLI-IDE-DETECT-PLACEMENT-001):
 *   - Tests use a temp directory as the fake HOME override so no real ~/.claude,
 *     ~/.config/Cursor etc. on the test machine pollutes results.
 *   - overrideHome parameter is used rather than mutating process.env.HOME to
 *     avoid state leakage between tests.
 *   - NO shell-out assertion: the test suite verifies child_process is never
 *     imported or called by importing the module in isolation and asserting on
 *     the module's exports (it has no child_process import).
 *   - Platform-specific cursor paths are tested via platform-detection coverage
 *     on the Linux path (the CI host is Linux). Darwin + win32 candidate paths
 *     are tested via buildCandidatePaths directly by temporarily overriding
 *     process.platform (save/restore pattern — no persistent mutation).
 *
 * Evaluation Contract coverage (§3b.1 of plans/wi-656-cli-ux-collapse.md):
 *   [EC-DETECT-1] per-IDE fixture: HOME override → existsSync probe → detection list assertion
 *   [EC-DETECT-2] no false positives: empty fake HOME returns []
 *   [EC-DETECT-3] no shell-out: child_process.spawn not imported in ide-detect.ts
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KNOWN_IDE_NAMES, buildCandidatePaths, detectInstalledIdes } from "./ide-detect.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "yakcc-ide-detect-test-"));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

/** Create a directory at path (and parents). */
function mkdirAt(path: string): void {
  mkdirSync(path, { recursive: true });
}

// ---------------------------------------------------------------------------
// [EC-DETECT-2] No false positives — empty fake HOME returns []
// ---------------------------------------------------------------------------

describe("detectInstalledIdes — empty home returns no results", () => {
  it("returns [] when no IDE config dirs exist in fake HOME", () => {
    // fakeHome is empty (freshly created temp dir)
    const result = detectInstalledIdes(fakeHome);
    expect(result).toEqual([]);
  });

  it("returns exactly the IDEs whose config dirs were created", () => {
    // Only create claude-code's config dir
    mkdirAt(join(fakeHome, ".claude"));
    const result = detectInstalledIdes(fakeHome);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("claude-code");
  });
});

// ---------------------------------------------------------------------------
// [EC-DETECT-1] Per-IDE fixture tests (Linux paths used as canonical in CI)
// ---------------------------------------------------------------------------

describe("detectInstalledIdes — claude-code detection", () => {
  it("detects claude-code when ~/.claude/ exists", () => {
    const configDir = join(fakeHome, ".claude");
    mkdirAt(configDir);

    const result = detectInstalledIdes(fakeHome);
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry?.name).toBe("claude-code");
    expect(entry?.configDir).toBe(configDir);
    expect(entry?.installed).toBe(true);
    expect(existsSync(entry?.configDir ?? "")).toBe(true);
  });

  it("does NOT detect claude-code when ~/.claude/ is absent", () => {
    const result = detectInstalledIdes(fakeHome);
    expect(result.find((e) => e.name === "claude-code")).toBeUndefined();
  });
});

describe("detectInstalledIdes — cursor detection (linux path)", () => {
  // These tests set up ~/.config/Cursor which is the linux cursor path.
  // On darwin, buildCandidatePaths() only probes ~/Library/Application Support/Cursor,
  // so without the platform mock the test setup would never match. Mock process.platform
  // to "linux" for the entire block to make detection deterministic on all host OSes.
  const origPlatformCursorLinux = process.platform;
  beforeAll(() => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });
  afterAll(() => {
    Object.defineProperty(process, "platform", {
      value: origPlatformCursorLinux,
      configurable: true,
    });
  });

  it("detects cursor via ~/.config/Cursor/ on linux", () => {
    const configDir = join(fakeHome, ".config", "Cursor");
    mkdirAt(configDir);

    const result = detectInstalledIdes(fakeHome);
    const entry = result.find((e) => e.name === "cursor");
    expect(entry).toBeDefined();
    expect(entry?.configDir).toBe(configDir);
    expect(entry?.installed).toBe(true);
  });

  it("does NOT detect cursor when ~/.config/Cursor/ is absent", () => {
    const result = detectInstalledIdes(fakeHome);
    expect(result.find((e) => e.name === "cursor")).toBeUndefined();
  });
});

describe("detectInstalledIdes — cline detection", () => {
  it("detects cline via ~/.config/cline/ (primary probe)", () => {
    const configDir = join(fakeHome, ".config", "cline");
    mkdirAt(configDir);

    const result = detectInstalledIdes(fakeHome);
    const entry = result.find((e) => e.name === "cline");
    expect(entry).toBeDefined();
    expect(entry?.configDir).toBe(configDir);
    expect(entry?.installed).toBe(true);
  });

  it("detects cline via VS Code extension dir (secondary probe)", () => {
    const extDir = join(fakeHome, ".vscode", "extensions", "saoudrizwan.claude-dev");
    mkdirAt(extDir);

    const result = detectInstalledIdes(fakeHome);
    const entry = result.find((e) => e.name === "cline");
    expect(entry).toBeDefined();
    expect(entry?.configDir).toBe(extDir);
  });

  it("primary probe wins over secondary when both exist", () => {
    const primary = join(fakeHome, ".config", "cline");
    const secondary = join(fakeHome, ".vscode", "extensions", "saoudrizwan.claude-dev");
    mkdirAt(primary);
    mkdirAt(secondary);

    const result = detectInstalledIdes(fakeHome);
    const entry = result.find((e) => e.name === "cline");
    expect(entry?.configDir).toBe(primary);
  });

  it("does NOT detect cline when neither probe path exists", () => {
    const result = detectInstalledIdes(fakeHome);
    expect(result.find((e) => e.name === "cline")).toBeUndefined();
  });
});

describe("detectInstalledIdes — continue.dev detection", () => {
  it("detects continue via ~/.continue/ (primary probe)", () => {
    const configDir = join(fakeHome, ".continue");
    mkdirAt(configDir);

    const result = detectInstalledIdes(fakeHome);
    const entry = result.find((e) => e.name === "continue");
    expect(entry).toBeDefined();
    expect(entry?.configDir).toBe(configDir);
    expect(entry?.installed).toBe(true);
  });

  it("detects continue via VS Code extension dir (secondary probe)", () => {
    const extDir = join(fakeHome, ".vscode", "extensions", "continue.continue");
    mkdirAt(extDir);

    const result = detectInstalledIdes(fakeHome);
    const entry = result.find((e) => e.name === "continue");
    expect(entry).toBeDefined();
    expect(entry?.configDir).toBe(extDir);
  });

  it("primary probe wins over secondary when both exist", () => {
    const primary = join(fakeHome, ".continue");
    const secondary = join(fakeHome, ".vscode", "extensions", "continue.continue");
    mkdirAt(primary);
    mkdirAt(secondary);

    const result = detectInstalledIdes(fakeHome);
    const entry = result.find((e) => e.name === "continue");
    expect(entry?.configDir).toBe(primary);
  });

  it("does NOT detect continue when neither probe path exists", () => {
    const result = detectInstalledIdes(fakeHome);
    expect(result.find((e) => e.name === "continue")).toBeUndefined();
  });
});

describe("detectInstalledIdes — windsurf detection", () => {
  it("detects windsurf when ~/.windsurf/ exists", () => {
    const configDir = join(fakeHome, ".windsurf");
    mkdirAt(configDir);

    const result = detectInstalledIdes(fakeHome);
    const entry = result.find((e) => e.name === "windsurf");
    expect(entry).toBeDefined();
    expect(entry?.configDir).toBe(configDir);
    expect(entry?.installed).toBe(true);
  });

  it("does NOT detect windsurf when ~/.windsurf/ is absent", () => {
    const result = detectInstalledIdes(fakeHome);
    expect(result.find((e) => e.name === "windsurf")).toBeUndefined();
  });
});

describe("detectInstalledIdes — aider detection", () => {
  it("detects aider when ~/.aider/ exists", () => {
    const configDir = join(fakeHome, ".aider");
    mkdirAt(configDir);

    const result = detectInstalledIdes(fakeHome);
    const entry = result.find((e) => e.name === "aider");
    expect(entry).toBeDefined();
    expect(entry?.configDir).toBe(configDir);
    expect(entry?.installed).toBe(true);
  });

  it("does NOT detect aider when ~/.aider/ is absent", () => {
    const result = detectInstalledIdes(fakeHome);
    expect(result.find((e) => e.name === "aider")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Multi-IDE detection
// ---------------------------------------------------------------------------

describe("detectInstalledIdes — multiple IDEs simultaneously", () => {
  // Cursor's linux path (~/.config/Cursor) is used in these tests. Mock process.platform
  // to "linux" so buildCandidatePaths() selects the linux cursor candidate on all host OSes.
  const origPlatformMultiIde = process.platform;
  beforeAll(() => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });
  afterAll(() => {
    Object.defineProperty(process, "platform", { value: origPlatformMultiIde, configurable: true });
  });

  it("detects all six IDEs when all config dirs exist", () => {
    mkdirAt(join(fakeHome, ".claude"));
    mkdirAt(join(fakeHome, ".config", "Cursor"));
    mkdirAt(join(fakeHome, ".config", "cline"));
    mkdirAt(join(fakeHome, ".continue"));
    mkdirAt(join(fakeHome, ".windsurf"));
    mkdirAt(join(fakeHome, ".aider"));

    const result = detectInstalledIdes(fakeHome);
    expect(result).toHaveLength(6);
    const names = result.map((e) => e.name);
    expect(names).toContain("claude-code");
    expect(names).toContain("cursor");
    expect(names).toContain("cline");
    expect(names).toContain("continue");
    expect(names).toContain("windsurf");
    expect(names).toContain("aider");
  });

  it("result order is stable: claude-code, cursor, cline, continue, windsurf, aider", () => {
    mkdirAt(join(fakeHome, ".claude"));
    mkdirAt(join(fakeHome, ".config", "Cursor"));
    mkdirAt(join(fakeHome, ".config", "cline"));
    mkdirAt(join(fakeHome, ".continue"));
    mkdirAt(join(fakeHome, ".windsurf"));
    mkdirAt(join(fakeHome, ".aider"));

    const result = detectInstalledIdes(fakeHome);
    expect(result.map((e) => e.name)).toEqual([
      "claude-code",
      "cursor",
      "cline",
      "continue",
      "windsurf",
      "aider",
    ]);
  });

  it("detects only the IDEs whose config dirs actually exist (subset)", () => {
    mkdirAt(join(fakeHome, ".claude"));
    mkdirAt(join(fakeHome, ".continue"));
    // cursor, cline, windsurf, aider NOT created

    const result = detectInstalledIdes(fakeHome);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.name)).toEqual(["claude-code", "continue"]);
  });
});

// ---------------------------------------------------------------------------
// buildCandidatePaths — platform-specific cursor paths
// ---------------------------------------------------------------------------

describe("buildCandidatePaths — cursor platform variants", () => {
  it("darwin: primary candidate is ~/Library/Application Support/Cursor", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const candidates = buildCandidatePaths(fakeHome);
      expect(candidates.cursor[0]).toBe(join(fakeHome, "Library", "Application Support", "Cursor"));
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  it("linux: primary candidate is ~/.config/Cursor", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const candidates = buildCandidatePaths(fakeHome);
      expect(candidates.cursor[0]).toBe(join(fakeHome, ".config", "Cursor"));
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  it("win32: primary candidate uses APPDATA/Cursor when APPDATA is set", () => {
    const origPlatform = process.platform;
    const origAppdata = process.env.APPDATA;
    const fakeAppdata = join(fakeHome, "AppData", "Roaming");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    process.env.APPDATA = fakeAppdata;
    try {
      const candidates = buildCandidatePaths(fakeHome);
      expect(candidates.cursor[0]).toBe(join(fakeAppdata, "Cursor"));
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      process.env.APPDATA = origAppdata;
    }
  });

  it("win32: fallback candidate is ~/AppData/Roaming/Cursor when APPDATA is unset", () => {
    const origPlatform = process.platform;
    const hadAppdata = Object.prototype.hasOwnProperty.call(process.env, "APPDATA");
    const origAppdata = process.env.APPDATA;
    // Truly remove APPDATA from env so the undefined-check in ide-detect.ts triggers.
    Reflect.deleteProperty(process.env, "APPDATA");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const candidates = buildCandidatePaths(fakeHome);
      expect(candidates.cursor[0]).toBe(join(fakeHome, "AppData", "Roaming", "Cursor"));
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      if (hadAppdata) {
        process.env.APPDATA = origAppdata;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// [EC-DETECT-2] Negative cases — no false positives
// ---------------------------------------------------------------------------

describe("detectInstalledIdes — no false positives", () => {
  it("returns [] for a completely empty fake home", () => {
    expect(detectInstalledIdes(fakeHome)).toEqual([]);
  });

  it("a FILE at the config dir path DOES trigger detection (existsSync behavior)", () => {
    // existsSync returns true for files; a file at ~/.claude triggers detection.
    // This is explicitly the accepted trade-off (DEC-CLI-IDE-DETECT-SEMANTICS-001):
    // false-positive < false-negative cost. If a user has a FILE named ~/.claude,
    // we still detect it so uninstall can find what install installed.
    writeFileSync(join(fakeHome, ".claude"), "");
    const result = detectInstalledIdes(fakeHome);
    // existsSync returns true for files — detection fires (this is the spec)
    expect(result.find((e) => e.name === "claude-code")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// [EC-DETECT-3] No shell-out — child_process is NOT imported by ide-detect.ts
// ---------------------------------------------------------------------------

describe("detectInstalledIdes — no shell-out (B6a air-gap gate)", () => {
  // The runtime smoke test below creates ~/.config/Cursor (linux path) and expects 6
  // detected IDEs. Mock process.platform to "linux" so buildCandidatePaths() probes the
  // linux cursor candidate on all host OSes, making the assertion deterministic.
  const origPlatformB6a = process.platform;
  beforeAll(() => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });
  afterAll(() => {
    Object.defineProperty(process, "platform", { value: origPlatformB6a, configurable: true });
  });

  it("ide-detect.ts source does not import node:child_process", async () => {
    // ESM namespace objects are non-configurable (vitest limitation documented
    // at https://vitest.dev/guide/browser/#limitations), so we cannot spy on
    // child_process exports at the module level. Instead, we verify the no-spawn
    // contract statically: read the source file and assert it has no child_process
    // import. This is the correct test for a structural constraint ("the module
    // must never import child_process") rather than a runtime behaviour.
    const { readFileSync: rfs } = await import("node:fs");
    const { dirname: dn, join: pj, resolve } = await import("node:path");
    const { fileURLToPath: ftu } = await import("node:url");

    const thisDir = dn(ftu(import.meta.url));
    const sourceFile = resolve(pj(thisDir, "ide-detect.ts"));
    const src = rfs(sourceFile, "utf-8");

    // The module must never IMPORT child_process in any form (B6a gate).
    // We check for import statements and require() calls specifically, not
    // the bare string "child_process" (which appears in comments).
    expect(src).not.toMatch(/from\s+['"]node:child_process['"]/);
    expect(src).not.toMatch(/require\s*\(\s*['"](?:node:)?child_process['"]\s*\)/);
    expect(src).not.toMatch(/\bexecSync\s*\(/);
    expect(src).not.toMatch(/\bspawnSync\s*\(/);
  });

  it("detectInstalledIdes only calls existsSync (no subprocess side-effects)", () => {
    // Run detection with all IDE dirs present — if any spawn occurred the test
    // environment would hang or produce unexpected output. This is the runtime
    // smoke complement to the static check above.
    mkdirAt(join(fakeHome, ".claude"));
    mkdirAt(join(fakeHome, ".config", "Cursor"));
    mkdirAt(join(fakeHome, ".config", "cline"));
    mkdirAt(join(fakeHome, ".continue"));
    mkdirAt(join(fakeHome, ".windsurf"));
    mkdirAt(join(fakeHome, ".aider"));

    // Should complete synchronously and instantly (no subprocess latency).
    const start = Date.now();
    const result = detectInstalledIdes(fakeHome);
    const elapsed = Date.now() - start;

    expect(result).toHaveLength(6);
    // Subprocess spawn would add at least 20ms even on fast machines.
    // A pure-existsSync run on 6 paths completes in < 5ms.
    expect(elapsed).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// KNOWN_IDE_NAMES export
// ---------------------------------------------------------------------------

describe("KNOWN_IDE_NAMES", () => {
  it("contains exactly the six supported IDE names (claude-code, cursor, cline, continue, windsurf, aider)", () => {
    expect(KNOWN_IDE_NAMES).toEqual([
      "claude-code",
      "cursor",
      "cline",
      "continue",
      "windsurf",
      "aider",
    ]);
  });

  it("does NOT contain 'codex' (NG1: #220 closed not-planned)", () => {
    expect(KNOWN_IDE_NAMES).not.toContain("codex");
  });
});
