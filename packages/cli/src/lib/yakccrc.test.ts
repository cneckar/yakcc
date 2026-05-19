/**
 * yakccrc.test.ts - unit tests for the yakccrc.ts single-source-of-truth module.
 *
 * Production sequence exercised:
 *   readRc(dir) -> null on absent/corrupt file
 *   writeRc(dir, rc) -> writes .yakccrc.json
 *   addInstalledHook(dir, ide) -> creates/merges .yakccrc.json.installedHooks
 *   removeInstalledHook(dir, ide) -> filters .yakccrc.json.installedHooks
 *
 * Sacred Practice #5: no mocks -- all tests use real tmpdirs via mkdtempSync.
 *
 * @decision DEC-CLI-YAKCCRC-AUTHORITY-001 -- canonical unit test suite for the
 *   single-authority module. All 4 corners: absent/corrupt/minimal/full rc.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RC_FILENAME, addInstalledHook, readRc, removeInstalledHook, writeRc } from "./yakccrc.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-yakccrc-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function rcPath(): string {
  return join(tmpDir, RC_FILENAME);
}

function readRcFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(rcPath(), "utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// readRc
// ---------------------------------------------------------------------------

describe("readRc - absent file", () => {
  it("returns null when .yakccrc.json does not exist", () => {
    expect(readRc(tmpDir)).toBeNull();
  });
});

describe("readRc - corrupt file", () => {
  it("returns null when .yakccrc.json contains invalid JSON", () => {
    writeFileSync(rcPath(), "{ this is not json }", "utf-8");
    expect(readRc(tmpDir)).toBeNull();
  });

  it("returns null when .yakccrc.json is empty", () => {
    writeFileSync(rcPath(), "", "utf-8");
    expect(readRc(tmpDir)).toBeNull();
  });
});

describe("readRc - valid file", () => {
  it("returns the parsed rc when file is valid JSON", () => {
    const rc = { version: 1, installedHooks: ["claude-code"] };
    writeFileSync(rcPath(), JSON.stringify(rc), "utf-8");
    const result = readRc(tmpDir);
    expect(result).not.toBeNull();
    expect(result?.version).toBe(1);
    expect(result?.installedHooks).toEqual(["claude-code"]);
  });

  it("preserves unknown fields verbatim", () => {
    const rc = {
      version: 1,
      mode: "local",
      registry: { path: ".yakcc/r.sqlite" },
      installedHooks: [],
    };
    writeFileSync(rcPath(), JSON.stringify(rc), "utf-8");
    const result = readRc(tmpDir);
    expect(result?.mode).toBe("local");
    expect((result?.registry as Record<string, unknown>)?.path).toBe(".yakcc/r.sqlite");
  });
});

// ---------------------------------------------------------------------------
// writeRc
// ---------------------------------------------------------------------------

describe("writeRc", () => {
  it("writes .yakccrc.json as pretty-printed JSON with trailing newline", () => {
    const rc = { version: 1 as const, installedHooks: ["cursor"] };
    writeRc(tmpDir, rc);
    expect(existsSync(rcPath())).toBe(true);
    const contents = readFileSync(rcPath(), "utf-8");
    expect(contents.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(contents) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
    expect(parsed.installedHooks).toEqual(["cursor"]);
  });

  it("round-trips: writeRc then readRc returns the same object", () => {
    const rc = { version: 1 as const, mode: "global", installedHooks: ["cline", "aider"] };
    writeRc(tmpDir, rc);
    const result = readRc(tmpDir);
    expect(result?.installedHooks).toEqual(["cline", "aider"]);
    expect(result?.mode).toBe("global");
  });
});

// ---------------------------------------------------------------------------
// addInstalledHook - absent rc (DEC-CLI-YAKCCRC-CREATE-ON-INSTALL-001)
// ---------------------------------------------------------------------------

describe("addInstalledHook - absent rc", () => {
  it("creates a minimal rc with version:1 and installedHooks:[ide]", () => {
    addInstalledHook(tmpDir, "claude-code");
    expect(existsSync(rcPath())).toBe(true);
    const rc = readRcFile();
    expect(rc.version).toBe(1);
    expect(rc.installedHooks).toEqual(["claude-code"]);
  });

  it("only adds version + installedHooks fields when file was absent", () => {
    addInstalledHook(tmpDir, "cursor");
    const rc = readRcFile();
    const keys = Object.keys(rc).sort();
    expect(keys).toEqual(["installedHooks", "version"]);
  });
});

// ---------------------------------------------------------------------------
// addInstalledHook - corrupt rc (DEC-CLI-YAKCCRC-PARSEFAIL-PASSTHROUGH-001)
// ---------------------------------------------------------------------------

describe("addInstalledHook - corrupt rc", () => {
  it("treats corrupt JSON as absent and creates a fresh minimal rc", () => {
    writeFileSync(rcPath(), "not valid json!!!", "utf-8");
    addInstalledHook(tmpDir, "windsurf");
    const rc = readRcFile();
    expect(rc.version).toBe(1);
    expect(rc.installedHooks).toEqual(["windsurf"]);
  });
});

// ---------------------------------------------------------------------------
// addInstalledHook - existing rc
// ---------------------------------------------------------------------------

describe("addInstalledHook - existing rc", () => {
  it("appends ide to installedHooks on existing rc", () => {
    writeFileSync(rcPath(), JSON.stringify({ version: 1, installedHooks: ["cursor"] }), "utf-8");
    addInstalledHook(tmpDir, "claude-code");
    const rc = readRcFile();
    const hooks = rc.installedHooks as string[];
    expect(hooks).toContain("cursor");
    expect(hooks).toContain("claude-code");
    expect(hooks.length).toBe(2);
  });

  it("deduplicates: adding an already-present ide does not duplicate", () => {
    writeFileSync(
      rcPath(),
      JSON.stringify({ version: 1, installedHooks: ["claude-code"] }),
      "utf-8",
    );
    addInstalledHook(tmpDir, "claude-code");
    const rc = readRcFile();
    const hooks = rc.installedHooks as string[];
    expect(hooks.filter((h) => h === "claude-code").length).toBe(1);
  });

  it("preserves all other rc fields verbatim (EC-S2-I3)", () => {
    const seed = {
      version: 1,
      mode: "local",
      registry: { path: ".yakcc/registry.sqlite" },
      federation: { peers: ["https://example.org"] },
      installedHooks: [],
    };
    writeFileSync(rcPath(), JSON.stringify(seed), "utf-8");
    addInstalledHook(tmpDir, "aider");
    const rc = readRcFile();
    expect(rc.mode).toBe("local");
    expect((rc.registry as Record<string, unknown>).path).toBe(".yakcc/registry.sqlite");
    expect((rc.federation as Record<string, unknown[]>).peers).toEqual(["https://example.org"]);
    expect(rc.version).toBe(1);
    expect(rc.installedHooks).toEqual(["aider"]);
  });
});

// ---------------------------------------------------------------------------
// removeInstalledHook - absent rc
// ---------------------------------------------------------------------------

describe("removeInstalledHook - absent rc", () => {
  it("no-ops and does NOT create the file when rc is absent", () => {
    removeInstalledHook(tmpDir, "claude-code");
    expect(existsSync(rcPath())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// removeInstalledHook - ide not present
// ---------------------------------------------------------------------------

describe("removeInstalledHook - ide not present", () => {
  it("no-ops when installedHooks does not contain the ide", () => {
    writeFileSync(rcPath(), JSON.stringify({ version: 1, installedHooks: ["cursor"] }), "utf-8");
    const before = readFileSync(rcPath(), "utf-8");
    removeInstalledHook(tmpDir, "claude-code");
    const after = readFileSync(rcPath(), "utf-8");
    expect(after).toBe(before);
  });

  it("no-ops when installedHooks field is absent", () => {
    writeFileSync(rcPath(), JSON.stringify({ version: 1 }), "utf-8");
    removeInstalledHook(tmpDir, "claude-code");
    const rc = readRcFile();
    expect(rc.installedHooks).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// removeInstalledHook - ide present
// ---------------------------------------------------------------------------

describe("removeInstalledHook - ide present", () => {
  it("removes the specified ide from installedHooks", () => {
    writeFileSync(
      rcPath(),
      JSON.stringify({ version: 1, installedHooks: ["claude-code", "cursor"] }),
      "utf-8",
    );
    removeInstalledHook(tmpDir, "claude-code");
    const rc = readRcFile();
    const hooks = rc.installedHooks as string[];
    expect(hooks).not.toContain("claude-code");
    expect(hooks).toContain("cursor");
  });

  it("leaves an empty array when the only ide is removed", () => {
    writeFileSync(rcPath(), JSON.stringify({ version: 1, installedHooks: ["cline"] }), "utf-8");
    removeInstalledHook(tmpDir, "cline");
    const rc = readRcFile();
    expect(rc.installedHooks).toEqual([]);
  });

  it("preserves all other rc fields verbatim (EC-S2-I3)", () => {
    const seed = {
      version: 1,
      mode: "global",
      registry: { path: ".yakcc/registry.sqlite" },
      federation: { peers: ["https://example.org"] },
      installedHooks: ["cursor", "aider"],
    };
    writeFileSync(rcPath(), JSON.stringify(seed), "utf-8");
    removeInstalledHook(tmpDir, "aider");
    const rc = readRcFile();
    expect(rc.mode).toBe("global");
    expect((rc.registry as Record<string, unknown>).path).toBe(".yakcc/registry.sqlite");
    expect((rc.federation as Record<string, unknown[]>).peers).toEqual(["https://example.org"]);
    expect(rc.installedHooks).toEqual(["cursor"]);
  });
});

// ---------------------------------------------------------------------------
// Compound interaction: end-to-end production sequence
// ---------------------------------------------------------------------------

describe("compound interaction - add/remove round trip (production sequence)", () => {
  it("install two IDEs then remove one: correct final state", () => {
    addInstalledHook(tmpDir, "claude-code");
    addInstalledHook(tmpDir, "cursor");
    removeInstalledHook(tmpDir, "claude-code");
    const rc = readRcFile();
    const hooks = rc.installedHooks as string[];
    expect(hooks).toEqual(["cursor"]);
  });

  it("add -> remove -> add produces exactly one entry", () => {
    addInstalledHook(tmpDir, "windsurf");
    removeInstalledHook(tmpDir, "windsurf");
    addInstalledHook(tmpDir, "windsurf");
    const rc = readRcFile();
    const hooks = rc.installedHooks as string[];
    expect(hooks.filter((h) => h === "windsurf").length).toBe(1);
  });

  it("removes only the targeted IDE when multiple are present", () => {
    addInstalledHook(tmpDir, "cline");
    addInstalledHook(tmpDir, "continue");
    addInstalledHook(tmpDir, "aider");
    removeInstalledHook(tmpDir, "continue");
    const rc = readRcFile();
    const hooks = rc.installedHooks as string[];
    expect(hooks).toContain("cline");
    expect(hooks).toContain("aider");
    expect(hooks).not.toContain("continue");
  });
});
