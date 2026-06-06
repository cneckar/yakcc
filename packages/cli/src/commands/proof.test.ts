// SPDX-License-Identifier: MIT
//
// proof.test.ts — Integration tests for `yakcc proof bounty post`,
//                 `yakcc proof claim commit`, and `yakcc proof claim reveal`.
//
// These tests exercise the real production sequence end-to-end:
//   1. Open a ProofMarket backed by :memory: SQLite.
//   2. Post a bounty (proof bounty post).
//   3. Commit a claim — stash file is written (proof claim commit).
//   4. Transition the bounty to REVEAL status (direct engine call).
//   5. Reveal the claim — reads stash, calls revealClaim, deletes stash (proof claim reveal).
//
// The homedir injection seam (ProofOptions.homedirFn) redirects all stash writes
// to a per-test tmpdir so no $HOME state is mutated.
//
// The registryPath injection seam uses ":memory:" so no disk SQLite is created.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProofMarket } from "@yakcc/proof-market";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import { type ProofClaimStash, proof } from "./proof.js";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/** Create a fresh per-test tmpdir and return a homedirFn pointing into it. */
function makeTmpHome(): { homedirFn: () => string; tmpHome: string } {
  const tmpHome = mkdtempSync(join(tmpdir(), "proof-test-"));
  return { homedirFn: () => tmpHome, tmpHome };
}

/**
 * Return a path to a small artifact file inside a tmpdir.
 * We write a few bytes so the artifact bytes are non-empty and deterministic.
 */
function makeArtifactFile(tmpHome: string): string {
  const { writeFileSync } = require("node:fs");
  const path = join(tmpHome, "artifact.lean");
  writeFileSync(path, "-- test lean proof artifact\ntheorem foo : 1 + 1 = 2 := rfl\n");
  return path;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** A valid 64-char lowercase hex theorem statement hash (32 zero bytes for tests). */
const TEST_THEOREM_HASH = "0".repeat(64);

/** A valid 64-char lowercase hex atom_bmr. */
const TEST_ATOM_BMR = "a".repeat(64);

// ---------------------------------------------------------------------------
// bounty post
// ---------------------------------------------------------------------------

describe("proof bounty post", () => {
  it("returns a bounty_id on stdout for valid inputs", async () => {
    const logger = new CollectingLogger();
    const { homedirFn } = makeTmpHome();

    const exitCode = await proof(
      ["bounty", "post", TEST_ATOM_BMR, "--theorem", TEST_THEOREM_HASH, "--reward", "100"],
      logger,
      { registryPath: ":memory:", homedirFn },
    );

    expect(exitCode).toBe(0);
    expect(logger.errLines).toEqual([]);
    // bounty_id is a 64-char lowercase hex string
    expect(logger.logLines).toHaveLength(1);
    expect(logger.logLines[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("exits 1 when atom_bmr positional is missing", async () => {
    const logger = new CollectingLogger();
    const { homedirFn } = makeTmpHome();

    const exitCode = await proof(
      ["bounty", "post", "--theorem", TEST_THEOREM_HASH, "--reward", "100"],
      logger,
      { registryPath: ":memory:", homedirFn },
    );

    expect(exitCode).toBe(1);
    expect(logger.errLines[0]).toMatch(/missing required positional/);
  });

  it("exits 1 when --theorem is missing", async () => {
    const logger = new CollectingLogger();
    const { homedirFn } = makeTmpHome();

    const exitCode = await proof(["bounty", "post", TEST_ATOM_BMR, "--reward", "100"], logger, {
      registryPath: ":memory:",
      homedirFn,
    });

    expect(exitCode).toBe(1);
    expect(logger.errLines[0]).toMatch(/--theorem is required/);
  });

  it("exits 1 when --reward is missing", async () => {
    const logger = new CollectingLogger();
    const { homedirFn } = makeTmpHome();

    const exitCode = await proof(
      ["bounty", "post", TEST_ATOM_BMR, "--theorem", TEST_THEOREM_HASH],
      logger,
      { registryPath: ":memory:", homedirFn },
    );

    expect(exitCode).toBe(1);
    expect(logger.errLines[0]).toMatch(/--reward is required/);
  });

  it("exits 1 when --reward is not a positive integer", async () => {
    const logger = new CollectingLogger();
    const { homedirFn } = makeTmpHome();

    const exitCode = await proof(
      ["bounty", "post", TEST_ATOM_BMR, "--theorem", TEST_THEOREM_HASH, "--reward", "0"],
      logger,
      { registryPath: ":memory:", homedirFn },
    );

    expect(exitCode).toBe(1);
    expect(logger.errLines[0]).toMatch(/--reward must be a positive integer/);
  });
});

// ---------------------------------------------------------------------------
// claim commit
// ---------------------------------------------------------------------------

describe("proof claim commit", () => {
  let tmpHome: string;
  let homedirFn: () => string;
  let artifactPath: string;
  let bountyId: string;

  beforeEach(async () => {
    ({ homedirFn, tmpHome } = makeTmpHome());
    artifactPath = makeArtifactFile(tmpHome);

    // Post a bounty first (needed for commitClaim to find the bounty).
    const logger = new CollectingLogger();
    const exitCode = await proof(
      ["bounty", "post", TEST_ATOM_BMR, "--theorem", TEST_THEOREM_HASH, "--reward", "50"],
      logger,
      { registryPath: ":memory:", homedirFn },
    );
    // NOTE: :memory: SQLite is created fresh each invocation of ProofMarket.open().
    // Because claim commit opens a SEPARATE :memory: DB it won't find the bounty.
    // For the stash-shape test below we test directly against a shared DB path.
    // bountyId here is from a separate DB — used only for argument passing tests.
    expect(exitCode).toBe(0);
    bountyId = logger.logLines[0] as string;
  });

  it("exits 1 when bounty_id positional is missing", async () => {
    const logger = new CollectingLogger();
    const exitCode = await proof(
      ["claim", "commit", "--artifact", artifactPath, "--stake", "10"],
      logger,
      { registryPath: ":memory:", homedirFn },
    );

    expect(exitCode).toBe(1);
    expect(logger.errLines[0]).toMatch(/missing required positional/);
  });

  it("exits 1 when --artifact is missing", async () => {
    const logger = new CollectingLogger();
    const exitCode = await proof(["claim", "commit", bountyId, "--stake", "10"], logger, {
      registryPath: ":memory:",
      homedirFn,
    });

    expect(exitCode).toBe(1);
    expect(logger.errLines[0]).toMatch(/--artifact is required/);
  });

  it("exits 1 when artifact file does not exist", async () => {
    const logger = new CollectingLogger();
    const exitCode = await proof(
      ["claim", "commit", bountyId, "--artifact", "/nonexistent/path.lean", "--stake", "10"],
      logger,
      { registryPath: ":memory:", homedirFn },
    );

    expect(exitCode).toBe(1);
    expect(logger.errLines[0]).toMatch(/artifact file not found/);
  });

  it("writes a stash file with correct shape when commit succeeds", async () => {
    // Use a real file-backed SQLite (in tmpdir) so bounty post and claim commit
    // share the same DB and commitClaim can find the bounty.
    const dbPath = join(tmpHome, "proof.sqlite");
    const logger = new CollectingLogger();

    // Post bounty into shared DB.
    const postCode = await proof(
      ["bounty", "post", TEST_ATOM_BMR, "--theorem", TEST_THEOREM_HASH, "--reward", "50"],
      logger,
      { registryPath: dbPath, homedirFn },
    );
    expect(postCode).toBe(0);
    const sharedBountyId = logger.logLines[0] as string;

    // Commit claim into same DB.
    const commitLogger = new CollectingLogger();
    const commitCode = await proof(
      ["claim", "commit", sharedBountyId, "--artifact", artifactPath, "--stake", "10"],
      commitLogger,
      { registryPath: dbPath, homedirFn },
    );
    expect(commitCode).toBe(0);
    expect(commitLogger.errLines).toEqual([]);

    const claimId = commitLogger.logLines[0];
    expect(claimId).toMatch(/^[0-9a-f]{64}$/);

    // Verify stash file exists and has the expected shape.
    const stashFile = join(tmpHome, ".yakcc", "proof-claims", `${claimId}.json`);
    const stashRaw = readFileSync(stashFile, "utf8");
    const stash = JSON.parse(stashRaw) as ProofClaimStash;

    expect(stash.claim_id).toBe(claimId);
    expect(stash.bounty_id).toBe(sharedBountyId);
    expect(typeof stash.artifact_b64).toBe("string");
    expect(stash.artifact_b64.length).toBeGreaterThan(0);
    expect(typeof stash.nonce_b64).toBe("string");
    expect(Buffer.from(stash.nonce_b64, "base64")).toHaveLength(32);
    expect(typeof stash.claimant_id).toBe("string");
    expect(typeof stash.committed_at_iso).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// claim reveal
// ---------------------------------------------------------------------------

describe("proof claim reveal", () => {
  it("exits 1 when claim_id positional is missing", async () => {
    const { homedirFn } = makeTmpHome();
    const logger = new CollectingLogger();

    const exitCode = await proof(["claim", "reveal"], logger, {
      registryPath: ":memory:",
      homedirFn,
    });

    expect(exitCode).toBe(1);
    expect(logger.errLines[0]).toMatch(/missing required positional/);
  });

  it("exits 1 when stash file does not exist", async () => {
    const { homedirFn } = makeTmpHome();
    const logger = new CollectingLogger();

    const exitCode = await proof(["claim", "reveal", "a".repeat(64)], logger, {
      registryPath: ":memory:",
      homedirFn,
    });

    expect(exitCode).toBe(1);
    expect(logger.errLines[0]).toMatch(/no stash found for claim/);
  });

  it("reads stash, calls revealClaim, deletes stash on success", async () => {
    const { homedirFn, tmpHome } = makeTmpHome();
    const artifactPath = makeArtifactFile(tmpHome);
    const dbPath = join(tmpHome, "proof-reveal.sqlite");

    // Step 1: Post a bounty.
    const postLogger = new CollectingLogger();
    await proof(
      ["bounty", "post", TEST_ATOM_BMR, "--theorem", TEST_THEOREM_HASH, "--reward", "50"],
      postLogger,
      { registryPath: dbPath, homedirFn },
    );
    const sharedBountyId = postLogger.logLines[0] as string;

    // Step 2: Commit a claim.
    const commitLogger = new CollectingLogger();
    const commitCode = await proof(
      ["claim", "commit", sharedBountyId, "--artifact", artifactPath, "--stake", "10"],
      commitLogger,
      { registryPath: dbPath, homedirFn },
    );
    expect(commitCode).toBe(0);
    const claimId = commitLogger.logLines[0] as string;

    // Verify stash exists before reveal.
    const stashFile = join(tmpHome, ".yakcc", "proof-claims", `${claimId}.json`);
    expect(() => readFileSync(stashFile)).not.toThrow();

    // Step 3: Manually transition the bounty to REVEAL status so revealClaim
    // can proceed. The CLI does not expose transitionBounty (daemon responsibility),
    // so we call the engine directly here.
    const market = ProofMarket.open(dbPath);
    const pastTime = Date.now() + 25 * 60 * 60 * 1000; // 25h in the future → commit window closed
    market.transitionBounty(
      sharedBountyId as ReturnType<typeof market.getBounty> extends infer R
        ? R extends { bounty_id: infer B }
          ? B
          : never
        : never,
      {
        nowMs: pastTime,
      },
    );
    market.close();

    // Step 4: Reveal.
    const revealLogger = new CollectingLogger();
    const revealCode = await proof(["claim", "reveal", claimId], revealLogger, {
      registryPath: dbPath,
      homedirFn,
    });
    expect(revealCode).toBe(0);
    expect(revealLogger.errLines).toEqual([]);
    expect(revealLogger.logLines[0]).toMatch(new RegExp(claimId));

    // Stash must be deleted after successful reveal.
    expect(() => readFileSync(stashFile)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unknown subcommand
// ---------------------------------------------------------------------------

describe("proof dispatch", () => {
  it("exits 1 and prints usage for unknown subcommand", async () => {
    const { homedirFn } = makeTmpHome();
    const logger = new CollectingLogger();

    const exitCode = await proof(["unknown", "sub"], logger, {
      registryPath: ":memory:",
      homedirFn,
    });

    expect(exitCode).toBe(1);
    expect(logger.errLines[0]).toMatch(/unknown proof subcommand/);
  });

  it("exits 1 and prints usage when no subcommand given", async () => {
    const { homedirFn } = makeTmpHome();
    const logger = new CollectingLogger();

    const exitCode = await proof([], logger, {
      registryPath: ":memory:",
      homedirFn,
    });

    expect(exitCode).toBe(1);
    expect(logger.errLines[0]).toMatch(/missing proof subcommand/);
  });
});
