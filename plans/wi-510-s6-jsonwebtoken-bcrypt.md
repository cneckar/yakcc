# WI-510 Slice 6 — Per-Entry Shave of `jsonwebtoken` (verify, decode) + `bcryptjs` (single-module package atom)

**Status:** Planning pass (read-only research output). Not Guardian readiness for any code slice.
**Scope:** Slice 6 of [#510](https://github.com/cneckar/yakcc/issues/510). Slice 1 (engine, PR #526, `37ec862`), Slice 2 (validator, PR #544, `aeec068`), Slice 3 (semver, PR #570+#571, `b83d46f`), and Slice 4 (uuid+nanoid, PR #573, `5d8bde1`) are landed on `main`. Slice 5 (date-fns) is being planned in parallel on a sibling workflow.
**Branch:** `feature/wi-510-s6-jsonwebtoken-bcrypt`
**Worktree:** `C:/src/yakcc/.worktrees/wi-510-s6-jsonwebtoken-bcrypt`
**Authored:** 2026-05-16 (planner stage, workflow `wi-510-s6-jsonwebtoken-bcrypt`)
**Parent docs (on `main`, read in full):** `plans/wi-510-shadow-npm-corpus.md` (the reframed #510 engine plan), `plans/wi-510-s4-uuid-nanoid.md` (the immediate structural sibling — two-package slice with `crypto` foreign-leaf pattern), `plans/wi-510-s3-semver-bindings.md` (cycle-guard + class-arrow-gap context).

This document changes no TypeScript source, does not modify `MASTER_PLAN.md` permanent sections, and does not constitute Guardian readiness for any code-bearing slice. New DEC IDs in §8 are to be annotated at the implementation point (consistent with how Slices 1–4 recorded their `DEC-WI510-*` entries).

---

## 1. What changed — why Slice 6 exists

Slices 1–4 proved the dependency-following shave engine on `ms`, `validator`, `semver`, and `uuid`+`nanoid`. The graduated-fixture ladder of `plans/wi-510-shadow-npm-corpus.md` line 115 reserves Slice 6 for:

> *Slice 6 — jsonwebtoken + bcrypt (crypto/token; shared constant-time-compare subgraph)*

Slice 6 covers **two packages at once**, mirroring the Slice 4 paired-package pattern. The two packages exercise:

1. **The first real-world fixture with non-trivial external npm-dep fan-out.** Slices 2–4 all picked packages with zero runtime npm dependencies (`validator`, `semver`, `uuid`, `nanoid`). `jsonwebtoken@9.0.2` ships **10 npm runtime dependencies** (`ms`, `jws`, `semver`, and 6 individual `lodash.*` packages). Each becomes a `ForeignLeafEntry` via the existing B-scope predicate — populating `ModuleForestNode.externalSpecifiers` for the first time at meaningful breadth. This corroborates the Slice 4 `crypto`-builtin foreign-leaf assertion at npm-package scope. The actual engine emission shape is documented in §3.6; the **planner asserts what the engine actually emits**, not the planner-estimate (per the PR #571 lesson on issue #576).

2. **The first real-world fixture that is a single-module UMD bundle.** `bcryptjs@2.4.3` ships `dist/bcrypt.js` as a 1,379-line UMD IIFE — no internal `require()` edges; `index.js` is literally `module.exports = require("./dist/bcrypt.js")`. The shave engine's per-module decomposition produces one atom for the whole package. This is **structurally novel** in the WI-510 fixture suite (all prior slices had multi-module graphs). It exercises the engine's "what happens when there is nothing to decompose past the entry module?" path. The result is a single-module package-atom with `crypto` in `externalSpecifiers` (bcryptjs uses `require("crypto")['randomBytes']` for entropy).

The two packages were paired in the master plan slice ordering because they share the **crypto/token domain** and both have a **constant-time-compare subgraph** (jsonwebtoken via `jws` → `safe-buffer` → buffer compare; bcryptjs via its own internal `bcrypt.compareSync` Blowfish hash comparison). They are otherwise independent — no shared imports, no shared atoms.

### 1.1 Binding-name resolution (operator-decision boundaries closed)

The issue body (#510) names headline bindings for both packages. Resolution:

#### jsonwebtoken headlines

| Issue-body name | npm export | Resolution | Decision |
|---|---|---|---|
| `HS256-verify` | `verify(token, secret, options)` (in `verify.js`) | The `verify` function dispatches on `options.algorithms` — HS256 is one of the supported algorithms it handles internally via `jws.verify`. There is no separate `HS256-verify` file. | **Map to `verify.js`** — Document in `DEC-WI510-S6-JWT-HS256-VERIFY-BINDING-001`. HS256 is selected at call time, not at the file/binding level. |
| `decode-base64url` | `decode(token, options)` (in `decode.js`) → returns header/payload/signature after internal base64url decode | jsonwebtoken does not export a standalone `base64url` helper. Its base64url decoding lives inside the `jws` dependency (external — emitted as `externalSpecifiers`). The user-facing way to "decode base64url JOSE parts" is `decode(token)`. | **Map to `decode.js`** — Document in `DEC-WI510-S6-JWT-DECODE-BASE64URL-BINDING-001`. The base64url decoding is encapsulated by `jws` (external dep). The atomized graph captures the user-facing entry point. |
| `parse-jose-header` | `decode(token, {complete: true}).header` (in `decode.js`) | Returns the `decoded.header` field after `jws.decode` parses the token. Same source file as `decode-base64url`. | **Map to `decode.js`** — Document in `DEC-WI510-S6-JWT-PARSE-JOSE-HEADER-BINDING-001`. Two issue-body headlines (`decode-base64url`, `parse-jose-header`) collapse to **the same source file** (`decode.js`) because `decode()` is the single public entry that does both. The corpus carries two separate query rows — both point at the same atom merkle root — exactly the same pattern bcryptjs uses below. |

**Net result for jsonwebtoken:** three issue-body headlines collapse to **TWO entryPath shaves** — `verify.js` and `decode.js`. The corpus appends **three** `synthetic-tasks` rows; the `decode-base64url` and `parse-jose-header` rows both point at the same `decode.js`-atom merkle root.

#### bcryptjs headlines

| Issue-body name | npm export | Resolution | Decision |
|---|---|---|---|
| `hash` | `hashSync(s, salt)` / `hash(s, salt, cb)` (in `dist/bcrypt.js`) | bcryptjs's package layout is `index.js` (1-line shim) → `dist/bcrypt.js` (1,379-line UMD IIFE with EVERY API method on one `bcrypt` namespace object). | **Map to `dist/bcrypt.js`** with single-package-atom acceptance — see §1.2 for the structural-novelty discussion. |
| `verify` (constant-time-compare) | `compareSync(s, hash)` / `compare(s, hash, cb)` (in `dist/bcrypt.js`) | Same file as `hash`. | **Map to `dist/bcrypt.js`** — the same atom. Document in `DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001`. |

**Net result for bcryptjs:** two issue-body headlines collapse to **ONE entryPath shave** producing **one atom**. The corpus appends **two** `synthetic-tasks` rows; both point at the same merkle root.

### 1.2 bcrypt vs bcryptjs — the operator-decision boundary

The issue body names `bcrypt`. The npm `bcrypt@5.x` package ships **precompiled native bindings (`.node` files)** — the actual hash/verify implementation is a C++ Node addon. The shave engine processes JavaScript AST via ts-morph; it **cannot decompose `.node` binaries**. Three paths exist:

| Path | Description | Trade-off |
|---|---|---|
| **A (chosen)** | Vendor `bcryptjs@2.4.3` — pure-JS implementation, identical public API to `bcrypt`. | Honest end-to-end shave. The atomized library runtime is real. The `bcrypt`-vs-`bcryptjs` substitution is documented loudly in `DEC-WI510-S6-BCRYPT-USE-BCRYPTJS-001`. |
| B (rejected) | Vendor `bcrypt@5.x`'s JS layer only, ignoring `.node` files. | Atomized graph would assert the JS-wrapper but the hash/verify runtime would not actually work. The atom is dishonest — it claims behavior the file cannot deliver. |
| C (rejected) | Defer bcrypt entirely; ship only jsonwebtoken in this slice. | Under-delivers the master-plan slice ordering. Issue body names both. |

**Path A chosen.** bcryptjs is the canonical pure-JS bcrypt implementation (the npmjs.org page links to it as the JS-only alternative to native bcrypt). It is widely deployed (~12M weekly downloads as of 2026-05). Same public API as bcrypt, so when `#508`'s import-intercept hook fires on `import bcrypt from 'bcrypt'`, the atom Slice 6 produces is interchangeable (a later slice or a registry alias can map `bcrypt` → `bcryptjs`-atom).

**Documented in `DEC-WI510-S6-BCRYPT-USE-BCRYPTJS-001` (§8).** A follow-on initiative may add `bcrypt`-native handling once the shave engine grows `.node`-binary tolerance (likely never — `.node` files are opaque, not source).

### 1.3 bcryptjs structural novelty — single-module package

bcryptjs's published tarball contains:

- `index.js` — `module.exports = require("./dist/bcrypt.js")` (1-line shim).
- `dist/bcrypt.js` — 1,379 lines, **a UMD IIFE wrapping the entire library**: `(function(global, factory) { if AMD ... if CJS ... else global ... }(this, function() { "use strict"; var bcrypt = {}; ... return bcrypt; }))`. Internal references are inside the closure — no `require()` calls except the inlined `require("crypto")['randomBytes']` for entropy.
- `dist/bcrypt.min.js`, `dist/bcrypt.min.map`, `dist/bcrypt.min.js.gz` — minified browser variants. Unreferenced by `package.json#main`; the BFS never enqueues them.
- `src/bcrypt.js`, `src/wrap.js`, `src/bcrypt/impl.js`, `src/bcrypt/util.js`, `src/bcrypt/prng/{accum.js, isaac.js}`, `src/bcrypt/util/base64.js` — the un-bundled "build inputs" the bundler concatenates into `dist/bcrypt.js`. **These are NOT CJS modules:** no `module.exports`, no `require()` (except the same inlined `require("crypto")`), no exports at all — they're concatenated text. The package's actual entry point is `dist/bcrypt.js`.
- `bin/bcrypt`, `bower.json`, `externs/`, `scripts/`, `tests/` — tooling and metadata, never reached.

**Consequence:** every reasonable `entryPath` for bcryptjs (whether `index.js`, `dist/bcrypt.js`, or `src/bcrypt.js`) produces a **single-module forest**. The two headlines `hash` and `verify` are co-housed inside the same `bcrypt = {}` namespace inside the same file. Per-entry decomposition gives no granularity over per-package decomposition for bcryptjs — there is exactly one source file holding all of the package's behaviors.

This is the **first real-world WI-510 fixture exercising the single-module-package shape** — a structural property the engine has handled in unit-test isolation (any `.js` file with no requires shaves to `moduleCount=1`) but never on a published npm package. **Documented in `DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001` (§8).**

The corpus rows for `hash` and `verify` both point at the same atom merkle root. From the discovery-eval perspective, both queries should retrieve the same atom (the bcryptjs-package-atom) — the embedder ranks the atom by combined query similarity, and both query strings should fall into the `confident` band (>= 0.70) against the single bcryptjs atom because the atom's source contains both `bcrypt.hashSync` and `bcrypt.compareSync` strings.

### 1.4 jsonwebtoken structural novelty — external-deps fan-out

jsonwebtoken@9.0.2's `verify.js` requires:

- **In-package:** `./lib/JsonWebTokenError`, `./lib/NotBeforeError`, `./lib/TokenExpiredError`, `./decode`, `./lib/timespan`, `./lib/validateAsymmetricKey`, `./lib/psSupported`.
- **External npm:** `jws`.
- **Node builtin:** `crypto` (via `const {KeyObject, createSecretKey, createPublicKey} = require("crypto")`).

And transitively:
- `./lib/timespan` → `require('ms')` (external).
- `./lib/psSupported` → `require('semver')` (external).
- `./lib/validateAsymmetricKey` → `./asymmetricKeyDetailsSupported`, `./rsaPssKeyDetailsSupported` (both in-package, both require `semver`).
- `./decode` → `require('jws')`.

`sign.js` adds **6 more lodash externals**: `lodash.includes`, `lodash.isboolean`, `lodash.isinteger`, `lodash.isnumber`, `lodash.isplainobject`, `lodash.isstring`, `lodash.once`.

**Sum across the package:** 10 unique npm external specifiers (`ms`, `jws`, `semver`, `lodash.includes`, `lodash.isboolean`, `lodash.isinteger`, `lodash.isnumber`, `lodash.isplainobject`, `lodash.isstring`, `lodash.once`) + 1 Node builtin (`crypto`). The `verify.js` subgraph specifically references **{`jws`, `crypto`, `ms`, `semver`}** transitively — four external specifiers. The `decode.js` subgraph references **{`jws`}** — one external specifier.

This is the **first real-world WI-510 fixture with multi-external fan-out**, the canonical complement to Slice 4's single-external-builtin (`crypto`) case.

### 1.5 Version pin

**Selected: `jsonwebtoken@9.0.2`.**

- `9.0.2` is the current `latest` dist-tag (verified `npm view jsonwebtoken@9.0.2 dist` on 2026-05-16). The 9.x line is auth0's current stable.
- jsonwebtoken@9 source is **plain modern Node.js CJS** (`const x = require('./y')`, `module.exports = function ...`) — structurally the same shape Slice 3's `semver` proved. No Babel transpile boilerplate; no ESM-only entry.
- Pin to `9.0.2` for byte-identical fixture vendoring.

**Documented in `DEC-WI510-S6-JWT-VERSION-PIN-001` (§8).**

**Selected: `bcryptjs@2.4.3`.**

- `2.4.3` is the head of the 2.x line. There is a `3.x` line as of 2026 but `2.4.3` remains the most-installed version (~12M weekly downloads on the 2.x line vs ~0.5M on 3.x as of early 2026). The 2.x line is widely deployed and stable.
- Zero npm dependencies (`npm view bcryptjs@2.4.3 dependencies` returns empty).
- The UMD-IIFE shape is identical between 2.x and 3.x — both ship `dist/bcrypt.js` as a bundle.

**Documented in `DEC-WI510-S6-BCRYPTJS-VERSION-PIN-001` (§8).** A follow-on initiative may extend to bcryptjs@3 once the corpus demands a refresh.

---

## 2. Path A confirmed — no engine change needed

The engine pattern is settled across Slices 1–4. `shavePackage({ packageRoot, entryPath })` accepts an explicit per-entry override; `isInPackageBoundary()` scopes the BFS to the package's own directory; `extractRequireSpecifiers` walks CJS `require(<string>)` calls; external edges (npm deps OR Node builtins like `crypto`) become entries in `ModuleForestNode.externalSpecifiers` (the engine stores unresolvable/external specifiers on the node, not as `ModuleStubEntry`/`stubCount` — that PR #573 lesson is critical and §5.2 / §5.6 honor it).

**Slice 6 is a pure fixture-and-test slice.** Gate is **`review`** (matches Slices 2–4). No engine source change. No new public-API surface. No `ShavePackageOptions` shape change.

The two structural-novelty properties Slice 6 exercises (multi-external-fan-out and single-module-package) are handled by the existing engine — the planner does not assume the engine handles either; the implementer **asserts what the engine actually emits** (§5.6 criterion 4) and files a Slice 1 engine bug if either property surfaces unexpected behavior (§5.5 — no in-slice engine patches).

---

## 3. Per-entry subgraph size estimates (planner read from extracted source)

**Critical lesson learned (PR #571, issue #576):** the planner's estimates of `moduleCount` have a known failure mode — the engine's `decompose()` cannot atomize ArrowFunctions inside class bodies, which can collapse an estimated `moduleCount=18` subgraph (`semver/satisfies`) to actual `moduleCount=1` if the BFS-reached class uses arrow-method bodies. The implementer **asserts what the engine actually emits** (not the planner's `moduleCount`) and writes the test assertions against the empirical output. The ranges below are planner anchors, not absolute requirements.

Estimates read directly from the vendored tarballs (`tmp/wi-510-s6/jsonwebtoken-9/` and `tmp/wi-510-s6/bcryptjs-2/`). Each estimate counts in-package `require('./...')` and `require('../...')` specifiers transitively. External edges (`require('jws')`, `require('lodash.once')`, `require('crypto')`, etc.) are NOT in-package and become entries in `ModuleForestNode.externalSpecifiers`.

### 3.1 `jsonwebtoken/verify.js`

Direct requires (8 total):
- In-package (7): `./lib/JsonWebTokenError`, `./lib/NotBeforeError`, `./lib/TokenExpiredError`, `./decode`, `./lib/timespan`, `./lib/validateAsymmetricKey`, `./lib/psSupported`.
- External (1 npm + 1 builtin): `jws`, `crypto`.

Transitive in-package edges:
- `./lib/JsonWebTokenError`, `./lib/NotBeforeError`, `./lib/TokenExpiredError` → leaves (no requires).
- `./decode` → external `jws` (leaf in-package).
- `./lib/timespan` → external `ms`.
- `./lib/validateAsymmetricKey` → `./asymmetricKeyDetailsSupported`, `./rsaPssKeyDetailsSupported`.
- `./lib/asymmetricKeyDetailsSupported` → external `semver`.
- `./lib/rsaPssKeyDetailsSupported` → external `semver`.
- `./lib/psSupported` → external `semver`.

**Unique in-package module set:** `verify.js`, `lib/JsonWebTokenError.js`, `lib/NotBeforeError.js`, `lib/TokenExpiredError.js`, `decode.js`, `lib/timespan.js`, `lib/validateAsymmetricKey.js`, `lib/psSupported.js`, `lib/asymmetricKeyDetailsSupported.js`, `lib/rsaPssKeyDetailsSupported.js` = **~10 modules**.

**Unique externalSpecifiers across the subgraph:** `jws`, `crypto`, `ms`, `semver` = **4 external specifiers**.

**Range guidance for §A:** `moduleCount in [3, 12]`, `stubCount = 0`, `externalSpecifiers count >= 1` and includes `jws` (with the strong expectation of `>= 3` and the four specifiers above, but the implementer asserts the empirical value).

The **wide lower bound** (3) is a deliberate concession to the issue #576 class-arrow-gap risk: if any in-package transitive (e.g. `lib/validateAsymmetricKey.js`) surfaces a pattern the engine cannot decompose, the BFS may emit a `ModuleStubEntry` early and collapse the subgraph. The lower bound 3 covers the worst credible case (the entry + one or two stubs).

### 3.2 `jsonwebtoken/decode.js`

Direct requires (1):
- External: `jws`.

Transitive: none in-package.

**Unique in-package module set:** `decode.js` = **1 module**.

**Unique externalSpecifiers:** `jws` = **1 external specifier**.

**Range guidance for §A:** `moduleCount in [1, 2]`, `stubCount = 0`, `externalSpecifiers` includes `jws`.

This is the **smallest planned subgraph in the entire WI-510 fixture suite** (smaller than uuid/validate's 2 modules). Wall-clock should be sub-second.

### 3.3 `bcryptjs/dist/bcrypt.js`

Direct requires (1):
- External: `crypto` (inlined as `require("crypto")['randomBytes']` inside the IIFE — extractable via standard `require(<string-literal>)` walking).

Transitive: none in-package (UMD IIFE has no `require()` for in-package modules — everything is inside the closure).

**Unique in-package module set:** `dist/bcrypt.js` = **1 module**.

**Unique externalSpecifiers:** `crypto` = **1 external specifier**.

**Range guidance for §A:** `moduleCount in [1, 2]`, `stubCount = 0`, `externalSpecifiers` includes `crypto`.

Per-entry, this is the smallest possible subgraph (one source file). Wall-clock should be sub-second. The atom itself is the entire bcryptjs library — a 1,379-line single-file package.

**Critical caveat for `dist/bcrypt.js`:** the IIFE pattern `(function (global, factory) { ... })(this, function () { var bcrypt = {}; ... return bcrypt; })` is **non-trivial JS** that the engine's `decompose()` may or may not atomize cleanly. The outer call is a `CallExpression` whose callee is a `FunctionExpression`; the inner function body is a chain of `FunctionDeclaration` + `bcrypt.X = ...` assignments. Each top-level function inside the IIFE is potentially an atomizable function, but they live inside a closure scope — the engine's atomization may decide the whole IIFE is one atom (preserving closure context), or it may extract each `function X() {...}` separately. **The implementer asserts the empirical output.** If the IIFE atomizes to a single atom, `forestTotalLeafCount = 1`. If it decomposes into N atoms, `forestTotalLeafCount = N`. Either is acceptable — the test asserts `>= 1` and records the actual value in measurement evidence.

If the engine throws on the IIFE (e.g. some unsupported syntax), `decompose()` returns a stub entry and `stubCount = 1`. This is a **stop-and-report engine-gap finding** — file a new bug against the engine; do not patch in-slice.

### 3.4 Aggregate footprint and expected wall-clock

Total decompositions:
- `verify.js` subgraph: ~10 modules.
- `decode.js` subgraph: ~1 module.
- `bcryptjs/dist/bcrypt.js` subgraph: ~1 module.

Cumulative ~12 module-decompositions across the three §A–§E test groups — meaningfully smaller than Slice 3 (~40) and similar to Slice 4 (~15).

**Per-headline test budget: <120 s per headline (the Slice 2–4 ceiling); typical <10 s** (most subgraphs are 1–2 modules). **Cumulative §A–§E budget: <5 minutes.** **§F cumulative (with `DISCOVERY_EVAL_PROVIDER=local`): <8 minutes.** Any binding exceeding 120 s is a **stop-and-report** event.

### 3.5 externalSpecifiers expectation — the new property

For the first time in the WI-510 graduated fixtures, Slice 6 asserts **multi-element `externalSpecifiers` populated by genuine npm package edges** (not just one Node builtin). Specifically:

- `verify.js` subgraph: `externalSpecifiers` contains `jws`, `crypto`, `ms`, `semver` (or whatever subset the engine resolves; the implementer asserts what is actually emitted, with minimum `externalSpecifiers count >= 1` and the strong expectation that `jws` is present).
- `decode.js` subgraph: `externalSpecifiers` contains `jws`.
- `bcryptjs/dist/bcrypt.js` subgraph: `externalSpecifiers` contains `crypto`.

This corroborates the engine's foreign-leaf emission for **npm packages** (not just Node builtins), the canonical complement to Slice 4's Node-builtin case. The shave engine's `extractRequireSpecifiers` doesn't distinguish builtins from npm packages — both are non-relative specifiers — so the same foreign-leaf path handles both.

If `externalSpecifiers` is empty for `verify.js`, that is a **stop-and-report engine-gap finding** — file a bug.

### 3.6 stubCount expectation

For Slices 2–4 every `entryPath`-shave produced `stubCount = 0` (external specifiers go into `externalSpecifiers`, not `stubCount`). Slice 6 carries the same expectation: **`stubCount = 0` for all three headline shaves**, with `externalSpecifiers` populated as above.

If `stubCount > 0` for any of the three shaves, it indicates one of:
- An in-package transitive module the engine cannot decompose (issue #576 class-arrow-gap class of failure) — record loudly in measurement evidence; do not raise the assertion ceiling silently.
- An unreadable file in the vendored tarball — fixture-vendoring error.
- A `.d.ts`-only dep with no `.js` runtime — not applicable for these two packages.

Per the PR #573 lesson, the test asserts `stubCount = 0` as the canonical expectation; if the empirical value is non-zero, the implementer must investigate and document (either file an engine bug + relax the assertion with a citation comment, or fix the fixture vendoring).

---

## 4. Fixture shape — vendored tarballs, mirroring Slice 4

**Decision: vendor the full `jsonwebtoken-9.0.2` and `bcryptjs-2.4.3` published tarballs verbatim.** Same rationale chain Slices 3 and 4 documented:

1. Honesty about what `node_modules` contains.
2. `isInPackageBoundary` scopes traversal — unreferenced files (`bcryptjs/dist/bcrypt.min.js`, `bin/`, `tests/`, etc.) exist on disk at zero traversal cost.
3. Trimming duplicates maintenance burden.
4. Operator constraint respected (vendor published tarball, not source).

**Fixture acquisition path (already done in `tmp/wi-510-s6/` by the planner; the implementer re-runs for fresh known-good copies):**

- `npm pack jsonwebtoken@9.0.2` → `jsonwebtoken-9.0.2.tgz` (SHA1 `65ff91f4abef1784697d40952bb1998c504caaf3`, integrity `sha512-PRp66vJ865SSqOlgqS8hujT5U4AOgMfhrwYIuIhfKaoSCZcirrmASQr8CX7cUg+RMih+hgznrjp99o+W4pJLHQ==`, 15 files).
- `npm pack bcryptjs@2.4.3` → `bcryptjs-2.4.3.tgz` (SHA1 `9ab5627b93e60621ff7cdac5da9733027df1d0cb`, integrity `sha512-V/Hy/X9Vt7f3BbPJEi8BdVFMByHi+jNXrYkW3huaybV/kQ0KJg0Y6PkEMbn+zeT+i+SiKZ/HMqJGIIt4LZDqNQ==`, 28 files).
- Extract → `package/` directory → copy contents into `packages/shave/src/__fixtures__/module-graph/jsonwebtoken-9.0.2/` and `bcryptjs-2.4.3/` respectively.
- Author one `PROVENANCE.md` per fixture (templates in §4.1, §4.2).

The vendored tree is biome-ignored by the existing global `src/__fixtures__/module-graph/**` glob in `biome.json` (verified by Slices 1–4). The `.js` and `.cjs` files are outside `tsc`'s scope.

### 4.1 `PROVENANCE.md` template — jsonwebtoken

```
# Provenance — jsonwebtoken@9.0.2 fixture

- **Package:** jsonwebtoken
- **Version:** 9.0.2 (latest `latest` dist-tag as of 2026-05-16)
- **Source:** npm tarball (`npm pack jsonwebtoken@9.0.2`)
- **Tarball SHA1:** 65ff91f4abef1784697d40952bb1998c504caaf3
- **Tarball integrity:** sha512-PRp66vJ865SSqOlgqS8hujT5U4AOgMfhrwYIuIhfKaoSCZcirrmASQr8CX7cUg+RMih+hgznrjp99o+W4pJLHQ==
- **Retrieved:** 2026-05-16
- **Contents:** 15 files. package.json#main → "index.js". Top-level: index.js, decode.js,
  sign.js, verify.js. lib/: JsonWebTokenError.js, NotBeforeError.js, TokenExpiredError.js,
  asymmetricKeyDetailsSupported.js, psSupported.js, rsaPssKeyDetailsSupported.js,
  timespan.js, validateAsymmetricKey.js. Plus README.md, LICENSE.
- **Shape:** Plain modern Node.js CommonJS. Every *.js opens with `const x = require('./y')`
  or `var x = require('./y')`. Mix of `module.exports = function ...` and
  `module.exports = { ... }`. NOT Babel-transpiled.
- **Runtime dependencies (10 npm + 1 builtin):**
  - ms (^2.1.1) -- used by lib/timespan.js
  - jws (^3.2.2) -- used by decode.js and verify.js
  - semver (^7.5.4) -- used by lib/psSupported.js, lib/asymmetricKeyDetailsSupported.js, lib/rsaPssKeyDetailsSupported.js
  - lodash.once (^4.0.0), lodash.includes (^4.3.0), lodash.isnumber (^3.0.3),
    lodash.isstring (^4.0.1), lodash.isboolean (^3.0.3), lodash.isinteger (^4.0.4),
    lodash.isplainobject (^4.0.6) -- all used by sign.js
  - crypto (Node builtin) -- used by verify.js and sign.js via destructured import
- **Headline behaviors (this slice):** verify (HS256-verify) -> verify.js; decode-base64url + parse-jose-header -> decode.js
  (per DEC-WI510-S6-JWT-HS256-VERIFY-BINDING-001, DEC-WI510-S6-JWT-DECODE-BASE64URL-BINDING-001, DEC-WI510-S6-JWT-PARSE-JOSE-HEADER-BINDING-001).
- **Path decision:** Path A (published CJS tarball) -- inherits Slice 3 DEC-WI510-S3-FIXTURE-FULL-TARBALL-001
  and Slice 4 DEC-WI510-S4-FIXTURE-FULL-TARBALL-001.
- **Why pin 9.0.2:** Current latest dist-tag, auth0's stable line, plain CJS source shape
  (structurally simpler than Babel-transpiled validator-13.15.35), 10 runtime deps + 1 builtin
  exercise the engine's external-fan-out path (first WI-510 fixture to do so at this breadth).
- **WI:** WI-510 Slice 6, workflow `wi-510-s6-jsonwebtoken-bcrypt`.
```

### 4.2 `PROVENANCE.md` template — bcryptjs

```
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
```

---

## 5. Evaluation Contract — Slice 6 (per-entry shave of jsonwebtoken `verify`+`decode` and bcryptjs single-package atom)

This is the exact, executable acceptance target. A reviewer runs every check. "Ready for Guardian" is defined at §5.6.

### 5.1 Required tests

- **`pnpm --filter @yakcc/shave test`** — the full shave suite passes, including the existing `module-graph.test.ts` (Slice 1), `validator-headline-bindings.test.ts` (Slice 2), `semver-headline-bindings.test.ts` (Slice 3), `uuid-headline-bindings.test.ts` (Slice 4), `nanoid-headline-bindings.test.ts` (Slice 4) **with zero regressions**, plus the new jsonwebtoken and bcryptjs headline tests.
- **`pnpm --filter @yakcc/shave build`** and **`pnpm --filter @yakcc/shave typecheck`** — clean.
- **Workspace-wide `pnpm lint` (`turbo run lint`) and `pnpm typecheck` (`turbo run typecheck`)** — clean across all packages. Carry-over from Slices 2–4; `--filter`-scoped passing is necessary but not sufficient.
- **Per-entry headline tests** — TWO new test files:
  - `packages/shave/src/universalize/jsonwebtoken-headline-bindings.test.ts` — TWO `describe` blocks (`verify`, `decode`), each with sections A–F. Plus a compound interaction test at the end (real production sequence). The two issue-body headlines `decode-base64url` and `parse-jose-header` BOTH map to the `decode.js` shave (per §1.1); the `decode` `describe` covers both corpus query strings in its §F.
  - `packages/shave/src/universalize/bcryptjs-headline-bindings.test.ts` — ONE `describe` block (`bcryptjs-package-atom`), sections A–F. Both issue-body headlines (`hash`, `verify`) map to the same single-module shave; the §F asserts both corpus query strings retrieve the same atom merkle root with `combinedScore >= 0.70`.
  - Each `describe` is independent (no shared `beforeAll` across bindings) — Slices 2/3/4 per-entry isolation invariant carries forward.
- **Compound interaction tests** — at least one test per package exercising the real production sequence `shavePackage → collectForestSlicePlans → maybePersistNovelGlueAtom` end-to-end, mirroring the Slice 4 pattern. This is the load-bearing "real-path" check, not a unit-mocked one.

### 5.2 Required real-path checks

- **Per-headline real-path forest:** for each of the three entryPath shaves, `shavePackage(<fixture-root>, { registry, entryPath: <fixture-root>/<binding-path> })` produces a `ModuleForest` whose `moduleCount` falls inside the §3 range for that binding:
  - jsonwebtoken `verify` (`verify.js`): `moduleCount in [3, 12]`, `stubCount = 0` (or document the empirical non-zero count loudly per §3.6), `externalSpecifiers count >= 1` and ideally includes `jws`.
  - jsonwebtoken `decode` (`decode.js`): `moduleCount in [1, 2]`, `stubCount = 0`, `externalSpecifiers` includes `jws`.
  - bcryptjs (`dist/bcrypt.js`): `moduleCount in [1, 2]`, `stubCount = 0`, `externalSpecifiers` includes `crypto`.
  - The reviewer inspects `forest.nodes` and `forestStubs(forest)` to confirm `forest.nodes[0].filePath` ends in the expected entry file and that the external specifiers list captures the expected npm/builtin specifiers.
- **External-package foreign-leaf emission proven (the new property):** for jsonwebtoken `verify`, `forestModules(forest).flatMap(m => m.externalSpecifiers)` is non-empty AND includes at least one of `jws`, `crypto`, `ms`, `semver`. For jsonwebtoken `decode`, the list includes `jws`. For bcryptjs, the list includes `crypto`. This is the **first real-world WI-510 fixture asserting npm-package (not just Node-builtin) externalSpecifiers**. §5.6 criterion 12 is the explicit Slice 6 acceptance gate for this property.
- **bcryptjs single-module-package shape proven (the new property):** `forest.moduleCount == 1` for the bcryptjs shave (or `<= 2` to allow for resolver weirdness around the `index.js → dist/bcrypt.js` indirection). The implementer asserts the empirical value and the BFS path makes it explicit which file is the canonical atom (`dist/bcrypt.js` is the expectation). §5.6 criterion 13 is the explicit acceptance gate.
- **`combinedScore >= 0.70`** for **each** of the **five** corpus query strings (§F):
  - `cat1-jsonwebtoken-verify-001` (HS256-verify) — points at jsonwebtoken `verify.js` atom merkle root.
  - `cat1-jsonwebtoken-decode-base64url-001` — points at jsonwebtoken `decode.js` atom merkle root.
  - `cat1-jsonwebtoken-parse-jose-header-001` — points at the **same** jsonwebtoken `decode.js` atom merkle root (two corpus rows, one atom).
  - `cat1-bcryptjs-hash-001` — points at bcryptjs `dist/bcrypt.js` atom merkle root.
  - `cat1-bcryptjs-verify-001` — points at the **same** bcryptjs `dist/bcrypt.js` atom merkle root (two corpus rows, one atom).
  Measured via `findCandidatesByQuery` against an in-memory registry populated by the engine's own real-path `storeBlock` output. Each test uses `withSemanticIntentCard` (the Slice 2 helper, carried forward verbatim in Slices 3/4) with a behaviorText that mirrors each row's `corpus.json` query string. If `DISCOVERY_EVAL_PROVIDER=local` is absent so the quality block skips, **the slice is blocked, not ready** — reviewer must run with the local provider and paste the five scores.
- **Two-pass byte-identical determinism per headline:** for each of the three entryPath shaves, `shavePackage` is invoked twice with the same `entryPath`; `moduleCount`, `stubCount`, `forestTotalLeafCount`, BFS-ordered `filePath` list, `externalSpecifiers` (sorted), AND the sorted set of every leaf `canonicalAstHash` are byte-identical across passes (per-headline, not aggregated — same property Slices 2/3/4 assert).
- **Forest persisted via the real `storeBlock` path per headline:** for each of the three shaves, the slice plans from `collectForestSlicePlans` are iterated and each `NovelGlueEntry` flows through `maybePersistNovelGlueAtom`, not a `buildTriplet`-on-entry-source shortcut. Registry has `> 0` blocks after each shave's persist; the headline atom is retrievable. (Carry-over from Slices 2–4.)

### 5.3 Required authority invariants

- **The engine is used, not forked.** Slice 6 calls the landed `shavePackage` / `collectForestSlicePlans` / `module-resolver` exports verbatim. **No engine-source change in `packages/shave/src/universalize/**` (`recursion.ts`, `slicer.ts`, `module-resolver.ts`, `module-graph.ts`, `types.ts`, `stef.ts`, `variance-rank.ts`, `atom-test.ts`).** No new public API surface in `packages/shave/src/types.ts`.
- **B-scope predicate untouched and corroborated on real-world npm-fan-out.** `isInPackageBoundary` is unchanged. The 10 jsonwebtoken npm-dep edges + 1 builtin edge are correctly treated as B-scope external because they do not resolve to any path under the fixture root. Slice 6 must not introduce a parallel "is this a Node builtin?" or "is this a `lodash.*` package?" check.
- **One persist authority.** The forest → registry path uses the existing `maybePersistNovelGlueAtom` / `buildTriplet` / idempotent `storeBlock` primitives.
- **Public `types.ts` surface frozen-for-L5.** No public-surface change.
- **`corpus.json` is append-only.** Slice 6 appends **five** new `synthetic-tasks` entries (`cat1-jsonwebtoken-verify-001`, `cat1-jsonwebtoken-decode-base64url-001`, `cat1-jsonwebtoken-parse-jose-header-001`, `cat1-bcryptjs-hash-001`, `cat1-bcryptjs-verify-001`). No existing entry modified, no category list edit, no `discovery-eval-full-corpus.test.ts` harness change.
- **Fixture isolation.** The vendored sources live ONLY under `packages/shave/src/__fixtures__/module-graph/jsonwebtoken-9.0.2/` and `bcryptjs-2.4.3/`. Biome-ignored, outside `tsc`'s `.js` scope.
- **Per-entry isolation guarantee.** Each of the three entryPath shaves uses its own `shavePackage` call with its own `entryPath`. No shared `beforeAll` across the `verify` and `decode` describe blocks within the jsonwebtoken test file.
- **Predecessor fixtures untouched.** `validator-13.15.35/**`, `semver-7.8.0/**`, `uuid-11.1.1/**`, `nanoid-3.3.12/**`, `ms-2.1.3/**`, `circular-pkg/**`, `degradation-pkg/**`, `three-module-pkg/**` are read-only for Slice 6. Reviewer can spot-check with `git diff main -- packages/shave/src/__fixtures__/module-graph/` showing exactly two new sibling directories.
- **`vitest.config.ts` unchanged.** `testTimeout=30_000`, `hookTimeout=30_000`. The Slice 2 invariant `DEC-WI510-S2-NO-TIMEOUT-RAISE-001` carries forward.

### 5.4 Required integration points

- `packages/shave/src/__fixtures__/module-graph/jsonwebtoken-9.0.2/**` — vendored jsonwebtoken tarball + `PROVENANCE.md`. Required.
- `packages/shave/src/__fixtures__/module-graph/bcryptjs-2.4.3/**` — vendored bcryptjs tarball + `PROVENANCE.md`. Required.
- `packages/shave/src/universalize/jsonwebtoken-headline-bindings.test.ts` — new Slice 6 test file (two headline `describe` blocks + compound test). Required.
- `packages/shave/src/universalize/bcryptjs-headline-bindings.test.ts` — new Slice 6 test file (one `describe` block + compound test). Required.
- `packages/registry/test/discovery-benchmark/corpus.json` — append five `synthetic-tasks` entries:
  - `cat1-jsonwebtoken-verify-001` — query: "Verify a JSON Web Token signature using the HS256 HMAC-SHA256 algorithm and return the decoded payload"
  - `cat1-jsonwebtoken-decode-base64url-001` — query: "Decode the three base64url-encoded sections of a JSON Web Token into header, payload, and signature parts"
  - `cat1-jsonwebtoken-parse-jose-header-001` — query: "Parse the JOSE header of a JSON Web Token to extract the alg and kid fields for key selection"
  - `cat1-bcryptjs-hash-001` — query: "Compute a bcrypt password hash with a configurable cost factor producing a salted one-way hash for credential storage"
  - `cat1-bcryptjs-verify-001` — query: "Compare a plaintext password against a stored bcrypt hash using constant-time comparison to verify authentication"
  Append-only. Required.
- `plans/wi-510-s6-jsonwebtoken-bcrypt.md` — this plan. Owner.
- `plans/wi-510-shadow-npm-corpus.md` — one-paragraph status update only (mark Slice 6 as in-progress / landed). No permanent-section edits. Allowed.
- `tmp/wi-510-s6/**` — planner scratch (tarballs + extracted `package/` trees). Implementer may use the same directory for re-acquisition; not part of the commit.

### 5.5 Forbidden shortcuts

- **No whole-package shave path.** Calling `shavePackage(<jsonwebtoken-fixture-root>, { registry })` without an `entryPath` override is **forbidden** — same as Slices 2–4. Every `shavePackage` invocation in the new tests must pass an explicit `entryPath` pointing at one of the three headline files. For bcryptjs the `entryPath` is `dist/bcrypt.js` (the canonical entry per `package.json#main → index.js → require("./dist/bcrypt.js")`); the test does NOT call `shavePackage(<bcryptjs-fixture-root>)` without an `entryPath`.
- **No `vitest.config.ts` timeout raise.** Per-`it()` overrides bounded to 120 s with measurement-citing comments. >120 s = stop-and-report.
- **No shared `beforeAll` across the bindings within the jsonwebtoken test file.**
- **No engine-source change in `packages/shave/src/universalize/**`.** Engine is frozen after Slice 1. If an engine gap surfaces (most likely class: issue #576's class-arrow ArrowFunction-in-class-body gap surfacing in some jsonwebtoken transitive; or the bcryptjs UMD IIFE causing an unexpected throw in `decompose()`), it is filed as a separate bug against the engine and is **not** patched in-slice. Slice 6 stops and reports.
- **No single-source-`buildTriplet` shortcut for the persist check.** §5.2's `combinedScore` and the §5.1 per-headline persist check must run through the real `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path.
- **No hand-authored `jsonwebtoken` or `bcryptjs` atoms.** The atoms are the engine's output from vendored source. (Sacred Practice 12.)
- **No `discovery-eval-full-corpus.test.ts` / registry-schema edit.** Constitutional; Slice 6 only appends `synthetic-tasks` rows.
- **No silent `maxModules` truncation.** Each per-entry shave's expected `moduleCount` is small (§3, max ~12 for verify). If any headline test sees `moduleCount` approaching `maxModules` (default 500), that indicates a B-scope leak or fixture-vendoring error. Implementer stops and reports. Do not raise `maxModules` to hide the symptom.
- **No non-determinism.** Each per-headline subgraph must be two-pass byte-identical. `readdir`-order / `Map`-iteration / absolute-path leakage in any helper added by Slice 6 is forbidden.
- **No public `types.ts` surface break.**
- **No reach into predecessor fixtures.** `validator-13.15.35/`, `semver-7.8.0/`, `uuid-11.1.1/`, `nanoid-3.3.12/`, `ms-2.1.3/`, `circular-pkg/`, `degradation-pkg/`, `three-module-pkg/` are read-only for Slice 6.
- **No new fixture vendoring beyond `jsonwebtoken-9.0.2` and `bcryptjs-2.4.3`.** Slices 5, 7, 8, 9 (date-fns, lodash, zod/joi, p-limit+p-throttle) remain out of scope.
- **No `void (async () => {...})()` patterns in test files.** Per the Slice 3 lesson learned from PR #566: the shave engine cannot atomize `VoidExpression` of an IIFE. Test orchestration must use plain `await`-in-`async`-`it()`. If parallelism is desired, use `queueMicrotask` per the same lesson.
- **No skipping `biome format --write` before commit.** Per the Slice 3 lesson learned from PR #570: local turbo cache can hide format violations that CI catches. Run `pnpm biome format --write packages/shave/src/universalize/jsonwebtoken-headline-bindings.test.ts packages/shave/src/universalize/bcryptjs-headline-bindings.test.ts` (and any other touched files) before staging.
- **No `bcrypt` (native) vendoring.** The substitution to `bcryptjs` is constitutional per `DEC-WI510-S6-BCRYPT-USE-BCRYPTJS-001`.
- **No `Closes #510`** in the PR description. Slice 6 of 9; use `Refs #510 (Slice 6 of 9)` only.
- **No assertion against planner-estimated `moduleCount` without empirical verification.** Per the PR #571 / issue #576 lesson: the planner's estimates are anchors, not certainties. The implementer **runs the shave first** to discover the actual `moduleCount` / `externalSpecifiers` / `stubCount`, then writes assertions that honor the empirical output. If the empirical value falls outside the §3 range, the implementer either widens the assertion with a citation comment OR investigates the divergence (engine gap, fixture error). The §3 ranges are deliberately wide for the same reason.

### 5.6 Ready-for-Guardian definition (Slice 6)

Slice 6 is ready for Guardian when **all** of the following are simultaneously true on the current HEAD:

1. `pnpm --filter @yakcc/shave build && pnpm --filter @yakcc/shave typecheck && pnpm --filter @yakcc/shave test` all green, with **zero regressions** in `module-graph.test.ts`, `validator-headline-bindings.test.ts`, `semver-headline-bindings.test.ts`, `uuid-headline-bindings.test.ts`, `nanoid-headline-bindings.test.ts`, and the rest of the existing shave suite.
2. **Workspace-wide** `pnpm lint` (`turbo run lint`) and `pnpm typecheck` (`turbo run typecheck`) are clean across all packages — reviewer pastes the output (this was the CI failure pattern on Slice 1's PR; package-scoped passing is necessary but not sufficient).
3. **Per-headline measurement evidence in the PR body and the plan status update**: for each of the three entryPath shaves (`jsonwebtoken/verify`, `jsonwebtoken/decode`, `bcryptjs/dist/bcrypt.js`), the implementer records `moduleCount`, `stubCount`, `forestTotalLeafCount`, the BFS-ordered `filePath` list (so the reviewer can verify the subgraph contains only transitively-reachable modules), the **merkle root of the headline binding's atom** (the entry-module's persisted atom root), the **externalSpecifiers list** (proving npm-dep + Node-builtin foreign leaves are correctly captured), and the wall-clock time of that headline's `shavePackage` invocation. The §3 estimates are the reviewer's anchor for "does this look right?" — but the empirical values are the source of truth.
4. Each of the three entryPath shaves produces a `ModuleForest` whose nodes are the headline's transitive in-package subgraph — reviewer confirms via §3 inspection that no unrelated package behavior modules are present and the engine emitted what the implementer empirically asserts.
5. **Each per-headline test completes in <120 seconds wall-clock** with the default vitest config (no `testTimeout`/`hookTimeout` raise). A test exceeding 120 s — even with a per-`it()` override — is a blocking flag, not a passing condition. Cumulative §A–§E wall-clock <5 minutes; cumulative including §F (with `DISCOVERY_EVAL_PROVIDER=local`) <8 minutes. Slice 6's subgraphs are the smallest of any landed/planned slice, so a >120 s headline is a loud red flag.
6. Two-pass byte-identical determinism per headline.
7. `combinedScore >= 0.70` for **each** of the **five** corpus query strings, measured via `findCandidatesByQuery` against a registry populated by the engine's own real-path `storeBlock` output — quality block(s) **ran (not skipped)**, reviewer pastes the five per-query scores. The two `decode`-pointing rows (`cat1-jsonwebtoken-decode-base64url-001`, `cat1-jsonwebtoken-parse-jose-header-001`) both retrieve the **same** atom merkle root; the two `bcryptjs`-pointing rows (`cat1-bcryptjs-hash-001`, `cat1-bcryptjs-verify-001`) both retrieve the **same** atom merkle root. If `DISCOVERY_EVAL_PROVIDER=local` is absent so the quality block skips, the slice is **blocked, not ready**.
8. Each headline's forest is persisted via the **real** `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path — not the single-source-`buildTriplet` shortcut.
9. `corpus.json` carries exactly the five appended `synthetic-tasks` entries (`expectedAtom: null`), no existing entry modified, and `discovery-eval-full-corpus.test.ts` still passes.
10. `packages/shave/vitest.config.ts` is unchanged.
11. **Predecessor fixtures untouched.** Reviewer spot-checks `git diff main -- packages/shave/src/__fixtures__/module-graph/{validator-13.15.35,semver-7.8.0,uuid-11.1.1,nanoid-3.3.12,ms-2.1.3,circular-pkg,degradation-pkg,three-module-pkg}/` shows no changes.
12. **External-package foreign-leaf emission proven on real-world npm fan-out.** For jsonwebtoken `verify`, reviewer confirms `forestModules(forest).flatMap(m => m.externalSpecifiers)` is non-empty AND includes at least one of `jws`, `crypto`, `ms`, `semver`. For jsonwebtoken `decode`, the list includes `jws`. For bcryptjs, the list includes `crypto`. This is the load-bearing real-world npm-package-external corroboration the slice exists to deliver, complementing Slice 4's Node-builtin-only case.
13. **bcryptjs single-module-package shape proven.** `forest.moduleCount` for the bcryptjs shave is `1` (or `<= 2` if resolver indirection through `index.js` lands), the BFS path resolves to `dist/bcrypt.js`, and the persisted atom merkle root is treated as the canonical bcryptjs-package-atom (one atom, two corpus rows). This is the load-bearing real-world single-module-package corroboration the slice exists to deliver.
14. New `@decision` annotations are present at the Slice 6 modification points (the two test files; the two `PROVENANCE.md` files cite the DEC IDs in §8). New DEC IDs per §8.

---

## 6. Scope Manifest — Slice 6 (per-entry shave of jsonwebtoken `verify`+`decode` and bcryptjs package atom)

**Allowed paths (implementer may touch):**
- `packages/shave/src/__fixtures__/module-graph/jsonwebtoken-9.0.2/**` — vendored jsonwebtoken fixture + `PROVENANCE.md`. Pure tarball acquisition + extraction + copy.
- `packages/shave/src/__fixtures__/module-graph/bcryptjs-2.4.3/**` — vendored bcryptjs fixture + `PROVENANCE.md`. Pure tarball acquisition + extraction + copy.
- `packages/shave/src/universalize/jsonwebtoken-headline-bindings.test.ts` — new Slice 6 test file (two `describe` blocks + compound test).
- `packages/shave/src/universalize/bcryptjs-headline-bindings.test.ts` — new Slice 6 test file (one `describe` block + compound test).
- `packages/registry/test/discovery-benchmark/corpus.json` — append five `synthetic-tasks` headline query entries. Append-only.
- `plans/wi-510-s6-jsonwebtoken-bcrypt.md` — this plan. Owner.
- `plans/wi-510-shadow-npm-corpus.md` — one-paragraph status update only. No permanent-section edits.
- `tmp/wi-510-s6/**` — scratch (tarballs + extracted packages); not committed.

**Required paths (implementer MUST modify):**
- `packages/shave/src/__fixtures__/module-graph/jsonwebtoken-9.0.2/**` — the vendored jsonwebtoken fixture tree (~15 files) + `PROVENANCE.md`.
- `packages/shave/src/__fixtures__/module-graph/bcryptjs-2.4.3/**` — the vendored bcryptjs fixture tree (~28 files) + `PROVENANCE.md`.
- `packages/shave/src/universalize/jsonwebtoken-headline-bindings.test.ts` — the new jsonwebtoken test file.
- `packages/shave/src/universalize/bcryptjs-headline-bindings.test.ts` — the new bcryptjs test file.
- `packages/registry/test/discovery-benchmark/corpus.json` — the five `synthetic-tasks` query entries.

**Forbidden touch points (must not change without re-approval):**
- `packages/shave/vitest.config.ts` — `testTimeout=30_000` / `hookTimeout=30_000` defaults carry forward `DEC-WI510-S2-NO-TIMEOUT-RAISE-001` verbatim.
- `packages/shave/src/universalize/recursion.ts`, `slicer.ts`, `module-resolver.ts`, `module-graph.ts`, `types.ts`, `stef.ts`, `variance-rank.ts`, `atom-test.ts` — the entire engine surface. Frozen after Slice 1.
- `packages/shave/src/universalize/validator-headline-bindings.test.ts` — Slice 2 test file.
- `packages/shave/src/universalize/semver-headline-bindings.test.ts` — Slice 3 test file.
- `packages/shave/src/universalize/uuid-headline-bindings.test.ts` — Slice 4 test file.
- `packages/shave/src/universalize/nanoid-headline-bindings.test.ts` — Slice 4 test file.
- `packages/shave/src/universalize/module-graph.test.ts` — Slice 1 engine tests.
- `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/**` — Slice 2 fixture.
- `packages/shave/src/__fixtures__/module-graph/semver-7.8.0/**` — Slice 3 fixture.
- `packages/shave/src/__fixtures__/module-graph/uuid-11.1.1/**` — Slice 4 fixture.
- `packages/shave/src/__fixtures__/module-graph/nanoid-3.3.12/**` — Slice 4 fixture.
- `packages/shave/src/__fixtures__/module-graph/ms-2.1.3/**`, `circular-pkg/**`, `degradation-pkg/**`, `three-module-pkg/**` — Slice 1 fixtures.
- `packages/shave/src/types.ts` — frozen-for-L5 public surface.
- `packages/shave/src/persist/**` — used by the test; not modified.
- `packages/shave/src/cache/**`, `packages/shave/src/intent/**` — used by the test (existing `withStubIntentCard` / `withSemanticIntentCard` helpers consume `sourceHash`, `STATIC_MODEL_TAG`, `STATIC_PROMPT_VERSION`); not modified.
- `packages/ir/**`, `packages/contracts/**` — constitutional (`validateStrictSubset`, `blockMerkleRoot`, `canonicalAstHash`, embedding providers).
- `packages/registry/src/schema.ts`, `packages/registry/src/storage.ts`, `packages/registry/src/discovery-eval-helpers.ts`, `packages/registry/src/discovery-eval-full-corpus.test.ts` — constitutional registry surface and discovery-eval harness.
- `packages/seeds/src/blocks/**` and all existing seed atoms — Slice 6 produces atoms via the engine; hand-authors nothing.
- `packages/hooks-*/**`, `packages/compile/**`, `bench/**`, `examples/**`, `.worktrees/**` — adjacent lanes (#508, #512, benches) outside Slice 6's scope.
- `biome.json` — already covers `__fixtures__/module-graph/**`; no change needed.
- `MASTER_PLAN.md` — permanent sections untouched.
- All other `plans/*.md` files — Slice 6 owns only `plans/wi-510-s6-jsonwebtoken-bcrypt.md` and the one-paragraph status update on `plans/wi-510-shadow-npm-corpus.md`. **Especially `plans/wi-510-s5-date-fns.md` — the Slice 5 parallel sibling lane must not be touched.**

**Expected state authorities touched:**
- **Shave module-graph engine** — canonical authority: the landed `shavePackage()` / `collectForestSlicePlans()` in `module-graph.ts`, `decompose()` in `recursion.ts`, `slice()` in `slicer.ts`. Slice 6 **calls** these with an explicit `entryPath` option per headline; does not fork, modify, or extend them.
- **Module resolver — B-scope predicate** — canonical authority: `isInPackageBoundary()` and `resolveSpecifier()` in `module-resolver.ts`. Slice 6 **exercises** the predicate on 11 distinct external specifiers (10 npm packages + 1 Node builtin) — the first WI-510 fixture at this breadth.
- **Atom identity + registry block store** — canonical authority: `blockMerkleRoot()` (`@yakcc/contracts`) and idempotent `storeBlock()` (`@yakcc/registry`), reached via `maybePersistNovelGlueAtom` / `buildTriplet`. Slice 6 produces three headline-atom-rooted subgraphs (one of which — bcryptjs — is a single-module-package atom).
- **Discovery-eval query corpus** — canonical authority: `packages/registry/test/discovery-benchmark/corpus.json`. Slice 6 appends five `synthetic-tasks` entries.
- **Vitest test-execution discipline** — canonical authority: `packages/shave/vitest.config.ts`. Slice 6 does not modify; per-entry shave size is tiny (§3 max ~12 modules) so default `testTimeout=30_000` is more than sufficient.
- **Fixture directory** — canonical authority: `packages/shave/src/__fixtures__/module-graph/`. Slice 6 adds two sibling directories (`jsonwebtoken-9.0.2/` and `bcryptjs-2.4.3/`) next to the existing eight.

---

## 7. Slicing / dependency position

Slice 6 is a single work item. Dependencies: **Slice 1 (landed `37ec862` on `main`)**, **Slice 2 (landed `aeec068` on `main`)**, **Slice 3 (landed `b83d46f` on `main`)**, and **Slice 4 (landed `5d8bde1` on `main`)** for pattern continuity (Slice 6 imports no Slice 2/3/4 source, but its test files are structurally siblings-by-copy of `uuid-headline-bindings.test.ts` and `nanoid-headline-bindings.test.ts`).

**Parallel lane:** Slice 5 (date-fns) is being planned simultaneously on a sibling workflow. Slice 5 and Slice 6 are independent — disjoint fixture directories (date-fns vs jsonwebtoken+bcryptjs), disjoint test files, disjoint corpus rows. The parallelism is safe.

Downstream consumers: none currently named. The shadow-npm corpus expansion (#510) listing jsonwebtoken+bcrypt as Slice 6 is the proximate consumer; the triad (#508, #512) currently focuses on the validator headline bindings — jsonwebtoken+bcryptjs atoms are corpus completeness, not the next demo binding.

- **Weight:** **M** (two small fixtures vendored + three small entryPath shaves + test orchestration + first real-world npm-fan-out corroboration + first real-world single-module-package corroboration + measurement-evidence discipline). Slightly heavier than Slice 4 because the jsonwebtoken external-fan-out is structurally novel and the bcryptjs single-module-package shape requires careful empirical assertion.
- **Gate:** **`review`** (no engine source change; no public-surface change; no constitutional file touched).
- **Landing policy:** default grant — branch checkpoint allowed, reviewer handoff allowed, autoland allowed once `ready_for_guardian`, `no_ff` merge.

---

## 8. Decision Log Entries (new — to be recorded at implementation)

| DEC-ID | Title | Rationale summary |
|--------|-------|-------------------|
| `DEC-WI510-S6-PER-ENTRY-SHAVE-001` | Slice 6 shaves jsonwebtoken verify+decode + bcryptjs package atom per-entry, not the whole packages | Inherits the structural pattern from Slices 2–4. jsonwebtoken: two `shavePackage({ entryPath })` calls (`verify.js`, `decode.js`) producing 1–12-module subgraphs (§3 estimates). bcryptjs: one `shavePackage({ entryPath: dist/bcrypt.js })` call producing a 1-module package-atom. All three are comfortable inside the default 30 s `testTimeout`. Broader coverage (jsonwebtoken's `sign`, bcryptjs's individual methods) is deferred to a later production-corpus initiative the master plan §5 reserves. |
| `DEC-WI510-S6-BCRYPT-USE-BCRYPTJS-001` | Slice 6 substitutes `bcryptjs@2.4.3` for the issue body's `bcrypt` | Native `bcrypt` ships precompiled `.node` binaries the shave engine cannot decompose (the engine processes JS AST via ts-morph). `bcryptjs` is the canonical pure-JS implementation with an identical public API — `bcrypt.hashSync(s, salt)`, `bcrypt.compareSync(s, hash)`, etc. The substitution is honest about what the engine can atomize. A registry alias (`bcrypt` → `bcryptjs`-atom) is a follow-on concern when `#508`'s import-intercept hook fires on `import bcrypt from 'bcrypt'` in user code. Alternatives rejected: (a) vendor bcrypt's JS layer only — produces a dishonest atom that claims behavior it cannot deliver; (b) defer bcrypt entirely — under-delivers the master-plan slice ordering. |
| `DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001` | bcryptjs `hash` and `verify` resolve to a single-module package atom (`dist/bcrypt.js`) | bcryptjs's `index.js` is a 1-line shim (`module.exports = require("./dist/bcrypt.js")`); `dist/bcrypt.js` is a 1,379-line UMD IIFE wrapping the entire library in `(function(global, factory) { ... }(this, function() { var bcrypt = {}; ... return bcrypt; }))`. No internal `require()` edges. Every reasonable `entryPath` produces a 1-module subgraph. The two issue-body headlines `hash` and `verify` are co-housed inside the same `bcrypt` namespace inside the same file — per-entry decomposition gives no granularity over per-package decomposition. The corpus carries two separate query rows; both retrieve the same atom merkle root via embedded query similarity. This is the first WI-510 fixture with a single-module-package shape. |
| `DEC-WI510-S6-BCRYPTJS-VERSION-PIN-001` | Pin to `bcryptjs@2.4.3` (most-installed 2.x line; 3.x exists but is newer with the same UMD IIFE shape) | bcryptjs@2.4.3 has ~12M weekly downloads on the 2.x line (vs ~0.5M on 3.x as of early 2026); the 2.x line is widely deployed and stable. Zero npm dependencies. Same UMD IIFE bundle shape as 3.x (no structural change). A follow-on initiative may add bcryptjs@3 once the corpus demands a refresh. |
| `DEC-WI510-S6-JWT-VERSION-PIN-001` | Pin to `jsonwebtoken@9.0.2` (current `latest` dist-tag) | 9.0.2 is the current `latest` dist-tag (verified 2026-05-16). auth0's stable line. Plain modern Node.js CJS source (structurally the same as Slice 3's semver fixture — no Babel transpile). |
| `DEC-WI510-S6-JWT-HS256-VERIFY-BINDING-001` | Issue-body `HS256-verify` resolves to `verify.js`'s `verify(token, secret, options)` | jsonwebtoken's `verify` function dispatches on `options.algorithms` — HS256 is one of the supported algorithms it handles internally via `jws.verify`. There is no separate `HS256-verify` file. The issue body's `HS256-verify` is the natural-language description of "verify a JWT using HS256"; the shaved atom is the engine's output for `verify.js`. The algorithm selection happens at call time, not at the file/binding level. |
| `DEC-WI510-S6-JWT-DECODE-BASE64URL-BINDING-001` | Issue-body `decode-base64url` resolves to `decode.js`'s `decode(token, options)` | jsonwebtoken does not export a standalone `base64url` decoder. Its base64url decoding lives inside the `jws` dependency (external — emitted as `externalSpecifiers`). The user-facing way to "decode base64url JOSE parts" is `decode(token)`, which returns the parsed `{header, payload, signature}` after internal `jws.decode`. The atomized graph captures the user-facing entry point. |
| `DEC-WI510-S6-JWT-PARSE-JOSE-HEADER-BINDING-001` | Issue-body `parse-jose-header` resolves to the SAME `decode.js` source file | `decode(token, {complete: true}).header` exposes the parsed JOSE header. Same source file as `decode-base64url`. Two issue-body headlines collapse to one source file and one atom. The corpus carries two separate query rows; both retrieve the same atom merkle root via embedded query similarity (the atom's source mentions both base64url decoding and the header field). |
| `DEC-WI510-S6-FIXTURE-FULL-TARBALL-001` | Vendor the full `jsonwebtoken-9.0.2` and `bcryptjs-2.4.3` published tarballs verbatim | Inherits Slice 3 rationale (`DEC-WI510-S3-FIXTURE-FULL-TARBALL-001`) and Slice 4 rationale (`DEC-WI510-S4-FIXTURE-FULL-TARBALL-001`): honest about what `node_modules` contains, lets `isInPackageBoundary` scope traversal at zero cost for unreferenced files (bcryptjs's `dist/bcrypt.min.js`, `bin/`, `tests/`, `externs/`, etc.; jsonwebtoken's `README.md`, `LICENSE`, `package.json`), avoids the maintenance burden of hand-trimming. Both fixtures live under `packages/shave/src/__fixtures__/module-graph/` and are biome-ignored. |
| `DEC-WI510-S6-NPM-EXTERNAL-FAN-OUT-001` | jsonwebtoken `verify` exercises the engine's `externalSpecifiers` path on multiple npm packages + 1 Node builtin (`jws`, `crypto`, `ms`, `semver`) | First real-world WI-510 fixture exercising the engine's foreign-leaf emission on multiple distinct npm-package external specifiers (Slice 4 covered only the Node-builtin case via `crypto`). The 10 unique npm-dep specifiers across the jsonwebtoken package (`ms`, `jws`, `semver`, 6 × `lodash.*`) all become entries in `ModuleForestNode.externalSpecifiers` via the same B-scope predicate that handled Slice 4's `crypto` builtin. §5.6 criterion 12 is the explicit Slice 6 acceptance gate for this property. If `externalSpecifiers` is empty for `verify`, that is a Slice 1 engine gap — file a bug, do NOT patch. |

These DECs are recorded in `@decision` annotation blocks at the Slice 6 modification points (the two test files primarily; the two `PROVENANCE.md` files cite the DEC IDs). If the operator wants them in the project-level log, they are appended to `MASTER_PLAN.md` `## Decision Log` as a separate doc-only change — not part of this slice.

---

## 9. Risks

| Risk | Mitigation |
|------|-----------|
| Issue #576's class-arrow-gap surfaces in some jsonwebtoken transitive (`lib/validateAsymmetricKey.js` uses object-literal lookup tables but no class-arrow methods; the risk is low but possible if some module uses a pattern the engine cannot decompose). `moduleCount` may be smaller than §3 estimates. | The §3 ranges are deliberately wide (`verify in [3, 12]`). The implementer **asserts what the engine actually emits** (per PR #571 lesson) — runs the shave first, then writes assertions that honor the empirical output. If `moduleCount < 3`, the implementer investigates (which transitive collapsed? Is it the same #576 class) and documents in the test file with a citation comment. The slice does NOT patch the engine to fix the gap. |
| The bcryptjs UMD IIFE pattern `(function(global, factory) { ... })(this, function () { var bcrypt = {}; ... return bcrypt; })` is structurally non-trivial for `decompose()`. The outer call is a `CallExpression` whose callee is a `FunctionExpression`; the inner function body has dozens of `function X() {...}` declarations + `bcrypt.X = ...` assignments. `decompose()` may throw (silently producing a stub) or atomize the whole IIFE as one giant atom or split it into N atoms — the implementer cannot predict without running it. | The implementer runs the shave first to discover the empirical `forestTotalLeafCount` (could be `1` if one giant atom, could be `N` if split). The test asserts `forest.moduleCount == 1` (always — the IIFE is one file) and `forestTotalLeafCount >= 1`, then records the actual leaf count in measurement evidence. If `decompose()` throws so the engine emits a stub (`stubCount > 0`), that is a stop-and-report engine-gap finding: file a Slice 1 bug ("decompose can't handle UMD IIFE wrapper") and document in §5.6 evidence; do NOT patch in-slice. The reviewer evaluates whether the resulting atom shape is still useful for discovery (the source string still contains "bcrypt.hashSync" and "bcrypt.compareSync", which is what the embedder needs for `combinedScore` quality). |
| jsonwebtoken `verify.js`'s `combinedScore` for HS256 query may be diluted by the fact that the same `verify` function handles RS256/ES256/PS256 algorithms too — the embedded source mentions all algorithms equally. | Same mitigation as Slice 2 §9 / Slice 3 §9 / Slice 4 §9. The `withSemanticIntentCard` helper takes an explicit `behaviorText` that mirrors the corpus query string; Slice 6 reuses it. The HS256-specific corpus query string mentions "HS256" and "HMAC-SHA256" — strong signal. If under-scores, extend `semanticHints` with domain-specific keyword phrases ("symmetric secret", "HMAC verification", "JWT signature check"). Reviewer escalates only if even with semantic hints the score stays <0.70 — that is a genuine quality finding, not a Slice 6 design failure. |
| The two `decode`-pointing corpus rows (`decode-base64url`, `parse-jose-header`) both retrieve the same atom — if the embedder ranks the atom highly for ONE query but not the OTHER, one of the two queries fails the 0.70 floor. | The `decode.js` source is short (~30 lines) and explicitly handles both behaviors: `jws.decode(jwt)` returns `{header, payload, signature}`. The embedder should rank both queries highly against this single atom because both behaviors are in the source. If one query under-scores, the implementer extends that query's `semanticHints` independently. The two queries are corpus-distinct rows; their `combinedScore` independence is the embedder's responsibility, not a Slice 6 design failure. |
| The two `bcryptjs` corpus rows (`hash`, `verify`) both retrieve the same single-module atom — the `combinedScore` for "hash a password" and "compare a password against a hash" against the same 1,379-line atom may dilute one query if the embedder picks up too many irrelevant strings (Blowfish constants, base64 alphabet, randomness fallback). | The atom's source contains `bcrypt.hashSync`, `bcrypt.compareSync`, `bcrypt.hash`, `bcrypt.compare`, plus extensive JSDoc describing each method — strong signal for both queries. If one query under-scores, the implementer extends `semanticHints` with bcrypt-specific keyword phrases ("password hashing", "salt rounds", "constant-time comparison"). Reviewer escalates only if even with semantic hints both queries don't clear 0.70 — that is a genuine quality finding that may prompt a future engine-fix for finer-grained single-file atomization. |
| TWO fixtures vendored in one slice (15 + 28 files = 43 total) may double the chance of a vendoring mistake. | Implementer follows Slices 3/4 step-by-step (download tarball, verify SHA1, extract, copy contents, author PROVENANCE.md, verify biome doesn't complain). §5.6 criterion 11 explicitly checks predecessor fixtures are untouched. Reviewer spot-checks `git diff main -- packages/shave/src/__fixtures__/module-graph/` to confirm exactly two new sibling directories. |
| Implementer reaches for `void (async () => {...})()` IIFE pattern in test orchestration and hits the VoidExpression atomization gap from PR #566. | §5.5 forbids `void (async () => {...})()` patterns explicitly. All test orchestration uses plain `await`-in-`async`-`it()`. If parallelism is genuinely needed, use `queueMicrotask` per the standing constraint. |
| Implementer skips `biome format --write` before committing → local turbo cache hides format violations → CI fails on the PR. | §5.5 explicitly requires `pnpm biome format --write` on the two new test files before staging. Per Slice 3 lesson learned (PR #570 had this exact failure mode). |
| The five `corpus.json` entries fail the `discovery-eval-full-corpus.test.ts` per-category invariants (≥8-per-category, positive+negative balance). | `cat1` is well-populated with ~24 existing entries (10 original + 4 validator + 4 semver + 3 uuid + 1 nanoid + earlier baseline rows). Appending 5 more puts cat1 at ~29 entries; the ≥8 invariant is comfortably satisfied. The positive+negative balance invariant applies to entries with `expectedAtom` — since all five new entries have `expectedAtom: null` (`synthetic-tasks`), they are neither positive nor negative for that balance check (consistent with Slices 2/3/4). |
| Two corpus rows pointing at the same atom merkle root is novel — the discovery-eval harness may not have handled this case before. | The harness treats each corpus row independently — it runs `findCandidatesByQuery` per row, sorts candidates, and checks if the candidate set contains a `combinedScore >= 0.70` candidate. Two rows pointing at the same atom is no different from two rows pointing at different atoms; the harness doesn't know or care about row-to-atom uniqueness. If the harness DOES surface a bug here (e.g. dedup that drops one row), that is a discovery-eval bug to file separately — Slice 6 records the evidence and stops. |
| Parallel Slice 5 (date-fns) workflow modifies `plans/wi-510-shadow-npm-corpus.md`'s status section simultaneously, causing a merge conflict on the status update paragraph. | The Slice 6 status update is a single appended paragraph at the bottom of the status section; Slice 5's update is structurally identical. If both PRs land in close sequence, one PR's status paragraph rebases cleanly on top of the other's. The implementer handles the rebase mechanically if it surfaces — both slices add ONE paragraph and edit no permanent sections. |

---

## 10. What This Plan Does NOT Cover (Non-Goals)

- **jsonwebtoken's `sign` headline.** The issue body names HS256-verify, decode-base64url, parse-jose-header — not sign. A separate slice may add `sign.js` once the corpus demands it.
- **Native `bcrypt` package.** Substituted to `bcryptjs` per `DEC-WI510-S6-BCRYPT-USE-BCRYPTJS-001`. A `bcrypt` → `bcryptjs`-atom registry alias is a follow-on concern.
- **bcryptjs's individual methods as separate atoms.** Per `DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001`, the single-module-package shape means `hash` and `verify` share one atom. Finer-grained atomization would require an engine extension for splitting single-file packages into per-method atoms — out of scope.
- **A whole-package shave path.** Forbidden — §5.5.
- **Any engine-source change in `packages/shave/src/universalize/**`.** Engine frozen after Slice 1.
- **Slices 5, 7, 8, 9 graduated fixtures** (date-fns, lodash, zod/joi, p-limit+p-throttle). Out of scope. Slice 5 is being planned in parallel on a sibling workflow.
- **`vitest.config.ts` adjustments.** Forbidden touch point.
- **`MASTER_PLAN.md` initiative registration.** Doc-only slice the orchestrator dispatches separately if/when the user wants it.
- **The import-intercept hook (`#508`).** Separate WI; Slice 6 produces the headline-binding atoms in the corpus, `#508` Slice 2 already shipped with validator as the demo binding.
- **The B10 bench (`#512`).** Separate WI; jsonwebtoken+bcryptjs atoms are corpus completeness, not the demo path.
- **The shave engine's ArrowFunction-in-class-body gap (#576).** Tracked separately as a Slice 1 engine concern. Slice 6 honors the gap by widening §3 ranges and asserting empirical output.

---

*End of Slice 6 plan — per-entry shave of `verify` + `decode` (jsonwebtoken headline bindings) + single-module package atom (bcryptjs `hash` + `verify`) per #510 Slice 6 of 9.*
