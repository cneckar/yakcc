// SPDX-License-Identifier: MIT
// Numeric substrate for the v1-wave-2 WASM parity demo.
//
// This function is the TypeScript-backend reference for the numeric-substrate
// parity harness in test/parity.test.ts. The ts-backend output for an add(a,b)
// block is semantically identical to this function; the WASM backend exports
// __wasm_export_add which implements the same i32 addition.
//
// @decision DEC-V1W2-WASM-DEMO-TSREF-001
// title: use imported substrate source as ts-backend execution reference
// status: decided (WI-V1W2-WASM-04)
// rationale:
//   Executing the tsBackend().emit() output at runtime requires either
//   (a) a Node.js TypeScript evaluator (not available without extra deps in
//   Node 22.22.2 — node:amaro is absent), or (b) writing the output to disk
//   and dynamic-importing it (vitest module graph complications). The ts-backend
//   output for a single-block substrate is the source function plus a re-export
//   wrapper — semantically identical to importing the source directly. We import
//   the source function, call tsBackend().emit() to verify it produces valid
//   TypeScript, and use the imported function for value-level comparison.
//   This matches the existing wasm-host.test.ts Test 8 pattern
//   (DEC-V1-WAVE-2-WASM-TEST-002).

export function add(a: number, b: number): number {
  return a + b;
}
