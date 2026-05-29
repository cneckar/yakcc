// SPDX-License-Identifier: MIT
/**
 * canLowerTo — static lowerability check for @yakcc/compile-python.
 *
 * @decision DEC-POLYGLOT-CANLOWER-PY-001
 * @title canLowerTo is co-located with the Python lower rules as the single
 *   authority for what can be lowered to Python.
 * @status decided
 * @rationale
 *   The existing lower.ts handles a strict TS-subset. Rather than duplicating
 *   the knowledge of what is/is not supported into a separate package (#784
 *   discovery pipeline), this primitive lives here alongside lower.ts and
 *   performs the same AST walk without emitting any output. Callers that need
 *   to pre-screen atoms before invoking compileToPython use this gate.
 *
 *   Design invariants:
 *   - NEVER performs actual lowering — pure static IR-AST inspection only.
 *   - NEVER throws — all uncertainty returns "unknown".
 *   - Returns false (not "unknown") for constructs lower.ts provably cannot handle.
 *   - Returns "unknown" for language targets without a shipped adapter (go, rs).
 *   - Returns true for the atom's native language (ts) unconditionally.
 *
 *   BigInt rationale: Python's int is arbitrary-precision, but the TS-subset IR
 *   uses `bigint` to signal values that must not be rounded by float coercion.
 *   The current Python lower path maps `number` → float, which WOULD silently
 *   truncate bigint semantics. Until a dedicated arbitrary-precision path is
 *   added to lower.ts, bigint constructs must be blocked here.
 *   See: lower.ts lowerTypeNode — BigIntKeyword has no case and falls through
 *   to the opaque string fallback `"bigint"`, which is not valid Python.
 */

import type { BlockTripletRow } from "@yakcc/registry";
import { Node, Project, SyntaxKind } from "ts-morph";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Language targets. "ts" is the atom's native form. "go" and "rs" have no
 * adapter shipped yet; they always return "unknown".
 */
export type TargetLanguage = "py" | "ts" | "go" | "rs";

/**
 * Result of the lowerability check.
 *
 * - `true`      — the atom's IR AST uses only constructs the target adapter can handle.
 * - `false`     — the atom contains constructs the target adapter explicitly cannot handle.
 * - `"unknown"` — the adapter cannot decide statically (no adapter shipped, or
 *                 the IR contains constructs outside the checked set). Never throws.
 */
export type CanLowerResult = boolean | "unknown";

/**
 * Statically inspect an atom's IR AST to determine whether it can be lowered
 * to the given target language without errors.
 *
 * This function is pure and side-effect-free. It never throws.
 *
 * Production call pattern:
 * ```ts
 * const result = canLowerTo(atom, "py");
 * if (result === true) {
 *   return compileToPython(atom);
 * } else if (result === false) {
 *   // atom is definitively not lowerable — skip or surface error
 * } else {
 *   // "unknown" — adapter not installed or cannot decide; treat conservatively
 * }
 * ```
 *
 * @param atom     The atom whose implSource IR will be statically inspected.
 * @param language The target output language.
 */
export function canLowerTo(atom: BlockTripletRow, language: TargetLanguage): CanLowerResult {
  try {
    return checkCanLower(atom.implSource, language);
  } catch {
    // Any unexpected parse failure → unknown (never throw)
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

function checkCanLower(implSource: string, language: TargetLanguage): CanLowerResult {
  // Native language: always lowerable (it is the source form)
  if (language === "ts") return true;

  // No adapter shipped for these targets yet — documented escape hatch
  if (language === "go" || language === "rs") return "unknown";

  // language === "py": static AST inspection
  return checkPythonLowerable(implSource);
}

/**
 * Inspect the implSource AST for constructs the Python lower adapter
 * explicitly cannot handle. Returns false on first confirmed blocker.
 *
 * Currently checked blockers:
 *   1. BigIntKeyword type annotations (e.g. `x: bigint`)
 *   2. BigIntLiteral expressions (e.g. `42n`)
 *
 * All other constructs are assumed lowerable (lower.ts falls back gracefully
 * for unknown constructs rather than throwing). If the source cannot be parsed
 * at all, we return "unknown" (handled by the outer try/catch in canLowerTo).
 */
function checkPythonLowerable(implSource: string): CanLowerResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: true,
      noImplicitAny: true,
      strictNullChecks: true,
      // Use the same options as lower.ts to ensure identical parse results
      target: 99,
      module: 99,
      skipLibCheck: true,
    },
  });

  const sf = project.createSourceFile("impl.ts", implSource);

  // Walk every node in the file; stop early on first blocker found
  let blocked = false;
  sf.forEachDescendant((node) => {
    if (blocked) return;
    const k = node.getKind();

    // bigint type annotation: `x: bigint` → SyntaxKind.BigIntKeyword
    if (k === SyntaxKind.BigIntKeyword) {
      blocked = true;
      return;
    }

    // bigint literal: `42n` → SyntaxKind.BigIntLiteral
    if (k === SyntaxKind.BigIntLiteral) {
      blocked = true;
      return;
    }

    // LiteralType wrapping a BigIntLiteral: `type T = 42n`
    if (k === SyntaxKind.LiteralType && Node.isLiteralTypeNode(node)) {
      const lit = node.getLiteral();
      if (lit.getKind() === SyntaxKind.BigIntLiteral) {
        blocked = true;
      }
    }
  });

  if (blocked) return false;
  return true;
}
