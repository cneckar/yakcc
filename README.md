# Yakcc

[![PR CI](https://github.com/cneckar/yakcc/actions/workflows/pr-ci.yml/badge.svg)](https://github.com/cneckar/yakcc/actions/workflows/pr-ci.yml)
[![Nightly](https://github.com/cneckar/yakcc/actions/workflows/nightly.yml/badge.svg)](https://github.com/cneckar/yakcc/actions/workflows/nightly.yml)

## What is yakcc

**Shave once, reuse forever.** Yakcc is a content-addressed block registry for assembling programs from verified, reusable building blocks. Instead of writing the same parsing logic, data transformation, or utility function over and over, you shave it once into an atomic, tested block and store it in a local registry. The next time you need it — in any project, on any machine — the registry serves the exact same bytes, with proof that it works. The name is a yak-shave joke that is also a thesis; the double-c is a nod to the long lineage of terse compiler names.

## Get started in 60 seconds

```sh
# Install dependencies and build all packages
pnpm install && pnpm build

# Initialize yakcc in your project directory
# (creates .yakcc/, wires detected IDE hooks, and seeds bootstrap atoms)
yakcc init

# Assemble the parse-int-list demo to verify the full pipeline
yakcc compile examples/parse-int-list

# Run it
node examples/parse-int-list/dist/main.js
```

Expected output:

```
parse-int-list demo — assembled by Yakcc v0
============================================
  listOfInts("[1,2,3]") => [1,2,3]
  listOfInts("[]") => []
  listOfInts("[ 42 ]") => [42]
  listOfInts("[10,200,3000]") => [10,200,3000]
```

For a full walkthrough see [docs/USING_YAKCC.md](docs/USING_YAKCC.md). Testing the v0.5.0-alpha? See [docs/ALPHA.md](docs/ALPHA.md) for the alpha-specific tester guide.

Need a custom target path or peer?

```sh
yakcc init --target my-project/ [--peer https://registry.example.com]
```

To remove yakcc from a project:

```sh
yakcc uninstall
yakcc uninstall --purge
```

## Why yakcc

**Reproducibility by construction.** Every assembled program carries a provenance manifest naming every constituent block by its content-address. Bit-for-bit reproducibility is not a build option — it is the default.

**Verified building blocks.** Every block in the registry carries property tests. When you compose blocks into a program, you know exactly what was tested and how.

**IDE integration.** Hooks for Claude Code, Cursor, Cline, and Continue.dev intercept code-emission events and check the registry first. If a matching block already exists, it is served — no generation needed.

**Offline-first.** No API key is required for most operations. Shaving uses static TypeScript analysis by default. Vector search uses a local embedding model.

**Federation.** Registries can mirror each other over HTTP. Every transferred block is integrity-checked by recomputing its content-address from the received bytes.

## What's measured

| Benchmark | Status | Result |
|---|---|---|
| B6 — air-gap operation (no outbound) | Proven | Full pipeline runs with zero network calls |
| B1 — hook latency vs native code write | Proven | Sub-millisecond warm-cache; see `bench/B1-latency/` |
| B4-v3 — token-spend matrix (hooked vs unhooked) | In flight | Numbers land when [DEC-BENCH-B4-V3-001](docs/archive/developer/MASTER_PLAN.md) is complete |

To reproduce B6 and B1 locally: see `bench/B6-airgap/README.md` and `bench/B1-latency/README.md`.

## Quick troubleshooting

Common failures and their fixes are in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

The most common issues:

- Hook not firing after `yakcc init` → restart Claude Code and verify `.claude/settings.json` contains a `_yakcc` entry.
- Every emission shows `outcome: "passthrough"` → run `yakcc registry rebuild --path .yakcc/registry.sqlite` to regenerate embeddings.
- Registry looks empty after init → rerun `yakcc init` and inspect the summary for seed completion, then run `yakcc bootstrap --verify` to confirm corpus/materialization health.

## Advanced

[docs/ADVANCED.md](docs/ADVANCED.md) covers:

- Running your own federation peer (`yakcc federation serve`)
- Mirroring from a peer across machines or teams
- Airgap deployment with no outbound network
- Custom embedding models and re-embedding
- Granularity dial (`--granularity=<1..5>`)
- Telemetry inspection
- Bulk shave on a real codebase
- yakcc shaves itself — the v2 self-shave demo

## Contributing

Working on yakcc itself? See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for the contributor orientation. The developer documentation lives in the archive:

- [docs/archive/developer/MASTER_PLAN.md](docs/archive/developer/MASTER_PLAN.md) — decision log + work-item history
- [docs/archive/developer/DESIGN.md](docs/archive/developer/DESIGN.md) — architecture rationale + contract philosophy
- [docs/archive/developer/VERIFICATION.md](docs/archive/developer/VERIFICATION.md) — verification ladder + triplet identity + TCB
- [docs/archive/developer/FEDERATION.md](docs/archive/developer/FEDERATION.md) — F0..F4 federation trust/scale axis
- [docs/archive/developer/MANIFESTO.md](docs/archive/developer/MANIFESTO.md) — project voice and intent
- [docs/archive/developer/AGENTS.md](docs/archive/developer/AGENTS.md) — sister-agent operating guide
- [docs/archive/developer/PRIOR_ART.md](docs/archive/developer/PRIOR_ART.md) — defensive publication of substrate's novel mechanisms
- [docs/archive/developer/V2_SELF_HOSTING_DEMO.md](docs/archive/developer/V2_SELF_HOSTING_DEMO.md) — v2 self-hosting walkthrough
- [docs/archive/developer/adr/](docs/archive/developer/adr/) — architecture decision records

## Releases

See [docs/RELEASE.md](./docs/RELEASE.md) for the release process, trusted-publisher setup, and the per-new-package pre-config requirement.

## License

Yakcc consists of two distinct artifacts with different licenses:

- **Substrate code** — the engine (shave, compile, discovery, registry storage, hooks, CLI, tooling, configs, build files) — is licensed under the [Apache License 2.0](LICENSE).
- **Atom content** — items in the atom registry, including everything under `packages/seeds/blocks/**` and the artifact contents referenced by `bootstrap/expected-roots.json` — is dedicated to the public domain under [The Unlicense](LICENSE-ATOMS).

The split reflects the nature of the artifacts: the engine is a software tool with conventional copyright; the registry is a content commons.
