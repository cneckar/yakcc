# Advanced Usage

This document covers power-user features: running your own registry peer, airgap deployments, custom embeddings, the granularity dial, telemetry inspection, bulk shave, and the yakcc v2 self-shave demo.

For common errors and diagnostic steps, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md). For the basic walkthrough, see [USING_YAKCC.md](USING_YAKCC.md).

---

## 1. Running your own federation peer

Serve your local registry to teammates over HTTP:

```sh
yakcc federation serve \
  --registry .yakcc/registry.sqlite \
  --port 8080
```

This starts a read-only HTTP server that exposes blocks by their `BlockMerkleRoot`. Any yakcc client can mirror from it:

```sh
# On a teammate's machine:
yakcc federation mirror \
  --remote http://your-host:8080 \
  --registry .yakcc/registry.sqlite
```

F1 has no authentication — run it behind a reverse proxy or on a private network. Every transferred block is integrity-checked by recomputing its content-address from the received bytes; a tampered transfer is rejected loudly, never silently accepted.

---

## 2. Mirroring from a peer

Pull the full atom set from a team registry:

```sh
yakcc federation mirror \
  --remote https://team-registry.example.com \
  --registry .yakcc/registry.sqlite
```

Cherry-pick a single known atom instead of mirroring everything:

```sh
yakcc federation pull \
  --remote https://team-registry.example.com \
  --root <BlockMerkleRoot> \
  --registry .yakcc/registry.sqlite
```

Update your peer list in `.yakccrc.json` to point at the new registry:

```json
{
  "version": 1,
  "registry": { "path": ".yakcc/registry.sqlite" },
  "federation": {
    "peers": ["https://team-registry-new.example.com"]
  }
}
```

---

## 3. Airgap deployment (no outbound)

Yakcc is offline-first by design. The entire pipeline — shave, compile, registry query, hook intercept — operates with zero outbound network calls when:

1. The embedding model is cached locally. On first use, `bge-small-en-v1.5` is downloaded once to the model cache. To pre-populate the cache before airgap:

   ```sh
   # On an internet-connected machine, pre-warm the model cache
   yakcc registry rebuild --path /dev/null   # downloads + caches the model
   cp -r ~/.cache/yakcc/ <portable-cache-dir>/
   ```

2. The seed corpus is pre-loaded. On the airgap machine:

   ```sh
   # Copy your registry.sqlite to the target machine
   yakcc seed --yakcc  # skips download if registry.sqlite is already present
   ```

3. No federation peers are configured. `yakcc federation mirror` requires HTTP access; omit it in airgapped environments.

Verify the install works without network:

```sh
# Block outbound on macOS with pf or on Linux with iptables, then:
yakcc query "store a block by content address"
# Should return registry hits from the local corpus
```

---

## 4. Custom embedding model and re-embedding

The default embedding model is `bge-small-en-v1.5` (per `DEC-EMBED-MODEL-DEFAULT-002`). After an upgrade that changes the model, existing registry vectors must be regenerated:

```sh
yakcc registry rebuild --path .yakcc/registry.sqlite
```

`rebuild` is idempotent and preserves all atom content byte-for-byte — only the embedding index is regenerated. Use it whenever you:

- Upgrade yakcc and the default model changes.
- Swap in a custom model for higher-precision semantic search.
- See every query returning `outcome: "passthrough"` (vector mismatch diagnostic).

Custom model (when the flag is available; see open issue for the configuration surface):

```sh
# Planned syntax — check `yakcc registry rebuild --help` for current flags
yakcc registry rebuild --path .yakcc/registry.sqlite --model <model-name>
```

---

## 5. Granularity dial

The shave pipeline exposes a `--granularity` flag (range 1–5, per [#463](https://github.com/cneckar/yakcc/issues/463)) that controls how finely the decomposer splits atoms:

| Level | Behaviour |
|---|---|
| 1 | Coarse — only top-level named exports are extracted |
| 3 (default) | Balanced — decomposes into logical sub-expressions |
| 5 | Fine — maximally atomic; more splits, smaller individual atoms |

```sh
yakcc shave src/my-utils.ts --granularity=5
```

Higher granularity produces more atoms with narrower intent, which improves hit rate on specific sub-problems. Lower granularity produces fewer, broader atoms that are more likely to match whole-function queries.

---

## 6. Telemetry inspection

Every hook invocation appends a JSON line to `~/.yakcc/telemetry/<session-id>.jsonl`. This file is local-only; nothing leaves your machine.

One event per emission:

```ts
{
  t: 1715568000000,              // unix-ms timestamp
  intentHash: "blake3:…",        // BLAKE3 of the emission text
  toolName: "Edit" | "Write" | "MultiEdit",
  latencyMs: 12,
  outcome: "registry-hit" | "synthesis-required" | "passthrough",
  substituted: true,
  substitutedAtomHash: "7f3a1c…" // BMR[:8] of the substituted atom, or null
}
```

Quick hit/miss tally for the current session:

```sh
jq -s 'group_by(.outcome) | map({outcome: .[0].outcome, count: length})' \
   ~/.yakcc/telemetry/<session-id>.jsonl
```

Rolling 7-day view across all sessions:

```sh
jq -s 'map(select(.t > (now * 1000 - 7*24*3600*1000)))
       | group_by(.outcome) | map({outcome: .[0].outcome, count: length})' \
   ~/.yakcc/telemetry/*.jsonl
```

A dedicated `yakcc telemetry` subcommand is on the roadmap; until then `jq` is the read surface.

---

## 7. Bulk shave on a real codebase

To ingest an entire TypeScript workspace into the registry:

```sh
yakcc bootstrap
```

This traverses every file in the workspace, decomposes JSDoc-annotated exports into atoms, and writes a manifest at `bootstrap/expected-roots.json`. Add `--verify` to byte-compare the produced manifest against a committed baseline:

```sh
yakcc bootstrap --verify
```

After an embedding-model upgrade, regenerate vectors without re-shaving:

```sh
yakcc registry rebuild --path .yakcc/registry.sqlite
```

For a single file:

```sh
yakcc shave src/my-utils.ts
```

Re-shaving is a no-op for unchanged files (content-addressed idempotency). Shave your most heavily-reused modules first for the fastest return on corpus density.

---

## 8. yakcc shaves itself — the v2 self-shave demo

yakcc shaves the meaningfully-reusable parts of arbitrary TypeScript — including its own source — recompiles itself from those atoms, and the recompiled yakcc produces the same manifest. Reproducible from a fresh clone in 4 commands:

```sh
pnpm install --frozen-lockfile && pnpm -r build
node packages/cli/dist/bin.js bootstrap --verify
node packages/cli/dist/bin.js compile-self --output=dist-recompiled/
YAKCC_TWO_PASS=1 pnpm --filter @yakcc/v2-self-shave-poc test two-pass-equivalence
```

What each pass proves:

- **Pass 1 (`bootstrap --verify`):** yakcc shaves its own source into a content-addressed manifest of 3,807 atoms. The manifest matches `bootstrap/expected-roots.json` byte-for-byte.
- **Pass 2 (`YAKCC_TWO_PASS=1`):** the recompiled yakcc (assembled entirely from its own atoms) produces the same manifest. Byte-identity across the compile-self round-trip.

This is the "moat" claim: if yakcc can shave and recompile itself without drift, it can do the same for any sufficiently well-structured TypeScript codebase.

For the full fresh-clone reproduction with captured output and the "If equivalence fails" taxonomy, see [docs/V2_SELF_SHAVE_DEMO.md](V2_SELF_SHAVE_DEMO.md).

For pass-1 internals (bootstrap mechanics, manifest semantics, CI integration) see [docs/archive/developer/V2_SELF_HOSTING_DEMO.md](archive/developer/V2_SELF_HOSTING_DEMO.md).
