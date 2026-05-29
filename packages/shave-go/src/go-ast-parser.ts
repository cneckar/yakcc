// SPDX-License-Identifier: MIT
//
// go-ast-parser.ts -- subprocess wrapper around Go's go/ast standard library (WI-870 slice 1).
//
// Invokes `go run scripts/go-ast-parse.go` as a child process, feeds Go
// source over stdin, and reads a JSON AST envelope from stdout.  The wire
// shape is intentionally minimal in this slice -- only enough to prove the
// subprocess plumbing and let the signature parser consume real function
// declarations.
//
// All Go runtime concerns (Go toolchain install, version pinning, performance
// tuning) are gated behind this single seam.  Tests inject a mock interpreter
// via `GoAstParseOptions.spawnImpl` so the suite runs in pure-Node CI with no
// Go toolchain installed.
//
// @decision DEC-POLYGLOT-GO-SUBPROCESS-001 (WI-870 slice 1)
// @title Subprocess-per-file go/ast invocation (no daemon, no batching) in MVP
// @status accepted (WI-870 slice 1)
// @rationale
//   The MVP performance budget allows < 500ms per file (per #870, mirroring #782).
//   A fresh `go run` process is ~100-200ms cold-start on commodity hardware; go/ast
//   parse of a typical function adds < 5ms.  Total budget is comfortably met for
//   the MVP corpus.  Daemonizing the Go worker is a perf optimization for a later
//   slice once real corpus measurements show it is needed.  Using go/ast (stdlib)
//   rather than tree-sitter-go (Node binding) avoids a native addon build step in
//   CI, keeping the Node-side purely JS/TS.

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Thrown when the go/ast subprocess fails for any reason -- Go not on PATH,
 * parse failure, non-zero exit, or stdout that cannot be parsed as JSON.
 * The .message carries an actionable remediation hint where possible
 * (e.g. "install the Go toolchain from https://go.dev/dl/").
 *
 * Slice 4 will reroute parse-side failures to `CannotRaiseToIRError` from
 * `@yakcc/contracts` where appropriate (syntactically invalid Go is not the
 * same class of failure as "Go is not installed").
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
 * A Go function parameter as represented in the JSON envelope.
 */
export interface GoAstParam {
  /** Parameter name (may be empty for unnamed return params). */
  readonly name: string;
  /** Go type as a source string, e.g. "int", "[]string", "map[string]bool". */
  readonly goType: string;
}

/**
 * A Go generic type parameter (Go 1.18+).
 */
export interface GoAstTypeParam {
  /** Type parameter name, e.g. "T". */
  readonly name: string;
  /** Constraint as a source string, e.g. "comparable", "any". */
  readonly constraint: string;
}

/**
 * A single function declaration from the Go AST envelope.
 *
 * This is the wire shape produced by scripts/go-ast-parse.go.  It contains
 * exactly what slice 1 signature parser needs; body AST is deferred to slice 2.
 */
export interface GoAstFunction {
  /** Function name as written in Go source. */
  readonly name: string;
  /** Receiver type source string for methods, or null for top-level funcs. */
  readonly receiver: string | null;
  /** Generic type parameters (Go 1.18+); empty array for non-generic funcs. */
  readonly typeParams: readonly GoAstTypeParam[];
  /** Input parameters in declaration order. */
  readonly params: readonly GoAstParam[];
  /**
   * Return parameters.  Named returns carry a name; unnamed returns have
   * name === "".  Multiple returns are represented as an array.
   */
  readonly results: readonly GoAstParam[];
  /**
   * Verbatim function body source text (for slice 2 body raiser).
   * May be null if the function is a forward declaration or external.
   */
  readonly bodySource: string | null;
}

/**
 * Top-level shape of the JSON envelope emitted by scripts/go-ast-parse.go.
 */
export interface GoAstParseResult {
  /** Schema version of the envelope. Slice 1 ships v=1. */
  readonly version: 1;
  /** Package name declared at the top of the file. */
  readonly packageName: string;
  /** Top-level function declarations. */
  readonly functions: readonly GoAstFunction[];
}

/**
 * Injectable subprocess constructor -- defaults to `node:child_process.spawn`.
 * Tests pass a fake that emits a known stdout/stderr/exit-code triple so the
 * suite does not require Go to be installed.
 *
 * Matches the relevant subset of node spawn signature so the default
 * implementation slots in without an adapter.
 */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options?: { readonly env?: NodeJS.ProcessEnv },
) => ChildProcess;

export interface GoAstParseOptions {
  /**
   * Go executable to invoke.  Defaults to `process.env.YAKCC_GO ?? "go"`.
   * Slice 4 will honor `go.mod` toolchain directives when present.
   */
  readonly goExecutable?: string;
  /**
   * Absolute path to `scripts/go-ast-parse.go`.  Defaults to the script
   * shipped with this package.
   */
  readonly scriptPath?: string;
  /**
   * Injectable subprocess factory (for tests).  Defaults to `spawn` from
   * `node:child_process`.
   */
  readonly spawnImpl?: SpawnImpl;
}

const DEFAULT_GO = "go";

/** Resolve the bundled `scripts/go-ast-parse.go` from this module location. */
function defaultScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Built layout: dist/go-ast-parser.js -> ../../scripts/go-ast-parse.go
  // Source layout: src/go-ast-parser.ts -> ../../scripts/go-ast-parse.go
  return resolve(here, "..", "..", "scripts", "go-ast-parse.go");
}

/**
 * Parse a Go source string into a `GoAstParseResult` by invoking the
 * go/ast subprocess.
 *
 * Behavior:
 *   - Go source is fed over stdin (UTF-8).
 *   - stdout is parsed as JSON and shape-checked against `GoAstParseResult`.
 *   - Non-zero exit -> AdapterSubprocessError carrying exitCode + stderr.
 *   - Spawn failure (e.g. go not on PATH) -> AdapterSubprocessError with a
 *     remediation hint pointing at https://go.dev/dl/.
 *   - JSON parse failure -> AdapterSubprocessError (stderr contains the raw bytes).
 */
export async function parseGoSource(
  source: string,
  options: GoAstParseOptions = {},
): Promise<GoAstParseResult> {
  const goExe = options.goExecutable ?? process.env.YAKCC_GO ?? DEFAULT_GO;
  const script = options.scriptPath ?? defaultScriptPath();
  const spawnFn = options.spawnImpl ?? (spawn as unknown as SpawnImpl);

  return new Promise<GoAstParseResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawnFn(goExe, ["run", script]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rejectPromise(
        new AdapterSubprocessError(
          `Failed to spawn ${goExe}: ${msg}. Ensure the Go toolchain (>=1.18) is installed and on PATH (download from https://go.dev/dl/ or set YAKCC_GO to override).`,
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
          `${goExe} subprocess error: ${err.message}. Ensure the Go toolchain (>=1.18) is installed and on PATH.`,
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
            `${goExe} exited with code ${String(code)}. stderr: ${stderr.trim() || "(empty)"}. If Go is missing, install from https://go.dev/dl/`,
            code,
            stderr,
          ),
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        rejectPromise(
          new AdapterSubprocessError(
            `go-ast-parse stdout was not valid JSON: ${msg}`,
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
      resolvePromise(parsed as GoAstParseResult);
    });

    child.stdin?.end(source, "utf-8");
  });
}

/**
 * Lightweight runtime shape check.  Returns null if `value` matches
 * `GoAstParseResult`, else a descriptive error string.
 */
function validateParseResult(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "go-ast-parse output: expected a non-null object";
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) {
    return `go-ast-parse output: schema version must be 1, got ${String(obj.version)}`;
  }
  if (typeof obj.packageName !== "string") {
    return 'go-ast-parse output: "packageName" must be a string';
  }
  if (!Array.isArray(obj.functions)) {
    return 'go-ast-parse output: "functions" must be an array';
  }
  return null;
}
