/**
 * hook-intercept.test.ts - Integration and failure-mode tests for hookIntercept() Phase-2.
 *
 * Production sequence exercised (in-process path):
 *   hookIntercept(argv, logger, { stdin: Readable.from([buf]), telemetryDir: tmpdir,
 *                                 registryPath: tmpRegistry,
 *                                 executeSubstrateFn: substrateStub })
 *   -> readStdin -> JSON.parse -> existsSync(registry) -> executeSubstrateFn
 *   -> [substrate stub calls captureTelemetry internally] -> JSONL line
 *
 * Production sequence exercised (spawned-subprocess path, Acceptance criterion 4 / Sacred Practice #1):
 *   spawnSync(node, [distBin, "hook-intercept"], { input: payload, env: { YAKCC_TELEMETRY_DIR: tmpdir } })
 *   -> real stdin read -> real existsSync(registry) gate -> exit 0 (no registry in smokeDir)
 *
 * @decision DEC-CLI-HOOK-INTERCEPT-001 -- Phase-2 wire contract verified here.
 * @decision DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001 -- silent-fail verified via injected stubs.
 * @decision DEC-WI831-002 -- 500ms hard cap verified via schedulerFn injection.
 * @decision DEC-WI831-003 -- missing registry silent-exit verified.
 * @decision DEC-WI831-006 -- no stdout emission on substitution verified.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { HookResponseWithSubstitution } from "@yakcc/hooks-base";
import { captureTelemetry, hashIntent } from "@yakcc/hooks-base/telemetry.js";
import type { TelemetryEvent } from "@yakcc/hooks-base/telemetry.js";
import type { Registry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import { hookIntercept } from "./hook-intercept.js";
import type { HookInterceptOptions } from "./hook-intercept.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Matches the exact signature of executeRegistryQueryWithSubstitution. */
type SubstrateFn = NonNullable<HookInterceptOptions["executeSubstrateFn"]>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-hook-intercept-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeStdin(payload: unknown): NodeJS.ReadableStream {
  const buf = Buffer.from(JSON.stringify(payload), "utf-8");
  return Readable.from([buf]);
}

function makeRawStdin(raw: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(raw, "utf-8")]);
}

function readJsonlLine(dir: string, sessionId: string): TelemetryEvent | null {
  const p = join(dir, `${sessionId}.jsonl`);
  if (!existsSync(p)) return null;
  const line = readFileSync(p, "utf-8").trim();
  if (!line) return null;
  return JSON.parse(line) as TelemetryEvent;
}

function countJsonlLines(dir: string, sessionId: string): number {
  const p = join(dir, `${sessionId}.jsonl`);
  if (!existsSync(p)) return 0;
  return readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).length;
}

/**
 * Create a dummy registry file at the given path.
 * existsSync gates on this file in hook-intercept; it just needs to exist.
 * Real registry interactions are handled by the substrate stub.
 */
function touchRegistryFile(dir: string, name = "registry.sqlite"): string {
  const p = join(dir, name);
  writeFileSync(p, "");
  return p;
}

/**
 * Build a substrate stub that simulates a passthrough outcome (no registry match).
 * Writes one TelemetryEvent via captureTelemetry so JSONL assertions work.
 * sessionId and telemetryDir are threaded from the substrate opts.
 */
function makePassthroughSubstrate(): SubstrateFn {
  return async (_registry, ctx, _code, toolName, options) => {
    captureTelemetry({
      intent: ctx.intent,
      toolName,
      response: { kind: "passthrough" },
      candidateCount: 0,
      topScore: null,
      latencyMs: 0,
      substituted: false,
      substitutedAtomHash: null,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.telemetryDir !== undefined ? { telemetryDir: options.telemetryDir } : {}),
    });
    return { kind: "passthrough", substituted: false } satisfies HookResponseWithSubstitution;
  };
}

/**
 * Build a substrate stub that simulates a registry-hit (substituted=true, atomHash present).
 * Writes one TelemetryEvent. Returns a substituted response.
 */
function makeRegistryHitSubstrate(
  atomHash: string,
  candidateCount: number,
  topScore: number,
): SubstrateFn {
  return async (_registry, ctx, _code, toolName, options) => {
    captureTelemetry({
      intent: ctx.intent,
      toolName,
      response: { kind: "passthrough" },
      candidateCount,
      topScore,
      latencyMs: 5,
      substituted: true,
      substitutedAtomHash: atomHash,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.telemetryDir !== undefined ? { telemetryDir: options.telemetryDir } : {}),
    });
    // Return value is discarded by hook-intercept (DEC-WI831-006 telemetry-only).
    return {
      kind: "passthrough",
      substituted: true,
      substitutedCode: "const x = 1;",
      atomHash,
    } as unknown as HookResponseWithSubstitution;
  };
}

/**
 * Build a substrate stub that simulates synthesis-required (candidates below threshold).
 */
function makeSynthesisRequiredSubstrate(): SubstrateFn {
  return async (_registry, ctx, _code, toolName, options) => {
    const syntheisProposal = {
      behavior: ctx.intent,
      inputs: [],
      outputs: [],
      guarantees: [],
      errorConditions: [],
      nonFunctional: { purity: "pure" as const, threadSafety: "safe" as const },
      propertyTests: [],
    };
    captureTelemetry({
      intent: ctx.intent,
      toolName,
      response: { kind: "synthesis-required", proposal: syntheisProposal },
      candidateCount: 2,
      topScore: 0.8,
      latencyMs: 10,
      substituted: false,
      substitutedAtomHash: null,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.telemetryDir !== undefined ? { telemetryDir: options.telemetryDir } : {}),
    });
    return {
      kind: "synthesis-required",
      proposal: syntheisProposal,
      substituted: false,
    } as unknown as HookResponseWithSubstitution;
  };
}

// ---------------------------------------------------------------------------
// Suite 1: Happy path -- Edit tool with substrate stub (Phase-2)
// ---------------------------------------------------------------------------

describe("hookIntercept -- Phase-2 happy path (Edit tool)", () => {
  it("returns 0, logs nothing, writes one JSONL line via substrate stub", async () => {
    const logger = new CollectingLogger();
    const registryPath = touchRegistryFile(tmpDir);
    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/x", new_string: "hello world" },
      hook_event_name: "PreToolUse",
      session_id: "test-session-edit",
    };
    const code = await hookIntercept([], logger, {
      stdin: makeStdin(payload),
      telemetryDir: tmpDir,
      registryPath,
      executeSubstrateFn: makePassthroughSubstrate(),
    });

    expect(code).toBe(0);
    // Empty stdout -- the logger must never be called.
    expect(logger.logLines).toHaveLength(0);
    expect(logger.errLines).toHaveLength(0);

    // Exactly one JSONL line written (by the substrate stub).
    expect(countJsonlLines(tmpDir, "test-session-edit")).toBe(1);

    const event = readJsonlLine(tmpDir, "test-session-edit");
    expect(event).not.toBeNull();
    expect(event?.toolName).toBe("Edit");
    expect(event?.outcome).toBe("passthrough");
    expect(event?.substituted).toBe(false);
    expect(event?.candidateCount).toBe(0);
    expect(event?.topScore).toBeNull();
    expect(event?.substitutedAtomHash).toBeNull();
    // intentHash must be the BLAKE3 hash of "hello world" -- not the raw string.
    expect(event?.intentHash).toBe(hashIntent("hello world"));
    expect(event?.intentHash).toHaveLength(64); // 256-bit BLAKE3 => 64 hex chars
    expect(typeof event?.t).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Happy path -- Write tool with content field
// ---------------------------------------------------------------------------

describe("hookIntercept -- Phase-2 happy path (Write tool, content field)", () => {
  it("writes JSONL line with intentHash matching hashIntent(content)", async () => {
    const logger = new CollectingLogger();
    const registryPath = touchRegistryFile(tmpDir);
    const payload = {
      tool_name: "Write",
      tool_input: { file_path: "/tmp/y", content: "some file content" },
      session_id: "test-session-write",
    };
    const code = await hookIntercept([], logger, {
      stdin: makeStdin(payload),
      telemetryDir: tmpDir,
      registryPath,
      executeSubstrateFn: makePassthroughSubstrate(),
    });

    expect(code).toBe(0);
    const event = readJsonlLine(tmpDir, "test-session-write");
    expect(event).not.toBeNull();
    expect(event?.toolName).toBe("Write");
    expect(event?.intentHash).toBe(hashIntent("some file content"));
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Happy path -- MultiEdit tool
// ---------------------------------------------------------------------------

describe("hookIntercept -- Phase-2 happy path (MultiEdit tool)", () => {
  it("writes JSONL line with toolName === MultiEdit", async () => {
    const logger = new CollectingLogger();
    const registryPath = touchRegistryFile(tmpDir);
    const payload = {
      tool_name: "MultiEdit",
      tool_input: { file_path: "/tmp/z", new_string: "multi" },
      session_id: "test-session-multiedit",
    };
    const code = await hookIntercept([], logger, {
      stdin: makeStdin(payload),
      telemetryDir: tmpDir,
      registryPath,
      executeSubstrateFn: makePassthroughSubstrate(),
    });

    expect(code).toBe(0);
    const event = readJsonlLine(tmpDir, "test-session-multiedit");
    expect(event).not.toBeNull();
    expect(event?.toolName).toBe("MultiEdit");
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Failure modes -- all must exit 0 with empty stdout
// ---------------------------------------------------------------------------

describe("hookIntercept -- failure modes (DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001)", () => {
  it("malformed JSON stdin -> exit 0, empty stdout, no JSONL file", async () => {
    const logger = new CollectingLogger();
    const code = await hookIntercept([], logger, {
      stdin: makeRawStdin("not valid json {{{"),
      telemetryDir: tmpDir,
    });

    expect(code).toBe(0);
    expect(logger.logLines).toHaveLength(0);
    expect(logger.errLines).toHaveLength(0);
    // No file should have been created.
    expect(existsSync(join(tmpDir, "test.jsonl"))).toBe(false);
  });

  it("empty stdin -> exit 0, empty stdout, no JSONL line", async () => {
    const logger = new CollectingLogger();
    const code = await hookIntercept([], logger, {
      stdin: Readable.from([]),
      telemetryDir: tmpDir,
    });

    expect(code).toBe(0);
    expect(logger.logLines).toHaveLength(0);
    expect(logger.errLines).toHaveLength(0);
  });

  it("tool_name is Bash (not Edit/Write/MultiEdit) -> exit 0, no JSONL line", async () => {
    const logger = new CollectingLogger();
    const payload = {
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      session_id: "test-bash-session",
    };
    const code = await hookIntercept([], logger, {
      stdin: makeStdin(payload),
      telemetryDir: tmpDir,
    });

    expect(code).toBe(0);
    expect(countJsonlLines(tmpDir, "test-bash-session")).toBe(0);
  });

  it("missing session_id -> exit 0, JSONL line written to fallback session file", async () => {
    const logger = new CollectingLogger();
    const registryPath = touchRegistryFile(tmpDir);
    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/x", new_string: "fallback test" },
      // No session_id field
    };

    // Clear CLAUDE_SESSION_ID to force process-UUID fallback
    const savedEnv = process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = undefined;

    try {
      const code = await hookIntercept([], logger, {
        stdin: makeStdin(payload),
        telemetryDir: tmpDir,
        registryPath,
        executeSubstrateFn: makePassthroughSubstrate(),
      });

      expect(code).toBe(0);
      // A JSONL file should exist somewhere in tmpDir (the fallback session ID)
      const { readdirSync } = await import("node:fs");
      const files = readdirSync(tmpDir).filter((f) => f.endsWith(".jsonl"));
      expect(files.length).toBeGreaterThan(0);
    } finally {
      if (savedEnv !== undefined) {
        process.env.CLAUDE_SESSION_ID = savedEnv;
      }
    }
  });

  it("substrate injection throws -> exit 0, empty stdout (silent-fail proven, DEC-WI831-003)", async () => {
    // Phase-2 replacement for the old 'appendEvent injection throws' test.
    // Proves DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001 still holds when the substrate throws.
    const logger = new CollectingLogger();
    const registryPath = touchRegistryFile(tmpDir);
    const throwingSubstrate: SubstrateFn = async () => {
      throw new Error("ENOSPC: disk full in substrate");
    };
    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/x", new_string: "disk full test" },
      session_id: "test-disk-full",
    };

    const code = await hookIntercept([], logger, {
      stdin: makeStdin(payload),
      telemetryDir: tmpDir,
      registryPath,
      executeSubstrateFn: throwingSubstrate,
    });

    expect(code).toBe(0);
    expect(logger.logLines).toHaveLength(0);
    expect(logger.errLines).toHaveLength(0);
    // No file written since substrate threw before captureTelemetry fired.
    expect(countJsonlLines(tmpDir, "test-disk-full")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Spawned-subprocess smoke test (Sacred Practice #1 real-stdin proof)
//
// Gates on dist/bin.js existing. If dist/bin.js is absent (vitest runs before
// pnpm build in some CI orderings), the test is skipped with a note.
// The reviewer MUST confirm this test passed at least once against a freshly-
// built dist/bin.js before declaring ready_for_guardian.
// ---------------------------------------------------------------------------

describe("hookIntercept -- spawned-subprocess smoke (real stdin, Sacred Practice #1)", () => {
  const distBin = join(
    process.cwd().replace(/packages[\\/]cli.*$/, ""),
    "packages",
    "cli",
    "dist",
    "bin.js",
  );

  it.runIf(existsSync(distBin))(
    "pipes PreToolUse JSON via real stdin; exit 0 + empty stdout (no registry in smokeDir = silent no-op)",
    () => {
      const smokeDir = mkdtempSync(join(tmpdir(), "yakcc-hook-intercept-smoke-"));
      try {
        const payload = JSON.stringify({
          tool_name: "Edit",
          tool_input: { file_path: "/tmp/x", new_string: "smoke test content" },
          session_id: "smoke-test",
        });

        // Phase-2: no registry at cwd-default ".yakcc/registry.sqlite" →
        // hook exits 0 with no JSONL event (DEC-WI831-003: absent registry → silent no-op).
        const result = spawnSync(process.execPath, [distBin, "hook-intercept"], {
          input: payload,
          env: { ...process.env, YAKCC_TELEMETRY_DIR: smokeDir },
          encoding: "utf-8",
          timeout: 10_000,
        });

        // Exit 0
        expect(result.status).toBe(0);
        // Empty stdout (DEC-WI831-006 + DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001)
        expect(result.stdout).toBe("");
        // No stderr errors (ignore any Node.js deprecation noise)
        if (result.stderr) {
          expect(result.stderr).not.toMatch(/Error:|ENOENT/);
        }
      } finally {
        rmSync(smokeDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(existsSync(distBin))(
    "SKIP: dist/bin.js not found -- build the package first (pnpm -r build)",
    () => {
      // This test is intentionally skipped when the binary is not built.
      // The reviewer must run pnpm -r build and then pnpm -r test to exercise this.
      expect(true).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Suite 6: Phase-2 specific tests (DEC-WI831-001 through DEC-WI831-006)
// ---------------------------------------------------------------------------

describe("hookIntercept -- Phase-2: registry-hit substrate stub (DEC-WI831-001)", () => {
  it("happy path with registry-hit substrate: writes one JSONL line with substituted=true", async () => {
    // Proves G1 (real atomHash etc.) and DEC-WI831-006 (telemetry-only, no stdout injection).
    const logger = new CollectingLogger();
    const registryPath = touchRegistryFile(tmpDir);
    const fakeAtomHash = "a".repeat(64);
    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/x", new_string: "function add(a, b) { return a + b; }" },
      session_id: "test-registry-hit",
    };

    const code = await hookIntercept([], logger, {
      stdin: makeStdin(payload),
      telemetryDir: tmpDir,
      registryPath,
      executeSubstrateFn: makeRegistryHitSubstrate(fakeAtomHash, 3, 0.15),
    });

    expect(code).toBe(0);
    // DEC-WI831-006: substituted code NOT injected to stdout. Logger still silent.
    expect(logger.logLines).toHaveLength(0);
    expect(logger.errLines).toHaveLength(0);

    // Exactly one JSONL line (the substrate's) — no duplicate from CLI seam.
    expect(countJsonlLines(tmpDir, "test-registry-hit")).toBe(1);

    const event = readJsonlLine(tmpDir, "test-registry-hit");
    expect(event).not.toBeNull();
    expect(event?.toolName).toBe("Edit");
    expect(event?.substituted).toBe(true);
    expect(event?.substitutedAtomHash).toBe(fakeAtomHash);
    expect(event?.candidateCount).toBe(3);
    expect(event?.topScore).toBe(0.15);
    expect(event?.intentHash).toBe(hashIntent("function add(a, b) { return a + b; }"));
  });
});

describe("hookIntercept -- Phase-2: synthesis-required substrate stub (DEC-WI831-001)", () => {
  it("synthesis-required path: writes JSONL line with outcome=synthesis-required, substituted=false", async () => {
    const logger = new CollectingLogger();
    const registryPath = touchRegistryFile(tmpDir);
    const payload = {
      tool_name: "Write",
      tool_input: { content: "novel algorithm nobody has seen" },
      session_id: "test-synthesis-required",
    };

    const code = await hookIntercept([], logger, {
      stdin: makeStdin(payload),
      telemetryDir: tmpDir,
      registryPath,
      executeSubstrateFn: makeSynthesisRequiredSubstrate(),
    });

    expect(code).toBe(0);
    expect(countJsonlLines(tmpDir, "test-synthesis-required")).toBe(1);
    const event = readJsonlLine(tmpDir, "test-synthesis-required");
    expect(event).not.toBeNull();
    expect(event?.outcome).toBe("synthesis-required");
    expect(event?.substituted).toBe(false);
    expect(event?.candidateCount).toBe(2);
  });
});

describe("hookIntercept -- Phase-2: missing registry (DEC-WI831-003)", () => {
  it("absent registry file -> exit 0, no JSONL line, no error (silent no-op)", async () => {
    // Proves DEC-WI831-003: cwd-relative .yakcc/registry.sqlite does not exist →
    // exit 0 with no telemetry event written.
    const logger = new CollectingLogger();
    const nonExistentRegistry = join(tmpDir, "does-not-exist.sqlite");
    const payload = {
      tool_name: "Edit",
      tool_input: { new_string: "test code" },
      session_id: "test-no-registry",
    };

    const code = await hookIntercept([], logger, {
      stdin: makeStdin(payload),
      telemetryDir: tmpDir,
      registryPath: nonExistentRegistry,
    });

    expect(code).toBe(0);
    expect(logger.logLines).toHaveLength(0);
    expect(logger.errLines).toHaveLength(0);
    // No JSONL file at all — substrate was never called.
    expect(existsSync(join(tmpDir, "test-no-registry.jsonl"))).toBe(false);
  });
});

describe("hookIntercept -- Phase-2: 500ms hard cap enforcement (DEC-WI831-002)", () => {
  it("never-resolving substrate stub + fast scheduler -> exits 0 immediately, no JSONL line", async () => {
    // Proves DEC-WI831-002: the 500ms hard cap fires when substrate hangs.
    // A fast scheduler (0ms timeout) makes this test instantaneous.
    const logger = new CollectingLogger();
    const registryPath = touchRegistryFile(tmpDir);
    const payload = {
      tool_name: "Edit",
      tool_input: { new_string: "wedged substrate test" },
      session_id: "test-timeout",
    };

    // Substrate that never resolves (simulates a wedged sqlite-vec query).
    const neverResolvingSubstrate: SubstrateFn = () =>
      new Promise<HookResponseWithSubstitution>(() => {});

    // Fast scheduler: resolves immediately (0ms) so timer fires before substrate.
    const fastScheduler = (_ms: number): Promise<void> => Promise.resolve();

    const code = await hookIntercept([], logger, {
      stdin: makeStdin(payload),
      telemetryDir: tmpDir,
      registryPath,
      executeSubstrateFn: neverResolvingSubstrate,
      schedulerFn: fastScheduler,
    });

    // Hook must exit 0 even with a wedged substrate.
    expect(code).toBe(0);
    expect(logger.logLines).toHaveLength(0);
    expect(logger.errLines).toHaveLength(0);
    // No JSONL line: substrate never wrote one since it never resolved.
    expect(countJsonlLines(tmpDir, "test-timeout")).toBe(0);
  });
});

describe("hookIntercept -- Phase-2: no-double-write invariant (Sacred Practice #12)", () => {
  it("substrate stub writes exactly one JSONL line; hook-intercept CLI seam writes zero additional lines", async () => {
    // Compound interaction test: proves the full production sequence end-to-end.
    // Exercises: stdin read → parse → existsSync gate → substrate call → single telemetry write.
    //
    // Sacred Practice #12 (single writer): if the old Phase-1 appendEvent path were still
    // active inside hookIntercept(), we'd see 2 JSONL lines. We must see exactly 1.
    const logger = new CollectingLogger();
    const registryPath = touchRegistryFile(tmpDir);
    let substrateCallCount = 0;
    const sessionId = "test-no-double-write";

    const countingSubstrate: SubstrateFn = async (_registry, ctx, _code, toolName, options) => {
      substrateCallCount++;
      captureTelemetry({
        intent: ctx.intent,
        toolName,
        response: { kind: "passthrough" },
        candidateCount: 0,
        topScore: null,
        latencyMs: 1,
        substituted: false,
        substitutedAtomHash: null,
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.telemetryDir !== undefined ? { telemetryDir: options.telemetryDir } : {}),
      });
      return { kind: "passthrough", substituted: false } satisfies HookResponseWithSubstitution;
    };

    const payload = {
      tool_name: "Edit",
      tool_input: { new_string: "double write test" },
      session_id: sessionId,
    };

    const code = await hookIntercept([], logger, {
      stdin: makeStdin(payload),
      telemetryDir: tmpDir,
      registryPath,
      executeSubstrateFn: countingSubstrate,
    });

    expect(code).toBe(0);
    // Substrate was called exactly once.
    expect(substrateCallCount).toBe(1);
    // Exactly one JSONL line total — the substrate's. No second line from CLI seam.
    expect(countJsonlLines(tmpDir, sessionId)).toBe(1);
  });
});

describe("hookIntercept -- Phase-2: DEC-WI831-006 telemetry-only delivery (no stdout injection)", () => {
  it("when substrate returns substituted=true, hook exits 0 with empty stdout (no inline injection)", async () => {
    // Proves DEC-WI831-006: substituted code is NOT rendered to stdout.
    // The Claude Code PreToolUse contract: non-empty stdout blocks the tool call.
    // We verify logger is never called even on a registry-hit.
    const logger = new CollectingLogger();
    const registryPath = touchRegistryFile(tmpDir);
    const fakeAtomHash = "b".repeat(64);
    const payload = {
      tool_name: "Write",
      tool_input: { content: "function multiply(a, b) { return a * b; }" },
      session_id: "test-telemetry-only",
    };

    const code = await hookIntercept([], logger, {
      stdin: makeStdin(payload),
      telemetryDir: tmpDir,
      registryPath,
      executeSubstrateFn: makeRegistryHitSubstrate(fakeAtomHash, 1, 0.1),
    });

    expect(code).toBe(0);
    // Critical: no output, even on substitution (DEC-WI831-006).
    expect(logger.logLines).toHaveLength(0);
    expect(logger.errLines).toHaveLength(0);
  });
});

describe("hookIntercept -- Phase-2: substrate receives correct session_id and telemetryDir (DEC-WI831-WIRE-001)", () => {
  it("substrate receives the session_id from stdin payload and telemetryDir from options", async () => {
    // Proves that hookIntercept correctly threads sessionId and telemetryDir
    // into the substrate call per DEC-WI831-WIRE-001.
    const logger = new CollectingLogger();
    const registryPath = touchRegistryFile(tmpDir);
    let capturedSessionId: string | undefined;
    let capturedTelemetryDir: string | undefined;

    const capturingSubstrate: SubstrateFn = async (_registry, _ctx, _code, toolName, options) => {
      capturedSessionId = options.sessionId;
      capturedTelemetryDir = options.telemetryDir;
      captureTelemetry({
        intent: "wiring test",
        toolName,
        response: { kind: "passthrough" },
        candidateCount: 0,
        topScore: null,
        latencyMs: 0,
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.telemetryDir !== undefined ? { telemetryDir: options.telemetryDir } : {}),
      });
      return { kind: "passthrough", substituted: false } satisfies HookResponseWithSubstitution;
    };

    const payload = {
      tool_name: "Edit",
      tool_input: { new_string: "wiring test" },
      session_id: "expected-session-id",
    };

    const code = await hookIntercept([], logger, {
      stdin: makeStdin(payload),
      telemetryDir: tmpDir,
      registryPath,
      executeSubstrateFn: capturingSubstrate,
    });

    expect(code).toBe(0);
    // hookIntercept must pass the parsed session_id to the substrate.
    expect(capturedSessionId).toBe("expected-session-id");
    // hookIntercept must pass the injected telemetryDir to the substrate.
    expect(capturedTelemetryDir).toBe(tmpDir);
  });
});
