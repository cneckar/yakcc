// SPDX-License-Identifier: MIT
// compile-self.ts — `yakcc compile-self` command (A1 scaffold stub).
//
// @decision DEC-V2-COMPILE-SELF-CLI-NAMING-001
// @title `yakcc compile-self` is a top-level command, NOT `yakcc compile --self`
// @status accepted
// @rationale Keeps argument parsing and exit-code semantics independent of
//   `yakcc compile`. The two commands have different inputs (compile takes an
//   entry; compile-self walks the corpus) and different outputs (compile writes
//   one module; compile-self writes a full dist tree in A2). Co-locating behind
//   a flag would force compile.ts to branch on a fundamentally different code
//   path and would make A2 risk regressing compile.
//
// @decision DEC-V2-COMPILE-SELF-EXIT-CODE-001
// @title A1 stub returns exit code 2 (not-yet-implemented) with zero side effects
// @status accepted
// @rationale Exit code 1 is reserved for usage/runtime errors per CLI conventions;
//   exit code 2 signals "recognized command, feature unimplemented" and is testable
//   as a distinct outcome. Keeping A1 free of side effects means the smoke test can
//   spawn the command in any working directory without worrying about filesystem state.
//
// Deferred: DEC-V2-COMPILE-SELF-EQ-001 (functional vs byte equivalence)
//   → A2 will implement compile-then-test; A3 will implement the diff harness.
//   Both slices close DEC-V2-COMPILE-SELF-EQ-001 by making the equivalence
//   criterion concrete and tested.
//
// Deferred: DEC-V2-CORPUS-DISTRIBUTION-001 (SQLite registry distribution)
//   → A2's Evaluation Contract will close this DEC when compile-self actually
//   consumes the registry for recompile.

import type { Logger } from "../index.js";

// ---------------------------------------------------------------------------
// compileSelf — A1 stub
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc compile-self`.
 *
 * A1 status: not yet implemented. Returns exit code 2 and prints a help-style
 * message describing the three-slice decomposition (A1/A2/A3) of issue #59
 * (WI-V2-CORPUS-AND-COMPILE-SELF-EQ). Does NOT open the registry, does NOT
 * touch the filesystem, and does NOT perform any compile logic.
 *
 * A2 will replace this stub with the compile-then-test implementation.
 * A3 will add the diff harness.
 *
 * Exit codes:
 *   2 — recognized command, not yet implemented (DEC-V2-COMPILE-SELF-EXIT-CODE-001)
 *
 * @param _argv  - Subcommand args after "compile-self" has been consumed (ignored in A1).
 * @param logger - Output sink; defaults to CONSOLE_LOGGER via the caller.
 * @returns Promise<number> — always 2 in A1.
 */
export async function compileSelf(_argv: ReadonlyArray<string>, logger: Logger): Promise<number> {
  logger.log(
    [
      "yakcc compile-self — not yet implemented (A1 scaffold)",
      "",
      "This command will recompile the yakcc source corpus and verify",
      "equivalence with the shaved atoms recorded in corpus.manifest.json.",
      "",
      "Slice decomposition (WI-V2-CORPUS-AND-COMPILE-SELF-EQ, issue #59):",
      "  A1 (current) — scaffold + corpus enumeration helper (corpus.manifest.json)",
      "  A2            — compile-then-test: recompile each corpus atom and run property tests",
      "  A3            — diff harness: structural + byte-level equivalence comparison",
      "",
      "Run `yakcc bootstrap` first to populate the registry, then re-dispatch A2.",
      "",
      "Exit code 2: recognized command, not yet implemented.",
    ].join("\n"),
  );
  return 2;
}
