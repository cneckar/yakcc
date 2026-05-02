# v1-federation-demo

v1 wave-1 federation closer demo for yakcc. Exercises the full cross-machine
federation loop end-to-end:

  shave (registryA on disk) → serveRegistry → mirrorRegistry → registryB on disk → compile on both → byte-identical dist outputs

## Purpose

This demo is the acceptance vehicle for WI-021 in MASTER_PLAN.md. It proves
the v1 wave-1 federation invariant: a block produced by `yakcc shave` on one
machine (registryA) can be replicated to a second machine (registryB) via the
HTTP federation wire, and `yakcc compile` against both registries produces
byte-identical outputs.

## What is demonstrated

1. **shave** — The demo's `src/argv-parser.ts` (MIT, multi-atom substrate)
   is shaved into registryA. Every persisted block carries real property_tests
   artifacts (WI-016) and populated `parent_block_root` lineage (WI-017).

2. **serve + mirror** — `serveRegistry(registryA)` exposes registryA over
   localhost HTTP. `mirrorRegistry(serveUrl, registryB)` replicates every
   block byte-identically to an empty registryB.

3. **compile** — `yakcc compile` against registryA (distA/) and registryB
   (distB/) produces byte-identical `module.ts` and `manifest.json`.

4. **No-ownership wire** — The served wire body carries no author, signer,
   owner, account, or identity-shaped fields (DEC-NO-OWNERSHIP-011).

5. **License gate + federation** — GPL-prepared input is refused at registryA's
   shave path; registryB never sees the refused source bytes via federation.

## Acceptance criteria (WI-021)

| # | Criterion | Offline? |
|---|---|---|
| (a) | registryA seeded by shave carries property_tests artifacts + parent_block_root lineage | yes — uses static intent extraction |
| (b) | mirrorRegistry replicates registryA byte-identically onto fresh registryB | yes — uses localhost HTTP |
| (c) | yakcc compile on registryA and registryB emits byte-identical TS module + provenance manifest | yes — content-addressed output |
| (d) | provenance manifest names every block by BlockMerkleRoot with parent block links | yes |
| (e) | idempotent re-mirror is a no-op (blocksFetched = 0, blocksAlreadyPresent = all) | yes |
| (f) | GPL-prepared input refused at shave; registryB never sees refused bytes | yes |
| (g) | federation wire carries no ownership-shaped fields | yes |
| (h) | registryB never contains registryA local file paths | yes |
| (i) | offline compile on registryB (server closed) succeeds and emits identical bytes | yes |

## What is offline-tolerant vs. live-API-required

All nine acceptance tests pass without `ANTHROPIC_API_KEY`. The demo uses
`intentStrategy: "static"` (DEC-INTENT-STRATEGY-001) for the shave path, which
does not call the Anthropic API. The intent and corpus caches are pre-seeded
by the test harness before shave runs (WI-018 `seedIntentCache` + WI-016
`seedCorpusCache` paths).

Live-API paths (LLM intent extraction) are out of scope for WI-021 and tracked
as a future follow-up.

## Invocation

```
pnpm --filter @v1-federation-demo test    # run acceptance tests
pnpm -r build                             # build all packages
pnpm -r test                             # run all workspace tests
```

## Evidence

All evidence is written to `tmp/wi-021-evidence/` under the workspace root:
- `registryA.sqlite` / `registryB.sqlite` — the two disk-backed registries.
- `distA/` / `distB/` — compile outputs (byte-identical).
- `transcript.txt` — shave + serve + mirror + diff log.
- SQL snapshots — block and artifact rows from both registries.

The directory is deleted at the start of each test run for hermetic re-runs.

## Architecture notes

- **DEC-SERVE-SPECS-ENUMERATION-020**: `serveRegistry` receives an inline
  `enumerateSpecs` callback that runs a SQL query against registryA's SQLite
  handle. This is the documented v0.7-style escape hatch (destination: B-008).
- **DEC-V1-FEDERATION-WIRE-ARTIFACTS-002**: every block carries artifact bytes
  on the wire; the receiver recomputes `blockMerkleRoot` to verify integrity.
- **DEC-V1-WAVE-1-SCOPE-001**: F1 read-only mirror only. No F2 publishing,
  no signed manifests, no peer keypairs.
- **DEC-NO-OWNERSHIP-011**: no ownership-shaped field anywhere on the wire.
