# DEC-DUC-TRUST-MODEL-001 — Accepting shared DUC implementations (D4)

**Status:** Proposed
**Date:** 2026-11-22
**Issue:** https://github.com/cneckar/yakcc/issues/1284
**Parent:** #1275 (DUC graphs as the stored atom form, D4, phase 8)
**Related:** #1279 (graph storage), #1281 (closure), #1282 (base sets), #1277 (types), #1278 (lowering)

---

## Context

An implementation is a DUC graph keyed by the pair (contract `specHash`, graph identity). The
structure is stored once per identity, and its links and annotations are kept outside identity
(#1279). A store accepts only closed batches (#1275): every reference either resolves inside the
batch or to a contract already in the store, or it is a platform primitive of the target's base set.

A store that accepts submissions from others (F2 federation) receives graphs it did not produce.
A graph is a **claim**: "this structure implements that contract". This record sets what a
submitter sends, what a receiving store checks and in what order, and what each check protects
against.

## Decision

### 1. What a submission carries

A submission is one **closed batch**. For each implementation in it:

| Field | Content |
|---|---|
| `spec` | The contract's canonical bytes (`SpecYak`). The receiver recomputes `specHash`. |
| `structure` | The packed graph structure (brotli-compressed compact encoding) and its `formatVersion`. |
| `identity` | The graph identity the submitter computed. |
| `lifterVersion` | The lifter that produced the graph, when it was lifted rather than written. |
| `links` | For each reference: (reason, symbol, module, target `specHash`). |
| `evidence` | Conformance vectors: inputs and expected outputs, each tied to the contract. |
| `baseSet` | The target base set (id and version) whose primitives the graph uses. |

Annotations (origin text) are optional. They are never needed to check anything, and a receiver
may drop them.

### 2. What the receiving store checks, in order

The checks go from cheapest to most expensive. Each one runs only if every check before it
passed, so a malformed or dishonest submission costs the receiver as little as possible. A batch
is accepted only if every implementation in it passes every check.

1. **Decode.** The receiver reads `formatVersion` and decodes the structure. *Covers:* corrupt or
   truncated bytes, an unknown format, decompression bombs. The decompressed size is capped before
   decoding.
2. **Well-formedness.** Every value has exactly one producer; regions, branches, loops and
   closures nest as the line form requires (`printLineForm` succeeds); there is no cycle outside a
   loop's carried values. *Covers:* a graph that cannot mean anything, and one that crashes a
   lowerer.
3. **Integrity.** The receiver recomputes `graphIdentity` from the decoded structure, and the
   `specHash` from the contract bytes, and compares both with what was sent. *Covers:* a key that
   does not match the content, so one implementation cannot be stored under another's key.
4. **No external code (D5).** Every diamond is a local, a link, a platform primitive, or a hole
   (unlinked reference). There is no source text to run and no opaque node whose meaning is text.
   An opaque node (a construct summarized by its source hash) is **refused** for a shared
   submission: its meaning cannot be checked from the structure. *Covers:* code smuggled in as text.
5. **Closure.** `checkSubmission(batch, storedContracts, baseSet)`: every link targets a contract
   in the batch or in the store, and every platform primitive is in the declared base set.
   *Covers:* a dangling dependency, and a graph that needs a capability the target does not offer.
6. **Capabilities.** The receiver compares each primitive's capability label from the base set
   (`process`, `io`, `network`, `timers`, `module-location`) and its nondeterminism label
   (`primitiveReport`, `nondeterministicObservations`) with the contract's declared `effects`. A
   graph that reaches a capability its contract does not declare is refused. *Covers:* an
   implementation that does more than its contract admits, such as network access behind a "pure"
   contract.
7. **Types.** The receiver runs `inferTypes` seeded with the contract's input types. The result
   must fit the contract's output type with no mismatches. Ambiguities are recorded, because they
   matter only to the targets that refuse them. *Covers:* a structure that cannot return what the
   contract promises.
8. **Conformance.** The receiver runs the evidence vectors itself, on at least one lowering it
   trusts: TypeScript (`emitTypeScript`), and Python (`emitPython`) where the graph lowers. Each
   output must equal the expected output. A vector whose expected output contradicts the contract's
   postconditions is a refusal of the whole submission. *Covers:* a structure that does not compute
   what it claims, as far as the vectors reach.
9. **Corroboration.** The vectors are the submitter's, so a dishonest submitter can choose vectors
   that pass. The receiver adds its own vectors:
   - vectors already stored for the contract (other implementations' evidence);
   - property tests generated from the contract's types and postconditions.

   Where another stored implementation of the same contract exists, both are run on the same
   inputs, and any disagreement is recorded against both. *Covers:* evidence chosen to pass, and an
   implementation that is wrong where the submitter did not look.

### 3. What acceptance means

A graph that passes checks 1–7 is **admitted as a claim**: it is stored, keyed by its pair, and
marked `claimed`. Checks 8–9 raise its trust:

| Level | Meaning | Reached by |
|---|---|---|
| `claimed` | Well-formed, intact, closed, within its capabilities, well-typed. | Checks 1–7 |
| `conforming` | Computes its own evidence on the receiver's lowering. | Check 8 |
| `corroborated` | Agrees with the receiver's vectors and with every other implementation of its contract. | Check 9 |
| `proven` | A proof attests the contract (the existing proof manifest, L1–L3). | `@yakcc/contracts` proof levels |

Selection (#1280) prefers higher levels. A trust level is a property of the pair (spec, identity),
not of the graph alone: the same structure can be corroborated under one contract and only claimed
under another.

### 4. Failure modes and the check that covers each

| Failure | Covered by |
|---|---|
| Corrupt or hostile bytes | 1 Decode (size cap), 2 Well-formedness |
| A key that does not match the content | 3 Integrity |
| Code smuggled in as text, or an opaque construct | 4 No external code |
| A dependency the store does not have | 5 Closure |
| A capability or nondeterminism the contract does not admit | 5 Closure (base set), 6 Capabilities |
| A result of the wrong type | 7 Types |
| A wrong computation | 8 Conformance, 9 Corroboration |
| Evidence chosen to pass | 9 Corroboration |
| A link whose target contract is weaker than its use needs | Not covered here; it is recorded as an open question below |

## Consequences

- Shared submissions carry no TypeScript text. Each receiver lowers the graph itself and keeps
  the TypeScript only as a cache (#1279).
- Opaque nodes stay usable locally but cannot be shared. That gives a measurable target:
  opaque-free atoms are what federation can carry (55 of 418 corpus structures had an opaque node
  at the time of this record, #1276).
- Conformance needs a trusted lowering per checked target. The TypeScript emitter (round-trip
  tested) and the Python lowering (conformance tested) exist; Go and Rust do not yet (#1278).

## Implementation notes (#1287)

`checkSharedSubmission` in `@yakcc/federation` (`src/duc-submission.ts`) implements checks 1–9.
Points the design left open, as built:

- **Check 4** also refuses `eval` and `Function` by name, linked or not: a link to a contract does
  not stop them running text as code.
- **Check 6.** A primitive's capability label `c` is admitted by a contract effect that is `c`, or
  starts with `c:` (case-insensitive; `"network:api.example.com"` admits `network`). A result that
  depends on a nondeterministic primitive is admitted by the effect `"nondeterministic"`.
- **Check 8** runs the TypeScript lowering, with types stripped, in a fresh `vm` context. That
  context holds the language's built-ins and the DUC runtime, nothing of the host, and each vector
  has a time limit. Values are compared as JSON. Each linked reference is defined in the same
  context from an implementation of its contract, from the batch or the store.
  - A name the context cannot provide makes the evidence **unchecked**, not wrong, and the pair
    stays `claimed`. This covers Node primitives, and a link to an atom that only declares a
    value (a module statement).
- **Check 9** runs each other stored implementation of the contract on both sides' vectors. A
  vector either side cannot run is skipped.

**Modules (#1290).** A submission carries a `ModuleRecord` per file. It sits outside identity,
like links, and holds:
- the file's statements in order, each with its contract, identity, kind (`function` or
  `statement`), and the names it declares in its graph's output order;
- the module each relative `require` names;
- optionally, evidence against the module's exports.

How the receiver uses it:
- **Check 5.** A name the module declares, its `exports` and `module`, and a `require` of a
  module in the submission or of one the platform provides, are not holes.
- **Platform modules.** The base set lists the platform's modules with their labels (`NODE`
  version 2: `fs` grants `io`, `crypto` is nondeterministic, …). Check 6 holds those labels
  against the contract's effects.
- **Check 8.** A module runs in its own context: functions first (they hoist), then its
  statements in order. Its members' evidence and its own evidence run there.
- **Host modules.** These are never handed to the sandbox: evidence that needs one is unchecked.

On the corpus, with module records, closure refusals fall from 1,065 to 62. The rest are mostly
packages outside the submission (`require` of a dependency that was not shaved). base64-js and ms
pass checks 1–8 against evidence taken from the real packages (`duc-module-submission.test.ts`).

**Measured on the shaved corpus, before module records** (one batch per package; each original source run on sample
inputs to give the evidence, so check 8 tests the graph against its source):

| Outcome | Implementations |
|---|---|
| `conforming` | 157 (1,639 vectors in all) |
| `claimed` | 84 |
| refused at capabilities | 3 (`Date` under a pure contract) |
| refused at closure | 326 |
| refused at conformance | 0 |

Every closure refusal is a module-level name that is not an atom (#1290).

## Open questions

1. **Link strength.** A link says "use contract S". It does not say that S's postconditions are
   strong enough for the caller's use. Checking that is a refinement question (`refinesInfluence`
   in `@yakcc/duc`). It is left to the proof levels, not to acceptance.
2. **Lifter version skew.** Two lifter versions can give the same source two identities. A
   receiver accepts the structure it is sent, whatever its `lifterVersion`. Relifting a source is
   not part of acceptance.
3. **Revocation.** A corroboration failure found later, against a new implementation, lowers the
   trust of an already accepted pair. Whether that propagates to dependents is a policy question.
