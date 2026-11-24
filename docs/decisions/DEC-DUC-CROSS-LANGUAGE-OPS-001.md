# DEC-DUC-CROSS-LANGUAGE-OPS-001: how operations are named across languages

**Status:** **Proposed, direction set by the user (2026-11-24):** operations are generic across languages wherever their meaning is shared, and per-language only where a meaning is unique to one language. Below: how that is done, and what is still to confirm.
**Date:** 2026-11-23
**Issues:**
- https://github.com/cneckar/yakcc/issues/1298
- https://github.com/cneckar/yakcc/issues/1292 (criterion 2)

**Evidence:**
- [`docs/duc/raising-python-1298.md`](../duc/raising-python-1298.md) (raising from Python);
- [`docs/duc/lowering-prototypes-1299.md`](../duc/lowering-prototypes-1299.md) (lowering to Python, Go, Rust).

---

## Question

A graph's operation labels are part of its identity. Today there is one vocabulary: the
JavaScript lifter's labels (`+`, `ElementAccess`, `.slice`, `template:[…]`), each meaning what
ECMAScript says. When Python, Go or Rust is **raised** to graphs, what do its operations become?

## Options

### A. Per-language operations

Each language raises to its own operations, named under a language prefix: `py:+`, `py://`,
`py:subscript`, `py:tuple`. Each label means what that language says. The existing unprefixed
labels stay as they are and mean ECMAScript.

- **Identity.** The same algorithm in two languages gives two graphs. They are linked by their contract (the same `specHash`), never by identity.
  A raiser improvement does not change identity, because a raise is one operation per source operation.
- **Raising** is faithful by construction. Nothing is composed or approximated.
- **Lowering** a `py:` graph to another target needs that target to implement Python's operations: its numeric tower, its exceptions, its string model. That is one runtime per (source language, target) pair.
  Lowering a graph to its own language is direct.
- **The format must fix,** before the lock:
  - the prefix scheme (which prefixes exist; that the absent prefix is ECMAScript);
  - that a graph uses one language's operations. A call to another language's atom crosses by a link and the contract's types, not by mixing operations.

### B. A shared core, with language-specific extensions

The core holds the operations whose meaning is **the same in every language, for every value they
accept**. A raiser writes a core operation when it can show the operands are in that domain. Every
other operation is an extension, named as in A.

- **Identity.** A Python function and a JavaScript function that compute the same thing over core operations get the same identity: deduplication across languages.
  But which operation a raiser may write depends on what it knows of the operand types, so identity depends on type information at raise time. A raise with better types gives a different identity, unless the format fixes how types are found.
- **How large is the core?** Small, on the evidence below.
  - IEEE-754 double arithmetic, except division, where Python raises on zero.
  - Booleans.
  - String concatenation and string equality.
  - Not string `length`, indexing, slicing or ordering: Python counts and orders code points, JavaScript UTF-16 code units (gap A1 in #1299).
  - Not integer arithmetic: Python's int is unbounded.
  - Not truthiness: `[]` is falsy in Python and truthy in JavaScript.
  - Not `==` on lists: structural in Python, identity in JavaScript.
- **The format must fix** the core's membership and the rule that picks core over extension. Both are in identity.

### C. One vocabulary, with compositions (today's prototype)

Every language raises to the ECMAScript operations. A construct whose meaning differs is written as a composition with the right meaning, and where none exists it is refused. This is what `raisePythonFunction` does now.

- **Identity:** compositions are part of it, so changing a composition changes every atom that uses it.
- **Lossy where no composition exists** (measured below): tuples, unbounded ints, exception classes.

## Evidence (38 CPython standard-library functions, #1298)

| | Measured |
|---|---|
| Raised under C | 30 / 38 |
| Faithful under C, round trip through `emitPython` | 15 / 30 |
| Lost under C: a tuple returned as a list | 12 / 30 |
| Lost under C: a float returned as an int | 2 / 30 |
| Lost under C: the exception class (ZeroDivisionError, IndexError, AssertionError → Error) | 3 / 30 |
| Lost under C: an int past 2^53 (the graph's own meaning) | on every function that does integer arithmetic. Observed: `_days_before_year(2**53 + 1)` |
| Wrong in any other way | 0 |
| Size of compositions under C | 622 of 1720 nodes (36%). Python `//` is a 42-node closure (CPython's `float_divmod`); a checked subscript is 29 |
| Operations whose meaning is the same in Python and ECMAScript on every value (B's core) | double `+ - *`, comparisons of doubles, string `+` and `===`, booleans. Not ints, `/`, `//`, `%`, `len`, subscripts, slices, string ordering, truthiness of containers, `==` on containers, `in` on dicts |

From lowering (#1299), the same holds in the other direction. Python, Go and Rust have to *emulate*
JavaScript's strings (UTF-16), numbers (doubles, with ECMAScript's ToString) and `undefined` in
order to lower today's graphs. The cost of every non-native vocabulary is a runtime, whichever way
the graph crosses.

## What each choice does to identity

| | A: per-language | B: core + extensions | C: one vocabulary |
|---|---|---|---|
| The same algorithm in two languages | two identities, one contract | one identity where all operations are core; otherwise two | one identity only if the compositions match |
| A raiser improvement | identity unchanged | can change identity (more operations proven core) | changes identity (new compositions) |
| Faithful raise | by construction | by construction | not for tuples, big ints, exception classes |
| Format content to fix before the lock | prefix scheme; one language per graph | prefix scheme; core membership; the core-selection rule | nothing new; the losses are permanent |
| JavaScript lifter labels | unchanged (unprefixed = ECMAScript) | unchanged; the core is a subset of them | unchanged |

## Proposal: operations named by meaning

The user's direction: **as much as possible generic, per-language only what is truly unique.**

The obstacle to "generic" is that a language's *symbol* is not an operation. Python's `%` and
ECMAScript's `%` are two different operations that happen to share a symbol. So the vocabulary is
named by **meaning**, and each language's symbol is raised to the meaning it has on its operands:

| Generic operation | Python raises to it from | ECMAScript raises to it from |
|---|---|---|
| `f64.add`, `f64.sub`, `f64.mul` | `+ - *` on floats | `+ - *` on numbers |
| `f64.div` (IEEE: a zero divisor gives ±Infinity or NaN) | — | `/` |
| `f64.div.checked` (a zero divisor raises) | `/` | — |
| `mod.floored` | `%` | — (but available to any language) |
| `rem.truncated` | `math.fmod` | `%` |
| `int.add` (unbounded) | `+` on ints | `+` on BigInt |
| `str.concat` | `+` on strings | `+` on two strings |
| `str.length.units16` / `str.length.codepoints` | — / `len(s)` | `s.length` / — |
| `list.get.checked` (out of range raises) | `xs[i]` | — |
| `list.get` (out of range gives undefined) | — | `xs[i]` |

**Per-language, because the meaning is unique:**
- ECMAScript's `+` on operands of unknown or mixed type, with ToPrimitive and its coercions (`js.add`);
- `undefined`;
- Python's tuple;
- each language's exception classes, as data the generic `throw` carries.

**What this does to identity:**
- The same algorithm in two languages gets **one identity** wherever its operations are generic. A function over floats and strings raised from Python, and the same function lifted from ECMAScript, are the same graph.
- Choosing a generic operation needs the operands' types. ECMAScript `a + b` is `f64.add` when both are numbers, `str.concat` when both are strings, and `js.add` otherwise.
  The rule that picks the operation is part of the format, so a better type inference must not change which operation an atom already has. The proposed answer: the operation is chosen from the **contract's** types only, which are fixed with the atom.
- **The JavaScript lifter's labels change:** today's unprefixed labels become these names. Every stored atom's identity changes once, before the lock.

**To confirm:**
1. The generic vocabulary's names, and its first membership (the table above, grown as each target needs).
2. Operations chosen from the contract's types only, so identity does not move with inference.
3. Relabelling the JavaScript lifter's operations before the lock.

## Not decided here

- **The lowering side:** which targets implement which language's operations. That is per target and does not lock.
- **Go and Rust raising:** `raise-go.ts` and `raise-rust.ts` read the lowerings' own dialects today, as `raise-py.ts` did. The same decision applies to them.
