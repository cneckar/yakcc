// SPDX-License-Identifier: MIT
// @decision DEC-STORAGE-LIBRARY-001: better-sqlite3 + sqlite-vec extension.
// Status: decided (WI-003)
// Rationale: better-sqlite3 is synchronous, has the best Node.js performance
// profile of any SQLite binding, and is widely used. sqlite-vec provides the
// vec0 virtual table that backs the vector index. Both are mature enough for
// the v0 local-only requirement. The sync API is fine for v0 (no concurrent
// writers; the registry is a CLI tool). Async wrappers are added at the
// Promise boundary to match the Registry interface.

// @decision DEC-STORAGE-FAIL-LOUD-001: No in-memory fallback on SQLite open
// failure. Status: decided (WI-003)
// Rationale: A silent fallback would mask DB errors and let callers believe
// they have a real registry when they don't. Fail loudly with a descriptive
// error so the operator knows immediately that the DB is unavailable.

// @decision DEC-STORAGE-IDEMPOTENT-001: storeBlock() uses INSERT OR IGNORE for
// the blocks table to ensure idempotency on re-store of the same
// content-addressed block_merkle_root. The vector table uses DELETE+INSERT for
// the same reason (vec0 does not support INSERT OR IGNORE / ON CONFLICT).
// Status: decided (WI-T03, continuing DEC-STORAGE-IDEMPOTENT-001 from WI-003)
// Rationale: Block identity is content-addressed; the same block_merkle_root
// always means the same content. Idempotent store means callers never need to
// check for existence before storing.

// @decision DEC-SCHEMA-MIGRATION-002: WI-T03 clean re-create schema.
// Status: decided (MASTER_PLAN.md WI-T03 Evaluation Contract)
// Rationale: The v0 (contracts, implementations) two-table schema is replaced
// with a single `blocks` table keyed by block_merkle_root with a spec_hash
// index. No dual-table coexistence; no read-time fallback derivation of
// block_merkle_root (the column must be stored). See schema.ts for DDL.

import { blake3 } from "@noble/hashes/blake3.js";
import {
  type BlockMerkleRoot,
  type CanonicalAstHash,
  type EmbeddingProvider,
  type ProofManifest,
  type QueryIntentCard,
  type SpecHash,
  type SpecYak,
  canonicalAstHash,
  canonicalize,
  canonicalizeQueryText,
  blockMerkleRoot as computeBlockMerkleRoot,
  generateEmbedding,
} from "@yakcc/contracts";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type {
  BlockTripletRow,
  BootstrapManifestEntry,
  CandidateMatch,
  CandidateNearMiss,
  FindCandidatesByQueryOptions,
  FindCandidatesByQueryResult,
  FindCandidatesOptions,
  ForeignRefRow,
  IntentQuery,
  PerDimensionScores,
  Provenance,
  QueryCandidate,
  Registry,
  WorkspacePlumbingEntry,
} from "./index.js";
import { SCHEMA_VERSION, applyMigrations } from "./schema.js";
import { structuralMatch } from "./search.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Serialize a Float32Array to a Buffer for sqlite-vec storage. */
function serializeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

// ---------------------------------------------------------------------------
// Internal DB row shapes
// ---------------------------------------------------------------------------

interface BlockRow {
  block_merkle_root: string;
  spec_hash: string;
  spec_canonical_bytes: Buffer;
  impl_source: string;
  proof_manifest_json: string;
  level: string;
  created_at: number;
  canonical_ast_hash: string;
  /** NULL for root blocks; non-NULL for atoms shaved from a parent block. */
  parent_block_root: string | null;
  /**
   * Discriminator column added in migration 6 (DEC-V2-FOREIGN-BLOCK-SCHEMA-001).
   * 'local' for all pre-v6 rows (DEFAULT covers them); 'foreign' for foreign atoms.
   */
  kind: string;
  /**
   * npm package name or Node built-in specifier. Non-NULL iff kind='foreign'.
   * NULL for local blocks and for all pre-v6 rows.
   */
  foreign_pkg: string | null;
  /**
   * Exported symbol name at the use site. Non-NULL iff kind='foreign'.
   * NULL for local blocks and for all pre-v6 rows.
   */
  foreign_export: string | null;
  /**
   * Optional BLAKE3 hash of the .d.ts declaration text. NULL when not snapshotted.
   * Only meaningful when kind='foreign'.
   */
  foreign_dts_hash: string | null;

  // ---------------------------------------------------------------------------
  // Migration-7 fields (DEC-V2-REGISTRY-SOURCE-FILE-PROVENANCE-001 / P1)
  // NULL for all pre-v7 rows (no backfill UPDATE — forbidden shortcut #4).
  // Provenance is populated by re-running `yakcc bootstrap`.
  // ---------------------------------------------------------------------------

  /**
   * Workspace package directory (e.g. 'packages/cli'). NULL for foreign atoms,
   * seed blocks, and all pre-v7 rows. First-observed-wins via INSERT OR IGNORE.
   */
  source_pkg: string | null;

  /**
   * Workspace-relative path of the originating .ts source file
   * (e.g. 'packages/cli/src/commands/compile.ts'). NULL for foreign atoms,
   * seed blocks, and all pre-v7 rows.
   */
  source_file: string | null;

  /**
   * Byte offset of the atom's implSource within source_file. NULL when unknown.
   * NOT folded into blockMerkleRoot — provenance is metadata only.
   */
  source_offset: number | null;
}

interface TestHistoryRow {
  suite_id: string;
  passed: number;
  at: number;
}

interface RuntimeExposureRow {
  requests_seen: number;
  last_seen: number | null;
}

interface StrictnessEdgeRow {
  stricter_root: string;
  looser_root: string;
}

/** One row from the block_artifacts table (WI-022 / DEC-V1-FEDERATION-WIRE-ARTIFACTS-002). */
interface BlockArtifactRow {
  path: string;
  bytes: Buffer;
  declaration_index: number;
}

// ---------------------------------------------------------------------------
// SQLite-backed Registry implementation (v0.6 triplet schema)
// ---------------------------------------------------------------------------

class SqliteRegistry implements Registry {
  private readonly db: Database.Database;
  private readonly embeddings: EmbeddingProvider;
  private closed = false;

  constructor(db: Database.Database, embeddings: EmbeddingProvider) {
    this.db = db;
    this.embeddings = embeddings;
  }

  // -------------------------------------------------------------------------
  // storeBlock
  // -------------------------------------------------------------------------

  async storeBlock(row: BlockTripletRow, opts: { validateOnStore?: boolean } = {}): Promise<void> {
    this.assertOpen();

    const validateOnStore = opts.validateOnStore !== false; // default: true

    // -----------------------------------------------------------------------
    // Integrity check: recompute blockMerkleRoot from stored fields and compare
    // against row.blockMerkleRoot. Rejects rows whose stored root doesn't match
    // the canonical contracts formula (DEC-CONTRACTS-AUTHORITY-001).
    //
    // The check is default-on (validateOnStore: true). Migration-internal callers
    // that pre-date artifact threading pass validateOnStore: false to skip.
    //
    // @decision DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: Registry-side integrity gate.
    // Status: decided (WI-022). Rationale: closes the same loop the wire-side
    // gate will close in WI-020; ensures every persisted row's stored merkle root
    // matches its bytes — foundational for federation round-trip correctness.
    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // L2-I3 invariant guard: kind='foreign' requires foreign_pkg and
    // foreign_export to be non-null. Enforced here at the single insert path
    // (DEC-V2-FOREIGN-BLOCK-SCHEMA-001 / WI-V2-04 L2-I3).
    // This is an application-level guard because SQLite's ADD COLUMN cannot
    // add cross-column CHECK constraints after the fact.
    // -----------------------------------------------------------------------
    if (row.kind === "foreign") {
      if (row.foreignPkg == null || row.foreignExport == null) {
        const err = new Error(
          "storeBlock invariant violation (L2-I3): kind='foreign' requires foreignPkg and foreignExport to be non-null",
        );
        (err as Error & { reason: string }).reason = "foreign_invariant_failed";
        throw err;
      }
    }

    if (validateOnStore) {
      let recomputed: string;
      if (row.kind === "foreign") {
        // Foreign blocks: identity is keyed on (kind, pkg, export, dtsHash?).
        // Pass the ForeignTripletFields shape directly to blockMerkleRoot().
        // L2-I3 guard above guarantees foreignPkg/foreignExport are non-null
        // for kind='foreign' before we reach this point.
        const pkg = row.foreignPkg ?? "";
        const foreignExport = row.foreignExport ?? "";
        recomputed = computeBlockMerkleRoot({
          kind: "foreign",
          pkg,
          export: foreignExport,
          ...(row.foreignDtsHash != null ? { dtsHash: row.foreignDtsHash } : {}),
        });
      } else {
        // Local blocks: identity is keyed on (spec, implSource, manifest, artifacts).
        const spec = JSON.parse(Buffer.from(row.specCanonicalBytes).toString("utf-8")) as SpecYak;
        const manifest = JSON.parse(row.proofManifestJson) as ProofManifest;
        // row.artifacts is ReadonlyMap; blockMerkleRoot() accepts Map — cast is safe.
        const artifacts = row.artifacts as Map<string, Uint8Array>;
        recomputed = computeBlockMerkleRoot({
          spec: spec as unknown as SpecYak,
          implSource: row.implSource,
          manifest,
          artifacts,
        });
      }
      if (recomputed !== row.blockMerkleRoot) {
        const err = new Error(
          `storeBlock integrity check failed: stored blockMerkleRoot ${row.blockMerkleRoot} does not match recomputed value ${recomputed}`,
        );
        (err as Error & { reason: string }).reason = "integrity_failed";
        throw err;
      }
    }

    const now = row.createdAt > 0 ? row.createdAt : Date.now();

    // Parse the spec canonical bytes back to a SpecYak so we can generate an
    // embedding. The canonical bytes were produced by canonicalize(spec), so
    // we JSON-parse them (canonicalize produces UTF-8 JSON) to get the spec.
    // We need the spec text (its canonical JSON) for embedding generation.
    // The embedding provider accepts a text string derived from the spec.
    // We use the UTF-8 string of the canonical bytes as the embedding input,
    // consistent with the v0 approach (generateEmbedding expects a ContractSpec
    // but we pass the decoded canonical text as a surrogate spec string).
    const specText = Buffer.from(row.specCanonicalBytes).toString("utf-8");
    // Parse the canonical JSON to get the spec object for the embedding provider.
    const specObj = JSON.parse(specText) as SpecYak;
    const embedding = await generateEmbedding(
      specObj as unknown as Parameters<typeof generateEmbedding>[0],
      this.embeddings,
    );

    // Trust the canonicalAstHash already computed by the caller (e.g. makeBlockRow,
    // the seed package, and all future write paths). Callers are responsible for
    // computing canonicalAstHash once at row-construction time; the storage layer
    // accepts the value as-given rather than re-parsing implSource through ts-morph
    // on every write. The migration backfill path (see migrateAddCanonicalAstHash)
    // is the only code path that must compute the hash here because pre-WI-012-02
    // rows arrive without the field populated.
    const implAstHash = row.canonicalAstHash;

    // @decision DEC-V2-REGISTRY-SOURCE-FILE-PROVENANCE-001
    // INSERT OR IGNORE is the load-bearing first-observed-wins mechanism.
    // A second storeBlock call for the same blockMerkleRoot with null provenance
    // does NOT overwrite the existing non-null provenance — the entire row is
    // ignored on conflict (UNIQUE constraint on block_merkle_root PRIMARY KEY).
    // This is correct: the registry is monotonic; provenance is set at first-write
    // and never changed. Callers that need to update provenance must not assume
    // a second storeBlock will succeed — it will silently no-op per this design.
    const insertBlock = this.db.prepare<
      [
        string,
        string,
        Buffer,
        string,
        string,
        string,
        number,
        string,
        string | null,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number | null,
      ]
    >(
      "INSERT OR IGNORE INTO blocks(block_merkle_root, spec_hash, spec_canonical_bytes, impl_source, proof_manifest_json, level, created_at, canonical_ast_hash, parent_block_root, kind, foreign_pkg, foreign_export, foreign_dts_hash, source_pkg, source_file, source_offset) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );

    // vec0 does not support INSERT OR IGNORE / ON CONFLICT, so use DELETE+INSERT
    // to make this idempotent (DEC-STORAGE-IDEMPOTENT-001).
    const deleteEmbedding = this.db.prepare<[string]>(
      "DELETE FROM contract_embeddings WHERE spec_hash = ?",
    );
    const insertEmbedding = this.db.prepare<[string, Buffer]>(
      "INSERT INTO contract_embeddings(spec_hash, embedding) VALUES (?, ?)",
    );

    // Artifact INSERT prepared statement. One row per Map entry.
    // INSERT OR IGNORE: idempotent on re-store of the same (block_merkle_root, path).
    // The composite PK prevents duplicate rows; a second store is a no-op.
    const insertArtifact = this.db.prepare<[string, string, Buffer, number]>(
      "INSERT OR IGNORE INTO block_artifacts(block_merkle_root, path, bytes, declaration_index) VALUES (?, ?, ?, ?)",
    );

    const embeddingBuf = serializeEmbedding(embedding);

    // Capture artifact entries in Map iteration order (= declaration order per
    // the BlockTriplet contract: keys match manifest.artifacts[*].path in order).
    const artifactEntries = [...row.artifacts.entries()];

    const txn = this.db.transaction(() => {
      insertBlock.run(
        row.blockMerkleRoot,
        row.specHash,
        Buffer.from(row.specCanonicalBytes),
        row.implSource,
        row.proofManifestJson,
        row.level,
        now,
        implAstHash,
        row.parentBlockRoot ?? null,
        // Migration-6 columns (DEC-V2-FOREIGN-BLOCK-SCHEMA-001 / L2-I3).
        // kind defaults to 'local' for rows that omit the field (backward compat).
        row.kind ?? "local",
        row.foreignPkg ?? null,
        row.foreignExport ?? null,
        row.foreignDtsHash ?? null,
        // Migration-7 columns (DEC-V2-REGISTRY-SOURCE-FILE-PROVENANCE-001 / P1).
        // Optional fields: callers that omit them (federation.ts, seed.ts,
        // assemble-candidate.ts) pass null — correct for non-bootstrap atoms.
        // Bootstrap walker sets real values for local atoms via ShaveOptions.
        // INSERT OR IGNORE means first-observed-wins: if the row already exists
        // with non-null provenance, this second store is a silent no-op.
        row.sourcePkg ?? null,
        row.sourceFile ?? null,
        row.sourceOffset ?? null,
      );
      // Only write the embedding if the spec_hash doesn't already have one.
      // Check by attempting DELETE (no-op if absent) then INSERT.
      // This is safe for idempotent re-stores of the same spec_hash because
      // the embedding is deterministic for the same spec.
      deleteEmbedding.run(row.specHash);
      insertEmbedding.run(row.specHash, embeddingBuf);
      // Persist artifact bytes in declaration order (Map iteration order).
      // INSERT OR IGNORE ensures idempotency on re-store: the composite PK
      // (block_merkle_root, path) rejects duplicates without error.
      for (let i = 0; i < artifactEntries.length; i++) {
        const entry = artifactEntries[i];
        if (entry === undefined) continue;
        const [artifactPath, artifactBytes] = entry;
        insertArtifact.run(row.blockMerkleRoot, artifactPath, Buffer.from(artifactBytes), i);
      }
    });

    txn();
  }

  // -------------------------------------------------------------------------
  // selectBlocks — return all BlockMerkleRoots for a given spec hash
  // -------------------------------------------------------------------------

  async selectBlocks(specHash: SpecHash): Promise<BlockMerkleRoot[]> {
    this.assertOpen();

    // Load all blocks for this spec_hash.
    const blockRows = this.db
      .prepare<[string], BlockRow>(
        "SELECT * FROM blocks WHERE spec_hash = ? ORDER BY created_at ASC",
      )
      .all(specHash);

    if (blockRows.length === 0) return [];

    // Load strictness edges for these blocks (by block_merkle_root).
    const roots = blockRows.map((r) => r.block_merkle_root);
    const placeholders = roots.map(() => "?").join(", ");
    const edgeRows = this.db
      .prepare<string[], StrictnessEdgeRow>(
        `SELECT stricter_root, looser_root FROM strictness_edges WHERE stricter_root IN (${placeholders}) OR looser_root IN (${placeholders})`,
      )
      .all(...roots, ...roots);

    // Load passing test counts for each block.
    const passingRunsMap = new Map<string, number>();
    for (const root of roots) {
      const row = this.db
        .prepare<[string], { passing: number }>(
          "SELECT COUNT(*) AS passing FROM test_history WHERE block_merkle_root = ? AND passed = 1",
        )
        .get(root);
      passingRunsMap.set(root, row?.passing ?? 0);
    }

    // Build edge set restricted to roots in the candidate set.
    const rootSet = new Set(roots);
    type EdgeKey = string;
    const edgeSet = new Set<EdgeKey>();
    for (const e of edgeRows) {
      if (
        rootSet.has(e.stricter_root) &&
        rootSet.has(e.looser_root) &&
        e.stricter_root !== e.looser_root
      ) {
        edgeSet.add(`${e.stricter_root}|${e.looser_root}`);
      }
    }

    // Sort by: (1) maximally-strict first, (2) non-functional quality of the
    // spec (parsed from canonical bytes), (3) passing test runs, (4) lex root.
    // For simplicity at v0.6 (all blocks for the same spec_hash share the same
    // spec, so NF tiebreak is the same for all siblings), we sort by:
    //   - strictness partial order (stricter first)
    //   - more passing test runs
    //   - lexicographically smaller block_merkle_root
    const sorted = [...blockRows].sort((a, b) => {
      // Strictness: if a is declared stricter than b, a comes first.
      const aStricterThanB = isStricterThan(
        a.block_merkle_root,
        b.block_merkle_root,
        edgeSet,
        roots,
      );
      const bStricterThanA = isStricterThan(
        b.block_merkle_root,
        a.block_merkle_root,
        edgeSet,
        roots,
      );
      if (aStricterThanB && !bStricterThanA) return -1;
      if (bStricterThanA && !aStricterThanB) return 1;

      // Passing test runs — more is better.
      const passingA = passingRunsMap.get(a.block_merkle_root) ?? 0;
      const passingB = passingRunsMap.get(b.block_merkle_root) ?? 0;
      if (passingA !== passingB) return passingB - passingA;

      // Lexicographic tiebreak — smaller root first.
      return a.block_merkle_root < b.block_merkle_root ? -1 : 1;
    });

    return sorted.map((r) => r.block_merkle_root as BlockMerkleRoot);
  }

  // -------------------------------------------------------------------------
  // getBlock — retrieve a full block row by BlockMerkleRoot
  // -------------------------------------------------------------------------

  async getBlock(merkleRoot: BlockMerkleRoot): Promise<BlockTripletRow | null> {
    this.assertOpen();

    const row = this.db
      .prepare<[string], BlockRow>("SELECT * FROM blocks WHERE block_merkle_root = ?")
      .get(merkleRoot);

    if (row === undefined) return null;

    // Eagerly hydrate artifact bytes in declaration order.
    // Ordered by declaration_index to reconstruct the Map in manifest order.
    // Pre-WI-022 blocks that have no block_artifacts rows return an empty Map
    // (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002 migration note).
    const artifactRows = this.db
      .prepare<[string], BlockArtifactRow>(
        "SELECT path, bytes, declaration_index FROM block_artifacts WHERE block_merkle_root = ? ORDER BY declaration_index ASC",
      )
      .all(merkleRoot);

    return hydrateBlock(row, artifactRows);
  }

  // -------------------------------------------------------------------------
  // getForeignRefs — return block_foreign_refs rows for a parent block
  // (DEC-V2-FOREIGN-BLOCK-SCHEMA-001 / WI-V2-04 L2)
  // -------------------------------------------------------------------------

  async getForeignRefs(merkleRoot: BlockMerkleRoot): Promise<readonly ForeignRefRow[]> {
    this.assertOpen();

    const rows = this.db
      .prepare<
        [string],
        { parent_block_root: string; foreign_block_root: string; declaration_index: number }
      >(
        "SELECT parent_block_root, foreign_block_root, declaration_index FROM block_foreign_refs WHERE parent_block_root = ? ORDER BY declaration_index ASC",
      )
      .all(merkleRoot);

    return rows.map((r) => ({
      parentBlockRoot: r.parent_block_root as BlockMerkleRoot,
      foreignBlockRoot: r.foreign_block_root as BlockMerkleRoot,
      declarationIndex: r.declaration_index,
    }));
  }

  // -------------------------------------------------------------------------
  // findByCanonicalAstHash — look up blocks by impl canonical AST hash
  // -------------------------------------------------------------------------

  async findByCanonicalAstHash(hash: CanonicalAstHash): Promise<readonly BlockMerkleRoot[]> {
    this.assertOpen();

    const rows = this.db
      .prepare<[string], { block_merkle_root: string }>(
        "SELECT block_merkle_root FROM blocks WHERE canonical_ast_hash = ? ORDER BY created_at ASC, block_merkle_root ASC",
      )
      .all(hash);

    return rows.map((r) => r.block_merkle_root as BlockMerkleRoot);
  }

  // -------------------------------------------------------------------------
  // getProvenance — test history + runtime exposure for a block
  // -------------------------------------------------------------------------

  async getProvenance(merkleRoot: BlockMerkleRoot): Promise<Provenance> {
    this.assertOpen();

    const testRows = this.db
      .prepare<[string], TestHistoryRow>(
        "SELECT suite_id, passed, at FROM test_history WHERE block_merkle_root = ? ORDER BY at ASC",
      )
      .all(merkleRoot);

    const exposureRow = this.db
      .prepare<[string], RuntimeExposureRow>(
        "SELECT requests_seen, last_seen FROM runtime_exposure WHERE block_merkle_root = ?",
      )
      .get(merkleRoot);

    const testHistory = testRows.map((r) => ({
      runAt: new Date(r.at).toISOString(),
      passed: r.passed === 1,
      caseCount: 0, // caseCount not persisted in v0.6 schema
    }));

    const runtimeExposure =
      exposureRow !== undefined && exposureRow.requests_seen > 0
        ? [
            {
              observedAt: new Date(exposureRow.last_seen ?? Date.now()).toISOString(),
              assembledInto: merkleRoot, // placeholder; real assembledInto tracked by compile
            },
          ]
        : [];

    return { testHistory, runtimeExposure };
  }

  // -------------------------------------------------------------------------
  // findCandidatesByIntent — vector KNN search + optional structural rerank
  // -------------------------------------------------------------------------

  // @decision DEC-VECTOR-RETRIEVAL-002
  // title: Query-text derivation for findCandidatesByIntent
  // status: accepted (see also index.ts DEC-VECTOR-RETRIEVAL-002 annotation)
  // rationale: behavior + "\n" + "name: typeHint" per input + per output gives
  //   a text that mirrors the embedding input used at storeBlock time. The
  //   spec's embedding is derived from its behavior+parameter text; the query
  //   uses the same template so query and document vectors are comparable.

  async findCandidatesByIntent(
    card: IntentQuery,
    options: FindCandidatesOptions = {},
  ): Promise<readonly CandidateMatch[]> {
    this.assertOpen();

    const k = options.k ?? 10;

    // Derive query text from the card (DEC-VECTOR-RETRIEVAL-002).
    // behavior + each input as "name: typeHint" + each output as "name: typeHint"
    const parts: string[] = [card.behavior];
    for (const p of card.inputs) {
      parts.push(`${p.name}: ${p.typeHint}`);
    }
    for (const p of card.outputs) {
      parts.push(`${p.name}: ${p.typeHint}`);
    }
    const queryText = parts.join("\n");

    // Generate embedding for the query text by calling the provider directly.
    // We bypass generateEmbedding() (which calls canonicalizeText on a ContractSpec)
    // and call embed() directly with our derived query text. This is intentional:
    // the query text is already in the same format as the text embedded at write time
    // (storeBlock calls generateEmbedding on the spec, which canonicalizes its JSON;
    // we match that space by embedding the same behavior+params text directly).
    const queryEmbedding = await this.embeddings.embed(queryText);

    const queryBuf = serializeEmbedding(queryEmbedding);

    // KNN query against contract_embeddings (vec0 virtual table).
    // Returns rows ordered by ascending distance (closest first).
    // The vec0 KNN syntax: WHERE embedding MATCH ? AND k = N ORDER BY distance
    interface EmbeddingRow {
      spec_hash: string;
      distance: number;
    }

    let embeddingRows: EmbeddingRow[];
    try {
      embeddingRows = this.db
        .prepare<[Buffer, number], EmbeddingRow>(
          "SELECT spec_hash, distance FROM contract_embeddings WHERE embedding MATCH ? AND k = ? ORDER BY distance",
        )
        .all(queryBuf, k);
    } catch {
      // If the embeddings table is empty, vec0 may throw. Return [] gracefully.
      return [];
    }

    if (embeddingRows.length === 0) return [];

    // For each spec_hash, find the best block (first from selectBlocks which uses
    // the strictness-aware sort). We hydrate one block per spec_hash hit.
    const results: CandidateMatch[] = [];

    for (const eRow of embeddingRows) {
      const specHash = eRow.spec_hash as SpecHash;
      // Get all blocks for this spec, ordered by strictness/quality.
      const roots = await this.selectBlocks(specHash);
      if (roots.length === 0) continue;

      // Take the best block (first in strictness order).
      const bestRoot = roots[0];
      if (bestRoot === undefined) continue;

      const block = await this.getBlock(bestRoot);
      if (block === null) continue;

      results.push({
        block,
        cosineDistance: eRow.distance,
      });
    }

    // Optional structural rerank (DEC-VECTOR-RETRIEVAL-003).
    if (options.rerank === "structural") {
      // Build a minimal SpecYak from the card for structural comparison.
      // structuralMatch requires SpecYak; we construct the minimum valid shape.
      const querySpec: SpecYak = {
        name: "query",
        inputs: card.inputs.map((p) => ({ name: p.name, type: p.typeHint })),
        outputs: card.outputs.map((p) => ({ name: p.name, type: p.typeHint })),
        preconditions: [],
        postconditions: [],
        invariants: [],
        effects: [],
        level: "L0",
      };

      // Annotate each result with a structural score, then sort by combined score.
      const annotated = results.map((m) => {
        const candidateSpec = JSON.parse(
          Buffer.from(m.block.specCanonicalBytes).toString("utf-8"),
        ) as SpecYak;
        const matchResult = structuralMatch(querySpec, candidateSpec);
        const structuralScore = matchResult.matches ? 1.0 : 0.0;
        return { ...m, structuralScore };
      });

      // Sort by combined score descending: (1 - cosineDistance) + structuralScore.
      // cosineDistance is in [0, 2] on the unit sphere; (1 - d) maps to [-1, 1].
      // structuralScore is 0 or 1 at v0. Higher combined score = better match.
      annotated.sort((a, b) => {
        const sa = 1 - a.cosineDistance + a.structuralScore;
        const sb = 1 - b.cosineDistance + b.structuralScore;
        return sb - sa;
      });

      return annotated;
    }

    // Default: return in KNN distance order (already ascending from vec0 query).
    return results;
  }

  // -------------------------------------------------------------------------
  // findCandidatesByQuery — D3 5-stage multi-dimensional discovery pipeline
  // -------------------------------------------------------------------------

  // @decision DEC-V3-IMPL-QUERY-002
  // title: Cross-provider rejection at constructor layer
  // status: accepted
  // rationale: The embedding provider modelId is snapshotted at openRegistry()
  //   time (this.embeddings.modelId). findCandidatesByQuery() checks the caller's
  //   queryEmbeddings.modelId against the snapshot before any KNN call. Mismatch
  //   throws a typed Error with reason='cross_provider_rejected' (D2 cross-provider
  //   invariant). Silent fallback is explicitly forbidden (D2 §"Cross-provider
  //   rejection invariant"). This check fires at the method boundary, not at
  //   first-use, so mocks that throw if reached are the correct test sentinel.

  // @decision DEC-V3-IMPL-QUERY-003
  // title: Per-dimension weight collapse for v1 (key 'unified')
  // status: accepted
  // rationale: v3 uses the single contract_embeddings.embedding column (no
  //   per-column KNN — migration 7 for 5-column schema is deferred). Per-dimension
  //   weights in QueryIntentCard.weights are accepted by the API for forward-compat
  //   but collapsed to a single 'unified' weight. combinedScore = 1 - L²/4
  //   (DEC-V3-IMPL-QUERY-007 re-stated; canonical site: discovery-eval-helpers.ts).
  //   perDimensionScores carries a single entry under the queried dimension key(s).

  // @decision DEC-V3-IMPL-QUERY-006
  // title: D3 5-stage pipeline + CandidateNearMiss
  // status: accepted
  // rationale: Pipeline stages per D3 §Q3:
  //   Stage 1: KNN with K' = max(topK*5, 50) against contract_embeddings.
  //   Stage 2: structuralMatch() gate on QueryIntentCard.signature.
  //   Stage 3: Strictness gate on level, nonFunctional.purity, nonFunctional.threadSafety.
  //   Stage 4: Reserved no-op (DEC-VERIFY-010 v3.1 trigger; MUST NOT implement logic).
  //   Stage 5: combinedScore ranking (desc), ε=0.02 lex-BlockMerkleRoot tiebreaker
  //            (smaller wins), minScore filter, truncate to topK.
  //   When Stages 2–4 reduce to 0: near-miss envelope from Stage 1 K' set.
  //   autoAccepted: top-1.combinedScore > 0.85 AND (top-1 - top-2).combinedScore > 0.15.

  /**
   * Query the registry for atom candidates matching a multi-dimensional intent card.
   *
   * TRUST DOMAIN: This API is correct only within a same-process trust domain.
   * Registry-file portability across machines with different default embedding
   * providers is a known-untreated boundary deferred to migration-7 /
   * WI-V3-DISCOVERY-IMPL-MIGRATION-VERIFY. The cross-provider rejection gate
   * (see below) catches provider mismatches within the same process, but it
   * cannot detect binary-identical model IDs from different machines.
   *
   * @see DEC-V3-IMPL-QUERY-002 for the cross-provider rejection design.
   */
  async findCandidatesByQuery(
    query: QueryIntentCard,
    options?: FindCandidatesByQueryOptions,
  ): Promise<FindCandidatesByQueryResult> {
    this.assertOpen();

    // Cross-provider rejection (DEC-V3-IMPL-QUERY-002):
    // Verify model ID before any KNN call. Throw loud error on mismatch.
    // TRUST DOMAIN NOTE: This gate is correct only within a same-process trust domain.
    // Registry-file portability across machines with different default embedding
    // providers is a known-untreated boundary deferred to migration-7 /
    // WI-V3-DISCOVERY-IMPL-MIGRATION-VERIFY. See DEC-V3-IMPL-QUERY-002.
    const registryModelId = this.embeddings.modelId;
    const callerModelId = options?.queryEmbeddings?.modelId;
    if (callerModelId !== undefined && callerModelId !== registryModelId) {
      const err = new Error(
        `query-time embedding provider "${callerModelId}" does not match registry provider "${registryModelId}"; aborting`,
      );
      (err as Error & { reason: string }).reason = "cross_provider_rejected";
      throw err;
    }

    const topK = query.topK ?? 10;
    const kPrime = Math.max(topK * 5, 50); // D3 §Q3: K' = max(K×5, 50)

    // -----------------------------------------------------------------------
    // Stage 1 — Vector KNN retrieval with K' candidates
    // -----------------------------------------------------------------------

    // @decision DEC-V3-DISCOVERY-D3-FILTER-STRICTNESS-FIX-001
    // @title Stage 1 KNN uses plain behavior text for retrieval (issue #319)
    // @status accepted
    // @rationale
    //   "No-op when one side is missing" rule (issue #319 §Correct semantics):
    //   optional query fields (guarantees, errorConditions) present only on the
    //   query side must NOT penalize candidates that phrase those dimensions
    //   differently or don't declare them. Embedding the full canonicalizeQueryText
    //   in Stage 1 violates this rule: the guarantees text shifts the query vector
    //   toward source-fragment atoms whose names contain matching keywords
    //   (e.g., "function-digit-s-number" for a "Parse a decimal digit" query),
    //   pushing the semantically-correct atom to rank 43/50 in Stage 1.
    //
    //   Fix: Stage 1 embeds the plain behavior string (no JSON wrapper, no optional
    //   dimensions). This is identical to findCandidatesByIntent's embedding path,
    //   which achieves M2=62.5% vs query-mode-with-full-text M2=20.0% on the
    //   full-corpus harness (issue #309 measurements).
    //
    //   Why plain string (not canonicalizeQueryText({behavior}))?
    //   canonicalizeQueryText({behavior}) produces {"behavior":"..."} (JSON), while
    //   findCandidatesByIntent embeds the plain behavior string directly. The JSON
    //   wrapper adds structural tokens that degrade similarity vs stored specs
    //   (measured: plain string intent mode 62.5% M2 vs JSON behavior-only 20% M2).
    //
    //   The full canonicalizeQueryText is intentionally NOT used for Stage 1 KNN.
    //   Optional dimensions serve as context for Stage 2+ structural filtering, not
    //   for Stage 1 retrieval where the no-op rule must hold.
    //   Per-dimension KNN is deferred to DEC-V3-IMPL-QUERY-003 (migration 7,
    //   5-column schema). Until then, behavior-driven retrieval is the correct
    //   single-column approach.
    const stage1QueryText = query.behavior ?? "";
    const queryEmbedding = await this.embeddings.embed(stage1QueryText);
    const queryBuf = serializeEmbedding(queryEmbedding);

    interface EmbeddingRow {
      spec_hash: string;
      distance: number;
    }

    let stage1Rows: EmbeddingRow[];
    try {
      stage1Rows = this.db
        .prepare<[Buffer, number], EmbeddingRow>(
          "SELECT spec_hash, distance FROM contract_embeddings WHERE embedding MATCH ? AND k = ? ORDER BY distance",
        )
        .all(queryBuf, kPrime);
    } catch {
      // vec0 throws when table is empty
      return { candidates: [], nearMisses: [] };
    }

    if (stage1Rows.length === 0) {
      return { candidates: [], nearMisses: [] };
    }

    // Hydrate blocks for each Stage 1 candidate.
    // Use the same hydration logic as findCandidatesByIntent: best block per spec_hash.
    interface HydratedCandidate {
      block: BlockTripletRow;
      cosineDistance: number;
      specYak: SpecYak;
    }

    const stage1: HydratedCandidate[] = [];
    for (const eRow of stage1Rows) {
      const specHash = eRow.spec_hash as SpecHash;
      const roots = await this.selectBlocks(specHash);
      if (roots.length === 0) continue;
      const bestRoot = roots[0];
      if (bestRoot === undefined) continue;
      const block = await this.getBlock(bestRoot);
      if (block === null) continue;
      const specYak = JSON.parse(
        Buffer.from(block.specCanonicalBytes).toString("utf-8"),
      ) as SpecYak;
      stage1.push({ block, cosineDistance: eRow.distance, specYak });
    }

    if (stage1.length === 0) {
      return { candidates: [], nearMisses: [] };
    }

    // -----------------------------------------------------------------------
    // Stage 2 — Structural filter (structuralMatch on QueryIntentCard.signature)
    // -----------------------------------------------------------------------
    // Build a minimal SpecYak query shape from the card's signature field.
    // If no signature is provided, this stage is a no-op (all pass).

    // Track which Stage 1 candidates failed Stage 2 (for near-miss envelope).
    const stage2Failed: Array<{ item: HydratedCandidate; reason: string }> = [];
    let stage2Passed: HydratedCandidate[];

    if (
      query.signature === undefined ||
      (query.signature.inputs === undefined && query.signature.outputs === undefined)
    ) {
      // No-op: all Stage 1 candidates pass through.
      stage2Passed = stage1;
    } else {
      const querySpec: SpecYak = {
        name: "query",
        inputs: (query.signature.inputs ?? []).map((p, i) => ({
          name: p.name ?? `arg${i}`,
          type: p.type,
        })),
        outputs: (query.signature.outputs ?? []).map((p, i) => ({
          name: p.name ?? `out${i}`,
          type: p.type,
        })),
        preconditions: [],
        postconditions: [],
        invariants: [],
        effects: [],
        level: "L0",
      };

      stage2Passed = [];
      for (const item of stage1) {
        const result = structuralMatch(querySpec, item.specYak);
        if (result.matches) {
          stage2Passed.push(item);
        } else {
          const reason = result.reasons.join("; ");
          stage2Failed.push({ item, reason });
        }
      }
    }

    // -----------------------------------------------------------------------
    // Stage 3 — Strictness filter (level, nonFunctional.purity, threadSafety)
    // -----------------------------------------------------------------------
    // Only applies when QueryIntentCard.nonFunctional is provided.
    // A candidate fails Stage 3 if:
    //   - Its purity rank < query's purity rank
    //   - Its threadSafety rank < query's threadSafety rank
    // (The same ordering as structuralMatch's NF check.)

    const stage3Failed: Array<{ item: HydratedCandidate; reason: string }> = [];
    let stage3Passed: HydratedCandidate[];

    const queryNF = query.nonFunctional;
    if (queryNF === undefined) {
      // No-op: all Stage 2 survivors pass through.
      stage3Passed = stage2Passed;
    } else {
      const PURITY_RANK: Record<string, number> = {
        pure: 3,
        io: 2,
        stateful: 1,
        nondeterministic: 0,
      };
      const THREAD_RANK: Record<string, number> = {
        safe: 2,
        sequential: 1,
        unsafe: 0,
      };

      stage3Passed = [];
      for (const item of stage2Passed) {
        const reasons: string[] = [];
        const candidateNF = item.specYak.nonFunctional;

        // Graceful-skip semantics per DEC-V3-DISCOVERY-D3-FILTER-STRICTNESS-FIX
        // (issue #314, follow-up to DEC-V3-INITIATIVE-002-DISPOSITION):
        //   - If candidate has no nonFunctional declaration, the strictness
        //     dimension is SKIPPED for this candidate (not a rejection).
        //   - Rejection only applies when BOTH query and candidate declare the
        //     field AND candidate is strictly weaker.
        // Rationale: corpus + registry have sparse nonFunctional coverage
        // (0/50 in stratified corpus; rare in source-shaved atoms). Treating
        // missing-on-candidate as rejection gave intent-mode A/B +42.5pts M2
        // / +20pts M3 / +0.364 M4 vs query-mode in #289/#309. Graceful-skip is
        // the correct semantics: a candidate that doesn't declare the field is
        // no worse than one that declared it and matched.
        if (candidateNF !== undefined) {
          if (queryNF.purity !== undefined && candidateNF.purity !== undefined) {
            const qRank = PURITY_RANK[queryNF.purity] ?? 0;
            const cRank = PURITY_RANK[candidateNF.purity] ?? 0;
            if (cRank < qRank) {
              reasons.push(`purity=${candidateNF.purity} but query requires ${queryNF.purity}`);
            }
          }
          if (queryNF.threadSafety !== undefined && candidateNF.threadSafety !== undefined) {
            const qRank = THREAD_RANK[queryNF.threadSafety] ?? 0;
            const cRank = THREAD_RANK[candidateNF.threadSafety] ?? 0;
            if (cRank < qRank) {
              reasons.push(
                `threadSafety=${candidateNF.threadSafety} but query requires ${queryNF.threadSafety}`,
              );
            }
          }
        }
        // candidateNF === undefined → graceful skip per
        // @decision DEC-V3-DISCOVERY-D3-FILTER-STRICTNESS-FIX-001 (#319/#314):
        // a candidate that doesn't declare nonFunctional is NOT asserting failure;
        // it simply doesn't assert anything about purity/threadSafety. Stage 3
        // treats this as no-op (pass through), not rejection. The legitimate
        // filter case (candidateNF declared AND strictly weaker) is in the
        // candidateNF !== undefined branch above and remains unchanged.

        if (reasons.length > 0) {
          stage3Failed.push({ item, reason: reasons.join("; ") });
        } else {
          stage3Passed.push(item);
        }
      }
    }

    // -----------------------------------------------------------------------
    // Stage 4 — Reserved no-op (DEC-VERIFY-010 v3.1 trigger)
    // @decision DEC-V3-IMPL-QUERY-006 (Stage 4)
    // This slot is explicitly reserved. In v3, ALL Stage 3 survivors pass through
    // unconditionally. Property-test verification infrastructure (DEC-VERIFY-010)
    // is the v3.1 trigger for implementing this stage. DO NOT add logic here.
    // -----------------------------------------------------------------------
    const stage4Passed = stage3Passed; // pass-through, no filtering

    // -----------------------------------------------------------------------
    // Stage 5 — Final ranking + combinedScore + tiebreaker + minScore + topK
    // -----------------------------------------------------------------------

    // combinedScore formula (DEC-V3-IMPL-QUERY-007 re-stated, 1 - L²/4):
    // For unit-sphere embeddings: cosineDistance ∈ [0, 2].
    // similarity = 1 - cosineDistance/2 = 1 - L²/4 ∈ [0, 1].
    // v1 uses unified single-column embedding; per-dimension breakdown deferred.
    // perDimensionScores carries the 'unified' dimension under the queried keys.

    // Build unified score entries for all stage4Passed candidates.
    const scored: Array<{
      item: HydratedCandidate;
      combinedScore: number;
      perDimensionScores: PerDimensionScores;
    }> = stage4Passed.map((item) => {
      // @decision DEC-V3-IMPL-QUERY-007
      // @title combinedScore formula — L2→[0,1] via 1 - d²/4
      // @status accepted
      // @cross-links DEC-V3-DISCOVERY-CALIBRATION-FIX-002 (live calibration authority,
      //   supersedes -001; canonical site: discovery-eval-helpers.ts cosineDistanceToCombinedScore)
      // @deferred WI-V3-DISCOVERY-COMBINED-SCORE-CONSOLIDATE (consolidate inline formula
      //   into cosineDistanceToCombinedScore call to eliminate duplication)
      // @rationale vec0 returns L2 Euclidean distance (not cosine) for unit-normalized
      //   vectors. For unit vectors: L2² = 2 - 2·cos(θ) ⟹ cos(θ) = 1 - L2²/2.
      //   combinedScore = (1 + cos(θ)) / 2 = 1 - L2²/4. This is the corrected formula
      //   from PR #275 / DEC-V3-DISCOVERY-CALIBRATION-FIX-002. The earlier formula
      //   (1 - d/2) was incorrect — it applied a cosine-distance formula to an L2 distance.
      const combinedScore = Math.max(0, 1 - (item.cosineDistance * item.cosineDistance) / 4);

      // v1 per-dimension scores: single 'unified' key carries the combinedScore.
      // Using actual dimension keys (behavior, guarantees, …) here would falsely
      // imply per-dimension semantics that aren't implemented — v1 has only one
      // shared embedding column. Per-dimension granularity ships in v3.1 when
      // migration 7 (5-column schema) lands (DEC-V3-IMPL-QUERY-003).
      const perDimensionScores: PerDimensionScores = { unified: combinedScore };

      return { item, combinedScore, perDimensionScores };
    });

    // Sort by combinedScore descending.
    // @decision DEC-V3-DISCOVERY-D3-FILTER-STRICTNESS-FIX-001
    // @title Stage 5 tiebreaker ε reduced from 0.02 to 0 (issue #319)
    // @status accepted
    // @rationale
    //   The original ε=0.02 "tie window" caused rank inversions for candidate pairs
    //   with genuinely different cosine distances. Two candidates with scores 0.6419
    //   and 0.6233 (|diff|=0.0186 < 0.02) were treated as tied, and the lex-BMR
    //   tiebreaker placed the FURTHER atom at rank #1, displacing the CLOSER (correct)
    //   atom. This is a direct violation of the "ranking by semantic similarity" principle.
    //
    //   Fix: ε=0 means the lex-BMR tiebreaker only fires when two candidates have
    //   EXACTLY the same float combinedScore. In practice with semantic embeddings,
    //   identical scores from different text inputs are vanishingly rare. This restores
    //   pure distance-based ranking (matching findCandidatesByIntent behavior).
    //
    //   D3 §Q4 tiebreakers 2–4 (usage history, test depth, atom age) are deferred to
    //   WI-V3-DISCOVERY-D3-TIEBREAKERS. The lex-root tiebreaker (prio 5) remains for
    //   true float-equal ties only.
    //
    //   Measured impact (issue #309 full-corpus harness, paired with Stage 1 fix):
    //   Before fix: M2=20.0%, M3=72.5%, M4=0.378
    //   After fix:  M2≥62.5%, M3≥90%, M4≥0.70 (verified post-fix)
    const EPSILON = 0;
    scored.sort((a, b) => {
      const diff = b.combinedScore - a.combinedScore;
      if (Math.abs(diff) <= EPSILON) {
        // Within tie window: lex BlockMerkleRoot ascending (smaller wins, D3 §Q4 prio 5).
        return a.item.block.blockMerkleRoot < b.item.block.blockMerkleRoot ? -1 : 1;
      }
      return diff; // descending by combinedScore
    });

    // Apply minScore filter.
    const minScore = query.minScore;
    const minScoreFailed: Array<{ item: HydratedCandidate; combinedScore: number }> = [];
    const afterMinScore =
      minScore !== undefined
        ? scored.filter((s) => {
            if (s.combinedScore < minScore) {
              minScoreFailed.push({ item: s.item, combinedScore: s.combinedScore });
              return false;
            }
            return true;
          })
        : scored;

    // Truncate to topK.
    const topKResults = afterMinScore.slice(0, topK);

    if (topKResults.length === 0) {
      // 0 survivors: build near-miss envelope from Stage 1 K' set.
      // Near-misses are drawn from stage1 sorted by best combinedScore, up to topK.
      const nearMissMap = new Map<
        string,
        {
          item: HydratedCandidate;
          failedAtLayer: CandidateNearMiss["failedAtLayer"];
          failureReason: string;
        }
      >();

      // Stage 2 failures first (structural)
      for (const { item, reason } of stage2Failed) {
        nearMissMap.set(item.block.blockMerkleRoot, {
          item,
          failedAtLayer: "structural",
          failureReason: reason,
        });
      }
      // Stage 3 failures (strictness) — may overlap with stage 2 items; stage 2 wins
      for (const { item, reason } of stage3Failed) {
        if (!nearMissMap.has(item.block.blockMerkleRoot)) {
          nearMissMap.set(item.block.blockMerkleRoot, {
            item,
            failedAtLayer: "strictness",
            failureReason: reason,
          });
        }
      }
      // minScore failures (min_score)
      for (const { item, combinedScore: cs } of minScoreFailed) {
        if (!nearMissMap.has(item.block.blockMerkleRoot)) {
          nearMissMap.set(item.block.blockMerkleRoot, {
            item,
            failedAtLayer: "min_score",
            failureReason: `combinedScore=${cs.toFixed(4)} < minScore=${minScore ?? 0}`,
          });
        }
      }

      // Sort near-misses by combinedScore descending (best first), take topK.
      // Formula: 1 - d²/4 (DEC-V3-IMPL-QUERY-007 / DEC-V3-DISCOVERY-CALIBRATION-FIX-002).
      const nearMissEntries = [...nearMissMap.values()]
        .sort((a, b) => {
          const sa = Math.max(0, 1 - (a.item.cosineDistance * a.item.cosineDistance) / 4);
          const sb = Math.max(0, 1 - (b.item.cosineDistance * b.item.cosineDistance) / 4);
          return sb - sa;
        })
        .slice(0, topK);

      const nearMisses: CandidateNearMiss[] = nearMissEntries.map(
        ({ item, failedAtLayer, failureReason }) => {
          // Formula: 1 - d²/4 (DEC-V3-IMPL-QUERY-007 / DEC-V3-DISCOVERY-CALIBRATION-FIX-002).
          const cs = Math.max(0, 1 - (item.cosineDistance * item.cosineDistance) / 4);
          const pds: PerDimensionScores = { unified: cs };
          return {
            block: item.block,
            cosineDistance: item.cosineDistance,
            combinedScore: cs,
            perDimensionScores: pds,
            autoAccepted: false,
            failedAtLayer,
            failureReason,
          };
        },
      );

      return { candidates: [], nearMisses };
    }

    // Non-empty results: compute autoAccepted flag.
    // D2 §Q5 + D3 §Q1: autoAccepted iff top-1 combinedScore > 0.85 AND gap > 0.15.
    const top1 = topKResults[0];
    const top2 = topKResults[1];
    const top1Score = top1?.combinedScore ?? 0;
    const top2Score = top2?.combinedScore ?? 0;
    const autoAcceptFires = top1Score > 0.85 && top1Score - top2Score > 0.15;

    const candidates: QueryCandidate[] = topKResults.map((s, idx) => ({
      block: s.item.block,
      cosineDistance: s.item.cosineDistance,
      combinedScore: s.combinedScore,
      perDimensionScores: s.perDimensionScores,
      autoAccepted: autoAcceptFires && idx === 0,
    }));

    return { candidates, nearMisses: [] };
  }

  // -------------------------------------------------------------------------
  // enumerateSpecs — return all distinct spec hashes, sorted ascending
  // -------------------------------------------------------------------------

  // @decision DEC-SERVE-SPECS-ENUMERATION-020 (closure)
  // title: enumerateSpecs() — registry-native SELECT DISTINCT primitive
  // status: closed by WI-026
  // rationale: Pre-WI-026, serveRegistry accepted an optional `enumerateSpecs`
  //   callback because no method existed on Registry. The callback was the
  //   documented workaround (DEC-SERVE-SPECS-ENUMERATION-020). WI-026 adds
  //   this method as the single authority for spec enumeration; serveRegistry
  //   now calls `registry.enumerateSpecs()` directly.
  //
  //   No caching: the SELECT DISTINCT is cheap and caching would introduce a
  //   stale-write window (forbidden shortcut per WI-026 eval contract).
  //   No ownership columns: touches spec_hash only (DEC-NO-OWNERSHIP-011).
  //   Read-only: no mutations; storeBlock remains the sole mutation entry point
  //   (DEC-SCHEMA-MIGRATION-002).

  async enumerateSpecs(): Promise<readonly SpecHash[]> {
    this.assertOpen();

    const rows = this.db
      .prepare<[], { spec_hash: string }>(
        "SELECT DISTINCT spec_hash FROM blocks ORDER BY spec_hash",
      )
      .all();

    return rows.map((r) => r.spec_hash as SpecHash);
  }

  // -------------------------------------------------------------------------
  // exportManifest — deterministic manifest for bootstrap --verify
  // -------------------------------------------------------------------------

  // @decision DEC-V2-BOOTSTRAP-MANIFEST-001
  // title: exportManifest() excludes non-deterministic columns
  // status: accepted
  // rationale: createdAt and ROWID vary per-environment and per-run. The six
  //   fields in BootstrapManifestEntry are all content-addressed (derived from
  //   artifact bytes via BLAKE3) so the same block stored on any machine at any
  //   time produces the same entry. The array is sorted ascending by
  //   blockMerkleRoot — the sort is the load-bearing determinism contract for
  //   WI-V2-BOOTSTRAP-03's byte-identity gate.
  //   Blocks missing impl.ts or proof/manifest.json artifacts (pre-WI-022)
  //   receive the BLAKE3-of-empty-bytes sentinel so the schema is uniform.

  async exportManifest(): Promise<readonly BootstrapManifestEntry[]> {
    this.assertOpen();

    // Single query over blocks, sorted ascending by block_merkle_root.
    // The ORDER BY is the load-bearing determinism contract — do NOT change
    // to insertion order or any other sort key.
    interface ManifestBlockRow {
      block_merkle_root: string;
      spec_hash: string;
      canonical_ast_hash: string;
      parent_block_root: string | null;
    }

    const blockRows = this.db
      .prepare<[], ManifestBlockRow>(
        `SELECT
           b.block_merkle_root,
           b.spec_hash,
           b.canonical_ast_hash,
           b.parent_block_root
         FROM blocks b
         ORDER BY b.block_merkle_root ASC`,
      )
      .all();

    if (blockRows.length === 0) return [];

    // Precompute the sentinel: BLAKE3 of empty bytes (used when an artifact
    // path is absent — pre-WI-022 blocks or blocks with no matching path).
    const EMPTY_SENTINEL = bytesToHex(blake3(new Uint8Array(0)));

    // Load artifact bytes for all blocks in one query to avoid N+1 queries.
    // We only need impl.ts and proof/manifest.json paths.
    const allRoots = blockRows.map((r) => r.block_merkle_root);
    const placeholders = allRoots.map(() => "?").join(", ");
    interface ArtifactHashRow {
      block_merkle_root: string;
      path: string;
      bytes: Buffer;
    }
    const artifactRows = this.db
      .prepare<string[], ArtifactHashRow>(
        `SELECT block_merkle_root, path, bytes
         FROM block_artifacts
         WHERE block_merkle_root IN (${placeholders})
           AND path IN ('impl.ts', 'proof/manifest.json')`,
      )
      .all(...allRoots);

    // Build a lookup: root → { implSourceHash, manifestJsonHash }
    const hashMap = new Map<string, { implSourceHash: string; manifestJsonHash: string }>();
    for (const row of artifactRows) {
      let entry = hashMap.get(row.block_merkle_root);
      if (entry === undefined) {
        entry = { implSourceHash: EMPTY_SENTINEL, manifestJsonHash: EMPTY_SENTINEL };
        hashMap.set(row.block_merkle_root, entry);
      }
      const digest = bytesToHex(blake3(new Uint8Array(row.bytes)));
      if (row.path === "impl.ts") {
        entry.implSourceHash = digest;
      } else if (row.path === "proof/manifest.json") {
        entry.manifestJsonHash = digest;
      }
    }

    return blockRows.map((r): BootstrapManifestEntry => {
      const hashes = hashMap.get(r.block_merkle_root) ?? {
        implSourceHash: EMPTY_SENTINEL,
        manifestJsonHash: EMPTY_SENTINEL,
      };
      return {
        blockMerkleRoot: r.block_merkle_root as BlockMerkleRoot,
        specHash: r.spec_hash as SpecHash,
        canonicalAstHash: r.canonical_ast_hash,
        parentBlockRoot: (r.parent_block_root ?? null) as BlockMerkleRoot | null,
        implSourceHash: hashes.implSourceHash,
        manifestJsonHash: hashes.manifestJsonHash,
      };
    });
  }

  // -------------------------------------------------------------------------
  // storeWorkspacePlumbing — insert a plumbing-file row (P2)
  //
  // @decision DEC-V2-WORKSPACE-PLUMBING-AUTHORITY-001
  // title: workspace_plumbing is the single authority for non-atom bootable files
  // status: accepted (WI-V2-REGISTRY-SOURCE-FILE-PROVENANCE P2)
  // rationale: INSERT OR IGNORE + primary-key-on-workspace_path gives first-
  //   observed-wins semantics matching storeBlock. Content-hash verification is
  //   enforced here (not deferred to callers) so every row in the table is
  //   provably integrity-checked. Workspace-relative path validation prevents
  //   absolute-path or path-traversal rows from entering the table.
  // -------------------------------------------------------------------------

  async storeWorkspacePlumbing(entry: WorkspacePlumbingEntry): Promise<void> {
    this.assertOpen();

    // Validate workspace-relative path.
    if (entry.workspacePath.startsWith("/") || entry.workspacePath.includes("..")) {
      throw new Error(
        `storeWorkspacePlumbing: workspacePath must be workspace-relative and must not contain '..': ${entry.workspacePath}`,
      );
    }

    // Verify content integrity: BLAKE3-256(contentBytes) must equal contentHash.
    const actualHash = bytesToHex(blake3(entry.contentBytes));
    if (actualHash !== entry.contentHash) {
      throw new Error(
        `storeWorkspacePlumbing: contentHash mismatch for ${entry.workspacePath}: ` +
          `stored=${entry.contentHash}, computed=${actualHash}`,
      );
    }

    const insertPlumbing = this.db.prepare<[string, Buffer, string, number]>(
      "INSERT OR IGNORE INTO workspace_plumbing(workspace_path, content_bytes, content_hash, created_at) VALUES (?, ?, ?, ?)",
    );

    insertPlumbing.run(
      entry.workspacePath,
      Buffer.from(entry.contentBytes),
      entry.contentHash,
      entry.createdAt > 0 ? entry.createdAt : Date.now(),
    );
  }

  // -------------------------------------------------------------------------
  // listWorkspacePlumbing — enumerate all plumbing rows (P2)
  //
  // @decision DEC-V2-WORKSPACE-PLUMBING-AUTHORITY-001
  // title: deterministic enumeration sorted by workspace_path ASC
  // status: accepted (WI-V2-REGISTRY-SOURCE-FILE-PROVENANCE P2)
  // rationale: The ORDER BY workspace_path ASC is the load-bearing determinism
  //   contract — two calls on the same DB state produce identical results
  //   (mirrors exportManifest()'s ORDER BY blockMerkleRoot ASC contract).
  //   Callers may materialise files in any order; the canonical sort allows
  //   test assertions and diff-stable tooling output.
  // -------------------------------------------------------------------------

  async listWorkspacePlumbing(): Promise<readonly WorkspacePlumbingEntry[]> {
    this.assertOpen();

    interface PlumbingRow {
      workspace_path: string;
      content_bytes: Buffer;
      content_hash: string;
      created_at: number;
    }

    const rows = this.db
      .prepare<[], PlumbingRow>(
        "SELECT workspace_path, content_bytes, content_hash, created_at FROM workspace_plumbing ORDER BY workspace_path ASC",
      )
      .all();

    return rows.map((r) => ({
      workspacePath: r.workspace_path,
      contentBytes: new Uint8Array(r.content_bytes),
      contentHash: r.content_hash,
      createdAt: r.created_at,
    }));
  }

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Registry has been closed");
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (module-level to avoid closure overhead in tight loops)
// ---------------------------------------------------------------------------

/**
 * Hydrate a DB row into a BlockTripletRow.
 *
 * @param row          - The blocks table row.
 * @param artifactRows - Rows from block_artifacts, already ordered by
 *                       declaration_index ASC (callers are responsible for
 *                       the ORDER BY). Pre-WI-022 blocks pass an empty array,
 *                       producing an empty Map (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002).
 */
function hydrateBlock(row: BlockRow, artifactRows: readonly BlockArtifactRow[]): BlockTripletRow {
  // Reconstruct the artifacts Map in declaration order. Map insertion order in
  // JavaScript equals iteration order, so inserting in declaration_index order
  // is sufficient to guarantee correct Map.entries() iteration order.
  const artifacts = new Map<string, Uint8Array>();
  for (const ar of artifactRows) {
    artifacts.set(ar.path, new Uint8Array(ar.bytes));
  }

  return {
    blockMerkleRoot: row.block_merkle_root as BlockMerkleRoot,
    specHash: row.spec_hash as SpecHash,
    specCanonicalBytes: new Uint8Array(row.spec_canonical_bytes),
    implSource: row.impl_source,
    proofManifestJson: row.proof_manifest_json,
    level: row.level as "L0" | "L1" | "L2" | "L3",
    createdAt: row.created_at,
    canonicalAstHash: row.canonical_ast_hash as CanonicalAstHash,
    parentBlockRoot: (row.parent_block_root ?? null) as BlockMerkleRoot | null,
    artifacts,
    // Migration-6 fields (DEC-V2-FOREIGN-BLOCK-SCHEMA-001 / WI-V2-04 L2).
    // Pre-v6 rows return kind='local' via the DEFAULT; foreign fields are null.
    kind: (row.kind ?? "local") as "local" | "foreign",
    foreignPkg: row.foreign_pkg ?? null,
    foreignExport: row.foreign_export ?? null,
    foreignDtsHash: row.foreign_dts_hash ?? null,
    // Migration-7 fields (DEC-V2-REGISTRY-SOURCE-FILE-PROVENANCE-001 / P1).
    // Pre-v7 rows return null for all three fields — the correct sentinel for
    // atoms that predate provenance tracking. Callers must treat null as
    // "unknown provenance", not as "no source file exists".
    sourcePkg: row.source_pkg ?? null,
    sourceFile: row.source_file ?? null,
    sourceOffset: row.source_offset ?? null,
  };
}

/**
 * Return true if `aRoot` is declared strictly stronger than `bRoot`
 * (directly or transitively) within the edge set.
 * Uses iterative BFS to avoid call-stack blowup on large graphs.
 */
function isStricterThan(
  aRoot: string,
  bRoot: string,
  edgeSet: ReadonlySet<string>,
  allRoots: readonly string[],
): boolean {
  const visited = new Set<string>();
  const queue: string[] = [aRoot];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const id of allRoots) {
      if (!visited.has(id) && edgeSet.has(`${current}|${id}`)) {
        if (id === bRoot) return true;
        queue.push(id);
      }
    }
  }
  return false;
}

/**
 * Convert a Uint8Array to a lowercase hex string.
 * Each file defines its own private copy — codebase pattern from merkle.ts:107.
 * (DEC-V2-BOOTSTRAP-BYTESTOHEX-001)
 */
function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]?.toString(16).padStart(2, "0");
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Public constructor
// ---------------------------------------------------------------------------

/**
 * Options for opening a registry.
 */
export interface RegistryOptions {
  /**
   * Embedding provider to use. Defaults to the local transformers.js provider
   * (Xenova/all-MiniLM-L6-v2, 384 dimensions).
   */
  embeddings?: EmbeddingProvider | undefined;
}

/**
 * Open (or create) a Yakcc registry at the given filesystem path.
 *
 * Opens the SQLite database at `path`, loads the sqlite-vec extension, and
 * applies schema migrations. If the file does not exist, it is created.
 *
 * Pass `":memory:"` as `path` for an in-process database with no disk I/O
 * (useful for tests).
 *
 * Fails loudly if the database cannot be opened or the vec extension cannot
 * be loaded — no silent in-memory fallback (DEC-STORAGE-FAIL-LOUD-001).
 *
 * @param path    - Filesystem path to the registry database file, or ":memory:".
 * @param options - Optional configuration including embedding provider.
 */
export async function openRegistry(path: string, options?: RegistryOptions): Promise<Registry> {
  // Open the SQLite database. better-sqlite3 throws synchronously on failure.
  const db = new Database(path);

  // Enable WAL mode for better concurrent read performance.
  db.pragma("journal_mode = WAL");
  // Enable foreign key enforcement.
  db.pragma("foreign_keys = ON");

  // Load the sqlite-vec extension (throws if unavailable).
  sqliteVec.load(db);
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  db.exec("INSERT OR IGNORE INTO schema_version(version) VALUES (0)");
  const preMigrationVersionRow = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | undefined;
  const preMigrationVersion = preMigrationVersionRow?.version ?? 0;

  // Apply schema migrations (idempotent).
  // applyMigrations handles DDL for all migrations including 2→3 (adds the
  // canonical_ast_hash column) and 3→4 (adds parent_block_root). The
  // version-3 backfill and version bump are performed here because this
  // layer has access to canonicalAstHash() from @yakcc/contracts (schema.ts
  // is pure DDL and does not import it).
  applyMigrations(db);
  if (preMigrationVersion < 3) {
    const rowsToBackfill = db
      .prepare<[], { block_merkle_root: string; impl_source: string }>(
        "SELECT block_merkle_root, impl_source FROM blocks WHERE canonical_ast_hash = ''",
      )
      .all();

    const updateHash = db.prepare<[string, string]>(
      "UPDATE blocks SET canonical_ast_hash = ? WHERE block_merkle_root = ?",
    );

    // Bump to SCHEMA_VERSION (not just 3): applyMigrations already ran migration 4
    // and bumped the DB to SCHEMA_VERSION. The backfill is a prerequisite for all
    // migrations ≥ 3, so after completing it the version must reflect the full
    // applied migration chain, not just the migration-3 milestone.
    const backfillTxn = db.transaction(() => {
      for (const r of rowsToBackfill) {
        updateHash.run(canonicalAstHash(r.impl_source), r.block_merkle_root);
      }
      db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
    });
    backfillTxn();
  }

  // Resolve the embedding provider: use provided, or import the local default.
  let embeddingProvider: EmbeddingProvider;
  if (options?.embeddings !== undefined) {
    embeddingProvider = options.embeddings;
  } else {
    const { createLocalEmbeddingProvider } = await import("@yakcc/contracts");
    embeddingProvider = createLocalEmbeddingProvider();
  }

  return new SqliteRegistry(db, embeddingProvider);
}

// ---------------------------------------------------------------------------
// Internal re-export for schema inspection (tests only)
// ---------------------------------------------------------------------------

export { canonicalize };
