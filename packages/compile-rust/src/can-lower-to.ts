// SPDX-License-Identifier: Apache-2.0
/**
 * canLowerTo -- static lowerability check for @yakcc/compile-rust.
 *
 * @decision DEC-POLYGLOT-RUST-COMPILE-001
 * @title canLowerTo is co-located with the Rust lower rules as the single
 *   authority for what can be lowered to Rust.
 * @status decided (Slice 1)
 * @rationale
 *   Mirrors compile-go canLowerTo (WI-871) for the Rust direction.
 *   The existing shave-rust handles a strict TS-subset surface (number, string,
 *   boolean, T[], Option<T>/Vec<T>, return/expr/let stmts, limited binary/unary
 *   ops).  This primitive performs the same AST walk without emitting any output.
 *   Callers that need to pre-screen atoms before invoking compileToRust use this
 *   gate.
 *
 *   Design invariants:
 *   - NEVER performs actual lowering -- pure static IR-AST inspection only.
 *   - NEVER throws -- all uncertainty returns "unknown".
 *   - Returns false (not "unknown") for constructs the Rust lower path provably
 *     cannot handle (the >=5 blocker classes documented below).
 *   - Returns "unknown" for language targets without a shipped adapter in this pkg.
 *   - Returns true for the atom native language (ts) unconditionally.
 *
 *   Rust blocker taxonomy (Slice 1 -- error taxonomy seed):
 *
 *   BLOCKER-RUST-001 (async/Promise/await): No Rust MVP equivalent.
 *     Rust async requires futures/tokio ecosystem; out of scope for MVP.
 *
 *   BLOCKER-RUST-002 (complex generics): Beyond MVP surface.
 *     Generic type params with extends constraints have no direct Rust MVP
 *     equivalent without trait bounds, which are Slice 2+.
 *
 *   BLOCKER-RUST-003 (bigint): No Rust primitive equivalent in MVP.
 *     bigint has no direct Rust primitive -- u128/i128/BigDecimal are library
 *     types not in the Slice-1 type map.
 *
 *   BLOCKER-RUST-004 (union types): No clean Rust equivalent without enums.
 *     TS union types (A | B) require a Rust enum or enum dispatch which is
 *     beyond the MVP lower surface.
 *
 *   BLOCKER-RUST-005 (function-typed values / closures): Beyond MVP.
 *     Arrow functions as values and function-type annotations require Rust
 *     closure/fn-pointer syntax; the MVP targets top-level exported functions only.
 */

import type { BlockTripletRow } from "@yakcc/registry";
import { Project, SyntaxKind } from "ts-morph";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Language targets. "ts" is the atom native form. "go" and "py" have no
 * adapter verdict in this package; they return "unknown".
 */
export type TargetLanguage = "py" | "ts" | "go" | "rs";

/**
 * Result of the lowerability check.
 *
 * - `true`      -- the atom IR AST uses only constructs the target adapter can handle.
 * - `false`     -- the atom contains constructs the target adapter explicitly cannot handle.
 * - `"unknown"` -- the adapter cannot decide statically (no adapter shipped for
 *                  this package target). Never throws.
 */
export type CanLowerResult = boolean | "unknown";

/**
 * Statically inspect an atom IR AST to determine whether it can be lowered
 * to the given target language without errors.
 *
 * This function is pure and side-effect-free. It never throws.
 *
 * @param atom     The atom whose implSource IR will be statically inspected.
 * @param language The target output language.
 */
export function canLowerTo(atom: BlockTripletRow, language: TargetLanguage): CanLowerResult {
  try {
    return checkCanLower(atom.implSource, language);
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

function checkCanLower(implSource: string, language: TargetLanguage): CanLowerResult {
  if (language === "ts") return true;
  if (language === "go" || language === "py") return "unknown";
  return checkRustLowerable(implSource);
}

/**
 * Inspect the implSource AST for constructs the Rust lower adapter explicitly
 * cannot handle. Returns false on first confirmed blocker.
 */
function checkRustLowerable(implSource: string): CanLowerResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: true,
      noImplicitAny: true,
      strictNullChecks: true,
      target: 99,
      module: 99,
      skipLibCheck: true,
    },
  });

  const sf = project.createSourceFile("impl.ts", implSource);

  let blocked = false;

  sf.forEachDescendant((node) => {
    if (blocked) return;
    const k = node.getKind();

    // BLOCKER-RUST-001: async/Promise/await
    if (k === SyntaxKind.AsyncKeyword) {
      blocked = true;
      return;
    }
    if (k === SyntaxKind.AwaitExpression) {
      blocked = true;
      return;
    }
    const typeRef = node.asKind(SyntaxKind.TypeReference);
    if (typeRef !== undefined) {
      if (typeRef.getTypeName().getText().trim() === "Promise") blocked = true;
      return;
    }

    // BLOCKER-RUST-002: generic type parameters (conservative -- block all for MVP)
    if (k === SyntaxKind.TypeParameter) {
      blocked = true;
      return;
    }

    // BLOCKER-RUST-003: bigint type/literal
    if (k === SyntaxKind.BigIntKeyword) {
      blocked = true;
      return;
    }
    if (k === SyntaxKind.BigIntLiteral) {
      blocked = true;
      return;
    }
    const litTypeNode = node.asKind(SyntaxKind.LiteralType);
    if (litTypeNode !== undefined) {
      if (litTypeNode.getLiteral().getKind() === SyntaxKind.BigIntLiteral) blocked = true;
      return;
    }

    // BLOCKER-RUST-004: union types
    if (k === SyntaxKind.UnionType) {
      blocked = true;
      return;
    }

    // BLOCKER-RUST-005: function-typed values / closures
    if (k === SyntaxKind.FunctionType) {
      blocked = true;
      return;
    }
    if (k === SyntaxKind.ArrowFunction) {
      blocked = true;
      return;
    }
  });

  return !blocked;
}
