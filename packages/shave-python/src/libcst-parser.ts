// SPDX-License-Identifier: MIT
//
// libcst-parser.ts — subprocess wrapper around Python's libcst (WI-782 slice 1).
//
// Invokes `python3 scripts/libcst-parse.py` as a child process, feeds Python
// source over stdin, and reads a JSON AST envelope from stdout.  The wire
// shape is intentionally minimal in this slice — only enough to prove the
// subprocess plumbing and let slice 2's mapping pass consume real ASTs.
//
// All Python runtime concerns (libcst install, version pinning, performance
// tuning) are gated behind this single seam.  Tests inject a mock interpreter
// via `LibcstParseOptions.spawnImpl` so the suite runs in pure-Node CI.
//
// @decision DEC-POLYGLOT-SHAVE-PY-SUBPROCESS-001 (WI-782 slice 1)
// @title Subprocess-per-file libcst invocation (no daemon, no batching) in MVP
// @status accepted (WI-782 slice 1)
// @rationale
//   The MVP performance budget allows < 500ms per file (per #782).  A fresh
//   `python3` process is ~50ms cold-start on commodity hardware; libcst parse
//   of a typical function adds ~5–20ms.  Total budget is comfortably met.
//   Daemonizing libcst (long-running Python worker) is a perf optimization for
//   a later slice once real corpus measurements show it's needed.

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Thrown when the libcst subprocess fails for any reason — Python not on
 * PATH, libcst not installed, parse failure, non-zero exit, or stdout that
 * cannot be parsed as JSON.  The .message carries an actionable remediation
 * hint where possible (e.g. "pip install libcst").
 *
 * Slice 4 will reroute parse-side failures to `CannotRaiseToIRError` from
 * `@yakcc/contracts` where appropriate (syntactically invalid Python is not
 * the same class of failure as "Python is not installed").
 */
export class AdapterSubprocessError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "AdapterSubprocessError";
  }
}

/**
 * A node in the JSON AST envelope emitted by libcst-parse.py.
 *
 * Intentionally a recursive bag-of-fields rather than a tagged union — slice
 * 1 is the wire contract only; slice 2 narrows this into a discriminated
 * union as the mapping table is implemented.
 */
export interface PythonAstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * Top-level shape of the JSON envelope.
 */
export interface LibcstParseResult {
  /** Schema version of the envelope. Slice 1 ships v=1. */
  readonly version: 1;
  /** Root module node from libcst. */
  readonly module: PythonAstNode;
}

/**
 * Injectable subprocess constructor — defaults to `node:child_process.spawn`.
 * Tests pass a fake that emits a known stdout/stderr/exit-code triple so the
 * suite does not require Python to be installed.
 *
 * Matches the relevant subset of node's spawn signature so the default
 * implementation slots in without an adapter.
 */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options?: { readonly env?: NodeJS.ProcessEnv },
) => ChildProcess;

export interface LibcstParseOptions {
  /**
   * Python interpreter to invoke.  Defaults to `process.env.YAKCC_PY ?? "python3"`.
   * Slice 4 honors `pyproject.toml` venv pointers when present.
   */
  readonly pythonExecutable?: string;
  /**
   * Absolute path to `scripts/libcst-parse.py`.  Defaults to the script
   * shipped with this package.
   */
  readonly scriptPath?: string;
  /**
   * Injectable subprocess factory (for tests).  Defaults to `spawn` from
   * `node:child_process`.
   */
  readonly spawnImpl?: SpawnImpl;
}

const DEFAULT_PYTHON = "python3";

/** Resolve the bundled `scripts/libcst-parse.py` from this module's location. */
function defaultScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Built layout: dist/libcst-parser.js → ../scripts/libcst-parse.py
  // Source layout: src/libcst-parser.ts → ../scripts/libcst-parse.py
  return resolve(here, "..", "scripts", "libcst-parse.py");
}

/**
 * Parse a Python source string into a `LibcstParseResult` by invoking the
 * libcst subprocess.
 *
 * Behavior:
 *   - Python source is fed over stdin (UTF-8).
 *   - stdout is parsed as JSON and shape-checked against `LibcstParseResult`.
 *   - Non-zero exit → AdapterSubprocessError carrying exitCode + stderr.
 *   - Spawn failure (e.g. python not on PATH) → AdapterSubprocessError with
 *     a remediation hint pointing at the runtime requirements.
 *   - JSON parse failure → AdapterSubprocessError (stderr contains the raw bytes).
 */
export async function parsePythonSource(
  source: string,
  options: LibcstParseOptions = {},
): Promise<LibcstParseResult> {
  const python =
    options.pythonExecutable ?? process.env.YAKCC_PY ?? DEFAULT_PYTHON;
  const script = options.scriptPath ?? defaultScriptPath();
  const spawnFn = options.spawnImpl ?? (spawn as unknown as SpawnImpl);

  return new Promise<LibcstParseResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawnFn(python, [script]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rejectPromise(
        new AdapterSubprocessError(
          `Failed to spawn ${python}: ${msg}. Ensure Python 3.10+ is installed and on PATH (set YAKCC_PY to override).`,
          null,
          "",
        ),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err: Error) => {
      rejectPromise(
        new AdapterSubprocessError(
          `${python} subprocess error: ${err.message}. Ensure Python 3.10+ is installed and on PATH.`,
          null,
          Buffer.concat(stderrChunks).toString("utf-8"),
        ),
      );
    });

    child.on("close", (code: number | null) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      if (code !== 0) {
        rejectPromise(
          new AdapterSubprocessError(
            `${python} exited with code ${String(code)}. stderr: ${stderr.trim() || "(empty)"}. If libcst is missing, run: pip install libcst`,
            code,
            stderr,
          ),
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rejectPromise(
          new AdapterSubprocessError(
            `libcst-parse stdout was not valid JSON: ${msg}`,
            code,
            stdout,
          ),
        );
        return;
      }
      const validationError = validateParseResult(parsed);
      if (validationError !== null) {
        rejectPromise(new AdapterSubprocessError(validationError, code, stderr));
        return;
      }
      resolvePromise(parsed as LibcstParseResult);
    });

    child.stdin?.end(source, "utf-8");
  });
}

/**
 * Lightweight runtime shape check.  Returns null if `value` matches
 * `LibcstParseResult`, else a descriptive error string.
 */
function validateParseResult(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "libcst-parse output: expected a non-null object";
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) {
    return `libcst-parse output: schema version must be 1, got ${String(obj.version)}`;
  }
  if (obj.module === null || typeof obj.module !== "object" || Array.isArray(obj.module)) {
    return 'libcst-parse output: "module" must be a non-null object';
  }
  if (typeof (obj.module as Record<string, unknown>).type !== "string") {
    return 'libcst-parse output: "module.type" must be a string';
  }
  return null;
}
