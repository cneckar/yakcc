# Using yakcc

A practical guide to common yakcc workflows.

## Getting started

Initialize yakcc in a project directory:

```bash
yakcc init [--target <dir>]
```

This creates `.yakcc/registry.sqlite`, installs the Claude Code hook, and writes
`.yakccrc.json`. Run once per project. Safe to re-run (idempotent).

## Seeding the registry

Add yakcc atoms to your registry by shaving the source tree:

```bash
yakcc bootstrap
```

Or seed individual files:

```bash
yakcc seed <entry>
```

## Querying

Search the registry by intent:

```bash
yakcc query "<intent text>" [--registry <path>]
```

## Embedding model migration

yakcc uses a local embedding model to vectorize atoms for semantic search.
When the default embedding model changes (for example, from `all-MiniLM-L6-v2`
to `bge-small-en-v1.5` in PR #336), existing registries contain stale embedding
vectors that are no longer consistent with the new model. Running a query against
a mismatched registry produces a clear error with the exact remediation command.

To re-embed all stored blocks with the current default model:

```bash
yakcc registry rebuild [--path <registry-path>]
```

The default path is `.yakcc/registry.sqlite`. The command is idempotent: safe to
run multiple times. All atom data (specs, implementations, proof manifests) is
preserved byte-for-byte; only the derived embedding index is regenerated.

For the bootstrap-managed registry:

```bash
yakcc bootstrap
```

`yakcc bootstrap` always creates a fresh registry from the current source tree,
so it inherently uses the current embedding model.

## Registry initialization

Create a new empty registry at a custom path:

```bash
yakcc registry init [--path <path>]
```
