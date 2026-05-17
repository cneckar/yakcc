# PROVENANCE — toposort@2.0.2 fixture (WI-510 Slice 13 / #642 S13)

## Tarball

| Field | Value |
|---|---|
| Package | `toposort@2.0.2` |
| Author | Marcel Klehr (`marcelklehr`) |
| Registry | https://www.npmjs.com/package/toposort |
| Tarball | `toposort-2.0.2.tgz` |
| sha256 | `866a794f685b78219e0afe396d339ec5ebf072af6473257d595ba84ca9776eb3` |
| sha1 (npm dist.shasum) | `ae21768175d1559d48bef35420b2f4962f09c330` |
| sha512 (npm dist.integrity) | `sha512-0a5EOkAUp8D4moMi2W8ZF8jcga7BgZd91O/yabJCFY8az+XSzeGyTKs0Aoo897iV1Nj6guFq8orWDS96z91oGg==` |
| Acquired | 2026-05-17 (planner probe; tarball pinned at `/home/claude/yakcc/tmp/wi-510-s13/probe/toposort-2.0.2.tgz`) |

## Trimmed vendor manifest (4 files — plan §4.1+§4.2)

The full tarball ships 10 files. This fixture vendors only the 4 files needed:

| File | Source | Notes |
|---|---|---|
| `index.js` | Verbatim from tarball `package/index.js` | 99 LOC pure-CJS entry; `module.exports = function(edges){...}` + `module.exports.array = toposort` |
| `package.json` | Verbatim from tarball `package/package.json` | Root manifest; no `"type":"module"` (CJS default); `"main":"index.js"` |
| `License` | Verbatim from tarball `package/License` | Capital-L, no extension — preserved as-is per `DEC-WI510-S13-LICENSE-FILE-NAMING-001` |
| `PROVENANCE.md` | Authored at implementation | This file |

**Excluded** (the 6 remaining tarball files — not transitively reachable from `index.js`):
- `test.js` (Vows-based test suite)
- `README.md` (documentation)
- `graph.svg` (marketing illustration)
- `Makefile` (dev shortcut)
- `.travis.yml` (CI config)
- `.npmignore` (npm publish config)
- `component.json` (deprecated Component.js manifest)

Note: No inner `package.json` marker is needed (per `DEC-WI510-S13-NO-INNER-MARKER-001`). The root
`package.json` does NOT set `"type":"module"`; the package defaults to `commonjs`, which is the
correct classification for `index.js` (pure CJS with `module.exports`; zero `require()` calls).

## License file naming

The tarball ships the MIT license as `License` (capital-L, no extension). This differs from the
WI-510 corpus norm (S5/S7/S10/S11/S12 used `LICENSE.md`; S6 used `LICENSE`; S9 used `license`).
The filename is preserved verbatim per `DEC-WI510-S13-LICENSE-FILE-NAMING-001`: the license-detector
reads file text and matches on the MIT header phrase; the filename itself does not gate detection.

## Decision IDs recorded at this fixture

| DEC-ID | Title |
|---|---|
| `DEC-WI510-S13-PACKAGE-SELECTION-TOPOSORT-001` | Slice 13 ships toposort@2.0.2 (Marcel Klehr) |
| `DEC-WI510-S13-ENTRY-PATH-INDEX-CJS-001` | Slice 13 entry is index.js (the ONLY entry; no ESM alternative) |
| `DEC-WI510-S13-ONE-FILE-ONE-ROW-001` | Slice 13 ships ONE corpus row (cat1-toposort-001) |
| `DEC-WI510-S13-VERSION-PIN-001` | Pin to toposort@2.0.2 (current latest at 2026-05-17) |
| `DEC-WI510-S13-FIXTURE-TRIMMED-VENDOR-001` | Vendor a TRIMMED 4-file subset (10 files → 4 files) |
| `DEC-WI510-S13-NO-INNER-MARKER-001` | NO inner package.json markers required |
| `DEC-WI510-S13-LICENSE-FILE-NAMING-001` | Preserve tarball-faithful License capitalization |
| `DEC-WI510-S13-NO-CLASSES-001` | toposort/index.js has ZERO classes; #666 engine-gap N/A |
| `DEC-WI510-S13-NO-EXTERNAL-IMPORTS-001` | index.js has ZERO require() calls AND zero import declarations |
| `DEC-WI510-S13-CJS-EXPORT-SHAPE-001` | module.exports = FunctionExpression + module.exports.X = Identifier |
| `DEC-WI510-S13-VAR-FUNCTION-DECL-001` | Pre-ES2015 var + function declarations decompose identically |
| `DEC-WI510-S13-ENGINE-GAPS-LANDSCAPE-001` | Engine gaps #576/#585/#619 CLOSED + #666 OPEN-but-N/A |
| `DEC-WI510-S13-MODERN-PRIMITIVES-001` | Set/Map/Array.from/JSON.stringify inside function bodies |
| `DEC-WI510-S13-EXTERNAL-SPECIFIERS-EXPECTATIONS-001` | Expected externalSpecifiers for index.js is [] |
| `DEC-WI510-S13-COMBINED-SCORE-FIXED-FLOOR-001` | combinedScore quality gate uses >= 0.70 fixed floor |

Full rationale for each decision is in `plans/wi-510-s13-toposort.md §8`.
