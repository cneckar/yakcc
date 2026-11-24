# DEC-DUC-FRAGMENT-COMPLETION-001: a fragment that can return has a completion record

**Status:** Decided (option B on #1297)
**Date:** 2026-11-24
**Issue:** https://github.com/cneckar/yakcc/issues/1297
**Parent:** #1292 (format lock, criterion 1)

---

## Context

The shaver slices a function body that is not one atom into its statements. A statement can return
from the function. Across yakcc's own sources:
- 2,183 of 8,973 fragments contain a `return`;
- 1,629 of those are guard clauses in the middle of a function (`if (x === undefined) return
  undefined;`, then more statements).

A module statement's graph had one result, `declares:[names]`, the values of the names it declares.
A fragment that returns had no place for that:
- an unconditional `return x;` lifted to two results, which TypeScript cannot express;
- a guard clause's return was dropped;
- fidelity compares names only, so neither was caught.

Two options were put on #1297:
- **A:** the slicer keeps everything from a function's first guard to its end as one fragment. No
  new construct, but atoms are much coarser wherever a function starts with guards.
- **B:** a completion record. The slicing stays as fine as it is.

**B was chosen.**

## Decision

A fragment that returns at its top level (outside any function it contains) is lifted in the
function's exit mode, under the return state that function bodies already use:
- a return on some paths sets the returned flag and keeps the first value;
- the statements after it run only on the paths that have not returned.

Its one result is

    completes:[names]   inputs: returned, value, …declared values (in the order of names)

which is ECMAScript's completion record (normal or return) made explicit:
- **returned** is a boolean. It is true on every path that returned (or threw).
- **value** is what it returned, `undefined` where it did not.
- **The declared names** are joined over the exits: a name first declared after a guard is its
  value where the fragment did not return, and `undefined` where it did.

A fragment with no top-level return keeps `declares:`. A function's graph is unchanged.

**TypeScript form (emit-ts).** The completion is written as two more module names before the
declared ones, `__yakccReturned` and `__yakccReturnValue`, assigned at the end of the statements'
block and exported. Lifted again, a module whose first two exported names are those is a completion
record, with those two as its first inputs. The round trip holds.

## Evidence

- **Round trip:** graph to TypeScript to graph gives the same identity on every distinct atom of
  both recorded corpora, 433 / 433 and 940 / 940. Before, six had no TypeScript form.
- **Fidelity:** 1,949 / 1,949 hold.
- **Meaning:** a differential test (`emit-ts.test.ts`) runs each fragment inside a function, with a
  return as `[true, value]` and falling off as `[false, undefined, …declared]`, and runs the emitted
  TypeScript on the same inputs. They agree on:
  - guard clauses;
  - two guards with names between and after;
  - a return in a loop;
  - an unconditional return.

## Consequences

- The format gains one operation label prefix, `completes:`. LIFTER_VERSION 40.
- `completionOf(graph)` (`@yakcc/duc`) reads it, as `declaredNamesOf` reads `declares:`.
- A lowering that runs module statements does not meet a completion: a fragment that can return is
  a slice of a function body, not a module statement. The native lowering refuses it by its label.
