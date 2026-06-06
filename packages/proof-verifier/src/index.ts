// SPDX-License-Identifier: MIT
/**
 * @yakcc/proof-verifier — public API surface.
 *
 * Exports the Ed25519 identity helpers, attestation signing/verification,
 * and the Lean proof runner.  The claim-level orchestration pipeline
 * ({@link runVerifierForClaim}) is the primary integration point for the
 * proof-market supermajority aggregator.
 *
 * @module @yakcc/proof-verifier
 */

// Identity
export {
  DEFAULT_KEY_PATH,
  loadOrCreateIdentity,
} from "./identity.js";
export type { VerifierIdentity } from "./identity.js";

// Lean runner
export {
  detectLeanVersion,
  parseLeanVersion,
  runCoqCheck,
  runLeanCheck,
} from "./lean-runner.js";
export type { LeanRunResult } from "./lean-runner.js";

// Core verifier / attestation
export {
  runVerifierForClaim,
  signAttestation,
  verifyAttestation,
} from "./verifier.js";
export type {
  Attestation,
  AttestationPayload,
  RunVerifierParams,
  VerifierClaimResult,
} from "./verifier.js";
