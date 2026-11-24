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

## Held-out set and the confirm step (built, not run)

- `harness/needs-from-readme.mjs` reads each corpus package's README, one section at a
  time, never the code. A model writes the needs a programmer would have, in their words,
  plus the documented API name, which is used only to grade. A need that names the API or
  the package is dropped. 8 READMEs, 33 sections.
- `harness/confirm-roots.mjs`: the model sees only its need and the top K root names, and
  picks one or none. It records the real tokens, so leverage uses the measured cost of
  finding instead of the estimate.

Both default to Haiku 5.5 and refuse to run above `--max-dollars` (default $2). On Haiku
each costs about a cent. Neither has run: the API account is out of credit.

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
- **Leverage uses estimated tokens** (characters / 4) until `confirm-roots.mjs` runs. It
  also counts the whole closure as the cost of writing, which assumes a writer would need
  all of it.
- **Names cannot see some definitions.** Anonymous default exports and functions inside
  IIFEs have no name to attach to: bcryptjs's `hash` and jsonwebtoken's `verify` are out
  of the pool for this reason, which is a gap for #1309.
- **No execution check at module scale.** Large roots are often classes, async, or depend
  on host APIs, so the confirm step is the decision.
