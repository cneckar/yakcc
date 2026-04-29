# DESIGN.md — Yakcc

> A 15-minute orientation. If you are a new contributor — human or agent —
> read this end-to-end before touching a file. Then read `MASTER_PLAN.md` for
> what we're building next, and `initialize.txt` for the full vision in the
> user's own words.

---

## What Yakcc is

Yakcc is a substrate for assembling software out of minimal, behaviorally-
specified, content-addressed basic blocks drawn from a global registry. Each
block is written exactly once — by the first caller who needs it — and the
substrate improves monotonically as stricter or faster implementations are
contributed alongside the originals.

The name is a yak-shave joke that is also a thesis: this project is a massive
prerequisite undertaking whose explicit purpose is to abolish all future yak
shaves. We shave once so callers never shave again. The double-c is a nod to
GCC and the long lineage of terse compiler names.

## Why Yakcc

Two failure modes meet in the middle and Yakcc exists in the gap.

**Failure mode 1: generic libraries import attack surface their callers never
use.** A program that needs to parse a list of integers reaches for a JSON
library and inherits every CVE that library will ever have. The library author
maximized generality to maximize adoption; the caller pays the surface-area
tax forever. Multiplied across the ecosystem, this is the modern supply-chain
problem in one sentence.

**Failure mode 2: AI coding agents reflexively reimplement.** When an agent
can't find the right library quickly, it reimplements the function inline.
Generation is cheaper than retrieval-plus-comprehension, so generation wins,
and the same `parseInt` wrapper, the same `debounce`, the same React
boilerplate gets emitted ten million times across ten million projects. The
long tail of correct, audited, minimal implementations rots while the same
mediocre code is rewritten over and over.

Yakcc inverts both. A caller asking for "parse a list of ints, no other types"
gets exactly that — no JSON-the-language attack surface attached. An AI agent
asking for the same thing gets a registry hit, not a reemission. Every line
of code in a Yakcc-assembled program points to a verified, reused basic block
with a known test history and minimum necessary surface.

---

## Core concepts

### Contracts

A contract is a precise behavioral specification of what a piece of code does.

> "Parse a JSON array of integers, no other types, no escapes, fail on
> malformed input."
> "Match an opening bracket character."
> "Compute SHA-256 of a byte array, FIPS-compliant, constant-time."

Each of those is a contract. Two implementations that satisfy the same
contract are interchangeable from the caller's perspective.

### Content-addressed identity

A contract's identity is the hash of its canonicalized spec. It is not a name,
not a semver, not the hash of the implementation code. Two implementations
satisfying the same contract share an identity for that contract; the
implementations themselves are distinct entries underneath.

This is load-bearing. It is what lets the registry be version-free and
monotonic: nothing is "upgraded," because nothing has a version to upgrade
from. Newer entries simply advertise stricter contracts (a bug fix declares
correct handling of a case the prior entry mishandled) or better non-functional
properties (faster, smaller, lower-memory) and start winning selection.

### Partial ordering by strictness

Contracts form a partial order. A stricter contract refines a looser one — it
does less, but guarantees more about what it does. A bug fix is a strictly-
stricter contract. A perf improvement is a same-strictness contract with
stronger non-functional guarantees.

Inferring this ordering in general is undecidable. v0 takes the pragmatic
path: contributors declare ordering, and the substrate runs structural sanity
checks. Future work tightens this with differential execution and formal
properties.

### The embedding is just an index

Vector embeddings of contracts exist *only* to surface candidates for a
proposal. They are the search mechanism, not the contract. Selection from
candidates is governed by structured matching plus strictness, never by
cosine distance.

This is a discipline, not a default. Near-neighbors in embedding space can
have wildly different semantics — off-by-one, endianness, error handling,
thread safety. If embedding similarity ever becomes a correctness criterion,
the substrate has silently failed.

### Composition from minimal blocks

Every component decomposes into smaller contracts that compose back into
larger ones. A list-of-ints JSON parser composes an integer-recognizer, a
bracket-matcher, and a comma-separator. A full JSON parser is built atop the
list-of-ints parser plus a string-recognizer plus an object-recognizer.

Each level inherits only the surface area it actually exercises. This is the
answer to the supply-chain problem: minimum-viable code is the *point*, not a
stretch goal.

### Monotonic, version-free registry

Old implementations are never deleted. They simply stop winning selection
because newer entries advertise stricter contracts or better non-functional
properties. There is no semver, no `latest`, no breaking-change event, no
upgrade. The substrate gets quietly better over time, and references to
content-addressed contracts remain stable forever.

Versioning is one of the largest sources of accidental complexity in modern
software. Yakcc designs it out by making contracts the identity rather than
names.

### No ownership

The registry is a public-domain commons. There is no `author_email`, no
`signature`, no reserved columns for either. The entire repo and every
registered block is dedicated to the public domain under **The Unlicense**.

The Unlicense (rather than 0BSD or MIT) is deliberate. A permissive copyright
license still presupposes an owner who is graciously waiving most of their
rights. A public-domain dedication asserts there is no owner to begin with.
That distinction matters here: the cornerstone is not "you may freely use
this code," it is "no ownership is allowed in this commons." The license is
the legal instrument that matches the cornerstone, not a pragmatic compromise
on top of it.

This is not a default we will quietly back away from when trust mechanisms
become interesting later — trust mechanisms, when they arrive, will attach
to immutable contract ids in a sidecar layer. Identity stays a hash.

### Minimum-viable code

Yakcc produces the smallest implementation whose contract is a superset of
what the caller actually needs. This is the opposite of how libraries are
written today, where authors maximize generality to maximize adoption. The
wedge for the project — especially in security-conscious contexts — is that
every line of code in a Yakcc-assembled program points to something verified
and minimal.

### Library absorption

A registry of hand-authored blocks is a demo. A registry that can absorb the
working ecosystem block-by-block is the answer to the supply-chain problem.
v0 stands up the substrate; v0.5 lets AI synthesize blocks the registry is
missing; v0.7 ingests the libraries that already exist by decomposing them.

Decomposition takes a third-party library's source tree and walks it for
discrete contract-shaped units — a single function, a single exported
binding, a method that cleanly factors out of its class. For each unit the
decomposition engine proposes a `ContractSpec`, derives or synthesizes a
property-test corpus (preferring the library's own tests where adaptable,
falling back to its published usage examples, then to AI-derived cases),
and ingests the unit as a strict-TS block in the registry. Provenance —
source URL, upstream commit SHA, file path, line range, original license —
attaches as mutable metadata on the immutable contract id.

The point of this is concrete: a caller asking for `debounce` should get
just the `debounce` block, not the rest of lodash. A caller asking for an
`ms`-style millisecond-string parser should get just that parser, with
provenance back to the line of upstream source it was extracted from. The
supply-chain claim — "you get exactly what you asked for, with no attached
attack surface" — only stops being theoretical when the registry can absorb
existing libraries this way. Decomposition is the bootstrap path for that.

Each absorbed block passes the same gates as a fresh block: the strict TS
subset, a property-test corpus, content-addressed identity. Upstream
licenses are recorded but not relicensed — the commons absorbs without
rewriting attribution. v0.7 gates absorption on property tests; v1 adds
differential execution against the upstream source as the harder, slower,
more thorough check that the absorbed block actually behaves like the
original on a large input corpus. Until that v1 check exists, decomposed
blocks should be treated as candidate replacements pending manual audit
in security-critical contexts, not drop-in substitutes.

---

## Architecture

Seven packages. Read the per-package README for the full contract; this
section is the map.

```
                        +-----------------------------+
                        |    @yakcc/hooks-claude-code  |
                        |  (facade in v0, live v0.5+) |
                        +--------------+--------------+
                                       |
                                       v
                        +-----------------------------+
                        |          @yakcc/cli         |
                        |  propose | search | compile  |
                        |  registry init | block author|
                        |  decompose (v0.7)            |
                        +--------------+--------------+
                                       |
   +-------------+-------------+-------+-------+-------------+
   |             |             |               |             |
   v             v             v               v             v
+--------+ +-----------+ +-----------+ +-------------+ +------+
|contracts| | registry | |  compile  | | decompose   | |  ir  |
|spec    | | SQLite + | | IR -> TS  | | (v0.7)      | |strict|
|canon.  | | sqlite-  | | whole-    | | AI-driven   | | TS   |
|content-| | vec      | | program   | | absorption  | |subset|
|address | | match    | | assembly  | | of existing | |ts-   |
|embed   | | select   | | provenance| | libraries   | |morph |
|pipeline| |          | | manifest  | | + provenance| |      |
+---+----+ +----+-----+ +----+------+ +------+------+ +---+--+
    |           |             |              |           ^
    |           |             |              |           |
    +-----------+-------------+--------------+-----------+
                  (all blocks pass through @yakcc/ir)
```

### `@yakcc/contracts`

The shape of a contract. A `ContractSpec` declares input/output types,
behavioral guarantees, error conditions, and non-functional properties
(complexity, purity, side effects, thread safety). Canonicalization rules
make two equivalent specs hash identically. The embedding pipeline produces
a vector representation behind a provider interface — `transformers.js`
locally in v0, hosted providers swappable later.

### `@yakcc/registry`

Storage and retrieval. SQLite plus sqlite-vec in one file. Vector search
surfaces candidates for a proposal; structured matching filters those
candidates against the caller's actual needs; selection picks among matching
candidates by strictness then non-functional properties. Provenance metadata
(test history, differential execution results, runtime exposure) attaches to
contract ids; in v0 this metadata is sparsely populated, by design — the
schema has the columns, the workflows that fill them out come in v0.5+.

The registry is monotonic. `delete` is not part of its contract.

### `@yakcc/ir`

The strict TypeScript subset blocks are written in. `ts-morph` validates that
each block is free of `any`, `eval`, untyped imports, runtime reflection, and
the rest of the escape-hatch list. ESLint enforces the lighter rules. The
validator is wired into the Turbo build, so a non-conformant block fails the
pipeline rather than slipping into the registry.

Contract metadata is first-class IR syntax — error propagation, resource
ownership, and non-functional property composition are machine-readable, not
comment conventions.

### `@yakcc/compile`

Whole-program assembly. Given a top-level contract, walk sub-contracts, bind
each to a registry implementation, and emit a single TS artifact plus a
provenance manifest naming every basic block by content-address. The
compilation engine *does not generate code* — it composes pre-written blocks.
Code synthesis happens in `@yakcc/hooks-claude-code` (v0.5+), never here.

v0 ships only the TS backend. WASM is a v1 backend; LLVM/JVM are v1+. The
backend interface is real now so adding targets later is mechanical.

### `@yakcc/cli`

A thin developer surface: `propose`, `search`, `compile`, `registry init`,
`block author`. All real logic lives in the packages above; the CLI is the
adapter and the demoable artifact host. `yakcc compile examples/parse-int-list`
is the v0 acceptance check.

### `@yakcc/hooks-claude-code`

The leverage point. In v0 it ships as a facade — real install command, real
slash-command surface, real project config — with the proposal flow stubbed
behind a clear "v0.5 feature" message. The surface ships early so v0.5 is a
behavioral change, not an interface change.

In v0.5 the stub becomes a live interceptor: the agent's "I need to write
code that does X" moment is rerouted into the registry, and the agent's
output becomes a reference to a registry entry rather than a wall of
generated code. That is when Yakcc starts paying for itself in real authoring
loops.

### `@yakcc/decompose` (v0.7)

The library-absorption engine. Input is a source tree from an existing
library; output is a set of registry rows, one per discrete contract-shaped
unit identified in the source, each carrying provenance back to the upstream
URL, commit SHA, file, and line range, plus the original library license.

The engine is AI-driven: identifying which units cleanly factor out, deriving
their `ContractSpec`, and producing a property-test corpus all involve model
calls. The engine is *not* a free pass past the substrate's gates — every
absorbed block passes the strict-TS IR validator, every absorbed block has a
property-test corpus that passes before ingestion, and every absorbed block
gets a content-addressed identity via the same canonicalization path as a
hand-authored block. The substrate cannot tell, at lookup time, whether a
candidate came from a human, from v0.5 synthesis, or from v0.7 decomposition;
only the provenance metadata records the difference.

License compatibility is enforced at the ingestion boundary. Permissive
upstream licenses (MIT, BSD, Apache-2.0, ISC, 0BSD, Unlicense, public domain)
are accepted with their license recorded; non-permissive licenses are
refused with a clear error. The Unlicense remains the standard for fresh
contributions per the cornerstone — absorbed third-party code carries its
original license, the commons does not rewrite upstream attribution.

v0.7 gates absorption on property tests. v1 adds differential execution
against upstream as the deeper check, surfaced as a non-functional property
on the contract id. The v0.7 demo target is `vercel/ms` — a single-purpose
~100 LOC library with well-understood semantics, chosen specifically as a
low-risk first proof of the pipeline.

---

## Why a strict subset of TypeScript is the IR

This is the load-bearing IR decision. We chose TS over Rust, over a custom
DSL, over a parser-fork-of-something-existing. The reasoning:

- **Training-data density.** Every LLM that matters has read a planet-sized
  corpus of TypeScript. The IR exists to be authored by AI and humans
  interchangeably; choosing the language LLMs already speak natively buys
  authoring quality for free.
- **Structural typing matches contract subtyping.** TypeScript's type system
  is structural, not nominal. Contract refinement is structural too. The
  match is so close that strict-TS already encodes a chunk of what we'd
  otherwise have to invent.
- **Branded types and template literal types already encode behavior.** The
  TS ecosystem has been quietly using its type system for behavioral
  contracts for years. We are not introducing a foreign concept; we are
  formalizing an existing pattern.
- **Free fallback codegen.** Strict TS transpiles to vanilla TS and runs on
  Node, Deno, and Bun today. Even before any other backend exists, every
  Yakcc-assembled program can run somewhere.
- **Toolchain leverage.** ts-morph, ESLint, the TypeScript compiler, and the
  ecosystem of editors that already understand TS all become Yakcc tooling
  for free. A custom DSL would have to ship its own LSP.

The strict subset bans `any`, `eval`, untyped imports, runtime reflection,
and the rest of the escape hatches that would defeat contract verification.
The subset is enforced by ts-morph and ESLint, not by forking the parser —
forking the parser is a v1+ conversation if it ever happens.

---

## Tradeoffs accepted for v0

| We accept | In exchange for | Revisited at |
|---|---|---|
| Local-only registry | A single-file, no-server, demoable substrate | v1 (federation) |
| TS-only backend | Single-target compile path; no native-binding ops in v0 | v1 (WASM, then native) |
| Manual block authoring | No coupling to a moving model surface; substrate trustable in isolation | v0.5 (AI synthesis), v0.7 (library absorption) |
| Facade hook | Locked install/command surface; v0.5 is behavioral not structural | v0.5 (live intercept) |
| Hand-picked seed corpus | Demoable composition story; reviewer-sized | v0.5 (corpus grows organically once hook is live) |
| Contributor-declared strictness | Tractable in v0; gameable in principle | v1 (trust layer) |
| No author identity, no signatures | Cornerstone fidelity; commons stays a commons | v1 (trust metadata as sidecar attached to immutable id) |
| Embedding latency on first run | Offline-by-default; no vendor lock-in | v0.5+ (provider swap) |
| sqlite-vec over LanceDB / pgvector | Single-file, embeddable, no-server | v1 (federation backend may differ) |

---

## Hard problems we explicitly aren't solving in v0

`MASTER_PLAN.md` carries the live deferral table. The summary:

- **Contract equivalence is undecidable in general.** We rely on declared
  strictness, structural sanity checks, and shared property-test corpora.
  Near-duplicates are tolerated.
- **Composition is not free.** Errors, resources, and performance don't
  decompose cleanly. v0 limits seed blocks to pure, total, side-effect-free
  cases where composition is well-behaved.
- **Provenance and trust.** None in v0. Public-domain commons. Trust
  mechanisms are a v1 design pass.
- **Adversarial contributions.** Out of scope until a shared registry exists
  to attack.
- **Seed-corpus bias.** Whatever ~20 blocks we pick will shape composition
  taste. We accept the bias and rely on v0.5's authoring loops to dilute it.

---

## How to read the rest of the repo

- `initialize.txt` — the full vision in the user's own words. Source of
  truth for *why*.
- `MASTER_PLAN.md` — staged plan, exit criteria, non-goals, live work
  items, decision log, riskiest assumptions. Source of truth for *what
  next*.
- `AGENTS.md` — orientation for AI agents who land in the repo.
- `packages/<name>/README.md` — per-package contract. The package's
  promises, its public surface, and what it does not do. (Authored
  alongside each package's first real implementation.)
- `examples/parse-int-list/` — the v0 demoable artifact. Reading it
  end-to-end is the fastest way to understand whole-program assembly.
- `tmp/` — scratch. Never `/tmp/`.

When in doubt: read the cornerstone in `MASTER_PLAN.md` and check whether
your change preserves it. If it doesn't, that is a replanning conversation,
not an implementation conversation.
