// SPDX-License-Identifier: MIT
/**
 * symbol-table.ts — Lexical-scoped symbol table for the WASM lowering pass.
 *
 * Purpose:
 *   Track per-scope: local-slot assignments, parameter slots, captured-variable
 *   placeholders (filled by WI-V1W3-WASM-LOWER-10), and inferred numeric domain
 *   (i32/i64/f64). The visitor pushes a new frame on every function/block entry
 *   and pops it on exit.
 *
 * Rationale:
 *   WASM uses flat integer indices for all locals (params + declared locals).
 *   Building this mapping during AST traversal avoids a separate pre-pass.
 *   Lexical scoping via a frame stack mirrors TypeScript's block-scoping rules
 *   (let/const), which the visitor enforces when lowering block statements.
 *
 * Frame layout (WASM convention):
 *   - Parameter slots occupy indices 0 … (paramCount - 1).
 *   - Declared locals occupy indices paramCount … N.
 *   - Each inner block scope pushes a new frame but preserves the slot counter
 *     from the enclosing function frame, so slot indices are globally unique
 *     within a function (WASM requires this).
 *
 * Captured variables (closures) are placeholders in this WI. WI-V1W3-WASM-LOWER-10
 * extends the `CapturedSlot` kind to a real lowering strategy once the closure
 * layout is decided.
 */

import type { NumericDomain } from "./wasm-function.js";

// ---------------------------------------------------------------------------
// Slot kinds
// ---------------------------------------------------------------------------

/**
 * A parameter slot: bound at function entry, read-only from the caller's perspective.
 * In WASM binary, parameters and locals share the same index space; params come first.
 */
export interface ParamSlot {
  readonly kind: "param";
  readonly index: number;
  readonly domain: NumericDomain;
}

/**
 * A local variable slot declared inside a function or block.
 * Assigned sequentially after all parameter slots.
 */
export interface LocalSlot {
  readonly kind: "local";
  readonly index: number;
  readonly domain: NumericDomain;
}

/**
 * A captured-variable placeholder.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-CLOSURE-PLACEHOLDER-001
 * @title Closure capture is a placeholder for WI-V1W3-WASM-LOWER-10
 * @status placeholder (will be superseded by WI-10)
 * @rationale
 *   Lowering closures requires a memory layout decision (struct on linear memory
 *   vs environment record passed as extra param) that is deferred to WI-10.
 *   Including the kind now lets visitor code reference captures without needing
 *   to implement the full lowering, and makes the deferred work explicit rather
 *   than silently absent. Any visitor code that encounters a CapturedSlot must
 *   throw a LoweringError with kind "unsupported-capture" until WI-10 fills it.
 */
export interface CapturedSlot {
  readonly kind: "captured";
  readonly name: string;
}

/** A resolved symbol — param, local, or closure capture. */
export type Slot = ParamSlot | LocalSlot | CapturedSlot;

// ---------------------------------------------------------------------------
// Frame
//
// One frame per lexical scope (function body or block). Inner frames inherit
// the slot counter from their enclosing function frame so indices are
// globally unique within the function.
// ---------------------------------------------------------------------------

interface Frame {
  /** Map from symbol name to its slot assignment. */
  readonly slots: Map<string, Slot>;
  /**
   * Whether this frame opened a new function boundary.
   * When true, nextSlotIndex resets to 0 for a new function.
   * When false (block scope), nextSlotIndex continues from the enclosing frame.
   */
  readonly isFunctionBoundary: boolean;
}

// ---------------------------------------------------------------------------
// SymbolTable
// ---------------------------------------------------------------------------

/**
 * Lexical-scoped symbol table for the WASM lowering visitor.
 *
 * Usage pattern:
 *   const table = new SymbolTable();
 *   table.pushFrame({ isFunctionBoundary: true });
 *   table.defineParam("a", "i32");  // slot 0
 *   table.defineParam("b", "i32");  // slot 1
 *   table.pushFrame({ isFunctionBoundary: false });
 *   table.defineLocal("tmp", "i32"); // slot 2
 *   table.lookup("a");   // → ParamSlot { index: 0, domain: "i32" }
 *   table.lookup("tmp"); // → LocalSlot { index: 2, domain: "i32" }
 *   table.popFrame();
 *   table.popFrame();
 */
export class SymbolTable {
  /** Frame stack. Index 0 is the outermost scope, last is the innermost. */
  private readonly _frames: Frame[] = [];

  /**
   * The next available slot index within the current function boundary.
   * Shared across all frames within the same function so that inner block
   * scopes do not re-use slot numbers.
   */
  private _nextSlotIndex = 0;

  // -------------------------------------------------------------------------
  // Frame management
  // -------------------------------------------------------------------------

  /**
   * Push a new lexical scope frame.
   *
   * @param options.isFunctionBoundary
   *   true → new function scope (resets slot counter from 0).
   *   false → inner block scope (continues slot counter from enclosing function).
   */
  pushFrame(options: { isFunctionBoundary: boolean }): void {
    if (options.isFunctionBoundary) {
      this._nextSlotIndex = 0;
    }
    this._frames.push({
      slots: new Map(),
      isFunctionBoundary: options.isFunctionBoundary,
    });
  }

  /**
   * Pop the innermost frame. Throws if the frame stack is empty.
   *
   * The slot counter (`_nextSlotIndex`) is NOT modified on pop — it is only
   * reset to 0 when a new function-boundary frame is pushed. This preserves
   * the shared-counter invariant: inner block scopes share the slot counter
   * with their enclosing function frame, so indices remain globally unique
   * within a function even after an inner scope exits.
   *
   * Rationale: WASM local slots are allocated for the full function lifetime
   * regardless of block nesting. A local declared inside an inner block still
   * occupies a slot in the function's flat local space. Resetting the counter
   * on pop would cause slot-number collisions between inner-scope locals and
   * subsequent locals in the enclosing scope.
   */
  popFrame(): void {
    if (this._frames.length === 0) {
      throw new Error("SymbolTable.popFrame(): frame stack is empty");
    }
    this._frames.pop();
  }

  // -------------------------------------------------------------------------
  // Symbol definition
  // -------------------------------------------------------------------------

  /**
   * Define a function parameter in the current (innermost) frame.
   *
   * Parameters must be defined before locals — WASM requires params to occupy
   * the lowest slot indices. Caller is responsible for enforcing this order.
   *
   * @returns The assigned ParamSlot.
   */
  defineParam(name: string, domain: NumericDomain): ParamSlot {
    const frame = this._requireCurrentFrame("defineParam");
    const slot: ParamSlot = {
      kind: "param",
      index: this._nextSlotIndex++,
      domain,
    };
    frame.slots.set(name, slot);
    return slot;
  }

  /**
   * Define a local variable in the current (innermost) frame.
   *
   * @returns The assigned LocalSlot.
   */
  defineLocal(name: string, domain: NumericDomain): LocalSlot {
    const frame = this._requireCurrentFrame("defineLocal");
    const slot: LocalSlot = {
      kind: "local",
      index: this._nextSlotIndex++,
      domain,
    };
    frame.slots.set(name, slot);
    return slot;
  }

  /**
   * Record a captured (closure) variable in the current frame as a placeholder.
   *
   * @returns The assigned CapturedSlot.
   */
  defineCapture(name: string): CapturedSlot {
    const frame = this._requireCurrentFrame("defineCapture");
    const slot: CapturedSlot = { kind: "captured", name };
    frame.slots.set(name, slot);
    return slot;
  }

  // -------------------------------------------------------------------------
  // Symbol lookup
  // -------------------------------------------------------------------------

  /**
   * Look up a symbol by name, searching outward through the frame stack.
   *
   * Returns the slot if found, or `undefined` if the name is not in scope.
   * Shadowing is supported: inner-frame definitions take precedence.
   */
  lookup(name: string): Slot | undefined {
    // Walk the stack from innermost to outermost.
    for (let i = this._frames.length - 1; i >= 0; i--) {
      const frame = this._frames[i];
      if (frame === undefined) continue;
      const slot = frame.slots.get(name);
      if (slot !== undefined) return slot;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Introspection helpers (used by tests and the visitor)
  // -------------------------------------------------------------------------

  /** Current frame nesting depth (0 = no frames pushed). */
  get depth(): number {
    return this._frames.length;
  }

  /** The slot index that will be assigned to the next param or local. */
  get nextSlotIndex(): number {
    return this._nextSlotIndex;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _requireCurrentFrame(op: string): Frame {
    const top = this._frames[this._frames.length - 1];
    if (top === undefined) {
      throw new Error(`SymbolTable.${op}(): no frame pushed — call pushFrame() first`);
    }
    return top;
  }
}
