// SPDX-License-Identifier: MIT
//
// @decision DEC-COMPOSE-BY-REF-BUILD-001
// @title yakcc build — manifest-driven atom materialization pass
// @status accepted (#1045, epic #1043 compose-by-reference [2/6])
// @rationale
//   `yakcc build` is the counterpart to #1044's manifest format. It reads
//   `.yakcc/manifest.json` (the project-level content-address registry) and
//   materializes each referenced atom as a TypeScript module at
//   `.yakcc/atoms/<alias>.ts`. This makes compose-by-reference practical:
//   the model emits a ~10-token import line; `yakcc build` expands each
//   reference offline and deterministically into runnable source.
//
//   Design decisions:
//   - Materialization is ONLY via assemble() — no parallel materialize path
//     (Sacred Practice #12: no parallel mechanisms). The registry/seed/assemble
//     idioms are reused verbatim from compile.ts (DRY).
//   - Offline: no network; assemble() uses the local registry only.
//   - Deterministic: same manifest + same registry → byte-identical output.
//     assemble() is already deterministic given stable registry content.
//   - Idempotent: re-running overwrites output files identically.
//   - Manifest is read ONLY via parseProjectManifest() from @yakcc/compile
//     (single authority for manifest parsing, DEC-COMPOSE-BY-REF-MANIFEST-001).
//   - Output paths are computed via materializedModulePath() / materializedDtsPath()
//     from @yakcc/compile (single authority for alias→path mapping).
//
//   @decision DEC-COMPOSE-BY-REF-DTS-001
//   @title yakcc build — .d.ts emission alongside .ts (#1046, epic #1043 [3/6])
//   @status accepted (#1046)
//   @rationale
//     For reference source to typecheck pre-build (before the .ts impl exists),
//     a .d.ts declaration file must be present at `.yakcc/atoms/<alias>.d.ts`.
//     The .d.ts is derived from the atom's SpecYak signature (registry block
//     specCanonicalBytes field), decoded via JSON.parse — never from the impl.
//     This means reference consumers typecheck with ONLY the .d.ts present.
//     generateAtomDts() (atom-dts.ts, @yakcc/compile barrel) is the sole authority
//     for the .d.ts text. materializedDtsPath() is the sole authority for the path.
//     Failure to decode spec or retrieve the block is loud (logger.error + return 1);
//     no silent fallback (DEC-COMPOSE-BY-REF-DTS-001).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  type AtomReference,
  PROJECT_MANIFEST_PATH,
  generateAtomDts,
  materializedDtsPath,
  materializedModulePath,
  parseProjectManifest,
} from "@yakcc/compile";
import { assemble } from "@yakcc/compile";
import type { SpecYak } from "@yakcc/contracts";
import { type Registry, type RegistryOptions, openRegistry } from "@yakcc/registry";
import { seedRegistry } from "@yakcc/seeds";
import type { Logger } from "../index.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";

/** Internal options for build — not exposed in CLI args. */
export interface BuildOptions {
  embeddings?: RegistryOptions["embeddings"];
}

/**
 * Handler for `yakcc build [--registry <p>] [<project-root>]`.
 *
 * Reads `<project-root>/.yakcc/manifest.json`, then for each atom reference
 * calls assemble() and writes the assembled TypeScript source to
 * `<project-root>/.yakcc/atoms/<alias>.ts`.
 *
 * Properties:
 * - Offline: no network; uses the local registry only.
 * - Deterministic: same manifest + registry → byte-identical output.
 * - Idempotent: re-running overwrites files identically.
 *
 * @param argv - Remaining argv after `build` has been consumed.
 * @param logger - Output sink; defaults to console via the caller.
 * @param opts - Internal options (embedding provider injection for tests).
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function build(
  argv: readonly string[],
  logger: Logger,
  opts?: BuildOptions,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      registry: { type: "string", short: "r" },
      "project-root": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  // Resolve project root: --project-root flag, then first positional, then cwd.
  const projectRoot =
    (values["project-root"] as string | undefined) ?? positionals[0] ?? process.cwd();

  const registryPath = (values.registry as string | undefined) ?? DEFAULT_REGISTRY_PATH;

  // Read and parse the project manifest.
  const manifestPath = join(projectRoot, PROJECT_MANIFEST_PATH);
  let manifestText: string;
  try {
    manifestText = readFileSync(manifestPath, "utf-8");
  } catch {
    logger.error(`error: manifest not found at ${manifestPath}`);
    logger.error(
      `  Run 'yakcc init' to initialize a project, or create ${PROJECT_MANIFEST_PATH} manually.`,
    );
    return 1;
  }

  let manifest: ReturnType<typeof parseProjectManifest>;
  try {
    manifest = parseProjectManifest(manifestText);
  } catch (err) {
    logger.error(`error: invalid manifest at ${manifestPath}: ${String(err)}`);
    return 1;
  }

  if (manifest.references.length === 0) {
    logger.log("build: manifest has no references — nothing to materialize.");
    return 0;
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
    // Seed the registry — idempotent (INSERT OR IGNORE). Returns all known
    // merkle roots, required for the assemble() stem-index pre-scan.
    const seedResult = await seedRegistry(registry);

    // Materialize each atom reference.
    const materialized: string[] = [];
    for (const ref of manifest.references as AtomReference[]) {
      let artifact: Awaited<ReturnType<typeof assemble>>;
      try {
        artifact = await assemble(ref.root, registry, undefined, {
          knownMerkleRoots: seedResult.merkleRoots,
        });
      } catch (err) {
        logger.error(`error: assembly failed for ${ref.alias} (${ref.root}): ${String(err)}`);
        return 1;
      }

      // Write assembled source to <project-root>/.yakcc/atoms/<alias>.ts.
      // materializedModulePath() is the single authority for the output path shape.
      const relPath = materializedModulePath(ref.alias);
      const absPath = join(projectRoot, relPath);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, artifact.source, "utf-8");

      // --- .d.ts emission (#1046, DEC-COMPOSE-BY-REF-DTS-001) ---
      // Retrieve the block's SpecYak from specCanonicalBytes so the .d.ts is
      // derived from the spec — not from the impl — and therefore works pre-build.
      // registry.getBlock is async (Promise<BlockTripletRow | null>).
      const blockRow = await registry.getBlock(ref.root);
      if (blockRow === null) {
        // Defensive loud failure: assemble() already resolved this root, so a null
        // here is unexpected; surface it loudly rather than silently skipping the .d.ts.
        logger.error(
          `error: registry.getBlock returned null for ${ref.alias} (${ref.root}) — .d.ts cannot be generated`,
        );
        return 1;
      }

      let spec: SpecYak;
      try {
        spec = JSON.parse(new TextDecoder().decode(blockRow.specCanonicalBytes)) as SpecYak;
      } catch (err) {
        logger.error(
          `error: failed to decode specCanonicalBytes for ${ref.alias} (${ref.root}): ${String(err)}`,
        );
        return 1;
      }

      // generateAtomDts() is the sole authority for the .d.ts text content.
      // The symbol (e.g. "asciiChar") comes from the manifest reference, not the spec name.
      const dts = generateAtomDts(spec, ref.symbol);

      // materializedDtsPath() is the sole authority for the .d.ts output path.
      const dtsRelPath = materializedDtsPath(ref.alias);
      const dtsAbsPath = join(projectRoot, dtsRelPath);
      // The dir was already created above for the .ts — this is a no-op on second run.
      mkdirSync(dirname(dtsAbsPath), { recursive: true });
      writeFileSync(dtsAbsPath, dts, "utf-8");

      materialized.push(relPath);
    }

    logger.log(
      `build: materialized ${materialized.length} atom${materialized.length === 1 ? "" : "s"} (.ts + .d.ts) → .yakcc/atoms/`,
    );
    return 0;
  } finally {
    await registry.close();
  }
}
