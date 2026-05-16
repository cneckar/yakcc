# Provenance -- uuid@11.1.1 fixture

- **Package:** uuid
- **Version:** 11.1.1 (latest `legacy-11` dist-tag as of 2026-05-16)
- **Source:** npm tarball (`npm pack uuid@11.1.1`)
- **Tarball SHA1:** f6d81d2e1c65d00762e5e29b16c5d2d995e208ad
- **Tarball integrity:** sha512-vIYxrBCC/N/K+Js3qSN88go7kIfNPssr/hHCesKCQNAjmgvYS2oqr69kIufEG+O4+PfezOH4EbIeHCfFov8ZgQ==
- **Retrieved:** 2026-05-16
- **Contents:** ~73 files. dist/ tree carries cjs/, cjs-browser/, esm/, esm-browser/
  variants of every module plus .d.ts files. package.json#main -> "./dist/cjs/index.js".
- **Shape:** TypeScript-compiled CJS (`"use strict"; Object.defineProperty(exports, "__esModule", ...)`).
  Every relative `require()` uses an explicit `.js` extension (e.g. `require("./rng.js")`).
- **Runtime dependencies:** none (`package.json#dependencies` is empty / absent).
- **External edges:** `require('crypto')` (Node builtin -- B-scope external, emitted as ForeignLeafEntry).
- **Headline behaviors (this slice):** `v4`, `validate`, `v7` (mapping issue-body
  "v4-generate", "v4-validate", "v7-generate" per DEC-WI510-S4-UUID-BINDING-NAMES-001).
- **Path decision:** Path A (published CJS tarball) -- inherits Slice 3
  DEC-WI510-S3-FIXTURE-FULL-TARBALL-001. uuid@14 is ESM-only (DEC-WI510-S4-UUID-VERSION-PIN-001).
- **Why pin 11.1.1:** ESM-only uuid@14 would be the first ESM-vendored fixture in
  the corpus, a deliberately deferred concern. 11.1.1 is the head of the still-supported
  legacy-11 CJS line. Zero runtime npm dependencies (verified `npm view uuid@11.1.1 dependencies`).
- **WI:** WI-510 Slice 4, workflow `wi-510-s4-uuid-nanoid`.

## Decision IDs

- `DEC-WI510-S4-UUID-VERSION-PIN-001` -- Pin to uuid@11.1.1 (latest CJS-shipping line; uuid@14 is ESM-only)
- `DEC-WI510-S4-UUID-BINDING-NAMES-001` -- Issue-body "v4-generate" -> `v4`, "v4-validate" -> `validate`, "v7-generate" -> `v7`
- `DEC-WI510-S4-FIXTURE-FULL-TARBALL-001` -- Vendor the full uuid-11.1.1 and nanoid-3.3.12 published tarballs verbatim
- `DEC-WI510-S4-NODE-BUILTIN-FOREIGN-LEAF-001` -- uuid/v4, uuid/v7, and nanoid each reference require('crypto') -- a Node builtin treated as B-scope external (ForeignLeafEntry)

## Subgraph notes

### v4 subgraph (dist/cjs/v4.js)
Direct requires: ./native.js, ./rng.js, ./stringify.js
Transitive: native.js -> require('crypto') (external stub); rng.js -> require('crypto') (external stub);
stringify.js -> ./validate.js -> ./regex.js (leaf).
Expected: moduleCount in [4, 9], stubCount in [1, 2].

### validate subgraph (dist/cjs/validate.js)
Direct requires: ./regex.js (leaf). No external edges.
Expected: moduleCount in [2, 4], stubCount = 0.

### v7 subgraph (dist/cjs/v7.js)
Direct requires: ./rng.js, ./stringify.js
Transitive: rng.js -> require('crypto') (external stub);
stringify.js -> ./validate.js -> ./regex.js (leaf).
Expected: moduleCount in [3, 7], stubCount in [1, 2].
