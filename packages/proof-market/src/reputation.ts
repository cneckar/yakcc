// SPDX-License-Identifier: MIT
//
// Reputation ledger consumers for the proof-incentive market.
//
// @decision DEC-PROOF-STAKE-ECONOMICS-001 (implementation site)
// @title Reputation ledger consumers — accrue / slash / decay / bootstrap / sybil
// @status accepted (Slice E implementation, #1085)
// @rationale
//   Implementation of the reputation track specified in
//   docs/proof-incentive-economics.md. The spec is authoritative; this module
//   mirrors the spec's accrual rates, decay half-life, slash semantics, and
//   sybil-resistance rules. If the spec changes, the constants below must
//   change to match.
//
//   Key invariants:
//   1. Reputation is non-transferable. slashReputation() decrements an
//      account's balance without writing to any other account.
//   2. Bootstrap grant (100 RC) is one-time per account, gated on absence of
//      any row in reputation_ledger.
//   3. Linear half-life decay (180 days) is applied at read time. The stored
//      `score` is an undecayed checkpoint; readers see the decayed value.
//   4. Sybil rate-limit (5 concurrent active claims per account) is enforced
//      via checkSybilLimit() which the lifecycle (commitClaim) must call.
//
// Issue: #1085 (Slice E impl). Plan: plans/proof-incentive-layer.md §4 Slice E.
// Authority: docs/proof-incentive-economics.md.

import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Accrual constants (mirror of economics spec § 2)
// ---------------------------------------------------------------------------

/** +5 RC per accepted atom submission. */
export const RC_ATOM_ACCEPTED = 5;

/** +50 RC per accepted proof claim. 10× atom because proofs are scarcer. */
export const RC_PROOF_CLAIM_ACCEPTED = 50;

/** +2 RC per correct verifier attestation. */
export const RC_VERIFIER_ATTESTATION_CORRECT = 2;

/** −100 RC per slashed claim. */
export const RC_CLAIM_SLASHED = -100;

/** −10 RC per dissenting verifier attestation. */
export const RC_VERIFIER_DISSENT = -10;

/** Bootstrap grant: new accounts get this on first event (one-time). */
export const RC_BOOTSTRAP_GRANT = 100;

/** Decay half-life in milliseconds. 180 days, linear half-life. */
export const RC_HALF_LIFE_MS = 180 * 24 * 60 * 60 * 1000;

/** Maximum concurrent active claims per account before sybil rate-limit fires. */
export const SYBIL_MAX_ACTIVE_CLAIMS = 5;

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type ReputationEvent =
  | "atom_accepted"
  | "proof_claim_accepted"
  | "verifier_attestation_correct"
  | "claim_slashed"
  | "verifier_dissent";

const EVENT_DELTAS: Record<ReputationEvent, number> = {
  atom_accepted: RC_ATOM_ACCEPTED,
  proof_claim_accepted: RC_PROOF_CLAIM_ACCEPTED,
  verifier_attestation_correct: RC_VERIFIER_ATTESTATION_CORRECT,
  claim_slashed: RC_CLAIM_SLASHED,
  verifier_dissent: RC_VERIFIER_DISSENT,
};

/** Public lookup so callers can preview the delta a given event will apply. */
export function reputationDeltaForEvent(event: ReputationEvent): number {
  return EVENT_DELTAS[event];
}

// ---------------------------------------------------------------------------
// Time abstraction (so tests can inject synthetic timestamps)
// ---------------------------------------------------------------------------

export interface ReputationClock {
  now(): number;
}

const REAL_CLOCK: ReputationClock = {
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function accrueReputation(
  db: Database.Database,
  account_id: string,
  event: ReputationEvent,
  clock: ReputationClock = REAL_CLOCK,
): number {
  bootstrapGrantIfNeeded(db, account_id, clock);
  applyReputationDelta(db, account_id, EVENT_DELTAS[event], clock.now());
  return getReputation(db, account_id, clock);
}

export function slashReputation(
  db: Database.Database,
  account_id: string,
  amount: number,
  _reason: string,
  clock: ReputationClock = REAL_CLOCK,
): number {
  if (amount <= 0) {
    throw new TypeError(`slashReputation: amount must be positive, got ${amount}`);
  }
  bootstrapGrantIfNeeded(db, account_id, clock);
  applyReputationDelta(db, account_id, -amount, clock.now());
  return getReputation(db, account_id, clock);
}

export function getReputation(
  db: Database.Database,
  account_id: string,
  clock: ReputationClock = REAL_CLOCK,
): number {
  const row = db
    .prepare("SELECT score, last_event_at FROM reputation_ledger WHERE account_id = ?")
    .get(account_id) as { score: number; last_event_at: number } | undefined;
  if (row === undefined) return 0;
  const elapsed = clock.now() - row.last_event_at;
  if (elapsed <= 0) return row.score;
  const halfLives = elapsed / RC_HALF_LIFE_MS;
  return row.score * Math.pow(0.5, halfLives);
}

export function applyDecay(
  db: Database.Database,
  account_id: string,
  clock: ReputationClock = REAL_CLOCK,
): number {
  const decayed = getReputation(db, account_id, clock);
  db.prepare(
    "UPDATE reputation_ledger SET score = ?, last_event_at = ? WHERE account_id = ?",
  ).run(decayed, clock.now(), account_id);
  return decayed;
}

export function bootstrapGrantIfNeeded(
  db: Database.Database,
  account_id: string,
  clock: ReputationClock = REAL_CLOCK,
): boolean {
  const existing = db
    .prepare("SELECT 1 FROM reputation_ledger WHERE account_id = ?")
    .get(account_id);
  if (existing !== undefined) return false;
  db.prepare(
    "INSERT INTO reputation_ledger (account_id, score, last_event_at) VALUES (?, ?, ?)",
  ).run(account_id, RC_BOOTSTRAP_GRANT, clock.now());
  return true;
}

export function checkSybilLimit(db: Database.Database, account_id: string): void {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM proof_claims WHERE claimant_id = ? AND status IN ('COMMITTED', 'REVEALED')",
    )
    .get(account_id) as { n: number };
  if (row.n >= SYBIL_MAX_ACTIVE_CLAIMS) {
    const err = new Error(
      `ESYBIL_LIMIT: account ${account_id} has ${row.n} active claims (max ${SYBIL_MAX_ACTIVE_CLAIMS})`,
    );
    (err as Error & { code: string }).code = "ESYBIL_LIMIT";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function applyReputationDelta(
  db: Database.Database,
  account_id: string,
  delta: number,
  now: number,
): void {
  const existing = db
    .prepare("SELECT score, last_event_at FROM reputation_ledger WHERE account_id = ?")
    .get(account_id) as { score: number; last_event_at: number } | undefined;

  if (existing === undefined) {
    db.prepare(
      "INSERT INTO reputation_ledger (account_id, score, last_event_at) VALUES (?, ?, ?)",
    ).run(account_id, delta, now);
    return;
  }

  const elapsed = now - existing.last_event_at;
  const halfLives = elapsed / RC_HALF_LIFE_MS;
  const decayed = elapsed > 0 ? existing.score * Math.pow(0.5, halfLives) : existing.score;

  db.prepare(
    "UPDATE reputation_ledger SET score = ?, last_event_at = ? WHERE account_id = ?",
  ).run(decayed + delta, now, account_id);
}
