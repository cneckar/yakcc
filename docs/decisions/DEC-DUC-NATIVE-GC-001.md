# DEC-DUC-NATIVE-GC-001: the native runtime's collector

**Status:** Proposed (lane:native)
**Date:** 2026-11-25
**Issue:** https://github.com/cneckar/yakcc/issues/1361 (P1, lane:native)
**Related:** DEC-DUC-NATIVE-RUNTIME-001 (boxed values), DEC-DUC-TYPED-NATIVE-001, #1370 (self-rebuild)

---

## Context
The native runtime (`packages/duc/runtime/yk.c`) allocated every value from a bump allocator and never freed one. That works for tests. It does not work for #1370, which has to run the TypeScript compiler, the shave pipeline and yakcc's suite natively.

Where values live in the native lowering:
- **Generated code** keeps them in LLVM SSA values and allocas, on the native stack and in registers.
- **Coroutines** (async functions and generators, #1295) run on stacks of their own.
- **Globals** hold module bindings and runtime state.
- **No stack maps.** The lowering does not emit them, and LLVM's statepoints would bind the lowering to one GC strategy.

## Decision
**A conservative, non-moving mark-sweep collector** in the runtime.

### The heap
- **Pages.** The heap is a range of address space reserved once (`mmap`, no reserve): 64 GiB on 64-bit targets and 1 GiB on 32-bit ones, falling back to smaller sizes. It is divided into 64 KiB pages.
- **Blocks.** A page holds blocks of one of 38 size classes, from 16 bytes to 32 KiB. A block larger than half a page takes whole pages.
- **Metadata.** Each page has a descriptor holding its kind and class, plus an allocated bit and a mark bit per block.
- **Allocation.** Blocks come from per-class free lists, zeroed. A block is one byte longer than requested, so a pointer one past its end still keeps it alive.

### Roots and marking
- **Roots:**
  - the native stack from the current frame up;
  - the registers (`setjmp`);
  - the writable `PT_LOAD` segments of the program (`dl_iterate_phdr`).
- **Coroutines.**
  - A coroutine's stack is a heap block, so a suspended coroutine's frames are scanned when the coroutine is reached.
  - While a coroutine runs, the main stack is scanned from where it was left: `gc_main_sp`, recorded when switching away.
- **What counts as a pointer.** A word is a candidate if it is an address inside the heap, or a boxed value (tag `0xFFFA` or above) whose 48-bit payload is one. Any address inside a block marks that block, and a marked block is scanned whole. Marking uses an explicit work stack.
- **Sweep.** Unmarked blocks return to the free lists. A page left with no live block, or an unmarked large block, returns to a list of free page runs.

### Scheduling and limits
- **When.** A collection runs when the bytes allocated since the last one reach the threshold: at least 16 MiB, or the live size after the last collection, whichever is larger.
- **Platforms.** The collector is Linux-only for now (ELF, `dl_iterate_phdr`, `pthread_getattr_np`). Elsewhere, or if the heap or the stack bounds can't be found, the bump allocator stays and nothing is freed.

### Requirements on the runtime
Values must never live only in memory the collector can't see. For this reason:
- the class field and private-name tables, the job queue, promise reactions and sort buffers moved from `malloc`/`realloc` to the heap (`grow`);
- buffers that hold no values (UTF-16 scratch, C's memory regions) stay with the C library.

### Testing
- `YK_GC_STRESS=1` collects every 64 KiB.
- `YK_GC_STATS=1` reports the number of collections at exit.
- `emit-llvm-gc.test.ts` runs allocation-heavy programs under stress against Node: objects, strings, JSON, Maps and Sets, a sort whose comparator allocates, closures, classes with private fields, generators suspended across collections, async chains, and regular expressions.
- The native suites also pass under stress.

## Alternatives
- **Precise collection with LLVM statepoints or stack maps.** It is exact about roots, but every call becomes a safepoint, and generated code would have to relocate pointers if objects moved. It can come later for the typed lowering, where most values are unboxed anyway.
- **Reference counting.** It costs on every copy of a value, and needs cycle collection for JavaScript's object graphs.
- **Boehm GC as a dependency.** It is the same design, but it is an external C library, which the self-rebuild would also have to shave. This collector is about 300 lines of the runtime's own C.

## Consequences
- **Conservative scanning retains some garbage.** A double whose bits look like a heap address keeps a block alive. This is bounded and harmless to correctness.
- **Coroutine stacks are 256 KiB blocks scanned whole.** Many live generators make collections slower.
- **Nothing moves,** so pointers held by C code (strings' units, array items) remain valid across collections.
