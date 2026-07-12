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

Being honest about the machine-checked frontier, exactly as the paper is:

| Result | Status |
|---|---|
| Graph base: values, opaque nodes, def/use, `defined`, `conservation` (WF-C) | **mechanized** (`DUC_Core.v`) |
| `push_op` conservative builder step | **mechanized** |
| `push_preserves_conservation` (WF-C preserved by one builder step) | **mechanized, axiom-free** |
| `wf_run_preserves_conservation` (WF-C across an arbitrary builder run) | **mechanized, axiom-free** |
| `builder_from_empty_conserves` (every lift is closed under WF-C) | **mechanized, axiom-free** |
| Acyclicity (WF-A) via the emission index; `happens-before` order | *next* (`DUC_Core.v`, in progress) |
| Influence soundness — builder source form (Thm 4.5a) | *next* (`DUC_Transfer.v`) |
| Ranking-renaming transfer to every WF graph (`influence_soundness_WF`) | *next* (`DUC_Transfer.v`) |
| Term-model realization (Thm 4.6), least-sound (Cor 4.7), graph-NI ⇒ | **paper-proved**, not mechanized (as in the paper) |

The current commit establishes the harness and the conservation core; the
influence-soundness proofs are the S6 continuation. Nothing here claims more than
`coqc`/`coqchk` actually check — a theorem is listed *mechanized* only if
`make verify` passes with it axiom-free.

## Files

- `DUC_Core.v` — the graph base, `push_op`, and the conservation theorems.
- `_CoqProject` — logical mapping (`-Q . DUC`) + source list.
- `Makefile` — `all` (compile), `verify` (the I1 gate), `clean`.
- `flake.nix` — reproducible Nix toolchain (paper-parity; see note in the file).
