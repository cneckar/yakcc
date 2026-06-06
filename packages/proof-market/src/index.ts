// SPDX-License-Identifier: MIT
// @yakcc/proof-market — public API surface for the proof incentive lifecycle.
// Re-exports everything from proof-market.ts and retraction.ts so consumers
// import from "@yakcc/proof-market".

export {
  ProofMarket,
  DEFAULT_T_COMMIT_MS,
  DEFAULT_T_REVEAL_MS,
  MIN_T_COMMIT_MS,
  MAX_T_COMMIT_MS,
  MIN_T_REVEAL_MS,
  MAX_T_REVEAL_MS,
  SUPERMAJORITY_NUMERATOR,
  SUPERMAJORITY_DENOMINATOR,
} from "./proof-market.js";
export type {
  BountyId,
  ClaimId,
  AttestationId,
  BountyStatus,
  ClaimStatus,
  AttestationResult,
  BountyRow,
  ClaimRow,
  PostBountyOptions,
} from "./proof-market.js";

// Reputation track (#1085 / Slice E impl)
export {
  RC_ATOM_ACCEPTED,
  RC_PROOF_CLAIM_ACCEPTED,
  RC_VERIFIER_ATTESTATION_CORRECT,
  RC_CLAIM_SLASHED,
  RC_VERIFIER_DISSENT,
  RC_BOOTSTRAP_GRANT,
  RC_HALF_LIFE_MS,
  SYBIL_MAX_ACTIVE_CLAIMS,
  accrueReputation,
  applyDecay,
  bootstrapGrantIfNeeded,
  checkSybilLimit,
  getReputation,
  reputationDeltaForEvent,
  slashReputation,
} from "./reputation.js";
export type { ReputationClock, ReputationEvent } from "./reputation.js";

// Retraction (#1087 / Slice F — counter-proof admission)
export {
  RetractionMarket,
  T_RETRACTION_MS,
  RETRACTION_STAKE_MULTIPLIER,
  RETRACTION_SLASH_HALF_LIFE_MS,
  RETRACTION_REWARD_FRACTION,
} from "./retraction.js";
export type {
  RetractionId,
  RetractionStatus,
  RetractionRow,
  RetractionResolution,
  FileRetractionOptions,
  ResolveRetractionOptions,
} from "./retraction.js";
