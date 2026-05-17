# PROVENANCE — fastest-levenshtein@1.0.16 fixture (WI-510 Slice 12 / #642 S12)

## Tarball

| Field | Value |
|---|---|
| Package | `fastest-levenshtein@1.0.16` |
| Author | Kasper U. Weihe (`ka-weihe`) |
| License | MIT |
| Tarball filename | `fastest-levenshtein-1.0.16.tgz` |
| sha256 | `650310ac51ee96ae0f900751d47b2846f038b80fd3380f35533605f3704c5b5f` |
| sha1 (npm dist.shasum) | `210e61b6ff181de91ea9b3d1b84fdedd47e034e5` |
| Compressed size | ~6.1 KB |
| Unpacked size | ~21.3 KB |
| Total files in tarball | 14 |
| Acquisition date | 2026-05-17 |
| Source | `npm pack fastest-levenshtein@1.0.16` |

## Trimmed vendor manifest

Per plan §4.1 + §4.2, this fixture vendors **5 files** from the 14-file tarball:

| File | Source | Notes |
|---|---|---|
| `esm/mod.js` | Copied verbatim from tarball + header added | ESM entry (138 LOC production source); the file Slice 12 shaves |
| `esm/package.json` | **Synthetic** (not in tarball) | Inner `{"type":"module"}` marker per `DEC-WI510-S12-INNER-PACKAGE-JSON-MARKER-001` |
| `package.json` | Copied verbatim from tarball | Package manifest; `#module` field points to `./esm/mod.js` |
| `LICENSE.md` | Copied verbatim from tarball | MIT license |
| `PROVENANCE.md` | This file (authored by Slice 12 implementer) | Provenance record |

### Excluded files (10 of 14 tarball files excluded)

- `mod.js` — TSC-emitted CJS entry with `__esModule` prelude; rejected per `DEC-WI510-S12-ENTRY-PATH-ESM-MOD-001` (would re-engage #619 territory)
- `mod.d.ts`, `mod.d.ts.map` — TypeScript types for CJS entry; engine processes `.js` only
- `esm/mod.d.ts`, `esm/mod.d.ts.map` — TypeScript types for ESM entry; engine processes `.js` only
- `test.ts`, `test.js` — dev test code; not in runtime surface
- `bench.js` — benchmark code; not in runtime surface
- `.travis.yml`, `.prettierrc`, `.eslintrc.json` — CI/linting config; not in runtime surface
- `README.md` — documentation; not engine-relevant

## Package selection rationale

fastest-levenshtein was chosen over js-levenshtein for the #642 S12 Levenshtein slot per
`DEC-WI510-S12-PACKAGE-SELECTION-FASTEST-001`. Key reasons:

1. `js-levenshtein@1.1.6` ships ONLY as a CJS `module.exports = (function(){...})()` IIFE —
   a previously-unobserved engine shape with HIGH-UNKNOWN engine-gap risk.
2. `fastest-levenshtein@1.0.16` ships `esm/mod.js` — a clean single-file ESM with arrow-function
   `const` bindings and named exports, structurally identical to the S9-validated p-throttle regime.
3. The #642 issue table explicitly grants the swap: "Operator/implementer may swap exact npm
   package per WI-510 selection conventions."

## Inner esm/package.json marker rationale

The root `package.json` does NOT set `"type":"module"`; the package defaults to `commonjs`.
The `esm/mod.js` file uses ESM syntax via the `module` bundler-convention field only.
Without the inner `esm/package.json` marker containing `{"type":"module"}`, the shave engine's
package.json walker may classify `esm/mod.js` as CJS and refuse to parse ESM `import`/`export`.
The 25-byte synthetic marker guarantees correct classification regardless of engine resolution.
Mirrors S10 lru-cache's `dist/esm/package.json` pattern.
Per `DEC-WI510-S12-INNER-PACKAGE-JSON-MARKER-001`.

## Decision IDs recorded at this slice

| DEC-ID | Title |
|---|---|
| `DEC-WI510-S12-PACKAGE-SELECTION-FASTEST-001` | Slice 12 ships fastest-levenshtein@1.0.16, NOT js-levenshtein |
| `DEC-WI510-S12-ENTRY-PATH-ESM-MOD-001` | Slice 12 entry is esm/mod.js (NOT mod.js) |
| `DEC-WI510-S12-ONE-FILE-ONE-ROW-001` | Slice 12 ships ONE corpus row carrying both distance and closest exports |
| `DEC-WI510-S12-VERSION-PIN-001` | Pin to fastest-levenshtein@1.0.16 (current latest) |
| `DEC-WI510-S12-FIXTURE-TRIMMED-VENDOR-001` | Vendor a TRIMMED 5-file subset of the 14-file tarball |
| `DEC-WI510-S12-INNER-PACKAGE-JSON-MARKER-001` | Synthetic inner esm/package.json {"type":"module"} marker |
| `DEC-WI510-S12-NO-CLASSES-001` | esm/mod.js has zero classes; #666 engine-gap CANNOT apply |
| `DEC-WI510-S12-NO-EXTERNAL-IMPORTS-001` | esm/mod.js has zero import declarations; externalSpecifiers === [] |
| `DEC-WI510-S12-MODULE-SCOPE-TYPED-ARRAY-001` | const peq = new Uint32Array(0x10000) is opaque construction |
| `DEC-WI510-S12-ENGINE-GAPS-LANDSCAPE-001` | Engine gaps #576/#585/#619 CLOSED + #666 OPEN-but-N/A |
| `DEC-WI510-S12-MODERN-PRIMITIVES-001` | Uint32Array/Math/String/Infinity at module scope treated as opaque refs |
| `DEC-WI510-S12-EXTERNAL-SPECIFIERS-EXPECTATIONS-001` | Expected externalSpecifiers = [] (zero imports) |
| `DEC-WI510-S12-COMBINED-SCORE-FIXED-FLOOR-001` | combinedScore >= 0.70 fixed floor |
