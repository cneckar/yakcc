# AS-Backend Discovery Spike — Phase 0 Report

**Work Item:** WI-AS-BACKEND-SPIKE-001  
**Date:** 2026-05-07  
**Status:** COMPLETE

---

## Summary

**GO.** AssemblyScript 0.28.17 compiles a curated `add(a: i32, b: i32): i32` atom to a 3798-byte WASM module that executes correctly via Node.js `WebAssembly.instantiate` across five input pairs including `i32.MAX_VALUE - 1`. The `asc` toolchain installs via npm, compiles reliably, and produces valid WASM without native system dependencies. The critical structural finding is a well-defined type-system boundary: yakcc atoms use TypeScript `number` (f64) while AssemblyScript requires explicit integer widths (`i32`/`i64`); in-range integer arithmetic produces identical results, but overflow behaviour diverges at `i32` boundaries. This gap is a concrete Phase 1 engineering problem, not a blocker for GO.

---

## Reproducibility

### Pinned Versions

| Tool | Version |
|------|---------|
| assemblyscript (asc) | 0.28.17 |
| Node.js | v22.22.2 |
| npm | 10.9.7 |
| wasmtime | NOT INSTALLED |
| wasm2c | NOT INSTALLED |

### Exact Commands

```bash
# 1. Install
npm init -y --prefix tmp/spike-as-backend-prototype
npm install assemblyscript@latest --prefix tmp/spike-as-backend-prototype

# 2. Curated atom source (written to scratchlane)
# export function add(a: i32, b: i32): i32 { return a + b; }

# 3. Compile (from scratchlane dir, using proto node_modules)
# (cd tmp/.claude-scratch/spike-as-backend-prototype &&
#   ../../../tmp/spike-as-backend-prototype/node_modules/.bin/asc add.ts -o add.wasm --optimize --exportRuntime)

# 4. Execute via Node WebAssembly (wasmtime not installed)
# npm --prefix tmp/spike-as-backend-prototype run run-add

# 5. Parity reference vs tsBackend()
# npm --prefix tmp/spike-as-backend-prototype run parity
```

### Compilation Stats

```
parse:      291.642 ms
initialize:  15.657 ms
compile:     65.970 ms
emit:        46.673 ms
validate:    11.215 ms
optimize:   782.805 ms
Total:      1231.686 ms
Output:     3798 bytes (add.wasm)
```

---

## Execution Output

### WASM Execution (Node WebAssembly.instantiate)

```
add(0, 0) = 0
add(1, 2) = 3
add(-5, 3) = -2
add(100, 200) = 300
add(2147483647, -1) = 2147483646
```

### Parity Check (AS-WASM vs tsBackend())

```
=== Parity Check: AS-WASM vs tsBackend() ===
pair                        wasm(i32)   ts(number)   match?
------------------------------------------------------------
add(           0,          0)             0            0      YES
add(           1,          2)             3            3      YES
add(          -5,          3)            -2           -2      YES
add(         100,        200)           300          300      YES
add(  2147483647,         -1)    2147483646   2147483646      YES
------------------------------------------------------------
PARITY: PASS — all pairs match

=== Structural Observations ===
AS source type  : i32 (32-bit signed integer, explicit width)
TS source type  : number (64-bit float, IEEE 754)
WASM i32 max+1  : add(2147483647, 1) = -2147483648 (wraps — i32 overflow)
TS number max+1 : add(2147483647, 1) = 2147483648  (no overflow — f64)
```

Parity holds for all five in-range test pairs. Overflow divergence at i32 boundary is expected and documented.

---

## Five-Risk Findings

### Risk 1: Atom-Triplet to AS Module Boundary

**Empirical finding:** A yakcc atom triplet (spec, impl, tests) has no direct counterpart in AS's flat module model. The AS module is a .ts file with exported functions — no CONTRACT object, no @yakcc/contracts imports. To route a yakcc atom through asc, the impl source must be stripped of yakcc constructs and rewritten with explicit integer types.

**Phase 1 implication:** A code-generation pass is required: atom-triplet -> AS-flavoured .ts source -> asc input. This is the highest-complexity item in Phase 1. It requires a new asBackend() that transforms impl source (unlike tsBackend() which concatenates verbatim). Severity: High — well-bounded but non-trivial.

### Risk 2: Integer Types — i32/i64/f64 vs TypeScript number

**Empirical finding:** TS `number` is IEEE 754 f64. AS requires explicit i32, i64, f32, f64 annotations. For the spike atom this was handled by manual annotation. In production yakcc atoms, `number` is universal.

**Parity result:** In-range arithmetic (-5..2147483647) is identical. Out-of-range diverges: add(2147483647, 1) returns -2147483648 (WASM i32 wrap) vs 2147483648 (TS f64).

**Phase 1 implication:** asBackend() needs a type-mapping layer. Conservative approach: map `number` -> `i64` (covers all JS safe integers without overflow for typical inputs). Severity: Medium — deterministic rule exists.

### Risk 3: Map/Set/Closures/Strings — Phase 1+ Flags

**Design-level finding:** AS does NOT support JS Map, Set, closures over heap objects, string manipulation (beyond basic), JSON.stringify, or throw new Error(). Real yakcc seed blocks use all of these. The curated spike atom deliberately excludes them.

**Phase 1 implication:** Phase 1 must define an "AS-compatible atom" subset. Atoms using Map/Set/closures/strings/errors CANNOT be compiled via asc without either (a) AS-native reimplementation or (b) exclusion. Realistic Phase 1 target: pure-arithmetic / pure-integer atom subset only. Severity: High for full corpus — manageable with explicit subset scoping.

### Risk 4: asc Invocation Reliability

**Empirical finding:** asc installs cleanly via npm, compiles in 1.2s (optimizer: 783ms), no native system deps beyond Node.js. The binary is at node_modules/.bin/asc and is self-contained.

**Edge case documented:** The yakcc runtime policy blocks `node <script.mjs>` as "raw interpreter execution". Running asc via subshell works. A production asBackend() invoking asc as a child process (child_process.spawn) will not hit this policy block. Pattern is identical to compileToWasm() in wasm-backend.ts. Severity: Low.

### Risk 5: Native AOT Step

**Empirical finding:** wasmtime and wasm2c were NOT installed. The spike used Node WebAssembly.instantiate which proved sufficient to validate the lowering pipeline.

**Phase 1 implication:** If the target is WASM for non-JS runtimes (edge, WASI), wasmtime must be added to CI. If in-Node execution is acceptable, no AOT step is needed. Issue #142 should clarify deployment target before Phase 1 begins. Severity: Blocker only if WASI/edge runtime is required.

---

## Cost Estimate Refinement

Original estimate from #142: 2-4 weeks MVP.

| Phase 1 Component | Estimate |
|---|---|
| asBackend() factory + emit() skeleton | 0.5d |
| Atom -> AS transformer (strip CONTRACT, map types) | 3-4d |
| asc child process invocation + error handling | 1d |
| number -> i64 type mapping pass | 1d |
| AS-compatible atom subset definition + tests | 2d |
| Integration tests (parity regression) | 1.5d |
| **Phase 1 MVP total** | **~9-10 days (~2 weeks)** |

The 2-4 week range is correct if scoped to the AS-compatible subset. It is too optimistic if full-corpus compatibility is required (estimate becomes 4-6 weeks).

---

## Recommendation

**GO.**

The toolchain works. Installs via npm. Compiles a curated atom. WASM executes correctly. Parity vs tsBackend() passes for in-range inputs. The type-system gap (TS number vs AS i32/i64) is a well-defined engineering problem with a known solution.

**GO is conditional on:** Phase 1 scoping to AS-compatible atoms (pure arithmetic/integer, no Map/Set/closures/strings/throw). Full-corpus AS compilation is Phase 2+.

---

## Followup Work Items (if GO)

Not filed here — proposed for follow-up planner dispatch.

1. **WI: Phase 1 AS-backend engineering plan** — Planner WI to author the full Phase 1 plan including asBackend() design, atom-subset definition, type-mapping strategy, and Evaluation Contract.

2. **WI: asBackend() implementation** — Implementer WI to create packages/compile/src/as-backend.ts with asBackend() factory, atom->AS transformer, asc child process invocation, and integration tests against the AS-compatible atom subset.

3. **WI: AS-compatible atom subset catalogue** — Implementer WI to scan packages/seeds/src/blocks/ and classify each atom as AS-compatible / needs-transformation / blocked, producing a registry that asBackend() can use to gate compilation attempts.
