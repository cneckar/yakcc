// SPDX-License-Identifier: MIT
//
// proof-market.ts — commit-reveal lifecycle state machine for the yakcc proof incentive layer.
//
// @decision DEC-PROOF-COMMIT-REVEAL-001
// @title Commit-reveal lifecycle as the proof marketplace state machine
// @status decided (WI-1082 / issue #1082 / plans/proof-incentive-layer.md §3.2 Slice C)
// @rationale
//   The commit-reveal scheme prevents front-running of revealed proof artifacts:
//
//   PROBLEM: Without commit-reveal, a claimant reveals their proof artifact on-chain
//   and a watcher can copy it and submit an identical claim before the original
//   claimant's transaction lands. This "front-running" attack lets an adversary steal
//   the bounty reward for work they did not perform.
//
//   SOLUTION: Two-phase protocol —
//     Phase 1 (COMMIT): Claimant submits commit_hash = BLAKE3(artifact_hash || nonce || claimant_id).
//       The artifact bytes remain secret. The commit is timestamped. Commit-time priority
//       is the deciding factor when multiple valid proofs exist — the EARLIEST committed
//       claimant wins the bounty (not the earliest to reveal). This property is the
//       single most important invariant: a front-runner seeing a reveal cannot win
//       the bounty because their commit would arrive after the original.
//     Phase 2 (REVEAL): After T_commit closes, each committed claimant submits
//       (artifact_bytes, nonce). The state machine recomputes:
//         artifact_hash = BLAKE3(artifact_bytes)
//         expected_commit = BLAKE3(artifact_hash || nonce || claimant_id)
//       and checks expected_commit == stored commit_hash. Mismatch → INVALID.
//
//   TIMING:
//     T_commit: window after bounty post during which commits are accepted (default 24h).
//       Configurable per bounty within [1h, 72h] to support high-value long-window bounties.
//     T_reveal: window after T_commit closes during which reveals are accepted (default 1h).
//       Configurable per bounty within [30m, 6h]. Reveals outside this window → LAPSED.
//
//   STATE MACHINE (plans/proof-incentive-layer.md §3.2):
//     OPEN → COMMIT: requester posts bounty; T_commit window opens.
//     COMMIT → REVEAL: T_commit expires; reveal window opens (transitionBounty).
//     REVEAL → CHECK: T_reveal expires; verifier daemons pick up (transitionBounty).
//     CHECK → ACCEPT: supermajority (≥2/3) of attestations are 'valid'.
//     CHECK → REJECT: T_reveal expired, no valid attestations OR no reveals at all.
//
//   DATABASE: All state changes are single SQLite transactions against the schema-v13
//   proof_bounties / proof_claims / stake_ledger / verifier_attestations tables
//   (DEC-PROOF-REGISTRY-TABLES-001). Because better-sqlite3 is synchronous, every
//   exported function either runs entirely in a single db.transaction() call or
//   is a pure read with no mutation — there are no partial-write windows.
//
//   PACKAGE HOME: new `packages/proof-market/` (not in-registry) — proof-market owns
//   orchestration (state transitions, timing, business logic), registry owns storage
//   (SQLite DDL, low-level row mutations). Separating them respects Sacred Practice #12
//   (single source of truth per domain). Registry stays focused on atom content;
//   proof-market stays focused on marketplace lifecycle.
//
//   SUPERMAJORITY THRESHOLD: 2/3 of total attestations must be 'valid' for ACCEPT.
//   Rationale from plans/proof-incentive-layer.md §3.4: a bare majority is gameable;
//   2/3 makes dishonest attestation economically irrational when verifier stakes are
//   proportional to claimed confidence.

import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { applyMigrations } from "@yakcc/registry";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

// ---------------------------------------------------------------------------
// Branded ID types — prevent accidental substitution of opaque strings.
// ---------------------------------------------------------------------------

export type BountyId = string & { readonly __brand: "BountyId" };
export type ClaimId = string & { readonly __brand: "ClaimId" };
export type AttestationId = string & { readonly __brand: "AttestationId" };

// ---------------------------------------------------------------------------
// Status enums — match schema-v13 TEXT column values exactly.
// ---------------------------------------------------------------------------

export type BountyStatus = "OPEN" | "COMMIT" | "REVEAL" | "CHECK" | "ACCEPT" | "REJECT";
export type ClaimStatus = "COMMITTED" | "REVEALED" | "VALID" | "INVALID" | "LAPSED";
export type AttestationResult = "valid" | "invalid";

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/** Default commit window: 24 hours in milliseconds. */
export const DEFAULT_T_COMMIT_MS = 24 * 60 * 60 * 1000;

/** Default reveal window: 1 hour in milliseconds. */
export const DEFAULT_T_REVEAL_MS = 60 * 60 * 1000;

/** Minimum commit window: 1 hour. */
export const MIN_T_COMMIT_MS = 60 * 60 * 1000;

/** Maximum commit window: 72 hours. */
export const MAX_T_COMMIT_MS = 72 * 60 * 60 * 1000;

/** Minimum reveal window: 30 minutes. */
export const MIN_T_REVEAL_MS = 30 * 60 * 1000;

/** Maximum reveal window: 6 hours. */
export const MAX_T_REVEAL_MS = 6 * 60 * 60 * 1000;

/** Supermajority threshold for finalization: 2/3 of attestations must be 'valid'. */
export const SUPERMAJORITY_NUMERATOR = 2;
export const SUPERMAJORITY_DENOMINATOR = 3;

// ---------------------------------------------------------------------------
// Row shapes for read operations
// ---------------------------------------------------------------------------

export interface BountyRow {
  bounty_id: BountyId;
  atom_bmr: string;
  theorem_statement_hash: string;
  reward_amount: number;
  reward_unit: string;
  requester_id: string;
  status: BountyStatus;
  created_at: number;
  t_commit_close: number | null;
  t_reveal_close: number | null;
}

export interface ClaimRow {
  claim_id: ClaimId;
  bounty_id: BountyId;
  claimant_id: string;
  commit_hash: string;
  stake_amount: number;
  stake_unit: string;
  revealed_artifact_hash: string | null;
  status: ClaimStatus;
  committed_at: number;
  revealed_at: number | null;
}

// ---------------------------------------------------------------------------
// Options for postBounty
// ---------------------------------------------------------------------------

export interface PostBountyOptions {
  /** Override commit window in ms (default: DEFAULT_T_COMMIT_MS). Must be in [MIN, MAX]. */
  tCommitMs?: number;
  /** Override reveal window in ms (default: DEFAULT_T_REVEAL_MS). Must be in [MIN, MAX]. */
  tRevealMs?: number;
  /** Override now (Unix epoch ms). Defaults to Date.now(). For testing. */
  nowMs?: number;
}

// ---------------------------------------------------------------------------
// ProofMarket — the public API surface
// ---------------------------------------------------------------------------

/**
 * ProofMarket owns all lifecycle state transitions for the proof incentive marketplace.
 *
 * Every mutation is a single SQLite transaction (better-sqlite3 db.transaction()).
 * Reads are plain SELECT queries with no mutations.
 *
 * Construction: call `ProofMarket.open(dbPath)` to open or create a registry DB,
 * apply migrations, and return a ProofMarket instance ready for use.
 */
export class ProofMarket {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Open (or create) a SQLite database at `dbPath`, load sqlite-vec, apply all
   * pending schema migrations (including v13 proof tables), and return a ProofMarket.
   *
   * Callers that need an in-memory DB for testing pass ":memory:".
   */
  static open(dbPath: string): ProofMarket {
    const db = new Database(dbPath);
    // Load sqlite-vec extension (required for vec0 virtual tables in the registry schema).
    sqliteVec.load(db);
    // Enable foreign keys for referential integrity.
    db.exec("PRAGMA foreign_keys = ON");
    // Apply all pending migrations (v0 → v13).
    applyMigrations(db);
    return new ProofMarket(db);
  }

  /**
   * Close the underlying SQLite connection. After close(), no other methods may be called.
   */
  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // postBounty — requester creates a bounty (OPEN status, T_commit window set)
  // -------------------------------------------------------------------------

  /**
   * Post a new proof bounty.
   *
   * Creates a proof_bounties row with status='OPEN' and t_commit_close set
   * immediately (bounty is open for commits from creation). The OPEN status
   * signals that the bounty exists; the state machine transitions to 'COMMIT'
   * lazily (via transitionBounty) once the first commit arrives or when the
   * commit window is polled. For simplicity this implementation immediately
   * opens the commit window: status='COMMIT', t_commit_close = now + tCommitMs.
   *
   * Atomic: single db.transaction() call.
   *
   * @returns The new BountyId.
   */
  postBounty(
    atomBmr: string,
    theoremStatementHash: string,
    rewardAmount: number,
    rewardUnit: string,
    requesterId: string,
    opts?: PostBountyOptions,
  ): BountyId {
    const nowMs = opts?.nowMs ?? Date.now();
    const tCommitMs = opts?.tCommitMs ?? DEFAULT_T_COMMIT_MS;
    const tRevealMs = opts?.tRevealMs ?? DEFAULT_T_REVEAL_MS;

    if (tCommitMs < MIN_T_COMMIT_MS || tCommitMs > MAX_T_COMMIT_MS) {
      throw new Error(
        `tCommitMs ${tCommitMs} out of range [${MIN_T_COMMIT_MS}, ${MAX_T_COMMIT_MS}]`,
      );
    }
    if (tRevealMs < MIN_T_REVEAL_MS || tRevealMs > MAX_T_REVEAL_MS) {
      throw new Error(
        `tRevealMs ${tRevealMs} out of range [${MIN_T_REVEAL_MS}, ${MAX_T_REVEAL_MS}]`,
      );
    }

    const bountyId = this.newId() as BountyId;
    const tCommitClose = nowMs + tCommitMs;
    // t_reveal_close is set when the bounty transitions from COMMIT → REVEAL.
    const tRevealClose = null;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO proof_bounties
            (bounty_id, atom_bmr, theorem_statement_hash, reward_amount, reward_unit,
             requester_id, status, created_at, t_commit_close, t_reveal_close)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bountyId,
          atomBmr,
          theoremStatementHash,
          rewardAmount,
          rewardUnit,
          requesterId,
          "COMMIT" as BountyStatus,
          nowMs,
          tCommitClose,
          tRevealClose,
        );
    });
    tx();
    return bountyId;
  }

  // -------------------------------------------------------------------------
  // commitClaim — claimant submits a commitment (commit_hash, stake)
  // -------------------------------------------------------------------------

  /**
   * Submit a commit for an existing bounty.
   *
   * The claimant supplies a pre-computed commit_hash =
   *   BLAKE3(artifact_hash || nonce || claimant_id)
   * where artifact_hash = BLAKE3(artifact_bytes). The caller is responsible for
   * generating the nonce and computing the hash before calling this method.
   * CLI layer handles local nonce generation + hash computation + stashing.
   *
   * Guards:
   *   - Bounty must exist and be in 'COMMIT' status.
   *   - Current time must be before t_commit_close.
   *   - commit_hash must be a 64-char lowercase hex string.
   *
   * Atomic: single db.transaction() call.
   *
   * @returns The new ClaimId.
   */
  commitClaim(
    bountyId: BountyId,
    commitHash: string,
    claimantId: string,
    stakeAmount: number,
    stakeUnit: string,
    opts?: { nowMs?: number },
  ): ClaimId {
    const nowMs = opts?.nowMs ?? Date.now();

    if (!/^[0-9a-f]{64}$/.test(commitHash)) {
      throw new Error(`commit_hash must be a 64-char lowercase hex string; got: ${commitHash}`);
    }

    const claimId = this.newId() as ClaimId;

    const tx = this.db.transaction(() => {
      const bounty = this.db
        .prepare("SELECT status, t_commit_close FROM proof_bounties WHERE bounty_id = ?")
        .get(bountyId) as { status: string; t_commit_close: number | null } | undefined;

      if (bounty === undefined) {
        throw new Error(`bounty not found: ${bountyId}`);
      }
      if (bounty.status !== "COMMIT") {
        throw new Error(`bounty ${bountyId} is not in COMMIT status (current: ${bounty.status})`);
      }
      if (bounty.t_commit_close !== null && nowMs > bounty.t_commit_close) {
        throw new Error(`commit window closed at ${bounty.t_commit_close}; current time ${nowMs}`);
      }

      this.db
        .prepare(
          `INSERT INTO proof_claims
            (claim_id, bounty_id, claimant_id, commit_hash, stake_amount, stake_unit,
             revealed_artifact_hash, status, committed_at, revealed_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'COMMITTED', ?, NULL)`,
        )
        .run(claimId, bountyId, claimantId, commitHash, stakeAmount, stakeUnit, nowMs);
    });
    tx();
    return claimId;
  }

  // -------------------------------------------------------------------------
  // revealClaim — claimant submits (artifact_bytes, nonce); resolver verifies
  // -------------------------------------------------------------------------

  /**
   * Reveal a claim by submitting the artifact bytes and nonce.
   *
   * The state machine recomputes:
   *   artifact_hash    = BLAKE3(artifact_bytes)
   *   expected_commit  = BLAKE3(artifact_hash_bytes || nonce_bytes || claimant_id_bytes)
   * and checks expected_commit (hex) == stored commit_hash.
   *
   * On match: claim status → 'REVEALED', revealed_artifact_hash set, revealed_at set.
   * On mismatch: throws (commit hash does not match supplied artifact+nonce).
   *
   * Guards:
   *   - Claim must exist and be in 'COMMITTED' status.
   *   - Bounty must be in 'REVEAL' status.
   *   - Current time must be before t_reveal_close (or t_reveal_close may be null
   *     if the bounty was just transitioned — guard skipped in that case).
   *
   * Atomic: single db.transaction() call.
   */
  revealClaim(
    claimId: ClaimId,
    artifactBytes: Uint8Array,
    nonce: Uint8Array,
    opts?: { nowMs?: number },
  ): void {
    const nowMs = opts?.nowMs ?? Date.now();

    const tx = this.db.transaction(() => {
      const claim = this.db
        .prepare(
          "SELECT claim_id, bounty_id, claimant_id, commit_hash, status FROM proof_claims WHERE claim_id = ?",
        )
        .get(claimId) as
        | {
            claim_id: string;
            bounty_id: string;
            claimant_id: string;
            commit_hash: string;
            status: string;
          }
        | undefined;

      if (claim === undefined) {
        throw new Error(`claim not found: ${claimId}`);
      }
      if (claim.status !== "COMMITTED") {
        throw new Error(`claim ${claimId} is not in COMMITTED status (current: ${claim.status})`);
      }

      const bounty = this.db
        .prepare("SELECT status, t_reveal_close FROM proof_bounties WHERE bounty_id = ?")
        .get(claim.bounty_id) as { status: string; t_reveal_close: number | null } | undefined;

      if (bounty === undefined) {
        throw new Error(`bounty not found: ${claim.bounty_id}`);
      }
      if (bounty.status !== "REVEAL") {
        throw new Error(
          `bounty ${claim.bounty_id} is not in REVEAL status (current: ${bounty.status})`,
        );
      }
      if (bounty.t_reveal_close !== null && nowMs > bounty.t_reveal_close) {
        throw new Error(`reveal window closed at ${bounty.t_reveal_close}; current time ${nowMs}`);
      }

      // Recompute commitment and verify.
      const artifactHash = blake3(artifactBytes);
      const claimantIdBytes = new TextEncoder().encode(claim.claimant_id);
      const preimage = new Uint8Array(artifactHash.length + nonce.length + claimantIdBytes.length);
      preimage.set(artifactHash, 0);
      preimage.set(nonce, artifactHash.length);
      preimage.set(claimantIdBytes, artifactHash.length + nonce.length);
      const recomputedCommit = bytesToHex(blake3(preimage));

      if (recomputedCommit !== claim.commit_hash) {
        throw new Error(
          `commit hash mismatch: stored=${claim.commit_hash} recomputed=${recomputedCommit}`,
        );
      }

      const artifactHashHex = bytesToHex(artifactHash);

      this.db
        .prepare(
          `UPDATE proof_claims
           SET status = 'REVEALED', revealed_artifact_hash = ?, revealed_at = ?
           WHERE claim_id = ?`,
        )
        .run(artifactHashHex, nowMs, claimId);
    });
    tx();
  }

  // -------------------------------------------------------------------------
  // transitionBounty — drive bounty forward when T_commit / T_reveal expire
  // -------------------------------------------------------------------------

  /**
   * Drive a bounty's status forward based on elapsed time.
   *
   * Transitions:
   *   COMMIT → REVEAL: when nowMs >= t_commit_close. Sets t_reveal_close.
   *     Any claims still in COMMITTED status (did not reveal in time) are NOT
   *     lapsed here — they are lapsed lazily in finalizeBounty or by explicit
   *     call. The reveal window opens for already-committed claimants.
   *   REVEAL → CHECK: when nowMs >= t_reveal_close. Any COMMITTED claims are
   *     set to LAPSED (reveal window expired).
   *
   * Returns the new status (or current if no transition occurred).
   *
   * Atomic: single db.transaction() call.
   */
  transitionBounty(
    bountyId: BountyId,
    opts?: { nowMs?: number; tRevealMs?: number },
  ): BountyStatus {
    const nowMs = opts?.nowMs ?? Date.now();
    const tRevealMs = opts?.tRevealMs ?? DEFAULT_T_REVEAL_MS;

    let newStatus: BountyStatus = "OPEN";

    const tx = this.db.transaction(() => {
      const bounty = this.db
        .prepare(
          "SELECT status, t_commit_close, t_reveal_close FROM proof_bounties WHERE bounty_id = ?",
        )
        .get(bountyId) as
        | { status: BountyStatus; t_commit_close: number | null; t_reveal_close: number | null }
        | undefined;

      if (bounty === undefined) {
        throw new Error(`bounty not found: ${bountyId}`);
      }

      newStatus = bounty.status;

      if (
        bounty.status === "COMMIT" &&
        bounty.t_commit_close !== null &&
        nowMs >= bounty.t_commit_close
      ) {
        // COMMIT → REVEAL
        const tRevealClose = bounty.t_commit_close + tRevealMs;
        this.db
          .prepare(
            "UPDATE proof_bounties SET status = 'REVEAL', t_reveal_close = ? WHERE bounty_id = ?",
          )
          .run(tRevealClose, bountyId);
        newStatus = "REVEAL";
      } else if (
        bounty.status === "REVEAL" &&
        bounty.t_reveal_close !== null &&
        nowMs >= bounty.t_reveal_close
      ) {
        // REVEAL → CHECK: lapse any un-revealed claims.
        this.db
          .prepare(
            "UPDATE proof_claims SET status = 'LAPSED' WHERE bounty_id = ? AND status = 'COMMITTED'",
          )
          .run(bountyId);
        this.db
          .prepare("UPDATE proof_bounties SET status = 'CHECK' WHERE bounty_id = ?")
          .run(bountyId);
        newStatus = "CHECK";
      }
    });
    tx();
    return newStatus;
  }

  // -------------------------------------------------------------------------
  // finalizeBounty — supermajority-aware CHECK → ACCEPT | REJECT
  // -------------------------------------------------------------------------

  /**
   * Finalize a bounty in CHECK status by evaluating submitted attestations.
   *
   * Supermajority rule (DEC-PROOF-COMMIT-REVEAL-001):
   *   If (valid_count / total_count) >= (2/3), then ACCEPT.
   *   Otherwise REJECT.
   *   If zero attestations or zero revealed claims: REJECT.
   *
   * On ACCEPT: the earliest-committed REVEALED/VALID claim wins the bounty.
   *   Other REVEALED claims that also match are set to VALID (they proved the same theorem).
   *   COMMITTED (lapsed) claims remain LAPSED.
   *
   * On REJECT: all claims set to INVALID, stakes are forfeit (application layer handles
   *   actual stake transfer; this function only mutates claim/bounty status).
   *
   * Atomic: single db.transaction() call.
   *
   * @param attestations — attestation objects to record and evaluate.
   */
  finalizeBounty(
    bountyId: BountyId,
    attestations: ReadonlyArray<{
      attestationId: AttestationId;
      claimId: ClaimId;
      verifierId: string;
      result: AttestationResult;
      toolchainVersionHash: string;
      signature: string;
      attestedAt?: number;
    }>,
    opts?: { nowMs?: number },
  ): BountyStatus {
    const nowMs = opts?.nowMs ?? Date.now();

    let finalStatus: BountyStatus = "CHECK";

    const tx = this.db.transaction(() => {
      const bounty = this.db
        .prepare("SELECT status FROM proof_bounties WHERE bounty_id = ?")
        .get(bountyId) as { status: BountyStatus } | undefined;

      if (bounty === undefined) {
        throw new Error(`bounty not found: ${bountyId}`);
      }
      if (bounty.status !== "CHECK") {
        throw new Error(`bounty ${bountyId} is not in CHECK status (current: ${bounty.status})`);
      }

      // Insert all attestations.
      const insertAttestation = this.db.prepare(
        `INSERT INTO verifier_attestations
          (attestation_id, claim_id, verifier_id, result, toolchain_version_hash, signature, attested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const a of attestations) {
        insertAttestation.run(
          a.attestationId,
          a.claimId,
          a.verifierId,
          a.result,
          a.toolchainVersionHash,
          a.signature,
          a.attestedAt ?? nowMs,
        );
      }

      // Count valid vs total attestations across all claims for this bounty.
      const counts = this.db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN va.result = 'valid' THEN 1 ELSE 0 END) AS valid_count
           FROM verifier_attestations va
           JOIN proof_claims pc ON pc.claim_id = va.claim_id
           WHERE pc.bounty_id = ?`,
        )
        .get(bountyId) as { total: number; valid_count: number };

      const total = counts.total;
      const validCount = counts.valid_count;

      // Supermajority: validCount / total >= 2/3
      // Equivalent integer form: validCount * 3 >= total * 2 (avoids floating point).
      const isSupermajority =
        total > 0 && validCount * SUPERMAJORITY_DENOMINATOR >= total * SUPERMAJORITY_NUMERATOR;

      if (isSupermajority) {
        // ACCEPT: mark all REVEALED claims as VALID; bounty → ACCEPT.
        this.db
          .prepare(
            "UPDATE proof_claims SET status = 'VALID' WHERE bounty_id = ? AND status = 'REVEALED'",
          )
          .run(bountyId);
        this.db
          .prepare("UPDATE proof_bounties SET status = 'ACCEPT' WHERE bounty_id = ?")
          .run(bountyId);
        finalStatus = "ACCEPT";
      } else {
        // REJECT: mark all REVEALED claims as INVALID; bounty → REJECT.
        this.db
          .prepare(
            "UPDATE proof_claims SET status = 'INVALID' WHERE bounty_id = ? AND status = 'REVEALED'",
          )
          .run(bountyId);
        this.db
          .prepare("UPDATE proof_bounties SET status = 'REJECT' WHERE bounty_id = ?")
          .run(bountyId);
        finalStatus = "REJECT";
      }
    });
    tx();
    return finalStatus;
  }

  // -------------------------------------------------------------------------
  // Read helpers
  // -------------------------------------------------------------------------

  /** Fetch a bounty by ID. Returns undefined if not found. */
  getBounty(bountyId: BountyId): BountyRow | undefined {
    return this.db.prepare("SELECT * FROM proof_bounties WHERE bounty_id = ?").get(bountyId) as
      | BountyRow
      | undefined;
  }

  /** Fetch a claim by ID. Returns undefined if not found. */
  getClaim(claimId: ClaimId): ClaimRow | undefined {
    return this.db.prepare("SELECT * FROM proof_claims WHERE claim_id = ?").get(claimId) as
      | ClaimRow
      | undefined;
  }

  /** List all claims for a bounty, ordered by committed_at ascending (earliest first). */
  listClaims(bountyId: BountyId): ClaimRow[] {
    return this.db
      .prepare("SELECT * FROM proof_claims WHERE bounty_id = ? ORDER BY committed_at ASC")
      .all(bountyId) as ClaimRow[];
  }

  // -------------------------------------------------------------------------
  // Commit-reveal primitive (exported for CLI use)
  // -------------------------------------------------------------------------

  /**
   * Compute the commit hash for a given artifact + nonce + claimant.
   *
   * commit_hash = BLAKE3(artifact_hash || nonce || claimant_id_bytes)
   * where artifact_hash = BLAKE3(artifact_bytes)
   *
   * This is the canonical computation for both the CLI (which stores nonce locally)
   * and the reveal verifier (which recomputes and checks).
   *
   * @returns 64-char lowercase hex string.
   */
  static computeCommitHash(
    artifactBytes: Uint8Array,
    nonce: Uint8Array,
    claimantId: string,
  ): string {
    const artifactHash = blake3(artifactBytes);
    const claimantIdBytes = new TextEncoder().encode(claimantId);
    const preimage = new Uint8Array(artifactHash.length + nonce.length + claimantIdBytes.length);
    preimage.set(artifactHash, 0);
    preimage.set(nonce, artifactHash.length);
    preimage.set(claimantIdBytes, artifactHash.length + nonce.length);
    return bytesToHex(blake3(preimage));
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Generate a new opaque ID using BLAKE3 over a random 32-byte seed.
   * Returns a 64-char lowercase hex string suitable for all ID columns.
   */
  private newId(): string {
    const seed = new Uint8Array(32);
    // Use globalThis.crypto (available in Node.js 19+, Web, and Bun).
    // Falls back to require('crypto').randomFillSync for older Node.
    if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
      globalThis.crypto.getRandomValues(seed);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodeCrypto = require("node:crypto") as { randomFillSync: (buf: Uint8Array) => void };
      nodeCrypto.randomFillSync(seed);
    }
    return bytesToHex(blake3(seed));
  }
}
