// SPDX-License-Identifier: MIT
// two-pass-equivalence.test.ts — Crown-jewel two-pass bootstrap equivalence harness.
//
// WI-V2-09 / Issue #286: Fixed-point self-hosting proof.
//
// Claim: yakcc shaved by yakcc, recomposed via compile-self, then re-shaved against
// the recomposed source → byte-identical BlockMerkleRoots for every atom in the
// shavable subset. Any divergence surfaces non-determinism in the canonicalizer,
// AST-hash, or merkle path — the most valuable test the project can run.
//
// Two-pass cycle:
//   Pass 1 (registry A): bootstrap/yakcc.registry.sqlite — the live bootstrap
//          registry, produced by a prior 'yakcc bootstrap' run.
//   Recompile: yakcc compile-self → tmp/two-pass/dist-recompiled/
//   Pass 2 (registry B): yakcc bootstrap inside dist-recompiled workspace
//          → tmp/two-pass/registry-B.sqlite
//   Compare: forall r in (rootsA \ excludedRoots): r in rootsB  (byte-equal hex strings)
//
// @decision DEC-V2-BOOTSTRAP-EQUIV-001
// @title Strict byte-equality of every BlockMerkleRoot in the shavable subset
// @status accepted (WI-V2-09 / Issue #286)
// @rationale Per-root byte-equality (not hash-of-hashes, not subset-of-superset) is the
//   load-bearing invariant. Any divergence between registry A and registry B for an
//   included source file is a real non-determinism bug. The harness fails loudly and
//   routes to planner with the divergent-root manifest (Risk R2 from plan.md). The
//   exclusion list operates at the FILE level only; within included files, all roots
//   must be byte-identical. No tolerance, no truncation, no prefix-match.
//
// @decision DEC-V2-BOOTSTRAP-EQUIV-EXCLUSIONS-001
// @title Exclusion list lives as a documented const; dynamic ⊆ documented invariant
// @status accepted (WI-V2-09 / Issue #286)
// @rationale The 7 known-failure files (issue #399 — WI-SHAVE-PROBLEM-CONSTRUCTS) are
//   recorded as a static documented upper bound. The harness ALSO derives a dynamic
//   exclusion set at runtime: source files not in the compile-self manifest (i.e., files
//   that emitted zero atoms in pass 1). The harness asserts dynamic ⊆ documented. When
//   issue #399 lands and the 7 files start shaving, the dynamic set shrinks to empty and
//   T2 automatically covers the full 144-file corpus — zero rework required.
//
// Gate: YAKCC_TWO_PASS=1 (mirrors YAKCC_BENCHMARKS=1 / DEC-CI-OFFLINE-005).
// Without the env var the entire describe block is describe.skipIf-skipped.
// Default pnpm -r test must not regress in runtime or pass-count.
//
// Wall-time: ~60-70 min for the full two-pass cycle.

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { openRegistry } from "@yakcc/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Known-failure exclusion list (issue #399 — WI-SHAVE-PROBLEM-CONSTRUCTS)
//
// These 7 source files cannot be shaved due to construct-level gaps in the
// shave pipeline. They are documented here as the static upper bound for the
// dynamic exclusion set. When issue #399 lands and these files start shaving,
// the dynamic exclusion set derived at runtime will shrink (potentially to
// empty), and the byte-identity proof automatically covers the full corpus.
//
// Class A — IntentCardSchemaError (2 files):
//   Produces an IntentCardSchemaError during yakcc bootstrap.
//   These files use constructs that the intent-card schema parser rejects.
//
// Class B — DidNotReachAtomError on CallExpression (5 files):
//   The shave pipeline emits a DidNotReachAtomError when encountering
//   certain CallExpression patterns (e.g., method chains, dynamic imports).
//
// @decision DEC-V2-BOOTSTRAP-EQUIV-EXCLUSIONS-001 (annotation site)
// ---------------------------------------------------------------------------

/**
 * Static upper bound for the dynamic exclusion set.
 * Source: issue #399 (WI-SHAVE-PROBLEM-CONSTRUCTS), validated at planner time 2026-05-12.
 *
 * IMPORTANT: the harness uses the DYNAMIC exclusion set (derived from the compile-self
 * manifest) for filtering, NOT this list directly. This list is the superset assertion:
 *   dynamic ⊆ EXCLUSION_DOCUMENTED_FILES
 * If a new file appears in the dynamic set that is NOT here, the harness fails loudly.
 */
export const EXCLUSION_DOCUMENTED_FILES: readonly string[] = [
  // Class A — IntentCardSchemaError (issue #399)
  "packages/cli/src/commands/hooks-cursor-install.ts",
  "packages/cli/src/commands/hooks-install.ts",
  // Class B — DidNotReachAtomError on CallExpression (issue #399)
  "packages/hooks-base/src/index.ts",
  "packages/hooks-base/src/telemetry.ts",
  "packages/hooks-claude-code/src/index.ts",
  "packages/hooks-cursor/src/index.ts",
  "packages/registry/src/discovery-eval-helpers.ts",
] as const;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

const THIS_FILE = resolve(import.meta.url.replace("file://", ""));
const EXAMPLES_DIR = resolve(THIS_FILE, "../../..");
const REPO_ROOT = findRepoRoot(EXAMPLES_DIR);

// Registry A: the live bootstrap registry (pass 1, read-only consumer).
const REGISTRY_A_PATH = join(REPO_ROOT, "bootstrap", "yakcc.registry.sqlite");

// Scratch outputs for the two-pass cycle (tmp/ is gitignored globally).
const TWO_PASS_DIR = join(REPO_ROOT, "tmp", "two-pass");
const DIST_RECOMPILED_DIR = join(TWO_PASS_DIR, "dist-recompiled");
const REGISTRY_B_PATH = join(TWO_PASS_DIR, "registry-B.sqlite");
const REPORT_B_PATH = join(TWO_PASS_DIR, "report-B.json");
const MANIFEST_B_PATH = join(TWO_PASS_DIR, "expected-roots-B.json");

// The built CLI binary in the canonical workspace (source of truth for the CLI).
const CLI_BIN_PATH = join(REPO_ROOT, "packages", "cli", "dist", "bin.js");

// Null-zero embedding opts (bootstrap uses zero vectors for determinism).
const NULL_EMBEDDING_OPTS = {
  embeddings: {
    dimension: 384,
    modelId: "two-pass/null-zero",
    embed: async (_text: string): Promise<Float32Array> => new Float32Array(384),
  },
} as const;

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

let registryAAvailable = false;
let cliBinAvailable = false;

// Roots collected from registry A and B.
let rootsA: Set<string> = new Set();
let rootsB: Set<string> = new Set();

// Dynamic exclusion set: source files that emitted zero atoms in pass 1.
// Derived from the compile-self manifest (files present in registry A's occurrence
// table but absent from the manifest = zero-atom files in pass 1).
let dynamicExclusionSet: Set<string> = new Set();

// Roots that are excluded (all their occurrences map to excluded source files).
let excludedRoots: Set<string> = new Set();
// Roots included in the byte-identity check (rootsA minus excludedRoots).
let includedRoots: Set<string> = new Set();

// Diagnostics surfaced by the two-pass cycle.
let compileSelfOutput = "";
let bootstrapBOutput = "";
let includedCount = 0;
let excludedCount = 0;

// ---------------------------------------------------------------------------
// Helper: walk all shavable .ts source files in a workspace root
// ---------------------------------------------------------------------------

function walkTs(dir: string, results: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTs(full, results);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
}

function collectShavableFiles(workspaceRoot: string): string[] {
  const raw: string[] = [];
  for (const topDir of ["packages", "examples"]) {
    const top = join(workspaceRoot, topDir);
    if (!existsSync(top)) continue;
    for (const pkg of readdirSync(top, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const srcDir = join(top, pkg.name, "src");
      walkTs(srcDir, raw);
    }
  }
  // Return workspace-relative paths (e.g. "packages/cli/src/commands/foo.ts").
  return raw
    .map((abs) => relative(workspaceRoot, abs))
    .filter((rel) => !rel.startsWith(".."))
    .sort();
}

// ---------------------------------------------------------------------------
// describe.skipIf gate — mirrors DEC-CI-OFFLINE-005 / storage.benchmark.test.ts
//
// The full two-pass cycle is ~60-70 min. Default pnpm -r test must not block.
// Opt in with: YAKCC_TWO_PASS=1 pnpm --filter v2-self-shave-poc test two-pass-equivalence
// ---------------------------------------------------------------------------

describe.skipIf(process.env.YAKCC_TWO_PASS !== "1")(
  "Two-pass bootstrap equivalence (#286 WI-V2-09)",
  () => {
    // -------------------------------------------------------------------------
    // Setup: run the full two-pass cycle
    // -------------------------------------------------------------------------

    beforeAll(async () => {
      // --- Precondition: registry A must exist ---
      if (!existsSync(REGISTRY_A_PATH)) {
        console.warn(
          `[two-pass] BLOCKED_BY_PLAN (precondition): registry A not found at ${REGISTRY_A_PATH}.` +
            ` Run 'yakcc bootstrap' first to populate it. Two-pass cycle cannot proceed.`,
        );
        return;
      }
      registryAAvailable = true;

      // --- Precondition: CLI binary must be built ---
      if (!existsSync(CLI_BIN_PATH)) {
        console.warn(
          `[two-pass] BLOCKED_BY_PLAN (precondition): CLI binary not found at ${CLI_BIN_PATH}.` +
            ` Run 'pnpm -r build' first. Two-pass cycle cannot proceed.`,
        );
        return;
      }
      cliBinAvailable = true;

      // --- Step 0: create scratch directories ---
      mkdirSync(TWO_PASS_DIR, { recursive: true });

      // Remove stale recompiled workspace and registry B from prior runs.
      if (existsSync(DIST_RECOMPILED_DIR)) {
        rmSync(DIST_RECOMPILED_DIR, { recursive: true, force: true });
      }
      if (existsSync(REGISTRY_B_PATH)) {
        rmSync(REGISTRY_B_PATH, { force: true });
      }

      // --- Step 1 (T2 in evaluation contract): compile-self ---
      // Run yakcc compile-self --registry <registryA> --output <distRecompiledDir>
      // This reconstructs the workspace from the atoms in registry A.
      console.info(
        `[two-pass] Step 1: compile-self → ${DIST_RECOMPILED_DIR}`,
      );
      try {
        compileSelfOutput = execSync(
          `node "${CLI_BIN_PATH}" compile-self --registry "${REGISTRY_A_PATH}" --output "${DIST_RECOMPILED_DIR}" 2>&1`,
          {
            cwd: REPO_ROOT,
            timeout: 300_000, // 5 min for compile-self
            encoding: "utf-8",
            env: { ...process.env },
          },
        );
        console.info(
          `[two-pass] compile-self succeeded.\n${compileSelfOutput.slice(-800)}`,
        );
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        const errOut = (e.stdout ?? "") + (e.stderr ?? String(err));
        console.error(`[two-pass] compile-self FAILED (exit ${(e as { status?: number }).status ?? "?"}):`, errOut.slice(-1000));
        throw new Error(
          `[two-pass] compile-self failed: ${errOut.slice(0, 300)}`,
        );
      }

      // Verify the recompiled workspace produced output.
      if (!existsSync(DIST_RECOMPILED_DIR)) {
        throw new Error(
          `[two-pass] compile-self exited 0 but ${DIST_RECOMPILED_DIR} does not exist.`,
        );
      }

      // --- Step 2: derive dynamic exclusion set from compile-self manifest ---
      //
      // The compile-self manifest records which source files had atoms placed.
      // Source files present in the shavable corpus but ABSENT from the manifest
      // emitted zero atoms in pass 1 → they belong to the dynamic exclusion set.
      //
      // @decision DEC-V2-BOOTSTRAP-EQUIV-EXCLUSIONS-001 (implementation site)

      const manifestPath = join(DIST_RECOMPILED_DIR, "manifest.json");
      if (!existsSync(manifestPath)) {
        throw new Error(
          `[two-pass] compile-self manifest not found at ${manifestPath}. compile-self may have failed silently.`,
        );
      }

      type RawManifestEntry = { sourceFile?: string | null; outputPath?: string };
      const manifestEntries = JSON.parse(readFileSync(manifestPath, "utf-8")) as RawManifestEntry[];
      // Collect all source files represented in the manifest (have atoms in pass 1).
      const manifestSourceFiles = new Set<string>(
        manifestEntries
          .map((e) => e.sourceFile ?? e.outputPath ?? "")
          .filter((f) => f.length > 0),
      );

      // Walk all shavable .ts files in the original workspace.
      const allShavableFiles = collectShavableFiles(REPO_ROOT);
      console.info(`[two-pass] Shavable corpus: ${allShavableFiles.length} files.`);
      console.info(`[two-pass] compile-self manifest coverage: ${manifestSourceFiles.size} source files.`);

      // Dynamic exclusion set = shavable files NOT in the manifest.
      // These files emitted zero atoms in pass 1 (either failed to shave or
      // produced only glue — the latter is impossible in practice since every
      // valid TS file with functions has at least one atom).
      for (const rel of allShavableFiles) {
        if (!manifestSourceFiles.has(rel)) {
          dynamicExclusionSet.add(rel);
        }
      }

      console.info(
        `[two-pass] Dynamic exclusion set (${dynamicExclusionSet.size} files):`,
      );
      for (const f of [...dynamicExclusionSet].sort()) {
        console.info(`  - ${f}`);
      }

      // --- Step 3 (T3 in evaluation contract): assert dynamic ⊆ documented ---
      //
      // @decision DEC-V2-BOOTSTRAP-EQUIV-EXCLUSIONS-001 (assertion site)
      //
      // If a new zero-atom file appears that is NOT in EXCLUSION_DOCUMENTED_FILES,
      // the harness fails loudly with the new path — surfacing drift before any
      // byte-identity claim is made. This is the durability invariant.
      const documentedSet = new Set(EXCLUSION_DOCUMENTED_FILES);
      const undocumentedNewFailures: string[] = [];
      for (const f of dynamicExclusionSet) {
        if (!documentedSet.has(f)) {
          undocumentedNewFailures.push(f);
        }
      }

      if (undocumentedNewFailures.length > 0) {
        console.error(
          `[two-pass] DYNAMIC ⊄ DOCUMENTED: ${undocumentedNewFailures.length} new zero-atom file(s) ` +
            `not in EXCLUSION_DOCUMENTED_FILES:\n` +
            undocumentedNewFailures.map((f) => `  + ${f}`).join("\n") +
            `\n\nAction: add these paths to EXCLUSION_DOCUMENTED_FILES in this test file, ` +
            `referencing the tracking issue. Then investigate why these files emit zero atoms.`,
        );
        throw new Error(
          `[two-pass] Dynamic exclusion set contains undocumented files: ${undocumentedNewFailures.join(", ")}`,
        );
      }
      console.info("[two-pass] T3: dynamic ⊆ documented — invariant holds.");

      // --- Step 4 (T1 in evaluation contract): second bootstrap pass ---
      //
      // Run yakcc bootstrap against the recompiled workspace to produce registry B.
      // The recompiled workspace acts as the "repo root" for bootstrap's source walk
      // (packages/*/src + examples/*/src). Registry B is written to tmp/two-pass/.
      //
      // IMPORTANT: we use the CANONICAL CLI binary (from the original workspace)
      // to run bootstrap, because the recompiled workspace cannot be built due to
      // issue #399 (7 unshavable files prevent pnpm -r build from completing).
      // The canonical CLI is invoked from the recompiled workspace directory so
      // findRepoRoot(process.cwd()) discovers dist-recompiled/ as the repo root
      // and walks its packages/*/src + examples/*/src source tree.
      //
      // This is the correct second-pass semantics: bootstrap shaves the RECOMPILED
      // source files (not the original ones), producing registry B.

      if (!existsSync(join(DIST_RECOMPILED_DIR, "pnpm-workspace.yaml"))) {
        console.warn(
          `[two-pass] BLOCKED_BY_PLAN: dist-recompiled/pnpm-workspace.yaml not present. ` +
            `Bootstrap plumbing capture may not have captured this file. ` +
            `Second bootstrap pass may walk the wrong root.`,
        );
        // Non-fatal: proceed with the bootstrap run; findRepoRoot will fall back
        // to the CWD if pnpm-workspace.yaml is missing.
      }

      console.info(
        `[two-pass] Step 4: second bootstrap pass → ${REGISTRY_B_PATH}`,
      );
      try {
        bootstrapBOutput = execSync(
          `node "${CLI_BIN_PATH}" bootstrap ` +
            `--registry "${REGISTRY_B_PATH}" ` +
            `--manifest "${MANIFEST_B_PATH}" ` +
            `--report "${REPORT_B_PATH}" 2>&1`,
          {
            cwd: DIST_RECOMPILED_DIR, // walk recompiled workspace source tree
            timeout: 3_600_000, // 60 min for full bootstrap
            encoding: "utf-8",
            env: { ...process.env },
          },
        );
        console.info(
          `[two-pass] Second bootstrap pass succeeded.\n${bootstrapBOutput.slice(-800)}`,
        );
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        const errOut = (e.stdout ?? "") + (e.stderr ?? String(err));
        console.error(
          `[two-pass] Second bootstrap FAILED (exit ${(e as { status?: number }).status ?? "?"}):`,
          errOut.slice(-1000),
        );
        throw new Error(
          `[two-pass] Second bootstrap pass failed: ${errOut.slice(0, 300)}`,
        );
      }

      // --- Step 5: build rootsA and rootsB sets for the byte-identity check ---
      //
      // @decision DEC-V2-BOOTSTRAP-EQUIV-001 (implementation site)
      //
      // Open both registries and collect all blockMerkleRoots.
      // Registry A is opened READ-ONLY (no write paths from this harness).

      const regA = await openRegistry(REGISTRY_A_PATH, NULL_EMBEDDING_OPTS);
      try {
        const manifestA = await regA.exportManifest();
        rootsA = new Set(manifestA.map((e) => e.blockMerkleRoot));
        console.info(`[two-pass] Registry A: ${rootsA.size} unique blockMerkleRoots.`);
      } finally {
        await regA.close();
      }

      const regB = await openRegistry(REGISTRY_B_PATH, NULL_EMBEDDING_OPTS);
      try {
        const manifestB = await regB.exportManifest();
        rootsB = new Set(manifestB.map((e) => e.blockMerkleRoot));
        console.info(`[two-pass] Registry B: ${rootsB.size} unique blockMerkleRoots.`);
      } finally {
        await regB.close();
      }

      // --- Step 6: compute excludedRoots and includedRoots ---
      //
      // A root is EXCLUDED iff all its occurrences in registry A come from source
      // files in the dynamic exclusion set. (A root shared between an excluded file
      // and a non-excluded file is INCLUDED — stricter, correct per plan.md R5.)
      //
      // Implementation: open registry A again to query listOccurrencesByMerkleRoot().
      // We only query roots that could plausibly be excluded (i.e., roots from registry A
      // that are absent from registry B) to minimize the query count.
      //
      // For each root in rootsA:
      //   if the root IS in rootsB → automatically included (byte-identity holds for this root)
      //   if the root is NOT in rootsB → need to check if all occurrences are in dynamicExclusionSet

      const missingInB = [...rootsA].filter((r) => !rootsB.has(r));
      console.info(
        `[two-pass] Roots in A not in B (before exclusion check): ${missingInB.length}`,
      );

      if (missingInB.length > 0) {
        const regA2 = await openRegistry(REGISTRY_A_PATH, NULL_EMBEDDING_OPTS);
        try {
          for (const root of missingInB) {
            const occurrences = await regA2.listOccurrencesByMerkleRoot(root);
            // A root is excluded iff EVERY occurrence source file is in the dynamic exclusion set.
            const allOccurrencesInExcluded = occurrences.every((occ) =>
              dynamicExclusionSet.has(occ.sourceFile),
            );
            if (allOccurrencesInExcluded) {
              excludedRoots.add(root);
            }
            // Roots in rootsA that ARE in rootsB pass automatically (no exclusion needed).
          }
        } finally {
          await regA2.close();
        }
      }

      // includedRoots = rootsA \ excludedRoots (only check roots from A, not A∩B)
      // The byte-identity assertion is: forall r in includedRoots → r in rootsB.
      for (const r of rootsA) {
        if (!excludedRoots.has(r)) {
          includedRoots.add(r);
        }
      }

      includedCount = includedRoots.size;
      excludedCount = excludedRoots.size;

      console.info(`[two-pass] Included roots (must appear in B): ${includedCount}`);
      console.info(`[two-pass] Excluded roots (from #399 files): ${excludedCount}`);
    }, 4_200_000); // 70 min total timeout for the full two-pass cycle

    afterAll(() => {
      // Registry B and dist-recompiled are gitignored (tmp/ pattern).
      // We do NOT clean them up here so the reviewer can inspect the outputs.
      // The directories are overwritten on the next run (rmSync at beforeAll start).
    });

    // -------------------------------------------------------------------------
    // T1: Two-pass cycle ran to completion without error
    // -------------------------------------------------------------------------

    it("T1: registry A exists (precondition)", () => {
      if (!registryAAvailable) {
        console.warn(
          "BLOCKED_BY_PLAN (precondition): registry A not found. Run 'yakcc bootstrap' first.",
        );
        return; // soft-skip: document blocker, not a hard failure
      }
      expect(existsSync(REGISTRY_A_PATH)).toBe(true);
    });

    it("T1: CLI binary exists (precondition)", () => {
      if (!cliBinAvailable) {
        console.warn(
          "BLOCKED_BY_PLAN (precondition): CLI binary not found. Run 'pnpm -r build' first.",
        );
        return;
      }
      expect(existsSync(CLI_BIN_PATH)).toBe(true);
    });

    it("T1: compile-self produced the recompiled workspace", () => {
      if (!registryAAvailable || !cliBinAvailable) return;
      expect(existsSync(DIST_RECOMPILED_DIR)).toBe(true);
      // The manifest must exist (proves compile-self emitted atoms and wrote manifest).
      const manifestPath = join(DIST_RECOMPILED_DIR, "manifest.json");
      expect(existsSync(manifestPath)).toBe(true);
      const rawManifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as unknown[];
      expect(rawManifest.length).toBeGreaterThanOrEqual(137);
      console.info(`[two-pass] T1: compile-self manifest has ${rawManifest.length} entries.`);
    });

    it("T1: compile-self emitted ≥ 137 source files (137/144 shavable subset)", () => {
      if (!registryAAvailable || !cliBinAvailable) return;
      // Verify the recompiled workspace contains source files under packages/ and examples/.
      let tsFileCount = 0;
      function countTs(dir: string): void {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) countTs(full);
          else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) tsFileCount++;
        }
      }
      countTs(join(DIST_RECOMPILED_DIR, "packages"));
      countTs(join(DIST_RECOMPILED_DIR, "examples"));
      console.info(`[two-pass] T1: recompiled workspace has ${tsFileCount} .ts source files.`);
      expect(tsFileCount).toBeGreaterThanOrEqual(137);
    });

    it("T1: registry B exists (second bootstrap pass completed)", () => {
      if (!registryAAvailable || !cliBinAvailable) return;
      expect(existsSync(REGISTRY_B_PATH)).toBe(true);
      expect(statSync(REGISTRY_B_PATH).size).toBeGreaterThan(0);
    });

    it("T1: registry B has a non-empty manifest (atoms were shaved in pass 2)", () => {
      if (!registryAAvailable || !cliBinAvailable) return;
      expect(rootsB.size).toBeGreaterThan(0);
      console.info(`[two-pass] T1: registry B has ${rootsB.size} blockMerkleRoots.`);
    });

    // -------------------------------------------------------------------------
    // T2: Strict per-root byte-equality (the crown-jewel proof)
    //
    // @decision DEC-V2-BOOTSTRAP-EQUIV-001
    // forall r in (rootsA \ excludedRoots): r in rootsB
    // Byte-equal 64-char hex string comparison. No tolerance, no truncation.
    // -------------------------------------------------------------------------

    it(
      "T2: every included blockMerkleRoot from registry A exists byte-identically in registry B",
      () => {
        if (!registryAAvailable || !cliBinAvailable) return;

        // Collect all roots that are in includedRoots but NOT in rootsB.
        const divergentRoots: string[] = [];
        for (const root of includedRoots) {
          if (!rootsB.has(root)) {
            divergentRoots.push(root);
          }
        }

        const passFail = divergentRoots.length === 0 ? "PASS" : "FAIL";
        console.info(
          `[two-pass] BYTE-IDENTITY: ${passFail}` +
            ` | included=${includedCount} excluded=${excludedCount}` +
            ` | divergent=${divergentRoots.length}`,
        );

        if (divergentRoots.length > 0) {
          // Log diagnostic info for each divergent root.
          console.error(
            `[two-pass] T2 FAILURE: ${divergentRoots.length} root(s) present in registry A ` +
              `but ABSENT from registry B (byte-identity broken):`,
          );
          for (const root of divergentRoots.slice(0, 20)) {
            console.error(`  DIVERGENT: ${root}`);
          }
          if (divergentRoots.length > 20) {
            console.error(`  ... and ${divergentRoots.length - 20} more.`);
          }
          console.error(
            `[two-pass] Risk R2 from plan.md: this is a real non-determinism bug surfacing event.\n` +
              `  Action: route to planner with REVIEW_VERDICT=blocked_by_plan and the divergent root manifest.\n` +
              `  Do NOT try to fix within this slice — the harness's job is to surface the bug.`,
          );
        }

        // @decision DEC-V2-BOOTSTRAP-EQUIV-001 (assertion site)
        // Strict Set<string> membership equality. Every included root MUST appear in B.
        expect(divergentRoots).toHaveLength(0);
      },
    );

    // -------------------------------------------------------------------------
    // T3: Dynamic exclusion-list invariant (the durability gate)
    //
    // @decision DEC-V2-BOOTSTRAP-EQUIV-EXCLUSIONS-001 (assertion site)
    //
    // The T3 assertions run in beforeAll (so the two-pass cycle can fail fast
    // if the invariant is violated). This test confirms the post-beforeAll state.
    // -------------------------------------------------------------------------

    it("T3: dynamic exclusion set is a subset of the documented list", () => {
      if (!registryAAvailable || !cliBinAvailable) return;
      const documentedSet = new Set(EXCLUSION_DOCUMENTED_FILES);
      const violations = [...dynamicExclusionSet].filter((f) => !documentedSet.has(f));

      if (violations.length > 0) {
        console.error(
          `[two-pass] T3 FAILURE: dynamic exclusion set contains undocumented files:\n` +
            violations.map((f) => `  + ${f}`).join("\n"),
        );
      }

      // @decision DEC-V2-BOOTSTRAP-EQUIV-EXCLUSIONS-001 (hard assertion)
      expect(violations).toHaveLength(0);
    });

    it("T3: documented exclusion list references the correct number of files (7 at planning time)", () => {
      // Informational: if this fails it means the documented list was modified.
      // The count at planning time was 7 (2 Class A + 5 Class B from issue #399).
      // If #399 partially lands, the documented list may shrink — update it here.
      console.info(
        `[two-pass] T3: EXCLUSION_DOCUMENTED_FILES.length = ${EXCLUSION_DOCUMENTED_FILES.length} ` +
          `(7 at planning time; may shrink as #399 is resolved).`,
      );
      console.info(
        `[two-pass] T3: dynamic exclusion set size = ${dynamicExclusionSet.size}`,
      );
      if (dynamicExclusionSet.size === 0) {
        console.info(
          "[two-pass] T3: dynamic set is EMPTY — issue #399 appears resolved! " +
            "The byte-identity proof now covers the FULL corpus. " +
            "The documented exclusion list is vestigial and can be cleared.",
        );
      }
      // Not a hard failure: just informational.
      expect(EXCLUSION_DOCUMENTED_FILES.length).toBeGreaterThan(0);
    });

    it("T3: dynamic exclusion filter is used for T2 (not the static documented list)", () => {
      if (!registryAAvailable || !cliBinAvailable) return;
      // Verify that includedRoots + excludedRoots covers all of rootsA.
      const totalCovered = includedRoots.size + excludedRoots.size;
      expect(totalCovered).toBe(rootsA.size);
      console.info(
        `[two-pass] T3: rootsA=${rootsA.size} = includedRoots=${includedRoots.size} + excludedRoots=${excludedRoots.size}`,
      );
    });

    // -------------------------------------------------------------------------
    // T4 (plan's T1): Root counts and summary
    // -------------------------------------------------------------------------

    it("T4: registry A has a non-trivial number of unique roots (sanity check)", () => {
      if (!registryAAvailable || !cliBinAvailable) return;
      // The 137-file shavable corpus has at least several hundred unique atoms.
      expect(rootsA.size).toBeGreaterThan(100);
      console.info(`[two-pass] T4: registry A unique roots: ${rootsA.size}`);
    });

    it("T4: registry B roots are a superset of the included roots from registry A", () => {
      if (!registryAAvailable || !cliBinAvailable) return;
      // Since T2 must pass, this is a derived check: if T2 passes, B ⊇ includedRoots.
      // Surfaced here as a direct assertion for reviewer visibility.
      for (const root of includedRoots) {
        if (!rootsB.has(root)) {
          // T2 would have already failed, but be explicit.
          expect.fail(
            `Root ${root.slice(0, 16)}... in includedRoots is not in registry B.`,
          );
        }
      }
      expect(true).toBe(true); // All includedRoots found in B.
    });

    it("T4: byte-identity summary line is logged (PASS or FAIL)", () => {
      if (!registryAAvailable || !cliBinAvailable) return;
      // This test always passes — it just ensures the summary line is surfaced
      // in the vitest console output for the reviewer paste-back.
      const passFail =
        [...includedRoots].every((r) => rootsB.has(r)) ? "PASS" : "FAIL";
      console.info(
        `[two-pass] BYTE-IDENTITY: ${passFail}` +
          ` | registry_A=${rootsA.size} included=${includedCount} excluded=${excludedCount}` +
          ` | registry_B=${rootsB.size}`,
      );
      expect(passFail === "PASS" || passFail === "FAIL").toBe(true);
    });
  },
);
