# Yakcc Proofs — machine-checked guarantees for the atoms you depend on

> A market for formally verified code primitives. Anyone can post a bounty for a
> proof against a yakcc atom; anyone can claim the bounty by delivering a
> machine-checked proof; anyone can run a verifier daemon and earn for honest
> attestation. This document is the user-facing entry point for that market.

**Status:** alpha. The engine, schema, lifecycle, economics, and discovery
integration are on `main` (issues #1080–#1088). CLI wrappers are tracked in
[#1095](https://github.com/cneckar/yakcc/issues/1095) and may not be shipped
yet — the walkthrough below labels aspirational commands `(coming in #1095)`.

---

## What this is

A **yakcc atom** is a content-addressed function snippet (`spec.yak` + `impl.ts`
+ `proof/` directory). The substrate already ships [L0 verification][L0]
(property tests on every atom) and L1/L2 placeholders for totality and SMT
certificates.

A **proof** in this document means an **L3 machine-checked formal proof** —
typically a [Lean 4](https://leanprover.github.io/) or [Coq](https://coq.inria.fr/)
proof that the atom's implementation refines its formal spec. Concretely: a
proof that `forall input, impl(input) = spec(input)`, machine-verified by a
pinned toolchain version, and signed off by independent verifier daemons.

The **proof market** is the off-chain economic layer that funds proof
production:

- Anyone with a yakcc atom they want proven can **post a bounty** (a stake of
  reputation credit or, optionally, crypto) attached to the atom plus the
  theorem statement they want established.
- Anyone can **claim the bounty** by submitting a proof artifact. Claims use a
  commit-reveal scheme so revealed proofs can't be front-run.
- **Verifier daemons** mechanically check revealed proofs against the pinned
  Lean/Coq toolchain and emit signed attestations. A supermajority of
  attestations finalizes the claim.

The whole thing is documented at the architecture level in
[`plans/proof-incentive-layer.md`](../plans/proof-incentive-layer.md) and at
the economic-parameter level in
[`docs/proof-incentive-economics.md`](./proof-incentive-economics.md). This
document is the **user-facing** view.

[L0]: ./archive/developer/VERIFICATION.md

---

## Why it matters

Two reasons:

1. **Trust.** The atom you reach for via `yakcc_resolve` carries property
   tests. That's good — property tests catch most regressions. But an L3 proof
   is *qualitatively different*: a Lean proof of `crc32c ≡ spec` rules out
   entire classes of subtle bug (wrong polynomial, off-by-one in the reflected
   bit order, mis-handled boundary) by construction. For security-critical
   primitives — hashing, token derivation, signature verification — that
   guarantee is worth paying for.

2. **A reason for outside contributors to engage.** Submitting atoms is the
   lowest-leverage participation in yakcc — shaving libraries is mechanical
   and there's no scarcity. Proofs are scarce, expensive to produce, and
   verifiable by anyone. They're the right unit of contribution for a
   community economy. Reputation accrues to people who do real verification
   work; that reputation is non-transferable and decays slowly, so the
   leaderboard reflects sustained engagement.

---

## The three roles

| Role | Does | Earns |
|---|---|---|
| **Requester** | Posts a bounty against a specific atom + theorem statement. Funds the reward. | Gets a verified proof shipped with the atom on the next BlockMerkleRoot revision. |
| **Claimant** | Constructs a Lean/Coq proof against the bounty's theorem. Commits, then reveals. Stakes reputation credit (or crypto) to back the claim. | Bounty reward + stake refund on accept. Bounty is held in escrow until verifier supermajority confirms the proof. |
| **Verifier** | Runs a daemon that watches `REVEAL`-state claims, runs the pinned checker, signs attestations. | A fixed fraction of each bounty escrow (10% per economics spec). Reputation accrues to honest attesters; dissenters from the supermajority are penalized. |

Anyone can play any role; the market is permissionless once you have a
reputation account (created on first event; bootstrap grant 100 RC).

---

## Requester walkthrough

You want a proof that `crc32c.impl.ts` matches its `spec.yak`. Post a bounty.

**Engine API today** (TypeScript, from `@yakcc/proof-market`):

```ts
import { ProofMarket } from "@yakcc/proof-market";

const pm = ProofMarket.open("./registry.sqlite");
const bountyId = await pm.postBounty({
  atomBmr: "blake3:abcd...",          // the atom you want proven
  theoremStatementHash: "blake3:1234...", // hash of the theorem statement
  rewardAmount: 200,
  rewardUnit: "reputation_credit",
  requesterId: "alice",
});
```

**CLI (coming in #1095):**

```bash
yakcc proof bounty post <atom_bmr> \
  --theorem <theorem_statement_hash> \
  --reward 200 \
  --unit reputation_credit
```

The bounty is now `OPEN`. Claimants have `T_commit` (default 24h) to commit
their proof hash. After that, a 1h reveal window opens. Verifiers then run the
pinned Lean checker and finalize.

You can query the bounty's status at any time:

```ts
const bounty = await pm.getBounty(bountyId);
console.log(bounty.status); // OPEN | COMMIT | REVEAL | CHECK | ACCEPT | REJECT
```

---

## Claimant walkthrough

You want to claim a bounty for `crc32c`. You've written `refines.lean`
proving `forall b, impl(b) = spec(b)` against the pinned `lean4@4.7.0`.

### Step 1 — commit

```ts
import { ProofMarket } from "@yakcc/proof-market";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const pm = ProofMarket.open("./registry.sqlite");
const artifactBytes = await readFile("./refines.lean");
const nonce = randomBytes(32);
const commitHash = ProofMarket.computeCommitHash(artifactBytes, nonce, "claimant_bob");

const claimId = await pm.commitClaim({
  bountyId,
  commitHash,
  claimantId: "claimant_bob",
  stakeAmount: 50,
  stakeUnit: "reputation_credit",
});

// Hold on to (artifactBytes, nonce) locally until the reveal window opens.
```

**CLI (coming in #1095):**

```bash
yakcc proof claim commit <bounty_id> \
  --artifact ./refines.lean \
  --stake 50
# Generates a nonce, computes the commit hash, submits it, stashes
# (artifactBytes, nonce) under ~/.yakcc/proof-claims/<claim_id>.json
# for the reveal step.
```

The commit timestamp determines bounty priority. If two claimants commit the
same hash (unlikely but possible), the earlier commit wins the bounty.

### Step 2 — reveal

After `T_commit` closes (24h), the reveal window opens for 1h.

```ts
await pm.revealClaim({
  claimId,
  artifactBytes,
  nonce,
});
```

**CLI:** `yakcc proof claim reveal <claim_id>` (uses the stashed file).

The resolver verifies `BLAKE3(artifactBytes || nonce || claimant_id)` matches
the committed hash. If it doesn't, the reveal is rejected and the stake is
forfeit.

### Step 3 — wait for finalization

Verifier daemons watch the `REVEAL → CHECK` transition automatically. They run
the pinned Lean checker against your artifact, sign their attestation, and a
supermajority (default 2/3) of `valid` attestations transitions the bounty to
`ACCEPT`.

- **On ACCEPT:** you receive `R` (the bounty reward) + `S` (your stake
  refunded). Your reputation accrues by `+50 RC` per the economics spec.
- **On REJECT:** all stakes forfeit to the operator treasury (the slashed
  amount never transfers to other participants — preserves grief-resistance).

The accepted proof is appended to the atom's `proof/manifest.json` as a
`lean_proof` artifact. The atom's `BlockMerkleRoot` mutates (proof is part of
the triplet); the new BMR is published as a new atom version.

---

## Verifier walkthrough

Verifiers are independent processes. Run one if you have Lean installed and
want to earn from honest attestation.

### One-time setup

```ts
import { loadOrCreateIdentity } from "@yakcc/proof-verifier";

// Generate an Ed25519 keypair (or load an existing one)
const identity = loadOrCreateIdentity();
console.log("Public key (registered as your verifier id):",
  Buffer.from(identity.publicKey).toString("hex"));
```

Register the verifier with the network by staking reputation (minimum 50 RC
per economics spec):

```ts
await pm.registerVerifier({
  verifierId: Buffer.from(identity.publicKey).toString("hex"),
  stake: 50,
});
```

### Daemon loop

The MVP doesn't include a long-running watcher process — verifier work is
invoked per-claim. A simple loop:

```ts
import { runVerifierForClaim } from "@yakcc/proof-verifier";

const claims = await pm.listClaimsInState("REVEAL");
for (const claim of claims) {
  const attestation = await runVerifierForClaim({
    claimId: claim.claimId,
    artifactBytes: claim.revealedArtifact,
    theoremStatementHash: claim.theoremStatementHash,
    checker: claim.checker, // e.g. "lean4@4.7.0"
    leanRunner: defaultLeanRunner(),
    identity,
  });
  await pm.recordAttestation(attestation);
}
```

You earn:

- **+2 RC** per correct attestation (you matched the supermajority outcome)
- Your share of **10% of each bounty escrow** that you attested to
- **−10 RC** if you dissented from the supermajority (honest dissent is paid
  but reputation-penalized — this is how Byzantine-correct verifiers stand out
  from broken ones)

---

## Reputation and stakes

The full economic spec lives at
[`docs/proof-incentive-economics.md`](./proof-incentive-economics.md). Highlights:

| Event | Reputation delta |
|---|---|
| Accepted atom submission | +5 RC |
| Accepted proof claim | +50 RC |
| Correct verifier attestation | +2 RC |
| Slashed claim (bad proof) | −100 RC |
| Verifier dissent (vs supermajority) | −10 RC |
| Bootstrap grant (new account) | +100 RC (one-time) |

**Decay:** linear half-life of 180 days. A score of 200 RC unattended for 6
months is worth 100 RC; another 6 months and it's 50 RC. Continued
participation keeps you on the leaderboard.

**Slashing:** when a stake is forfeit it goes to the operator treasury (crypto
track) or is deleted (reputation track) — it never transfers to another
participant. The one exception is **retraction reward**: if you successfully
retract a previously-accepted proof, you receive a fraction of the slashed
amount from the original claimant. (See *Retraction* below.)

**Sybil resistance (v0):** identity is tied to your GitHub account. Bootstrap
grants are rate-limited per epoch; concurrent active claims per account capped
at 5.

---

## Retraction — when an accepted proof turns out to be wrong

L3 proofs are mechanically checked, but checkers have bugs and spec text can
be ambiguous. The safety net: anyone can **file a retraction** within 90 days
of acceptance.

To file a retraction, you submit a counter-proof (a proof of falsehood, a
counterexample, or a proof that the original checker was compromised) along
with a stake of at least **2× the original claimant's stake** (asymmetric —
discourages frivolous retractions).

If the retraction succeeds:

- The original claimant is slashed proportional to time-since-accept. Caught
  within a day: nearly full slash. Caught at day 89: small slash. (Linear
  half-life of 30 days.)
- You (the retractor) receive a fraction of the slashed amount.
- The atom's `proof/manifest.json` annotates that theorem as `RETRACTED`.

If the retraction fails: your stake is forfeit to the operator treasury (same
rules as failed claims).

Retraction is the *only* place in the system where slashed value flows from
one participant to another. It exists because retracting a real bug is
valuable work that the original verifier supermajority missed.

---

## What to expect in v0 launch

- **1 verifier (operator-run).** Verification is deterministic — a single
  verifier's attestation is reproducible by anyone with the pinned toolchain,
  so anyone can spot-check. Counter-proof / retraction reverses any bad
  acceptance.
- **5–10 seeded bounties.** Operator posts the first batch against
  load-bearing atoms (BLAKE3 hash, base64 encode/decode, CRC32C, HMAC-SHA256)
  to demonstrate the flywheel. Once organic flow starts, anyone can post.
- **Reputation track only.** Crypto track is deferred to later (#1086) — the
  operator-treasury escrow model isn't strictly necessary for the reputation
  flywheel to start.
- **CLI wrappers ETA.** Most of the engine is on `main`; the `yakcc proof`
  CLI verbs are tracked in #1095 and will follow shortly. In the meantime,
  the TypeScript engine API is stable and importable from
  `@yakcc/proof-market`.

---

## FAQ

**Q: What kind of theorem can I post a bounty against?**
A: Anything you can express as a formal statement in Lean or Coq about the
atom's behavior. The simplest is `forall input, impl(input) = spec(input)` —
the refinement claim. More targeted: `forall x y, impl(x ++ y) = impl(x) +
shift(impl(y), length(x))` for a streaming-friendly hash. The theorem
statement is hashed and pinned into the bounty so verifiers know what they're
checking.

**Q: What if no one claims my bounty?**
A: After `T_commit` expires with no commits, the bounty is `REJECT`-ed and
your reward is returned (or rolled over, per your initial choice). You're out
nothing but time.

**Q: Can I run a verifier daemon without staking?**
A: No. Verifier registration requires a minimum stake (50 RC) so dishonest
attestations have a cost. New accounts get the 100 RC bootstrap grant which
is enough to register.

**Q: How are theorem statements written and hashed?**
A: A theorem statement is a Lean (or Coq) module that exports a single
`theorem` declaration. The bounty's `theorem_statement_hash` is `BLAKE3` of
the canonical module bytes. Verifiers check that the claimant's proof
artifact's `theorem` declaration has the matching hash before running the
checker.

**Q: Where do crypto bounties go?**
A: They don't, in v0. The crypto track (#1086) is deferred. When it ships,
crypto bounties will use operator-treasury escrow (no smart contract in v0).

**Q: What if there's only 1 verifier and they're wrong?**
A: That's what retraction is for. The operator runs the v0 verifier; if they
make a bad attestation, anyone can submit a counter-proof within 90 days with
2× stake and recover both the reward and a slash payout. Multi-verifier mode
becomes meaningful at N=3 supermajority, which is the v0.2 target.

**Q: Is this on a blockchain?**
A: No. The marketplace state lives in registry SQLite tables keyed off
`BlockMerkleRoot`. Off-chain entirely. (Plan §3.1.) A future iteration could
publish proof-acceptance attestations to a public commitment chain for
auditability without changing the substrate.

---

## Where to next

- [`docs/PROOF_BOUNTY_WALKTHROUGH.md`](./PROOF_BOUNTY_WALKTHROUGH.md) — end-to-end
  tutorial with concrete commands.
- [`docs/proof-incentive-economics.md`](./proof-incentive-economics.md) — economic
  parameter authority.
- [`plans/proof-incentive-layer.md`](../plans/proof-incentive-layer.md) — full
  plan with adversary model and slice-by-slice architecture.
- [`docs/archive/developer/VERIFICATION.md`](./archive/developer/VERIFICATION.md) —
  the L0/L1/L2/L3 verification ladder this layer activates.
- [`docs/archive/developer/FEDERATION.md`](./archive/developer/FEDERATION.md) —
  the F4 tier framework the proof market instantiates.
