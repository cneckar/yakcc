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
