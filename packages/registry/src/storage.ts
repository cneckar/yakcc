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
  type SpecHash,
  type SpecYak,
  canonicalAstHash,
  canonicalize,
  blockMerkleRoot as computeBlockMerkleRoot,
  generateEmbedding,
} from "@yakcc/contracts";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type {
  BlockTripletRow,
  BootstrapManifestEntry,
  CandidateMatch,
  FindCandidatesOptions,
  ForeignRefRow,
  IntentQuery,
  Provenance,
  Registry,
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
      ]
    >(
      "INSERT OR IGNORE INTO blocks(block_merkle_root, spec_hash, spec_canonical_bytes, impl_source, proof_manifest_json, level, created_at, canonical_ast_hash, parent_block_root, kind, foreign_pkg, foreign_export, foreign_dts_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
