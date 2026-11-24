# DEC-DUC-OPERATIONS-AS-ATOMS-001: a small set of leaves; every other operation is an atom

**Status:** Decided by the user (2026-11-24). Its words:

> "do 1 and 2, start with Math, write the DEC.. labels to more complex operations and trees are
> great and useful but they should be refs into the root of the operation as implemented in
> graphs not bare ops implemented separately"

and, on how the atoms are made:

> "the right way to do this is to be able to shave C down to atoms.. again, shave EVERYTHING"

**Date:** 2026-11-24
**Issues:**
- https://github.com/cneckar/yakcc/issues/1329 (shaving the platform)
- https://github.com/cneckar/yakcc/issues/1332 (ECMAScript built-ins as atoms)
- https://github.com/cneckar/yakcc/issues/1291 and https://github.com/cneckar/yakcc/issues/1292 (the format lock)

**Builds on:**
- DEC-DUC-CROSS-LANGUAGE-OPS-001 (operations named by meaning);
- DEC-DUC-GRAPH-ROOT-001 (a root commits to a graph's links);
- DEC-DUC-WASM-MEMORY-001 (the runtime's operations written as atoms).

**Must land before:** DEC-DUC-FORMAT-001 locks. What is a leaf is part of every identity built on it.

---

## Question

A graph names operations: `js.add`, `.slice`, `Math.sin`, `ToNumber`. Each lowering (TypeScript, native, wasm, JVM, Python, Go, Rust) implements each named operation separately. So:

- **The meaning of an operation lives outside the graph.** It lives in seven implementations, which can disagree.
- **Some already disagree.** ECMAScript calls `Math.sin`, `exp`, `pow` and the other transcendental functions *implementation-approximated*. V8, a C libm and Java's StrictMath differ in the last bit. The native lowering refuses `Math.sin` for that reason, and the JVM lowering refuses `exp`, `cbrt`, `atan2` and `hypot`.
- **It is not shaved.** `sin` is a graph of float64 arithmetic. So is `Number.prototype.toString`, `String.prototype.slice`, and JavaScript's `+`.

## Decision

### 1. The leaves are few, and are named in one place

A **leaf** is an operation a target implements itself. It is exact, total, and has one meaning:

| Leaves | Meaning |
|---|---|
| float64 `+ − × ÷`, `√`, negation, `abs` | IEEE 754, round to nearest even |
| fixed-width integers: 32-bit multiply (`__ykI32Mul`), 64-bit wrap (`__ykU64`, `__ykI64`), and conversions between widths and to and from float64 (`__ykNumToBig`, `__ykBigToI32`, `__ykBigToU32`, `__ykBigToF64`, `__ykF64ToI64`) | two's complement, as C's fixed-width types; a float64 to an integer truncates |
| a float64's 64 bits: `__ykF64Bits(x)`, `__ykF64FromBits(b)` | its representation (`bit_cast`, a union, `memcpy`). Its 32-bit words are integer operations on the bits |
| `floor`, `ceil`, `trunc` | exact |
| comparisons and equality on float64 | IEEE 754 |
| memory (#1363): `__ykAlloc(n, align)`, `__ykFree(p)`, `__ykData(kind, values)` (constant memory); `__ykLoad{8,16,32,64,F32,F64}(p)`, unsigned; `__ykStore{8,16,32,64,F32,F64}(p, v)`; and `__ykF32(x)`, rounding to binary32 | one flat, byte-addressed, little-endian memory per program. An address is an integer below 2^53, so address arithmetic is float64 arithmetic. Address 0 is never allocated. An access is defined inside a live block. The reference implementation traps outside one; a native lowering may leave the check out where the source's own meaning leaves the access undefined (C's out-of-bounds access). A signed load is the integer operations on an unsigned one |
| bitwise `& \| ^ ~ << >> >>>` on numbers | ECMAScript's, ToInt32/ToUint32 included: exactly specified, total |
| the string primitives: a UTF-16 unit, a substring by checked bounds, a join, the length | DEC-DUC-WASM-MEMORY-001 |
| objects, arrays and closures: make, read a slot, write a slot | the heap |
| control: branches, loops, calls, `throw`, the try, coroutine and await primitives | the graph's structure |
| the layer-0 base set (#1331) | effects: time, randomness, I/O |

The table is the list, kept in one module: `packages/duc/src/leaves.ts` (`LEAF_FUNCTIONS`, `LEAF_OPERATIONS`), with each leaf function's reference implementation (`leafFunctionsJs`). A lowering implements these and nothing else.

*Amended 2026-11-24 (#1362, #1363):*
- the float64-word leaves (`__ykF64Hi`, `__ykF64Lo`, `__ykF64Make`) are dropped, since they are integer operations on `__ykF64Bits`;
- the memory leaves are added. They are named as the C front end raises them (#1372).

### 2. Every other operation is an atom, and a label is a reference to its root

- **An atom.** Every operation not in the table is an atom, a graph over leaves and other atoms. Examples:
  - every `Math` function;
  - ToNumber, ToString and ToPrimitive;
  - JavaScript's `+`, `==` and `<` on values of any kind;
  - every string, array, object, JSON and Number method.
- **A reference.** In a graph, such an operation keeps its readable label (`Math.sin`, `js.add`). The label is a reference: the graph's links bind it to the root of the atom that implements it. The link's reason is `operation`.
- **Roots commit.** A graph's root commits to its links (DEC-DUC-GRAPH-ROOT-001). So the root says which implementation the graph uses, and changing an implementation changes the root of every graph that uses it, never silently.
- **Identity** stays structural, with the readable label in it: two graphs that call `Math.sin` have the same identity.
- **Closure.** A graph whose non-leaf label has no link is not closed, as an unresolved reference is not.
- **Lowering.** A lowering lowers a referenced atom's graph, inline or as a function, as it lowers any atom. It never writes its own `sin`.

### 3. Atoms are shaved, never written by hand

An operation's atom is shaved from the source that implements it, never rewritten by hand:
- JavaScript and TypeScript, by the lifter;
- C and C++, by the C front end (`raise-c.ts`).

**The C front end.**
- **Parsing:** clang parses a translation unit with its own preprocessor and type checker. Macros are expanded, and every implicit conversion and promotion is explicit in its typed AST.
- **Raising:** each function is raised mechanically, with C's meaning on every value. It goes through the same lifter, as the Python raiser does.
  - 32-bit integers wrap. Unsigned values have logical shifts.
  - A comparison is an `int` in C and a `bool` in C++.
  - 64-bit integers wrap through the fixed-width leaves.
  - A conversion from `double` truncates.
  - `bit_cast`, and a union of 64-bit views, read or write a float64's bits.
  - A backward `goto` within a block is a loop it continues.
- **Calls:** a call is a reference.
  - A function whose body clang has is raised too: the unit's own, a header's inline function, a template's instance, the standard library's `numeric_limits`. So is a constant at namespace scope.
  - A compiler builtin that is an exact IEEE 754 operation is a leaf.
  - A function with no body here is an external reference, linked to the atom another unit shaves. V8's `scalbn` is linked to musl's.
- **Refusal:** anything else is refused with a reason. Nothing is guessed.

### 4. The meaning of an approximated function is its atom

- **The rule.** Where ECMAScript leaves a function implementation-approximated, the atom fixes it. Every target then computes the same bits.
- **Which algorithm.** The atoms are V8 12.4's own: its `src/base/ieee754.cc` (fdlibm), shaved. Node v22's build computes exactly these, `sin` and `cos` included. So a program run in Node agrees with its graph lowered anywhere.
- **Tests.** Each atom is tested bit for bit (`Object.is`), on edge values and generated doubles (±0, ±∞, NaN, subnormals, random bit patterns), against two oracles: the same C compiled natively by clang, and Node's `Math`.

### 5. Language structure

Labels for language structure keep their current form for now:
- classes and their members;
- generators and `for await`;
- `try`;
- holes.

Where such a label denotes an operation with a meaning a graph can state, it becomes a reference by the same rule. For example, defining a class is an operation over objects and closures. The emitted TypeScript then writes the source's form, so the round trip holds.

## Plan

1. **`Math`** (#1332): done by shaving.
   - V8 12.4's `ieee754.cc` (vendored in `packages/duc/vendor/v8`) shaves whole: 21 functions, their kernels, and the header code they call.
   - musl's `scalbn.c` (`packages/duc/vendor/musl`) supplies the one external.
   - Each atom equals native C and Node's `Math` bit for bit, as raised and as lifted to a graph and lowered (`raise-c.test.ts`).
2. **References** (#1362), done for `Math`:
   - **Lifting.** The lifter writes `Math.f(..)` as the operation `Math.f` for the 21 functions with atoms. It is pure, as `+` is, and has no read of `Math`. This applies when `Math` is the platform's and the call has the function's arity and no spread. `operations.ts` lists the references.
   - **The atom library.** The atoms are committed as their shaved TypeScript (`src/atoms/math.ts`, generated by `scripts/shave-math.ts`). A test checks that file against a fresh shave whenever clang is present.
   - **Roots.** An atom's root is its graph's root, with its references to other atoms (`__kernel_sin`, musl's `scalbn`) linked to their roots.
   - **Links.** A graph's links gain the reason `operation`: `{operation, Math.sin, <root of sin>}`. So a graph's root commits to the implementation it uses.
   - **Closure.** The closure check counts an operation reference as linked, and a leaf function as a leaf.
   - **The TypeScript lowering** writes `Math.f(..)`, so the round trip holds.
   - **Evidence.** Every atom, lifted to its graph and lowered to TypeScript over the leaves' reference implementations, equals Node's `Math` bit for bit (`operations.test.ts`).
   - **Other lowerings.** Each lowers the atom's graph (`atomGraph`, `linkedAtomGraph`). The native, wasm and JVM lowerings refuse the reference until they do (lane:native, #1361). Python, Go and Rust write it as the member call they wrote before.
   - **Labels with no atom yet.** `js.*` on values of any kind, the other `Math` functions and the methods stay as they are. They become references, with the closure check requiring a link for every non-leaf label, as step 3 shaves their atoms.
3. **The other operations:** `js.*` on values of any kind, ToNumber/ToString/ToPrimitive, and the string and array methods. The WasmGC/JVM lane's runtime atoms (`wasm-runtime-atoms.ts`) are written this way already. They move under the same references, and the native, Python, Go and Rust lowerings consume them instead of their own.
4. **The lock:** DEC-DUC-FORMAT-001 locks after steps 1 and 2, with the leaf table above in it.

## Consequences

- **Smaller lowerings.** A new target implements the table and nothing more.
- **One definition.** An operation has one definition, tested once against the reference engine, instead of seven that drift.
- **Same bits everywhere.** Transcendental functions compute the same bits on every target.
- **Larger graphs to lower** (the atoms'). A lowering may still choose a native instruction for an atom when it proves the instruction computes the atom's bits, as `floor` already is a leaf for that reason. The atom stays the definition.
