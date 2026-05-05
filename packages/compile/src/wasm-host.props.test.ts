// SPDX-License-Identifier: MIT
// Vitest harness for wasm-host.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling wasm-host.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_WasiErrno_BADF_is_8,
  prop_WasiErrno_SUCCESS_is_zero,
  prop_WasiErrno_values_are_injective,
  prop_WasiErrno_values_are_non_negative_integers,
  prop_WasmTrap_default_message_contains_kind,
  prop_WasmTrap_explicit_message_preserved,
  prop_WasmTrap_hostPanicCode_only_when_defined,
  prop_WasmTrap_is_Error_subclass,
  prop_WasmTrap_kind_preserved,
  prop_WasmTrap_name_is_WasmTrap,
  prop_createHost_host_alloc_advances_bump_ptr,
  prop_createHost_host_alloc_oom_throws_WasmTrap,
  prop_createHost_host_alloc_returns_number_in_heap,
  prop_createHost_host_panic_code_0x01_throws_oom_trap,
  prop_createHost_host_panic_throws_WasmTrap,
  prop_createHost_logs_accumulates_messages,
  prop_createHost_logs_starts_empty,
  prop_createHost_memory_is_one_page,
  prop_createHost_onLog_callback_is_called,
  prop_createHost_returns_importObject_with_yakcc_host,
} from "./wasm-host.props.js";

// Pure property tests (WasmTrap construction, WasiErrno constants): 100 runs.
// createHost() properties: 20 runs (allocates WebAssembly.Memory per run).
const pureOpts = { numRuns: 100 };
const hostOpts = { numRuns: 20 };

// WasmTrap
it("property: prop_WasmTrap_is_Error_subclass", () => {
  fc.assert(prop_WasmTrap_is_Error_subclass, pureOpts);
});

it("property: prop_WasmTrap_name_is_WasmTrap", () => {
  fc.assert(prop_WasmTrap_name_is_WasmTrap, pureOpts);
});

it("property: prop_WasmTrap_kind_preserved", () => {
  fc.assert(prop_WasmTrap_kind_preserved, pureOpts);
});

it("property: prop_WasmTrap_default_message_contains_kind", () => {
  fc.assert(prop_WasmTrap_default_message_contains_kind, pureOpts);
});

it("property: prop_WasmTrap_explicit_message_preserved", () => {
  fc.assert(prop_WasmTrap_explicit_message_preserved, pureOpts);
});

it("property: prop_WasmTrap_hostPanicCode_only_when_defined", () => {
  fc.assert(prop_WasmTrap_hostPanicCode_only_when_defined, pureOpts);
});

// WasiErrno
it("property: prop_WasiErrno_values_are_non_negative_integers", () => {
  fc.assert(prop_WasiErrno_values_are_non_negative_integers, pureOpts);
});

it("property: prop_WasiErrno_SUCCESS_is_zero", () => {
  fc.assert(prop_WasiErrno_SUCCESS_is_zero, pureOpts);
});

it("property: prop_WasiErrno_values_are_injective", () => {
  fc.assert(prop_WasiErrno_values_are_injective, pureOpts);
});

it("property: prop_WasiErrno_BADF_is_8", () => {
  fc.assert(prop_WasiErrno_BADF_is_8, pureOpts);
});

// createHost()
it("property: prop_createHost_returns_importObject_with_yakcc_host", () => {
  fc.assert(prop_createHost_returns_importObject_with_yakcc_host, hostOpts);
});

it("property: prop_createHost_memory_is_one_page", () => {
  fc.assert(prop_createHost_memory_is_one_page, hostOpts);
});

it("property: prop_createHost_logs_starts_empty", () => {
  fc.assert(prop_createHost_logs_starts_empty, hostOpts);
});

it("property: prop_createHost_host_alloc_returns_number_in_heap", () => {
  fc.assert(prop_createHost_host_alloc_returns_number_in_heap, hostOpts);
});

it("property: prop_createHost_host_alloc_advances_bump_ptr", () => {
  fc.assert(prop_createHost_host_alloc_advances_bump_ptr, hostOpts);
});

it("property: prop_createHost_host_panic_throws_WasmTrap", () => {
  fc.assert(prop_createHost_host_panic_throws_WasmTrap, hostOpts);
});

it("property: prop_createHost_host_panic_code_0x01_throws_oom_trap", () => {
  fc.assert(prop_createHost_host_panic_code_0x01_throws_oom_trap, hostOpts);
});

it("property: prop_createHost_onLog_callback_is_called", () => {
  fc.assert(prop_createHost_onLog_callback_is_called, hostOpts);
});

it("property: prop_createHost_logs_accumulates_messages", () => {
  fc.assert(prop_createHost_logs_accumulates_messages, hostOpts);
});

it("property: prop_createHost_host_alloc_oom_throws_WasmTrap", () => {
  fc.assert(prop_createHost_host_alloc_oom_throws_WasmTrap, hostOpts);
});
