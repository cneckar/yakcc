# Provenance — p-limit@7.3.0 fixture

- **Package:** p-limit
- **Version:** 7.3.0 (current `latest` dist-tag at planning; see DEC-WI510-S9-VERSION-PIN-001)
- **Source:** npm tarball (`npm pack p-limit@7.3.0`)
- **Tarball bytes (packed):** 4,580
- **Tarball file count:** 5
- **File listing:** index.js, index.d.ts, package.json, license, readme.md
- **Unpacked size:** ~15 KB (14,881 bytes)
- **Retrieved:** 2026-05-16
- **Vendor strategy:** FULL tarball (5 files; trimming yields zero benefit at this scale).
  Inherits Slices 3/4/6/8 full-tarball rationale extended via DEC-WI510-S9-FIXTURE-FULL-TARBALL-001.
- **package.json#type:** module (Sindre Sorhus ESM-only canonical shape; the engine's
  extractImportSpecifiers path is exercised in production for the first time in WI-510)
- **package.json#main:** absent
- **package.json#module:** absent (only `exports` is used)
- **package.json#exports:** `{ types: "./index.d.ts", default: "./index.js" }`
- **package.json#dependencies:** `{ "yocto-queue": "^1.2.1" }` — single npm dep; appears as a
  foreign leaf in shaved output (yocto-queue is NOT vendored; the engine emits it as
  externalSpecifiers=["yocto-queue"] per DEC-WI510-S9-FOREIGN-LEAF-YOCTO-QUEUE-001)
- **Source shape:** Hand-authored ESM (NOT tsc-compiled).
  - Top-level `import`/`export` syntax (NOT `__createBinding`/`__importStar` prelude — issue #619 NOT exercised)
  - Zero class declarations (issue #576 NOT exercised)
  - No UMD IIFE wrapper (issue #585 NOT exercised)
  - ~128 LOC; plain `import Queue from 'yocto-queue';` at line 1
- **External edges (visible to engine):** ["yocto-queue"] — one external npm import that resolves
  UNRESOLVABLE → foreign leaf (yocto-queue is not vendored; the B-scope predicate stops at package
  boundary per DEC-WI510-S9-FOREIGN-LEAF-YOCTO-QUEUE-001)
- **Headline behavior (this slice):**
  - p-limit: count-based-sliding-window concurrency limit (pLimit(N) returns a generator)
  - One issue-body headline `sliding-window` → TWO atoms (one per package) per
    DEC-WI510-S9-TWO-BINDINGS-NOT-ONE-001
- **Engine-tractability expectation (per plan §3.1):**
  - moduleCount=1, stubCount=0, externalSpecifiers=["yocto-queue"], forestTotalLeafCount>=5
  - If empirical differs: stop-and-report; either ship engine-reality (S8 pattern) or investigate
- **Why pin current-latest:** p-limit has been ESM-only across its entire published history since
  v4; no LTS CJS line exists to pin to. Current-latest tracks `engines.node >= 20` and the canonical
  Sindre Sorhus ESM shape. Per DEC-WI510-S9-VERSION-PIN-001.
- **Closing remark — Slice 9 is the FINAL WI-510 slice:** PR landing closes #510 per the §11
  closing-comment text in plans/wi-510-s9-p-limit-p-throttle.md.
- **DEC IDs:**
  - DEC-WI510-S9-VERSION-PIN-001
  - DEC-WI510-S9-FIXTURE-FULL-TARBALL-001
  - DEC-WI510-S9-FOREIGN-LEAF-YOCTO-QUEUE-001
  - DEC-WI510-S9-TWO-BINDINGS-NOT-ONE-001
  - DEC-WI510-S9-ENGINE-GAPS-NOT-EXERCISED-001
  - DEC-WI510-S9-ESM-IMPORT-EXTRACTOR-FIRST-PRODUCTION-USE-001
  - DEC-WI510-S9-FINAL-SLICE-CLOSES-510-001
- **WI:** WI-510 Slice 9, workflow `wi-510-s9-p-limit-p-throttle`.
