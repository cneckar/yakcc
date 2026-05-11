// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-CLI-SHAVE-001: hand-authored property-test corpus for
// @yakcc/cli commands/shave.ts. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-87-fill-cli)
// Rationale: shave() validates --foreign-policy and the source path positional
// before calling openRegistry(). Those validation exits are pure and testable
// without any filesystem or registry I/O.
//
// ---------------------------------------------------------------------------
// Property-test corpus for commands/shave.ts atoms
//
// Atoms covered:
//   shave() argument validation (A1):
//     - invalid --foreign-policy value → exit 1 + error message
//     - missing source path positional → exit 1 + error message
//     - --help flag → exit 0 + usage text in logLines
//
// Properties exercised (6):
//   1. invalid --foreign-policy → exit 1
//   2. invalid --foreign-policy → error mentions "--foreign-policy"
//   3. invalid --foreign-policy → error mentions valid choices (allow/reject/tag)
//   4. missing source path → exit 1
//   5. missing source path → error mentions "missing source path"
//   6. --help flag → exit 0
//
// NOTE: All properties exercise code paths that return BEFORE openRegistry()
// is called — no SQLite I/O occurs.
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { CollectingLogger } from "../index.js";
import { shave } from "./shave.js";

// ---------------------------------------------------------------------------
// A1: shave() --foreign-policy validation — exit-before-I/O paths
// ---------------------------------------------------------------------------

/**
 * Arbitrary for invalid --foreign-policy strings.
 * Valid values are: "allow", "reject", "tag".
 * These are strings that are definitely not any of those three.
 */
const invalidForeignPolicyArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom("ALLOW", "REJECT", "TAG", "none", "deny", "block", "ignore", ""),
  fc
    .string({ minLength: 1, maxLength: 10 })
    .filter((s) => s !== "allow" && s !== "reject" && s !== "tag"),
);

/**
 * prop_shave_invalid_foreign_policy_exits_1
 *
 * When --foreign-policy is set to a value not in {allow, reject, tag},
 * shave() returns exit code 1.
 *
 * Invariant: The policy validation guard fires before any registry access.
 */
export const prop_shave_invalid_foreign_policy_exits_1 = fc.asyncProperty(
  invalidForeignPolicyArb,
  async (policy) => {
    const logger = new CollectingLogger();
    const code = await shave(["some-file.ts", "--foreign-policy", policy], logger);
    return code === 1;
  },
);

/**
 * prop_shave_invalid_foreign_policy_emits_error_mentioning_flag
 *
 * When --foreign-policy is invalid, the error message contains "--foreign-policy".
 *
 * Invariant: The error message always identifies which flag was invalid.
 */
export const prop_shave_invalid_foreign_policy_emits_error_mentioning_flag = fc.asyncProperty(
  fc.constantFrom("ALLOW", "REJECT", "none", "deny", "block"),
  async (policy) => {
    const logger = new CollectingLogger();
    await shave(["some-file.ts", "--foreign-policy", policy], logger);
    return logger.errLines.some((l) => l.includes("--foreign-policy"));
  },
);

/**
 * prop_shave_invalid_foreign_policy_error_mentions_valid_choices
 *
 * When --foreign-policy is invalid, the error message lists the valid choices
 * (allow, reject, tag) so the user knows what to use.
 *
 * Invariant: Error messages for invalid enum flags always enumerate valid values.
 */
export const prop_shave_invalid_foreign_policy_error_mentions_valid_choices = fc.asyncProperty(
  fc.constantFrom("ALLOW", "REJECT", "none", "xyz"),
  async (policy) => {
    const logger = new CollectingLogger();
    await shave(["some-file.ts", "--foreign-policy", policy], logger);
    const errText = logger.errLines.join(" ");
    return errText.includes("allow") && errText.includes("reject") && errText.includes("tag");
  },
);

// ---------------------------------------------------------------------------
// A2: shave() missing source path — exit-before-I/O paths
// ---------------------------------------------------------------------------

/**
 * prop_shave_missing_source_path_exits_1
 *
 * When no positional source path is provided, shave() returns exit code 1.
 *
 * Invariant: The missing-path guard fires before openRegistry() is called.
 */
export const prop_shave_missing_source_path_exits_1 = fc.asyncProperty(
  fc.constantFrom(
    [],
    ["--registry", "/tmp/test.sqlite"],
    ["--offline"],
    ["--offline", "--registry", "/tmp/test.sqlite"],
  ),
  async (argv) => {
    const logger = new CollectingLogger();
    const code = await shave(argv, logger);
    return code === 1;
  },
);

/**
 * prop_shave_missing_source_path_emits_error_mentioning_missing_source_path
 *
 * When no source path is given, the error message contains "missing source path".
 *
 * Invariant: The user-facing error is always specific about what is missing.
 */
export const prop_shave_missing_source_path_emits_error_mentioning_missing_source_path =
  fc.asyncProperty(
    fc.constantFrom([], ["--registry", "/tmp/test.sqlite"], ["--offline"]),
    async (argv) => {
      const logger = new CollectingLogger();
      await shave(argv, logger);
      return logger.errLines.some((l) => l.includes("missing source path"));
    },
  );

/**
 * prop_shave_help_flag_exits_0
 *
 * When --help or -h is passed, shave() returns exit code 0 and writes
 * usage text to logLines.
 *
 * Invariant: Help requests never fail; usage text is always on the stdout channel.
 */
export const prop_shave_help_flag_exits_0 = fc.asyncProperty(
  fc.constantFrom(["--help"], ["-h"]),
  async (argv) => {
    const logger = new CollectingLogger();
    const code = await shave(argv, logger);
    return code === 0 && logger.logLines.length > 0 && logger.errLines.length === 0;
  },
);
