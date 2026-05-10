// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-002: hand-authored property-test corpus for
// @yakcc/compile wasm-lowering/symbol-table.ts atoms. Two-file pattern: this
// file (.props.ts) is vitest-free and holds the corpus; the sibling
// .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3-compile-gaps)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (7 named):
//   ST1.1 — pushFrame / popFrame: depth tracking
//   ST1.2 — defineParam: slot assignment and index sequencing
//   ST1.3 — defineLocal: slot assignment continuing after params
//   ST1.4 — defineCapture: closure placeholder (name preserved, no index)
//   ST1.5 — lookup: scoped resolution, shadowing, undefined for missing
//   ST1.6 — slot counter: global within function, resets on function boundary,
//            NOT reset on popFrame
//   ST1.7 — error paths: popFrame on empty stack, define* with no frame
//
// Properties (18 named):
//   prop_depth_starts_at_zero
//   prop_depth_increments_on_push
//   prop_depth_decrements_on_pop
//   prop_popFrame_throws_on_empty_stack
//   prop_defineParam_returns_param_slot
//   prop_defineParam_indexes_are_sequential
//   prop_defineParam_domain_preserved
//   prop_defineLocal_returns_local_slot
//   prop_defineLocal_index_continues_after_params
//   prop_defineLocal_domain_preserved
//   prop_defineCapture_returns_captured_slot
//   prop_defineCapture_name_preserved
//   prop_lookup_finds_defined_symbol
//   prop_lookup_returns_undefined_for_missing
//   prop_lookup_inner_shadows_outer
//   prop_slot_counter_resets_on_function_boundary
//   prop_slot_counter_not_reset_on_block_pop
//   prop_define_throws_without_frame
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { SymbolTable } from "./symbol-table.js";
import type { NumericDomain } from "./wasm-function.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

const numericDomainArb: fc.Arbitrary<NumericDomain> = fc.constantFrom(
  "i32" as NumericDomain,
  "i64" as NumericDomain,
  "f64" as NumericDomain,
);

/** An identifier-like name safe for map keys. */
const nameArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9]{0,7}$/)
  .filter((s) => s.length >= 1);

/** A small positive count for repeated defines. */
const smallCountArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 8 });

// ---------------------------------------------------------------------------
// ST1.1: pushFrame / popFrame — depth tracking
// ---------------------------------------------------------------------------

/**
 * prop_depth_starts_at_zero
 *
 * A freshly constructed SymbolTable has depth 0 (no frames pushed).
 *
 * Invariant (ST1.1): depth reflects the number of live frames exactly.
 */
export const prop_depth_starts_at_zero = fc.property(fc.constant(null), (_) => {
  const t = new SymbolTable();
  return t.depth === 0;
});

/**
 * prop_depth_increments_on_push
 *
 * Each pushFrame call increments depth by exactly 1.
 *
 * Invariant (ST1.1): depth tracks push count.
 */
export const prop_depth_increments_on_push = fc.property(
  fc.integer({ min: 1, max: 6 }),
  (pushCount) => {
    const t = new SymbolTable();
    for (let i = 0; i < pushCount; i++) {
      t.pushFrame({ isFunctionBoundary: i === 0 });
    }
    return t.depth === pushCount;
  },
);

/**
 * prop_depth_decrements_on_pop
 *
 * Each popFrame call decrements depth by exactly 1.
 *
 * Invariant (ST1.1): pop removes exactly one frame.
 */
export const prop_depth_decrements_on_pop = fc.property(
  fc.integer({ min: 1, max: 6 }),
  (pushCount) => {
    const t = new SymbolTable();
    for (let i = 0; i < pushCount; i++) {
      t.pushFrame({ isFunctionBoundary: i === 0 });
    }
    const depthBefore = t.depth;
    t.popFrame();
    return t.depth === depthBefore - 1;
  },
);

/**
 * prop_popFrame_throws_on_empty_stack
 *
 * popFrame() throws an Error when the frame stack is empty.
 *
 * Invariant (ST1.7): operations on an empty stack fail loudly, not silently.
 */
export const prop_popFrame_throws_on_empty_stack = fc.property(fc.constant(null), (_) => {
  const t = new SymbolTable();
  try {
    t.popFrame();
    return false; // should not reach here
  } catch (e) {
    return e instanceof Error && e.message.includes("frame stack is empty");
  }
});

// ---------------------------------------------------------------------------
// ST1.2: defineParam — slot assignment and index sequencing
// ---------------------------------------------------------------------------

/**
 * prop_defineParam_returns_param_slot
 *
 * defineParam() returns a ParamSlot with kind === "param".
 *
 * Invariant (ST1.2): the returned slot is always a ParamSlot.
 */
export const prop_defineParam_returns_param_slot = fc.property(
  nameArb,
  numericDomainArb,
  (name, domain) => {
    const t = new SymbolTable();
    t.pushFrame({ isFunctionBoundary: true });
    const slot = t.defineParam(name, domain);
    return slot.kind === "param";
  },
);

/**
 * prop_defineParam_indexes_are_sequential
 *
 * Multiple params receive sequential indices starting from 0 in a fresh
 * function frame.
 *
 * Invariant (ST1.2): param slots occupy indices 0 … (n-1) within a function.
 * This is required by WASM: parameters are the first local entries.
 */
export const prop_defineParam_indexes_are_sequential = fc.property(
  smallCountArb,
  numericDomainArb,
  (count, domain) => {
    const t = new SymbolTable();
    t.pushFrame({ isFunctionBoundary: true });
    for (let i = 0; i < count; i++) {
      const slot = t.defineParam(`p${i}`, domain);
      if (slot.index !== i) return false;
    }
    return true;
  },
);

/**
 * prop_defineParam_domain_preserved
 *
 * The domain passed to defineParam is stored unchanged on the returned slot.
 *
 * Invariant (ST1.2): no domain coercion occurs during slot assignment.
 */
export const prop_defineParam_domain_preserved = fc.property(
  nameArb,
  numericDomainArb,
  (name, domain) => {
    const t = new SymbolTable();
    t.pushFrame({ isFunctionBoundary: true });
    const slot = t.defineParam(name, domain);
    return slot.domain === domain;
  },
);

// ---------------------------------------------------------------------------
// ST1.3: defineLocal — slot assignment continuing after params
// ---------------------------------------------------------------------------

/**
 * prop_defineLocal_returns_local_slot
 *
 * defineLocal() returns a LocalSlot with kind === "local".
 *
 * Invariant (ST1.3): the returned slot is always a LocalSlot.
 */
export const prop_defineLocal_returns_local_slot = fc.property(
  nameArb,
  numericDomainArb,
  (name, domain) => {
    const t = new SymbolTable();
    t.pushFrame({ isFunctionBoundary: true });
    const slot = t.defineLocal(name, domain);
    return slot.kind === "local";
  },
);

/**
 * prop_defineLocal_index_continues_after_params
 *
 * When params are defined first, the first local's index equals the param count.
 * Slot indices are globally unique within a function — params and locals share
 * one counter.
 *
 * Invariant (ST1.3): locals are assigned indices that continue from where params
 * left off, satisfying WASM's requirement that all local slots (params + locals)
 * form a contiguous sequence starting at 0.
 */
export const prop_defineLocal_index_continues_after_params = fc.property(
  smallCountArb,
  numericDomainArb,
  (paramCount, domain) => {
    const t = new SymbolTable();
    t.pushFrame({ isFunctionBoundary: true });
    for (let i = 0; i < paramCount; i++) {
      t.defineParam(`p${i}`, domain);
    }
    const local = t.defineLocal("x", domain);
    return local.index === paramCount;
  },
);

/**
 * prop_defineLocal_domain_preserved
 *
 * The domain passed to defineLocal is stored unchanged on the returned slot.
 *
 * Invariant (ST1.3): no domain coercion occurs during local slot assignment.
 */
export const prop_defineLocal_domain_preserved = fc.property(
  nameArb,
  numericDomainArb,
  (name, domain) => {
    const t = new SymbolTable();
    t.pushFrame({ isFunctionBoundary: true });
    const slot = t.defineLocal(name, domain);
    return slot.domain === domain;
  },
);

// ---------------------------------------------------------------------------
// ST1.4: defineCapture — closure placeholder
// ---------------------------------------------------------------------------

/**
 * prop_defineCapture_returns_captured_slot
 *
 * defineCapture() returns a CapturedSlot with kind === "captured".
 *
 * Invariant (ST1.4): the returned slot is always a CapturedSlot.
 * Captured variables are a WI-10 placeholder — no index is assigned.
 */
export const prop_defineCapture_returns_captured_slot = fc.property(nameArb, (name) => {
  const t = new SymbolTable();
  t.pushFrame({ isFunctionBoundary: true });
  const slot = t.defineCapture(name);
  return slot.kind === "captured";
});

/**
 * prop_defineCapture_name_preserved
 *
 * The name passed to defineCapture is stored unchanged on the returned slot.
 *
 * Invariant (ST1.4): the captured slot name equals the defined name.
 * The visitor uses this name to identify the capture in future WI-10 lowering.
 */
export const prop_defineCapture_name_preserved = fc.property(nameArb, (name) => {
  const t = new SymbolTable();
  t.pushFrame({ isFunctionBoundary: true });
  const slot = t.defineCapture(name);
  return slot.name === name;
});

// ---------------------------------------------------------------------------
// ST1.5: lookup — scoped resolution, shadowing, undefined for missing
// ---------------------------------------------------------------------------

/**
 * prop_lookup_finds_defined_symbol
 *
 * A symbol defined in the current frame is found by lookup() in the same frame.
 *
 * Invariant (ST1.5): lookup returns the assigned slot for any defined symbol.
 */
export const prop_lookup_finds_defined_symbol = fc.property(
  nameArb,
  numericDomainArb,
  (name, domain) => {
    const t = new SymbolTable();
    t.pushFrame({ isFunctionBoundary: true });
    const slot = t.defineParam(name, domain);
    const found = t.lookup(name);
    return found !== undefined && found === slot;
  },
);

/**
 * prop_lookup_returns_undefined_for_missing
 *
 * lookup() returns undefined for a name that has never been defined in any frame.
 *
 * Invariant (ST1.5): no implicit symbol creation; missing names return undefined
 * so the visitor can detect unresolved references and emit a LoweringError.
 */
export const prop_lookup_returns_undefined_for_missing = fc.property(nameArb, (name) => {
  const t = new SymbolTable();
  t.pushFrame({ isFunctionBoundary: true });
  // Use a different name so no collision is possible.
  t.defineLocal("__other__", "i32");
  return t.lookup(`${name}_missing_xyz`) === undefined;
});

/**
 * prop_lookup_inner_shadows_outer
 *
 * When the same name is defined in both an outer and an inner frame, lookup()
 * returns the inner (most recent) binding — shadowing is supported.
 *
 * Invariant (ST1.5): lexical shadowing is implemented correctly. Inner-scope
 * definitions take precedence over outer-scope definitions when names collide.
 * The visitor relies on this when block-scoped variables shadow function params.
 */
export const prop_lookup_inner_shadows_outer = fc.property(
  nameArb,
  numericDomainArb,
  numericDomainArb,
  (name, domainOuter, domainInner) => {
    const t = new SymbolTable();
    t.pushFrame({ isFunctionBoundary: true });
    const outerSlot = t.defineParam(name, domainOuter);

    t.pushFrame({ isFunctionBoundary: false });
    const innerSlot = t.defineLocal(name, domainInner);

    const found = t.lookup(name);
    // Inner slot takes precedence over outer.
    const shadowsCorrectly = found !== undefined && found === innerSlot && found !== outerSlot;

    t.popFrame();
    // After inner frame is popped, outer slot is visible again.
    const afterPop = t.lookup(name);
    const outerVisibleAfterPop = afterPop !== undefined && afterPop === outerSlot;

    return shadowsCorrectly && outerVisibleAfterPop;
  },
);

// ---------------------------------------------------------------------------
// ST1.6: Slot counter — function boundary vs. block boundary behaviour
// ---------------------------------------------------------------------------

/**
 * prop_slot_counter_resets_on_function_boundary
 *
 * Pushing a new function-boundary frame resets nextSlotIndex to 0, so each
 * function body starts slot numbering from scratch.
 *
 * Invariant (ST1.6): each function has its own independent slot space.
 * WASM local indices are per-function; a second function must not continue
 * numbering from the first function's last slot.
 */
export const prop_slot_counter_resets_on_function_boundary = fc.property(
  smallCountArb,
  numericDomainArb,
  (paramCount, domain) => {
    const t = new SymbolTable();

    // Define some params in the first function.
    t.pushFrame({ isFunctionBoundary: true });
    for (let i = 0; i < paramCount; i++) {
      t.defineParam(`p${i}`, domain);
    }
    t.popFrame();

    // Start a second function — counter must reset to 0.
    t.pushFrame({ isFunctionBoundary: true });
    return t.nextSlotIndex === 0;
  },
);

/**
 * prop_slot_counter_not_reset_on_block_pop
 *
 * Popping an inner (non-function-boundary) block frame does NOT reset the
 * slot counter. Subsequent locals in the enclosing scope receive indices
 * that continue from the inner block, not from the last param.
 *
 * Invariant (ST1.6): slot indices are globally unique within a function even
 * after inner blocks exit. WASM local slots are allocated for the full function
 * lifetime regardless of block nesting depth; re-using indices would corrupt
 * the WASM code section.
 */
export const prop_slot_counter_not_reset_on_block_pop = fc.property(numericDomainArb, (domain) => {
  const t = new SymbolTable();
  t.pushFrame({ isFunctionBoundary: true });

  // Define one param (index 0).
  t.defineParam("a", domain);

  // Enter an inner block and define one local (index 1).
  t.pushFrame({ isFunctionBoundary: false });
  const innerLocal = t.defineLocal("tmp", domain);
  t.popFrame();

  // After the inner block is popped, the next local must be index 2,
  // not index 1 (which would indicate an incorrect counter reset).
  const afterLocal = t.defineLocal("b", domain);
  return innerLocal.index === 1 && afterLocal.index === 2;
});

// ---------------------------------------------------------------------------
// ST1.7: Error paths — define* with no frame pushed
// ---------------------------------------------------------------------------

/**
 * prop_define_throws_without_frame
 *
 * defineParam, defineLocal, and defineCapture all throw when no frame has been
 * pushed. The error message names the offending operation.
 *
 * Invariant (ST1.7): operations fail loudly with a descriptive error when called
 * out of sequence. This guards against visitor bugs where a symbol is defined
 * before the corresponding pushFrame call.
 */
export const prop_define_throws_without_frame = fc.property(
  nameArb,
  numericDomainArb,
  (name, domain) => {
    const throwsWithMsg = (fn: () => unknown, opName: string): boolean => {
      try {
        fn();
        return false;
      } catch (e) {
        return e instanceof Error && e.message.includes(opName);
      }
    };

    const t1 = new SymbolTable();
    const t2 = new SymbolTable();
    const t3 = new SymbolTable();

    return (
      throwsWithMsg(() => t1.defineParam(name, domain), "defineParam") &&
      throwsWithMsg(() => t2.defineLocal(name, domain), "defineLocal") &&
      throwsWithMsg(() => t3.defineCapture(name), "defineCapture")
    );
  },
);
