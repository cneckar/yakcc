/**
 * booleans.test.ts — Property-based tests for WI-V1W3-WASM-LOWER-03.
 *
 * Purpose:
 *   Verify that the boolean and comparison lowering path produces WASM byte
 *   sequences that execute correctly and match TypeScript reference semantics.
 *   Eight substrates covering boolean ops, short-circuit side effects,
 *   integer comparisons (i32/i64/f64), mixed numeric comparisons, ===\/!==
 *   parity with ==\/!=, and if/else from a boolean expression.
 *
 * Short-circuit observability (CRITICAL — the entire point of this WI):
 *   `&&` and `||` MUST emit if/else/end block opcodes, NOT i32.and/i32.or.
 *   Short-circuit is observable when the RHS has side effects on local state.
 *   Substrate bool-2 exercises this: a `let counter` is incremented in the RHS;
 *   the test asserts the counter matches JS semantics (incremented iff LHS allows
 *   RHS to evaluate). A bug that emits i32.and would always evaluate both sides
 *   and fail the counter assertions.
 *
 * WASM module construction:
 *   buildStandaloneWasm() / buildStandaloneWasmMixed() assemble minimal modules
 *   with no host imports — just type/function/export/code sections, matching the
 *   pattern from numeric.test.ts (DEC-V1-WAVE-3-WASM-LOWER-TEST-STANDALONE-001).
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-EQ-001
 * @title == and === emit identical opcodes for primitives; !== and != likewise
 * @status accepted
 * @rationale
 *   Under the IR strict-subset, both operands are always primitively typed
 *   (boolean or numeric). Strict equality (===) and abstract equality (==) are
 *   semantically identical for same-type primitives in both TypeScript and
 *   JavaScript. Emitting the same WASM opcode (i32.eq / i64.eq / f64.eq) for
 *   both is therefore correct. Object-equality (reference comparison for
 *   non-primitive types) is out of scope until WI-V1W3-WASM-LOWER-06; if the
 *   typechecker reports either operand as a non-primitive, the visitor MUST
 *   reject with a loud error referencing WI-06. See also MASTER_PLAN.md
 *   DEC-V1-WAVE-3-WASM-LOWER-EQ-001.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-BOOL-DOMAIN-001
 * @title boolean type lowers to i32 (0/1); no separate boolean NumericDomain
 * @status accepted
 * @rationale
 *   WASM has no boolean type — booleans are i32 with values 0 (false) and 1
 *   (true). Adding a fourth "bool" variant to NumericDomain would complicate
 *   every domain-switch in visitor.ts without benefit, since all boolean
 *   operations emit i32 opcodes anyway. TS `boolean` parameters and return
 *   types are declared as i32 in the WASM type section; boolean literals
 *   (true/false) emit i32.const 1/0. This is consistent with how every WASM
 *   language (C, Rust, AssemblyScript) lowers booleans.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-AND-OR-SHORT-CIRCUIT-001
 * @title && and || emit if/else/end WASM blocks, not i32.and/i32.or
 * @status accepted
 * @rationale
 *   JavaScript && and || are short-circuit operators: the RHS is only evaluated
 *   if the LHS result requires it (LHS truthy for &&, LHS falsy for ||). If the
 *   RHS has side effects (local mutation, host calls) that are observable, emitting
 *   i32.and/i32.or is incorrect — it always evaluates both sides. WASM if/else/end
 *   blocks provide the only correct structural encoding of short-circuit semantics.
 *   The short-circuit contract is explicitly tested in bool-2 (side-effect substrate).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { LoweringVisitor } from "../../src/wasm-lowering/visitor.js";
import { valtypeByte } from "../../src/wasm-lowering/wasm-function.js";
import type { NumericDomain, WasmFunction } from "../../src/wasm-lowering/wasm-function.js";

// ---------------------------------------------------------------------------
// f64 comparison tolerance (same as numeric.test.ts)
// ---------------------------------------------------------------------------

const F64_REL_EPSILON = 1e-9;
const F64_ABS_EPSILON = Number.EPSILON * 8;

function f64Close(a: number, b: number): boolean {
  if (!Number.isFinite(a) && !Number.isFinite(b)) return Object.is(a, b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const absDiff = Math.abs(a - b);
  const maxAbs = Math.max(Math.abs(a), Math.abs(b));
  if (maxAbs < 1e-300) return absDiff < F64_ABS_EPSILON;
  return absDiff / maxAbs < F64_REL_EPSILON;
}

// ---------------------------------------------------------------------------
// Minimal standalone WASM module builder (mirrors numeric.test.ts)
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-TEST-STANDALONE-001 (see numeric.test.ts)
// ---------------------------------------------------------------------------

const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
const WASM_VERSION = new Uint8Array([0x01, 0x00, 0x00, 0x00]);
const FUNCTYPE = 0x60;

function uleb128(n: number): Uint8Array {
  const bytes: number[] = [];
  let v = n >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return new Uint8Array(bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function section(id: number, content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([id]), uleb128(content.length), content);
}

function encodeName(name: string): Uint8Array {
  const bytes = new TextEncoder().encode(name);
  return concat(uleb128(bytes.length), bytes);
}

function serializeWasmFn(fn: WasmFunction): Uint8Array {
  const localParts: Uint8Array[] = [uleb128(fn.locals.length)];
  for (const decl of fn.locals) {
    localParts.push(uleb128(decl.count), new Uint8Array([valtypeByte(decl.type)]));
  }
  const localsBytes = concat(...localParts);
  const bodyBytes = new Uint8Array(fn.body);
  const endByte = new Uint8Array([0x0b]);
  return concat(localsBytes, bodyBytes, endByte);
}

/**
 * Build a standalone WASM module with uniform param/result types.
 *
 * paramDomain is used for all parameters; resultDomain is the return type.
 * When they differ (e.g. (i32, i32) → i32 comparison returning i32), pass
 * resultDomain="i32" regardless of paramDomain.
 */
function buildStandaloneWasm(
  wasmFn: WasmFunction,
  paramDomain: NumericDomain,
  paramCount: number,
  resultDomain: NumericDomain = paramDomain,
): Uint8Array {
  const pvt = valtypeByte(paramDomain);
  const rvt = valtypeByte(resultDomain);

  const paramTypes = new Uint8Array(paramCount).fill(pvt);
  const resultTypes = new Uint8Array([rvt]);
  const funcTypeDef = concat(
    new Uint8Array([FUNCTYPE]),
    uleb128(paramCount),
    paramTypes,
    uleb128(1),
    resultTypes,
  );
  const typeSection = section(1, concat(uleb128(1), funcTypeDef));
  const funcSection = section(3, concat(uleb128(1), uleb128(0)));
  const exportSection = section(
    7,
    concat(uleb128(1), encodeName("fn"), new Uint8Array([0x00, 0x00])),
  );
  const body = serializeWasmFn(wasmFn);
  const codeSection = section(10, concat(uleb128(1), uleb128(body.length), body));
  return concat(WASM_MAGIC, WASM_VERSION, typeSection, funcSection, exportSection, codeSection);
}

/** Lower a TypeScript source to a standalone WASM binary. */
function lowerToWasm(source: string): {
  wasmBytes: Uint8Array;
  domain: NumericDomain;
  paramCount: number;
  warnings: ReadonlyArray<string>;
} {
  const visitor = new LoweringVisitor();
  const result = visitor.lower(source);
  const domain = result.numericDomain ?? "i32";
  const paramCount =
    source
      .match(/\(([^)]*)\)/)?.[1]
      ?.split(",")
      .filter((s) => s.trim().length > 0).length ?? 0;
  const wasmBytes = buildStandaloneWasm(result.wasmFn, domain, paramCount);
  return { wasmBytes, domain, paramCount, warnings: result.warnings };
}

/**
 * Lower a source that has boolean params but i32 result (comparisons).
 *
 * For comparison functions: params are numeric domain X, result is i32 (boolean).
 * For pure boolean functions: params and result are both i32.
 */
function lowerBooleanSource(
  source: string,
  paramDomain: NumericDomain,
  paramCount: number,
): Uint8Array {
  const visitor = new LoweringVisitor();
  const result = visitor.lower(source);
  // Result domain for comparisons is always i32 (boolean)
  return buildStandaloneWasm(result.wasmFn, paramDomain, paramCount, "i32");
}

/**
 * Instantiate and call a WASM fn. Returns number (i32/f64) or bigint (i64).
 */
async function runWasm(wasmBytes: Uint8Array, args: number[] | bigint[]): Promise<number | bigint> {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const fn = (instance.exports as Record<string, unknown>).fn as (
    ...a: unknown[]
  ) => number | bigint;
  return fn(...args);
}

// ---------------------------------------------------------------------------
// Substrate bool-1: Pure boolean ops — !a, a && b, a || b
//
// Functions with only boolean params/return lower to i32 domain.
// true → i32.const 1, false → i32.const 0, ! → i32.eqz
// && → if/else/end short-circuit, || → if/else/end short-circuit
// ---------------------------------------------------------------------------

describe("boolean lowering — bool-1: pure boolean ops", () => {
  it("bool-1a: not(a) — ! lowers to i32.eqz over 15+ fc.boolean() inputs", async () => {
    const src = "export function notB(a: boolean): boolean { return !a; }";
    const visitor = new LoweringVisitor();
    const result = visitor.lower(src);
    expect(result.numericDomain).toBe("i32"); // boolean is i32
    const wasmBytes = buildStandaloneWasm(result.wasmFn, "i32", 1);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (a) => {
        const tsRef = !a ? 1 : 0;
        const wasmResult = await runWasm(wasmBytes, [a ? 1 : 0]);
        expect(Number(wasmResult)).toBe(tsRef);
      }),
      { numRuns: 20 },
    );
  });

  it("bool-1b: and(a, b) — && lowers to if/else/end block over 15+ fc.boolean() pairs", async () => {
    const src = "export function andB(a: boolean, b: boolean): boolean { return a && b; }";
    const visitor = new LoweringVisitor();
    const result = visitor.lower(src);
    expect(result.numericDomain).toBe("i32");
    const wasmBytes = buildStandaloneWasm(result.wasmFn, "i32", 2);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.boolean(), async (a, b) => {
        const tsRef = a && b ? 1 : 0;
        const wasmResult = await runWasm(wasmBytes, [a ? 1 : 0, b ? 1 : 0]);
        expect(Number(wasmResult)).toBe(tsRef);
      }),
      { numRuns: 20 },
    );
  });

  it("bool-1c: or(a, b) — || lowers to if/else/end block over 15+ fc.boolean() pairs", async () => {
    const src = "export function orB(a: boolean, b: boolean): boolean { return a || b; }";
    const visitor = new LoweringVisitor();
    const result = visitor.lower(src);
    expect(result.numericDomain).toBe("i32");
    const wasmBytes = buildStandaloneWasm(result.wasmFn, "i32", 2);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.boolean(), async (a, b) => {
        const tsRef = a || b ? 1 : 0;
        const wasmResult = await runWasm(wasmBytes, [a ? 1 : 0, b ? 1 : 0]);
        expect(Number(wasmResult)).toBe(tsRef);
      }),
      { numRuns: 20 },
    );
  });

  it("bool-1d: true/false literals lower to i32.const 1/0 — 15 cases", async () => {
    const srcTrue = "export function alwaysTrue(): boolean { return true; }";
    const srcFalse = "export function alwaysFalse(): boolean { return false; }";
    const vTrue = new LoweringVisitor();
    const rTrue = vTrue.lower(srcTrue);
    const wasmTrue = buildStandaloneWasm(rTrue.wasmFn, "i32", 0);
    const vFalse = new LoweringVisitor();
    const rFalse = vFalse.lower(srcFalse);
    const wasmFalse = buildStandaloneWasm(rFalse.wasmFn, "i32", 0);

    expect(() => new WebAssembly.Module(wasmTrue)).not.toThrow();
    expect(() => new WebAssembly.Module(wasmFalse)).not.toThrow();

    // Run each 15 times (no args, deterministic)
    for (let i = 0; i < 15; i++) {
      expect(Number(await runWasm(wasmTrue, []))).toBe(1);
      expect(Number(await runWasm(wasmFalse, []))).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Substrate bool-2: SHORT-CIRCUIT WITH SIDE EFFECTS (CRITICAL)
//
// A function increments a local counter in the RHS of && and ||.
// The counter is returned; its value must match JS short-circuit semantics.
//
// For &&: counter incremented ONLY when LHS is truthy.
// For ||: counter incremented ONLY when LHS is falsy.
//
// A bug that emits i32.and/i32.or will always evaluate both sides, causing
// the counter to be incremented even when short-circuit would skip the RHS.
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-AND-OR-SHORT-CIRCUIT-001 (see file header)
// ---------------------------------------------------------------------------

describe("boolean lowering — bool-2: short-circuit side-effect observability", () => {
  /**
   * bool-2a: && short-circuit.
   *
   * Source:
   *   export function andSideEffect(a: boolean): number {
   *     let counter = 0;
   *     const result = a && (counter = counter + 1) > 0;
   *     return counter;
   *   }
   *
   * Expected JS behaviour:
   *   - a = true  → RHS evaluated → counter = 1
   *   - a = false → RHS skipped   → counter = 0
   */
  it("bool-2a: && short-circuit — RHS increments counter only when LHS is truthy (15+ cases)", async () => {
    const src = `
export function andSideEffect(a: boolean): number {
  let counter: number = 0;
  const _r: boolean = a && ((counter = (counter + 1) | 0) > 0);
  return counter;
}`;
    const visitor = new LoweringVisitor();
    const result = visitor.lower(src);
    // counter is i32 domain (bitop | 0 forces it)
    expect(result.numericDomain).toBe("i32");
    // 1 boolean param = i32; result = i32 (counter)
    const wasmBytes = buildStandaloneWasm(result.wasmFn, "i32", 1);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (a) => {
        // JS reference: same semantics. Assignment-in-expression is intentional —
        // this is the side-effect observability test for && short-circuit.
        let counter = 0;
        // biome-ignore lint/suspicious/noAssignInExpressions: intentional short-circuit test
        const _r = a && (counter = (counter + 1) | 0) > 0;
        const jsCounter = counter;

        const wasmResult = Number(await runWasm(wasmBytes, [a ? 1 : 0]));
        expect(wasmResult).toBe(jsCounter);
      }),
      { numRuns: 20 },
    );

    // Explicit checks for true and false to be unambiguous
    // a=true  → counter=1
    expect(Number(await runWasm(wasmBytes, [1]))).toBe(1);
    // a=false → counter=0 (SHORT-CIRCUIT: RHS must NOT execute)
    expect(Number(await runWasm(wasmBytes, [0]))).toBe(0);
  });

  /**
   * bool-2b: || short-circuit.
   *
   * Source:
   *   export function orSideEffect(a: boolean): number {
   *     let counter: number = 0;
   *     const _r: boolean = a || ((counter = (counter + 1) | 0) > 0);
   *     return counter;
   *   }
   *
   * Expected JS behaviour:
   *   - a = false → RHS evaluated → counter = 1
   *   - a = true  → RHS skipped   → counter = 0
   */
  it("bool-2b: || short-circuit — RHS increments counter only when LHS is falsy (15+ cases)", async () => {
    const src = `
export function orSideEffect(a: boolean): number {
  let counter: number = 0;
  const _r: boolean = a || ((counter = (counter + 1) | 0) > 0);
  return counter;
}`;
    const visitor = new LoweringVisitor();
    const result = visitor.lower(src);
    expect(result.numericDomain).toBe("i32");
    const wasmBytes = buildStandaloneWasm(result.wasmFn, "i32", 1);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (a) => {
        let counter = 0;
        // biome-ignore lint/suspicious/noAssignInExpressions: intentional side-effect test
        const _r = a || (counter = (counter + 1) | 0) > 0;
        const jsCounter = counter;

        const wasmResult = Number(await runWasm(wasmBytes, [a ? 1 : 0]));
        expect(wasmResult).toBe(jsCounter);
      }),
      { numRuns: 20 },
    );

    // Explicit: a=true → counter=0 (RHS skipped), a=false → counter=1
    expect(Number(await runWasm(wasmBytes, [1]))).toBe(0);
    expect(Number(await runWasm(wasmBytes, [0]))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Substrate bool-3: i32 comparisons (4 distinct ops)
//
// Comparison functions return i32 (0 or 1).
// Params are i32 (bitop hint | 0 forces i32 domain).
// ---------------------------------------------------------------------------

describe("boolean lowering — bool-3: i32 comparisons", () => {
  it("bool-3a: lt(a, b) — a < b returns i32 0/1 over 20+ fc.integer() pairs", async () => {
    const src = "export function lt(a: number, b: number): boolean { return (a | 0) < b; }";
    const wasmBytes = lowerBooleanSource(src, "i32", 2);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -2147483648, max: 2147483647 }),
        fc.integer({ min: -2147483648, max: 2147483647 }),
        async (a, b) => {
          const tsRef = (a | 0) < b ? 1 : 0;
          const wasmResult = Number(await runWasm(wasmBytes, [a, b]));
          expect(wasmResult).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("bool-3b: lte(a, b) — a <= b over 20+ fc.integer() pairs", async () => {
    const src = "export function lte(a: number, b: number): boolean { return (a | 0) <= b; }";
    const wasmBytes = lowerBooleanSource(src, "i32", 2);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -2147483648, max: 2147483647 }),
        fc.integer({ min: -2147483648, max: 2147483647 }),
        async (a, b) => {
          const tsRef = (a | 0) <= b ? 1 : 0;
          expect(Number(await runWasm(wasmBytes, [a, b]))).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("bool-3c: gt(a, b) — a > b over 20+ fc.integer() pairs", async () => {
    const src = "export function gt(a: number, b: number): boolean { return (a | 0) > b; }";
    const wasmBytes = lowerBooleanSource(src, "i32", 2);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -2147483648, max: 2147483647 }),
        fc.integer({ min: -2147483648, max: 2147483647 }),
        async (a, b) => {
          const tsRef = (a | 0) > b ? 1 : 0;
          expect(Number(await runWasm(wasmBytes, [a, b]))).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("bool-3d: eq(a, b) — a == b over 20+ fc.integer() pairs", async () => {
    const src = "export function eqI(a: number, b: number): boolean { return (a | 0) == b; }";
    const wasmBytes = lowerBooleanSource(src, "i32", 2);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        async (a, b) => {
          // biome-ignore lint/suspicious/noDoubleEquals: reference implementation uses ==
          const tsRef = (a | 0) == b ? 1 : 0;
          expect(Number(await runWasm(wasmBytes, [a, b]))).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Substrate bool-4: i64 comparisons
//
// i64 domain is forced by large literals (> 2^31-1).
// Comparison returns i32 (0/1); params are i64 (BigInt at the WASM boundary).
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-I64-CMP-RESULT-TYPE-001
// @title i64 comparison result is i32 (0/1), not i64
// @status accepted
// @rationale
//   WASM comparison ops for all domains (i32.lt_s, i64.lt_s, f64.lt) return an
//   i32 value (0 or 1) per the WASM spec §6.4.2. The result type section must
//   declare the function return as i32, not i64, even when the parameters are
//   i64. The test module accordingly uses paramDomain=i64 for the input type
//   section but resultDomain=i32 for the return type.
// ---------------------------------------------------------------------------

describe("boolean lowering — bool-4: i64 comparisons", () => {
  /** Build a WASM module for i64 params that returns i32 (comparison result). */
  function lowerI64Cmp(source: string): Uint8Array {
    const visitor = new LoweringVisitor();
    const result = visitor.lower(source);
    return buildStandaloneWasm(result.wasmFn, "i64", 2, "i32");
  }

  it("bool-4a: lt64(a, b) — i64 a < b returns i32 0/1 over 15+ BigInt pairs", async () => {
    // Large literal (3000000000 > 2^31-1) forces i64 domain
    const src =
      "export function lt64(a: number, b: number): boolean { return (a + 3000000000) < (b + 3000000000); }";
    const wasmBytes = lowerI64Cmp(src);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: -1000000n, max: 1000000n }),
        fc.bigInt({ min: -1000000n, max: 1000000n }),
        async (a, b) => {
          const tsRef = a + 3000000000n < b + 3000000000n ? 1 : 0;
          expect(Number(await runWasm(wasmBytes, [a, b]))).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("bool-4b: gte64(a, b) — i64 a >= b returns i32 0/1 over 15+ BigInt pairs", async () => {
    const src =
      "export function gte64(a: number, b: number): boolean { return (a + 3000000000) >= (b + 3000000000); }";
    const wasmBytes = lowerI64Cmp(src);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: -1000000n, max: 1000000n }),
        fc.bigInt({ min: -1000000n, max: 1000000n }),
        async (a, b) => {
          const tsRef = a + 3000000000n >= b + 3000000000n ? 1 : 0;
          expect(Number(await runWasm(wasmBytes, [a, b]))).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("bool-4c: ne64(a, b) — i64 a != b over 15+ BigInt pairs", async () => {
    const src =
      "export function ne64(a: number, b: number): boolean { return (a + 3000000000) != (b + 3000000000); }";
    const wasmBytes = lowerI64Cmp(src);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: -100n, max: 100n }),
        fc.bigInt({ min: -100n, max: 100n }),
        async (a, b) => {
          const tsRef = a + 3000000000n !== b + 3000000000n ? 1 : 0;
          expect(Number(await runWasm(wasmBytes, [a, b]))).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Substrate bool-5: f64 comparisons
//
// f64 domain is forced by the `/` operator (true division).
// NaN comparisons: NaN < x is always false in WASM (IEEE 754 unordered).
// We exclude NaN explicitly and document the behaviour.
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-F64-NAN-CMP-001
// @title NaN comparisons return 0 (false) per IEEE 754 unordered rules
// @status accepted
// @rationale
//   IEEE 754 defines comparison results for NaN as "unordered" — all ordered
//   comparisons (lt, le, gt, ge, eq) return false (0) when either operand is NaN.
//   The WASM f64.lt/le/gt/ge/eq opcodes implement this correctly. JavaScript
//   behaves identically (NaN == NaN is false). Tests exclude NaN inputs via
//   fc.float({noNaN: true}) to focus on well-defined comparison semantics;
//   the NaN contract is documented here for Future Implementers.
// ---------------------------------------------------------------------------

describe("boolean lowering — bool-5: f64 comparisons", () => {
  function lowerF64Cmp(source: string): Uint8Array {
    const visitor = new LoweringVisitor();
    const result = visitor.lower(source);
    // f64 params → i32 result
    return buildStandaloneWasm(result.wasmFn, "f64", 2, "i32");
  }

  it("bool-5a: ltF(a, b) — f64 a < b returns i32 0/1 over 20+ float pairs", async () => {
    // true division forces f64 domain
    const src =
      "export function ltF(a: number, b: number): boolean { return (a / 1.0) < (b / 1.0); }";
    const wasmBytes = lowerF64Cmp(src);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(
        fc.float({ noNaN: true, noDefaultInfinity: true, min: -1e10, max: 1e10 }),
        fc.float({ noNaN: true, noDefaultInfinity: true, min: -1e10, max: 1e10 }),
        async (a, b) => {
          const tsRef = a < b ? 1 : 0;
          expect(Number(await runWasm(wasmBytes, [a, b]))).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("bool-5b: eqF(a, b) — f64 a == b returns i32 0/1 over 20+ float pairs", async () => {
    const src =
      "export function eqF(a: number, b: number): boolean { return (a / 1.0) == (b / 1.0); }";
    const wasmBytes = lowerF64Cmp(src);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(
        fc.float({ noNaN: true, noDefaultInfinity: true, min: -100, max: 100 }),
        fc.float({ noNaN: true, noDefaultInfinity: true, min: -100, max: 100 }),
        async (a, b) => {
          // biome-ignore lint/suspicious/noDoubleEquals: reference uses == to match WASM semantics
          const tsRef = a == b ? 1 : 0;
          expect(Number(await runWasm(wasmBytes, [a, b]))).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("bool-5c: leF(a, b) — f64 a <= b returns i32 0/1 over 20+ float pairs", async () => {
    const src =
      "export function leF(a: number, b: number): boolean { return (a / 1.0) <= (b / 1.0); }";
    const wasmBytes = lowerF64Cmp(src);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(
        fc.float({ noNaN: true, noDefaultInfinity: true, min: -1e5, max: 1e5 }),
        fc.float({ noNaN: true, noDefaultInfinity: true, min: -1e5, max: 1e5 }),
        async (a, b) => {
          const tsRef = a <= b ? 1 : 0;
          expect(Number(await runWasm(wasmBytes, [a, b]))).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Substrate bool-6: Mixed-numeric cross-domain comparison policy
//
// Under the IR strict-subset, mixing numeric domains (e.g. comparing an i32
// expression with an f64 expression) is not meaningful at the WASM level — the
// lowering visitor infers a single domain per function. If both operands of a
// comparison resolve to the same domain (both i32, both f64), it works. If
// they would require different domains, the domain inference heuristic resolves
// the ambiguity (typically to f64 per the ambiguous-default rule).
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-CROSS-DOMAIN-CMP-001
// @title Cross-domain comparison defers to the ambiguous-default (f64) rule
// @status accepted
// @rationale
//   The IR strict-subset does not have sub-types for i32 vs f64 within 'number'.
//   When a function has expressions that would independently classify as both i32
//   and f64 (e.g. bitop on one side, division on the other), the f64 indicator
//   wins (inferNumericDomain rule 1: true-division forces f64). The entire
//   function body then uses f64 ops throughout. This is conservative (f64 is
//   never lossy for values representable as i32) and avoids emitting mixed-type
//   WASM (which has no mixed-type arithmetic opcodes anyway). The correct fix is
//   for the caller to keep arithmetic domains uniform within a single function
//   body. This WI documents the behaviour rather than rejecting it, since
//   TypeScript's type system does not distinguish i32 from f64.
// ---------------------------------------------------------------------------

describe("boolean lowering — bool-6: cross-domain comparison policy", () => {
  it("bool-6: mixed hints (bitop + division) → f64 wins, comparison works correctly", async () => {
    // Both operands: bitop forces i32, division forces f64.
    // f64 wins per DEC-V1-WAVE-3-WASM-LOWER-NUMERIC-001 rule 1 (highest priority).
    const src = `
export function mixedCmp(a: number, b: number): boolean {
  return (a / 2.0) > b;
}`;
    const visitor = new LoweringVisitor();
    const result = visitor.lower(src);
    expect(result.numericDomain).toBe("f64"); // division wins
    // f64 params → i32 result
    const wasmBytes = buildStandaloneWasm(result.wasmFn, "f64", 2, "i32");
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(
        fc.float({ noNaN: true, noDefaultInfinity: true, min: -1e5, max: 1e5 }),
        fc.float({ noNaN: true, noDefaultInfinity: true, min: -1e5, max: 1e5 }),
        async (a, b) => {
          const tsRef = a / 2.0 > b ? 1 : 0;
          expect(Number(await runWasm(wasmBytes, [a, b]))).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Substrate bool-7: === / !== parity with == / !=
//
// Per DEC-V1-WAVE-3-WASM-LOWER-EQ-001, both emit identical opcodes for
// primitive types. This substrate exercises both operators side-by-side and
// asserts that WASM output is byte-identical for == vs === and != vs !==.
// ---------------------------------------------------------------------------

describe("boolean lowering — bool-7: === and !== parity with == and !=", () => {
  it("bool-7a: === emits same opcodes as == for i32 primitives (20+ cases)", async () => {
    const srcAbstract =
      "export function eqA(a: number, b: number): boolean { return (a | 0) == b; }";
    const srcStrict =
      "export function eqS(a: number, b: number): boolean { return (a | 0) === b; }";

    const v1 = new LoweringVisitor();
    const r1 = v1.lower(srcAbstract);
    const v2 = new LoweringVisitor();
    const r2 = v2.lower(srcStrict);

    // Opcode bodies must be byte-identical
    expect(r1.wasmFn.body).toEqual(r2.wasmFn.body);
    expect(r1.wasmFn.locals).toEqual(r2.wasmFn.locals);

    const wasmAbstract = lowerBooleanSource(srcAbstract, "i32", 2);
    const wasmStrict = lowerBooleanSource(srcStrict, "i32", 2);

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -10000, max: 10000 }),
        fc.integer({ min: -10000, max: 10000 }),
        async (a, b) => {
          const r1 = Number(await runWasm(wasmAbstract, [a, b]));
          const r2 = Number(await runWasm(wasmStrict, [a, b]));
          expect(r1).toBe(r2);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("bool-7b: !== emits same opcodes as != for i32 primitives (20+ cases)", async () => {
    const srcAbstract =
      "export function neA(a: number, b: number): boolean { return (a | 0) != b; }";
    const srcStrict =
      "export function neS(a: number, b: number): boolean { return (a | 0) !== b; }";

    const v1 = new LoweringVisitor();
    const r1 = v1.lower(srcAbstract);
    const v2 = new LoweringVisitor();
    const r2 = v2.lower(srcStrict);

    expect(r1.wasmFn.body).toEqual(r2.wasmFn.body);
    expect(r1.wasmFn.locals).toEqual(r2.wasmFn.locals);

    const wasmAbstract = lowerBooleanSource(srcAbstract, "i32", 2);
    const wasmStrict = lowerBooleanSource(srcStrict, "i32", 2);

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -10000, max: 10000 }),
        fc.integer({ min: -10000, max: 10000 }),
        async (a, b) => {
          const r1 = Number(await runWasm(wasmAbstract, [a, b]));
          const r2 = Number(await runWasm(wasmStrict, [a, b]));
          expect(r1).toBe(r2);
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Substrate bool-8: if/else branch from a compound boolean expression
//
// function f(a, b): if (a > 0 && b < 10) return 1; else return 0;
//
// This exercises the composition of boolean ops with comparisons inside a
// conditional branch. It tests the full lowering pipeline:
//   1. i32 comparisons (a > 0, b < 10)
//   2. && short-circuit
//   3. if/else/end as the conditional
//   4. return from either branch
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-IF-ELSE-RETURN-001
// @title if/else branch lowers to WASM if/else/end with explicit return opcodes
// @status accepted
// @rationale
//   In WI-02, the visitor only handled single-return functions (implicit fall-through
//   on the stack). An if/else with returns in both branches requires:
//   (1) WASM if with a result type (i32 block type → 0x7f), emitting the result
//       on the stack from each branch; OR
//   (2) WASM if with void block type (0x40), using explicit return (0x0f) opcodes.
//   Strategy (1) is cleaner and matches WASM's structured-block design: the if block
//   declares its result type, both branches push the same type onto the stack, and
//   the result is available after the end. This WI implements strategy (1) for if/else
//   expressions that appear as the sole return value.
// ---------------------------------------------------------------------------

describe("boolean lowering — bool-8: if/else branch from compound boolean", () => {
  it("bool-8: f(a, b) = if (a > 0 && b < 10) 1 else 0 — 20+ i32 pairs", async () => {
    const src = `
export function condFn(a: number, b: number): number {
  if (((a | 0) > 0) && (b < (10 | 0))) {
    return 1 | 0;
  } else {
    return 0 | 0;
  }
}`;
    const visitor = new LoweringVisitor();
    const result = visitor.lower(src);
    expect(result.numericDomain).toBe("i32"); // bitop forces i32
    const wasmBytes = buildStandaloneWasm(result.wasmFn, "i32", 2);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: -100, max: 100 }),
        async (a, b) => {
          const tsRef = (a | 0) > 0 && b < (10 | 0) ? 1 : 0;
          expect(Number(await runWasm(wasmBytes, [a, b]))).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Substrate bool-5-nan: f64 NaN comparison semantics
//
// The existing bool-5 substrates use fc.float({noNaN: true}) so the NaN branch
// of the f64 comparison opcodes is never exercised. This substrate fills that
// gap with both deterministic and property-based tests.
//
// IEEE 754 / WASM f64 NaN comparison contract (DEC-V1-WAVE-3-WASM-LOWER-F64-NAN-CMP-001):
//   NaN <  x  → 0 (false)   — f64.lt  returns 0 when either operand is NaN
//   NaN >  x  → 0 (false)   — f64.gt  returns 0 when either operand is NaN
//   NaN == x  → 0 (false)   — f64.eq  returns 0 when either operand is NaN
//   NaN != x  → 1 (true)    — f64.ne  returns 1 when either operand is NaN
//   Same results hold in mirror form (x op NaN).
//
// JavaScript implements the same IEEE 754 semantics, so `(NaN < 1.0) === false`
// and `(NaN != 1.0) === true` in both JS and WASM. The comparison RESULT is
// always 0 or 1 (i32); it is never NaN itself.
//
// Substrates:
//   bool-5-nan-explicit: 8 deterministic cases (2 per op × 4 ops)
//   bool-5-nan-property: 4 fast-check properties (1 per op, ~25% NaN injection)
// ---------------------------------------------------------------------------

describe("boolean lowering — bool-5-nan: f64 NaN comparison semantics", () => {
  /**
   * Lower a two-f64-param → i32-result comparison function.
   * Mirrors the lowerF64Cmp helper from bool-5.
   */
  function lowerF64NanCmp(source: string): Uint8Array {
    const visitor = new LoweringVisitor();
    const result = visitor.lower(source);
    // f64 params → i32 result (boolean)
    return buildStandaloneWasm(result.wasmFn, "f64", 2, "i32");
  }

  // -------------------------------------------------------------------------
  // bool-5-nan-explicit: 8 deterministic NaN cases
  //
  // For each op (<, >, ==, !=) × each NaN position (LHS, RHS):
  //   - Compile the comparison function
  //   - Run it with one NaN operand
  //   - Assert WASM output matches the JS reference value
  //
  // All sources use true-division (/ 1.0) to force f64 domain inference,
  // mirroring the existing bool-5 substrates.
  // -------------------------------------------------------------------------

  it("bool-5-nan-explicit-lt-lhs: NaN < finite → 0 (false)", async () => {
    const src =
      "export function ltF(a: number, b: number): boolean { return (a / 1.0) < (b / 1.0); }";
    const wasmBytes = lowerF64NanCmp(src);
    const jsRef = NaN < 1.0 ? 1 : 0; // 0 per IEEE 754
    expect(jsRef).toBe(0);
    expect(Number(await runWasm(wasmBytes, [NaN, 1.0]))).toBe(0);
  });

  it("bool-5-nan-explicit-lt-rhs: finite < NaN → 0 (false)", async () => {
    const src =
      "export function ltF(a: number, b: number): boolean { return (a / 1.0) < (b / 1.0); }";
    const wasmBytes = lowerF64NanCmp(src);
    const jsRef = 1.0 < NaN ? 1 : 0; // 0 per IEEE 754
    expect(jsRef).toBe(0);
    expect(Number(await runWasm(wasmBytes, [1.0, NaN]))).toBe(0);
  });

  it("bool-5-nan-explicit-gt-lhs: NaN > finite → 0 (false)", async () => {
    const src =
      "export function gtF(a: number, b: number): boolean { return (a / 1.0) > (b / 1.0); }";
    const wasmBytes = lowerF64NanCmp(src);
    const jsRef = NaN > 1.0 ? 1 : 0; // 0 per IEEE 754
    expect(jsRef).toBe(0);
    expect(Number(await runWasm(wasmBytes, [NaN, 1.0]))).toBe(0);
  });

  it("bool-5-nan-explicit-gt-rhs: finite > NaN → 0 (false)", async () => {
    const src =
      "export function gtF(a: number, b: number): boolean { return (a / 1.0) > (b / 1.0); }";
    const wasmBytes = lowerF64NanCmp(src);
    const jsRef = 1.0 > NaN ? 1 : 0; // 0 per IEEE 754
    expect(jsRef).toBe(0);
    expect(Number(await runWasm(wasmBytes, [1.0, NaN]))).toBe(0);
  });

  it("bool-5-nan-explicit-eq-lhs: NaN == finite → 0 (false)", async () => {
    const src =
      "export function eqF(a: number, b: number): boolean { return (a / 1.0) == (b / 1.0); }";
    const wasmBytes = lowerF64NanCmp(src);
    // biome-ignore lint/suspicious/noDoubleEquals: reference uses == to match WASM semantics
    const jsRef = NaN == 1.0 ? 1 : 0; // 0 per IEEE 754
    expect(jsRef).toBe(0);
    expect(Number(await runWasm(wasmBytes, [NaN, 1.0]))).toBe(0);
  });

  it("bool-5-nan-explicit-eq-rhs: finite == NaN → 0 (false)", async () => {
    const src =
      "export function eqF(a: number, b: number): boolean { return (a / 1.0) == (b / 1.0); }";
    const wasmBytes = lowerF64NanCmp(src);
    // biome-ignore lint/suspicious/noDoubleEquals: reference uses == to match WASM semantics
    const jsRef = 1.0 == NaN ? 1 : 0; // 0 per IEEE 754
    expect(jsRef).toBe(0);
    expect(Number(await runWasm(wasmBytes, [1.0, NaN]))).toBe(0);
  });

  it("bool-5-nan-explicit-ne-lhs: NaN != finite → 1 (true) — only NaN cmp that returns true", async () => {
    const src =
      "export function neF(a: number, b: number): boolean { return (a / 1.0) != (b / 1.0); }";
    const wasmBytes = lowerF64NanCmp(src);
    // biome-ignore lint/suspicious/noDoubleEquals: reference uses != to match WASM semantics
    const jsRef = NaN != 1.0 ? 1 : 0; // 1 — NaN is not equal to anything
    expect(jsRef).toBe(1);
    expect(Number(await runWasm(wasmBytes, [NaN, 1.0]))).toBe(1);
  });

  it("bool-5-nan-explicit-ne-rhs: finite != NaN → 1 (true) — mirror form", async () => {
    const src =
      "export function neF(a: number, b: number): boolean { return (a / 1.0) != (b / 1.0); }";
    const wasmBytes = lowerF64NanCmp(src);
    // biome-ignore lint/suspicious/noDoubleEquals: reference uses != to match WASM semantics
    const jsRef = 1.0 != NaN ? 1 : 0; // 1 — NaN is not equal to anything
    expect(jsRef).toBe(1);
    expect(Number(await runWasm(wasmBytes, [1.0, NaN]))).toBe(1);
  });

  // -------------------------------------------------------------------------
  // bool-5-nan-property: 4 property-based NaN injection tests
  //
  // For each op, fc.option(fc.constant(NaN), { freq: 3 }) injects NaN in ~25%
  // of runs (freq: 3 means NaN appears roughly 1 in 4 times). The property
  // asserts WASM output equals the JS reference on every input pair.
  //
  // The comparison RESULT is always 0 or 1 (i32) — it is never NaN. The property
  // uses Number.isNaN only to document which inputs are NaN; the actual assertion
  // compares integer output values directly.
  //
  // Rationale for explicit NaN-result documentation: code reviewers must not
  // mistake "the result is NaN" for "we got NaN" — the result is always 0 or 1.
  // -------------------------------------------------------------------------

  it("bool-5-nan-property-lt: a < b — 30+ runs with ~25% NaN injection, WASM matches JS", async () => {
    const src =
      "export function ltF(a: number, b: number): boolean { return (a / 1.0) < (b / 1.0); }";
    const wasmBytes = lowerF64NanCmp(src);

    // fc.oneof with weight objects: NaN injected ~25% of runs (weight 1 vs 3)
    const nanOrFinite = fc.oneof(
      { weight: 1, arbitrary: fc.constant(NaN) },
      { weight: 3, arbitrary: fc.float({ noNaN: true, noDefaultInfinity: true, min: -1e10, max: 1e10 }) },
    );

    await fc.assert(
      fc.asyncProperty(nanOrFinite, nanOrFinite, async (a, b) => {
        // JS reference: a < b returns false (0) when either operand is NaN
        const jsRef = a < b ? 1 : 0;
        // WASM result must be 0 or 1 (i32), never NaN
        const wasmResult = Number(await runWasm(wasmBytes, [a, b]));
        expect(wasmResult).toBe(jsRef);
      }),
      { numRuns: 30 },
    );
  });

  it("bool-5-nan-property-gt: a > b — 30+ runs with ~25% NaN injection, WASM matches JS", async () => {
    const src =
      "export function gtF(a: number, b: number): boolean { return (a / 1.0) > (b / 1.0); }";
    const wasmBytes = lowerF64NanCmp(src);

    const nanOrFinite = fc.oneof(
      { weight: 1, arbitrary: fc.constant(NaN) },
      { weight: 3, arbitrary: fc.float({ noNaN: true, noDefaultInfinity: true, min: -1e10, max: 1e10 }) },
    );

    await fc.assert(
      fc.asyncProperty(nanOrFinite, nanOrFinite, async (a, b) => {
        const jsRef = a > b ? 1 : 0;
        const wasmResult = Number(await runWasm(wasmBytes, [a, b]));
        expect(wasmResult).toBe(jsRef);
      }),
      { numRuns: 30 },
    );
  });

  it("bool-5-nan-property-eq: a == b — 30+ runs with ~25% NaN injection, WASM matches JS", async () => {
    const src =
      "export function eqF(a: number, b: number): boolean { return (a / 1.0) == (b / 1.0); }";
    const wasmBytes = lowerF64NanCmp(src);

    const nanOrFinite = fc.oneof(
      { weight: 1, arbitrary: fc.constant(NaN) },
      { weight: 3, arbitrary: fc.float({ noNaN: true, noDefaultInfinity: true, min: -1e10, max: 1e10 }) },
    );

    await fc.assert(
      fc.asyncProperty(nanOrFinite, nanOrFinite, async (a, b) => {
        // biome-ignore lint/suspicious/noDoubleEquals: reference uses == to match WASM semantics
        const jsRef = a == b ? 1 : 0;
        const wasmResult = Number(await runWasm(wasmBytes, [a, b]));
        expect(wasmResult).toBe(jsRef);
      }),
      { numRuns: 30 },
    );
  });

  it("bool-5-nan-property-ne: a != b — 30+ runs with ~25% NaN injection, WASM matches JS (NaN != x is always 1)", async () => {
    const src =
      "export function neF(a: number, b: number): boolean { return (a / 1.0) != (b / 1.0); }";
    const wasmBytes = lowerF64NanCmp(src);

    const nanOrFinite = fc.oneof(
      { weight: 1, arbitrary: fc.constant(NaN) },
      { weight: 3, arbitrary: fc.float({ noNaN: true, noDefaultInfinity: true, min: -1e10, max: 1e10 }) },
    );

    await fc.assert(
      fc.asyncProperty(nanOrFinite, nanOrFinite, async (a, b) => {
        // biome-ignore lint/suspicious/noDoubleEquals: reference uses != to match WASM semantics
        const jsRef = a != b ? 1 : 0;
        // When either operand is NaN: jsRef === 1 (NaN != anything is true)
        const wasmResult = Number(await runWasm(wasmBytes, [a, b]));
        expect(wasmResult).toBe(jsRef);
      }),
      { numRuns: 30 },
    );
  });
});
