# Provenance — bcryptjs@2.4.3 fixture

- **Package:** bcryptjs (substituted for the issue body's `bcrypt` per DEC-WI510-S6-BCRYPT-USE-BCRYPTJS-001)
- **Version:** 2.4.3 (most-installed version on the 2.x line as of 2026-05-16; 3.x exists but is newer)
- **Source:** npm tarball (`npm pack bcryptjs@2.4.3`)
- **Tarball SHA1:** 9ab5627b93e60621ff7cdac5da9733027df1d0cb
- **Tarball integrity:** sha512-V/Hy/X9Vt7f3BbPJEi8BdVFMByHi+jNXrYkW3huaybV/kQ0KJg0Y6PkEMbn+zeT+i+SiKZ/HMqJGIIt4LZDqNQ==
- **Retrieved:** 2026-05-16
- **Contents:** 28 files. package.json#main -> "index.js"; package.json#browser -> "dist/bcrypt.js".
  Top-level: index.js, README.md, LICENSE, package.json, bower.json.
  bin/bcrypt (CLI wrapper). dist/: bcrypt.js (1379 lines, UMD IIFE),
  bcrypt.min.js, bcrypt.min.js.gz, bcrypt.min.map, README.md.
  src/: bcrypt.js, wrap.js, bcrypt/{impl.js, util.js, prng/{accum.js, isaac.js, README.md},
  util/base64.js} -- build inputs concatenated into dist/bcrypt.js, NOT CJS modules.
  externs/, scripts/, tests/ -- tooling and metadata.
- **Shape:** UMD IIFE bundle. index.js is a 1-line shim: `module.exports = require("./dist/bcrypt.js")`.
  dist/bcrypt.js wraps the entire library in `(function(global, factory) { ... }(this, function() { var bcrypt = {}; ... return bcrypt; }))`.
  No internal require() edges except the inlined `require("crypto")['randomBytes']` for entropy.
  **This is the first WI-510 fixture with a single-module-package shape** -- per
  DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001, every reasonable entryPath
  produces a 1-module subgraph; the whole library is one atom.
- **Runtime dependencies:** none (`package.json#dependencies` is empty).
- **External edges:** crypto (Node builtin -- B-scope external, emitted in externalSpecifiers).
- **Headline behaviors (this slice):** hash, verify (constant-time compare) -- both co-housed
  inside dist/bcrypt.js's bcrypt namespace; the same atom satisfies both corpus rows
  (per DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001).
- **Path decision:** Path A (published tarball) -- same rationale as Slices 3 and 4.
- **Why pin 2.4.3:** Most-installed bcryptjs version (~12M weekly downloads on the 2.x line);
  zero npm deps; same UMD IIFE shape as 3.x (no structural change in 3.x).
- **Substitution note:** The issue body names `bcrypt`. Native bcrypt ships precompiled
  .node binaries the shave engine cannot decompose. bcryptjs is the pure-JS implementation
  with an identical public API -- the canonical substitution (per DEC-WI510-S6-BCRYPT-USE-BCRYPTJS-001).
- **WI:** WI-510 Slice 6, workflow `wi-510-s6-jsonwebtoken-bcrypt`.
