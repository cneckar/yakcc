# B14 — Reuse economics at module scale (#1258, re-scoped)

#1258 asked whether registry reuse lowers the cost of composition tasks, and at what point
it breaks even. B12 and B13 answered part of that. Looking up function-sized helpers costs
more than writing them (B12). Finding large modules is usually cheaper than writing them,
a median of 6.4× with measured tokens (B13). B14 asks the question end to end: **does a
model that finds and reuses a module solve the task correctly, for less than a model that
writes it?** Both arms are scored by held-out tests.

## Arms (same model, same tasks, seeds)

| Arm | What happens | Calls |
|---|---|---|
| `scratch` | The model writes the whole solution. | 1 |
| `reuse` | The model names the capability it needs, in one or two sentences (or NONE). The library shows the top 5 modules, from `@yakcc/discovery-search` `searchModules` over the module index. The model picks one or none. With a pick, it sees the module's root definition and writes glue that calls `lib.<name>`, which the scorer binds to the picked module. With none, it writes everything itself. | 2–3 |

**Scoring.** The candidate runs in a vm sandbox with no host APIs, and with the reused
module loaded in the same realm. The held-out cases and checks are never shown to any
client, and a test enforces it.

**The library** is the module index built with `--all-builds`: 312 roots with descriptive
names, one-line descriptions and closure sources. B14 offers only modules that load in its
runtime, so Node-only builds such as uuid's `crypto`-backed `v5` are filtered out. It shows
one candidate per package and name.

## Tasks (13)

| Task | Size | Module that does the heavy lifting (hidden from the model) |
|---|---|---|
| `best-compatible-version` | large | semver `maxSatisfying` |
| `range-within-range` | large | semver `subset` |
| `sort-iso-timestamps` | large | date-fns `parseISO` |
| `deep-copy` | large | lodash `cloneDeep` |
| `apply-path-updates` | large | lodash `set` |
| `keep-valid-urls` | large | validator `isURL` |
| `name-based-uuid` | large | uuid `v5` (browser build; SHA-1 inside) |
| `md5-hex` | large | uuid `md5` (browser build) |
| `canonical-emails` | medium | validator `normalizeEmail` |
| `spell-suggest` | medium | fastest-levenshtein `closest` |
| `build-order` | small | toposort |
| `base64-decode` | small | base64-js `toByteArray` |
| `iso-utc-string` | small | date-fns `formatISO` |

The expected values follow the published semantics: npm semver, ISO 8601, RFC 4122
(including the RFC's DNS example) and RFC 1321. They were cross-checked against the corpus
modules. The small tasks are controls, where writing should win.

## Status

- **Harness and offline validation:** done (`results/offline-validation.json`). The offline
  client answers with references. Its reuse arm passes 12 of 13: the exception is
  `deep-copy`, where the offline client's need, the spec's first sentence, does not
  surface `cloneDeep`. Its scratch arm passes only the 4 tasks that have a hand-written
  scratch reference; the large tasks have none on purpose. These numbers validate the
  plumbing and measure nothing.
- **Live run: needs a go-ahead in #1258.** `node harness/run.mjs --dry-run --seeds 3` bounds
  it at 156 calls, about $0.10 on Haiku 5.5 (about $4 on Opus 5.5). Haiku is the default,
  and the run refuses above `--max-dollars` (default $2).

## Running

```sh
node scripts/build-module-index.mjs --all-builds \
  --descriptions bench/B12-need-to-code/results/descriptions.json \
  --out bench/B14-module-reuse/.cache/module-index-all-builds.json      # from the repo root
node --test harness/b14.test.mjs
node harness/run.mjs --dry-run --seeds 3
node harness/run.mjs --client offline
CLAUDE_API_KEY=... node harness/run.mjs --client anthropic --seeds 3   # after the go-ahead
```

## Limitations

- **One module per task.** Real composition can need several modules; one keeps the realm
  simple (glue and module share a context).
- **The reuse arm sees the root definition only,** not the whole closure, because that is
  what calling by reference needs. A module whose root does not explain its use (a class
  with many methods) is harder to reuse than one that does.
- **The spec states the behavior the module has.** Where a library's defaults are a choice
  (validator's email rules), the spec spells them out, so scratch is not graded against
  an unstated convention.
