# proof-incentive-economics.md — Yakcc

> The economic spec for the proof-incentive layer. This document is orthogonal
> to the substrate ladder in `MASTER_PLAN.md` (v0..v2), to the verification
> spine in `docs/archive/developer/VERIFICATION.md` (L0..L3), and to the
> trust/scale axis in `docs/archive/developer/FEDERATION.md` (F0..F4). It
> instantiates the F4 economic primitives — Decomposition Bounty, Proof of
> Fuzz, Stake-to-Refine — named in `docs/archive/developer/MANIFESTO.md` §IV
> with concrete numerical defaults, slashing rules, verifier compensation, and
> sybil-resistance mechanics.
>
> **Authority.** This document is read-only for implementer slices. The
> reputation-track implementation (`wi-proof-stake-reputation-track`, #1085)
> and the crypto-track implementation (`wi-proof-stake-crypto-track`, #1086)
> consume this doc as authority. Any deviation requires a spec revision and a
> new `DEC-PROOF-STAKE-ECONOMICS-NNN` entry.
>
> **Source slice.** `plans/proof-incentive-layer.md` §4 Slice E (economics).

@decision: DEC-PROOF-STAKE-ECONOMICS-001 — Proof market economic parameters
locked. Status: accepted. Cross-refs: `MASTER_PLAN.md` decision log,
`docs/archive/developer/FEDERATION.md` DEC-FED-004 (slashing-as-deprecation)
and DEC-FED-005 (F4 economic primitives), `docs/archive/developer/MANIFESTO.md`
§IV (Decomposition Bounty / PoF / Stake-to-Refine), and
`docs/archive/developer/PRIOR_ART.md` §M8 (slashing-as-deprecation mechanism).

---

## Thesis

The proof-incentive layer answers a single question: **how does a stranger
convince the registry that their proof claim is worth trusting, when the
cornerstone forbids author identity as evidence?** The answer is economic
skin-in-the-game — the claimant stakes something they care about, the
network attests, and a defected claim costs the claimant more than honest
participation would have paid them.

The substrate already provides the *mechanical* verification ladder
(L0..L3); see `docs/archive/developer/VERIFICATION.md`. The economic layer
provides the *participation* incentive that makes verifiers show up, that
makes claimants think twice before submitting weak proofs, and that makes
the cost-asymmetry of L3 (proofs are cheap to verify, expensive to forge)
into a market signal rather than a benevolent assumption.

Two stake units are supported and must coexist from v0:

1. **Reputation credit** (default, non-transferable). A per-account scalar
   maintained by the registry. Earned through accepted submissions and
   correct attestations; lost through slashing. Cannot be sold, gifted, or
   transferred between accounts. This is the F4-without-chain path: every
   feature of the proof market is accessible to a participant who never
   touches a token.
2. **Crypto opt-in** (per-bounty, escrow-custodied). A participant may
   designate a particular bounty as crypto-collateralized; the operator
   treasury holds the escrow until resolution. v0 uses trusted-operator
   manual escrow (no smart contract dependency). The crypto track is
   strictly opt-in, per-bounty, and may be absent from any given
   deployment.

Reputation is the default because it preserves the cornerstone framing
established in `FEDERATION.md` — **private use is first-class, public use is
the amplified mode of private use**. A federation peer running at F4 with
zero crypto integration must remain a fully participating verifier-citizen.
The crypto track exists to give the operator a fundraising surface and to
give risk-tolerant participants a way to internalize higher-confidence
attestations; it must never be a precondition for participation.

---

## §1. Stake units

| Unit | Transferable | Custody | Slashing destination | Bootstrap source |
|---|---|---|---|---|
| Reputation credit (RC) | No | Centralized `reputation_ledger` (v0); federated gossip deferred to v1 | Deleted (irrecoverable) | Operator grant of 100 RC per new account |
| Crypto escrow | Yes (off-chain transfer; redeemable at resolution) | Operator treasury wallet (trusted-operator escrow for v0; smart-contract escrow deferred to v1) | Transferred to operator treasury wallet | Per-bounty operator contribution; later, slashed-stake revenue |

**Why two units.** Reputation alone cannot fund a synthesizer who needs to
recoup compute cost; crypto alone violates the "private use first-class"
framing. Both must exist, and a participant must be able to choose which to
hold for any given bounty.

**Why reputation is non-transferable.** A transferable reputation token
becomes a tradeable asset, which re-introduces author identity by the back
door (a high-reputation account becomes a valuable identity to purchase or
phish). Reputation as a non-transferable scalar is structurally aligned
with the cornerstone: it accumulates per-participant from per-participant
work, and cannot be reassigned.

**Why crypto custody is centralized for v0.** A smart-contract escrow is
the obvious v1 target but introduces chain-coupling that
`docs/archive/developer/FEDERATION.md` DEC-FED-002 explicitly defers (the
`@yakcc/incentives` package keeps chain adapters as a leaf interface, not a
hard dependency). Trusted-operator escrow is the minimum viable economic
flow that proves the rest of the spec; it is honest about the trust
assumption rather than pretending decentralization that does not yet exist.

---

## §2. Reputation accrual rules

The reputation ledger is a per-account scalar updated atomically on each
qualifying event. Defaults are concrete (not TBD); they are tunable via the
proof market's governance surface but require a `DEC-PROOF-STAKE-ECONOMICS-NNN`
revision to change.

| Event | Reputation delta | Rationale |
|---|---|---|
| Accepted atom submission (block reaches L0 and passes registry checks) | +5 RC | Baseline participation reward; covers the typical case (most submissions are atoms, not proofs). |
| Accepted proof claim (claim reaches L3 and survives the dispute window) | +50 RC | Proofs are 10× scarcer than atoms and bear 10× the verification cost; the reward must justify the marginal effort. |
| Correct verifier attestation (attestation matches the supermajority outcome at resolution) | +2 RC | Small per-attestation reward; verifiers earn primarily through volume. |
| Slashed claim (claim invalidated by counter-proof during dispute window) | −100 RC | 2× the upside of a successful proof claim — a defected proof must cost more than the expected value of an honest one to make defection unprofitable in expectation. |
| Dissenting verifier (attestation does not match the supermajority outcome) | −10 RC | Honest-minority work is still partially compensated through the fee pool (§4) but reputation is gently penalized to discourage low-effort attestations. |

**Decay.** Reputation decays with a **linear half-life of 180 days**. A
participant who accrues 100 RC and then stops participating retains 50 RC
after 180 days, 25 RC after 360 days, and so on. The decay is computed
lazily at read time, not as a scheduled job; the ledger stores the absolute
RC value and the timestamp of last update, and reads apply the half-life
formula.

**Why linear half-life over step-function.** A step decay (e.g., "all RC
older than 12 months is zeroed") creates cliff effects that distort
behavior near the boundary — participants game the calendar rather than
participate consistently. Linear half-life produces a smooth, predictable
gradient: the marginal value of participating today is always the same
relative to participating yesterday, regardless of absolute calendar
position.

**Why the asymmetry between accrual and slash.** A successful proof claim
earns +50 RC. A slashed proof claim costs −100 RC. The 2× asymmetry is the
core economic deterrent: it makes the expected-value calculation favor
honest participation whenever the participant's subjective probability of
detection exceeds 50%. The supermajority verifier set is sized to make that
threshold easy to clear in practice (see §4).

---

## §3. Slashing rules

Slashing is the cost imposed on a defected claim or attestation. It is
neither a transfer to the harmed party nor a reward to the detector; it is
**destruction-to-treasury** (crypto) or **deletion** (reputation). This is a
direct application of `docs/archive/developer/FEDERATION.md` DEC-FED-004:
slashing is *deprecation* of the failing block / claim at the registry
level, not seizure that flows to a counterparty.

| Track | Slashing destination | Counter-claimant reward | Verifier reward |
|---|---|---|---|
| Reputation | Deleted from `reputation_ledger` (irrecoverable) | None (reputation cannot be transferred) | Verifier fee pool (§4) only |
| Crypto | Transferred to operator treasury wallet | None (see exception below) | Verifier fee pool (§4) only |

**Why slashing never flows to participants.** A slash that rewards the
detector creates a grief vector: a well-resourced attacker submits a
plausible-looking but ultimately false counter-proof against an honest
claim, hoping to provoke a settlement at the detector's expense. The
network must reward *correct detection through the supermajority verifier
process*, not detection-as-bounty-hunting. The verifier fee pool (§4) is
the legitimate reward path; it is funded by bounty escrow, not by slashed
stake.

**The one exception: retraction reward.** A claimant may *self-retract* a
claim during the dispute window, in which case a portion of the staked
collateral is recoverable. The retraction-reward mechanism is the subject
of Slice F (`wi-proof-retraction-mvp`, #1087) and is defined in that
slice's spec, not here. This document deliberately does not lock retraction
percentages — Slice E is the slashing spec, Slice F is the retraction spec,
and the boundary is intentional so the retraction work can iterate without
re-litigating the slashing rules.

**Why crypto slash goes to operator treasury rather than being burned.**
For v0, the operator treasury is the natural counterparty: it funds the
verifier fee pool, it seeds bootstrap bounties, and it bears the
infrastructure cost of running the proof market. Routing slashed crypto
collateral back into the treasury closes the loop: the network's adversaries
fund the network's defenders. The same routing would not work for
reputation (reputation cannot be transferred to a corporate entity), which
is why the reputation track simply deletes.

---

## §4. Verifier compensation

Verifiers are the load-bearing actors in the proof market — they are the
ones whose collective signal turns a claim into a confirmed proof. Their
compensation must be:

1. positive in expectation for honest work, even when their attestation
   ends up in the minority;
2. funded by the bounty itself, not by slashed stake (see §3);
3. proportional to the bounty's value, so high-stakes claims attract
   correspondingly more verifier attention.

**The verifier fee pool.** 10% of every bounty's escrow is reserved as a
verifier fee pool, allocated at claim resolution.

| Outcome | Pool share | Per-verifier share |
|---|---|---|
| Verifiers in the matching supermajority | 98% of pool | Pool × 0.98 / N_matching |
| Verifiers in the dissenting minority | 2% of pool | Pool × 0.02 / N_dissenting (flat — equal share among dissenters) |

**Worked example.** A bounty with 1000 RC of escrow has a 100 RC verifier
fee pool. Seven verifiers attest: five agree the claim is valid, two
dissent. The supermajority outcome is "valid." Each matching verifier
earns (100 × 0.98) / 5 = 19.6 RC. Each dissenting verifier earns
(100 × 0.02) / 2 = 1.0 RC. The dissenting verifiers additionally lose 10
RC each from §2 (dissent penalty), so their net is −9.0 RC; the matching
verifiers gain 19.6 RC + 2 RC (accrual) = 21.6 RC.

**Why pay dissenters at all.** Honest verifiers can legitimately disagree
with the eventual supermajority — they may have found a real edge case the
majority missed, or they may have spent real compute on the attestation
and produced a defensible negative result. Paying the minority a flat
positive fee acknowledges the work and prevents a chilling effect on
adversarial-minority attestations, which are exactly the attestations the
network most needs to surface real bugs.

**Why 98/2 and not 80/20 or 50/50.** The matching:dissent ratio must
strongly favor consensus to keep verifier attention focused — a verifier
who knows minority attestations pay nearly as well as majority ones has no
incentive to invest effort in being correct. The 98/2 split preserves the
"dissent is paid honestly but consensus is rewarded handsomely" gradient.

**Supermajority threshold.** A claim resolves as "valid" if at least
**2/3 of attesting verifiers** signed positive. Below 2/3, the claim is
considered contested and rolls into an extended verification window with
additional verifier solicitation. The 2/3 threshold is the standard BFT
honesty assumption applied at the attestation layer.

---

## §5. Sybil resistance for the reputation track

Reputation is non-transferable and accrues from accepted work, so the
attack surface is sybil — an adversary who controls N accounts can multiply
their reputation accumulation rate by N and amortize a single defected
claim across many sybil-grant balances. The defenses are layered:

**Bootstrap grant.** Each new account receives **100 RC** at account
creation. This is the working capital that lets a new participant attempt
proof claims (which cost reputation if slashed). The grant is large enough
to be useful and small enough that creating a fresh sybil for a single
defected claim costs the operator only the per-account grant, not real
revenue.

**Identity binding for v0.** Account identity is bound to GitHub identity
(yakcc-account = github-account). This is not a strong identity guarantee
— GitHub accounts can be created cheaply — but it raises the floor on
sybil creation cost (each sybil requires a fresh GitHub account with
non-trivial activity history to clear basic spam filters) and makes
adversary tracking possible across the open web. Stronger identity
binding (signed attestations from prior peers, web-of-trust, KYC for the
crypto track) is deferred to v1.

**Per-account claim rate-limit.** Each account is limited to **5 active
proof claims** at any one time. A claim is "active" between submission and
either acceptance or slashing. The cap forces adversaries to either commit
many sybils to active claims simultaneously (raising the per-attack cost)
or to pace their attacks (raising the per-attack time). It also prevents a
single compromised account from flooding the proof queue.

**Bootstrap grant is one-time and non-renewable.** A slashed account that
falls below 100 RC does not receive a fresh grant. The bootstrap grant is
the working capital for honest participation, not a respawn mechanic.

**Why these defenses and not, say, proof-of-stake-to-vote.** A proof-of-stake
gate would require the reputation track to behave like the crypto track,
which would undermine the "no chain dependency required" framing. The
GitHub-identity-plus-rate-limit pair is the weakest defense that suffices
for v0; the strongest defense — signed peer-attestation web-of-trust — is
the v1 target once the federation gossip protocol exists.

---

## §6. Bootstrap economics

The proof market cannot exist before there are bounties to fund and
verifiers to attest. The bootstrap path is deliberate and operator-funded:

**Phase B-0 (pre-launch).** Operator seeds the first **5–10 bounties** with
meaningful reward levels (target: 200–500 RC per bounty, or crypto-track
equivalent). Bounties target high-value, well-specified proof problems
drawn from the seed corpus — proofs the operator can independently verify,
so payout authority is unambiguous in the bootstrap window.

**Phase B-1 (open call).** Operator continues to seed bounties at a slower
rate and opens proposal-submission to the network. Verifier solicitation
becomes open-call rather than operator-driven. The verifier fee pool now
funds itself out of bounty escrow rather than out of operator subsidy.

**Phase B-2 (self-sustaining).** Slashed-stake revenue (crypto track) and
network-organic bounty submission cover the verifier fee pool and the
operational cost. The operator's role narrows to escrow custody and dispute
arbitration.

**Reward sources, in priority order:**

1. **Operator treasury contributions** — the bootstrap source; covers
   B-0 fully and B-1 partially.
2. **Slashed crypto-track collateral** — flows into the operator treasury
   per §3; available to refund into the bounty pool.
3. **Optional sponsor contributions** — third parties may sponsor bounties
   directly. Sponsors do not get governance influence over claim
   resolution; the verifier process is the only authority.

**Why operator-seeded rather than community-bootstrapped.** A
community-bootstrapped market requires participants to believe the market
will exist before the market exists, which is a coordination problem
identical to the one any new network faces. The operator absorbing the
B-0 risk is the cheapest way to demonstrate the flywheel works; it is
explicit and audit-trail-visible, which is consistent with the trust model
already established by trusted-operator escrow in §1.

---

## §7. Open questions resolved here

This section locks resolutions for the open questions called out in
`plans/proof-incentive-layer.md` §4 Slice E. Each resolution carries
explicit rationale so the decision is not reopened without a new DEC.

| Open question | Resolution | Rationale |
|---|---|---|
| Crypto-track v0: smart contract or trusted operator? | **Trusted-operator manual escrow.** Smart-contract escrow deferred to v1. | Smart-contract escrow introduces chain coupling that `FEDERATION.md` DEC-FED-002 already defers. Manual escrow proves the rest of the spec without prejudging the chain choice. |
| Reputation storage: centralized or federated? | **Centralized in `reputation_ledger` for v0.** Federation gossip deferred to v1. | The federation protocol (`docs/archive/developer/FEDERATION_PROTOCOL.md`) does not yet specify a reputation-gossip schema. Centralizing for v0 lets the proof market work today and lets the federation work define the gossip schema with real reputation data as input. |
| Decay model: linear half-life or step function? | **Linear half-life with 180-day half-life period.** | Step functions create gaming behavior at the boundary; linear half-life produces a smooth gradient. See §2 for the full rationale. |
| Slashing destination: burned, transferred to detector, transferred to treasury? | **Reputation: deleted. Crypto: transferred to operator treasury.** | Detector-reward creates grief vectors (§3). Burning is wasteful for crypto and incoherent for reputation. Operator-treasury routing closes the economic loop for crypto and matches the operator's bootstrap role. |
| Verifier compensation split: how to handle dissenting verifiers? | **98/2 split with flat per-dissenter share.** | Pays honest minority work without weakening the consensus gradient. See §4 worked example. |

---

## §8. Cross-references

| Source | Reference | Relationship |
|---|---|---|
| `plans/proof-incentive-layer.md` | §4 Slice E (economics) | This document is the deliverable for Slice E. |
| `plans/proof-incentive-layer.md` | §11 decision log | This document's `DEC-PROOF-STAKE-ECONOMICS-001` is the source-of-truth entry; the plan's decision log row mirrors it. |
| `plans/proof-incentive-layer.md` | §3.2 lifecycle | Claim states (submitted → attested → resolved → confirmed / slashed) are consumed by the slashing rules in §3. |
| `plans/proof-incentive-layer.md` | §6 adversary model | The sybil-resistance defenses in §5 instantiate the threats enumerated in the plan's adversary model. |
| `docs/archive/developer/FEDERATION.md` | F4 tier (`§The trust/scale axis`) | This document specifies the economic primitives that the F4 tier requires. |
| `docs/archive/developer/FEDERATION.md` | DEC-FED-004 (slashing-as-deprecation) | §3 is a direct application: slashing is destruction/deletion, never transfer to a counterparty. |
| `docs/archive/developer/FEDERATION.md` | DEC-FED-005 (F4 primitives) | §1 enumerates the stake units that the Decomposition Bounty / PoF / Stake-to-Refine primitives use. |
| `docs/archive/developer/MANIFESTO.md` | §IV (three economic primitives) | This document is the numerical/operational realization of the manifesto's economic framing. |
| `docs/archive/developer/PRIOR_ART.md` | §M8 (slashing-as-deprecation mechanism) | Prior-art justification for the slashing-destination rules in §3. |
| `docs/archive/developer/VERIFICATION.md` | L3 cost asymmetry | §2's 10× accrual for proof claims over atom submissions reflects the L3-vs-L0 cost asymmetry documented in `VERIFICATION.md`. |
| `wi-proof-stake-reputation-track` (#1085) | Implementation slice | Consumes §1, §2, §3 (reputation row), §5 as authority. |
| `wi-proof-stake-crypto-track` (#1086) | Implementation slice | Consumes §1, §3 (crypto row), §6 as authority. |
| `wi-proof-retraction-mvp` (#1087) | Adjacent slice | Owns the retraction-reward percentages deliberately left open in §3. |

---

## Decision log

| DEC | Statement |
|---|---|
| DEC-PROOF-STAKE-ECONOMICS-001 | Proof market economic parameters locked at the values specified in this document. Reputation accrual: +5 / +50 / +2 / −100 / −10 (atom / proof / correct attestation / slashed claim / dissenting attestation). Linear half-life decay of 180 days. Slashing destination: reputation deleted, crypto transferred to operator treasury wallet; never transferred to participants except per the retraction mechanism (Slice F). Verifier fee pool: 10% of bounty escrow, 98/2 supermajority/dissent split. Sybil defenses for the reputation track: 100 RC bootstrap grant (one-time), GitHub-identity binding for v0, 5-active-claim per-account rate limit. Bootstrap economics: operator seeds 5–10 initial bounties at 200–500 RC equivalent; slashed-stake revenue feeds the verifier fee pool from Phase B-2 onward. Open questions resolved: crypto v0 = trusted-operator escrow; reputation v0 = centralized `reputation_ledger`; decay = linear half-life. Status: accepted. Supersedes: none (initial economic spec for the proof-incentive layer). |
