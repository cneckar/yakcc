// SPDX-License-Identifier: MIT
/**
 * Ed25519 verifier identity — load or create a persistent keypair.
 *
 * The keypair is persisted as a single hex-encoded private key (64 hex chars
 * for the 32-byte seed) in a file under `~/.yakcc/verifier-key` by default.
 * The corresponding public key is always derived from the private key so
 * there is a single source of truth.
 *
 * @decision DEC-PROOF-VERIFIER-IDENTITY-001
 * title: Node.js native crypto for Ed25519 — no @noble/curves dep
 * status: decided
 * rationale:
 *   Node.js 22 ships native Ed25519 support via node:crypto (KeyObject API).
 *   @noble/curves is not yet in the workspace lock file.  Adding it as a new
 *   dependency for one package, when the native implementation is zero-overhead
 *   and already audited by the Node team, would be premature.  If the proof-
 *   market layer later requires @noble/curves for other reasons (ECC primitives,
 *   ECDSA), we consolidate then.  For MVP: node:crypto only.
 *
 * @module identity
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

/** A loaded Ed25519 keypair. */
export interface VerifierIdentity {
  /** Raw 32-byte Ed25519 private key seed. */
  readonly privateKey: Uint8Array;
  /** Raw 32-byte Ed25519 public key. */
  readonly publicKey: Uint8Array;
}

/** Default path for the persisted private key. */
export const DEFAULT_KEY_PATH = `${homedir()}/.yakcc/verifier-key`;

/**
 * Export a Node.js Ed25519 `KeyObject` to its raw 32-byte seed.
 *
 * Node's `pkcs8` DER export for Ed25519 private keys is:
 *   30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 <32-byte seed>
 * The seed starts at byte offset 16.
 */
function privateKeyObjectToBytes(keyObj: ReturnType<typeof createPrivateKey>): Uint8Array {
  const der = keyObj.export({ type: "pkcs8", format: "der" }) as Buffer;
  // Ed25519 PKCS8 DER: fixed 48-byte wrapper, seed is last 32 bytes
  return new Uint8Array(der.subarray(der.length - 32));
}

/**
 * Export a Node.js Ed25519 public `KeyObject` to its raw 32-byte point.
 *
 * `spki` DER for Ed25519:
 *   30 2a 30 05 06 03 2b 65 70 03 21 00 <32-byte public key>
 * The public key bytes start at byte offset 12.
 */
function publicKeyObjectToBytes(keyObj: ReturnType<typeof createPublicKey>): Uint8Array {
  const der = keyObj.export({ type: "spki", format: "der" }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

/**
 * Reconstruct a private `KeyObject` from a 32-byte raw seed.
 *
 * We build the PKCS8 DER wrapper by hand.  The wrapper is a fixed 16-byte
 * prefix for Ed25519 private keys.
 */
function bytesToPrivateKeyObject(seed: Uint8Array): ReturnType<typeof createPrivateKey> {
  // PKCS8 DER prefix for Ed25519 private key (OneAsymmetricKey / RFC 8410)
  const prefix = Buffer.from(
    "302e020100300506032b657004220420",
    "hex",
  );
  const der = Buffer.concat([prefix, seed]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/**
 * Load an existing identity from `keyPath` or create a new one.
 *
 * - If the file exists: reads the hex-encoded seed (32 bytes = 64 hex chars),
 *   derives the public key.
 * - If the file does not exist: generates a fresh keypair, writes the hex seed
 *   to `keyPath` (creating parent directories as needed).
 *
 * @param keyPath  Path to the persisted private key file.  Defaults to
 *   `~/.yakcc/verifier-key`.
 */
export function loadOrCreateIdentity(
  keyPath: string = DEFAULT_KEY_PATH,
): VerifierIdentity {
  if (existsSync(keyPath)) {
    const hex = readFileSync(keyPath, "utf8").trim();
    if (hex.length !== 64) {
      throw new Error(
        `verifier identity file at ${keyPath} must contain a 64-char hex string (32-byte seed); got ${hex.length} chars`,
      );
    }
    const seed = new Uint8Array(Buffer.from(hex, "hex"));
    const privObj = bytesToPrivateKeyObject(seed);
    const pubObj = createPublicKey(privObj);
    return {
      privateKey: privateKeyObjectToBytes(privObj),
      publicKey: publicKeyObjectToBytes(pubObj),
    };
  }

  // Generate fresh keypair
  const { privateKey: privObj, publicKey: pubObj } = generateKeyPairSync("ed25519");
  const privateKey = privateKeyObjectToBytes(privObj);
  const publicKey = publicKeyObjectToBytes(pubObj);

  // Persist
  const dir = dirname(keyPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyPath, Buffer.from(privateKey).toString("hex") + "\n", {
    mode: 0o600,
  });

  return { privateKey, publicKey };
}
