// SPDX-License-Identifier: MIT
// @decision DEC-CLI-COMPILE-001: compile command reads the entry as either a BlockMerkleRoot
// (64-hex string), a path to a JSON SpecYak file, or a directory path. When a directory
// is given, it resolves to <dir>/spec.yak and defaults --out to <dir>/dist. When a
// spec file path is given, specHash() derives the specHash, selectBlocks() fetches all
// satisfying BlockMerkleRoots, and the first is used as the entry. The assembled artifact
// is written to <out>/module.ts and <out>/manifest.json. assemble() receives
// knownMerkleRoots from seedRegistry so the pre-scan can build the full stem index before
// DFS traversal.
// Status: updated (WI-T06; WI-877: polyglot sniff)
// Rationale: WI-T06 migrated the demo from contract.json to spec.yak (triplet shape).
// The directory resolver now looks for spec.yak exclusively — contract.json is deleted
// (Sacred Practice #12: no parallel mechanisms, DEC-WI009-SUBSUMED-021).
// WI-T03/T04 migrated the compile/registry API from ContractId to BlockMerkleRoot.
// The entry resolution calls selectBlocks(specHash) to find the matching BlockMerkleRoot.
//
// WI-877 polyglot sniff:
//   After argv parsing, --target python delegates to runCompilePython (which reuses
//   the same entry-resolution logic).  --target rust/go exits 1 with issue pointers.
//   The existing TS assemble() path is untouched below the sniff.
//
// @decision DEC-WI877-002
// @title yakcc compile arg shape + --target dispatch defaulting to ts; registry-symmetric Python path
// @status accepted (WI-877)
// @rationale
//   Option C: --target defaults to ts.  When --target python, delegate to
//   runCompilePython which reuses the same BlockMerkleRoot resolution logic.
//   --target rust/go exit 1 with #868/#870 pointers.
//   Cross-reference: PLAN.md §3.1 §4 / #877
//
// @decision DEC-WI877-008 §A
// @title Polyglot dispatch is added as a sniff at the top; existing TS code untouched below
// @status accepted (WI-877)
// @rationale
//   The diff for this WI shows the existing TS code untouched below the sniff line.
//   Cross-reference: PLAN.md §4 / #877

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Artifact, assemble } from "@yakcc/compile";
import {
  type BlockMerkleRoot,
  type Granularity,
  type SpecYak,
  parseGranularity,
  specHash,
} from "@yakcc/contracts";
import { type Registry, type RegistryOptions, openRegistry } from "@yakcc/registry";
import { seedRegistry } from "@yakcc/seeds";
import type { Logger } from "../index.js";
import { runCompilePython } from "./compile-python.js";
import { TARGETS_TRACKED } from "./lang-target.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";

/** Internal options for compile — not exposed in CLI args. */
export interface CompileOptions {
  embeddings?: RegistryOptions["embeddings"];
}

/** A 64-hex string that may be a BlockMerkleRoot. */
function isHex64(s: string): boolean {
  return /^[0-9a-f]{64}$/i.test(s);
}

/**
 * Handler for `yakcc compile <entry> [--registry <p>] [--out <dir>]`.
 *
 * <entry> is a BlockMerkleRoot (64-hex string), a path to a JSON SpecYak file,
 * or a directory path containing spec.yak.
 * Writes <out>/module.ts and <out>/manifest.json.
 *
 * @param argv - Remaining argv after `compile` has been consumed (includes the positional).
 * @param logger - Output sink; defaults to console via the caller.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function compile(
  argv: readonly string[],
  logger: Logger,
  opts?: CompileOptions,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      registry: { type: "string", short: "r" },
      out: { type: "string", short: "o" },
      granularity: { type: "string", short: "g" },
      // WI-877: polyglot additions — parsed here so strict: true does not throw
      target: { type: "string" },
      function: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  const entryArg = positionals[0];
  if (entryArg === undefined || entryArg === "") {
    logger.error(
      "error: compile requires an <entry> argument (BlockMerkleRoot, spec file, or directory)",
    );
    return 1;
  }

  // ---------------------------------------------------------------------------
  // WI-877: Polyglot sniff — must run before TS-specific assembly logic.
  // --target defaults to "ts" when omitted.  Python/rust/go dispatch here;
  // TS falls through to the existing assemble() path unchanged (DEC-WI877-008 §A).
  // ---------------------------------------------------------------------------
  {
    const target = (values.target as string | undefined) ?? "ts";

    if (target === "python") {
      // Use conditional spread to satisfy exactOptionalPropertyTypes (tsconfig.base.json).
      // Passing `outDir: undefined` or `fnName: undefined` would be a type error when
      // the interface uses optional (?: T) rather than nullable (?: T | undefined).
      const outVal = values.out as string | undefined;
      const fnVal = values.function as string | undefined;
      return runCompilePython(
        {
          entryArg,
          registryPath: values.registry ?? DEFAULT_REGISTRY_PATH,
          ...(outVal !== undefined && { outDir: outVal }),
          ...(fnVal !== undefined && { fnName: fnVal }),
        },
        logger,
      );
    }

    if (target === "rust" || target === "go") {
      const issue = TARGETS_TRACKED[target];
      logger.error(`error: --target ${target} is not yet wired; tracked at #${issue}`);
      return 1;
    }

    if (target !== "ts") {
      logger.error(
        `error: unknown --target value: ${target}. Must be one of: ts, python, rust, go`,
      );
      return 1;
    }
    // target === "ts" → fall through to existing TS path unchanged.
  }
  // END WI-877 polyglot sniff — existing TS code below this line is UNCHANGED.

  const granularityRaw = values.granularity;
  let granularity: Granularity | undefined;
  if (granularityRaw !== undefined) {
    const parsed = parseGranularity(granularityRaw);
    if (parsed === null) {
      logger.error(
        `error: --granularity must be an integer between 1 and 5 (got ${JSON.stringify(granularityRaw)})`,
      );
      return 1;
    }
    granularity = parsed;
  }

  const registryPath = values.registry ?? DEFAULT_REGISTRY_PATH;

  // Resolve the spec file path and output directory.
  // If entryArg is a directory, look for spec.yak inside it and default
  // --out to <dir>/dist. Otherwise treat it as a spec file (or BlockMerkleRoot).
  let specFilePath: string | null = null;
  let outDir: string;

  if (!isHex64(entryArg)) {
    // Check whether the arg is a directory.
    let isDir = false;
    try {
      isDir = statSync(entryArg).isDirectory();
    } catch {
      // stat failed — not a directory (or doesn't exist); fall through to file path handling.
    }

    if (isDir) {
      specFilePath = join(entryArg, "spec.yak");
      outDir = values.out ?? join(entryArg, "dist");
    } else {
      specFilePath = entryArg;
      outDir = values.out ?? "./yakcc-out";
    }
  } else {
    outDir = values.out ?? "./yakcc-out";
  }

  // Open the registry.
  let registry: Registry;
  try {
    registry = await openRegistry(registryPath, { embeddings: opts?.embeddings });
  } catch (err) {
    logger.error(`error: failed to open registry at ${registryPath}: ${String(err)}`);
    return 1;
  }

  try {
    // Seed the registry and collect all merkle roots for the pre-scan stem index.
    // seedRegistry is idempotent (INSERT OR IGNORE), so running it on an already-
    // seeded registry is safe and produces consistent knownMerkleRoots.
    const seedResult = await seedRegistry(registry);

    // Resolve the entry BlockMerkleRoot.
    let entryRoot: BlockMerkleRoot;
    if (isHex64(entryArg)) {
      // Treat as a BlockMerkleRoot directly.
      entryRoot = entryArg as BlockMerkleRoot;
    } else {
      // Treat as a path to a JSON SpecYak file (or resolved from directory above).
      const resolvedPath = specFilePath ?? entryArg;
      let specJson: string;
      try {
        specJson = readFileSync(resolvedPath, "utf-8");
      } catch (err) {
        logger.error(`error: cannot read spec file ${resolvedPath}: ${String(err)}`);
        return 1;
      }
      let spec: SpecYak;
      try {
        spec = JSON.parse(specJson) as SpecYak;
      } catch (err) {
        logger.error(`error: invalid JSON in spec file ${resolvedPath}: ${String(err)}`);
        return 1;
      }
      const hash = specHash(spec);
      const roots = await registry.selectBlocks(hash);
      if (roots.length === 0) {
        logger.error(`error: no block found for spec in ${resolvedPath} (specHash=${hash})`);
        return 1;
      }
      entryRoot = roots[0] as BlockMerkleRoot;
    }

    // Assemble the artifact.
    let artifact: Artifact;
    try {
      artifact = await assemble(entryRoot, registry, undefined, {
        knownMerkleRoots: seedResult.merkleRoots,
        ...(granularity !== undefined && { granularity }),
      });
    } catch (err) {
      logger.error(`error: assembly failed: ${String(err)}`);
      return 1;
    }

    // Write output files.
    mkdirSync(outDir, { recursive: true });
    const modulePath = join(outDir, "module.ts");
    const manifestPath = join(outDir, "manifest.json");
    writeFileSync(modulePath, artifact.source, "utf-8");
    writeFileSync(manifestPath, JSON.stringify(artifact.manifest, null, 2), "utf-8");

    const blockCount = artifact.manifest.entries.length;
    logger.log(`compiled ${blockCount} blocks → ${modulePath}; manifest at ${manifestPath}`);
    return 0;
  } finally {
    await registry.close();
  }
}
