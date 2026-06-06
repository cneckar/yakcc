// SPDX-License-Identifier: MIT
//
// retraction.test.ts — counter-proof admission tests for Slice F.
//
// Production sequence exercised here:
//   1. A proof bounty is posted and a claimant wins it (ACCEPT path from proof-market.ts).
//   2. A retractor files a retraction against the accepted claim (fileRetraction).
//   3. Verifier attestations resolve the retraction (resolveRetraction).
//   4. Economic consequences are computed: slash amount, retractor reward, treasury share.
//
// Test categories:
//   T-1: Successful retraction within 30 days → full slash region, retractor reward paid.
//   T-2: Successful retraction at day 89 → small slash (decay).
//   T-3: Retraction after T_RETRACTION_MS (90 days) → fileRetraction throws.
//   T-4: Asymmetric stake violation: stake < 2× original → fileRetraction throws.
//   T-5: Rejected retraction → retractor stake forfeit (status REJECTED, slashAmount=0).
//   T-6: Multiple concurrent retractions on same claim: first RETRACTED wins,
//        subsequent auto-REJECTED.
//   T-7: COMPOUND end-to-end — post bounty → commit → reveal → ACCEPT → retraction filed
//        → resolved RETRACTED via supermajority attestations (crosses all component boundaries).
//   T-8: Retraction on non-VALID claim → fileRetraction throws.
//   T-9: Resolve non-PENDING retraction → resolveRetraction throws.
//   T-10: computeSlashFraction boundary values.

import { beforeEach, describe, expect, it } from "vitest";
import { ProofMarket as ProofMarketCls } from "./proof-market.js";
import {
  type ClaimId,
  MIN_T_COMMIT_MS,
  MIN_T_REVEAL_MS,
} from "./index.js";
import {
  RetractionMarket,
  type RetractionId,
  RETRACTION_REWARD_FRACTION,
  RETRACTION_SLASH_HALF_LIFE_MS,
  RETRACTION_STAKE_MULTIPLIER,
  T_RETRACTION_MS,
} from "./retraction.js";

// ---------------------------------------------------------------------------
// Test helpers shared between proof-market and retraction tests
// ---------------------------------------------------------------------------

const ATOM_BMR = "a".repeat(64);
const THEOREM_HASH = "b".repeat(64);
const REQUESTER = "requester-alice";
const CLAIMANT_A = "claimant-alpha";
const RETRACTOR = "retractor-bob";
const STAKE_UNIT = "reputation_credit";
const REWARD_UNIT = "reputation_credit";
const ORIGINAL_STAKE = 100;
const ORIGINAL_REWARD = 1000;

function nonce(seed: string): Uint8Array {
  const enc = new TextEncoder();
  return enc.encode(seed.padEnd(32, "\0").slice(0, 32));
}

function artifact(label: string): Uint8Array {
  return new TextEncoder().encode(`proof-artifact-${label}`);
}

// ---------------------------------------------------------------------------
// Shared fixture: set up a ProofMarket + RetractionMarket on the same in-memory DB
// then drive a bounty all the way to ACCEPT so tests can file retractions against it.
// ---------------------------------------------------------------------------

let pm: ProofMarketCls;
let rm: RetractionMarket;
/** The claim_id of the winning VALID claim. */
let acceptedClaimId: ClaimId;
/** The revealed_at timestamp of the accepted claim (used as "accepted_at" proxy). */
let acceptedAt: number;

const T0 = 1_700_000_000_000; // fixed epoch for deterministic timing

/**
 * Drive a full bounty lifecycle to ACCEPT and return the VALID claim's ID.
 * Uses the shared `pm` / `rm` instances.
 */
function driveToAccept(opts: { t0?: number; originalStake?: number; originalReward?: number } = {}): {
  claimId: ClaimId;
  revealedAt: number;
} {
  const t0 = opts.t0 ?? T0;
  const stake = opts.originalStake ?? ORIGINAL_STAKE;
  const reward = opts.originalReward ?? ORIGINAL_REWARD;

  const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, reward, REWARD_UNIT, REQUESTER, {
    nowMs: t0,
    tCommitMs: MIN_T_COMMIT_MS,
    tRevealMs: MIN_T_REVEAL_MS,
  });

  const art = artifact("lean4-accepted-proof");
  const n = nonce("nonce-accepted");
  const commitHash = ProofMarketCls.computeCommitHash(art, n, CLAIMANT_A);
  const claimId = pm.commitClaim(bountyId, commitHash, CLAIMANT_A, stake, STAKE_UNIT, {
    nowMs: t0 + 1000,
  });

  // Advance to REVEAL
  pm.transitionBounty(bountyId, { nowMs: t0 + MIN_T_COMMIT_MS, tRevealMs: MIN_T_REVEAL_MS });

  const revealedAt = t0 + MIN_T_COMMIT_MS + 1000;
  pm.revealClaim(claimId, art, n, { nowMs: revealedAt });

  // Advance to CHECK
  pm.transitionBounty(bountyId, { nowMs: t0 + MIN_T_COMMIT_MS + MIN_T_REVEAL_MS });

  // Finalize with supermajority valid
  pm.finalizeBounty(bountyId, [
    {
      attestationId: "att-1" as unknown as ReturnType<typeof String.prototype.toString> & {
        readonly __brand: "AttestationId";
      },
      claimId,
      verifierId: "verifier-1",
      result: "valid",
      toolchainVersionHash: "c".repeat(64),
      signature: "sig-1",
    },
    {
      attestationId: "att-2" as unknown as ReturnType<typeof String.prototype.toString> & {
        readonly __brand: "AttestationId";
      },
      claimId,
      verifierId: "verifier-2",
      result: "valid",
      toolchainVersionHash: "c".repeat(64),
      signature: "sig-2",
    },
    {
      attestationId: "att-3" as unknown as ReturnType<typeof String.prototype.toString> & {
        readonly __brand: "AttestationId";
      },
      claimId,
      verifierId: "verifier-3",
      result: "valid",
      toolchainVersionHash: "c".repeat(64),
      signature: "sig-3",
    },
  ]);

  return { claimId, revealedAt };
}

// ---------------------------------------------------------------------------
// Fixture setup — fresh in-memory DB for each test, shared between PM and RM.
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Open ProofMarket first (it applies migrations including v14 proof_retractions).
  pm = ProofMarketCls.open(":memory:");
  // Share the same DB with RetractionMarket via the internal db handle.
  // We accomplish this by having RetractionMarket open its own in-memory DB pointing
  // to ":memory:" — but since each ":memory:" is a distinct DB, we need to share.
  // The clean approach: use RetractionMarket.fromDb with the PM's DB handle.
  // ProofMarket exposes no public db accessor, so we open RM.open(":memory:") and
  // drive both using their own separate in-memory DBs. This tests RM in isolation.
  // For the compound test (T-7) we use a shared DB via a file-based temp path.
  rm = RetractionMarket.open(":memory:");

  // Pre-populate the RM's DB with an accepted claim by driving the full lifecycle.
  // For isolated RM tests we need a claim in a DB that RM owns.
  // Strategy: use a single helper that drives the FULL lifecycle through RM's own DB.
  // RetractionMarket.fromDb wraps an existing DB — so we open PM on RM's DB handle.
  // Since we cannot access rm.db directly (private), we use RetractionMarket.open
  // and drive the accept lifecycle using a separate ProofMarket opened on the same path.
  // For in-memory isolation we accept that each test drives its own lifecycle.
  // The acceptedClaimId / acceptedAt are populated per-test via the helpers below.
});

// ---------------------------------------------------------------------------
// Helper: create a shared DB, drive to accept, return both market handles.
// ---------------------------------------------------------------------------

function setupSharedDb(opts: { t0?: number; originalStake?: number; originalReward?: number } = {}): {
  pm: ProofMarketCls;
  rm: RetractionMarket;
  claimId: ClaimId;
  revealedAt: number;
} {
  // Open ProofMarket on ":memory:" — it applies all migrations through v14.
  const localPm = ProofMarketCls.open(":memory:");
  // Wrap the same underlying DB with RetractionMarket.
  // We need to access the DB — this is the one legitimate reason to call fromDb.
  // We achieve this by having RetractionMarket.open open a SECOND in-memory handle
  // and using that. But to share state we need to pass the DB from PM.
  // The practical solution: both open the same path. For tests, use a temp file.
  // However, for simplicity and to avoid temp-file cleanup, we expose a test seam:
  // open RM using the SAME database by passing a special test shim.
  //
  // IMPLEMENTATION NOTE: ProofMarket.open and RetractionMarket.open both call
  // applyMigrations, which is idempotent. The simplest shared-DB approach for
  // tests is to open a PM, then open an RM wrapping the same underlying Database
  // object. ProofMarket stores db as private, so we use a parallel test path:
  // open both on the same database instance via a test helper in retraction.ts.
  //
  // Rather than adding test-only seams to production code, we drive the shared
  // lifecycle by having the PM drive to ACCEPT, then export the claim_id, and
  // test the RM using a fresh DB where we manually insert the accepted claim row
  // using raw SQL (the RM does not care how the row got there, only its status).
  //
  // This is the most honest approach: the RM queries proof_claims via FK, which
  // means it operates against a real schema row regardless of how it was created.

  const { claimId, revealedAt } = driveToAcceptOnPm(localPm, opts);

  // Now open RM on the SAME in-memory DB via fromDb.
  // ProofMarket exposes no db getter, so we need a different strategy:
  // Open both markets on a shared Database instance passed via fromDb.
  // We construct the shared Database manually here, then pass it to both.

  // Re-implement: use a single Database object for both.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const DatabaseCtor = require("better-sqlite3") as typeof import("better-sqlite3").default;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqliteVec = require("sqlite-vec") as typeof import("sqlite-vec");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { applyMigrations } = require("@yakcc/registry") as { applyMigrations: (db: unknown) => void };

  const sharedDb = new DatabaseCtor(":memory:");
  sqliteVec.load(sharedDb);
  sharedDb.exec("PRAGMA foreign_keys = ON");
  applyMigrations(sharedDb);

  // Drive to ACCEPT using the shared DB.
  const sharedPm = ProofMarketCls.fromDbForTest(sharedDb);
  const { claimId: sharedClaimId, revealedAt: sharedRevealedAt } = driveToAcceptOnPm(
    sharedPm,
    opts,
  );
  const sharedRm = RetractionMarket.fromDb(sharedDb);
  localPm.close();

  return { pm: sharedPm, rm: sharedRm, claimId: sharedClaimId, revealedAt: sharedRevealedAt };
}

function driveToAcceptOnPm(
  localPm: ProofMarketCls,
  opts: { t0?: number; originalStake?: number; originalReward?: number } = {},
): { claimId: ClaimId; revealedAt: number } {
  const t0 = opts.t0 ?? T0;
  const stake = opts.originalStake ?? ORIGINAL_STAKE;
  const reward = opts.originalReward ?? ORIGINAL_REWARD;

  const bountyId = localPm.postBounty(ATOM_BMR, THEOREM_HASH, reward, REWARD_UNIT, REQUESTER, {
    nowMs: t0,
    tCommitMs: MIN_T_COMMIT_MS,
    tRevealMs: MIN_T_REVEAL_MS,
  });

  const art = artifact("lean4-accepted-proof");
  const n = nonce("nonce-accepted");
  const commitHash = ProofMarketCls.computeCommitHash(art, n, CLAIMANT_A);
  const claimId = localPm.commitClaim(bountyId, commitHash, CLAIMANT_A, stake, STAKE_UNIT, {
    nowMs: t0 + 1000,
  });

  localPm.transitionBounty(bountyId, { nowMs: t0 + MIN_T_COMMIT_MS, tRevealMs: MIN_T_REVEAL_MS });
  const revealedAt = t0 + MIN_T_COMMIT_MS + 1000;
  localPm.revealClaim(claimId, art, n, { nowMs: revealedAt });
  localPm.transitionBounty(bountyId, { nowMs: t0 + MIN_T_COMMIT_MS + MIN_T_REVEAL_MS });

  localPm.finalizeBounty(bountyId, [
    {
      attestationId: "att-1" as unknown as ReturnType<typeof String.prototype.toString> & {
        readonly __brand: "AttestationId";
      },
      claimId,
      verifierId: "v1",
      result: "valid",
      toolchainVersionHash: "c".repeat(64),
      signature: "sig1",
    },
    {
      attestationId: "att-2" as unknown as ReturnType<typeof String.prototype.toString> & {
        readonly __brand: "AttestationId";
      },
      claimId,
      verifierId: "v2",
      result: "valid",
      toolchainVersionHash: "c".repeat(64),
      signature: "sig2",
    },
    {
      attestationId: "att-3" as unknown as ReturnType<typeof String.prototype.toString> & {
        readonly __brand: "AttestationId";
      },
      claimId,
      verifierId: "v3",
      result: "valid",
      toolchainVersionHash: "c".repeat(64),
      signature: "sig3",
    },
  ]);

  return { claimId, revealedAt };
}

// ---------------------------------------------------------------------------
// T-10: computeSlashFraction boundary values (pure math, no DB needed)
// ---------------------------------------------------------------------------

describe("computeSlashFraction — exponential half-life decay", () => {
  it("returns 1.0 at elapsed=0 (full slash, caught immediately)", () => {
    expect(RetractionMarket.computeSlashFraction(0)).toBe(1.0);
  });

  it("returns ~0.5 at elapsed=HALF_LIFE (30 days)", () => {
    const fraction = RetractionMarket.computeSlashFraction(RETRACTION_SLASH_HALF_LIFE_MS);
    expect(fraction).toBeCloseTo(0.5, 5);
  });

  it("returns ~0.25 at elapsed=2×HALF_LIFE (60 days)", () => {
    const fraction = RetractionMarket.computeSlashFraction(2 * RETRACTION_SLASH_HALF_LIFE_MS);
    expect(fraction).toBeCloseTo(0.25, 5);
  });

  it("returns ~0.13 at elapsed=~90 days (near window close)", () => {
    // 90 days = 3 × 30d half-lives → 2^(-3) = 0.125
    const fraction = RetractionMarket.computeSlashFraction(3 * RETRACTION_SLASH_HALF_LIFE_MS);
    expect(fraction).toBeCloseTo(0.125, 5);
  });

  it("returns a value strictly between 0 and 1 for any positive elapsed", () => {
    for (const ms of [1, 1000, 1_000_000, T_RETRACTION_MS]) {
      const f = RetractionMarket.computeSlashFraction(ms);
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// T-3: Filing after window close throws
// ---------------------------------------------------------------------------

describe("T-3: retraction after T_RETRACTION_MS window → throws", () => {
  it("throws when filed more than 90 days after acceptance", () => {
    const { rm: sharedRm, claimId, revealedAt } = setupSharedDb();

    const afterWindow = revealedAt + T_RETRACTION_MS + 1;
    expect(() =>
      sharedRm.fileRetraction(
        claimId,
        RETRACTOR,
        ORIGINAL_STAKE * RETRACTION_STAKE_MULTIPLIER,
        STAKE_UNIT,
        null,
        { nowMs: afterWindow },
      ),
    ).toThrow("retraction window closed");

    sharedRm.close();
  });
});

// ---------------------------------------------------------------------------
// T-4: Asymmetric stake violation → throws
// ---------------------------------------------------------------------------

describe("T-4: stake < 2× original → fileRetraction throws", () => {
  it("throws when stake is exactly 1× original", () => {
    const { rm: sharedRm, claimId, revealedAt } = setupSharedDb();

    // Stake is equal to original (100), not 2× (200)
    expect(() =>
      sharedRm.fileRetraction(claimId, RETRACTOR, ORIGINAL_STAKE, STAKE_UNIT, null, {
        nowMs: revealedAt + 1000,
      }),
    ).toThrow("less than required minimum");

    sharedRm.close();
  });

  it("throws when stake is 2× - 1 (just below threshold)", () => {
    const { rm: sharedRm, claimId, revealedAt } = setupSharedDb();

    expect(() =>
      sharedRm.fileRetraction(
        claimId,
        RETRACTOR,
        ORIGINAL_STAKE * RETRACTION_STAKE_MULTIPLIER - 1,
        STAKE_UNIT,
        null,
        { nowMs: revealedAt + 1000 },
      ),
    ).toThrow("less than required minimum");

    sharedRm.close();
  });

  it("succeeds with exactly 2× stake (boundary inclusive)", () => {
    const { rm: sharedRm, claimId, revealedAt } = setupSharedDb();

    const retractionId = sharedRm.fileRetraction(
      claimId,
      RETRACTOR,
      ORIGINAL_STAKE * RETRACTION_STAKE_MULTIPLIER,
      STAKE_UNIT,
      null,
      { nowMs: revealedAt + 1000 },
    );
    expect(retractionId).toMatch(/^[0-9a-f]{64}$/);

    sharedRm.close();
  });
});

// ---------------------------------------------------------------------------
// T-8: Retraction on non-VALID claim → throws
// ---------------------------------------------------------------------------

describe("T-8: retraction on non-VALID claim", () => {
  it("throws when original claim does not exist", () => {
    expect(() =>
      rm.fileRetraction("no-such-claim", RETRACTOR, 200, STAKE_UNIT, null, {
        nowMs: T0 + 1000,
      }),
    ).toThrow("claim not found");
  });
});

// ---------------------------------------------------------------------------
// T-5: Rejected retraction → status REJECTED, slashAmount=0
// ---------------------------------------------------------------------------

describe("T-5: rejected retraction (supermajority invalid)", () => {
  it("sets status to REJECTED and returns zero slash amounts", () => {
    const { rm: sharedRm, claimId, revealedAt } = setupSharedDb();

    const retractionId = sharedRm.fileRetraction(
      claimId,
      RETRACTOR,
      ORIGINAL_STAKE * RETRACTION_STAKE_MULTIPLIER,
      STAKE_UNIT,
      "evidenceHash123",
      { nowMs: revealedAt + 1000 },
    );

    // Resolve with all-invalid attestations (no supermajority)
    const resolution = sharedRm.resolveRetraction(
      retractionId,
      [
        { verifierId: "v1", result: "invalid" },
        { verifierId: "v2", result: "invalid" },
        { verifierId: "v3", result: "invalid" },
      ],
      { nowMs: revealedAt + 2000, originalRewardAmount: ORIGINAL_REWARD },
    );

    expect(resolution.status).toBe("REJECTED");
    expect(resolution.slashAmount).toBe(0);
    expect(resolution.retractorReward).toBe(0);
    expect(resolution.treasuryAmount).toBe(0);

    const row = sharedRm.getRetraction(retractionId);
    expect(row!.status).toBe("REJECTED");
    expect(row!.resolved_at).toBe(revealedAt + 2000);

    sharedRm.close();
  });

  it("REJECTED with zero attestations (no verifiers showed up)", () => {
    const { rm: sharedRm, claimId, revealedAt } = setupSharedDb();

    const retractionId = sharedRm.fileRetraction(
      claimId,
      RETRACTOR,
      ORIGINAL_STAKE * RETRACTION_STAKE_MULTIPLIER,
      STAKE_UNIT,
      null,
      { nowMs: revealedAt + 1000 },
    );

    const resolution = sharedRm.resolveRetraction(retractionId, [], {
      nowMs: revealedAt + 2000,
    });

    expect(resolution.status).toBe("REJECTED");

    sharedRm.close();
  });
});

// ---------------------------------------------------------------------------
// T-9: Resolve non-PENDING retraction throws
// ---------------------------------------------------------------------------

describe("T-9: resolve non-PENDING retraction → throws", () => {
  it("throws when trying to resolve an already-REJECTED retraction", () => {
    const { rm: sharedRm, claimId, revealedAt } = setupSharedDb();

    const retractionId = sharedRm.fileRetraction(
      claimId,
      RETRACTOR,
      ORIGINAL_STAKE * RETRACTION_STAKE_MULTIPLIER,
      STAKE_UNIT,
      null,
      { nowMs: revealedAt + 1000 },
    );

    // Resolve once (REJECT)
    sharedRm.resolveRetraction(retractionId, [], { nowMs: revealedAt + 2000 });

    // Try to resolve again
    expect(() =>
      sharedRm.resolveRetraction(retractionId, [], { nowMs: revealedAt + 3000 }),
    ).toThrow("not PENDING");

    sharedRm.close();
  });
});

// ---------------------------------------------------------------------------
// T-1: Successful retraction within 30 days → full slash region
// ---------------------------------------------------------------------------

describe("T-1: successful retraction within 30 days (full slash region)", () => {
  it("resolves RETRACTED with near-full slash when caught quickly (elapsed ~ 1 day)", () => {
    const { rm: sharedRm, claimId, revealedAt } = setupSharedDb();

    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const retractionId = sharedRm.fileRetraction(
      claimId,
      RETRACTOR,
      ORIGINAL_STAKE * RETRACTION_STAKE_MULTIPLIER,
      STAKE_UNIT,
      "counterexample-hash",
      { nowMs: revealedAt + ONE_DAY_MS },
    );

    const resolution = sharedRm.resolveRetraction(
      retractionId,
      [
        { verifierId: "v1", result: "valid" },
        { verifierId: "v2", result: "valid" },
        { verifierId: "v3", result: "valid" },
      ],
      {
        nowMs: revealedAt + ONE_DAY_MS + 1000,
        originalRewardAmount: ORIGINAL_REWARD,
      },
    );

    expect(resolution.status).toBe("RETRACTED");

    // Slash fraction at 1 day: 2^(-1/30) ≈ 0.977
    const expectedFraction = Math.pow(2, -(ONE_DAY_MS / RETRACTION_SLASH_HALF_LIFE_MS));
    expect(resolution.slashFraction).toBeCloseTo(expectedFraction, 5);

    // Slash amount should be close to full reward
    const expectedSlash = Math.round(ORIGINAL_REWARD * expectedFraction);
    expect(resolution.slashAmount).toBe(expectedSlash);

    // Retractor reward = RETRACTION_REWARD_FRACTION of slashAmount
    expect(resolution.retractorReward).toBe(
      Math.round(expectedSlash * RETRACTION_REWARD_FRACTION),
    );

    // Treasury gets the rest
    expect(resolution.treasuryAmount).toBe(resolution.slashAmount - resolution.retractorReward);

    // DB row is updated
    const row = sharedRm.getRetraction(retractionId);
    expect(row!.status).toBe("RETRACTED");

    sharedRm.close();
  });

  it("retractorReward + treasuryAmount = slashAmount (no rounding leakage)", () => {
    const { rm: sharedRm, claimId, revealedAt } = setupSharedDb();

    const retractionId = sharedRm.fileRetraction(
      claimId,
      RETRACTOR,
      ORIGINAL_STAKE * RETRACTION_STAKE_MULTIPLIER,
      STAKE_UNIT,
      null,
      { nowMs: revealedAt + 1000 },
    );

    const resolution = sharedRm.resolveRetraction(
      retractionId,
      [{ verifierId: "v1", result: "valid" }, { verifierId: "v2", result: "valid" }],
      { nowMs: revealedAt + 2000, originalRewardAmount: ORIGINAL_REWARD },
    );

    expect(resolution.status).toBe("RETRACTED");
    expect(resolution.retractorReward + resolution.treasuryAmount).toBe(resolution.slashAmount);

    sharedRm.close();
  });
});

// ---------------------------------------------------------------------------
// T-2: Successful retraction at day 89 → small slash (decay)
// ---------------------------------------------------------------------------

describe("T-2: successful retraction at day 89 (small slash near window close)", () => {
  it("resolves RETRACTED with small slash fraction (~0.13 at 90 days)", () => {
    const { rm: sharedRm, claimId, revealedAt } = setupSharedDb();

    const DAY_89_MS = 89 * 24 * 60 * 60 * 1000;
    const retractionId = sharedRm.fileRetraction(
      claimId,
      RETRACTOR,
      ORIGINAL_STAKE * RETRACTION_STAKE_MULTIPLIER,
      STAKE_UNIT,
      "counterexample-hash-late",
      { nowMs: revealedAt + DAY_89_MS },
    );

    const resolveTime = revealedAt + DAY_89_MS + 1000;
    const resolution = sharedRm.resolveRetraction(
      retractionId,
      [{ verifierId: "v1", result: "valid" }, { verifierId: "v2", result: "valid" }],
      { nowMs: resolveTime, originalRewardAmount: ORIGINAL_REWARD },
    );

    expect(resolution.status).toBe("RETRACTED");

    // At ~89 days the slash fraction is ~2^(-89/30) ≈ 0.131
    expect(resolution.slashFraction).toBeLessThan(0.2);
    expect(resolution.slashFraction).toBeGreaterThan(0.05);

    // Slash amount is much smaller than the full reward
    expect(resolution.slashAmount).toBeLessThan(ORIGINAL_REWARD * 0.2);

    sharedRm.close();
  });
});

// ---------------------------------------------------------------------------
// T-6: Multiple concurrent retractions — first RETRACTED wins, rest auto-REJECTED
// ---------------------------------------------------------------------------

describe("T-6: multiple concurrent retractions on same claim", () => {
  it("first successful retraction wins; concurrent pending ones auto-REJECTED", () => {
    const { rm: sharedRm, claimId, revealedAt } = setupSharedDb();

    const fileTime = revealedAt + 1000;

    // File three independent retractions
    const r1 = sharedRm.fileRetraction(
      claimId,
      "retractor-1",
      ORIGINAL_STAKE * RETRACTION_STAKE_MULTIPLIER,
      STAKE_UNIT,
      "evidence-1",
      { nowMs: fileTime },
    );
    const r2 = sharedRm.fileRetraction(
      claimId,
      "retractor-2",
      ORIGINAL_STAKE * RETRACTION_STAKE_MULTIPLIER,
      STAKE_UNIT,
      "evidence-2",
      { nowMs: fileTime + 100 },
    );
    const r3 = sharedRm.fileRetraction(
      claimId,
      "retractor-3",
      ORIGINAL_STAKE * RETRACTION_STAKE_MULTIPLIER,
      STAKE_UNIT,
      "evidence-3",
      { nowMs: fileTime + 200 },
    );

    // All three are PENDING initially
    for (const id of [r1, r2, r3]) {
      expect(sharedRm.getRetraction(id)!.status).toBe("PENDING");
    }

    // Resolve r1 first — supermajority valid → RETRACTED
    const resolution1 = sharedRm.resolveRetraction(
      r1,
      [{ verifierId: "v1", result: "valid" }, { verifierId: "v2", result: "valid" }],
      { nowMs: fileTime + 5000, originalRewardAmount: ORIGINAL_REWARD },
    );
    expect(resolution1.status).toBe("RETRACTED");

    // r2 and r3 should now be auto-REJECTED (the proof is already retracted)
    expect(sharedRm.getRetraction(r2)!.status).toBe("REJECTED");
    expect(sharedRm.getRetraction(r3)!.status).toBe("REJECTED");

    // listRetractions returns all three in filed_at order
    const allRetractions = sharedRm.listRetractions(claimId);
    expect(allRetractions).toHaveLength(3);
    expect(allRetractions[0]!.retraction_id).toBe(r1);
    expect(allRetractions[1]!.retraction_id).toBe(r2);
    expect(allRetractions[2]!.retraction_id).toBe(r3);

    sharedRm.close();
  });

  it("concurrent retraction resolving after first is already RETRACTED → auto-REJECTED immediately", () => {
    const { rm: sharedRm, claimId, revealedAt } = setupSharedDb();

    const fileTime = revealedAt + 1000;

    const r1 = sharedRm.fileRetraction(
      claimId,
      "retractor-1",
      ORIGINAL_STAKE * RETRACTION_STAKE_MULTIPLIER,
      STAKE_UNIT,
      null,
      { nowMs: fileTime },
    );
    const r2 = sharedRm.fileRetraction(
      claimId,
      "retractor-2",
      ORIGINAL_STAKE * RETRACTION_STAKE_MULTIPLIER,
      STAKE_UNIT,
      null,
      { nowMs: fileTime + 100 },
    );

    // Resolve r1 → RETRACTED (auto-rejects r2)
    sharedRm.resolveRetraction(
      r1,
      [{ verifierId: "v1", result: "valid" }, { verifierId: "v2", result: "valid" }],
      { nowMs: fileTime + 5000, originalRewardAmount: ORIGINAL_REWARD },
    );

    // r2 was auto-REJECTED by r1's resolution; trying to explicitly resolve r2 should throw
    expect(() =>
      sharedRm.resolveRetraction(
        r2,
        [{ verifierId: "v1", result: "valid" }],
        { nowMs: fileTime + 6000 },
      ),
    ).toThrow("not PENDING");

    sharedRm.close();
  });
});

// ---------------------------------------------------------------------------
// T-7: COMPOUND end-to-end test — crosses all component boundaries
//
// Production sequence:
//   1. ProofMarket: post bounty → commit → reveal → finalize → ACCEPT
//   2. RetractionMarket: file retraction (asymmetric stake, within window)
//   3. RetractionMarket: resolve retraction with supermajority
//   4. Assert economic outputs: slash fraction, retractor reward, treasury split
// ---------------------------------------------------------------------------

describe("T-7: compound end-to-end — full lifecycle from bounty post to retraction resolution", () => {
  it("post→commit→reveal→ACCEPT→retraction filed→resolved RETRACTED; rewards computed correctly", () => {
    // Construct a shared Database for both markets.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const DatabaseCtor = require("better-sqlite3") as typeof import("better-sqlite3").default;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVecMod = require("sqlite-vec") as typeof import("sqlite-vec");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { applyMigrations: applyMig } = require("@yakcc/registry") as {
      applyMigrations: (db: unknown) => void;
    };

    const sharedDb = new DatabaseCtor(":memory:");
    sqliteVecMod.load(sharedDb);
    sharedDb.exec("PRAGMA foreign_keys = ON");
    applyMig(sharedDb);

    // --- Phase 1: Proof lifecycle (commit-reveal-ACCEPT) ---
    const localPm = ProofMarketCls.fromDbForTest(sharedDb);
    const localRm = RetractionMarket.fromDb(sharedDb);

    const t0 = T0;
    const bountyId = localPm.postBounty(ATOM_BMR, THEOREM_HASH, ORIGINAL_REWARD, REWARD_UNIT, REQUESTER, {
      nowMs: t0,
      tCommitMs: MIN_T_COMMIT_MS,
      tRevealMs: MIN_T_REVEAL_MS,
    });

    const art = artifact("compound-proof");
    const n = nonce("compound-nonce");
    const commitHash = ProofMarketCls.computeCommitHash(art, n, CLAIMANT_A);
    const claimId = localPm.commitClaim(bountyId, commitHash, CLAIMANT_A, ORIGINAL_STAKE, STAKE_UNIT, {
      nowMs: t0 + 500,
    });

    localPm.transitionBounty(bountyId, {
      nowMs: t0 + MIN_T_COMMIT_MS,
      tRevealMs: MIN_T_REVEAL_MS,
    });

    const revealedAt = t0 + MIN_T_COMMIT_MS + 1000;
    localPm.revealClaim(claimId, art, n, { nowMs: revealedAt });
    localPm.transitionBounty(bountyId, { nowMs: t0 + MIN_T_COMMIT_MS + MIN_T_REVEAL_MS });

    localPm.finalizeBounty(bountyId, [
      {
        attestationId: "att-e2e-1" as unknown as ReturnType<typeof String.prototype.toString> & {
          readonly __brand: "AttestationId";
        },
        claimId,
        verifierId: "verifier-e2e-1",
        result: "valid",
        toolchainVersionHash: "d".repeat(64),
        signature: "sig-e2e-1",
      },
      {
        attestationId: "att-e2e-2" as unknown as ReturnType<typeof String.prototype.toString> & {
          readonly __brand: "AttestationId";
        },
        claimId,
        verifierId: "verifier-e2e-2",
        result: "valid",
        toolchainVersionHash: "d".repeat(64),
        signature: "sig-e2e-2",
      },
      {
        attestationId: "att-e2e-3" as unknown as ReturnType<typeof String.prototype.toString> & {
          readonly __brand: "AttestationId";
        },
        claimId,
        verifierId: "verifier-e2e-3",
        result: "valid",
        toolchainVersionHash: "d".repeat(64),
        signature: "sig-e2e-3",
      },
    ]);

    // Verify ACCEPT state
    expect(localPm.getBounty(bountyId)!.status).toBe("ACCEPT");
    expect(localPm.getClaim(claimId)!.status).toBe("VALID");

    // --- Phase 2: Retraction filed (15 days after acceptance) ---
    const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
    const retractionFileTime = revealedAt + FIFTEEN_DAYS_MS;

    const retractionId = localRm.fileRetraction(
      claimId,
      RETRACTOR,
      ORIGINAL_STAKE * RETRACTION_STAKE_MULTIPLIER, // 2× stake = 200
      STAKE_UNIT,
      "counterexample-artifact-hash-e2e",
      { nowMs: retractionFileTime },
    );

    const retractionRow = localRm.getRetraction(retractionId);
    expect(retractionRow).toBeDefined();
    expect(retractionRow!.status).toBe("PENDING");
    expect(retractionRow!.original_claim_id).toBe(claimId);
    expect(retractionRow!.stake_amount).toBe(ORIGINAL_STAKE * RETRACTION_STAKE_MULTIPLIER);
    expect(retractionRow!.filed_at).toBe(retractionFileTime);

    // --- Phase 3: Resolve retraction with supermajority (2 valid of 3) ---
    const resolveTime = retractionFileTime + 60_000;
    const resolution = localRm.resolveRetraction(
      retractionId,
      [
        { verifierId: "retraction-v1", result: "valid" },
        { verifierId: "retraction-v2", result: "valid" },
        { verifierId: "retraction-v3", result: "invalid" }, // 2/3 = exactly supermajority
      ],
      { nowMs: resolveTime, originalRewardAmount: ORIGINAL_REWARD },
    );

    // --- Phase 4: Assert economic outputs ---
    expect(resolution.status).toBe("RETRACTED");

    // elapsed = resolveTime - revealedAt ≈ 15 days + 60s
    const expectedElapsed = resolveTime - revealedAt;
    expect(resolution.elapsedMs).toBe(expectedElapsed);

    // slash_fraction = 2^(-elapsed / HALF_LIFE)
    const expectedFraction = Math.pow(2, -(expectedElapsed / RETRACTION_SLASH_HALF_LIFE_MS));
    expect(resolution.slashFraction).toBeCloseTo(expectedFraction, 5);

    // At 15 days, slash fraction ≈ 0.71 (more than half, less than full)
    expect(resolution.slashFraction).toBeGreaterThan(0.5);
    expect(resolution.slashFraction).toBeLessThan(1.0);

    const expectedSlashAmount = Math.round(ORIGINAL_REWARD * expectedFraction);
    expect(resolution.slashAmount).toBe(expectedSlashAmount);

    const expectedRetractorReward = Math.round(expectedSlashAmount * RETRACTION_REWARD_FRACTION);
    expect(resolution.retractorReward).toBe(expectedRetractorReward);
    expect(resolution.treasuryAmount).toBe(expectedSlashAmount - expectedRetractorReward);

    // Conservation: reward + treasury = slash
    expect(resolution.retractorReward + resolution.treasuryAmount).toBe(resolution.slashAmount);

    // DB state: retraction is RETRACTED
    const finalRow = localRm.getRetraction(retractionId);
    expect(finalRow!.status).toBe("RETRACTED");
    expect(finalRow!.resolved_at).toBe(resolveTime);

    sharedDb.close();
  });
});
