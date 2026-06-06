// SPDX-License-Identifier: MIT
/**
 * Lean proof checker runner.
 *
 * Invokes `lean --check <path>` against a pinned toolchain version. The checker
 * compares the requested toolchain version against the locally installed Lean
 * binary version. If they do not match, the result is `invalid` — the daemon
 * never tries to install Lean (that is container/CI territory per the MVP scope
 * decision in DEC-PROOF-VERIFIER-DAEMON-001).
 *
 * The sandbox policy for v0 is: trust the local Lean install. Container/nix-shell
 * isolation is deferred to the sandbox-policy work item
 * (`wi-proof-verifier-sandbox-policy`) per DEC-PROOF-VERIFIER-DAEMON-001.
 *
 * @module lean-runner
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Result of running the Lean checker against a single proof file. */
export interface LeanRunResult {
  /** `"valid"` when Lean accepted the proof without errors; `"invalid"` otherwise. */
  readonly result: "valid" | "invalid";
  /**
   * Lean version string reported by `lean --version` (e.g. `"4.7.0"`).
   * Populated even when the result is `"invalid"` (version mismatch returns the
   * locally-installed version so the caller can surface the discrepancy).
   * `null` when Lean is not installed.
   */
  readonly localVersion: string | null;
  /** Lean stdout + stderr combined; useful for debugging failed checks. */
  readonly output: string;
}

/**
 * Parse a Lean version string from the output of `lean --version`.
 *
 * Lean 4.x prints:
 *   `Lean (version 4.7.0, ...)`
 * We extract the first `<major>.<minor>.<patch>` triple.
 */
export function parseLeanVersion(raw: string): string | null {
  const m = raw.match(/(\d+\.\d+\.\d+)/u);
  return m?.[1] ?? null;
}

/**
 * Detect the locally-installed Lean version.
 *
 * Returns `null` when `lean` is not found on PATH or exits non-zero for
 * `--version`.
 */
export async function detectLeanVersion(): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync("lean", ["--version"]);
    return parseLeanVersion(stdout + stderr);
  } catch {
    return null;
  }
}

/**
 * Run `lean --check <proofFilePath>` and return the result.
 *
 * @param proofFilePath  Absolute path to the `.lean` proof file.
 * @param requiredVersion  Toolchain version string from the artifact's `checker`
 *   field (e.g. `"lean4@4.7.0"` or `"4.7.0"`). The bare version component is
 *   compared against the locally-installed Lean binary.
 *
 * If the local Lean version does not match `requiredVersion`, returns
 * `{ result: "invalid", ... }` immediately without running the checker.
 *
 * If Lean is not installed, returns `{ result: "invalid", localVersion: null, ... }`.
 */
export async function runLeanCheck(
  proofFilePath: string,
  requiredVersion: string,
): Promise<LeanRunResult> {
  // Normalise: strip leading prefix like "lean4@" or "lean@"
  const bare = requiredVersion.replace(/^[a-z]+@/u, "");

  const localVersion = await detectLeanVersion();

  if (localVersion === null) {
    return {
      result: "invalid",
      localVersion: null,
      output: "lean binary not found on PATH",
    };
  }

  if (localVersion !== bare) {
    return {
      result: "invalid",
      localVersion,
      output: `toolchain mismatch: required ${bare}, found ${localVersion}`,
    };
  }

  // Toolchain matches — run the check.
  try {
    const { stdout, stderr } = await execFileAsync("lean", [
      "--check",
      proofFilePath,
    ]);
    return { result: "valid", localVersion, output: stdout + stderr };
  } catch (err: unknown) {
    const output =
      err instanceof Error
        ? ((err as NodeJS.ErrnoException & { stdout?: string; stderr?: string })
            .stdout ?? err.message)
        : String(err);
    return { result: "invalid", localVersion, output };
  }
}

// ---------------------------------------------------------------------------
// Coq skeleton — deferred per MVP scope
// ---------------------------------------------------------------------------

/**
 * Skeleton for Coq checker support.
 *
 * The Coq runner follows the same pattern as the Lean runner (version-pin check,
 * then `coqc <file>`). Full implementation is deferred — the schema already
 * accepts `coq_proof` artifacts but the daemon does not yet run Coq locally.
 * Tracked in: `wi-proof-verifier-coq-checker`.
 */
export async function runCoqCheck(
  _proofFilePath: string,
  _requiredVersion: string,
): Promise<LeanRunResult> {
  return {
    result: "invalid",
    localVersion: null,
    output: "Coq checker not yet implemented (deferred to wi-proof-verifier-coq-checker)",
  };
}
