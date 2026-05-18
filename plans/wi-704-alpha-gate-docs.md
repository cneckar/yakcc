# WI-704 Plan — Alpha-gate docs: B3 PROTOCOL.md + ALPHA install update

**Issue:** #704
**Branch:** `feature/704-alpha-gate-docs`
**Worktree:** `/Users/cris/src/yakcc/.worktrees/feature-704-alpha-gate-docs`
**HEAD at plan time:** `b3b6b9f`
**Workflow:** `fix-704-alpha-gate-docs`
**Goal:** `g-704-alpha-docs`
**Work item:** `wi-704-alpha-docs`

## Goal

Land the two narrow docs artifacts that block tagging `v0.5.0-alpha.0` and handing it to the first external B3 tester:

1. `bench/B3-cache-hit/PROTOCOL.md` — sprint protocol per #187 acceptance
2. `docs/ALPHA.md` — install section reflects shipped reality post-#361 Slice 1; new "How to contribute" section pointing at the B3 protocol

Both are pure docs. No code, no tests, no schema changes, no production paths touched.

## Pre-investigation findings (load-bearing for the implementer)

Verified against the worktree at HEAD `b3b6b9f`:

- **#361 status (binary distribution).** Only **Slice 1 of 4** has landed (commit `1aa61e3`). It adds a local `pnpm --filter @yakcc/cli build:binary` path producing `packages/cli/dist/yakcc-bin` (Linux x64 host). **Slices 2 (multi-arch CI), 3 (distribution channel), 4 (native-dep edges) have NOT shipped.** `gh release list` returns empty. **There is no downloadable binary today.**
- **#704 issue body wording is partially wrong about reality.** It says "Lead with the binary path (download + place on PATH + verify with `yakcc --version`)". A download path does not exist. Honest install hierarchy today: monorepo clone primary, locally-built binary secondary (skip on macOS/Windows until Slice 2), downloadable binary "coming in #361 Slices 2-3".
- **#656 single-command install is DONE.** Closed 2026-05-18 (commits `393d278`, `7bfec06`, `ac04d26`). The "single-command install (#656) is in flight" framing from the issue body is stale — `yakcc init` is already the single command. The new ALPHA copy must NOT call #656 in-flight.
- **#187 status.** OPEN. The PROTOCOL.md we land here is exactly the artifact #187 cites in its acceptance — quote the 5-section structure verbatim from #704.
- **`docs/ALPHA.md` current shape** (134 lines): §1 "What this alpha is", §2 "Install (alpha-specific)" (lines 28-57, including "Known platform notes"), §3 "Known broken / known limited", §4 "How to send feedback", §5 "What's in this alpha", §6 "What's next", §7 "Thank you". The current install section already correctly reflects single-command `yakcc init` (lines 42-49). The bit that needs replacing is lines 30-40 (the "binary in flight at #361" + clone-from-monorepo block) and the row at line 69 of the Known-broken table ("No standalone binary yet").

## Implementer playbook

### File 1: `bench/B3-cache-hit/PROTOCOL.md` (NEW)

Create the directory `bench/B3-cache-hit/` and write `PROTOCOL.md` with **exactly five top-level sections** matching #704 verbatim plus a short intro that pins purpose, audience, and links back to #187:

```
# B3 Cache-Hit Sprint Protocol

> Hands-on protocol for the B3 cache-hit benchmark (#187): a 3+3+3 day
> sprint that measures registry-hit rate on real engineer work, with and
> without the yakcc hook engaged. The tester (operator, friendly engineer,
> or a sister sister-AI) follows this document end-to-end.

## 1. Setup (pre-sprint, ~30 min)
   - Install yakcc per docs/ALPHA.md § Install
   - `yakcc init` in the target project (already wires IDE hooks + seeds corpus)
   - Verify telemetry: `tail -1 ~/.yakcc/telemetry/*.jsonl` must show at least one event
   - Define task list: ≥30 tasks, stratified into boilerplate / glue / novel-logic
   - Independent reviewer pre-classifies each task (operator or a sister)

## 2. Hook-enabled arm (3 days)
   - Engineer works normally; hook captures telemetry
   - End-of-day checkpoint: count of `registry-hit` / `synthesis-required` / `passthrough` outcomes
   - Per-task self-classification of how much friction the hook introduced

## 3. Hook-disabled arm (3 days)
   - Same engineer, same task domain
   - Uninstall hooks: `yakcc hooks claude-code install --uninstall` (or
     `yakcc uninstall --ide claude-code` per the #656 collapsed CLI)
   - Capture baseline emission count; no atom matching expected

## 4. Analysis (~3 days)
   - Aggregate hit rates by category
   - Diff token spend (output tokens, inference passes) per task
   - Selection-bias check: were there tasks the engineer subconsciously routed differently?
   - Publish per-category hit rate vs bars: boilerplate ≥60%, glue ≥30%, novel-logic ≥10%

## 5. Verdict
   - `DEC-BENCH-B3-001` annotated in MASTER_PLAN
   - Raw telemetry committed (hashes only — no source code leaked)
   - Verdict against bars: GREEN / YELLOW / RED with rationale

## Cross-references
- #187 — B3 parent (this protocol satisfies its acceptance)
- #704 — alpha-gate docs WI that authored this
- docs/ALPHA.md — install + onboarding for the tester
```

Length target: ~80-120 lines including the intro and cross-refs. Do not invent additional procedures or shape the protocol differently than #704 specified; the issue text IS the spec.

### File 2: `docs/ALPHA.md` (UPDATE)

Two surgical edits:

**Edit A — replace the install block (lines 28-57).** Rewrite "## Install (alpha-specific)" to reflect shipped reality:

- **Primary install path: monorepo clone** (still the only path that gives every platform a working `yakcc` today). Keep the current 7-line block intact.
- **Optional secondary: build a single-file binary locally** — `pnpm --filter @yakcc/cli build:binary` produces `packages/cli/dist/yakcc-bin` (Linux x64 host today; macOS/Windows arrive with #361 Slice 2). Place on PATH; verify with `yakcc-bin --version`. Note this is the Slice-1-of-#361 output and the download path is still in flight.
- **Coming soon:** downloadable binaries via GitHub Releases (#361 Slices 2-3) and `npm install -g @yakcc/cli` (not on roadmap; binary path won).
- **Keep:** the `yakcc init` paragraph (it is already correct post-#656).
- **Keep:** the "Known platform notes" sub-block at the end.
- Remove the stale "single-command install (#656) is in flight" framing wherever it appears in surrounding paragraphs (none in current text, but check newly written copy).

**Edit B — add "## How to contribute" section** (immediately before "## Thank you", i.e. after the current "What's next" §6). ≤15 lines. Bullet structure:

- "Run the B3 cache-hit sprint" → link to `bench/B3-cache-hit/PROTOCOL.md`; one-line explainer of what it measures and what data we want back
- "File an alpha-feedback issue" → re-anchor existing template link
- "Report regressions found via the smoke-test loop" → standard issue path

**Edit C — update the "Known broken" table row for the binary.** Row at current line 69 reads "No standalone binary yet ... binary lands ~1-2 weeks". Replace with: "Standalone binary Slice 1 landed (#361, local build only); multi-arch download via GitHub Releases pending Slices 2-3."

**Edit D — update "What's next" §6 trajectory bullet referencing #361.** Currently says "`v0.5.0-beta.0`: binary distribution (#361, Wrath active)". Update to: "`v0.5.0-beta.0`: binary distribution multi-arch + downloadable (#361 Slices 2-4), shave cache (#363), recursive self-hosting proof closure (#355)."

No other ALPHA.md edits. Do not touch §1 / §3 (rest of table) / §4 / §5 / §7.

## Scope (mirrors workflow_contract)

### Allowed paths
- `bench/B3-cache-hit/PROTOCOL.md` (NEW)
- `bench/B3-cache-hit/README.md` (optional pointer file; only if implementer judges it warranted — issue doesn't require it)
- `docs/ALPHA.md` (UPDATE)
- `plans/wi-704-alpha-gate-docs.md` (this file)
- `tmp/wi-704-*` (scratch)

### Required paths
- `plans/wi-704-alpha-gate-docs.md`
- `bench/B3-cache-hit/PROTOCOL.md`

### Forbidden paths (any change here voids the WI)
- `packages/**` — no code changes, no exceptions
- `bench/B1-latency/**`, `bench/B2-bloat/**`, `bench/B4-tokens/**`, `bench/B5-coherence/**`, `bench/B6-airgap/**`, `bench/B7-commit/**`, `bench/B8-synthetic/**`, `bench/B9-min-surface/**`, `bench/B10-import-replacement/**`, `bench/v0-release-smoke/**` — other bench dirs untouched
- `docs/USING_YAKCC.md`, `docs/TROUBLESHOOTING.md`, `docs/ADVANCED.md`, `docs/CONTRIBUTING.md`, `docs/PRIOR_ART.md`, `docs/V2_*`, `docs/REGISTRY_LICENSE_POLICY.md`, `docs/enforcement-config.md`, `docs/adr/**`, `docs/system-prompts/**` — out of scope (the #657 reshape is its own WI)
- `.github/**`, `.claude/**`, `MASTER_PLAN.md`, `DESIGN.md`, `VERIFICATION.md`, `FEDERATION.md`, `MANIFESTO.md`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `examples/**`, `scripts/**`, `bootstrap/**` — out of scope

### Authority domains
- `b3-protocol` — owner of the B3 sprint procedure surface (new authority; this WI seeds it)
- `alpha-install-section` — owner of `docs/ALPHA.md` §2 install copy

## State / authority map

- No runtime state. No SQLite tables touched. No registry, no hook, no telemetry surface modified.
- `b3-protocol` becomes the canonical authority for the B3 sprint procedure. #187 and any future PROTOCOL revisions point here.
- `alpha-install-section` is the canonical authority for the alpha install copy. README.md and USING_YAKCC.md install instructions remain owned by their respective WIs; the implementer must not pre-emptively change them to match.

## Evaluation Contract

### required_tests (manual verification — no code tests)
1. `bench/B3-cache-hit/PROTOCOL.md` exists and contains **all five** top-level sections: `## 1. Setup`, `## 2. Hook-enabled arm`, `## 3. Hook-disabled arm`, `## 4. Analysis`, `## 5. Verdict` (literal grep against the file).
2. `docs/ALPHA.md` `## Install (alpha-specific)` section presents monorepo path AS primary today, locally-built binary AS optional secondary with explicit Slice-1 caveat, and downloadable binary AS "coming soon" — NOT as a path the user can take today.
3. `docs/ALPHA.md` contains a new `## How to contribute` section positioned before `## Thank you` and pointing at `bench/B3-cache-hit/PROTOCOL.md` via a relative link.
4. `docs/ALPHA.md` "Known broken" table row about the binary reflects Slice 1 shipped, Slices 2-3 pending — not "No standalone binary yet".
5. `docs/ALPHA.md` "What's next" §6 references #361 Slices 2-4 specifically, not "Wrath active".

### required_evidence
- `git diff --stat origin/main..HEAD` shows exactly 3 files: `plans/wi-704-alpha-gate-docs.md`, `bench/B3-cache-hit/PROTOCOL.md`, `docs/ALPHA.md` (plus optional `bench/B3-cache-hit/README.md`). Any other file in the diff → scope violation.
- `grep -c "^## " bench/B3-cache-hit/PROTOCOL.md` returns ≥5 (intro + 5 numbered sections; cross-references section permissible).
- Link integrity: every `](...)` in changed files resolves (relative path exists or is a known-good external URL).

### required_real_path_checks
- After implementation, open `docs/ALPHA.md` in plain Markdown view: install section reads as a coherent shipped-reality narrative, not a wishlist.
- After implementation, open `bench/B3-cache-hit/PROTOCOL.md`: a tester reading it cold can begin Setup without consulting another doc except for the install pointer.

### required_authority_invariants
- No production code touched (`packages/**` clean in diff).
- No other docs touched (`docs/*.md` except ALPHA.md clean in diff).
- `README.md` untouched (its install copy is owned by a different WI and would conflict with #657 reshape).
- Other bench directories untouched.
- No new state authority introduced beyond the two named above.

### required_integration_points
- References to #361 accurately reflect Slice 1 shipped + Slices 2-4 pending — verified against `git log --grep="#361"` showing only `1aa61e3`/`21fdbc8`.
- References to #187 accurately describe the parent benchmark — verified against `gh issue view 187`.
- References to #656 (if any) acknowledge it shipped — verified against `gh issue view 656` showing `closedAt`.

### forbidden_shortcuts
- **Do NOT** write install copy that tells users to download a binary that doesn't exist. The temptation will be high because #704 issue body suggests it; the implementer must override and document the shipped reality instead.
- **Do NOT** modify other docs (USING_YAKCC.md, README.md) to "fix" link-integrity issues — leave their text alone even if it has stale install copy; those are separate WIs.
- **Do NOT** add code, scripts, or fixtures under `bench/B3-cache-hit/`. PROTOCOL.md (and optionally README.md) only.
- **Do NOT** rewrite ALPHA.md sections that are already correct (§1, §3 narrative, §4, §5, §7) — surgical edits A/B/C/D only.
- **Do NOT** retitle or reorder existing ALPHA.md sections. Section numbering is not load-bearing but its current order is.

### rollback_boundary
Single git revert of the landing commit removes `bench/B3-cache-hit/PROTOCOL.md` and reverts `docs/ALPHA.md`. No migrations, no schema, no data, no hook re-wiring. Clean undo.

### acceptance_notes
- Alpha-gate priority: this is the last docs piece between current HEAD and tagging `v0.5.0-alpha.0`.
- Time budget: 1-2 hours implementer time. If it grows past 3 hours, stop and surface — the scope is wrong.

### ready_for_guardian_definition
All of the following are true:
1. Diff contains only files listed under "required_evidence" above.
2. All five `required_tests` literal-grep checks pass.
3. `bench/B3-cache-hit/PROTOCOL.md` reads as a coherent procedure cold.
4. `docs/ALPHA.md` install section reads as shipped reality.
5. PR body includes `Closes #704` and quotes the four-row evaluation pass list.

## Out of scope (explicit)

- The full `docs/USING_YAKCC.md` rewrite — that is #657's reshape work, currently scoped out elsewhere.
- README.md install copy alignment — owned by a different WI; touching it here would conflict with #657.
- Downloadable binary delivery — #361 Slices 2-4, separate WIs.
- Running an actual B3 sprint — this WI delivers the PROTOCOL; #187 owns execution.
- `bench/B3-cache-hit/` test harness, fixtures, or scripts — pure procedure doc.

## Decision log additions

- **DEC-704-ALPHA-INSTALL-001** — Alpha install copy MUST reflect shipped reality (Slice 1 only). Rationale: documenting a downloadable binary that does not exist would block the very tester onboarding this WI exists to enable; the first failed `curl` would burn trust. The honest local-build path serves the same audience adequately until Slices 2-3 ship.
- **DEC-704-B3-PROTOCOL-AUTHORITY-001** — `bench/B3-cache-hit/PROTOCOL.md` is the canonical authority for the B3 sprint procedure. #187 references it; future revisions amend this file.
