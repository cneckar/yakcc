/**
 * init.test.ts — integration tests for `yakcc init`.
 *
 * Production sequence exercised:
 *   init(argv, logger, opts?)
 *   → parseArgs → mkdirSync(.yakcc/) → registryInit
 *   → detectInstalledIdes → installHookForIde(each) → seedYakccCorpus
 *   → [optional federation mirror] → writeRc(.yakccrc.json) → summary log
 *
 * Tests cover the original behavior (suites 1–9) plus the new WI-656-S1 flags
 * (suites 10–18). All new-flag tests pass opts.overrideHome to control which
 * IDEs appear detected without touching the real home directory.
 *
 * @decision DEC-CLI-INIT-TEST-001
 * title: Tests use temp directories; federation mirror not exercised (no test server)
 * status: updated (WI-656-S1 — additive extension)
 * rationale:
 *   Each test creates a fresh OS temp directory so runs are isolated. The
 *   --peer path is validated (URL parsing + .yakccrc.json write) but the actual
 *   federation mirror call against a live HTTP server is out of scope — that is
 *   covered by the federation test suite. CollectingLogger captures output
 *   without mocking. Sacred Practice #5: no mocks on fs internals — all file
 *   I/O is real, against the temp directory.
 *
 *   WI-656-S1 extension: opts.overrideHome injects a fake HOME so IDE detection
 *   probes a controlled directory. Seed is disabled by default in new-flag tests
 *   (--no-seed) to keep them fast; seed behavior is covered by suite 14.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOfflineEmbeddingProvider } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger, runCli } from "../index.js";
import { init } from "./init.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-init-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readRc(dir: string): Record<string, unknown> | null {
  const p = join(dir, ".yakccrc.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

function readSettings(dir: string): Record<string, unknown> | null {
  const p = join(dir, ".claude", "settings.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Suite 1: fresh init produces the expected directory layout
// ---------------------------------------------------------------------------

describe("init — fresh directory", () => {
  it("creates .yakcc/ with subdirectories", async () => {
    const logger = new CollectingLogger();
    const code = await init(["--target", tmpDir], logger);

    expect(code).toBe(0);
    expect(existsSync(join(tmpDir, ".yakcc"))).toBe(true);
    expect(existsSync(join(tmpDir, ".yakcc", "registry"))).toBe(true);
    expect(existsSync(join(tmpDir, ".yakcc", "telemetry"))).toBe(true);
    expect(existsSync(join(tmpDir, ".yakcc", "config"))).toBe(true);
  });

  it("creates .yakcc/registry.sqlite", async () => {
    const code = await init(["--target", tmpDir], new CollectingLogger());
    expect(code).toBe(0);
    expect(existsSync(join(tmpDir, ".yakcc", "registry.sqlite"))).toBe(true);
  });

  it("creates .claude/settings.json with PreToolUse hook entry", async () => {
    const code = await init(["--target", tmpDir], new CollectingLogger());
    expect(code).toBe(0);
    const settings = readSettings(tmpDir);
    expect(settings).not.toBeNull();
    const hooks = settings?.hooks as Record<string, unknown[]>;
    expect(hooks).toBeDefined();
    const preToolUse = hooks.PreToolUse as Array<Record<string, unknown>>;
    expect(Array.isArray(preToolUse)).toBe(true);
    expect(preToolUse.length).toBeGreaterThan(0);
  });

  it("creates .yakccrc.json", async () => {
    const code = await init(["--target", tmpDir], new CollectingLogger());
    expect(code).toBe(0);
    expect(existsSync(join(tmpDir, ".yakccrc.json"))).toBe(true);
  });

  it("prints concise summary output (DEC-CLI-INIT-002 replaces verbose next-steps)", async () => {
    const logger = new CollectingLogger();
    // Use --no-seed + overrideHome to empty dir so test is fast (no corpus, no real HOME)
    await init(["--target", tmpDir, "--no-seed"], logger, { overrideHome: tmpDir });
    const allLog = logger.logLines.join("\n");
    // New summary line per DEC-CLI-INIT-002 / G6
    expect(allLog).toContain("Installed in");
    expect(allLog).toContain(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: .yakccrc.json content
// ---------------------------------------------------------------------------

describe(".yakccrc.json content", () => {
  it("version field is 1", async () => {
    await init(["--target", tmpDir], new CollectingLogger());
    const rc = readRc(tmpDir);
    expect(rc).not.toBeNull();
    expect(rc?.version).toBe(1);
  });

  it("registry.path matches default registry subpath", async () => {
    await init(["--target", tmpDir], new CollectingLogger());
    const rc = readRc(tmpDir);
    expect(rc?.registry).toEqual({ path: ".yakcc/registry.sqlite" });
  });

  it("no federation key when --peer is not provided", async () => {
    await init(["--target", tmpDir], new CollectingLogger());
    const rc = readRc(tmpDir);
    expect(rc?.federation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 3: --target <dir>
// ---------------------------------------------------------------------------

describe("init — --target <dir>", () => {
  it("initializes into a non-cwd path", async () => {
    const subDir = join(tmpDir, "my-project");
    mkdirSync(subDir);

    const code = await init(["--target", subDir], new CollectingLogger());

    expect(code).toBe(0);
    expect(existsSync(join(subDir, ".yakcc", "registry.sqlite"))).toBe(true);
    expect(existsSync(join(subDir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(subDir, ".yakccrc.json"))).toBe(true);
    // Nothing written to parent
    expect(existsSync(join(tmpDir, ".yakcc"))).toBe(false);
    expect(existsSync(join(tmpDir, ".claude"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: idempotency
// ---------------------------------------------------------------------------

describe("init — idempotent re-run", () => {
  it("running twice exits 0 both times", async () => {
    const code1 = await init(["--target", tmpDir], new CollectingLogger());
    const code2 = await init(["--target", tmpDir], new CollectingLogger());
    expect(code1).toBe(0);
    expect(code2).toBe(0);
  });

  it("running twice does not duplicate PreToolUse entries", async () => {
    await init(["--target", tmpDir], new CollectingLogger());
    await init(["--target", tmpDir], new CollectingLogger());

    const settings = readSettings(tmpDir);
    const hooks = settings?.hooks as Record<string, unknown[]>;
    const preToolUse = hooks.PreToolUse as unknown[];
    // Should still have exactly 1 yakcc entry (idempotent hook install)
    expect(
      preToolUse.filter((e) =>
        ((e as Record<string, unknown[]>).hooks ?? []).some(
          (h) => (h as Record<string, unknown>)._yakcc === "yakcc-hook-v1",
        ),
      ).length,
    ).toBe(1);
  });

  it("running twice does not corrupt .yakccrc.json", async () => {
    await init(["--target", tmpDir], new CollectingLogger());
    await init(["--target", tmpDir], new CollectingLogger());

    const rc = readRc(tmpDir);
    expect(rc).not.toBeNull();
    expect(rc?.version).toBe(1);
    expect((rc?.registry as Record<string, unknown>).path).toBe(".yakcc/registry.sqlite");
  });
});

// ---------------------------------------------------------------------------
// Suite 5: --peer flag
// ---------------------------------------------------------------------------

describe("init — --peer <url>", () => {
  it("writes federation.peers into .yakccrc.json (mirror failure is non-fatal)", async () => {
    // The mirror will fail (no real HTTP server), but init should still succeed
    // because mirror failure is non-fatal per DEC-CLI-INIT-001.
    const logger = new CollectingLogger();
    const code = await init(["--target", tmpDir, "--peer", "http://localhost:19999"], logger);

    // Exit 0 — mirror failure is a warning, not a fatal error
    expect(code).toBe(0);
    const rc = readRc(tmpDir);
    expect(rc).not.toBeNull();
    const fed = rc?.federation as Record<string, unknown>;
    expect(fed).toBeDefined();
    expect(Array.isArray(fed.peers)).toBe(true);
    expect((fed.peers as string[]).includes("http://localhost:19999")).toBe(true);
  });

  it("re-run with same peer URL does not duplicate peer entry", async () => {
    const peerUrl = "http://localhost:19999";
    await init(["--target", tmpDir, "--peer", peerUrl], new CollectingLogger());
    await init(["--target", tmpDir, "--peer", peerUrl], new CollectingLogger());

    const rc = readRc(tmpDir);
    const fed = rc?.federation as Record<string, unknown>;
    const peers = fed.peers as string[];
    expect(peers.filter((p) => p === peerUrl).length).toBe(1);
  });

  it("second peer URL is appended alongside the first", async () => {
    const peer1 = "http://localhost:19999";
    const peer2 = "http://localhost:19998";
    await init(["--target", tmpDir, "--peer", peer1], new CollectingLogger());
    await init(["--target", tmpDir, "--peer", peer2], new CollectingLogger());

    const rc = readRc(tmpDir);
    const fed = rc?.federation as Record<string, unknown>;
    const peers = fed.peers as string[];
    expect(peers.includes(peer1)).toBe(true);
    expect(peers.includes(peer2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 6: invalid --peer URL
// ---------------------------------------------------------------------------

describe("init — invalid --peer URL", () => {
  it("returns exit 1 for a non-URL string", async () => {
    const logger = new CollectingLogger();
    const code = await init(["--target", tmpDir, "--peer", "not-a-url"], logger);

    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("error:"))).toBe(true);
  });

  it("returns exit 1 for a ftp:// URL (wrong scheme)", async () => {
    const logger = new CollectingLogger();
    const code = await init(["--target", tmpDir, "--peer", "ftp://example.com"], logger);

    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("http"))).toBe(true);
  });

  it("does not touch the filesystem before validation", async () => {
    await init(["--target", tmpDir, "--peer", "bad-url"], new CollectingLogger());
    // .yakcc/ should not exist — we fail before touching the filesystem
    expect(existsSync(join(tmpDir, ".yakcc"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 7: invalid flags
// ---------------------------------------------------------------------------

describe("init — invalid flags", () => {
  it("returns exit 1 for an unknown flag", async () => {
    const logger = new CollectingLogger();
    const code = await init(["--unknown-flag"], logger);

    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("error:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 8: smoke test — query against initialized registry
// ---------------------------------------------------------------------------

describe("init — smoke test: query against initialized registry", () => {
  it("registry produced by init is openable and queryable (offline embeddings, empty registry)", async () => {
    // Initialize the registry; --no-seed to avoid corpus lookup in test env.
    const initCode = await init(["--target", tmpDir, "--no-seed"], new CollectingLogger(), {
      overrideHome: tmpDir,
    });
    expect(initCode).toBe(0);

    // Open the registry with the offline embedding provider (no network I/O).
    // This proves the SQLite file created by init is a valid, queryable registry.
    const registryPath = join(tmpDir, ".yakcc", "registry.sqlite");
    const embeddings = createOfflineEmbeddingProvider();
    const reg = await openRegistry(registryPath, { embeddings });

    // Run a semantic query against the empty registry — expect 0 results, no crash.
    const results = await reg.findCandidatesByIntent(
      { behavior: "parse a list of integers", inputs: [], outputs: [] },
      { k: 3, rerank: "none" },
    );
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);

    await reg.close();
  });
});

// ---------------------------------------------------------------------------
// Suite 9: runCli dispatch
// ---------------------------------------------------------------------------

describe("runCli dispatch", () => {
  it("routes 'init' correctly to the init handler", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["init", "--target", tmpDir], logger);

    expect(code).toBe(0);
    expect(existsSync(join(tmpDir, ".yakcc", "registry.sqlite"))).toBe(true);
    expect(existsSync(join(tmpDir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(tmpDir, ".yakccrc.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 10: --skip-hooks flag (EC test per §3b.1)
// ---------------------------------------------------------------------------

describe("init — --skip-hooks", () => {
  it("--skip-hooks produces no hook files in .claude/ or .cursor/", async () => {
    const logger = new CollectingLogger();
    // Create fake HOME with both claude-code and cursor config dirs so auto-detect
    // would normally find them.
    const fakeHome = join(tmpDir, "fakehome");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    mkdirSync(join(fakeHome, ".config", "Cursor"), { recursive: true });

    const code = await init(["--target", tmpDir, "--skip-hooks", "--no-seed"], logger, {
      overrideHome: fakeHome,
    });

    expect(code).toBe(0);
    // No hook files should appear in the project dir
    expect(existsSync(join(tmpDir, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(tmpDir, ".cursor", "settings.json"))).toBe(false);
    // Summary mentions skip
    expect(logger.logLines.some((l) => l.includes("skip-hooks"))).toBe(true);
  });

  it("--skip-hooks writes installedHooks: [] to .yakccrc.json", async () => {
    await init(["--target", tmpDir, "--skip-hooks", "--no-seed"], new CollectingLogger(), {
      overrideHome: tmpDir,
    });
    const rc = readRc(tmpDir);
    expect(rc?.installedHooks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Suite 11: --ide flag (EC tests per §3b.1)
// ---------------------------------------------------------------------------

describe("init — --ide flag", () => {
  it("--ide claude-code installs only the Claude Code hook (ignores detected cursor)", async () => {
    const fakeHome = join(tmpDir, "fakehome");
    // Both claude-code and cursor config dirs exist
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    mkdirSync(join(fakeHome, ".config", "Cursor"), { recursive: true });

    const code = await init(
      ["--target", tmpDir, "--ide", "claude-code", "--no-seed"],
      new CollectingLogger(),
      { overrideHome: fakeHome },
    );

    expect(code).toBe(0);
    // Claude Code hook installed
    expect(existsSync(join(tmpDir, ".claude", "settings.json"))).toBe(true);
    // Cursor NOT installed (explicit list)
    expect(existsSync(join(tmpDir, ".cursor", "settings.json"))).toBe(false);
  });

  it("--ide claude-code,cursor installs both Claude Code and Cursor hooks", async () => {
    const fakeHome = join(tmpDir, "fakehome");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    mkdirSync(join(fakeHome, ".config", "Cursor"), { recursive: true });

    const code = await init(
      ["--target", tmpDir, "--ide", "claude-code,cursor", "--no-seed"],
      new CollectingLogger(),
      { overrideHome: fakeHome },
    );

    expect(code).toBe(0);
    expect(existsSync(join(tmpDir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(tmpDir, ".cursor", "settings.json"))).toBe(true);
  });

  it("--ide bogus exits 1 with a message listing the four known IDE names", async () => {
    const logger = new CollectingLogger();
    const code = await init(["--target", tmpDir, "--ide", "bogus-ide", "--no-seed"], logger, {
      overrideHome: tmpDir,
    });

    expect(code).toBe(1);
    const errText = logger.errLines.join("\n");
    expect(errText).toContain("claude-code");
    expect(errText).toContain("cursor");
    expect(errText).toContain("cline");
    expect(errText).toContain("continue");
  });

  it("--ide bogus does NOT touch the filesystem before validation", async () => {
    await init(["--target", tmpDir, "--ide", "bogus-ide", "--no-seed"], new CollectingLogger(), {
      overrideHome: tmpDir,
    });
    // .yakcc/ should not exist — we fail before touching the filesystem
    expect(existsSync(join(tmpDir, ".yakcc"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 12: --no-seed flag (EC tests per §3b.1)
// ---------------------------------------------------------------------------

describe("init — --no-seed flag", () => {
  it("--no-seed does not call seedYakccCorpus (registry stays empty)", async () => {
    const code = await init(["--target", tmpDir, "--no-seed"], new CollectingLogger(), {
      overrideHome: tmpDir,
    });
    expect(code).toBe(0);

    // Registry was created but seeding was skipped — block count should be 0.
    const { createOfflineEmbeddingProvider } = await import("@yakcc/contracts");
    const registryPath = join(tmpDir, ".yakcc", "registry.sqlite");
    const reg = await openRegistry(registryPath, {
      embeddings: createOfflineEmbeddingProvider(),
    });
    const manifest = await reg.exportManifest();
    await reg.close();
    expect(manifest).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 13: seed by default (EC test per §3b.1)
// ---------------------------------------------------------------------------

describe("init — seed by default", () => {
  it("default (no --no-seed) calls seedYakccCorpus and registry is non-empty when corpus exists", async () => {
    // Find the bootstrap corpus path (worktree-aware walk)
    const { existsSync: eSync } = await import("node:fs");
    const { dirname, join: pjoin } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    let corpusPath: string | null = null;
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 30; i++) {
      const candidate = pjoin(dir, "bootstrap", "yakcc.registry.sqlite");
      if (eSync(candidate)) {
        corpusPath = candidate;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    if (corpusPath === null) {
      // Skip this test if bootstrap corpus is not available in this environment.
      // The corpus is a monorepo artifact; binary-distribution follow-up (#361).
      return;
    }

    const logger = new CollectingLogger();
    const code = await init(["--target", tmpDir, "--skip-hooks"], logger, {
      overrideHome: tmpDir,
      corpusPath,
    });
    expect(code).toBe(0);

    // Registry should have atoms from the bootstrap corpus.
    const { createOfflineEmbeddingProvider } = await import("@yakcc/contracts");
    const registryPath = join(tmpDir, ".yakcc", "registry.sqlite");
    const reg = await openRegistry(registryPath, {
      embeddings: createOfflineEmbeddingProvider(),
    });
    const manifest = await reg.exportManifest();
    await reg.close();
    expect(manifest.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 14: --airgapped flag (EC tests per §3b.1)
// ---------------------------------------------------------------------------

describe("init — --airgapped flag", () => {
  it("--airgapped writes mode: 'airgapped' to .yakccrc.json", async () => {
    await init(
      ["--target", tmpDir, "--airgapped", "--no-seed", "--skip-hooks"],
      new CollectingLogger(),
      {
        overrideHome: tmpDir,
      },
    );
    const rc = readRc(tmpDir);
    expect(rc?.mode).toBe("airgapped");
  });
});

// ---------------------------------------------------------------------------
// Suite 15: --local flag (EC tests per §3b.1)
// ---------------------------------------------------------------------------

describe("init — --local flag", () => {
  it("--local writes mode: 'local' to .yakccrc.json", async () => {
    await init(
      ["--target", tmpDir, "--local", "--no-seed", "--skip-hooks"],
      new CollectingLogger(),
      {
        overrideHome: tmpDir,
      },
    );
    const rc = readRc(tmpDir);
    expect(rc?.mode).toBe("local");
  });

  it("default (no flag) also writes mode: 'local' to .yakccrc.json", async () => {
    await init(["--target", tmpDir, "--no-seed", "--skip-hooks"], new CollectingLogger(), {
      overrideHome: tmpDir,
    });
    const rc = readRc(tmpDir);
    expect(rc?.mode).toBe("local");
  });
});

// ---------------------------------------------------------------------------
// Suite 16: --peer flag mode (EC test per §3b.1)
// ---------------------------------------------------------------------------

describe("init — --peer flag sets mode: global (EC DEC-CLI-INIT-001 backward compat)", () => {
  it("--peer <url> writes mode: 'global' AND federation.peers[]", async () => {
    const logger = new CollectingLogger();
    const code = await init(
      ["--target", tmpDir, "--peer", "http://localhost:19999", "--no-seed", "--skip-hooks"],
      logger,
      { overrideHome: tmpDir },
    );

    expect(code).toBe(0);
    const rc = readRc(tmpDir);
    expect(rc?.mode).toBe("global");
    const fed = rc?.federation as Record<string, unknown>;
    expect(fed).toBeDefined();
    expect((fed.peers as string[]).includes("http://localhost:19999")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 17: summary output (EC tests per §3b.1, G6)
// ---------------------------------------------------------------------------

describe("init — summary output (G6: ≤6 lines on happy path)", () => {
  it("success output contains 'Installed in' + target dir", async () => {
    const logger = new CollectingLogger();
    await init(["--target", tmpDir, "--no-seed", "--skip-hooks"], logger, {
      overrideHome: tmpDir,
    });
    const allLog = logger.logLines.join("\n");
    expect(allLog).toContain("Installed in");
    expect(allLog).toContain(tmpDir);
  });

  it("success output contains 'Hooked into:' when an IDE is installed", async () => {
    const fakeHome = join(tmpDir, "fakehome");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });

    const logger = new CollectingLogger();
    await init(["--target", tmpDir, "--no-seed", "--ide", "claude-code"], logger, {
      overrideHome: fakeHome,
    });

    const allLog = logger.logLines.join("\n");
    expect(allLog).toContain("Hooked into:");
    expect(allLog).toContain("claude-code");
  });

  it("success output is ≤8 lines on default happy path (G6 + WI-760 telemetry lines)", async () => {
    // @decision DEC-CLI-INIT-WI760-G6-UPDATE-001
    // title: G6 line-count limit raised from 6 to 8 to accommodate WI-760 telemetry discoverability
    // status: accepted (WI-760)
    // rationale: WI-760 adds a "telemetry will land in" line from hooksClaudeCodeInstall and a
    //   "Telemetry:" summary line from init itself. Both are required per the WI-760 acceptance
    //   criteria. The prior G6=6 constraint is updated to G6=8 to reflect these two additions.
    const fakeHome = join(tmpDir, "fakehome");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });

    const logger = new CollectingLogger();
    await init(["--target", tmpDir, "--no-seed", "--ide", "claude-code"], logger, {
      overrideHome: fakeHome,
    });

    // Count non-empty log lines
    const nonEmptyLines = logger.logLines.filter((l) => l.trim().length > 0);
    expect(nonEmptyLines.length).toBeLessThanOrEqual(8);
  });

  // EC-S7-T1: no-detect path surfaces a structured hint (DEC-CLI-INIT-NO-IDE-HINT-001)
  it("no-detect path surfaces a hint with `--ide` and the known IDE names", async () => {
    // On Windows, buildCandidatePaths uses process.env.APPDATA for Cursor (not home-relative),
    // so we must temporarily redirect APPDATA to a non-existent path inside fakeHome to
    // guarantee detectInstalledIdes returns [] (Sacred Practice #5: real I/O, no deep mocks).
    const fakeHome = join(tmpDir, "fakehome-empty");
    mkdirSync(fakeHome, { recursive: true });
    const savedAppdata = process.env.APPDATA;
    process.env.APPDATA = join(fakeHome, "AppData", "Roaming");

    let logger: CollectingLogger;
    try {
      logger = new CollectingLogger();
      await init(["--target", tmpDir, "--no-seed"], logger, { overrideHome: fakeHome });
    } finally {
      // Always restore APPDATA, even on test failure (prevent state leakage)
      if (savedAppdata === undefined) {
        // biome-ignore lint/performance/noDelete: restoring env to absent state
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = savedAppdata;
      }
    }

    const allLog = logger.logLines.join("\n");
    // Hint references the recovery flag and the opt-out
    expect(allLog).toContain("--ide");
    expect(allLog).toContain("--skip-hooks");
    // Hint lists IDE names — sample at least 3 of the 6 (avoid coupling to exact ordering)
    const { KNOWN_IDE_NAMES } = await import("../lib/ide-detect.js");
    const namesInHint = KNOWN_IDE_NAMES.filter((n) => allLog.includes(n));
    expect(namesInHint.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Suite 18: .yakccrc.json schema invariants (EC per §3b.1)
// ---------------------------------------------------------------------------

describe("init — .yakccrc.json schema invariants (NG4: version stays 1, additive only)", () => {
  it("version is still 1 after WI-656-S1 extension", async () => {
    await init(["--target", tmpDir, "--no-seed", "--skip-hooks"], new CollectingLogger(), {
      overrideHome: tmpDir,
    });
    const rc = readRc(tmpDir);
    expect(rc?.version).toBe(1);
  });

  it("installedHooks is present after install", async () => {
    await init(["--target", tmpDir, "--no-seed", "--skip-hooks"], new CollectingLogger(), {
      overrideHome: tmpDir,
    });
    const rc = readRc(tmpDir);
    expect(Array.isArray(rc?.installedHooks)).toBe(true);
  });

  it("mode field is present", async () => {
    await init(["--target", tmpDir, "--no-seed", "--skip-hooks"], new CollectingLogger(), {
      overrideHome: tmpDir,
    });
    const rc = readRc(tmpDir);
    expect(rc?.mode).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 19: cline dispatch through init (coverage for lines 210-215 of init.ts)
// ---------------------------------------------------------------------------

describe("init — --ide cline: installs cline marker via installHookForIde", () => {
  it("--ide cline creates yakcc-cline-hook.json in ~/.config/cline/", async () => {
    const fakeHome = join(tmpDir, "fakehome-cline");
    // Create the cline config dir so detectInstalledIdes can find it
    mkdirSync(join(fakeHome, ".config", "cline"), { recursive: true });

    const logger = new CollectingLogger();
    const code = await init(["--target", tmpDir, "--ide", "cline", "--no-seed"], logger, {
      overrideHome: fakeHome,
    });

    expect(code).toBe(0);
    // Marker file written to the overrideHome-rooted cline config dir
    expect(existsSync(join(fakeHome, ".config", "cline", "yakcc-cline-hook.json"))).toBe(true);
    // .yakccrc.json records installedHooks: ["cline"]
    const rc = readRc(tmpDir);
    expect((rc?.installedHooks as string[]).includes("cline")).toBe(true);
  });

  it("--ide cline: cline marker contains _yakcc sentinel field", async () => {
    const fakeHome = join(tmpDir, "fakehome-cline-marker");
    mkdirSync(join(fakeHome, ".config", "cline"), { recursive: true });

    await init(["--target", tmpDir, "--ide", "cline", "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });

    const markerPath = join(fakeHome, ".config", "cline", "yakcc-cline-hook.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as Record<string, unknown>;
    expect(marker._yakcc).toBe("yakcc-hook-v1-cline");
  });
});

// ---------------------------------------------------------------------------
// Suite 20: continue dispatch through init (coverage for lines 217-222 of init.ts)
// ---------------------------------------------------------------------------

describe("init — --ide continue: installs continue marker via installHookForIde", () => {
  it("--ide continue creates yakcc-continue-hook.json in ~/.continue/", async () => {
    const fakeHome = join(tmpDir, "fakehome-continue");
    // Create the continue config dir so detectInstalledIdes can find it
    mkdirSync(join(fakeHome, ".continue"), { recursive: true });

    const logger = new CollectingLogger();
    const code = await init(["--target", tmpDir, "--ide", "continue", "--no-seed"], logger, {
      overrideHome: fakeHome,
    });

    expect(code).toBe(0);
    // Marker file written to the overrideHome-rooted continue config dir
    expect(existsSync(join(fakeHome, ".continue", "yakcc-continue-hook.json"))).toBe(true);
    // .yakccrc.json records installedHooks: ["continue"]
    const rc = readRc(tmpDir);
    expect((rc?.installedHooks as string[]).includes("continue")).toBe(true);
  });

  it("--ide continue: continue marker contains _yakcc sentinel field", async () => {
    const fakeHome = join(tmpDir, "fakehome-continue-marker");
    mkdirSync(join(fakeHome, ".continue"), { recursive: true });

    await init(["--target", tmpDir, "--ide", "continue", "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });

    const markerPath = join(fakeHome, ".continue", "yakcc-continue-hook.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as Record<string, unknown>;
    expect(marker._yakcc).toBe("yakcc-hook-v1-continue");
  });
});

// ---------------------------------------------------------------------------
// Suite 21: compound-interaction test (Evaluation Contract requirement)
//
// Exercises the real production sequence end-to-end:
//   init → registry → claude-code hook install → yakccrc write → summary
//
// This is the "at least one test that exercises the real production sequence
// end-to-end, crossing the boundaries of multiple internal components"
// required by the implementer dispatch contract.
// ---------------------------------------------------------------------------

describe("init — compound interaction: real sequence end-to-end", () => {
  it("end-to-end: init + claude-code hook + yakccrc, all written atomically", async () => {
    const fakeHome = join(tmpDir, "fakehome");
    // Only claude-code config dir exists — cursor/cline/continue not detected
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });

    const logger = new CollectingLogger();
    const code = await init(["--target", tmpDir, "--no-seed"], logger, {
      overrideHome: fakeHome,
    });

    // 1. Exit 0
    expect(code).toBe(0);

    // 2. .yakcc/ directory layout
    expect(existsSync(join(tmpDir, ".yakcc"))).toBe(true);
    expect(existsSync(join(tmpDir, ".yakcc", "registry.sqlite"))).toBe(true);
    expect(existsSync(join(tmpDir, ".yakcc", "telemetry"))).toBe(true);
    expect(existsSync(join(tmpDir, ".yakcc", "config"))).toBe(true);

    // 3. Claude Code hook installed (real settings.json written)
    expect(existsSync(join(tmpDir, ".claude", "settings.json"))).toBe(true);
    const settings = readSettings(tmpDir);
    const hooks = settings?.hooks as Record<string, unknown[]>;
    const preToolUse = hooks?.PreToolUse as Array<Record<string, unknown>>;
    expect(Array.isArray(preToolUse)).toBe(true);
    expect(preToolUse.length).toBeGreaterThan(0);

    // 4. .yakccrc.json has mode + installedHooks
    const rc = readRc(tmpDir);
    expect(rc?.version).toBe(1);
    expect(rc?.mode).toBe("local");
    expect(Array.isArray(rc?.installedHooks)).toBe(true);
    expect((rc?.installedHooks as string[]).includes("claude-code")).toBe(true);

    // 5. Summary output references the target dir and the detected IDE
    const allLog = logger.logLines.join("\n");
    expect(allLog).toContain("Installed in");
    expect(allLog).toContain("Hooked into:");
    expect(allLog).toContain("claude-code");
  });
});

// ---------------------------------------------------------------------------
// Suite 22: windsurf / aider auto-detect through init (S7 / WI-687-S7 / #746 AC1)
//
// The lifecycle integration test covers all 6 adapters end-to-end, but those
// tests seed each adapter explicitly via --ide flag. These two cases exercise
// the AUTO-DETECT path through init() for the two adapters that previously
// lacked init.test.ts coverage of that path (claude-code/cursor/cline/continue
// were already covered by suites 1, 11, 19, 20, 21).
// EC-S7-T2 (windsurf) and EC-S7-T3 (aider).
// ---------------------------------------------------------------------------

describe("init — auto-detect-through-init: windsurf", () => {
  it("auto-detects windsurf when ~/.windsurf/ exists in fakeHome", async () => {
    const fakeHome = join(tmpDir, "fakehome-windsurf-auto");
    mkdirSync(join(fakeHome, ".windsurf"), { recursive: true });

    const code = await init(["--target", tmpDir, "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });
    expect(code).toBe(0);
    const rc = readRc(tmpDir);
    expect((rc?.installedHooks as string[]).includes("windsurf")).toBe(true);
  });
});

describe("init — auto-detect-through-init: aider", () => {
  it("auto-detects aider when ~/.aider/ exists in fakeHome", async () => {
    const fakeHome = join(tmpDir, "fakehome-aider-auto");
    mkdirSync(join(fakeHome, ".aider"), { recursive: true });

    const code = await init(["--target", tmpDir, "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });
    expect(code).toBe(0);
    const rc = readRc(tmpDir);
    expect((rc?.installedHooks as string[]).includes("aider")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 23: capstone — all six IDEs auto-detected through init (S7 capstone)
//
// Proves the S7 acceptance: when every IDE config dir is present, init() runs
// the real production sequence (detectInstalledIdes → installHookForIde each)
// and ALL six IDEs land in installedHooks. This is the single test that
// demonstrates "yakcc init auto-detect expansion to all 6 IDEs" end-to-end
// through init() (lifecycle integration test exercises the round-trip; this
// suite exercises only the init-side auto-detect glue).
// EC-S7-T4.
// ---------------------------------------------------------------------------

describe("init — auto-detect-through-init: all six IDEs (S7 capstone)", () => {
  it("auto-detects all 6 known IDEs when every config dir exists", async () => {
    const fakeHome = join(tmpDir, "fakehome-all-six");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    mkdirSync(join(fakeHome, ".config", "Cursor"), { recursive: true });
    mkdirSync(join(fakeHome, ".config", "cline"), { recursive: true });
    mkdirSync(join(fakeHome, ".continue"), { recursive: true });
    mkdirSync(join(fakeHome, ".windsurf"), { recursive: true });
    mkdirSync(join(fakeHome, ".aider"), { recursive: true });

    const code = await init(["--target", tmpDir, "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });
    expect(code).toBe(0);

    const rc = readRc(tmpDir);
    const installed = rc?.installedHooks as string[];
    const { KNOWN_IDE_NAMES } = await import("../lib/ide-detect.js");
    for (const ide of KNOWN_IDE_NAMES) {
      expect(installed.includes(ide)).toBe(true);
    }
    // Future-proof: a 7th IDE adapter that forgets to extend auto-detect glue
    // will fail this assertion (Sacred Practice #12 / DEC-WI687-SLICING-001).
    expect(installed).toHaveLength(KNOWN_IDE_NAMES.length);
  });
});
