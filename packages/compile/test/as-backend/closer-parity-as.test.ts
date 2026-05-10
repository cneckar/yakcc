// SPDX-License-Identifier: MIT
//
// closer-parity-as.test.ts — AS-backend sibling closer-parity test
//
// @decision DEC-AS-CLOSER-PARITY-SIBLING-FILE-001
// Title: Phase 2 introduces a NEW sibling closer-parity test that drives
//        assemblyScriptBackend() against the same regenerateCorpus() loader.
//        The wave-3 closer-parity.test.ts is NOT modified (Phase 3 retirement target).
// Status: decided (WI-AS-PHASE-2A-MULTI-EXPORT-AND-RECORDS, 2026-05-10)
// Rationale:
//   The wave-3 file gates on wasmBackend() and is Phase 3's retirement target.
//   Editing it now creates churn that Phase 3 deletes. The sibling lives under
//   packages/compile/test/as-backend/ (Phase 2 authority surface) so ownership
//   is mechanically clear. Phase 3 retirement deletes both the wave-3 file and
//   wasmBackend() together; the sibling becomes the sole closer-parity test.
//
// @decision DEC-AS-MULTI-EXPORT-001
// Title: The AS-backend accepts multi-export modules natively. For atoms whose
//        implSource contains ≥1 `export function`, asc produces callable WASM.
//        The 86 wave-3 "missing-export" atoms compile cleanly under asc.
//
// Production sequence exercised:
//   regenerateCorpus()                          [corpus loader: shave() over packages/src]
//   -> beforeAll: for each atom in corpus:
//      makeSingleBlockResolution(implSource)    [synthetic ResolutionResult]
//      -> assemblyScriptBackend().emit()        [WASM bytes or AS compile error]
//      -> WebAssembly.validate(bytes)           [foundation invariant]
//      -> count export symbols                  [coverage: ≥1 export = covered]
//      -> record covered or pending with AS category
//   -> assert coverage ≥ 30% (first-slice minimum)
//   -> it.fails(coverage >= 80%)               [forcing function — DO NOT lower threshold]
//   -> persist pending-atoms-as.json
//   -> write coverage report to tmp/wi-146-evidence/coverage-report.txt
//
// Coverage categories for pending atoms (AS-specific, different from wave-3):
//   as-compile-error: asc threw (syntax error, type error, unsupported construct)
//   as-no-exports: asc compiled but resulting WASM has zero exports
//   as-other: catch-all (requires DEC before adding new categories)
//
// DO NOT lower the 0.80 threshold (DEC-CLOSER-CONSUMER-FIX-001).
// DO NOT filter the corpus (DEC-V1-WAVE-3-WASM-DEMO-CORPUS-LOADER-001).
// DO NOT use it.skip() or it.todo() to bypass the acceptance assertion.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import type { ResolutionResult, ResolvedBlock } from "@yakcc/compile";
import {
  type BlockMerkleRoot,
  type LocalTriplet,
  type SpecYak,
  blockMerkleRoot,
  specHash,
} from "@yakcc/contracts";
import {
  loadPendingAtoms,
  regenerateCorpus,
  writePendingAtoms,
} from "../../../../examples/v1-wave-3-wasm-lower-demo/test/corpus-loader.js";
import { assemblyScriptBackend } from "../../src/as-backend.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const _dir = dirname(fileURLToPath(import.meta.url));
// Sibling pending-atoms-as.json lives alongside wave-3's pending-atoms.json.
// @decision DEC-AS-CLOSER-PARITY-SIBLING-FILE-001
const PENDING_AS_PATH = join(
  _dir,
  "../../../../examples/v1-wave-3-wasm-lower-demo/test/pending-atoms-as.json",
);

const EVIDENCE_DIR = join(_dir, "../../../../tmp/wi-146-evidence");
const COVERAGE_REPORT_PATH = join(EVIDENCE_DIR, "coverage-report.txt");

// ---------------------------------------------------------------------------
// AS-specific pending atom schema
//
// @decision DEC-AS-CLOSER-PARITY-SIBLING-FILE-001
// @decision DEC-AS-MULTI-EXPORT-001
// ---------------------------------------------------------------------------

interface AsPendingAtom {
  readonly canonicalAstHash: string;
  readonly sourcePath: string | null;
  readonly reason: string; // >= 10 chars (Sacred Practice #5)
  readonly category: "as-compile-error" | "as-no-exports" | "as-other";
}

// ---------------------------------------------------------------------------
// Fixture helpers (mirror wave-3 closer-parity.test.ts pattern)
// ---------------------------------------------------------------------------

function makeSpecYak(name: string, behavior: string): SpecYak {
  return {
    name,
    inputs: [{ name: "a", type: "number" }],
    outputs: [{ name: "result", type: "number" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior,
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe" },
    propertyTests: [],
  };
}

const MINIMAL_MANIFEST_JSON = JSON.stringify({
  artifacts: [{ kind: "property_tests", path: "tests.fast-check.ts" }],
});

function makeMerkleRoot(name: string, behavior: string, implSource: string): BlockMerkleRoot {
  const spec = makeSpecYak(name, behavior);
  const manifest = JSON.parse(MINIMAL_MANIFEST_JSON) as {
    artifacts: Array<{ kind: string; path: string }>;
  };
  const artifactBytes = new TextEncoder().encode(implSource);
  const artifactsMap = new Map<string, Uint8Array>();
  for (const art of manifest.artifacts) {
    artifactsMap.set(art.path, artifactBytes);
  }
  return blockMerkleRoot({
    spec,
    implSource,
    manifest: manifest as LocalTriplet["manifest"],
    artifacts: artifactsMap,
  });
}

function makeResolution(
  blocks: ReadonlyArray<{ id: BlockMerkleRoot; source: string }>,
): ResolutionResult {
  const blockMap = new Map<BlockMerkleRoot, ResolvedBlock>();
  const order: BlockMerkleRoot[] = [];
  for (const { id, source } of blocks) {
    const sh = specHash(makeSpecYak(id.slice(0, 8), `behavior-${id.slice(0, 8)}`));
    blockMap.set(id, { merkleRoot: id, specHash: sh, source, subBlocks: [] });
    order.push(id);
  }
  const entry = order[order.length - 1] as BlockMerkleRoot;
  return { entry, blocks: blockMap, order };
}

/**
 * Build a synthetic ResolutionResult for a single atom's implSource.
 * Mirrors the same helper in wave-3's closer-parity.test.ts for parity.
 */
function makeSingleBlockResolution(fnSource: string): ResolutionResult {
  const fnName = fnSource.match(/export\s+function\s+(\w+)/)?.[1] ?? "fn";
  const id = makeMerkleRoot(fnName, `${fnName} substrate`, fnSource);
  return makeResolution([{ id, source: fnSource }]);
}

// ---------------------------------------------------------------------------
// Corpus state (loaded once in beforeAll)
// ---------------------------------------------------------------------------

interface AtomState {
  readonly hash: string;
  readonly source: string;
  readonly sourcePath: string;
}

const allAtomStates: AtomState[] = [];
const coveredHashes: Set<string> = new Set();
const pendingHashes: Set<string> = new Set();
const runtimePending: AsPendingAtom[] = [];

// Track validated WASM bytes for the foundation-invariant sweep
interface ValidatedAtom {
  readonly hash: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}
const validatedAtoms: ValidatedAtom[] = [];

// ---------------------------------------------------------------------------
// beforeAll: regenerate corpus, run AS emit pass
//
// Budget: 30 minutes (same as wave-3 closer-parity.test.ts).
// ---------------------------------------------------------------------------

beforeAll(
  async () => {
    // Step 1: regenerate corpus from current source via shave() + shared registry.
    // This is the canonical denominator per DEC-V1-WAVE-3-WASM-DEMO-CORPUS-LOADER-001.
    // DO NOT substitute a curated subset — the corpus is the real production atom surface.
    const corpus = await regenerateCorpus();

    console.log(
      `\n[corpus-as] Regenerated ${corpus.size} unique atoms from ${corpus.filesWalked} files${corpus.shaveFailures > 0 ? ` (${corpus.shaveFailures} shave failures)` : ""}`,
    );

    // Load pre-seeded AS pending atoms (from prior runs of this test).
    // These are separate from wave-3's pending-atoms.json (sibling file).
    // @decision DEC-AS-CLOSER-PARITY-SIBLING-FILE-001
    const preSeededPending = (() => {
      try {
        return loadPendingAtoms(PENDING_AS_PATH) as unknown as AsPendingAtom[];
      } catch {
        return [] as AsPendingAtom[];
      }
    })();
    const preSeededPendingSet = new Set(preSeededPending.map((p) => p.canonicalAstHash));

    // Build atom state for all corpus atoms.
    for (const [hash, atom] of corpus.atoms) {
      allAtomStates.push({
        hash,
        source: atom.implSource,
        sourcePath: atom.sourcePath,
      });
    }

    // Step 2: AS emit pass — attempt assemblyScriptBackend().emit() for each atom.
    // @decision DEC-AS-MULTI-EXPORT-001 — asc handles multi-export natively.
    // An atom is "covered" when asc compiles it AND the resulting WASM has ≥1 export.
    // An atom is "pending" when asc throws OR WASM has zero exports.
    //
    // Note: the 86 wave-3 "missing-export" atoms compile cleanly here because asc
    // does NOT require a single exported entry point. However, atoms whose source
    // is a code snippet (not a full function) or uses unsupported TS constructs will
    // fail with as-compile-error and go to pending. This is the expected first-slice
    // outcome — the pending list categorizes them for future Phase 2B-2I work.
    const backend = assemblyScriptBackend();

    for (const state of allAtomStates) {
      // Respect pre-seeded pending registry (from prior runs).
      if (preSeededPendingSet.has(state.hash)) {
        pendingHashes.add(state.hash);
        continue;
      }

      try {
        const resolution = makeSingleBlockResolution(state.source);
        const bytes = (await backend.emit(resolution)) as Uint8Array<ArrayBuffer>;

        // Count exports in the WASM module.
        // @decision DEC-AS-MULTI-EXPORT-001: ≥1 export = covered (structural coverage).
        // The wave-3 closer treats this the same for P-OTHER atoms.
        const exportCount = countWasmExports(bytes);

        if (exportCount >= 1) {
          // Covered: WASM validates and has at least one callable export.
          validatedAtoms.push({ hash: state.hash, bytes });
          coveredHashes.add(state.hash);
        } else {
          // Compiled but zero exports — counts as pending.
          // This can happen when source has only unexported helper functions.
          runtimePending.push({
            canonicalAstHash: state.hash,
            sourcePath: state.sourcePath,
            reason:
              "asc compiled OK but WASM has zero exports — no callable surface for parity testing",
            category: "as-no-exports",
          });
          pendingHashes.add(state.hash);
        }
      } catch (err: unknown) {
        // asc compile error — categorize and record.
        const errMsg = err instanceof Error ? err.message : String(err);
        // Truncate to first 200 chars for readability in pending registry.
        const shortReason = errMsg.slice(0, 200).replace(/\n/g, " ").trim();
        runtimePending.push({
          canonicalAstHash: state.hash,
          sourcePath: state.sourcePath,
          // reason must be ≥ 10 chars (Sacred Practice #5)
          reason: `asc compile error: ${shortReason}`.slice(0, 300),
          category: "as-compile-error",
        });
        pendingHashes.add(state.hash);
      }
    }

    // Step 3: Write updated pending-atoms-as.json (merge pre-seeded + runtime discovered).
    // Sacred Practice #5: every uncovered atom MUST appear with a category and reason.
    const mergedPending: AsPendingAtom[] = [...preSeededPending];
    const existingHashes = new Set(preSeededPending.map((p) => p.canonicalAstHash));
    for (const p of runtimePending) {
      if (!existingHashes.has(p.canonicalAstHash)) {
        mergedPending.push(p);
      }
    }
    try {
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      writePendingAtoms(PENDING_AS_PATH, mergedPending as Parameters<typeof writePendingAtoms>[1]);
    } catch (err) {
      console.warn(`[closer-parity-as] Failed to write pending-atoms-as.json: ${String(err)}`);
    }
  },
  3_600_000, // 60-minute budget (asc shelling out per-atom is slower than in-house wave-3 lowerer)
);

// ---------------------------------------------------------------------------
// WebAssembly export counter
//
// Reads the WASM binary's export section to count how many exports exist.
// Uses a minimal hand-rolled WASM section parser (no external dependencies).
// Only needs to read the export section header count — not full symbol names.
// ---------------------------------------------------------------------------

/**
 * Count the number of exports in a WASM binary by parsing the export section.
 * Returns 0 if the binary is invalid, has no export section, or parsing fails.
 *
 * WASM binary format (§ 5.5.12 Export Section):
 *   section_id = 7 (0x07)
 *   section_size: u32 (LEB128)
 *   num_exports: u32 (LEB128)
 *   exports: [{ name_len: u32, name: bytes, desc_type: u8, desc_idx: u32 }]
 */
function countWasmExports(bytes: Uint8Array): number {
  // WASM magic + version: 8 bytes header
  if (bytes.length < 8) return 0;
  // Magic: \0asm
  if (bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return 0;

  let pos = 8; // skip magic + version

  while (pos < bytes.length) {
    const sectionId = bytes[pos];
    pos++;

    // Read section size (LEB128 u32)
    let sectionSize = 0;
    let shift = 0;
    while (pos < bytes.length) {
      const byte = bytes[pos] as number;
      pos++;
      sectionSize |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }

    if (sectionId === 7) {
      // Export section found — read num_exports (LEB128 u32)
      let numExports = 0;
      let exportShift = 0;
      let exportPos = pos;
      while (exportPos < bytes.length) {
        const byte = bytes[exportPos] as number;
        exportPos++;
        numExports |= (byte & 0x7f) << exportShift;
        if ((byte & 0x80) === 0) break;
        exportShift += 7;
      }
      return numExports;
    }

    // Skip this section and continue
    pos += sectionSize;
  }

  return 0; // no export section found
}

// ---------------------------------------------------------------------------
// Foundation invariant: WebAssembly.validate() on all bytes-producing atoms
// ---------------------------------------------------------------------------

describe("AS backend closer-parity — WebAssembly.validate foundation invariant", () => {
  it("100% of bytes-producing atoms pass WebAssembly.validate()", () => {
    expect(allAtomStates.length, "corpus must be non-empty").toBeGreaterThan(0);

    for (const { hash, bytes } of validatedAtoms) {
      expect(WebAssembly.validate(bytes), `validate() failed for atom ${hash.slice(0, 16)}`).toBe(
        true,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Partition completeness
// ---------------------------------------------------------------------------

describe("AS backend closer-parity — partition completeness", () => {
  it("partition: {covered} union {pending} == {full regenerated-corpus set}", () => {
    const allHashSet = new Set(allAtomStates.map((s) => s.hash));

    for (const hash of allHashSet) {
      const inCovered = coveredHashes.has(hash);
      const inPending = pendingHashes.has(hash);
      expect(
        inCovered || inPending,
        `Atom ${hash.slice(0, 16)} is in neither covered nor pending — partition incomplete`,
      ).toBe(true);
      expect(
        inCovered && inPending,
        `Atom ${hash.slice(0, 16)} is in BOTH covered and pending — invariant violated`,
      ).toBe(false);
    }

    expect(coveredHashes.size + pendingHashes.size).toBe(allHashSet.size);
  });
});

// ---------------------------------------------------------------------------
// Coverage gate + report
// ---------------------------------------------------------------------------

describe("AS backend closer-parity — coverage gate", () => {
  it("coverage report: print numerator/denominator/ratio (informational)", () => {
    const total = allAtomStates.length;
    const covered = coveredHashes.size;
    const pending = pendingHashes.size;
    const ratio = total > 0 ? covered / total : 0;

    // Pending breakdown by AS category
    const byCategory = new Map<string, number>();
    for (const p of runtimePending) {
      byCategory.set(p.category, (byCategory.get(p.category) ?? 0) + 1);
    }
    const categoryBreakdown = [...byCategory.entries()].map(([cat, n]) => `${cat}:${n}`).join(", ");

    const report = [
      "\n=== WI-AS-PHASE-2A COVERAGE REPORT ===",
      `Regenerated corpus size:              ${total}`,
      `Covered (WASM emitted + ≥1 export):  ${covered}`,
      `Pending (compile-error or no-export): ${pending}`,
      `Coverage ratio: ${covered}/${total} = ${(ratio * 100).toFixed(1)}%`,
      "Acceptance threshold: 80% (it.fails — first-slice: must reach ≥30%)",
      `Threshold met: ${ratio >= 0.8 ? "YES" : "NO"}`,
      `First-slice minimum met (30%): ${ratio >= 0.3 ? "YES" : "NO"}`,
      `Pending breakdown: ${categoryBreakdown || "none"}`,
      "==========================================\n",
    ].join("\n");

    console.log(report);

    // Persist coverage report for reviewer verification
    try {
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      appendFileSync(COVERAGE_REPORT_PATH, report, "utf8");
    } catch {
      // Best-effort
    }

    expect(total).toBeGreaterThan(0);
    expect(covered + pending).toBe(total);
  });

  // First-slice minimum: coverage MUST be ≥ 30%.
  // This verifies the multi-export unblocker is working as intended.
  // If this assertion fails, the slice cannot proceed — per PLAN.md risk register:
  // "if ratio < 30%, investigate before declaring ready_for_guardian".
  it("first-slice minimum: coverage >= 30% (DEC-AS-MULTI-EXPORT-001 validation)", () => {
    const total = allAtomStates.length;
    const covered = coveredHashes.size;
    const ratio = total > 0 ? covered / total : 0;

    expect(
      ratio,
      `AS-backend coverage ${(ratio * 100).toFixed(1)}% < 30% first-slice minimum. Covered: ${covered}/${total}. The multi-export unblocker (DEC-AS-MULTI-EXPORT-001) did not reach the expected threshold. Investigate pending-atoms-as.json for per-atom categorized failure reasons. Per PLAN.md risk register: STOP and report BLOCKED_BY_PLAN if ratio < 30%.`,
    ).toBeGreaterThanOrEqual(0.3);
  });

  // 80% acceptance gate (DEC-CLOSER-CONSUMER-FIX-001):
  // This assertion is EXPECTED TO FAIL until Phase 2B–2I sub-slices grow the
  // AS-backend surface enough that coverage crosses 80%.
  // When it starts passing, vitest surfaces "expected to fail but passed" —
  // that is the signal to flip back to it() and close the Phase 2 milestone.
  // DO NOT lower the 0.80 threshold. DO NOT use it.skip().
  it.fails("coverage >= 80% of regenerated-corpus atoms (Phase 2 acceptance gate)", () => {
    const total = allAtomStates.length;
    const covered = coveredHashes.size;
    const ratio = total > 0 ? covered / total : 0;

    expect(
      ratio,
      `AS-backend coverage ${(ratio * 100).toFixed(1)}% < 80%. Covered: ${covered}/${total} regenerated-corpus atoms. See pending-atoms-as.json for per-atom categorized failure reasons. The 80% gate flips when Phase 2B–2I sub-slices land sufficient feature coverage. See DEC-CLOSER-CONSUMER-FIX-001: do NOT lower this threshold.`,
    ).toBeGreaterThanOrEqual(0.8);
  });
});
