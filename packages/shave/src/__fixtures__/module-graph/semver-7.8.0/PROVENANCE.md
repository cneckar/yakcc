# Provenance -- semver@7.8.0 fixture

- **Package:** semver
- **Version:** 7.8.0 (latest `latest` dist-tag as of 2026-05-16)
- **Source:** npm tarball (`npm pack semver@7.8.0`)
- **Tarball SHA1:** ed0661039fcbcda2ce71f01fa6adbefaa77040df
- **Tarball integrity:** sha512-AcM7dV/5ul4EekoQ29Agm5vri8JNqRyj39o0qpX6vDF2GZrtutZl5RwgD1XnZjiTAfncsJhMI48QQH3sN87YNA==
- **Retrieved:** 2026-05-16
- **Contents:** `package.json`, `index.js`, `preload.js`, `range.bnf`, `bin/`, `classes/`, `functions/`, `internal/`, `ranges/` -- 53 files total (note: `package.json#files` mentions `lib/` but semver@7 dropped the `lib/` directory; harmless drift, no `require('./lib/...')` edge exists in source)
- **Shape:** Plain modern Node.js CommonJS. Every `*.js` opens with `'use strict'`
  and uses `const x = require('<rel-path>')` for in-package edges. NOT Babel-transpiled
  (contrast with validator-13.15.35 which is Babel-CJS with `_interopRequireDefault` wrappers).
- **Runtime dependencies:** none (`package.json#dependencies` is empty / absent).
- **Headline behaviors (this slice):** `satisfies`, `coerce`, `compare`, `parse`
  (the "parse-component" binding from #510's issue body resolves to `functions/parse.js`;
  see DEC-WI510-S3-PARSE-COMPONENT-BINDING-001).
- **Path decision:** Path A (published CJS tarball) -- same as Slice 2's
  validator-13.15.35 fixture per DEC-WI510-S2-VENDORED-FIXTURE-CARRYOVER-001.
- **WI:** WI-510 Slice 3, workflow `wi-510-s3-semver-bindings`.

## Decision IDs

- `DEC-WI510-S3-VERSION-PIN-001` -- Pin to semver@7.8.0 (current latest, zero runtime deps, plain CJS)
- `DEC-WI510-S3-FIXTURE-FULL-TARBALL-001` -- Vendor the full published tarball verbatim (biome-ignored, outside tsc .js scope)
- `DEC-WI510-S3-PARSE-COMPONENT-BINDING-001` -- "parse-component" from issue body resolves to functions/parse.js
- `DEC-WI510-S3-CYCLE-GUARD-REAL-WORLD-PROOF-001` -- satisfies subgraph exercises classes/range.js <-> classes/comparator.js circular import (first real-world corroboration of Slice 1's cycle guard)

## Circular import note

`classes/range.js` and `classes/comparator.js` form a genuine circular import in this
package (both files contain a `// hoisted class for cyclic dependency` comment and
cross-require each other). The `satisfies.js` headline binding transitively pulls in
this cycle. Slice 1's cycle guard handles it correctly per
DEC-WI510-S3-CYCLE-GUARD-REAL-WORLD-PROOF-001.
