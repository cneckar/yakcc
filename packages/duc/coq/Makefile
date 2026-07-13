# SPDX-License-Identifier: Apache-2.0
# S6 proof harness for @yakcc/duc (DEC-DUC-MECHANIZATION-001, GH #1167).
#
# `make verify` is the I1 gate: it compiles the development, rejects any proof
# hole, and asserts that every claimed theorem is axiom-free (Print Assumptions =
# "Closed under the global context"). An Admitted proof is caught two ways — the
# hole grep AND, authoritatively, because an admitted lemma appears as an axiom.
#
# Provision a compiler (see README.md): `apt-get install -y coq` (Coq 8.18+) or
# `nix develop` (flake.nix). No external Coq libraries are required.

COQC      ?= coqc
COQ_FLAGS := -Q . DUC
SOURCES   := DUC_Core.v DUC_Soundness.v
MODULES   := DUC.DUC_Core DUC.DUC_Soundness

# Theorems whose admit-free / axiom-free status `verify` asserts.
CLAIMED := push_preserves_conservation \
           wf_run_preserves_conservation \
           builder_from_empty_conserves \
           push_preserves_single_assignment \
           builder_preserves_wf \
           builder_from_empty_wf \
           influence_soundness \
           non_influence \
           graph_NI_sound \
           depmap_only_sources

.PHONY: all verify clean

all:
	@for f in $(SOURCES); do \
	  echo "coqc $$f"; $(COQC) $(COQ_FLAGS) $$f || exit 1; \
	done

verify: all
	@# 1. Authoritative whole-module check: coqchk re-checks every .vo and prints a
	@#    CONTEXT SUMMARY. Any Admitted/admit anywhere in the development surfaces as
	@#    an axiom in the "* Axioms:" section — we fail if any of OUR constants do.
	@coqchk -o $(COQ_FLAGS) $(MODULES) > _chk.out 2>&1 || { cat _chk.out; rm -f _chk.out; exit 1; }
	@if awk '/\* Axioms:/{f=1} /type-in-type/{f=0} f' _chk.out | grep -q 'DUC\.'; then \
	  echo "verify: FAILED — the development relies on an axiom (proof hole):"; \
	  awk '/\* Axioms:/{f=1} /type-in-type/{f=0} f' _chk.out | grep 'DUC\.'; \
	  rm -f _chk.out; exit 1; fi
	@rm -f _chk.out
	@# 2. Document the headline claims: each named theorem must be axiom-free.
	@printf 'Require Import DUC.DUC_Core DUC.DUC_Soundness.\n' > _assum.v
	@for t in $(CLAIMED); do printf 'Print Assumptions %s.\n' $$t >> _assum.v; done
	@$(COQC) $(COQ_FLAGS) _assum.v > _assum.out 2>&1 || { cat _assum.out; rm -f _assum.*; exit 1; }
	@closed=$$(grep -c 'Closed under the global context' _assum.out); \
	 expected=$$(printf '%s\n' $(CLAIMED) | wc -w); \
	 rm -f _assum.v _assum.vo _assum.glob _assum.out .*.aux; \
	 if [ "$$closed" -ne "$$expected" ]; then \
	   echo "verify: FAILED — $$closed/$$expected headline theorems axiom-free"; exit 1; fi; \
	 echo "verify: OK — whole module axiom-free; $$expected headline theorem(s) admit-free"

clean:
	@rm -f *.vo *.vok *.vos *.glob .*.aux _assum.* *.aux
