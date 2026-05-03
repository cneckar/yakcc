// SPDX-License-Identifier: MIT
// @decision DEC-TRIPLET-IDENTITY-020: BlockMerkleRoot encoding (L0).
// Status: decided (MASTER_PLAN.md, VERIFICATION.md DEC-VERIFY-002)
// Rationale: Block identity migrates from ContractId = BLAKE3(canonicalize(spec))
// to BlockMerkleRoot = BLAKE3(spec_hash || impl_hash || proof_root). The L0-specific
// encoding decisions below are bounded to L0; L1+ may adopt richer encodings.
//
// Concrete L0 encoding:
//   spec_hash  = BLAKE3(canonicalize(spec.yak))
//              — same canonicalization rule as v0 contractId(ContractSpec).
//              — SpecHash values are continuous with v0 ContractId values when
//                applied to a spec that omits the v1-only required fields.
//   impl_hash  = BLAKE3(impl.ts file bytes, as UTF-8)
//              — no ts-morph normalization at L0 (deferred to L1+ where the
//                totality pass normalizes the AST anyway; picking file bytes now
//                and AST bytes later is consistent with the strict partial-order
//                refinement in VERIFICATION.md §"What each level guarantees").
//   proof_root = BLAKE3(canonicalize(manifest.json) || concat(BLAKE3(artifact_bytes)
//                  in the order the manifest declares))
//              — manifest is canonicalized (same rule as spec.yak) so that
//                manifest field-order differences are not identity-significant.
//              — artifact bytes are hashed independently and concatenated so that
//                each artifact contributes to the root independently of the others.
//   block_merkle_root = BLAKE3(spec_hash || impl_hash || proof_root)
//              — spec_hash, impl_hash, proof_root are the 32-byte raw digests
//                (not hex strings), concatenated in that order, then hashed once.
//
// Superseding this encoding requires a new DEC-ID entry in MASTER_PLAN.md per
// DEC-IDENTITY-005. Implementations that change the encoding without a new DEC
// entry violate the single-source-of-truth invariant.

import { blake3 } from "@noble/hashes/blake3.js";
import { canonicalize } from "./canonicalize.js";
import type { ContractSpec } from "./index.js";
import type { ProofManifest } from "./proof-manifest.js";
import type { SpecHash, SpecYak } from "./spec-yak.js";

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

/**
 * The content-address of a Block triplet (spec.yak, impl.ts, proof/).
 * A 64-character lowercase hex string encoding BLAKE3-256 output (32 bytes).
 *
 * Distinct from SpecHash: two blocks with the same SpecHash are alternative
 * implementations of the same contract; their BlockMerkleRoots differ.
 *
 * References between blocks (a composition pointing at a sub-block) carry
 * BlockMerkleRoot, not SpecHash (VERIFICATION.md DEC-VERIFY-002).
 */
export type BlockMerkleRoot = string & { readonly __brand: "BlockMerkleRoot" };

// ---------------------------------------------------------------------------
// BlockTriplet — the input shape for blockMerkleRoot()
// ---------------------------------------------------------------------------

/**
 * @decision DEC-V2-FOREIGN-BLOCK-SCHEMA-001 (sub-A: kind discriminator on Triplet)
 * Status: decided (PLAN_WI_V2_04.md §2.1, L1 contracts layer)
 * @rationale Foreign atoms are opaque leaves keyed by (pkg, export, dtsHash) per
 *            DEC-IDENTITY-005. The `kind` discriminator participates in BlockMerkleRoot
 *            so foreign and local atoms with otherwise-identical fields produce
 *            different roots. Approach (b) was chosen: discriminated union on the
 *            triplet type rather than a separate table, satisfying Sacred Practice #12
 *            (one canonical type for "block by merkle root"). The `kind` field defaults
 *            to `'local'` so existing callsites compile without change (L1-I2).
 * @scope L1 only — schema migration lands in L2.
 */

/**
 * Fields shared or specific to a local (yakcc-shaved) block triplet.
 *
 * A LocalTriplet is the original "local impl" form: spec.yak + impl.ts + proof/.
 * The `kind: 'local'` discriminator defaults to `'local'` so existing callsites
 * that omit `kind` continue to compile without modification (L1-I2).
 */
export interface LocalTriplet {
  /** Discriminator. Defaults to `'local'` for backwards compat (L1-I2). */
  readonly kind?: "local";
  /** The parsed spec.yak content. */
  readonly spec: SpecYak;
  /** The impl.ts source text as UTF-8. At L0: raw file bytes, no normalization. */
  readonly implSource: string;
  /** The parsed proof/manifest.json content. */
  readonly manifest: ProofManifest;
  /**
   * Bytes for each artifact declared in manifest.artifacts, keyed by the
   * artifact's path field. All declared paths must be present.
   */
  readonly artifacts: Map<string, Uint8Array>;
}

/**
 * Fields for a foreign (npm-package or Node built-in) block triplet.
 *
 * Foreign blocks are opaque leaves. Their identity is keyed exclusively on
 * (kind, pkg, export, dtsHash?) per DEC-IDENTITY-005 and DEC-V2-FOREIGN-BLOCK-SCHEMA-001.
 * The `implSource` / `spec` / `manifest` / `artifacts` fields of a LocalTriplet
 * are intentionally absent — foreign blocks carry no shaved implementation.
 */
export interface ForeignTripletFields {
  /** Discriminator — must be `'foreign'` for this variant. */
  readonly kind: "foreign";
  /** The npm package name or Node built-in specifier, e.g. `"node:fs"`, `"ts-morph"`. */
  readonly pkg: string;
  /** The exported symbol name consumed at the use site, e.g. `"readFileSync"`. */
  readonly export: string;
  /**
   * Optional BLAKE3 hash of the declaration text from the package's `.d.ts` file.
   * When present, two foreign blocks with identical (pkg, export) but different
   * `.d.ts` shapes receive different BlockMerkleRoots (type drift is identity-significant).
   * When absent, identity is keyed on (pkg, export) only.
   */
  readonly dtsHash?: string;
}

/**
 * The data the blockMerkleRoot() function needs to derive a block's identity.
 *
 * `BlockTriplet` is a discriminated union of LocalTriplet | ForeignTripletFields.
 * The `kind` field is the discriminator:
 *   - `kind: 'local'` (or absent) → local yakcc-shaved block
 *   - `kind: 'foreign'`           → foreign npm/Node block (opaque leaf)
 *
 * T01 is pure-function only; reading files from disk is T02's job. Callers
 * materialize the artifact bytes from whatever source they prefer (filesystem,
 * in-memory fixture, database blob) and pass the results here.
 *
 * Design note: Map<string, Uint8Array> is the simplest shape that does not
 * lock T02..T06 into a specific I/O strategy. T02 will populate this from
 * filesystem reads; T03 will populate it from database blobs; tests populate
 * it from inline literals. The function itself has no I/O dependencies.
 */
export type BlockTriplet = LocalTriplet | ForeignTripletFields;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();

/** Concatenate multiple Uint8Arrays into one. */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** Convert a Uint8Array to a lowercase hex string. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// SpecHash derivation (re-exported for the continuity test)
// ---------------------------------------------------------------------------

/**
 * Derive a SpecHash from a SpecYak.
 *
 * SpecHash = BLAKE3(canonicalize(spec.yak))
 *
 * This is continuous with v0's contractId(ContractSpec) derivation: when a
 * SpecYak is projected to the ContractSpec shape (dropping v1-only fields),
 * specHash(spec) === contractId(projection). This continuity is what lets
 * T03's registry migration re-index without recomputing SpecHash from scratch.
 *
 * The canonicalize() function accepts ContractSpec; SpecYak is structurally
 * compatible (a strict superset), so the cast is safe.
 */
export function specHash(spec: SpecYak): SpecHash {
  const bytes = canonicalize(spec as unknown as ContractSpec);
  const digest = blake3(bytes);
  return bytesToHex(digest) as SpecHash;
}

// ---------------------------------------------------------------------------
// blockMerkleRoot — the primary identity derivation
// ---------------------------------------------------------------------------

/**
 * Derive the BlockMerkleRoot for a block triplet.
 *
 * Dispatches on `triplet.kind`:
 *
 * **Local (kind: 'local' or omitted) — L0 encoding (DEC-TRIPLET-IDENTITY-020):**
 *
 *   spec_hash      = BLAKE3(canonicalize(spec.yak))           [32 raw bytes]
 *   impl_hash      = BLAKE3(UTF-8 bytes of implSource)        [32 raw bytes]
 *   proof_root     = BLAKE3(                                   [32 raw bytes]
 *                      canonicalize(manifest.json)
 *                      || BLAKE3(artifact[0].bytes)
 *                      || BLAKE3(artifact[1].bytes)
 *                      || ...  [in manifest declaration order]
 *                    )
 *   block_merkle_root = BLAKE3(spec_hash || impl_hash || proof_root)
 *
 * Throws if any artifact declared in manifest.artifacts is missing from the
 * artifacts Map.
 *
 * **Foreign (kind: 'foreign') — package-keyed identity (DEC-V2-FOREIGN-BLOCK-SCHEMA-001):**
 *
 *   foreign_identity_bytes = canonicalize({ kind, pkg, export, dtsHash? })
 *   block_merkle_root = BLAKE3(foreign_identity_bytes)
 *
 * The hash inputs are (kind, pkg, export, dtsHash?) only — NOT the impl source.
 * This is the "package-keyed identity" property: two foreign references to the same
 * (pkg, export, dtsHash?) always produce the same BlockMerkleRoot regardless of the
 * source file that references them. The `kind` discriminator participates in the hash
 * so a foreign triplet with otherwise-identical fields to a local triplet produces a
 * different root.
 */
export function blockMerkleRoot(triplet: BlockTriplet): BlockMerkleRoot {
  if (triplet.kind === "foreign") {
    return blockMerkleRootForeign(triplet);
  }
  return blockMerkleRootLocal(triplet);
}

/**
 * Derive BlockMerkleRoot for a local (yakcc-shaved) triplet.
 * See blockMerkleRoot() for full encoding spec.
 */
function blockMerkleRootLocal(triplet: LocalTriplet): BlockMerkleRoot {
  // spec_hash: BLAKE3(canonicalize(spec.yak))
  const specBytes = canonicalize(triplet.spec as unknown as ContractSpec);
  const specHashBytes = blake3(specBytes); // 32 raw bytes

  // impl_hash: BLAKE3(UTF-8 bytes of impl.ts)
  const implBytes = TEXT_ENCODER.encode(triplet.implSource);
  const implHashBytes = blake3(implBytes); // 32 raw bytes

  // proof_root: BLAKE3(canonicalize(manifest.json) || concat(BLAKE3(artifact_i)))
  // Step 1: canonicalize the manifest (treats it as a generic JSON object).
  // The ProofManifest is structurally compatible with the JsonValue shape the
  // canonicalizer operates over; cast through unknown is safe here.
  const manifestBytes = canonicalize(triplet.manifest as unknown as ContractSpec);

  // Step 2: hash each artifact in manifest declaration order, then concatenate.
  const artifactHashParts: Uint8Array[] = [];
  for (const artifact of triplet.manifest.artifacts) {
    const artifactBytes = triplet.artifacts.get(artifact.path);
    if (artifactBytes === undefined) {
      throw new Error(
        `blockMerkleRoot: artifact "${artifact.path}" declared in manifest but not found in artifacts Map`,
      );
    }
    artifactHashParts.push(blake3(artifactBytes)); // each is 32 bytes
  }

  // Step 3: BLAKE3(manifest_canonical_bytes || artifact_hash_0 || artifact_hash_1 || ...)
  const proofInput = concatBytes(manifestBytes, ...artifactHashParts);
  const proofRootBytes = blake3(proofInput); // 32 raw bytes

  // block_merkle_root: BLAKE3(spec_hash || impl_hash || proof_root)
  const rootInput = concatBytes(specHashBytes, implHashBytes, proofRootBytes);
  const rootBytes = blake3(rootInput);

  return bytesToHex(rootBytes) as BlockMerkleRoot;
}

/**
 * Derive BlockMerkleRoot for a foreign (opaque leaf) triplet.
 *
 * Identity is keyed on (kind, pkg, export, dtsHash?) only — per DEC-IDENTITY-005
 * and DEC-V2-FOREIGN-BLOCK-SCHEMA-001. The canonical JSON is sorted by key,
 * so the discriminator `kind` always precedes `pkg` alphabetically, ensuring
 * the discriminator participates in the hash input.
 *
 * The `dtsHash` field is omitted from the canonical form when undefined so
 * that absent and absent produce the same root (omitted ≠ null per DEC-CANON-001).
 */
function blockMerkleRootForeign(triplet: ForeignTripletFields): BlockMerkleRoot {
  // Build a plain object with only the identity-significant fields.
  // dtsHash is omitted when undefined so canonicalize() skips it (undefined → omitted).
  const identityObj: Record<string, string> = {
    kind: triplet.kind,
    pkg: triplet.pkg,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    export: triplet.export,
    ...(triplet.dtsHash !== undefined ? { dtsHash: triplet.dtsHash } : {}),
  };

  // canonicalize() sorts keys lexicographically; for this object the order is:
  // dtsHash (when present), export, kind, pkg — deterministic across runtimes.
  const identityBytes = canonicalize(identityObj as unknown as ContractSpec);
  const rootBytes = blake3(identityBytes);
  return bytesToHex(rootBytes) as BlockMerkleRoot;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Narrow a BlockTriplet to LocalTriplet.
 *
 * Returns true when `kind` is `'local'` or absent (backwards-compat default).
 * The absent case covers all existing callsites that were created before the
 * `kind` discriminator was introduced (L1-I2).
 */
export function isLocalTriplet(t: BlockTriplet): t is LocalTriplet {
  return t.kind !== "foreign";
}

/**
 * Narrow a BlockTriplet to ForeignTripletFields.
 *
 * Returns true only when `kind === 'foreign'`.
 */
export function isForeignTriplet(t: BlockTriplet): t is ForeignTripletFields {
  return t.kind === "foreign";
}
