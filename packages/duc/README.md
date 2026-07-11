# @yakcc/duc

The **Def-Use Calculus (DUC)** influence layer: a semantics-free def-use graph
over a strict-TS atom, plus the analyses that are *theorems of the graph*,
quantified over every interpretation of its opaque nodes.

This package is the engine for the DUC influence layer (epic
[#1161](https://github.com/cneckar/yakcc/issues/1161); design in
[`plans/wi-duc-influence-layer.md`](../../plans/wi-duc-influence-layer.md)). It
is a **leaf** package — pure, offline, no registry I/O, no LLM — that `@yakcc/ir`,
`@yakcc/shave`, `@yakcc/compile`, and `@yakcc/contracts` build on.

Source paper: *Sound Influence under Opacity: A Def-Use Calculus for Computation
whose Semantics Were Never Given*.

## What it promises

Given a strict-TS atom body, `liftAtom` emits a **DUC graph**: values
(single-assignment names), **opaque** operation nodes (the graph records their
input/output ports, never what they compute), def-use edges, and **♦-sources** —
the distinguished label the conservative builder attaches to any use it could not
resolve (a foreign import, a free identifier, an unresolved module edge). A use
is always resolved, declared as a ♦-source, or the atom is ill-formed: a silently
dropped use is unrepresentable.

From that graph alone the package derives, in linear time per query:

- **well-formedness** (`isWellFormed`) — conservation (every use has a def) plus
  acyclicity, with a WF-C counterexample or a WF-A ranking.
- **may-influence** (`mayInfluence`, `influenceCone`, `mayInfluencePairs`) — the
  closure of flows-to through opaque nodes; sound for every interpretation, least
  among graph-only sound relations, witnessed.
- **unknown-support** (`usupp`, `usuppOfObservations`) — which ♦-sources each
  observation depends on. The computed fact that replaces "candidate pending
  audit".
- **witnesses** (`witness`, `renderWitness`) — the symbolic provenance term where
  subterm-occurrence *is* influence.
- **graph non-interference** (`graphNI`, `labelBySymbol`) — non-interference as
  reachability: an *iff* over the graph and all interpretations, with a witness at
  a leaking observation. Implicit flows are covered because a branch condition
  flows into its `sel` gate as ordinary data.
- **monotone composition** (`boundaryType`, `paramSummaryMatrix`, `refine`,
  `refinesInfluence`, `refinementIsMonotone`) — an opaque node is the coarsest
  sound summary of a replacement subgraph; refinement only removes influence.
  `refinesInfluence` is the strictness falsifier: a claimed-stricter block that
  *adds* a param->obs influence edge is rejected.

## What it does not do

- It does **not** model node semantics. Opacity is the point: two nodes are
  interpreted independently even where a reader annotated them the same way.
- It does **not** verify the lift (that shave faithfully captured every operand /
  control decision). That is a lifting-correctness obligation, out of scope here.
- The base graph is **path-insensitive**, finite, and acyclic. Loops are
  summarized as one opaque node (mirroring shave's loop-is-the-atom bottoming
  out); path-sensitive guard layers and side-channel/timing facets are named
  deferred work in the plan.

## Usage

```ts
import { liftAtom, isWellFormed, usupp, graphNI, labelBySymbol } from "@yakcc/duc";

const graph = liftAtom(
  `import { readFileSync } from "node:fs";
   export function loadFlag(path: string): string { return readFileSync(path); }`,
);

isWellFormed(graph).wellFormed; // true — the unresolved read is a ♦-source, not a drop
usupp(graph, graph.obs[0]);      // [{ label: { reason: "foreign-import", symbol: "readFileSync", module: "node:fs" } }]

// Non-interference: does a secret reach a low observation?
const labeling = labelBySymbol(graph, new Set(["readFileSync"]), graph.obs);
graphNI(graph, labeling);        // { holds: false, leaks: [ ... ] }
```

## Scripts

- `pnpm build` — `tsc` to `dist/`.
- `pnpm test` / `pnpm test:coverage` — `vitest`.
- `pnpm lint` — `biome`.
