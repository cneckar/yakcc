# AGENTS.md — Yakcc orientation for AI agents

You have landed in a repo called Yakcc. Read this before touching anything.

## Where the canonical documents live

- `initialize.txt` — the project vision in the user's own words. Source of
  truth for *why* Yakcc exists.
- `MASTER_PLAN.md` — staged plan, exit criteria, non-goals, live work items,
  decision log, riskiest assumptions. Source of truth for *what we are doing
  next*.
- `DESIGN.md` — 15-minute orientation on philosophy and architecture. Source
  of truth for *how the pieces fit together*.
- `packages/<name>/README.md` — per-package contract. Source of truth for
  *what an individual package promises*.

If those four documents disagree, escalate to the user. Do not silently
reconcile.

## Cornerstone (do not violate without explicit replanning)

These invariants are load-bearing. They are restated from `MASTER_PLAN.md` so
you cannot miss them.

1. **No versioning.** No semver, no `latest`, no breaking-change event.
   Identity is the hash of the canonicalized contract spec.
2. **No ownership.** The registry is a public-domain commons. No
   `author_email`, no `signature`, not even reserved columns. The repo and
   every registered block are dedicated to the public domain under **The
   Unlicense** — a public-domain dedication, not a permissive copyright
   license. No owner is being preserved here.
3. **Content-addressed contracts.** Identity is the hash of the canonical
   spec. Verification evidence is mutable metadata attached to the immutable
   id.
4. **Embedding is just an index.** Vector similarity surfaces candidates;
   structural matching plus declared strictness decides selection. Cosine
   distance is never a correctness criterion.
5. **Composition from minimal blocks.** Minimum-viable code is the point.
   Do not pull in JSON-the-language to parse a list of ints.
6. **Monotonic registry.** Add, never delete.

If a change you are about to make conflicts with any of these, stop and
surface the conflict to the user. Do not proceed by relaxing a cornerstone
"just for v0" — there is no such relaxation.

## Where to write what

- **Plan, scope, exit criteria, decision log changes** → `MASTER_PLAN.md`.
  Permanent sections (Identity, Cornerstone, Architecture summary) are not
  edited without an explicit replanning request from the user.
- **Architecture or philosophy changes** → `DESIGN.md`. Update alongside the
  plan change that motivates them, not after the fact.
- **Per-package contracts (what the package promises, its public surface)**
  → `packages/<name>/README.md`.
- **Implementation code** → `packages/<name>/src/`, behind the package's
  facade interface. Stub responses are real responses with real types — no
  `TODO`, `placeholder`, or "not implemented" strings cross a package
  boundary.
- **Scratch, ephemera, generated artifacts under inspection** → `tmp/` at
  the repo root. Never `/tmp/`.
- **Examples and demoable artifacts** → `examples/<name>/`. The v0 demo is
  `examples/parse-int-list/`.

## Things explicitly not to do

- **Do not introduce versioning.** No semver, no `latest`, no migration
  scripts, no breaking-change events. Contracts are the identity.
- **Do not add author identity, signatures, or trust metadata.** No
  `author_email`, no `signature`, not even reserved nullable columns "for
  later". The cornerstone forbids it. Trust mechanisms, if they ever arrive,
  attach to immutable contract ids in a sidecar layer designed separately.
- **Do not let embedding similarity drive selection.** Embedding surfaces
  candidates only. Selection reads structural match results and declared
  strictness, never cosine distance.
- **Do not generate code in `@yakcc/compile`.** The compilation engine
  *composes* pre-written blocks from the registry. Synthesis lives in the
  hook (v0.5+). If you find yourself emitting code in `@yakcc/compile`,
  you are in the wrong package.
- **Do not pull in a generic library when a narrower one would do.** Yakcc
  cannot ship its own substrate by importing the problem it claims to
  solve. If the narrower dependency does not exist, that is a candidate
  basic block, not a justification for the wider one.
- **Do not write source code on `main`.** Implementation lands through the
  canonical chain (planner → guardian provision → implementer → reviewer →
  guardian land). The orchestrator only edits docs/config/non-source files
  that qualify for the Simple Task Fast Path.
- **Do not use `/tmp/`.** Use `tmp/` in the repo root.
- **Do not skip the IR validator.** ts-morph + ESLint enforce the strict
  TypeScript subset. A block that fails IR validation does not enter the
  registry — there is no override flag, by design.
- **Do not paper over disagreement between the plan and reality.** If the
  code shows the plan is wrong about *what* we are building, that is a
  replanning conversation. If the code shows the plan is wrong about *how*,
  the code wins and you record the rationale in the decision log.

## Before you open a PR — branch hygiene is load-bearing

A recurring pattern has burned hours of orchestrator time: a branch authored
before sibling work landed, "rebased" onto current main with conflicts
resolved by `--ours` for files outside the WI's scope, opens a PR that
silently deletes other sisters' landed work. The PR appears clean
(base SHA = current main) but its diff vs main shows large deletions in
files the WI never legitimately touched. Reviewers and orchestrators have
caught these post-hoc; the cost compounds with sister parallelism.

Every agent must run this check before clicking "ready for review":

```
git fetch origin main
git diff --stat origin/main..HEAD | tail -1
```

Or use the helper: `bash scripts/pre-pr-check.sh`.

**Two PR-stoppers:**

1. The total deletion count exceeds your scope manifest's expected deletions
   by more than ~10%.
2. Files outside your scope manifest appear in the diff at all (additions
   OR deletions).

Either condition means the branch is in stale-rebase damage. Recover via:

**Option A (recommended) — cherry-pick onto fresh:**

```
git fetch origin main
git checkout -b feature/<your-wi>-redo origin/main
git cherry-pick <your commits in order>
# Resolve conflicts by INTEGRATING both sides; never --ours for files
# outside scope.
```

**Option B — proper rebase:**

```
git fetch origin main
git rebase origin/main
# For files outside scope manifest, take --theirs (origin/main wins).
```

After either path, re-run the diff-stat check. Only when the diff matches
your scope manifest do you run `pnpm install && pnpm -r build && pnpm -r test`
locally. If both gates pass, open the PR.

**Cross-track damage is non-negotiable.** A PR that deletes another sister's
landed work — even if the rebase mechanically "resolved" the conflict — is
a regression and will be rejected at reviewer time. The sister who authored
the destroyed work has not approved its deletion; you do not have authority
to remove it. The fact that your branch's history pre-dates the deletion
target is not a defense.

If you find yourself with `--force-with-lease` queued against a branch that
has had multiple sibling tracks land underneath it, the answer is almost
always "cherry-pick onto fresh," not "force the rebase through."

## When stuck

Surface the blocker. Do not guess.

Specifically:

- If a requirement is ambiguous and `initialize.txt`, `MASTER_PLAN.md`, and
  `DESIGN.md` do not resolve it, ask the user.
- If your task appears to require violating a cornerstone, stop and ask. Do
  not proceed under a "temporary exception."
- If you discover the plan is materially wrong about *what* we are building,
  flag it as a replanning request rather than silently reinterpreting scope.
- If a tool, dependency, or piece of state you expected is missing, report
  it concretely (path, command, observed output) rather than working around
  it invisibly.

The user prefers a short, specific blocker report over confident prose that
papers over uncertainty. Confident prose is not a substitute for verifiable
state.
