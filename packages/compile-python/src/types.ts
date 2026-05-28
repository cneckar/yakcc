// SPDX-License-Identifier: MIT

/** A warning emitted during IR → Python lowering. */
export interface LowerWarning {
  /** Short identifier for the warning category. */
  readonly kind: string;
  /** Human-readable warning message. */
  readonly message: string;
  /** Source location of the construct that triggered the warning, if available. */
  readonly location?: { readonly line: number; readonly col: number } | undefined;
}

/**
 * Result of compiling a TS-subset IR atom to Python.
 *
 * @decision DEC-POLYGLOT-COMPILE-PY-001 (see lower.ts header)
 */
export interface PythonCompileResult {
  /** Emitted .py file content (the lowered implementation). */
  readonly source: string;
  /**
   * Emitted tests.hypothesis.py content, derived from proof/properties.json via
   * the WI-POLYGLOT-PROOF-IR emitter (DEC-POLYGLOT-PROOF-IR-001).
   * Empty string when no proof/properties.json artifact is present in the atom.
   */
  readonly testSource: string;
  /** Warnings collected during lowering. */
  readonly warnings: readonly LowerWarning[];
}
