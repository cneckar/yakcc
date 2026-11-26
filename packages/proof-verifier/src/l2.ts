// SPDX-License-Identifier: MIT
/**
 * The L2 verifier as a verifier-as-block (DEC-VERIFY-008; #1421 slice 6): re-checks an L2 block's
 * record and signs an attestation, as `duc.ts` does for I1.
 *
 * What is trusted: the encoder of @yakcc/verify-l2 at the version the payload names, and the
 * solver this verifier runs (named in the payload). The prover that made the record is not
 * trusted: its record is recomputed (DEC-VERIFY-L2-RECORD-001), and the attestation binds the
 * record's hash to the block's root.
 */
import {
  type Callee,
  ENCODER_VERSION,
  type L2Contract,
  l2RecordHash,
  recheckL2,
  solverVersion,
} from "@yakcc/verify-l2";
import { signPayload } from "./verifier.js";

/** The signed content of an L2 attestation. */
export interface L2Payload {
  readonly level: "L2";
  /** The block the attestation is about (its content address). */
  readonly block: string;
  /** BLAKE3 of the L2 record's bytes (the smt_cert artifact). */
  readonly record_hash: string;
  readonly encoder: string;
  /** The solver this verifier decided the queries with. */
  readonly solver: string;
  readonly timestamp: string;
}

export interface L2Attestation {
  readonly payload: string;
  readonly signature: string;
  readonly publicKey: string;
}

export type L2IssueResult =
  | { readonly issued: true; readonly signed: L2Attestation }
  | { readonly issued: false; readonly reasons: readonly string[] };

/**
 * Re-check an L2 record and sign an attestation, or say why not. The callees are the ones this
 * verifier resolves for the block's links, with their roots and L2 status.
 */
export async function issueL2Attestation(params: {
  readonly block: string;
  readonly record: string;
  readonly implSource: string;
  readonly contract: L2Contract;
  readonly callees?: Readonly<Record<string, Callee>>;
  readonly identity: { readonly privateKey: Uint8Array; readonly publicKey: Uint8Array };
  readonly timestamp?: string;
}): Promise<L2IssueResult> {
  const check = await recheckL2(params.record, params.implSource, params.contract, {
    ...(params.callees !== undefined ? { callees: params.callees } : {}),
  });
  if (!check.valid) return { issued: false, reasons: check.reasons };
  const payload: L2Payload = {
    level: "L2",
    block: params.block,
    record_hash: l2RecordHash(params.record),
    encoder: ENCODER_VERSION,
    solver: await solverVersion(),
    timestamp: params.timestamp ?? new Date().toISOString(),
  };
  const signed = signPayload(params.identity.privateKey, payload);
  return {
    issued: true,
    signed: { ...signed, publicKey: Buffer.from(params.identity.publicKey).toString("hex") },
  };
}
