# DEC-DUC-NATIVE-RUNTIME-001: NaN-boxed values and a C runtime for the native lowering

**Status:** Proposed (first slice built)
**Date:** 2026-11-23
**Issue:** https://github.com/cneckar/yakcc/issues/1292 (criteria 3 and 4)
**Related:** DEC-DUC-NATIVE-BACKEND-001 (LLVM backend), #1289 (the typed subset)

---

## Context

The typed native lowering covers numbers and booleans. Everything else a JavaScript graph computes
needs a representation and a runtime: strings, arrays, objects, closures, `undefined` and `null`.

Before the format locks, #1292 asks one question: **does the graph carry what such a lowering needs?**

## Decision

### Representation and runtime

**Values are NaN-boxed into one 64-bit word**, as JavaScript engines box them:
- a double is itself, with NaN canonical;
- every other value has a tag in the top 16 bits, a space no canonical double uses: 0xFFF9 for undefined, null and the booleans, then strings, arrays, objects and functions.

**Strings are UTF-16 code units**, as in JavaScript.

**The runtime is one C file**, `packages/duc/runtime/yk.c`.
- clang, LLVM's C compiler, compiles it for each target, so the lowering and the runtime come from one toolchain.
- It is linked like any C library.
- Its operations follow ECMA-262 for the values it covers:
  - ToNumber (the full StringNumericLiteral grammar) and ToString (Number::toString's shortest round-trip digits and layout);
  - ToPrimitive: an array's join, and an object's own `valueOf` / `toString`;
  - `+`, the arithmetic, relational and equality operators, `typeof`, truthiness;
  - property and index reads and writes;
  - the string builtins (`charCodeAt`, `slice`, `indexOf`, `split`, `includes`, `startsWith`, `endsWith`, `trim`);
  - the array builtins (`push`, `join`, `indexOf`, `slice`, `map`, `forEach`, `filter`, `reduce`, `some`, `every`, `find`, `findIndex`, `includes`, `sort`);
  - `String`, `Number` and `Boolean` as function values.
- **Objects** keep their own properties in insertion order.
- **Functions** have one calling convention: `(closure, this, argc, argv)`. A closure's graph is lowered to its own function. Its captures (the graph's first parameters) are read from the closure record, and its own parameters from `argv`, `undefined` past `argc`. A `function` takes the receiver a method call gives; an arrow does not.

**`emitLlvmBoxed`** lowers a graph to LLVM IR. Every value is an `i64`, and each operation the graph names is a call to the runtime. The exported function is `uint64_t f(uint64_t, …)`.

### What the graph needed

**Nothing new.**

| Lowering needs | The graph already has |
|---|---|
| The runtime function for an operation | Its label, one to one: `+` is `yk_add`, `ElementAccess` is `yk_get`, `.length` is a named read, `template:[…]` is `yk_template` |
| The receiver of a method call | The member read that feeds the call |
| The order calls are made in | The heap token. `loweringView` gives each heap operation the operations it comes after, and the scope planner schedules by them, inside and across branches and loops |
| A closure's code and captures | The closure node: its captures are its inputs, its graph is nested, and `this` and `function-self` are operations inside it |
| A captured variable that is reassigned | A cell, an `object:["value"]` the closure captures. It needs no lowering of its own |
| The object a write yields | The write's output (`.k=`, `[]=`), as the TypeScript lowering reads it |

Graph node order is canonical, not source order, so this ordering is required: without it, `xs.push(t)` and a later `xs.length` could be reversed.

### Memory

Values are allocated and never freed. A collector is a later slice. It doesn't change the
representation: a precise collector needs the roots, which are the values the lowering holds in
its stack slots.

## Evidence

**Natively.** Each program is linked
with the runtime, run on x86-64 on generated inputs of every kind in the slice, and agrees with Node exactly (`Object.is`, element by element
for arrays). The inputs include:
- numbers with -0, NaN and ±Infinity, and 1e21 / 1e-7 at the formatting boundaries;
- Unicode strings and awkward numeric strings (`" 0x1F "`, `".5"`, `"5."`, `"+.5e-3"`, NBSP and LS whitespace);
- booleans, `null` and `undefined`;
- arrays of all of these.

Fifteen programs, each run on 500 generated inputs, cover:
- `+` on every pair of kinds, and every other operator with its coercions;
- template literals;
- the string methods, and arrays with a loop and `push`;
- the exact `Math` on any value;
- objects: computed keys, reads and writes, own methods with `this`, chained;
- closures: a counter cell, recursion, functions as values;
- the array callbacks, including `sort` with and without a comparator;
- an object's own `valueOf` and `toString`;
- classes, ES5 constructors and prototypes, spread, rest and `delete`;
- derived classes over three levels: super calls, super getters, static super, `super` in an arrow,
  default constructors;
- an Error subclass, thrown and caught.

**Other architectures.** The array program also runs on AArch64, ARMv7 and RISC-V. Each is
cross-linked against the target's glibc, with the runtime compiled by clang for the target, and run
under QEMU, with the same agreement.

**What the tests found, all fixed:**
- `null == undefined` took the same-tag shortcut to strict equality.
- A write returned the assigned value instead of the object.

## Derived classes (#1294)

A class's parent is its class operation's first input (`["extends"]`). The runtime keeps it on the
class closure:
- **Prototypes:** the class's prototype inherits the parent's prototype, so `instanceof` and
  inherited methods follow the chain.
- **Statics:** a static member the class lacks is looked up on the parent.
- **`super(args)`:** the graph's `super` operation. It runs the parent's constructor on the receiver
  `new` made. An object the parent's constructor returns replaces the receiver.
  - A derived class with no constructor of its own passes its arguments on, as ECMAScript's default
    derived constructor does.
  - An Error-family parent makes the receiver an error, with the parent's name and message.
- **`super.name`:** the graph's `super.name` operation, whose input is the receiver. It reads the
  parent's member: the parent's prototype's member from an instance member, the parent's own from a
  static member. A getter runs with the receiver.
  - A call through it passes the receiver.
  - A closure made inside a member keeps the member's class and staticness, so an arrow's `super`
    is its member's.

Not yet:
- a write through `super`;
- extending a built-in other than the Error family (Array, Map, Set);
- `super` in an object literal's method.

The lifter keeps these opaque or the runtime refuses them by name.

## Async functions, promises and generators (#1295)

**Coroutines.** An async function's or a generator's body is lowered exactly as any function's. Its
closure carries a mode (async or generator), and a call dispatches on it:
- Each call runs the body on a stack of its own, a coroutine. On Linux this is glibc's `ucontext`,
  which every target here has.
- `await v` and `yield v` are runtime calls that suspend the coroutine.
- The exception handlers are per coroutine: a throw unwinds only its own stack.

The lowering needs no state machine, and no graph construct changes.

**Promises** follow ECMA-262 §27.2:
- resolving functions share one already-resolved flag;
- a thenable resolves through a NewPromiseResolveThenableJob;
- reactions are jobs in one FIFO queue.

`await v` is PerformPromiseThen(PromiseResolve(v), resume), one job after v settles (ES2019). An
async function's result resolves its promise through the resolving functions, so a returned promise
takes its two extra jobs, as in V8.

The runtime gives:
- `then`, `catch`, `finally`;
- `Promise.resolve`, `reject`, `all`, `allSettled`, `race`;
- `new Promise`;
- `queueMicrotask`;
- `__yakccTryAsync`, as the TypeScript runtime defines it.

**Generators.**
- `next(v)`, `throw(e)` and `return(v)`.
- `return(v)` unwinds the body as a throw that no catch sees and every finally does.
- `yield*` over a generator or an iterable.
- for…of, spread and `Array.from` draw from a generator one step at a time.

**The harness.** It runs the jobs after each call (`yk_settle`). A promise is written as its value,
or as `["rejected", String(reason)]`.

**Evidence.** Four async programs, each on 200 generated inputs, give Node's results exactly:
- the interleaving of concurrent awaits, then chains and queueMicrotask, all, allSettled, race,
  finally, and a caught rejection;
- thenables, and an async function returning a promise;
- rejections before and after an await;
- a p-limit-style limiter, whose start and end order depends on the job order.

A generator program covers `yield*`, `next(v)`, `return()`, `throw()`, spread and `Array.from`. The
job-order program also runs on AArch64, ARMv7 and RISC-V under QEMU, with the same results.

Not yet:
- async generators and `for await`;
- timers (`setTimeout`, a host API, not ECMAScript);
- closing a generator when a for…of over it breaks early (IteratorClose);
- a try block that contains a `yield`, which the lifter keeps opaque.

## Next slices

- A collector.
- The boundary a contract's types give, so a typed caller need not box.
