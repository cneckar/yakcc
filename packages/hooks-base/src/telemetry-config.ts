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
 *   4. YAKCC_TELEMETRY_ENDPOINT="https://<host>/<path>" (non-default) → {disabled: false, endpoint: url}
 *      → Composite(File + HttpsBatcher(url)) — full URL including path is the operator's responsibility
 *   5. YAKCC_TELEMETRY_ENDPOINT="https://metrics.yakcc.com/v1/telemetry/ingest" → same as case 4 (default URL)
 *   6. YAKCC_TELEMETRY_ENDPOINT absent or empty → {disabled: false, endpoint: DEFAULT_TELEMETRY_ENDPOINT}
 *      → Composite(File + HttpsBatcher(DEFAULT_TELEMETRY_ENDPOINT))
 *   7. YAKCC_TELEMETRY_FULL_INTENT=1 → fullIntent: true (File sink only; HTTPS always hashes)
 *
 *   DEC-TELEMETRY-EXPORT-PRIVACY-006: HTTPS sink always uses intentHash; fullIntent applies
 *   to File sink only. The HTTPS path never emits raw intent text in Slice 1.
 *
 * @decision DEC-WPE-TELEMETRY-PATH-001
 * @title DEFAULT_TELEMETRY_ENDPOINT bakes the full ingest path (WI-WPE-A, wire-public-endpoints)
 * @status accepted
 * @rationale
 *   The yakforge receiver (`@yakforge/hosted-registry`) only serves `POST /v1/telemetry/ingest`.
 *   A POST to bare `/` returns 404. Because `HttpsBatcherSink` is fail-silent
 *   (DEC-TELEMETRY-EXPORT-FAIL-SILENT-005), the path mismatch produces silent total telemetry
 *   loss the moment `metrics.yakcc.com` goes live.
 *
 *   HOW chosen: bake the full ingest URL into `DEFAULT_TELEMETRY_ENDPOINT` (not append in the sink,
 *   not a config-derived path). Rationale:
 *   - The constant becomes the complete, correct URL — no hidden path-appending magic in the sink.
 *   - Operators using `YAKCC_TELEMETRY_ENDPOINT` supply a full URL (their server, their path).
 *     This is coherent: overriders control the path on their server.
 *   - The 7-case precedence model stays unchanged: cases 4/5 pass the full URL through as-is,
 *     case 6 (absent/empty) falls back to the full DEFAULT URL.
 *   - Zero changes to HttpsBatcherSink, CompositeSink, or telemetry-wire.ts (cross-repo contract).
 *
 *   Custom-endpoint coherence: `YAKCC_TELEMETRY_ENDPOINT="https://example.test/v1/telemetry/ingest"`
 *   works as-is. Operators running a custom server include the ingest path in their override.
 *   Cross-refs: WI-WPE-A; DEC-TELEMETRY-EXPORT-CONFIG-002; DEC-TELEMETRY-EXPORT-FAIL-SILENT-005;
 *   DEC-TELEMETRY-EXPORT-PRIVACY-006; yakforge DEC-HR-HTTP-ROUTER.
 */

/**
 * Default HTTPS endpoint for telemetry export.
 *
 * @decision DEC-WPE-TELEMETRY-PATH-001
 * Full ingest URL including the `/v1/telemetry/ingest` path required by the yakforge receiver
 * (`@yakforge/hosted-registry`, DEC-HR-HTTP-ROUTER). The receiver does NOT serve `POST /` —
 * a path-less POST returns 404. Since `HttpsBatcherSink` is fail-silent (DEC-005), a missing
 * path would produce silent total telemetry loss. Baking the full path here keeps the model
 * clean: the constant IS the correct POST target; sink code requires no path manipulation.
 * Custom overrides (`YAKCC_TELEMETRY_ENDPOINT`) must supply the full URL including path.
 */
export const DEFAULT_TELEMETRY_ENDPOINT = "https://metrics.yakcc.com/v1/telemetry/ingest";

/**
 * Resolved telemetry export configuration.
 * Produced by `resolveTelemetryConfig`; consumed by `selectSink` in telemetry-sink.ts.
 */
export type TelemetryConfig = {
  /** If true, selectSink() must return NoOpSink — no I/O at all. */
  readonly disabled: boolean;
  /**
   * Where to send telemetry (full URL including path):
   * - `DEFAULT_TELEMETRY_ENDPOINT` ("https://metrics.yakcc.com/v1/telemetry/ingest") → Composite(HttpsBatcher)
   * - `"https://<host>/<path>"` → Composite(HttpsBatcher(<full-url>)) — operator supplies full URL
   * - `"file://<path>"` → FileSink only
   * Only meaningful when `disabled === false`.
   * DEC-WPE-TELEMETRY-PATH-001: the full ingest path is the caller's responsibility.
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
