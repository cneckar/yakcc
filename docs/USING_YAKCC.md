# Using Yakcc

End-user walkthrough: from a fresh TypeScript project to seeing registry hits in Claude Code in under 15 minutes.

This document is for people who want to **use** yakcc in their own project. If you want to **contribute** to yakcc itself, see [`README.md`](../README.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## 1. Prerequisites

- **Node.js >= 22** — verify with `node --version`.
- **pnpm >= 9** — install with `npm install -g pnpm` if needed.
- **Claude Code, Cursor, Cline, or Continue.dev** — install whichever IDE(s) you use. `yakcc init` auto-detects them. See [§8 IDE adapters](#8-ide-adapters) for the full list.
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

What this does (per `DEC-CLI-INIT-001` and `DEC-CLI-INIT-002` in `packages/cli/src/commands/init.ts`):

1. Creates `.yakcc/` for operational data — an empty SQLite registry at `.yakcc/registry.sqlite`, a `telemetry/` directory, and a `config/` directory.
2. Writes `.yakccrc.json` at the project root with the registry path, mode, installed hooks list, and (optionally) federation peers.
3. Auto-detects installed IDEs (Claude Code, Cursor, Cline, Continue.dev) by probing their config directories (per `DEC-CLI-IDE-DETECT-SEMANTICS-001`), then wires the yakcc hook for each detected IDE.
4. Seeds the yakcc bootstrap corpus (~3k+ atoms) into the local registry by default (per `DEC-CLI-INIT-002`). Pass `--no-seed` to skip this step.
5. Prints a concise summary (<=6 lines) naming which IDEs were hooked and confirming the corpus was seeded.

Verify the install:

```sh
ls .yakcc/                              # registry/  telemetry/  config/  registry.sqlite
cat .yakccrc.json                       # { "version": 1, "mode": "local", "registry": { "path": ".yakcc/registry.sqlite" }, "installedHooks": [...] }
grep -A 5 yakcc .claude/settings.json   # PreToolUse hook entry with the yakcc-hook-v1 marker (if Claude Code detected)
```

### Init flags

| Flag | Default | Description |
|---|---|---|
| `--target <dir>` | `.` (current dir) | Initialize a different directory |
| `--peer <url>` | none | Connect to a team registry peer on first boot (http/https only) |
| `--local` | (default) | Explicit local mode — offline-first, no peer |
| `--airgapped` | off | Explicit airgap mode — semantically equivalent to `--local` today |
| `--skip-hooks` | off | Skip IDE hook auto-install entirely |
| `--ide <list>` | (auto-detect) | Comma-separated explicit IDE list, e.g. `--ide claude-code,cursor`. Skips auto-detection. Valid values: `claude-code`, `cursor`, `cline`, `continue` |
| `--no-seed` | off | Skip the bootstrap corpus seed step |

To initialize a *different* directory or connect to a team registry on first boot:

```sh
yakcc init --target ./some-other-project --peer https://registry.example.com
```

`--peer` is validated strictly (must be `http:` or `https:`); the peer URL is stored under `federation.peers[]` in `.yakccrc.json` and immediately mirrored. See [§7 Federation](#7-federation).

To wire hooks for specific IDEs only (skip auto-detection):

```sh
yakcc init --ide claude-code,cursor
```

---

## 4. Verify the integration

### 4a. Verify the bootstrap corpus was seeded

`yakcc init` auto-seeds the yakcc bootstrap corpus by default (per `DEC-CLI-INIT-002`). This gives you ~3,800 real-shaved atoms covering yakcc's parsers, registry primitives, hook helpers, federation transport, and more — enough that your first Claude Code sessions hit the registry immediately instead of returning `synthesis-required` for every emission.

Confirm the seed ran:

```sh
yakcc query "store a block by content address"
```

You should see at least one registry hit. If the query returns nothing and you did not pass `--no-seed`, check that `bootstrap/yakcc.registry.sqlite` exists in your repo clone (`git status bootstrap/`).

To re-seed manually (the operation is idempotent):

```sh
yakcc seed --yakcc
```

> **Opt-out:** `yakcc init --no-seed` skips the seed step, restoring the quiet-init shape from before `DEC-CLI-INIT-002`. Use this if you only want your own project's atoms and prefer to seed on your own schedule.

> **Wall-time:** expect 20-60 seconds on a modern dev machine (mostly BLAKE3 + sqlite-vec embedding insertion).

---

### 4b. Optionally prime with the minimal seed corpus

If you only want the 20-block JSON integer-list parser seed (the original smaller corpus):

```sh
yakcc seed
```

Both `yakcc seed` and `yakcc seed --yakcc` are idempotent; running them together is safe.

---

### 4c. Verify the Claude Code hook

Start (or restart) Claude Code in the project root. Then in the project, ask Claude to write something the registry knows about — e.g. *"parse a JSON array of integers from this string."*

What you'll see:

- With the bootstrap corpus seeded, the hook returns `outcome: "registry-hit"` for queries that match existing atoms. Claude will reference an existing atom by its BlockMerkleRoot instead of generating new code.
- The hook records every emission to `~/.yakcc/telemetry/<session-id>.jsonl`. Check that it fired:

  ```sh
  ls ~/.yakcc/telemetry/
  tail -1 ~/.yakcc/telemetry/*.jsonl | jq .
  ```

  You should see a JSON line with `outcome: "passthrough"` or `outcome: "registry-hit"` and a sub-millisecond `latencyMs`. If the file does not exist, the hook is not wired — re-run `yakcc init` from the project root and restart Claude Code.

---

### 4d. Local directory layout — where things live

yakcc creates **two directories named `.yakcc`** in normal use. They are in different parent directories and hold different state:

| Directory | Contents | Created by |
|---|---|---|
| `<project>/.yakcc/` | `registry.sqlite` (atom store), `config/`, `registry/` | `yakcc init` |
| `~/.yakcc/` | `telemetry/<session-id>.jsonl` — one per Claude Code session | Hook on first Edit/Write |

**Telemetry is always written to `~/.yakcc/telemetry/`, not `<project>/.yakcc/`.** This is intentional: a single Claude Code session can touch multiple projects, so telemetry is aggregated per-user rather than fragmented per-project (D-HOOK-5).

Use the `yakcc telemetry` command to inspect it without having to remember the path:

```sh
yakcc telemetry           # list session files with event counts + timestamps
yakcc telemetry --tail 5  # print the last 5 events from the latest session
yakcc telemetry --path    # print the resolved telemetry directory
```

---

## 5. Walking through a registry hit

When the hook substitutes a registry atom, the emitted code carries an inline contract comment showing exactly which atom was used (per D-HOOK-4 in [`docs/archive/developer/adr/hook-layer-architecture.md`](archive/developer/adr/hook-layer-architecture.md)):

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

Every transferred block is integrity-checked by recomputing its BlockMerkleRoot from the received bytes (per [`FEDERATION.md`](archive/developer/FEDERATION.md) F1 axis). Tampered transfers fail loud.

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

`yakcc init` auto-detects all four supported IDEs by probing their config directories (per `DEC-CLI-IDE-DETECT-SEMANTICS-001`). The explicit per-IDE commands below are for re-wiring after a fresh IDE install, troubleshooting, or targeted control.

### Claude Code

`yakcc init` wires this automatically when `~/.claude/` is detected. To manage it explicitly:

```sh
yakcc hooks claude-code install [--target <dir>]   # re-wire (idempotent)
yakcc hooks claude-code install --uninstall        # remove the yakcc entry only
```

The installer reads `.claude/settings.json`, adds (or removes) a single `PreToolUse` block marked `_yakcc: "yakcc-hook-v1"`, and writes it back. Any other hook configuration you have is left untouched.

### Cursor

`yakcc init` wires this automatically when the Cursor config directory is detected (platform-specific path per `DEC-CLI-IDE-DETECT-SEMANTICS-001`). To manage it explicitly:

```sh
yakcc hooks cursor install [--target <dir>]
yakcc hooks cursor install --uninstall
```

Same shape as the Claude Code installer; targets the Cursor settings surface.

### Cline

`yakcc init` writes a marker file `~/.config/cline/yakcc-cline-hook.json` when the Cline config directory is detected (per `DEC-CLI-HOOKS-CLINE-INSTALL-001`). The marker records the hook intent for when Cline's VS Code extension API surface stabilizes. No live settings.json wiring yet.

To manage it explicitly:

```sh
yakcc hooks cline install         # write (or refresh) the marker file
yakcc hooks cline install --uninstall   # remove the marker file
```

Cline detection probes `~/.config/cline/` and the VS Code extension dir `~/.vscode/extensions/saoudrizwan.claude-dev`.

### Continue.dev

`yakcc init` writes a marker file `~/.continue/yakcc-continue-hook.json` when the Continue.dev config directory is detected (per `DEC-CLI-HOOKS-CONTINUE-INSTALL-001`). Same pattern as Cline — the marker documents intent for when Continue.dev's extension API stabilizes. No live settings.json wiring yet.

To manage it explicitly:

```sh
yakcc hooks continue install      # write (or refresh) the marker file
yakcc hooks continue install --uninstall   # remove the marker file
```

Continue.dev detection probes `~/.continue/` and `~/.vscode/extensions/continue.continue`.

### Codex CLI

Not yet wired. Tracked at issue [#220](https://github.com/cneckar/yakcc/issues/220) (closed not-planned, conditional on demand).

---

## 9. Removing yakcc

To remove yakcc hooks from your project (preserves the local registry and `.yakcc/` data directory):

```sh
yakcc uninstall
```

What this does (per `DEC-CLI-UNINSTALL-COMMAND-001` and `DEC-CLI-UNINSTALL-DETECTION-001` in `packages/cli/src/commands/uninstall.ts`):

1. Reads `.yakccrc.json` to discover which IDEs were installed (the `installedHooks` field written by `yakcc init`).
2. Calls the per-IDE uninstaller for each detected IDE (idempotent — already-absent hooks log a message and exit 0).
3. Updates `.yakccrc.json` to clear the `installedHooks` field.
4. Prints a concise summary.

The local registry (`.yakcc/registry.sqlite` and related data), telemetry files, and `.yakccrc.json` are preserved by default.

### Uninstall flags

| Flag | Default | Description |
|---|---|---|
| `--target <dir>` | `.` (current dir) | Uninstall from a different directory |
| `--purge` | off | Also remove `.yakcc/` and `.yakccrc.json` — destructive; removes all local registry data |
| `--ide <list>` | (all installed) | Comma-separated list of specific IDEs to uninstall. Valid values: `claude-code`, `cursor`, `cline`, `continue` |

To remove all yakcc data from a project (hooks + registry + config):

```sh
yakcc uninstall --purge
```

To remove hooks for a specific IDE only:

```sh
yakcc uninstall --ide claude-code
yakcc uninstall --ide cline,continue
```

Re-running `yakcc uninstall` is safe — it is idempotent. Running it on a project where yakcc was never initialized exits 0 with a no-op summary.

---

## 10. Telemetry — am I actually saving work?

Every hook invocation appends one JSON line to `~/.yakcc/telemetry/<session-id>.jsonl` (per D-HOOK-5 in `docs/archive/developer/adr/hook-layer-architecture.md`). The file is **local-only**; nothing leaves your machine.

Schema (one event per emission):

```ts
{
  t: 1715568000000,                // unix-ms timestamp
  intentHash: "blake3:...",        // BLAKE3 of the emission text
  toolName: "Edit" | "Write" | "MultiEdit",
  latencyMs: 12,
  outcome: "registry-hit" | "synthesis-required" | "passthrough",
  substituted: true,               // true iff Phase 2 substitution fired
  substitutedAtomHash: "7f3a1c..."   // BMR[:8] of the substituted atom, or null
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

## 11. Shaving your own codebase (optional)

If you already have a TypeScript package with conventions you want represented in the registry, bulk-ingest the whole tree:

```sh
yakcc bootstrap
```

This shaves every file in the workspace, decomposes JSDoc-annotated exports into atoms, and writes a manifest at `bootstrap/expected-roots.json`. Add `--verify` to also byte-compare the produced manifest against a committed one (the self-hosting proof; see [`docs/archive/developer/V2_SELF_HOSTING_DEMO.md`](archive/developer/V2_SELF_HOSTING_DEMO.md)):

```sh
yakcc bootstrap --verify
```

After an embedding-model upgrade (the default is `bge-small-en-v1.5` per `DEC-EMBED-MODEL-DEFAULT-002`), regenerate vectors without re-shaving:

```sh
yakcc registry rebuild --path .yakcc/registry.sqlite
```

`rebuild` is idempotent and preserves all atom content byte-for-byte — only the embedding index is regenerated.

---

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `yakcc: command not found` | PATH not set or build skipped | Re-run `pnpm -r build` and re-export PATH (see [§2](#2-installation)). |
| Claude Code does not invoke the hook | `.claude/settings.json` missing the yakcc entry, or Claude Code not restarted after `yakcc init` | Run `yakcc hooks claude-code install` and restart Claude Code. Verify with `grep yakcc .claude/settings.json`. |
| Registry seems empty after `yakcc init` | Seed was skipped (`--no-seed`) or the bootstrap corpus is missing | Run `yakcc seed --yakcc` to seed manually. If that fails, check that `bootstrap/yakcc.registry.sqlite` exists in your repo clone (`git status bootstrap/`). |
| `federation mirror` fails with integrity error | Peer returned bytes that don't match the advertised BMR | Refuse the transfer (correct behavior). Contact the peer operator. |
| Every emission shows `outcome: "passthrough"` | Embedding model mismatch after a yakcc upgrade | Re-embed the registry: `yakcc registry rebuild --path .yakcc/registry.sqlite`. |
| Hook latency feels high (>200ms) | Cold embedding model on first call | Expected once per session; subsequent calls are warm-cached. If persistent, file an issue with a telemetry sample. |
| `yakcc shave <file>` fails with `DidNotReachAtomError` | A `CallExpression` in the source is neither atomic nor decomposable | Refactor the offending expression to a named helper, or add the file to `bootstrap/expected-failures.json` if you're contributing to yakcc itself. |
| `yakcc shave` rejects a file with `IntentCardSchemaError: behavior must not contain newline characters` | A function's JSDoc `@behavior` field spans multiple lines | Collapse `@behavior` to a single line; long descriptions go in the function body or a separate doc. |

---

## 13. Concurrency model

yakcc uses SQLite with WAL (Write-Ahead Logging) mode as its registry backend. Understanding
the concurrency model helps when running multiple yakcc processes against the same registry.

### Readers

**Many concurrent readers are fine.** WAL mode allows unlimited simultaneous read operations
with no interference between readers or between a reader and a single writer. Run as many
`yakcc query`, `yakcc search`, `yakcc compile`, or hook-intercept processes as you like —
they never block each other or block a writer.

### Writers

**Only one writer at a time per registry.** The commands that write to the registry are:

- `yakcc shave`
- `yakcc bootstrap`
- `yakcc registry rebuild`
- `yakcc federation mirror`
- `yakcc federation pull` (only when `--registry` is supplied)

yakcc enforces this with an **advisory write lock** — a `.write.lock` file in the same
directory as `registry.sqlite`. The first writer acquires the lock; subsequent writers
wait (polling) and error after a configurable timeout if the lock is never released.

**Default timeout:** 30 seconds. Override with `YAKCC_WRITE_LOCK_TIMEOUT_MS=<ms>`.

If a writer is killed mid-run the lock file may be left behind. yakcc detects this
automatically (the recorded PID is no longer alive) and steals the lock on the next write.
If automatic detection fails, remove `.yakcc/.write.lock` manually.

### Multi-developer teams

Don't share a single `.yakcc/registry.sqlite` over NFS or a network mount. Each
developer's local clone has their own registry; the `yakcc federation mirror` command
handles cross-developer atom sharing. Lock files over NFS are notoriously unreliable and
are explicitly **not** supported.

### CI environments

`bootstrap-accumulate.yml` is single-process by design — one CI job writes to the
registry at a time. If you need parallel CI jobs that each read from a shared registry,
have them all use `yakcc search` / `yakcc compile` (reader paths that don't acquire the
write lock).

---

## 14. Where to go next

- [`README.md`](../README.md) — yakcc-the-project overview, monorepo layout, contributor quickstart.
- [`docs/CONTRIBUTING.md`](CONTRIBUTING.md) — contributor orientation and pointers into the developer-docs archive.
- [`docs/archive/developer/MASTER_PLAN.md`](archive/developer/MASTER_PLAN.md) — architecture decisions and work-item history.
- [`docs/archive/developer/DESIGN.md`](archive/developer/DESIGN.md) — extended design rationale and contract philosophy.
- [`docs/archive/developer/VERIFICATION.md`](archive/developer/VERIFICATION.md) — verification ladder, triplet identity, TCB.
- [`docs/archive/developer/FEDERATION.md`](archive/developer/FEDERATION.md) — F0..F4 federation trust/scale axis.
- [`docs/archive/developer/MANIFESTO.md`](archive/developer/MANIFESTO.md) — project voice and intent.
- [`docs/archive/developer/PRIOR_ART.md`](archive/developer/PRIOR_ART.md) — defensive publication of the substrate's novel mechanisms.
- [`docs/archive/developer/V2_SELF_HOSTING_DEMO.md`](archive/developer/V2_SELF_HOSTING_DEMO.md) — the `yakcc bootstrap --verify` self-hosting proof.
- [`docs/archive/developer/adr/hook-layer-architecture.md`](archive/developer/adr/hook-layer-architecture.md) — D-HOOK-1..6 hook-layer decisions.

---

_If something in this walkthrough doesn't match what you observe, please [file an issue](https://github.com/cneckar/yakcc/issues/new). The walkthrough lives at `docs/USING_YAKCC.md` and is intended to track shipped software exactly._
