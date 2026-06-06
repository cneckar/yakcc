# End-to-end: post a bounty against `crc32c`, claim it with a Lean proof, ship the verified atom

This walkthrough runs the full proof-market lifecycle against a real atom.
It's intentionally concrete: by the end you'll have an accepted Lean proof
attached to `crc32c.impl.ts`, a paid-out bounty, and a measurable reputation
delta.

**Roles played:** Requester (Alice), Claimant (Bob), Verifier (operator-run for v0).

**Prerequisites:**
- yakcc registry seeded with the bootstrap atoms (default after `yakcc init`)
- `@yakcc/proof-market` and `@yakcc/proof-verifier` packages installed
- For Bob: Lean 4.7.0 installed and in `$PATH`
- For all parties: a reputation account (created automatically on first event)

Commands shown as CLI verbs (`yakcc proof ...`) are aspirational — they ship
in [#1095](https://github.com/cneckar/yakcc/issues/1095). For now use the
TypeScript engine API; both forms are shown.

---

## Setup — open the registry and check baseline reputation

```ts
import { ProofMarket } from "@yakcc/proof-market";
import { getReputation } from "@yakcc/proof-market";

const pm = ProofMarket.open("./registry.sqlite");
const db = pm.getDbForTest();

console.log("Alice rep:", getReputation(db, "alice"));   // 0 (no row yet)
console.log("Bob rep:",   getReputation(db, "bob"));     // 0
```

Both start at 0. The first event for each account triggers a one-time
bootstrap grant of 100 RC.

---

## Step 1 — Alice posts a bounty

Alice wants `crc32c` formally proven. She has the atom's BlockMerkleRoot and a
Lean module that defines the theorem she wants established.

The theorem (in `theorem-crc32c-refines.lean`):

```lean
theorem crc32c_refines :
  ∀ (input : ByteArray),
    YakccImpl.crc32c input = YakccSpec.crc32c input := by
  sorry  -- claimant fills this in
```

The bounty pins the *theorem statement hash*, not the full module — so the
claimant fills in the proof but can't substitute a different theorem.

```ts
import { blake3 } from "@noble/hashes/blake3";
import { readFile } from "node:fs/promises";

const theoremModuleBytes = await readFile("./theorem-crc32c-refines.lean");
// Hash only the theorem statement (the `theorem ... by` line and signature) —
// the `:= by sorry` body is the claimant's contribution and varies per proof.
// In practice, hash the canonical form of the theorem declaration only.
const theoremStatementHash = "blake3:" +
  Buffer.from(blake3(theoremModuleBytes)).toString("hex");

const bountyId = await pm.postBounty({
  atomBmr: "blake3:<crc32c-atom-bmr>",
  theoremStatementHash,
  rewardAmount: 200,
  rewardUnit: "reputation_credit",
  requesterId: "alice",
});

console.log("Bounty posted:", bountyId);
console.log("Alice rep after bootstrap:", getReputation(db, "alice")); // 100
```

**CLI (coming in #1095):**

```bash
yakcc proof bounty post blake3:<crc32c-atom-bmr> \
  --theorem ./theorem-crc32c-refines.lean \
  --reward 200 \
  --unit reputation_credit
```

The bounty is now `OPEN`. Claimants have 24h to commit.

---

## Step 2 — Bob writes the proof and commits

Bob has been working on Lean proofs of bit-twiddling functions. He sees
Alice's bounty, downloads the atom (`yakcc atom get blake3:<crc32c-atom-bmr>`),
and writes `refines.lean`:

```lean
-- refines.lean — Bob's proof against Alice's theorem
import Crc32c.Impl
import Crc32c.Spec

theorem crc32c_refines :
  ∀ (input : ByteArray),
    YakccImpl.crc32c input = YakccSpec.crc32c input := by
  intro input
  induction input.toList with
  | nil => rfl
  | cons head tail ih =>
    simp [YakccImpl.crc32c, YakccSpec.crc32c, ...]
    -- (real proof — about 40-80 lines for a careful induction over bytes
    --  + a lemma proving the reflected polynomial step matches the spec)
```

He checks it locally:

```bash
lean --check refines.lean
# exit 0
```

Then commits to the market:

```ts
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

const artifactBytes = await readFile("./refines.lean");
const nonce = randomBytes(32);
const commitHash = ProofMarket.computeCommitHash(
  artifactBytes, nonce, "bob",
);

const claimId = await pm.commitClaim({
  bountyId,
  commitHash,
  claimantId: "bob",
  stakeAmount: 50,
  stakeUnit: "reputation_credit",
});

// Stash (artifactBytes, nonce) locally for the reveal step.
await writeFile(
  `./.yakcc-claim-${claimId}.json`,
  JSON.stringify({
    claimId,
    artifact: Buffer.from(artifactBytes).toString("base64"),
    nonce: Buffer.from(nonce).toString("base64"),
  }),
);

console.log("Bob committed claim:", claimId);
console.log("Bob rep after bootstrap:", getReputation(db, "bob")); // 100
```

**CLI:**

```bash
yakcc proof claim commit <bounty_id> --artifact ./refines.lean --stake 50
# Stashes (artifact, nonce) under ~/.yakcc/proof-claims/<claim_id>.json
```

The claim is `COMMITTED`. Bob's stake (50 RC) is locked. Nobody can see the
proof yet — only the commit hash.

---

## Step 3 — The commit window closes, reveal opens

Twenty-four hours later, the bounty transitions to `REVEAL`. Bob has 1 hour
to reveal his proof.

```ts
const stash = JSON.parse(await readFile(`./.yakcc-claim-${claimId}.json`, "utf8"));
await pm.revealClaim({
  claimId: stash.claimId,
  artifactBytes: Buffer.from(stash.artifact, "base64"),
  nonce: Buffer.from(stash.nonce, "base64"),
});
```

**CLI:** `yakcc proof claim reveal <claim_id>`

The resolver verifies
`BLAKE3(artifactBytes || nonce || "bob") === commitHash`. If yes,
the claim transitions to `REVEALED` and the proof artifact is now public.

If the reveal window closes without Bob revealing (he lost the laptop, his
network died, etc.), the claim transitions to `LAPSED` and his 50 RC stake is
forfeit to the operator treasury.

---

## Step 4 — Verifier checks the proof

A verifier daemon (operator-run for v0) sees the `REVEAL → CHECK` transition.
It runs:

```bash
lean --check refines.lean
# Verifies the proof against Lean 4.7.0 (the toolchain version pinned in
# the manifest's `checker` field)
```

The checker returns 0. The verifier signs an attestation:

```ts
import { runVerifierForClaim, loadOrCreateIdentity, defaultLeanRunner } from "@yakcc/proof-verifier";

const identity = loadOrCreateIdentity();
const attestation = await runVerifierForClaim({
  claimId,
  artifactBytes: stash.artifact, // the revealed proof
  theoremStatementHash,
  checker: "lean4@4.7.0",
  leanRunner: defaultLeanRunner(),
  identity,
});

await pm.recordAttestation(attestation);
```

In v0 with N=1 verifier, one valid attestation triggers `ACCEPT`. (Multi-verifier
supermajority at v0.2 target.)

---

## Step 5 — Bounty finalizes; rewards flow

```ts
await pm.finalizeBounty(bountyId);
const bounty = await pm.getBounty(bountyId);
console.log(bounty.status); // ACCEPT

console.log("Bob rep after accepted claim:", getReputation(db, "bob"));
// 100 (bootstrap) + 50 (claim accepted) = 150 RC
// Plus he got back his 50 RC stake AND the 200 RC bounty reward.
// Net delta from this run: +200 RC bounty + +50 RC accrual = +250 RC
// (Stake refund cancels the lock that happened at commit time.)

console.log("Alice rep:", getReputation(db, "alice"));
// 100 (bootstrap); -200 RC for the bounty paid out
// Note: reward already left her account at post-time, so this is net.

console.log("Verifier rep:", getReputation(db, identity.publicKey.toString("hex")));
// +2 RC for the correct attestation
// Plus the 10% verifier-fee share of the 200 RC bounty.
```

The atom's `proof/manifest.json` is updated:

```json
{
  "artifacts": [
    { "kind": "property_tests", "path": "proof/tests.fast-check.ts" },
    {
      "kind": "lean_proof",
      "path": "proof/refines.lean",
      "checker": "lean4@4.7.0"
    }
  ]
}
```

The atom's `BlockMerkleRoot` mutates (proof_root changes; new BMR for the
proven version). The new BMR is published; downstream consumers can choose
between the unproven and the proven version. `yakcc_resolve` with
`proof_requirement: "preferred"` will rank the proven version higher (+0.10
score bonus).

---

## What if the proof had been wrong?

Same flow, different ending at Step 4. The verifier daemon runs
`lean --check refines.lean` and Lean reports a type error. The verifier signs
an attestation with `result: "invalid"`. With N=1 verifier, one `invalid`
triggers `REJECT`. Bob's 50 RC stake is forfeit to operator treasury (per
economics spec — slashing destroys, doesn't transfer to other participants).
Bob loses 100 RC of reputation per `claim_slashed`. Alice's 200 RC bounty
returns to her or rolls over (per her initial choice).

The retraction window applies post-`ACCEPT` (see `docs/PROOFS.md` §Retraction).
A buggy checker / collusion attack can be retracted within 90 days by anyone
willing to put up 2× Bob's stake.

---

## Closing thought

This walkthrough is the smallest unit of trust the proof market can produce:
one atom, one theorem, one proof, one attestation. The substrate doesn't
require this — most atoms ship at L0 (property tests) forever. But for the
atoms that matter — auth tokens, password hashing, cryptographic operations,
audit-relevant code — the option to demand an L3 proof and *pay* for one is
now first-class.

That's the whole point.
