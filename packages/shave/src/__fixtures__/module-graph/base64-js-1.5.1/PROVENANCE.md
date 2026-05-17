# PROVENANCE — base64-js@1.5.1 fixture (WI-510 Slice 15 / #642 S15)

## Tarball

| Field | Value |
|---|---|
| Package | `base64-js@1.5.1` |
| Author | T. Jameson Little (`beatgammit`); funded by Feross Aboukhadijeh |
| Registry | https://www.npmjs.com/package/base64-js |
| Tarball | `base64-js-1.5.1.tgz` |
| sha256 | `b1b7a945b52685269083425216d6597e33d97bf21699d656e92fdb3eb5210a85` |
| sha1 (npm dist.shasum) | `1b1b440160a5bf7ad40b650f095963481903930a` |
| sha512 (npm dist.integrity) | `sha512-AKpaYlHn8t4SVbOHCy+b5+KKgvR4vrsD8vbvrbiQJps7fKDTkjkDry6ji0rUJjC0kzbNePLwzxq8iypo41qeWA==` |
| Acquired | 2026-05-17 (implementer; tarball pinned at `/home/claude/yakcc/.worktrees/feature-wi-510-s15-base64/tmp/wi-510-s15/base64-js-1.5.1.tgz`) |

## Trimmed vendor manifest (4 files — plan §4.1+§4.2)

The full tarball ships 6 files. This fixture vendors only the 4 files needed:

| File | Source | Notes |
|---|---|---|
| `index.js` | Verbatim from tarball `package/index.js` | 150 LOC pure-CJS entry; `exports.byteLength = byteLength` + `exports.toByteArray = toByteArray` + `exports.fromByteArray = fromByteArray` |
| `package.json` | Verbatim from tarball `package/package.json` | Root manifest; no `"type":"module"` (CJS default); `"main":"index.js"` (bare filename) |
| `LICENSE` | Verbatim from tarball `package/LICENSE` | All-caps NO extension — preserved as-is per `DEC-WI510-S15-LICENSE-FILE-NAMING-001` |
| `PROVENANCE.md` | Authored at implementation | This file |

**Excluded** (the 4 other tarball files — not transitively reachable from `index.js`):
- `base64js.min.js` (Browserify+babel-minify UMD build for `<script>` tag; NOT the Node entry; excluded per `DEC-WI510-S15-ENTRY-PATH-BASE64JS-CJS-001`)
- `index.d.ts` (TypeScript definitions; not read by the JS shave engine)
- `README.md` (documentation)
- (any remaining tarball metadata files)

Note: No inner `package.json` marker is needed. The root `package.json` does NOT set
`"type":"module"`; the package defaults to `commonjs`, which is the correct classification
for `index.js` (pure CJS with `exports.X = Y`; zero `require()` calls). Same shape as S13
toposort and S14 jsonpointer (no inner marker needed).

## License file naming

The tarball ships the MIT license as `LICENSE` (all-caps, NO extension). This matches the S2
validator, S3 semver, S6 jsonwebtoken+bcryptjs, S8 zod, S9 nanoid convention. The filename is
preserved verbatim per `DEC-WI510-S15-LICENSE-FILE-NAMING-001`: the license-detector reads
file text and matches on the MIT header phrase; the filename itself does not gate detection.

## `package.json#main` path

The `package.json` ships `"main": "index.js"` (bare filename with `.js` extension). The engine
resolves directly to `index.js` with no extension-fallback needed (unlike S14 jsonpointer's
`"./jsonpointer"` bare-no-extension case). Preserved verbatim from the tarball.

## Decision IDs recorded at this fixture

| DEC-ID | Title |
|---|---|
| `DEC-WI510-S15-PACKAGE-SELECTION-BASE64JS-001` | Slice 15 ships base64-js@1.5.1 (T. Jameson Little) |
| `DEC-WI510-S15-ENTRY-PATH-BASE64JS-CJS-001` | Slice 15 entry is index.js (the ONLY entry; no ESM alternative; base64js.min.js excluded) |
| `DEC-WI510-S15-ONE-FILE-ONE-ROW-001` | Slice 15 ships ONE corpus row (cat1-base64-js-001) |
| `DEC-WI510-S15-VERSION-PIN-001` | Pin to base64-js@1.5.1 (current latest at 2026-05-17) |
| `DEC-WI510-S15-FIXTURE-TRIMMED-VENDOR-001` | Vendor a TRIMMED 4-file subset (6 files → 4 files) |
| `DEC-WI510-S15-NO-INNER-MARKER-001` | NO inner package.json markers required |
| `DEC-WI510-S15-LICENSE-FILE-NAMING-001` | Preserve tarball-faithful LICENSE spelling (all-caps, no extension) |
| `DEC-WI510-S15-NO-CLASSES-001` | base64-js/index.js has ZERO classes; #666 engine-gap N/A |
| `DEC-WI510-S15-NO-EXTERNAL-IMPORTS-001` | index.js has ZERO require() calls AND zero import declarations |
| `DEC-WI510-S15-CJS-EXPORT-SHAPE-001` | exports.X = Identifier named-export shape — IDENTICAL to S14 jsonpointer |
| `DEC-WI510-S15-MODULE-SCOPE-FOR-LOOP-001` | First WI-510 fixture with executable module-scope for loop body (lines 12-15) |
| `DEC-WI510-S15-USE-STRICT-DIRECTIVE-001` | Hand-authored 'use strict' at line 1 (single-quoted, no semicolon) |
| `DEC-WI510-S15-ENGINE-GAPS-LANDSCAPE-001` | Engine gaps #576/#585/#619 CLOSED + #666 OPEN-but-N/A |
| `DEC-WI510-S15-EXTERNAL-SPECIFIERS-EXPECTATIONS-001` | Expected externalSpecifiers for index.js is [] |
| `DEC-WI510-S15-COMBINED-SCORE-FIXED-FLOOR-001` | combinedScore quality gate uses >= 0.70 fixed floor |
| `DEC-WI510-S15-MODULE-SCOPE-TYPED-ARRAY-CONDITIONAL-001` | Module-scope var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array |
| `DEC-WI510-S15-HEAVY-BITWISE-ARITHMETIC-001` | First WI-510 fixture with heavy bitwise arithmetic (<<, >>, &, |, 0xFF, 0x3F) |

Full rationale for each decision is in `plans/wi-510-s15-base64.md`.
