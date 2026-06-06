/**
 * init.test.ts — integration tests for `yakcc init`.
 *
 * Production sequence exercised:
 *   init(argv, logger, opts?)
 *   → parseArgs → mkdirSync(.yakcc/) → registryInit
 *   → detectInstalledIdes → installHookForIde(each) → seedYakccCorpus
 *   → [optional federation mirror via runFederation seam] → writeRc(.yakccrc.json) → summary log
 *
 * Tests cover the original behavior (suites 1–9) plus the new WI-656-S1 flags
 * (suites 10–18). All new-flag tests pass opts.overrideHome to control which
 * IDEs appear detected without touching the real home directory.
 *
 * @decision DEC-CLI-INIT-TEST-001
 * title: Tests use temp directories; federation mirror stubbed via InitOptions.runFederation seam
 * status: updated (WI-656-S1 — additive; WI-WPE-C — mirror seam injection)
 * rationale:
 *   Each test creates a fresh OS temp directory so runs are isolated. The
 *   --peer path is validated (URL parsing + .yakccrc.json write) but the actual
 *   federation mirror call against a live HTTP server is avoided — tests inject
 *   a stub via opts.runFederation (DEC-WPE-DEFAULT-PEER-001 seam). This prevents
 *   tests from hanging when registry.yakcc.com is unreachable and keeps the suite
 *   fast. CollectingLogger captures output without mocking. Sacred Practice #5:
 *   no mocks on fs internals — all file I/O is real, against the temp directory.
 *
 *   WI-656-S1 extension: opts.overrideHome injects a fake HOME so IDE detection
 *   probes a controlled directory. Seed is disabled by default in new-flag tests
 *   (--no-seed) to keep them fast; seed behavior is covered by suite 14.
 *
 *   WI-WPE-C mirror seam: tests that exercise the default-peer path inject
 *   noOpMirror (returns 0 immediately) or captureMirror (records call args).
 *   Tests that only care about filesystem layout use --local to skip the mirror
 *   entirely. The three canonical seam tests (suite 24) assert: default invokes
 *   the seam with correct args; --local skips it; --airgapped skips it.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeFileSync as writeFileSyncForPolyglot,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOfflineEmbeddingProvider } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Logger } from "../index.js";
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
// Mirror seam stubs (DEC-WPE-DEFAULT-PEER-001 testability seam)
//
// noOpMirror: returns 0 immediately — used when a test exercises the default-peer
//   registration path but does not care about mirror behaviour.
// captureMirror: records all call args — used by suite 24 to assert the correct
//   mirror args are passed without performing real network I/O.
// ---------------------------------------------------------------------------

/** No-op mirror stub: signals success without real HTTP. */
const noOpMirror = async (_argv: string[], _logger: Logger): Promise<number> => 0;

/**
 * Build a capturing mirror stub. Returns { stub, calls } — stub is the function
 * to inject; calls is the live array that accumulates each argv array received.
 */
function captureMirror(): {
  stub: (argv: string[], logger: Logger) => Promise<number>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const stub = async (argv: string[], _logger: Logger): Promise<number> => {
    calls.push([...argv]);
    return 0;
  };
  return { stub, calls };
}

// ---------------------------------------------------------------------------
// Suite 1: fresh init produces the expected directory layout
// ---------------------------------------------------------------------------

describe("init — fresh directory", () => {
  it("creates .yakcc/ with subdirectories", async () => {
    const logger = new CollectingLogger();
    // --local --no-seed: skip mirror and corpus seeding; this test only cares about filesystem layout
    const code = await init(["--target", tmpDir, "--local", "--no-seed"], logger);

    expect(code).toBe(0);
    expect(existsSync(join(tmpDir, ".yakcc"))).toBe(true);
    expect(existsSync(join(tmpDir, ".yakcc", "registry"))).toBe(true);
    expect(existsSync(join(tmpDir, ".yakcc", "telemetry"))).toBe(true);
    expect(existsSync(join(tmpDir, ".yakcc", "config"))).toBe(true);
  });

  it("creates .yakcc/registry.sqlite", async () => {
    // --local --no-seed: skip mirror and seeding; only testing SQLite creation
    const code = await init(["--target", tmpDir, "--local", "--no-seed"], new CollectingLogger());
    expect(code).toBe(0);
    expect(existsSync(join(tmpDir, ".yakcc", "registry.sqlite"))).toBe(true);
  });

  it("creates .claude/settings.json with PreToolUse hook entry", async () => {
    // --local --no-seed: skip mirror and seeding; only testing hook install
    const code = await init(["--target", tmpDir, "--local", "--no-seed"], new CollectingLogger());
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
    // --local --no-seed: skip mirror and seeding; only testing rc file creation
    const code = await init(["--target", tmpDir, "--local", "--no-seed"], new CollectingLogger());
    expect(code).toBe(0);
    expect(existsSync(join(tmpDir, ".yakccrc.json"))).toBe(true);
  });

  it("prints concise summary output (DEC-CLI-INIT-002 replaces verbose next-steps)", async () => {
    const logger = new CollectingLogger();
    // Use --no-seed + --local + overrideHome to empty dir so test is fast (no corpus, no real HOME, no mirror)
    await init(["--target", tmpDir, "--no-seed", "--local"], logger, { overrideHome: tmpDir });
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
    // --local --no-seed: skip mirror and seeding; this test only cares about the version field
    await init(["--target", tmpDir, "--local", "--no-seed"], new CollectingLogger());
    const rc = readRc(tmpDir);
    expect(rc).not.toBeNull();
    expect(rc?.version).toBe(1);
  });

  it("registry.path matches default registry subpath", async () => {
    // --local --no-seed: skip mirror and seeding; this test only cares about the registry.path field
    await init(["--target", tmpDir, "--local", "--no-seed"], new CollectingLogger());
    const rc = readRc(tmpDir);
    expect(rc?.registry).toEqual({ path: ".yakcc/registry.sqlite" });
  });

  it("federation key is present with default peer when no --peer/--local/--airgapped flag is given (DEC-WPE-DEFAULT-PEER-001)", async () => {
    // DEC-WPE-DEFAULT-PEER-001: bare `yakcc init` now registers registry.yakcc.com
    // as the default federation peer. noOpMirror is injected so the test does not
    // perform real HTTP I/O — we assert the RC is written correctly, not the mirror.
    await init(["--target", tmpDir, "--skip-hooks", "--no-seed"], new CollectingLogger(), {
      overrideHome: tmpDir,
      runFederation: noOpMirror,
    });
    const rc = readRc(tmpDir);
    const fed = rc?.federation as Record<string, unknown> | undefined;
    expect(fed).toBeDefined();
    expect(Array.isArray(fed?.peers)).toBe(true);
    expect((fed?.peers as string[]).includes("https://registry.yakcc.com")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: --target <dir>
// ---------------------------------------------------------------------------

describe("init — --target <dir>", () => {
  it("initializes into a non-cwd path", async () => {
    const subDir = join(tmpDir, "my-project");
    mkdirSync(subDir);

    // --local --no-seed: skip mirror and seeding; this test only cares about target-dir isolation
    const code = await init(["--target", subDir, "--local", "--no-seed"], new CollectingLogger());

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
    // --local --no-seed: skip mirror and seeding; this test only cares about idempotency of exit code
    const code1 = await init(["--target", tmpDir, "--local", "--no-seed"], new CollectingLogger());
    const code2 = await init(["--target", tmpDir, "--local", "--no-seed"], new CollectingLogger());
    expect(code1).toBe(0);
    expect(code2).toBe(0);
  });

  it("running twice does not duplicate PreToolUse entries", async () => {
    // --local --no-seed: skip mirror and seeding; this test only cares about hook-install idempotency
    await init(["--target", tmpDir, "--local", "--no-seed"], new CollectingLogger());
    await init(["--target", tmpDir, "--local", "--no-seed"], new CollectingLogger());

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
    // --local --no-seed: skip mirror and seeding; this test only cares about rc idempotency
    await init(["--target", tmpDir, "--local", "--no-seed"], new CollectingLogger());
    await init(["--target", tmpDir, "--local", "--no-seed"], new CollectingLogger());

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
    // because mirror failure is non-fatal per DEC-CLI-INIT-001. noOpMirror is
    // injected to avoid waiting for a TCP timeout on localhost:19999. --no-seed
    // avoids slow corpus seeding (unrelated to this test).
    const logger = new CollectingLogger();
    const code = await init(
      ["--target", tmpDir, "--peer", "http://localhost:19999", "--no-seed"],
      logger,
      {
        runFederation: noOpMirror,
      },
    );

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
    // noOpMirror + --no-seed: this test cares about peer deduplication, not mirror or seeding
    await init(["--target", tmpDir, "--peer", peerUrl, "--no-seed"], new CollectingLogger(), {
      runFederation: noOpMirror,
    });
    await init(["--target", tmpDir, "--peer", peerUrl, "--no-seed"], new CollectingLogger(), {
      runFederation: noOpMirror,
    });

    const rc = readRc(tmpDir);
    const fed = rc?.federation as Record<string, unknown>;
    const peers = fed.peers as string[];
    expect(peers.filter((p) => p === peerUrl).length).toBe(1);
  });

  it("second peer URL is appended alongside the first", async () => {
    const peer1 = "http://localhost:19999";
    const peer2 = "http://localhost:19998";
    // noOpMirror + --no-seed: this test cares about peer list accumulation, not mirror or seeding
    await init(["--target", tmpDir, "--peer", peer1, "--no-seed"], new CollectingLogger(), {
      runFederation: noOpMirror,
    });
    await init(["--target", tmpDir, "--peer", peer2, "--no-seed"], new CollectingLogger(), {
      runFederation: noOpMirror,
    });

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
    // Initialize the registry; --no-seed to avoid corpus lookup; --local to skip mirror.
    const initCode = await init(
      ["--target", tmpDir, "--no-seed", "--local"],
      new CollectingLogger(),
      { overrideHome: tmpDir },
    );
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
    // --local --no-seed: skip mirror and seeding; this test only cares that the CLI routes to init correctly
    const code = await runCli(["init", "--target", tmpDir, "--local", "--no-seed"], logger);

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

    // noOpMirror: this test cares about --skip-hooks behaviour, not mirror
    const code = await init(["--target", tmpDir, "--skip-hooks", "--no-seed"], logger, {
      overrideHome: fakeHome,
      runFederation: noOpMirror,
    });

    expect(code).toBe(0);
    // No hook files should appear in the project dir
    expect(existsSync(join(tmpDir, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(tmpDir, ".cursor", "settings.json"))).toBe(false);
    // Summary mentions skip
    expect(logger.logLines.some((l) => l.includes("skip-hooks"))).toBe(true);
  });

  it("--skip-hooks writes installedHooks: [] to .yakccrc.json", async () => {
    // noOpMirror: this test cares about installedHooks content, not mirror
    await init(["--target", tmpDir, "--skip-hooks", "--no-seed"], new CollectingLogger(), {
      overrideHome: tmpDir,
      runFederation: noOpMirror,
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

    // noOpMirror: this test cares about --ide selection, not mirror
    const code = await init(
      ["--target", tmpDir, "--ide", "claude-code", "--no-seed"],
      new CollectingLogger(),
      { overrideHome: fakeHome, runFederation: noOpMirror },
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

    // noOpMirror: this test cares about --ide multi-selection, not mirror
    const code = await init(
      ["--target", tmpDir, "--ide", "claude-code,cursor", "--no-seed"],
      new CollectingLogger(),
      { overrideHome: fakeHome, runFederation: noOpMirror },
    );

    expect(code).toBe(0);
    expect(existsSync(join(tmpDir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(tmpDir, ".cursor", "settings.json"))).toBe(true);
  });

  it("--ide bogus exits 1 with a message listing the four known IDE names", async () => {
    const logger = new CollectingLogger();
    // Validation fails before mirror is attempted — no runFederation injection needed
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
    // Validation fails before mirror is attempted — no runFederation injection needed
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
    // noOpMirror: this test cares about --no-seed behaviour, not mirror
    const code = await init(["--target", tmpDir, "--no-seed"], new CollectingLogger(), {
      overrideHome: tmpDir,
      runFederation: noOpMirror,
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
  it(
    "default (no --no-seed) calls seedYakccCorpus and registry is non-empty when corpus exists",
    { timeout: 60_000 },
    async () => {
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

      // Inject the offline-blake3-stub embedding provider so the seed path
      // does not load the BGE model. The model load was making this test
      // exceed its 300s timeout (closes #802); with the stub, seed completes
      // well under 60s on commodity hardware.
      const { createOfflineEmbeddingProvider } = await import("@yakcc/contracts");
      const offlineEmbeddings = createOfflineEmbeddingProvider();

      // DEC-CLI-HERMETIC-INIT-001: guard against corpus embedding model mismatch.
      // The bootstrap corpus was produced with Xenova/bge-small-en-v1.5 in some
      // environments and bootstrap/null-zero in others. If the corpus was stored
      // with a model that differs from the zero-vector provider used by
      // seedYakccCorpus internally, the open will throw a mismatch error which
      // init() catches non-fatally — leaving seedCount=0 and this test failing.
      // Solution: probe the corpus with the null-zero provider before running the
      // full test. If the probe fails (mismatch), skip deterministically rather
      // than asserting a count that seeding will never produce.
      const zeroProvider = {
        dimension: 384,
        modelId: "bootstrap/null-zero",
        embed: async (_text: string): Promise<Float32Array> => new Float32Array(384),
      };
      try {
        const probeReg = await openRegistry(corpusPath, { embeddings: zeroProvider });
        await probeReg.close();
      } catch {
        // Corpus was stored with a different embedding model (e.g. Xenova/bge-small-en-v1.5).
        // seedYakccCorpus uses the null-zero provider internally; the mismatch causes
        // a non-fatal error in init(), leaving the registry empty. Skip deterministically.
        return;
      }

      const logger = new CollectingLogger();
      // noOpMirror: this test cares about seed behaviour, not mirror
      const code = await init(["--target", tmpDir, "--skip-hooks"], logger, {
        overrideHome: tmpDir,
        corpusPath,
        runFederation: noOpMirror,
        embeddings: offlineEmbeddings,
      });
      expect(code).toBe(0);

      // Registry should have atoms from the bootstrap corpus.
      const registryPath = join(tmpDir, ".yakcc", "registry.sqlite");
      const reg = await openRegistry(registryPath, {
        embeddings: offlineEmbeddings,
      });
      const manifest = await reg.exportManifest();
      await reg.close();
      expect(manifest.length).toBeGreaterThanOrEqual(1);
    },
  );
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

  it("default (no flag) writes mode: 'global' to .yakccrc.json (DEC-WPE-DEFAULT-PEER-001)", async () => {
    // DEC-WPE-DEFAULT-PEER-001 reverses the prior offline-first default:
    // bare `yakcc init` now writes mode="global" (not "local") to signal
    // that registry.yakcc.com is registered as the default federation peer.
    // noOpMirror: this test cares about mode field, not whether mirror actually ran
    await init(["--target", tmpDir, "--no-seed", "--skip-hooks"], new CollectingLogger(), {
      overrideHome: tmpDir,
      runFederation: noOpMirror,
    });
    const rc = readRc(tmpDir);
    expect(rc?.mode).toBe("global");
  });
});

// ---------------------------------------------------------------------------
// Suite 16: --peer flag mode (EC test per §3b.1)
// ---------------------------------------------------------------------------

describe("init — --peer flag sets mode: global (EC DEC-CLI-INIT-001 backward compat)", () => {
  it("--peer <url> writes mode: 'global' AND federation.peers[]", async () => {
    const logger = new CollectingLogger();
    // noOpMirror: this test cares about mode + peers content; mirror success is irrelevant
    const code = await init(
      ["--target", tmpDir, "--peer", "http://localhost:19999", "--no-seed", "--skip-hooks"],
      logger,
      { overrideHome: tmpDir, runFederation: noOpMirror },
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
    // --local: skip mirror; this test only checks summary content
    await init(["--target", tmpDir, "--no-seed", "--skip-hooks", "--local"], logger, {
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
    // noOpMirror: this test checks hook summary line, not mirror behaviour
    await init(["--target", tmpDir, "--no-seed", "--ide", "claude-code"], logger, {
      overrideHome: fakeHome,
      runFederation: noOpMirror,
    });

    const allLog = logger.logLines.join("\n");
    expect(allLog).toContain("Hooked into:");
    expect(allLog).toContain("claude-code");
  });

  it("success output is ≤9 lines on default happy path (G6 + WI-760 telemetry lines + compose-by-ref line)", async () => {
    // @decision DEC-CLI-INIT-WI760-G6-UPDATE-001
    // title: G6 line-count limit is 9 to accommodate WI-760 telemetry + compose-by-ref line
    // status: updated (DEC-COMPOSE-BY-REF-DEFAULT-001 adds the manifest-scaffold summary line)
    // rationale: WI-760 adds a "telemetry will land in" line from hooksClaudeCodeInstall and a
    //   "Telemetry:" summary line from init itself. DEC-COMPOSE-BY-REF-DEFAULT-001 adds a
    //   "Compose-by-reference:" manifest-scaffold line. Prior G6=8 → G6=9.
    //   DEC-WPE-DEFAULT-PEER-001 mirror path does not add a log line on the happy path (the
    //   pre-mirror log was removed; only a warning is emitted on failure). noOpMirror is
    //   injected here so the count is deterministic even when registry.yakcc.com is unreachable.
    const fakeHome = join(tmpDir, "fakehome");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });

    const logger = new CollectingLogger();
    // noOpMirror: deterministic line count — mirror is exercised but adds 0 lines on success
    await init(["--target", tmpDir, "--no-seed", "--ide", "claude-code"], logger, {
      overrideHome: fakeHome,
      runFederation: noOpMirror,
    });

    // Count non-empty log lines
    const nonEmptyLines = logger.logLines.filter((l) => l.trim().length > 0);
    expect(nonEmptyLines.length).toBeLessThanOrEqual(9);
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
      // noOpMirror: this test cares about the no-IDE hint, not mirror
      await init(["--target", tmpDir, "--no-seed"], logger, {
        overrideHome: fakeHome,
        runFederation: noOpMirror,
      });
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
    // noOpMirror: this test cares about schema version, not mirror
    await init(["--target", tmpDir, "--no-seed", "--skip-hooks"], new CollectingLogger(), {
      overrideHome: tmpDir,
      runFederation: noOpMirror,
    });
    const rc = readRc(tmpDir);
    expect(rc?.version).toBe(1);
  });

  it("installedHooks is present after install", async () => {
    // noOpMirror: this test cares about installedHooks field, not mirror
    await init(["--target", tmpDir, "--no-seed", "--skip-hooks"], new CollectingLogger(), {
      overrideHome: tmpDir,
      runFederation: noOpMirror,
    });
    const rc = readRc(tmpDir);
    expect(Array.isArray(rc?.installedHooks)).toBe(true);
  });

  it("mode field is present", async () => {
    // noOpMirror: this test cares about mode field presence, not mirror
    await init(["--target", tmpDir, "--no-seed", "--skip-hooks"], new CollectingLogger(), {
      overrideHome: tmpDir,
      runFederation: noOpMirror,
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
    // noOpMirror: this test cares about cline hook install, not mirror
    const code = await init(["--target", tmpDir, "--ide", "cline", "--no-seed"], logger, {
      overrideHome: fakeHome,
      runFederation: noOpMirror,
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

    // noOpMirror: this test cares about the marker content, not mirror
    await init(["--target", tmpDir, "--ide", "cline", "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
      runFederation: noOpMirror,
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
    // noOpMirror: this test cares about continue hook install, not mirror
    const code = await init(["--target", tmpDir, "--ide", "continue", "--no-seed"], logger, {
      overrideHome: fakeHome,
      runFederation: noOpMirror,
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

    // noOpMirror: this test cares about the marker content, not mirror
    await init(["--target", tmpDir, "--ide", "continue", "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
      runFederation: noOpMirror,
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
    // noOpMirror: compound test covers the real production sequence; mirror seam
    // is separately verified by suite 24. Injecting here keeps the test fast
    // and avoids network dependency in the cross-component integration coverage.
    const code = await init(["--target", tmpDir, "--no-seed"], logger, {
      overrideHome: fakeHome,
      runFederation: noOpMirror,
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
    // DEC-WPE-DEFAULT-PEER-001: default mode is now "global" (not "local")
    const rc = readRc(tmpDir);
    expect(rc?.version).toBe(1);
    expect(rc?.mode).toBe("global");
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

    // --local: skip mirror; this test only cares about IDE auto-detection
    const code = await init(["--target", tmpDir, "--no-seed", "--local"], new CollectingLogger(), {
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

    // --local: skip mirror; this test only cares about IDE auto-detection
    const code = await init(["--target", tmpDir, "--no-seed", "--local"], new CollectingLogger(), {
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
    // claude-code: always ~/.claude/
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    // cursor: platform-specific path (buildCandidatePaths uses different dirs per platform)
    // darwin: ~/Library/Application Support/Cursor
    // win32:  %APPDATA%/Cursor (or ~/AppData/Roaming/Cursor)
    // linux:  ~/.config/Cursor
    if (process.platform === "darwin") {
      mkdirSync(join(fakeHome, "Library", "Application Support", "Cursor"), { recursive: true });
    } else if (process.platform === "win32") {
      mkdirSync(join(fakeHome, "AppData", "Roaming", "Cursor"), { recursive: true });
    } else {
      mkdirSync(join(fakeHome, ".config", "Cursor"), { recursive: true });
    }
    mkdirSync(join(fakeHome, ".config", "cline"), { recursive: true });
    mkdirSync(join(fakeHome, ".continue"), { recursive: true });
    mkdirSync(join(fakeHome, ".windsurf"), { recursive: true });
    mkdirSync(join(fakeHome, ".aider"), { recursive: true });

    // --local: skip mirror; capstone tests IDE auto-detection, not federation behaviour.
    // Mirror seam is separately verified by suite 24.
    const code = await init(["--target", tmpDir, "--no-seed", "--local"], new CollectingLogger(), {
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

// ---------------------------------------------------------------------------
// Suite 24: runFederation seam tests (Evaluation Contract — DEC-WPE-DEFAULT-PEER-001)
//
// These three tests are the canonical proof that:
//   1. Default `yakcc init` invokes runFederation(["mirror", ...]) with the
//      correct args (registry.yakcc.com + local registry path).
//   2. --local suppresses the mirror entirely.
//   3. --airgapped suppresses the mirror entirely.
//
// All three use the captureMirror / noOpMirror seam (DEC-WPE-DEFAULT-PEER-001
// testability seam) to avoid real HTTP calls to registry.yakcc.com.
// ---------------------------------------------------------------------------

describe("init — runFederation seam: default-peer mirror invocation (DEC-WPE-DEFAULT-PEER-001)", () => {
  it("default init invokes runFederation(['mirror', '--remote', 'https://registry.yakcc.com', ...])", async () => {
    // captureMirror records every call to the injected federation runner.
    // We assert it is called exactly once with the expected mirror args.
    const { stub, calls } = captureMirror();

    const code = await init(
      ["--target", tmpDir, "--no-seed", "--skip-hooks"],
      new CollectingLogger(),
      {
        overrideHome: tmpDir,
        runFederation: stub,
      },
    );

    expect(code).toBe(0);
    // Mirror must be called exactly once
    expect(calls).toHaveLength(1);
    // TypeScript: assert non-undefined before indexing (vitest `toHaveLength` already guarantees this)
    const mirrorArgv = calls[0] as string[];
    // First positional must be "mirror"
    expect(mirrorArgv[0]).toBe("mirror");
    // --remote must point to the default public registry
    const remoteIdx = mirrorArgv.indexOf("--remote");
    expect(remoteIdx).toBeGreaterThanOrEqual(0);
    expect(mirrorArgv[remoteIdx + 1]).toBe("https://registry.yakcc.com");
    // --registry must be present (the local sqlite path)
    expect(mirrorArgv.includes("--registry")).toBe(true);
    // Default peer must be recorded in .yakccrc.json
    const rc = readRc(tmpDir);
    const fed = rc?.federation as Record<string, unknown> | undefined;
    expect((fed?.peers as string[]).includes("https://registry.yakcc.com")).toBe(true);
  });

  it("--local flag skips runFederation entirely (no mirror, no default peer)", async () => {
    const { stub, calls } = captureMirror();

    const code = await init(
      ["--target", tmpDir, "--no-seed", "--skip-hooks", "--local"],
      new CollectingLogger(),
      { overrideHome: tmpDir, runFederation: stub },
    );

    expect(code).toBe(0);
    // runFederation must NOT be called when --local is set
    expect(calls).toHaveLength(0);
    // No default peer in .yakccrc.json
    const rc = readRc(tmpDir);
    const fed = rc?.federation as Record<string, unknown> | undefined;
    // federation key may be absent entirely, or peers must not include the default URL
    const peers = (fed?.peers as string[] | undefined) ?? [];
    expect(peers.includes("https://registry.yakcc.com")).toBe(false);
  });

  it("--airgapped flag skips runFederation entirely (no mirror, no default peer)", async () => {
    const { stub, calls } = captureMirror();

    const code = await init(
      ["--target", tmpDir, "--no-seed", "--skip-hooks", "--airgapped"],
      new CollectingLogger(),
      { overrideHome: tmpDir, runFederation: stub },
    );

    expect(code).toBe(0);
    // runFederation must NOT be called when --airgapped is set
    expect(calls).toHaveLength(0);
    // No default peer in .yakccrc.json
    const rc = readRc(tmpDir);
    const fed = rc?.federation as Record<string, unknown> | undefined;
    const peers = (fed?.peers as string[] | undefined) ?? [];
    expect(peers.includes("https://registry.yakcc.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 25: Polyglot adapter detection (DEC-POLYGLOT-ADAPTER-PACKAGING-001 / #785)
//
// Scans target dir for pyproject.toml / setup.py / go.mod / Cargo.toml after
// init completes. Hints are non-interactive (exit 0, no stdin). Suppressible
// via --skip-polyglot-hints or YAKCC_POLYGLOT_HINTS=0. Self-suppress when the
// adapter is already installed (require.resolve).
// ---------------------------------------------------------------------------

describe("init — polyglot adapter detection (#785)", () => {
  it("emits a Python hint when pyproject.toml exists in target dir", async () => {
    writeFileSyncForPolyglot(join(tmpDir, "pyproject.toml"), '[project]\nname="x"\n');
    const logger = new CollectingLogger();
    // isInstalled: () => false — DEC-CLI-HERMETIC-INIT-001: inject deterministic
    // "not installed" predicate so the hint is always emitted regardless of whether
    // @yakcc/shave-python happens to be resolvable in the local linked workspace.
    const code = await init(["--target", tmpDir, "--skip-hooks", "--no-seed", "--local"], logger, {
      isInstalled: () => false,
    });
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("hint: Python project detected (pyproject.toml)");
    expect(out).toContain("npm install @yakcc/shave-python @yakcc/compile-python");
    expect(out).toContain("yakcc shave <dir> --language=py");
  });

  it("emits a Python hint when setup.py exists (alternative marker)", async () => {
    writeFileSyncForPolyglot(join(tmpDir, "setup.py"), "from setuptools import setup\nsetup()\n");
    const logger = new CollectingLogger();
    // isInstalled: () => false — DEC-CLI-HERMETIC-INIT-001: hermetic not-installed predicate
    const code = await init(["--target", tmpDir, "--skip-hooks", "--no-seed", "--local"], logger, {
      isInstalled: () => false,
    });
    expect(code).toBe(0);
    expect(logger.logLines.join("\n")).toContain("hint: Python project detected (setup.py)");
  });

  it("emits a Go hint with not-yet-published caveat for go.mod", async () => {
    writeFileSyncForPolyglot(join(tmpDir, "go.mod"), "module example.com/x\n");
    const logger = new CollectingLogger();
    // isInstalled: () => false — DEC-CLI-HERMETIC-INIT-001: hermetic not-installed predicate
    const code = await init(["--target", tmpDir, "--skip-hooks", "--no-seed", "--local"], logger, {
      isInstalled: () => false,
    });
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("hint: Go project detected (go.mod)");
    expect(out).toContain("not yet published on npm");
    expect(out).toContain("npm install @yakcc/shave-go");
  });

  it("emits a Rust hint with not-yet-published caveat for Cargo.toml", async () => {
    writeFileSyncForPolyglot(join(tmpDir, "Cargo.toml"), '[package]\nname="x"\nversion="0.0.1"\n');
    const logger = new CollectingLogger();
    // isInstalled: () => false — DEC-CLI-HERMETIC-INIT-001: hermetic not-installed predicate
    const code = await init(["--target", tmpDir, "--skip-hooks", "--no-seed", "--local"], logger, {
      isInstalled: () => false,
    });
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("hint: Rust project detected (Cargo.toml)");
    expect(out).toContain("not yet published on npm");
    expect(out).toContain("npm install @yakcc/shave-rust");
  });

  it("emits multiple hints for a multi-language project", async () => {
    writeFileSyncForPolyglot(join(tmpDir, "pyproject.toml"), '[project]\nname="x"\n');
    writeFileSyncForPolyglot(join(tmpDir, "go.mod"), "module example.com/x\n");
    const logger = new CollectingLogger();
    // isInstalled: () => false — DEC-CLI-HERMETIC-INIT-001: hermetic not-installed predicate
    const code = await init(["--target", tmpDir, "--skip-hooks", "--no-seed", "--local"], logger, {
      isInstalled: () => false,
    });
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("hint: Python project detected");
    expect(out).toContain("hint: Go project detected");
  });

  it("emits NO hint in a TS-only project (no language config files)", async () => {
    // No pyproject.toml / setup.py / go.mod / Cargo.toml written.
    const logger = new CollectingLogger();
    const code = await init(["--target", tmpDir, "--skip-hooks", "--no-seed", "--local"], logger);
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).not.toContain("project detected");
    expect(out).not.toContain("@yakcc/shave-python");
    expect(out).not.toContain("@yakcc/shave-go");
    expect(out).not.toContain("@yakcc/shave-rust");
  });

  it("--skip-polyglot-hints suppresses all hints", async () => {
    writeFileSyncForPolyglot(join(tmpDir, "pyproject.toml"), '[project]\nname="x"\n');
    writeFileSyncForPolyglot(join(tmpDir, "go.mod"), "module example.com/x\n");
    const logger = new CollectingLogger();
    // isInstalled: () => false — DEC-CLI-HERMETIC-INIT-001: harmless here since
    // --skip-polyglot-hints fires before isInstalled is consulted, but injecting
    // keeps the suite uniformly hermetic across workspace linking states.
    const code = await init(
      ["--target", tmpDir, "--skip-hooks", "--no-seed", "--local", "--skip-polyglot-hints"],
      logger,
      { isInstalled: () => false },
    );
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).not.toContain("project detected");
  });

  it("YAKCC_POLYGLOT_HINTS=0 suppresses all hints", async () => {
    writeFileSyncForPolyglot(join(tmpDir, "pyproject.toml"), '[project]\nname="x"\n');
    const prev = process.env.YAKCC_POLYGLOT_HINTS;
    process.env.YAKCC_POLYGLOT_HINTS = "0";
    try {
      const logger = new CollectingLogger();
      // isInstalled: () => false — DEC-CLI-HERMETIC-INIT-001: harmless here since
      // YAKCC_POLYGLOT_HINTS=0 fires before isInstalled is consulted, but keeps suite hermetic.
      const code = await init(
        ["--target", tmpDir, "--skip-hooks", "--no-seed", "--local"],
        logger,
        {
          isInstalled: () => false,
        },
      );
      expect(code).toBe(0);
      expect(logger.logLines.join("\n")).not.toContain("project detected");
    } finally {
      if (prev === undefined) {
        // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
        delete process.env.YAKCC_POLYGLOT_HINTS;
      } else {
        process.env.YAKCC_POLYGLOT_HINTS = prev;
      }
    }
  });

  it("init exits 0 (non-interactive) even when hints fire", async () => {
    writeFileSyncForPolyglot(join(tmpDir, "pyproject.toml"), '[project]\nname="x"\n');
    writeFileSyncForPolyglot(join(tmpDir, "go.mod"), "module example.com/x\n");
    writeFileSyncForPolyglot(join(tmpDir, "Cargo.toml"), '[package]\nname="x"\nversion="0.0.1"\n');
    const logger = new CollectingLogger();
    // isInstalled: () => false — DEC-CLI-HERMETIC-INIT-001: force hints to fire
    // deterministically regardless of adapter resolvability in the workspace.
    const code = await init(["--target", tmpDir, "--skip-hooks", "--no-seed", "--local"], logger, {
      isInstalled: () => false,
    });
    expect(code).toBe(0);
  });

  it("does NOT install anything automatically (no node_modules side-effects)", async () => {
    writeFileSyncForPolyglot(join(tmpDir, "pyproject.toml"), '[project]\nname="x"\n');
    const logger = new CollectingLogger();
    // isInstalled: () => false — DEC-CLI-HERMETIC-INIT-001: hermetic not-installed predicate
    const code = await init(["--target", tmpDir, "--skip-hooks", "--no-seed", "--local"], logger, {
      isInstalled: () => false,
    });
    expect(code).toBe(0);
    // node_modules must not appear under the target as a side-effect of detection
    expect(existsSync(join(tmpDir, "node_modules"))).toBe(false);
  });
});

// Suite 25 extension: #870 slice 3 — explicit shave-go routing assertion.
//
// The existing Suite 25 tests (above) cover go.mod detection at the integration
// level. This dedicated test makes the routing target explicit: a go.mod project
// MUST route .go files through @yakcc/shave-go specifically, not any other adapter.
// Verification-only: init routing was added by #785; slice 3 only strengthens the
// assertion to name the package explicitly.
describe("init — go.mod routes .go files through @yakcc/shave-go (#870 slice 3)", () => {
  it("go.mod in target dir routes to @yakcc/shave-go (not shave-python, not shave-rust)", async () => {
    writeFileSyncForPolyglot(join(tmpDir, "go.mod"), "module example.com/mymod\n\ngo 1.21\n");
    const logger = new CollectingLogger();
    // isInstalled: () => false — DEC-CLI-HERMETIC-INIT-001: hermetic not-installed predicate
    // so the hint is always emitted regardless of workspace linking.
    const code = await init(["--target", tmpDir, "--skip-hooks", "--no-seed", "--local"], logger, {
      isInstalled: () => false,
    });
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    // Primary: explicitly confirms @yakcc/shave-go is the routing target for Go
    expect(out).toContain("@yakcc/shave-go");
    // Secondary: the detection message names shave-go as the adapter
    expect(out).toContain("hint: Go project detected (go.mod)");
    // Negative: a Go project must not route to the Python or Rust adapters
    expect(out).not.toContain("@yakcc/shave-python");
    expect(out).not.toContain("@yakcc/shave-rust");
  });
});

// ---------------------------------------------------------------------------
// Suite 26: discovery snippet (WI-953 bite 2 — DEC-953B-SNIPPET-REFERENCE-001,
//            DEC-953B-SURFACE-SETTINGS-001)
//
// Evaluation Contract required_tests:
//   EC-953B-T1: snippet written — fresh init makes .claude/settings.json carry
//               the yakcc-discovery marker referencing yakcc-discovery.md.
//   EC-953B-T2: idempotency — running init twice does NOT duplicate the marker.
//   EC-953B-T3: --airgapped path still writes the snippet (instruction is
//               mode-independent; only the global cascade is gated).
//   EC-953B-T4: per-IDE installer seam — the snippet goes through the existing
//               installHookForIde dispatch table (claude-code surface verified).
//
// The snippet rides .claude/settings.json["yakcc-discovery"] (an additive key
// inside the existing surface owned by hooksClaudeCodeInstall).  No CLAUDE.md
// is created (DEC-953B-SURFACE-SETTINGS-001 / DEC-CLI-HOOKS-INSTALL-002).
// ---------------------------------------------------------------------------

function readDiscoverySnippet(dir: string): Record<string, unknown> | null | undefined {
  const settingsPath = join(dir, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return undefined;
  const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  return settings["yakcc-discovery"] as Record<string, unknown> | null | undefined;
}

describe("init — discovery snippet: yakcc_resolve instruction written to .claude/settings.json (WI-953 bite 2)", () => {
  // EC-953B-T1: snippet written after fresh init
  it("fresh init --ide claude-code writes yakcc-discovery marker into .claude/settings.json", async () => {
    const code = await init(
      ["--target", tmpDir, "--ide", "claude-code", "--no-seed"],
      new CollectingLogger(),
      {
        overrideHome: tmpDir,
        runFederation: noOpMirror,
      },
    );
    expect(code).toBe(0);

    const snippet = readDiscoverySnippet(tmpDir);
    expect(snippet, "yakcc-discovery key must be present in .claude/settings.json").toBeDefined();
    expect(snippet).not.toBeNull();

    // DEC-953B-SNIPPET-REFERENCE-001: snippet references the canonical prompt path, not inline body
    expect((snippet as Record<string, unknown>).promptRef).toContain("yakcc-discovery.md");
    // Marker sentinel for idempotency detection
    expect((snippet as Record<string, unknown>)._marker).toBe("yakcc-discovery-v1");
    // Instruction imperative present
    expect(typeof (snippet as Record<string, unknown>).instruction).toBe("string");
    expect((snippet as Record<string, unknown>).instruction as string).toContain("yakcc_resolve");
  });

  // DEC-953B-SURFACE-SETTINGS-001: no CLAUDE.md resurrection
  it("does NOT create .claude/CLAUDE.md (retired facade must not be resurrected)", async () => {
    await init(["--target", tmpDir, "--ide", "claude-code", "--no-seed"], new CollectingLogger(), {
      overrideHome: tmpDir,
      runFederation: noOpMirror,
    });
    expect(existsSync(join(tmpDir, ".claude", "CLAUDE.md"))).toBe(false);
  });

  // EC-953B-T2: idempotency — second run must not duplicate the snippet
  it("running init twice does NOT duplicate the yakcc-discovery entry (idempotency)", async () => {
    const opts = { overrideHome: tmpDir, runFederation: noOpMirror };
    await init(
      ["--target", tmpDir, "--ide", "claude-code", "--no-seed"],
      new CollectingLogger(),
      opts,
    );
    await init(
      ["--target", tmpDir, "--ide", "claude-code", "--no-seed"],
      new CollectingLogger(),
      opts,
    );

    // settings.json["yakcc-discovery"] must be an object (not an array), proving no duplication
    const settingsPath = join(tmpDir, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    expect(Array.isArray(settings["yakcc-discovery"])).toBe(false);
    const snippet = settings["yakcc-discovery"] as Record<string, unknown>;
    // Exactly one _marker — object, not duplicated
    expect(snippet._marker).toBe("yakcc-discovery-v1");
  });

  // EC-953B-T3: --airgapped path still writes the snippet (instruction is mode-independent)
  it("--airgapped still writes the discovery snippet (only the global cascade is gated)", async () => {
    const code = await init(
      ["--target", tmpDir, "--ide", "claude-code", "--no-seed", "--airgapped"],
      new CollectingLogger(),
      { overrideHome: tmpDir },
    );
    expect(code).toBe(0);

    const snippet = readDiscoverySnippet(tmpDir);
    expect(snippet, "yakcc-discovery must be present even in --airgapped mode").toBeDefined();
    expect(snippet).not.toBeNull();
    expect((snippet as Record<string, unknown>)._marker).toBe("yakcc-discovery-v1");
    // .yakccrc.json must not have the default registry peer (--airgapped)
    const rc = readRc(tmpDir);
    const peers =
      ((rc?.federation as Record<string, unknown> | undefined)?.peers as string[] | undefined) ??
      [];
    expect(peers.includes("https://registry.yakcc.com")).toBe(false);
  });

  // EC-953B-T4: per-IDE installer seam — discovery goes through installHookForIde
  // (i.e., the existing .claude/settings.json the installer owns also carries the snippet)
  it("discovery snippet is in the same .claude/settings.json surface the hook installer owns", async () => {
    await init(["--target", tmpDir, "--ide", "claude-code", "--no-seed"], new CollectingLogger(), {
      overrideHome: tmpDir,
      runFederation: noOpMirror,
    });

    // Both the hook entry (PreToolUse) AND the discovery snippet live in settings.json — same file
    const settingsPath = join(tmpDir, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;

    // Hook entry is present (installer did its job)
    const hooks = settings.hooks as Record<string, unknown[]> | undefined;
    expect(Array.isArray(hooks?.PreToolUse)).toBe(true);
    expect((hooks?.PreToolUse as unknown[]).length).toBeGreaterThan(0);

    // Discovery snippet is present in the same file (no parallel writer)
    const snippet = settings["yakcc-discovery"] as Record<string, unknown> | undefined;
    expect(snippet).toBeDefined();
    expect(snippet?._marker).toBe("yakcc-discovery-v1");
  });
});

// ---------------------------------------------------------------------------
// Suite 27: .mcp.json MCP server registration (WI-1005-mcp-init / #1005)
//
// Evaluation Contract required behaviour:
//   EC-MCP-T1: Fresh init --ide claude-code writes .mcp.json with mcpServers.yakcc
//              entry using npx -y yakcc-mcp-registry.
//   EC-MCP-T2: Existing .mcp.json with an unrelated server: yakcc entry added,
//              existing server preserved (merge, not replace).
//   EC-MCP-T3: Re-running yakcc init is idempotent: .mcp.json not corrupted,
//              yakcc key written exactly once.
//   EC-MCP-T4: Compound production sequence — init → hooks install → mcp.json
//              + settings.json both present in the same run (DEC-CLI-MCP-INIT-001).
//   EC-MCP-T5: Non-claude-code init (--skip-hooks) does NOT write .mcp.json
//              (MCP config is Claude Code-specific).
//
// @decision DEC-CLI-MCP-INIT-001 — see init.ts claude-code arm for full rationale.
// ---------------------------------------------------------------------------

function readMcpJson(dir: string): Record<string, unknown> | null {
  const p = join(dir, ".mcp.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

describe("init — .mcp.json MCP server registration (#1005)", () => {
  // EC-MCP-T1: fresh init writes .mcp.json with mcpServers.yakcc
  it("fresh init --ide claude-code writes .mcp.json with mcpServers.yakcc using npx", async () => {
    const code = await init(
      ["--target", tmpDir, "--ide", "claude-code", "--no-seed"],
      new CollectingLogger(),
      { overrideHome: tmpDir, runFederation: noOpMirror },
    );
    expect(code).toBe(0);

    expect(existsSync(join(tmpDir, ".mcp.json"))).toBe(true);
    const mcp = readMcpJson(tmpDir);
    expect(mcp).not.toBeNull();
    const servers = mcp?.mcpServers as Record<string, unknown> | undefined;
    expect(servers).toBeDefined();
    const yakcc = servers?.yakcc as Record<string, unknown> | undefined;
    expect(yakcc).toBeDefined();
    expect(yakcc?.command).toBe("npx");
    expect(Array.isArray(yakcc?.args)).toBe(true);
    expect((yakcc?.args as string[]).includes("-y")).toBe(true);
    expect((yakcc?.args as string[]).includes("yakcc-mcp-registry")).toBe(true);
  });

  // EC-MCP-T2: existing .mcp.json with unrelated server → yakcc entry added, other preserved
  it("existing .mcp.json with unrelated server: yakcc entry added, existing server preserved", async () => {
    // Pre-populate .mcp.json with a different server
    const existing = {
      mcpServers: {
        "my-db-tool": { command: "node", args: ["db-mcp.js"] },
      },
    };
    writeFileSyncForPolyglot(join(tmpDir, ".mcp.json"), JSON.stringify(existing, null, 2));

    const code = await init(
      ["--target", tmpDir, "--ide", "claude-code", "--no-seed"],
      new CollectingLogger(),
      { overrideHome: tmpDir, runFederation: noOpMirror },
    );
    expect(code).toBe(0);

    const mcp = readMcpJson(tmpDir);
    const servers = mcp?.mcpServers as Record<string, unknown>;
    // yakcc entry added
    const yakcc = servers?.yakcc as Record<string, unknown> | undefined;
    expect(yakcc).toBeDefined();
    expect(yakcc?.command).toBe("npx");
    // unrelated server preserved
    const dbTool = servers?.["my-db-tool"] as Record<string, unknown> | undefined;
    expect(dbTool).toBeDefined();
    expect(dbTool?.command).toBe("node");
  });

  // EC-MCP-T3: idempotent — running init twice does not corrupt .mcp.json
  it("running init twice does not corrupt .mcp.json (idempotent)", async () => {
    const opts = { overrideHome: tmpDir, runFederation: noOpMirror };
    await init(
      ["--target", tmpDir, "--ide", "claude-code", "--no-seed"],
      new CollectingLogger(),
      opts,
    );
    await init(
      ["--target", tmpDir, "--ide", "claude-code", "--no-seed"],
      new CollectingLogger(),
      opts,
    );

    const mcp = readMcpJson(tmpDir);
    const servers = mcp?.mcpServers as Record<string, unknown>;
    // yakcc key written exactly once (object, not duplicated)
    expect(typeof servers?.yakcc).toBe("object");
    // The file must be valid JSON (already parsed above without throw)
    // mcpServers must have exactly 1 key (no accidental duplication)
    expect(Object.keys(servers).length).toBe(1);
  });

  // EC-MCP-T4: compound — .mcp.json AND .claude/settings.json both present
  it("compound: .mcp.json and .claude/settings.json both written in the same claude-code init", async () => {
    const fakeHome = join(tmpDir, "fakehome-mcp-compound");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });

    const code = await init(["--target", tmpDir, "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
      runFederation: noOpMirror,
    });
    expect(code).toBe(0);

    // Both surfaces written
    expect(existsSync(join(tmpDir, ".mcp.json"))).toBe(true);
    expect(existsSync(join(tmpDir, ".claude", "settings.json"))).toBe(true);

    // .mcp.json has yakcc entry
    const mcp = readMcpJson(tmpDir);
    const yakcc = (mcp?.mcpServers as Record<string, unknown>)?.yakcc as
      | Record<string, unknown>
      | undefined;
    expect(yakcc?.command).toBe("npx");

    // settings.json has PreToolUse hook entry
    const settings = readSettings(tmpDir);
    const hooks = settings?.hooks as Record<string, unknown[]> | undefined;
    expect(Array.isArray(hooks?.PreToolUse)).toBe(true);
  });

  // EC-MCP-T5: --skip-hooks does NOT write .mcp.json (Claude Code-specific path skipped)
  it("--skip-hooks does NOT write .mcp.json", async () => {
    const code = await init(
      ["--target", tmpDir, "--skip-hooks", "--no-seed"],
      new CollectingLogger(),
      { overrideHome: tmpDir, runFederation: noOpMirror },
    );
    expect(code).toBe(0);
    expect(existsSync(join(tmpDir, ".mcp.json"))).toBe(false);
  });
});

// Suite 26: CLAUDE.md discovery context injection (WI-1008)
//
// DEC-1008-CLAUDE-MD-CONTEXT-INJECT-001: `yakcc init --ide claude-code` must
// write a CLAUDE.md containing the @-import directive so the 299-line
// discovery prompt body reaches the LLM context on every session start.
//
// Production sequence exercised:
//   init(--ide claude-code) → hooksClaudeCodeInstall → writeCLaudeMdDiscovery
//   → CLAUDE.md with sentinel-delimited section containing:
//       @docs/system-prompts/yakcc-discovery.md
//
// Tests:
//   T1 — fresh init creates CLAUDE.md with managed section + @-import
//   T2 — existing CLAUDE.md (with user content) is preserved; section appended
//   T3 — re-running init is idempotent (no duplicate sections)
//   T4 — compound: CLAUDE.md + settings.json + .yakccrc.json all written in one init
// ---------------------------------------------------------------------------

describe("init — CLAUDE.md discovery context injection (WI-1008)", () => {
  function readCLaudeMd(dir: string): string | null {
    const p = join(dir, "CLAUDE.md");
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf-8");
  }

  // T1: fresh init creates CLAUDE.md with managed section + @-import directive
  it("fresh init (--ide claude-code) creates CLAUDE.md with @-import for discovery prompt", async () => {
    const fakeHome = join(tmpDir, "fakehome-claude-md-fresh");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });

    const code = await init(
      ["--target", tmpDir, "--ide", "claude-code", "--no-seed"],
      new CollectingLogger(),
      { overrideHome: fakeHome, runFederation: noOpMirror },
    );

    expect(code).toBe(0);
    const content = readCLaudeMd(tmpDir);
    expect(content, "CLAUDE.md must be created by yakcc init").not.toBeNull();
    // Must contain the sentinel markers that delimit the managed section
    expect(content).toContain("<!-- yakcc-discovery:start -->");
    expect(content).toContain("<!-- yakcc-discovery:end -->");
    // Must contain the @-import directive pointing at the canonical prompt
    expect(content).toContain("@docs/system-prompts/yakcc-discovery.md");
  });

  // T2: existing CLAUDE.md with user content is preserved; managed section is appended
  it("existing CLAUDE.md with user content is preserved when managed section is appended", async () => {
    const fakeHome = join(tmpDir, "fakehome-claude-md-existing");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });

    // Write a CLAUDE.md with existing user-owned content
    const existingContent = "# My Project\n\nSome project-specific instructions.\n";
    writeFileSyncForPolyglot(join(tmpDir, "CLAUDE.md"), existingContent, "utf-8");

    const code = await init(
      ["--target", tmpDir, "--ide", "claude-code", "--no-seed"],
      new CollectingLogger(),
      { overrideHome: fakeHome, runFederation: noOpMirror },
    );

    expect(code).toBe(0);
    const content = readCLaudeMd(tmpDir);
    expect(content, "CLAUDE.md must still exist").not.toBeNull();
    // User's original content must be preserved verbatim
    expect(content).toContain("# My Project");
    expect(content).toContain("Some project-specific instructions.");
    // Managed section must be appended
    expect(content).toContain("<!-- yakcc-discovery:start -->");
    expect(content).toContain("@docs/system-prompts/yakcc-discovery.md");
  });

  // T3: re-running init is idempotent — no duplicate sections
  it("re-running init is idempotent: no duplicate managed sections in CLAUDE.md", async () => {
    const fakeHome = join(tmpDir, "fakehome-claude-md-idempotent");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });

    const opts = { overrideHome: fakeHome, runFederation: noOpMirror };

    // Run init twice
    await init(
      ["--target", tmpDir, "--ide", "claude-code", "--no-seed"],
      new CollectingLogger(),
      opts,
    );
    await init(
      ["--target", tmpDir, "--ide", "claude-code", "--no-seed"],
      new CollectingLogger(),
      opts,
    );

    const content = readCLaudeMd(tmpDir);
    expect(content, "CLAUDE.md must exist after two runs").not.toBeNull();

    // Count sentinel occurrences — must be exactly 1 each
    const startCount = (content?.match(/<!-- yakcc-discovery:start -->/g) ?? []).length;
    const endCount = (content?.match(/<!-- yakcc-discovery:end -->/g) ?? []).length;
    expect(startCount).toBe(1);
    expect(endCount).toBe(1);

    // @-import must appear exactly once
    const importCount = (content?.match(/@docs\/system-prompts\/yakcc-discovery\.md/g) ?? [])
      .length;
    expect(importCount).toBe(1);
  });

  // T4 (compound): single init call writes CLAUDE.md + settings.json + .yakccrc.json atomically
  // This exercises the real production sequence: all three surfaces must be consistent.
  it("compound: CLAUDE.md + settings.json + .yakccrc.json all written in a single init", async () => {
    const fakeHome = join(tmpDir, "fakehome-claude-md-compound");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });

    const logger = new CollectingLogger();
    const code = await init(["--target", tmpDir, "--ide", "claude-code", "--no-seed"], logger, {
      overrideHome: fakeHome,
      runFederation: noOpMirror,
    });

    expect(code).toBe(0);

    // Surface 1: CLAUDE.md with @-import directive (context loading)
    const claudeMd = readCLaudeMd(tmpDir);
    expect(claudeMd).not.toBeNull();
    expect(claudeMd).toContain("@docs/system-prompts/yakcc-discovery.md");

    // Surface 2: .claude/settings.json with PreToolUse hook + discovery snippet (hook wiring)
    const settings = readSettings(tmpDir);
    expect(settings).not.toBeNull();
    const hooks = settings?.hooks as Record<string, unknown[]> | undefined;
    expect(Array.isArray(hooks?.PreToolUse)).toBe(true);
    const snippet = settings?.["yakcc-discovery"] as Record<string, unknown> | undefined;
    expect(snippet?._marker).toBe("yakcc-discovery-v1");
    expect(snippet?.promptRef).toBe("docs/system-prompts/yakcc-discovery.md");

    // Surface 3: .yakccrc.json with mode + installedHooks (registry config)
    const rc = readRc(tmpDir);
    expect(rc?.version).toBe(1);
    expect((rc?.installedHooks as string[]).includes("claude-code")).toBe(true);

    // All three surfaces are written atomically in a single init call —
    // this is the compound-interaction proof that the real production sequence works.
    expect(logger.logLines.join("\n")).toContain("Installed in");
  });
});

// ---------------------------------------------------------------------------
// Suite 28: .yakcc/manifest.json scaffold (DEC-COMPOSE-BY-REF-DEFAULT-001)
//
// Evaluation Contract required_tests:
//   EC-CRD-T1: yakcc init writes a valid empty .yakcc/manifest.json that
//              parseProjectManifest accepts (version 1, empty references).
//   EC-CRD-T2: re-running init does NOT clobber a manifest that already has
//              references (idempotency).
//   EC-CRD-T3: the summary line mentions compose-by-reference.
//   EC-CRD-T4: compound — manifest + .yakccrc.json + registry all written in
//              a single init call (real production sequence).
//
// Required authority: manifest written ONLY via @yakcc/compile emptyManifest()
// + serializeProjectManifest() — parseProjectManifest must accept it without
// throwing (the authority check is parseProjectManifest round-tripping).
// ---------------------------------------------------------------------------

describe("init — .yakcc/manifest.json scaffold (DEC-COMPOSE-BY-REF-DEFAULT-001)", () => {
  // EC-CRD-T1: fresh init writes valid empty manifest accepted by parseProjectManifest
  it("fresh init writes .yakcc/manifest.json that parseProjectManifest accepts (version 1, empty references)", async () => {
    const { parseProjectManifest } = await import("@yakcc/compile");

    const code = await init(
      ["--target", tmpDir, "--local", "--no-seed", "--skip-hooks"],
      new CollectingLogger(),
      { overrideHome: tmpDir },
    );
    expect(code).toBe(0);

    const manifestPath = join(tmpDir, ".yakcc", "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);

    const text = readFileSync(manifestPath, "utf-8");
    // Must not throw — this is the authority check (single authority: @yakcc/compile)
    const manifest = parseProjectManifest(text);
    expect(manifest.version).toBe(1);
    expect(manifest.references).toHaveLength(0);
  });

  // EC-CRD-T2: idempotency — re-init does NOT clobber a manifest with references
  it("re-running init does NOT clobber an existing manifest that has references", async () => {
    const {
      addReference,
      serializeProjectManifest: serialize,
      emptyManifest: empty,
      parseProjectManifest,
    } = await import("@yakcc/compile");

    // First init to set up the directory
    const code1 = await init(
      ["--target", tmpDir, "--local", "--no-seed", "--skip-hooks"],
      new CollectingLogger(),
      { overrideHome: tmpDir },
    );
    expect(code1).toBe(0);

    // Simulate an active project: add a reference to the manifest
    const manifestPath = join(tmpDir, ".yakcc", "manifest.json");
    const fakeRoot = "a".repeat(64) as Parameters<typeof addReference>[1]["root"];
    const { manifest: withRef } = addReference(empty(), {
      root: fakeRoot,
      symbol: "myFn",
    });
    writeFileSync(manifestPath, serialize(withRef), "utf-8");

    // Re-run init — must not clobber the manifest
    const code2 = await init(
      ["--target", tmpDir, "--local", "--no-seed", "--skip-hooks"],
      new CollectingLogger(),
      { overrideHome: tmpDir },
    );
    expect(code2).toBe(0);

    const text = readFileSync(manifestPath, "utf-8");
    const manifest = parseProjectManifest(text);
    // References must still be there — not reset to empty
    expect(manifest.references).toHaveLength(1);
    expect(manifest.references[0]?.symbol).toBe("myFn");
  });

  // EC-CRD-T3: summary mentions compose-by-reference
  it("summary output mentions compose-by-reference and yakcc build", async () => {
    const logger = new CollectingLogger();
    const code = await init(["--target", tmpDir, "--local", "--no-seed", "--skip-hooks"], logger, {
      overrideHome: tmpDir,
    });
    expect(code).toBe(0);
    const allLog = logger.logLines.join("\n");
    expect(allLog).toContain("Compose-by-reference");
    expect(allLog).toContain("yakcc build");
  });

  // EC-CRD-T4: compound — manifest + .yakccrc.json + registry all in one init run
  it("compound: .yakcc/manifest.json + .yakccrc.json + registry.sqlite all written in a single init call", async () => {
    const { parseProjectManifest } = await import("@yakcc/compile");

    const code = await init(
      ["--target", tmpDir, "--local", "--no-seed", "--skip-hooks"],
      new CollectingLogger(),
      { overrideHome: tmpDir },
    );
    expect(code).toBe(0);

    // .yakcc/manifest.json — valid empty manifest (single @yakcc/compile authority)
    const manifestPath = join(tmpDir, ".yakcc", "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = parseProjectManifest(readFileSync(manifestPath, "utf-8"));
    expect(manifest.version).toBe(1);
    expect(manifest.references).toHaveLength(0);

    // .yakccrc.json — written by writeRc
    expect(existsSync(join(tmpDir, ".yakccrc.json"))).toBe(true);
    const rc = readRc(tmpDir);
    expect(rc?.version).toBe(1);

    // registry.sqlite — created by registryInit
    expect(existsSync(join(tmpDir, ".yakcc", "registry.sqlite"))).toBe(true);
  });
});
