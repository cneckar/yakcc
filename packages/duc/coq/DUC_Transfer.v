(* SPDX-License-Identifier: Apache-2.0

   DUC_Transfer.v — order theory and the ranking-renaming transfer (DUC Thm 3.2,
   Thm 3.3, and the transfer of influence soundness to every well-formed graph).

   @decision DEC-DUC-MECHANIZATION-001 (wi-duc-influence-layer S6, GH #1167)

   DUC_Soundness.v proves influence soundness for a straight-line PROGRAM, the
   emission order of a builder run. This file lifts that to a GRAPH: an unordered
   list of single-output instructions. Three results:

   1. Happens-before (Thm 3.2): under a ranking (the acyclicity witness, WF-A),
      the direct def-use relation's transitive closure is a strict partial order.
   2. Descent (Thm 3.3, the ranking face): the ranking strictly increases along
      HB, so an HB-cycle is impossible.
   3. Transfer (influence_soundness_WF): every well-formed graph has a well-ordered
      emission order, a permutation of the graph in which every use is defined
      earlier, and influence soundness holds for that order.

   Honest scope. WF-A is modelled as the EXISTENCE of a ranking, not as a
   finiteness argument over an arbitrary cycle-free graph. The transfer is
   EXISTENTIAL: we prove that a well-ordered emission order exists and that
   soundness holds for it. We do NOT prove that the dependency set (depmap) is
   independent of which well-ordered order is chosen. That independence is a
   named open item (see coq/README.md); it is not claimed here. *)

Require Import List PeanoNat Lia.
Require Import Coq.Sorting.Permutation.
Import ListNotations.
Require Import DUC.DUC_Soundness.

(* ------------------------------------------------------------------ *)
(* Graphs: unordered lists of single-output instructions.              *)
(* ------------------------------------------------------------------ *)

Definition args_of (i : Instr) : list Val :=
  match i with ISrc _ => [] | IOp _ _ args => args end.

Definition out_of (i : Instr) : Val :=
  match i with ISrc o => o | IOp o _ _ => o end.

Definition Graph := list Instr.

(* Closed under E: every use is an external value (in E) or defined in g. *)
Definition closed (E : list Val) (g : Graph) : Prop :=
  forall i, In i g -> forall a, In a (args_of i) ->
    In a E \/ exists j, In j g /\ out_of j = a.

(* Ranking: a use's value is ranked strictly below the value it feeds. *)
Definition ranked (r : Val -> nat) (g : Graph) : Prop :=
  forall i, In i g -> forall a, In a (args_of i) -> r a < r (out_of i).

(* Single assignment: every value is the output of at most one instruction. *)
Definition single (g : Graph) : Prop := NoDup (map out_of g).

(* Well-formed: conservation (WF-C), single assignment (WF-A, value half),
   and acyclicity via a ranking (WF-A, order half). *)
Definition WF (g : Graph) : Prop :=
  closed [] g /\ single g /\ exists r, ranked r g.

(* ------------------------------------------------------------------ *)
(* Happens-before (DUC Thm 3.2).                                       *)
(* ------------------------------------------------------------------ *)

(* b uses a directly: some instruction of g outputs b and takes a as input. *)
Definition uses (g : Graph) (a b : Val) : Prop :=
  exists i, In i g /\ out_of i = b /\ In a (args_of i).

Inductive HB (g : Graph) : Val -> Val -> Prop :=
  | HB_step : forall a b, uses g a b -> HB g a b
  | HB_trans : forall a b c, HB g a b -> HB g b c -> HB g a c.

(* Descent (Thm 3.3): the ranking strictly increases along happens-before. *)
Lemma HB_descent : forall g r, ranked r g -> forall a b, HB g a b -> r a < r b.
Proof.
  intros g r Hr a b H.
  induction H as [a b Hu | a b c Hab IH1 Hbc IH2].
  - destruct Hu as [i [Hi [Hout Hin]]]. subst b. exact (Hr i Hi a Hin).
  - lia.
Qed.

(* Thm 3.2: under a ranking, happens-before is irreflexive and transitive,
   i.e. a strict partial order. *)
Theorem hb_strict_partial_order :
  forall g r, ranked r g ->
    (forall a, ~ HB g a a) /\ (forall a b c, HB g a b -> HB g b c -> HB g a c).
Proof.
  intros g r Hr. split.
  - intros a Hloop. pose proof (HB_descent g r Hr a a Hloop). lia.
  - intros a b c Hab Hbc. exact (HB_trans g a b c Hab Hbc).
Qed.

(* Corollary: a happens-before cycle is impossible under a ranking. *)
Corollary hb_acyclic :
  forall g r, ranked r g -> forall a, ~ HB g a a.
Proof. intros g r Hr. exact (proj1 (hb_strict_partial_order g r Hr)). Qed.

(* ------------------------------------------------------------------ *)
(* Well-ordered emission orders.                                       *)
(* ------------------------------------------------------------------ *)

(* p is well-ordered over the already-available set E when every instruction's
   inputs are in E or are outputs of an earlier instruction of p. This is the
   condition under which eval never reads an undefined value. *)
Fixpoint well_ordered (E : list Val) (p : Prog) : Prop :=
  match p with
  | [] => True
  | i :: rest =>
      (forall a, In a (args_of i) -> In a E) /\ well_ordered (out_of i :: E) rest
  end.

(* A nonempty list has an element whose ranked output is minimal. *)
Lemma exists_min (r : Val -> nat) (g : Graph) :
  g <> [] -> exists i, In i g /\ forall j, In j g -> r (out_of i) <= r (out_of j).
Proof.
  induction g as [| x xs IH]; intros Hne.
  - exfalso. apply Hne. reflexivity.
  - destruct xs as [| y ys].
    + exists x. split; [left; reflexivity |].
      intros j [Hj | Hj]; [subst j; lia | contradiction].
    + destruct (IH (ltac:(intro H; discriminate))) as [m [Hm Hmin]].
      destruct (Nat.le_gt_cases (r (out_of x)) (r (out_of m))) as [Hle | Hlt].
      * exists x. split; [left; reflexivity |].
        intros j [Hj | Hj]; [subst j; lia |].
        pose proof (Hmin j Hj). lia.
      * exists m. split; [right; exact Hm |].
        intros j [Hj | Hj]; [subst j; lia |].
        pose proof (Hmin j Hj). lia.
Qed.

(* Linearization: every closed, ranked graph has a well-ordered permutation.
   Induction on size: the minimal-rank instruction has no input defined inside
   the remaining graph, so it can be emitted first; the rest is closed under the
   enlarged available set. *)
Lemma linearize :
  forall (r : Val -> nat) (n : nat) (g : Graph) (E : list Val),
    length g = n -> closed E g -> ranked r g ->
    exists p, Permutation p g /\ well_ordered E p.
Proof.
  intros r n. induction n as [| n IH]; intros g E Hlen Hclosed Hrank.
  - destruct g as [| x xs]; [| discriminate Hlen].
    exists []. split; [apply perm_nil | exact I].
  - assert (Hne : g <> []) by (intro H; subst g; simpl in Hlen; discriminate).
    destruct (exists_min r g Hne) as [i [Hi Hmin]].
    apply In_split in Hi as [l1 [l2 Hg]].
    subst g.
    assert (Hl : length (l1 ++ l2) = n).
    { rewrite !app_length in Hlen. simpl in Hlen. rewrite app_length. lia. }
    assert (Hsub : forall x, In x (l1 ++ l2) -> In x (l1 ++ i :: l2)).
    { intros x Hx. apply in_app_or in Hx. apply in_or_app.
      destruct Hx as [H | H]; [left; exact H | right; right; exact H]. }
    (* (a) the minimal instruction's inputs are all already available. *)
    assert (Hargs : forall a, In a (args_of i) -> In a E).
    { intros a Ha.
      assert (Hin : In i (l1 ++ i :: l2)) by (apply in_or_app; right; left; reflexivity).
      destruct (Hclosed i Hin a Ha) as [HE | [k [Hk Hout]]].
      - exact HE.
      - pose proof (Hrank i Hin a Ha) as H1.
        pose proof (Hmin k Hk) as H2.
        rewrite Hout in H2. lia. }
    (* (b) the rest is closed under the enlarged available set. *)
    assert (Hcl : closed (out_of i :: E) (l1 ++ l2)).
    { intros j Hj a Ha.
      destruct (Hclosed j (Hsub j Hj) a Ha) as [HE | [k [Hk Hout]]].
      - left. apply in_cons. exact HE.
      - apply in_app_or in Hk. destruct Hk as [Hk1 | Hk2].
        + right. exists k. split; [apply in_or_app; left; exact Hk1 | exact Hout].
        + destruct Hk2 as [-> | Hk2].
          * left. subst a. apply in_eq.
          * right. exists k. split; [apply in_or_app; right; exact Hk2 | exact Hout]. }
    (* (c) the rest is still ranked. *)
    assert (Hrk : ranked r (l1 ++ l2)).
    { intros j Hj a Ha. apply Hrank; [apply Hsub; exact Hj | exact Ha]. }
    destruct (IH (l1 ++ l2) (out_of i :: E) Hl Hcl Hrk) as [p' [Hp' Hwo']].
    exists (i :: p'). split.
    + eapply perm_trans.
      * apply perm_skip. exact Hp'.
      * apply Permutation_middle.
    + split; [exact Hargs | exact Hwo'].
Qed.

(* ------------------------------------------------------------------ *)
(* The transfer (ranking-renaming): influence soundness for every WF graph. *)
(* ------------------------------------------------------------------ *)

(* Every well-formed graph admits a well-ordered emission order, and influence
   soundness (DUC Thm 4.5a, from DUC_Soundness.v) holds for that order: a source
   valuation that agrees on the order's dependency set induces the same value at
   F, under every interpretation of the opaque operations. *)
Theorem influence_soundness_WF :
  forall g, WF g ->
    exists p, Permutation p g /\ well_ordered [] p /\
      forall (V : Type) (interp : Op -> list V -> V) (d d' : Env V) (e : Env V) (F : Val),
        agree d d' (depmap p F) -> eval d interp p e F = eval d' interp p e F.
Proof.
  intros g [Hc [_ [r Hr]]].
  destruct (linearize r (length g) g [] eq_refl Hc Hr) as [p [Hperm Hwo]].
  exists p. split; [exact Hperm |]. split; [exact Hwo |].
  intros V interp d d' e F Hagree.
  exact (influence_soundness V interp p d d' e F Hagree).
Qed.
