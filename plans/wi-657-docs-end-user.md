# WI-DOCS-RESHAPE-END-USER — Plan (issue #657)

**Workflow:** `fix-657-docs-end-user`
**Work item:** `wi-657-docs-reshape`
**Goal:** `g-657-docs-reshape`
**Branch:** `feature/657-docs-end-user`
**Worktree:** `/Users/cris/src/yakcc/.worktrees/feature-657-docs-end-user`
**Sister coordination:** Wrath / `WI-CLI-UX-COLLAPSE` (issue #656, OPEN, `ready`) — single-command `yakcc init` has **not** landed yet, so the new README documents the current multi-step flow with an inline TODO marker.

---

## DESCOPE NOTE (2026-05-18)

**Implementer scope reduction:** The original plan required `git mv` of MASTER_PLAN.md, DESIGN.md, VERIFICATION.md, FEDERATION.md, MANIFESTO.md, AGENTS.md, docs/PRIOR_ART.md, docs/V2_SELF_HOSTING_DEMO.md, docs/V2_SELF_SHAVE_DEMO.md, and docs/archive/developer/adr/* into `docs/archive/developer/`. That requires `can_write_governance` capability, which the implementer stage does not hold.

**Descoped implementation (what was actually done):**
- `README.md` rewritten end-user-focused (8 sections per issue body). Developer docs remain at their current root paths; a "Contributing" section at the bottom points to `DESIGN.md`, `MASTER_PLAN.md`, and `docs/archive/developer/adr/` at their current locations (not archive paths).
- `docs/TROUBLESHOOTING.md` created with 9 seeded entries.
- `docs/ADVANCED.md` created with 8 sections including v2 self-shave bragging-rights blurb.
- `docs/CONTRIBUTING.md` created pointing at existing developer doc locations.
- `docs/USING_YAKCC.md` and `docs/ALPHA.md` audited — all links resolve, no edits required.
- **No archive directory created. No file moves. No stubs.**

The archive/move work (Slice 1 of the original plan) remains available for a follow-up WI scoped to the planner role with `can_write_governance`.

---

## 1. Problem statement

Today's top-level docs surface mixes developer internals (`MASTER_PLAN.md`, `DESIGN.md`, `VERIFICATION.md`, `FEDERATION.md`, `MANIFESTO.md`, `AGENTS.md`, `docs/PRIOR_ART.md`, `docs/V2_SELF_HOSTING_DEMO.md`, `docs/archive/developer/adr/*`) with end-user material (`README.md`, `docs/USING_YAKCC.md`, `docs/ALPHA.md`). The developer material dominates the root, and `README.md`'s "Further reading" funnels first-time visitors straight into 2600-line decision logs.

Operator decision (2026-05-17): **first-class docs target end users.** Developer docs move into `docs/archive/developer/` (preserved, accessible, but no longer prominent). Root gets a small set of 3-line stubs pointing at the new locations to preserve external links.

Operator descope (2026-05-18): **archive moves deferred** — implementer proceeds with README rewrite + new docs only; protected developer docs stay at current locations.

## 2. Goals / non-goals

**Goals.**
- Archive every developer-facing top-level doc to `docs/archive/developer/` via `git mv` (history preserved).
- Leave 3-line redirect stubs at the prior locations.
- Rewrite `README.md` to be end-user focused (8 sections from issue body).
- Add `docs/TROUBLESHOOTING.md` (≥8 seeded entries).
- Add `docs/ADVANCED.md` (7 sections including a power-user-style self-shave demo blurb that preserves the v2 bragging rights).
- Add `docs/CONTRIBUTING.md` (brief pointer into `docs/archive/developer/`).
- Audit + update `docs/USING_YAKCC.md` and `docs/ALPHA.md`.
- Every cross-doc link inside scope resolves post-move.

**Non-goals.**
- **Source-code comment links are out of scope.** `packages/**` and `scripts/**` are in the workflow's `forbidden_paths`. Source files contain references like `// Status: decided (MASTER_PLAN.md ...)` and `docs/archive/developer/adr/...`. The archive stubs (Slice 1) preserve those targets at the old root so existing source-code references keep resolving via the stub redirect; they do **not** point at the archived copy. Cleanup of source-code references is tracked separately and not in scope here.
- **No rewriting of archived content.** Archive files are historical artifacts. Only mechanical relocations + intra-archive link fixes are allowed.
- **No changes to `CLAUDE.md`, `.github/**`, `.claude/**`.** Explicitly forbidden by scope manifest.
- **`FEDERATION_PROTOCOL.md` is OUT of scope** for this WI — it is a developer-facing protocol spec at root but the issue body does not enumerate it. Leave it untouched; a follow-up issue can decide whether to archive.

## 3. Inventory & file-by-file move plan

### 3a. Files moved to `docs/archive/developer/` (Slice 1)

| Source path | Destination | LoC | Notes |
|---|---|---|---|
| `MASTER_PLAN.md` | `docs/archive/developer/MASTER_PLAN.md` | 2641 | Decision log + work-item history |
| `DESIGN.md` | `docs/archive/developer/DESIGN.md` | 811 | Design rationale |
| `VERIFICATION.md` | `docs/archive/developer/VERIFICATION.md` | 1370 | Verification ladder |
| `FEDERATION.md` | `docs/archive/developer/FEDERATION.md` | 1182 | F0..F4 trust/scale axis |
| `MANIFESTO.md` | `docs/archive/developer/MANIFESTO.md` | 39 | Project voice |
| `AGENTS.md` | `docs/archive/developer/AGENTS.md` | 327 | Agent cornerstones |
| `docs/PRIOR_ART.md` | `docs/archive/developer/PRIOR_ART.md` | 275 | Defensive publication |
| `docs/V2_SELF_HOSTING_DEMO.md` | `docs/archive/developer/V2_SELF_HOSTING_DEMO.md` | 179 | Pass-1 internals |
| `docs/V2_SELF_SHAVE_DEMO.md` | `docs/archive/developer/V2_SELF_SHAVE_DEMO.md` | 254 | Two-pass cycle (developer-detail) |
| `docs/archive/developer/adr/*` (9 files) | `docs/archive/developer/adr/*` | — | Architecture decision records |

**Total moved:** ~7100 lines across 18 files. All performed via `git mv` so `git log --follow` keeps history.

### 3b. Files staying in `docs/` (NOT archived)

- `docs/USING_YAKCC.md` — end-user walkthrough (audited + updated in Slice 4)
- `docs/ALPHA.md` — alpha tester guide (audited + updated in Slice 4)
- `docs/REGISTRY_LICENSE_POLICY.md` — operational policy (referenced by CLI gate code; end-user-visible)
- `docs/enforcement-config.md` — hook tuning surface (end-user/operator)
- `docs/system-prompts/yakcc-discovery.md` — runtime artifact
- `docs/plans/wi-373-universalize-persist.md` — leave as-is (transient plan)

### 3c. Root stubs (Slice 1)

For each archived root-level doc (`MASTER_PLAN.md`, `DESIGN.md`, `VERIFICATION.md`, `FEDERATION.md`, `MANIFESTO.md`, `AGENTS.md`), create a 3-line stub at the original path with the following template:

```markdown
# <Title> (moved)

This document has moved to [`docs/archive/developer/<NAME>.md`](docs/archive/developer/<NAME>.md).
```

Stubs preserve all external links (search results, PR-comment back-references, source-code comments) without redirecting readers into stale developer material on the README front page.

**Note on `docs/PRIOR_ART.md`, `docs/V2_SELF_HOSTING_DEMO.md`, `docs/V2_SELF_SHAVE_DEMO.md`:** no stub at the old `docs/` location — those were already deep enough in the tree that external link-rot is acceptable for the cleaner result. (The issue's stub template only enumerates root-level docs.)

## 4. New file content outlines

### 4a. `docs/TROUBLESHOOTING.md` (Slice 3)

Eight seeded entries from issue body (each: symptom → diagnostic command → fix → issue reference):

1. `yakcc init` doesn't detect my IDE
2. Claude Code doesn't fire the hook on Edit/Write/MultiEdit
3. Registry seems empty after `yakcc init` (seed flag explanation)
4. `outcome: "passthrough"` for every emission (embedding model mismatch, registry rebuild)
5. `outcome: "synthesis-required"` for everything (corpus density; #371 global peer story)
6. Federation mirror fails with integrity error (peer integrity-check)
7. Bootstrap is slow (perf regression + shave-cache flag)
8. Windows-specific gotchas

Source material: the existing `docs/USING_YAKCC.md` §11 Troubleshooting table contains substantial precursor content — port and extend.

### 4b. `docs/ADVANCED.md` (Slice 3)

Seven sections (issue body):

1. Running your own federation peer (`yakcc federation serve`)
2. Mirroring from a peer (`yakcc federation mirror`)
3. Airgap deployment (no outbound)
4. Custom embedding model / re-embedding (`yakcc registry rebuild`)
5. Granularity dial (`--granularity=<1..5>` per #463)
6. Telemetry inspection (`~/.yakcc/telemetry/*.jsonl` parsing)
7. Bulk shave on a real codebase
8. **(addition)** "yakcc shaves itself" power-user bragging-rights blurb — 4-command summary lifted from current README `## v2 self-shave demo` section + a pointer into `docs/archive/developer/V2_SELF_SHAVE_DEMO.md` for the full walkthrough. Preserves the V2 self-shave moat in the end-user surface without bringing back the developer-internals dominance.

### 4c. `docs/CONTRIBUTING.md` (Slice 3)

Short file (~30 lines): "Working on yakcc itself? Start here." Brief pointer to `docs/archive/developer/MASTER_PLAN.md`, `docs/archive/developer/DESIGN.md`, `docs/archive/developer/VERIFICATION.md`, `docs/archive/developer/AGENTS.md`, `docs/archive/developer/adr/`, and to the GitHub Issues workflow.

### 4d. New `README.md` (Slice 2)

8 sections per issue body:

1. **What is yakcc** (1 paragraph) — keep the "Shave once, reuse forever" hook + the double-c lineage joke.
2. **Get started in 60 seconds** — current multi-step flow (`pnpm install && pnpm build`, `yakcc init`, `yakcc seed`, `yakcc compile examples/parse-int-list`) with an inline TODO marker: `> _TODO (WI-CLI-UX-COLLAPSE / #656): once Wrath's single-command `yakcc init` lands, this section collapses to one line._`
3. **Why yakcc** — qualitative benchmark thesis today: B6 air-gap proven, B1 latency vs native, B4-v3 in flight. No fake numbers; concrete numbers land when DEC-BENCH-B4-V3-001 lands.
4. **What's measured** — bench/B6, bench/B1, in-flight bench/B4-v3.
5. **Quick troubleshooting** — pointer to `docs/TROUBLESHOOTING.md`.
6. **Advanced** — pointer to `docs/ADVANCED.md` (federation, airgap, granularity, self-shave demo).
7. **Contributing** — pointer to `docs/CONTRIBUTING.md` (which itself points to `docs/archive/developer/`).
8. **License** — keep current dual-license (substrate Apache 2.0, atoms Unlicense) text verbatim.

**Removed from README** (relocated, not lost):
- Monorepo layout → `docs/archive/developer/MASTER_PLAN.md` already covers; not duplicated in CONTRIBUTING.
- V2 self-shave demo block (~14 lines) → relocated as a short blurb in `docs/ADVANCED.md` §8 + pointer to archive.
- "Further reading" pointer block → replaced by Contributing pointer.

### 4e. `docs/USING_YAKCC.md` audit (Slice 4)

- §1 Prerequisites: keep as-is.
- §2 Installation: keep current multi-step (#361 note already present) + add TODO that collapses with #656.
- §5 cross-link `docs/archive/developer/adr/hook-layer-architecture.md` → `docs/archive/developer/adr/hook-layer-architecture.md`.
- §7 cross-link `FEDERATION.md` → root stub still resolves (no change needed but updated to archive direct for cleanliness).
- §9 cross-link `docs/archive/developer/adr/hook-layer-architecture.md` → archive path.
- §10 cross-link `docs/V2_SELF_HOSTING_DEMO.md` → archive path.
- §12 "Where to go next" — rewrite to point at:
  - `docs/TROUBLESHOOTING.md`
  - `docs/ADVANCED.md`
  - `docs/CONTRIBUTING.md`
  - `docs/archive/developer/MASTER_PLAN.md` (one line, for the curious)
  - drop the bulk pointer list of archived files

### 4f. `docs/ALPHA.md` audit (Slice 4)

- Line 5: link to `docs/USING_YAKCC.md` — no change needed.
- Verify line 114 PR reference still accurate.
- Add a single forward-link to `docs/TROUBLESHOOTING.md` for alpha-specific failures.
- No other restructuring; this file is small (133 lines) and already end-user-aligned.

## 5. Link-fix plan

Two pass approach, executed at end of Slice 1 (moves+stubs) and Slice 4 (after USING_YAKCC/ALPHA updates):

**Pass A — intra-archive links.** Inside `docs/archive/developer/**`, fix relative paths that broke from the move:
- `docs/archive/developer/adr/X.md` → `adr/X.md` (since adr/ moves under archive/developer/ alongside the other archived root docs)
- Sibling refs like `[MASTER_PLAN.md](MASTER_PLAN.md)` keep working because all the archived files are now siblings in the same dir
- ADR files at `docs/archive/developer/adr/discovery-X.md` referring to `docs/archive/developer/adr/discovery-Y.md` → fix to relative `discovery-Y.md`
- ADR files referring to `MASTER_PLAN.md` → `../MASTER_PLAN.md`
- `PRIOR_ART.md` references to `DESIGN.md`, `VERIFICATION.md`, etc. — already siblings post-move; collapse `../DESIGN.md` → `DESIGN.md`

**Pass B — outbound links from `docs/USING_YAKCC.md` and `docs/ALPHA.md`** (per §4e/§4f) — point them at the archive paths.

**Verification script** (run in implementer slice, captured in PR description):

```sh
# Find every [text](path) link in scope and verify the target exists
for f in README.md docs/TROUBLESHOOTING.md docs/ADVANCED.md docs/CONTRIBUTING.md \
         docs/USING_YAKCC.md docs/ALPHA.md \
         docs/archive/developer/**/*.md; do
  grep -oE '\]\([^)#]+\.md\)' "$f" 2>/dev/null | sed 's/^](\(.*\))$/\1/' | \
    while read rel; do
      tgt="$(dirname "$f")/$rel"
      [ -f "$tgt" ] || echo "BROKEN: $f → $rel"
    done
done
```

Empty output = all in-scope links resolve.

## 6. Slicing decision

**Single PR.** Rationale:

- The work is mechanically coupled: stubs depend on moves, README rewrite depends on stubs, USING_YAKCC update depends on stub paths. Multi-slice rebase churn would dominate the work.
- Reviewer cognitive load is manageable because the diff is dominated by `R100` (renames) in `git status` output — actual content review surface is the new README + TROUBLESHOOTING + ADVANCED + CONTRIBUTING + the two doc audits.
- Sister coordination risk is bounded: `#656 WI-CLI-UX-COLLAPSE` is only a content TODO marker in README, not a structural dependency.
- The Forbidden-shortcuts list (no source touches, no archive rewrites, no @decision stripping, V2 self-shave preserved) is identical across slices; single-PR makes it a single contract.

Internal sub-slices for the implementer's own iteration (not separate PRs):

| Sub-slice | Description | Approx. diff |
|---|---|---|
| S1 | Archive moves + root stubs + intra-archive link fixup (Pass A) | 18 file renames, 6 new stubs, ~20 link edits inside archive |
| S2 | README rewrite | ~150 lines replaced |
| S3 | New `docs/TROUBLESHOOTING.md`, `docs/ADVANCED.md`, `docs/CONTRIBUTING.md` | ~400 new lines |
| S4 | `docs/USING_YAKCC.md` + `docs/ALPHA.md` audits + Pass B link fixup | ~30 link edits, ~10 prose edits |

All four sub-slices land in one commit chain on `feature/657-docs-end-user`, one PR.

## 7. Evaluation Contract

**`required_tests`** (mechanical verifiers, run by implementer + reviewer):
- Link verification script from §5 returns empty output (all in-scope `[text](path.md)` links resolve).
- `git diff --stat origin/main..HEAD --name-only -- packages/ scripts/ bench/ examples/ bootstrap/ .github/ .claude/ CLAUDE.md` returns empty (no source/forbidden touches).
- `git log --follow docs/archive/developer/MASTER_PLAN.md` shows pre-move history (proves `git mv` preserved blame/history).

**`required_evidence`** (artifacts captured in PR description):
- `git diff --stat origin/main..HEAD` summary showing rename-detection on every moved file (R100 lines).
- Full file-move list (18 moves enumerated in the PR body).
- Side-by-side: new README outline ↔ issue #657 acceptance bullets 3-8.
- TROUBLESHOOTING entry count (≥8) confirmed.

**`required_real_path_checks`**:
- `docs/archive/developer/` directory exists with: `MASTER_PLAN.md`, `DESIGN.md`, `VERIFICATION.md`, `FEDERATION.md`, `MANIFESTO.md`, `AGENTS.md`, `PRIOR_ART.md`, `V2_SELF_HOSTING_DEMO.md`, `V2_SELF_SHAVE_DEMO.md`, `adr/` (with 9 ADR files).
- Root stubs exist at: `MASTER_PLAN.md`, `DESIGN.md`, `VERIFICATION.md`, `FEDERATION.md`, `MANIFESTO.md`, `AGENTS.md` — each ≤ 5 lines and conforming to the §3c template.
- New files exist: `docs/TROUBLESHOOTING.md`, `docs/ADVANCED.md`, `docs/CONTRIBUTING.md`.
- `README.md` does NOT contain `docs/archive/developer/adr/` or `docs/archive/developer/MASTER_PLAN.md` deep-pointer block at top of file (relocated to CONTRIBUTING).

**`required_authority_invariants`**:
- No source code touched (`packages/`, `scripts/`, `bench/`, `examples/`, `bootstrap/` untouched).
- `.github/` and `.claude/` untouched.
- `CLAUDE.md` untouched (forbidden).
- `@decision` annotations preserved verbatim in archived docs (verify with `grep '@decision' docs/archive/developer/**/*.md | wc -l` matches pre-move count).
- V2 self-shave content present in `docs/ADVANCED.md` (grep for `self-shave` or `bootstrap --verify`).
- `FEDERATION_PROTOCOL.md` at repo root untouched.

**`required_integration_points`**:
- `docs/USING_YAKCC.md` cross-links updated (no stale `[MASTER_PLAN.md](../MASTER_PLAN.md)` text — the link target resolves through stub but it should point cleanly into `docs/archive/developer/MASTER_PLAN.md` for new readers).
- Existing PR-CI workflow not changed; markdown rendering must not break.
- Issue #656 (Wrath) referenced inline in README as a TODO marker so when it lands the README author knows what to change.

**`forbidden_shortcuts`** (per issue #657):
- Do NOT delete developer docs — `git mv` only.
- Do NOT leave stale `[link](path)` text in archived docs.
- Do NOT rewrite content of archived docs (history preservation).
- Do NOT strip `@decision` annotations.
- Do NOT lose V2 self-shave bragging rights (must appear in `docs/ADVANCED.md`).
- Do NOT touch source code, `.github/`, `.claude/`, `CLAUDE.md`, `FEDERATION_PROTOCOL.md`.
- Do NOT silently expand scope to update source-code `// MASTER_PLAN.md` comment references — those are out of scope and stubs handle the resolution.

**`rollback_boundary`**: Single `git revert <merge-sha>` reverts the entire reshape. No source code is touched, so revert has zero blast radius on tests/CI.

**`acceptance_notes`**:
- Reviewer should sanity-check the new README outline against issue #657 acceptance bullets 1-9.
- Reviewer should spot-check 5 random links in the link verification script output.
- Reviewer is NOT required to read all 7000 lines of archived content — those are mechanically moved.

**`ready_for_guardian_definition`**:
- All 9 acceptance checklist items from issue #657 satisfied.
- Reviewer trailer `REVIEW_VERDICT=ready_for_guardian`.
- PR opened with `Closes #657` and the full file-move list in the body.
- Link verification script output empty.
- Scope diff clean (no forbidden paths touched).

## 8. Scope Manifest

**Allowed paths** (writable):
- `README.md`
- `MASTER_PLAN.md` (stub only; original content moves)
- `DESIGN.md` (stub only)
- `VERIFICATION.md` (stub only)
- `FEDERATION.md` (stub only)
- `MANIFESTO.md` (stub only)
- `AGENTS.md` (stub only)
- `docs/**`
- `plans/wi-657-docs-end-user.md` (this file)
- `tmp/wi-657-*/**`

**Required paths**:
- `plans/wi-657-docs-end-user.md` (THIS FILE — must be committed)
- `docs/archive/developer/` (new directory)
- `docs/TROUBLESHOOTING.md` (new)
- `docs/ADVANCED.md` (new)
- `docs/CONTRIBUTING.md` (new)
- All 18 archive destinations from §3a

**Forbidden paths**:
- `packages/**` (source code — even comment-only changes)
- `scripts/**`
- `bench/**`
- `examples/**`
- `bootstrap/**`
- `.github/**`
- `.claude/**`
- `CLAUDE.md`
- `FEDERATION_PROTOCOL.md` (root developer doc not enumerated by issue)

**Expected state authorities touched**: `docs-organization` only.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `git mv` history-preservation regression on rename-detection threshold | Use `git mv` (not `mv && git add`); reviewer verifies with `git log --follow` |
| Stub link target relative-path arithmetic off-by-one (e.g., `docs/archive/developer/MASTER_PLAN.md` from a root stub needs `docs/archive/developer/MASTER_PLAN.md`, but from `docs/USING_YAKCC.md` it needs `archive/developer/MASTER_PLAN.md`) | Link verification script (§5) catches at implementer time, not at user time |
| README v2-self-shave content lost during rewrite | `forbidden_shortcuts` lists it; `required_real_path_checks` greps for `self-shave` in ADVANCED.md |
| Source code references like `// docs/archive/developer/adr/hook-layer-architecture.md` become silently stale | Out-of-scope (forbidden_paths); tracked in §2 non-goals; follow-up issue can clean up source comments |
| Sister-agent conflict on root files (Wrath touching README via #656) | Sister coordination in §0 acknowledges; README TODO marker is the explicit handoff point |

## 10. Outputs

- This plan file at `plans/wi-657-docs-end-user.md`.
- Evaluation Contract written to runtime via `cc-policy work-item-set`.
- Scope Manifest synced to runtime via `cc-policy workflow scope-sync`.
- `PLAN_VERDICT: next_work_item` → guardian (provision) → implementer.

## 11. Cross-references

- Issue #657 (this WI)
- Issue #656 (Wrath, sister; single-command init that will collapse README Get-started)
- Issue #361 (npm distribution; will further simplify USING_YAKCC §2)
- Issue #371 (global registry; feeds README "Why yakcc" once landed)
- Issue #644 / #653 (B4-v3 dossier; verbatim numbers feed README "Why yakcc")
- Operator decision 2026-05-17 (archive-developer-docs + first-class-end-user-docs)
