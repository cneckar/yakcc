// SPDX-License-Identifier: MIT
//
// retraction.ts — counter-proof admission (Slice F) for the yakcc proof incentive layer.
//
// @decision DEC-PROOF-RETRACTION-001
// @title Counter-proof admission as a post-ACCEPT retraction state machine
// @status decided (WI-1087 / issue #1087 / plans/proof-incentive-layer.md §3.3 + §4 Slice F)
// @rationale
//   PROBLEM: Even after a proof has been ACCEPTED via supermajority attestation, the
//   underlying acceptance can be wrong — checker bugs, spec ambiguities, or malicious
//   checker collusion. Without a retraction mechanism, a bad proof permanently poisons
//   the atom's proof status.
//
//   SOLUTION: Post-ACCEPT counter-proof admission. Anyone may file a RETRACTION_CLAIM
//   against an accepted proof by providing:
//     1. A stake of at least RETRACTION_STAKE_MULTIPLIER × original_claim_stake.
//     2. An evidence artifact hash (counter-example, proof-of-falshood, or proof of
//        checker malfeasance).
//
//   STATE MACHINE (plans/proof-incentive-layer.md §3.3):
//     ACCEPT (on proof_bounties) → RETRACTION_PENDING → RETRACTED | REJECTED
//     where "RETRACTION_PENDING" is represented by proof_retractions.status = 'PENDING'.
//
//   ASYMMETRIC STAKE (key disincentive against frivolous retractions):
//     retractor_stake >= RETRACTION_STAKE_MULTIPLIER × original_claim_stake
//     Default multiplier: 2. Configurable via fileRetraction opts.
//
//   TIME-LOCKED FILING WINDOW:
//     Retractions must be filed within T_RETRACTION_MS (default 90 days) of the original
//     claim's acceptance (approximated here as the time it was marked VALID, i.e.
//     revealed_at of the original claim). After this window, a higher-cost sealed-retraction
//     path (not yet implemented) would be required per §3.3.
//
//   SLASH DECAY (proportional time-decay):
//     The original claimant's reward is slashed proportionally to time elapsed since
//     acceptance. The decay uses an exponential half-life:
//       slash_fraction = exp(-ln(2) × elapsed_ms / RETRACTION_SLASH_HALF_LIFE_MS)
//     At elapsed=0 (caught immediately): slash_fraction ≈ 1.0 (full slash).
//     At elapsed=HALF_LIFE (30 days): slash_fraction ≈ 0.5 (half slash).
//     At elapsed=90 days: slash_fraction ≈ 0.13 (small slash near window close).
//
//   SLASH DISTRIBUTION (DEC-PROOF-RETRACTION-001 sub-decision):
//     This is the ONE exception to "slashing-to-treasury" (plans §11 decision log):
//       - retractor_reward = slash_amount × RETRACTION_REWARD_FRACTION (default 0.5)
//       - treasury_amount  = slash_amount × (1 - RETRACTION_REWARD_FRACTION)
//     Justified because: (a) the retractor performed valuable work the verifier missed;
//     (b) without a reward, nobody would file retractions; (c) asymmetric stake prevents
//     grief at scale.
//     On REJECTED retraction: retractor stake forfeited (NOT transferred — same
//     slashing-as-deprecation rule as failed claims).
//
//   CONCURRENT RETRACTIONS (see schema DEC-PROOF-RETRACTION-001 sub-decision):
//     Multiple concurrent retractions on the same claim are allowed. Once any retraction
//     resolves to RETRACTED, subsequent PENDING retractions on the same claim are
//     auto-REJECTED (the proof is already retracted; retractors should not be double-paid).
//
//   DATABASE: All state changes are single SQLite transactions against the schema-v14
//   proof_retractions table (MIGRATION_14_DDL, DEC-PROOF-RETRACTION-001). same
//   pattern as ProofMarket (proof-market.ts).

import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { applyMigrations } from "@yakcc/registry";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

// ---------------------------------------------------------------------------
// Branded ID type
// ---------------------------------------------------------------------------

export type RetractionId = string & { readonly __brand: "RetractionId" };

// ---------------------------------------------------------------------------
// Status enum — matches schema-v14 TEXT column values exactly.
// ---------------------------------------------------------------------------

export type RetractionStatus = "PENDING" | "RETRACTED" | "REJECTED";

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/** Default retraction filing window: 90 days in milliseconds. */
export const T_RETRACTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Minimum stake multiplier: retractor_stake >= MULTIPLIER × original_claim_stake. */
export const RETRACTION_STAKE_MULTIPLIER = 2;

/**
 * Slash half-life: 30 days in milliseconds.
 * At elapsed=0: slash_fraction ≈ 1.0.
 * At elapsed=30d: slash_fraction ≈ 0.5.
 * Formula: slash_fraction = 2^(-elapsed_ms / RETRACTION_SLASH_HALF_LIFE_MS)
 */
export const RETRACTION_SLASH_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Fraction of the slashed amount that goes to the retractor (the ONE exception to
 * slashing-to-treasury). The remainder goes to the operator treasury.
 * Default: 0.5 (retractor gets half the slash; treasury gets the other half).
 */
export const RETRACTION_REWARD_FRACTION = 0.5;

// ---------------------------------------------------------------------------
// Row shapes for read operations
// ---------------------------------------------------------------------------

export interface RetractionRow {
  retraction_id: RetractionId;
  original_claim_id: string;
  retractor_id: string;
  stake_amount: number;
  stake_unit: string;
  evidence_artifact_hash: string | null;
  status: RetractionStatus;
  filed_at: number;
  resolved_at: number | null;
}

/**
 * Result of resolving a retraction. Contains the computed slash and reward amounts
 * so the application layer can apply actual stake transfers.
 */
export interface RetractionResolution {
  retractionId: RetractionId;
  originalClaimId: string;
  status: "RETRACTED" | "REJECTED";
  /** Non-zero only for RETRACTED. Integer slash amount (from original reward). */
  slashAmount: number;
  /** Non-zero only for RETRACTED. Goes to the retractor (slashAmount × RETRACTION_REWARD_FRACTION). */
  retractorReward: number;
  /** Non-zero only for RETRACTED. Goes to operator treasury. */
  treasuryAmount: number;
  /** Elapsed time in ms between original acceptance and retraction resolution. */
  elapsedMs: number;
  /** Computed slash fraction [0.0, 1.0]. */
  slashFraction: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FileRetractionOptions {
  /** Override now (Unix epoch ms). Defaults to Date.now(). For testing. */
  nowMs?: number;
  /**
   * Override stake multiplier requirement (default: RETRACTION_STAKE_MULTIPLIER = 2).
   * retractor_stake must be >= stakeMultiplier × original_claim_stake.
   */
  stakeMultiplier?: number;
  /** Override retraction window in ms (default: T_RETRACTION_MS = 90 days). */
  tRetractionMs?: number;
}

export interface ResolveRetractionOptions {
  /** Override now (Unix epoch ms). Defaults to Date.now(). For testing. */
  nowMs?: number;
  /**
   * The original bounty reward amount. Used to compute the slash amount.
   * If not provided, slash is computed from original claim stake_amount as a proxy.
   */
  originalRewardAmount?: number;
}

// ---------------------------------------------------------------------------
// RetractionMarket — public API surface
// ---------------------------------------------------------------------------

/**
 * RetractionMarket owns the counter-proof admission lifecycle (Slice F).
 *
 * Every mutation is a single SQLite transaction (better-sqlite3 db.transaction()).
 * Reads are plain SELECT queries.
 *
 * Construction: call `RetractionMarket.open(dbPath)` or, more typically, pass an
 * already-open Database instance via `RetractionMarket.fromDb(db)` when sharing a
 * DB with ProofMarket.
 *
 * IMPORTANT: The database must have migrations up to v14 applied before use.
 * `RetractionMarket.open()` applies them automatically. If you construct via
 * `fromDb()`, call `applyMigrations(db)` beforehand.
 */
export class RetractionMarket {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Open (or create) a SQLite database at `dbPath`, load sqlite-vec, apply all
   * pending schema migrations (including v14 proof_retractions), and return a
   * RetractionMarket.
   *
   * Pass ":memory:" for in-memory databases (testing).
   */
  static open(dbPath: string): RetractionMarket {
    const db = new Database(dbPath);
    sqliteVec.load(db);
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db);
    return new RetractionMarket(db);
  }

  /**
   * Wrap an already-open Database instance.
   * The caller is responsible for having applied applyMigrations() and loaded sqlite-vec.
   * Useful when sharing a single DB with ProofMarket.
   */
  static fromDb(db: Database.Database): RetractionMarket {
    return new RetractionMarket(db);
  }

  /** Close the underlying SQLite connection. */
  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // fileRetraction — retractor opens a retraction challenge against an accepted claim
  // -------------------------------------------------------------------------

  /**
   * File a retraction against an accepted proof claim.
   *
   * Guards (all enforced atomically inside a transaction):
   *   1. The original claim must exist and be in 'VALID' status (ACCEPT path).
   *   2. The retraction stake must be >= stakeMultiplier × original_claim_stake.
   *   3. The filing time must be within the retraction window:
   *        filed_at <= accepted_at + tRetractionMs
   *      (accepted_at is approximated as the claim's revealed_at; if null, the
   *       claim is not yet in an accepted state and retraction is rejected).
   *
   * Atomic: single db.transaction() call.
   *
   * @returns The new RetractionId.
   */
  fileRetraction(
    originalClaimId: string,
    retractorId: string,
    stake: number,
    unit: string,
    evidenceArtifactHash: string | null,
    opts?: FileRetractionOptions,
  ): RetractionId {
    const nowMs = opts?.nowMs ?? Date.now();
    const stakeMultiplier = opts?.stakeMultiplier ?? RETRACTION_STAKE_MULTIPLIER;
    const tRetractionMs = opts?.tRetractionMs ?? T_RETRACTION_MS;

    const retractionId = this.newId() as RetractionId;

    const tx = this.db.transaction(() => {
      // Load original claim.
      const claim = this.db
        .prepare("SELECT claim_id, stake_amount, stake_unit, status, revealed_at FROM proof_claims WHERE claim_id = ?")
        .get(originalClaimId) as
        | {
            claim_id: string;
            stake_amount: number;
            stake_unit: string;
            status: string;
            revealed_at: number | null;
          }
        | undefined;

      if (claim === undefined) {
        throw new Error(`claim not found: ${originalClaimId}`);
      }
      if (claim.status !== "VALID") {
        throw new Error(
          `claim ${originalClaimId} is not in VALID status (current: ${claim.status}); ` +
          `retraction requires an accepted (VALID) claim`,
        );
      }

      // Guard 2: asymmetric stake check.
      const minStake = stakeMultiplier * claim.stake_amount;
      if (stake < minStake) {
        throw new Error(
          `retraction stake ${stake} is less than required minimum ` +
          `${stakeMultiplier}× original stake ${claim.stake_amount} = ${minStake}`,
        );
      }

      // Guard 3: time-lock window check.
      // accepted_at is approximated as revealed_at (the time the artifact was revealed,
      // which is the closest timestamp to when the claim was accepted). If revealed_at
      // is null the claim hasn't been properly accepted yet and we fail defensively.
      const acceptedAt = claim.revealed_at;
      if (acceptedAt === null) {
        throw new Error(
          `claim ${originalClaimId} has no revealed_at timestamp; cannot determine acceptance time`,
        );
      }
      const windowClose = acceptedAt + tRetractionMs;
      if (nowMs > windowClose) {
        throw new Error(
          `retraction window closed at ${windowClose} (${tRetractionMs}ms after accepted_at=${acceptedAt}); ` +
          `current time ${nowMs}. A sealed-retraction path (10× stake) is required beyond this window.`,
        );
      }

      // Insert the retraction row.
      this.db
        .prepare(
          `INSERT INTO proof_retractions
            (retraction_id, original_claim_id, retractor_id, stake_amount, stake_unit,
             evidence_artifact_hash, status, filed_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, NULL)`,
        )
        .run(retractionId, originalClaimId, retractorId, stake, unit, evidenceArtifactHash, nowMs);
    });
    tx();
    return retractionId;
  }

  // -------------------------------------------------------------------------
  // resolveRetraction — verifier attestations drive the retraction to terminal state
  // -------------------------------------------------------------------------

  /**
   * Resolve a PENDING retraction using verifier attestations (same supermajority
   * pattern as finalizeBounty in proof-market.ts).
   *
   * Supermajority rule (matching DEC-PROOF-COMMIT-REVEAL-001):
   *   valid_count / total_count >= 2/3 → RETRACTED
   *   otherwise → REJECTED
   *   zero attestations → REJECTED
   *
   * On RETRACTED:
   *   - slash_fraction = 2^(-elapsed_ms / RETRACTION_SLASH_HALF_LIFE_MS)
   *   - slash_amount   = round(originalRewardAmount × slash_fraction)
   *   - retractor_reward = round(slash_amount × RETRACTION_REWARD_FRACTION)
   *   - treasury_amount  = slash_amount - retractor_reward
   *   - retraction row status → 'RETRACTED', resolved_at = nowMs
   *   - If any OTHER pending retractions exist on the same claim, they are auto-REJECTED
   *     (the proof is already retracted; concurrent retractors lose their stakes).
   *
   * On REJECTED:
   *   - retraction row status → 'REJECTED', resolved_at = nowMs
   *   - retractor stake is forfeit to operator treasury (application layer handles transfer;
   *     this function mutates status only).
   *
   * NOTE: If the claim already has a RETRACTED retraction (i.e., this is a concurrent
   * retraction on an already-retracted claim), it is auto-REJECTED immediately without
   * evaluating attestations (the proof is already retracted; the bet is moot).
   *
   * Atomic: single db.transaction() call.
   *
   * @returns RetractionResolution with slash amounts for the application layer.
   */
  resolveRetraction(
    retractionId: RetractionId,
    attestations: ReadonlyArray<{
      verifierId: string;
      result: "valid" | "invalid";
    }>,
    opts?: ResolveRetractionOptions,
  ): RetractionResolution {
    const nowMs = opts?.nowMs ?? Date.now();

    let resolution: RetractionResolution | null = null;

    const tx = this.db.transaction(() => {
      // Load the retraction.
      const retraction = this.db
        .prepare(
          "SELECT retraction_id, original_claim_id, retractor_id, stake_amount, filed_at, status FROM proof_retractions WHERE retraction_id = ?",
        )
        .get(retractionId) as
        | {
            retraction_id: string;
            original_claim_id: string;
            retractor_id: string;
            stake_amount: number;
            filed_at: number;
            status: string;
          }
        | undefined;

      if (retraction === undefined) {
        throw new Error(`retraction not found: ${retractionId}`);
      }
      if (retraction.status !== "PENDING") {
        throw new Error(
          `retraction ${retractionId} is not PENDING (current: ${retraction.status})`,
        );
      }

      // Load the original claim for accepted_at (revealed_at proxy) and reward info.
      const claim = this.db
        .prepare("SELECT claim_id, stake_amount, revealed_at FROM proof_claims WHERE claim_id = ?")
        .get(retraction.original_claim_id) as
        | { claim_id: string; stake_amount: number; revealed_at: number | null }
        | undefined;

      if (claim === undefined) {
        throw new Error(`original claim not found: ${retraction.original_claim_id}`);
      }

      // Check if there is already a RETRACTED retraction on this claim (concurrent case).
      const alreadyRetracted = this.db
        .prepare(
          "SELECT retraction_id FROM proof_retractions WHERE original_claim_id = ? AND status = 'RETRACTED' LIMIT 1",
        )
        .get(retraction.original_claim_id) as { retraction_id: string } | undefined;

      if (alreadyRetracted !== undefined) {
        // Proof already retracted by a concurrent retraction — auto-REJECT this one.
        this.db
          .prepare(
            "UPDATE proof_retractions SET status = 'REJECTED', resolved_at = ? WHERE retraction_id = ?",
          )
          .run(nowMs, retractionId);
        resolution = {
          retractionId,
          originalClaimId: retraction.original_claim_id,
          status: "REJECTED",
          slashAmount: 0,
          retractorReward: 0,
          treasuryAmount: 0,
          elapsedMs: 0,
          slashFraction: 0,
        };
        return;
      }

      // Evaluate supermajority on provided attestations.
      const total = attestations.length;
      const validCount = attestations.filter((a) => a.result === "valid").length;

      // Supermajority: validCount / total >= 2/3
      // Integer form: validCount * 3 >= total * 2 (avoids floating point).
      const isSupermajority = total > 0 && validCount * 3 >= total * 2;

      if (!isSupermajority) {
        // REJECTED: retractor stake forfeit (application layer transfers).
        this.db
          .prepare(
            "UPDATE proof_retractions SET status = 'REJECTED', resolved_at = ? WHERE retraction_id = ?",
          )
          .run(nowMs, retractionId);
        resolution = {
          retractionId,
          originalClaimId: retraction.original_claim_id,
          status: "REJECTED",
          slashAmount: 0,
          retractorReward: 0,
          treasuryAmount: 0,
          elapsedMs: 0,
          slashFraction: 0,
        };
        return;
      }

      // RETRACTED: compute time-decay slash.
      const acceptedAt = claim.revealed_at ?? retraction.filed_at;
      const elapsedMs = Math.max(0, nowMs - acceptedAt);
      // Exponential half-life decay: slash_fraction = 2^(-elapsed / half_life)
      const slashFraction = Math.pow(2, -(elapsedMs / RETRACTION_SLASH_HALF_LIFE_MS));

      // Slash base is the original reward amount if provided; else original claim stake.
      const rewardBase = opts?.originalRewardAmount ?? claim.stake_amount;
      const slashAmount = Math.round(rewardBase * slashFraction);
      const retractorReward = Math.round(slashAmount * RETRACTION_REWARD_FRACTION);
      const treasuryAmount = slashAmount - retractorReward;

      // Mark this retraction RETRACTED.
      this.db
        .prepare(
          "UPDATE proof_retractions SET status = 'RETRACTED', resolved_at = ? WHERE retraction_id = ?",
        )
        .run(nowMs, retractionId);

      // Auto-REJECT all other PENDING retractions on the same claim (concurrent retractions
      // lose their bet now that the proof is retracted — they each independently staked against
      // the same proof but a different retractor got there first).
      this.db
        .prepare(
          "UPDATE proof_retractions SET status = 'REJECTED', resolved_at = ? " +
          "WHERE original_claim_id = ? AND status = 'PENDING' AND retraction_id != ?",
        )
        .run(nowMs, retraction.original_claim_id, retractionId);

      resolution = {
        retractionId,
        originalClaimId: retraction.original_claim_id,
        status: "RETRACTED",
        slashAmount,
        retractorReward,
        treasuryAmount,
        elapsedMs,
        slashFraction,
      };
    });
    tx();

    if (resolution === null) {
      // This branch is unreachable by construction (every path in the tx sets resolution),
      // but TypeScript requires a return-type guard.
      throw new Error("internal error: resolution not set after transaction");
    }
    return resolution;
  }

  // -------------------------------------------------------------------------
  // Read helpers
  // -------------------------------------------------------------------------

  /** Fetch a retraction by ID. Returns undefined if not found. */
  getRetraction(retractionId: RetractionId): RetractionRow | undefined {
    return this.db
      .prepare("SELECT * FROM proof_retractions WHERE retraction_id = ?")
      .get(retractionId) as RetractionRow | undefined;
  }

  /** List all retractions for a given original claim, ordered by filed_at ascending. */
  listRetractions(originalClaimId: string): RetractionRow[] {
    return this.db
      .prepare(
        "SELECT * FROM proof_retractions WHERE original_claim_id = ? ORDER BY filed_at ASC",
      )
      .all(originalClaimId) as RetractionRow[];
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Compute the time-decay slash fraction for a given elapsed time.
   *
   * slash_fraction = 2^(-elapsed_ms / RETRACTION_SLASH_HALF_LIFE_MS)
   *
   * At elapsed=0: fraction=1.0 (full slash).
   * At elapsed=HALF_LIFE: fraction=0.5.
   * Exported as a static helper so tests can verify the math independently.
   */
  static computeSlashFraction(elapsedMs: number): number {
    return Math.pow(2, -(elapsedMs / RETRACTION_SLASH_HALF_LIFE_MS));
  }

  /**
   * Generate a new opaque ID using BLAKE3 over a random 32-byte seed.
   * Returns a 64-char lowercase hex string.
   */
  private newId(): string {
    const seed = new Uint8Array(32);
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
