# Provenance — `lru-cache@11.3.6` trimmed fixture (WI-510 Slice 10 / #642 S10)

## Authorship

Slice: WI-510 Slice 10 (first slice of the #642 cluster — S10–S15)
Authored: 2026-05-17
Workflow: `wi-642-s10-lru-cache`
Implementer lease: `6efcf86c488d450bab4a37e4d271f5a8`
Plan: `plans/wi-510-s10-lru-cache.md`
Tracking issue: https://github.com/cneckar/yakcc/issues/642

## Tarball acquisition

Source: `npm pack lru-cache@11.3.6`
npm sha1 (dist.shasum): `f0306ad6e9f0a5dc25b16aeba4e8f57b7ec2df55`
Local sha256: `ac25c9ea2f0c3df12ee81dea7f58e0e463cc09af5a338c221fc94ffbccba248d`
Tarball filename: `lru-cache-11.3.6.tgz`
Total files in published tarball: 89 files / ~2.7 MB unpacked

## Trimmed manifest (7 files retained)

Per plan §4.1+§4.2 (DEC-WI510-S10-FIXTURE-TRIMMED-VENDOR-001):

```
lru-cache-11.3.6/
  LICENSE.md                      # ISC license file (DEC-WI510-S10-FIXTURE-TRIMMED-VENDOR-001)
  package.json                    # Root package manifest; engine reads name/version/type/exports
  PROVENANCE.md                   # This file
  dist/esm/
    diagnostics-channel.js        # 18-LOC ESM platform-agnostic diagnostics polyfill (transitive)
    index.js                      # 1681-LOC TSC-emitted ESM — LRUCache class entry (DEC-WI510-S10-ENTRY-PATH-DIST-ESM-001)
    package.json                  # Inner {"type":"module"} marker (DEC-WI510-S10-INNER-PACKAGE-JSON-INCLUDED-001)
    perf.js                       # 7-LOC ESM performance clock ternary (transitive)
```

All other 82 tarball files explicitly excluded per plan §4.1:
- All `.min.js` files (minified entries — deliberately bypassed per DEC-WI510-S10-ENTRY-PATH-DIST-ESM-001)
- All `.d.ts` and `.d.ts.map` files (TypeScript types; engine processes .js only)
- All `.js.map` source maps
- `dist/esm/browser/`, `dist/esm/node/`, `dist/commonjs/`, `dist/commonjs/browser/`, `dist/commonjs/node/` subtrees
- `README.md`

## Decision IDs recorded in this slice

| DEC-ID | Title | Location |
|--------|-------|----------|
| `DEC-WI510-S10-PER-ENTRY-SHAVE-001` | Slice 10 shaves the LRUCache class entry per-entry | test file @decision block |
| `DEC-WI510-S10-ENTRY-PATH-DIST-ESM-001` | Entry is `dist/esm/index.js` (NOT minified, NOT CJS) | test file @decision block |
| `DEC-WI510-S10-ONE-CLASS-ONE-ROW-001` | ONE corpus row (`cat1-lru-cache-001`) for the LRUCache headline | test file @decision block |
| `DEC-WI510-S10-VERSION-PIN-001` | Pin to `lru-cache@11.3.6` (current `latest` dist-tag 2026-05-17) | test file @decision block |
| `DEC-WI510-S10-FIXTURE-TRIMMED-VENDOR-001` | Vendor a TRIMMED 7-file subset (89 files → 7 files) | this file + test file |
| `DEC-WI510-S10-INNER-PACKAGE-JSON-INCLUDED-001` | Inner `dist/esm/package.json` included verbatim | this file + test file |
| `DEC-WI510-S10-CLASS-BODY-FIRST-PRODUCTION-EXERCISE-001` | First WI-510 production-fixture exercise of class-body decompose at scale | test file @decision block |
| `DEC-WI510-S10-DYNAMIC-IMPORT-EMPIRICAL-001` | `import('node:diagnostics_channel')` recorded as engine-reality-empirical | test file @decision block |
| `DEC-WI510-S10-ENGINE-GAPS-LANDSCAPE-001` | #576/#585/#619 all closed; risk is unknown-class-body-shape | test file @decision block |
| `DEC-WI510-S10-MODERN-PRIMITIVES-001` | AbortSignal/Symbol/Map/Set/process treated as opaque identifier references | test file @decision block |
| `DEC-WI510-S10-EXTERNAL-SPECIFIERS-EXPECTATIONS-001` | `externalSpecifiers` empirical (Outcome A `[]` or Outcome B `["node:diagnostics_channel"]`) | test file @decision block |
| `DEC-WI510-S10-COMBINED-SCORE-FIXED-FLOOR-001` | combinedScore quality gate uses fixed `>= 0.70` floor | test file @decision block |

## Package structural summary

| Property | Value |
|---|---|
| Author | Isaac Z. Schlueter |
| License | BlueOak-1.0.0 |
| `package.json#type` | `module` |
| `package.json#main` | `./dist/commonjs/index.min.js` (minified CJS — deliberately bypassed) |
| Runtime dependencies | none (zero) |
| Class declarations in `dist/esm/index.js` | 3: `ZeroArray extends Array`, `Stack`, `export class LRUCache` |
| `dist/esm/index.js` LOC | 1681 |
| In-package transitive modules (default ESM path) | 3: `dist/esm/index.js` + `dist/esm/diagnostics-channel.js` + `dist/esm/perf.js` |
| Dynamic `import('node:diagnostics_channel')` in `diagnostics-channel.js` | YES (top-level; Outcome A vs B per §1.7) |
