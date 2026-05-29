// SPDX-License-Identifier: MIT
//
// compile-python.ts — CLI helper that drives @yakcc/compile-python to lower a
// TS-subset IR atom (from the registry) to Python source.
//
// @decision DEC-WI877-002
// @title yakcc compile arg shape + --target dispatch defaulting to ts; registry-symmetric Python path
// @status accepted (WI-877)
// @rationale
//   This helper is called by compile.ts when --target python is set.  It reuses
//   the existing entry-resolution logic (BlockMerkleRoot, spec file, directory)
//   identical to the TS path, then calls compileToPython(row, opts).  Writes
//   module.py, optionally test_module.py (when testSource is non-empty), and
//   manifest.json with "target": "python" and warnings array.
//   Cross-reference: PLAN.md §3.1 / #877
//
// @decision DEC-WI877-006 (compile variant)
// @title Directory output for compile: module.py + optional test_module.py + manifest.json
// @status accepted (WI-877)
// @rationale
//   Output mirrors the TS compile path (<out>/module.ts + manifest.json) with
//   "target": "python" in manifest.json and optional test_module.py from
//   compileToPython's testSource field.
//   Cross-reference: PLAN.md §4 / #877

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileToPython } from "@yakcc/compile-python";
import type { BlockMerkleRoot, SpecYak } from "@yakcc/contracts";
import { specHash } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import type { Registry } from "@yakcc/registry";
import { seedRegistry } from "@yakcc/seeds";
import type { Logger } from "../index.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";

/** A 64-hex string that may be a BlockMerkleRoot. */
function isHex64(s: string): boolean {
  return /^[0-9a-f]{64}$/i.test(s);
}

/**
 * Parsed options for the compile-python path.
 * Mirrors the values extracted from the shared parseArgs call in compile.ts.
 */
export interface CompilePythonCallArgs {
  entryArg: string;
  registryPath: string;
  outDir?: string;
  fnName?: string;
}

/**
 * Run the Python compile pipeline for a single entry (BlockMerkleRoot / spec file / directory).
 *
 * Called from compile.ts when --target python is set.
 *
 * Writes:
 *   <out>/module.py          — lowered Python source (always)
 *   <out>/test_module.py     — hypothesis tests (only when testSource non-empty)
 *   <out>/manifest.json      — { entryRoot, target: "python", warnings }
 *
 * @returns 0 on success, 1 on any error.
 */
export async function runCompilePython(
  { entryArg, registryPath, outDir, fnName }: CompilePythonCallArgs,
  logger: Logger,
): Promise<number> {
  // ---------------------------------------------------------------------------
  // Entry resolution — identical logic to compile.ts (DEC-CLI-COMPILE-001).
  // Lifted here so the TS path in compile.ts is not touched.
  // ---------------------------------------------------------------------------
  let specFilePath: string | null = null;
  let resolvedOutDir: string;

  if (!isHex64(entryArg)) {
    let isDir = false;
    try {
      isDir = statSync(entryArg).isDirectory();
    } catch {
      // Not a directory or doesn't exist — treat as file path.
    }
    if (isDir) {
      specFilePath = join(entryArg, "spec.yak");
      resolvedOutDir = outDir ?? join(entryArg, "dist");
    } else {
      specFilePath = entryArg;
      resolvedOutDir = outDir ?? "./yakcc-out";
    }
  } else {
    resolvedOutDir = outDir ?? "./yakcc-out";
  }

  // ---------------------------------------------------------------------------
  // Open registry (read-only — Python compile does NOT write to the registry).
  // ---------------------------------------------------------------------------
  let registry: Registry;
  try {
    registry = await openRegistry(registryPath);
  } catch (err) {
    logger.error(`error: failed to open registry at ${registryPath}: ${String(err)}`);
    return 1;
  }

  try {
    // Seed to get knownMerkleRoots (idempotent).
    await seedRegistry(registry);

    // ---------------------------------------------------------------------------
    // Resolve BlockMerkleRoot.
    // ---------------------------------------------------------------------------
    let entryRoot: BlockMerkleRoot;
    if (isHex64(entryArg)) {
      entryRoot = entryArg as BlockMerkleRoot;
    } else {
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

    // ---------------------------------------------------------------------------
    // Fetch the BlockTripletRow.
    // ---------------------------------------------------------------------------
    const row = await registry.getBlock(entryRoot);
    if (row === null) {
      logger.error(`error: no atom with root ${entryRoot}`);
      return 1;
    }

    // ---------------------------------------------------------------------------
    // Compile to Python.
    // ---------------------------------------------------------------------------
    let result: ReturnType<typeof compileToPython>;
    try {
      result = compileToPython(row, fnName !== undefined ? { fnName } : undefined);
    } catch (err) {
      logger.error(`error: compileToPython failed: ${String(err)}`);
      return 1;
    }

    // ---------------------------------------------------------------------------
    // Write output files.
    // ---------------------------------------------------------------------------
    mkdirSync(resolvedOutDir, { recursive: true });

    const modulePath = join(resolvedOutDir, "module.py");
    writeFileSync(modulePath, result.source, "utf-8");

    if (result.testSource !== "") {
      const testPath = join(resolvedOutDir, "test_module.py");
      writeFileSync(testPath, result.testSource, "utf-8");
    }

    const manifest = {
      entryRoot,
      target: "python",
      warnings: result.warnings,
    };
    writeFileSync(
      join(resolvedOutDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );

    // Surface warnings to stderr.
    for (const w of result.warnings) {
      logger.error(`warning: ${w.message}`);
    }

    logger.log(`compiled → ${modulePath}`);
    if (result.testSource !== "") {
      logger.log(`hypothesis tests → ${join(resolvedOutDir, "test_module.py")}`);
    }
    return 0;
  } finally {
    await registry.close();
  }
}
