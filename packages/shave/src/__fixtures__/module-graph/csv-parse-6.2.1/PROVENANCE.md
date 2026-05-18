# csv-parse@6.2.1 fixture — WI-510 Slice 11 / #642 S11

**Authored:** 2026-05-17  
**Workflow:** `wi-642-s11-csv-parse`  
**Plan:** `plans/wi-510-s11-csv-parse.md`  
**Tracking issue:** [#642](https://github.com/cneckar/yakcc/issues/642)

## Tarball provenance

- **Source:** npm public registry (`registry.npmjs.org`)
- **Package:** `csv-parse@6.2.1`
- **Tarball filename:** `csv-parse-6.2.1.tgz`
- **sha256 (tarball):** `a66924cc1926d48cf6cb5fe5d99948a7571c1a6d01ae6d1d93492cb4ee47cabc`
- **sha1 (npm dist.shasum):** `325c5adb126b1ad07fa68077c3dc739ccfc12cf5`
- **Total files in published tarball:** 30
- **Files vendored in this fixture:** 12 (trimmed; §4.1 of the plan)

## Trimmed manifest (12 files)

All files are verbatim copies from the tarball `package/` directory. No edits.

```
package.json                              (root; engines, exports, type:"module")
LICENSE                                   (MIT; authored David Worms / Adaltas)
lib/index.js                              (callback/Parser entry — 147 LOC; shave entry 1)
lib/sync.js                               (sync entry — 28 LOC; shave entry 2)
lib/api/index.js                          (transform state machine — 922 LOC)
lib/api/normalize_options.js              (option normalization — 691 LOC)
lib/api/init_state.js                     (state init — 68 LOC)
lib/api/normalize_columns_array.js        (column array normalization — 32 LOC)
lib/api/CsvError.js                       (CsvError class — 22 LOC)
lib/utils/is_object.js                    (is_object utility — 5 LOC)
lib/utils/ResizeableBuffer.js             (ResizeableBuffer utility — 63 LOC)
lib/utils/underscore.js                   (underscore utility — 7 LOC)
```

## Excluded files (18 of 30)

- `lib/stream.js` — `csv-parse/stream` entry (web-stream wrapper; out of scope per §10)
- `lib/**/*.d.ts` — TypeScript declarations (engine processes `.js` only)
- `dist/cjs/index.cjs`, `dist/cjs/sync.cjs`, `dist/cjs/*.d.cts` — CJS rollup; not shaved
- `dist/esm/index.js`, `dist/esm/sync.js`, `dist/esm/*.d.ts` — browser ESM rollup (6951 LOC); not shaved
- `dist/iife/*`, `dist/umd/*` — legacy bundles
- `README.md` — not engine-relevant

## Decision IDs

- `DEC-WI510-S11-PER-ENTRY-SHAVE-001` — Two entries shaved per-entry (callback + sync)
- `DEC-WI510-S11-ENTRY-PATH-LIB-ESM-001` — lib/index.js and lib/sync.js (NOT any dist/* rollup)
- `DEC-WI510-S11-TWO-ROW-FUNCTION-PAIR-001` — Two corpus rows (cat1-csv-parse-001 + cat1-csv-parse-sync-001)
- `DEC-WI510-S11-VERSION-PIN-001` — csv-parse@6.2.1 (current latest dist-tag at 2026-05-17)
- `DEC-WI510-S11-FIXTURE-TRIMMED-VENDOR-001` — Trimmed 12-file subset (30 files → 12)
- `DEC-WI510-S11-NO-INNER-PACKAGE-JSON-001` — No inner package.json markers needed
- `DEC-WI510-S11-NO-PRIVATE-FIELDS-001` — No #foo private class fields; #666 gap N/A
- `DEC-WI510-S11-NODE-BUILTIN-STREAM-001` — lib/index.js imports Transform from "stream"; foreign leaf in externalSpecifiers
- `DEC-WI510-S11-HAND-AUTHORED-ESM-001` — Hand-authored ESM (not rollup'd or TSC-emitted)
- `DEC-WI510-S11-ENGINE-GAPS-LANDSCAPE-001` — #576/#585/#619 closed; #666 N/A for csv-parse
- `DEC-WI510-S11-MODERN-PRIMITIVES-001` — Buffer/JSON/Array/Math/Error/Object/setImmediate/setTimeout treated as opaque
- `DEC-WI510-S11-EXTERNAL-SPECIFIERS-EXPECTATIONS-001` — lib/index.js externalSpecifiers=["stream"]; lib/sync.js externalSpecifiers=[]
- `DEC-WI510-S11-COMBINED-SCORE-FIXED-FLOOR-001` — combinedScore >= 0.70 fixed floor
