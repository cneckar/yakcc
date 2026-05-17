# Provenance — p-throttle@8.1.0 fixture

- **Package:** p-throttle
- **Version:** 8.1.0 (current `latest` dist-tag at planning; see DEC-WI510-S9-VERSION-PIN-001)
- **Source:** npm tarball (`npm pack p-throttle@8.1.0`)
- **Tarball bytes (packed):** 6,553
- **Tarball file count:** 5
- **File listing:** index.js, index.d.ts, package.json, license, readme.md
- **Unpacked size:** ~22 KB (21,636 bytes)
- **Retrieved:** 2026-05-16
- **Vendor strategy:** FULL tarball (5 files; trimming yields zero benefit at this scale).
  Inherits Slices 3/4/6/8 full-tarball rationale extended via DEC-WI510-S9-FIXTURE-FULL-TARBALL-001.
- **package.json#type:** module (Sindre Sorhus ESM-only canonical shape; the engine's
  extractImportSpecifiers path is exercised in production for the first time in WI-510)
- **package.json#main:** absent
- **package.json#module:** absent (only `exports` is used)
- **package.json#exports:** `{ types: "./index.d.ts", default: "./index.js" }`
- **package.json#dependencies:** NONE (zero runtime deps; historical p-limit dep was removed at v8)
- **Source shape:** Hand-authored ESM (NOT tsc-compiled).
  - Top-level `export default function pThrottle` syntax (NOT `__createBinding`/`__importStar` prelude — issue #619 NOT exercised)
  - Zero class declarations (issue #576 NOT exercised)
  - No UMD IIFE wrapper (issue #585 NOT exercised)
  - ~305 LOC; p-throttle uses modern Node >=20 globals: WeakMap, WeakRef, FinalizationRegistry, AbortSignal
    (engine handles these as opaque identifier references at module scope per DEC-WI510-S9-MODERN-PLATFORM-PRIMITIVES-001)
  - File opens with `const states = new WeakMap()` at module scope — zero `import` statements
- **External edges (visible to engine):** [] — zero imports of any kind
  (historical p-limit dependency removed at v8; pure module-scope code)
- **Headline behavior (this slice):**
  - p-throttle: time-based-sliding-window throttle (pThrottle({limit, interval}) returns a wrapper)
  - One issue-body headline `sliding-window` → TWO atoms (one per package) per
    DEC-WI510-S9-TWO-BINDINGS-NOT-ONE-001
- **Engine-tractability expectation (per plan §3.2):**
  - moduleCount=1, stubCount=0, externalSpecifiers=[], forestTotalLeafCount>=10
  - If WeakMap/WeakRef/FinalizationRegistry/AbortSignal defeat decomposition: ship engine-reality
    per S8 dispatch-contract pattern (assert stub state + file new engine-gap issue)
  - Per DEC-WI510-S9-MODERN-PLATFORM-PRIMITIVES-001
- **Why pin current-latest:** p-throttle has been ESM-only across its entire published history since
  v4; no LTS CJS line exists to pin to. v8 removed the p-limit runtime dep (confirmed by reading
  package.json: zero runtime dependencies). Current-latest tracks `engines.node >= 20` and the
  canonical Sindre Sorhus ESM shape. Per DEC-WI510-S9-VERSION-PIN-001.
- **Closing remark — Slice 9 is the FINAL WI-510 slice:** PR landing closes #510 per the §11
  closing-comment text in plans/wi-510-s9-p-limit-p-throttle.md.
- **DEC IDs:**
  - DEC-WI510-S9-VERSION-PIN-001
  - DEC-WI510-S9-FIXTURE-FULL-TARBALL-001
  - DEC-WI510-S9-TWO-BINDINGS-NOT-ONE-001
  - DEC-WI510-S9-ENGINE-GAPS-NOT-EXERCISED-001
  - DEC-WI510-S9-MODERN-PLATFORM-PRIMITIVES-001
  - DEC-WI510-S9-EXTERNAL-SPECIFIERS-EXPECTATIONS-001
  - DEC-WI510-S9-ESM-IMPORT-EXTRACTOR-FIRST-PRODUCTION-USE-001
  - DEC-WI510-S9-FINAL-SLICE-CLOSES-510-001
- **WI:** WI-510 Slice 9, workflow `wi-510-s9-p-limit-p-throttle`.
