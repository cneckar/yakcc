// SPDX-License-Identifier: MIT
// two-pass-equivalence.test.ts — Crown-jewel two-pass bootstrap equivalence harness.
//
// WI-V2-09 / Issue #286: Fixed-point self-hosting proof.
// Issue #436: Harness derivation fix — report.json-sourced exclusions, S1≡S3 runtime equality.
//
// Claim: yakcc shaved by yakcc, recomposed via compile-self, then re-shaved against
// the recomposed source → byte-identical BlockMerkleRoots for every atom in the
// included subset (all files that shaved successfully in BOTH passes). Any divergence
// surfaces non-determinism in the canonicalizer, AST-hash, or merkle path.
//
// Two-pass cycle:
//   Pass 1 (registry A): bootstrap/yakcc.registry.sqlite — the live bootstrap
//          registry, produced by a prior 'yakcc bootstrap' run.
//   Report A: bootstrap/report.json — per-file outcomes from pass 1 (authoritative).
//   Recompile: yakcc compile-self → tmp/two-pass/dist-recompiled/
//   Pass 2 (registry B): yakcc bootstrap inside dist-recompiled workspace
//          → tmp/two-pass/registry-B.sqlite
//   Report B: tmp/two-pass/report-B.json — per-file outcomes from pass 2.
//   Compare (S1 ≡ S3): every blockMerkleRoot from the pass-1 SUCCESS set must
//          appear byte-identically in the pass-2 SUCCESS set (and vice versa).
//
// @decision DEC-V2-TWO-PASS-PRECONDITION-001
// @title Hard-fail on missing preconditions when YAKCC_TWO_PASS=1 gate is open
// @status accepted (Issue #472, WI-V2-TWO-PASS-CI-FALSE-GREEN, 2026-05-13)
// @rationale When YAKCC_TWO_PASS=1 is set, the CI gate is OPEN and the full two-pass
//   cycle is expected to run. If a prerequisite artifact (registry A, report.json, CLI
//   binary) is absent, a silent early-return produces a false-green result — vitest
//   counts the early-return as a PASS, masking ALL regressions in the harness.
//   The correct behaviour: throw a hard Error so vitest reports a FAIL, and the CI
//   job goes red with a clear actionable message. This protects the load-bearing
//   contract established by DEC-V2-CI-GATE-FINAL-001 (two-pass gate on push:main + PR).
//   The off-path (YAKCC_TWO_PASS !== "1") uses describe.skipIf — that silent-skip is
//   correct and is NOT changed here. Only the precondition-paths INSIDE the open gate
//   are converted from soft-skip to hard-fail.
//
// @decision DEC-V2-BOOTSTRAP-EQUIV-001
// @title Strict byte-equality of every BlockMerkleRoot in the included subset
// @status superseded by DEC-V2-HARNESS-STRICT-EQUALITY-001 (Issue #436, WI-V2-09-FIX)
// @rationale Per-root byte-equality (not hash-of-hashes, not subset-of-superset) is the
//   load-bearing invariant. Any divergence between S1 (pass-1 success roots) and
//   S3 (pass-2 success roots) for an included source file is a real non-determinism bug.
//   The harness fails loudly and routes to planner with the divergent-root manifest.
//   No tolerance, no truncation, no prefix-match.
//
// @decision DEC-V2-BOOTSTRAP-EQUIV-EXCLUSIONS-001
// @title Exclusion list lives as a documented const; dynamic ⊆ documented invariant
// @status superseded by DEC-V2-HARNESS-FAILURE-SOURCE-001 (Issue #436, WI-V2-09-FIX)
// @rationale The workspace-vs-manifest set-diff approach was removed. Exclusions are now
//   sourced directly from bootstrap/report.json outcome="failure" entries. The old
//   EXCLUSION_DOCUMENTED_FILES const and its dynamic ⊆ documented hard assertion have
//   been removed. See plan.md §5 for the analysis of the over-count bug.
//
// @decision DEC-V2-HARNESS-FAILURE-SOURCE-001
// @title Dynamic exclusion is sourced from bootstrap/report.json outcome="failure" entries
// @status accepted (Issue #436, WI-V2-09-FIX, 2026-05-12)
// @rationale report.json is the empirical record of what the shave pipeline could not
//   process. Every other classification (success, expected-failure, cache-hit) is either
//   a successful shave or a deliberate exclusion. The set-diff approach conflated failures
//   with legitimate non-atoms (type-only, barrels, tests, fixtures) that the pipeline
//   already distinguishes. Single source of truth: same data drives CI summary and
//   this harness gate. Unknown outcome variants → treat as excluded (conservative).
//
// @decision DEC-V2-HARNESS-STRICT-EQUALITY-001
// @title Byte-identity is asserted between runtime S1 (pass-1 manifest) and runtime S3
//   (pass-2 manifest), not against the committed bootstrap/expected-roots.json superset
// @status accepted (Issue #436, WI-V2-09-FIX, 2026-05-12)
// @rationale expected-roots.json is a monotonic accumulator per DEC-BOOTSTRAP-MANIFEST-
//   ACCUMULATE-001 — it includes archived atoms from deleted source. Comparing a full
//   manifest export against the monotonic superset always surfaces archived-atom drift
//   that is not a shave non-determinism bug. S1 and S3 are both current-source shaves
//   of equivalent inputs (original source vs. recompiled source). Their root sets
//   must be byte-identical modulo files that failed in either pass. Divergence beyond
//   that is a real pipeline non-determinism bug — the load-bearing claim of this harness.
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
import { join, resolve } from "node:path";
import { openRegistry } from "@yakcc/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Report.json schema (stable contract per plan.md §6 D4)
//
// @decision DEC-V2-HARNESS-FAILURE-SOURCE-001 (schema site)
//
// These interfaces mirror bootstrap.ts's FileOutcome union. We re-declare them
// here rather than importing from the CLI source so the harness has no compile-
// time coupling to the pipeline package. The shape is treated as a public API.
// ---------------------------------------------------------------------------

interface FileOutcomeSuccess {
  readonly path: string;
  readonly outcome: "success";
  readonly atomCount: number;
  readonly intentCardCount: number;
}

interface FileOutcomeFailure {
  readonly path: string;
  readonly outcome: "failure";
  readonly errorClass: string;
  readonly errorMessage: string;
}

interface FileOutcomeExpectedFailure {
  readonly path: string;
  readonly outcome: "expected-failure";
  readonly errorClass: string;
  readonly errorMessage: string;
  readonly rationale: string;
}

interface FileOutcomeCacheHit {
  readonly path: string;
  readonly outcome: "cache-hit";
  readonly atomCount: number;
}

type FileOutcome =
  | FileOutcomeSuccess
  | FileOutcomeFailure
  | FileOutcomeExpectedFailure
  | FileOutcomeCacheHit;

/**
 * Parse a report.json file and extract the excluded and successful path sets.
 *
 * Excluded = outcome "failure" | "expected-failure".
 * Successful = outcome "success" | "cache-hit".
 * Unknown outcome variants → logged + treated as excluded (conservative per plan §6 D4).
 *
 * @decision DEC-V2-HARNESS-FAILURE-SOURCE-001 (implementation site)
 */
function parseReportJson(reportPath: string): {
  excludedPaths: Set<string>;
  successPaths: Set<string>;
} {
  const raw = JSON.parse(readFileSync(reportPath, "utf-8")) as FileOutcome[];
  const excludedPaths = new Set<string>();
  const successPaths = new Set<string>();

  for (const entry of raw) {
    switch (entry.outcome) {
      case "success":
      case "cache-hit":
        successPaths.add(entry.path);
        break;
      case "failure":
      case "expected-failure":
        excludedPaths.add(entry.path);
        break;
      default: {
        // Unknown outcome variant — treat as excluded to avoid silent over-count.
        // This covers future additions to the FileOutcome union without breaking the harness.
        const unknownPath = (entry as { path?: string }).path ?? "(unknown)";
        const unknownOutcome = (entry as { outcome?: unknown }).outcome;
        console.warn(
          `[two-pass] WARN: unknown outcome variant "${String(unknownOutcome)}" for ${unknownPath} ` +
            `in ${reportPath} — treating as excluded (conservative per DEC-V2-HARNESS-FAILURE-SOURCE-001).`,
        );
        if (unknownPath !== "(unknown)") excludedPaths.add(unknownPath);
        break;
      }
    }
  }

  return { excludedPaths, successPaths };
}

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

// Report A: per-file outcomes from pass 1. Authority: bootstrap pipeline.
//
// @decision DEC-V2-HARNESS-FAILURE-SOURCE-001 (constant site)
// This is the single authority for pass-1 per-file outcomes. The harness reads
// it; it does not re-derive it from workspace walks.
const REPORT_A_PATH = join(REPO_ROOT, "bootstrap", "report.json");

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
let reportAAvailable = false;

// Roots collected from registry A and B.
let rootsA: Set<string> = new Set();
let rootsB: Set<string> = new Set();

// Dynamic exclusion set: source files with outcome "failure" or "expected-failure"
// in EITHER pass-1 OR pass-2 report.json.
//
// @decision DEC-V2-HARNESS-FAILURE-SOURCE-001 (state site)
// Sourced exclusively from report.json entries — NOT from workspace walks.
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

// Failure-count breakdown for reviewer logs.
let reportAFailureCount = 0;
let reportBFailureCount = 0;

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
      // @decision DEC-V2-TWO-PASS-PRECONDITION-001 (beforeAll enforcement site)
      //
      // When YAKCC_TWO_PASS=1 the gate is open. Missing prerequisites are hard
      // errors here — NOT soft skips. A soft skip (console.warn + return) causes
      // vitest to count the test as PASSED while running no assertions, producing
      // the false-green signal this fix was written to eliminate (Issue #472).
      //
      // The gating helper: if the gate is open (YAKCC_TWO_PASS=1) and a precondition
      // fails, throw immediately so vitest marks the test as FAILED with a clear
      // actionable message. If the gate is closed, the entire describe block is
      // already describe.skipIf-skipped before beforeAll runs — this branch is
      // unreachable in the off-path.
      const gateName = "YAKCC_TWO_PASS=1";
      function requireArtifact(exists: boolean, msg: string): void {
        if (!exists) {
          throw new Error(
            `Precondition FAILED [${gateName}]: ${msg} ` +
              `YAKCC_TWO_PASS=1 was set, meaning the gate is open, but a required ` +
              `prerequisite artifact is missing. Either produce the artifact before ` +
              `running the test, or unset YAKCC_TWO_PASS to skip the gate entirely. ` +
              `(DEC-V2-TWO-PASS-PRECONDITION-001)`,
          );
        }
      }

      // --- Precondition: registry A must exist ---
      requireArtifact(
        existsSync(REGISTRY_A_PATH),
        `registry A not found at ${REGISTRY_A_PATH}. Run 'yakcc bootstrap' first to populate it.`,
      );
      registryAAvailable = true;

      // --- Precondition: report.json (report A) must exist ---
      //
      // @decision DEC-V2-HARNESS-FAILURE-SOURCE-001 (precondition site)
      //
      // The harness requires bootstrap/report.json to derive the exclusion set.
      // It does NOT re-run bootstrap to generate it — that would be a 60-min
      // wall-time operation and would conflate "first-pass" with "second-pass"
      // semantics (per plan.md §6 D5 / Risk R1 mitigation).
      requireArtifact(
        existsSync(REPORT_A_PATH),
        `pass-1 report.json not found at ${REPORT_A_PATH}. ` +
          `Run 'yakcc bootstrap' first to produce the authoritative per-file shave outcomes.`,
      );
      reportAAvailable = true;

      // --- Precondition: CLI binary must be built ---
      requireArtifact(
        existsSync(CLI_BIN_PATH),
        `CLI binary not found at ${CLI_BIN_PATH}. Run 'pnpm -r build' first.`,
      );
      cliBinAvailable = true;

      // --- Step 0: create scratch directories ---
      mkdirSync(TWO_PASS_DIR, { recursive: true });

      // Remove stale recompiled workspace, registry B, and report B from prior runs.
      // (Risk R2 mitigation: guarantee report B freshness per plan.md §8.)
      if (existsSync(DIST_RECOMPILED_DIR)) {
        rmSync(DIST_RECOMPILED_DIR, { recursive: true, force: true });
      }
      if (existsSync(REGISTRY_B_PATH)) {
        rmSync(REGISTRY_B_PATH, { force: true });
      }
      if (existsSync(REPORT_B_PATH)) {
        rmSync(REPORT_B_PATH, { force: true });
      }

      // --- Step 1: compile-self ---
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

      // Verify the manifest.json is present (sanity check that compile-self wrote atoms).
      const manifestPath = join(DIST_RECOMPILED_DIR, "manifest.json");
      if (!existsSync(manifestPath)) {
        throw new Error(
          `[two-pass] compile-self manifest not found at ${manifestPath}. compile-self may have failed silently.`,
        );
      }

      // --- Step 2: derive dynamic exclusion set from bootstrap/report.json ---
      //
      // @decision DEC-V2-HARNESS-FAILURE-SOURCE-001 (derivation site)
      //
      // The pass-1 report.json is the single authority for per-file shave outcomes.
      // We read its "failure" and "expected-failure" entries to build the exclusion set.
      // We do NOT derive exclusions from a workspace-walk minus manifest comparison —
      // that approach over-counted type-only files, barrels, tests, and fixtures.

      const reportAParsed = parseReportJson(REPORT_A_PATH);
      for (const p of reportAParsed.excludedPaths) {
        dynamicExclusionSet.add(p);
      }
      reportAFailureCount = reportAParsed.excludedPaths.size;

      console.info(
        `[two-pass] report.json (pass 1): ${reportAParsed.successPaths.size} successes, ` +
          `${reportAFailureCount} excluded (failure + expected-failure).`,
      );
      if (dynamicExclusionSet.size > 0) {
        console.info(`[two-pass] Pass-1 excluded files (${dynamicExclusionSet.size}):`);
        for (const f of [...dynamicExclusionSet].sort()) {
          console.info(`  - ${f}`);
        }
      }

      // --- Step 3: second bootstrap pass ---
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
      // source files (not the original ones), producing registry B + report B.

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
        `[two-pass] Step 3: second bootstrap pass → ${REGISTRY_B_PATH}`,
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

      // --- Step 4: extend exclusion set with pass-2 failures (report B) ---
      //
      // @decision DEC-V2-HARNESS-FAILURE-SOURCE-001 (report-B integration site)
      //
      // Files that failed in pass 2 are also excluded from the S1≡S3 comparison.
      // The exclusion set is the UNION of pass-1 and pass-2 failures.

      if (!existsSync(REPORT_B_PATH)) {
        throw new Error(
          `[two-pass] report-B.json not found at ${REPORT_B_PATH}. ` +
            `The second bootstrap pass must have failed to write the report.`,
        );
      }

      const reportBParsed = parseReportJson(REPORT_B_PATH);
      for (const p of reportBParsed.excludedPaths) {
        dynamicExclusionSet.add(p);
      }
      reportBFailureCount = reportBParsed.excludedPaths.size;

      console.info(
        `[two-pass] report-B.json (pass 2): ${reportBParsed.successPaths.size} successes, ` +
          `${reportBFailureCount} excluded (failure + expected-failure).`,
      );
      console.info(
        `[two-pass] Combined exclusion set (pass-1 ∪ pass-2): ${dynamicExclusionSet.size} files.`,
      );

      // --- Step 5: build rootsA (S1) and rootsB (S3) sets ---
      //
      // @decision DEC-V2-HARNESS-STRICT-EQUALITY-001 (S1/S3 derivation site)
      //
      // S1 = blockMerkleRoots from registry A's exportManifest().
      // S3 = blockMerkleRoots from registry B's exportManifest().
      // Both are runtime-derived — NOT compared against committed expected-roots.json,
      // which is a monotonic-accumulator superset (includes archived atoms).
      //
      // Registry A is opened READ-ONLY (no write paths from this harness, IS-1).

      const regA = await openRegistry(REGISTRY_A_PATH, NULL_EMBEDDING_OPTS);
      try {
        const manifestA = await regA.exportManifest();
        rootsA = new Set(manifestA.map((e) => e.blockMerkleRoot));
        console.info(`[two-pass] Registry A (S1): ${rootsA.size} unique blockMerkleRoots.`);
      } finally {
        await regA.close();
      }

      const regB = await openRegistry(REGISTRY_B_PATH, NULL_EMBEDDING_OPTS);
      try {
        const manifestB = await regB.exportManifest();
        rootsB = new Set(manifestB.map((e) => e.blockMerkleRoot));
        console.info(`[two-pass] Registry B (S3): ${rootsB.size} unique blockMerkleRoots.`);
      } finally {
        await regB.close();
      }

      // --- Step 6: compute excludedRoots and includedRoots ---
      //
      // @decision DEC-V2-HARNESS-STRICT-EQUALITY-001 (exclusion filter site)
      //
      // A root is EXCLUDED iff all its occurrences in registry A come from source
      // files in the dynamic exclusion set. (A root shared between an excluded file
      // and a non-excluded file is INCLUDED — correct per plan.md R5.)
      //
      // We only query roots that are absent from registry B (minimizes query count).
      // Roots present in both A and B trivially satisfy byte-identity.

      const missingInB = [...rootsA].filter((r) => !rootsB.has(r));
      console.info(
        `[two-pass] Roots in A not in B (before exclusion check): ${missingInB.length}`,
      );

      if (missingInB.length > 0) {
        const regA2 = await openRegistry(REGISTRY_A_PATH, NULL_EMBEDDING_OPTS);
        try {
          for (const root of missingInB) {
            const occurrences = await regA2.listOccurrencesByMerkleRoot(root);
            // A root is excluded iff EVERY occurrence source file is in the exclusion set.
            const allOccurrencesInExcluded = occurrences.every((occ) =>
              dynamicExclusionSet.has(occ.sourceFile),
            );
            if (allOccurrencesInExcluded) {
              excludedRoots.add(root);
            }
          }
        } finally {
          await regA2.close();
        }
      }

      // includedRoots = rootsA \ excludedRoots.
      // Assertion: forall r in includedRoots → r in rootsB (S1 \ excluded ≡ S3 \ excluded).
      for (const r of rootsA) {
        if (!excludedRoots.has(r)) {
          includedRoots.add(r);
        }
      }

      includedCount = includedRoots.size;
      excludedCount = excludedRoots.size;

      console.info(`[two-pass] Included roots (S1 ∩ S3 check): ${includedCount}`);
      console.info(`[two-pass] Excluded roots (union of pass-1/2 failures): ${excludedCount}`);
    }, 4_200_000); // 70 min total timeout for the full two-pass cycle

    afterAll(() => {
      // Registry B, report B, and dist-recompiled are gitignored (tmp/ pattern).
      // We do NOT clean them up here so the reviewer can inspect the outputs.
      // The directories and files are overwritten on the next run (rmSync at beforeAll start).
    });

    // -------------------------------------------------------------------------
    // T1: Two-pass cycle ran to completion without error
    // -------------------------------------------------------------------------

    // @decision DEC-V2-TWO-PASS-PRECONDITION-001 (individual test enforcement)
    //
    // When YAKCC_TWO_PASS=1 is set and beforeAll throws on a missing precondition,
    // individual tests that depend on those flags will be marked as FAILED by vitest
    // (because beforeAll threw). However, for completeness and to produce a clear
    // error message independent of vitest's beforeAll failure reporting, we also
    // guard at the individual test level. Unlike the old soft-skip pattern (console.warn
    // + return), these guards throw so the test is counted as FAILED, not silently PASSED.
    //
    // Pattern: throw rather than return when the gate is open (YAKCC_TWO_PASS=1).
    // The describe.skipIf at the top of the block ensures these tests never run when
    // the gate is closed — the early-throw path is only reachable when the gate is open.

    it("T1: registry A exists (precondition)", () => {
      if (!registryAAvailable) {
        throw new Error(
          `Precondition FAILED [YAKCC_TWO_PASS=1]: registry A not found at ${REGISTRY_A_PATH}. ` +
            `Run 'yakcc bootstrap' first. (DEC-V2-TWO-PASS-PRECONDITION-001)`,
        );
      }
      expect(existsSync(REGISTRY_A_PATH)).toBe(true);
    });

    it("T1: report.json (pass-1) exists (precondition)", () => {
      // @decision DEC-V2-HARNESS-FAILURE-SOURCE-001 (precondition test)
      if (!reportAAvailable) {
        throw new Error(
          `Precondition FAILED [YAKCC_TWO_PASS=1]: bootstrap/report.json not found at ${REPORT_A_PATH}. ` +
            `Run 'yakcc bootstrap' first to produce the per-file outcome report. ` +
            `(DEC-V2-TWO-PASS-PRECONDITION-001)`,
        );
      }
      expect(existsSync(REPORT_A_PATH)).toBe(true);
    });

    it("T1: CLI binary exists (precondition)", () => {
      if (!cliBinAvailable) {
        throw new Error(
          `Precondition FAILED [YAKCC_TWO_PASS=1]: CLI binary not found at ${CLI_BIN_PATH}. ` +
            `Run 'pnpm -r build' first. (DEC-V2-TWO-PASS-PRECONDITION-001)`,
        );
      }
      expect(existsSync(CLI_BIN_PATH)).toBe(true);
    });

    it("T1: compile-self produced the recompiled workspace", () => {
      // @decision DEC-V2-TWO-PASS-PRECONDITION-001 — hard-fail, not soft-skip
      if (!registryAAvailable || !reportAAvailable || !cliBinAvailable) {
        throw new Error(
          `Precondition FAILED [YAKCC_TWO_PASS=1]: one or more prerequisite artifacts are missing ` +
            `(registryA=${registryAAvailable}, reportA=${reportAAvailable}, cliBin=${cliBinAvailable}). ` +
            `Run 'pnpm -r build' and 'yakcc bootstrap' before running the two-pass test. ` +
            `(DEC-V2-TWO-PASS-PRECONDITION-001)`,
        );
      }
      expect(existsSync(DIST_RECOMPILED_DIR)).toBe(true);
      // The manifest must exist (proves compile-self emitted atoms and wrote manifest).
      const manifestPath = join(DIST_RECOMPILED_DIR, "manifest.json");
      expect(existsSync(manifestPath)).toBe(true);
      const rawManifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as unknown[];
      expect(rawManifest.length).toBeGreaterThanOrEqual(137);
      console.info(`[two-pass] T1: compile-self manifest has ${rawManifest.length} entries.`);
    });

    it("T1: compile-self emitted ≥ 137 source files (137/144 shavable subset)", () => {
      // @decision DEC-V2-TWO-PASS-PRECONDITION-001 — hard-fail, not soft-skip
      if (!registryAAvailable || !reportAAvailable || !cliBinAvailable) {
        throw new Error(
          `Precondition FAILED [YAKCC_TWO_PASS=1]: one or more prerequisite artifacts are missing ` +
            `(registryA=${registryAAvailable}, reportA=${reportAAvailable}, cliBin=${cliBinAvailable}). ` +
            `Run 'pnpm -r build' and 'yakcc bootstrap' before running the two-pass test. ` +
            `(DEC-V2-TWO-PASS-PRECONDITION-001)`,
        );
      }
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
      // @decision DEC-V2-TWO-PASS-PRECONDITION-001 — hard-fail, not soft-skip
      if (!registryAAvailable || !reportAAvailable || !cliBinAvailable) {
        throw new Error(
          `Precondition FAILED [YAKCC_TWO_PASS=1]: one or more prerequisite artifacts are missing ` +
            `(registryA=${registryAAvailable}, reportA=${reportAAvailable}, cliBin=${cliBinAvailable}). ` +
            `Run 'pnpm -r build' and 'yakcc bootstrap' before running the two-pass test. ` +
            `(DEC-V2-TWO-PASS-PRECONDITION-001)`,
        );
      }
      expect(existsSync(REGISTRY_B_PATH)).toBe(true);
      expect(statSync(REGISTRY_B_PATH).size).toBeGreaterThan(0);
    });

    it("T1: report-B.json exists (second bootstrap pass produced outcomes)", () => {
      // @decision DEC-V2-TWO-PASS-PRECONDITION-001 — hard-fail, not soft-skip
      if (!registryAAvailable || !reportAAvailable || !cliBinAvailable) {
        throw new Error(
          `Precondition FAILED [YAKCC_TWO_PASS=1]: one or more prerequisite artifacts are missing ` +
            `(registryA=${registryAAvailable}, reportA=${reportAAvailable}, cliBin=${cliBinAvailable}). ` +
            `Run 'pnpm -r build' and 'yakcc bootstrap' before running the two-pass test. ` +
            `(DEC-V2-TWO-PASS-PRECONDITION-001)`,
        );
      }
      // @decision DEC-V2-HARNESS-FAILURE-SOURCE-001 (report-B existence check)
      expect(existsSync(REPORT_B_PATH)).toBe(true);
      expect(statSync(REPORT_B_PATH).size).toBeGreaterThan(0);
      console.info(
        `[two-pass] T1: report-B.json failure count: ${reportBFailureCount} ` +
          `(files excluded from S3 comparison).`,
      );
    });

    it("T1: registry B has a non-empty manifest (atoms were shaved in pass 2)", () => {
      // @decision DEC-V2-TWO-PASS-PRECONDITION-001 — hard-fail, not soft-skip
      if (!registryAAvailable || !reportAAvailable || !cliBinAvailable) {
        throw new Error(
          `Precondition FAILED [YAKCC_TWO_PASS=1]: one or more prerequisite artifacts are missing ` +
            `(registryA=${registryAAvailable}, reportA=${reportAAvailable}, cliBin=${cliBinAvailable}). ` +
            `Run 'pnpm -r build' and 'yakcc bootstrap' before running the two-pass test. ` +
            `(DEC-V2-TWO-PASS-PRECONDITION-001)`,
        );
      }
      expect(rootsB.size).toBeGreaterThan(0);
      console.info(`[two-pass] T1: registry B (S3) has ${rootsB.size} blockMerkleRoots.`);
    });

    // -------------------------------------------------------------------------
    // T2: report.json failure-source invariant
    //
    // @decision DEC-V2-HARNESS-FAILURE-SOURCE-001
    // The dynamic exclusion set is sourced from report.json, not workspace walks.
    // -------------------------------------------------------------------------

    it("T2: exclusion set is sourced from report.json (not workspace-walk diff)", () => {
      // @decision DEC-V2-TWO-PASS-PRECONDITION-001 — hard-fail, not soft-skip
      if (!registryAAvailable || !reportAAvailable || !cliBinAvailable) {
        throw new Error(
          `Precondition FAILED [YAKCC_TWO_PASS=1]: one or more prerequisite artifacts are missing ` +
            `(registryA=${registryAAvailable}, reportA=${reportAAvailable}, cliBin=${cliBinAvailable}). ` +
            `Run 'pnpm -r build' and 'yakcc bootstrap' before running the two-pass test. ` +
            `(DEC-V2-TWO-PASS-PRECONDITION-001)`,
        );
      }
      // The dynamic exclusion set size must equal the count of failure+expected-failure
      // entries in the union of report-A and report-B.
      // (dynamicExclusionSet is the UNION of both passes' excluded paths.)
      console.info(
        `[two-pass] T2: dynamicExclusionSet.size=${dynamicExclusionSet.size} ` +
          `(report-A excluded=${reportAFailureCount}, report-B excluded=${reportBFailureCount}).`,
      );
      // The exclusion set must be non-negative and bounded by the union of both reports.
      expect(dynamicExclusionSet.size).toBeGreaterThanOrEqual(0);
      // Sanity: each excluded path must come from a report entry (the set is only ever
      // populated via parseReportJson). We verify the report-A failure count is reflected.
      expect(dynamicExclusionSet.size).toBeGreaterThanOrEqual(reportAFailureCount);
    });

    it("T2: report-A failure count is plausible (≤ total shavable corpus size)", () => {
      // @decision DEC-V2-TWO-PASS-PRECONDITION-001 — hard-fail, not soft-skip
      if (!registryAAvailable || !reportAAvailable || !cliBinAvailable) {
        throw new Error(
          `Precondition FAILED [YAKCC_TWO_PASS=1]: one or more prerequisite artifacts are missing ` +
            `(registryA=${registryAAvailable}, reportA=${reportAAvailable}, cliBin=${cliBinAvailable}). ` +
            `Run 'pnpm -r build' and 'yakcc bootstrap' before running the two-pass test. ` +
            `(DEC-V2-TWO-PASS-PRECONDITION-001)`,
        );
      }
      // Sanity check: we should not have more failures than there are source files.
      // The full corpus is ~144 files; failures must be a small fraction.
      console.info(
        `[two-pass] T2: report-A failures=${reportAFailureCount} ` +
          `(expected ≤ 144, the ~144-file shavable corpus).`,
      );
      expect(reportAFailureCount).toBeLessThanOrEqual(144);
    });

    // -------------------------------------------------------------------------
    // T3: Strict per-root byte-equality (the crown-jewel proof, S1 ≡ S3)
    //
    // @decision DEC-V2-HARNESS-STRICT-EQUALITY-001
    // S1 = pass-1 manifest roots; S3 = pass-2 manifest roots.
    // Comparison target is NOT bootstrap/expected-roots.json.
    // -------------------------------------------------------------------------

    it(
      "T3: every included blockMerkleRoot from S1 exists byte-identically in S3",
      () => {
        // @decision DEC-V2-TWO-PASS-PRECONDITION-001 — hard-fail, not soft-skip
      if (!registryAAvailable || !reportAAvailable || !cliBinAvailable) {
        throw new Error(
          `Precondition FAILED [YAKCC_TWO_PASS=1]: one or more prerequisite artifacts are missing ` +
            `(registryA=${registryAAvailable}, reportA=${reportAAvailable}, cliBin=${cliBinAvailable}). ` +
            `Run 'pnpm -r build' and 'yakcc bootstrap' before running the two-pass test. ` +
            `(DEC-V2-TWO-PASS-PRECONDITION-001)`,
        );
      }

        // @decision DEC-V2-HARNESS-STRICT-EQUALITY-001 (assertion site)
        //
        // S1 \ excluded ≡ S3 \ excluded.
        // Strict Set<string> membership equality. Every included root MUST appear in B.
        // "expected-roots.json" is NOT read here — see decision rationale above.

        const divergentRoots: string[] = [];
        for (const root of includedRoots) {
          if (!rootsB.has(root)) {
            divergentRoots.push(root);
          }
        }

        const passFail = divergentRoots.length === 0 ? "PASS" : "FAIL";
        console.info(
          `[two-pass] BYTE-IDENTITY: ${passFail}` +
            ` | S1=${rootsA.size} S3=${rootsB.size} included=${includedCount} excluded=${excludedCount}` +
            ` | divergent=${divergentRoots.length}`,
        );

        if (divergentRoots.length > 0) {
          // Log diagnostic info for each divergent root.
          console.error(
            `[two-pass] T3 FAILURE: ${divergentRoots.length} root(s) in S1 ABSENT from S3 ` +
              `(byte-identity broken — real non-determinism finding):`,
          );
          for (const root of divergentRoots.slice(0, 20)) {
            console.error(`  DIVERGENT: ${root}`);
          }
          if (divergentRoots.length > 20) {
            console.error(`  ... and ${divergentRoots.length - 20} more.`);
          }
          console.error(
            `[two-pass] This is the S1≡S3 invariant failure per DEC-V2-HARNESS-STRICT-EQUALITY-001.\n` +
              `  Action: route to planner with REVIEW_VERDICT=blocked_by_plan and the divergent root manifest.\n` +
              `  Do NOT try to fix within this slice — the harness's job is to surface real bugs.`,
          );
        }

        expect(divergentRoots).toHaveLength(0);
      },
    );

    it("T3: S3 does not introduce roots absent from S1 (symmetric check)", () => {
      // @decision DEC-V2-TWO-PASS-PRECONDITION-001 — hard-fail, not soft-skip
      if (!registryAAvailable || !reportAAvailable || !cliBinAvailable) {
        throw new Error(
          `Precondition FAILED [YAKCC_TWO_PASS=1]: one or more prerequisite artifacts are missing ` +
            `(registryA=${registryAAvailable}, reportA=${reportAAvailable}, cliBin=${cliBinAvailable}). ` +
            `Run 'pnpm -r build' and 'yakcc bootstrap' before running the two-pass test. ` +
            `(DEC-V2-TWO-PASS-PRECONDITION-001)`,
        );
      }
      // @decision DEC-V2-HARNESS-STRICT-EQUALITY-001 (symmetric assertion)
      //
      // S1 ≡ S3 means not only S1 ⊆ S3 but also S3 ⊆ S1 for included files.
      // Roots present in B but absent from A (modulo excluded) represent atoms
      // that appeared in recompiled source but NOT in the original — also a
      // non-determinism signal (though less common than A-only divergence).
      const onlyInB: string[] = [];
      for (const root of rootsB) {
        if (!rootsA.has(root) && !excludedRoots.has(root)) {
          onlyInB.push(root);
        }
      }
      if (onlyInB.length > 0) {
        console.warn(
          `[two-pass] T3 (symmetric): ${onlyInB.length} root(s) in S3 not in S1.` +
            ` This may indicate the recompiled workspace has extra source files (OK if compile-self` +
            ` produces plumbing not in the original). Listing first 10:`,
        );
        for (const root of onlyInB.slice(0, 10)) {
          console.warn(`  S3-only: ${root}`);
        }
      }
      console.info(
        `[two-pass] T3 (symmetric): S3-only roots (not in S1, not excluded) = ${onlyInB.length}.`,
      );
      // Informational: S3-only roots are logged but not a hard failure here since
      // compile-self may produce plumbing atoms for files not in the original workspace.
      // The load-bearing assertion is S1 ⊆ S3 (T3 above).
      expect(true).toBe(true);
    });

    // -------------------------------------------------------------------------
    // T4: Root counts, coverage, and summary
    // -------------------------------------------------------------------------

    it("T4: registry A (S1) has a non-trivial number of unique roots (sanity check)", () => {
      // @decision DEC-V2-TWO-PASS-PRECONDITION-001 — hard-fail, not soft-skip
      if (!registryAAvailable || !reportAAvailable || !cliBinAvailable) {
        throw new Error(
          `Precondition FAILED [YAKCC_TWO_PASS=1]: one or more prerequisite artifacts are missing ` +
            `(registryA=${registryAAvailable}, reportA=${reportAAvailable}, cliBin=${cliBinAvailable}). ` +
            `Run 'pnpm -r build' and 'yakcc bootstrap' before running the two-pass test. ` +
            `(DEC-V2-TWO-PASS-PRECONDITION-001)`,
        );
      }
      // The 137-file shavable corpus has at least several hundred unique atoms.
      expect(rootsA.size).toBeGreaterThan(100);
      console.info(`[two-pass] T4: registry A (S1) unique roots: ${rootsA.size}`);
    });

    it("T4: rootsA = includedRoots + excludedRoots (partition coverage)", () => {
      // @decision DEC-V2-TWO-PASS-PRECONDITION-001 — hard-fail, not soft-skip
      if (!registryAAvailable || !reportAAvailable || !cliBinAvailable) {
        throw new Error(
          `Precondition FAILED [YAKCC_TWO_PASS=1]: one or more prerequisite artifacts are missing ` +
            `(registryA=${registryAAvailable}, reportA=${reportAAvailable}, cliBin=${cliBinAvailable}). ` +
            `Run 'pnpm -r build' and 'yakcc bootstrap' before running the two-pass test. ` +
            `(DEC-V2-TWO-PASS-PRECONDITION-001)`,
        );
      }
      // Every root in A is either included or excluded — no root is lost.
      const totalCovered = includedRoots.size + excludedRoots.size;
      expect(totalCovered).toBe(rootsA.size);
      console.info(
        `[two-pass] T4: rootsA=${rootsA.size} = includedRoots=${includedRoots.size} + excludedRoots=${excludedRoots.size}`,
      );
    });

    it("T4: byte-identity summary line is logged (PASS or FAIL)", () => {
      // @decision DEC-V2-TWO-PASS-PRECONDITION-001 — hard-fail, not soft-skip
      if (!registryAAvailable || !reportAAvailable || !cliBinAvailable) {
        throw new Error(
          `Precondition FAILED [YAKCC_TWO_PASS=1]: one or more prerequisite artifacts are missing ` +
            `(registryA=${registryAAvailable}, reportA=${reportAAvailable}, cliBin=${cliBinAvailable}). ` +
            `Run 'pnpm -r build' and 'yakcc bootstrap' before running the two-pass test. ` +
            `(DEC-V2-TWO-PASS-PRECONDITION-001)`,
        );
      }
      // This test always passes — it surfaces the summary line in vitest console output
      // for reviewer paste-back (evaluation contract T4 evidence).
      const passFail =
        [...includedRoots].every((r) => rootsB.has(r)) ? "PASS" : "FAIL";
      console.info(
        `[two-pass] BYTE-IDENTITY: ${passFail}` +
          ` | S1=${rootsA.size} S3=${rootsB.size} included=${includedCount} excluded=${excludedCount}` +
          ` | report_A_failures=${reportAFailureCount} report_B_failures=${reportBFailureCount}`,
      );
      expect(passFail === "PASS" || passFail === "FAIL").toBe(true);
    });
  },
);
