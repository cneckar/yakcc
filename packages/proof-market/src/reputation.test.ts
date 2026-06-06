// SPDX-License-Identifier: MIT
//
// Tests for the reputation ledger consumers (#1085 / Slice E impl).
//
// Uses an in-memory SQLite with the v13 schema (proof_claims +
// reputation_ledger tables) so the tests exercise real SQL paths.

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RC_ATOM_ACCEPTED,
  RC_BOOTSTRAP_GRANT,
  RC_CLAIM_SLASHED,
  RC_HALF_LIFE_MS,
  RC_PROOF_CLAIM_ACCEPTED,
  RC_VERIFIER_ATTESTATION_CORRECT,
  RC_VERIFIER_DISSENT,
  SYBIL_MAX_ACTIVE_CLAIMS,
  accrueReputation,
  applyDecay,
  bootstrapGrantIfNeeded,
  checkSybilLimit,
  getReputation,
  reputationDeltaForEvent,
  slashReputation,
  type ReputationClock,
} from "./reputation.js";

// ---------------------------------------------------------------------------
// In-memory test DB with the v13 reputation_ledger + proof_claims subset
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE reputation_ledger (
      account_id TEXT PRIMARY KEY,
      score REAL NOT NULL,
      last_event_at INTEGER NOT NULL
    );
    CREATE TABLE proof_claims (
      claim_id TEXT PRIMARY KEY,
      bounty_id TEXT NOT NULL,
      claimant_id TEXT NOT NULL,
      commit_hash TEXT,
      stake_amount INTEGER,
      stake_unit TEXT,
      revealed_artifact_hash TEXT,
      status TEXT NOT NULL,
      committed_at INTEGER,
      revealed_at INTEGER
    );
    CREATE INDEX idx_proof_claims_claimant ON proof_claims (claimant_id);
  `);
  return db;
}

class FakeClock implements ReputationClock {
  constructor(public t: number) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

let db: Database.Database;

beforeEach(() => {
  db = makeDb();
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Accrual
// ---------------------------------------------------------------------------

describe("accrueReputation — event deltas", () => {
  it.each([
    ["atom_accepted", RC_ATOM_ACCEPTED] as const,
    ["proof_claim_accepted", RC_PROOF_CLAIM_ACCEPTED] as const,
    ["verifier_attestation_correct", RC_VERIFIER_ATTESTATION_CORRECT] as const,
    ["claim_slashed", RC_CLAIM_SLASHED] as const,
    ["verifier_dissent", RC_VERIFIER_DISSENT] as const,
  ])("applies %s -> delta=%i (on top of bootstrap grant)", (event, expectedDelta) => {
    const clock = new FakeClock(1_000_000);
    const score = accrueReputation(db, "alice", event, clock);
    // First event: bootstrap grant (100) + the event delta
    expect(score).toBe(RC_BOOTSTRAP_GRANT + expectedDelta);
  });

  it("reputationDeltaForEvent matches the constants table", () => {
    expect(reputationDeltaForEvent("atom_accepted")).toBe(RC_ATOM_ACCEPTED);
    expect(reputationDeltaForEvent("proof_claim_accepted")).toBe(RC_PROOF_CLAIM_ACCEPTED);
    expect(reputationDeltaForEvent("verifier_attestation_correct")).toBe(
      RC_VERIFIER_ATTESTATION_CORRECT,
    );
    expect(reputationDeltaForEvent("claim_slashed")).toBe(RC_CLAIM_SLASHED);
    expect(reputationDeltaForEvent("verifier_dissent")).toBe(RC_VERIFIER_DISSENT);
  });

  it("multiple events accumulate (no decay over zero elapsed time)", () => {
    const clock = new FakeClock(1_000_000);
    accrueReputation(db, "alice", "atom_accepted", clock);
    accrueReputation(db, "alice", "atom_accepted", clock);
    accrueReputation(db, "alice", "proof_claim_accepted", clock);
    expect(getReputation(db, "alice", clock)).toBe(
      RC_BOOTSTRAP_GRANT + 2 * RC_ATOM_ACCEPTED + RC_PROOF_CLAIM_ACCEPTED,
    );
  });
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

describe("bootstrapGrantIfNeeded", () => {
  it("grants RC_BOOTSTRAP_GRANT on first call for a new account", () => {
    const clock = new FakeClock(1_000_000);
    const granted = bootstrapGrantIfNeeded(db, "alice", clock);
    expect(granted).toBe(true);
    expect(getReputation(db, "alice", clock)).toBe(RC_BOOTSTRAP_GRANT);
  });

  it("does NOT grant a second time", () => {
    const clock = new FakeClock(1_000_000);
    expect(bootstrapGrantIfNeeded(db, "alice", clock)).toBe(true);
    expect(bootstrapGrantIfNeeded(db, "alice", clock)).toBe(false);
    expect(getReputation(db, "alice", clock)).toBe(RC_BOOTSTRAP_GRANT);
  });

  it("subsequent accrueReputation does not re-grant bootstrap", () => {
    const clock = new FakeClock(1_000_000);
    accrueReputation(db, "alice", "atom_accepted", clock); // 100 + 5
    accrueReputation(db, "alice", "atom_accepted", clock); // 105 + 5
    expect(getReputation(db, "alice", clock)).toBe(RC_BOOTSTRAP_GRANT + 2 * RC_ATOM_ACCEPTED);
  });
});

// ---------------------------------------------------------------------------
// Slashing — non-transferable property
// ---------------------------------------------------------------------------

describe("slashReputation — non-transferable", () => {
  it("decrements the slashed account; no other account row is created or touched", () => {
    const clock = new FakeClock(1_000_000);
    accrueReputation(db, "alice", "proof_claim_accepted", clock); // 100 + 50 = 150
    bootstrapGrantIfNeeded(db, "refuter", clock); // refuter has 100 RC

    const aliceBefore = getReputation(db, "alice", clock);
    const refuterBefore = getReputation(db, "refuter", clock);

    slashReputation(db, "alice", 50, "claim_invalid_proof", clock);

    expect(getReputation(db, "alice", clock)).toBe(aliceBefore - 50);
    // Critical: nothing transferred to refuter
    expect(getReputation(db, "refuter", clock)).toBe(refuterBefore);
  });

  it("throws on non-positive amount", () => {
    expect(() => slashReputation(db, "alice", 0, "test")).toThrow(TypeError);
    expect(() => slashReputation(db, "alice", -5, "test")).toThrow(TypeError);
  });

  it("ledger row count is exactly 1 after slashing one account from a fresh state", () => {
    const clock = new FakeClock(1_000_000);
    slashReputation(db, "alice", 1, "test", clock);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM reputation_ledger").get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Decay — linear half-life
// ---------------------------------------------------------------------------

describe("decay — linear half-life", () => {
  it("score halves after RC_HALF_LIFE_MS", () => {
    const t0 = 1_000_000_000;
    const clock = new FakeClock(t0);
    bootstrapGrantIfNeeded(db, "alice", clock);
    expect(getReputation(db, "alice", clock)).toBe(RC_BOOTSTRAP_GRANT);
    clock.advance(RC_HALF_LIFE_MS);
    expect(getReputation(db, "alice", clock)).toBeCloseTo(RC_BOOTSTRAP_GRANT / 2, 4);
  });

  it("score quarters after 2× half-life", () => {
    const t0 = 1_000_000_000;
    const clock = new FakeClock(t0);
    bootstrapGrantIfNeeded(db, "alice", clock);
    clock.advance(RC_HALF_LIFE_MS * 2);
    expect(getReputation(db, "alice", clock)).toBeCloseTo(RC_BOOTSTRAP_GRANT / 4, 4);
  });

  it("applyDecay updates the stored checkpoint to the decayed value", () => {
    const t0 = 1_000_000_000;
    const clock = new FakeClock(t0);
    bootstrapGrantIfNeeded(db, "alice", clock);
    clock.advance(RC_HALF_LIFE_MS);
    applyDecay(db, "alice", clock);
    // Reading immediately after applyDecay (zero elapsed) gives the checkpoint
    const row = db
      .prepare("SELECT score FROM reputation_ledger WHERE account_id = ?")
      .get("alice") as { score: number };
    expect(row.score).toBeCloseTo(RC_BOOTSTRAP_GRANT / 2, 4);
  });

  it("returns 0 for unknown accounts", () => {
    expect(getReputation(db, "ghost")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sybil rate-limit
// ---------------------------------------------------------------------------

describe("checkSybilLimit", () => {
  it("does not throw when no active claims", () => {
    expect(() => checkSybilLimit(db, "alice")).not.toThrow();
  });

  it("does not throw at SYBIL_MAX_ACTIVE_CLAIMS - 1", () => {
    for (let i = 0; i < SYBIL_MAX_ACTIVE_CLAIMS - 1; i++) {
      db.prepare(
        "INSERT INTO proof_claims (claim_id, bounty_id, claimant_id, status) VALUES (?, ?, ?, ?)",
      ).run(`claim-${i}`, "bounty-1", "alice", "COMMITTED");
    }
    expect(() => checkSybilLimit(db, "alice")).not.toThrow();
  });

  it("throws ESYBIL_LIMIT at SYBIL_MAX_ACTIVE_CLAIMS", () => {
    for (let i = 0; i < SYBIL_MAX_ACTIVE_CLAIMS; i++) {
      db.prepare(
        "INSERT INTO proof_claims (claim_id, bounty_id, claimant_id, status) VALUES (?, ?, ?, ?)",
      ).run(`claim-${i}`, "bounty-1", "alice", "COMMITTED");
    }
    try {
      checkSybilLimit(db, "alice");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error & { code: string }).code).toBe("ESYBIL_LIMIT");
    }
  });

  it("ignores finalized claims (VALID / INVALID / LAPSED) when counting", () => {
    // Sybil cap is concurrent ACTIVE claims, not lifetime claims
    for (let i = 0; i < SYBIL_MAX_ACTIVE_CLAIMS + 10; i++) {
      db.prepare(
        "INSERT INTO proof_claims (claim_id, bounty_id, claimant_id, status) VALUES (?, ?, ?, ?)",
      ).run(`claim-${i}`, "bounty-1", "alice", "VALID");
    }
    expect(() => checkSybilLimit(db, "alice")).not.toThrow();
  });

  it("counts REVEALED claims toward the cap (still active)", () => {
    for (let i = 0; i < SYBIL_MAX_ACTIVE_CLAIMS; i++) {
      db.prepare(
        "INSERT INTO proof_claims (claim_id, bounty_id, claimant_id, status) VALUES (?, ?, ?, ?)",
      ).run(`claim-${i}`, "bounty-1", "alice", "REVEALED");
    }
    expect(() => checkSybilLimit(db, "alice")).toThrow(/ESYBIL_LIMIT/);
  });
});
