(* SPDX-License-Identifier: Apache-2.0

   DUC_Soundness.v — influence soundness (DUC Thm 4.5a), mechanized admit-free.

   @decision DEC-DUC-MECHANIZATION-001 (wi-duc-influence-layer S6, GH #1167)

   The paper's headline mechanized result: the induced valuation of a value F is a
   function of the source valuation restricted to the sources that may-influence F
   (§4, Thm 4.5a, "source form"). We model the builder-constructed graph in its
   emission order as a straight-line, single-output program (each opaque node
   defines one value from earlier values; multi-output nodes are WLOG a family of
   single-output ones). Evaluation and the source-dependency set are then two
   folds with the SAME shape, so soundness is a single joint induction — no
   well-founded recursion, and the `may-influence` set is computed exactly. *)

Require Import List PeanoNat.
Import ListNotations.

(* ------------------------------------------------------------------ *)
(* Straight-line, single-output model (emission order).                *)
(* ------------------------------------------------------------------ *)

Definition Val := nat.   (* value names *)
Definition Op  := nat.   (* opaque operation identity (anonymous) *)

Inductive Instr :=
  | ISrc (out : Val)                        (* 0-ary source: value comes from the valuation d *)
  | IOp  (out : Val) (op : Op) (args : list Val). (* opaque op: out = op(args) *)

Definition Prog := list Instr.              (* head = earliest emitted *)

(* ------------------------------------------------------------------ *)
(* Environments and the induced valuation `eval` (DUC Def 4.3).        *)
(* An interpretation gives each opaque op a function of its inputs;     *)
(* sources read the valuation d. Reads of not-yet-defined values fall   *)
(* back to the initial env e (they never matter for a well-ordered      *)
(* program, but keeping eval total avoids option plumbing).             *)
(* ------------------------------------------------------------------ *)

Definition Env (V : Type) := Val -> V.

Definition upd {V} (e : Env V) (x : Val) (y : V) : Env V :=
  fun z => if Nat.eqb z x then y else e z.

Lemma upd_same : forall V (e : Env V) x y, upd e x y x = y.
Proof. intros; unfold upd; now rewrite Nat.eqb_refl. Qed.

Lemma upd_other : forall V (e : Env V) x y z, z <> x -> upd e x y z = e z.
Proof. intros V e x y z Hne; unfold upd; now rewrite (proj2 (Nat.eqb_neq z x) Hne). Qed.

Fixpoint eval {V} (d : Env V) (interp : Op -> list V -> V) (p : Prog) (e : Env V) : Env V :=
  match p with
  | [] => e
  | ISrc o :: rest      => eval d interp rest (upd e o (d o))
  | IOp o f args :: rest => eval d interp rest (upd e o (interp f (map e args)))
  end.

(* ------------------------------------------------------------------ *)
(* The source-dependency set (usupp): the sources F may-influence-from. *)
(* Same fold shape as eval, over a map Val -> list Val.                 *)
(* ------------------------------------------------------------------ *)

Definition DMap := Val -> list Val.

Definition updL (m : DMap) (x : Val) (l : list Val) : DMap :=
  fun z => if Nat.eqb z x then l else m z.

Lemma updL_same : forall m x l, updL m x l x = l.
Proof. intros; unfold updL; now rewrite Nat.eqb_refl. Qed.

Lemma updL_other : forall m x l z, z <> x -> updL m x l z = m z.
Proof. intros m x l z Hne; unfold updL; now rewrite (proj2 (Nat.eqb_neq z x) Hne). Qed.

Fixpoint build (p : Prog) (m : DMap) : DMap :=
  match p with
  | [] => m
  | ISrc o :: rest      => build rest (updL m o [o])
  | IOp o f args :: rest => build rest (updL m o (flat_map m args))
  end.

Definition depmap (p : Prog) : DMap := build p (fun _ => []).

(* ------------------------------------------------------------------ *)
(* Joint invariant: eval under d and d' agree on any value whose        *)
(* dependency set is a set d and d' agree on.                           *)
(* ------------------------------------------------------------------ *)

Definition agree {V} (d d' : Env V) (l : list Val) : Prop :=
  forall s, In s l -> d s = d' s.

Lemma eval_agrees_on_deps :
  forall (V : Type) (interp : Op -> list V -> V) (d d' : Env V) (p : Prog)
         (eD eD' : Env V) (m : DMap),
    (forall w, agree d d' (m w) -> eD w = eD' w) ->
    forall w, agree d d' (build p m w) ->
      eval d interp p eD w = eval d' interp p eD' w.
Proof.
  intros V interp d d' p.
  induction p as [| a rest IH]; intros eD eD' m Hinv w Hcond; simpl in *.
  - (* [] : eval is the accumulator; the dependency map is m. *)
    now apply Hinv.
  - destruct a as [o | o f args].
    + (* source o : value d o / d' o, deps [o]. *)
      apply IH with (m := updL m o [o]); [| exact Hcond].
      intros w' Hw'. destruct (Nat.eq_dec w' o) as [-> | Hne].
      * rewrite !upd_same. rewrite updL_same in Hw'. apply Hw'. now left.
      * rewrite !upd_other by exact Hne. apply Hinv.
        rewrite updL_other in Hw' by exact Hne. exact Hw'.
    + (* op o : value interp f (map _ args), deps = union of arg deps. *)
      apply IH with (m := updL m o (flat_map m args)); [| exact Hcond].
      intros w' Hw'. destruct (Nat.eq_dec w' o) as [-> | Hne].
      * rewrite !upd_same. f_equal.
        rewrite updL_same in Hw'.
        apply map_ext_in. intros a Ha. apply Hinv.
        intros s Hs. apply Hw'. apply in_flat_map. now exists a.
      * rewrite !upd_other by exact Hne. apply Hinv.
        rewrite updL_other in Hw' by exact Hne. exact Hw'.
Qed.

(* ------------------------------------------------------------------ *)
(* Influence soundness (DUC Thm 4.5a): the induced valuation of F is a  *)
(* function of d restricted to F's source-dependency set. Two source    *)
(* valuations agreeing on `depmap p F` induce the same value at F,       *)
(* under EVERY interpretation of the opaque ops.                        *)
(* ------------------------------------------------------------------ *)

Theorem influence_soundness :
  forall (V : Type) (interp : Op -> list V -> V) (p : Prog) (d d' : Env V) (e : Env V) (F : Val),
    agree d d' (depmap p F) ->
    eval d interp p e F = eval d' interp p e F.
Proof.
  intros V interp p d d' e F Hagree.
  apply (eval_agrees_on_deps V interp d d' p e e (fun _ => [])); [| exact Hagree].
  (* base invariant: the empty dependency map forces nothing, and e = e. *)
  intros w _. reflexivity.
Qed.

(* Pointwise non-influence (the contrapositive face, DUC Thm 4.5b-style):
   a source outside F's dependency set never changes F's value. *)
Corollary non_influence :
  forall (V : Type) (interp : Op -> list V -> V) (p : Prog) (d : Env V) (e : Env V) (F s : Val) (y : V),
    ~ In s (depmap p F) ->
    eval d interp p e F = eval (upd d s y) interp p e F.
Proof.
  intros V interp p d e F s y Hnin.
  apply influence_soundness.
  intros s' Hs'. unfold upd. destruct (Nat.eqb s' s) eqn:Hb.
  - apply Nat.eqb_eq in Hb. subst s'. contradiction.
  - reflexivity.
Qed.

(* ------------------------------------------------------------------ *)
(* Graph non-interference, sound direction (DUC Thm 5.2, <=). If no      *)
(* high-labelled source may-influence an observation F, then F is        *)
(* non-interferent: varying the high sources (while low sources agree)    *)
(* never changes F, under EVERY interpretation. This is the mechanized    *)
(* (<=) half of the graph-NI iff — the S4 verdict, proved here as a        *)
(* corollary of influence soundness.                                      *)
(* ------------------------------------------------------------------ *)

Theorem graph_NI_sound :
  forall (V : Type) (interp : Op -> list V -> V) (p : Prog) (H : Val -> bool)
         (d d' : Env V) (e : Env V) (F : Val),
    (forall s, In s (depmap p F) -> H s = false) ->  (* no high source influences F *)
    (forall s, H s = false -> d s = d' s) ->         (* d, d' agree on every low source *)
    eval d interp p e F = eval d' interp p e F.
Proof.
  intros V interp p H d d' e F Hno Hlow.
  apply influence_soundness.
  intros s Hs. apply Hlow. now apply Hno.
Qed.

(* ------------------------------------------------------------------ *)
(* Observability face: every dependency is a declared source (usupp of  *)
(* a value contains only sources, DUC Cor 4.10).                         *)
(* ------------------------------------------------------------------ *)

Definition is_source (p : Prog) (s : Val) : Prop := In (ISrc s) p.

(* Ambient source program `Q` is decoupled from the fold's `p` so the conclusion
   does not grow with the induction. *)
Lemma build_deps_are_sources :
  forall (Q : Prog) (p : Prog) (m : DMap),
    (forall o, In (ISrc o) p -> In (ISrc o) Q) ->
    (forall w s, In s (m w) -> In (ISrc s) Q) ->
    forall w s, In s (build p m w) -> In (ISrc s) Q.
Proof.
  intros Q p. induction p as [| a rest IH]; intros m Hp Hm w s Hin; simpl in *.
  - eapply Hm; eauto.
  - destruct a as [o | o f args].
    + eapply (IH (updL m o [o])).
      * intros o0 Ho0. apply Hp. now right.
      * intros w' s' Hs'. destruct (Nat.eq_dec w' o) as [-> | Hne].
        -- rewrite updL_same in Hs'. destruct Hs' as [<- | []]. apply Hp. now left.
        -- rewrite updL_other in Hs' by exact Hne. eapply Hm; eauto.
      * exact Hin.
    + eapply (IH (updL m o (flat_map m args))).
      * intros o0 Ho0. apply Hp. now right.
      * intros w' s' Hs'. destruct (Nat.eq_dec w' o) as [-> | Hne].
        -- rewrite updL_same in Hs'. apply in_flat_map in Hs' as [aa [_ Haa]]. eapply Hm; eauto.
        -- rewrite updL_other in Hs' by exact Hne. eapply Hm; eauto.
      * exact Hin.
Qed.

Theorem depmap_only_sources :
  forall p F s, In s (depmap p F) -> is_source p s.
Proof.
  intros p F s Hin. unfold is_source, depmap in *.
  eapply (build_deps_are_sources p p (fun _ => [])); [ now auto | | exact Hin ].
  intros w s' [].
Qed.
