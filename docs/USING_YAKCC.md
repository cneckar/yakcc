# Using Yakcc

End-user walkthrough: from a fresh TypeScript project to seeing registry hits in Claude Code in under 15 minutes.

This document is for people who want to **use** yakcc in their own project. If you want to **contribute** to yakcc itself, see [`README.md`](../README.md) and [`MASTER_PLAN.md`](../MASTER_PLAN.md).

---

## 1. Prerequisites

- **Node.js >= 22** — verify with `node --version`.
- **pnpm >= 9** — install with `npm install -g pnpm` if needed.
- **Claude Code** — install per [Claude Code docs](https://docs.claude.com/en/docs/claude-code). Cursor users see [§8 IDE adapters](#8-ide-adapters).
- A TypeScript project you want to use yakcc with. The walkthrough assumes you are in its root.

---

## 2. Installation

> **Note (2026-05-12):** A standalone npm distribution is in flight (issue [#361](https://github.com/cneckar/yakcc/issues/361)). Until that lands, install from the monorepo. Steps will collapse to `npm install -g @yakcc/cli` once #361 ships.

```sh
git clone https://github.com/cneckar/yakcc.git ~/.yakcc-cli
cd ~/.yakcc-cli
pnpm install --frozen-lockfile
pnpm -r build
```

Wire the CLI onto your PATH:

```sh
# bash / zsh
export PATH="$HOME/.yakcc-cli/packages/cli/dist:$PATH"
# Permanent: add the line above to ~/.bashrc or ~/.zshrc
```

Confirm it works:

```sh
yakcc --help
```

You should see the command list. If `yakcc` is not found, double-check the PATH export or use the absolute path `node ~/.yakcc-cli/packages/cli/dist/bin.js`.

---

## 3. First 30 seconds — `yakcc init`

From your project root:

```sh
cd ~/my-project
yakcc init
```

What this does (per `DEC-CLI-INIT-001` in `packages/cli/src/commands/init.ts`):

1. Creates `.yakcc/` for operational data — an empty SQLite registry at `.yakcc/registry.sqlite`, a `telemetry/` directory, and a `config/` directory.
2. Writes `.yakccrc.json` at the project root with the registry path and (optionally) federation peers.
3. Wires the Claude Code `PreToolUse` hook into `.claude/settings.json` (or creates the file if absent). The hook intercepts `Edit | Write | MultiEdit` tool calls and routes them through `yakcc hook-intercept` before they land on disk.

Verify the install:

```sh
ls .yakcc/                              # registry/  telemetry/  config/  registry.sqlite
cat .yakccrc.json                       # { "version": 1, "registry": { "path": ".yakcc/registry.sqlite" } }
grep -A 5 yakcc .claude/settings.json   # PreToolUse hook entry with the yakcc-hook-v1 marker
```

To initialize a *different* directory or connect to a team registry on first boot:

```sh
yakcc init --target ./some-other-project --peer https://registry.example.com
```

`--peer` is validated strictly (must be `http:` or `https:`); the peer URL is stored under `federation.peers[]` in `.yakccrc.json` and immediately mirrored. See [§7 Federation](#7-federation).

---

## 4. Verify the integration

Start (or restart) Claude Code in the project root. Then in the project, ask Claude to write something the empty registry won't have — e.g. *"add a debounce utility to `src/util.ts`."*

What you'll see:

- The first time, the registry is empty, so the hook returns `synthesis-required`. Claude writes the code itself. (See [§6](#6-the-synthesis-required-outcome) for what to do next.)
- The hook records every emission to `~/.yakcc/telemetry/<session-id>.jsonl`. Check that it fired:

  ```sh
  ls ~/.yakcc/telemetry/
  tail -1 ~/.yakcc/telemetry/*.jsonl | jq .
  ```

  You should see a JSON line with `outcome: "passthrough"` or `outcome: "synthesis-required"` and a sub-millisecond `latencyMs`. If the file does not exist, the hook is not wired — re-run `yakcc init` from the project root and restart Claude Code.

Optionally, prime the registry with the bundled seed corpus (~20 atoms composing a JSON integer-list parser):

```sh
yakcc seed
```

Now ask Claude Code something the seed corpus *does* know about, e.g. *"parse a JSON array of integers from this string."* The hook should return `outcome: "registry-hit"` and Claude will reference an existing atom by its BlockMerkleRoot instead of generating new code.

---

## 5. Walking through a registry hit

When the hook substitutes a registry atom, the emitted code carries an inline contract comment showing exactly which atom was used (per D-HOOK-4 in [`docs/adr/hook-layer-architecture.md`](adr/hook-layer-architecture.md)):

```ts
// @atom parseIntList (string => number[]; never throws on well-formed input) — yakcc:7f3a1c20
import { parseIntList } from "@yakcc/atoms/parseIntList";
const ints = parseIntList(input);
```

The format is `// @atom <name> (<signature>; <key-guarantee>) — yakcc:<hash[:8]>` per `DEC-HOOK-PHASE-3-001` in `packages/hooks-base/src/substitute.ts`.

The contract comment is the *audit trail*: every assembled program can be re-verified by re-fetching atoms by their content-address and re-running their property tests. Nothing was generated; nothing can drift.

To inspect the atom by hand:

```sh
yakcc query "parse a JSON array of integers" --top 5
```

This returns up to 5 atoms ranked by semantic similarity, each annotated with its BlockMerkleRoot, IntentCard, and structural distance. The `--rerank` flag adds a structural score on top of the vector score for tighter ranking.

Free-text vs spec-file search:

```sh
yakcc search "parse a JSON array of integers"          # structural search by free text
yakcc query "..." --card-file ./my-intent.json         # exact IntentCard JSON
```

---

## 6. The synthesis-required outcome

When the registry has no good match, the hook returns `synthesis-required` and Claude Code writes the code from scratch. Your role as the operator is to decide whether the new code is *atom-worthy* — does it solve a general problem the registry should learn?

When [#362](https://github.com/cneckar/yakcc/issues/362) (hook atom-capture) lands, every novel emission will be auto-atomized into the registry, closing the flywheel automatically. Until then, the manual path is:

```sh
# Shave the file Claude just wrote into atoms
yakcc shave src/util.ts
```

`yakcc shave` extracts every JSDoc-annotated exported function, validates each as a strict-TS-subset atom, computes its BlockMerkleRoot, and stores it (idempotently — re-shaves are a no-op when content is unchanged). Confirm:

```sh
yakcc search "debounce" --top 5
```

The atom you just shaved is now discoverable in subsequent Claude Code sessions.

---

## 7. Federation

If your team has a shared registry, point your local copy at it.

### Mirror from a peer

```sh
yakcc federation mirror \
  --remote https://team-registry.example.com \
  --registry .yakcc/registry.sqlite
```

Every transferred block is integrity-checked by recomputing its BlockMerkleRoot from the received bytes (per [`FEDERATION.md`](../FEDERATION.md) F1 axis). Tampered transfers fail loud.

### Serve your registry to others

```sh
yakcc federation serve \
  --registry .yakcc/registry.sqlite \
  --port 8080
```

This starts a read-only HTTP server. Co-workers point their `yakcc federation mirror --remote http://your-host:8080` at it. F1 has no auth — run it behind a reverse proxy or on a private network only.

### Pull a single block

```sh
yakcc federation pull \
  --remote https://team-registry.example.com \
  --root <BlockMerkleRoot> \
  --registry .yakcc/registry.sqlite
```

Useful for cherry-picking a known atom without mirroring the whole peer.

### Switch peers

Edit `.yakccrc.json`:

```json
{
  "version": 1,
  "registry": { "path": ".yakcc/registry.sqlite" },
  "federation": {
    "peers": ["https://team-registry-new.example.com"]
  }
}
```

Then re-run `yakcc federation mirror --remote <new-url> --registry .yakcc/registry.sqlite`.

---

## 8. IDE adapters

### Claude Code (default)

`yakcc init` wires this automatically. To manage it explicitly:

```sh
yakcc hooks claude-code install [--target <dir>]   # re-wire (idempotent)
yakcc hooks claude-code install --uninstall        # remove the yakcc entry only
```

The installer reads `.claude/settings.json`, adds (or removes) a single `PreToolUse` block marked `_yakcc: "yakcc-hook-v1"`, and writes it back. Any other hook configuration you have is left untouched.

### Cursor

```sh
yakcc hooks cursor install [--target <dir>]
yakcc hooks cursor install --uninstall
```

Same shape as the Claude Code installer; targets the Cursor settings surface.

### Codex CLI

Not yet wired. Tracked at issue [#220](https://github.com/cneckar/yakcc/issues/220) (conditional on demand).

---

## 9. Telemetry — am I actually saving work?

Every hook invocation appends one JSON line to `~/.yakcc/telemetry/<session-id>.jsonl` (per D-HOOK-5 in `docs/adr/hook-layer-architecture.md`). The file is **local-only**; nothing leaves your machine.

Schema (one event per emission):

```ts
{
  t: 1715568000000,                // unix-ms timestamp
  intentHash: "blake3:…",          // BLAKE3 of the emission text
  toolName: "Edit" | "Write" | "MultiEdit",
  latencyMs: 12,
  outcome: "registry-hit" | "synthesis-required" | "passthrough",
  substituted: true,               // true iff Phase 2 substitution fired
  substitutedAtomHash: "7f3a1c…"   // BMR[:8] of the substituted atom, or null
}
```

Quick hit/miss tally for the current session:

```sh
jq -s 'group_by(.outcome) | map({outcome: .[0].outcome, count: length})' \
   ~/.yakcc/telemetry/<session-id>.jsonl
```

For a rolling 7-day view across all sessions:

```sh
jq -s 'map(select(.t > (now * 1000 - 7*24*3600*1000)))
       | group_by(.outcome) | map({outcome: .[0].outcome, count: length})' \
   ~/.yakcc/telemetry/*.jsonl
```

A dedicated `yakcc telemetry` subcommand is on the roadmap; until then `jq` is the read surface.

---

## 10. Shaving your own codebase (optional)

If you already have a TypeScript package with conventions you want represented in the registry, bulk-ingest the whole tree:

```sh
yakcc bootstrap
```

This shaves every file in the workspace, decomposes JSDoc-annotated exports into atoms, and writes a manifest at `bootstrap/expected-roots.json`. Add `--verify` to also byte-compare the produced manifest against a committed one (the self-hosting proof; see [`docs/V2_SELF_HOSTING_DEMO.md`](V2_SELF_HOSTING_DEMO.md)):

```sh
yakcc bootstrap --verify
```

After an embedding-model upgrade (the default is `bge-small-en-v1.5` per `DEC-EMBED-MODEL-DEFAULT-002`), regenerate vectors without re-shaving:

```sh
yakcc registry rebuild --path .yakcc/registry.sqlite
```

`rebuild` is idempotent and preserves all atom content byte-for-byte — only the embedding index is regenerated.

---

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `yakcc: command not found` | PATH not set or build skipped | Re-run `pnpm -r build` and re-export PATH (see [§2](#2-installation)). |
| Claude Code does not invoke the hook | `.claude/settings.json` missing the yakcc entry, or Claude Code not restarted after `yakcc init` | Run `yakcc hooks claude-code install` and restart Claude Code. Verify with `grep yakcc .claude/settings.json`. |
| Registry seems empty after `yakcc init` | `init` deliberately does not auto-seed (per `DEC-CLI-INIT-001`) | Run `yakcc seed` (yakcc seed corpus) or `yakcc federation mirror --remote <peer-url> --registry .yakcc/registry.sqlite` (team registry). |
| `federation mirror` fails with integrity error | Peer returned bytes that don't match the advertised BMR | Refuse the transfer (correct behavior). Contact the peer operator. |
| Every emission shows `outcome: "passthrough"` | Embedding model mismatch after a yakcc upgrade | Re-embed the registry: `yakcc registry rebuild --path .yakcc/registry.sqlite`. |
| Hook latency feels high (>200ms) | Cold embedding model on first call | Expected once per session; subsequent calls are warm-cached. If persistent, file an issue with a telemetry sample. |
| `yakcc shave <file>` fails with `DidNotReachAtomError` | A `CallExpression` in the source is neither atomic nor decomposable | Refactor the offending expression to a named helper, or add the file to `bootstrap/expected-failures.json` if you're contributing to yakcc itself. |
| `yakcc shave` rejects a file with `IntentCardSchemaError: behavior must not contain newline characters` | A function's JSDoc `@behavior` field spans multiple lines | Collapse `@behavior` to a single line; long descriptions go in the function body or a separate doc. |

---

## 12. Where to go next

- [`README.md`](../README.md) — yakcc-the-project overview, monorepo layout, contributor quickstart.
- [`MASTER_PLAN.md`](../MASTER_PLAN.md) — architecture decisions and work-item history.
- [`DESIGN.md`](../DESIGN.md) — extended design rationale and contract philosophy.
- [`VERIFICATION.md`](../VERIFICATION.md) — verification ladder, triplet identity, TCB.
- [`FEDERATION.md`](../FEDERATION.md) — F0..F4 federation trust/scale axis.
- [`MANIFESTO.md`](../MANIFESTO.md) — project voice and intent.
- [`docs/PRIOR_ART.md`](PRIOR_ART.md) — defensive publication of the substrate's novel mechanisms.
- [`docs/V2_SELF_HOSTING_DEMO.md`](V2_SELF_HOSTING_DEMO.md) — the `yakcc bootstrap --verify` self-hosting proof.
- [`docs/adr/hook-layer-architecture.md`](adr/hook-layer-architecture.md) — D-HOOK-1..6 hook-layer decisions.

---

_If something in this walkthrough doesn't match what you observe, please [file an issue](https://github.com/cneckar/yakcc/issues/new). The walkthrough lives at `docs/USING_YAKCC.md` and is intended to track shipped software exactly._
