# Contributing to yakcc

Working on yakcc itself? Start here.

## Where the developer docs live

The full developer documentation — architecture decisions, design rationale, verification ladder, agent cornerstones, federation spec, and ADRs — lives in [`docs/archive/developer/`](archive/developer/) to keep the top-level focused on end-user material.

- [`MASTER_PLAN.md`](archive/developer/MASTER_PLAN.md) — decision log and work-item history (load-bearing audit trail)
- [`DESIGN.md`](archive/developer/DESIGN.md) — extended design rationale and contract philosophy
- [`VERIFICATION.md`](archive/developer/VERIFICATION.md) — verification ladder, triplet identity, TCB
- [`AGENTS.md`](archive/developer/AGENTS.md) — sister-agent operating guide and orchestration cornerstones
- [`FEDERATION.md`](archive/developer/FEDERATION.md) — F0..F4 federation trust/scale axis
- [`MANIFESTO.md`](archive/developer/MANIFESTO.md) — project voice and intent
- [`PRIOR_ART.md`](archive/developer/PRIOR_ART.md) — defensive publication of substrate's novel mechanisms
- [`V2_SELF_HOSTING_DEMO.md`](archive/developer/V2_SELF_HOSTING_DEMO.md) — v2 self-hosting technical walkthrough
- [`adr/`](archive/developer/adr/) — architecture decision records

The original root-level paths (`MASTER_PLAN.md`, `DESIGN.md`, etc.) are now 3-line stubs pointing at the archive, preserving external links and PR references.

## Where to start

1. Read [`DESIGN.md`](archive/developer/DESIGN.md) for the design principles and contract philosophy.
2. Read [`MASTER_PLAN.md`](archive/developer/MASTER_PLAN.md) for open work items and prior decisions.
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
