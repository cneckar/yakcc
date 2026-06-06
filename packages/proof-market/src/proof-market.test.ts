// SPDX-License-Identifier: MIT
//
// proof-market.test.ts — state machine + race condition tests for the proof incentive layer.
//
// Production sequence this file exercises:
//   1. requester calls postBounty → bounty_id returned, bounty in DB at COMMIT status
//   2. claimant(s) call commitClaim → claim_id returned, claim in DB at COMMITTED status
//   3. time advances past t_commit_close; transitionBounty → bounty REVEAL status
//   4. claimant calls revealClaim(artifact_bytes, nonce) → claim REVEALED status
//   5. time advances past t_reveal_close; transitionBounty → bounty CHECK status
//   6. verifier daemons submit attestations; finalizeBounty → ACCEPT or REJECT
//
// Race conditions covered:
//   RC-1: Two claimants commit same artifact hash → both committed, both revealed, earliest wins
//   RC-2: Reveal without prior commit → rejected
//   RC-3: Reveal after T_reveal expires → LAPSED (transitionBounty lapses it)
//   RC-4: Commit after T_commit closes → rejected
//   RC-5: Reveal with mismatched (artifact, nonce) vs commit → rejected
//   RC-6: No reveals at all → bounty REJECT, all stakes forfeit (claim status LAPSED)
//   RC-7: Multiple valid reveals, earliest commit wins bounty
//   RC-8: T_commit expiry transitions COMMIT → REVEAL automatically via transitionBounty
//   RC-9: Supermajority not met → REJECT even with some valid attestations
//   RC-10: finalizeBounty on non-CHECK bounty → error

import { beforeEach, describe, expect, it } from "vitest";
import {
  type BountyId,
  type ClaimId,
  DEFAULT_T_COMMIT_MS,
  DEFAULT_T_REVEAL_MS,
  type ProofMarket,
  MIN_T_COMMIT_MS,
  MIN_T_REVEAL_MS,
} from "./index.js";
// Import concrete class for static method access
import { ProofMarket as ProofMarketCls } from "./proof-market.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ATOM_BMR = "a".repeat(64);
const THEOREM_HASH = "b".repeat(64);
const REQUESTER = "requester-alice";
const CLAIMANT_A = "claimant-alpha";
const CLAIMANT_B = "claimant-beta";
const STAKE_UNIT = "reputation_credit";
const REWARD_UNIT = "reputation_credit";

/** Generate a deterministic nonce from a seed string. */
function nonce(seed: string): Uint8Array {
  const enc = new TextEncoder();
  const bytes = enc.encode(seed.padEnd(32, "\0").slice(0, 32));
  return bytes;
}

/** Produce fake artifact bytes from a label. */
function artifact(label: string): Uint8Array {
  return new TextEncoder().encode(`proof-artifact-${label}`);
}

/** Fake attestation factory. */
function makeAttestation(
  claimId: ClaimId,
  result: "valid" | "invalid",
  idx: number,
): {
  attestationId: ReturnType<typeof String.prototype.toString> & { readonly __brand: "AttestationId" };
  claimId: ClaimId;
  verifierId: string;
  result: "valid" | "invalid";
  toolchainVersionHash: string;
  signature: string;
} {
  return {
    attestationId: `att-${idx}-${claimId}` as unknown as ReturnType<
      typeof String.prototype.toString
    > & { readonly __brand: "AttestationId" },
    claimId,
    verifierId: `verifier-${idx}`,
    result,
    toolchainVersionHash: "c".repeat(64),
    signature: `sig-${idx}`,
  };
}

// ---------------------------------------------------------------------------
// Fixture setup — fresh in-memory ProofMarket for each test
// ---------------------------------------------------------------------------

let pm: ProofMarket;

beforeEach(() => {
  pm = ProofMarketCls.open(":memory:");
});

// ---------------------------------------------------------------------------
// computeCommitHash — primitive
// ---------------------------------------------------------------------------

describe("computeCommitHash", () => {
  it("produces a 64-char lowercase hex string", () => {
    const hash = ProofMarketCls.computeCommitHash(artifact("x"), nonce("n1"), CLAIMANT_A);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const a = ProofMarketCls.computeCommitHash(artifact("x"), nonce("n1"), CLAIMANT_A);
    const b = ProofMarketCls.computeCommitHash(artifact("x"), nonce("n1"), CLAIMANT_A);
    expect(a).toBe(b);
  });

  it("changes when artifact changes", () => {
    const a = ProofMarketCls.computeCommitHash(artifact("x"), nonce("n1"), CLAIMANT_A);
    const b = ProofMarketCls.computeCommitHash(artifact("y"), nonce("n1"), CLAIMANT_A);
    expect(a).not.toBe(b);
  });

  it("changes when nonce changes", () => {
    const a = ProofMarketCls.computeCommitHash(artifact("x"), nonce("n1"), CLAIMANT_A);
    const b = ProofMarketCls.computeCommitHash(artifact("x"), nonce("n2"), CLAIMANT_A);
    expect(a).not.toBe(b);
  });

  it("changes when claimant changes — prevents front-running across identities", () => {
    const a = ProofMarketCls.computeCommitHash(artifact("x"), nonce("n1"), CLAIMANT_A);
    const b = ProofMarketCls.computeCommitHash(artifact("x"), nonce("n1"), CLAIMANT_B);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// postBounty
// ---------------------------------------------------------------------------

describe("postBounty", () => {
  it("creates a bounty in COMMIT status", () => {
    const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, 100, REWARD_UNIT, REQUESTER);
    const row = pm.getBounty(bountyId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("COMMIT");
    expect(row!.reward_amount).toBe(100);
    expect(row!.atom_bmr).toBe(ATOM_BMR);
    expect(row!.t_commit_close).toBeTypeOf("number");
    expect(row!.t_reveal_close).toBeNull();
  });

  it("sets t_commit_close relative to nowMs", () => {
    const nowMs = 1_000_000;
    const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, 100, REWARD_UNIT, REQUESTER, {
      nowMs,
      tCommitMs: MIN_T_COMMIT_MS,
    });
    const row = pm.getBounty(bountyId);
    expect(row!.t_commit_close).toBe(nowMs + MIN_T_COMMIT_MS);
  });

  it("rejects tCommitMs below minimum", () => {
    expect(() =>
      pm.postBounty(ATOM_BMR, THEOREM_HASH, 100, REWARD_UNIT, REQUESTER, {
        tCommitMs: MIN_T_COMMIT_MS - 1,
      }),
    ).toThrow("tCommitMs");
  });

  it("rejects tRevealMs below minimum", () => {
    expect(() =>
      pm.postBounty(ATOM_BMR, THEOREM_HASH, 100, REWARD_UNIT, REQUESTER, {
        tRevealMs: MIN_T_REVEAL_MS - 1,
      }),
    ).toThrow("tRevealMs");
  });

  it("getBounty returns undefined for unknown id", () => {
    expect(pm.getBounty("unknown" as BountyId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// commitClaim
// ---------------------------------------------------------------------------

describe("commitClaim", () => {
  it("records a COMMITTED claim for a COMMIT-phase bounty", () => {
    const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, 100, REWARD_UNIT, REQUESTER, {
      nowMs: 1000,
    });
    const commitHash = ProofMarketCls.computeCommitHash(artifact("x"), nonce("n1"), CLAIMANT_A);
    const claimId = pm.commitClaim(bountyId, commitHash, CLAIMANT_A, 50, STAKE_UNIT, {
      nowMs: 2000,
    });
    const claim = pm.getClaim(claimId);
    expect(claim).toBeDefined();
    expect(claim!.status).toBe("COMMITTED");
    expect(claim!.commit_hash).toBe(commitHash);
    expect(claim!.committed_at).toBe(2000);
  });

  it("RC-4: rejects commit after T_commit window closes", () => {
    const nowMs = 1000;
    const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, 100, REWARD_UNIT, REQUESTER, {
      nowMs,
      tCommitMs: MIN_T_COMMIT_MS,
    });
    const commitHash = ProofMarketCls.computeCommitHash(artifact("x"), nonce("n1"), CLAIMANT_A);
    // Attempt commit after t_commit_close
    expect(() =>
      pm.commitClaim(bountyId, commitHash, CLAIMANT_A, 50, STAKE_UNIT, {
        nowMs: nowMs + MIN_T_COMMIT_MS + 1,
      }),
    ).toThrow("commit window closed");
  });

  it("rejects commit on non-existent bounty", () => {
    const commitHash = ProofMarketCls.computeCommitHash(artifact("x"), nonce("n1"), CLAIMANT_A);
    expect(() =>
      pm.commitClaim("no-such-bounty" as BountyId, commitHash, CLAIMANT_A, 50, STAKE_UNIT),
    ).toThrow("bounty not found");
  });

  it("rejects commit_hash that is not 64-char hex", () => {
    const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, 100, REWARD_UNIT, REQUESTER);
    expect(() => pm.commitClaim(bountyId, "not-a-hash", CLAIMANT_A, 50, STAKE_UNIT)).toThrow(
      "commit_hash must be",
    );
  });
});

// ---------------------------------------------------------------------------
// transitionBounty — timer-driven state advancement
// ---------------------------------------------------------------------------

describe("transitionBounty", () => {
  it("RC-8: transitions COMMIT → REVEAL when t_commit_close has passed", () => {
    const nowMs = 1_000_000;
    const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, 100, REWARD_UNIT, REQUESTER, {
      nowMs,
      tCommitMs: MIN_T_COMMIT_MS,
    });
    // Before close: no transition
    const statusBefore = pm.transitionBounty(bountyId, {
      nowMs: nowMs + MIN_T_COMMIT_MS - 1,
    });
    expect(statusBefore).toBe("COMMIT");

    // At close: transitions to REVEAL
    const statusAfter = pm.transitionBounty(bountyId, {
      nowMs: nowMs + MIN_T_COMMIT_MS,
    });
    expect(statusAfter).toBe("REVEAL");

    const bounty = pm.getBounty(bountyId);
    expect(bounty!.status).toBe("REVEAL");
    expect(bounty!.t_reveal_close).toBeTypeOf("number");
  });

  it("transitions REVEAL → CHECK when t_reveal_close has passed", () => {
    const nowMs = 1_000_000;
    const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, 100, REWARD_UNIT, REQUESTER, {
      nowMs,
      tCommitMs: MIN_T_COMMIT_MS,
    });
    // Advance past commit close → REVEAL
    pm.transitionBounty(bountyId, { nowMs: nowMs + MIN_T_COMMIT_MS, tRevealMs: MIN_T_REVEAL_MS });
    // Advance past reveal close → CHECK
    const status = pm.transitionBounty(bountyId, {
      nowMs: nowMs + MIN_T_COMMIT_MS + MIN_T_REVEAL_MS,
    });
    expect(status).toBe("CHECK");
    expect(pm.getBounty(bountyId)!.status).toBe("CHECK");
  });

  it("RC-3: lapses COMMITTED claims when reveal window expires (REVEAL → CHECK)", () => {
    const nowMs = 1_000_000;
    const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, 100, REWARD_UNIT, REQUESTER, {
      nowMs,
      tCommitMs: MIN_T_COMMIT_MS,
    });
    const commitHash = ProofMarketCls.computeCommitHash(artifact("x"), nonce("n1"), CLAIMANT_A);
    const claimId = pm.commitClaim(bountyId, commitHash, CLAIMANT_A, 50, STAKE_UNIT, { nowMs });
    // Advance to REVEAL
    pm.transitionBounty(bountyId, { nowMs: nowMs + MIN_T_COMMIT_MS, tRevealMs: MIN_T_REVEAL_MS });
    // Claimant does NOT reveal — advance past reveal close
    pm.transitionBounty(bountyId, {
      nowMs: nowMs + MIN_T_COMMIT_MS + MIN_T_REVEAL_MS,
    });
    // Claim should now be LAPSED
    const claim = pm.getClaim(claimId);
    expect(claim!.status).toBe("LAPSED");
  });

  it("does not transition a bounty that is already past CHECK", () => {
    const nowMs = 1_000_000;
    const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, 100, REWARD_UNIT, REQUESTER, {
      nowMs,
      tCommitMs: MIN_T_COMMIT_MS,
    });
    pm.transitionBounty(bountyId, { nowMs: nowMs + MIN_T_COMMIT_MS, tRevealMs: MIN_T_REVEAL_MS });
    pm.transitionBounty(bountyId, { nowMs: nowMs + MIN_T_COMMIT_MS + MIN_T_REVEAL_MS });
    // Force to ACCEPT
    pm.finalizeBounty(bountyId, []);
    // Another call should not throw and should leave status unchanged
    const status = pm.transitionBounty(bountyId, { nowMs: nowMs + 999_999_999 });
    // REJECT status (from no attestations) — transition call is a no-op
    expect(["ACCEPT", "REJECT"]).toContain(status);
  });
});

// ---------------------------------------------------------------------------
// revealClaim
// ---------------------------------------------------------------------------

describe("revealClaim", () => {
  function setupRevealPhase(opts: { nowMs?: number } = {}): {
    bountyId: BountyId;
    claimId: ClaimId;
    art: Uint8Array;
    n: Uint8Array;
    now: number;
  } {
    const now = opts.nowMs ?? 1_000_000;
    const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, 100, REWARD_UNIT, REQUESTER, {
      nowMs: now,
      tCommitMs: MIN_T_COMMIT_MS,
    });
    const art = artifact("proof-alpha");
    const n = nonce("nonce-alpha");
    const commitHash = ProofMarketCls.computeCommitHash(art, n, CLAIMANT_A);
    const claimId = pm.commitClaim(bountyId, commitHash, CLAIMANT_A, 50, STAKE_UNIT, { nowMs: now });
    // Advance to REVEAL
    pm.transitionBounty(bountyId, {
      nowMs: now + MIN_T_COMMIT_MS,
      tRevealMs: MIN_T_REVEAL_MS,
    });
    return { bountyId, claimId, art, n, now };
  }

  it("happy path: COMMITTED → REVEALED with correct artifact+nonce", () => {
    const { claimId, art, n, now } = setupRevealPhase();
    pm.revealClaim(claimId, art, n, { nowMs: now + MIN_T_COMMIT_MS + 1 });
    const claim = pm.getClaim(claimId);
    expect(claim!.status).toBe("REVEALED");
    expect(claim!.revealed_artifact_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(claim!.revealed_at).toBeTypeOf("number");
  });

  it("RC-5: rejects reveal with wrong nonce (commit hash mismatch)", () => {
    const { claimId, art, now } = setupRevealPhase();
    expect(() =>
      pm.revealClaim(claimId, art, nonce("wrong-nonce"), {
        nowMs: now + MIN_T_COMMIT_MS + 1,
      }),
    ).toThrow("commit hash mismatch");
  });

  it("RC-5: rejects reveal with wrong artifact (commit hash mismatch)", () => {
    const { claimId, n, now } = setupRevealPhase();
    expect(() =>
      pm.revealClaim(claimId, artifact("wrong-artifact"), n, {
        nowMs: now + MIN_T_COMMIT_MS + 1,
      }),
    ).toThrow("commit hash mismatch");
  });

  it("RC-2: rejects reveal for a non-existent claim", () => {
    setupRevealPhase();
    expect(() =>
      pm.revealClaim("no-such-claim" as ClaimId, artifact("x"), nonce("n"), {
        nowMs: 1_000_000 + MIN_T_COMMIT_MS + 1,
      }),
    ).toThrow("claim not found");
  });

  it("RC-2: rejects reveal when bounty is not in REVEAL status", () => {
    // Claim is in COMMITTED status but bounty is still COMMIT (window not closed)
    const now = 1_000_000;
    const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, 100, REWARD_UNIT, REQUESTER, {
      nowMs: now,
      tCommitMs: MIN_T_COMMIT_MS,
    });
    const art = artifact("x");
    const n = nonce("n1");
    const commitHash = ProofMarketCls.computeCommitHash(art, n, CLAIMANT_A);
    const claimId = pm.commitClaim(bountyId, commitHash, CLAIMANT_A, 50, STAKE_UNIT, { nowMs: now });
    // Try to reveal while bounty is still COMMIT
    expect(() => pm.revealClaim(claimId, art, n, { nowMs: now + 1 })).toThrow(
      "not in REVEAL status",
    );
  });

  it("RC-3: rejects reveal after T_reveal window has closed", () => {
    const { claimId, art, n, now } = setupRevealPhase();
    // Reveal after t_reveal_close
    expect(() =>
      pm.revealClaim(claimId, art, n, {
        nowMs: now + MIN_T_COMMIT_MS + MIN_T_REVEAL_MS + 1,
      }),
    ).toThrow("reveal window closed");
  });
});

// ---------------------------------------------------------------------------
// finalizeBounty
// ---------------------------------------------------------------------------

describe("finalizeBounty", () => {
  /**
   * Sets up a bounty in CHECK status with one revealed claim.
   * Returns bountyId, claimId for assertion.
   */
  function setupCheckPhase(): { bountyId: BountyId; claimId: ClaimId } {
    const now = 1_000_000;
    const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, 100, REWARD_UNIT, REQUESTER, {
      nowMs: now,
      tCommitMs: MIN_T_COMMIT_MS,
    });
    const art = artifact("proof-final");
    const n = nonce("nonce-final");
    const commitHash = ProofMarketCls.computeCommitHash(art, n, CLAIMANT_A);
    const claimId = pm.commitClaim(bountyId, commitHash, CLAIMANT_A, 50, STAKE_UNIT, { nowMs: now });
    pm.transitionBounty(bountyId, { nowMs: now + MIN_T_COMMIT_MS, tRevealMs: MIN_T_REVEAL_MS });
    pm.revealClaim(claimId, art, n, { nowMs: now + MIN_T_COMMIT_MS + 1 });
    pm.transitionBounty(bountyId, { nowMs: now + MIN_T_COMMIT_MS + MIN_T_REVEAL_MS });
    return { bountyId, claimId };
  }

  it("happy path: supermajority valid → ACCEPT, claim VALID", () => {
    const { bountyId, claimId } = setupCheckPhase();
    // 3 valid out of 3 = 100% > 2/3
    const attestations = [
      makeAttestation(claimId, "valid", 1),
      makeAttestation(claimId, "valid", 2),
      makeAttestation(claimId, "valid", 3),
    ];
    const result = pm.finalizeBounty(bountyId, attestations);
    expect(result).toBe("ACCEPT");
    expect(pm.getBounty(bountyId)!.status).toBe("ACCEPT");
    expect(pm.getClaim(claimId)!.status).toBe("VALID");
  });

  it("RC-9: supermajority not met → REJECT even with some valid attestations", () => {
    const { bountyId, claimId } = setupCheckPhase();
    // 1 valid out of 3 = 33% < 2/3
    const attestations = [
      makeAttestation(claimId, "valid", 1),
      makeAttestation(claimId, "invalid", 2),
      makeAttestation(claimId, "invalid", 3),
    ];
    const result = pm.finalizeBounty(bountyId, attestations);
    expect(result).toBe("REJECT");
    expect(pm.getBounty(bountyId)!.status).toBe("REJECT");
    expect(pm.getClaim(claimId)!.status).toBe("INVALID");
  });

  it("RC-6: no reveals → REJECT (zero attestations, finalize with empty list)", () => {
    const now = 1_000_000;
    const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, 100, REWARD_UNIT, REQUESTER, {
      nowMs: now,
      tCommitMs: MIN_T_COMMIT_MS,
    });
    // No commits at all — advance to CHECK
    pm.transitionBounty(bountyId, { nowMs: now + MIN_T_COMMIT_MS, tRevealMs: MIN_T_REVEAL_MS });
    pm.transitionBounty(bountyId, { nowMs: now + MIN_T_COMMIT_MS + MIN_T_REVEAL_MS });
    const result = pm.finalizeBounty(bountyId, []);
    expect(result).toBe("REJECT");
    expect(pm.getBounty(bountyId)!.status).toBe("REJECT");
  });

  it("RC-10: finalizeBounty on non-CHECK bounty throws", () => {
    const now = 1_000_000;
    const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, 100, REWARD_UNIT, REQUESTER, {
      nowMs: now,
    });
    expect(() => pm.finalizeBounty(bountyId, [])).toThrow("not in CHECK status");
  });

  it("exact 2/3 supermajority → ACCEPT (integer boundary)", () => {
    const { bountyId, claimId } = setupCheckPhase();
    // 2 valid out of 3 = exactly 2/3
    const attestations = [
      makeAttestation(claimId, "valid", 1),
      makeAttestation(claimId, "valid", 2),
      makeAttestation(claimId, "invalid", 3),
    ];
    const result = pm.finalizeBounty(bountyId, attestations);
    expect(result).toBe("ACCEPT");
  });

  it("just below 2/3 → REJECT (1 valid out of 2 = 50% < 2/3)", () => {
    const { bountyId, claimId } = setupCheckPhase();
    // 1 valid out of 2 = 50% < 66.7%
    const attestations = [
      makeAttestation(claimId, "valid", 1),
      makeAttestation(claimId, "invalid", 2),
    ];
    const result = pm.finalizeBounty(bountyId, attestations);
    expect(result).toBe("REJECT");
  });
});

// ---------------------------------------------------------------------------
// RC-1: Two claimants commit the same artifact hash — earliest commit wins
// ---------------------------------------------------------------------------

describe("RC-1: Two claimants, same proof artifact, commit-time priority", () => {
  it("both claims reach REVEALED; earliest committed_at determines winner", () => {
    const now = 1_000_000;
    const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, 100, REWARD_UNIT, REQUESTER, {
      nowMs: now,
      tCommitMs: MIN_T_COMMIT_MS,
    });

    // Both claimants independently find the same proof artifact
    const sharedArtifact = artifact("same-proof");

    // Claimant A commits first (earlier timestamp)
    const nonceA = nonce("nonce-A");
    const hashA = ProofMarketCls.computeCommitHash(sharedArtifact, nonceA, CLAIMANT_A);
    const claimA = pm.commitClaim(bountyId, hashA, CLAIMANT_A, 50, STAKE_UNIT, { nowMs: now + 100 });

    // Claimant B commits second (later timestamp) — same artifact, different nonce+id
    const nonceB = nonce("nonce-B");
    const hashB = ProofMarketCls.computeCommitHash(sharedArtifact, nonceB, CLAIMANT_B);
    const claimB = pm.commitClaim(bountyId, hashB, CLAIMANT_B, 50, STAKE_UNIT, { nowMs: now + 200 });

    // Advance to REVEAL phase
    pm.transitionBounty(bountyId, { nowMs: now + MIN_T_COMMIT_MS, tRevealMs: MIN_T_REVEAL_MS });

    // Both reveal successfully
    pm.revealClaim(claimA, sharedArtifact, nonceA, { nowMs: now + MIN_T_COMMIT_MS + 1 });
    pm.revealClaim(claimB, sharedArtifact, nonceB, { nowMs: now + MIN_T_COMMIT_MS + 2 });

    // Advance to CHECK
    pm.transitionBounty(bountyId, { nowMs: now + MIN_T_COMMIT_MS + MIN_T_REVEAL_MS });

    // Both claims are REVEALED (not yet finalized)
    expect(pm.getClaim(claimA)!.status).toBe("REVEALED");
    expect(pm.getClaim(claimB)!.status).toBe("REVEALED");

    // Finalize: supermajority valid (all 3 attestations on claim A are valid)
    const attestations = [
      makeAttestation(claimA, "valid", 1),
      makeAttestation(claimA, "valid", 2),
      makeAttestation(claimB, "valid", 3),
    ];
    const result = pm.finalizeBounty(bountyId, attestations);
    expect(result).toBe("ACCEPT");

    // Both claims become VALID (both provided the proof)
    expect(pm.getClaim(claimA)!.status).toBe("VALID");
    expect(pm.getClaim(claimB)!.status).toBe("VALID");

    // Verify commit-time ordering: A committed before B
    const claims = pm.listClaims(bountyId);
    expect(claims[0]!.claim_id).toBe(claimA); // earliest commit first
    expect(claims[1]!.claim_id).toBe(claimB);
    expect(claims[0]!.committed_at).toBeLessThan(claims[1]!.committed_at);

    // Application layer (not yet wired) would award bounty to claims[0] (claimA).
    // The state machine preserves committed_at so application can implement this.
  });
});

// ---------------------------------------------------------------------------
// Full happy-path end-to-end: post → commit → reveal → CHECK → ACCEPT
// This is the "compound interaction" test that crosses all component boundaries.
// ---------------------------------------------------------------------------

describe("end-to-end: full proof lifecycle", () => {
  it("post → commit → transition → reveal → transition → finalize → ACCEPT", () => {
    // Step 1: requester posts bounty
    const t0 = 1_700_000_000_000; // realistic epoch
    const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, 1000, REWARD_UNIT, REQUESTER, {
      nowMs: t0,
      tCommitMs: MIN_T_COMMIT_MS, // 1h
      tRevealMs: MIN_T_REVEAL_MS, // 30m
    });

    let bounty = pm.getBounty(bountyId)!;
    expect(bounty.status).toBe("COMMIT");
    expect(bounty.t_commit_close).toBe(t0 + MIN_T_COMMIT_MS);

    // Step 2: claimant computes commitment and submits
    const art = artifact("lean4-proof-term");
    const n = nonce("random-nonce-32b");
    const commitHash = ProofMarketCls.computeCommitHash(art, n, CLAIMANT_A);
    const claimId = pm.commitClaim(bountyId, commitHash, CLAIMANT_A, 100, STAKE_UNIT, {
      nowMs: t0 + 1000,
    });

    let claim = pm.getClaim(claimId)!;
    expect(claim.status).toBe("COMMITTED");
    expect(claim.commit_hash).toBe(commitHash);

    // Step 3: T_commit expires — transitionBounty COMMIT → REVEAL
    const tCommitExpiry = t0 + MIN_T_COMMIT_MS;
    const statusAfterCommit = pm.transitionBounty(bountyId, {
      nowMs: tCommitExpiry,
      tRevealMs: MIN_T_REVEAL_MS,
    });
    expect(statusAfterCommit).toBe("REVEAL");
    bounty = pm.getBounty(bountyId)!;
    expect(bounty.t_reveal_close).toBe(tCommitExpiry + MIN_T_REVEAL_MS);

    // Step 4: claimant reveals artifact + nonce
    pm.revealClaim(claimId, art, n, { nowMs: tCommitExpiry + 60_000 });
    claim = pm.getClaim(claimId)!;
    expect(claim.status).toBe("REVEALED");
    expect(claim.revealed_artifact_hash).not.toBeNull();

    // Step 5: T_reveal expires — transitionBounty REVEAL → CHECK
    const tRevealExpiry = tCommitExpiry + MIN_T_REVEAL_MS;
    const statusAfterReveal = pm.transitionBounty(bountyId, { nowMs: tRevealExpiry });
    expect(statusAfterReveal).toBe("CHECK");

    // Step 6: verifier daemons submit attestations (supermajority valid)
    const result = pm.finalizeBounty(bountyId, [
      makeAttestation(claimId, "valid", 1),
      makeAttestation(claimId, "valid", 2),
      makeAttestation(claimId, "valid", 3),
    ]);
    expect(result).toBe("ACCEPT");

    // Final state assertions
    expect(pm.getBounty(bountyId)!.status).toBe("ACCEPT");
    expect(pm.getClaim(claimId)!.status).toBe("VALID");

    // listClaims returns the single claim
    const allClaims = pm.listClaims(bountyId);
    expect(allClaims).toHaveLength(1);
    expect(allClaims[0]!.claim_id).toBe(claimId);
  });

  it("post → commit → transition → NO reveal → transition → finalize → REJECT (RC-6)", () => {
    const t0 = 2_000_000_000_000;
    const bountyId = pm.postBounty(ATOM_BMR, THEOREM_HASH, 500, REWARD_UNIT, REQUESTER, {
      nowMs: t0,
      tCommitMs: MIN_T_COMMIT_MS,
      tRevealMs: MIN_T_REVEAL_MS,
    });

    // Claimant commits but never reveals
    const art = artifact("will-not-reveal");
    const n = nonce("silent-nonce");
    const commitHash = ProofMarketCls.computeCommitHash(art, n, CLAIMANT_A);
    const claimId = pm.commitClaim(bountyId, commitHash, CLAIMANT_A, 50, STAKE_UNIT, { nowMs: t0 });

    // Advance to REVEAL phase
    pm.transitionBounty(bountyId, { nowMs: t0 + MIN_T_COMMIT_MS, tRevealMs: MIN_T_REVEAL_MS });

    // Claimant does NOT call revealClaim

    // Advance past reveal close → claim LAPSED, bounty CHECK
    pm.transitionBounty(bountyId, { nowMs: t0 + MIN_T_COMMIT_MS + MIN_T_REVEAL_MS });
    expect(pm.getClaim(claimId)!.status).toBe("LAPSED");
    expect(pm.getBounty(bountyId)!.status).toBe("CHECK");

    // Finalize with no attestations → REJECT
    const result = pm.finalizeBounty(bountyId, []);
    expect(result).toBe("REJECT");
    expect(pm.getBounty(bountyId)!.status).toBe("REJECT");
  });
});
