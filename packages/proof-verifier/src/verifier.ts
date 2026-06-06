// SPDX-License-Identifier: MIT
/**
 * Core verifier logic: sign/verify attestations and run the checker pipeline.
 *
 * @decision DEC-PROOF-VERIFIER-DAEMON-001
 * title: Verifier daemon MVP — signed attestation pipeline
 * status: decided
 * rationale:
 *   The proof incentive layer (proof-market, #1082) finalises bounty claims by
 *   collecting attestations from a supermajority of registered verifiers.  Each
 *   verifier must produce a deterministic, signed statement about a claim so the
 *   aggregator can detect equivocation and slash misbehaving verifiers.
 *
 *   Design choices for MVP:
 *   1. Ed25519 over secp256k1 — constant-time, no cofactor issues, matches the
 *      existing Node.js 22 native crypto KeyObject API (DEC-PROOF-VERIFIER-
 *      IDENTITY-001).  Secp256k1 is deferred until on-chain verification is
 *      required (currently out of scope).
 *   2. Canonical JSON payload — `JSON.stringify` with sorted keys via a small
 *      helper.  No CBOR or protobuf to keep the MVP dependency surface flat.
 *      Determinism: same inputs → identical byte sequence → identical payload
 *      hash even across different runtimes.
 *   3. Toolchain version pin enforced before invocation — the verifier never
 *      runs the checker with a mismatched toolchain.  This prevents a split
 *      verdict from an environment misconfiguration.
 *   4. Supermajority aggregation and finalizeBounty integration live in
 *      @yakcc/proof-market (shipped in #1082).  This module ONLY produces
 *      attestations; aggregation is out of scope here.
 *   5. Verifier registration / reputation slashing deferred to #1085.  The
 *      registry checks registration at attestation-write time — the daemon
 *      does not enforce it locally.
 *   6. Container / nix-shell sandbox for the Lean process is deferred to
 *      wi-proof-verifier-sandbox-policy.
 *
 * @module verifier
 */

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";

import type { LeanRunResult } from "./lean-runner.js";

// ---------------------------------------------------------------------------
// Canonical JSON serialisation
// ---------------------------------------------------------------------------

/**
 * Serialize `value` to a canonical JSON string where object keys are sorted
 * alphabetically at every level.  This ensures the same logical payload always
 * produces the same byte sequence regardless of insertion order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  const entries = sorted.map(
    (k) =>
      JSON.stringify(k) +
      ":" +
      canonicalJson((value as Record<string, unknown>)[k]),
  );
  return "{" + entries.join(",") + "}";
}

// ---------------------------------------------------------------------------
// Attestation types
// ---------------------------------------------------------------------------

/**
 * The logical content of an attestation — serialised as canonical JSON before
 * signing.  All fields are required so the schema is deterministic.
 */
export interface AttestationPayload {
  /** The claim identifier this attestation covers. */
  readonly claim_id: string;
  /** Checker verdict — `"valid"` only when the proof was accepted. */
  readonly result: "valid" | "invalid";
  /**
   * Toolchain version string from the claim artifact (e.g. `"lean4@4.7.0"`).
   * Included in the payload so the aggregator can detect toolchain-split votes.
   */
  readonly toolchain_version_hash: string;
  /**
   * Hex-encoded SHA-256 of the claim's theorem statement bytes.
   * Binds the attestation to the exact statement — not just the claim id.
   */
  readonly theorem_statement_hash: string;
  /** ISO-8601 UTC timestamp when the attestation was produced. */
  readonly timestamp: string;
}

/** A fully-signed attestation ready for submission to the aggregator. */
export interface Attestation {
  /** Canonical JSON of the {@link AttestationPayload}. */
  readonly payload: string;
  /** Hex-encoded Ed25519 signature over `payload` (UTF-8 bytes). */
  readonly signature: string;
  /** Hex-encoded 32-byte Ed25519 public key of the signing verifier. */
  readonly publicKey: string;
}

// ---------------------------------------------------------------------------
// Key helpers (raw bytes ↔ KeyObject)
// ---------------------------------------------------------------------------

/**
 * Build a PKCS8 DER wrapper around a raw 32-byte Ed25519 seed so Node's
 * `createPrivateKey` can consume it.
 *
 * The wrapper is the standard RFC 8410 OneAsymmetricKey structure for Ed25519.
 */
function seedToPrivateKeyObject(
  seed: Uint8Array,
): ReturnType<typeof createPrivateKey> {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const der = Buffer.concat([prefix, seed]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/**
 * Build an SPKI DER wrapper around a raw 32-byte Ed25519 public key so Node's
 * `createPublicKey` can consume it.
 */
function bytesToPublicKeyObject(
  pubBytes: Uint8Array,
): ReturnType<typeof createPublicKey> {
  // SubjectPublicKeyInfo prefix for Ed25519 (RFC 8410)
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  const der = Buffer.concat([prefix, pubBytes]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sign an attestation payload.
 *
 * Produces a canonical JSON payload from the provided fields and signs it with
 * the given private key (raw 32-byte Ed25519 seed).
 *
 * @returns `{ payload, signature }` — the canonical JSON string and its
 *   hex-encoded Ed25519 signature.
 */
export function signAttestation(
  privateKey: Uint8Array,
  claim_id: string,
  result: "valid" | "invalid",
  toolchain_version_hash: string,
  theorem_statement_hash: string,
  timestamp?: string,
): Pick<Attestation, "payload" | "signature"> {
  const attestPayload: AttestationPayload = {
    claim_id,
    result,
    theorem_statement_hash,
    timestamp: timestamp ?? new Date().toISOString(),
    toolchain_version_hash,
  };

  const payload = canonicalJson(attestPayload);
  const privObj = seedToPrivateKeyObject(privateKey);

  // Ed25519 in node:crypto requires the one-shot sign() API with no hash
  // algorithm (Ed25519 hashes internally). The streaming Sign object pattern
  // (createSign("sha512") + update + sign) is incompatible with Ed25519 —
  // fails with "Unsupported crypto operation" because Ed25519 cannot be
  // combined with an externally-applied digest.
  const sigBuffer = cryptoSign(null, Buffer.from(payload, "utf8"), privObj);

  return { payload, signature: sigBuffer.toString("hex") };
}

/**
 * Verify a previously-produced attestation.
 *
 * @returns `true` when the signature is valid for the given public key and
 *   payload bytes; `false` otherwise (including malformed input).
 */
export function verifyAttestation({
  payload,
  signature,
  publicKey,
}: {
  payload: string;
  signature: string;
  publicKey: Uint8Array | string;
}): boolean {
  try {
    const pubBytes =
      typeof publicKey === "string"
        ? new Uint8Array(Buffer.from(publicKey, "hex"))
        : publicKey;
    const pubObj = bytesToPublicKeyObject(pubBytes);

    return cryptoVerify(
      null,
      Buffer.from(payload, "utf8"),
      pubObj,
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Claim-level orchestration
// ---------------------------------------------------------------------------

/**
 * Parameters for {@link runVerifierForClaim}.
 */
export interface RunVerifierParams {
  /** Unique identifier of the proof claim. */
  readonly claim_id: string;
  /**
   * Raw bytes of the proof artifact file (e.g. the `.lean` file contents).
   * The caller is responsible for fetching / decoding the artifact.
   */
  readonly artifactBytes: Uint8Array;
  /**
   * Hex-encoded SHA-256 of the theorem statement.  Included verbatim in the
   * attestation payload — the verifier does not recompute it.
   */
  readonly theorem_statement_hash: string;
  /**
   * Toolchain version string from the claim (e.g. `"lean4@4.7.0"`).
   * Checked against the local Lean installation before invoking the runner.
   */
  readonly checker: string;
  /**
   * A runner function with the same signature as {@link runLeanCheck}.
   * Injected to allow mocking in tests.
   */
  readonly leanRunner: (
    proofFilePath: string,
    requiredVersion: string,
  ) => Promise<LeanRunResult>;
  /** The signing identity (raw private + public key bytes). */
  readonly identity: { privateKey: Uint8Array; publicKey: Uint8Array };
  /**
   * Optional: override the timestamp injected into the attestation.  Useful
   * in tests to produce deterministic payloads.
   */
  readonly timestamp?: string;
}

/**
 * Full result returned by {@link runVerifierForClaim}.
 */
export interface VerifierClaimResult {
  /** The signed attestation. */
  readonly attestation: Attestation;
  /** Raw output from the Lean runner (or the mismatch message). */
  readonly runnerOutput: string;
  /** Lean version detected locally (or `null` when Lean is not installed). */
  readonly localVersion: string | null;
}

/**
 * Run the full verifier pipeline for a single proof claim.
 *
 * Steps:
 * 1. Write artifact bytes to a temp file.
 * 2. Invoke `leanRunner` — which internally checks toolchain version first.
 * 3. Sign the attestation with the provided identity.
 *
 * A toolchain version mismatch causes an `"invalid"` attestation to be issued
 * WITHOUT invoking the lean runner's actual checker logic — the lean runner
 * returns immediately on version mismatch.
 *
 * @throws If the temp file cannot be written or signing fails.
 */
export async function runVerifierForClaim(
  params: RunVerifierParams,
): Promise<VerifierClaimResult> {
  const {
    claim_id,
    artifactBytes,
    theorem_statement_hash,
    checker,
    leanRunner,
    identity,
    timestamp,
  } = params;

  // Write artifact to a temp file that lean can read
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const tmpDir = await mkdtemp(join(tmpdir(), "yakcc-verifier-"));
  const proofFilePath = join(tmpDir, "proof.lean");

  let runResult: LeanRunResult;
  try {
    await writeFile(proofFilePath, artifactBytes);
    runResult = await leanRunner(proofFilePath, checker);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  const { payload, signature } = signAttestation(
    identity.privateKey,
    claim_id,
    runResult.result,
    checker,
    theorem_statement_hash,
    timestamp,
  );

  const attestation: Attestation = {
    payload,
    signature,
    publicKey: Buffer.from(identity.publicKey).toString("hex"),
  };

  return {
    attestation,
    runnerOutput: runResult.output,
    localVersion: runResult.localVersion,
  };
}
