# Lowering prototypes on a fixed corpus sample: Python, Go, Rust (#1299)

**Issue:** https://github.com/cneckar/yakcc/issues/1299 — criterion 3 of #1292 (atom format lock)
**Date:** 2026-11-23
**Test:** `packages/duc/src/corpus-lowering.test.ts` · **Sample:** `packages/duc/src/__fixtures__/corpus-sample.json` · **Pinned statuses:** `packages/duc/src/__fixtures__/corpus-lowering-expected.json`

## (c) — format gaps that must enter identity: these block the lock (to lane core)

**No (c) item comes from Python, Go or Rust semantics.** Every disagreement and refusal below is
a missing piece of a lowering's runtime or an analysis that can be stored beside the graph. Two
gaps in the **normal form of literal labels** were found, though. Fixing either changes
identity, so both must be decided before the lock.

### C1. A template literal's label holds its source text, not its value

`template:[…]` stores each quasi as **raw source text**, escapes included. Two templates with the
same value therefore get two identities, and every lowering that reads the label as a value is wrong.

Minimal graphs (both `export function f(a) { return … }`):

| Source | Label | Value of the quasi |
|---|---|---|
| `` `a${a}` `` | `template:["a",""]` | `a` |
| `` `\x61${a}` `` | `template:["\\x61",""]` | `a` — the same value, a different identity |
| `` `\n${a}` `` | `template:["\\n",""]` | a newline |
| `` `⏎${a}` `` (a literal newline) | `template:["\n",""]` | a newline — the same value, a different identity |

- **Lowering evidence:** `emitEntry` disagrees on Python, Go and Rust, and still does with characters past U+FFFF left out. Each target emits a backslash and an `n`, where JavaScript has a newline.
  The TypeScript lowering is right only because it writes the raw text back into a template, where JavaScript cooks it again.
  The native runtime's `yk_template` takes the label too (DEC-DUC-NATIVE-RUNTIME-001).
- **Corpus:** 632 of the 4808 registry atoms that lift contain a template. **44** of them have an escape in a quasi.
- **Proposed fix:** the label holds the **cooked** strings, as string literals already do (`"\x41"` and `"A"` share an identity today).
  A tagged template is the one place the raw text is observable (`String.raw`, `strings.raw`). It should be a different operation that carries both.

### C2. A regular expression's flags are kept in source order

`/a/gi` and `/a/ig` are the same regular expression. `RegExp.prototype.flags` and `toString()` give
the flags in canonical order, `"dgimsuvy"`. The literal label keeps them in source order, so the two
get two identities.

- Minimal graphs: `/a/gi.test(a)` gives `lit "/a/gi"`, and `/a/ig.test(a)` gives `lit "/a/ig"`.
- **Corpus:** none of the 50 registry atoms with a flagged regex writes its flags out of order today. The gap is in the normal form, not yet in the data.
- **Proposed fix:** sort the flags in the literal's normal form.
- The **pattern** text is **not** in this class: `/\x41/` and `/A/` differ in `.source`, so they are different values, and two identities are right.

## Method

- **Sample:** 61 atoms, fixed and committed with their graph identities. The test fails if any atom no longer lifts to its identity.
  - 47 come from the bootstrap registry (`bootstrap/yakcc.registry.sqlite`, 4904 L0 blocks).
  - 14 are seed blocks (`packages/seeds/src/blocks`), which seed every registry.
- **Selection:** of the 4904 blocks, 222 lift with parameters. Of those, 90 read nothing but platform primitives, so a lowering needs no link to run them.
  The sample takes every one of these whose inputs can be generated as data: no host objects such as `Logger`, `ServerResponse` or ts-morph `Node`. Duplicates by identity are dropped.
  It then adds the seed parsers without imports, for exceptions and loops (`base64-alphabet` lifts as a module and was left out). `scripts/build-corpus-sample.mjs` rebuilds the sample.
- **Coverage by construct:** strings 31, exceptions 16, objects 15, numbers 14, arrays 13, regular expressions 11, loops 10, closures 9. Also switch, `in`, `typeof`, optional chains, spread, computed keys, default parameters, tuples and `sort`.
- **Probes:** 12 more small functions cover the semantics #1299 names for each target. They are not corpus atoms, so they carry no identity:
  - Python: integer precision and division, truthiness, `null` versus `undefined`, `+`, number to string, `JSON.stringify`, `indexOf` / `lastIndexOf`;
  - Go and Rust: caught and uncaught throws, for the error-value question;
  - Rust: an array shared by two names and by a closure, for ownership.
- **Inputs:** from a seeded generator (`__fixtures__/differential.ts`), 40 distinct argument lists per atom, or the whole domain when it is smaller. That is 2268 inputs over the sample.
  - Numbers include -0, NaN, ±Infinity, 2^53, 1e21, 1e-7 and 5e-324.
  - Strings include `é`, U+00A0, control characters and 😀, which is past U+FFFF: two UTF-16 code units.
- **Comparison:** each input runs through the TypeScript reference (`emitTypeScript` of the same graph) and through the lowering. The results are compared exactly:
  - numbers by `Object.is`, as float64 bits with NaN canonical. A Python integer a double cannot hold is never equal;
  - strings by UTF-16 code units;
  - objects by entries in order;
  - throws by error name and message.
- **Pinned statuses:** every (atom, target) result is pinned, so any change in what lowers, refuses or disagrees fails the test until this table moves with it.
- **Reproduce:**
  - `DUC_CORPUS_REPORT=<file> pnpm --filter @yakcc/duc exec vitest run src/corpus-lowering.test.ts` writes reasons and first disagreements.
  - `DUC_CORPUS_BMP=1` leaves out inputs with characters past U+FFFF.

## Results

| Target | Identical | Refused (with reason) | Disagrees | Disagrees with characters past U+FFFF left out |
|---|---|---|---|---|
| Python | 37 / 61 | 8 | 16 | 2 |
| Go | 36 / 61 | 8 | 17 | 3 |
| Rust | 39 / 61 | 7 | 15 | 2 |

On the 12 probes, Python is identical on 11. The other is integer precision (A5). Go and Rust are identical on 11, and refuse `lastIndexOf` on the twelfth. Nothing fails to build.

Most disagreements are one gap: **the UTF-16 string model** (A1). With characters past U+FFFF
left out, only these disagree:
- `emitEntry`: C1, the template label;
- `tokenize` on Go and Rust: A4;
- `stemToCamelCase` on Python and Go: A3;
- Python's integer precision: A5.

### Fixed in this change (lowering gaps found by the test)

- **`JSON.stringify(value)`** in all three lowerings. It was the commonest refusal: 8 atoms on every target, most of the exception and loop seeds.
  A replacer or an indent argument is still refused with a reason.
- **`Number.parseInt`** in all three, and **`Number.isNaN` / `isFinite` / `isInteger`** in Python. These unblocked `parseSemver`.
- **Number to string** in Python and Go: ECMA-262's Number::toString layout. They wrote `1e-07` for `1e-7`, and `1e-05` for `0.00001`.
- Python's **`Math.max` / `Math.min`** with NaN and ±0, which gave `1` where JavaScript gives NaN.
- Python's **`in`** on a value that is not an object now throws JavaScript's TypeError, where it used to crash.
- Python's **`split` with a regular expression** (ECMA-262's algorithm: an empty match does not split, captures are spliced in). `tokenize` now agrees.
- Python's **bitwise operators** (`<<`, `>>`, `>>>`, `&`, `|`, `^`, `~`), with ToInt32 / ToUint32. This came up in #1298, where `heapq` needs `>>`.
- Python's **`indexOf` with a start position**, and **`lastIndexOf`**.
- Python's **`Math.floor` / `ceil` / `trunc`** on ±Infinity and NaN, which used to crash. A zero result now keeps the sign of a negative argument, as JavaScript does (`Math.ceil(-0.5)` is `-0`).
- Python's **`%`** on integers now gives `-0` for a negative dividend with no remainder (`-4 % 2`).

## (a) — the lowering lacks it, and it can be added

| # | Gap | Targets | Atoms |
|---|---|---|---|
| A1 | **Strings are UTF-16 code units in JavaScript.** Python's `str` holds code points, Go's `string` and Rust's `str` hold UTF-8. So `length`, indexing, `slice`, `charCodeAt` and the comparisons of a string with a character past U+FFFF differ. The native runtime already settled this: strings are UTF-16 (DEC-DUC-NATIVE-RUNTIME-001). The same representation, or a code-unit view over UTF-8, closes it. | all | `truncate`, `renderAtomNewComment` and twelve seed parsers (`non-ascii-rejector` agrees on Rust) |
| A2 | Template quasis are read as values. This is the lowering side of C1. If C1 is fixed, the lowerings need no change; if not, they must cook the text. | all | `emitEntry` |
| A3 | `replace` with a function as the replacement | Python, Go | `stemToCamelCase` |
| A4 | `split` with a regular expression (Python has it now) | Go, Rust | `tokenize` |
| A5 | Python integers past 2^53 are exact, where JavaScript rounds. Python must round every integer result to a double, or use floats where the type inference does not show a safe integer (see B4). | Python | probe: integer precision |
| A6 | `lastIndexOf`, and `indexOf` with a start position | Go, Rust | probe: `index-of` |
| A7 | Platform functions refused with a reason: `Array.from`, `Object.entries`, `RegExp.prototype.exec`, `Array.prototype.sort`, `Number.prototype.toFixed`, `ArrayBuffer` / `DataView`, the optional call `a?.()` | all | `bytesToHex`, `parseArgv`, `extractFunctionName`, `worstHitRateEntries`, `buildSuggestion`, `f64Bytes`, `refBytesToHex` |
| A8 | An object literal with a computed key (Rust has it) | Python, Go | `withHitIncrement` |

None of these needs anything the graph does not carry: the operation's label, its inputs, and the heap token's order.

## (b) — the format lacks it, but it can be stored as an annotation

These are what a lowering would need to go beyond the dynamic value (`any`, `V`, Python objects)
that all three use today. Each is a function of the graph, or of the graph and its contract. So
each is a side table keyed by identity (#1292: "what is attached to a graph"), and none changes
identity.

- **B1. Concrete types (Go and Rust).** `inferTypes` (T1, #1277) on the sample, given only the contract's input types, gives a concrete type to **1392 of 1600** values (87%).
  The rest are unions such as `string | undefined`, values of `unknown`-typed inputs, and the element type of an empty array literal. A lowering to Go structs or Rust enums boxes exactly those.
  Two things decide the result: the graph and the contract.
- **B2. Error values instead of throw (Go `error`, Rust `Result`).** A lowering that returns errors must know which calls may throw. That is a may-throw summary:
  - `throw` operations and `__yakccTry` regions are in the graph;
  - platform primitives that throw are known per target;
  - a linked reference uses its callee's own summary, keyed by the callee's identity.

  Today's lowerings use panic and unwind. They agree with JavaScript on every throw in the sample, including 16 exception atoms, and on both throw probes.
- **B3. Ownership and borrowing (Rust).** A lowering without `Rc<RefCell<…>>` must know which heap values are shared, by two names or by a closure, and which escape.
  The graph gives this: the heap token orders every heap operation, and a closure's captures are its inputs. An alias and escape summary is an annotation.
  Today's `Rc<RefCell>` lowering is identical on both sharing probes.
- **B4. Integer or float (Python).** `inferTypes` already tells `integer` from `float` where the contract and the operations show it. It is the annotation A5 needs to keep Python's `int` without changing results.

## Per-atom table

"identical n/m": every one of m inputs agrees exactly. "**disagrees** n/m": n of m agree.
"(BMP: identical)": the atom agrees on every input without characters past U+FFFF, so its only gap is A1.
Probes are listed last.

| Atom | Origin | Constructs | Inputs | Python | Go | Rust |
|---|---|---|---|---|---|---|
| `add` | `db5da00e2383` | number | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `isHex64` | `67612218ea2b` | string, regex | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `truncate` | `7c6b1dff6c39` | string, number | 40 | **disagrees** 34/40 (BMP: identical) | **disagrees** 34/40 (BMP: identical) | **disagrees** 34/40 (BMP: identical) |
| `stemToCamelCase` | `52639497e792` | string, regex, closure | 40 | **disagrees** 24/40 | **disagrees** 24/40 | identical 40/40 |
| `emitEntry` | `939775daa16d` | string, object, switch | 40 | **disagrees** 13/40 | **disagrees** 13/40 | **disagrees** 13/40 |
| `panicCodeToKind` | `4fc4eb009a7a` | number | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `f64Bytes` | `333e718ae4f1` | number, array, platform | 40 | refused: ArrayBuffer(...) | refused: ArrayBuffer(...) | refused: ArrayBuffer(...) |
| `valtypeByte` | `de5a27255483` | switch, module | 4 | identical 4/4 | identical 4/4 | identical 4/4 |
| `bytesToHex` | `bfa606249fbc` | array, closure, string | 40 | refused: Array.from | refused: Array.from | refused: Array.from |
| `isLocalTriplet` | `49c462823a32` | object | 2 | identical 2/2 | identical 2/2 | identical 2/2 |
| `normalizeBase` | `aabb5f8610b9` | string | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `buildIntentCardQuery` | `e3e4fe3152d5` | object, truthiness | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `buildSkeletonSpec` | `672ef5373e4c` | object, array | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `refBytesToHex` | `8dc97fc0c4bb` | loop, array, string | 40 | refused: an optional method call | refused: an optional method call | refused: an optional method call |
| `isAsciiDigit` | `d0897c9466dd` | string, comparison | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `isEnoent` | `e02be7c904fa` | object, in, typeof | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `normalizeSource` | `d931405d023f` | string, regex | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `candidatesToCombinedScores` | `985c697cc935` | array, closure, number | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `propsArtifactPath` | `85f2dc95ec67` | string | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `collapseWhitespace` | `dc29dd0af302` | string, regex | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `escapeRegex` | `4aec71ca159c` | string, regex | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `normalizeId` | `d63e7bcb4889` | string, regex | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `mapParam` | `5c305103efed` | object | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `deriveSpecName` | `ab986670f9ec` | string, regex | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `normalizeSentence` | `ea87254f07e6` | string, regex | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `parseArgv` | `6142909d11ac` | loop, closure, object, array, string | 40 | refused: Object.entries | refused: Object.entries | refused: Object.entries |
| `insideSnapshot` | `ec715635d0a3` | string | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `validateProofManifestL0` | `fb8b23598335` | exception, loop, object, in, typeof | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `buildFragmentFallback` | `355decb5236f` | string, number | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `isTestEmission` | `7c8f7e55c62b` | string, regex | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `extractFunctionName` | `6653796f339d` | regex, optional-chain | 4 | refused: the method exec | refused: the method exec | refused: the method exec |
| `renderAtomNewComment` | `80502491912a` | string | 40 | **disagrees** 35/40 (BMP: identical) | **disagrees** 35/40 (BMP: identical) | **disagrees** 35/40 (BMP: identical) |
| `outcomeFromResponse` | `f3ad41d8d8a4` | object, undefined | 4 | identical 4/4 | identical 4/4 | identical 4/4 |
| `cosineDistanceToCombinedScore` | `549cfea79fd8` | number, math | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `benchmarkQueryToIntentQuery` | `7fcc13032529` | object, closure, optional-chain | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `worstHitRateEntries` | `ae2a5ef79872` | array, closure, sort, default-param | 40 | refused: the method sort | refused: the method sort | refused: the method sort |
| `computePrecisionAt1` | `c70cd690c1c0` | array, closure, number | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `computeRecallAtK` | `cffb9d270bcb` | array, closure, number | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `computeAtomComplexity` | `d0a5ca1c69f5` | object, number, nullish | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `computeNeedComplexity` | `c8fe85d625ad` | number, math | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `buildSuggestion` | `1c4451dab5df` | switch, string, number-format | 40 | refused: the method toFixed | refused: the method toFixed | refused: the method toFixed |
| `tokenize` | `55829234954f` | string, regex, closure, array | 40 | identical 40/40 | **disagrees** 21/40 | **disagrees** 21/40 |
| `withCompletion` | `b37c8738c458` | object, spread, array | 14 | identical 14/14 | identical 14/14 | identical 14/14 |
| `withHitIncrement` | `f2efd15031e9` | object, spread, computed-key | 40 | refused: an object with a computed key, a method or an accessor | refused: an object with a computed key, a method or an accessor | identical 40/40 |
| `makeBindingKey` | `0f089e81fcc3` | string | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `makeLruNode` | `c4417a5b7949` | object | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `parseSemver` | `4021ed3d5731` | exception, loop, string, object | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `seed:ascii-char` | seed:ascii-char | string, exception | 40 | **disagrees** 33/40 (BMP: identical) | **disagrees** 33/40 (BMP: identical) | **disagrees** 33/40 (BMP: identical) |
| `seed:bracket` | seed:bracket | string, exception | 40 | **disagrees** 37/40 (BMP: identical) | **disagrees** 37/40 (BMP: identical) | **disagrees** 37/40 (BMP: identical) |
| `seed:char-code` | seed:char-code | string, exception | 40 | **disagrees** 32/40 (BMP: identical) | **disagrees** 32/40 (BMP: identical) | **disagrees** 35/40 (BMP: identical) |
| `seed:digit-or-throw` | seed:digit-or-throw | string, exception, tuple | 40 | **disagrees** 39/40 (BMP: identical) | **disagrees** 39/40 (BMP: identical) | **disagrees** 39/40 (BMP: identical) |
| `seed:eof-check` | seed:eof-check | exception | 40 | **disagrees** 36/40 (BMP: identical) | **disagrees** 36/40 (BMP: identical) | **disagrees** 36/40 (BMP: identical) |
| `seed:integer` | seed:integer | loop, exception, number | 40 | **disagrees** 37/40 (BMP: identical) | **disagrees** 37/40 (BMP: identical) | **disagrees** 37/40 (BMP: identical) |
| `seed:signed-integer` | seed:signed-integer | loop, exception, number | 40 | **disagrees** 36/40 (BMP: identical) | **disagrees** 36/40 (BMP: identical) | **disagrees** 36/40 (BMP: identical) |
| `seed:whitespace` | seed:whitespace | loop, exception | 40 | **disagrees** 39/40 (BMP: identical) | **disagrees** 39/40 (BMP: identical) | **disagrees** 39/40 (BMP: identical) |
| `seed:string-from-position` | seed:string-from-position | string, exception | 40 | **disagrees** 35/40 (BMP: identical) | **disagrees** 35/40 (BMP: identical) | **disagrees** 35/40 (BMP: identical) |
| `seed:position-step` | seed:position-step | number, exception | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `seed:peek-char` | seed:peek-char | string, exception, null | 40 | **disagrees** 37/40 (BMP: identical) | **disagrees** 37/40 (BMP: identical) | **disagrees** 37/40 (BMP: identical) |
| `seed:non-ascii-rejector` | seed:non-ascii-rejector | loop, exception, string | 40 | **disagrees** 31/40 (BMP: identical) | **disagrees** 31/40 (BMP: identical) | identical 40/40 |
| `seed:comma-separated-integers` | seed:comma-separated-integers | loop, exception, array, tuple | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `seed:nonempty-list-content` | seed:nonempty-list-content | loop, exception, array | 40 | **disagrees** 37/40 (BMP: identical) | **disagrees** 37/40 (BMP: identical) | **disagrees** 37/40 (BMP: identical) |
| `probe:integer-precision` | probe | — | 20 | **disagrees** 19/20 | identical 20/20 | identical 20/20 |
| `probe:integer-division` | probe | — | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `probe:truthiness` | probe | — | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `probe:null-undefined` | probe | — | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `probe:plus` | probe | — | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `probe:number-to-string` | probe | — | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `probe:json-stringify` | probe | — | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `probe:index-of` | probe | — | 40 | identical 40/40 | refused: the method lastIndexOf | refused: the method lastIndexOf |
| `probe:caught-throw` | probe | — | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `probe:uncaught-throw` | probe | — | 14 | identical 14/14 | identical 14/14 | identical 14/14 |
| `probe:shared-array` | probe | — | 40 | identical 40/40 | identical 40/40 | identical 40/40 |
| `probe:closure-over-heap` | probe | — | 14 | identical 14/14 | identical 14/14 | identical 14/14 |
