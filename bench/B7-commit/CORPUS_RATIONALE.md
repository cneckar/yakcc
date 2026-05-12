# B7 Corpus Rationale — Slice 2

<!--
@decision DEC-BENCH-B7-CORPUS-001
@title B7-commit corpus: 32 novel-glue utilities — selection rationale and adversarial framing
@status accepted (WI-B7-SLICE-2, issue #389)
@rationale
  This document locks the corpus content per the never-versioning cornerstone
  (DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001). Corpus content must never be changed
  silently — any substitution requires a new DEC-BENCH-B7-CORPUS-NNN decision with
  explicit rationale for the change.

  SELECTION DISCIPLINE (adversarial framing):
  Each utility was chosen because it requires REAL VERIFICATION to distinguish a
  correct from an incorrect implementation. Trivial passthrough utilities (identity
  functions, single-expression wrappers) are explicitly forbidden per #191's
  "adversarial framing" cornerstone: no utility that could be verified by inspection
  alone. Every utility in this corpus has at least one of:
    - Multi-branch logic with non-obvious edge cases
    - A numeric or string invariant that must be actively tested
    - An encoding/decoding round-trip property
    - A boundary condition that commonly produces off-by-one bugs
    - A well-known algorithmic property (commutativity, idempotence, triangle inequality)

  NEVER-SYNTHETIC CORNERSTONE:
  All 32 utilities are hand-authored TypeScript implementing real, commonly-used
  algorithms. None is LLM-generated. Each JSDoc describes what the function actually
  does — the JSDoc is the oracle. This satisfies DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001.

  NO-VERSIONING CORNERSTONE:
  SHA-256 hashes in corpus-spec.json lock each utility's exact source. Changing a
  utility's source silently invalidates all historical timing comparisons. Amend this
  document and the corresponding corpus-spec.json entry together, filing a new DEC ID.
-->

**Parent decision:** DEC-BENCH-B7-CORPUS-001 (see frontmatter)
**Issue:** #389 — WI-B7-SLICE-2
**Parent:** #191 — WI-BENCHMARK-B7

---

## Corpus overview

32 utilities across 6 shape classes. The 5 from Slice 1 are preserved unchanged;
27 new utilities were added for Slice 2.

| Category | Count | Utilities |
|----------|-------|-----------|
| Slice 1 (preserved) | 5 | array-median, camel-to-snake-preserving-acronyms, hamming-distance, is-valid-ipv4, iso-duration-to-seconds |
| String parsing / predicates | 8 | parse-semver, valid-uuid-v4-detector, parse-cron-expression, valid-email-rfc5322, parse-rgb-hex, valid-jwt-shape, parse-query-string, slugify-ascii |
| Numeric / math | 6 | gcd-euclidean, prime-sieve-eratosthenes, lerp-clamped, fast-pow-mod, sum-digits-recursive, kahan-sum |
| Array / collection | 6 | chunk-fixed-size, group-by-key, dedupe-stable-order, zip-longest, flatten-depth-bounded, rotate-array-in-place |
| Date / time | 3 | is-leap-year-gregorian, days-between-dates, parse-rfc3339-utc |
| Bitwise / encoding | 4 | popcount, base64-url-encode, hex-encode-lowercase, varint-encode |

---

## Per-utility selection rationale

### Slice 1 utilities (preserved from WI-B7-SLICE-1, unchanged)

**array-median** — Numeric array → scalar. Real properties: correct sort, mid-index
arithmetic, even-length average. Cross-harness baseline: timing should match
v0-release-smoke smoke.mjs step8bDurationMs within noise.

**camel-to-snake-preserving-acronyms** — String transform. Real properties: idempotence
on already-snake input, length monotonicity, acronym collapse semantics differ from
naive per-character lowercasing.

**hamming-distance** — Two-string scalar. Real properties: symmetry (hd(a,b)=hd(b,a)),
identity-of-indiscernibles (hd(a,a)=0), triangle inequality. Throws on unequal lengths —
error path must be verified.

**is-valid-ipv4** — String predicate. Real properties: octet boundary enforcement
(0–255), leading-zero rejection, exactly-4-part requirement. Commonly implemented
incorrectly (parseInt accepts leading zeros; regex-only misses numeric range).

**iso-duration-to-seconds** — String parsing → numeric. Real properties: associativity
of parse + round-trip for canonical durations, year/month approximation (365d/30d) must
be documented. Malformed input yields NaN.

---

### String parsing / predicates (8 new)

**parse-semver** — SemVer 2.0.0 parsing. Real properties: version comparison order
(major > minor > patch), no-leading-zeros rule for numeric parts, prerelease
dot-identifier structure. Incorrect implementations frequently conflate build-metadata
with prerelease or accept "01.2.3". Non-trivial multi-branch regex + numeric parsing.

**valid-uuid-v4-detector** — UUID v4 shape validation. Real properties: version nibble
at position 14 must be '4'; variant nibble at position 19 must be {8,9,a,b} (2 high bits
= 10xxxxxx). Common bugs: accepting uppercase, accepting version 1/3/5, ignoring variant
bits. Requires genuine multi-branch logic beyond a single regex.

**parse-cron-expression** — 5-field cron parsing. Real properties: per-field range
enforcement (minute 0–59, hour 0–23, day-of-month 1–31, month 1–12, day-of-week 0–7),
step form validation (*/N where N ≥ 1 and N ≤ field-max). Incorrect implementations
frequently accept out-of-range values or wrong field counts.

**valid-email-rfc5322** — RFC 5322 structural email validation. Real properties: 254
character total limit, 64 character local-part limit, domain label 63 character limit,
no leading/trailing hyphens on labels, no consecutive dots in local-part. Common bug:
accepting "a@b" (single-label domain) or addresses with no at-sign.

**parse-rgb-hex** — CSS hex color parsing. Real properties: 3-digit form expands each
nibble by doubling (not shifting), 6-digit form parses pairs directly, case-insensitive
body, strict '#' prefix requirement. Common bugs: wrong nibble expansion for 3-digit form,
accepting 4-digit or 8-digit RGBA forms.

**valid-jwt-shape** — JWT structural shape check. Real properties: exactly 3 base64url
segments separated by dots, header must be a JSON object with a string "alg" field,
payload must be a JSON object (not array, not primitive). Requires base64url decode
(not standard base64), JSON parse, and type-checking — not a single regex.

**parse-query-string** — URL query string parsing. Real properties: percent-decoding of
both keys and values, '+' → space substitution (application/x-www-form-urlencoded),
repeated-key accumulation into arrays, empty key handling. Common bugs: using split('=')
naively (breaks on values containing '='), not handling repeated keys.

**slugify-ascii** — ASCII slug generation. Real properties: idempotence on already-slug
input, non-ASCII stripping (not transliteration), run-collapsing (multiple consecutive
non-alphanum → single hyphen), leading/trailing hyphen removal. Common bugs: not stripping
non-ASCII before lowercasing, double-hyphen survivors.

---

### Numeric / math (6 new)

**gcd-euclidean** — Euclidean GCD. Real properties: commutativity (gcd(a,b)=gcd(b,a)),
gcd(n,0)=n, gcd(0,0)=0 by convention, divides-both property. Iterative implementation
exercises the remainder chain; tests must verify transitivity of divisibility.

**prime-sieve-eratosthenes** — Prime sieve. Real properties: all returned numbers are
prime, no primes in [2, limit] are missing, output is sorted ascending. Common bugs:
starting inner loop at 2i instead of i², missing 2 as a prime, off-by-one on the limit.
Uses Uint8Array for O(n) space efficiency — exercises typed array semantics.

**lerp-clamped** — Clamped linear interpolation. Real properties: lerp(a,b,0)=a,
lerp(a,b,1)=b, monotonicity for t ∈ [0,1], output ∈ [min(a,b), max(a,b)] for any
finite inputs including negative range and reversed a/b. Common bugs: clamping t but
not the result (floating-point rounding can still escape range), wrong handling of b < a.

**fast-pow-mod** — Modular exponentiation. Real properties: (b^0)%m=1 for any valid m,
(b^1)%m=b%m, Fermat's little theorem for prime m (b^(m-1)=1 mod m when gcd(b,m)=1).
Common bugs: using ** operator (loses precision above 2^53), wrong modulus=1 special case.
The right-to-left bit scan and floor division avoid bitwise-shift precision loss.

**sum-digits-recursive** — Digital root. Real properties: sumDigitsRecursive(n) ∈ [1,9]
for n>0, equals n mod 9 with 9 substituted for 0 (per the digital root formula),
sumDigitsRecursive(0)=0. Common bugs: returning 0 for multiples of 9, infinite recursion
on single-digit inputs, incorrect modular mapping.

**kahan-sum** — Kahan compensated summation. Real properties: |kahanSum(values) - Σ(values)|
< naive summation error for long sequences, kahanSum([0.1, 0.2, 0.3]) should produce ≈0.6
(not 0.6000000000000001), kahanSum([]) = 0. The compensation variable is the key
distinguishing feature from naive summation — requires understanding floating-point
representation to verify correctly.

---

### Array / collection (6 new)

**chunk-fixed-size** — Fixed-size chunking. Real properties: all but the last chunk have
exactly `size` elements, concatenation of chunks equals the input array, empty input
returns [], chunk size > array length returns [[...all]]. Common bugs: off-by-one on
slice boundaries, wrong final chunk size.

**group-by-key** — Group-by. Real properties: union of all groups equals the input set,
within each group original order is preserved, first-seen key ordering in the Map.
Requires a key function — tests must verify that the key function is applied per-item,
not per-type, and that items with the same computed key land in the same group.

**dedupe-stable-order** — Stable deduplication. Real properties: output is a subsequence
of the input (no reordering), first occurrence of each element survives, NaN === NaN
deduplication (Set uses SameValueZero). Optional keyFn allows projection-based dedup
(e.g. by object id). Common bugs: using indexOf (O(n²)), using JSON.stringify for
equality (breaks on non-serializable values).

**zip-longest** — Zip with padding. Real properties: output length = max(a.length, b.length),
output[i][0] = a[i] (or fillA if i >= a.length), output[i][1] = b[i] (or fillB if
i >= b.length), zip-longest of equal-length arrays equals zip. Distinguishable from
zip-shortest (which discards elements) — this property is what makes verification
non-trivial.

**flatten-depth-bounded** — Depth-bounded flatten. Real properties: flatten(x, 0) is a
shallow copy, flatten([[1,[2]]], 1) = [1,[2]] (does not recurse past depth), concatenation
of flatten(x, Infinity) equals the fully-flat array, non-array elements are passed through.
Recursive implementation exercises the depth-decrement invariant.

**rotate-array-in-place** — In-place array rotation. Real properties: rotate(arr, n) =
rotate(arr, n % arr.length), rotate then un-rotate restores the original array,
rotate(arr, 0) is a no-op, rotate(arr, n) followed by rotate(arr, -n) is a no-op.
The three-reversal algorithm is a non-obvious correctness claim — tests must verify
the reversal sequence produces the correct rotation direction.

---

### Date / time (3 new)

**is-leap-year-gregorian** — Gregorian leap year. Real properties: divisible-by-400
are leap (1600, 2000), divisible-by-100-but-not-400 are not (1700, 1800, 1900),
divisible-by-4-but-not-100 are (1996, 2004). The three-rule hierarchy is the
adversarial property — many implementations get the century exception wrong. Negative
years (proleptic calendar) must work.

**days-between-dates** — Calendar days between dates. Real properties: daysBetween(d,d)=0,
symmetry (daysBetween(a,b)=daysBetween(b,a)), daysBetween("2000-02-28","2000-03-01")=2
(leap year 2000), daysBetween("1900-02-28","1900-03-01")=1 (non-leap 1900). UTC midnight
interpretation avoids DST artifacts. Common bugs: month off-by-one in Date.UTC,
forgetting to subtract instead of add.

**parse-rfc3339-utc** — RFC 3339 UTC timestamp parsing. Real properties: fractional
seconds are optional and millisecond-converted, 'Z' and 'z' suffixes both accepted
(RFC 3339 §5.6), non-UTC offsets rejected, month/day/hour/minute/second range validation,
null for malformed. Common bugs: accepting '+00:00' offsets, omitting fractional-second
parsing, not validating hour > 23.

---

### Bitwise / encoding (4 new)

**popcount** — Population count. Real properties: popcount(0)=0, popcount(0xFFFFFFFF)=32,
popcount(n) + popcount(~n) = 32 for any 32-bit n, popcount is additive over disjoint
bit-masks. The parallel bit-counting algorithm uses 5 bitmask steps — any error in a
mask or shift produces systematically wrong results for specific bit patterns.

**base64-url-encode** — Base64url encoding. Real properties: output contains no '+',
'/', or '=' characters, base64url-decode(base64url-encode(x)) = x (round-trip),
output length = ceil(input.length * 4 / 3) with no padding. Differs from standard
base64 only in character substitution (+→- /→_ padding stripped) — tests must verify
these substitutions, not just "looks like base64".

**hex-encode-lowercase** — Hex encoding. Real properties: output length = 2 × input.length,
all characters in [0-9a-f], hex-decode(hex-encode(x)) = x, byte value 0x0F encodes to
"0f" (not "f" — leading zero required). Common bugs: no leading zero for bytes < 16,
uppercase output.

**varint-encode** — Protocol Buffers varint. Real properties: single-byte encoding for
values 0–127, MSB continuation bit set for values >= 128, decode(encode(n)) = n for
all valid inputs, encode(128) = [0x80, 0x01] (the canonical 2-byte form). Common bugs:
using bitwise right-shift (>> loses bits above 2^31 for JS numbers), forgetting the
continuation bit pattern.

---

## What was NOT chosen and why

- **identity / passthrough utilities** (e.g. `clamp(n, lo, hi)` with a single
  `Math.max(lo, Math.min(hi, n))` expression): body < 3 statements; rejected by
  TRIVIAL_BODY_THRESHOLD. These would never reach the verification path.

- **pure regex wrappers** (e.g. `isHexString(s)` returning `/^[0-9a-f]+$/i.test(s)`):
  single-statement body; trivial passthrough. Real verification adds no signal.

- **well-known algorithms already in bootstrap** (e.g. `clamp`, `lerp` without
  clamping, `range`): novelty validation gate prevents collisions with the bootstrap
  registry. Any utility scoring >= 0.70 against bootstrap pre-atomize is replaced.

- **cryptographic primitives** (SHA-256, AES, HMAC): these delegate to Node's `crypto`
  module; the body would be a trivial wrapper. The interesting verification is in the
  primitive itself, not the wrapper.
