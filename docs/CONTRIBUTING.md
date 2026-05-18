# Contributing to yakcc

Working on yakcc itself? Start here.

## Where the developer docs live

The full developer documentation — architecture decisions, design rationale, verification ladder, agent cornerstones, federation spec, and ADRs — lives at these paths in the repository:

- [`DESIGN.md`](../DESIGN.md) — extended design rationale and contract philosophy
- [`MASTER_PLAN.md`](../MASTER_PLAN.md) — architecture decisions and work-item history
- [`VERIFICATION.md`](../VERIFICATION.md) — verification ladder, triplet identity, TCB
- [`AGENTS.md`](../AGENTS.md) — agent cornerstones and orchestration model
- [`FEDERATION.md`](../FEDERATION.md) — F0..F4 federation trust/scale axis
- [`docs/adr/`](adr/) — architecture decision records (9 ADRs)

## Where to start

1. Read `DESIGN.md` for the design principles and contract philosophy.
2. Read `MASTER_PLAN.md` for open work items and prior decisions.
3. Check [github.com/cneckar/yakcc/issues](https://github.com/cneckar/yakcc/issues) for the open issue queue — pick a `ready` issue.
4. Work in a git worktree on a feature branch — never directly on `main`.
5. Follow the `@decision` annotation format for any significant new code (50+ lines).

## Sending a PR

- Feature branches: `feature/<issue-number>-short-description`
- Commit message: imperative mood, reference the issue number.
- PR description: include the `Closes #<N>` trailer so the issue auto-closes on merge.
- CI must pass: `pnpm -r build && pnpm -r test` should be green before requesting review.

## Questions

File a GitHub issue or leave a comment on the relevant open issue. The team triages within 72 hours for substantive contributions.
