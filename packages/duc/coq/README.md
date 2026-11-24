# @yakcc/duc — Coq proof harness (S6)

The **I1 trust anchor** of the DUC influence facet: a machine-checked,
**admit-free and axiom-free** mechanization of the Def-Use Calculus builder-run
core (epic [#1161](https://github.com/cneckar/yakcc/issues/1161), slice
[#1167](https://github.com/cneckar/yakcc/issues/1167);
`DEC-DUC-MECHANIZATION-001`). It mirrors the paper *Sound Influence under
Opacity* (§3, §4, §10) and the TypeScript engine in `../src`.

## Provisioning the prover

**The pin.** `flake.nix` takes nixpkgs from the NixOS 25.05 release tarball, and `flake.lock`
records its content hash. Its prover is **the Rocq Prover 9.0.0**, with Rocq's standard library
(`rocqPackages.stdlib`). No other library is needed.

```sh
nix develop -c make verify   # a shell with the pinned rocq + make, running the gate
nix build                    # the same gate, hermetically: fails on any proof hole
```

Both were run against this lock. `nix build` printed `verify: OK — whole module axiom-free; 15
headline theorem(s) admit-free`.

The gate also fails as it should under Rocq 9.0.0:
- **an `Admitted` lemma:** `verify: FAILED — the development relies on an axiom (proof hole): DUC.DUC_Soundness.yk_hole`;
- **an `Axiom`:** the same, naming it.

**Without Nix.** The development also checks under Coq 8.18 (`apt-get install coq`). That is what
`.github/workflows/duc-coq.yml` runs today. Rocq 9 reports two deprecations, `app_length` and
`From Coq`, which do not affect the result.

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
| Happens-before strict partial order under a ranking (Thm 3.2): `hb_strict_partial_order`, `hb_acyclic` | **mechanized, axiom-free** (`DUC_Transfer.v`) |
| Descent (Thm 3.3, ranking face): `HB_descent` — the ranking strictly increases along happens-before | **mechanized, axiom-free** (`DUC_Transfer.v`) |
| Ranking-renaming transfer (`influence_soundness_WF`): every WF graph has a well-ordered emission order (`linearize`) for which influence soundness holds | **mechanized, axiom-free** — *existential* (see below) |
| Independence of depmap / valuation from the choice of well-ordered order | **not mechanized, not claimed** — named open item |
| WF-A modelled as the *existence of a ranking*, not as a finiteness argument over arbitrary cycle-free graphs | **scope note** — acyclicity is taken in its ranking form |
| Term-model realization (Thm 4.6), least-sound (Cor 4.7), graph-NI ⇒ | **paper-proved**, not mechanized (exactly as in the source artifact) |
| The lifted model's wider constructs: branch regions, loops (with carries and invariant sources), iteration, closures as graphs of their own, async modes | **not mechanized**. They are in the trust base when the engine analyses them. A graph that uses any of them is not issued an I1 attestation (see below) |
| `sel` (a selection whose condition is an input, DUC Example 2.6) | **covered**: it is the model's opaque operation over its condition and both arms |

The soundness development models a builder-constructed graph in its emission
order as a straight-line, single-output program (multi-output nodes are WLOG a
family of single-output ones); evaluation and the source-dependency set are two
folds of the same shape, so `influence_soundness` is one joint induction — no
well-founded recursion, and the may-influence set is computed exactly. Nothing
is listed *mechanized* unless `make verify` passes it axiom-free.

## The verifier-as-block: I1 attestations (DEC-VERIFY-008)

`@yakcc/proof-verifier` (`src/duc.ts`) issues the influence facet's **I1** attestations from this
development.

- **The verifier's identity** is `ducVerifierHash`: a SHA-256 over the pinned contents of this
  directory (the three `.v` files, the Makefile, `_CoqProject`, `flake.nix`, `flake.lock`).
- **One run per verifier hash.** `runDucMechanization` runs `make verify` through the pin, and
  refuses any toolchain other than `rocq@9.0.0`.
- **What it signs.** `issueDucAttestation` signs, with the verifier's Ed25519 key, the tuple:
  - the block;
  - the hash of the `duc_influence` or `duc_ni` document;
  - the verifier hash and the toolchain;
  - the theorem the claim rests on: `influence_soundness_WF` or `graph_NI_sound`.

  `verifyAttestation` checks it.
- **When it signs.** Only for a graph inside the mechanized model: straight-line sources and opaque
  operations, put in a well-founded emission order (the order `linearize` proves exists). And only
  when the engine's attestation equals the one recomputed from `depmap`'s own definition, a
  transcription of `build` (`mechanizedDepmap`).
- **Otherwise** the block stays at I0, and the reason is returned.

**Trusted:**
- Rocq's kernel and the pinned toolchain;
- the transcription of `depmap`. It is a dozen lines; extracting it from Rocq would remove it from the trust base.

**Not trusted:** the engine that computed the attestation. Its result is checked.

## Files

- `DUC_Core.v` — the graph base, `push_op`, conservation + single-assignment, and
  the builder ⇒ WF theorems.
- `DUC_Soundness.v` — the induced valuation `eval`, the dependency set `depmap`,
  and influence soundness / non-influence / graph-NI(⇐) / usupp-⊆-sources.
- `DUC_Transfer.v` — happens-before as a strict partial order, descent, `linearize`, and the
  transfer `influence_soundness_WF` to every well-formed graph.
- `_CoqProject` — logical mapping (`-Q . DUC`) + source list.
- `Makefile` — `all` (compile), `verify` (the I1 gate), `clean`.
- `flake.nix`, `flake.lock` — the pinned toolchain (Rocq 9.0.0, NixOS 25.05).
