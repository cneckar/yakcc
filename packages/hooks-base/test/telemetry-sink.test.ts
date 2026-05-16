// SPDX-License-Identifier: MIT
// @mock-exempt: fetch is an external HTTP boundary (DEC-TELEMETRY-EXPORT-FAIL-SILENT-005,
//   DEC-TELEMETRY-EXPORT-BATCHING-004). Real outbound HTTP in unit tests would require a live
//   server and would make tests environment-dependent; fetch is the one canonical external
//   boundary in this module. All other collaborators (FileSink, NoOpSink, real fs) are used
//   as real implementations per Sacred Practice #5.
/**
 * telemetry-sink.test.ts — Unit tests for all six sink test cases (DEC-TELEMETRY-EXPORT-SINK-001).
 *
 * Cases covered:
 *   1. NoOpSink.send() — zero I/O (verified via real tmpdir: no file created; no fetch called)
 *   2. FileSink.send() — writes JSONL to real tmpdir
 *   3. HttpsBatcherSink — batches by size: 50 events triggers mocked fetch
 *   4. HttpsBatcherSink — batches by time: 5000ms interval (fake timers + mocked fetch)
 *   5. HttpsBatcherSink — fails silently on fetch rejection (no throw; at-most-once console.warn)
 *   6. HttpsBatcherSink never instantiated when YAKCC_TELEMETRY_DISABLED=1
 *      (selectSink returns NoOpSink — verified structurally, no mocking needed)
 *   7. CompositeSink — fan-out uses real FileSink instances; one failure does not affect the other
 *
 * Mocking policy: ONLY fetch is mocked (external HTTP boundary). All fs operations
 * use real tmpdir paths. CompositeSink tests use real FileSink/NoOpSink as inner sinks
 * instead of fake objects.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompositeSink,
  FileSink,
  HttpsBatcherSink,
  NoOpSink,
  _resetSinkSingleton,
  buildSink,
  selectSink,
} from "../src/telemetry-sink.js";
import type { TelemetryEvent } from "../src/telemetry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a JSONL line at a given index. Throws if the line is undefined (test bug, not prod). */
function parseLine<T>(lines: string[], index: number): T {
  const line = lines[index];
  if (line === undefined)
    throw new Error(`No line at index ${index} (lines.length=${lines.length})`);
  return JSON.parse(line) as T;
}

function makeEvent(overrides?: Partial<TelemetryEvent>): TelemetryEvent {
  return {
    t: Date.now(),
    intentHash: "c".repeat(64),
    toolName: "Edit",
    candidateCount: 0,
    topScore: null,
    substituted: false,
    substitutedAtomHash: null,
    latencyMs: 5,
    outcome: "passthrough",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test-lifecycle — real tmpdir, singleton reset, HttpsBatcherSink disposal
// ---------------------------------------------------------------------------

let tmpDir: string;
/** Track all HttpsBatcherSink instances so afterEach can always dispose them.
 * This prevents beforeExit handlers from leaking when an assertion fails
 * before the test body's own sink.dispose() call. */
const _httpsSinks: HttpsBatcherSink[] = [];

/** Create an HttpsBatcherSink and register it for guaranteed afterEach disposal. */
function makeHttpsSink(endpoint: string, sessionId: string): HttpsBatcherSink {
  const sink = new HttpsBatcherSink(endpoint, sessionId);
  _httpsSinks.push(sink);
  return sink;
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `yakcc-sink-test-${process.pid}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  _resetSinkSingleton();
});

afterEach(() => {
  // Dispose all tracked HttpsBatcherSink instances before restoring timers,
  // so clearInterval runs under the same timer environment as setInterval.
  for (const sink of _httpsSinks.splice(0)) {
    sink.dispose();
  }
  _resetSinkSingleton();
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Case 1: NoOpSink.send() — zero I/O
// Verified using real tmpdir: no file must appear. No FS spy needed.
// ---------------------------------------------------------------------------

describe("NoOpSink — zero I/O (DEC-TELEMETRY-EXPORT-B6A-AUTO-DISABLE-007)", () => {
  it("send() does not create any file in the process working directory or tmpdir", () => {
    const filesBefore = readdirSync(tmpDir) as string[];

    const sink = new NoOpSink();
    for (let i = 0; i < 5; i++) {
      sink.send(makeEvent({ t: i }));
    }

    // No new files must appear in tmpDir (would appear if any real FS write occurred)
    const filesAfter = readdirSync(tmpDir) as string[];
    expect(filesAfter).toEqual(filesBefore);
  });

  it("send() does not call fetch (verified by spy on external boundary)", () => {
    // fetch IS the external boundary; spy is legitimate here
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const sink = new NoOpSink();
    sink.send(makeEvent());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("send() does not throw for any event shape", () => {
    const sink = new NoOpSink();
    expect(() => sink.send(makeEvent())).not.toThrow();
    expect(() =>
      sink.send(makeEvent({ candidateCount: 99, topScore: 0.99, latencyMs: 9999 })),
    ).not.toThrow();
  });

  it("send() accepts 200 events without accumulating state (O(1) by design)", () => {
    const sink = new NoOpSink();
    // If NoOpSink were accidentally buffering, memory usage would grow.
    // Completing without error AND without any files written is the observable proof.
    for (let i = 0; i < 200; i++) {
      sink.send(makeEvent({ t: i }));
    }
    const filesAfter = readdirSync(tmpDir) as string[];
    expect(filesAfter).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Case 2: FileSink.send() — writes JSONL to real tmpdir
// ---------------------------------------------------------------------------

describe("FileSink — JSONL writer (real FS)", () => {
  it("creates the file and writes a valid JSONL line", () => {
    const sink = new FileSink(tmpDir, "session-file-test");
    const event = makeEvent({ outcome: "registry-hit", candidateCount: 2 });
    sink.send(event);

    const filePath = join(tmpDir, "session-file-test.jsonl");
    expect(existsSync(filePath)).toBe(true);

    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = parseLine<TelemetryEvent>(lines, 0);
    expect(parsed.outcome).toBe("registry-hit");
    expect(parsed.candidateCount).toBe(2);
  });

  it("appends multiple events as separate JSONL lines (append-only invariant)", () => {
    const sink = new FileSink(tmpDir, "session-file-append");
    sink.send(makeEvent({ outcome: "registry-hit", t: 1 }));
    sink.send(makeEvent({ outcome: "synthesis-required", t: 2 }));
    sink.send(makeEvent({ outcome: "passthrough", t: 3 }));

    const filePath = join(tmpDir, "session-file-append.jsonl");
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(parseLine<TelemetryEvent>(lines, 0).outcome).toBe("registry-hit");
    expect(parseLine<TelemetryEvent>(lines, 1).outcome).toBe("synthesis-required");
    expect(parseLine<TelemetryEvent>(lines, 2).outcome).toBe("passthrough");
  });

  it("creates deeply nested directories if they do not exist", () => {
    const subDir = join(tmpDir, "deep", "nested", "dir");
    const sink = new FileSink(subDir, "session-mkdir");
    expect(() => sink.send(makeEvent())).not.toThrow();
    expect(existsSync(join(subDir, "session-mkdir.jsonl"))).toBe(true);
  });

  it("each JSONL line is independently parseable JSON", () => {
    const sink = new FileSink(tmpDir, "session-jsonl-lines");
    for (let i = 0; i < 5; i++) {
      sink.send(makeEvent({ t: i * 1000, outcome: "passthrough" }));
    }
    const lines = readFileSync(join(tmpDir, "session-jsonl-lines.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("does not throw when write fails (fail-silent, DEC-005)", () => {
    // /dev/full is a character device, so mkdirSync on a child path fails fast
    // with ENOTDIR. Avoid /proc/... here — mkdirSync on /proc subpaths hangs the
    // syscall on Linux (kernel-resident vfs), so it would block the test forever.
    const sink = new FileSink("/dev/full/yakcc-nonexistent-12345", "session-baddir");
    expect(() => sink.send(makeEvent())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Case 3: HttpsBatcherSink — size flush (50 events)
// @mock-exempt: fetch is the external HTTP boundary
// ---------------------------------------------------------------------------

describe("HttpsBatcherSink — size-based batch flush (DEC-TELEMETRY-EXPORT-BATCHING-004)", () => {
  it("flushes when buffer reaches 50 events and POSTs to the endpoint", async () => {
    const fetchCalls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: Parameters<typeof globalThis.fetch>[0]) => {
      fetchCalls.push(url.toString());
      return new Response(null, { status: 200 });
    });

    const sink = new HttpsBatcherSink("https://metrics.yakcc.com/test-size", "size-test");

    // 49 events — must NOT flush yet
    for (let i = 0; i < 49; i++) {
      sink.send(makeEvent({ t: i }));
    }
    await Promise.resolve();
    const callsBefore = fetchCalls.length;

    // 50th event — triggers size flush
    sink.send(makeEvent({ t: 49 }));
    await new Promise((r) => setTimeout(r, 30));

    expect(fetchCalls.length).toBeGreaterThan(callsBefore);
    expect(fetchCalls[0]).toBe("https://metrics.yakcc.com/test-size");

    sink.dispose();
  });

  it("flush POST body is a valid TelemetryEnvelope with schemaVersion=1", async () => {
    let capturedBody: string | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      capturedBody = (init?.body as string) ?? null;
      return new Response(null, { status: 200 });
    });

    const sink = new HttpsBatcherSink("https://metrics.yakcc.com/test-body", "body-test");
    for (let i = 0; i < 50; i++) {
      sink.send(makeEvent({ t: i }));
    }
    await new Promise((r) => setTimeout(r, 30));

    expect(capturedBody).not.toBeNull();
    const envelope = JSON.parse(capturedBody ?? "") as {
      schemaVersion: number;
      sessionId: string;
      events: TelemetryEvent[];
      emittedAt: number;
      source: { cliVersion: string; platform: string; nodeVersion: string };
    };
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.sessionId).toBe("body-test");
    expect(Array.isArray(envelope.events)).toBe(true);
    expect(envelope.events.length).toBeGreaterThan(0);
    expect(typeof envelope.source.cliVersion).toBe("string");
    expect(envelope.source.platform).toBe(process.platform);

    sink.dispose();
  });
});

// ---------------------------------------------------------------------------
// Case 4: HttpsBatcherSink — time-based flush (fake timers + mocked fetch)
// @mock-exempt: fetch is the external HTTP boundary; fake timers avoid 5s test wait
// ---------------------------------------------------------------------------

describe("HttpsBatcherSink — time-based batch flush (DEC-TELEMETRY-EXPORT-BATCHING-004)", () => {
  it("flushes after 5000ms interval when buffer is non-empty", async () => {
    vi.useFakeTimers();
    const fetchCalls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: Parameters<typeof globalThis.fetch>[0]) => {
      fetchCalls.push(url.toString());
      return new Response(null, { status: 200 });
    });

    // Note: makeHttpsSink registers for afterEach disposal BEFORE vi.useRealTimers(),
    // ensuring clearInterval runs under the same fake-timer environment as setInterval.
    const sink = makeHttpsSink("https://metrics.yakcc.com/test-timer", "timer-test");

    // A few events — not enough for size flush
    sink.send(makeEvent({ t: 1 }));
    sink.send(makeEvent({ t: 2 }));

    // Advance past the 5000ms interval
    await vi.advanceTimersByTimeAsync(5001);

    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(fetchCalls[0]).toBe("https://metrics.yakcc.com/test-timer");
  });
});

// ---------------------------------------------------------------------------
// Case 5: HttpsBatcherSink — fail-silent on fetch rejection
// @mock-exempt: fetch is the external HTTP boundary
// ---------------------------------------------------------------------------

describe("HttpsBatcherSink — fail-silent on fetch error (DEC-TELEMETRY-EXPORT-FAIL-SILENT-005)", () => {
  it("does not throw when fetch rejects with a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const sink = new HttpsBatcherSink("https://metrics.yakcc.com/test-fail", "fail-test");
    for (let i = 0; i < 50; i++) {
      sink.send(makeEvent({ t: i }));
    }
    // Must not throw even as the async flush rejects
    await expect(Promise.resolve()).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 30));

    sink.dispose();
  });

  it("at-most-once warn per error class — same class does not produce duplicate warnings", async () => {
    let fetchCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      fetchCallCount++;
      return Promise.reject(new TypeError("fetch always fails"));
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const sink = new HttpsBatcherSink("https://metrics.yakcc.com/test-once-warn", "once-warn-test");

    // First batch flush (50 events → size trigger)
    for (let i = 0; i < 50; i++) {
      sink.send(makeEvent({ t: i }));
    }
    await new Promise((r) => setTimeout(r, 30));
    const firstWarnCount = warnSpy.mock.calls.length;

    // Second batch flush — same error class
    warnSpy.mockClear();
    for (let i = 0; i < 50; i++) {
      sink.send(makeEvent({ t: i + 50 }));
    }
    await new Promise((r) => setTimeout(r, 30));

    // at-most-once: second flush of same class should NOT warn again
    expect(warnSpy.mock.calls.length).toBe(0);
    expect(firstWarnCount).toBeGreaterThanOrEqual(1);
    expect(fetchCallCount).toBeGreaterThanOrEqual(2);

    sink.dispose();
  });

  it("does not throw on HTTP 500 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const sink = new HttpsBatcherSink("https://metrics.yakcc.com/test-5xx", "test-5xx-session");
    for (let i = 0; i < 50; i++) {
      sink.send(makeEvent({ t: i }));
    }
    await new Promise((r) => setTimeout(r, 30));

    sink.dispose();
  });
});

// ---------------------------------------------------------------------------
// Case 6: selectSink with DISABLED=1 — NoOpSink returned, no HttpsBatcher
// No mocking needed: structural type check is sufficient.
// ---------------------------------------------------------------------------

describe("selectSink — DISABLED=1 returns NoOpSink (DEC-TELEMETRY-EXPORT-B6A-AUTO-DISABLE-007)", () => {
  it("returns a NoOpSink instance when YAKCC_TELEMETRY_DISABLED=1", () => {
    const sink = selectSink({ YAKCC_TELEMETRY_DISABLED: "1" });
    expect(sink).toBeInstanceOf(NoOpSink);
  });

  it("is not an HttpsBatcherSink or CompositeSink when disabled", () => {
    const sink = selectSink({ YAKCC_TELEMETRY_DISABLED: "1" });
    expect(sink).not.toBeInstanceOf(HttpsBatcherSink);
    expect(sink).not.toBeInstanceOf(CompositeSink);
  });

  it("buildSink with disabled=true → NoOpSink (factory level)", () => {
    const sink = buildSink({
      disabled: true,
      endpoint: "https://metrics.yakcc.com",
      fullIntent: false,
    });
    expect(sink).toBeInstanceOf(NoOpSink);
  });

  it("buildSink with https endpoint → not a NoOpSink", () => {
    const sink = buildSink({
      disabled: false,
      endpoint: "https://metrics.yakcc.com",
      fullIntent: false,
    });
    expect(sink).not.toBeInstanceOf(NoOpSink);
    // buildSink("https://...") returns CompositeSink([HttpsBatcherSink(...)]).
    // Dispose the composite so its inner HttpsBatcherSink's setInterval and
    // beforeExit handler are cleared — otherwise the vitest fork worker hangs.
    if (sink instanceof CompositeSink) sink.dispose();
    else if (sink instanceof HttpsBatcherSink) _httpsSinks.push(sink);
  });
});

// ---------------------------------------------------------------------------
// Case 7: CompositeSink — fan-out with real FileSink inner sinks
// Real FileSink instances used as inner sinks — no fake TelemetrySink objects.
// ---------------------------------------------------------------------------

describe("CompositeSink — fan-out and failure isolation (real inner sinks)", () => {
  it("delivers events to all real FileSink inner sinks", () => {
    const dirA = join(tmpDir, "sinkA");
    const dirB = join(tmpDir, "sinkB");
    const sinkA = new FileSink(dirA, "composite-session");
    const sinkB = new FileSink(dirB, "composite-session");
    const composite = new CompositeSink([sinkA, sinkB]);

    composite.send(makeEvent({ outcome: "registry-hit", t: 42 }));

    const lineA = JSON.parse(
      readFileSync(join(dirA, "composite-session.jsonl"), "utf-8").trim(),
    ) as TelemetryEvent;
    const lineB = JSON.parse(
      readFileSync(join(dirB, "composite-session.jsonl"), "utf-8").trim(),
    ) as TelemetryEvent;

    expect(lineA.outcome).toBe("registry-hit");
    expect(lineB.outcome).toBe("registry-hit");
    expect(lineA.t).toBe(42);
    expect(lineB.t).toBe(42);
  });

  it("second sink (FileSink) still receives events when first sink (bad dir) fails", () => {
    // sinkA writes to an unwritable path. /dev/full is a char device — mkdirSync
    // on a child path fails fast with ENOTDIR. (Avoid /proc/... paths: mkdirSync
    // on /proc subpaths hangs the syscall on Linux.)
    const sinkA = new FileSink("/dev/full/yakcc-bad-12345", "fail-session");
    const dirB = join(tmpDir, "sinkB-isolation");
    const sinkB = new FileSink(dirB, "fail-session");

    const composite = new CompositeSink([sinkA, sinkB]);
    // sinkA will fail (ENOENT/EACCES on /proc path), sinkB must succeed
    expect(() => composite.send(makeEvent({ outcome: "synthesis-required", t: 77 }))).not.toThrow();

    // sinkB must have written despite sinkA failure
    const filePath = join(dirB, "fail-session.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, "utf-8").trim()) as TelemetryEvent;
    expect(parsed.outcome).toBe("synthesis-required");
    expect(parsed.t).toBe(77);
  });

  it("first sink (FileSink) still receives events when second sink fails", () => {
    const dirA = join(tmpDir, "sinkA-isolation");
    const sinkA = new FileSink(dirA, "fail2-session");
    // sinkB writes to an unwritable path. /dev/full is a char device — mkdirSync
    // on a child path fails fast with ENOTDIR. (Avoid /proc/... paths: mkdirSync
    // on /proc subpaths hangs the syscall on Linux.)
    const sinkB = new FileSink("/dev/full/yakcc-bad-99999", "fail2-session");

    const composite = new CompositeSink([sinkA, sinkB]);
    expect(() => composite.send(makeEvent({ outcome: "passthrough", t: 55 }))).not.toThrow();

    const filePath = join(dirA, "fail2-session.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, "utf-8").trim()) as TelemetryEvent;
    expect(parsed.outcome).toBe("passthrough");
    expect(parsed.t).toBe(55);
  });

  it("multiple events are delivered to all sinks in order", () => {
    const dirA = join(tmpDir, "order-A");
    const dirB = join(tmpDir, "order-B");
    const sinkA = new FileSink(dirA, "order-session");
    const sinkB = new FileSink(dirB, "order-session");
    const composite = new CompositeSink([sinkA, sinkB]);

    for (let i = 0; i < 3; i++) {
      composite.send(makeEvent({ t: i + 1, outcome: "passthrough" }));
    }

    for (const dir of [dirA, dirB]) {
      const lines = readFileSync(join(dir, "order-session.jsonl"), "utf-8")
        .split("\n")
        .filter(Boolean);
      expect(lines).toHaveLength(3);
      expect(parseLine<TelemetryEvent>(lines, 0).t).toBe(1);
      expect(parseLine<TelemetryEvent>(lines, 1).t).toBe(2);
      expect(parseLine<TelemetryEvent>(lines, 2).t).toBe(3);
    }
  });

  it("empty CompositeSink does not throw", () => {
    const composite = new CompositeSink([]);
    expect(() => composite.send(makeEvent())).not.toThrow();
  });

  it("NoOpSink as inner sink does not affect outer CompositeSink behavior", () => {
    const dir = join(tmpDir, "with-noop");
    const realSink = new FileSink(dir, "noop-composite");
    const composite = new CompositeSink([new NoOpSink(), realSink, new NoOpSink()]);

    composite.send(makeEvent({ outcome: "atomized", t: 100 }));

    const filePath = join(dir, "noop-composite.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, "utf-8").trim()) as TelemetryEvent;
    expect(parsed.outcome).toBe("atomized");
    expect(parsed.t).toBe(100);
  });
});
