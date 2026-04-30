# FEDERATION.md — Yakcc

> The trust/scale axis. This document is orthogonal to the substrate ladder
> in `MASTER_PLAN.md` (v0..v2) and to the verification spine in
> `VERIFICATION.md` (L0..L3). Substrate maturity is what yakcc can do;
> verification is how confident we are in each block; federation is how
> many machines participate and what economic primitives are available.

---

## Thesis

The user, in their own words:

> *This should all be an optional layer that can be super imposed for the
> public repository. The yakcc backend should be usable as a private set of
> recomposable blocks for anyone to use. Reputation, scale, and incentivized
> verification are the add-ons.*

Federation is the optional sidecar. **Yakcc-private — single-machine, no
chain, no attestation network — must remain first-class at every substrate
level.** A user running yakcc privately at `(v0.7, F0)` has the full
substrate (recursive sub-function decomposition, the verification ladder,
the seed corpus, `yakcc shave`) without ever touching a network. Federation
features are **imported, not inherited**: a private deployment imports
`@yakcc/federation` only when it wants attestation lookup against a public
mirror; it imports `@yakcc/incentives` only when it wants to participate in
the bounty economy. Neither is a default.

This framing forecloses on a class of architectural drift. If we let
federation features creep into the core packages — "the registry just needs
a tiny attestation-fetch path on the cold path" — then private use stops
being first-class and becomes "the degraded mode of public use." The
cornerstone (no ownership) and the user's "optional sidecar" framing both
require the opposite: public use is the *amplified* mode of private use.

The trust/scale axis names that amplification at five levels. Each level
adds capability. No level is a tax on the level beneath it.

---

## The trust/scale axis (F0..F4)

| F | Mode | What's connected | What's local | Required packages |
|---|---|---|---|---|
| F0 | Single-machine | nothing | full registry, full IR, full verification, full execution | `@yakcc/core` |
| F1 | Federated read-only mirror | pull attestations + content from public registry | execution stays local; selection consults attestations | `@yakcc/core` + `@yakcc/federation` |
| F2 | Attested mirror | + write attestations back; participate as verifier-citizen | local verifier produces signed attestations under its identity | `@yakcc/core` + `@yakcc/federation` |
| F3 | ZK-supply-chain | + cryptographic proof that the local executable maps to on-chain hashes | tamper-proof supply chain without exposing local execution | `@yakcc/core` + `@yakcc/federation` (+ ZK toolchain) |
| F4 | Economic-commons participant | + bounty submissions, stake, slashing, PoF, refinement market | reputation/economics as opt-in modules | `@yakcc/core` + `@yakcc/federation` + `@yakcc/incentives` |

The levels stack. F1 is F0 plus a lookup capability. F4 is F3 plus economic
primitives. A user can sit at any level and stay there indefinitely; there
is no expectation that everyone moves toward F4. The registry is a commons,
not a marketplace; F4 is what makes the commons *expand* in adversarial
conditions, but a private registry that never grows is a perfectly valid
yakcc deployment.

### What each level changes for a single user

A worked example: `parse-int-list-co`, an enthusiast running yakcc on a
laptop, considering each level.

- **F0.** They `pnpm install @yakcc/core`. They run `yakcc registry init`,
  ingest the seed corpus, and `yakcc compile examples/parse-int-list`. They
  never touch a network beyond `pnpm install`. Their registry holds
  whatever they author or shave locally. They are at full v0.7 capability:
  the substrate is real, blocks are content-addressed, the IR validator
  enforces the strict TS subset, the verification ladder lets them claim
  L0–L3 levels on their own blocks. Nothing about F0 is a degraded mode.

- **F1.** They add `pnpm install @yakcc/federation`, configure a public
  mirror URL, and run `yakcc federation pull`. The local registry now
  contains content-addressed copies of public blocks plus attestations from
  trusted verifiers in the public network. They still execute locally. They
  still verify locally if they want. Selection has more candidates to
  choose from — and consults attestations to prefer L2/L3 blocks where
  available. They have not authored anything publicly. They have not
  exposed any local code or local compute.

- **F2.** They add a verifier identity (a keypair generated locally), and
  when their local verifier checks a block at L0/L1/L2, they sign the
  attestation and `yakcc federation push` it. The federation layer
  propagates the attestation to other F2+ peers. They are now a
  *verifier-citizen* of the public network. They have not contributed
  source code; they have contributed verification labor. Their identity
  is the keypair, not their email — the cornerstone (no ownership) holds
  because nothing they signed is a *block*; it is an *attestation*.

- **F3.** They add the ZK toolchain (a separate install, a real binary
  size, real proving compute). When they `yakcc compile`, the compiler
  emits a ZK proof showing the local executable's bytes hash to the
  on-chain attestation set. They can hand the proof to a deployment target
  (a server, a smart contract, a customer) without exposing the source.
  This is the supply-chain promise made cryptographic: "you got exactly
  what was attested, with no attached attack surface." They still execute
  locally; the proof is a sidecar that travels with the artifact.

- **F4.** They run a bounty miner — a process that searches the registry's
  unmatched proposals, attempts synthesis, and submits candidate blocks for
  payout. They run a Proof-of-Fuzz miner that fuzzes existing blocks for
  contract deviations. They stake tokens on refinement claims they make
  about specific blocks ("this block is 2x faster than the current
  selection winner; here is my benchmark"). They can lose stake on failed
  claims. The economy is the part of yakcc most exposed to adversarial
  pressure; F4 is the level where that exposure becomes intentional.

At every level above F0, the user can drop back to F0 by uninstalling the
optional packages. Their private blocks remain. Their content-addresses do
not change. There is no upgrade-then-can-never-go-back boundary.

---

## Orthogonal-axes diagram

Three independent axes:

```
                          Trust/Scale (this document)
                          F0 → F1 → F2 → F3 → F4
                          ──────────────────────────►

Substrate (MASTER_PLAN)   ▲
v0 → v0.5 → v0.7          │           Verification (VERIFICATION.md)
v1 → v2                   │           ▲
                          │           │
                          │           │  L0 → L1 → L2 → L3
                          │           │
                          ▼           ▼
```

A user's coordinate is `(v, F, L)`:

- `(v0.7, F0, L0)` — full substrate, single machine, property-tested only.
  The current v0.7 demo target.
- `(v0.7, F1, L2)` — full substrate, single machine, but selecting against
  a public mirror's L2-attested blocks. Property tests run locally; SMT
  refinement attestations come from trusted public verifiers.
- `(v1, F4, L3)` — federated registry, full economic participation,
  selecting Lean-proven blocks where available. The aspirational endpoint.
- `(v2, F0, L0)` — yakcc self-hosting on a single machine with no network
  and no formal verification, just the property-test floor. Still a valid
  configuration; the cornerstone holds.

The substrate ladder (`MASTER_PLAN.md`) and the verification ladder
(`VERIFICATION.md`) are independent of this axis; nothing in F1+ requires
v1+, and nothing in v1+ requires F1+. The packaging decomposition below is
what enforces this independence.

@decision: DEC-FED-001 — Substrate (v-axis), trust/scale (F-axis), and
verification (L-axis) are orthogonal. A user sits at any `(v, F, L)`
coordinate. Federation features are imported, not inherited; the F0
single-machine deployment is first-class at every substrate level.

---

## Package decomposition

```
@yakcc/core                                # F0 — every yakcc deployment
├── @yakcc/contracts                       # spec, canonicalization, content-address
├── @yakcc/registry                        # local SQLite + sqlite-vec store
├── @yakcc/ir                              # strict-TS subset validator
├── @yakcc/compile                         # whole-program assembly
├── @yakcc/seeds                           # the ~20-block seed corpus
├── @yakcc/cli                             # `yakcc` command surface
├── @yakcc/hooks-claude-code               # facade in v0, live v0.5+
└── @yakcc/shave                           # v0.7 sub-function decomposition

@yakcc/federation                          # F1+ — opt-in
├── attestation lookup                     # consult remote verifiers
├── content mirroring                      # pull/push content-addressed blocks
├── attestation publishing                 # F2+ — local verifier signs and propagates
└── ZK supply-chain proofs                 # F3 — cryptographic artifact map

@yakcc/incentives                          # F4 — opt-in, chain-bound
├── bounty submission                      # claim unmatched proposals
├── proof-of-fuzz miner                    # find contract deviations
├── stake-to-refine                        # claim faster/smaller/better; risk stake
└── slashing/deprecation                   # adversarial-block response
```

Three properties of this decomposition:

1. **`@yakcc/core` is everything in v0/v0.5/v0.7/v1/v2 substrate work.** The
   v-axis advances entirely within `@yakcc/core`. A v0.7 deployment without
   federation is `@yakcc/core` only; a v2 self-hosting deployment without
   federation is `@yakcc/core` only.
2. **`@yakcc/federation` is chain-agnostic.** Nothing in this package
   imports a specific chain, a specific token, or a specific consensus
   layer. It speaks attestations and content-addressed mirroring. F1, F2,
   F3 all live here. The only chain-bound package is `@yakcc/incentives`.
3. **`@yakcc/incentives` is the only package that touches a chain.** This
   isolation is deliberate. A user who wants F1/F2/F3 capability without
   any economic exposure installs `@yakcc/federation` and not
   `@yakcc/incentives`. The cornerstone (no ownership) is preserved
   because incentives reward *compute and verification labor*, not
   *authorship of blocks*.

Each package has its own README with its contract, its public surface, and
its non-goals. The dependency graph is a DAG: `@yakcc/incentives` depends
on `@yakcc/federation` depends on `@yakcc/core`; nothing flows the other
way. The IR validator does not know federation exists; the registry does
not know about chains.

@decision: DEC-FED-002 — Package decomposition. `@yakcc/core` ships the full
substrate (v0..v2). `@yakcc/federation` is the F1+ optional sidecar
(attestation lookup, content mirroring, attestation publishing, ZK
supply-chain proofs). `@yakcc/incentives` is the F4-only chain-bound
sidecar. Dependencies flow `incentives → federation → core`; never the
reverse.

---

## Network architecture (F3+)

F3 introduces three layers. None of them is implemented in v0/v0.5/v0.7;
the architecture is documented now so the F-axis design is coherent and
v1+ can build to it without re-deriving.

### State and attestation appchain (L2/L3 rollup)

Holds:

- **content-addressed contract IDs** — `(spec_hash → BlockMerkleRoot[])`
  index entries.
- **append-only attestation ledger** — every attestation issued by a
  verifier on the network. Attestations are immutable once published;
  revocations are separate ledger entries that mark prior attestations
  invalid.

The chain choice is an example, not a commitment. OP Stack rollups
(Optimism, Base) are a reasonable default for an append-only attestation
log: cheap, tamper-evident, public. Other rollups (Arbitrum, Starknet) work
equally well. **Specific chain choice, token names, and supply schedules
are deferred to F4 implementation work and are not load-bearing decisions
of this document.** The principle is that attestations need a tamper-
evident public ledger, not that they need a specific chain.

### Data availability layer

Holds the actual block content: `spec.yak`, `impl.ts`, `proof/` artifacts.
The chain holds *hashes*; the DA layer holds *bytes*.

Candidate stacks: Celestia, EigenDA, IPFS. **Important caveat:** atomic
blocks are small. A typical seed-corpus atom (`digit`, `bracket`, `comma`)
is hundreds of bytes of source plus a kilobyte of property tests plus
maybe an SMT certificate. A `parseIntList` block is ~5 KB. A registry of
1M blocks is on the order of 10 GB of content.

This means the **default DA assumption — pay for cryptoeconomic
availability via Celestia or EigenDA — may be the wrong tool**. IPFS
pinning, with a few well-incentivized pinners, may be sufficient and
substantially cheaper. The right choice depends on adversarial assumptions
(if pinners can be coerced to drop content, cryptoeconomic DA becomes
necessary; if they cannot, IPFS is fine). This is an empirical question.
The architecture supports either; the decision is deferred until the
registry has enough blocks for the cost difference to matter.

@decision: DEC-FED-003 — Data availability layer for F3+ is selected
empirically. IPFS pinning is the cheap default; cryptoeconomic DA
(Celestia, EigenDA) is the upgrade path if pinning proves insufficient.
The architecture supports both. Specific selection deferred to F4
implementation.

### ZK supply-chain proofs

The F3 capability: prove that a locally-assembled executable's bytes hash
to a specific set of on-chain attestations.

This is **hash composition, not behavioral proof**. The ZK circuit shows:
"the bytes of `output.js` are derivable from the bytes of these N
content-addressed blocks via the published `@yakcc/compile` algorithm,
and those N blocks have these K attestations on-chain." It does **not**
show "the executable is correct." Correctness comes from the L1/L2/L3
attestations on each constituent block; the ZK proof shows those
attestations *belong to this binary*.

The distinction matters because ZK proofs of arbitrary computation are
expensive and fragile. ZK proofs of hash compositions are cheap and well-
understood. F3 is intentionally the cheaper one: it makes the
attestation-coverage claim cryptographic, and it lets the
verification-level claim ride along by reference.

A consumer of the ZK proof verifies:

1. the proof checks under a known circuit and known proving system.
2. the cited attestations exist on the appchain.
3. the cited blocks meet the consumer's verification-level threshold.
4. the binary's bytes hash matches the proof's claimed output.

If all four hold, the consumer has cryptographic confidence the binary
they have is the binary that was attested. This is a substantially
stronger supply-chain story than today's "the package was downloaded from
npm and we hope no one MITM'd it."

---

## Attestation protocol

An attestation, repeated from `VERIFICATION.md`:

```
Attestation = (
  verifier_hash: BlockMerkleRoot,        // which verifier produced this
  block_hash: BlockMerkleRoot,           // which block was checked
  level: L0 | L1 | L2 | L3,              // the level claim
  evidence: bytes,                       // signed payload
  valid_until_revoked: bool,             // revocation semantics
  issued_at: timestamp,                  // for ordering revocations
  signer: PublicKey,                     // F2+: the verifier-citizen's key
  signature: bytes,                      // F2+: signature over the tuple
)
```

### Lifecycle

1. **Issue.** A verifier (local at F0; remote at F1+; signed at F2+) runs
   the level check on a block. On success, it constructs the attestation
   tuple. At F2+ the verifier signs the tuple with its keypair.
2. **Propagate.** At F1+ the attestation is published to the federation.
   At F2+ the verifier explicitly pushes its signed attestations. At F4
   the verifier may earn tokens for publishing attestations on previously-
   unattested blocks.
3. **Consult.** At selection time, the registry's selector consults the
   attestation set for each candidate block. Selection prefers blocks
   with attestations from trusted verifiers at higher levels.
4. **Revoke.** A revocation is a separate ledger entry naming a verifier
   hash (revoke all that verifier's attestations) or a specific
   attestation tuple (revoke just this one). Consumers re-query selection;
   blocks that lose their level claim fall back to whatever else is
   re-verifiable.

### Verifier rotation as a controlled wave

When `VerifierHash_B` releases:

- the federation does **not** mass-re-verify every block on day zero. That
  would be prohibitive.
- selection lazily prefers `VerifierHash_B` attestations where they exist;
  blocks with only `VerifierHash_A` attestations remain selectable but at
  a lower selection priority for callers whose trust list has updated.
- proof-converter agents (where applicable; see `VERIFICATION.md`) produce
  `VerifierHash_B` attestations from `VerifierHash_A` attestations for
  compatible verifier upgrades, without re-running the full check.
- F4 incentives can prioritize re-verification under B by pricing
  fresh-B-attestation bounties higher for high-traffic blocks.

The rotation is an emergent process driven by selection pressure and
incentive design, not a coordinated mass-update. This is what makes the
verifier-as-block pattern scale: nothing has to happen at once.

---

## Economic mechanics (F4 only)

F4 is the only level that touches a chain or a token. **None of these
primitives are part of `@yakcc/core` or `@yakcc/federation`.** They live
in `@yakcc/incentives`, which a user installs only when they choose to
participate in the economy.

Tokens reward **compute and verification labor**, not block authorship.
This is the cornerstone-preserving move: a block, once registered, belongs
to the public domain under The Unlicense. Its registrant gets nothing
recurring. The reward goes to:

- the synthesizer who first produced an L2/L3-passing block for an
  unmatched proposal (one-time bounty payout).
- the fuzzer who first finds a contract-deviation counterexample
  (Proof-of-Fuzz reward).
- the verifier-citizen who attests blocks at L2/L3 (attestation-publishing
  reward, weighted by level — see "L3 economic premium" below).
- the refiner who proves a refinement claim (faster / smaller / lower-
  memory) about an existing block (stake-returned with yield).

> *Tokens are emitted strictly to subsidize the expansion and auditing of
> the commons. Once a block is verified and accepted, it belongs to the
> public domain.* — the user, on the cornerstone-preserving move.

### Proof-of-Fuzz (PoF)

Miners run differential execution and SMT solving on competing
implementations of the same contract. A discovered deviation — input on
which two implementations disagree, or input on which an implementation
violates its declared postcondition — is rewarded with newly-minted
tokens.

**Slashing semantics.** When a deviation is found in block B, B is
**deprecated** at the registry level: future selection avoids B in favor
of the alternative implementation that survives the deviation, and a
deprecation event is logged on the appchain. Slashing is **not** seizure
of an author's stake, because the cornerstone forbids author identity —
there is no submitter stake at submission time to seize. The block goes
public-domain at registration; it loses selection at deprecation. That is
the entire economic consequence on the block side.

**Adversarial structure.** The attack is "submit blocks I expect to fail
PoF, hoping nobody runs the fuzz." Mitigation: PoF rewards are weighted
toward high-traffic blocks (more selection volume = more PoF reward),
which means malicious low-traffic blocks are uneconomical to attack but
also relatively low-impact when they slip through. The other attack is
"sybil-attack the fuzz miner pool to claim my own bounties." This is
genuinely hard to fully solve under "no ownership." Partial mitigation:
proof-of-fuzz requires expensive compute (the differential-execution
budget is the cost), so sybil rewards collapse to compute cost; sybil
attacks become break-even at best. Real attestation-pool diversity is
the long-term answer.

@decision: DEC-FED-004 — Slashing is *deprecation* of the failing block at
the registry level, not seizure of submitter assets. The cornerstone
forbids submitter identity; there is no asset to seize. A block losing
selection because PoF found a counterexample is the economic
consequence. This preserves the public-domain commitment.

### Bounties

Unmatched proposals (a caller asked for a contract no block satisfies)
attach a token bounty. The first synthesizer with a passing block claims
it. The block goes public-domain on registration; the synthesizer keeps
the bounty payout.

**Front-running mitigation.** The naive design ("first transaction in the
mempool wins") is MEV-vulnerable: a synthesizer with mempool-watching
infrastructure copies a competitor's submission and front-runs them.
Mitigation: **batch-resolution windows.** Bounties resolve at fixed
intervals (e.g., every 24 hours). All submissions during the window are
revealed at the same time (commit-reveal scheme: submit a hash during the
window, reveal the block at window close). The best submission by
quality+speed criteria wins, with quality being a function of declared
verification level (L3 beats L2 beats L1 beats L0) and speed being the
benchmark on a published test corpus.

This breaks the mempool-race attack. It introduces its own attack — "spam
many low-quality submissions during the window to drown out the real
ones" — which is mitigated by the canonicalization engine (next).

### Stake-to-Refine

A refinement claim is a non-functional improvement: "this block is 2x
faster than the current selection winner on benchmark X," "this block
uses 30% less memory on input Y," "this block is constant-time where the
prior was not." Submitting a refinement claim requires staking tokens.

PoF benchmarkers test the claim:

- if the claim holds, the staker's stake is returned with a yield, and
  the benchmarkers are paid.
- if the claim fails (the benchmark does not reproduce the claimed
  improvement), the stake is **burned** (not transferred to a competitor;
  burning preserves the no-ownership commitment).
- if the benchmarkers find a *backdoor* in the refinement (the block is
  faster because it skips a postcondition check), the stake is burned
  *and* the block is deprecated.

This is the only stake-at-risk mechanism in the F4 economy. The stake is
not on the block (the cornerstone forbids that); it is on a *claim about
the block*. Claims are signed by the staker's keypair, not their email.
Lost stake to a failed claim is a recoverable mistake; the staker has not
lost authorship of anything because they never had it.

### Canonicalization engine (constitutional, not F4-owned)

The canonicalizer that collapses cosmetic-rewrite spam in F4 bounty
windows is **not an F4 mechanism**. It is the constitutional pre-ledger
canonicalization pass owned by `VERIFICATION.md` §"Semantic AST
canonicalization" (DEC-VERIFY-009), running in `@yakcc/contracts`, on
**every** yakcc deployment from F0 single-machine outward. F4 does not
add the canonicalizer; F4 *amplifies its reach* across the commons by
applying it to every cross-deployment proposal that hits the bounty
batch.

Concretely:

- **At F0/F1/F2/F3:** the canonicalizer runs at submission time on every
  block proposal. A structural duplicate is rejected at ingest with the
  existing block's `BlockMerkleRoot` returned. The yakcc-private operator
  gets duplicate detection and structural-equivalence indexing for free —
  the user's "optional layer" framing means private deployments inherit
  the universalizer pipeline, not just the public commons.
- **At F4 specifically:** the same canonicalizer also gates the bounty
  batch-resolution window. An attacker submitting ten cosmetic
  variations of the same block produces ten submissions that all
  canonicalize to the same `canonical_ast_hash`; nine collapse to
  duplicates of the first; only the first gets evaluated for the
  bounty payout. This is the F4 amplification: the constitutional pass
  is the same pass; the F4 deployment runs it across a wider input set
  with economic stakes attached.

Why this matters for federation architecture: an earlier draft of this
document framed the canonicalization engine as F4 anti-spam. That framing
was wrong because it implied yakcc-private installations did not get the
universalizer's spam-resistance. Per the cornerstone (no ownership) and
the user's "optional layer" framing, **private use is the amplified mode
of public use, not the degraded mode**. The canonicalizer belongs in
`@yakcc/core` (under `@yakcc/contracts`), not in `@yakcc/federation` or
`@yakcc/incentives`.

`Stake-to-Refine` claims, `Bounties` submissions, and direct
`yakcc propose` invocations all pass through the same canonicalization
pass. The canonicalizer is a content-addressed block on the per-caller
trust list (verifier-as-block discipline; `VERIFICATION.md` DEC-VERIFY-008);
v0.7's sub-function granularity work makes the canonicalizer tractable:
atoms are small, finite, enumerable, and two implementations of `digit`
canonicalize to the same atom-shaped form regardless of cosmetic
differences.

@decision: DEC-FED-007 — The canonicalization engine is constitutional,
not F4-owned. It lives in `@yakcc/contracts` (per `VERIFICATION.md`
DEC-VERIFY-009), runs at every level from F0 outward, and is amplified
(not introduced) at F4. Earlier drafts of `FEDERATION.md` §"Canonicalization
engine" framed it as F4 anti-spam; that framing is superseded. F4 economic
flows (Stake-to-Refine, Bounties, batch-resolution windows) consult the
constitutional canonicalizer; they do not own a parallel one (Sacred
Practice #12). Source: `suggestions.txt` ask #1, surfaced into the
constitutional layer.

### L3 economic premium

L3 attestations earn ~10x L2 to incentivize proof writing.

**Why this is necessary.** Proof writing is approximately 10x more
expensive than fuzz-driven verification at the same coverage. Without an
asymmetric reward, a rational F4 participant minimizes effort by writing
fuzz harnesses and never writes Lean proofs. The L3 tier of the
verification ladder remains aspirational and unpopulated.

**Why ~10x.** The number is illustrative, not load-bearing on this
document. It expresses the order-of-magnitude asymmetry; the exact
multiplier is a F4 implementation parameter tuned to observed cost
ratios. The point is the asymmetry, not the constant.

**The cost-asymmetry premium also applies to TCB unsoundness bounties** —
see `VERIFICATION.md` "TCB hardening". A TCB unsoundness finding is ~10x
the reward of a TCB completeness finding, and the unsoundness report must
include a counterexample witness so the bounty system is not
denial-of-service-attacked by unverifiable reports.

@decision: DEC-FED-005 — F4 economic primitives: Proof of Fuzz (rewards
finding contract deviations; deprecates failing blocks), Bounties (reward
synthesizers of unmatched proposals; batch-resolution windows mitigate
front-running), Stake-to-Refine (refinement claims require stake;
benchmarker-verified; failed/backdoored claims burn stake). The
canonicalization engine collapses duplicate submissions before
resolution. L3 attestations earn ~10x L2 to populate the proof tier.
TCB unsoundness bounties earn ~10x completeness bounties.

---

## Governance

The default trust list shipped with `@yakcc/registry` is the most
sensitive object in the entire substrate. It determines what verifiers
a fresh F2+ install accepts. A captured default trust list could route
attestations through a compromised verifier and produce a
substrate-wide unsoundness without any individual user noticing.

### The caller's trust list is sovereign

This is the cleanest governance principle available: each caller's
local trust list is final for that caller. Object-capability discipline
makes this mechanically clean — the trust list is a per-caller
configuration object, not a global registry. A user can override the
default at install time, at runtime, or per-query.

This forecloses on the absolutist failure mode (a captured default
trust list cannot affect users who have configured their own trust
list). It does not foreclose on the typical-user failure mode (most
users will not configure a trust list and will accept the default).

### The shipped default is governance, not a default

A "default" that 99% of users accept is, functionally, the canonical
trust list. Calling it a default does not change its governance weight.
The question of who maintains it is unavoidable.

Three options, with failure modes:

- **Multi-sig of named maintainers.** Reliable, accountable, has obvious
  capture risk if the maintainer set is small. The cornerstone (no
  ownership) is in tension with named maintainers who have governance
  authority — even if they are not authors of any block, they are
  governors of the trust set.

- **On-chain vote weighted by attestation history.** Aligns governance
  weight with verification labor. Has the obvious failure mode that an
  adversary who controls a lot of attestations gains governance
  authority — Sybil attacks at the verifier-citizen level become
  governance attacks. Mitigation requires reputation systems that
  themselves have governance.

- **Federation-of-attesters with rotating membership.** Hybrid:
  membership is itself voted on by the federation, with rotation rules
  that limit any single member's tenure. Most resistant to capture; most
  complex to bootstrap.

### This document does not pick

This is explicitly a **user-decision boundary**. The cornerstone forbids
ownership; the substrate requires a default trust list; "no ownership"
plus "the default trust list is sovereign" is a pair that does not have
an obvious resolution.

The implementation path is:

1. **F0/F1/F2** ship without a default trust list. Each user configures
   their own. The substrate works at this scale because users trust their
   own verifier or a small ring of named verifiers.
2. **F3/F4** require a public default. The decision on which governance
   model lives in the default is itself a governance act: it requires
   user adjudication and is the responsibility of whoever is establishing
   the public network.
3. The default trust list, once established, is itself content-addressed
   and the governance object is a block in the registry. Updates to it
   are governed by whatever the F3/F4 deployment chose at step 2.

@decision: DEC-FED-006 — Trust list governance is per-caller (sovereign
local policy). The shipped default is itself governance and is deferred
as a user-decision boundary, not chosen unilaterally by this document.
F0/F1/F2 ship without a default; F3/F4 require the governance question
to be answered by whoever deploys the public network.

---

## Adversarial considerations

The federation layer is the adversarial surface. F0 is air-gapped and
does not face network adversaries. F1+ does. F4 specifically invites
economically-motivated adversaries.

### Front-running on bounties

Mempool-watching synthesizers copy and front-run competitors' bounty
submissions. **Mitigated** by batch-resolution windows with commit-
reveal: submissions during the window are hashes; bodies are revealed at
window close; best wins on quality+speed. No mempool race exists.

### Spam via AST mutations

An attacker submits ten thousand cosmetic variations of the same block to
crowd out genuine submissions in a bounty window. **Mitigated** by the
canonicalization engine: variations of the same canonical form collapse
to the same content-address pre-resolution; the spam is visible as
duplicates before window close.

### MEV-style synthesis racing

A synthesizer with privileged compute (a fast TPU cluster) consistently
beats individual researchers to bounties, capturing the bounty pool.
**Partial mitigation** via the L3 economic premium: hard contracts that
require proof engineering (not just synthesis throughput) reward
researcher effort over compute scale. **No full mitigation** for
synthesis-throughput-heavy bounties; this is a feature, not a bug — the
substrate wants the bounties claimed by whoever can claim them, regardless
of compute scale, as long as the work is real.

### Sybil attacks on PoF

Sybil identities split rewards in a fuzz pool to game the bounty
distribution. **Partial mitigation:** PoF requires expensive compute, so
sybil split returns approximately compute-cost per identity (break-even
at best). **Full mitigation requires reputation systems that resist
Sybil at the identity-creation level**, which is unsolved at the
no-ownership constraint. We accept the partial mitigation.

### Capability forgery

An adversary at F2+ forges signed attestations under a verifier identity
they do not control. **Mitigated** by signature verification — the
attestation tuple is signed by the verifier's keypair; consumers verify
the signature against the trust list. A keypair leak compromises the
verifier; rotation is the response (the verifier publishes a key-
rotation event, the trust list updates). **No full mitigation** for
keypair leaks themselves; standard key hygiene applies.

### The exfiltration class

An adversary smuggles state out of a block via covert channels (timing,
cache, side effects on shared global state). **Mitigated at the source
level** by ocap discipline (no global state, no implicit effects, no
unattenuated capabilities). **Not mitigated** at the microarchitectural
level (cache timing, branch predictor, speculative execution); the
substrate has no story for those, and `constant_time` blocks are still
exposed to Spectre-class attacks. Open research; explicitly out of scope
for v0/v1.

### Verifier collusion

A coordinated set of F2+ verifiers all sign attestations for an unsound
block, hoping the trust list accepts attestations from that quorum.
**Mitigated** by the per-caller trust list — no individual caller has to
trust a majority quorum if they curate their own list. **At F3+ where
the default trust list matters**, mitigation depends on the governance
model chosen (see "Governance" above). This is a governance failure
mode, not an architectural one; the architecture supports any
governance choice.

### Retroactive unsoundness

A previously-trusted verifier is later found to be unsound; every
attestation it issued is now suspect. **Mitigated** by the
`valid_until_revoked` semantics: revocation events invalidate prior
attestations, blocks fall back to alternative verifiers, the substrate
recovers via re-attestation under sound verifiers. **Real risk** is the
window between unsoundness existing and unsoundness being detected;
during that window, downstream consumers may have built on attestations
they later cannot trust. Mitigation: the attestation ledger is
append-only and signed, so revocations are auditable, and consumers can
inspect their build's dependency on revoked attestations after the fact.

---

## Hard problems

The federation layer surfaces problems v0/v1 does not solve:

- **Verifier governance.** The default trust list problem. Surfaced
  above; deferred to user adjudication for F3+ deployment.

- **Default trust list authority.** Same problem from the other side:
  even if governance is decided, the bootstrap question — who runs the
  first instance — is not. Likely the answer is "whoever spins up the
  first F3 deployment is the genesis governor and the governance model
  rolls forward from there." Acceptable for a research substrate;
  fragile for a production commons.

- **Retroactive unsoundness response time.** How fast does the federation
  recover from a major verifier unsoundness event? Probably hours to days
  for re-attestation pipelines to clear; meanwhile downstream binaries
  that linked against attestations from the unsound verifier are still in
  the wild. Disclosure-and-rotation discipline is human-loop work.

- **AI proof synthesis viability.** The L3 economic premium assumes proof
  synthesis becomes cheap enough at scale that the 10x reward is
  economically rational. If proof synthesis remains 100x more expensive
  than fuzzing (rather than 10x), the premium is too small and L3 stays
  sparse. Open research; the substrate stays useful even if L3 is sparse,
  but the verification-spine pitch weakens.

- **BMC's confidence-not-certainty ceiling for crypto-sensitive blocks.**
  L2/BMC attestations are bounded — "no counterexample at depth ≤ N." For
  cryptographic primitives (SHA-256, AES, point multiplication on
  elliptic curves), depth-N is meaningless without depth-∞, and depth-∞
  is undecidable. Crypto blocks need L3 (proof) or they need a parallel
  argument (existing-deployment-history, formal-paper-level analysis).
  The substrate cannot mechanically promote a BMC attestation to crypto-
  worthy. Caller responsibility.

- **Token economics tuning.** The exact rewards, the exact stake size, the
  exact slashing curves — none of these are derivable from first
  principles. They are tuned empirically against observed adversarial
  pressure. v0/v1 ships without F4 active; F4 deployment is an experiment
  that adjusts parameters as the network grows.

- **Cross-jurisdictional commons.** Public-domain dedication is recognized
  in some jurisdictions and not others. The Unlicense plus the
  cornerstone provide the strongest available commitment in
  copyright-recognizing jurisdictions; in jurisdictions where moral rights
  cannot be waived, the commitment is weaker than its English text
  suggests. This is a legal-framework problem the substrate inherits, not
  one it solves.

---

## Decision log

These DEC-IDs are owned by this document. Each is a load-bearing choice;
new choices that supersede them require a new DEC-ID and a forward
reference, not silent edits.

| DEC-ID | Decision |
|---|---|
| DEC-FED-001 | Substrate (v-axis), trust/scale (F-axis), and verification (L-axis) are orthogonal. A user sits at any `(v, F, L)` coordinate. Federation features are imported, not inherited; the F0 single-machine deployment is first-class at every substrate level. |
| DEC-FED-002 | Package decomposition. `@yakcc/core` ships the full substrate (v0..v2). `@yakcc/federation` is the F1+ optional sidecar (attestation lookup, content mirroring, attestation publishing, ZK supply-chain proofs). `@yakcc/incentives` is the F4-only chain-bound sidecar. Dependencies flow `incentives → federation → core`; never the reverse. |
| DEC-FED-003 | DA layer for F3+ is selected empirically. IPFS pinning is the cheap default; cryptoeconomic DA (Celestia, EigenDA) is the upgrade path if pinning proves insufficient. The architecture supports both; specific selection deferred to F4 implementation. |
| DEC-FED-004 | Slashing is deprecation of the failing block at the registry level, not seizure of submitter assets. The cornerstone forbids submitter identity; there is no asset to seize. A block losing selection because PoF found a counterexample is the economic consequence; the public-domain commitment is preserved. |
| DEC-FED-005 | F4 economic primitives: Proof of Fuzz (rewards finding contract deviations; deprecates failing blocks), Bounties (reward synthesizers of unmatched proposals; batch-resolution windows mitigate front-running), Stake-to-Refine (refinement claims require stake; benchmarker-verified; failed/backdoored claims burn stake). The canonicalization engine collapses duplicates before resolution. L3 attestations earn ~10x L2 to populate the proof tier; TCB unsoundness bounties earn ~10x completeness bounties. |
| DEC-FED-006 | Trust list governance is per-caller (sovereign local policy). The shipped default is itself governance and is deferred as a user-decision boundary, not chosen unilaterally by this document. F0/F1/F2 ship without a default; F3/F4 require the governance question to be answered by whoever deploys the public network. |
| DEC-FED-007 | The canonicalization engine is constitutional (lives in `@yakcc/contracts`), not F4-owned. It runs on every yakcc deployment from F0 outward; F4 amplifies its reach (across bounty batch windows) but does not own it. Earlier drafts framed it as F4 anti-spam; that framing is superseded. F4 economic flows (Stake-to-Refine, Bounties, batch-resolution windows) consult the constitutional canonicalizer; they do not maintain a parallel one (Sacred Practice #12). The user's "optional layer" framing requires this — private use must remain first-class, including its access to the universalizer pipeline. Source: `suggestions.txt` ask #1, surfaced into the constitutional layer per `VERIFICATION.md` DEC-VERIFY-009. |
