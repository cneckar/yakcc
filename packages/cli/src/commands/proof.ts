// SPDX-License-Identifier: MIT
//
// proof.ts — handlers for `yakcc proof bounty post`, `yakcc proof claim commit`,
//            and `yakcc proof claim reveal`.
//
// @decision DEC-PROOF-CLI-001
// @title Three CLI verbs over @yakcc/proof-market engine (WI-1095)
// @status decided (WI-1095 / issue #1095)
// @rationale
//   The proof-market engine (ProofMarket class) landed in #1082 and is the sole
//   authority for the commit-reveal lifecycle state machine (DEC-PROOF-COMMIT-REVEAL-001).
//   These CLI verbs are pure glue: argparse → engine call → format output.
//
//   THREE VERBS:
//     1. `yakcc proof bounty post <atom_bmr> --theorem <hash|path> --reward <n>`
//        Posts a new bounty. Returns bounty_id on stdout.
//
//     2. `yakcc proof claim commit <bounty_id> --artifact <path> --stake <n>`
//        Reads artifact bytes, generates a 32-byte random nonce, computes commit_hash,
//        calls commitClaim(), and stashes (artifact_bytes_b64, nonce_b64, claim_id)
//        to ~/.yakcc/proof-claims/<claim_id>.json for use by the reveal step.
//        Returns claim_id on stdout.
//
//     3. `yakcc proof claim reveal <claim_id>`
//        Reads stash from ~/.yakcc/proof-claims/<claim_id>.json, calls revealClaim(),
//        deletes the stash on success (leaves it on failure for retry).
//
//   REGISTRY PATH: resolved from YAKCC_PROOF_REGISTRY env var, then --registry flag,
//   then DEFAULT_PROOF_REGISTRY_PATH (.yakcc/registry.sqlite in cwd). This mirrors
//   the pattern used by other commands (registry-init.ts DEFAULT_REGISTRY_PATH).
//
//   STASH DIRECTORY: resolved via an injected homedir() function so tests can redirect
//   stash writes to a temp dir without touching $HOME.
//
//   REQUESTER IDENTITY: defaults to git config user.email (spawned via child_process),
//   then "anonymous" if git is unavailable. Overridable via --requester flag.
//
//   NODE:UTIL PARSEARGS: consistent with the rest of the yakcc CLI surface (DEC-V0-CLI-004).
//   No external argparse dependency.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type BountyId, type ClaimId, ProofMarket } from "@yakcc/proof-market";
import type { Logger } from "../index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default proof registry path, relative to cwd. Mirrors DEFAULT_REGISTRY_PATH in registry-init.ts. */
export const DEFAULT_PROOF_REGISTRY_PATH = ".yakcc/registry.sqlite";

/** Default reward unit. v0 reputation-credit economy. */
const DEFAULT_REWARD_UNIT = "reputation_credit";

/** Default stake unit. */
const DEFAULT_STAKE_UNIT = "reputation_credit";

// ---------------------------------------------------------------------------
// Stash helpers
// ---------------------------------------------------------------------------

/**
 * Shape of the local stash file written by `claim commit` and read by `claim reveal`.
 *
 * Stored at: <homedirFn()>/.yakcc/proof-claims/<claim_id>.json
 *
 * Fields:
 *   claim_id         — the ClaimId returned by commitClaim()
 *   bounty_id        — the BountyId this claim belongs to (informational)
 *   artifact_b64     — Buffer.from(artifactBytes).toString("base64")
 *   nonce_b64        — Buffer.from(nonce).toString("base64")
 *   claimant_id      — identity string used to compute the commit_hash
 *   committed_at_iso — ISO-8601 timestamp of the commit (for human inspection)
 */
export interface ProofClaimStash {
  claim_id: string;
  bounty_id: string;
  artifact_b64: string;
  nonce_b64: string;
  claimant_id: string;
  committed_at_iso: string;
}

/** Return the stash directory path for a given home dir. */
function stashDir(homedirFn: () => string): string {
  return join(homedirFn(), ".yakcc", "proof-claims");
}

/** Return the full path to a claim's stash file. */
function stashPath(claimId: string, homedirFn: () => string): string {
  return join(stashDir(homedirFn), `${claimId}.json`);
}

/** Write a claim stash to disk. Creates the directory if it does not exist. */
function writeStash(stash: ProofClaimStash, homedirFn: () => string): void {
  const dir = stashDir(homedirFn);
  mkdirSync(dir, { recursive: true });
  writeFileSync(stashPath(stash.claim_id, homedirFn), JSON.stringify(stash, null, 2), "utf8");
}

/** Read a claim stash from disk. Throws if the file does not exist or is malformed. */
function readStash(claimId: string, homedirFn: () => string): ProofClaimStash {
  const path = stashPath(claimId, homedirFn);
  if (!existsSync(path)) {
    throw new Error(
      `no stash found for claim ${claimId} at ${path}\nDid you run \`yakcc proof claim commit\` first?`,
    );
  }
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as ProofClaimStash;
  } catch {
    throw new Error(`stash file at ${path} is not valid JSON`);
  }
}

/** Delete a claim stash from disk. No-ops if the file does not exist. */
function deleteStash(claimId: string, homedirFn: () => string): void {
  const path = stashPath(claimId, homedirFn);
  if (existsSync(path)) {
    rmSync(path);
  }
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the requester/claimant identity.
 *
 * Resolution order:
 *   1. Explicit --requester / --claimant argument.
 *   2. git config user.email (spawned synchronously; failure → fallthrough).
 *   3. "anonymous".
 */
function resolveIdentity(explicitId?: string): string {
  if (explicitId !== undefined && explicitId.trim().length > 0) {
    return explicitId.trim();
  }
  try {
    const email = execFileSync("git", ["config", "user.email"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    if (email.length > 0) return email;
  } catch {
    // git unavailable or no config — fall through.
  }
  return "anonymous";
}

// ---------------------------------------------------------------------------
// Theorem statement hash helper
// ---------------------------------------------------------------------------

/**
 * Resolve the theorem statement hash.
 *
 * If `value` looks like a 64-char lowercase hex string, return it as-is.
 * Otherwise treat it as a file path, read the file bytes, and compute
 * BLAKE3(bytes) — the canonical theorem statement hash (plans/proof-incentive-layer.md §3.1).
 *
 * The BLAKE3 computation is deferred to a dynamic import of @noble/hashes/blake3
 * to avoid pulling it in at the top-level import cost for commands that do not need it.
 * In practice the CLI already depends on proof-market which loads @noble/hashes.
 */
async function resolveTheoremHash(value: string): Promise<string> {
  if (/^[0-9a-f]{64}$/.test(value)) {
    return value;
  }
  // Treat as a file path.
  if (!existsSync(value)) {
    throw new Error(`--theorem: file not found: ${value}`);
  }
  const bytes = readFileSync(value);
  const { blake3 } = await import("@noble/hashes/blake3.js");
  const { bytesToHex } = await import("@noble/hashes/utils.js");
  return bytesToHex(blake3(bytes));
}

// ---------------------------------------------------------------------------
// Injectable options (for tests)
// ---------------------------------------------------------------------------

/**
 * Injection seam for `proof` commands.
 *
 * Tests override:
 *   homedirFn   → tmpdir so stash writes don't touch $HOME.
 *   registryPath → ":memory:" for in-process SQLite.
 */
export interface ProofOptions {
  /** Override home directory for stash storage. Defaults to node:os.homedir(). */
  homedirFn?: () => string;
  /** Override registry path. Defaults to YAKCC_PROOF_REGISTRY env var or DEFAULT_PROOF_REGISTRY_PATH. */
  registryPath?: string;
}

// ---------------------------------------------------------------------------
// Sub-handlers
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc proof bounty post <atom_bmr> --theorem <hash|path>
 *   --reward <amount> [--unit <unit>] [--requester <id>] [--registry <path>]`.
 *
 * Prints the returned bounty_id on stdout.
 */
async function proofBountyPost(
  argv: readonly string[],
  logger: Logger,
  opts?: ProofOptions,
): Promise<number> {
  const parseArgsConfig = {
    args: [...argv],
    options: {
      theorem: { type: "string" as const },
      reward: { type: "string" as const },
      unit: { type: "string" as const },
      requester: { type: "string" as const },
      registry: { type: "string" as const },
    },
    allowPositionals: true as const,
    strict: true as const,
  };

  let parsed: ReturnType<typeof parseArgs<typeof parseArgsConfig>>;
  try {
    parsed = parseArgs(parseArgsConfig);
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    logger.error(
      "Usage: yakcc proof bounty post <atom_bmr> --theorem <hash|path> --reward <amount> [--unit <unit>] [--requester <id>]",
    );
    return 1;
  }

  const positionals = parsed.positionals;
  if (positionals.length < 1) {
    logger.error("error: missing required positional: <atom_bmr>");
    logger.error(
      "Usage: yakcc proof bounty post <atom_bmr> --theorem <hash|path> --reward <amount>",
    );
    return 1;
  }
  // positionals.length < 1 guarded above; [0] is always defined here.
  const atomBmr = positionals[0] as string;

  const theoremRaw = parsed.values.theorem;
  if (theoremRaw === undefined) {
    logger.error("error: --theorem is required");
    return 1;
  }
  const rewardRaw = parsed.values.reward;
  if (rewardRaw === undefined) {
    logger.error("error: --reward is required");
    return 1;
  }
  const rewardAmount = Number.parseInt(rewardRaw, 10);
  if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) {
    logger.error(`error: --reward must be a positive integer; got: ${rewardRaw}`);
    return 1;
  }

  const rewardUnit = parsed.values.unit ?? DEFAULT_REWARD_UNIT;
  const requesterId = resolveIdentity(parsed.values.requester);
  const registryPath =
    opts?.registryPath ??
    parsed.values.registry ??
    process.env.YAKCC_PROOF_REGISTRY ??
    DEFAULT_PROOF_REGISTRY_PATH;

  let theoremHash: string;
  try {
    theoremHash = await resolveTheoremHash(theoremRaw);
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    return 1;
  }

  const market = ProofMarket.open(registryPath);
  let bountyId: BountyId;
  try {
    bountyId = market.postBounty(atomBmr, theoremHash, rewardAmount, rewardUnit, requesterId);
  } finally {
    market.close();
  }

  logger.log(bountyId);
  return 0;
}

/**
 * Handler for `yakcc proof claim commit <bounty_id> --artifact <path>
 *   --stake <amount> [--unit <unit>] [--claimant <id>] [--registry <path>]`.
 *
 * Stashes (artifact_bytes_b64, nonce_b64, claim_id) to
 * ~/.yakcc/proof-claims/<claim_id>.json and prints claim_id on stdout.
 */
async function proofClaimCommit(
  argv: readonly string[],
  logger: Logger,
  opts?: ProofOptions,
): Promise<number> {
  const parseArgsConfig = {
    args: [...argv],
    options: {
      artifact: { type: "string" as const },
      stake: { type: "string" as const },
      unit: { type: "string" as const },
      claimant: { type: "string" as const },
      registry: { type: "string" as const },
    },
    allowPositionals: true as const,
    strict: true as const,
  };

  let parsed: ReturnType<typeof parseArgs<typeof parseArgsConfig>>;
  try {
    parsed = parseArgs(parseArgsConfig);
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    logger.error(
      "Usage: yakcc proof claim commit <bounty_id> --artifact <path> --stake <amount> [--unit <unit>] [--claimant <id>]",
    );
    return 1;
  }

  const positionals = parsed.positionals;
  if (positionals.length < 1) {
    logger.error("error: missing required positional: <bounty_id>");
    logger.error("Usage: yakcc proof claim commit <bounty_id> --artifact <path> --stake <amount>");
    return 1;
  }
  const bountyId = positionals[0] as BountyId;

  const artifactPath = parsed.values.artifact;
  if (artifactPath === undefined) {
    logger.error("error: --artifact is required");
    return 1;
  }
  if (!existsSync(artifactPath)) {
    logger.error(`error: artifact file not found: ${artifactPath}`);
    return 1;
  }
  const stakeRaw = parsed.values.stake;
  if (stakeRaw === undefined) {
    logger.error("error: --stake is required");
    return 1;
  }
  const stakeAmount = Number.parseInt(stakeRaw, 10);
  if (!Number.isFinite(stakeAmount) || stakeAmount <= 0) {
    logger.error(`error: --stake must be a positive integer; got: ${stakeRaw}`);
    return 1;
  }

  const stakeUnit = parsed.values.unit ?? DEFAULT_STAKE_UNIT;
  const claimantId = resolveIdentity(parsed.values.claimant);
  const registryPath =
    opts?.registryPath ??
    parsed.values.registry ??
    process.env.YAKCC_PROOF_REGISTRY ??
    DEFAULT_PROOF_REGISTRY_PATH;
  const homedirFn = opts?.homedirFn ?? homedir;

  const artifactBytes = readFileSync(artifactPath);

  // Generate a 32-byte cryptographically secure nonce.
  const nonce = new Uint8Array(32);
  globalThis.crypto.getRandomValues(nonce);

  const commitHash = ProofMarket.computeCommitHash(
    new Uint8Array(artifactBytes.buffer, artifactBytes.byteOffset, artifactBytes.byteLength),
    nonce,
    claimantId,
  );

  const market = ProofMarket.open(registryPath);
  let claimId: ClaimId;
  try {
    claimId = market.commitClaim(bountyId, commitHash, claimantId, stakeAmount, stakeUnit);
  } finally {
    market.close();
  }

  // Stash locally for the reveal step.
  const stash: ProofClaimStash = {
    claim_id: claimId,
    bounty_id: bountyId,
    artifact_b64: Buffer.from(artifactBytes).toString("base64"),
    nonce_b64: Buffer.from(nonce).toString("base64"),
    claimant_id: claimantId,
    committed_at_iso: new Date().toISOString(),
  };
  writeStash(stash, homedirFn);

  logger.log(claimId);
  return 0;
}

/**
 * Handler for `yakcc proof claim reveal <claim_id> [--registry <path>]`.
 *
 * Reads stash from ~/.yakcc/proof-claims/<claim_id>.json,
 * calls revealClaim(), deletes the stash on success (leaves it for retry on failure).
 */
async function proofClaimReveal(
  argv: readonly string[],
  logger: Logger,
  opts?: ProofOptions,
): Promise<number> {
  const parseArgsConfig = {
    args: [...argv],
    options: {
      registry: { type: "string" as const },
    },
    allowPositionals: true as const,
    strict: true as const,
  };

  let parsed: ReturnType<typeof parseArgs<typeof parseArgsConfig>>;
  try {
    parsed = parseArgs(parseArgsConfig);
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    logger.error("Usage: yakcc proof claim reveal <claim_id> [--registry <path>]");
    return 1;
  }

  const positionals = parsed.positionals;
  if (positionals.length < 1) {
    logger.error("error: missing required positional: <claim_id>");
    logger.error("Usage: yakcc proof claim reveal <claim_id>");
    return 1;
  }
  const claimId = positionals[0] as ClaimId;

  const registryPath =
    opts?.registryPath ??
    parsed.values.registry ??
    process.env.YAKCC_PROOF_REGISTRY ??
    DEFAULT_PROOF_REGISTRY_PATH;
  const homedirFn = opts?.homedirFn ?? homedir;

  // Read stash — do this before opening the DB so we fail early if stash is missing.
  let stash: ProofClaimStash;
  try {
    stash = readStash(claimId, homedirFn);
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    return 1;
  }

  const artifactBytes = new Uint8Array(Buffer.from(stash.artifact_b64, "base64"));
  const nonce = new Uint8Array(Buffer.from(stash.nonce_b64, "base64"));

  const market = ProofMarket.open(registryPath);
  try {
    market.revealClaim(claimId, artifactBytes, nonce);
  } catch (err) {
    // Leave stash in place so the user can retry after fixing the underlying issue
    // (e.g., bounty not yet in REVEAL status; retry after transitionBounty fires).
    market.close();
    logger.error(`error: reveal failed: ${(err as Error).message}`);
    logger.error(`stash preserved at: ${stashPath(claimId, homedirFn)}`);
    return 1;
  }
  market.close();

  // Success — delete the stash file.
  deleteStash(claimId, homedirFn);
  logger.log(`revealed claim ${claimId}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Top-level dispatcher
// ---------------------------------------------------------------------------

/**
 * Top-level handler for `yakcc proof <subcommand> ...`.
 *
 * Dispatches on the two-word subcommand: "bounty post" or "claim commit|reveal".
 *
 * @param argv   - Remaining argv after `proof` has been consumed.
 * @param logger - Output sink (CollectingLogger in tests, CONSOLE_LOGGER in production).
 * @param opts   - Injectable options for tests (homedirFn, registryPath).
 * @returns Process exit code (0 = success, non-zero = error).
 */
export async function proof(
  argv: readonly string[],
  logger: Logger,
  opts?: ProofOptions,
): Promise<number> {
  const [sub1, sub2, ...rest] = argv;

  if (sub1 === "bounty" && sub2 === "post") {
    return proofBountyPost(rest, logger, opts);
  }
  if (sub1 === "claim" && sub2 === "commit") {
    return proofClaimCommit(rest, logger, opts);
  }
  if (sub1 === "claim" && sub2 === "reveal") {
    return proofClaimReveal(rest, logger, opts);
  }

  if (sub1 === undefined) {
    logger.error("error: missing proof subcommand");
  } else {
    logger.error(`error: unknown proof subcommand: ${sub1} ${sub2 ?? ""}`.trimEnd());
  }
  logger.error(
    "Usage:\n" +
      "  yakcc proof bounty post <atom_bmr> --theorem <hash|path> --reward <amount>\n" +
      "  yakcc proof claim commit <bounty_id> --artifact <path> --stake <amount>\n" +
      "  yakcc proof claim reveal <claim_id>",
  );
  return 1;
}
