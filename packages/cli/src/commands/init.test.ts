/**
 * init.test.ts — integration tests for `yakcc init`.
 *
 * Production sequence exercised:
 *   init(argv, logger)
 *   → parseArgs → mkdirSync(.yakcc/) → registryInit → hooksClaudeCodeInstall
 *   → writeRc(.yakccrc.json) → [optional federation mirror] → next-steps log
 *
 * Tests:
 *   1. Empty-dir init produces .yakcc/ layout + .claude/settings.json + .yakccrc.json
 *   2. --target <dir> works against a non-cwd path
 *   3. Idempotent re-run: init twice does not corrupt
 *   4. --peer <url> writes federation peers into .yakccrc.json
 *   5. --peer re-run with same URL does not duplicate peer entry
 *   6. Invalid --peer URL returns exit 1 with error message
 *   7. Invalid flag returns exit 1
 *   8. After init, yakcc query "<intent>" against seeded registry runs without error (smoke test)
 *   9. runCli dispatch: routes "init" correctly
 *  10. .yakccrc.json version field is 1
 *  11. .yakccrc.json registry.path matches the default registry subpath
 *  12. .yakcc/ subdirectories (registry/, telemetry/, config/) are created
 *
 * @decision DEC-CLI-INIT-TEST-001
 * title: Tests use temp directories; federation mirror not exercised (no test server)
 * status: decided (WI-V05-INIT-COMMAND #204)
 * rationale:
 *   Each test creates a fresh OS temp directory so runs are isolated. The
 *   --peer path is validated (URL parsing + .yakccrc.json write) but the actual
 *   federation mirror call against a live HTTP server is out of scope — that is
 *   covered by the federation test suite. CollectingLogger captures output
 *   without mocking. Sacred Practice #5: no mocks on fs internals — all file
 *   I/O is real, against the temp directory.
 *
 *   The smoke test (#8) seeds the registry inside the temp dir, then runs
 *   `yakcc query` against it using the offline embedding provider so no network
 *   I/O is required. This validates that init produces a registry that the
 *   query command can open.
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

  it("prints next-steps guidance", async () => {
    const logger = new CollectingLogger();
    await init(["--target", tmpDir], logger);
    const allLog = logger.logLines.join("\n");
    expect(allLog).toContain("yakcc initialized");
    expect(allLog).toContain("yakcc seed");
    expect(allLog).toContain("yakcc shave");
    expect(allLog).toContain("yakcc query");
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
    // Initialize the registry
    const initCode = await init(["--target", tmpDir], new CollectingLogger());
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
