# DEC-DUC-GATE-REJECT-001: the conservation gate rejects by default

**Status:** Decided
**Date:** 2026-11-23
**Issue:** https://github.com/cneckar/yakcc/issues/1173
**Parent:** #1169 (WI-EXPLAIN, fully explainable shave)
**Related:** #1163 (DEC-DUC-CONSERVATION-GATE-001, warn-first rollout), #1171 (module captures), #1282 (base sets), #1290 (module records)

---

## Context

The conservation gate lifts every shaved atom to a DUC graph and records its unknown-support
(DEC-DUC-CONSERVATION-GATE-001). It began in **warn** mode. It was to tighten to **reject** once
two things held:
- the fixture corpus shaves clean: no unexplained reference and no lift error;
- every lift is shown to be faithful (DUC Norm 3).

## Decision

### 1. Lift fidelity is checked on every atom (DEC-DUC-LIFT-FIDELITY-001)

`liftFidelity(source, graph)` (`@yakcc/duc`) compares two sets of names:
- **Source side:** the names the atom's source reads without declaring them. TypeScript's own binder finds them, on the parse the lifter uses.
- **Graph side:** the names the graph reports as references. These are the diamond sources, in the graph and in every closure graph inside it.

The two sets must be equal.

- **A missing name** is a reference the lifter resolved to a binding that is not there.
- **An extra name** is one the source binds but the graph reports as free. This is accepted only when the atom declares the name at its own top level. That makes it a module binding: the graph reads it live, as JavaScript does, and the module record links it (DEC-DUC-MODULE-SCOPE-001). Recursion and forward references among a module's declarations are such reads.
- **Left out:**
  - the lifter's own primitives (`__yakcc…`);
  - a function's own `arguments`;
  - meta-properties (`new.target`, `import.meta`).

The gate runs the check on every atom. A failure is a gate problem, like a lift error.

The check found these lifter defects, now fixed:

- **A closure made before a later `var` it reads.** For example, `o.f = function () { return K }; … var K = 10`. The closure now captures a cell holding `undefined` until the declaration writes it, as JavaScript hoists `var`. A function declaration reading a later `var` is hoisted the same way.
- **A closure in a `var`'s own initializer that reads the `var`.** For example, lodash's `var memoized = function () { … memoized.cache … }`. The `var` is a cell too. A `var` can be reassigned, so its name is not `function-self`.
- **A function or arrow that directly initializes a `const`, and reads that `const`.** For example, `const f = (n) => f(n - 1)`. The name is `function-self`, as in a named function expression. It can only ever be the function itself.

A `let` or `const` read before its declaration throws, so it does not get a cell. A function or
closure reading one is bound where it stands, and the name stays reported. An `undefined` cell
would turn the throw into a value.

### 2. A name the atom only probes for is explained (DEC-DUC-FEATURE-DETECTION-001)

A free name is explained when every read of it is one of:
- `typeof name`;
- inside the true side of a test that the name is present: an `if`, a `?:`, or the right of an `&&`, whose condition contains `typeof name === "<not undefined>"` or `typeof name !== "undefined"`.

The atom decides by its own test what to do when the name is absent. For example, a UMD wrapper's `define`.

A read inside a `try` is **not** a probe. A `catch` survives any missing name, a real hole
included.

### 3. A web base set

`WEB` (`@yakcc/duc`, target `web`) is ECMAScript plus the web platform's globals. Examples are `self`, `window`, `document`, `navigator`, `location`, storage, timers, `fetch` and `crypto`. Each has capability and nondeterminism labels, as in `NODE`.

A package written for several platforms names them, as bcryptjs reads `self.crypto` in a worker. Each is now a platform primitive of the web target. On a Node target the per-target closure check reports it as not on the target. It is not an unexplained hole.

### 3a. yakcc's own sources: TypeScript, and fragments of function bodies (#1297)

The fixture corpus is JavaScript, and its atoms are mostly whole functions. The self-shave bootstrap
of yakcc's own TypeScript, with the gate at reject, failed on 290 atoms. That self-shave runs in the
`v2 self-shave` workflow. The failures had four causes, each now fixed at its root.

- **Types read as values.** These now lift to nothing, and fidelity agrees:
  - type aliases, interfaces and ambient `declare`s;
  - overload signatures;
  - type-only export lists, and re-exports from another module (`export { a } from "m"`);
  - names in type positions: annotations, casts, type arguments, `implements`.
- **A fragment of a function body reads its enclosing scope.** The shaver slices a large function
  into its statements, and each fragment reads the function's parameters and locals.
  `enclosingBindingsOf(moduleSource, range)` computes the names bound in the scopes enclosing a
  fragment, below the module's top level:
  - parameters;
  - a named function expression's own name;
  - block declarations;
  - loop and catch variables.

  The gate records a read of one as `enclosing`, stored in the sidecar. It is a declared source in
  the same file, as a module binding is.
- **A class member sliced out of its class** (a method, an accessor, a constructor) did not parse.
  It now parses in a `class __atom__ { … }` form and lifts as that member's function, with a
  receiver. A parameter property is the write `this.x = x`.
- **Smaller lifter defects:**
  - a destructuring key (`{ key: local }`) was read as a name;
  - an import attribute's key (`with { type: "json" }`) was read as a name;
  - a fragment of an async body that awaits at its top level now parses as a module;
  - a `let` or `const` read by a closure made before it, or assigned by a closure in its own
    initializer, is a cell, as a later `var` already was;
  - `import.meta` (Node) and `Function` / `eval` (ECMAScript, capability `dynamic-code`) are
    platform primitives.

The slicer also descends into a `new` expression's object-literal arguments
(`new Proxy(t, { get() { … } })`), as it does a call's.

### 4. The default is reject

`ducGateModeFromEnv` returns `reject` unless `YAKCC_DUC_GATE` is exactly `warn`. Any other value
also rejects, so a typo fails closed. An atom with an unexplained reference, a lift error or an
unfaithful lift is not persisted. `YAKCC_DUC_GATE=warn` is the escape hatch, and the mode can be
overridden per call.

The allowlist of unliftable constructs is **empty**.

## Evidence

Measured over the fixture corpus (`packages/shave/src/__fixtures__/module-graph`, 21 packages):

| | Before WI-EXPLAIN | Now |
|---|---|---|
| Atoms with an unexplained reference | 831 (configuration C, baseline) | 0 |
| Lift errors | — | 0 |
| Unfaithful lifts | (not checked) | 0 |

Two more checks, over the two recorded atom sets (570 and 1,379 atoms):

| Check | Result |
|---|---|
| Fidelity | 1,949 / 1,949 hold |
| Round trip (graph to TypeScript to graph, same identity) | 426 / 426 and 930 / 930 distinct graphs |

A test persists a deliberately unexplained atom with no mode given and checks it is rejected (`packages/shave/src/persist/external-surface-roundtrip.test.ts`).

## Consequences

- A shaved package forest is persisted with the same gate context that `universalize` gives one module: the forest's composition names and the module's own bindings. `forestGateContext(plans, filePath)` (`@yakcc/shave`) computes it. Without that context every sibling reference is unexplained, and the gate now rejects it.

- A lifter regression that drops or invents a reference fails the shave. It is no longer recorded silently.
- `canonical.ts` memoizes identity, and the renumbering of a closure's captures, per graph object. Captures the outer graph cannot tell apart are first told apart by how the closure uses them. Closures nested deep with many hoisted cells (bcryptjs's factory) canonicalize in under a second. Before this, the cost grew exponentially in the nesting depth.
