// SPDX-License-Identifier: MIT
// @decision DEC-CLI-SHAVE-001: shave command wraps @yakcc/shave.shave() for CLI consumption.
// Opens the registry via @yakcc/registry.openRegistry(), delegates all pipeline logic
// to shaveImpl(), and prints a human-readable summary. Error paths follow the
// established pattern from seed.ts and compile.ts: catch, log to logger.error(), return 1.
// Status: updated (WI-V2-04 L5: foreign-policy gate output added; WI-877: polyglot sniff)
// Rationale: Keeps the CLI layer thin — argument parsing, registry open/close, and
// output formatting live here; pipeline logic stays in @yakcc/shave. Matches the
// `(argv, logger) → Promise<number>` contract shared by all yakcc commands.
//
// L5 additions:
//   - 'reject' policy: shaveImpl() throws ForeignPolicyRejectError; caught here,
//     formatted to stderr ("error: shave failed: foreign-policy reject: pkg#export,..."),
//     returns exit code 1. (L5-I3)
//   - 'tag' policy: shaveImpl() returns ShaveResultWithForeign.foreignDeps;
//     when non-empty, emit "foreign deps: pkg#export[, ...]" to stdout. (L5-I4)
//   - 'allow' policy: no change — shaveImpl() returns no foreignDeps. (L5-I5)
//
// WI-877 polyglot sniff:
//   A small dispatch block at the top of shave() detects --target python (or .py
//   extension) and delegates to runShavePython.  The entire existing TS pipeline
//   is preserved verbatim below the sniff.
//
// @decision DEC-WI877-001
// @title yakcc shave arg shape + extension-driven Python dispatch + TS-path preserved verbatim
// @status accepted (WI-877)
// @rationale
//   Option C: the polyglot dispatch is a sniff at the top of the existing entry
//   function.  The TS path falls through unchanged.  .py extension → python target;
//   --target overrides extension; --target rust/go exit 1 with issue pointers.
//   --foreign-policy is ignored for non-TS targets (warning emitted).
//   Cross-reference: PLAN.md §3.1 §4 / #877
//
// @decision DEC-WI877-008 §A
// @title Polyglot dispatch is added as a sniff at the top; existing TS code untouched below
// @status accepted (WI-877)
// @rationale
//   The diff for this WI shows the existing TS code untouched below the sniff line.
//   Cross-reference: PLAN.md §4 / #877

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Registry } from "@yakcc/registry";
import { acquireWriteLock, openRegistry } from "@yakcc/registry";
import {
  FOREIGN_POLICY_DEFAULT,
  type ForeignPolicy,
  ForeignPolicyRejectError,
  shave as shaveImpl,
} from "@yakcc/shave";
import type { Logger } from "../index.js";
import { makeCommonsBinding } from "../lib/commons-submit.js";
import { readRc } from "../lib/yakccrc.js";
import { TARGETS_TRACKED, inferTarget } from "./lang-target.js";
import { runShavePython } from "./shave-python.js";
import { runShaveRust } from "./shave-rust.js";

/** Valid values for --foreign-policy. */
const VALID_FOREIGN_POLICIES: readonly ForeignPolicy[] = ["allow", "reject", "tag"];

/** Argument options descriptor for parseArgs — typed inline to avoid implicit any. */
const SHAVE_PARSE_OPTIONS = {
  registry: { type: "string" },
  offline: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  "foreign-policy": { type: "string" },
  // WI-877 polyglot additions (parsed here so parseArgs does not throw on unknown flags)
  target: { type: "string" },
  out: { type: "string", short: "o" },
  function: { type: "string" },
} as const;

/**
 * Handler for `yakcc shave <path> [--registry <p>] [--offline] [--foreign-policy <policy>]`.
 *
 * Shaves a TypeScript source file: reads it, runs through the universalizer
 * (license gate → intent extraction → decompose → slice), and prints a summary
 * of the ShaveResult. The atoms array (each with placeholderId + sourceRange) is
 * printed; intent cards count and diagnostics are surfaced.
 *
 * @param argv    - Subcommand args after "shave" has been consumed (positional path + flags).
 * @param logger  - Output sink; defaults to CONSOLE_LOGGER via the caller.
 * @returns Promise<number> — 0 on success, 1 on error.
 */
export async function shave(argv: ReadonlyArray<string>, logger: Logger): Promise<number> {
  // Parse arguments — parseArgs throws on unknown flags, so wrap in try/catch.
  const parsed = (() => {
    try {
      return parseArgs({
        args: [...argv],
        allowPositionals: true,
        options: SHAVE_PARSE_OPTIONS,
      });
    } catch (err) {
      logger.error(`error: ${(err as Error).message}`);
      return null;
    }
  })();
  if (parsed === null) return 1;

  if (parsed.values.help) {
    logger.log(
      `Usage: yakcc shave <path> [--registry <p>] [--offline] [--foreign-policy <allow|reject|tag>]\n       [--target <ts|python|rust|go>] [--out <path>] [--function <name>]\n  Shave a source file into universalized result (atoms + intent + license).\n  .ts/.tsx files use the TS pipeline (default). .py files use the Python pipeline.\n  --target: override extension inference (default: inferred from file extension).\n  --out: output path for Python target (stdout when omitted).\n  --function: process only one named function (Python target only).\n  --foreign-policy: how to handle foreign-block deps (TS target only, default: ${FOREIGN_POLICY_DEFAULT})`,
    );
    return 0;
  }

  // ---------------------------------------------------------------------------
  // WI-877: Polyglot sniff — must run before TS-specific validation.
  // Infer target from positional file extension or explicit --target flag.
  // The TS path falls through unchanged below this block (DEC-WI877-008 §A).
  // ---------------------------------------------------------------------------
  {
    const positional = parsed.positionals[0];
    const explicitTarget = parsed.values.target as string | undefined;
    const target = inferTarget(positional, explicitTarget);

    if (target === "python") {
      return runShavePython(
        {
          filePath: positional ?? "",
          functionFilter: parsed.values.function as string | undefined,
          out: parsed.values.out as string | undefined,
          ignoredForeignPolicy: parsed.values["foreign-policy"] !== undefined,
        },
        logger,
      );
    }

    if (target === "rust") {
      return runShaveRust(
        {
          filePath: positional ?? "",
          functionFilter: parsed.values.function as string | undefined,
          out: parsed.values.out as string | undefined,
          ignoredForeignPolicy: parsed.values["foreign-policy"] !== undefined,
        },
        logger,
      );
    }

    if (target === "go") {
      const issue = TARGETS_TRACKED[target];
      logger.error(`error: --target ${target} is not yet wired; tracked at #${issue}`);
      return 1;
    }

    if (target === "unknown") {
      // An explicit --target was given but it's not a known language.
      if (explicitTarget !== undefined) {
        logger.error(
          `error: unknown --target value: ${explicitTarget}. Must be one of: ts, python, rust, go`,
        );
        return 1;
      }
      // Extension is unrecognized and no --target override — fall through to TS path.
      // The TS pipeline will fail gracefully if the file is not TS.
    }
    // target === "ts" | "unknown-without-override" → fall through to existing TS path.
  }
  // END WI-877 polyglot sniff — existing TS code below this line is UNCHANGED.

  // Validate --foreign-policy value when provided.
  const rawForeignPolicy = parsed.values["foreign-policy"];
  let foreignPolicy: ForeignPolicy = FOREIGN_POLICY_DEFAULT;
  if (rawForeignPolicy !== undefined) {
    if (!(VALID_FOREIGN_POLICIES as readonly string[]).includes(rawForeignPolicy)) {
      logger.error(
        `error: --foreign-policy must be one of: ${VALID_FOREIGN_POLICIES.join(", ")}; got: ${rawForeignPolicy}`,
      );
      return 1;
    }
    foreignPolicy = rawForeignPolicy as ForeignPolicy;
  }

  const sourcePath = parsed.positionals[0];
  if (sourcePath === undefined) {
    logger.error("error: missing source path. Usage: yakcc shave <path>");
    return 1;
  }

  const registryPath = parsed.values.registry ?? ".yakcc/registry.sqlite";
  const offline = parsed.values.offline === true;

  let releaseLock: (() => void) | null = null;
  try {
    releaseLock = await acquireWriteLock(resolve(registryPath));
  } catch (err) {
    logger.error(`error: failed to acquire registry write lock: ${(err as Error).message}`);
    return 1;
  }

  // Compose the commons-push binding (WI-794 slice 4 /
  // DEC-COMMONS-SUBMIT-AT-STOREBLOCK-001). makeCommonsBinding gates on
  // :memory:, airgapped mode in .yakccrc, and YAKCC_AIRGAP=1 — returning a
  // no-op submitter when any gate trips. Otherwise every novel storeBlock
  // POSTs to the commons fire-and-forget.
  const absRegistryPath = resolve(registryPath);
  const rcDir = ".";
  const rc = readRc(rcDir);
  const airgapped = rc?.mode === "airgapped";
  const commonsBinding = makeCommonsBinding({
    registryPath: absRegistryPath,
    airgapped,
  });

  let registry: Registry;
  try {
    registry = await openRegistry(absRegistryPath, {
      ...(commonsBinding.commonsSubmit !== undefined
        ? { commonsSubmit: commonsBinding.commonsSubmit }
        : {}),
    });
  } catch (err) {
    releaseLock();
    logger.error(`error: failed to open registry at ${registryPath}: ${(err as Error).message}`);
    return 1;
  }
  commonsBinding.bind(registry);

  // Adapt Registry → ShaveRegistryView (nullish mismatch on getBlock).
  const shaveRegistry = {
    selectBlocks: (specHash: Parameters<typeof registry.selectBlocks>[0]) =>
      registry.selectBlocks(specHash),
    getBlock: async (merkleRoot: Parameters<typeof registry.getBlock>[0]) => {
      const row = await registry.getBlock(merkleRoot);
      return row ?? undefined;
    },
    findByCanonicalAstHash: registry.findByCanonicalAstHash?.bind(registry),
  };

  try {
    const result = await shaveImpl(resolve(sourcePath), shaveRegistry, { offline, foreignPolicy });
    logger.log(`Shaved ${result.sourcePath}:`);
    logger.log(`  atoms: ${result.atoms.length}`);
    logger.log(`  intentCards: ${result.intentCards.length}`);
    if (result.atoms.length > 0) {
      logger.log("  atoms detail:");
      for (const atom of result.atoms) {
        logger.log(
          `    - ${atom.placeholderId} [${atom.sourceRange.start}..${atom.sourceRange.end}]`,
        );
      }
    }
    if (result.diagnostics.stubbed.length > 0) {
      logger.log(`  stubbed: ${result.diagnostics.stubbed.join(", ")}`);
    }
    // L5-I4: emit "foreign deps:" summary line when policy is 'tag' and deps exist.
    // result.foreignDeps is set by the shave() policy gate when policy === 'tag'.
    // It is undefined for 'allow' (silent accept per L5-I5).
    // It is never reached for 'reject' (ForeignPolicyRejectError is thrown instead).
    if (result.foreignDeps !== undefined && result.foreignDeps.length > 0) {
      const depTokens = result.foreignDeps.map((d) => `${d.pkg}#${d.export}`).join(", ");
      logger.log(`foreign deps: ${depTokens}`);
    }
    return 0;
  } catch (err) {
    // L5-I3: ForeignPolicyRejectError carries a structured message that already
    // includes "foreign-policy reject: pkg#export[, ...]". Catching it here lets
    // the generic catch re-use the same logger.error path, so the stderr line
    // naturally contains both the package name and the export name.
    if (err instanceof ForeignPolicyRejectError) {
      logger.error(`error: shave failed: ${err.message}`);
      return 1;
    }
    const e = err as Error;
    logger.error(`error: shave failed: ${e.message}`);
    return 1;
  } finally {
    await registry.close();
    releaseLock?.();
  }
}
