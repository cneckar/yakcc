# PROVENANCE — jsonpointer@5.0.1 fixture (WI-510 Slice 14 / #642 S14)

## Tarball

| Field | Value |
|---|---|
| Package | `jsonpointer@5.0.1` |
| Author | Jan Lehnardt (`janl`) + Marc Bachmann (contributor) |
| Registry | https://www.npmjs.com/package/jsonpointer |
| Tarball | `jsonpointer-5.0.1.tgz` |
| sha256 | `72c2fe2b1034905ed19b2477ccea0167a8490f1ff4e306f3a63a74c7a2ef1e10` |
| sha1 (npm dist.shasum) | `2110e0af0900fd37467b5907ecd13a7884a1b559` |
| sha512 (npm dist.integrity) | `sha512-p/nXbhSEcu3pZRdkW1OfJhpsVtW1gd4Wa1fnQc9YLiTfAjn0312eMKimbdIQzuZl9aa9xUGaRlP9T/CJE/ditQ==` |
| Acquired | 2026-05-17 (implementer; tarball pinned at `/home/claude/yakcc/.worktrees/feature-wi-510-s14-jsonpointer/tmp/wi-510-s14/jsonpointer-5.0.1.tgz`) |

## Trimmed vendor manifest (4 files — plan §4.1+§4.2)

The full tarball ships 5 files. This fixture vendors only the 4 files needed:

| File | Source | Notes |
|---|---|---|
| `jsonpointer.js` | Verbatim from tarball `package/jsonpointer.js` | 100 LOC pure-CJS entry; `exports.get = get` + `exports.set = set` + `exports.compile = compile` |
| `package.json` | Verbatim from tarball `package/package.json` | Root manifest; no `"type":"module"` (CJS default); `"main":"./jsonpointer"` (bare path, no `.js` extension) |
| `LICENSE.md` | Verbatim from tarball `package/LICENSE.md` | All-caps with `.md` extension — preserved as-is per `DEC-WI510-S14-LICENSE-FILE-NAMING-001` |
| `PROVENANCE.md` | Authored at implementation | This file |

**Excluded** (the 2 other tarball files — not transitively reachable from `jsonpointer.js`):
- `jsonpointer.d.ts` (TypeScript definitions; not read by the JS shave engine)
- `README.md` (documentation)

Note: No inner `package.json` marker is needed (per `DEC-WI510-S14-NO-INNER-MARKER-001`). The root
`package.json` does NOT set `"type":"module"`; the package defaults to `commonjs`, which is the
correct classification for `jsonpointer.js` (pure CJS with `exports.X = Y`; zero `require()` calls).

## License file naming

The tarball ships the MIT license as `LICENSE.md` (all-caps with `.md` extension). This matches
the dominant WI-510 corpus norm (S5 date-fns, S7 lodash, S10 lru-cache, S11 csv-parse, S12
fastest-levenshtein also used `LICENSE.md`). The filename is preserved verbatim per
`DEC-WI510-S14-LICENSE-FILE-NAMING-001`: the license-detector reads file text and matches on the
MIT header phrase; the filename itself does not gate detection.

## Bare `package.json#main` path

The `package.json` ships `"main": "./jsonpointer"` (bare path, no `.js` extension). The engine
resolves via `<main>` → `<main>.js` extension-fallback, finding `jsonpointer.js`. The bare path
is preserved verbatim from the tarball per `DEC-WI510-S14-BARE-MAIN-PATH-001`.

## Decision IDs recorded at this fixture

| DEC-ID | Title |
|---|---|
| `DEC-WI510-S14-PACKAGE-SELECTION-JSONPOINTER-001` | Slice 14 ships jsonpointer@5.0.1 (Jan Lehnardt) |
| `DEC-WI510-S14-ENTRY-PATH-JSONPOINTER-CJS-001` | Slice 14 entry is jsonpointer.js (the ONLY entry; no ESM alternative) |
| `DEC-WI510-S14-ONE-FILE-ONE-ROW-001` | Slice 14 ships ONE corpus row (cat1-jsonpointer-001) |
| `DEC-WI510-S14-VERSION-PIN-001` | Pin to jsonpointer@5.0.1 (current latest at 2026-05-17) |
| `DEC-WI510-S14-FIXTURE-TRIMMED-VENDOR-001` | Vendor a TRIMMED 4-file subset (5 files → 4 files) |
| `DEC-WI510-S14-NO-INNER-MARKER-001` | NO inner package.json markers required |
| `DEC-WI510-S14-LICENSE-FILE-NAMING-001` | Preserve tarball-faithful LICENSE.md spelling |
| `DEC-WI510-S14-BARE-MAIN-PATH-001` | package.json#main is the bare path "./jsonpointer" (no extension) |
| `DEC-WI510-S14-NO-CLASSES-001` | jsonpointer/jsonpointer.js has ZERO classes; #666 engine-gap N/A |
| `DEC-WI510-S14-NO-EXTERNAL-IMPORTS-001` | jsonpointer.js has ZERO require() calls AND zero import declarations |
| `DEC-WI510-S14-CJS-EXPORT-SHAPE-001` | exports.X = Identifier named-export shape is the validated CJS surface |
| `DEC-WI510-S14-VAR-FUNCTION-DECL-001` | Pre-ES2015 var + function declarations decompose identically |
| `DEC-WI510-S14-MODULE-SCOPE-REGEX-LITERAL-001` | Two module-scope var RegExp literal bindings |
| `DEC-WI510-S14-ENGINE-GAPS-LANDSCAPE-001` | Engine gaps #576/#585/#619 CLOSED + #666 OPEN-but-N/A |
| `DEC-WI510-S14-MODERN-PRIMITIVES-001` | Array.isArray/typeof/Error/Infinity inside function bodies |
| `DEC-WI510-S14-EXTERNAL-SPECIFIERS-EXPECTATIONS-001` | Expected externalSpecifiers for jsonpointer.js is [] |
| `DEC-WI510-S14-COMBINED-SCORE-FIXED-FLOOR-001` | combinedScore quality gate uses >= 0.70 fixed floor |

Full rationale for each decision is in `plans/wi-510-s14-jsonpointer.md §8`.
