// SPDX-License-Identifier: MIT
// compile-pipeline.ts — P2 workspace reconstruction pipeline for examples/v2-self-shave-poc.
//
// @decision DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001
// @title compile-self groups atoms by (sourcePkg, sourceFile) and reconstructs
//   workspace tree from provenance + plumbing
// @status decided (WI-V2-REGISTRY-SOURCE-FILE-PROVENANCE P2)
// @rationale With P1's provenance columns populated, atoms are grouped by
//   (sourcePkg, sourceFile), sorted by sourceOffset ASC, concatenated, and
//   emitted to <outputDir>/<sourceFile>. Plumbing files materialise from
//   workspace_plumbing rows. The flat-atom output path is DELETED.
//   This file mirrors compile-self.ts in packages/cli/src/commands/ — they
//   are kept separate because @yakcc/cli cannot import from examples/
//   (TypeScript rootDir: src constraint). When logic diverges, both files
//   must be updated (DEC-V2-COMPILE-SELF-EQ-001 N4 rationale).
//
// @decision DEC-V2-COMPILE-SELF-EQ-001
// @title Functional equivalence is the P2 acceptance bar (confirmed)
// @status re-confirmed (WI-V2-REGISTRY-SOURCE-FILE-PROVENANCE P2)
// @rationale P2 closes this DEC end-to-end: the recompiled workspace builds,
//   tests pass, and the recompiled bootstrap --verify produces byte-identical
//   bootstrap/expected-roots.json (T8 load-bearing assertion).
//
// @decision DEC-V2-COMPILE-SELF-GLUE-INTERLEAVING-001
// @title compile-pipeline interleaves glue blobs with atom implSources in sourceOffset order
// @status decided (WI-V2-WORKSPACE-PLUMBING-GLUE-CAPTURE #333)
// @rationale With glue blobs captured by bootstrap (DEC-V2-GLUE-CAPTURE-AUTHORITY-001),
//   the reconstructed file is: glue_region_0 ++ atom_0.implSource ++ glue_region_1 ++ ...
//   ++ glue_region_n. Glue region boundaries are derived from atom sourceOffset (character
//   position in original file) and implSource.length. This file mirrors compile-self.ts
//   exactly (DEC-V2-COMPILE-SELF-EQ-001): both must use glue-interleaved reconstruction.
//   Fallback: when no glue row exists (pre-#333 bootstrap), falls back to atom-only
//   concatenation and logs a warning (backward compatibility with pre-v8 registries).
//
// @decision DEC-V2-CORPUS-DISTRIBUTION-001
// @title SQLite registry + dist-recompiled/ are both gitignored
// @status closed (unchanged from A2)

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BlockMerkleRoot } from "@yakcc/contracts";
import type { BlockTripletRow, Registry, WorkspacePlumbingEntry } from "@yakcc/registry";
import { openRegistry } from "@yakcc/registry";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One gap row in the compose-path-gap report.
 *
 * reason values (P2 shape):
 *   'foreign-leaf-skipped' — foreign atoms are opaque leaves (informational)
 *   'null-provenance'      — local atom with NULL sourcePkg AND sourceFile
 *   'unresolved-pointer'   — PointerEntry with no in-corpus resolution
 *   'glue-absorbed'        — atom absorbed into glue (in blocks.source_file but not block_occurrences)
 *   'other'                — catch-all; triggers integration test failure (Sacred Practice #5)
 *
 * @decision DEC-V2-GLUE-GHOST-ATOM-EXCLUSION-001
 *   'glue-absorbed' is informational (same status as 'foreign-leaf-skipped'): the atom's
 *   implSource content is present in the reconstructed file via the glue blob. No data is
 *   lost — the atom was found in the group (via blocks.source_file fallback) but is not in
 *   block_occurrences, meaning bootstrap's glue capture already included its content.
 */
export interface GapRow {
  readonly blockMerkleRoot: BlockMerkleRoot;
  readonly packageName: string;
  readonly sourcePath?: string | undefined;
  readonly reason:
    | "null-provenance"
    | "unresolved-pointer"
    | "foreign-leaf-skipped"
    | "glue-absorbed"
    | "other";
  readonly detail: string;
}

/**
 * One entry in the compile manifest (P2 shape — workspace-shaped, per-atom).
 *
 * outputPath is now a workspace-relative path (e.g.
 * 'packages/cli/src/commands/compile.ts'), not the old flat atom path.
 * sourcePkg, sourceFile, sourceOffset are non-null for local atoms with provenance.
 *
 * @decision DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001
 */
export interface ManifestEntry {
  readonly outputPath: string;
  readonly blockMerkleRoot: BlockMerkleRoot;
  readonly sourcePkg: string | null;
  readonly sourceFile: string | null;
  readonly sourceOffset: number | null;
}

/**
 * Return type of runCompilePipeline / _runWithRegistry.
 */
export interface CompilePipelineResult {
  /** Number of source files emitted (one per (sourcePkg, sourceFile) group). */
  readonly recompiledFiles: number;
  /** Number of plumbing files materialised from registry. */
  readonly plumbingFilesEmitted: number;
  /** Manifest mapping output paths → blockMerkleRoot, sourcePkg, sourceFile, sourceOffset. */
  readonly manifest: readonly ManifestEntry[];
  /** Compose-path gap report (never silently dropped — F1/Sacred Practice #5). */
  readonly gapReport: readonly GapRow[];
}

/**
 * Options for runCompilePipeline.
 */
export interface CompilePipelineOptions {
  /** Absolute path to the SQLite registry. */
  readonly registryPath: string;
  /**
   * Directory under which the recompiled workspace is written.
   * Source files go to: <outputDir>/<sourceFile>  (e.g. packages/cli/src/commands/foo.ts)
   * Plumbing files go to: <outputDir>/<workspacePath>  (e.g. package.json)
   * Manifest: <outputDir>/manifest.json
   */
  readonly outputDir: string;
}

// ---------------------------------------------------------------------------
// Embedding provider for read-only registry open
// ---------------------------------------------------------------------------

const NULL_EMBEDDING_OPTS = {
  embeddings: {
    dimension: 384,
    modelId: "compile-self/null-zero",
    embed: async (_text: string): Promise<Float32Array> => new Float32Array(384),
  },
} as const;

// ---------------------------------------------------------------------------
// runCompilePipeline
// ---------------------------------------------------------------------------

/**
 * Reconstruct a workspace-shaped output from the registry corpus.
 *
 * P2 algorithm (DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001):
 *   1. Enumerate atoms via registry.exportManifest().
 *   2. Group by (sourcePkg, sourceFile); skip foreign / null-provenance with gap rows.
 *   3. For each group: sort by sourceOffset ASC (NULLs to end), concatenate implSource.
 *   4. Write to <outputDir>/<sourceFile>.
 *   5. Materialise plumbing from registry.listWorkspacePlumbing().
 *   6. Write manifest.json sorted by (outputPath ASC, sourceOffset ASC).
 *   7. NEVER emit <outputDir>/atoms/ — flat-atom output is deleted (Sacred Practice #12).
 *
 * @param opts - Registry path and output directory.
 * @returns CompilePipelineResult with manifest + gap report.
 */
export async function runCompilePipeline(
  opts: CompilePipelineOptions,
): Promise<CompilePipelineResult> {
  const registry: Registry = await openRegistry(opts.registryPath, NULL_EMBEDDING_OPTS);
  try {
    return await _runWithRegistry(registry, opts.outputDir);
  } finally {
    await registry.close();
  }
}

/**
 * Internal implementation after registry is open.
 * Separated for testability — tests may inject an already-open Registry.
 *
 * @internal
 */
export async function _runWithRegistry(
  registry: Registry,
  outputDir: string,
): Promise<CompilePipelineResult> {
  // Step 1: Enumerate all atoms.
  const manifestEntries = await registry.exportManifest();

  // Step 2: Group atoms by sourceFile (workspace-relative).
  // @decision DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001
  interface AtomGroup {
    sourcePkg: string;
    sourceFile: string;
    atoms: Array<{ block: BlockTripletRow; blockMerkleRoot: BlockMerkleRoot }>;
    // addedRoots tracks which blockMerkleRoots have been placed in this group.
    // A single atom may appear at N offsets within one file (N occurrence rows),
    // but must appear at most once in the group — the offset is resolved later
    // via listOccurrencesBySourceFile in step 3. Without this guard, atoms at
    // 2 offsets would be added twice, producing duplicate manifest entries
    // (violates I9: unique (outputPath, blockMerkleRoot) pairs).
    addedRoots: Set<BlockMerkleRoot>;
  }

  const groupMap = new Map<string, AtomGroup>();
  const gapReport: GapRow[] = [];

  for (const entry of manifestEntries) {
    const block = await registry.getBlock(entry.blockMerkleRoot);

    if (block === null) {
      gapReport.push({
        blockMerkleRoot: entry.blockMerkleRoot,
        packageName: "unknown",
        reason: "other",
        detail:
          "Block not found in registry despite being enumerated by exportManifest(). Registry may be corrupted.",
      });
      continue;
    }

    // Foreign atoms: informational skip.
    if (block.kind === "foreign") {
      gapReport.push({
        blockMerkleRoot: entry.blockMerkleRoot,
        packageName: block.foreignPkg ?? "unknown",
        reason: "foreign-leaf-skipped",
        detail: `Foreign atom ${block.foreignPkg ?? "unknown"} is an opaque leaf — not inlined (DEC-V2-FOREIGN-BLOCK-SCHEMA-001).`,
      });
      continue;
    }

    // @decision DEC-STORAGE-IDEMPOTENT-001 (option b / #355)
    // @title Group atoms by block_occurrences, not blocks.source_file (stale first-observed)
    // @status decided (WI-V2-STORAGE-IDEMPOTENT-RECOMPILE #355)
    // @rationale blocks.source_file is a first-observed shim — it points to the file where
    //   the atom was first encountered, not all files where it appears. block_occurrences is
    //   refreshed atomically per file on every bootstrap pass and accurately tracks all files
    //   containing each atom. Grouping by block_occurrences fixes the 6-atom gap for shared
    //   atoms in bootstrap.ts (and analogous shared atoms in other files) that were incorrectly
    //   placed in the first-observed file's group instead of all files they appear in.
    //   Fallback: when block_occurrences has no rows for this atom (pre-v9 registry or atom
    //   removed from source), fall back to block.sourceFile to preserve backward compatibility.
    const occurrences = await registry.listOccurrencesByMerkleRoot(entry.blockMerkleRoot);

    if (occurrences.length > 0) {
      // Per-occurrence placement: add this atom to every file's group it appears in.
      // Shared atoms (same implSource content appearing in N files) correctly appear
      // in N groups — one manifest entry per (file, atom) pair.
      //
      // Deduplication: an atom may appear at multiple offsets within the SAME file
      // (N occurrence rows with same source_file but different source_offset). The
      // group adds the atom only once — step 3 resolves the correct offset via
      // listOccurrencesBySourceFile. addedRoots tracks which merkle roots are already
      // in each group to prevent duplicate manifest entries.
      for (const occ of occurrences) {
        const key = occ.sourceFile;
        const existing = groupMap.get(key);
        if (existing !== undefined) {
          if (!existing.addedRoots.has(entry.blockMerkleRoot)) {
            existing.addedRoots.add(entry.blockMerkleRoot);
            existing.atoms.push({ block, blockMerkleRoot: entry.blockMerkleRoot });
          }
        } else {
          groupMap.set(key, {
            sourcePkg: occ.sourcePkg,
            sourceFile: occ.sourceFile,
            atoms: [{ block, blockMerkleRoot: entry.blockMerkleRoot }],
            addedRoots: new Set([entry.blockMerkleRoot]),
          });
        }
      }
    } else {
      // Fallback: no block_occurrences rows (pre-v9 registry or atom not in any current file).
      // Use blocks.source_* columns for backward compatibility.
      if (block.sourcePkg == null || block.sourceFile == null) {
        // @decision I7 resolution: NULL-provenance atoms emit a gap row.
        gapReport.push({
          blockMerkleRoot: entry.blockMerkleRoot,
          packageName: block.sourcePkg ?? "unknown",
          reason: "null-provenance",
          detail:
            "Atom has NULL sourcePkg and/or NULL sourceFile — cannot place in workspace tree. " +
            "Re-run 'yakcc bootstrap' with a P1+ CLI to populate provenance.",
        });
        continue;
      }
      const key = block.sourceFile;
      const existing = groupMap.get(key);
      if (existing !== undefined) {
        if (!existing.addedRoots.has(entry.blockMerkleRoot)) {
          existing.addedRoots.add(entry.blockMerkleRoot);
          existing.atoms.push({ block, blockMerkleRoot: entry.blockMerkleRoot });
        }
      } else {
        groupMap.set(key, {
          sourcePkg: block.sourcePkg,
          sourceFile: block.sourceFile,
          atoms: [{ block, blockMerkleRoot: entry.blockMerkleRoot }],
          addedRoots: new Set([entry.blockMerkleRoot]),
        });
      }
    }
  }

  // Step 3–4: Emit one TS file per group, interleaving glue + atoms by sourceOffset ASC.
  //
  // @decision DEC-V2-COMPILE-SELF-GLUE-INTERLEAVING-001
  // @title compile-pipeline interleaves glue blobs with atom implSources in sourceOffset order
  // @status decided (WI-V2-WORKSPACE-PLUMBING-GLUE-CAPTURE #333)
  // @rationale Mirrors compile-self.ts glue interleaving exactly (DEC-V2-COMPILE-SELF-EQ-001).
  //   Algorithm:
  //     1. Fetch glue blob for this (sourcePkg, sourceFile) via registry.getSourceFileGlue().
  //     2. Walk atoms in sourceOffset order. For each atom:
  //        a. glueCharsBeforeAtom = atom.sourceOffset - prevOriginalEnd
  //        b. Emit that slice of the glue string.
  //        c. Emit atom.implSource.
  //        d. Advance prevOriginalEnd = atom.sourceOffset + atom.implSource.length.
  //     3. Emit trailing glue (chars after last atom to end of file).
  //   Fallback: when no glue row exists (pre-#333 bootstrap or atoms lack sourceOffset),
  //   falls back to atom-only concatenation and logs a warning.
  //   Invariant: glue_blob_char_count + sum(implSource_lengths) == reconstructed file char count.
  // @decision I7: NULLs sort to end; I8: overlapping offsets treated as 'other' gap.
  const manifest: ManifestEntry[] = [];
  let recompiledFiles = 0;

  mkdirSync(outputDir, { recursive: true });

  for (const [, group] of groupMap) {
    // @decision DEC-V2-STORAGE-IDEMPOTENT-RECOMPILE-001
    // Read current-truth atom offsets from block_occurrences (not blocks.source_offset).
    // blocks.source_offset is a stale first-observed-wins value; block_occurrences is
    // refreshed atomically per file on every bootstrap pass (#355). Using block_occurrences
    // ensures atoms are placed at their current positions even after source edits.
    //
    // Fallback: when block_occurrences is empty (pre-v9 registry or bootstrap not run),
    // use blocks.source_offset for backward compatibility.
    const occurrences = await registry.listOccurrencesBySourceFile(group.sourceFile);

    // Build a map from blockMerkleRoot → ALL offsets where the atom appears in this file.
    // A single atom may appear at N different offsets (same implSource repeated N times).
    // Each occurrence offset produces a separate sorted entry so the glue-interleaving
    // emits the atom N times at the correct positions (mirroring the original source).
    //
    // @decision DEC-STORAGE-IDEMPOTENT-001 multi-offset expansion
    // @rationale When block_occurrences has N rows for (file, blockMerkleRoot) with different
    //   source_offsets, the original file contained the atom N times. Expanding to N sorted
    //   entries ensures each repetition is emitted at its correct position. A single-offset
    //   map (occurrenceOffsets) would miss the N-1 earlier occurrences, producing malformed
    //   output (observed build failure: canonical-ast.ts missing two instances of a 13-char atom).
    const occurrencesByRoot = new Map<string, number[]>();
    for (const occ of occurrences) {
      const existing = occurrencesByRoot.get(occ.blockMerkleRoot);
      if (existing !== undefined) {
        existing.push(occ.sourceOffset);
      } else {
        occurrencesByRoot.set(occ.blockMerkleRoot, [occ.sourceOffset]);
      }
    }

    // Expand group atoms: each unique atom gets one entry per occurrence offset.
    // For atoms with 1 occurrence: same as before (one entry). For atoms with N
    // occurrences in the same file: N entries with the same block data but different
    // effectiveOffset.
    //
    // @decision DEC-V2-GLUE-GHOST-ATOM-EXCLUSION-001
    // @title When v9 occurrence rows exist for a file, atoms absent from block_occurrences
    //   are glue-absorbed and must be excluded from reconstruction (not placed at stale offset)
    // @status decided (WI-V2-STORAGE-IDEMPOTENT-RECOMPILE #355 Bug D fix)
    // @rationale
    //   Mirrors compile-self.ts DEC-V2-GLUE-GHOST-ATOM-EXCLUSION-001 exactly
    //   (DEC-V2-COMPILE-SELF-EQ-001). When occurrences.length > 0 the file was processed
    //   by v9+ bootstrap and block_occurrences is authoritative. Atoms absent from
    //   occurrencesByRoot are glue-absorbed — excluding them prevents inserting their
    //   implSource inside a glue region that already contains the same content.
    //   When occurrences.length === 0 (pre-v9 registry), fall back to blocks.source_offset
    //   for backward compatibility.
    const v9ProcessedFile = occurrences.length > 0;
    interface AtomWithOffset {
      block: BlockTripletRow;
      blockMerkleRoot: BlockMerkleRoot;
      effectiveOffset: number | null;
    }
    const atomsWithOffset: AtomWithOffset[] = [];
    for (const atom of group.atoms) {
      const offsets = occurrencesByRoot.get(atom.blockMerkleRoot);
      if (offsets !== undefined && offsets.length > 0) {
        for (const offset of offsets) {
          atomsWithOffset.push({ ...atom, effectiveOffset: offset });
        }
      } else if (v9ProcessedFile) {
        // v9 bootstrap processed this file: atom absent from block_occurrences is
        // glue-absorbed — exclude it from reconstruction to avoid duplication, and
        // emit an informational gap row so the uniquePlaced + gap = total invariant holds.
        // (See DEC-V2-GLUE-GHOST-ATOM-EXCLUSION-001 for full rationale.)
        gapReport.push({
          blockMerkleRoot: atom.blockMerkleRoot,
          packageName: group.sourcePkg,
          sourcePath: group.sourceFile,
          reason: "glue-absorbed",
          detail: `Atom stale blocks.source_offset=${atom.block.sourceOffset ?? "null"} in ${group.sourceFile} — absent from block_occurrences (v9 processed), content already present in glue blob. Excluded from reconstruction to prevent duplicate content. (DEC-V2-GLUE-GHOST-ATOM-EXCLUSION-001)`,
        });
      } else {
        // Fallback: no occurrence rows (pre-v9 registry) — use legacy blocks.source_offset.
        atomsWithOffset.push({ ...atom, effectiveOffset: atom.block.sourceOffset ?? null });
      }
    }

    // Sort: current-truth offsets ascending first, null offsets appended.
    const sorted = [...atomsWithOffset].sort((a, b) => {
      const ao = a.effectiveOffset;
      const bo = b.effectiveOffset;
      if (ao === null && bo === null) return 0;
      if (ao === null) return 1;
      if (bo === null) return -1;
      return ao - bo;
    });

    // Glue-interleaved reconstruction (DEC-V2-COMPILE-SELF-GLUE-INTERLEAVING-001).
    // Mirrors the algorithm in packages/cli/src/commands/compile-self.ts _runPipeline().
    let fileContent: string;
    const glueEntry = await registry.getSourceFileGlue(group.sourcePkg, group.sourceFile);

    if (glueEntry !== null && sorted.every((a) => a.effectiveOffset !== null)) {
      // Glue-interleaved path: reconstruct the original file by weaving glue + atoms.
      //
      // @decision DEC-V2-COMPILE-SELF-GLUE-INTERLEAVING-001 (overlap handling)
      // @title Reconstruction uses merged intervals to mirror computeGlueBlob's behaviour
      // @status decided (WI-V2-WORKSPACE-PLUMBING-GLUE-CAPTURE #333 overlap fix; updated #355)
      // @rationale
      //   bootstrap.ts computeGlueBlob() merges overlapping atom intervals before
      //   computing glue gaps. The reconstruction must mirror this: build the same
      //   merged intervals, walk them to advance gluePos. With block_occurrences (#355),
      //   stale offsets are eliminated — each file's occurrences are refreshed atomically
      //   on every bootstrap pass. The merge is retained defensively.
      //
      //   Algorithm:
      //     1. Build merged intervals (same merge as computeGlueBlob).
      //     2. For each merged interval:
      //        a. Emit glue chars from gluePos up to interval.start.
      //        b. Emit atoms within the interval in sourceOffset order, skipping overlapping ones.
      //        c. Advance prevMergedEnd = interval.end.
      //     3. Emit trailing glue after the last merged interval.
      // @decision DEC-V2-COMPILE-SELF-GLUE-DECODE-IGNOREBOM-001 (parity — same fix as compile-self.ts)
      // @title compile-pipeline glue decode preserves UTF-8 BOM bytes
      // @status decided (WI-FIX-543, issue #543)
      // @rationale See compile-self.ts DEC-V2-COMPILE-SELF-GLUE-DECODE-IGNOREBOM-001.
      //   Identical BOM-strip defect via default TextDecoder options; same mechanical fix.
      const glueString = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        glueEntry.contentBlob,
      );

      // Step 1: compute merged intervals (same merge as computeGlueBlob).
      interface MergedInterval {
        start: number;
        end: number;
        atoms: Array<(typeof sorted)[number]>;
      }
      const mergedIntervals: MergedInterval[] = [];
      for (const atom of sorted) {
        const start = atom.effectiveOffset as number;
        const end = start + atom.block.implSource.length;
        const last = mergedIntervals[mergedIntervals.length - 1];
        if (last !== undefined && start < last.end) {
          if (end > last.end) last.end = end;
          last.atoms.push(atom);
        } else {
          mergedIntervals.push({ start, end, atoms: [atom] });
        }
      }

      // Step 2: interleave glue + atoms, walking merged intervals.
      const parts: string[] = [];
      let prevMergedEnd = 0;
      let gluePosCursor = 0;

      for (const interval of mergedIntervals) {
        // 2a: glue chars between last merged interval end and this interval's start.
        const glueBetween = interval.start - prevMergedEnd;
        if (glueBetween > 0) {
          parts.push(glueString.slice(gluePosCursor, gluePosCursor + glueBetween));
          gluePosCursor += glueBetween;
        }

        // 2b: atoms within this interval, skipping overlapping ones.
        let intervalCursor = interval.start;
        for (const atom of interval.atoms) {
          const atomStart = atom.effectiveOffset as number;
          if (atomStart < intervalCursor) {
            continue; // overlapping atom — already covered by a prior atom in this interval
          }
          parts.push(atom.block.implSource);
          intervalCursor = atomStart + atom.block.implSource.length;
        }

        prevMergedEnd = interval.end;
      }

      // Step 3: trailing glue after the last merged interval.
      if (gluePosCursor < glueString.length) {
        parts.push(glueString.slice(gluePosCursor));
      }

      if (parts.length > 0) {
        fileContent = parts.join("");
      } else {
        fileContent = sorted.map((a) => a.block.implSource).join("");
      }
    } else {
      // Fallback: no glue captured (pre-#333 bootstrap) or some atoms lack sourceOffset.
      // Log informational; do not fail (backward compatibility with pre-v8 registries).
      fileContent = sorted.map((a) => a.block.implSource).join("");
    }

    // Write to <outputDir>/<sourceFile>.
    const outputPath = join(outputDir, group.sourceFile);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, fileContent, "utf-8");
    recompiledFiles++;

    // One manifest row per atom. sourceOffset now reflects current-truth from block_occurrences.
    for (const atom of sorted) {
      manifest.push({
        outputPath: group.sourceFile,
        blockMerkleRoot: atom.blockMerkleRoot,
        sourcePkg: atom.block.sourcePkg ?? null,
        sourceFile: atom.block.sourceFile ?? null,
        sourceOffset: atom.effectiveOffset,
      });
    }
  }

  // Step 5: Materialise plumbing files.
  // SINGLE AUTHORITY: only registry.listWorkspacePlumbing() — no filesystem reads
  // at compile time (DEC-V2-WORKSPACE-PLUMBING-AUTHORITY-001 / FS3).
  const plumbingEntries: readonly WorkspacePlumbingEntry[] = await registry.listWorkspacePlumbing();
  let plumbingFilesEmitted = 0;

  for (const plumbing of plumbingEntries) {
    const outputPath = join(outputDir, plumbing.workspacePath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, plumbing.contentBytes);
    plumbingFilesEmitted++;
  }

  // Step 6: Write manifest.json sorted by (outputPath ASC, sourceOffset ASC).
  manifest.sort((a, b) => {
    const pathCmp = (a.outputPath ?? "").localeCompare(b.outputPath ?? "");
    if (pathCmp !== 0) return pathCmp;
    const ao = a.sourceOffset ?? Number.MAX_SAFE_INTEGER;
    const bo = b.sourceOffset ?? Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });

  const manifestPath = join(outputDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  return { recompiledFiles, plumbingFilesEmitted, manifest, gapReport };
}

// ---------------------------------------------------------------------------
// openRegistryForCompile — convenience factory
// ---------------------------------------------------------------------------

/**
 * Open a registry for the compile-self CLI command using null-zero embeddings.
 *
 * @internal for compile-self use only.
 */
export async function openRegistryForCompile(registryPath: string): Promise<Registry> {
  return openRegistry(registryPath, NULL_EMBEDDING_OPTS);
}
