# DEC-DUC-V8-OBJECT-MODEL-001: V8's own object layout, over the memory leaves

**Status:** Decided by the user (2026-11-28), from their direction on #1361 and #1516:

> "no runtime: everything shaved all the way down"

> "What's the point of having a separate engine that we ship? We could just use v8 that way … The
> point is to have atoms that do what V8 does when combined."

and, asked whether the open choice could simply be made: "What is the decision? Can we just make
it?"

**Date:** 2026-11-28
**Issues:**
- https://github.com/cneckar/yakcc/issues/1366 (V8's built-ins from their own sources; this is its DEC)
- https://github.com/cneckar/yakcc/issues/1516 (retire the hand-written native runtime)
- https://github.com/cneckar/yakcc/issues/1367 (Node's C++, over V8's API)

**Builds on:**
- DEC-DUC-OPERATIONS-AS-ATOMS-001 (a small set of leaves; every other operation is an atom);
- the memory leaves of that DEC's table (#1363).

## The question

V8's built-ins (C++, Torque, CSA) and Node's C++ do not operate on abstract objects. They read V8's
objects as V8 lays them out:
- tagged words: a small integer (Smi) in the word, or a tagged pointer to a heap object;
- each heap object's Map (its hidden class): instance type, size, elements kind, the descriptor
  array, the prototype;
- property arrays, elements backing stores, dictionaries, strings in their representations.

Shaved, that code runs only where something gives it those objects. #1366 named two ways:

- **A.** Keep an object model of our own: the graph's heap leaves (make an object, read and write a
  slot). Every read of a Map, a Smi or an elements kind in V8's code is translated to it.
- **B.** V8's own layout over the memory leaves. V8's objects are bytes in the program's memory,
  exactly as V8 lays them out. V8's own object code is shaved and runs over them.

## Decision: B

1. **Values are V8's tagged values,** as Node v22 builds V8 for x86-64: no pointer compression, no
   sandbox (Node's `v8_enable_pointer_compression=0`, `v8_enable_sandbox=0`).
   - A word is a Smi (a 32-bit integer in its upper half, its low bit 0) or a pointer to a heap
     object (its low bit 1).
   - A lowered program's values are those words.
2. **Objects are V8's objects, in byte-addressed memory,** read and written through the memory
   leaves.
   - Their layout is V8's class definitions: `src/objects/*.tq`, through Torque's generated
     layouts, and `src/objects/*.h`.
   - This covers Maps, JSObjects with their properties and elements, FixedArrays, dictionaries,
     strings (sequential, cons, sliced, thin, external), HeapNumbers, BigInts, Oddballs, functions
     and contexts.
3. **The object operations are V8's own source, shaved,** never written by hand.
   - This covers property lookup (`LookupIterator`), `GetProperty`/`SetProperty`, prototype chains,
     ToPrimitive/ToNumber/ToString on objects, elements accessors (`elements.cc`), and dictionaries.
   - The source is V8's `src/objects`, `src/runtime` and the Torque/CSA built-ins (#1366).
   - The graph's object and property labels become references to those atoms' roots.
4. **Allocation and collection.** Objects are allocated in memory obtained through the memory leaves.
   - At first, the collector is atoms over the memory leaves (the conservative mark-sweep's design,
     shaved or written as atoms, never C).
   - It later becomes V8's own heap (`src/heap`), shaved.
   - V8's write barriers and handles are V8's code like the rest.
5. **V8's API, which Node's C++ calls,** is atoms over the same objects (`src/api`, shaved). So
   `node/src` shaves (#1367): `v8::String::Utf8Length`, `FunctionCallbackInfo` and the rest.

## Consequences

- **The runtime's object model and built-ins go.** In `runtime/`, the object model (2,214 lines),
  the built-ins (10,221) and the Node glue (667) are deleted as V8's atoms replace them (#1516).
  Nothing hand-written stays above the memory leaves and the system-call leaf.
- **The native value representation changes from today's NaN-boxing to V8's tagged words.** It
  changes in stages, each checked by the existing differential suites against Node:
  1. V8's layouts generated: Torque's class layouts, already built by V8's own `torque`
     (`vendor/v8/gen`);
  2. the object operations shaved, run against a heap made through them;
  3. the lowering's labels switched to references;
  4. the runtime's code deleted.
- **Torque needs a front end** (#1366).
  - Torque compiles to CSA, C++ that builds code rather than runs it.
  - The front end raises Torque's own typed declarations, read through V8's own `torque` (built
    from source).
  - CSA-only built-ins take one of #1366's routes; that choice is separate and does not change this
    one.
- **Performance comes from the typed lowering** (#1369), not from hand-written code.
  - V8's code reads Maps and Smis directly, and the typed lowering specializes on them.
  - The same layout gives Smi-tagged arithmetic unboxed, as V8's JIT does.
- **Other targets.** WasmGC and the JVM keep their own value representations for now (#1337). They
  can take V8's layout over their memory too, at the cost of their native object support; that is
  their lane's later choice.

## Not decided here

- Pointer compression and the sandbox: off, as Node builds them. Turning them on later is V8's own
  configuration, shaved the same way.
- How CSA-only built-ins are raised (#1366's options 1-3).
- When V8's own collector replaces the first one.
