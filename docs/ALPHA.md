# yakcc v0.5.0-alpha — tester guide

Welcome. You're early. This document tells you what we're testing, what's known broken, and how to send feedback so we can iterate fast.

This is **not** the end-user walkthrough — that lives at [`docs/USING_YAKCC.md`](USING_YAKCC.md). Read that first; this file adds the alpha-specific context.

---

## What this alpha is

**`v0.5.0-alpha.0` is the first version of yakcc anyone outside the core team has used.** The flywheel works — every Claude Code / Cursor session you run can hit registry atoms (`registry-hit`), pass through your own emission (`passthrough`), or atomize your novel code into the local registry for future sessions (`atomized`). The corpus grows as you use it.

What we're testing:

1. **The walkthrough is honest.** Following [`docs/USING_YAKCC.md`](USING_YAKCC.md) end-to-end should produce the experience it describes, without you having to read source or dig in Discord. If it doesn't, that's the most important bug class.
2. **The flywheel is real.** Atomize an emission once, see it surface in the next session's `yakcc query`. If the round-trip is silent or surfaces wrong atoms, we need to know.
3. **The cost story holds.** Hooked Claude/Cursor on your real work should produce fewer output tokens than unhooked Claude/Cursor on the same task, at equal-or-better quality. Telemetry captures the data; we'll ask for snapshots.
4. **Cold-start is tolerable.** Even with the bundled yakcc corpus (`yakcc seed --yakcc`), early sessions on your code may see lots of `synthesis-required`. That's expected; what matters is whether it improves week-over-week as your personal corpus grows.

What we are **not** testing in this alpha:

- **Cross-machine federation** — F1 mirror works but the global registry (`yakcc.dev` peer) does not exist yet. If you set up a team peer, that's beta-territory work.
- **AssemblyScript / WASM backend** — partial; AS Phase 2 is still in flight. Most atom-execution paths are TypeScript only for v0.5.
- **Production performance** — `yakcc bootstrap` has a known 30+ minute regression on schema v9 (tracked at [#377](https://github.com/cneckar/yakcc/issues/377), fix imminent). Daily incremental shave caching is on the roadmap at [#363](https://github.com/cneckar/yakcc/issues/363).

---

## Install (alpha-specific)

The binary distribution is in flight at [#361](https://github.com/cneckar/yakcc/issues/361). For this alpha, **clone-from-monorepo is the install path**:

```sh
git clone https://github.com/cneckar/yakcc.git ~/.yakcc-cli
cd ~/.yakcc-cli
git checkout v0.5.0-alpha.0    # pin to the alpha tag
pnpm install --frozen-lockfile
pnpm -r build
export PATH="$HOME/.yakcc-cli/packages/cli/dist:$PATH"
yakcc --version    # confirm
```

Then in your own project:

```sh
cd ~/my-project
yakcc init                    # creates .yakcc/, .yakccrc.json, wires Claude Code hook
yakcc seed --yakcc            # imports yakcc's ~4k atoms as your starter corpus
```

Open Claude Code in the project. Ask it to do real work. Watch the hook fire.

### Known platform notes

- **Linux / macOS:** primary alpha targets. Everything in the walkthrough should work.
- **Windows:** alpha-supported. `yakcc init` Windows behavior is being verified at [#385](https://github.com/cneckar/yakcc/issues/385); if you hit a no-op `yakcc init`, that's the bug — file with platform info.

---

## Known broken / known limited

Things we know about, in priority order. **You will hit some of these.** That's the point of the alpha.

| What | Status | Issue |
|---|---|---|
| Substitution-integration: 4 specific test cases fail | Under triage; classifying which (if any) hit real-world usage | [#365](https://github.com/cneckar/yakcc/issues/365) |
| Bootstrap perf: schema v9 write path 30+min vs prior 5min | Fix in flight, lands within ~3 hours of investigation | [#377](https://github.com/cneckar/yakcc/issues/377) |
| Windows `yakcc init` may no-op | Under investigation; #274 fix may be incomplete | [#385](https://github.com/cneckar/yakcc/issues/385) |
| No standalone binary yet (`npm install -g` or single executable) | Wrath active; binary lands ~1-2 weeks | [#361](https://github.com/cneckar/yakcc/issues/361) |
| No global registry peer (`yakcc.dev`) yet | Post-v0 by design; alpha = your local corpus + yakcc seed | [#371](https://github.com/cneckar/yakcc/issues/371) |
| Codex CLI hook not wired | Deferred to v0.5+ on demand | [#220](https://github.com/cneckar/yakcc/issues/220) (closed not-planned) |
| Recursive self-hosting proof not yet green | Surgical fix in flight; load-bearing for v2 narrative not v0 use | [#355](https://github.com/cneckar/yakcc/issues/355) |
| Shave cache (`--verify` flag for byte-identical) not yet built | Daily-UX improvement; v0.5+ | [#363](https://github.com/cneckar/yakcc/issues/363) |

If you hit something **not** on this list, that's the bug we want to hear about.

---

## How to send feedback

GitHub issues are the official channel. Use the **alpha-feedback** issue template:

> https://github.com/cneckar/yakcc/issues/new?template=alpha-feedback.md

The template asks for:

- Your yakcc version (output of `yakcc --version` or the git SHA you cloned)
- Platform (Linux/macOS/Windows + arch + Node version)
- What you tried (exact commands)
- What you expected
- What happened
- Telemetry sample (last ~10 lines of `~/.yakcc/telemetry/*.jsonl`)
- Any error output / logs

The telemetry sample is the most useful diagnostic we have. Please include it. It's local-only, never leaves your machine until you paste it into a GitHub issue.

### Triage SLA

- **Crashes / data loss / wrong output**: triaged within 24h, fix within 72h or workaround documented
- **UX rough edges**: triaged within 72h, batched into the next walkthrough revision
- **Feature requests**: triaged on a weekly cadence, parked in the v0.5+ queue with a note

We're not promising hotfixes for cosmetic issues. We are promising to read every report.

---

## What's in this alpha (one-paragraph CHANGELOG)

`v0.5.0-alpha.0` ships:
- **Hook layer** (#194) — Claude Code + Cursor adapters wired; intercepts `Edit|Write|MultiEdit`; routes through local registry first.
- **Corpus flywheel** (#362, PR #368) — every novel emission becomes an atom in your local registry, discoverable in the next session.
- **Local registry + sqlite-vec** — content-addressed, embeddings-indexed, BLAKE3-keyed atom storage.
- **F1 federation** — mirror/serve/pull a registry over HTTP; integrity check on every transfer.
- **Smoke test** (#360, PR #370) — nightly CI verifies the full install→init→use→atomize→re-query loop.
- **End-user walkthrough** (#205, PR #367) — 11-section `docs/USING_YAKCC.md`.
- **AssemblyScript backend Phase 1** (#145) — TS atoms compile to WASM; full coverage is Phase 2 in flight.

---

## What's next (post-alpha-0 trajectory)

- `v0.5.0-alpha.1`: substitution-integration fixes (#365), bootstrap perf (#377), Windows bin fix (#385), starter-corpus polish.
- `v0.5.0-beta.0`: binary distribution (#361, Wrath active), shave cache (#363), recursive self-hosting proof closure (#355).
- `v0.5.0`: global registry peer (#371), OSS-libs shave campaign begins, B4 token-savings benchmark published.

We'll cut a new alpha tag for each substantive fix wave. Pin to a specific tag in your install instructions; we'll announce when to move forward.

---

## Thank you

You're testing software whose primary value-proposition is "every session grows the corpus, and the corpus saves you tokens." That value emerges over time, not on day 1. Your feedback during the awkward early period is what lets us reshape the rough edges before public launch.

We owe you working software in return. If something is broken in a way that wastes your time, tell us — that's the most useful signal we can get.
