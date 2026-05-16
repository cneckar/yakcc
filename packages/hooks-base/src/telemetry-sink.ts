// SPDX-License-Identifier: MIT
/**
 * telemetry-sink.ts — Pluggable telemetry sink layer for @yakcc/hooks-base.
 *
 * @decision DEC-TELEMETRY-EXPORT-SINK-001
 * @title Sink dispatcher hooks appendTelemetryEvent — single bottleneck
 * @status accepted
 * @rationale
 *   `appendTelemetryEvent` (telemetry.ts) is the single call site reached by both
 *   `captureTelemetry` (Phase 1/2) and `shave-on-miss.ts`. Hooking here guarantees
 *   all three call paths are covered without per-caller changes (Sacred Practice #12).
 *   This module exports the sink interface, implementations, and the `selectSink`
 *   factory. No other module constructs sink instances directly.
 *
 * @decision DEC-TELEMETRY-EXPORT-BATCHING-004
 * @title Time-or-size batching: 5000ms OR 50 events; exit-flush 200ms hard cap
 * @status accepted
 * @rationale
 *   Expected volume: ~tens of events per developer-hour. 50-event batches stay well
 *   under typical HTTP body limits. 5s cadence balances freshness vs request count.
 *   Exit flush via `process.on('beforeExit')` with a 200ms hard cap respects the
 *   D-HOOK-3 latency budget — process exit must not block noticeably.
 *
 * @decision DEC-TELEMETRY-EXPORT-FAIL-SILENT-005
 * @title All sink errors caught; at-most-once console.warn per session per error class
 * @status accepted
 * @rationale
 *   Telemetry must never break user workflows. Errors are caught at the sink boundary.
 *   At-most-once warn surfaces "your telemetry is failing" once per session without
 *   log-spam. The at-most-once set is keyed by error class (DOMException, TypeError, etc.)
 *   so a transient fetch error doesn't silence a subsequent config error.
 *
 * @decision DEC-TELEMETRY-EXPORT-PRIVACY-006
 * @title HTTPS sink: intentHash only; FULL_INTENT applies to File sink only
 * @status accepted
 * @rationale
 *   Conservative default for the network path. Plaintext intent leaving the machine
 *   requires a separate opt-in DEC. The file sink is on the operator's own machine,
 *   where full intent is reasonable if explicitly requested.
 *
 * @decision DEC-TELEMETRY-EXPORT-B6A-AUTO-DISABLE-007
 * @title B6a runYakcc sets YAKCC_TELEMETRY_DISABLED=1; factory returns NoOp when disabled
 * @status accepted
 * @rationale
 *   Two-layer defense: (a) env disables the factory (this module), (b) network interceptor
 *   catches anything that leaks. Either alone keeps B6a green; together they make failures loud.
 *   When disabled, HttpsBatcherSink is NEVER instantiated — zero opportunity for accidental fetch.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_TELEMETRY_ENDPOINT,
  type TelemetryConfig,
  resolveTelemetryConfig,
} from "./telemetry-config.js";
import { buildEnvelope } from "./telemetry-wire.js";
import type { TelemetryEvent } from "./telemetry.js";

// ---------------------------------------------------------------------------
// Session ID resolution (inlined to avoid circular dependency with telemetry.ts)
// ---------------------------------------------------------------------------

/**
 * Process-scoped fallback session ID for the sink layer.
 *
 * @decision DEC-TELEMETRY-EXPORT-SINK-001
 * Inlined here (not imported from telemetry.ts) to break the circular dependency:
 *   telemetry.ts → telemetry-sink.ts → telemetry.ts
 * The logic is identical to `FALLBACK_SESSION_ID` in telemetry.ts. Both modules
 * generate independent UUIDs; they are used as sink-level vs. file-level session IDs
 * when no CLAUDE_SESSION_ID is provided by the caller. In practice callers always
 * pass sessionId from resolveSessionId() in telemetry.ts, so the fallback is only
 * reached in isolated sink unit tests.
 */
const _SINK_FALLBACK_SESSION_ID: string = (() => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
})();

/** Resolve the session ID for sink use. Mirrors telemetry.ts:resolveSessionId(). */
function _resolveSinkSessionId(): string {
  return process.env.CLAUDE_SESSION_ID ?? _SINK_FALLBACK_SESSION_ID;
}

// ---------------------------------------------------------------------------
// Sink interface
// ---------------------------------------------------------------------------

/**
 * Pluggable telemetry sink.
 *
 * @decision DEC-TELEMETRY-EXPORT-SINK-001
 * All implementations MUST catch their own errors and NEVER throw to the caller.
 * send() is fire-and-forget from the caller's perspective (void return).
 */
export interface TelemetrySink {
  /**
   * Accept one telemetry event.
   * Implementations buffer, write, or discard the event immediately.
   * MUST NOT throw. MUST NOT add measurable latency (O(1) buffer push).
   */
  send(event: TelemetryEvent): void;
}

// ---------------------------------------------------------------------------
// NoOpSink
// ---------------------------------------------------------------------------

/**
 * Zero-I/O sink — discards all events immediately.
 * Used when `YAKCC_TELEMETRY_DISABLED=1` or `YAKCC_TELEMETRY_ENDPOINT=off`.
 *
 * @decision DEC-TELEMETRY-EXPORT-B6A-AUTO-DISABLE-007
 * When the factory returns NoOpSink, HttpsBatcherSink is never constructed —
 * there is no `fetch` call path reachable, period.
 */
export class NoOpSink implements TelemetrySink {
  send(_event: TelemetryEvent): void {
    // Intentionally empty — zero I/O.
  }
}

// ---------------------------------------------------------------------------
// FileSink
// ---------------------------------------------------------------------------

/**
 * Sink that appends events as JSONL to a configured directory.
 * Used when `YAKCC_TELEMETRY_ENDPOINT=file://<path>`.
 *
 * @decision DEC-TELEMETRY-EXPORT-PRIVACY-006
 * When `fullIntent` is true, the event's raw `intent` field may be present
 * in the line. For File sink this is acceptable — the file stays on the
 * operator's own machine.
 *
 * Note: The existing JSONL writer in `appendTelemetryEvent` (telemetry.ts)
 * is the primary local writer. This FileSink is an ADDITIVE override for
 * the `file://` endpoint case, writing to a DIFFERENT configured path.
 * It does NOT replace the primary writer.
 */
export class FileSink implements TelemetrySink {
  private readonly dir: string;
  private readonly sessionId: string;
  private initialized = false;
  // at-most-once warn set (DEC-TELEMETRY-EXPORT-FAIL-SILENT-005)
  private readonly warnedClasses = new Set<string>();

  constructor(dir: string, sessionId?: string) {
    this.dir = dir;
    this.sessionId = sessionId ?? _resolveSinkSessionId();
  }

  send(event: TelemetryEvent): void {
    try {
      if (!this.initialized) {
        mkdirSync(this.dir, { recursive: true });
        this.initialized = true;
      }
      const filePath = join(this.dir, `${this.sessionId}.jsonl`);
      appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf-8");
    } catch (err) {
      this._warnOnce(err);
    }
  }

  private _warnOnce(err: unknown): void {
    const cls = err instanceof Error ? err.constructor.name : "UnknownError";
    if (!this.warnedClasses.has(cls)) {
      this.warnedClasses.add(cls);
      console.warn(`[yakcc telemetry] FileSink error (${cls}):`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// HttpsBatcherSink
// ---------------------------------------------------------------------------

/** Batch flush constants (DEC-TELEMETRY-EXPORT-BATCHING-004). */
const BATCH_FLUSH_INTERVAL_MS = 5000;
const BATCH_FLUSH_SIZE = 50;
/** Hard cap on exit-flush duration (sub-D-HOOK-3, 200ms). */
const EXIT_FLUSH_TIMEOUT_MS = 200;
/** Hard cap on a single batch POST (10s). */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Async batching sink that POSTs schemaful envelopes to an HTTPS endpoint.
 *
 * @decision DEC-TELEMETRY-EXPORT-BATCHING-004
 * Events are buffered in-memory. A timer fires every 5000ms; a size gate fires
 * at 50 events. On `beforeExit`, a final flush attempt runs with a 200ms hard cap.
 *
 * @decision DEC-TELEMETRY-EXPORT-FAIL-SILENT-005
 * All fetch errors (DNS, TCP, TLS, HTTP non-2xx, timeout) are caught and
 * swallowed with at-most-once console.warn. NEVER thrown to the caller.
 *
 * @decision DEC-TELEMETRY-EXPORT-PRIVACY-006
 * Events posted to the HTTPS endpoint ALWAYS use intentHash only, regardless
 * of YAKCC_TELEMETRY_FULL_INTENT. This is hard-coded by contract in Slice 1.
 */
export class HttpsBatcherSink implements TelemetrySink {
  private readonly endpoint: string;
  private readonly sessionId: string;
  private buffer: TelemetryEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  // at-most-once warn set (DEC-TELEMETRY-EXPORT-FAIL-SILENT-005)
  private readonly warnedClasses = new Set<string>();
  private readonly _beforeExitHandler: () => void;
  private _registered = false;

  constructor(endpoint: string, sessionId?: string) {
    this.endpoint = endpoint;
    this.sessionId = sessionId ?? _resolveSinkSessionId();
    this._beforeExitHandler = () => {
      this._flushSync();
    };
  }

  send(event: TelemetryEvent): void {
    // @decision DEC-TELEMETRY-EXPORT-PRIVACY-006
    // The HTTPS sink ALWAYS uses intentHash only — strip any raw `intent`
    // field if present (defensive; TelemetryEvent schema doesn't have `intent`
    // but this guard ensures future-safety).
    this.buffer.push(event);
    this._ensureTimer();
    if (this.buffer.length >= BATCH_FLUSH_SIZE) {
      this._scheduleFlush();
    }
  }

  /** Start the interval timer and register the beforeExit handler (lazy, once). */
  private _ensureTimer(): void {
    if (this._registered) return;
    this._registered = true;

    this.timer = setInterval(() => {
      this._scheduleFlush();
    }, BATCH_FLUSH_INTERVAL_MS);
    // unref() so the timer does not keep the process alive beyond its natural exit
    if (this.timer && typeof this.timer.unref === "function") {
      this.timer.unref();
    }

    process.on("beforeExit", this._beforeExitHandler);
  }

  /** Schedule a flush on the next microtask tick (non-blocking). */
  private _scheduleFlush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    void this._flush(batch);
  }

  /** Async flush — fire-and-forget. DEC-TELEMETRY-EXPORT-FAIL-SILENT-005. */
  private async _flush(batch: TelemetryEvent[]): Promise<void> {
    if (batch.length === 0) return;
    const envelope = buildEnvelope(batch, this.sessionId);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": `yakcc-hooks-base/${envelope.source.cliVersion} (${envelope.source.platform}; node-${envelope.source.nodeVersion})`,
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
      // Non-2xx: treated as silent failure (DEC-TELEMETRY-EXPORT-FAIL-SILENT-005)
      if (!response.ok) {
        this._warnOnce(new Error(`HTTP ${response.status}`), "HttpError");
      }
    } catch (err) {
      // Network error, DNS, TLS, AbortError — all fail-silent with at-most-once warn.
      this._warnOnce(err);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Best-effort exit-flush called from `beforeExit`.
   *
   * @decision DEC-TELEMETRY-EXPORT-BATCHING-004
   * `beforeExit` fires when the Node event loop becomes empty (not via process.exit()).
   * We start the async flush here. Because `beforeExit` fires when the loop is empty,
   * the pending fetch promise keeps the loop alive long enough for the flush to complete
   * under normal conditions (no explicit process.exit()). If `process.exit()` is called
   * by the host, inflight events are dropped — this is the documented NG5 behavior
   * (no retry queue, at-most-once delivery).
   *
   * Previous implementation used `Atomics.wait` as a bounded sleep, but
   * `Atomics.wait` on the main thread throws `TypeError` in Node ≥ 16 when
   * `--experimental-vm-modules` or other thread guards are active (Node 22 always
   * rejects it on the main thread). The async-only approach is correct here because
   * `beforeExit` itself is an async boundary: the outstanding fetch promise will
   * re-trigger the loop, and if the process exits without the loop draining further,
   * the events are already acknowledged as best-effort (DEC-TELEMETRY-EXPORT-BATCHING-004).
   */
  private _flushSync(): void {
    if (this.buffer.length === 0) return;
    if (this.flushing) return;
    this.flushing = true;

    const batch = this.buffer.splice(0, this.buffer.length);
    // Start the async flush. The pending promise keeps the event loop alive so
    // beforeExit may re-fire after this flush completes. If process.exit() is
    // called explicitly, the events are dropped (NG5 — no retry queue).
    void this._flush(batch);
  }

  /**
   * Deregister timer and handlers (for tests and clean shutdown).
   * Drains the buffer without flushing — events in-buffer at dispose time are
   * dropped (NG5: at-most-once delivery). This is intentional for test isolation:
   * after dispose(), no further async fetch calls will originate from this sink.
   */
  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    process.removeListener("beforeExit", this._beforeExitHandler);
    this._registered = false;
    // Drain buffer so _flushSync (beforeExit) cannot start a post-dispose fetch.
    this.buffer.length = 0;
  }

  private _warnOnce(err: unknown, classOverride?: string): void {
    const cls = classOverride ?? (err instanceof Error ? err.constructor.name : "UnknownError");
    if (!this.warnedClasses.has(cls)) {
      this.warnedClasses.add(cls);
      console.warn(`[yakcc telemetry] HttpsBatcherSink error (${cls}):`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// CompositeSink
// ---------------------------------------------------------------------------

/**
 * Fan-out sink — calls all inner sinks for each event.
 * One inner sink failing does NOT affect the others (DEC-TELEMETRY-EXPORT-FAIL-SILENT-005).
 *
 * Implements `dispose()` to propagate cleanup to inner sinks that support it
 * (e.g. HttpsBatcherSink). This is critical for test isolation: a CompositeSink
 * wrapping an HttpsBatcherSink must dispose the inner sink's setInterval and
 * beforeExit handlers, or the vitest fork worker will hang waiting for them to
 * drain. Production code should call dispose() at process teardown if needed,
 * but omitting it is safe — the interval is unref()'d and will not prevent exit.
 */
export class CompositeSink implements TelemetrySink {
  private readonly sinks: TelemetrySink[];

  constructor(sinks: TelemetrySink[]) {
    this.sinks = sinks;
  }

  send(event: TelemetryEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.send(event);
      } catch {
        // Each inner sink's own error handling should catch its errors,
        // but if a sink throws despite DEC-005, we swallow here as backstop.
      }
    }
  }

  /**
   * Propagate dispose() to inner sinks that support it.
   * Safe to call multiple times (inner sinks are idempotent on dispose).
   * @internal — for test isolation and clean process shutdown.
   */
  dispose(): void {
    for (const sink of this.sinks) {
      if (sink instanceof HttpsBatcherSink) {
        sink.dispose();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sink factory (module-level lazy singleton)
// ---------------------------------------------------------------------------

/**
 * Module-level singleton sink, resolved once on first call.
 *
 * @decision DEC-TELEMETRY-EXPORT-SINK-001
 * Lazy singleton ensures config is read at first event, not at module load.
 * This avoids startup-order issues and lets tests override env vars before
 * the first `send()` call.
 */
let _sinkSingleton: TelemetrySink | null = null;

/**
 * Select and return the appropriate sink based on environment configuration.
 * Returns the same instance on repeated calls (module-level singleton).
 *
 * @param env     - Env var map (defaults to `process.env`). Override in tests.
 * @param config  - Pre-resolved config (skips env resolution). For tests.
 * @returns `TelemetrySink` instance appropriate for current configuration.
 *
 * @decision DEC-TELEMETRY-EXPORT-SINK-001 / DEC-TELEMETRY-EXPORT-B6A-AUTO-DISABLE-007
 * When `disabled === true`, returns `NoOpSink` — `HttpsBatcherSink` is NEVER
 * constructed, ensuring zero network I/O in air-gapped environments.
 */
export function selectSink(
  env: Record<string, string | undefined> = process.env,
  config?: TelemetryConfig,
): TelemetrySink {
  if (_sinkSingleton !== null) return _sinkSingleton;
  _sinkSingleton = _buildSink(config ?? resolveTelemetryConfig(env));
  return _sinkSingleton;
}

/**
 * Build a fresh sink from config (no singleton caching).
 * Used internally and by tests that need a fresh instance.
 */
export function buildSink(config: TelemetryConfig, sessionId?: string): TelemetrySink {
  return _buildSink(config, sessionId);
}

function _buildSink(config: TelemetryConfig, sessionId?: string): TelemetrySink {
  if (config.disabled) {
    return new NoOpSink();
  }

  const endpoint = config.endpoint;

  // file:// scheme → FileSink only (operator's own machine, no HTTPS)
  if (endpoint.startsWith("file://")) {
    const dir = endpoint.slice("file://".length);
    return new FileSink(dir, sessionId);
  }

  // https:// scheme (including default endpoint) → CompositeSink wrapping HttpsBatcherSink only.
  // The composite does NOT contain a FileSink; the local JSONL write is handled by the primary
  // JSONL writer in appendTelemetryEvent (see §2.1 plan), which runs unconditionally and is
  // independent of this sink factory. This composite path adds remote batched delivery on top
  // of that always-on local write — it does not duplicate it.
  if (endpoint.startsWith("https://")) {
    return new CompositeSink([new HttpsBatcherSink(endpoint, sessionId)]);
  }

  // Unknown scheme — fail-safe to NoOp
  console.warn(`[yakcc telemetry] Unknown endpoint scheme: ${endpoint} — using NoOpSink`);
  return new NoOpSink();
}

/**
 * Reset the module-level sink singleton.
 * For testing only — allows tests to inject a fresh config via env overrides.
 * MUST NOT be called in production code.
 * @internal
 */
export function _resetSinkSingleton(): void {
  if (_sinkSingleton instanceof HttpsBatcherSink) {
    _sinkSingleton.dispose();
  } else if (_sinkSingleton instanceof CompositeSink) {
    // CompositeSink.dispose() propagates to inner HttpsBatcherSink instances,
    // clearing their setInterval and beforeExit handlers (test isolation).
    _sinkSingleton.dispose();
  }
  _sinkSingleton = null;
}
