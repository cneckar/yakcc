# DEC-DUC-FORMAT-001: the DUC graph format, as locked

**Status:** Accepted. Locked at format version 3 on 2026-11-27. It can be reopened if a serious lack is found; reopening is a new format version with a migration, as below.
**Date:** 2026-11-24 (proposed), 2026-11-27 (locked)
**Issue:** https://github.com/cneckar/yakcc/issues/1292 (the lock); unblocks #1291
**Parent:** #1275

---

## What this fixes

The format is what a graph can express and how its identity is computed. Every stored atom's
identity depends on it, so after the lock a change to anything below needs a new format version
and a corpus migration.

**Not locked**, because each is a versioned side table keyed by identity or root:
- signatures, trust levels, target records, attestations, evidence and provenance;
- the TypeScript cache;
- the lifter version.

**The lifter is not frozen.** A graph is self-contained, so a graph from an earlier lifter stays
valid. A better lifter may give a different, also valid, graph for the same contract.

## The graph

A graph (`packages/duc/src/types.ts`) has:
- **nodes**;
- **values**, each the output of exactly one node;
- **observations**, the values the atom returns, in order;
- its **branches**;
- a **mode**: `async`, `generator` or both, when not an ordinary function.

**Node kinds:**

| Kind | What it is |
|---|---|
| `param-source` | A parameter. Its label is its index, with `...` for a rest parameter and `=` for one with a default (which sets a function's `length`, #1370). A TypeScript `this:` parameter is erased and is no parameter. |
| `literal-source` | A literal, labelled by its normal form (#1303): numbers and strings as canonical JSON, cooked template parts, sorted regex flags. |
| `diamond-source` | A reference the atom does not own. It carries a reason, a symbol and a module (DUC §2). The reasons are `platform-primitive`, `free-identifier`, `unlinked-reference` and `unresolved-module`. |
| `op` | An operation, named by its label (below). |
| `sel` | A join or select. Its condition is an ordinary input (control as data). |
| `loop` | A loop, as one node. Its body is the region `<id>.b`, with carried values, invariants, `next`, and a condition or an iteration (`for…of` over values, `for…in` over keys). |
| `carry-source` | Inside a loop body: a carried value (`carry:<i>`, `carry:<i>:heap`), an invariant (`invariant:<j>`), or the current element (`element`). |

**Structure:**
- **Regions.** A node inside an `if` or a loop carries its region path (`b0.t/L3.b`). A value leaves a branch only through a join.
- **Closures.** A closure node holds its own graph. Its first parameters are the captured values, which are the node's inputs.
- **The heap token (#1285).** Every heap operation (a call, `new`, a member read or write, `in`, a spread, an opaque summary, a throw) takes the previous heap operation's token as its last input and is marked `order: 1`. Their order is structure.
- **Conversions are ordered (#1370).** An operator that converts an operand (ToPrimitive, ToNumeric, ToString: arithmetic, comparison, `==`, bitwise, unary `+ - ~`, a template substitution) may run user code (`valueOf`, `toString`, `Symbol.toPrimitive`). It is a heap operation unless every operand is certainly a primitive: a literal, a primitive constant, another operator's result, a join of those, a loop invariant or closure capture whose outer value is one. `x == null` and `x != null` convert nothing. Such an operator, and `in` and `instanceof`, also run only on the paths that reach them.
- **Array destructuring is the iterator protocol (#1370).** It is lifted through the existing operations as ECMA-262 does it: GetIterator through `Symbol.iterator`, IteratorStepValue with the result-is-an-object check, and IteratorClose when the pattern ends before the iterator does. It adds no node kind and no label. It reads the platform's `Symbol`; under a binding of the program's own named `Symbol` it is refused.

## Labels

A label is part of identity. The families are:

**Operations by meaning** (DEC-DUC-CROSS-LANGUAGE-OPS-001, `ops.ts`):
- ECMAScript's operators are `js.*`: `js.add`, `js.neg`, `js.strict_eq`, `js.typeof`, `js.add_assign`, …
- The generic operations are `f64.*`, `str.*`, `bool.*`, `list.*` and `rem.truncated`. They are chosen from the contract's types by `byMeaning` (below).

**Member and element access:**
- reads `.name` and `?.name`, writes `.name=`;
- `ElementAccess` (and `ElementAccess?.`), `[]=`;
- `delete.name`, `delete[]`;
- `super.name`, resolved through the home object: a class's prototype, or an object literal's (#1370).

**Calls:** `CallExpression`, `CallExpression?.`, `NewExpression`, `super`.

**Constructors:**
- `ArrayLiteral`, `...` (spread);
- `object:[keys]`, `template:[parts]`, `tagged:[[cooked, raw]…]`;
- `class:…`;
- the closure kinds: `closure`, `async closure`, `function`, `function*`, …. A function declaration or expression is `function` (it has a `prototype` and constructs) whether or not it reads `this`; an arrow and a method are not;
- `function-self`, `class-self`, `this`.

**Control and effect:**
- `throw`, `AwaitExpression`, `YieldExpression`, `YieldExpression*`;
- the try primitive `__yakccTry`, as a call of a platform primitive;
- `heap` on a `sel` of the token.

**Results of a module statement:**
- `declares:[names]` (#1290);
- `completes:[names]` (DEC-DUC-FRAGMENT-COMPLETION-001);
- the bindings `binding` and `binding=`;
- `Uninitialized`.

**Opaque summaries:** `<Kind>#<hash>`, the hash of the construct's normalized text. Each is counted, and is allowed only where the gate admits it (DEC-DUC-GATE-REJECT-001).

## The choice of operations

`byMeaning(graph, contractSignature(contract))` is part of the format, not of the lifter.
- An operation is generic exactly when the #1277 inference, seeded with the contract's input types, gives each operand one kind in the operation's row of DEC-DUC-CROSS-LANGUAGE-OPS-001's table.
- So **the inference rules that decide those kinds are locked with the format.** A better inference that would choose differently is a new format version.
- **A closure is chosen under the types it is made and called with:**
  - its captures take the outer graph's types;
  - its own parameters take the union of the argument types over every use, but only when every use is a direct call or an array method's callback (element, index, array) on an array of known element type, reached through loop invariants;
  - any other use (returned, stored, carried, passed elsewhere), a rest parameter, or a call of itself leaves its own parameters unknown.
- A stored graph is in chosen form: a receiver chooses again and refuses a graph that changes (federation check 3).

## Canonical form and identity

`canonicalizeGraph` (`canonical.ts`):
- **Values and nodes** are numbered by a structural key, refined by use until stable. Parameters keep their index.
- **Branches** are numbered by condition and contents. **Loops** are numbered by the position of their node.
- **Literals** are hoisted.
- **Commutative operands** are put in structural order: the cases of `===` and `!==`, plus `f64.add` and `f64.mul`.
- **Invariants and closure captures** are put in structural order.
- **A join's dead side** (an `if` side that throws on every path) is `undefined` (#1316).

The keys:

    identity   = BLAKE3(canonical JSON of the canonical structure)
                 (kind, label, order, inputs, outputs, diamond, region, loop, closure identity; obs; branches; mode)
    graph_root = BLAKE3("yakcc-duc-graph" ‖ u32be format_version ‖ identity ‖ BLAKE3(sorted links))
    block_root = BLAKE3(spec_hash ‖ graph_root ‖ proof_root)

These are in DEC-DUC-GRAPH-ROOT-001. **Links** say which contract each reference calls. They are outside the identity, which stays the structural key, but inside the root.

## Encoding

`packGraph` (`store.ts`) writes the canonical structure, compacted (`compact.ts`) and Brotli-compressed. It carries:
- the format version;
- the links;
- the lifter version, as provenance.

`unpackGraph` reads only the versions it knows.

## Evidence, by criterion (#1292)

1. **Corpus stability:**
   - the gate is at reject;
   - round trip on the full corpus, and 61 / 61 on the pinned sample after #1316;
   - two shaves give identical identities;
   - the self-shave passes in CI.
2. **Second language:** Python raised to graphs (#1298). Operations are named by meaning, and the same function from Python and from TypeScript gets one identity where its operations are generic (#1310).
3. **Lowering prototypes:**
   - Python, Go, Rust (#1299);
   - wasm and WasmGC beyond numbers (#1300, #1315);
   - JVM: #1311. It found no gap of its own in the format, and the gaps it filed (#1349, #1352, #1360) are fixed. Its remaining work (regex wiring, stack-map frames) is lowering work, not format work.
4. **Native objects:** eight (architecture, object format) pairs. Programs run identically to Node on x86-64, AArch64, ARMv7 and RISC-V (#1294–#1296).

## Consequences

- **At the lock,** `GRAPH_FORMAT_VERSION` became 3. It was 2, before the BLAKE3 identity, the root, the literal normal form, the completion record, operations by meaning and the semantics of #1370. Graphs stored at versions 1 and 2 have the same encoding and are still read, under their stored roots, until #1291 migrates them.
- **#1291 then migrates** the registry's DUC implementations and the bootstrap manifest to these identities and roots, which DEC-DUC-GRAPH-ROOT-001 deferred. No stored database is rewritten before then.
- **After the lock,** a change to a node kind, a label family, the operations vocabulary or its choice rule, the canonical order, or the identity or root hashing is a new format version with a migration.
