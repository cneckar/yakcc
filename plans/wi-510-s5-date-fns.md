# WI-510 Slice 5 — Per-Entry Shave of Five `date-fns` Headline Bindings

**Status:** Planning pass (read-only research output). Not Guardian readiness for any code slice.
**Scope:** Slice 5 of [#510](https://github.com/cneckar/yakcc/issues/510). Slice 1 (engine, PR #526, `37ec862`), Slice 2 (validator, PR #544, `aeec068`), Slice 3 (semver, PR #570/#571, `b83d46f` + `d71364c`), and Slice 4 (uuid + nanoid, PR #573, `5d8bde1`) are all landed on `main`.
**Branch:** `feature/wi-510-s5-date-fns`
**Worktree:** `C:/src/yakcc/.worktrees/wi-510-s5-date-fns`
**Authored:** 2026-05-16 (planner stage, workflow `wi-510-s5-date-fns`)
**Parent docs (on `main`, read in full):** `plans/wi-510-shadow-npm-corpus.md` (the reframed #510 engine plan), `plans/wi-510-s4-uuid-nanoid.md` (Slice 4 template — the immediate structural sibling), `plans/wi-510-s3-semver-bindings.md` (Slice 3 template), `plans/wi-510-s2-headline-bindings.md` (Slice 2 origin).

This document changes no TypeScript source, does not modify `MASTER_PLAN.md` permanent sections, and does not constitute Guardian readiness for any code-bearing slice. New DEC IDs in §8 are to be annotated at the implementation point (consistent with how Slices 1-4 recorded their `DEC-WI510-*` entries).

**Parallel slice notice (2026-05-16):** Slice 6 (jsonwebtoken + bcrypt) is being planned in parallel in a separate worktree. The two slices are independent — disjoint fixture directories, disjoint test files, append-only into the same shared `corpus.json` (each adds rows with non-overlapping IDs). Slice 5 owns only `plans/wi-510-s5-date-fns.md`; it does NOT touch `plans/wi-510-s6-*.md`.

---

## 1. What changed — why Slice 5 exists

Slices 1-4 proved the dependency-following shave engine on `ms`, then `validator` (Babel-CJS), then `semver` (plain CJS + real-world `range`⇄`comparator` cycle), then `uuid` + `nanoid` (compiled CJS + first real-world `require('crypto')` Node-builtin foreign-leaf). Slice 5 advances one rung up the §5 graduated-fixture ladder of `plans/wi-510-shadow-npm-corpus.md`:

> *Slice 5 — date-fns subset (larger call graph; many small pure modules)*

The issue body (#510) names five date-fns headline bindings:

> *date-fns: parseISO / formatISO / addDays / differenceInMs / parse-tz-offset*

date-fns@4.1.0 is **dual-format dual-exports**: every named entry ships both `<name>.js` (ESM) and `<name>.cjs` (CJS) variants, with `package.json#exports` mapping `./<name>` to `{ require.default: "./<name>.cjs", import.default: "./<name>.js" }`. The shave engine's resolver prefers `require` over `import` (verified across Slices 2-4), landing on the CJS variants naturally — and we point `entryPath` directly at the `.cjs` file to bypass `exports` resolution entirely. **No engine source change.** Slice 5 is a **pure fixture-and-test slice**; gate is **`review`** (matches Slices 2-4).

### 1.1 Binding-name resolution (operator-decision boundaries closed)

| Issue-body name | Resolved entry | Notes |
|---|---|---|
| `parseISO` | `parseISO.cjs` | Direct match. The "parse an ISO-8601 string into a Date" canonical entry. Internally parses date, time, AND timezone offset substrings via file-local `parseTimezone()` helper. |
| `formatISO` | `formatISO.cjs` | Direct match. The "format a Date into an ISO-8601 string" canonical entry. |
| `addDays` | `addDays.cjs` | Direct match. The "add N days to a Date" canonical entry. |
| `differenceInMs` | `differenceInMilliseconds.cjs` | The issue-body name `differenceInMs` is the short conversational form; date-fns exports the full name `differenceInMilliseconds`. Single file, single export — no ambiguity. **Documented in `DEC-WI510-S5-DIFFERENCE-IN-MS-BINDING-001` (§8).** |
| `parse-tz-offset` | **`parseJSON.cjs` (substitute headline)** | **Operator-decision boundary closed via substitution.** See §1.2. |

### 1.2 `parse-tz-offset` resolution — substitute `parseJSON` (DEC-WI510-S5-PARSE-TZ-OFFSET-RESOLUTION-001)

**The problem.** date-fns@4.1.0 does not ship a top-level `parseTzOffset.cjs` or `parseTimezone.cjs` entry. Verified by exhaustive search of all 250 root `*.cjs` files: no file matching `parse*tz*`, `parse*Timezone*`, `*Tz*Offset*`, or `parse*Offset*` exists at the package's public entry surface (the files matching `tz|timezone|offset|utc` regex at the root are: zero — there are none). The closest entities are:

- **`_lib/getTimezoneOffsetInMilliseconds.cjs`** — a 31-line private helper that returns `date.getTimezoneOffset() * 60_000` plus DST handling. Not in `package.json#exports` (not a public binding). Semantically it returns the *system's* timezone offset, NOT parses a tz string into one — wrong concept.
- **`parseISO.cjs`'s file-local `parseTimezone()` function** (lines 224-242) — IS the real "parse tz string `"+05:30"` → offset-in-ms" implementation in date-fns, but it is a file-local helper, not a separately addressable export. Pointing `entryPath` at the file would re-shave `parseISO.cjs` (duplicate of the first headline).
- **`date-fns-tz`** — a sibling published package (`npm install date-fns-tz`) that exposes `parseFromTimeZone`, `getTimezoneOffset(timezone, date)`, `format-in-tz`, etc. as public bindings. This is a *different* npm package, out of Slice 5's scope.

**Three options evaluated:**

- **Path A — substitute with `parseISO`:** would duplicate the first headline. Rejected.
- **Path B — defer `parse-tz-offset` to a follow-on `date-fns-tz` slice:** honest but under-delivers Slice 5 (4 headlines instead of 5).
- **Path C (chosen) — substitute with `parseJSON.cjs`:** `parseJSON` IS date-fns's canonical "parse a date string WITH a trailing timezone-offset suffix into a Date" entry. From `parseJSON.cjs`'s own doc: it accepts ISO strings including the `+00:00`, `+0000`, `+05:45` tz-offset trailing components. Semantically it is the closest public binding to "parse-tz-offset" — it parses a string whose tail contains a tz offset, and the function's behavior is exactly the resolution of that offset against the leading date/time components. It is a real public binding (`./parseJSON` is in `package.json#exports`), it is a single small file (60 lines), and its subgraph is tiny (4 modules total: `parseJSON.cjs → toDate.cjs → constructFrom.cjs → constants.cjs`).

**Path C is chosen.** It honors the issue-body intent (the spirit of "a date-fns binding that parses tz-offset semantics out of a string") while staying inside what date-fns@4 actually ships as a public entry, mirroring the same pragmatic discipline Slice 3 used to map `"parse-component"` → `parse()` (`DEC-WI510-S3-PARSE-COMPONENT-BINDING-001`) and Slice 4 used to map `"v4-validate"` → `validate()` (`DEC-WI510-S4-UUID-BINDING-NAMES-001`).

**Documented in `DEC-WI510-S5-PARSE-TZ-OFFSET-RESOLUTION-001` (§8).** A separate follow-on issue should file the `date-fns-tz` slice (which would carry the real `parseFromTimeZone`/`getTimezoneOffset` bindings) if the corpus later needs the strict-timezone-string-parsing semantic. The corpus query (§5.4) describes the `parseJSON` headline as "Parse an ISO-8601 date string with optional timezone offset suffix into a Date" — honest to what the function actually does.

### 1.3 Version pin — `date-fns@4.1.0`

**Selected: `date-fns@4.1.0`** (current `latest` dist-tag as of 2026-05-16; `npm view date-fns dist-tags` returns `{ next: '4.0.0-beta.1', latest: '4.1.0' }`).

- Despite date-fns@4 being `"type": "module"`, **it ships dual-format `.cjs` + `.js` outputs** via `package.json#exports`. Verified: `4.1.0/index.cjs` exists; `./parseISO`, `./formatISO`, `./addDays`, `./differenceInMilliseconds`, `./parseJSON` all map their `require.default` condition to a `.cjs` file. The shave engine's resolver picks `require` over `import` (proven across Slices 2-4), landing on `.cjs` naturally. By pointing `entryPath` directly at the `.cjs` file we bypass `exports` resolution entirely.
- **Zero runtime npm dependencies.** Verified: `package.json` has no `dependencies` field. The only external concern is `Date.prototype.getTimezoneOffset()` in `_lib/getTimezoneOffsetInMilliseconds.cjs`, which is a Web/Node *global* (not a `require()` call), and none of the five Slice 5 headlines transitively reach into `_lib/getTimezoneOffsetInMilliseconds.cjs` anyway (only `parseISO`'s subgraph touches `_lib/`, and it touches `_lib/addLeadingZeros.cjs` via `formatISO`, NOT `getTimezoneOffsetInMilliseconds.cjs`). **Expected `stubCount = 0` for ALL five headlines** — date-fns is a return to the "pure JavaScript, no `crypto`, no external edges" regime that Slices 2 and 3 had, contrasting Slice 4's `require('crypto')`.
- **Source shape: clean modern CJS.** Every `.cjs` file opens with `"use strict";`, every `require()` is a top-level `var _index = require("./<relative>.cjs")` pattern. NOT Babel-transpiled with `_interopRequireDefault` wrappers (contrast with `validator-13.15.35`). NOT TypeScript-compiled with `Object.defineProperty(exports, "__esModule", ...)` (contrast with `uuid-11.1.1`). It is hand-aliased CJS, structurally the *simplest* of any landed/planned fixture.
- **No class declarations in any of the five headline subgraphs.** Verified by `grep -l '^class \w\+ {' *.cjs _lib/*.cjs` — only two files in the entire 32MB tarball contain a top-level class declaration (`parse/_lib/Parser.cjs`, `parse/_lib/Setter.cjs`), and they live under `parse/_lib/` which is the general-format `parse()` function's subdirectory — not transitively reachable from any of `parseISO`, `formatISO`, `addDays`, `differenceInMilliseconds`, `parseJSON`. **Risk of hitting engine limit #576 (ArrowFunction-in-class-body decomposition) is ZERO for Slice 5.**

**Documented in `DEC-WI510-S5-VERSION-PIN-001` (§8).**

### 1.4 Pre-existing issue context — engine limit #576 does NOT apply

Per filed issue **#576**: the shave engine cannot decompose ArrowFunctions inside class bodies. semver's `satisfies` hit this in Slice 3 and produces only `moduleCount=1, stubCount=1` instead of `~18` — the Slice 3 PR #571 fix was to align test assertions with engine reality. Slice 5's five headlines are **all pure function exports with no class declarations anywhere in their transitive subgraphs** (verified §1.3 above), so the #576 limit is structurally not exercised. Test assertions for Slice 5 use the §3 BFS-survey-derived ranges, not estimates that the engine cannot actually deliver.

---

## 2. Path A confirmed (again) — no engine change needed

The engine pattern is settled across Slices 1-4. `shavePackage({ packageRoot, entryPath })` accepts an explicit per-entry override; `isInPackageBoundary()` scopes the BFS to the package's own directory; `extractRequireSpecifiers` walks CJS `require(<string>)` calls; external edges become `ForeignLeafEntry` records. No engine source change. No new public-API surface. No `ShavePackageOptions` shape change. Slice 5 is a **pure fixture-and-test slice**; gate is **`review`** (matches Slices 2-4).

The single new property Slice 5 exercises beyond the engine's prior corroborations is **breadth-not-depth**: five small subgraphs that share a tight common chain (`toDate → constructFrom → constants`). Each headline's BFS independently rediscovers that shared chain (per-entry isolation invariant, `DEC-WI510-S2-PER-ENTRY-ISOLATION-001`); shared sub-atoms are deduplicated at the registry layer via `canonicalAstHash` and the idempotent `storeBlock` `INSERT OR IGNORE`. This is the cleanest corroboration yet of "the engine produces stable atom identities across multiple entry points into the same package" — useful evidence for the production-corpus discovery story even though Slice 5 does not formally assert it.

---

## 3. Per-entry subgraph size estimates (read from extracted source)

Estimates read directly from the `date-fns@4.1.0` tarball (extracted to `tmp/wi-510-s5/package/` by the planner; the implementer re-runs for fresh known-good copies). Each estimate counts in-package `require('./<rel>.cjs')` specifiers transitively. date-fns has no runtime npm dependencies (no `require('<bare-pkg>')` to skip), so every `require()` is an in-package edge.

### 3.1 `parseISO.cjs` (the largest subgraph)

Direct requires: `./constants.cjs`, `./constructFrom.cjs`, `./toDate.cjs`.

Transitive:
- `toDate.cjs` → `./constructFrom.cjs`.
- `constructFrom.cjs` → `./constants.cjs`.
- `constants.cjs` → leaf (no requires).

**Unique in-package module set:** `parseISO.cjs`, `toDate.cjs`, `constructFrom.cjs`, `constants.cjs` = **4 modules**.

**External stubs:** 0 (no external `require()` calls; `Date` is a runtime global, not a `require()` edge).

**Range guidance for §A assertion:** `moduleCount in [3, 6]`, `stubCount = 0`. Width allows ts-morph occasionally surfacing additional in-package nodes the static survey missed; the upper bound 6 catches a B-scope leak (date-fns has 250 root `.cjs` files plus `_lib/`, `fp/`, `locale/`, `parse/` subtrees — a leak would push toward 20+ rapidly).

### 3.2 `formatISO.cjs`

Direct requires: `./_lib/addLeadingZeros.cjs`, `./toDate.cjs`.

Transitive:
- `toDate.cjs` → `./constructFrom.cjs`.
- `constructFrom.cjs` → `./constants.cjs`.
- `constants.cjs` → leaf.
- `_lib/addLeadingZeros.cjs` → leaf (no requires; pure 6-line `padStart` wrapper).

**Unique in-package module set:** `formatISO.cjs`, `_lib/addLeadingZeros.cjs`, `toDate.cjs`, `constructFrom.cjs`, `constants.cjs` = **5 modules**.

**External stubs:** 0.

**Range guidance for §A:** `moduleCount in [4, 8]`, `stubCount = 0`. This is the **first WI-510 fixture to traverse into a package subdirectory** (`_lib/`), beyond just the package root. Adds a meaningful corroboration that `isInPackageBoundary` correctly accepts in-package subdirectory descent.

### 3.3 `addDays.cjs`

Direct requires: `./constructFrom.cjs`, `./toDate.cjs`.

Transitive:
- `toDate.cjs` → `./constructFrom.cjs` (deduped).
- `constructFrom.cjs` → `./constants.cjs`.
- `constants.cjs` → leaf.

**Unique in-package module set:** `addDays.cjs`, `toDate.cjs`, `constructFrom.cjs`, `constants.cjs` = **4 modules**.

**External stubs:** 0.

**Range guidance for §A:** `moduleCount in [3, 6]`, `stubCount = 0`.

### 3.4 `differenceInMilliseconds.cjs`

Direct requires: `./toDate.cjs`.

Transitive:
- `toDate.cjs` → `./constructFrom.cjs`.
- `constructFrom.cjs` → `./constants.cjs`.
- `constants.cjs` → leaf.

**Unique in-package module set:** `differenceInMilliseconds.cjs`, `toDate.cjs`, `constructFrom.cjs`, `constants.cjs` = **4 modules**.

**External stubs:** 0.

**Range guidance for §A:** `moduleCount in [3, 6]`, `stubCount = 0`.

### 3.5 `parseJSON.cjs` (substitute for `parse-tz-offset` per `DEC-WI510-S5-PARSE-TZ-OFFSET-RESOLUTION-001`)

Direct requires: `./toDate.cjs`.

Transitive: identical to `differenceInMilliseconds.cjs` and `addDays.cjs` shared chain.

**Unique in-package module set:** `parseJSON.cjs`, `toDate.cjs`, `constructFrom.cjs`, `constants.cjs` = **4 modules**.

**External stubs:** 0.

**Range guidance for §A:** `moduleCount in [3, 6]`, `stubCount = 0`.

### 3.6 Aggregate footprint, shared-chain redundancy, and expected wall-clock

Total module-decompositions across all five §A–§E tests: ~4 + 5 + 4 + 4 + 4 = **~21 decompositions**. Per-entry isolation means each test pays the decompose cost independently — that is the deliberate design from Slice 2 `DEC-WI510-S2-PER-ENTRY-ISOLATION-001`. The shared `toDate.cjs → constructFrom.cjs → constants.cjs` chain (3 modules) is re-decomposed per entry; that is intentional and acceptable given the modules are tiny (toDate=70 lines, constructFrom=~15 lines, constants=~30 lines).

Slice 4 (uuid+nanoid) measured ~15 decompositions cumulative inside <5 minutes (cumulative §A–§E budget). Slice 5 is ~21 decompositions across 5 entries (vs Slice 4's 4 entries), with smaller per-module bodies than uuid's TypeScript-compiled CJS. Expected per-headline wall-clock: ~3-10 seconds each in §A–§E (faster than uuid because the modules are smaller and structurally simpler).

**Per-headline test budget: <120 s per headline (the Slice 2 ceiling carried forward); typical <10 s.** **Cumulative §A–§E budget: <6 minutes.** **§F cumulative (with `DISCOVERY_EVAL_PROVIDER=local`): <10 minutes.** Any binding exceeding 120 s is a **stop-and-report** event, same as Slices 2-4.

### 3.7 Stub-count expectation — a return to `stubCount = 0`

Slice 4 introduced `stubCount > 0` via `require('crypto')` Node builtin. Slice 5 returns to `stubCount = 0` for all five headlines (verified: no external `require()` calls in any of the 5 subgraphs above). date-fns's runtime-global usages (`Date`, `Date.UTC`, `Math.abs`, `String.prototype.padStart`) are JavaScript built-ins reached via property access, not `require()` edges — the engine's `extractRequireSpecifiers` does not see them. If the §A test for any headline produces `stubCount > 0`, that is a **stop-and-report event**: it would mean either (a) the resolver is mis-categorizing an in-package edge as external (a B-scope leak in the *other* direction), or (b) a transitive require I missed in the source survey actually exists. Either way, investigate before declaring readiness.

---

## 4. Fixture shape — trimmed vendored tarball (deviation from prior precedent)

**Decision (deviation from Slice 4):** vendor a **trimmed** subset of the `date-fns-4.1.0` published tarball — only the files actually reachable or required for the engine to resolve `exports` and shave the five headline subgraphs, plus provenance metadata.

**Why a deviation.** Prior slices (`DEC-WI510-S3-FIXTURE-FULL-TARBALL-001`, `DEC-WI510-S4-FIXTURE-FULL-TARBALL-001`) committed full tarballs verbatim, with the rationale that `isInPackageBoundary` scopes traversal at zero traversal cost for unreferenced files. That rationale is still true for traversal time. But it ignores **git repo size + CI clone time + repo-wide tooling indexing cost**, which were acceptable concerns when the fixtures were small (semver=186KB, uuid=415KB, nanoid=79KB, validator=487KB; the largest was 487KB). The full `date-fns@4.1.0` tarball is **32MB** — **65x the largest existing fixture**, dominated by:

- `locale/` — 21MB (484 sub-files: every i18n locale × multiple variants).
- `fp/` — 3.4MB (every function's auto-curried wrapper).
- `parse/` — 448KB (date-format parser with class-body code that triggers issue #576).
- `docs/`, `*.d.ts`, `*.d.cts`, ESM `*.js` variants — additional weight not exercised by the shave path.

None of these are transitively referenced from any of the five Slice 5 headline subgraphs (verified §3.1-§3.5). Committing the full 32MB tarball to the repo just so `isInPackageBoundary` can skip-list it during BFS is a **bad tradeoff at this scale** — every clone, every `git status`, every workspace-wide `biome check` indexing pass would pay that cost forever. **Trimmed-vendor is the right answer here**; "full-tarball-vendor" was an answer for the 200KB-500KB regime, not the 32MB regime.

**Trimmed vendor manifest (what we keep):**

- `package.json` — required for `package.json#exports` resolution (the engine's resolver reads it for `main`/`exports` even when we pass an explicit `entryPath`, in case any in-package `require()` traverses an `exports` map; in practice the five headlines use only `./<rel>.cjs` direct requires).
- `LICENSE.md` — license carry-forward for the vendored source.
- All **5 headline `.cjs` files**: `parseISO.cjs`, `formatISO.cjs`, `addDays.cjs`, `differenceInMilliseconds.cjs`, `parseJSON.cjs`.
- All **shared transitive `.cjs` files**: `toDate.cjs`, `constructFrom.cjs`, `constants.cjs`, `_lib/addLeadingZeros.cjs`.
- `PROVENANCE.md` — authored to §4.1 template.

**Trimmed vendor size estimate: ~50-80KB** (9 small `.cjs` files + `package.json` + `LICENSE.md` + `PROVENANCE.md`). That is **smaller than every existing fixture**, fits cleanly in the existing 200KB-500KB regime, and still exercises the engine's real behavior on real date-fns source (each retained `.cjs` is the verbatim published source).

**What this trimmed vendor does NOT do** — and is honest about not doing:

- It does NOT vendor the 245 other top-level `.cjs` files (date-fns' other ~245 behaviors like `add`, `format`, `parse`, `differenceInDays`, etc.). Those are deferred to a later production-corpus initiative the master plan §5 reserves.
- It does NOT vendor `locale/`, `fp/`, `parse/`, `docs/`, ESM `*.js`, or `*.d.ts`/`*.d.cts` type files.
- It does NOT vendor `.cjs` files that are NOT in the §3 BFS-survey-derived transitive subgraph of any of the 5 headlines. If the implementer's actual BFS at runtime discovers an additional `.cjs` edge the static survey missed, the test will surface it as either an unresolvable edge (file an issue, do NOT silently vendor more) or as a B-scope leak (stop-and-report).

**Documented in `DEC-WI510-S5-FIXTURE-TRIMMED-VENDOR-001` (§8).** If a future Slice 5b expands date-fns coverage to more headlines, that slice's planner adds whichever additional `.cjs` files its new headlines transitively need (still trimmed, still small).

**Fixture acquisition path (already done in `tmp/wi-510-s5/` by the planner; the implementer re-runs for fresh known-good copies):**

- `cd tmp/wi-510-s5 && npm pack date-fns@4.1.0` → `date-fns-4.1.0.tgz` (SHA1 `64b3d83fff5aa80438f5b1a633c2e83b8a1c2d14`, integrity `sha512-Ukq0owbQXxa/U3EGtsdVBkR1w7KOQ5gIBqdH2hkvknzZPYvBxb/aa6E8L7tmjFtkwZBu3UXBbjIgPo/Ez4xaNg==`).
- Extract → `package/` directory.
- Copy the trimmed manifest (above) — explicitly: `package.json`, `LICENSE.md`, `parseISO.cjs`, `formatISO.cjs`, `addDays.cjs`, `differenceInMilliseconds.cjs`, `parseJSON.cjs`, `toDate.cjs`, `constructFrom.cjs`, `constants.cjs`, `_lib/addLeadingZeros.cjs` — into `packages/shave/src/__fixtures__/module-graph/date-fns-4.1.0/`.
- Author one `PROVENANCE.md` per §4.1 template; it MUST explicitly list every retained file AND name `DEC-WI510-S5-FIXTURE-TRIMMED-VENDOR-001` as the rationale for the deviation, AND list the explicitly-excluded directories (`locale/`, `fp/`, `parse/`, `docs/`, `_lib/*` other than `addLeadingZeros.cjs`).

The vendored tree is biome-ignored by the existing global `src/__fixtures__/module-graph/**` glob in `biome.json` (verified by Slices 1-4). The `.cjs` files are outside `tsc`'s scope.

### 4.1 `PROVENANCE.md` template

```
# Provenance — date-fns@4.1.0 fixture (TRIMMED)

- **Package:** date-fns
- **Version:** 4.1.0 (current `latest` dist-tag as of 2026-05-16)
- **Source:** npm tarball (`npm pack date-fns@4.1.0`)
- **Tarball SHA1:** 64b3d83fff5aa80438f5b1a633c2e83b8a1c2d14
- **Tarball integrity:** sha512-Ukq0owbQXxa/U3EGtsdVBkR1w7KOQ5gIBqdH2hkvknzZPYvBxb/aa6E8L7tmjFtkwZBu3UXBbjIgPo/Ez4xaNg==
- **Retrieved:** 2026-05-16
- **Vendor strategy:** TRIMMED (NOT full-tarball as Slices 3-4 used).
  Rationale: the full tarball is ~32MB (dominated by locale/=21MB, fp/=3.4MB,
  parse/=448KB) and 65x the largest existing fixture (validator-13.15.35=487KB).
  At this scale, full-tarball vendor crosses a different cost threshold (git
  repo bloat, CI clone time, repo-wide tooling indexing). Trimmed vendor
  retains only files actually traversed by the engine for the 5 Slice 5
  headline subgraphs, plus package.json and LICENSE.md. Trimmed size: ~50-80KB.
  See DEC-WI510-S5-FIXTURE-TRIMMED-VENDOR-001 for the full rationale.
- **Retained files (the entire trimmed vendor):**
  - package.json (required for any `package.json#exports` resolution the engine performs)
  - LICENSE.md (vendored-source license carry-forward)
  - PROVENANCE.md (this file)
  - parseISO.cjs (headline 1)
  - formatISO.cjs (headline 2)
  - addDays.cjs (headline 3)
  - differenceInMilliseconds.cjs (headline 4; issue-body name "differenceInMs"
    resolves to this per DEC-WI510-S5-DIFFERENCE-IN-MS-BINDING-001)
  - parseJSON.cjs (headline 5; substitute for issue-body "parse-tz-offset"
    per DEC-WI510-S5-PARSE-TZ-OFFSET-RESOLUTION-001)
  - toDate.cjs (shared transitive dep of headlines 1-5)
  - constructFrom.cjs (shared transitive dep via toDate/constants chain)
  - constants.cjs (leaf — math constants for ms-in-hour, ms-in-minute, etc.)
  - _lib/addLeadingZeros.cjs (transitive dep of formatISO only)
- **Excluded files / directories (deliberately NOT vendored):**
  - locale/ (21MB, 484 files — i18n)
  - fp/ (3.4MB — auto-curried functional-programming wrappers)
  - parse/ (448KB — general date-format parser; ALSO contains parse/_lib/Parser.cjs
    and parse/_lib/Setter.cjs which are the two class-body files in date-fns —
    not traversed by any Slice 5 headline so engine limit #576 is structurally
    not exercised)
  - docs/ (85KB — generated documentation)
  - *.d.ts, *.d.cts (TypeScript type files, outside tsc's .js scope)
  - *.js (ESM variants; the engine's resolver prefers require → import so it
    lands on .cjs files; ESM variants are not exercised in Slice 5)
  - All other 245 top-level <name>.cjs files (date-fns ships ~250 behaviors;
    only 5 are headlines for Slice 5; broader coverage deferred to a later
    production-corpus initiative)
  - _lib/*.cjs except addLeadingZeros.cjs (the other helpers are not transitive
    deps of any Slice 5 headline subgraph)
- **Shape:** Plain modern CJS. Every .cjs file opens with `"use strict";` and
  uses `var _index = require("./<rel>.cjs")` for in-package edges. NOT Babel-
  transpiled (contrast validator-13.15.35). NOT TypeScript-compiled with
  `Object.defineProperty(exports, "__esModule", ...)` (contrast uuid-11.1.1).
  Hand-aliased CJS — structurally the simplest of any landed fixture.
- **Runtime dependencies:** none (`package.json#dependencies` is empty / absent).
- **External edges from the 5 headline subgraphs:** none. All edges resolve
  in-package. Expected forest-level `stubCount = 0` for all 5 headlines.
  (Contrast Slice 4 uuid/nanoid where `require('crypto')` produced a Node-
  builtin external edge.)
- **Headline behaviors (this slice):** parseISO, formatISO, addDays,
  differenceInMilliseconds (mapping issue-body "differenceInMs" per
  DEC-WI510-S5-DIFFERENCE-IN-MS-BINDING-001), parseJSON (substitute for
  issue-body "parse-tz-offset" per DEC-WI510-S5-PARSE-TZ-OFFSET-RESOLUTION-001).
- **Why pin 4.1.0:** Current `latest` dist-tag. Dual-format `.cjs` + `.js`
  outputs via `package.json#exports` — engine's resolver picks `require` and
  lands on `.cjs`. Zero npm dependencies. No class declarations in any Slice 5
  headline subgraph (#576 risk = zero). See DEC-WI510-S5-VERSION-PIN-001.
- **WI:** WI-510 Slice 5, workflow `wi-510-s5-date-fns`.
```

---

## 5. Evaluation Contract — Slice 5 (per-entry shave of 5 date-fns headline bindings)

This is the exact, executable acceptance target. A reviewer runs every check. "Ready for Guardian" is defined at §5.6.

### 5.1 Required tests

- **`pnpm --filter @yakcc/shave test`** — the full shave suite passes, including `module-graph.test.ts` (Slice 1), `validator-headline-bindings.test.ts` (Slice 2), `semver-headline-bindings.test.ts` (Slice 3), `uuid-headline-bindings.test.ts` (Slice 4), `nanoid-headline-bindings.test.ts` (Slice 4) **with zero regressions**, plus the new per-entry date-fns headline tests.
- **`pnpm --filter @yakcc/shave build`** and **`pnpm --filter @yakcc/shave typecheck`** — clean.
- **Workspace-wide `pnpm lint` (`turbo run lint`) and `pnpm typecheck` (`turbo run typecheck`)** — clean across all packages. Carry-over from Slices 2-4; `--filter`-scoped passing is necessary but not sufficient (this is the CI parity check that has bitten prior PRs).
- **Per-entry headline tests** — ONE new test file: `packages/shave/src/universalize/date-fns-headline-bindings.test.ts` — five `describe` blocks (`parseISO`, `formatISO`, `addDays`, `differenceInMilliseconds`, `parseJSON`), each with sections A–F mirroring Slices 2-4. Plus a compound interaction test at the end (real production sequence).
- **Compound interaction test** — at least one test exercising the real production sequence `shavePackage → collectForestSlicePlans → maybePersistNovelGlueAtom` end-to-end across all 5 bindings sequentially (each binding under its own fresh `:memory:` registry to preserve per-entry isolation, mirroring the Slice 4 compound test pattern). This is the load-bearing "real-path" check.

### 5.2 Required real-path checks

- **Per-headline real-path forest:** for each of the five headlines, `shavePackage(<date-fns-fixture-root>, { registry, entryPath: <date-fns-fixture-root>/<binding>.cjs })` produces a `ModuleForest` whose `moduleCount` falls inside the §3 range for that binding:
  - `parseISO`: `moduleCount in [3, 6]`, `stubCount = 0`.
  - `formatISO`: `moduleCount in [4, 8]`, `stubCount = 0`.
  - `addDays`: `moduleCount in [3, 6]`, `stubCount = 0`.
  - `differenceInMilliseconds`: `moduleCount in [3, 6]`, `stubCount = 0`.
  - `parseJSON`: `moduleCount in [3, 6]`, `stubCount = 0`.
  - The reviewer inspects `forest.nodes` and `forestStubs(forest)` to confirm `forest.nodes[0].filePath` ends in the expected entry file AND that **no `stub` entries exist** (return to the `stubCount = 0` regime of Slices 2-3).
- **`stubCount = 0` proven across the board:** for each of the five headlines, `forest.stubCount === 0` AND `forestStubs(forest).length === 0`. This is the inverse of Slice 4's `stubCount > 0` Node-builtin assertion — Slice 5 corroborates that the engine does NOT spuriously emit stubs for pure in-package subgraphs. **§5.6 criterion 12 is the explicit Slice 5 acceptance gate for this property.**
- **`combinedScore >= 0.70`** for each of the five headline behaviors (§F), measured via `findCandidatesByQuery` against an in-memory registry populated by the engine's own real-path `storeBlock` output. Each test uses `withSemanticIntentCard` (the Slice 2 helper, carried forward verbatim) with a behaviorText that mirrors each binding's `corpus.json` query string. If `DISCOVERY_EVAL_PROVIDER=local` is absent so the quality block skips, **the slice is blocked, not ready** — reviewer must run with the local provider and paste the five scores.
- **Two-pass byte-identical determinism per headline:** for each of the five headlines, `shavePackage` is invoked twice with the same `entryPath`; `moduleCount`, `stubCount`, `forestTotalLeafCount`, BFS-ordered `filePath` list, AND the sorted set of every leaf `canonicalAstHash` are byte-identical across passes (per-headline, not aggregated).
- **Forest persisted via the real `storeBlock` path per headline:** for each headline, the slice plans from `collectForestSlicePlans` are iterated and each `NovelGlueEntry` flows through `maybePersistNovelGlueAtom`, not a `buildTriplet`-on-entry-source shortcut. Registry has `> 0` blocks after the headlines persist. (Carry-over from Slices 2-4. Per the Slice 4 lesson learned in `uuid-headline-bindings.test.ts:411-412`: some leaf-only modules may produce 0 `NovelGlueEntry` records because the slicer emits `GlueLeafEntry` for simple AST patterns; the test must `expect(persistedCount).toBeGreaterThanOrEqual(0)` for `differenceInMilliseconds` / `addDays` / `parseJSON` which are tiny single-function-body files, and `expect(persistedCount).toBeGreaterThan(0)` for `parseISO` / `formatISO` which contain multiple function bodies and `const patterns = {...}` complex literals.)
- **Subdirectory traversal proven:** the `formatISO` shave's BFS reaches `_lib/addLeadingZeros.cjs` — a real-world corroboration that `isInPackageBoundary` correctly accepts in-package subdirectory descent. This is the first WI-510 fixture to traverse into a package subdirectory; reviewer confirms `forestModules(formatISO_forest).some(m => m.filePath.includes("_lib/addLeadingZeros.cjs"))` is true.

### 5.3 Required authority invariants

- **The engine is used, not forked.** Slice 5 calls the landed `shavePackage` / `collectForestSlicePlans` / `module-resolver` exports verbatim. **No engine-source change in `packages/shave/src/universalize/**` (`recursion.ts`, `slicer.ts`, `module-resolver.ts`, `module-graph.ts`, `types.ts`, `stef.ts`, `variance-rank.ts`, `atom-test.ts`).** No new public API surface in `packages/shave/src/types.ts`.
- **B-scope predicate untouched and re-corroborated on a return-to-zero-external case.** `isInPackageBoundary` is unchanged. date-fns has no runtime npm deps and the 5 headline subgraphs reach no Node builtins — so every `require()` resolves in-package and `stubCount = 0` everywhere. This is the inverse corroboration of Slice 4's Node-builtin case: the predicate must correctly NOT emit foreign leaves when all edges are in-package.
- **One persist authority.** The forest → registry path uses the existing `maybePersistNovelGlueAtom` / `buildTriplet` / idempotent `storeBlock` primitives.
- **Public `types.ts` surface frozen-for-L5.** No public-surface change.
- **`corpus.json` is append-only.** Slice 5 appends FIVE new `synthetic-tasks` entries (IDs in §5.4). No existing entry modified, no category list edit, no `discovery-eval-full-corpus.test.ts` harness change.
- **Fixture isolation.** The vendored sources live ONLY under `packages/shave/src/__fixtures__/module-graph/date-fns-4.1.0/`. Biome-ignored, outside `tsc`'s `.js` scope.
- **Per-entry isolation guarantee.** Each of the five headline bindings is shaved by its own `shavePackage` call with its own `entryPath`. No shared `beforeAll` across bindings.
- **Predecessor fixtures untouched.** `uuid-11.1.1/`, `nanoid-3.3.12/`, `semver-7.8.0/`, `validator-13.15.35/`, `ms-2.1.3/`, `circular-pkg/`, `degradation-pkg/`, `three-module-pkg/` are read-only for Slice 5. Reviewer can spot-check with `git diff main -- packages/shave/src/__fixtures__/module-graph/{uuid-11.1.1,nanoid-3.3.12,semver-7.8.0,validator-13.15.35,ms-2.1.3,circular-pkg,degradation-pkg,three-module-pkg}/` showing no changes.
- **`vitest.config.ts` unchanged.** `testTimeout=30_000`, `hookTimeout=30_000`. The Slice 2 invariant `DEC-WI510-S2-NO-TIMEOUT-RAISE-001` carries forward.

### 5.4 Required integration points

- `packages/shave/src/__fixtures__/module-graph/date-fns-4.1.0/**` — vendored TRIMMED date-fns fixture (11 files: 9 `.cjs` + `package.json` + `LICENSE.md`) + `PROVENANCE.md`. Required.
- `packages/shave/src/universalize/date-fns-headline-bindings.test.ts` — new Slice 5 test file (five headline `describe` blocks + section F quality gates + compound interaction test). Required.
- `packages/registry/test/discovery-benchmark/corpus.json` — append FIVE `synthetic-tasks` entries:
  - `cat1-date-fns-parseISO-001` — query: `"Parse an ISO-8601 date-time string into a JavaScript Date object including the optional fractional seconds and timezone offset"`
  - `cat1-date-fns-formatISO-001` — query: `"Format a JavaScript Date object as an ISO-8601 string with optional date-only or time-only representation"`
  - `cat1-date-fns-addDays-001` — query: `"Return a new Date that is the given number of days after the input Date preserving the time-of-day components"`
  - `cat1-date-fns-differenceInMs-001` — query: `"Compute the difference in milliseconds between two Date objects as a signed integer"`
  - `cat1-date-fns-parseJSON-001` — query: `"Parse an ISO-8601 date string with optional timezone offset suffix as produced by JSON.stringify(new Date()) into a Date object"` *(this is the substitute for `parse-tz-offset` per `DEC-WI510-S5-PARSE-TZ-OFFSET-RESOLUTION-001`; the corpus query is honest about what `parseJSON` actually does)*
  Append-only. Required.
- `plans/wi-510-s5-date-fns.md` — this plan. Owner.
- `plans/wi-510-shadow-npm-corpus.md` — one-paragraph status update only (mark Slice 5 as in-progress / landed). No permanent-section edits. Allowed.
- `tmp/wi-510-s5/**` — planner scratch (tarball + extracted `package/` tree). Implementer may use the same directory for re-acquisition; not part of the commit.

### 5.5 Forbidden shortcuts

- **No whole-package shave.** Calling `shavePackage(<date-fns-fixture-root>, { registry })` without an `entryPath` override is **forbidden** in Slice 5 — same as Slices 2-4. Every `shavePackage` invocation in the new tests must pass an explicit `entryPath` pointing at one of the five headline files. *(Additionally: a whole-package shave on date-fns would attempt to resolve `package.json#main` which points at `index.cjs`, and `index.cjs` re-exports ALL ~250 behaviors — the Slice 2 abandoned-approach failure mode at multiplied scale.)*
- **No `vitest.config.ts` timeout raise.** Per-`it()` overrides bounded to 120 s with measurement-citing comments. >120 s = stop-and-report (same as Slices 2-4).
- **No shared `beforeAll` across the five bindings** (per-entry isolation).
- **No engine-source change in `packages/shave/src/universalize/**`.** Engine is frozen after Slice 1. If an engine gap surfaces, it is filed as a separate bug against the engine and is **not** patched in-slice. Slice 5 stops and reports.
- **No single-source-`buildTriplet` shortcut for the persist check.** §5.2's `combinedScore` and the §5.1 per-headline persist check must run through the real `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path.
- **No hand-authored `date-fns` atoms.** The five headline atoms are the engine's output from vendored source.
- **No `discovery-eval-full-corpus.test.ts` / registry-schema edit.** Constitutional; Slice 5 only appends `synthetic-tasks` rows.
- **No silent `maxModules` truncation.** Each per-entry shave's expected `moduleCount` is tiny (§3, max 5 for formatISO). If any headline test sees `moduleCount` approaching `maxModules` (default 500), that indicates a B-scope leak or trimmed-vendor over-pruning that left a needed file dangling. Implementer stops and reports. Do not raise `maxModules` to hide the symptom.
- **No expanding the trimmed-vendor manifest at runtime to "fix" a test failure.** If a test surfaces a missing transitive `.cjs` file that the §3 BFS-survey missed, that is a stop-and-report event: pause, identify the missing file, document it, AND amend the plan + `PROVENANCE.md` deliberately — do NOT silently add files to the vendor and re-run until the test passes. The trimmed vendor is a deliberate, auditable manifest, not a "minimum subset that happens to work."
- **No non-determinism.** Each per-headline subgraph must be two-pass byte-identical.
- **No public `types.ts` surface break.**
- **No reach into predecessor fixtures.** `validator-13.15.35/`, `semver-7.8.0/`, `uuid-11.1.1/`, `nanoid-3.3.12/`, `ms-2.1.3/`, `circular-pkg/`, `degradation-pkg/`, `three-module-pkg/` are read-only for Slice 5.
- **No new fixture vendoring beyond `date-fns-4.1.0`.** Slice 6 (jsonwebtoken + bcrypt) and Slices 7-9 (lodash, zod/joi, p-limit + p-throttle) remain out of scope.
- **No ESM-vendored date-fns variant.** date-fns@4 ships both ESM and CJS; Slice 5 vendors only the `.cjs` files for the trimmed manifest. An ESM-vendored variant is a deferred concern.
- **No `void (async () => {...})()` patterns in test files.** Per the Slice 3 lesson learned from PR #566: the shave engine cannot atomize `VoidExpression` of an IIFE. Test orchestration must use plain `await`-in-`async`-`it()`. If a `queueMicrotask`-style alternative is needed for test orchestration, prefer it over an IIFE.
- **No skipping `biome format --write` before commit.** Per the Slice 3 lesson learned from PR #570: local turbo cache can hide format violations that CI catches. Run `pnpm biome format --write packages/shave/src/universalize/date-fns-headline-bindings.test.ts` (and any other touched files) before staging.
- **No `Closes #510` in the commit/PR body.** This is Slice 5 of 9 — `#510` is the umbrella issue and is NOT closed by this slice. Use `Refs #510 (Slice 5 of 9)` only.
- **No asserting the planner's §3 size estimates as exact equalities.** Per the Slice 3 lesson learned from PR #571: the engine's actual `moduleCount`/`stubCount` may differ from the planner's static-survey estimate (e.g. if the engine de-dups differently, if a transitive edge resolves to an unexpected variant). Assert the §5.2 ranges (e.g. `moduleCount in [3, 6]`), not exact-equality, and record the actual observed values in the PR body so the reviewer can confirm they fall inside the range.

### 5.6 Ready-for-Guardian definition (Slice 5)

Slice 5 is ready for Guardian when **all** of the following are simultaneously true on the current HEAD:

1. `pnpm --filter @yakcc/shave build && pnpm --filter @yakcc/shave typecheck && pnpm --filter @yakcc/shave test` all green, with **zero regressions** in `module-graph.test.ts`, `validator-headline-bindings.test.ts`, `semver-headline-bindings.test.ts`, `uuid-headline-bindings.test.ts`, `nanoid-headline-bindings.test.ts`, and the rest of the existing shave suite.
2. **Workspace-wide** `pnpm lint` (`turbo run lint`) and `pnpm typecheck` (`turbo run typecheck`) are clean across all packages — reviewer pastes the output. Package-scoped passing is necessary but not sufficient.
3. **Per-headline measurement evidence in the PR body and the plan status update**: for each of the five bindings (`parseISO`, `formatISO`, `addDays`, `differenceInMilliseconds`, `parseJSON`), the implementer records the engine's *actual* `moduleCount`, `stubCount`, `forestTotalLeafCount`, the BFS-ordered `filePath` list (so the reviewer can verify the subgraph contains only transitively-reachable modules), the **merkle root of the headline binding's atom** (the entry-module's persisted atom root), and the wall-clock time of that headline's `shavePackage` invocation. The §3 estimates are the reviewer's anchor for "does this look right?" — but the test asserts the §5.2 ranges, not exact equalities.
4. Each of the five headline bindings produces a connected `ModuleForest` whose nodes are exactly the headline's transitive in-package subgraph — reviewer confirms via §3 inspection that no unrelated date-fns behavior modules are present (no `format.cjs`, no `parse.cjs` general parser, no `differenceInDays.cjs` or any other unrelated `*.cjs`, no `locale/` files, no `fp/` files).
5. **Each per-headline test completes in <120 seconds wall-clock** with the default vitest config (no `testTimeout`/`hookTimeout` raise). A test exceeding 120 s is a blocking flag, not a passing condition. Cumulative §A–§E wall-clock <6 minutes; cumulative including §F (with `DISCOVERY_EVAL_PROVIDER=local`) <10 minutes. Slice 5's subgraphs are the smallest of any landed slice, so a >120 s headline is a loud red flag.
6. Two-pass byte-identical determinism per headline.
7. `combinedScore >= 0.70` for **each** of the five headline behaviors, measured via `findCandidatesByQuery` against a registry populated by the engine's own real-path `storeBlock` output — quality block(s) **ran (not skipped)**, reviewer pastes the five per-behavior scores. If `DISCOVERY_EVAL_PROVIDER=local` is absent so the quality block skips, the slice is **blocked, not ready**.
8. Each headline's forest is persisted via the **real** `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path — not the single-source-`buildTriplet` shortcut. The §E test for `parseISO` and `formatISO` asserts `persistedCount > 0`; the §E tests for `addDays`, `differenceInMilliseconds`, `parseJSON` (tiny single-function-body files) assert `persistedCount >= 0` per the Slice 4 lesson.
9. `corpus.json` carries exactly the five appended `synthetic-tasks` entries (`expectedAtom: null`), no existing entry modified, and `discovery-eval-full-corpus.test.ts` still passes.
10. `packages/shave/vitest.config.ts` is unchanged.
11. **Predecessor fixtures untouched.** Reviewer spot-checks `git diff main -- packages/shave/src/__fixtures__/module-graph/{uuid-11.1.1,nanoid-3.3.12,semver-7.8.0,validator-13.15.35,ms-2.1.3,circular-pkg,degradation-pkg,three-module-pkg}/` shows no changes.
12. **`stubCount = 0` proven for all 5 headlines.** Reviewer confirms `forest.stubCount === 0` AND `forestStubs(forest).length === 0` for every headline test in §A. This is the inverse-of-Slice-4 corroboration: the engine does NOT spuriously emit stubs for pure in-package subgraphs with no Node-builtin reach.
13. **Subdirectory traversal proven for `formatISO`.** Reviewer confirms `forestModules(formatISO_forest).some(m => m.filePath.includes("_lib/addLeadingZeros.cjs"))` is true — the engine's B-scope predicate correctly accepts in-package subdirectory descent.
14. **Trimmed-vendor manifest matches `PROVENANCE.md`.** Reviewer runs `ls packages/shave/src/__fixtures__/module-graph/date-fns-4.1.0/` (recursively) and confirms the file list matches the §4 / `PROVENANCE.md` retained-files manifest **exactly** — no extra files silently added, no manifest-listed file missing. Vendored fixture size is in the 50-150KB range (consistent with the §4 estimate; well below the prior fixture max of 487KB).
15. New `@decision` annotations are present at the Slice 5 modification points (the test file; the `PROVENANCE.md` cites the DEC IDs in §8). New DEC IDs per §8.

---

## 6. Scope Manifest — Slice 5 (per-entry shave of 5 date-fns headline bindings)

**Allowed paths (implementer may touch):**
- `packages/shave/src/__fixtures__/module-graph/date-fns-4.1.0/**` — trimmed vendored date-fns fixture + `PROVENANCE.md`. Acquisition + extraction + selective copy per §4 manifest.
- `packages/shave/src/universalize/date-fns-headline-bindings.test.ts` — new Slice 5 test file (five `describe` blocks + section F quality gates + compound test).
- `packages/registry/test/discovery-benchmark/corpus.json` — append five `synthetic-tasks` headline query entries. Append-only.
- `plans/wi-510-s5-date-fns.md` — this plan. Owner.
- `plans/wi-510-shadow-npm-corpus.md` — one-paragraph status update only. No permanent-section edits.
- `tmp/wi-510-s5/**` — scratch (tarball + extracted `package/`); not committed.

**Required paths (implementer MUST modify):**
- `packages/shave/src/__fixtures__/module-graph/date-fns-4.1.0/**` — the trimmed vendored fixture tree (11 files per §4) + `PROVENANCE.md`.
- `packages/shave/src/universalize/date-fns-headline-bindings.test.ts` — the new test file.
- `packages/registry/test/discovery-benchmark/corpus.json` — the five `synthetic-tasks` query entries.

**Forbidden touch points (must not change without re-approval):**
- `MASTER_PLAN.md` — permanent sections untouched.
- `packages/shave/vitest.config.ts` — `testTimeout=30_000` / `hookTimeout=30_000` defaults carry forward `DEC-WI510-S2-NO-TIMEOUT-RAISE-001`.
- `packages/shave/src/universalize/recursion.ts`, `slicer.ts`, `module-resolver.ts`, `module-graph.ts`, `types.ts`, `stef.ts`, `variance-rank.ts`, `atom-test.ts` — the entire engine surface. Frozen after Slice 1.
- `packages/shave/src/universalize/validator-headline-bindings.test.ts` — Slice 2's test file.
- `packages/shave/src/universalize/semver-headline-bindings.test.ts` — Slice 3's test file.
- `packages/shave/src/universalize/uuid-headline-bindings.test.ts` — Slice 4's test file.
- `packages/shave/src/universalize/nanoid-headline-bindings.test.ts` — Slice 4's test file (the nanoid sibling).
- `packages/shave/src/universalize/module-graph.test.ts` — Slice 1's engine tests.
- `packages/shave/src/__fixtures__/module-graph/uuid-11.1.1/**`, `nanoid-3.3.12/**`, `semver-7.8.0/**`, `validator-13.15.35/**`, `ms-2.1.3/**`, `circular-pkg/**`, `degradation-pkg/**`, `three-module-pkg/**` — Slices 1-4 fixtures.
- `packages/shave/src/types.ts` — frozen-for-L5 public surface.
- `packages/shave/src/persist/**`, `cache/**`, `intent/**` — used by the test; not modified.
- `packages/ir/**`, `packages/contracts/**` — constitutional.
- `packages/registry/src/schema.ts`, `packages/registry/src/storage.ts`, `packages/registry/src/discovery-eval-helpers.ts`, `packages/registry/src/discovery-eval-full-corpus.test.ts` — constitutional registry surface and discovery-eval harness.
- `packages/seeds/src/blocks/**` and all existing seed atoms — Slice 5 produces atoms via the engine; hand-authors nothing.
- All other `packages/{contracts,registry,hooks-base,cli,compile,seeds,ir,variance,federation,types,hooks-*}/src/**` — adjacent lanes outside Slice 5's scope.
- `biome.json` — already covers `__fixtures__/module-graph/**`; no change needed.
- All other `plans/*.md` files — Slice 5 owns only `plans/wi-510-s5-date-fns.md` and the one-paragraph status update on `plans/wi-510-shadow-npm-corpus.md`. **Explicitly excluded: `plans/wi-510-s6-*.md`** (the parallel Slice 6 plan).
- `examples/**`, `bench/**`, `.worktrees/**` — adjacent lanes (#508, #512, benches) outside Slice 5's scope.

**Expected state authorities touched:**
- **Shave module-graph engine** — canonical authority: `shavePackage()` / `collectForestSlicePlans()` in `module-graph.ts`, `decompose()` in `recursion.ts`, `slice()` in `slicer.ts`. Slice 5 **calls** with explicit `entryPath` per headline; does not fork, modify, or extend.
- **Module resolver — B-scope predicate** — canonical authority: `isInPackageBoundary()` and `resolveSpecifier()` in `module-resolver.ts`. Slice 5 **exercises** the predicate on a return-to-zero-external case (no Node builtins, no external npm deps; every edge is in-package). Inverse corroboration of Slice 4's Node-builtin case. Predicate not modified.
- **Atom identity + registry block store** — canonical authority: `blockMerkleRoot()` (`@yakcc/contracts`) and idempotent `storeBlock()` (`@yakcc/registry`), reached via `maybePersistNovelGlueAtom` / `buildTriplet`. Slice 5 produces five headline-atom-rooted subgraphs.
- **Discovery-eval query corpus** — canonical authority: `packages/registry/test/discovery-benchmark/corpus.json`. Slice 5 appends five `synthetic-tasks` entries.
- **Vitest test-execution discipline** — canonical authority: `packages/shave/vitest.config.ts`. Slice 5 does not modify; per-entry shave size is tiny (§3 max 5 modules) so default `testTimeout=30_000` is more than sufficient.
- **Fixture directory** — canonical authority: `packages/shave/src/__fixtures__/module-graph/`. Slice 5 adds one sibling directory `date-fns-4.1.0/` next to the existing eight.

---

## 7. Slicing / dependency position

Slice 5 is a single work item. Dependencies: **Slices 1-4** are all landed on `main` and provide the engine + structural test pattern. Slice 5 imports no Slice 2-4 source, but its test file is a structural sibling-by-copy of `uuid-headline-bindings.test.ts`.

Downstream consumers: none currently named. The shadow-npm corpus expansion (#510) listing date-fns as Slice 5 is the proximate consumer.

- **Weight:** **M** (one larger trimmed-vendored fixture + five small per-entry shaves + section F quality gates + measurement-evidence discipline + first deviation-from-precedent on vendoring strategy + first subdirectory-traversal corroboration). Slightly heavier than Slice 4 in test count (5 bindings vs 4 effective) but lighter per binding (4-5 modules vs 2-6 modules per binding for Slice 4) and zero external-edge complexity.
- **Gate:** **`review`** (no engine source change; no public-surface change; no constitutional file touched). The trimmed-vendor deviation is a fixture-vendoring strategy change, not a constitutional change; it is documented in §4 and `DEC-WI510-S5-FIXTURE-TRIMMED-VENDOR-001` and is reviewer-verifiable (§5.6 criterion 14).
- **Landing policy:** default grant — branch checkpoint allowed, reviewer handoff allowed, autoland allowed once `ready_for_guardian`, `no_ff` merge.

---

## 8. Decision Log Entries (new — to be recorded at implementation)

| DEC-ID | Title | Rationale summary |
|--------|-------|-------------------|
| `DEC-WI510-S5-PER-ENTRY-SHAVE-001` | Slice 5 shaves five date-fns headline bindings per-entry, not the whole package | Inherits the structural pattern from Slices 2-4. Each of the five bindings is its own `shavePackage({ entryPath })` call producing a 4-5-module subgraph (§3 estimates). The five headlines are the bindings #510's issue body names for date-fns; broader coverage (~245 other top-level behaviors, `locale/`, `fp/`, `parse/`) is deferred to a later production-corpus initiative. A whole-package shave on date-fns would attempt to start at `index.cjs` which re-exports ~250 behaviors — the Slice 2 abandoned-approach failure mode at multiplied scale. |
| `DEC-WI510-S5-DIFFERENCE-IN-MS-BINDING-001` | Issue-body "differenceInMs" resolves to `differenceInMilliseconds.cjs` | date-fns exports the full name `differenceInMilliseconds`, not the abbreviation `differenceInMs`. The issue-body uses the conversational short form; the file and exported function are `differenceInMilliseconds`. Single small file (29 lines, one `require("./toDate.cjs")`), single export — no ambiguity. |
| `DEC-WI510-S5-PARSE-TZ-OFFSET-RESOLUTION-001` | Issue-body "parse-tz-offset" resolves to substitute `parseJSON.cjs`; real tz-string parsing is deferred to a future `date-fns-tz` slice | date-fns@4.1.0 ships no top-level `parseTzOffset.cjs` or `parseTimezone.cjs` entry. Verified by exhaustive search: zero files matching `parse*tz*`, `parse*Timezone*`, `*Tz*Offset*`, `parse*Offset*` exist at the public entry surface. The only "parse-tz" entity in date-fns@4 is a file-local helper inside `parseISO.cjs` (not separately addressable). `_lib/getTimezoneOffsetInMilliseconds.cjs` exists but is a private helper that reads `Date.prototype.getTimezoneOffset()` (system tz), NOT parses a tz string. `parseJSON` is chosen as the substitute because it IS the canonical "parse a date string WITH a trailing timezone-offset suffix into a Date" public entry — it accepts `+00:00`, `+0000`, `+05:45` tz suffixes (per its source-doc), is a public binding in `package.json#exports`, and produces a tiny 4-module subgraph. Corpus query phrases the headline honestly as "parseJSON" semantics. A separate follow-on issue should file a `date-fns-tz` slice for the strict tz-string-parsing public bindings (`parseFromTimeZone`, `getTimezoneOffset(timezone, date)`) when the corpus needs them. |
| `DEC-WI510-S5-VERSION-PIN-001` | Pin to `date-fns@4.1.0` (current `latest`; dual-format ESM+CJS via package.json exports) | `4.1.0` is the current `latest` dist-tag (2026-05-16). Despite `"type": "module"`, date-fns@4 ships dual-format `.cjs` + `.js` via `exports[<entry>].require.default` — the engine's resolver picks `require` over `import` (proven Slices 2-4) and lands on `.cjs` naturally. By passing `entryPath` directly we bypass `exports` resolution. Zero npm dependencies. Zero class declarations in any Slice 5 headline transitive subgraph (engine limit #576 structurally not exercised). Source shape is plain modern CJS — structurally the simplest of any landed/planned fixture. |
| `DEC-WI510-S5-FIXTURE-TRIMMED-VENDOR-001` | Vendor a trimmed subset of date-fns-4.1.0 (the 5 headlines + transitive deps + package.json + LICENSE), NOT the full 32MB tarball — deviation from `DEC-WI510-S3-FIXTURE-FULL-TARBALL-001` and `DEC-WI510-S4-FIXTURE-FULL-TARBALL-001` | Prior slices (semver 186KB, uuid 415KB, nanoid 79KB, validator 487KB) vendored the full tarball with the rationale that `isInPackageBoundary` scopes traversal at zero cost. That rationale is still true for traversal time, but ignores git repo size + CI clone time + repo-wide tooling indexing cost — acceptable at 200-500KB, not at 32MB. The date-fns@4.1.0 tarball is 32MB (locale/=21MB, fp/=3.4MB, parse/=448KB, docs/=85KB, type files=multi-MB), 65x the largest existing fixture. None of those subtrees are transitively reachable from any Slice 5 headline subgraph (verified §3.1-§3.5). Trimmed vendor retains: package.json (for any `exports` resolution); LICENSE.md (vendored-source license); 5 headline `.cjs` files; 4 shared transitive `.cjs` files (`toDate`, `constructFrom`, `constants`, `_lib/addLeadingZeros`); PROVENANCE.md. Total ~50-80KB. The vendored manifest is auditable and explicitly listed in `PROVENANCE.md`. §5.6 criterion 14 makes the reviewer verify the on-disk file list matches the manifest exactly. A future Slice 5b that adds more headlines amends the manifest deliberately. |
| `DEC-WI510-S5-RETURN-TO-ZERO-EXTERNAL-001` | All 5 date-fns headline subgraphs produce `stubCount = 0` — inverse corroboration of Slice 4's Node-builtin case | Slice 4 was the first slice to exercise `require('crypto')` Node-builtin foreign-leaf emission (`stubCount > 0` on v4/v7/nanoid). Slice 5 returns to the `stubCount = 0` regime: date-fns has no runtime npm deps AND the 5 headline subgraphs reach no Node builtins via `require()`. Date/Math/String built-ins are property-access globals, not `require()` edges. §5.6 criterion 12 makes the reviewer confirm `forest.stubCount === 0` AND `forestStubs(forest).length === 0` for every headline test — the inverse-of-Slice-4 acceptance gate. If `stubCount > 0` is observed, that is a stop-and-report event (either B-scope leak in the wrong direction, or a transitive require I missed in static survey). |
| `DEC-WI510-S5-SUBDIRECTORY-TRAVERSAL-001` | The `formatISO` shave traverses `<package-root>/_lib/addLeadingZeros.cjs` — first real-world subdirectory descent corroboration | Slices 2-4 fixtures all had transitive deps at the package root. `formatISO`'s subgraph is the first WI-510 fixture to exercise BFS descent into a package subdirectory (`_lib/`). The B-scope predicate (`isInPackageBoundary`) must correctly accept the subdirectory edge — which is the predicate's most natural behavior (compare `dirname(<edge>)` against `packageRoot` allowing nesting). §5.6 criterion 13 makes the reviewer confirm `_lib/addLeadingZeros.cjs` appears in the `formatISO` forest. If the engine drops the subdirectory edge, that is a B-scope predicate bug filed as a Slice 1 engine issue, not patched in-slice. |

These DECs are recorded in `@decision` annotation blocks at the Slice 5 modification points (the new test file primarily; the `PROVENANCE.md` cites the DEC IDs). If the operator wants them in the project-level log, they are appended to `MASTER_PLAN.md` `## Decision Log` as a separate doc-only change — not part of this slice.

---

## 9. Risks

| Risk | Mitigation |
|------|-----------|
| The trimmed vendor omits a `.cjs` file the engine actually needs at BFS time → `shavePackage` surfaces an unresolvable edge → headline test fails with a missing-transitive-dep error. | The §3 BFS-survey was read directly from source via grep on `require("...")` patterns for every transitive dep. The survey is conservative (over-counts shared chain). §5.5 explicitly forbids silent vendor-expansion to "make the test pass" — a missing file is a stop-and-report event: pause, identify, amend the plan + `PROVENANCE.md` deliberately. §5.6 criterion 14 makes the reviewer verify the on-disk file list matches the documented manifest. If the engine surfaces a missing file the planner did not anticipate, that is a Slice 5 planner gap (file a follow-up plan amendment), NOT a "silently add files" event. |
| The trimmed vendor is too aggressive and biome / typecheck / discovery hooks expect to find more files in the fixture tree. | Biome ignores `src/__fixtures__/module-graph/**` (existing global glob, verified across Slices 1-4). `tsc` does not set `allowJs`/`checkJs` so `.cjs` files are outside its scope. Discovery hooks read from the production registry, not from fixture trees. The trimmed vendor is mechanically isolated from every tool except the shave engine itself. If a tool unexpectedly reads the fixture tree, that is a tool-config bug filed separately, not a Slice 5 vendor expansion. |
| The engine's resolver tries to follow `package.json#exports` ahead of the explicit `entryPath` and lands on `index.js` (ESM) rather than `index.cjs` (CJS) for some implicit fallback. | Verified in `module-resolver.ts:resolveExportValue` (per the Slice 4 plan §1.2 read): the resolver's precedence is `node → require → import → default`. With dual-format date-fns, `require` wins and the `.cjs` is selected. By passing `entryPath` directly we bypass the entire `exports` resolution code path for the entry module; only transitive requires within the fixture rely on `exports` resolution, and every transitive require in the 5 headline subgraphs is a literal `./<rel>.cjs` string (verified §3) — no `exports`-map traversal needed for transitive deps either. |
| The substitute `parseJSON` headline (§1.2 / `DEC-WI510-S5-PARSE-TZ-OFFSET-RESOLUTION-001`) under-scores on `combinedScore` because its embedding semantics don't align with "parse-tz-offset"-style queries. | The corpus query (§5.4) is honest about what `parseJSON` actually does: "Parse an ISO-8601 date string with optional timezone offset suffix...". The query and the `withSemanticIntentCard` `behaviorText` describe the actual function behavior, not the issue-body's `parse-tz-offset` label. If under-scoring still occurs, extend `semanticHints` (which map to `IntentCard.preconditions`) with domain-specific keywords ("ISO-8601 date parser", "JSON date string deserialize", "timezone offset suffix"). Reviewer escalates only if even with semantic hints the score stays <0.70 — that is a genuine quality finding, not a Slice 5 design failure. |
| date-fns@4's compiled CJS uses some pattern the engine has not previously seen (e.g. `var _index = require(...)` aliased-import pattern was OK in Slice 4 uuid, but date-fns might mix in something novel). | Verified in §1.3: date-fns@4 source shape is plain modern CJS — structurally SIMPLER than validator (Babel) and uuid (tsc). Every `.cjs` file opens with `"use strict";`, every require is `var _index = require("./<rel>.cjs");`, every export is `exports.<name> = <name>;`. This is the same shape semver used (which produced `stubCount=1` for satisfies in PR #571 due to engine limit #576, NOT due to source-shape novelty). Slice 5's headline subgraphs contain ZERO class declarations (verified §1.3), so #576 does not apply. If a novel pattern surfaces, it is a Slice 1 engine gap (file a bug) — Slice 5 stops and reports. |
| The `_lib/addLeadingZeros.cjs` subdirectory traversal in `formatISO` fails because the engine's `isInPackageBoundary` rejects the subdirectory edge. | The B-scope predicate is `dirname(resolved)`/`relative()` style; nesting is its natural behavior (validator-13.15.35 in Slice 2 had multi-level nesting under `lib/util/`, `lib/util/algorithms/`, etc., and the engine handled them). If `_lib/addLeadingZeros.cjs` is rejected, that is a Slice 1 engine bug — file separately, do NOT patch in Slice 5. §5.6 criterion 13 makes this an explicit acceptance gate. |
| The five `corpus.json` entries fail the `discovery-eval-full-corpus.test.ts` per-category invariants. | `cat1` currently has 23 entries (10 original + 4 validator + 4 semver + 4 uuid + 1 nanoid, verified 2026-05-16). Appending 5 more puts cat1 at 28 entries; the ≥8 invariant is comfortably satisfied. All five new entries have `expectedAtom: null` (`synthetic-tasks`) — they are neither positive nor negative for the balance check (consistent with Slices 2-4). |
| Slice 6 (jsonwebtoken + bcrypt) lands first and changes the cat1 entry count, causing my five-entry append to drift. | corpus.json appends are by-ID; Slice 5's IDs (`cat1-date-fns-*`) and Slice 6's IDs (whatever they pick) are disjoint. JSON merge conflicts on the same file are possible if both PRs land within the same git push window — Guardian's standard merge-conflict path handles this; if conflict arises the second-to-merge re-bases and re-appends its rows. No coordination needed beyond disjoint IDs. |
| The implementer reaches for `void (async () => {...})()` IIFE pattern in test orchestration and hits the VoidExpression atomization gap from PR #566. | §5.5 forbids `void (async () => {...})()` patterns explicitly. All test orchestration uses plain `await`-in-`async`-`it()`. If parallelism is needed for the compound test, use `queueMicrotask` per the orchestrator's pre-amble. |
| Implementer skips `biome format --write` before committing → local turbo cache hides format violations → CI fails on the PR. | §5.5 explicitly requires `pnpm biome format --write` on the new test file before staging. Per Slices 3 / 4 lesson learned (PRs #570, #573 had this exact failure mode). |
| Implementer asserts the planner's §3 size estimates as exact equalities and the engine surfaces slightly different `moduleCount`/`stubCount` due to dedup behavior. | §5.5 forbids exact-equality assertions on engine output. Tests use the §5.2 ranges (e.g. `moduleCount in [3, 6]`), not exact values. Per Slice 3 lesson learned (PR #571 had this exact failure mode for semver `satisfies`). Implementer records actual observed values in the PR body. |

---

## 10. What This Plan Does NOT Cover (Non-Goals)

- **The other ~245 date-fns top-level behaviors** (`add`, `addBusinessDays`, `format`, `parse`, `differenceInDays`, `differenceInHours`, ..., the entire `differenceIn*` / `format*` / `parse*` family beyond the 5 headlines). Deferred.
- **`locale/`, `fp/`, `parse/`, `docs/` subtrees of date-fns.** Out of scope; explicitly excluded from the trimmed vendor manifest.
- **A real `parse-tz-offset` binding from `date-fns-tz`.** That is a sibling npm package and a separate slice; Slice 5 substitutes `parseJSON` per `DEC-WI510-S5-PARSE-TZ-OFFSET-RESOLUTION-001`.
- **An ESM-vendored date-fns variant.** date-fns@4 ships both; Slice 5 vendors only the `.cjs` files. ESM-vendored fixtures are a deliberately deferred concern (consistent with `DEC-WI510-S4-UUID-VERSION-PIN-001` and `DEC-WI510-S4-NANOID-VERSION-PIN-001` rationale).
- **The general date-format `parse()` function.** That lives in `parse.cjs` + `parse/_lib/Parser.cjs` + `parse/_lib/Setter.cjs` and contains class-body code that hits engine limit #576. Out of Slice 5 scope by `parse-tz-offset → parseJSON` substitution; would require an engine fix (#576) before being slicable as a headline.
- **A whole-package shave path.** Forbidden — §5.5.
- **Any engine-source change in `packages/shave/src/universalize/**`.** Engine frozen after Slice 1.
- **Slices 6-9 graduated fixtures** (jsonwebtoken + bcrypt, lodash, zod/joi, p-limit + p-throttle). Out of scope. Slice 6 is being planned in parallel in a separate worktree (`feature/wi-510-s6-...`); Slice 5 does NOT touch that plan.
- **`vitest.config.ts` adjustments.** Forbidden touch point.
- **`MASTER_PLAN.md` initiative registration.** Doc-only slice the orchestrator dispatches separately if/when the user wants it.
- **The import-intercept hook (`#508`).** Separate WI; Slice 5 produces the five headline-binding atoms in the corpus, `#508` Slice 2 already shipped with validator as the demo binding.
- **The B10 bench (`#512`).** Separate WI; date-fns atoms are corpus completeness, not the demo path.
- **A retroactive trimming of prior slices' full-tarball fixtures.** `DEC-WI510-S5-FIXTURE-TRIMMED-VENDOR-001` is a Slice-5-forward decision; prior fixtures (semver=186KB, uuid=415KB, nanoid=79KB, validator=487KB) stay at full-tarball because their absolute sizes do not cross the cost threshold that justifies the deviation. If a future operator-decision wants to retroactively trim them, that is a separate cleanup initiative, NOT part of Slice 5.

---

*End of Slice 5 plan — per-entry shave of `parseISO`, `formatISO`, `addDays`, `differenceInMilliseconds`, `parseJSON` (the five `date-fns@4.1.0` headline bindings per #510 Slice 5 of 9).*
