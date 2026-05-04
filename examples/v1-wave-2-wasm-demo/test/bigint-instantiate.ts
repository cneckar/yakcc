// SPDX-License-Identifier: MIT
/**
 * bigint-instantiate.ts — Test-local bigint-returning WASM instantiation helper.
 *
 * @decision DEC-WI-FOLLOWUP-WIDEADD-001
 * @title i64-boundary coverage via test-local bigint helper (no production-source modification)
 * @status decided (WI-FOLLOWUP-LOWER-02-WIDEADD)
 * @rationale
 *   Issue #48 primary suggestion was to modify `instantiateAndRun` in
 *   `packages/compile/src/wasm-host.ts` to return `bigint` for i64-domain
 *   functions. Production source is in scope-forbidden `packages/**`.
 *
 *   Adopted alternative: this test-local helper file inside
 *   `examples/v1-wave-2-wasm-demo/test/` wraps WebAssembly instantiation and
 *   returns the i64 result as JS `bigint` directly, bypassing the `number`
 *   cast in `instantiateAndRun`. Existing `instantiateAndRun` callers are
 *   untouched.
 *
 *   Mechanism: WASM i64 exports are marshalled to JS `bigint` by V8/Node.js per
 *   the WebAssembly JS API spec (WebAssembly.Function with i64 result type returns
 *   BigInt at the JS boundary). The `instantiateAndRun` production helper casts
 *   the return to `number` (losing precision beyond 2^53 - 1 = Number.MAX_SAFE_INTEGER).
 *   This helper returns the raw JS value from the WASM export call as `bigint`,
 *   preserving full i64 precision.
 *
 * @sacred-practice-4 truncation-injection-walkthrough
 *   If a hypothetical `& 0xFFFFFFFFn` truncation existed in the visitor that
 *   assembled the i64 WASM binary, wideAdd(2^53, 1) would produce a 32-bit-
 *   truncated value (likely 0n or 1n) rather than 9007199254740993n. The
 *   deterministic boundary test in parity.test.ts asserts exact bigint equality:
 *     expect(result).toEqual(9007199254740993n)
 *   With truncation the assertion would fail:
 *     expected 9007199254740993n, got <truncated value>
 *   This confirms the boundary tests catch the synthetic regression without
 *   requiring an actual bug injection.
 */

import { type CreateHostOptions, type YakccHost, createHost } from "@yakcc/compile";

/**
 * Instantiate a yakcc WASM binary and call one exported function, returning
 * the result as JS `bigint` (preserving full i64 precision).
 *
 * Unlike the production `instantiateAndRun`, this helper does NOT cast the
 * WASM call result to `number`. WASM i64 exports return a JS `bigint` at
 * the V8/Node.js boundary per the WebAssembly JS API spec — this value is
 * returned directly.
 *
 * Use this helper when the WASM export has i64 return type and the expected
 * result may exceed Number.MAX_SAFE_INTEGER (2^53 - 1 = 9007199254740991).
 *
 * @param bytes  - Valid .wasm binary (e.g., from wasmBackend().emit())
 * @param fnName - Name of the exported function to call (e.g., "__wasm_export_wideAdd")
 * @param args   - Arguments to pass. May include bigint values for i64 params.
 * @param opts   - Optional host configuration (passed to createHost)
 * @returns { result: bigint, host: YakccHost }
 * @throws TypeError if the export is not a function
 * @throws any WasmTrap propagated from host imports unchanged
 */
export async function instantiateAndRunBigInt(
  bytes: Uint8Array,
  fnName: string,
  args: (number | bigint)[],
  opts?: CreateHostOptions,
): Promise<{ result: bigint; host: YakccHost }> {
  const host = createHost(opts);

  // Cast through unknown: TS resolves WebAssembly.instantiate to Module→Instance
  // overload for some lib versions. The bytes overload always returns
  // WebAssemblyInstantiatedSource at runtime.
  const { instance } = (await WebAssembly.instantiate(
    bytes,
    host.importObject,
  )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;

  const fn = instance.exports[fnName];
  if (typeof fn !== "function") {
    throw new TypeError(`instantiateAndRunBigInt: export "${fnName}" is not a function`);
  }

  // Call the WASM function. For i64 return type, V8/Node.js returns a JS bigint.
  // We do NOT cast to number — that is the entire point of this helper.
  // Cast through the widest-correct type: WASM exports accept (number|bigint)[]
  // and return unknown (number, bigint, or void depending on WASM type).
  const rawResult: unknown = (fn as (...a: (number | bigint)[]) => unknown)(...args);

  // Normalize: if the engine already returned bigint (i64), use it directly.
  // If it returned number (i32 / f64 path), convert for uniform return type.
  const result: bigint = typeof rawResult === "bigint" ? rawResult : BigInt(rawResult as number);

  return { result, host };
}
