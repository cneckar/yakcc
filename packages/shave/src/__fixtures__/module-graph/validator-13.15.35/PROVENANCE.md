# Provenance — validator@13.15.35 fixture

- **Package:** validator
- **Version:** 13.15.35 (latest stable as of 2026-05-14)
- **Source:** npm tarball (`npm pack validator@13.15.35`)
- **Tarball SHA1:** 81cf455c51f15b69d8d340be5914f3fab00dbf7f
- **Tarball integrity:** sha512-TQ5pAGhd5whSt[...]ZOS1eqgkar0iw==
- **Retrieved:** 2026-05-14
- **Contents:** `package.json`, `index.js`, `lib/**` (104 files), `lib/util/**` (10 files)
- **Total source files:** 115 (index.js + 104 lib + 10 util) plus package.json
- **Shape:** Babel-transpiled CommonJS. Every `lib/*.js` opens with
  `"use strict"; Object.defineProperty(exports, "__esModule", ...); exports.default = <fn>;`
  and uses `_interopRequireDefault(require("./dep"))` for imports.
- **Headline behaviors:** `isEmail`, `isURL`, `isUUID`, `isAlphanumeric`
  (these are the atoms targeted by WI-510 Slice 2 and the triad MVDP).
- **Path decision:** Path A (published Babel CJS) — measured in `validator-fixture.test.ts §A`
  per `plans/wi-510-s2-validator.md` §6.0 mandatory gate.
- **WI:** WI-510 Slice 2, workflow `WI-510-S2-VALIDATOR`
