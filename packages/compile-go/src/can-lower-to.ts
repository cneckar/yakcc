// SPDX-License-Identifier: MIT
/**
 * canLowerTo -- static lowerability check for @yakcc/compile-go.
 *
 * @decision DEC-POLYGLOT-CANLOWER-GO-001
 * @title canLowerTo is co-located with the Go lower rules as the single
 *   authority for what can be lowered to Go.
 * @status decided
 * @rationale
 *   Mirrors compile-python canLowerTo primitive (#846) for the Go direction.
 *   The existing shave-go handles a strict TS-subset surface (number, string,
 *   boolean, Error, unknown, T[], Record<string,V>, *T, return/expr/assign/decl
 *   stmts, limited binary/unary ops). This primitive performs the same AST walk
 *   without emitting any output. Callers that need to pre-screen atoms before
 *   invoking compileToGo use this gate.
 *
 *   Design invariants:
 *   - NEVER performs actual lowering -- pure static IR-AST inspection only.
 *   - NEVER throws -- all uncertainty returns "unknown".
 *   - Returns false (not "unknown") for constructs the Go lower path provably
 *     cannot handle (the >=5 blocker classes documented below).
 *   - Returns "unknown" for language targets without a shipped adapter (py, rs).
 *   - Returns true for the atom native language (ts) unconditionally.
 *
 *   Go blocker taxonomy (Slice 1 -- error taxonomy seed):
 *
 *   BLOCKER-GO-001 (bigint): No Go primitive equivalent.
 *     Go has no built-in arbitrary-precision integer -- math/big is a library,
 *     not a primitive. The TS-subset IR uses bigint to signal values that must
 *     not be rounded; the current Go lower path maps number -> int/float which
 *     would silently truncate bigint semantics. Block until a dedicated
 *     math/big path is added.
 *
 *   BLOCKER-GO-002 (generics): Out of scope for #871 MVP.
 *     Go generics (type parameters on functions/types, e.g. <T>) require
 *     Go 1.18+ generic syntax. The Slice 1 Go emit surface targets a plain
 *     function set only; no generic lowering is implemented.
 *
 *   BLOCKER-GO-003 (union types): No clean Go equivalent.
 *     TypeScript union types (A | B, T | undefined, T | null) have no
 *     direct Go analogue without interface{}. Nullable unions break
 *     Go zero-value semantics. Block until a discriminated-union strategy
 *     (e.g. tagged struct or interface) is designed and implemented.
 *
 *   BLOCKER-GO-004 (async/Promise/await): No Go MVP equivalent.
 *     Go concurrency is goroutine-based, not Promise-based. Mapping async
 *     functions to goroutines+channels is out of scope for #871 MVP.
 *
 *   BLOCKER-GO-005 (function-typed values / higher-order closures): Beyond
 *     Slice-1 Go emit surface. Go does support first-class function values,
 *     but the MVP lower path targets exported top-level functions only.
 *     Arrow-function expressions used as values, and parameters/return types
 *     annotated as function types, require a function-value lowering strategy
 *     not yet implemented.
 */

import type { BlockTripletRow } from "@yakcc/registry";
import { Project, SyntaxKind } from "ts-morph";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Language targets. "ts" is the atom native form. "py" and "rs" have no
 * adapter verdict in this package; they return "unknown".
 */
export type TargetLanguage = "py" | "ts" | "go" | "rs";

/**
 * Result of the lowerability check.
 *
 * - `true`      -- the atom IR AST uses only constructs the target adapter can handle.
 * - `false`     -- the atom contains constructs the target adapter explicitly cannot handle.
 * - `"unknown"` -- the adapter cannot decide statically (no adapter shipped for
 *                  this package target, or the IR contains constructs outside
 *                  the checked set). Never throws.
 */
export type CanLowerResult = boolean | "unknown";

/**
 * Statically inspect an atom IR AST to determine whether it can be lowered
 * to the given target language without errors.
 *
 * This function is pure and side-effect-free. It never throws.
 *
 * Production call pattern:
 * ```ts
 * const result = canLowerTo(atom, "go");
 * if (result === true) {
 *   return compileToGo(atom);
 * } else if (result === false) {
 *   // atom is definitively not lowerable -- skip or surface error
 * } else {
 *   // "unknown" -- adapter not installed or cannot decide; treat conservatively
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
    // Any unexpected parse failure -> unknown (never throw)
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

function checkCanLower(implSource: string, language: TargetLanguage): CanLowerResult {
  // Native language: always lowerable (it is the source form)
  if (language === "ts") return true;

  // No verdict shipped by this package for these targets -- documented escape hatch
  if (language === "py" || language === "rs") return "unknown";

  // language === "go": static AST inspection
  return checkGoLowerable(implSource);
}

/**
 * Inspect the implSource AST for constructs the Go lower adapter explicitly
 * cannot handle. Returns false on first confirmed blocker.
 *
 * Blocker classes checked (Slice 1 error taxonomy seed -- >=5 classes):
 *
 *   BLOCKER-GO-001 BigInt type/literal
 *   BLOCKER-GO-002 Generic type parameters
 *   BLOCKER-GO-003 Union types (A | B, T | undefined, T | null)
 *   BLOCKER-GO-004 async / Promise / await
 *   BLOCKER-GO-005 Function-typed values / higher-order closures
 *
 * All other constructs are assumed lowerable within the shave-go MVP surface.
 * If the source cannot be parsed at all, we return "unknown" (handled by the
 * outer try/catch in canLowerTo).
 */
function checkGoLowerable(implSource: string): CanLowerResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: true,
      noImplicitAny: true,
      strictNullChecks: true,
      // Use the same options as compile-python canLowerTo for identical parse results
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

    // --- BLOCKER-GO-001: bigint type annotation and bigint literals ---
    // Go has no built-in arbitrary-precision integer type. bigint in TS-subset IR
    // signals values that must not be rounded; no clean Go primitive maps to this.

    // bigint keyword in a type position: x: bigint, : bigint
    if (k === SyntaxKind.BigIntKeyword) {
      blocked = true;
      return;
    }

    // bigint literal: 42n
    if (k === SyntaxKind.BigIntLiteral) {
      blocked = true;
      return;
    }

    // LiteralType wrapping a BigIntLiteral: type T = 42n
    // Use asKind() for safe narrowing within the forEachDescendant callback.
    const litTypeNode = node.asKind(SyntaxKind.LiteralType);
    if (litTypeNode !== undefined) {
      if (litTypeNode.getLiteral().getKind() === SyntaxKind.BigIntLiteral) {
        blocked = true;
      }
      return;
    }

    // --- BLOCKER-GO-002: generic type parameters ---
    // Go 1.18+ generics are out of scope for #871 MVP. Block any function or
    // type declaration that declares type parameters (function f<T>(...)).
    if (k === SyntaxKind.TypeParameter) {
      blocked = true;
      return;
    }

    // --- BLOCKER-GO-003: union types ---
    // TypeScript union types (A | B, T | undefined, T | null) have no direct
    // Go analogue without interface{}. Nullable unions break Go zero-value semantics.
    if (k === SyntaxKind.UnionType) {
      blocked = true;
      return;
    }

    // --- BLOCKER-GO-004: async functions / Promise / await ---
    // Go concurrency is goroutine-based; async/Promise/await has no Go MVP equivalent.

    // async modifier on a function declaration or function expression
    if (k === SyntaxKind.AsyncKeyword) {
      blocked = true;
      return;
    }

    // await expression
    if (k === SyntaxKind.AwaitExpression) {
      blocked = true;
      return;
    }

    // Promise<T> type reference -- also catches the return type annotation
    // Use asKind() for safe narrowing since the callback param type is Node<ts.Node>.
    const typeRef = node.asKind(SyntaxKind.TypeReference);
    if (typeRef !== undefined) {
      const typeName = typeRef.getTypeName().getText().trim();
      if (typeName === "Promise") {
        blocked = true;
      }
      return;
    }

    // --- BLOCKER-GO-005: function-typed values / higher-order closures ---
    // The MVP lower path targets exported top-level functions only.
    // Arrow functions used as values and parameters/return types annotated
    // as function types are out of scope.

    // FunctionType annotation in a parameter or variable: (x: () => void) => ...
    if (k === SyntaxKind.FunctionType) {
      blocked = true;
      return;
    }

    // ArrowFunction used as a value. For Slice 1 conservatism, block ALL
    // arrow function expressions -- pure function declarations are the supported form.
    if (k === SyntaxKind.ArrowFunction) {
      blocked = true;
      return;
    }
  });

  if (blocked) return false;
  return true;
}
