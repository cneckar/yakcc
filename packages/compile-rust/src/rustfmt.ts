// SPDX-License-Identifier: Apache-2.0
//
// rustfmt.ts -- injectable-spawn seam for rustfmt formatting.
//
// Default: spawns `rustfmt --edition 2021` via node:child_process.spawn.
// Tests inject a no-op mock so the suite runs in pure-Node CI with no Rust toolchain.
//
// Mirrors the subprocess lifecycle pattern from shave-rust/src/rust-ast-parser.ts
// (DEC-POLYGLOT-RUST-SUBPROCESS-001).
//
// @decision DEC-POLYGLOT-RUST-COMPILE-RUSTFMT-001
// @title rustfmt is invoked via an injectable SpawnImpl seam; default uses node:child_process.spawn
// @status decided (Slice 1)
// @rationale
//   Mirrors shave-rust's rust-ast-parser.ts pattern exactly.  The injectable seam
//   lets tests substitute a no-op identity function so the test suite requires no
//   Rust toolchain in CI (pr-ci.yml posture: TS-only, pure-Node).  Real-rustfmt
//   tests are gated behind YAKCC_RUST_E2E in polyglot-rust.yml.
//   rustfmt is invoked with stdin/stdout (not a temp file) for simplicity -- the
//   formatted output is read from stdout; stderr carries warnings (not errors).

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * Thrown when the rustfmt subprocess fails or is unavailable.
 */
export class RustfmtError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "RustfmtError";
  }
}

/**
 * A spawn function with the same signature as node:child_process.spawn.
 * Injected by callers for testing (identity/no-op) or production (real spawn).
 */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcess;

export interface RustfmtOptions {
  /**
   * Rust edition to pass to rustfmt --edition.
   * Defaults to "2021".
   */
  readonly edition?: string | undefined;
  /**
   * Injectable spawn implementation. Defaults to node:child_process.spawn.
   * Tests pass a no-op that returns the input unchanged.
   */
  readonly spawnImpl?: SpawnImpl | undefined;
}

/**
 * Format a Rust source string using rustfmt.
 *
 * Feeds `source` over stdin, reads formatted output from stdout.
 * Returns the formatted source string on success.
 * Throws RustfmtError if rustfmt is not installed, exits non-zero, or times out.
 *
 * Tests MUST inject a mock via options.spawnImpl to avoid requiring a Rust toolchain.
 *
 * @example (production)
 *   const formatted = await formatWithRustfmt(source);
 *
 * @example (test)
 *   const formatted = await formatWithRustfmt(source, { spawnImpl: identityRustfmtSpawn() });
 */
export function formatWithRustfmt(source: string, options?: RustfmtOptions): Promise<string> {
  const edition = options?.edition ?? "2021";
  const spawnFn: SpawnImpl = options?.spawnImpl ?? spawn;

  return new Promise<string>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn("rustfmt", ["--edition", edition], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      reject(
        new RustfmtError(
          `Failed to spawn rustfmt: ${String(err)}. Install the Rust toolchain from https://rustup.rs/`,
          null,
          "",
        ),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (err: Error) => {
      reject(
        new RustfmtError(
          `rustfmt process error: ${err.message}. Install the Rust toolchain from https://rustup.rs/`,
          null,
          stderrChunks.map((b) => b.toString()).join(""),
        ),
      );
    });

    child.on("close", (code: number | null) => {
      const stderr = stderrChunks.map((b) => b.toString()).join("");
      if (code !== 0) {
        reject(
          new RustfmtError(
            `rustfmt exited with code ${String(code)}${stderr ? `: ${stderr}` : ""}`,
            code,
            stderr,
          ),
        );
        return;
      }
      const formatted = stdoutChunks.map((b) => b.toString()).join("");
      resolve(formatted);
    });

    // Feed source over stdin
    child.stdin?.end(source, "utf8");
  });
}

// ---------------------------------------------------------------------------
// Mock spawn for tests
// ---------------------------------------------------------------------------

/**
 * Internal mock ChildProcess that pipes stdin -> stdout unchanged (identity).
 * Used by identityRustfmtSpawn to produce a no-op mock for tests.
 */
class MockChildProcess extends EventEmitter {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;

  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();

    // Pipe stdin to stdout (identity transform)
    this.stdin.pipe(this.stdout);

    // After stdin ends, emit close with code 0
    this.stdin.on("end", () => {
      setImmediate(() => {
        this.emit("close", 0);
      });
    });
  }
}

/**
 * Build an identity SpawnImpl for use in tests.
 *
 * The mock process echoes stdin to stdout unchanged (identity transform), so
 * tests can verify the full pipeline without a real rustfmt.
 *
 * Usage:
 *   const formatted = await formatWithRustfmt(source, { spawnImpl: identityRustfmtSpawn() });
 *   // formatted === source
 */
export function identityRustfmtSpawn(): SpawnImpl {
  return (_command: string, _args: readonly string[], _opts: unknown): ChildProcess => {
    return new MockChildProcess() as unknown as ChildProcess;
  };
}
