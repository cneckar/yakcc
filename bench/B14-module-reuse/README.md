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

## Results: live run on Haiku 5.5 (3 seeds, `results/live-claude-haiku-5-5.json`)

152 calls, about $0.095 (87k input and 173k output tokens). Output tokens include the
model's thinking (effort low).

| | Pass rate | Mean output tokens | Mean input tokens | Dollars per passing task |
|---|---|---|---|---|
| All 13 tasks, scratch | 1.00 | 2,705 | 165 | $0.00137 |
| All 13 tasks, reuse | 1.00 | 1,741 | 2,077 | **$0.00108 (−21%)** |
| Large (8), scratch | 1.00 | 3,937 | 174 | $0.00199 |
| Large (8), reuse | 1.00 | 2,241 | 2,500 | **$0.00137 (−31%)** |
| Medium (2), scratch | 1.00 | 523 | 170 | $0.00028 |
| Medium (2), reuse | 1.00 | 855 | 1,090 | $0.00054 (+93%) |
| Small (3), scratch | 1.00 | 872 | 137 | $0.00045 |
| Small (3), reuse | 1.00 | 998 | 1,607 | $0.00066 (+47%) |

Mean output tokens per task (scratch → reuse) and the reuse arm's picks (T = the target
module, x = another module, - = none):

| Task | Scratch | Reuse | Picks |
|---|---|---|---|
| best-compatible-version | 7,831 | **2,242** | TTT |
| range-within-range | 9,770 | **1,793** | xTT |
| sort-iso-timestamps | 3,811 | 3,028 | TTT |
| deep-copy | 1,877 | 911 | TxT |
| name-based-uuid | 3,377 | 2,831 | xxx |
| apply-path-updates | 1,086 | 1,423 | TTT |
| keep-valid-urls | 854 | 1,753 | TTT |
| md5-hex | 2,891 | 3,951 | TTT |
| canonical-emails | 647 | 921 | --- |
| spell-suggest | 399 | 788 | xxT |
| build-order | 822 | 1,015 | --- |
| base64-decode | 734 | 930 | --T |
| iso-utc-string | 1,060 | 1,049 | --- |

### What it shows

- **Correctness does not separate the arms on these tasks.** Both pass every test in
  every seed. Haiku writes even npm range matching, range containment and SHA-1 from
  scratch correctly, so these held-out tests are at the ceiling. Showing a correctness
  benefit from reuse needs harder tasks or a weaker model.
- **Reuse pays where the module is big and its use is simple.** The two semver range
  tasks drop from about 7,800 and 9,800 output tokens to about 2,200 and 1,800, a 3.5–5.4×
  saving. Over the large tasks, reuse is 31% cheaper per passing task.
- **Reuse costs more where the glue is not trivial, or the task is small.**
  - `md5-hex`: the glue still has to UTF-8 encode and hex-format the digest.
  - `keep-valid-urls`: the model wrote a short regex from scratch.
  - The small and medium tasks: the extra turns cost more than the code saved. The model
    mostly said NONE on the small controls, as it should, but the need turn still costs
    a call.
- **Break-even, roughly:** reuse wins when writing the code from scratch would take more
  than about 2,000 output tokens. Below that, write it. A caller can route on that,
  sending only needs it expects to be large to the library.
- **Picking a module other than the target still passed** in several runs. For
  `name-based-uuid`, the model picked uuid's `sha1` every time, reused the hash, and wrote
  the UUID layout (version and variant bits, formatting) itself. The library offers more
  than one valid level of reuse.

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
