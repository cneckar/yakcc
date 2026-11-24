# B13 — Discovery of large modules (WI-REUSE, GH #1253; names from #1309)

B12 showed that matching works, and that at atom scale it does not pay: finding a 60-token
helper costs more than writing it. B13 asks the question that matters. Can a composing
model's description of a **complex capability** find the graph root that implements it,
and is finding it cheaper than writing it?

## What it measures

- **Pool.** The 2,985 corpus definitions, each with a deterministic name. The names come
  from B12's `harness/names.mjs`, a bench prototype of #1309's names, built with no model:
  - identity, and the path from the nearest entry point;
  - signature and JSDoc;
  - composition: callees, closure size, fan-in;
  - static effects;
  - performance hints;
  - domain tokens.

  Imports are resolved across files, so a root's closure spans its module graph.
- **Two pools are searched.** One is every definition. The other is only the **large
  roots**: an entry point, or a core shared by two or more callers, whose closure has at
  least 400 AST nodes. That gives 253 roots.
- **Search.** Dense (bge-small) plus BM25 over the rendered names, fused by reciprocal rank,
  optionally with B12's model-written descriptions.
- **Leverage.** The cost of writing the target (its closure's source, as output tokens)
  divided by the cost of finding it. Finding means the request and a confirm pick (output
  tokens), plus reading K = 5 candidate names (input tokens), at list prices. Above 1,
  reuse is cheaper than writing.

## Results on the seed set

`queries/seed.json` has 38 author-written needs: 30 module-scale capabilities, such as
parsing CSV with quoting rules, finding the highest version in a range, a bounded cache
with TTL, validating URLs, or deep-cloning values; and 8 needs the corpus does not
implement (YAML, Markdown, DEFLATE, cron, diff, routing, currency formatting, image
resizing). It is a development set, so read it for direction only.

| Pool, text | Target in pool | Top-1 | Top-5 | Top-10 | MRR | Median tokens to write the target | Median leverage | Found in the top 5 and cheaper to reuse |
|---|---|---|---|---|---|---|---|---|
| All definitions, names | 1.00 | 0.47 | 0.77 | 0.83 | 0.59 | 1,426 | 8.0× | 0.70 |
| Large roots, names | 0.93 | 0.53 | 0.83 | 0.87 | 0.66 | 1,426 | 6.5× | 0.77 |
| All definitions, names + descriptions | 1.00 | 0.53 | 0.77 | 0.90 | 0.66 | 1,426 | 7.5× | 0.70 |
| **Large roots, names + descriptions** | 0.93 | **0.63** | **0.90** | 0.93 | 0.76 | 1,426 | 6.5× | **0.83** |

- **At module scale, finding is cheaper than writing:** median leverage 6.5–8×. Large
  targets go well beyond that: csv-parse's `parse` closure is about 14,700 tokens of
  source, and semver's `maxSatisfying` about 6,900. B12's atoms went the other way, at
  about 0.2×.
- **Restricting the search to large roots helps ranking** (top-5 0.77 → 0.83, and
  0.90 with descriptions). It costs coverage for two targets below the size threshold
  (nanoid's `customAlphabet` and toposort's `toposort`).
- **The deterministic names alone get most of the way.** Model-written descriptions add
  about 0.1 at top-1 on the large-root pool.
- **Some misses are other roots of the same capability.** For example, csv-parse's
  `Parser` and `transform` also implement "parse CSV". The seed targets are strict, so
  these numbers are lower bounds.

## Held-out results: needs from READMEs (Haiku 5.5)

`harness/needs-from-readme.mjs` had Haiku read the 8 corpus READMEs (33 sections), never the
code, and write the needs a programmer would have, plus the documented API name, which is
used only to grade.
- 78 needs graded, across 7 packages. semver's README dominates, with 54 of them.
- 31 needs were dropped because they named the API or the package.
- 93 were dropped because the API does not resolve to a named root. Examples are zod's
  `z.object()` (a factory, not the class) and jsonwebtoken's `sign` and `verify`, which
  are anonymous default exports. That second case is the gap noted on #1309.

### Search (`results/eval-readme*.json`)

| Pool, text | Top-1 | Top-5 | Top-10 | Median tokens to write the target |
|---|---|---|---|---|
| All definitions, names | 0.17 | 0.45 | 0.55 | 2,444 |
| Large roots, names | 0.14 | 0.45 | 0.62 | 2,444 |
| All definitions, names + descriptions | 0.44 | 0.77 | 0.88 | 2,444 |
| **Large roots, names + descriptions** | **0.45** | **0.82** | 0.85 | 2,444 |

Needs written from documentation describe behavior in prose, so names alone match them
poorly. The one-line descriptions are what make these searches work: they triple top-1.

### Confirm step (`results/confirm-*-desc-k*.json`)

The model (Haiku 5.5, effort low) sees only its need and the top K root names with
descriptions, and picks one or none.

| | README needs (78), K = 5 | README, K = 10 | Seed (30 + 8 none), K = 5 | Seed, K = 10 |
|---|---|---|---|---|
| Target among those shown | 0.82 | 0.85 | 0.90 | 0.93 |
| Picked the target | 0.78 | 0.77 | 0.90 | 0.93 |
| Picked it when it was shown | 0.95 | 0.91 | 1.00 | 1.00 |
| Reuse precision | 0.87 | 0.85 | 1.00 | 1.00 |
| Needs with no answer, answered "none" | – | – | 8 of 8 | 8 of 8 |

- **When the target was not shown, the model answered "none"** in all 8 such README cases
  rather than reusing something wrong.
- **Most of the 9 wrong reuses (K = 5) are close siblings.** Examples: semver's `cmp` for
  `neq` (`cmp(a, '!=', b)` calls `neq`), `sort` for `compareBuild`, and zod's `ZodObject`
  for `parse`. Two are real mismatches: uuid v6 for nanoid, and v7 for v1.
- **K = 10 adds little reach and slightly lowers accuracy,** so K = 5 is the better
  default.

### Measured leverage

These use real tokens from the confirm runs. A README need's request averages 41 tokens.
The confirm turn reads about 1,160 tokens and writes about 147 (the pick, a reason, and
thinking).

| | Median | 10th percentile | 90th percentile |
|---|---|---|---|
| README needs | **6.4×** | 0.3× | 21.7× |
| Seed needs | 3.9× | – | min 0.2× |

At module scale, finding and confirming is usually several times cheaper than writing. The
low tail is small targets such as `neq`, which are cheaper to write. A router could skip
search for needs it expects to be small.

**Spend:** about $0.07 on Haiku 5.5 for the README queries and all four confirm runs.

### Balanced by package (`harness/balance.mjs`, no model calls)

semver supplies 54 of the 78 needs, and it is the easy package: its target is in the top 5
for 94% of them. The other three packages with no large-root targets score zero, because
their targets are small or are methods and so are not in the pool by design:
- jsonwebtoken's error classes are 29–52 AST nodes;
- nanoid's `nanoid` is about 100;
- for zod's `parse` and `refine`, the search returns the owning class or `custom`.

Restricted to the 68 needs whose target is a large root (`--in-pool`), across four
packages:

| | All needs | Macro (each package equal) | Capped at 8 per package, macro |
|---|---|---|---|
| Search: target in top 5 | 0.94 | 0.94 | 0.89 |
| Confirm: picked the target | 0.90 | 0.89 | 0.89 |
| Confirm: reused something wrong | 0.07 | 0.06 | 0.03 |

Over all 78 needs, the package-balanced top-5 is 0.49. The gap is exactly the needs for
small or method targets.

### APIs the names cannot resolve (`harness/api-resolution.mjs`, input for #1309)

A second README run (`queries/readme-run2.json`, Haiku, about a cent) kept the needs whose
documented API resolved to no named definition. There were 81:

| Kind | Count | What would resolve it |
|---|---|---|
| Not an API: CLI flags, concept headings, options, types | 31 | nothing; README noise |
| Anonymous default export of a same-named file (jsonwebtoken's `sign.js`, `verify.js`) | 21 | #1309: name a default export after its file |
| Property-assigned function (bcryptjs's `bcrypt.genSaltSync = function …`) | 8 | #1309: name an assigned function after its property |
| Member of an object a factory returns (`limit.activeCount`) | 7 | already covered by the factory's root |
| Call signature in the API name (`pLimit(concurrency)`) | 6 | a parsing slip in the generator, now fixed |
| Other (constants, the `^` operator, `simplifyRange`) | 8 | — |

So 29 of the needs a README describes are blocked only by naming: anonymous default
exports and property-assigned functions.

## Running

```sh
node --test harness/b13.test.mjs
node harness/b13.mjs                                      # -> results/eval-seed.json
node harness/b13.mjs --descriptions ../B12-need-to-code/results/descriptions.json \
  --out results/eval-seed-desc.json
node harness/needs-from-readme.mjs --dry-run
node harness/confirm-roots.mjs --dry-run --eval results/eval-seed-desc.json
```

## Limitations

- **The seed needs are author-written,** and their targets are strict.
- **Leverage counts the whole closure as the cost of writing,** which assumes a writer
  would need all of it. A writer might need less, so leverage is an upper estimate on
  that side. The find side is measured.
- **semver dominates the README set** (54 of 78 needs) and is the easy package. Use the
  package-balanced numbers above.
- **Names cannot see some definitions.** Anonymous default exports and functions inside
  IIFEs have no name to attach to: bcryptjs's `hash` and jsonwebtoken's `verify` are out
  of the pool for this reason, which is a gap for #1309.
- **No execution check at module scale.** Large roots are often classes, async, or depend
  on host APIs, so the confirm step is the decision.
