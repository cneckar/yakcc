# Provenance — date-fns@4.1.0 fixture (TRIMMED)

- **Package:** date-fns
- **Version:** 4.1.0 (current `latest` dist-tag as of 2026-05-16)
- **Source:** npm tarball (`npm pack date-fns@4.1.0`)
- **Tarball SHA1:** 64b3d83fff5aa80438f5b1a633c2e83b8a1c2d14
- **Tarball integrity:** sha512-Ukq0owbQXxa/U3EGtsdVBkR1w7KOQ5gIBqdH2hkvknzZPYvBxb/aa6E8L7tmjFtkwZBu3UXBbjIgPo/Ez4xaNg==
- **Retrieved:** 2026-05-16
- **Vendor strategy:** TRIMMED (NOT full-tarball as Slices 3-4 used).
  Rationale: the full tarball is ~32MB (dominated by locale/=21MB, fp/=3.4MB,
  parse/=448KB) and 65x the largest existing fixture (validator-13.15.35=487KB).
  At this scale, full-tarball vendor crosses a different cost threshold (git
  repo bloat, CI clone time, repo-wide tooling indexing). Trimmed vendor
  retains only files actually traversed by the engine for the 5 Slice 5
  headline subgraphs, plus package.json and LICENSE.md. Trimmed size: ~50-80KB.
  See DEC-WI510-S5-FIXTURE-TRIMMED-VENDOR-001 for the full rationale.
- **Retained files (the entire trimmed vendor):**
  - package.json (required for any `package.json#exports` resolution the engine performs)
  - LICENSE.md (vendored-source license carry-forward)
  - PROVENANCE.md (this file)
  - parseISO.cjs (headline 1)
  - formatISO.cjs (headline 2)
  - addDays.cjs (headline 3)
  - differenceInMilliseconds.cjs (headline 4; issue-body name "differenceInMs"
    resolves to this per DEC-WI510-S5-DIFFERENCE-IN-MS-BINDING-001)
  - parseJSON.cjs (headline 5; substitute for issue-body "parse-tz-offset"
    per DEC-WI510-S5-PARSE-TZ-OFFSET-RESOLUTION-001)
  - toDate.cjs (shared transitive dep of headlines 1-5)
  - constructFrom.cjs (shared transitive dep via toDate/constants chain)
  - constants.cjs (leaf — math constants for ms-in-hour, ms-in-minute, etc.)
  - _lib/addLeadingZeros.cjs (transitive dep of formatISO only)
- **Excluded files / directories (deliberately NOT vendored):**
  - locale/ (21MB, 484 files — i18n)
  - fp/ (3.4MB — auto-curried functional-programming wrappers)
  - parse/ (448KB — general date-format parser; ALSO contains parse/_lib/Parser.cjs
    and parse/_lib/Setter.cjs which are the two class-body files in date-fns —
    not traversed by any Slice 5 headline so engine limit #576 is structurally
    not exercised)
  - docs/ (85KB — generated documentation)
  - *.d.ts, *.d.cts (TypeScript type files, outside tsc's .js scope)
  - *.js (ESM variants; the engine's resolver prefers require -> import so it
    lands on .cjs files; ESM variants are not exercised in Slice 5)
  - All other 245 top-level <name>.cjs files (date-fns ships ~250 behaviors;
    only 5 are headlines for Slice 5; broader coverage deferred to a later
    production-corpus initiative)
  - _lib/*.cjs except addLeadingZeros.cjs (the other helpers are not transitive
    deps of any Slice 5 headline subgraph)
- **Shape:** Plain modern CJS. Every .cjs file opens with `"use strict";` and
  uses `var _index = require("./<rel>.cjs")` for in-package edges. NOT Babel-
  transpiled (contrast validator-13.15.35). NOT TypeScript-compiled with
  `Object.defineProperty(exports, "__esModule", ...)` (contrast uuid-11.1.1).
  Hand-aliased CJS — structurally the simplest of any landed fixture.
- **Runtime dependencies:** none (`package.json#dependencies` is empty / absent).
- **External edges from the 5 headline subgraphs:** none. All edges resolve
  in-package. Expected forest-level `stubCount = 0` for all 5 headlines.
  (Contrast Slice 4 uuid/nanoid where `require('crypto')` produced a Node-
  builtin external edge.)
- **Headline behaviors (this slice):** parseISO, formatISO, addDays,
  differenceInMilliseconds (mapping issue-body "differenceInMs" per
  DEC-WI510-S5-DIFFERENCE-IN-MS-BINDING-001), parseJSON (substitute for
  issue-body "parse-tz-offset" per DEC-WI510-S5-PARSE-TZ-OFFSET-RESOLUTION-001).
- **Why pin 4.1.0:** Current `latest` dist-tag. Dual-format `.cjs` + `.js`
  outputs via `package.json#exports` — engine's resolver picks `require` and
  lands on `.cjs`. Zero npm dependencies. No class declarations in any Slice 5
  headline subgraph (#576 risk = zero). See DEC-WI510-S5-VERSION-PIN-001.
- **WI:** WI-510 Slice 5, workflow `wi-510-s5-date-fns`.
