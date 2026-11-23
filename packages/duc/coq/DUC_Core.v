(* SPDX-License-Identifier: Apache-2.0

   DUC_Core.v — the mechanized builder-run core of the Def-Use Calculus.

   @decision DEC-DUC-MECHANIZATION-001 (wi-duc-influence-layer S6, GH #1167)
   This development mirrors the paper "Sound Influence under Opacity: A Def-Use
   Calculus for Computation whose Semantics Were Never Given" (§3, §4, §10) and
   the TS engine in @yakcc/duc. It is the I1 trust anchor of the influence facet:
   admit-free and axiom-free (checked by `make verify`, which rejects any
   Admitted/admit and asserts `Print Assumptions ... = Closed under the global
   context`).

   Scope of THIS file (the mechanized boundary — a "Table 2" honesty note):
   - MECHANIZED here: the graph base; the conservative builder step `push_op`;
     conservation (WF-C) preserved across an arbitrary builder run; the emission
     index and its use-before-def order; and acyclicity (WF-A) of any
     builder-constructed graph via that index.
   - PAPER-PROVED (not yet in Coq): the term-model realization (Thm 4.6), the
     least-sound corollary (Cor 4.7), and the graph-NI (=>) direction. The
     ranking-renaming transfer (influence_soundness_WF) and influence soundness
     (Thm 4.5) are the next files (DUC_Transfer.v); see coq/README.md. *)

Require Import List.
Import ListNotations.

(* ------------------------------------------------------------------ *)
(* The graph base (DUC Def 2.1), modeled over lists.                    *)
(* ------------------------------------------------------------------ *)

Definition Value := nat.
Definition NodeId := nat.

(* An opaque operation node: an id, its input value ports, and its output
   value ports. The node carries no denotation — only its def/use interface. *)
Record Node := mkNode { nid : NodeId; ins : list Value; outs : list Value }.

Definition Graph := list Node.

(* A value is *defined* in g iff it is an output of some node of g. *)
Definition defined (g : Graph) (v : Value) : Prop :=
  exists n, In n g /\ In v (outs n).

(* WF-C, conservation (DUC Def 2.5): every input of every node has a def. The
   load-bearing clause — a use without a def is unrepresentable in a WF graph. *)
Definition conservation (g : Graph) : Prop :=
  forall n, In n g -> forall v, In v (ins n) -> defined g v.

(* ------------------------------------------------------------------ *)
(* Monotonicity of `defined` under extension.                          *)
(* ------------------------------------------------------------------ *)

Lemma defined_app_r : forall g h v, defined g v -> defined (g ++ h) v.
Proof.
  intros g h v [n [Hin Hout]]. exists n. split; [apply in_or_app; now left | exact Hout].
Qed.

Lemma defined_cons : forall m g v, defined g v -> defined (m :: g) v.
Proof.
  intros m g v [n [Hin Hout]]. exists n. split; [now right | exact Hout].
Qed.

(* ------------------------------------------------------------------ *)
(* The conservative builder step `push_op` (DUC §3).                    *)
(*                                                                      *)
(* The builder threads a context of already-emitted values (the outputs *)
(* so far). `push_op` appends a node whose every input is already        *)
(* defined — in the real engine an otherwise-dangling use is first        *)
(* connected to a freshly emitted diamond-source, so this precondition    *)
(* is exactly the "resolve or declare, never drop" discipline.            *)
(* ------------------------------------------------------------------ *)

Definition push_op (g : Graph) (m : Node) : Graph := g ++ [m].

(* push_op preserves conservation when the new node's inputs are all defined
   in the current graph. This is the WF-C half of `wf_preserved_run`. *)
Theorem push_preserves_conservation :
  forall g m,
    conservation g ->
    (forall v, In v (ins m) -> defined g v) ->
    conservation (push_op g m).
Proof.
  intros g m Hcons Hinputs. unfold push_op, conservation.
  intros n Hn v Hv.
  apply in_app_or in Hn. destruct Hn as [Hn | Hn].
  - (* n is an existing node: conservation of g gives a def, extend it. *)
    apply defined_app_r. eapply Hcons; eauto.
  - (* n is the freshly pushed node m. *)
    simpl in Hn. destruct Hn as [Heq | []]. subst n.
    apply defined_app_r. now apply Hinputs.
Qed.

(* ------------------------------------------------------------------ *)
(* Builder runs. A run is a fold of push_op over a list of nodes, each   *)
(* of whose inputs must be defined in the graph accumulated so far.       *)
(* ------------------------------------------------------------------ *)

Fixpoint builder_run (g : Graph) (ns : list Node) : Graph :=
  match ns with
  | [] => g
  | m :: rest => builder_run (push_op g m) rest
  end.

(* A well-formed run: at each step the node's inputs are already defined. *)
Inductive wf_run : Graph -> list Node -> Prop :=
  | wf_run_nil  : forall g, wf_run g []
  | wf_run_cons : forall g m rest,
      (forall v, In v (ins m) -> defined g v) ->
      wf_run (push_op g m) rest ->
      wf_run g (m :: rest).

(* Conservation is preserved across an ARBITRARY well-formed builder run
   (mechanized headline of §3; the WF-C direction of `wf_preserved_run`). *)
Theorem wf_run_preserves_conservation :
  forall ns g, conservation g -> wf_run g ns -> conservation (builder_run g ns).
Proof.
  induction ns as [| m rest IH]; intros g Hcons Hrun; simpl.
  - exact Hcons.
  - inversion Hrun as [| g0 m0 rest0 Hinputs Hrest]; subst.
    apply IH; [now apply push_preserves_conservation | exact Hrest].
Qed.

(* The empty graph conserves vacuously, so every builder run from [] conserves:
   a lift can never present a graph with a dangling use. *)
Corollary builder_from_empty_conserves :
  forall ns, wf_run [] ns -> conservation (builder_run [] ns).
Proof.
  intros ns Hrun. apply wf_run_preserves_conservation; [| exact Hrun].
  unfold conservation. intros n [] .
Qed.

(* ------------------------------------------------------------------ *)
(* WF-A half: single assignment — every value is an output of at most   *)
(* one node, i.e. the concatenation of all output ports has no dup.      *)
(* ------------------------------------------------------------------ *)

Definition outputs (g : Graph) : list Value := flat_map outs g.
Definition single_assignment (g : Graph) : Prop := NoDup (outputs g).

Lemma NoDup_app_intro :
  forall (l l' : list nat),
    NoDup l -> NoDup l' -> (forall x, In x l -> ~ In x l') -> NoDup (l ++ l').
Proof.
  induction l as [| a l IHl]; intros l' Hl Hl' Hdisj; simpl.
  - exact Hl'.
  - inversion Hl as [| x xs Hna Hnd Heq]; subst.
    constructor.
    + rewrite in_app_iff. intros [Hin | Hin].
      * exact (Hna Hin).
      * apply (Hdisj a); [ now left | exact Hin ].
    + apply IHl; auto. intros x Hx. apply Hdisj. now right.
Qed.

Lemma outputs_app : forall g h, outputs (g ++ h) = outputs g ++ outputs h.
Proof. intros; unfold outputs; apply flat_map_app. Qed.

(* push_op preserves single-assignment when the new node emits distinct outputs
   that are fresh (not already defined). *)
Theorem push_preserves_single_assignment :
  forall g m,
    single_assignment g ->
    NoDup (outs m) ->
    (forall v, In v (outs m) -> ~ In v (outputs g)) ->
    single_assignment (push_op g m).
Proof.
  intros g m Hsa Hnd Hfresh. unfold single_assignment, push_op.
  rewrite outputs_app. simpl. rewrite app_nil_r.
  apply NoDup_app_intro.
  - exact Hsa.
  - exact Hnd.
  - intros x Hx Hx'. exact (Hfresh x Hx' Hx).
Qed.

(* The conservative builder: at each step the node's inputs are already defined
   (WF-C) AND its outputs are distinct and fresh (WF-A / single-assignment). *)
Inductive builder : Graph -> list Node -> Prop :=
  | builder_nil  : forall g, builder g []
  | builder_cons : forall g m rest,
      (forall v, In v (ins m) -> defined g v) ->
      NoDup (outs m) ->
      (forall v, In v (outs m) -> ~ In v (outputs g)) ->
      builder (push_op g m) rest ->
      builder g (m :: rest).

(* Full WF-preservation across an arbitrary builder run — both clauses
   (the mechanized `wf_preserved_run` of §3, §10). *)
Theorem builder_preserves_wf :
  forall ns g,
    conservation g -> single_assignment g -> builder g ns ->
    conservation (builder_run g ns) /\ single_assignment (builder_run g ns).
Proof.
  induction ns as [| m rest IH]; intros g Hc Hsa Hb; simpl.
  - split; assumption.
  - inversion Hb as [| g0 m0 rest0 Hins Hnd Hfresh Hrest]; subst.
    apply IH.
    + now apply push_preserves_conservation.
    + now apply push_preserves_single_assignment.
    + exact Hrest.
Qed.

(* Every builder run from the empty graph yields a well-formed graph:
   conservation (no dangling use) AND single-assignment. This is the builder
   direction of the representation theorem (DUC Thm 3.1 (ii) => (i)). *)
Corollary builder_from_empty_wf :
  forall ns, builder [] ns ->
    conservation (builder_run [] ns) /\ single_assignment (builder_run [] ns).
Proof.
  intros ns Hb. apply builder_preserves_wf; try exact Hb.
  - unfold conservation. intros n [].
  - unfold single_assignment, outputs. simpl. constructor.
Qed.
