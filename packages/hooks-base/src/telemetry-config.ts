// SPDX-License-Identifier: MIT
/**
 * telemetry-config.ts — Env-var configuration resolver for the telemetry export sink layer.
 *
 * @decision DEC-TELEMETRY-EXPORT-CONFIG-002
 * @title Telemetry export env-var precedence: disabled → endpoint string → default
 * @status accepted
 * @rationale
 *   A single resolver function (`resolveTelemetryConfig`) owns all env-var parsing for
 *   the telemetry export pipeline. No call site outside this module resolves telemetry
 *   export configuration directly from `process.env`. This prevents parallel-authority
 *   drift (Sacred Practice #12).
 *
 *   Precedence (seven cases, DEC-TELEMETRY-EXPORT-CONFIG-002):
 *   1. YAKCC_TELEMETRY_DISABLED=1 → {disabled: true}  (terminal; no endpoint parsed)
 *   2. YAKCC_TELEMETRY_ENDPOINT="off" → {disabled: true}
 *   3. YAKCC_TELEMETRY_ENDPOINT="file://<path>" → {disabled: false, endpoint: "file://<path>"}
 *      → File sink only (no HTTPS)
 *   4. YAKCC_TELEMETRY_ENDPOINT="https://<host>" (non-default) → {disabled: false, endpoint: url}
 *      → Composite(File + HttpsBatcher(host))
 *   5. YAKCC_TELEMETRY_ENDPOINT="https://metrics.yakcc.com" → same as case 4 (default host)
 *   6. YAKCC_TELEMETRY_ENDPOINT absent or empty → {disabled: false, endpoint: DEFAULT_ENDPOINT}
 *      → Composite(File + HttpsBatcher(DEFAULT_ENDPOINT))
 *   7. YAKCC_TELEMETRY_FULL_INTENT=1 → fullIntent: true (File sink only; HTTPS always hashes)
 *
 *   DEC-TELEMETRY-EXPORT-PRIVACY-006: HTTPS sink always uses intentHash; fullIntent applies
 *   to File sink only. The HTTPS path never emits raw intent text in Slice 1.
 */

/**
 * Default HTTPS endpoint for telemetry export.
 * The receiver at this URL is built separately (NG1 from the plan — receiver is out of scope).
 * The client ships first; if the endpoint is unreachable the sink fails-silent (DEC-005).
 */
export const DEFAULT_TELEMETRY_ENDPOINT = "https://metrics.yakcc.com";

/**
 * Resolved telemetry export configuration.
 * Produced by `resolveTelemetryConfig`; consumed by `selectSink` in telemetry-sink.ts.
 */
export type TelemetryConfig = {
  /** If true, selectSink() must return NoOpSink — no I/O at all. */
  readonly disabled: boolean;
  /**
   * Where to send telemetry:
   * - `DEFAULT_TELEMETRY_ENDPOINT` ("https://metrics.yakcc.com") → Composite(File + HttpsBatcher)
   * - `"https://<other-host>"` → Composite(File + HttpsBatcher(<other-host>))
   * - `"file://<path>"` → FileSink only
   * Only meaningful when `disabled === false`.
   */
  readonly endpoint: string;
  /**
   * If true, File sink may emit raw `intent` text.
   * HTTPS sink ALWAYS uses `intentHash` regardless of this flag (DEC-TELEMETRY-EXPORT-PRIVACY-006).
   * Only meaningful when `disabled === false`.
   */
  readonly fullIntent: boolean;
};

/**
 * Resolve telemetry export configuration from an environment variable map.
 *
 * @param env - Env var map (defaults to `process.env`). Injectable for tests.
 * @returns Resolved `TelemetryConfig`.
 *
 * @decision DEC-TELEMETRY-EXPORT-CONFIG-002
 * All seven precedence cases are handled here and nowhere else.
 * Tests in `telemetry-config.test.ts` verify all seven cases.
 */
export function resolveTelemetryConfig(
  env: Record<string, string | undefined> = process.env,
): TelemetryConfig {
  const fullIntent = env.YAKCC_TELEMETRY_FULL_INTENT === "1";

  // Case 1: YAKCC_TELEMETRY_DISABLED=1 → terminal disable
  if (env.YAKCC_TELEMETRY_DISABLED === "1") {
    return { disabled: true, endpoint: DEFAULT_TELEMETRY_ENDPOINT, fullIntent };
  }

  const rawEndpoint = env.YAKCC_TELEMETRY_ENDPOINT;

  // Case 2: endpoint="off" → explicit opt-out string
  if (rawEndpoint === "off") {
    return { disabled: true, endpoint: DEFAULT_TELEMETRY_ENDPOINT, fullIntent };
  }

  // Cases 3-6: endpoint present or absent
  const endpoint =
    rawEndpoint !== undefined && rawEndpoint !== "" ? rawEndpoint : DEFAULT_TELEMETRY_ENDPOINT;

  return { disabled: false, endpoint, fullIntent };
}
