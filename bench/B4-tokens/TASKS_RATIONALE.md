# B4-tokens Task Corpus Rationale

<!--
@decision DEC-BENCH-B4-CORPUS-001
@title B4 token-expenditure corpus: adversarial task selection rationale
@status accepted
@rationale
  Task selection follows the adversarial framing principle from WI-BENCHMARK-B4 (#188):
  tasks must be HARD for the hooked agent. Wins must come from atoms genuinely satisfying
  complex requests, not cherry-picked easy wins. Each task was chosen for properties that
  stress the hook's atom-substitution path in distinct ways. See per-task rationale below.
-->

## Adversarial Framing Principle

The B4 benchmark measures whether the yakcc hook layer reduces LLM output-token expenditure
while preserving semantic correctness. The corner cases that would expose a false win are:

1. **Cherry-picked tasks**: Trivial implementations where the hook saves tokens by emitting
   a stub that passes a weak oracle — this is not a genuine win.
2. **Broken oracle**: Tests that pass for incorrect implementations — this inflates
   `semantic_equivalent` for Arm A.
3. **Easy tasks**: Tasks where LLMs consistently produce correct short implementations
   regardless of hooks — this reduces statistical signal.

Tasks are chosen to be **adversarial**: the oracle is exhaustive enough that a partially
correct implementation fails. The hook's atom-substitution path must synthesize genuinely
correct implementations, not abbreviated stubs.

---

## Task 1: `lru-cache-with-ttl`

**Prompt**: "Implement an LRU cache with TTL eviction"

**Why adversarial:**
- **Multi-method class** with 6 public methods (set/get/has/delete/size/clear), each with
  precise semantics that interact. A single method wrong breaks multiple oracle tests.
- **Two orthogonal eviction policies** (LRU order + TTL expiry) must compose correctly:
  TTL=0 is immediately expired; `set()` on existing key must reset TTL AND move to MRU.
- **Lazy expiry semantics**: `size()` must not count expired-but-not-yet-evicted entries;
  `delete()` returns `false` for expired entries. A naive implementation that counts all
  map entries fails immediately.
- **O(1) complexity target**: Forces doubly-linked-list + Map pattern. Implementations
  that scan the map for eviction fail the capacity-saturation oracle test.
- **Oracle coverage**: 25 tests spanning capacity, TTL boundary, eviction order, TTL vs LRU
  precedence, per-entry TTL override, and edge cases. An implementation that passes 24/25
  but fails the TTL=0 case, or the `set()` reset case, would still be KILL for Arm A if
  those failures indicate the hook corrupted the implementation.

**Hook-stress property**: The hook must atomize the doubly-linked-list node management,
Map operations, and TTL timestamp arithmetic as distinct atoms. Partial atomization
(e.g., providing the list structure but not the expiry check) produces incorrect output.

---

## Task 2: `csv-parser-quoted`

**Prompt**: "Build a CSV parser with quoted-field handling per RFC 4180"

**Why adversarial:**
- **State machine requirement**: Regex-only approaches fail. The prompt explicitly states
  this, and the oracle tests embedded newlines inside quoted fields — which regex cannot
  handle without multi-line modes that would also break non-quoted row splitting.
- **Edge cases are the majority of the oracle**: 39 tests, most covering corner cases —
  `""` inside `"..."` escaping, CRLF inside quoted field preserved verbatim, BOM stripping,
  trailing newline suppression (no spurious empty row), ragged rows, trailing delimiters.
- **CRLF vs LF**: Mixed line endings in the same file. An implementation that normalizes
  CRLF before parsing would incorrectly modify embedded CRLF inside quoted fields.
- **Whitespace significance**: Unquoted fields must NOT be trimmed. Implementations that
  blindly trim fields fail the whitespace preservation test.
- **Options interface**: Custom delimiter and quote character. Tests with tab-separated and
  pipe-separated data expose hardcoded-comma implementations.

**Hook-stress property**: The hook must recognize the CSV state machine as a coherent whole.
Partial atomization (e.g., providing field tokenization but not embedded-newline handling)
produces an implementation that fails the most adversarial oracle tests.

---

## Task 3: `debounce-with-cancel`

<!--
@decision DEC-BENCH-B4-NON-ENGAGEMENT-001
@title B4 debounce-with-cancel: known hook non-engagement in Slice 1
@status accepted
@rationale
  Diagnosed under WI-B4-DEBOUNCE-HOOK-ENGAGEMENT (#451), 2026-05-13.
  Root cause: debounce is a genuinely novel stateful higher-order function with
  no matching atom in the Slice 1 registry. The model saw the yakccResolve tool
  (Arm A input_tokens=1226 vs Arm B input_tokens=567; delta=659 = system prompt
  suffix + tool schema) but correctly did not invoke it because no atom matches.
  Both arms produced ~427 vs ~433 output tokens (1.4% noise, not a hook win).
  Three candidates evaluated:
    1. Registry not seeded → CONFIRMED. No debounce atom in bootstrap corpus.
    2. Embedding threshold filters candidate → RULED OUT. No candidate exists to
       fail threshold; the tool was presented but not invoked.
    3. Substitution flow logic bug → RULED OUT. The oracle shows Arm A semantic_eq=1
       (all 27 tests pass), meaning the model produced correct code without invoking
       the tool — the flow is intact, there's simply nothing to substitute.
  Path to engagement in Slice 2: seed a timer-management atom (setTimeout/clearTimeout
  closure pattern) into the registry seed corpus. Track via follow-up issue #454.
  This threshold will become a sweep parameter in B4 Slice 2; the non-engagement
  rate at 0.0% for debounce is a data point for the Slice 2 threshold sweep planner.
  Full annotation in corpus-spec.json.
-->

**Prompt**: "Write a debounce wrapper with cancellation, with cancel() and flush()"

**Why adversarial:**
- **Stateful time-based primitive**: Requires closure over timer handle + latest args.
  An implementation that doesn't properly clear both timer AND args on cancel/flush leaks
  state that causes double-invocation on later calls.
- **cancel()-during-wait**: The oracle tests that calling cancel() after db() then waiting
  for the full timer duration does NOT fire fn. An implementation that calls clearTimeout
  but doesn't set the timer ref to undefined may re-cancel on a stale reference.
- **flush() is synchronous**: Must invoke fn immediately (not via setTimeout), then clear
  pending state. An implementation that flush()es via setTimeout would fail the fake-timer
  test (`flush()` should not require `vi.runAllTimers()` to take effect).
- **waitMs=0 is still deferred**: Explicitly not synchronous. An implementation that treats
  0 as "invoke immediately" fails the oracle's fake-timer tests.
- **Sequential independent calls**: Two calls separated by > waitMs must both fire. An
  implementation that returns early if args haven't changed fails this test.

**Hook-stress property**: The hook must atomize the timer management and argument capture
patterns as reusable atoms. This is a genuinely novel stateful primitive — the bootstrap
corpus does not contain a debounce implementation, so the hook cannot short-circuit by
returning a pre-existing atom verbatim.

---

## Why These Three Tasks (Not Others)

The B4 slice 1 floor is 3 tasks per the #402 issue spec. Tasks were chosen to cover three
distinct implementation patterns:

| Task | Pattern | Oracle difficulty | Hook atom density |
|---|---|---|---|
| lru-cache-with-ttl | Stateful class, two-policy eviction | High (25 tests, property interactions) | High (list ops + map ops + TTL arithmetic) |
| csv-parser-quoted | Pure function, state machine | High (39 tests, RFC corner cases) | Medium (parsing states are novel; delimiter/quoting is generic) |
| debounce-with-cancel | Higher-order function, timer closure | Medium (27 tests, fake timers) | Low-medium (timer patterns exist; arg capture is task-specific) |

This spread ensures the benchmark is not biased toward a single implementation pattern.
Slice 2 will scale to 5–10 tasks per #188.

---

## What Makes a Bad Task (Excluded Patterns)

- **Trivial utilities** (e.g., "add two numbers"): LLMs produce correct output in 5 tokens;
  hook provides no measurable benefit.
- **Format converters with only happy-path tests**: Easy to pass with a stub.
- **Tasks with existing atoms in the bootstrap corpus**: Hook could return verbatim atom,
  inflating Arm A's token reduction without measuring generalization.
- **Tasks with no clear correct/incorrect oracle**: Subjective output quality cannot be
  measured as `semantic_equivalent: boolean`.

---

<!--
@decision DEC-B4-PURE-ADD-001
@title B4 Slice 3 (WI-609): pure-add corpus realignment — no task swap
@status accepted
@rationale
  The 2026-05-14 B4 run showed -10%/-21%/-6% output-token reduction (sign-flipped from
  the ≥70% goal). Root cause: only 2 of 8 tasks had shaved atoms in the registry
  (debounce-with-cancel via lodash, semver-range-satisfies via semver). The other 6 tasks
  paid hook overhead (~659 input-token delta per run) with no substitution benefit.
  WI-609 Slice 1 adds 3 new tasks targeting WI-510-shaved packages (uuid S4, jsonwebtoken
  S6, lodash S7 cloneDeep). Pure-add variant chosen (DEC-BENCH-B4-REALIGN-PURE-ADD-001):
  existing 8 tasks preserved byte-identical to keep the 2026-05-14 baseline comparable.
  n_tasks grows 8→11. A swap-out of the 6 misaligned tasks is a follow-up slice decision,
  gated on post-realignment measurement data. This section documents the Slice 3 add.
-->

## Slice 3 (WI-609): Corpus Realignment — 3 New Tasks Targeting WI-510 Shaved Atoms

**Added:** 2026-05-16 | **Issue:** [#609](https://github.com/cneckar/yakcc/issues/609) | **WI:** W-609-S1-1

The B4-2026-05-14 run showed sign-flipped results (-10%/-21%/-6%) because only 2 of 8
tasks had shaved atoms available for substitution. This slice adds 3 tasks that directly
target packages WI-510 has already shaved, raising the aligned-task fraction from 2/8 to
5/11 (45%) before the next run.

---

## Task 9: `uuid-v4-generate-validate`

**Prompt**: "Generate RFC 4122 v4 UUIDs and validate canonical UUID string form"

**WI-510 atom backing**: uuid Slice 4 (PR #xxx) — `v4.js` (generation with crypto RNG +
version/variant bit manipulation) and `validate.js` (canonical form regex).

**Why adversarial:**
- **Cryptographic RNG trap**: The oracle runs 10000 samples and tests bit-distribution
  uniformity. `Math.random()` is detectable at p < 10^-20 due to Lehmer RNG bias in
  the first-nibble bit distribution. Using `crypto.randomBytes` is required.
- **Version nibble omission**: RFC 4122 §4.4 requires byte 6 high nibble = `0100` (version 4).
  Naive implementations skip this, producing random version nibbles. The oracle tests
  1000 generated UUIDs and verifies index 14 = '4' in each.
- **Variant nibble omission**: RFC 4122 requires byte 8 high two bits = `10xx` (variant =
  8/9/a/b). The oracle tests all four variant values appear over 10000 samples
  (each must appear ≥500 times). A correct implementation has each appearing ~2500 times.
- **Over-permissive validator**: `validateV4` must reject uppercase hex, URN prefix
  (`urn:uuid:...`), curly-brace wrapping (`{...}`), missing dashes, wrong-length input,
  and variant nibbles c/d/e/f (Microsoft/NCS reserved). NIL UUID (all zeros) must be
  accepted (version nibble = 0, variant nibble = 0).

**Hook-stress property**: uuid's `v4.js` (35 LoC) and `validate.js` (~15 LoC) are small,
dense atoms. Both are direct substitution targets for the hook under WI-510 S4. A
hook-naive LLM regenerates 80-100 LoC of byte-fiddling and often omits one or both nibble
constraints.

| Property | Value |
|---|---|
| Oracle size | 37 tests |
| Distribution test | 10000 samples, all four variant values ≥500 |
| Adversarial discriminators | Math.random detection, version nibble, variant nibble, validator over-permissiveness, NIL UUID edge case |
| WI-510 atoms | `v4.js`, `validate.js` |
| Expected export | `named:generateV4`, `named:validateV4` |

---

## Task 10: `verify-jwt-hs256`

**Prompt**: "Verify a JWT signed with HS256 (HMAC-SHA256), checking algorithm, signature, and expiry"

**WI-510 atom backing**: jsonwebtoken Slice 6 (PR #xxx) — `verify.js` (full verification
path: structural split → header decode → alg check → payload decode → HMAC verify →
exp check) and `decode.js` (base64url decode + JSON parse).

**Why adversarial:**
- **Algorithm confusion attack (CVE class)**: The oracle includes tokens with `alg: "none"`,
  `alg: "RS256"`, `alg: "HS512"`, and missing `alg`. All must be rejected. Naive
  implementations check only that signature is present, not that `header.alg === "HS256"`.
- **HMAC over original base64url strings**: JWS signs `headerPart + "." + payloadPart`
  using the literal strings from the token, not decoded-and-re-encoded values. The oracle
  uses `createHmac` in the test helper using the same literal strings, so an implementation
  that decodes-then-re-encodes before signing will fail on any token whose base64url
  encoding differs from re-encoding (e.g., non-canonical padding).
- **Missing timingSafeEqual**: The prompt requires `crypto.timingSafeEqual` for constant-time
  comparison. The oracle doesn't directly measure timing, but the reference impl uses it
  and the prompt explicitly requires it (structural correctness criteria).
- **Expiry skipped**: `payload.exp` (Unix seconds) must be checked. The oracle includes
  expired tokens, tokens expiring exactly at `Date.now()`, and tokens with non-numeric
  `exp` fields. All must be rejected.
- **base64url vs base64**: `Buffer.from(x, "base64url")` must be used, not `atob` or
  manual replace/padding. The oracle tests payloads with values that would decode
  differently under base64 vs base64url.

**Hook-stress property**: jsonwebtoken's `verify.js` and `decode.js` cover the full
verification + decode path. A hook-equipped LLM avoids regenerating ~150-200 LoC of
HMAC + base64url plumbing and gets the algorithm-confusion check for free from the atom.

| Property | Value |
|---|---|
| Oracle size | 34 tests |
| Adversarial discriminators | alg=none, alg=RS256, HMAC canonical input, timingSafeEqual, exp boundary (== now rejected), non-numeric exp |
| WI-510 atoms | `verify.js`, `decode.js` |
| Expected export | `named:verifyHs256` |

---

## Task 11: `cycle-safe-deep-clone`

**Prompt**: "Deep-clone a JS value with cycle safety, preserving Date/RegExp/Map/Set and prototype chains"

**WI-510 atom backing**: lodash Slice 7 (PR #598) — `cloneDeep.js` (30 LoC top-level
entry) and `_baseClone.js` (~150 LoC recursive type dispatch with WeakMap cycle detection).

**Why adversarial:**
- **Cycle detection (primary trap)**: `const a = {}; a.self = a;` followed by
  `deepClone(a)` stack-overflows in naive recursive implementations. The reference impl
  uses a `WeakMap<original, clone>` visited set, exactly as lodash's `_baseClone` does.
  The oracle verifies `clone.self === clone` (cycle structure preserved, not just no crash).
- **Date → string trap**: `JSON.parse(JSON.stringify(new Date(...)))` produces an ISO
  string. The oracle creates `new Date(2026, 4, 16)` and asserts `clone instanceof Date`
  and `clone.getTime() === original.getTime()`.
- **Map/Set → plain object trap**: Same pattern — clone must be `instanceof Map` /
  `instanceof Set` with entries/values recursively cloned.
- **undefined property values**: `{a: undefined}` JSON.stringifies to `{}`. The oracle
  asserts `Object.hasOwn(clone, "a") === true` and `clone.a === undefined`.
- **Symbol-keyed properties dropped**: `Object.keys` misses symbol-keyed properties.
  The oracle includes a symbol-keyed object and asserts the clone preserves the symbol.
- **Prototype chain erased**: Naive `{...src}` or `Object.assign({}, src)` produces a
  plain object. The oracle creates a `Point` class instance and asserts
  `Object.getPrototypeOf(clone) === Object.getPrototypeOf(original)` and that prototype
  methods (e.g., `distanceTo`) work on the clone.
- **Functions by reference**: Per lodash.cloneDeep, functions are returned by reference.
  The oracle asserts `clone.fn === original.fn`.

**Hook-stress property**: lodash's `cloneDeep.js` wraps `_baseClone.js`. Both atoms are
direct substitution targets under WI-510 S7. A hook-naive LLM regenerates 100-200 LoC of
recursive type-dispatch, commonly missing cycles, symbol keys, undefined values, or prototype.

| Property | Value |
|---|---|
| Oracle size | 63 tests |
| Adversarial discriminators | self-reference cycle, mutual cycle, nested cycle, array cycle, Date instanceof, RegExp flags/lastIndex, Map/Set instanceof, undefined property, symbol key, prototype chain, functions by reference |
| WI-510 atoms | `cloneDeep.js`, `_baseClone.js` |
| Expected export | `default` |

---

## Why These Three Realignment Tasks (Not Others)

The WI-609 selection criteria (per `DEC-BENCH-B4-REALIGN-SLICE1-TASKS-001`):

| Task | WI-510 Slice | Atoms | Atom density | Oracle difficulty |
|---|---|---|---|---|
| uuid-v4-generate-validate | S4 (uuid) | v4.js, validate.js | High (2 atoms, distinct roles) | High (37 tests, distribution test) |
| verify-jwt-hs256 | S6 (jsonwebtoken) | verify.js, decode.js | High (2 atoms, full verify path) | High (34 tests, CVE-class trap) |
| cycle-safe-deep-clone | S7 (lodash) | cloneDeep.js, _baseClone.js | High (2 atoms, 150+ LoC combined) | High (63 tests, 8 named traps) |

All three tasks target **already-shipped WI-510 shaves**. The next B4 run will measure
hook engagement where substitution atoms actually exist, making the benchmark directionally
meaningful for the first time since the misaligned-corpus problem was diagnosed.
