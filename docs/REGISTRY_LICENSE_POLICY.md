# Registry License Policy

> Canonical license policy for atoms accepted into the global registry
> hosted at `registry.yakcc.com`. The policy is enforced in code at
> `packages/shave/src/license/gate.ts`; this document is the human-readable
> companion. **Code is truth — when in doubt, the code wins.**

---

## Status

- **v0.5 launch.** This is the initial license policy as of issue #371 (WI-V0.5-GLOBAL-REGISTRY).
- **DEC-V0.5-GLOBAL-REGISTRY-LICENSE-DOC-SHAPE-001** captures the doc structure decision
  (standalone doc in `docs/`, cross-linked from `FEDERATION.md`, code-derived not
  hand-maintained independently).

---

## Accepted licenses (SPDX identifiers)

Eight entries, matching the `AcceptedLicense` union in
`packages/shave/src/license/types.ts`. All are permissive and impose no
downstream redistribution requirements.

| SPDX identifier | Common name | Rationale |
|---|---|---|
| `MIT` | MIT License | Universally understood permissive baseline; no copyleft, attribution only. |
| `Apache-2.0` | Apache License 2.0 | Permissive with explicit patent grant; widely used in enterprise software. |
| `BSD-2-Clause` | 2-Clause BSD | Minimal attribution requirement; well-understood redistribution semantics. |
| `BSD-3-Clause` | 3-Clause BSD (Modified BSD) | Same as 2-clause plus non-endorsement clause; equivalent redistribution profile. |
| `ISC` | ISC License | Functionally equivalent to MIT; common in Node.js ecosystem (`npm` default). |
| `0BSD` | Zero-Clause BSD | No attribution required; maximally permissive BSD variant. |
| `Unlicense` | The Unlicense | Explicit public-domain dedication; yakcc's own code ships under this. |
| `public-domain` | Public domain (non-SPDX) | Detected from public-domain dedication phrases in source; normalized to this form. |

Any package whose detected SPDX identifier is NOT in this table is rejected
by the gate, regardless of how permissive the license may appear. If a new
license warrants acceptance, follow the process in the
[Adding a new accepted license](#adding-a-new-accepted-license) section below.

---

## Rejected licenses

### Copyleft (rejected for downstream-redistribution compatibility)

Copyleft licenses impose redistribution obligations on derivative works. Because
yakcc atoms are composed into downstream programs, accepting copyleft-licensed
atoms would propagate those obligations to every downstream consumer of the
registry. The registry accepts **only permissive licenses** to preserve freedom
of use at every deployment level (F0 through F4).

| Rejected identifier / prefix | Family | Notes |
|---|---|---|
| `GPL-*` (any version) | GNU General Public License | Strong copyleft; requires derivative works to be distributed under GPL. |
| `AGPL-*` (any version) | GNU Affero GPL | Like GPL, plus network-use copyleft trigger; even stricter redistribution obligations. |
| `LGPL-*` (any version) | GNU Lesser GPL | Weak copyleft; dynamic-linking exception mitigates but does not eliminate obligations. |
| `MPL-2.0` | Mozilla Public License 2.0 | **File-level weak copyleft.** Rejected for v0.5. Weak copyleft at the file boundary still imposes redistribution obligations on modified MPL-2.0 files. Community interest may justify revisiting this for v0.6+; requires operator approval and an open issue with a licensing analysis. |
| `BUSL-*` | Business Source License | Source-available but not open-source; time-limited commercial restriction. Not FOSS. |

### Non-commercial restrictions (rejected for commercial distribution)

| Rejected identifier | Notes |
|---|---|
| `CC-BY-NC` (and `-NC-*` variants) | The NonCommercial clause restricts commercial use. yakcc atoms may be used in commercial software; NC licenses are incompatible with that use case. |

### Proprietary / unspecified

The following are rejected exact-match identifiers (see `gate.ts` `REJECTED_EXACT`):

- `PROPRIETARY` — explicit proprietary claim; no redistribution permitted.
- `COMMERCIAL` — explicit commercial restriction.

Additionally, any package in one of these states is rejected:

- **Missing `license` field** in `package.json` and no SPDX comment detectable
  in source files — detected as `unknown` by the gate; rejected with "no
  recognizable license identifier".
- **Unrecognized SPDX identifier** that does not match any accepted entry and
  does not match any rejected prefix/exact — rejected as "unrecognized license
  identifier: `<id>`".

---

## Canonical aliases

The license gate normalizes identifiers before matching. Normalization steps
(from `gate.ts` `normalize()`):

1. Trim leading/trailing whitespace.
2. Strip a single pair of enclosing parentheses if present.
3. Replace one or more internal spaces with a hyphen.
4. Uppercase.

The following alias pairs are recognized after normalization. Either form
(left or right) is accepted and resolves to the same `AcceptedLicense`:

| Input form | Canonical `AcceptedLicense` |
|---|---|
| `BSD-2` | `BSD-2-Clause` |
| `BSD-2-Clause` | `BSD-2-Clause` |
| `BSD-3` | `BSD-3-Clause` |
| `BSD-3-Clause` | `BSD-3-Clause` |
| `Apache-2` | `Apache-2.0` |
| `Apache-2.0` | `Apache-2.0` |
| `UNLICENSE` (any case) | `Unlicense` |
| `Unlicense` | `Unlicense` |
| `PUBLIC-DOMAIN` (any case) | `public-domain` |
| `public-domain` | `public-domain` |

Common freeform variants handled by the normalization rules:

- `"Apache 2.0"` → normalizes to `APACHE-2.0` → resolves to `Apache-2.0`
- `"apache-2.0"` → normalizes to `APACHE-2.0` → resolves to `Apache-2.0`
- `"(MIT)"` → normalizes to `MIT` → resolves to `MIT`
- `"ISC license"` → normalizes to `ISC-LICENSE` → **does not match** (no alias);
  the upstream `package.json` must use `"ISC"` exactly.

---

## Audit log row format

Per issue #371 §3, every OSS-shave PR that adds an atom from an upstream
open-source package adds one row to the registry audit log. The audit log
records the provenance of each shaved atom and provides a verifiable chain
from atom → upstream tarball → license decision.

| Field | Type | Description | Example |
|---|---|---|---|
| `lib` | `string` | Package name (npm / pypi / crate / etc.) | `dayjs` |
| `version` | `string` | Upstream version tag or commit | `v1.11.10` |
| `license` | `string` | Human-readable license name (from package.json or header) | `MIT License` |
| `spdx` | `string` | SPDX identifier after gate normalization | `MIT` |
| `source_url` | `string` | URL of the upstream tarball or source archive | `https://registry.npmjs.org/dayjs/-/dayjs-1.11.10.tgz` |
| `tarball_sha` | `string` | SHA-256 of the tarball bytes (hex) | `e8d8f4...` |

The audit log is **append-only**. Each row corresponds to a specific
`(lib, version)` pair that was processed by the shave pipeline. A single
upstream version may produce multiple atoms; all share the same audit log row.

The audit log itself is stored separately from the atom registry (location
TBD in the OSS-shave follow-up work). The format above is the schema
requirement; the storage backend and query surface are out of scope for this
document.

---

## Provenance pointer convention

Each atom in the global registry carries a `provenance.upstream` field that
links back to its audit-log row. This provides a machine-queryable chain from
any registry atom to the upstream tarball it was derived from.

Convention:

- `provenance.upstream.lib` matches `lib` in the audit log row.
- `provenance.upstream.version` matches `version` in the audit log row.

Full schema for `provenance.upstream` is TBD in the OSS-shave follow-up
work (issue #371 §3 continuation). The convention above is the minimum
requirement: given an atom, a consumer can look up the audit log row by
`(lib, version)` and verify the license decision and tarball integrity.

---

## Adding a new accepted license

The accepted set is **locked at v0.5**. Widening it requires operator
approval and must follow this process:

1. **Open an issue** describing the license, its copyleft profile (if any),
   its redistribution implications for downstream consumers of yakcc atoms,
   and precedent (e.g., how it is treated in Debian, Fedora, or other major
   FOSS distros).

2. **Patch source** — update `packages/shave/src/license/types.ts` to add
   the new identifier to the `AcceptedLicense` union, and update
   `packages/shave/src/license/gate.ts` `CANONICAL_MAP` if normalization
   aliases are needed.

3. **Update this document** with the new entry in the "Accepted licenses"
   table and rationale.

4. **Operator approval required.** The registry's authority chain is
   operator-only signing per `DEC-V0-GLOBAL-REGISTRY-AUTHORITY-001`. A PR
   that widens the accepted set must be approved by the operator before
   landing. Do not self-approve or land as a routine implementer change.

Changes that _remove_ a previously accepted license require the same process.
Removing an accepted license may invalidate atoms already in the registry;
the migration plan for existing atoms must be stated in the issue.

---

## Cross-references

- [`FEDERATION.md`](../FEDERATION.md) — federation axis F0..F4; global
  registry sits at F1 as the public read-only mirror that permissive-licensed
  atoms are published to.
- [`FEDERATION_PROTOCOL.md`](../FEDERATION_PROTOCOL.md) — F1 wire format;
  how atoms flow between the global registry and local registries.
- [`packages/shave/src/license/gate.ts`](../packages/shave/src/license/gate.ts)
  — canonical gate implementation; the accepted/rejected logic in code.
- [`packages/shave/src/license/types.ts`](../packages/shave/src/license/types.ts)
  — `AcceptedLicense` union; the TypeScript type surface.
- [Issue #371](https://github.com/yakcc/yakcc/issues/371) — WI-V0.5-GLOBAL-REGISTRY;
  the work item that introduced this policy.

---

## Decisions

<!--
@decision DEC-V0.5-GLOBAL-REGISTRY-LICENSE-DOC-SHAPE-001
title: Standalone doc in docs/ with cross-link from FEDERATION.md (not inline in FEDERATION.md)
status: decided
rationale:
  - License policy has operational depth (aliases, audit log schema, process
    for widening) that would bloat FEDERATION.md if inlined.
  - FEDERATION.md covers trust/scale architecture; license policy is a
    content-governance concern one level below that framing.
  - Keeping docs/ as the home for operational references (cf. docs/ALPHA.md,
    docs/USING_YAKCC.md) is the established pattern.
  - Cross-linking from FEDERATION.md (near F1 description) satisfies
    discoverability without content duplication.
  - Code remains the single authority (gate.ts); this doc is human-readable
    companion only.
-->

| DEC-ID | Decision |
|---|---|
| `DEC-V0.5-GLOBAL-REGISTRY-LICENSE-DOC-SHAPE-001` | License policy lives in `docs/REGISTRY_LICENSE_POLICY.md` as a standalone doc, not inlined in `FEDERATION.md`. `FEDERATION.md` carries a one-paragraph cross-link. Code (`gate.ts`) remains the canonical authority; this doc is the human-readable companion. Introduced in issue #371 Slice 1. |
