// SPDX-License-Identifier: MIT
//
// @decision DEC-CLI-HOOK-INTERCEPT-CONTINUE-PKG-001
// title: @yakcc/hooks-continue is a thin re-export of @yakcc/hooks-cline
// status: decided (WI-753)
// rationale:
//   Continue.dev's VS Code/JetBrains extension has an identical API surface
//   pattern to Cline's at time of implementation (both marker-file based,
//   both lack stable synchronous tool-call interception). A thin re-export
//   preserves IDE-level package symmetry (@yakcc/hooks-<ide> exists for every
//   supported IDE) without duplicating 250 lines of code that no consumer
//   calls distinctly today. Sacred Practice #12 (single source of truth):
//   an alias is one source; a 250-line duplicate is two.
//
//   When Continue.dev ships a stable API that diverges from Cline's, this
//   one-line re-export becomes the seam: replace "export * from ..." with
//   a real implementation. That is a future WI (WI-HOOK-CONTINUE-NATIVE),
//   strictly easier than reconciling a drifted 250-line mirror.
//
//   Options rejected:
//   - Option 1 (full 250-line mirror): dead code by Sacred Practice #5;
//     two authorities for the same fact by Sacred Practice #12.
//   - Option 3 (no package; reference hooks-cline directly): breaks surface
//     symmetry; every other IDE has a @yakcc/hooks-<ide> package.
//
// FUTURE: when Continue.dev's API diverges from Cline's, replace this
// re-export with a real implementation. See DEC-CLI-HOOK-INTERCEPT-CONTINUE-PKG-001.

export * from "@yakcc/hooks-cline";
