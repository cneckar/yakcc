// SPDX-License-Identifier: MIT
//
// control-flow-parity.test.ts — AS-backend T3: control-flow substrates (P3 bucket)
//
// @decision DEC-AS-CONTROL-FLOW-001
// Title: AS-backend control-flow substrates emit pure scalar functions whose
//        branch, loop, and switch constructs are fully preserved by asc 0.28.x
//        without any workarounds in as-backend.ts.
// Status: decided (WI-AS-PHASE-2G-CONTROL-FLOW, 2026-05-10)
// Rationale:
//   AS/asc supports if/else, while, for, do-while, and switch natively.
//   All five constructs lower to standard WASM control instructions (if/else,
//   loop/br_if, block/br_table). No src/ changes are required. The test suite
//   exercises each construct with a TS reference oracle and 20 fast-check runs
//   to verify value parity. exportMemory: false (default) is used throughout
//   since these substrates take only scalar i32 arguments.
//
// Five substrates (per eval contract T3):
//   CF1: classify       — if / else-if / else (3 branches, tests all sign cases)
//   CF2: sumToN         — while loop (sum 0..n-1, verifies triangular number)
//   CF3: product        — for loop (factorial, small inputs to avoid overflow)
//   CF4: countdown      — do-while (count up until n reaches 0, min 1 iteration)
//   CF5: dayName        — switch with default (3 explicit cases + default)
//
// Minimum 20 fast-check runs per substrate (eval contract T3).
//
// @decision DEC-AS-PARITY-TEST-NODE-WASM-001 (inherited from numeric-parity.test.ts)
// @decision DEC-AS-PARITY-TEST-RESOLUTION-BUILDER-001 (inherited from numeric-parity.test.ts)

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type BlockMerkleRoot,
  type LocalTriplet,
  type SpecYak,
  blockMerkleRoot,
  specHash,
} from "@yakcc/contracts";
import { assemblyScriptBackend } from "../../src/as-backend.js";
import type { ResolutionResult, ResolvedBlock } from "../../src/resolve.js";

// ---------------------------------------------------------------------------
// Fixture helpers — mirror records-parity.test.ts pattern exactly
// ---------------------------------------------------------------------------

const MINIMAL_MANIFEST_JSON = JSON.stringify({
  artifacts: [{ kind: "property_tests", path: "tests.fast-check.ts" }],
});

function makeSpecYak(name: string, behavior: string): SpecYak {
  return {
    name,
    inputs: [{ name: "a", type: "number" }],
    outputs: [{ name: "result", type: "number" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior,
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe" },
    propertyTests: [],
  };
}

function makeMerkleRoot(name: string, behavior: string, implSource: string): BlockMerkleRoot {
  const spec = makeSpecYak(name, behavior);
  const manifest = JSON.parse(MINIMAL_MANIFEST_JSON) as {
    artifacts: Array<{ kind: string; path: string }>;
  };
  const artifactBytes = new TextEncoder().encode(implSource);
  const artifactsMap = new Map<string, Uint8Array>();
  for (const art of manifest.artifacts) {
    artifactsMap.set(art.path, artifactBytes);
  }
  return blockMerkleRoot({
    spec,
    implSource,
    manifest: manifest as LocalTriplet["manifest"],
    artifacts: artifactsMap,
  });
}

function makeResolution(
  blocks: ReadonlyArray<{ id: BlockMerkleRoot; source: string }>,
): ResolutionResult {
  const blockMap = new Map<BlockMerkleRoot, ResolvedBlock>();
  const order: BlockMerkleRoot[] = [];
  for (const { id, source } of blocks) {
    const sh = specHash(makeSpecYak(id.slice(0, 8), `behavior-${id.slice(0, 8)}`));
    blockMap.set(id, { merkleRoot: id, specHash: sh, source, subBlocks: [] });
    order.push(id);
  }
  const entry = order[order.length - 1] as BlockMerkleRoot;
  return { entry, blocks: blockMap, order };
}

function makeSourceResolution(name: string, source: string): ResolutionResult {
  const id = makeMerkleRoot(name, `Control-flow substrate: ${name}`, source);
  return makeResolution([{ id, source }]);
}

// ---------------------------------------------------------------------------
// CF1: classify — if / else-if / else
//
// AS source: classify(x: i32): i32
//   Returns -1 for x < 0, 0 for x === 0, 1 for x > 0.
//
// TS reference: Math.sign (equivalent to JS Math.sign, integer output).
// Tests all 3 branches: negative, zero, positive.
// @decision DEC-AS-CONTROL-FLOW-001
// ---------------------------------------------------------------------------

describe("AS backend control-flow — CF1: classify (if/else-if/else)", () => {
  // exportMemory: false (default) — pure scalar function, no memory required.
  // @decision DEC-AS-BACKEND-OPTIONS-001
  const CLASSIFY_SOURCE = `
export function classify(x: i32): i32 {
  if (x < 0) return -1;
  else if (x === 0) return 0;
  else return 1;
}
`.trim();

  it("CF1: classify compiles to valid WASM", async () => {
    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("classify", CLASSIFY_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "classify WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.classify).toBe("function");
  }, 30_000);

  it("CF1: classify — all 3 branch outcomes verified (negative / zero / positive)", async () => {
    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("classify", CLASSIFY_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const fn = instance.exports.classify as (x: number) => number;

    // Fixed branch-coverage checks before property testing
    expect(fn(-1)).toBe(-1);   // negative branch
    expect(fn(0)).toBe(0);     // zero branch
    expect(fn(1)).toBe(1);     // positive branch
    expect(fn(-999)).toBe(-1);
    expect(fn(999)).toBe(1);
  }, 30_000);

  it("CF1: classify — value parity vs TS Math.sign reference (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("classify", CLASSIFY_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const fn = instance.exports.classify as (x: number) => number;

    await fc.assert(
      fc.asyncProperty(
        // Use full i32 range; include 0 explicitly via frequency weighting
        fc.oneof(
          fc.constant(0),
          fc.integer({ min: -2_147_483_648, max: -1 }),
          fc.integer({ min: 1, max: 2_147_483_647 }),
        ),
        async (x) => {
          // TS reference: Math.sign truncated to i32 {-1, 0, 1}
          const tsRef = x < 0 ? -1 : x === 0 ? 0 : 1;
          expect(fn(x)).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// CF2: sumToN — while loop
//
// AS source: sumToN(n: i32): i32
//   Accumulates sum of 0, 1, ..., n-1 using a while loop.
//   Returns n*(n-1)/2 for n > 0; returns 0 for n <= 0 (loop body skipped).
//
// TS reference: triangular number formula (n * (n - 1)) / 2.
// Constrained to n in [0, 10_000] to keep both TS and WASM within i32 range:
//   max sum = 10_000 * 9_999 / 2 = 49_995_000 < 2^31-1 = 2_147_483_647.
// @decision DEC-AS-CONTROL-FLOW-001
// ---------------------------------------------------------------------------

describe("AS backend control-flow — CF2: sumToN (while loop)", () => {
  const SUMTON_SOURCE = `
export function sumToN(n: i32): i32 {
  let s: i32 = 0;
  let i: i32 = 0;
  while (i < n) {
    s += i;
    i++;
  }
  return s;
}
`.trim();

  it("CF2: sumToN compiles to valid WASM", async () => {
    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("sumToN", SUMTON_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "sumToN WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.sumToN).toBe("function");
  }, 30_000);

  it("CF2: sumToN — fixed cases: n=0, n=1, n=5, n=10", async () => {
    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("sumToN", SUMTON_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const fn = instance.exports.sumToN as (n: number) => number;

    expect(fn(0)).toBe(0);           // loop not entered
    expect(fn(1)).toBe(0);           // 0 only (sum of [0])
    expect(fn(5)).toBe(10);          // 0+1+2+3+4 = 10
    expect(fn(10)).toBe(45);         // 0+1+...+9 = 45
    expect(fn(100)).toBe(4950);      // 0+...+99 = 4950
  }, 30_000);

  it("CF2: sumToN — value parity vs triangular formula (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("sumToN", SUMTON_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const fn = instance.exports.sumToN as (n: number) => number;

    await fc.assert(
      fc.asyncProperty(
        // n in [0, 10_000]: max sum = 49_995_000 < INT32_MAX, no overflow
        fc.integer({ min: 0, max: 10_000 }),
        async (n) => {
          // TS reference: Gauss triangular formula
          const tsRef = (n * (n - 1)) / 2;
          expect(fn(n)).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// CF3: product — for loop (factorial)
//
// AS source: product(n: i32): i32
//   Computes n! using a for loop over [1, n].
//   product(0) = 1 (empty product, loop not entered).
//
// TS reference: iterative factorial (same loop in JS).
//
// Fast-check range: n in [0, 12].
//   12! = 479_001_600 < 2^31-1 (no i32 overflow).
//   13! = 6_227_020_800 > 2^31-1 (wraps in WASM i32 arithmetic, making
//   TS/WASM comparison undefined without explicit truncation).
//   Capped at 12 to keep the oracle trivially comparable.
// @decision DEC-AS-CONTROL-FLOW-001
// ---------------------------------------------------------------------------

describe("AS backend control-flow — CF3: product (for loop / factorial)", () => {
  const PRODUCT_SOURCE = `
export function product(n: i32): i32 {
  let p: i32 = 1;
  for (let i: i32 = 1; i <= n; i++) {
    p *= i;
  }
  return p;
}
`.trim();

  it("CF3: product compiles to valid WASM", async () => {
    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("product", PRODUCT_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "product WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.product).toBe("function");
  }, 30_000);

  it("CF3: product — fixed factorial cases: 0! through 12!", async () => {
    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("product", PRODUCT_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const fn = instance.exports.product as (n: number) => number;

    // Known factorial values within i32 range
    const FACTORIALS = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800, 39916800, 479001600];
    for (let n = 0; n <= 12; n++) {
      expect(fn(n)).toBe(FACTORIALS[n]);
    }
  }, 30_000);

  it("CF3: product — value parity vs TS iterative factorial (20 fast-check cases, n in [0,12])", async () => {
    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("product", PRODUCT_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const fn = instance.exports.product as (n: number) => number;

    await fc.assert(
      fc.asyncProperty(
        // [0,12]: 12! = 479_001_600 < INT32_MAX; 13! overflows i32
        fc.integer({ min: 0, max: 12 }),
        async (n) => {
          // TS reference: iterative factorial (same semantics as AS for loop)
          let tsRef = 1;
          for (let i = 1; i <= n; i++) tsRef *= i;
          expect(fn(n)).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// CF4: countdown — do-while loop
//
// AS source: countdown(n: i32): i32
//   Counts how many times we decrement n until n reaches 0.
//   The do-while body always executes at least once (even for n <= 0).
//   For n > 0: returns n (decrements n times before n hits 0).
//   For n <= 0: returns 1 (single iteration: c++ runs, n-- makes n <= -1,
//     loop exits because n > 0 is false).
//
// TS reference: max(n, 1) — the minimum is 1 due to the do-while guarantee.
// @decision DEC-AS-CONTROL-FLOW-001
// ---------------------------------------------------------------------------

describe("AS backend control-flow — CF4: countdown (do-while loop)", () => {
  const COUNTDOWN_SOURCE = `
export function countdown(n: i32): i32 {
  let c: i32 = 0;
  do {
    c++;
    n--;
  } while (n > 0);
  return c;
}
`.trim();

  it("CF4: countdown compiles to valid WASM", async () => {
    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("countdown", COUNTDOWN_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "countdown WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.countdown).toBe("function");
  }, 30_000);

  it("CF4: countdown — fixed cases verify do-while executes at least once", async () => {
    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("countdown", COUNTDOWN_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const fn = instance.exports.countdown as (n: number) => number;

    // Edge: n <= 0 always yields 1 (do-while body fires exactly once)
    expect(fn(0)).toBe(1);
    expect(fn(-1)).toBe(1);
    expect(fn(-100)).toBe(1);
    // Positive n: returns n (counts down n times)
    expect(fn(1)).toBe(1);
    expect(fn(5)).toBe(5);
    expect(fn(10)).toBe(10);
  }, 30_000);

  it("CF4: countdown — value parity vs max(n,1) reference (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("countdown", COUNTDOWN_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const fn = instance.exports.countdown as (n: number) => number;

    await fc.assert(
      fc.asyncProperty(
        // Keep n small to avoid long-running loops in property tests.
        // n in [-1000, 1000]: worst case = 1000 iterations, fast enough.
        fc.integer({ min: -1_000, max: 1_000 }),
        async (n) => {
          // TS reference: do-while runs at least once, so count = max(n, 1)
          const tsRef = Math.max(n, 1);
          expect(fn(n)).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// CF5: dayName — switch with default
//
// AS source: dayName(d: i32): i32
//   Maps d to an integer code: 0→100, 1→101, 2→102, anything else→99.
//   Tests: 3 explicit cases + default branch.
//
// TS reference: inline switch equivalent.
// The returned integer codes are arbitrary distinguishable constants — the
// important property is that each branch maps to a unique code and the
// default is different from all explicit cases.
// @decision DEC-AS-CONTROL-FLOW-001
// ---------------------------------------------------------------------------

describe("AS backend control-flow — CF5: dayName (switch with default)", () => {
  const DAYNAME_SOURCE = `
export function dayName(d: i32): i32 {
  switch (d) {
    case 0: return 100;
    case 1: return 101;
    case 2: return 102;
    default: return 99;
  }
}
`.trim();

  it("CF5: dayName compiles to valid WASM", async () => {
    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("dayName", DAYNAME_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "dayName WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.dayName).toBe("function");
  }, 30_000);

  it("CF5: dayName — all explicit cases and default verified", async () => {
    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("dayName", DAYNAME_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const fn = instance.exports.dayName as (d: number) => number;

    // Explicit switch cases
    expect(fn(0)).toBe(100);
    expect(fn(1)).toBe(101);
    expect(fn(2)).toBe(102);
    // Default branch: any other value
    expect(fn(-1)).toBe(99);
    expect(fn(3)).toBe(99);
    expect(fn(100)).toBe(99);
    expect(fn(-999)).toBe(99);
  }, 30_000);

  it("CF5: dayName — value parity vs TS switch reference (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("dayName", DAYNAME_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const fn = instance.exports.dayName as (d: number) => number;

    await fc.assert(
      fc.asyncProperty(
        // Mix of in-range and out-of-range values to exercise both explicit cases and default
        fc.oneof(
          fc.constantFrom(0, 1, 2),                          // explicit cases
          fc.integer({ min: -100, max: 100 }).filter(d => d < 0 || d > 2), // default branch
        ),
        async (d) => {
          // TS reference: inline switch equivalent
          let tsRef: number;
          switch (d) {
            case 0: tsRef = 100; break;
            case 1: tsRef = 101; break;
            case 2: tsRef = 102; break;
            default: tsRef = 99;
          }
          expect(fn(d)).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Compound-interaction test
//
// Exercises the full production sequence end-to-end for a representative
// control-flow substrate: source → AS backend → WASM bytes → instantiate →
// export call → value check crossing multiple internal component boundaries.
//
// Uses CF2 (sumToN) as it is the simplest loop with a closed-form oracle
// that verifies WASM execution state transitions (loop init, condition, body,
// increment, exit).
//
// @decision DEC-AS-PARITY-TEST-NODE-WASM-001 (inherited from numeric-parity.test.ts)
// @decision DEC-AS-CONTROL-FLOW-001
// ---------------------------------------------------------------------------

describe("AS backend control-flow — compound-interaction (end-to-end production sequence)", () => {
  it("CF2/compound: sumToN via full source→backend→wasm→instantiate→call sequence", async () => {
    const SUMTON_SOURCE = `
export function sumToN(n: i32): i32 {
  let s: i32 = 0;
  let i: i32 = 0;
  while (i < n) {
    s += i;
    i++;
  }
  return s;
}
`.trim();

    const resolution = makeSourceResolution("compound-sumToN", SUMTON_SOURCE);
    const backend = assemblyScriptBackend();

    // Step 1: AS backend emits WASM bytes
    const wasmBytes = await backend.emit(resolution);

    // Step 2: bytes constitute a valid WASM module
    expect(WebAssembly.validate(wasmBytes), "WASM bytes must be valid").toBe(true);

    // Step 3: WASM magic header present (0x00 0x61 0x73 0x6d)
    expect(wasmBytes[0]).toBe(0x00);
    expect(wasmBytes[1]).toBe(0x61);
    expect(wasmBytes[2]).toBe(0x73);
    expect(wasmBytes[3]).toBe(0x6d);

    // Step 4: instantiate and call — verify loop state transitions
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const fn = instance.exports.sumToN as (n: number) => number;

    expect(fn(0)).toBe(0);       // loop not entered
    expect(fn(1)).toBe(0);       // single iteration: s += 0, i++ → exit
    expect(fn(5)).toBe(10);      // 0+1+2+3+4
    expect(fn(10)).toBe(45);     // Gauss: 10*9/2
    expect(fn(100)).toBe(4950);  // Gauss: 100*99/2

    // Step 5: backend identity
    expect(backend.name).toBe("as");
  }, 30_000);
});
