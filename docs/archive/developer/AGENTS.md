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

## Before picking up any WI

**Check that the work isn't already done.** This is mandatory, not optional.

1. `gh issue view <N>` — if state is `closed`, stop. Do not re-implement.
2. `git fetch origin && git branch -r | grep <wi-number>` — if a branch
   already exists, read it. If the work is on `main` already, close the issue
   and stop. If the branch is open, coordinate rather than starting a parallel
   branch.
3. Search open PRs: `gh pr list --search "<wi-number>"` — if a PR is already
   open for this work item, do not open a second one. Comment on the existing
   PR instead.

Skipping this check and doing a full implementation of work that already
landed is the single most wasteful thing you can do on this project.

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
- **Do not resolve a closer/parity-WI gap by filtering the corpus.** When
  a closer or parity harness surfaces a gap between corpus shape and
  consumer capability (e.g. atoms unsupported by the wasm-backend, atoms
  missing source bytes, atoms below an arbitrary threshold), the routing
  default is *fix the consumer, not filter the corpus*. Filtering hides the
  signal the closer was designed to surface. See `DEC-CLOSER-CONSUMER-FIX-001`
  in `MASTER_PLAN.md` for the project-wide policy and precedents (#36,
  #125). Any future closer/parity WI MUST cite this DEC in its
  pre-assigned-decision section. Operator approval required for genuine
  corpus-filter exceptions.

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

## CI merge gate

Branch protection on `main` mechanically enforces the operator merge-gate
policy from `DEC-CI-MERGE-GATE-ENFORCE-001`: **`pnpm -r build` success is
THE merge gate**. Anything that takes >5 min (`pnpm -r test`, `bootstrap
--verify`, wave-3 parity, B6a air-gap) runs as advisory or post-merge and
does NOT gate merges.

### Required status checks

The following four `pr-ci.yml` jobs MUST pass before main accepts a merge:

- `lint (full workspace)` — Biome `useLiteralKeys`, `noNonNullAssertion`,
  format. Workspace-wide.
- `typecheck (full workspace)` — `tsc --noEmit` across all packages.
- `build (full workspace)` — `pnpm -r build`. Per `DEC-CI-MERGE-GATE-ENFORCE-002`
  amended 2026-05-11 (#320), the build step is the load-bearing gate;
  tests are advisory only.
- `branch hygiene check` — `scripts/pre-pr-check.sh` for stale-rebase
  damage detection (cross-track deletion guard).

### Explicitly NOT gating

- `test (affected packages, advisory)` — runs `pnpm $FILTER test` with
  `continue-on-error: true` at the job level. Failure surfaces in the PR
  UI for fast feedback but does NOT block the merge button.
- `B6a air-gap benchmark` — runs separately; not in required-checks list
  (legitimate B6a issues are tracked separately at #190).
- `bootstrap --verify`, wave-3-parity — async via push:main on their own
  workflow files.

### Knob choices (`DEC-CI-MERGE-GATE-ENFORCE-004`)

- `enforce_admins=false` — retains `gh pr merge --admin` as operator
  escape valve for the failure mode where the gate itself is broken.
- `required_pull_request_reviews=null` — the canonical reviewer agent is
  the technical-readiness authority per the canonical chain in CLAUDE.md;
  no human PR review required on top.
- `allow_force_pushes=false` — Sacred Practice #2 (Main is Sacred).
- `allow_deletions=false` — history-preservation invariant.

### Operator-decision boundary (`DEC-CI-MERGE-GATE-ENFORCE-005`)

The `gh api -X PUT repos/cneckar/yakcc/branches/main/protection` call is a
state-of-repository change beyond a normal source commit. The orchestrator
MUST surface the proposed JSON to the operator for confirmation BEFORE
the API call is issued. This applies to:

- Initial protection turn-on
- Adding a new required-status-check name (e.g., when B6a stabilizes)
- Removing or relaxing any knob

The orchestrator surfaces the proposed JSON via a comment on the WI issue;
operator runs the command themselves after confirming. The proposed JSON
for the initial turn-on lives at `tmp/wi-297-planning/wi-297-branch-protection-proposed.json`.

### Inspect current state

```bash
gh api repos/cneckar/yakcc/branches/main/protection --jq '.required_status_checks'
```

Returns 404 "Branch not protected" if no protection is configured.
Returns the contexts JSON if protection is on.

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
