# Raising from Python: coverage on a fixed sample, and faithfulness (#1298)

**Issue:** https://github.com/cneckar/yakcc/issues/1298 (criterion 2 of #1292)
**Date:** 2026-11-23
**Test:** `packages/duc/src/raise-py-source.test.ts`
**Sample:** `packages/duc/src/__fixtures__/python-sample.json`
**Pinned statuses:** `packages/duc/src/__fixtures__/raise-py-expected.json`
**Decision this feeds:** [DEC-DUC-CROSS-LANGUAGE-OPS-001](../decisions/DEC-DUC-CROSS-LANGUAGE-OPS-001.md) (proposed)

## What was built

### The raiser
`packages/duc/src/raise-py.ts` reads Python as people write it. Until now it read only the dialect
`emitPython` writes.

1. **`pythonAst`** parses with Python's own `ast` module. This is the standard library: libcst is not needed.
2. **`raisePythonFunction`** writes the function as the TypeScript the JavaScript lifter reads.
3. `liftAtom` gives the graph.

**No JavaScript lifter label changed.** The raised graph uses the reference language's operations, which is today's single vocabulary.

**Python's meaning comes from compositions of those operations, wherever one has it:**
- `//`, `%` and `divmod` use CPython's own `float_divmod` algorithm, so they take the sign of the divisor and a zero divisor raises.
- `/` by zero raises.
- A subscript out of range raises, and a negative subscript counts from the end.
- `str.replace` replaces every occurrence.
- `str.split()` splits on runs of whitespace.
- `partition`, `rpartition`, `capitalize`, `'{}'.format`, f-strings and `'%d' % x` are written out.
- A module constant assigned once, and a module function, become local definitions inside `f`. This stands in for a link to the module's atoms.

**Refused with a reason:**
- a name the module computes with statements;
- an import;
- an attribute read;
- `int.bit_length`;
- a slice step;
- `global`;
- a bytes literal;
- keyword arguments.

### The sample
38 pure functions from **CPython 3.13's standard library**, copied verbatim with the module each comes from (PSF License):
- `colorsys` and `calendar`;
- `string.capwords` and `html.escape`;
- the URL splitters of `urllib.parse`, and `email.utils.quote` / `unquote`;
- the date helpers of `_pydatetime`;
- `heapq`'s sift functions;
- `shlex.quote`, `textwrap.dedent` and others.

For each function, `scripts/build-python-sample.py` records the module statements that define the names it reads, transitively. The test raises the function with those statements as its module.

### The test

For each of 40 generated inputs per function, the test runs three things:
1. **Round trip.** The raised graph is lowered back to Python (`emitPython`) and run **in the same process as the original function**. The results must be identical, including:
   - Python's own types: an int is not a float, and a tuple is not a list;
   - exceptions, by class and message;
   - the arguments after the call, since `heapq` mutates its list.
2. **The graph's own meaning.** The same graph runs through the TypeScript reference (`emitTypeScript`). Its result is compared with the original's in JavaScript's value model: numbers as float64 bits, strings as UTF-16. A round trip can hide a difference here, because the Python lowering keeps Python ints exact (gap A5 in #1299).
3. **Determinism.** Raising the same function twice gives the same identity.

## Coverage

| | Functions |
|---|---|
| Raised | **30 / 38** |
| — round trip identical on every input | **15** |
| — round trip differs **only** because a tuple came back as a list | 10 |
| — differs because a tuple came back as a list and a float as an int (`yiq_to_rgb` clamps to the literal `0.0`; `rgb_to_hsv`) | 2 |
| — differs **only** in the exception's class (AssertionError, ZeroDivisionError, IndexError become `Error`; the message is identical) | 3 |
| — differs in a value | **0** |
| Refused, with a reason | 8 |
| The graph's own meaning agrees with Python on every input | 26 / 30. The exceptions are three exception classes, and `_days_before_year(2**53 + 1)`, where a double cannot hold the argument |

**Refusals, by reason:**
- a module name the module computes (`_DAYS_BEFORE_MONTH`, built by a loop): 2;
- reading an attribute of an imported module (`re.MULTILINE`, `re.compile(…).search`): 2;
- `int.bit_length()`: 1;
- `global`: 1;
- an imported name (`datetime.date`): 1;
- a bytes literal: 1.

**What extending the raiser over the commonest refusals did:**
- The first run refused 14 functions. Module-level names were the commonest reason, with 9 of them.
- Resolving module constants and functions raised 5 more functions, and all of them now run.
- `heapq` needed `>>` in the Python lowering. That was gap A6 of #1299; it is now added, with JavaScript's 32-bit meaning.
- `_ymd2ord` reached `'%d' % dim`, now raised for `%d` and `%s`.

## What the sample says about naming operations across languages

These are the measurements DEC-DUC-CROSS-LANGUAGE-OPS-001 rests on.

1. **A tuple has no form in a single vocabulary.**
   - 12 of the 30 raised functions return a tuple. Every one of them comes back as a list.
   - The graph cannot say "tuple": JavaScript has only arrays.
   - The contract's output type could tell a lowering to make a tuple, which would make it a (b) annotation. But then two graphs with the same identity would be different Python functions.
2. **Python's int is not a double.**
   - Under its own meaning, the graph agrees with Python on every input but one: `2**53 + 1`, which is not even representable as the graph's input.
   - Every function that does integer arithmetic has the same exposure on large inputs. `isleap(2**53 + 1)` is `False` in Python and `True` in the graph.
   - Int and float are also lost apart: `0.0` and `0` are one value in the graph.
3. **Python's exception classes are not JavaScript's.** Only `TypeError` and `SyntaxError` exist in both. `ValueError`, `IndexError`, `KeyError`, `ZeroDivisionError` and `AssertionError` all become `Error`.
4. **Compositions are large.**
   - Python's `//` written as reference operations (`__divmod`, CPython's algorithm) is a **42-node closure**. As one operation it would be one node.
   - A checked subscript is 29 nodes.
   - Across the 30 raised graphs, **622 of 1720 nodes (36%)** are such compositions.
   - Each composition is part of identity. A better composition later changes every Python atom's identity.
5. **What was never wrong:** apart from (1) to (3), every raised function computes Python's values on every input. A shared vocabulary *can* carry Python's meaning, at the cost of (4), for everything except tuples, unbounded ints and exception classes.

## Per-function table

"Round trip" counts the inputs where raise → `emitPython` → run is identical to CPython. "The graph's
own meaning" counts the inputs where the TypeScript reference of the raised graph agrees with CPython, in JavaScript's value model.

| Function | Status | Round trip (raise → `emitPython` → run) | The graph's own meaning (TypeScript reference) | Why they differ |
|---|---|---|---|---|
| `colorsys.rgb_to_yiq` | differs | 0/40 | 40/40 | round trip: tuple-list 40 |
| `colorsys.yiq_to_rgb` | differs | 0/40 | 40/40 | round trip: number-kind 34, tuple-list 40 |
| `colorsys.rgb_to_hls` | differs | 0/40 | 40/40 | round trip: tuple-list 40 |
| `colorsys.hls_to_rgb` | differs | 0/40 | 40/40 | round trip: tuple-list 40 |
| `colorsys._v` | faithful | 40/40 | 40/40 | — |
| `colorsys.rgb_to_hsv` | differs | 0/40 | 40/40 | round trip: tuple-list 40, number-kind 1 |
| `colorsys.hsv_to_rgb` | differs | 0/40 | 40/40 | round trip: tuple-list 40 |
| `calendar.isleap` | faithful | 40/40 | 40/40 | — |
| `calendar.leapdays` | faithful | 40/40 | 40/40 | — |
| `string.capwords` | faithful | 40/40 | 40/40 | — |
| `html.escape` | faithful | 40/40 | 40/40 | — |
| `difflib._format_range_unified` | faithful | 40/40 | 40/40 | — |
| `difflib._format_range_context` | faithful | 40/40 | 40/40 | — |
| `ipaddress._count_righthand_zero_bits` | refused | — | — | the method .bit_length() |
| `urllib.parse._splitnetloc` | differs | 0/40 | 40/40 | round trip: tuple-list 40 |
| `urllib.parse.unwrap` | faithful | 40/40 | 40/40 | — |
| `urllib.parse._splitport` | refused | — | — | a global statement |
| `urllib.parse._splituser` | differs | 0/40 | 40/40 | round trip: tuple-list 40 |
| `urllib.parse._splitpasswd` | differs | 0/40 | 40/40 | round trip: tuple-list 40 |
| `urllib.parse._splitvalue` | differs | 0/40 | 40/40 | round trip: tuple-list 40 |
| `urllib.parse._splittag` | differs | 0/40 | 40/40 | round trip: tuple-list 40 |
| `urllib.parse._splitquery` | differs | 0/40 | 40/40 | round trip: tuple-list 40 |
| `email.utils.quote` | faithful | 40/40 | 40/40 | — |
| `email.utils.unquote` | faithful | 40/40 | 40/40 | — |
| `_pydatetime._is_leap` | faithful | 40/40 | 40/40 | — |
| `_pydatetime._days_before_year` | faithful | 40/40 | 39/40 | graph: big-int 1 |
| `_pydatetime._days_in_month` | differs | 31/40 | 31/40 | round trip: exception 9; graph: exception 9 |
| `_pydatetime._days_before_month` | refused | — | — | reads the module name _DAYS_BEFORE_MONTH, which module statements compute |
| `_pydatetime._ymd2ord` | refused | — | — | reads the module name _DAYS_BEFORE_MONTH, which module statements compute |
| `_pydatetime._divide_and_round` | differs | 33/40 | 33/40 | round trip: exception 7; graph: exception 7 |
| `_pydatetime._cmp` | faithful | 40/40 | 40/40 | — |
| `heapq._siftdown` | faithful | 40/40 | 40/40 | — |
| `heapq._siftup` | faithful | 40/40 | 40/40 | — |
| `shlex.quote` | refused | — | — | reading the attribute .search |
| `glob._ishidden` | refused | — | — | a bytes literal |
| `locale._strip_padding` | differs | 36/40 | 36/40 | round trip: exception 4; graph: exception 4 |
| `_strptime._calc_julian_from_U_or_W` | refused | — | — | reads the imported module or name datetime_date (datetime) |
| `textwrap.dedent` | refused | — | — | reading the attribute .MULTILINE |
