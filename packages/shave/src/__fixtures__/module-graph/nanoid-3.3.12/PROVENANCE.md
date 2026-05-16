# Provenance -- nanoid@3.3.12 fixture

- **Package:** nanoid
- **Version:** 3.3.12 (head of `3.x` line as of 2026-05-16; `nanoid@latest` is 5.1.11 ESM-only)
- **Source:** npm tarball (`npm pack nanoid@3.3.12`)
- **Tarball SHA1:** ab3d912e217a6d0a514f00a72a16543a28982c05
- **Tarball integrity:** sha512-ZB9RH/39qpq5Vu6Y+NmUaFhQR6pp+M2Xt76XBnEwDaGcVAqhlvxrl3B2bKS5D3NH3QR76v3aSrKaF/Kiy7lEtQ==
- **Retrieved:** 2026-05-16
- **Contents:** ~26 files. Dual ESM + CJS layout: every entry ships both .js (ESM)
  and .cjs (CJS) variants. package.json#main -> "index.cjs". package.json#exports
  ".require.default" -> "./index.cjs". Sub-paths: "./async", "./non-secure", "./url-alphabet".
- **Shape:** Hand-written ES2017 CJS (`let crypto = require('crypto')`, `module.exports = { ... }`).
  No "use strict" pragma, no Babel/tsc boilerplate. Cleaner than uuid's compiled CJS.
- **Runtime dependencies:** none. (One historical version, 3.1.26, briefly depended on
  nanocolors; reverted by 3.1.27. 3.3.12 has no dependencies -- verified `npm view nanoid@3.3.12 dependencies`.)
- **External edges:** `require('crypto')` (Node builtin -- B-scope external, emitted as ForeignLeafEntry).
- **Headline behaviors (this slice):** `nanoid` (the primary export; the package's
  README headline behavior). Other primitives (`customAlphabet`, `customRandom`,
  `urlAlphabet`, `random`) are co-exported from the same `index.cjs` but are not
  separately addressable as per-entry shaves because they share the same entry file.
- **Path decision:** Path A (published CJS tarball) -- same as Slice 3 fixture.
- **Why pin 3.3.12:** ESM-only nanoid@5.x is the first-ESM-fixture deferral
  (DEC-WI510-S4-NANOID-VERSION-PIN-001). 3.x is the last CJS-shipping line, still
  widely installed via npm.
- **WI:** WI-510 Slice 4, workflow `wi-510-s4-uuid-nanoid`.

## Decision IDs

- `DEC-WI510-S4-NANOID-VERSION-PIN-001` -- Pin to nanoid@3.3.12 (latest CJS-shipping line; nanoid@5 is ESM-only)
- `DEC-WI510-S4-NANOID-PRIMARY-EXPORT-001` -- nanoid primary export resolves to index.cjs's nanoid() function
- `DEC-WI510-S4-FIXTURE-FULL-TARBALL-001` -- Vendor the full uuid-11.1.1 and nanoid-3.3.12 published tarballs verbatim
- `DEC-WI510-S4-NODE-BUILTIN-FOREIGN-LEAF-001` -- uuid/v4, uuid/v7, and nanoid each reference require('crypto') -- a Node builtin treated as B-scope external (ForeignLeafEntry)

## Subgraph notes

### nanoid subgraph (index.cjs)
Direct requires: crypto (external stub), ./url-alphabet/index.cjs.
Transitive: url-alphabet/index.cjs is a leaf (no further requires).
Expected: moduleCount in [2, 4], stubCount in [1, 2].
