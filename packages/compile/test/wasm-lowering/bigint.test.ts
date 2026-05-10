/**
 * bigint.test.ts — Property-based tests for WI-V1W3-WASM-LOWER-04 bigint→i64 lowering.
 *
 * Purpose:
 *   Verify that the bigint-detection path in inferNumericDomain and the i64 bigint
 *   expression lowering in visitor.ts produce WASM byte sequences that execute
 *   correctly for bigint substrates. Each substrate is:
 *     (a) lowered via LoweringVisitor (the wave-3 path), and
 *     (b) evaluated against the JavaScript/BigInt reference,
 *   then run through ≥15 fast-check inputs asserting value parity.
 *
 * Substrate coverage:
 *   bigint-1: basic bigint arithmetic: `addBig(a, b) = a + b`
 *   bigint-2: bigint bitops: `bitsBig(a, b) = (a & b) | (a ^ b)`
 *   bigint-3: mixed bigint+number: `mixedBig(a: bigint, n: number) = a + BigInt(n)`
 *   bigint-4: edge values near i64 max/min (deterministic + property)
 *   bigint-5: overflow boundary — wraps at i64 boundary per BigInt.asIntN(64, ...)
 *   domain-inference: unit tests for the three bigint inference signals
 *
 * WASM binary construction:
 *   buildBigIntWasm() assembles a minimal WASM module using per-parameter types
 *   (from LoweringResult.paramDomains), which is required for mixed bigint+number
 *   functions that have heterogeneous WASM type signatures.
 *
 * Overflow semantics:
 *   WASM i64 is 64-bit two's-complement. BigInt is arbitrary-precision. The parity
 *   oracle for overflow is `BigInt.asIntN(64, x)`, which truncates to the low 64 bits.
 *   See @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-001 in visitor.ts.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-001 (see visitor.ts file header)
 * @decision DEC-V1-WAVE-3-WASM-LOWER-TEST-STANDALONE-001 (see numeric.test.ts)
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { LoweringError, LoweringVisitor } from "../../src/wasm-lowering/visitor.js";
import { valtypeByte } from "../../src/wasm-lowering/wasm-function.js";
import type { NumericDomain, WasmFunction } from "../../src/wasm-lowering/wasm-function.js";

// ---------------------------------------------------------------------------
// Minimal standalone WASM module builder (heterogeneous param types)
//
// Unlike numeric.test.ts buildStandaloneWasm (homogeneous), this builder
// accepts an explicit array of param valuetypes and a result valuetype so it
// can handle mixed bigint+number functions like mixedBig(a: bigint, n: number).
//
// Binary structure:
//   magic + version
//   type section:     1 type — functype(paramTypes → [resultType])
//   function section: 1 function — type index 0
//   export section:   export "fn" as function 0
//   code section:     1 function body from WasmFunction
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
 * Build a standalone WASM module with explicit per-parameter types and a result type.
 *
 * @param wasmFn      - WasmFunction IR from LoweringVisitor
 * @param paramDomains - Per-parameter numeric domains (used for type signature)
 * @param resultDomain - Result numeric domain
 */
function buildBigIntWasm(
  wasmFn: WasmFunction,
  paramDomains: ReadonlyArray<NumericDomain>,
  resultDomain: NumericDomain,
): Uint8Array {
  const paramVts = new Uint8Array(paramDomains.map(valtypeByte));
  const resultVt = valtypeByte(resultDomain);

  // Type section: paramTypes → [resultType]
  const funcTypeDef = concat(
    new Uint8Array([FUNCTYPE]),
    uleb128(paramDomains.length),
    paramVts,
    uleb128(1),
    new Uint8Array([resultVt]),
  );
  const typeSection = section(1, concat(uleb128(1), funcTypeDef));

  // Function section: 1 function, type 0
  const funcSection = section(3, concat(uleb128(1), uleb128(0)));

  // Export section: export "fn" as function 0
  const exportSection = section(
    7,
    concat(uleb128(1), encodeName("fn"), new Uint8Array([0x00, 0x00])),
  );

  // Code section: 1 function body
  const body = serializeWasmFn(wasmFn);
  const codeSection = section(10, concat(uleb128(1), uleb128(body.length), body));

  return concat(WASM_MAGIC, WASM_VERSION, typeSection, funcSection, exportSection, codeSection);
}

/**
 * Lower a bigint TypeScript source to a WasmFunction IR and build a standalone WASM binary.
 *
 * Uses LoweringResult.paramDomains for heterogeneous param types (bigint-3).
 */
function lowerBigIntToWasm(source: string): {
  wasmBytes: Uint8Array;
  domain: NumericDomain;
  paramDomains: ReadonlyArray<NumericDomain>;
  warnings: ReadonlyArray<string>;
} {
  const visitor = new LoweringVisitor();
  const result = visitor.lower(source);
  const domain = result.numericDomain ?? "i64";
  // Use per-param domains from the result (required for mixed bigint+number fns)
  const paramDomains =
    result.paramDomains ?? Array(result.wasmFn.locals.length).fill(domain);
  const wasmBytes = buildBigIntWasm(result.wasmFn, paramDomains, domain);
  return { wasmBytes, domain, paramDomains, warnings: result.warnings };
}

/**
 * Instantiate a standalone WASM binary and call "fn" with bigint arguments.
 * Returns the result as a bigint (i64 → BigInt at the JS/WASM boundary).
 */
async function runBigIntWasm(wasmBytes: Uint8Array, args: (bigint | number)[]): Promise<bigint> {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const fn = instance.exports["fn"] as (...a: unknown[]) => bigint;
  return fn(...args);
}

// ---------------------------------------------------------------------------
// bigint-1: basic bigint arithmetic
// ---------------------------------------------------------------------------

describe("bigint lowering — bigint-1: basic arithmetic", () => {
  it(
    "bigint-1: addBig(a, b) = a + b — domain is i64, ≥15 fast-check cases over ±1e12n",
    async () => {
      const src = "export function addBig(a: bigint, b: bigint): bigint { return a + b; }";
      const { wasmBytes, domain } = lowerBigIntToWasm(src);

      // Domain inference assertion
      expect(domain).toBe("i64");

      // Binary must be valid
      expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: -1000000000000n, max: 1000000000000n }),
          fc.bigInt({ min: -1000000000000n, max: 1000000000000n }),
          async (a, b) => {
            const tsRef = a + b;
            const wasmResult = await runBigIntWasm(wasmBytes, [a, b]);
            expect(wasmResult).toBe(tsRef);
          },
        ),
        { numRuns: 25 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// bigint-2: bigint bitops — verify I64_BITOP_OPS are emitted (not I32_BITOP_OPS)
// ---------------------------------------------------------------------------

describe("bigint lowering — bigint-2: bitwise operations", () => {
  it(
    "bigint-2: bitsBig(a, b) = (a & b) | (a ^ b) — i64.and (0x83) emitted, NOT i32.and (0x71)",
    async () => {
      const src =
        "export function bitsBig(a: bigint, b: bigint): bigint { return (a & b) | (a ^ b); }";
      const { wasmBytes, domain } = lowerBigIntToWasm(src);

      expect(domain).toBe("i64");
      expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

      // Opcode verification: the WASM bytes must contain i64.and (0x83), NOT i32.and (0x71).
      // We scan the code section bytes directly. i64.and = 0x83, i32.and = 0x71.
      // The code section is after magic+version+type+func+export sections (variable length),
      // so we scan all bytes for the opcode pattern.
      //
      // @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-001 (opcode check site)
      // This assertion is the authoritative proof that I64_BITOP_OPS is used for bigint domains.
      const bytes = Array.from(wasmBytes);
      expect(bytes).toContain(0x83); // i64.and must be present
      expect(bytes).toContain(0x84); // i64.or must be present
      expect(bytes).toContain(0x85); // i64.xor must be present
      expect(bytes).not.toContain(0x71); // i32.and must NOT be present for a bigint function

      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: -(2n ** 40n), max: 2n ** 40n }),
          fc.bigInt({ min: -(2n ** 40n), max: 2n ** 40n }),
          async (a, b) => {
            const tsRef = (a & b) | (a ^ b);
            const wasmResult = await runBigIntWasm(wasmBytes, [a, b]);
            expect(wasmResult).toBe(tsRef);
          },
        ),
        { numRuns: 25 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// bigint-3: mixed bigint + number — BigInt(n) coercion
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-COERCE-001 (see visitor.ts)
// BigInt(n) where n is i32-typed emits i64.extend_i32_s (0xac).
// The WASM function type is [i64, i32] → i64 (heterogeneous params).
// ---------------------------------------------------------------------------

describe("bigint lowering — bigint-3: mixed bigint+number (BigInt(n) coercion)", () => {
  it(
    "bigint-3: mixedBig(a: bigint, n: number) = a + BigInt(n) — i64.extend_i32_s coercion (0xac)",
    async () => {
      const src =
        "export function mixedBig(a: bigint, n: number): bigint { return a + BigInt(n); }";
      const { wasmBytes, domain, paramDomains } = lowerBigIntToWasm(src);

      expect(domain).toBe("i64");
      // Param types: [i64, i32] for (bigint, number)
      expect(paramDomains[0]).toBe("i64");
      expect(paramDomains[1]).toBe("i32");
      expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

      // Verify i64.extend_i32_s (0xac) is emitted for BigInt(n) coercion
      // @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-COERCE-001: i32→i64 via extend_i32_s
      const bytes = Array.from(wasmBytes);
      expect(bytes).toContain(0xac); // i64.extend_i32_s

      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: -1000000000000n, max: 1000000000000n }),
          fc.integer({ min: -2147483648, max: 2147483647 }),
          async (a, n) => {
            const tsRef = a + BigInt(n);
            const wasmResult = await runBigIntWasm(wasmBytes, [a, n]);
            expect(wasmResult).toBe(tsRef);
          },
        ),
        { numRuns: 25 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// bigint-4: edge values near i64 max/min
// ---------------------------------------------------------------------------

const I64_MAX = 9223372036854775807n; // 2^63 - 1
const I64_MIN = -9223372036854775808n; // -2^63

describe("bigint lowering — bigint-4: edge values near i64 max/min", () => {
  it(
    "bigint-4: edgeBig(a) = a + 1n — explicit boundary deterministic tests + ≥15 fc cases",
    async () => {
      const src = "export function edgeBig(a: bigint): bigint { return a + 1n; }";
      const { wasmBytes, domain } = lowerBigIntToWasm(src);

      expect(domain).toBe("i64");
      expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

      // Deterministic boundary tests: i64 max, min, max-1, min+1
      // Overflow at max wraps to min (two's-complement wrap)
      const boundaries: [bigint, bigint][] = [
        [I64_MAX, BigInt.asIntN(64, I64_MAX + 1n)], // max + 1 wraps to min
        [I64_MIN, I64_MIN + 1n], // min + 1 = min+1 (no overflow)
        [I64_MAX - 1n, I64_MAX], // max-1 + 1 = max
        [I64_MIN + 1n, I64_MIN + 2n], // min+1 + 1 = min+2
      ];

      for (const [input, expected] of boundaries) {
        const result = await runBigIntWasm(wasmBytes, [input]);
        expect(result).toBe(expected);
      }

      // Property: ≥15 fast-check cases in safe mid-range
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: -(2n ** 62n), max: 2n ** 62n }),
          async (a) => {
            const tsRef = BigInt.asIntN(64, a + 1n);
            const wasmResult = await runBigIntWasm(wasmBytes, [a]);
            expect(wasmResult).toBe(tsRef);
          },
        ),
        { numRuns: 25 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// bigint-5: overflow boundary — BigInt.asIntN(64, ...) is the parity oracle
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-001
// WASM i64 wraps at 2^63. BigInt.asIntN(64, x) truncates to 64-bit two's-complement.
// This substrate verifies that WASM overflow semantics match BigInt.asIntN(64, ...).
// ---------------------------------------------------------------------------

describe("bigint lowering — bigint-5: overflow boundary semantics", () => {
  it(
    "bigint-5: overflowAdd(a, b) = a + b — WASM i64 overflow === BigInt.asIntN(64, a+b)",
    async () => {
      const src =
        "export function overflowAdd(a: bigint, b: bigint): bigint { return a + b; }";
      const { wasmBytes, domain } = lowerBigIntToWasm(src);

      expect(domain).toBe("i64");
      expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

      // Deterministic overflow tests
      // (max, 1n) → -9223372036854775808n (wraps to min)
      const maxPlus1 = await runBigIntWasm(wasmBytes, [I64_MAX, 1n]);
      expect(maxPlus1).toBe(I64_MIN);

      // (min, -1n) → 9223372036854775807n (wraps to max)
      const minMinus1 = await runBigIntWasm(wasmBytes, [I64_MIN, -1n]);
      expect(minMinus1).toBe(I64_MAX);

      // (max, max) → -2n (two's-complement: 0x7fff... + 0x7fff... = 0xfffe... = -2)
      const maxPlusMax = await runBigIntWasm(wasmBytes, [I64_MAX, I64_MAX]);
      expect(maxPlusMax).toBe(-2n);

      // Property: for any (a, b) in i64 range, wasmResult === BigInt.asIntN(64, a+b)
      // @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-001: overflow truncation oracle
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: I64_MIN, max: I64_MAX }),
          fc.bigInt({ min: I64_MIN, max: I64_MAX }),
          async (a, b) => {
            const tsRef = BigInt.asIntN(64, a + b);
            const wasmResult = await runBigIntWasm(wasmBytes, [a, b]);
            expect(wasmResult).toBe(tsRef);
          },
        ),
        { numRuns: 25 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// domain-inference unit tests
//
// Verify the three inferNumericDomain bigint-detection signals independently:
//   (a) bigint parameter type alone → i64
//   (b) bigint return type alone → i64
//   (c) BigIntLiteral in body alone → i64
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-001 (inference site)
// ---------------------------------------------------------------------------

describe("bigint lowering — domain inference unit tests", () => {
  it("bigint param alone forces i64", () => {
    // Rule -1: bigint-typed param triggers i64, even with no BigIntLiteral in body.
    // Isolates the param-type signal from the return-type and body-scan signals.
    const visitor = new LoweringVisitor();
    expect(visitor.lower("export function f(a: bigint): bigint { return a; }").numericDomain).toBe("i64");
  });

  it("bigint return alone forces i64", () => {
    // Rule -1: bigint return type triggers i64 even when param is `number`.
    // Source has a number param and a bigint return (isolating the return-type signal).
    // The TypeScript return type is bigint but the param is number — this is a
    // semantic type error in strict TS, but the lowering pass checks syntax only
    // (DEC-V1-WAVE-3-WASM-LOWER-BIGINT-INFERENCE-002) so the AST is available.
    const visitor = new LoweringVisitor();
    expect(visitor.lower("export function f(a: number): bigint { return BigInt(a); }").numericDomain).toBe("i64");
  });

  it("BigIntLiteral in body alone forces i64", () => {
    // Rule 7: a BigIntLiteral (123n) in the body forces i64 even when the TypeScript
    // signature is `number, number → number` (no bigint type in param or return).
    // Rule -1 does not fire (no bigint-typed signature). Rule 7 fires on `123n`.
    // Source has a semantic type error ("bigint not assignable to number") but
    // _parseSource accepts it because only syntax errors are rejected
    // (DEC-V1-WAVE-3-WASM-LOWER-BIGINT-INFERENCE-002). Domain inference sees the
    // BigIntLiteral node and infers i64 — the body's bigint arithmetic dominates.
    const visitor = new LoweringVisitor();
    expect(visitor.lower("export function f(a: number, b: number): number { return 123n + BigInt(a); }").numericDomain).toBe("i64");
  });
});

// ---------------------------------------------------------------------------
// LOWER-03 regression: cross-domain comparison must throw LoweringError
//
// @decision DEC-V2-GLUE-AWARE-SHAVE-001 (L4-#57)
// @title Cross-domain comparison (bigint i64 vs number i32) detection
// @status decided
// Rationale: mixed i64/i32 operands in a comparison produce invalid WASM
// (type mismatch). Silently defaulting to f64 domain changes comparison
// semantics. Throwing LoweringError("unsupported-node") causes the glue-aware
// slicer to emit GlueLeafEntry so the TypeScript compilation path preserves
// correct comparison semantics verbatim.
// ---------------------------------------------------------------------------

describe("bigint lowering — cross-domain comparison throws LoweringError (LOWER-03 / L4-#57)", () => {
  it("throws LoweringError for bigint === number comparison", () => {
    const visitor = new LoweringVisitor();
    const src = `export function crossEq(a: bigint, n: number): boolean { return a === n; }`;
    expect(() => visitor.lower(src)).toThrow(LoweringError);
  });

  it("thrown error has kind 'unsupported-node'", () => {
    const visitor = new LoweringVisitor();
    const src = `export function crossEq(a: bigint, n: number): boolean { return a === n; }`;
    let caught: unknown;
    try {
      visitor.lower(src);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LoweringError);
    expect((caught as LoweringError).kind).toBe("unsupported-node");
  });

  it("error message mentions cross-domain comparison", () => {
    const visitor = new LoweringVisitor();
    const src = `export function crossEq(a: bigint, n: number): boolean { return a === n; }`;
    let caught: unknown;
    try {
      visitor.lower(src);
    } catch (e) {
      caught = e;
    }
    const msg = (caught as LoweringError).message;
    expect(msg).toContain("cross-domain");
    expect(msg).toContain("GlueLeafEntry");
  });

  it("bigint-only comparison still compiles (same-domain, no throw)", () => {
    const visitor = new LoweringVisitor();
    const src = `export function bigEq(a: bigint, b: bigint): boolean { return a === b; }`;
    expect(() => visitor.lower(src)).not.toThrow();
  });

  it("number-only comparison still compiles (same-domain, no throw)", () => {
    const visitor = new LoweringVisitor();
    const src = `export function numEq(a: number, b: number): boolean { return a === b; }`;
    expect(() => visitor.lower(src)).not.toThrow();
  });
});
