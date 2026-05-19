# VERIFICATION.md — Yakcc

> The verification spine. This document is orthogonal to the substrate ladder
> in `MASTER_PLAN.md` (v0..v2) and to the trust/scale axis in `FEDERATION.md`
> (F0..F4). Substrate maturity says how much yakcc can do; verification says
> how much we believe it does it correctly. A user sits at any (v, F, L)
> coordinate.

---

## Thesis

Yakcc's pitch is supply-chain minimality: every line of an assembled program
points to a verified, reused basic block with a known test history and minimum
necessary surface. That pitch is hollow if "verified" means only "passes a
property-test suite the contributor wrote." Property tests are a floor, not a
ceiling. They establish that no counterexample was found in N samples; they do
not establish that no counterexample exists.

For the seed corpus this floor is acceptable. For a registry that wants to
absorb the working ecosystem at sub-function granularity (v0.7) and eventually
host its own implementation (v2), it is not. Two failure modes appear at
scale:

1. **Behavioral collisions.** Two implementations claim to satisfy the same
   contract; a property-test corpus written by the contributor of either fails
   to distinguish them on inputs the corpus did not anticipate. Selection
   binds to the wrong block; downstream consumers inherit the error.
2. **Adversarial contributions.** A block passes its property-test corpus and
   contains a backdoor — a code path triggered only by inputs the corpus does
   not generate. The cornerstone forbids author identity as the trust
   mechanism; without identity, the only path to confidence is mechanical
   verification of the block itself.

The verification ladder addresses both. It is a strict partial order over
verification regimes, declared in spec metadata, and **mechanically checkable**
by the registry — the same way the strict-TS subset is mechanically checkable
by the IR validator. A block claims a level; the registry confirms the claim
or rejects the block.

The ladder is **opt-in per block**. A user running yakcc privately, single-
machine, with the seed corpus at L0, never has to opt in to anything beyond
property tests. The ladder is the substrate's answer when the substrate is
asked to scale; it is not a tax on private use.

---

## The verification ladder (L0..L3)

| Level | Constraint | Verification check at registration | Cost |
|---|---|---|---|
| L0 | Strict-TS subset (the v0 IR) | `ts-morph` + ESLint subset validator; property-test suite (`fast-check`) passes | low |
| L1 | + Total functional (no unbounded recursion or loops; structural recursion or explicit fuel) | L0 checks + static totality check (extended `ts-morph` pass) | low–medium |
| L2 | + SMT-decidable theory declared in spec | L1 checks + Z3 / BMC equivalence proof against contract; or actor-critic fuzzing fallback when proof synthesis cannot reach | medium |
| L3 | + Paired Lean (or Coq / Agda) proof of contract refinement | L2 checks + machine-checked refinement proof against the contract spec | high |

Each level strictly refines the level beneath it. L3 of contract C refines L2
of C; L2 refines L1; L1 refines L0. The strictness partial order described in
the cornerstone (`MASTER_PLAN.md` cornerstone #1) becomes formalized at the
verification axis: a stricter level is a stricter contract about the same
behavior.

A block declares a target level in `spec.yak` metadata (see "Block as
cryptographic triplet" below). The registry runs the level's check at
registration time. A block that declares L2 but only passes L1 is rejected,
not silently downgraded. The ladder is declarative on the contributor side and
enforced on the registry side.

### What each level guarantees

- **L0** — The block is in the strict-TS subset and has no counterexamples in
  N property-test samples. This is the v0 floor. It catches obvious bugs and
  ensures the block is composable in the IR. It does not establish absence of
  bugs.
- **L1** — The block is total: every input produces a value in bounded steps.
  Non-termination is a category of bug the substrate cannot tolerate at scale
  — a registry that hosts non-terminating blocks lets a single corrupted entry
  hang every consumer that selects it. L1 makes termination a registration
  requirement.
- **L2** — The block's behavior matches the contract spec on every input the
  declared SMT theory can express. For first-order theories over bounded
  integers, fixed-width bitvectors, finite arrays, and string equality, this
  is decidable in practice (Z3 in seconds for blocks at the seed-corpus scale).
  For theories the solver cannot reach in budget, an actor-critic fuzzing
  fallback attempts to find a counterexample; absence-of-counterexample after
  budgeted search is recorded as a non-functional property, not as
  certainty.
- **L3** — A machine-checked Lean (or Coq / Agda) proof shows the
  implementation refines the contract. Refinement here is the formal
  proof-engineering meaning: every behavior of the implementation is permitted
  by the contract. The proof checker is the trust kernel; once a proof checks,
  the result holds without further appeal to property tests, fuzzing, or
  benchmarks.

### What each level requires from the contributor

- **L0** — the block source plus a property-test corpus. The v0 path. No
  declarations beyond the existing `ContractSpec`.
- **L1** — same as L0, plus structural recursion or an explicit fuel
  parameter where recursion or iteration appears. The totality checker is
  syntactic on the recursion site, not semantic; the cost to authors is
  refactoring `while (true)` into bounded iteration, not writing termination
  proofs.
- **L2** — same as L1, plus a declaration in `spec.yak` of the SMT theory the
  contract lives in (e.g., `theory: ["bv64", "arrays", "strings"]`), plus the
  contract's preconditions, postconditions, and invariants in a form the
  encoder can lift. The encoder is part of the registry's verifier; the
  contributor does not write SMT.
- **L3** — same as L2, plus a Lean (or Coq / Agda) proof bundled in the
  `proof/` directory. The contributor is doing real proof engineering. The
  registry's job is to run the proof checker against the bundled artifact;
  it is not to invent the proof.

### A worked example: `digit-recognizer` at each level

The hand-authored `digit` atom in `packages/seeds/src/blocks/` is one
predicate: *given a character, return true iff the character is an ASCII digit
0-9.* It appears at every level of the ladder.

- **At L0:** a strict-TS function plus `fast-check` properties: "round-trips
  through `String.fromCharCode` for all 0-127 inputs," "rejects every
  non-ASCII character in a 10k-sample," "agrees with `/^[0-9]$/.test(c)` on a
  Unicode-class sample of 100k." The block is content-addressed; the property
  tests are the only verification artifact.
- **At L1:** the block is statically total — it has one branch, no loops, no
  recursion, returns in O(1) on every input. Totality is verified by the
  syntactic check; nothing extra is required from the contributor.
- **At L2:** the contract declares `theory: ["bv8", "char-equality"]`,
  preconditions `input is a single char in 0..255`, postconditions `output is
  true iff input ∈ {48, 49, 50, 51, 52, 53, 54, 55, 56, 57}`. The encoder
  lifts the implementation into Z3; the solver reports `unsat` on the
  refinement query (`exists input. impl(input) ≠ spec(input)`); the L2
  attestation is registered.
- **At L3:** a Lean proof shows `forall (c : Char), digit c = (c.val ≥ 48 ∧
  c.val ≤ 57)`. The proof checks against the bundled spec lemma. The L3
  attestation is registered.

A consumer at F0 with no federation can select on level: "give me the highest
level available for contract C." A registry that only holds L0 blocks behaves
exactly as v0 does. A registry that holds L3 blocks for a contract gives the
caller machine-checked confidence at the cost of the proof-engineering work
the contributor did.

### Who pays for which level

L0 is paid for by every contributor at registration. L1 is paid for by the
contributor in refactoring cost when iteration appears. L2 is paid for by the
contributor in declaring theory and contract assertions; the solver work is
paid for by the registry at registration time (and is bounded — the encoder
gives up after a budget). L3 is paid for by the contributor in proof-
engineering hours, which are real and significant.

The trust/scale axis (`FEDERATION.md`) introduces an economic premium for L3
attestations under F4 — see the "L3 economic premium" section there. Without
that asymmetry, fuzzing dominates and the L3 tier never populates. Private
single-machine yakcc users (F0) carry no such pressure: they pay for L3 only
on blocks where they personally need the guarantee.

@decision: DEC-VERIFY-001 — Verification levels L0..L3 declared in spec, enforced
by registry. The level hierarchy is a strict partial order; a higher level
strictly refines a lower one. Levels are opt-in per block; L0 is the v0
floor and remains the default.

---

## Block as cryptographic triplet

v0 modeled identity as `ContractId = hash(canonical-spec)` with multiple
implementations as siblings under one ID. That model collapses two distinct
notions — *what is being computed* (the spec) and *what artifact is being
distributed* (the spec plus impl plus verification evidence) — into the
contract id. As soon as verification artifacts become first-class, that
collapse is wrong.

The verification ladder requires a three-part identity:

```
Block = (spec.yak, impl.ts, proof/)
BlockMerkleRoot = MerkleRoot(spec.yak, impl.ts, proof/)
```

The block's identity is the Merkle root of the triplet. The spec hash
(`hash(canonical(spec.yak))`) becomes an **index** over blocks:
`spec_hash → [BlockMerkleRoot, ...]`, returning every block whose `spec.yak`
canonicalizes to the same content-address. This preserves v0's selection
semantics — "find me the implementations of this contract" — while letting
each implementation carry its own verification evidence under its own
identity.

### `spec.yak`

JSON-shaped, LLM-friendly, AI-native authoring. The format is a deliberate
move away from embedding contracts as TypeScript literals (the v0 transitional
shape) — embedded literals are easy for humans to author but resist
mechanical extraction, lifting into solver theories, and proof-checking. JSON
is mechanically tractable.

Required fields:

- `name` — human-readable identifier (informational; identity is the hash).
- `inputs` — typed input schema in the strict-TS-subset type language.
- `outputs` — typed output schema.
- `preconditions` — assertions on inputs that the implementation may assume.
- `postconditions` — assertions on outputs the implementation must guarantee.
- `invariants` — properties preserved across the operation (for stateful
  contracts; pure-by-default blocks have none).
- `effects` — declared object-capability requirements (see "Object-capability
  discipline" below). Pure blocks declare `effects: []`.
- `level` — declared verification level (`L0` | `L1` | `L2` | `L3`).

Optional, level-dependent fields:

- `theory` — required at L2. Array of declared SMT theory tags (e.g.,
  `["bv64", "arrays", "strings"]`). The encoder uses this to choose its
  lifting strategy; an undeclared theory at L2 is a registration error.
- `bounds` — explicit fuzz/BMC budgets exposed to consumers (e.g., `bmc_depth:
  16`, `fuzz_samples: 100000`, `solver_budget_ms: 5000`). When a contract
  cannot prove unconditionally and falls back to bounded model checking,
  consumers see exactly what bound was used.
- `totality_witness` — required at L1+ when the totality checker cannot
  conclude purely syntactically. Either a structural-recursion declaration
  (`structural_on: <argument-name>`) or an explicit fuel parameter
  (`fuel: <argument-name>, max: <bound>`).
- `proof_kind` — required at L3. Identifies which checker artifact in
  `proof/` is the canonical refinement proof.
- `constant_time` — boolean, default false. A non-functional contract
  property indicating the implementation must run in time independent of its
  input. Declared separately from the level because constant-time is a
  side-channel property, not a behavioral one (see TCB hardening below).

### `impl.ts`

The strict-TS subset already validated by `@yakcc/ir` in v0. At L1+, the
totality check extends the validator. At L2+, `impl.ts` must be liftable
into the declared theory — practically, no opaque library calls, no
floating-point in the L2 regime (see "SMT and BMC" below), no constructs the
encoder cannot translate. The constraints tighten as the level rises; v0
blocks at L0 require no extra discipline.

### `proof/`

A *directory* with a manifest, not a single file `proof.zk`. (The name
`proof.zk` primes toward zk-SNARKs and is wrong here — most proofs are not
zero-knowledge proofs.) The manifest is a tagged-union declaration of which
verification artifacts are present and which checker each invokes:

```json
{
  "artifacts": [
    {"kind": "property_tests", "path": "tests.fast-check.ts"},
    {"kind": "smt_cert", "path": "refinement.smt2", "theory": ["bv8"]},
    {"kind": "lean_proof", "path": "refinement.lean", "checker": "lean4@4.7.0"}
  ]
}
```

Each artifact kind has a registered checker in the registry's verifier set
(see "Verifier-as-block" below). The manifest is what tells the verifier
which checker to invoke for which artifact; the manifest itself is part of
the Merkle root, so attestations cover not just the proof bytes but the
declaration of *what kind of proof* it is.

### MerkleRoot derivation

Concretely:

```
spec_hash      = hash(canonicalize(spec.yak))
impl_hash      = hash(canonicalize(impl.ts))
proof_root     = MerkleRoot(manifest.json, ...artifacts in stable order)
BlockMerkleRoot = MerkleRoot(spec_hash, impl_hash, proof_root)
```

Canonicalization rules for `spec.yak` are the existing JSON-canonicalization
path used in v0 for `ContractSpec`. Canonicalization for `impl.ts` is the
ts-morph deterministic-print pass. The `proof/` directory's Merkle root
covers the manifest plus every named artifact in the order the manifest
declares.

### Identity semantics

- A block's identity is `BlockMerkleRoot`. References between blocks (a
  composition pointing at a sub-block) carry `BlockMerkleRoot`, not
  `spec_hash`.
- A spec's identity is `spec_hash`. The spec hash is the index used by the
  selector to find candidate implementations. Two blocks with the same
  `spec_hash` are alternative implementations of the same contract; their
  `BlockMerkleRoot`s differ.
- Attestations (see below) are issued against `BlockMerkleRoot`. An
  attestation on the spec alone is meaningless — the spec without an
  implementation is not something a verifier can certify behaviorally.

### Migration from v0

v0's seed corpus uses `ContractId = hash(canonical-spec)` with embedded
`CONTRACT` literals in TypeScript. The migration is mechanical and
non-destructive:

1. **Lift embedded contracts.** A one-shot extraction tool walks each seed
   block, parses the `CONTRACT` literal via `ts-morph`, and emits a
   `spec.yak` JSON file alongside the existing `.ts`. The original `.ts`
   keeps the literal as a v0 transitional shape; the lifted `spec.yak` is
   what the v1+ registry indexes by.
2. **Wrap each seed in a triplet.** Each existing seed block becomes
   `(spec.yak, impl.ts, proof/manifest.json)` where `proof/manifest.json`
   declares only the existing property-test artifact. All ~20 seeds become
   L0 by construction.
3. **Backfill `proof/` incrementally.** As contributors add SMT certs or
   Lean proofs to seeds, they extend the manifest and the seed's level
   declaration follows. The seed's `BlockMerkleRoot` changes when the
   triplet changes; the seed's `spec_hash` does not. The selector continues
   to find the seed under its spec hash; consumers can opt in to a higher
   level when one becomes available.
4. **Retire `ContractId = hash(spec)`.** Once every seed has a `spec.yak`
   file, the registry switches from indexing by `ContractId` to indexing by
   `(spec_hash → BlockMerkleRoot)`. The old column name remains valid as a
   read-only alias for one release cycle, then is removed. Single-source-
   of-truth: the spec hash and the block Merkle root are not allowed to
   coexist as parallel identities for the same purpose.

@decision: DEC-VERIFY-002 — Block identity is the Merkle root of the triplet
(`spec.yak`, `impl.ts`, `proof/`). Spec hash is an index over blocks, not the
block identity. v0's `ContractId = hash(spec)` model is migrated, not
preserved as a parallel authority.

@decision: DEC-VERIFY-003 — `spec.yak` is JSON-shaped (LLM-friendly), with
required fields for theorem statement (preconditions, postconditions,
invariants), capability requirements (object-capability effect signature),
totality witnesses, declared verification level, and declared SMT theory at
L2. Embedded TypeScript `CONTRACT` literals are a v0 transitional shape
only; v1+ moves to `spec.yak`.

---

## Semantic AST canonicalization (the universalizer pre-filter)

> Source artifact: `suggestions.txt`, ask #1 ("Semantic AST Canonicalization
> (The Pre-Filter)"). The user framed canonicalization as a *constitutional*
> property of the substrate, not as an F4 economic anti-spam guard. This
> section encodes that framing in the verification spine and supersedes the
> earlier framing in `FEDERATION.md` §"Canonicalization engine" (now
> reduced-to-amplifier, see `FEDERATION.md` DEC-FED-007).

Before a block enters the registry — before its triplet's `BlockMerkleRoot`
is computed for storage and before any L0..L3 check runs — the
`@yakcc/contracts` canonicalizer derives a **canonical-AST hash** from
`impl.ts` and stores it as a registry-level structural-equivalence key. Two
blocks whose `impl.ts` differs only in variable names, argument order on
commutative operators, comment density, or pure-function nesting structure
will produce different `impl_hash` values (and therefore different
`BlockMerkleRoot`s — those triplets are not byte-equal and cannot share a
cache line) but **will produce the same `canonical_ast_hash`**, and the
registry flags them as semantic equivalents.

This is a constitutional property. Every yakcc deployment runs the
canonicalizer — F0 single-machine, F1 read-only-mirror, all the way through
F4. A yakcc-private installation gets duplicate detection, structural
equivalence indexing, and the universalizer's spam resistance for free; the
federation does not own the pass.

### Scope of canonicalization

Canonicalization runs over `impl.ts` only. The spec (`spec.yak`) is already
canonical-JSON-hashed via `SpecHash`, and the proof bundle (`proof/`) is
artifact-Merkleized by manifest order. The structural-equivalence question
the universalizer answers is "are these two implementations the same
algorithm written differently"; the spec hash already answers "are these two
contracts the same contract."

A block's full identity tuple in the registry therefore becomes:

```
spec_hash         = blake3(canonicalize(spec.yak))
canonical_ast_hash = blake3(canonicalize_ast(impl.ts))
impl_hash         = blake3(impl.ts file bytes)        // L0; ts-morph-print at L1+
proof_root        = MerkleRoot(manifest.json, ...)
block_merkle_root = blake3(spec_hash || impl_hash || proof_root)
```

`canonical_ast_hash` is a fourth column on the `blocks` table, indexed for
duplicate-equivalence lookup. It is **not** part of `BlockMerkleRoot`
derivation (the Merkle root remains exactly what `VERIFICATION.md`
DEC-VERIFY-002 specifies — variable renaming produces a new
`BlockMerkleRoot` because the bytes change). It is a sidecar index over
blocks, parallel to `spec_hash`, that the registry consults at submission
time.

### Normalization rules

The canonicalizer operates as a deterministic pass over the `ts-morph` AST
of `impl.ts` after the strict-TS-subset validator has accepted the block. At
L0 the rules are:

1. **De Bruijn renaming.** Every locally-bound identifier (function
   parameters, `const`/`let` introductions, destructured names, type
   parameters) is replaced by an index counted from its enclosing binder.
   Free identifiers (calls into other registry blocks, capability tokens
   passed in via the spec's effect list) keep their content-addressed names
   so cross-block references survive canonicalization.
2. **Commutative-operator normalization.** For every pure commutative
   operator over total-ordered operand classes — `+`, `*`, `&`, `|`, `^`,
   `&&`, `||`, `===`, `!==`, `==`, `!=` — the operands are sorted by their
   own canonicalized hash. `b + a` and `a + b` both serialize to the same
   ordered-operand form. Non-commutative operators (`-`, `/`, `%`, `<<`,
   string `+` over string operands) are left in source order.
3. **Pure-function flattening.** A pure single-call expression nested in a
   block whose only purpose is to forward arguments (`const x = f(a, b);
   return g(x);` where `x` has one use) is collapsed to `return g(f(a,
   b));`. Aliasing through unused intermediates does not produce a distinct
   canonical form.
4. **Bounded-recursion structural representation.** A `for (let i = 0; i <
   n; i++) body` and a structural recursion `loop(0, n, body)` over the same
   `body` against the same bound `n` produce the same canonical-AST
   fragment. The canonicalizer collapses the two iteration shapes into a
   shared "bounded-iteration-with-fuel" node when the totality witness or
   the loop's syntactic structure proves the fuel bound.
5. **Comment and whitespace stripping.** Comments do not enter the canonical
   form. Whitespace is normalized by `ts-morph`'s deterministic-print pass
   before AST canonicalization.

The hash function is **BLAKE3** (DEC-HASH-WI002) over the deterministic
serialization of the canonical AST. The serialization format is a recorded
`@decision` annotation on the canonicalization implementation file so
superseding it requires an explicit DEC entry (Sacred Practice #12).

### Submission-time semantics

When a contributor proposes a block:

1. The strict-TS-subset validator (`@yakcc/ir`) accepts or rejects `impl.ts`
   per its existing rules.
2. The canonicalizer derives `canonical_ast_hash` from the accepted AST.
3. The registry queries: does any existing block share this
   `canonical_ast_hash`?
   - If yes, the submission is **rejected as a structural duplicate**, with
     the existing block's `BlockMerkleRoot` returned as the canonical
     pointer the contributor should reference instead. No `BlockMerkleRoot`
     is registered for the duplicate; no L0..L3 verification work is run; no
     bounty is paid (at F4); no spam attestation is produced.
   - If no, registration continues: `block_merkle_root` is computed,
     `spec_hash`, `canonical_ast_hash`, `block_merkle_root`, and the triplet
     contents are written to the `blocks` table, and the L-axis check
     declared in `spec.yak` runs.
4. The selector exposes `canonical_ast_hash` to consumers as a non-functional
   "structural family" marker. Two blocks with the same `canonical_ast_hash`
   but different `spec_hash` are interesting (the same algorithm reused for
   different contracts); two blocks with the same `spec_hash` but different
   `canonical_ast_hash` are alternative implementations that the L-axis
   distinguishes.

### Interaction with strictness ordering

Open question: when a contributor submits a block whose `canonical_ast_hash`
collides with an existing block, but the new submission declares a stricter
`level` than the existing one (e.g., the existing block is at L0 with only
property tests; the new one carries the same canonicalized impl at L2 with
an SMT cert in `proof/`), which wins selection?

The cornerstone-honoring answer: **the existing block is the structural
truth; its `BlockMerkleRoot` does not change**. The new submission contributes
its `proof/` artifacts to the existing block by re-attestation under the new
verifier (`VERIFICATION.md` §"Verifier-as-block"), not by registering a
parallel block. The cornerstone forbids parallel-but-equivalent blocks — two
identical algorithms with two `BlockMerkleRoot`s differing only in proof
artifacts is the dual-authority bug Sacred Practice #12 forbids. The
canonicalizer enforces this at submission time by rejecting the second
registration and routing the contributor toward attesting the existing
block.

This rule is **load-bearing for the L-axis** because it makes
attestation-monotonicity tractable: an existing block accumulates
attestations as new verifiers reach it; it does not re-derive its identity
when its proof bundle grows. A contributor who genuinely wants a different
algorithm shape for the same contract writes a different algorithm — the
canonicalizer's De-Bruijn / commutative / flattening rules deliberately do
not unify algorithmically distinct implementations.

@decision: DEC-VERIFY-009 — Semantic AST canonicalization is a
constitutional pre-ledger pass in `@yakcc/contracts`. Every yakcc
deployment (F0..F4) runs it. The canonicalizer derives a
`canonical_ast_hash` (BLAKE3 over a De-Bruijn-renamed,
commutative-normalized, pure-function-flattened AST) on `impl.ts` only
(`spec.yak` and `proof/` are content-addressed by their own existing
hashes). The hash is sidecar to `BlockMerkleRoot` — it does not change the
Merkle root, but it gates submission: a structural duplicate is rejected at
ingest with the existing block's `BlockMerkleRoot` returned. When a
contributor wants a stricter L-axis level on an existing canonical-AST,
they re-attest the existing block, they do not register a parallel one
(Sacred Practice #12). Source: `suggestions.txt` ask #1.

---

## Object-capability discipline

The v0 IR validator already bans the most flagrant escape hatches (`any`,
`eval`, runtime reflection). The verification spine extends the ban list to
make blocks **pure by default** and lift effects to capability tokens that
are **explicitly passed**, never globally available.

This is the difference between "this block calls `fs.writeFile`, hopefully it
behaves" and "this block takes a `WriteOnly{path: '/tmp/x'}` capability and
the type system enforces that no other write is reachable." The former is a
v0 hazard; the latter is a verification-friendly contract.

### Pure-by-default rule

A block is pure unless its `spec.yak` declares effects. A pure block:

- has no `import` of an effectful module (no `fs`, no `process`, no `fetch`,
  no `node:*`, no browser globals).
- has no access to global ambient state (no `globalThis`, no
  `process.env`, no `Date.now`, no `Math.random`, no `performance.now`).
- has no closures over module-level mutable state.
- returns the same output for the same inputs.

The IR validator enforces these statically. A pure-declared block that
imports `fs` is a registration error.

### Static banishment list

Concretely banished from the strict-TS subset (extends the v0 list):

- `import "fs" / "fs/promises" / "node:fs"`
- `import "process" / "node:process"`, `process.env`, `process.cwd()`
- `import "fetch"` and direct use of the `fetch` global
- `import "child_process"`, `import "worker_threads"`
- `import "crypto"` for randomness sources (specific deterministic primitives
  may be re-imported under a capability boundary, see "delegation" below)
- `Math.random()`, `Date.now()`, `Date()`, `performance.now()`
- `crypto.randomBytes(...)`, `crypto.getRandomValues(...)` outside a passed
  capability
- `eval`, `new Function(...)`, `Function.prototype.constructor`
- Dynamic property access on a capability token (e.g., `cap[userInput]`)
- The `with` statement
- Top-level mutable bindings (`let` at module scope) that are not declared
  `as const`

### Capability tokens

When a block needs an effect, the effect enters as an argument:

```typescript
// pure (effects: [])
export function digit(c: number): boolean { /* ... */ }

// effectful (effects: ["WriteOnly:/tmp/spans"])
export function writeSpan(
  cap: WriteOnly<"/tmp/spans">,
  span: Span,
): void { /* uses cap.write(...) */ }
```

The capability token is a branded type whose constructor lives outside the
block. The registry's verifier checks that the block's source uses the
capability only via the methods declared on its branded interface — no
reflection on the token, no widening to `any`, no passing the token to
modules that did not declare a use for it.

### Capability attenuation

Attenuation is first-class. A capability is `WriteOnly<"/tmp/x">`, not blanket
`Filesystem`. A block that needs to append to a single file declares it
needs `Append<"/var/log/yakcc.log">`, and the caller passing the cap can
prove the cap was constructed with exactly that target. The contract spec
declares the attenuated capability shape; matching at selection time honors
the attenuation.

Attenuation primitives (in the strict-TS-subset capability vocabulary):

- `ReadOnly<P>` — read access to a single path or path prefix `P`.
- `WriteOnly<P>` — write access (creates and overwrites) to `P`.
- `Append<P>` — append-only access; cannot truncate or overwrite.
- `Listen<H, P>` — accept connections on host `H`, port `P`.
- `Connect<H, P>` — open connections to host `H`, port `P`.
- `Clock<Resolution>` — read clock at declared resolution (the only sanctioned
  way to read time inside a block).
- `Random<Source>` — read randomness from a declared source (CSPRNG vs. fast).

The list is extensible; the rule is that every effect is declared at a
specific attenuation, not a category. `Filesystem` as a blanket cap does not
exist in this vocabulary.

### Capability delegation discipline

A capability passed into a block is tagged `consumed` (used internally by the
block, never escapes) or `delegated` (passed to a named callee declared in
the block's spec). The IR validator checks the chain: a `consumed` cap that
appears as an argument to another block is a registration error; a
`delegated` cap that is passed to a callee not in the spec's effect list is
a registration error.

This makes effect propagation **statically auditable**. A consumer of a
block that declares `effects: ["consumed: WriteOnly:/tmp/x"]` knows the cap
goes nowhere downstream. A consumer of a block declaring
`effects: ["delegated: WriteOnly:/tmp/x → @yakcc/sub-block-merkle-root-X"]`
can follow the chain and confirm the downstream block also declared a
matching `effects` entry.

### Constant-time tag

`constant_time: true` in `spec.yak` is a non-functional contract property
for cryptographically-sensitive blocks (compare-MACs, secret-equality
checks, point-multiplication). It is *separate* from the verification level:
constant-time is a side-channel property, not a behavioral one. A block can
be L3-verified for behavior and not constant-time, or constant-time and only
L0-verified.

The constant-time check is a static analysis on `impl.ts` that bans
data-dependent branching, data-dependent indexing, and data-dependent loop
counts on inputs marked secret. It is conservative — it rejects code it
cannot prove constant-time, including code that may be constant-time on a
specific microarchitecture but not in the abstract model. False rejections
are an accepted cost.

Covert-channel resistance below the source-language level (cache timing,
branch predictor, speculative execution) is **explicitly out of scope** of
the static check. See "Hard problems" for the residual.

### Runtime hardening

Static checks are necessary; they are not sufficient. The runtime invoking
blocks must enforce the capability-token invariants:

- frozen prototypes on every shared object (no `Object.assign(prototype,
  ...)` from inside a block).
- no dynamic property names on capability tokens (the static check catches
  this at registration; the runtime catches it at call time as defense in
  depth).
- no `Function` constructor available in the block's realm.
- structured-clone arguments at the boundary so a block cannot mutate a
  caller's object via a shared reference.
- per-call capability binding so a cap passed in one call is not
  reachable from a different call (no module-level capture).

Runtime hardening lives in the v0.5+ live-execution path; v0's
property-test runner inherits the static checks and runs blocks in a
process boundary that already prevents most cross-block leakage.

@decision: DEC-VERIFY-004 — Object-capability discipline: pure-by-default blocks,
effects only via explicitly-passed capability tokens, attenuation as
first-class (a cap is `WriteOnly<P>`, not blanket `Filesystem`), and
delegation tagging (`consumed` vs `delegated`) so effect propagation is
statically auditable. `constant_time` is a separate non-functional contract
property for crypto-sensitive blocks.

---

## Total functional programming

L1 makes totality a registration requirement. A total block always returns a
value in bounded steps; partial blocks (those that may not terminate) are
rejected at L1+.

### What "total" means in the IR

For the strict-TS subset the substrate accepts:

- recursion is structural: every recursive call is on a syntactic
  sub-component of the recursive argument (e.g., `tail(list)` after pattern-
  matching `list` as `head :: tail`).
- iteration is bounded: every `for` / `while` declares an explicit fuel
  parameter or iterates a finite collection of statically-known size.
- mutual recursion is allowed if the call graph is structurally decreasing on
  a shared measure declared in the spec.

`while (true)` with internal `break` on a runtime condition is not bounded
under this regime. The contributor refactors to `for (let i = 0; i < fuel;
i++) { ... if (done) return ...; }` and declares `fuel` as the bound. Some
genuinely-unbounded code does not fit this discipline; those blocks remain at
L0 and consumers who require L1+ skip them at selection time.

### How the totality check extends the existing validator

The v0 `@yakcc/ir` validator already runs over the AST via `ts-morph`. The
L1 totality check is a new pass over the same AST that:

1. identifies every recursion site and verifies structural decrease on the
   declared `structural_on` argument.
2. identifies every iteration site and verifies a finite bound (a literal,
   the `length` of an input, or a declared `fuel` parameter).
3. rejects mutual recursion without a declared shared measure.
4. rejects any indirect call (function values passed in, higher-order
   combinators) where the callee is not statically known and itself L1+.

The pass is conservative. It rejects code that could be total but that the
checker cannot prove total. False rejections are paid in author effort
(refactor to fit the discipline) or in level downgrade (stay at L0).

### Halting-problem framing

L1 does not solve the halting problem. It restricts the IR to a fragment in
which termination is decidable by syntactic check. Code outside that fragment
is not "non-terminating"; it is "terminates by an argument the syntactic
checker cannot make." Such code lives at L0 and is selected by consumers who
do not need the L1 guarantee.

The discipline is a load-bearing ergonomic cost. Authors of blocks that
naturally express as unbounded iteration (streams, generators with external
termination) eat the refactor or stay at L0. We accept the cost because the
alternative — a registry where any block can hang any consumer that selects
it — is worse.

---

## SMT and BMC

L2 is the level where **the substrate becomes interesting**. The contract
spec declares the SMT theory the contract lives in; the registry's encoder
lifts both the spec and the implementation into the solver; the solver
either proves refinement or returns a counterexample.

### Theory declarations

`theory` in `spec.yak` is an array of tags identifying the fragments the
contract uses. Standard tags for v1:

- `bv<N>` — fixed-width bitvectors at width N (e.g., `bv8`, `bv32`, `bv64`).
- `arrays` — uninterpreted arrays.
- `strings` — bounded-length strings with character equality.
- `bool` — propositional logic over the above.

Reserved-but-deferred tags (not supported in v1, declared for future
expansion):

- `floats` — IEEE 754 arithmetic. Deferred because float SMT is fragile and
  the v0 seed corpus does not need it. Blocks using floats stay at L0/L1.
- `nat` / `int` — unbounded integers. Deferred because lifting unbounded
  integers requires non-linear theories that solvers handle inconsistently;
  fixed-width bitvectors cover the v1 use cases.

Declaring a theory the encoder does not support is a registration error.
Declaring a theory the solver cannot reach within budget triggers the BMC
fallback (see below).

### Z3 encoder layout

The encoder is a function `(spec.yak, impl.ts) → SMT2-script`. It walks the
implementation AST, lifts each construct into the declared theory, encodes
the contract's preconditions and postconditions, and emits the refinement
query:

```
forall (input : ContractInputType).
  precondition(input) →
    postcondition(impl(input))
```

The solver (Z3 by default; the encoder's output is portable to CVC5) returns
`unsat` (refinement holds) or a counterexample. `unsat` produces an L2
attestation; a counterexample is reported back to the contributor with the
input that breaks the contract.

### BMC and bounded budgets

When the encoder cannot lift a construct (e.g., an opaque library call) or
when the solver exceeds its budget, the registry falls back to **bounded
model checking**: unroll loops to a declared depth, check refinement on the
unrolled fragment, and record the bound as part of the attestation.

Budget declarations live in `spec.yak`'s `bounds`:

```json
{
  "bmc_depth": 16,
  "fuzz_samples": 100000,
  "solver_budget_ms": 5000
}
```

BMC produces a *bounded* attestation: "no counterexample exists at depth ≤
16, given fuzz coverage of 100k samples, in N ms of solver time." This is
visible to consumers — a block at L2/BMC is not the same as a block at
L2/proof-complete, and the selector exposes the distinction. A consumer
asking for "the strongest available level" prefers proof-complete over BMC;
a consumer with a known input range that BMC's bound covers may prefer the
faster registration path.

### Float semantics rejected at L2 in v0/v1

Float arithmetic at L2 requires either rejection at registration (L2 + float
= error) or a fragile float-SMT encoding that produces unhelpful
counterexamples. v0/v1 picks rejection: blocks using IEEE 754 floats stay at
L0/L1. The position is revisited in v2 if and when the seed corpus needs
float-heavy contracts.

@decision: DEC-VERIFY-005 — L2 verification uses Z3 as the default solver with
declared SMT theory in `spec.yak`. Bounds (BMC depth, fuzz samples, solver
budget) are visible contract metadata; bounded attestations and proof-
complete attestations are distinguishable at the selector. Float arithmetic
is rejected at L2 in v0/v1.

---

## Lean-paired proofs (L3)

L3 is `(impl.ts, spec_lemma.lean, refinement.lean)` plus a Lean checker. The
contributor writes the implementation in TypeScript, the spec lemma in Lean,
and the refinement proof in Lean. The registry's checker invokes the Lean
toolchain on the bundled artifacts and accepts or rejects.

### What the proof shows

The refinement proof demonstrates `forall input. impl(input) ∈
spec(input)` — every behavior the implementation can exhibit is permitted by
the contract. The proof is over a Lean-shaped model of the implementation,
not over the TypeScript source directly: a translation step
`translate(impl.ts) → impl.lean` produces a Lean term whose semantics match
the strict-TS-subset's operational semantics. The translator is part of the
TCB (see "TCB hardening").

### Compositional proof framework

A block's L3 proof can cite L3 proofs of its sub-blocks. If `parseIntList`
is L3-proved and uses `digit` and `bracket` as sub-blocks, the
`parseIntList` proof can rely on the lemmas the `digit` and `bracket` proofs
established. This is the standard proof-engineering compositionality
discipline; the registry's checker enforces that cited lemmas come from
content-addressed bundled `proof/` artifacts of the cited blocks.

### Effect system in the proof language

L3 proofs over effectful blocks (those declaring capabilities) require an
effect system in the proof language. Lean's monad/typeclass infrastructure
covers the common cases (`IO`, `State`, attenuated capabilities lifted as
typeclass-bounded operations). The translator embeds capability tokens as
typeclass parameters; the proof's hypotheses cover the capabilities the
contract declared.

### Erasure

Proof artifacts check at registration time and are erased at runtime — the
v0 compile path emits `impl.ts` plus the provenance manifest, not the Lean
proof. The proof's role is to gate registration; once a block is registered
with an L3 attestation, downstream consumers cite the attestation by Merkle
root and trust the registry's checker, not the proof bytes themselves.

This is what makes L3 economically tractable: the proof-engineering work is
paid once (at registration), and every downstream consumer benefits without
re-running the checker.

### What L3 does not give us

- **L3 does not prove the contract.** It proves the implementation refines
  the contract spec the contributor wrote. If the spec is wrong, the proof
  is irrelevant. Reviewers of L3 spec lemmas are part of the human-trust
  loop the substrate cannot mechanize.
- **L3 does not prove the runtime.** The Wasm runtime, the Lean checker,
  and the translator are all in the TCB. L3 is conditional on trust in the
  TCB.
- **L3 does not prove constant-time.** That is the `constant_time` flag
  separately, with its own static analysis.

@decision: DEC-VERIFY-006 — L3 verification pairs a TypeScript implementation
with a Lean (or Coq / Agda) refinement proof. The proof checks against a
Lean-shaped translation of the implementation; cited sub-block lemmas must
come from content-addressed `proof/` artifacts. Proofs are erased at runtime;
the registry stores the attestation by Merkle root.

### L3 attestation lifecycle and verifier-engine upgrade

@decision DEC-VERIFY-L3-LIFECYCLE-001

**Attestation versioning.** Every L3 attestation records the verifier engine
and version under which it was produced — e.g., `lean@4.7.1`, `coq@8.20`,
`agda@2.6.4`. This version tag is a first-class field of the attestation
tuple (extend the tuple in `FEDERATION.md` §"Attestation protocol") and is
covered by the attestation signature. An L3 attestation produced under
`lean@4.7.1` is a distinct object from one produced under `lean@4.8.0` even
if both cover the same `block_hash`; they cannot be conflated in the ledger.

**Upgrade migration.** When the network upgrades to a new verifier engine
version, prior L3 attestations are NOT automatically trusted under the new
engine. The migration path depends on deployment level:

- **At F4 (economic-commons deployments):** prior attestations migrate through
  the proof-converter shadow process described in `FEDERATION.md`
  §"F4 adversarial-dynamics design" (DEC-F4-THREAT-CONVERTER-SHADOW-001). A
  converter agent proposes new attestation hashes; a one-epoch shadow window
  samples 1% of conversions for independent re-verification; the converter
  goes official only after the shadow window passes with zero failures. A
  single shadow failure aborts the converter and slashes the proposer's
  governance bond. This process is enforced by `@yakcc/incentives`.

- **At F0/F1 (single-machine and read-only mirror deployments):** there is no
  automated converter. F0/F1 users who require re-validation under a new
  engine trigger it on demand by running the new verifier locally against the
  existing triplet. The old attestation (under the old engine version) remains
  in the registry and continues to satisfy callers whose trust list still
  accepts that engine version; callers who have updated their trust list to
  require the new engine version will see the block as un-attested under the
  new engine until local re-verification runs.

In both cases, the old attestation is never deleted from the ledger. It
persists as a historical record; callers decide whether to accept it based on
their per-caller trust list configuration.

**Spec equivalence and bounty payout.** L3 proofs demonstrate
`impl refines spec`. Under F4 bounty payout, the spec in that proof must be a
network-canonical spec — not an arbitrary submitter-authored spec — because
the bounty gate requires `bounty_eligible: true` on the canonical spec
registry (DEC-F4-THREAT-CANONICAL-SPEC-001, `FEDERATION.md`). Without F4, a
submitter's L3 proof against their own spec is still a valid verification
artifact: the triplet's `proof/` directory carries the proof, the registry
registers the L3 attestation for that `block_merkle_root`, and the attestation
is discoverable by callers who trust the verifier that checked it. It just
does not trigger bounty payout because the spec is not canonical. This is a
deliberate property: F4 economic participation is opt-in, and an F0/F1/F2/F3
user who writes a genuine L3 proof benefits from the attestation's
verification-level claim (higher selection priority for callers who sort on
level) without needing to engage the F4 bounty machinery at all.

---

## AI proof synthesis fallback

L3 is expensive. Most blocks the registry hosts will never reach it on
human-written proofs alone. The substrate's bet is that **AI proof synthesis
becomes good enough to populate the L3 tier at scale** during the
v0.7 → v1 → v2 horizon.

The fallback pattern is **actor-critic fuzzing** when proof synthesis cannot
reach:

- *actor* attempts to synthesize a Lean proof of refinement.
- *critic* runs aggressive fuzzing (millions of cases, mutation-driven,
  coverage-guided) against the implementation looking for counterexamples
  the actor's hypothesized invariants would forbid.
- if the critic finds a counterexample, the actor refines its invariant
  hypothesis and retries.
- if the critic exhausts its budget without a counterexample and the actor
  produces a proof that checks, the L3 attestation is registered.
- if the critic exhausts its budget without a counterexample and the actor
  fails to produce a checking proof, the result is an *L2/BMC attestation*
  with the fuzzing budget recorded — not an L3 attestation.

### Critic-quality benchmark

The critic's quality is the only thing standing between "AI synthesis works"
and "AI synthesis appears to work." We benchmark the critic on **injected
known bugs**: take a corpus of correctly-implemented blocks, mutate them
with documented bug patterns (off-by-one, sign-flip, branch-swap), and
require the critic to find each mutation within its budget. A critic that
misses bugs we can mechanically generate is not a critic we can trust on
bugs we cannot.

The critic-quality benchmark is itself a registry artifact: the benchmark
suite is a content-addressed block, its results against each critic version
are recorded, and the actor-critic loop only runs against critics whose
benchmark results meet a declared threshold.

### Cost asymmetry warning

L3 (proof) attestations are ~10x more expensive to produce than L2/BMC
attestations under the same actor-critic budget. Without an economic premium
that makes proof-writing 10x more rewarding than fuzzing, the pipeline
defaults to BMC and the L3 tier never populates. See `FEDERATION.md` "L3
economic premium" for the F4 mechanism that resolves this; private F0
deployments simply accept that L3 is sparse.

This is a research bet. It is in `MASTER_PLAN.md` "Riskiest Assumptions" as
a documented uncertainty, not as a settled outcome.

---

## Behavioral embeddings (deferred to L1+)

> Source artifact: `suggestions.txt`, ask #3 ("Behavioral Embeddings
> (Execution Traces)"). The user identified embedding-similarity drift —
> already a documented riskiest assumption — as a discovery-layer failure
> mode that propagates structurally to bounty farming under F4. This section
> records the eventual replacement of docstring-derived embeddings with
> execution-trace-derived embeddings. **The substrate cannot ship this in
> v0/v0.6/L0** because deriving a behavioral embedding requires sandboxed
> execution of arbitrary blocks against a fuzzed input matrix, which
> requires the object-capability discipline of L1+ (DEC-TRIPLET-L0-ONLY-019;
> see "Object-capability discipline" above). The section is here to lock the
> design direction so v0.7's `yakcc shave` work and v1's federation
> attestation surface know what discovery layer they are eventually
> replacing.

### The replacement

v0's `@yakcc/registry` derives candidate-retrieval vectors from the
`spec.yak` text via `transformers.js` (DEC-EMBED-010). At L1+ this provider
interface is augmented with a **behavioral provider** that derives the
vector from the block's execution behavior over a standardized fuzzed input
matrix instead of from natural-language text. Search-by-behavior replaces
search-by-description for blocks that have reached L1+; L0 blocks continue
to embed via the textual provider.

The two providers coexist in the registry per block. A block carries:

- `text_embedding` — derived by the existing `transformers.js`-class
  provider over `spec.yak`'s textual fields. Available at every level.
- `behavioral_embedding` — derived by sandboxed execution of `impl.ts`
  against the fuzzed input matrix. Available only for blocks at L1+ that
  passed sandbox execution; absent for L0 blocks.

The selector at L1+ prefers `behavioral_embedding` when both are available;
at L0 it falls back to `text_embedding`. Two implementations of the same
contract that satisfy `behavioral_embedding`-equivalence within a declared
tolerance are flagged as behaviorally equivalent regardless of textual
divergence — closing the embedding-similarity-drift class of failures
(`MASTER_PLAN.md` Riskiest Assumption #4 in part, and the bounty-farming
exploit suggestions.txt names: an attacker rewriting variable names and
comments cannot move a block in `behavioral_embedding` space).

### The fuzzed input matrix protocol

The matrix is a **content-addressed governance artifact**, not a private
property of any verifier. It enumerates input-class buckets relevant to the
substrate's seed shapes:

- bounded-integer fuzzers (signed/unsigned, common widths: 8, 16, 32, 64).
- bounded-string fuzzers (ASCII, Unicode, structured tokens, parser-edge
  inputs: empty string, single char, very long, mixed scripts).
- bounded-array/list fuzzers (empty, singleton, large, sorted/reverse,
  duplicates).
- structured-record fuzzers (JSON-shaped inputs at common depths).
- domain-specific fuzzers as the corpus grows (URL, email, semver, char
  predicates, etc.).

Each bucket is itself a content-addressed block in the registry — the
fuzzer is verifiable, reproducible, and rotatable under the
verifier-as-block discipline (DEC-VERIFY-008). The behavioral embedding is
the deterministic vector produced by hashing the input-output pairs the
implementation produced over the matrix, projected through a
behavior-aware encoder (a research artifact of its own — likely a
contrastive-loss model trained on registered (impl, behavior-vector) pairs;
the encoder is itself a content-addressed block on the trust list).

Curation of the matrix is the **discovery-layer governance artifact**. The
default matrix shipped with `@yakcc/registry` is governance in exactly the
sense the default trust list is governance (`FEDERATION.md` §"Governance"):
its choice determines what "behavioral equivalence" means substrate-wide.
The same per-caller-sovereign-trust-list pattern applies — a caller can run
their own fuzz matrix locally; the public default is what 99% of users will
accept and is therefore the canonical thing.

### Why this is L1+

Deriving a behavioral embedding requires:

1. running `impl.ts` against the fuzzed inputs without trusting the impl —
   the registry executes each candidate block in a sandbox.
2. proving that the block's effects during execution stay within its
   declared `effects` — a block that declares `effects: []` but writes to
   the filesystem during fuzzing is structurally adversarial and must be
   caught.
3. bounded execution per input — every fuzz input must terminate inside a
   declared budget, which only L1+ blocks satisfy (totality is L1's
   guarantee).

Each of these is an L1+ property:
- sandbox execution requires the expanded ocap banishment list
  (`VERIFICATION.md` §"Object-capability discipline" — `Math.random`,
  `Date.now`, ambient `globalThis`, etc.) so the sandbox can isolate the
  block's behavior from environmental nondeterminism.
- effect-conformance requires capability tokens being passed in explicitly
  rather than imported, so the sandbox can refuse to provide unauthorized
  caps.
- bounded execution requires totality, which is L1's registration
  requirement.

L0 blocks therefore continue to use textual embeddings (the v0
`transformers.js` path); the behavioral provider activates per block as
that block's level claim reaches L1+.

### Implications for the discovery layer

- **Selection is topology-based at L1+.** Two blocks with the same
  `canonical_ast_hash` collapse via DEC-VERIFY-009; two algorithmically
  distinct blocks with similar `behavioral_embedding`s but different
  `canonical_ast_hash`es are genuine alternative implementations and the
  L-axis distinguishes them by attestation depth, not by text-search
  proximity.
- **F4 bounty farming via cosmetic rewrites is structurally foreclosed.**
  Suggestions.txt's threat model — an LLM rewrites variable names and
  comments to bypass similarity matching — collapses against
  behavioral-embedding equivalence: rewritten variables produce the same
  behavioral vector. (DEC-VERIFY-009 already forecloses on the
  syntactic-rewrite axis at submission time; behavioral embeddings
  foreclose on the search-time axis.)
- **`MASTER_PLAN.md` Riskiest Assumption #4 ("transformers.js for local
  embeddings") narrows in scope.** The textual-embedding provider remains
  the L0 path; the L1+ path no longer leans on natural-language
  embedding fidelity for correctness — it leans on sandbox correctness
  and matrix-curation governance. Different research bet.

@decision: DEC-VERIFY-010 — Behavioral embeddings replace docstring-derived
embeddings at L1+. Each block at L1+ carries a `behavioral_embedding`
derived by sandbox execution of `impl.ts` against a content-addressed
fuzzed input matrix; L0 blocks continue to use the textual embedding
provider per DEC-EMBED-010. The fuzzed input matrix and the behavior-aware
encoder are content-addressed blocks on the per-caller trust list. This is
explicitly **deferred to L1+** because it depends on the expanded ocap
discipline and the L1 totality guarantee (DEC-TRIPLET-L0-ONLY-019). Source:
`suggestions.txt` ask #3.

---

## TCB hardening

Every verification result is conditional on the trusted computing base — the
infrastructure that generates and checks attestations. If the TCB is wrong,
attestations lie.

### What is in the TCB

- The IR validator (the strict-TS-subset checker).
- The totality checker (the L1 pass).
- The SMT encoder (`impl.ts → SMT2`) and the SMT solver (Z3 by default).
- The Lean translator (`impl.ts → impl.lean`) and the Lean checker.
- The Wasm runtime that executes blocks at compile-and-test time.
- The proof checker for any non-Lean proof formats supported.

A bug in any of these can produce a false attestation. A bug in the IR
validator lets an adversarial block through. A bug in the encoder lets a
spec-violating implementation prove refinement. A bug in the runtime lets a
block exhibit behavior at runtime it did not exhibit during verification.

### Reproducible WASM build

The TCB compiles to deterministic WASM, content-address itself, and audits
via the same ledger that audits blocks. A user running yakcc receives a TCB
binary with a known content-address; that content-address is queryable
against the registry's TCB-attestation surface (a parallel structure to
block attestations: `[TCB_hash, audit_artifacts...]`). A new TCB version is
a new content-address; consumers opt in deliberately, and the migration of
attestations under a new TCB is the verifier-rotation problem (see below).

Reproducibility requires a pinned toolchain. The `TRUSTED_BASE.md` document
(to be authored at v1; not part of this v0/v0.5 scope) names the Lean
compiler version, Rust toolchain version, Wasm runtime version, and Nix or
Bazel definition that produces a byte-identical TCB on a fresh machine.

### CakeML-style bootstrap

The aspirational architecture is CakeML-style:

1. A small hand-verified micro-kernel against a paper specification — the
   smallest fragment of the IR validator and proof checker we can fit on a
   page and review by hand.
2. The micro-kernel mechanically verifies a larger fragment of itself
   (a more capable validator written in the strict-TS subset).
3. The larger fragment mechanically verifies the production TCB.

This is research, not v0/v1 work. Its inclusion here is to name the target
the substrate is heading toward, not to claim it is done.

### Soundness vs completeness

A TCB bug can be either:

- **incomplete** — rejects a block that should pass (false negative).
- **unsound** — accepts a block that should fail (false positive).

Unsoundness is far worse: an unsound TCB silently accepts blocks that
violate their contracts, and downstream consumers believe attestations that
are wrong. We price the asymmetry into the bounty system at F4 (see
`FEDERATION.md`): unsoundness bounties are ~10x completeness bounties, and
unsoundness reports must include a witness — the false-positive proof
itself, demonstrating the contract violation. This forecloses on the
adversarial pattern of "report unsoundness without proof" as a denial-of-
service attack on the bounty system.

@decision: DEC-VERIFY-007 — TCB hardening: deterministic-WASM TCB binary,
content-addressed and audited via the same ledger as blocks; pinned
toolchain (`TRUSTED_BASE.md`, deferred); CakeML-style bootstrap as the
long-term target. Unsoundness bounties priced ~10x completeness; unsoundness
reports require a counterexample witness.

---

## Verifier-as-block

The verifier (the IR validator + totality checker + SMT encoder + Lean
checker + Wasm runtime) is itself a block in the registry. Its
content-address is the verifier's identity. This is the load-bearing trust
move: there is no privileged off-registry "official verifier"; there is the
verifier-block whose content-address is on the trust list, and the trust
list is per-caller.

### Attestations as sidecar metadata

An attestation is a tuple:

```
Attestation = (
  verifier_hash: BlockMerkleRoot,        // which verifier produced this
  block_hash: BlockMerkleRoot,           // which block was checked
  level: L0 | L1 | L2 | L3,              // the level claim
  evidence: bytes,                       // signed payload (signature in F2+)
  valid_until_revoked: bool,             // revocation semantics
  issued_at: timestamp,                  // for ordering revocations
)
```

Attestations live in the federation layer, **not** in the block itself.
A block's `proof/` directory carries the artifacts a verifier *would* check;
the attestation is the *signed claim* by a specific verifier that the check
succeeded. F0 (single-machine) callers run a verifier locally and produce
their own self-attestations; F2+ callers share attestations across the
federation.

### Verifier rotation

Verifier upgrades are inevitable. Lean compilers go from 4.7 to 4.8; SMT
solvers add new theory tactics; the IR validator gains a new check. When
`VerifierHash_B` releases:

- existing blocks attested under `VerifierHash_A` **do not break**. The
  attestation is still valid — it is a historical claim that A checked the
  block.
- selection lazily drops `VerifierHash_A` from the trust list (per
  governance — see `FEDERATION.md`) and prefers blocks with a `VerifierHash_B`
  attestation.
- as compute is available, blocks are re-attested under B. The re-attestation
  is a separate attestation; the old one is not deleted.

### Attestation transfer

When verifier upgrades are mechanically compatible (a Lean 4.7 → 4.7.1
patch release that does not change semantics), a **proof-converter agent**
can produce a `VerifierHash_B` attestation directly from an existing
`VerifierHash_A` attestation without re-running the full check. The
converter is itself a content-addressed block; its trust depends on the
governance of the trust list. This avoids the catastrophic case where every
block in the registry has to re-verify on every minor verifier update.

### Retroactive unsoundness

If `VerifierHash_A` is later discovered to be unsound — a bug, a soundness-
critical regression — the attestations it issued are **revoked**:

- a revocation event is published against `VerifierHash_A`. All
  attestations citing that verifier hash become invalid.
- consumers re-query selection; blocks whose only attestation was under
  `VerifierHash_A` lose their level claim and fall back to whatever is
  re-verifiable under a sound verifier.
- blocks that had *additional* attestations under sound verifiers retain
  those.

The `valid_until_revoked` flag is what makes this work. Attestations are
not absolute; they are valid until the verifier that issued them is
revoked. Revocation is an explicit, ledger-recorded event in F2+.

### Trust list per-caller

The trust list — the set of `VerifierHash`es a caller is willing to accept
attestations from — is per-caller. This is clean object-capability
governance: local policy decides what to trust. The default trust list
shipped with `@yakcc/registry` is **itself a governance artifact**; the
question of who maintains the default (multi-sig, on-chain vote,
federation-of-attesters) is explicitly deferred to `FEDERATION.md`.

A user running yakcc privately at F0 has total control over their trust
list; they can run their own verifier locally and never trust a remote
attestation. A user at F2+ imports the default trust list and may
override it.

@decision: DEC-VERIFY-008 — The verifier is a content-addressed block in the
registry. Attestations are sidecar metadata `(verifier_hash, block_hash,
level, evidence, valid_until_revoked)` living in the federation layer.
Verifier rotation is graceful: lazy re-verification, attestation transfer
for compatible upgrades, retroactive unsoundness handled via revocation
events. The trust list is per-caller; the shipped default is governance,
deferred to `FEDERATION.md`.

---

## Hard problems

These are the residual open questions the verification spine surfaces but
does not close. v0/v1 ship without resolving them; they are the live
research surface.

- **Governance of the default trust list.** The `@yakcc/registry` default
  trust list determines what verifiers a fresh F2+ install accepts. Who
  maintains it? Multi-sig of named maintainers? On-chain vote weighted by
  attestation history? Federation-of-attesters with rotating membership?
  Each option has failure modes (capture, low quorum, factional drift). The
  cornerstone forbids ownership; "no ownership" plus "the default trust list
  is sovereign" is a pair that does not have an obvious resolution.
  Surfaced in `FEDERATION.md`; explicitly a user-decision boundary, not a
  v0/v1 deliverable.

- **Covert channels (timing, cache, speculation).** The static
  `constant_time` analysis catches data-dependent branching and indexing in
  the source. It does not catch microarchitectural side-channels —
  cache-timing attacks, branch-predictor leakage, speculative-execution
  variants. A block can be `constant_time` at the source level and still
  leak via Spectre-class behavior on real hardware. The substrate has no
  story for this beyond "do not ship secret-handling code unless you have
  a separate hardware-aware analysis on top." Open research; not a v0/v1
  problem.

- **Capability attenuation language.** The vocabulary listed above
  (`ReadOnly`, `WriteOnly`, `Append`, `Listen`, `Connect`, `Clock`,
  `Random`) is incomplete. Real systems need temporal attenuation
  (capabilities that expire), revocable capabilities (capabilities the
  granter can withdraw), and quota-bounded capabilities (write at most N
  bytes). v0/v1 ships with the static vocabulary above; v2+ extends.

- **Proof-translator agents for verifier upgrades.** The attestation
  transfer mechanism described above relies on a proof-converter agent
  for compatible upgrades. The converter itself must be trusted. We can
  recursively apply the verifier-as-block pattern (the converter is
  content-addressed, runs under the trust list), but the bootstrap of
  trust in the first converter version is genuine. Open question.

- **AI proof synthesis as a research bet.** The L3-via-actor-critic
  pipeline assumes proof synthesis is on a trajectory that makes L3
  populated at scale during the v0.7 → v1 → v2 horizon. If the trajectory
  flattens, the substrate's L3 tier remains sparse — the cost asymmetry
  problem the F4 economic premium is supposed to solve does not solve a
  technological ceiling. We are betting on the trajectory; we are not
  staking the substrate on it (L0/L1/L2 remain useful even if L3 stays
  research-only).

- **Effect system completeness for L3.** Real-world effectful code uses
  more effects than the v1 vocabulary covers (long-lived background tasks,
  bidirectional streams, distributed state). L3 proofs over those effects
  require effect-system extensions whose soundness is its own research
  problem. v0/v1 ships with bounded synchronous effects only.

- **AST canonicalization completeness vs. soundness.** The De Bruijn /
  commutative / pure-flatten rules in DEC-VERIFY-009 are *sound*
  (semantically equivalent algorithms collapse to the same canonical form
  for all the rewrites the rules cover) but not *complete* (two genuinely
  equivalent algorithms can serialize differently if one uses a rewrite the
  rules do not normalize — e.g., loop-to-recursion transforms beyond the
  bounded-iteration node, or algebraic identities like `x * 2 == x + x`).
  Closing the gap further is undecidable in general; the v0.7+ rule set is
  what we ship and contributors who hit equivalence-not-detected cases can
  re-attest the existing block instead of registering a new one. Open
  research surface; not v1-blocking.

- **Standardized fuzz matrix as governance.** The behavioral-embedding
  matrix in DEC-VERIFY-010 is a substrate-wide governance artifact: it
  defines what "behavioral equivalence" means at L1+ for everyone using the
  default. Who curates it? Multi-sig of named curators, federation-of-
  fuzz-matrix-attesters, or per-caller curation that defaults to a content-
  addressed seed are all candidate models, and the same caller-sovereign-
  trust-list pattern from `FEDERATION.md` §"Governance" applies. The
  behavior-aware encoder (the model that projects (input, output) pairs
  into vector space) is a parallel governance artifact with the same shape
  of question. Deferred to L1+ deployment, not v0/v0.7 work.

---

## Decision log

These DEC-IDs are owned by this document. Each is a load-bearing choice; new
choices that supersede them require a new DEC-ID and a forward reference, not
silent edits.

| DEC-ID | Decision |
|---|---|
| DEC-VERIFY-001 | Verification levels L0..L3 declared in spec, enforced by registry. The level hierarchy is a strict partial order; a higher level strictly refines a lower one. Levels are opt-in per block; L0 is the v0 floor and the default. |
| DEC-VERIFY-002 | Block identity is the Merkle root of the triplet (`spec.yak`, `impl.ts`, `proof/`). Spec hash is an index over blocks, not the block identity. v0's `ContractId = hash(spec)` model is migrated, not preserved as a parallel authority. |
| DEC-VERIFY-003 | `spec.yak` is JSON-shaped (LLM-friendly), with required fields for theorem statement (preconditions, postconditions, invariants), capability requirements (ocap effect signature), totality witnesses, declared verification level, and declared SMT theory at L2. Embedded TS `CONTRACT` literals are a v0 transitional shape only. |
| DEC-VERIFY-004 | Object-capability discipline: pure-by-default blocks, effects only via explicitly-passed capability tokens, attenuation as first-class (`WriteOnly<P>`, not blanket `Filesystem`), delegation tagging (`consumed` vs `delegated`). `constant_time` is a separate non-functional contract property. |
| DEC-VERIFY-005 | L2 verification uses Z3 as the default solver with declared SMT theory in `spec.yak`. Bounds (BMC depth, fuzz samples, solver budget) are visible contract metadata; bounded attestations and proof-complete attestations are distinguishable at the selector. Float arithmetic is rejected at L2 in v0/v1. |
| DEC-VERIFY-006 | L3 verification pairs a TypeScript implementation with a Lean (or Coq / Agda) refinement proof. The proof checks against a Lean-shaped translation of the implementation; cited sub-block lemmas must come from content-addressed `proof/` artifacts. Proofs are erased at runtime. |
| DEC-VERIFY-007 | TCB hardening: deterministic-WASM TCB binary, content-addressed and audited via the same ledger as blocks; pinned toolchain (`TRUSTED_BASE.md`, deferred); CakeML-style bootstrap as the long-term target. Unsoundness bounties priced ~10x completeness; unsoundness reports require a counterexample witness. |
| DEC-VERIFY-008 | The verifier is a content-addressed block. Attestations are sidecar metadata `(verifier_hash, block_hash, level, evidence, valid_until_revoked)` living in the federation layer. Verifier rotation is graceful (lazy re-verification, attestation transfer for compatible upgrades, retroactive unsoundness via revocation). Trust list is per-caller; the shipped default is governance, deferred to `FEDERATION.md`. |
| DEC-VERIFY-009 | Semantic AST canonicalization is a constitutional pre-ledger pass in `@yakcc/contracts`, not an F4 economic guard. Every yakcc deployment (F0..F4) runs it. The canonicalizer derives a `canonical_ast_hash` (BLAKE3 over a De-Bruijn-renamed, commutative-normalized, pure-function-flattened AST of `impl.ts` only). The hash is sidecar to `BlockMerkleRoot` and gates submission: a structural duplicate is rejected at ingest with the existing block's `BlockMerkleRoot` returned. A contributor wanting a stricter L-axis level on an existing canonical-AST re-attests the existing block, never registers a parallel one (Sacred Practice #12). Source: `suggestions.txt` ask #1. |
| DEC-VERIFY-010 | Behavioral embeddings replace docstring-derived embeddings at L1+. Each L1+ block carries a `behavioral_embedding` derived by sandbox execution of `impl.ts` against a content-addressed fuzzed input matrix; L0 blocks continue to use the textual embedding provider per DEC-EMBED-010. The fuzzed input matrix and the behavior-aware encoder are content-addressed blocks on the per-caller trust list. Deferred to L1+ because sandbox execution requires expanded ocap discipline and the L1 totality guarantee (DEC-TRIPLET-L0-ONLY-019). Source: `suggestions.txt` ask #3. |
| DEC-VERIFY-L3-LIFECYCLE-001 | L3 attestations record verifier engine + version as a first-class tuple field (e.g., `lean@4.7.1`). Prior attestations are NOT auto-trusted under a new engine. At F4: migration through the proof-converter shadow process (DEC-F4-THREAT-CONVERTER-SHADOW-001, `FEDERATION.md`). At F0/F1: re-verification on demand. Old attestations persist as historical records; caller trust list determines acceptability. L3 proofs against non-canonical specs are valid verification artifacts but do not earn F4 bounty payout (DEC-F4-THREAT-CANONICAL-SPEC-001). |
