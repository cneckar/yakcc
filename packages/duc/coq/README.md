# @yakcc/duc — Coq proof harness (S6)

The **I1 trust anchor** of the DUC influence facet: a machine-checked,
**admit-free and axiom-free** mechanization of the Def-Use Calculus builder-run
core (epic [#1161](https://github.com/cneckar/yakcc/issues/1161), slice
[#1167](https://github.com/cneckar/yakcc/issues/1167);
`DEC-DUC-MECHANIZATION-001`). It mirrors the paper *Sound Influence under
Opacity* (§3, §4, §10) and the TypeScript engine in `../src`.

## Provisioning a compiler (the only collateral needed)

No external Coq libraries are required — just a Coq/Rocq compiler. Either:

```sh
# Option A — apt (Coq 8.18, the toolchain this harness is developed & CI-checked against)
sudo apt-get install -y --no-install-recommends coq

# Option B — Nix (reproducible pin, paper-parity; run flake.lock first in a Nix env)
nix develop      # shell with coq + make
nix build        # runs `make verify` hermetically
```

## Checking the proofs

```sh
make verify
```

`make verify`:

1. compiles the development (`coqc`), then
2. runs **`coqchk`** over the whole module — an `Admitted`/`admit` *anywhere*
   surfaces as an axiom in the `CONTEXT SUMMARY`, and `verify` fails if any of
   our constants appear there (the authoritative admit-free gate), and
3. asserts each headline theorem is axiom-free
   (`Print Assumptions ... = Closed under the global context`).

CI runs this on every change under `packages/duc/coq/**` via
`.github/workflows/duc-coq.yml`.

## What is mechanized (the "Table 2" boundary)

Being honest about the machine-checked frontier, exactly as the paper is. Every
row marked *mechanized* is compiled by `coqc` and confirmed axiom-free by
`make verify` (`coqchk` whole-module + `Print Assumptions`).

| Result | Status |
|---|---|
| Graph base: values, opaque nodes, def/use, `defined`, `conservation` (WF-C) | **mechanized** (`DUC_Core.v`) |
| `push_op` conservative builder step | **mechanized** |
| `push_preserves_conservation` / `wf_run_preserves_conservation` (WF-C across an arbitrary builder run) | **mechanized, axiom-free** |
| Single-assignment (WF-A half) + `push_preserves_single_assignment` | **mechanized, axiom-free** |
| `builder_preserves_wf` / `builder_from_empty_wf` — builder ⇒ WF, both clauses (Thm 3.1 (ii)⇒(i)) | **mechanized, axiom-free** |
| **Influence soundness — source form (Thm 4.5a)**: the induced valuation of `F` is a function of `d` over `F`'s source-dependency set | **mechanized, axiom-free** (`DUC_Soundness.v`) |
| `non_influence` — a source outside the dependency set never changes `F` (Thm 4.5b face) | **mechanized, axiom-free** |
| `graph_NI_sound` — graph non-interference, sound direction (Thm 5.2 ⇐) | **mechanized, axiom-free** |
| `depmap_only_sources` — every dependency is a declared source (usupp ⊆ sources, Cor 4.10 face) | **mechanized, axiom-free** |
| Happens-before strict partial order (Thm 3.2); descent measure (Thm 3.3); ranking-renaming transfer to every WF graph (`influence_soundness_WF`) | *next* (order theory / `DUC_Transfer.v`) |
| Term-model realization (Thm 4.6), least-sound (Cor 4.7), graph-NI ⇒ | **paper-proved**, not mechanized (exactly as in the source artifact) |

The soundness development models a builder-constructed graph in its emission
order as a straight-line, single-output program (multi-output nodes are WLOG a
family of single-output ones); evaluation and the source-dependency set are two
folds of the same shape, so `influence_soundness` is one joint induction — no
well-founded recursion, and the may-influence set is computed exactly. Nothing
is listed *mechanized* unless `make verify` passes it axiom-free.

## Files

- `DUC_Core.v` — the graph base, `push_op`, conservation + single-assignment, and
  the builder ⇒ WF theorems.
- `DUC_Soundness.v` — the induced valuation `eval`, the dependency set `depmap`,
  and influence soundness / non-influence / graph-NI(⇐) / usupp-⊆-sources.
- `_CoqProject` — logical mapping (`-Q . DUC`) + source list.
- `Makefile` — `all` (compile), `verify` (the I1 gate), `clean`.
- `flake.nix` — reproducible Nix toolchain (paper-parity; see note in the file).
