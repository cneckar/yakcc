// SPDX-License-Identifier: MIT
// @yakcc/proof-market — public API surface for the proof incentive lifecycle.
// Re-exports everything from proof-market.ts so consumers import from "@yakcc/proof-market".

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
