/**
 * @decision DEC-MCP-FETCH-ONE-CLIENT-006
 * @title Single fetch() consumer for all HTTP calls to registry.yakcc.com
 * @status decided (wi-944, bite 1)
 * @rationale
 *   One authority for: base URL resolution (YAKCC_REGISTRY_URL env override,
 *   default https://registry.yakcc.com), timeout, error mapping. All 8 tool
 *   modules call through this module — never call fetch() directly. Sacred
 *   Practice #12: one authority per operational fact.
 *
 * @decision DEC-MCP-ERROR-AS-CONTENT-004 applies to tool modules, NOT here.
 *   This layer throws HttpError so that tool modules can catch it and return
 *   structured MCP content. The HttpError carries the structured fields
 *   (status, code, bodyJson) that tool modules need to produce the content block.
 *
 * @decision DEC-MCP-STDERR-LOGGING-005
 *   Diagnostic output goes to stderr. This module does not log — callers log.
 */

export interface HttpClientOpts {
  /** Base URL of the registry, e.g. https://registry.yakcc.com */
  readonly baseUrl: string;
  /** Request timeout in milliseconds. Default: 30_000. */
  readonly timeoutMs: number;
}

/**
 * Error thrown by HttpClient for all non-2xx responses and transport failures.
 * Tool modules catch this and convert it to MCP content per DEC-MCP-ERROR-AS-CONTENT-004.
 */
export class HttpError extends Error {
  /** HTTP status code (0 for timeout / non-HTTP failures). */
  readonly status: number;
  /**
   * Machine-readable error code.
   * On non-2xx responses: taken from response body `{ error: { code } }` or
   * top-level `{ error: "<string>" }` field if present.
   * Synthetic codes used by this client:
   *   - "timeout"            — AbortController fired before response arrived
   *   - "non_json_response"  — 2xx response body was not valid JSON
   *   - "network_error"      — fetch() threw (DNS, connection refused, etc.)
   */
  readonly code: string;
  /** Raw parsed response body on non-2xx; undefined on transport/parse errors. */
  readonly bodyJson?: unknown;

  constructor(opts: { status: number; code: string; message: string; bodyJson?: unknown }) {
    super(opts.message);
    this.name = "HttpError";
    this.status = opts.status;
    this.code = opts.code;
    if (opts.bodyJson !== undefined) {
      this.bodyJson = opts.bodyJson;
    }
  }
}

/** Extract a server-provided error code from a parsed JSON body, or return fallback. */
function extractCode(body: unknown, fallback: string): string {
  if (body === null || typeof body !== "object") return fallback;
  const b = body as Record<string, unknown>;
  // Shape 1: { "error": { "code": "...", "message": "..." } }
  if (typeof b.error === "object" && b.error !== null) {
    const inner = b.error as Record<string, unknown>;
    if (typeof inner.code === "string" && inner.code.length > 0) {
      return inner.code;
    }
  }
  // Shape 2: { "error": "<code_string>" }
  if (typeof b.error === "string" && b.error.length > 0) {
    return b.error;
  }
  return fallback;
}

/** Extract a server-provided error message from a parsed JSON body, or return fallback. */
function extractMessage(body: unknown, fallback: string): string {
  if (body === null || typeof body !== "object") return fallback;
  const b = body as Record<string, unknown>;
  // Shape 1: { "error": { "message": "..." } }
  if (typeof b.error === "object" && b.error !== null) {
    const inner = b.error as Record<string, unknown>;
    if (typeof inner.message === "string" && inner.message.length > 0) {
      return inner.message;
    }
  }
  // Shape 2: { "message": "..." }
  if (typeof b.message === "string" && b.message.length > 0) {
    return b.message;
  }
  return fallback;
}

export class HttpClient {
  private readonly opts: HttpClientOpts;

  constructor(opts: HttpClientOpts) {
    this.opts = opts;
  }

  /**
   * GET <baseUrl>/<path>
   * Returns parsed JSON body on 2xx.
   * Throws HttpError on non-2xx, timeout, parse failure, or network error.
   */
  async get<T>(path: string): Promise<T> {
    const url = `${this.opts.baseUrl}/${path.replace(/^\//, "")}`;
    return this.request<T>(url, { method: "GET" });
  }

  /**
   * POST <baseUrl>/<path> with JSON-encoded body.
   * Returns parsed JSON body on 2xx.
   * Throws HttpError on non-2xx, timeout, parse failure, or network error.
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.opts.baseUrl}/${path.replace(/^\//, "")}`;
    return this.request<T>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.opts.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (cause) {
      clearTimeout(timer);
      // AbortError means the timeout fired
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new HttpError({
          status: 0,
          code: "timeout",
          message: `Request timed out after ${this.opts.timeoutMs}ms: ${url}`,
        });
      }
      throw new HttpError({
        status: 0,
        code: "network_error",
        message: `Network error: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    } finally {
      clearTimeout(timer);
    }

    // Parse body as JSON regardless of status (needed for error extraction)
    let parsed: unknown;
    let parseError = false;
    try {
      parsed = await response.json();
    } catch {
      parseError = true;
      parsed = undefined;
    }

    if (!response.ok) {
      const code = extractCode(parsed, `http_${response.status}`);
      const message = extractMessage(parsed, `HTTP ${response.status} ${response.statusText}`);
      throw new HttpError({
        status: response.status,
        code,
        message,
        bodyJson: parsed,
      });
    }

    // 2xx but body was not valid JSON
    if (parseError) {
      throw new HttpError({
        status: response.status,
        code: "non_json_response",
        message: `Server returned HTTP ${response.status} but body was not valid JSON`,
      });
    }

    return parsed as T;
  }
}

/** Default registry base URL (may be overridden via YAKCC_REGISTRY_URL). */
export const DEFAULT_REGISTRY_URL = "https://registry.yakcc.com";

/**
 * Construct an HttpClient using YAKCC_REGISTRY_URL env var with fallback
 * to DEFAULT_REGISTRY_URL.
 *
 * Precedence: explicit baseUrl arg > YAKCC_REGISTRY_URL env > DEFAULT_REGISTRY_URL.
 * The caller may pass an explicit baseUrl (used in tests and for per-call overrides).
 */
export function createHttpClient(opts?: { baseUrl?: string; timeoutMs?: number }): HttpClient {
  const baseUrl = opts?.baseUrl ?? process.env.YAKCC_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  return new HttpClient({ baseUrl, timeoutMs });
}
