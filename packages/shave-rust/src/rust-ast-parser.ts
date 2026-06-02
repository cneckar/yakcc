// SPDX-License-Identifier: Apache-2.0
//
// rust-ast-parser.ts -- subprocess wrapper around the syn-based Rust helper
// (rust-ast-parse/src/main.rs, WI-868 slice 1).
//
// Invokes `cargo run --manifest-path <path>/Cargo.toml` (or a pre-built binary
// at `rust-ast-parse/target/release/rust-ast-parse`) as a child process, feeds
// Rust source over stdin, and reads a JSON AST envelope from stdout.
//
// The wire shape is intentionally minimal — only enough to prove the subprocess
// plumbing and let the signature parser consume real function declarations.
// Slice 2 will add structured body AST wire types.
//
// All Rust toolchain concerns (cargo install, version pinning, performance
// tuning) are gated behind this single seam.  Tests inject a mock interpreter
// via `RustAstParseOptions.spawnImpl` so the suite runs in pure-Node CI with no
// Rust toolchain installed.
//
// @decision DEC-POLYGLOT-RUST-SUBPROCESS-001 (WI-868 slice 1)
// @title Subprocess-per-file syn invocation (no daemon, no batching) in MVP
// @status accepted (WI-868 slice 1)
// @rationale
//   Mirrors DEC-POLYGLOT-GO-SUBPROCESS-001 exactly.  The MVP performance budget
//   allows <500ms per file.  A fresh cargo-run process is ~200-500ms cold-start
//   on commodity hardware (first compile is one-time; the binary is cached in
//   target/).  syn parse of a typical function adds <5ms.  Using syn (the
//   canonical Rust AST library) rather than a Node native addon avoids a
//   native-addon build step in CI, keeping the Node side purely JS/TS.
//   Daemonizing the Rust worker is a perf optimisation for a later slice once
//   real corpus measurements show it is needed.

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Thrown when the syn subprocess fails for any reason — Rust/cargo not on PATH,
 * parse failure, non-zero exit, or stdout that cannot be parsed as JSON.
 * The .message carries an actionable remediation hint where possible
 * (e.g. "install the Rust toolchain from https://rustup.rs/").
 *
 * Slice 4 will reroute parse-side failures to `CannotRaiseToIRError` from
 * `@yakcc/contracts` where appropriate (syntactically invalid Rust is not the
 * same class of failure as "cargo is not installed").
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
 * A Rust function parameter as represented in the JSON envelope.
 */
export interface RustAstParam {
  /** Parameter name as written in Rust source. */
  readonly name: string;
  /** Rust type as a source string, e.g. "i32", "String", "Vec<u8>". */
  readonly rustType: string;
}

/**
 * A single function declaration from the Rust AST envelope (version 1).
 *
 * This is the wire shape produced by rust-ast-parse/src/main.rs.
 * Slice 2 will add the structured body AST wire types.
 */
export interface RustAstFunction {
  /** Function name as written in Rust source. */
  readonly name: string;
  /** True if the function is declared `pub`. */
  readonly isPub: boolean;
  /** Input parameters in declaration order. */
  readonly params: readonly RustAstParam[];
  /**
   * Return type as a Rust source string.  Empty string means no explicit
   * return (i.e. the function returns `()`).
   */
  readonly returnType: string;
  /**
   * Verbatim function body source text (for diagnostic and future body raise).
   * May be null if the function has no body (trait method declaration).
   */
  readonly bodySource: string | null;
}

/**
 * Top-level shape of the JSON envelope emitted by rust-ast-parse/src/main.rs.
 */
export interface RustAstParseResult {
  /** Schema version of the envelope.  Slice 1 ships v=1. */
  readonly version: 1;
  /** Crate / file name derived from the input (always "stdin.rs" for stdin). */
  readonly crateName: string;
  /** Top-level function declarations. */
  readonly functions: readonly RustAstFunction[];
}

/**
 * Injectable subprocess constructor — defaults to `node:child_process.spawn`.
 * Tests pass a fake that emits a known stdout/stderr/exit-code triple so the
 * suite does not require Rust/cargo to be installed.
 *
 * Matches the relevant subset of the Node spawn signature so the default
 * implementation slots in without an adapter.
 */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options?: { readonly env?: NodeJS.ProcessEnv },
) => ChildProcess;

export interface RustAstParseOptions {
  /**
   * Cargo executable to invoke when running via `cargo run`.
   * Defaults to `process.env.YAKCC_CARGO ?? "cargo"`.
   */
  readonly cargoExecutable?: string;
  /**
   * Absolute path to the rust-ast-parse Cargo.toml.
   * Defaults to the manifest shipped with this package.
   */
  readonly manifestPath?: string;
  /**
   * Injectable subprocess factory (for tests).  Defaults to `spawn` from
   * `node:child_process`.
   */
  readonly spawnImpl?: SpawnImpl;
}

const DEFAULT_CARGO = "cargo";

/**
 * Resolve the bundled `rust-ast-parse/Cargo.toml` from this module location.
 *
 * @decision DEC-SHAVE-RUST-MANIFEST-PATH-001
 * @title Resolve Cargo.toml path via import.meta.url with explicit dist-layout depth
 * @status accepted (WI-868)
 * @rationale
 *   The dist/ layout places the compiled file at packages/shave-rust/dist/rust-ast-parser.js.
 *   Walking up 2 levels from dist/ reaches packages/shave-rust/ where
 *   rust-ast-parse/Cargo.toml lives.  Using import.meta.url (rather than __dirname
 *   or process.cwd) is the ESM-safe approach that survives symlinks, worktrees,
 *   and external callers who import the package from node_modules.
 */
function defaultManifestPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Built layout:  packages/shave-rust/dist/rust-ast-parser.js
  //   dist/       → [1] packages/shave-rust/
  //   dist/../..  → [2] packages/  (one more up)
  // But rust-ast-parse/ is a sibling of dist/ inside shave-rust/, so:
  //   dist/..     → packages/shave-rust/
  return resolve(here, "..", "rust-ast-parse", "Cargo.toml");
}

/**
 * Parse a Rust source string into a `RustAstParseResult` by invoking the
 * syn subprocess.
 *
 * Behavior:
 *   - Rust source is fed over stdin (UTF-8).
 *   - stdout is parsed as JSON and shape-checked against `RustAstParseResult`.
 *   - Non-zero exit -> AdapterSubprocessError carrying exitCode + stderr.
 *   - Spawn failure (e.g. cargo not on PATH) -> AdapterSubprocessError with a
 *     remediation hint pointing at https://rustup.rs/.
 *   - JSON parse failure -> AdapterSubprocessError (stderr contains the raw bytes).
 */
export async function parseRustSource(
  source: string,
  options: RustAstParseOptions = {},
): Promise<RustAstParseResult> {
  const cargoExe = options.cargoExecutable ?? process.env.YAKCC_CARGO ?? DEFAULT_CARGO;
  const manifest = options.manifestPath ?? defaultManifestPath();
  const spawnFn = options.spawnImpl ?? (spawn as unknown as SpawnImpl);

  return new Promise<RustAstParseResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawnFn(cargoExe, ["run", "--quiet", "--manifest-path", manifest]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rejectPromise(
        new AdapterSubprocessError(
          `Failed to spawn ${cargoExe}: ${msg}. Ensure the Rust toolchain is installed and on PATH (see https://rustup.rs/ or set YAKCC_CARGO to override).`,
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
          `${cargoExe} subprocess error: ${err.message}. Ensure the Rust toolchain is installed and on PATH (see https://rustup.rs/).`,
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
            `${cargoExe} exited with code ${String(code)}. stderr: ${stderr.trim() || "(empty)"}. If Rust/cargo is missing, install from https://rustup.rs/`,
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
            `rust-ast-parse stdout was not valid JSON: ${msg}`,
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
      resolvePromise(parsed as RustAstParseResult);
    });

    // Trap EPIPE on stdin: if the subprocess exits before consuming all input
    // (e.g. parse error causes early exit), Node emits 'error' on the write
    // stream.  Without this handler the event is unhandled and crashes the host
    // process.  The non-zero exit code is surfaced through the 'close' handler.
    child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") return; // subprocess exited early — handled by exit-code path
      // Non-EPIPE stdin errors: let the existing 'error' handler on `child` surface them.
    });

    child.stdin?.end(source, "utf-8");
  });
}

/**
 * Lightweight runtime shape check.  Returns null if `value` matches
 * `RustAstParseResult`, else a descriptive error string.
 */
function validateParseResult(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "rust-ast-parse output: expected a non-null object";
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) {
    return `rust-ast-parse output: schema version must be 1, got ${String(obj.version)}`;
  }
  if (typeof obj.crateName !== "string") {
    return 'rust-ast-parse output: "crateName" must be a string';
  }
  if (!Array.isArray(obj.functions)) {
    return 'rust-ast-parse output: "functions" must be an array';
  }
  return null;
}
