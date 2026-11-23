// SPDX-License-Identifier: MIT
/**
 * The DUC mechanization as a verifier-as-block (DEC-VERIFY-008), issuing I1 attestations for the
 * influence facet (#1167, DEC-DUC-MECHANIZATION-001, DEC-DUC-INFLUENCE-FACET-I-AXIS-001).
 *
 * The verifier is the Rocq development in `packages/duc/coq`. Its identity, the verifier hash, is a
 * SHA-256 over its pinned contents: the `.v` sources, the Makefile, `_CoqProject`, `flake.nix` and
 * `flake.lock`. `make verify`, run through the pinned toolchain, establishes once per verifier hash
 * that the development is admit-free and axiom-free (lazy re-verification, DEC-VERIFY-008).
 *
 * An attestation is issued at **I1** only for a graph the mechanized model covers. That model is a
 * straight-line program of sources and opaque operations (`DUC_Soundness.v`, `Instr`): no branch
 * region, loop, closure, or async mode. Before signing, the verifier recomputes the attestation
 * from the model's own definition. `mechanizedDepmap` transcribes the `build` / `depmap` fold, and
 * runs it over a well-founded emission order of the graph (the order `influence_soundness_WF`'s
 * `linearize` says exists). It signs only if the engine's attestation equals the recomputed one.
 *
 * What is trusted, the Table 2 boundary: Rocq's kernel, the pinned toolchain, and this
 * transcription of `depmap` (a dozen lines; extracting it from Rocq would remove it). The engine
 * that computed the attestation (`@yakcc/duc`) is not trusted: its result is checked.
 *
 * @module duc
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DucAttestation,
  type DucGraph,
  type DucInfluenceAttestation,
  type DucNiAttestation,
  validateDucAttestation,
} from "@yakcc/duc";
import { signPayload } from "./verifier.js";

/** The toolchain the mechanization is pinned to (packages/duc/coq/flake.lock: NixOS 25.05). */
export const DUC_PINNED_TOOLCHAIN = "rocq@9.0.0";

/** The files whose content is the verifier: what `make verify` checks, and how it is built. */
export const DUC_VERIFIER_FILES = [
  "DUC_Core.v",
  "DUC_Soundness.v",
  "DUC_Transfer.v",
  "Makefile",
  "_CoqProject",
  "flake.nix",
  "flake.lock",
] as const;

/** The mechanized theorem an I1 attestation of each kind rests on. */
export const DUC_THEOREM: Readonly<Record<DucAttestation["kind"], string>> = {
  duc_influence: "influence_soundness_WF",
  duc_ni: "graph_NI_sound",
};

const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

/** The verifier hash: SHA-256 over each pinned file's name and content hash, in a fixed order. */
export function ducVerifierHash(coqDir: string): string {
  const lines = DUC_VERIFIER_FILES.map((f) => `${f} ${sha256(readFileSync(join(coqDir, f)))}`);
  return sha256(`${lines.join("\n")}\n`);
}

/** The Makefile's CLAIMED list: the headline theorems `make verify` checks are axiom-free. */
export function claimedTheorems(makefile: string): string[] {
  const lines = makefile.split("\n");
  const at = lines.findIndex((l) => /^CLAIMED\s*:=/.test(l));
  if (at < 0) return [];
  const words: string[] = [];
  for (let i = at; i < lines.length; i++) {
    const line = (lines[i] as string).replace(/^CLAIMED\s*:=/, "");
    words.push(
      ...line
        .replace(/\\\s*$/, "")
        .split(/\s+/)
        .filter((w) => w !== ""),
    );
    if (!/\\\s*$/.test(line)) break;
  }
  return words;
}

/** What one run of the mechanization established. */
export interface DucMechanizationRun {
  readonly ok: boolean;
  readonly verifierHash: string;
  /** e.g. "rocq@9.0.0", read from the pinned toolchain's own `coqc --version`. */
  readonly toolchain: string;
  /** The headline theorems `make verify` found axiom-free (from the Makefile's CLAIMED list). */
  readonly theorems: readonly string[];
  /** The tail of the output, for a failure. */
  readonly output: string;
}

/**
 * Runs `make verify` through the pinned toolchain (`nix develop <copy> -c make verify`). The run
 * holds for the verifier hash it reports. A toolchain other than the pin is refused before any
 * proof is checked, as the Lean runner refuses a mismatched toolchain.
 */
export function runDucMechanization(coqDir: string, nix = "nix"): DucMechanizationRun {
  // The run checks a private copy of exactly the hashed files, so what is verified is what the
  // verifier hash names, and the source directory is left as it was.
  const work = mkdtempSync(join(tmpdir(), "duc-mechanization-"));
  for (const f of DUC_VERIFIER_FILES) copyFileSync(join(coqDir, f), join(work, f));
  const verifierHash = ducVerifierHash(work);
  const inShell = (cmd: readonly string[]) =>
    spawnSync(nix, ["develop", work, "-c", ...cmd], {
      cwd: work,
      encoding: "utf8",
      maxBuffer: 1 << 26,
    });
  const version = inShell(["coqc", "--version"]);
  const m = /The (Rocq Prover|Coq Proof Assistant), version ([0-9.]+)/.exec(String(version.stdout));
  const toolchain = m === null ? "unknown" : `${m[1] === "Rocq Prover" ? "rocq" : "coq"}@${m[2]}`;
  const claimed = claimedTheorems(readFileSync(join(work, "Makefile"), "utf8"));
  if (toolchain !== DUC_PINNED_TOOLCHAIN)
    return {
      ok: false,
      verifierHash,
      toolchain,
      theorems: [],
      output: `the toolchain is ${toolchain}, not the pinned ${DUC_PINNED_TOOLCHAIN}`,
    };
  const run = inShell(["make", "verify"]);
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const ok = run.status === 0 && /verify: OK/.test(output);
  return {
    ok,
    verifierHash,
    toolchain,
    theorems: ok ? claimed : [],
    output: output.split("\n").slice(-12).join("\n"),
  };
}

// ---------------------------------------------------------------------------------------------
// The mechanized model, transcribed (DUC_Soundness.v)
// ---------------------------------------------------------------------------------------------

/** `Instr`: a source defines one value; an opaque operation defines one value from its arguments. */
export type CoreInstr =
  | { readonly src: string }
  | { readonly out: string; readonly args: readonly string[] };

/** The node kinds that are the model's `ISrc`: 0-ary sources, whose value the valuation gives. */
const SOURCE_KINDS: ReadonlySet<string> = new Set([
  "param-source",
  "literal-source",
  "diamond-source",
]);
/**
 * The node kinds that are the model's `IOp`: an opaque operation, and a selection (`sel`), whose
 * condition is an ordinary input (control as data, DUC Example 2.6).
 */
const OP_KINDS: ReadonlySet<string> = new Set(["op", "sel"]);

/**
 * The graph as the mechanized model's program, in a well-founded emission order: every argument
 * is defined before it is used. Undefined when the graph is outside the model, with the reason.
 * A node with several outputs is a family of single-output instructions over the same arguments,
 * as the model assumes without loss of generality.
 */
export function coreProgram(
  g: DucGraph,
): { readonly program: CoreInstr[] } | { readonly outside: string } {
  if (g.mode !== undefined) return { outside: `an ${g.mode} function` };
  if ((g.branches?.length ?? 0) > 0) return { outside: "a branch region" };
  const pending: { readonly node: DucGraph["nodes"][number] }[] = [];
  for (const node of g.nodes) {
    if (node.region !== undefined) return { outside: "a node inside a region" };
    if (node.loop !== undefined || node.kind === "loop" || node.kind === "carry-source")
      return { outside: "a loop" };
    if (node.closure !== undefined) return { outside: "a closure" };
    if (!SOURCE_KINDS.has(node.kind) && !OP_KINDS.has(node.kind))
      return { outside: `a node of kind ${node.kind}` };
    pending.push({ node });
  }
  const defined = new Set<string>();
  const program: CoreInstr[] = [];
  // Kahn's order: emit a node once every argument it reads is defined.
  let progress = true;
  let rest = pending;
  while (rest.length > 0 && progress) {
    progress = false;
    const next: typeof pending = [];
    for (const p of rest) {
      const { node } = p;
      if (SOURCE_KINDS.has(node.kind)) {
        for (const o of node.outputs) {
          program.push({ src: o });
          defined.add(o);
        }
        progress = true;
      } else if (node.inputs.every((v) => defined.has(v))) {
        for (const o of node.outputs) {
          program.push({ out: o, args: [...node.inputs] });
          defined.add(o);
        }
        progress = true;
      } else next.push(p);
    }
    rest = next;
  }
  if (rest.length > 0)
    return { outside: "a use with no well-founded definition (not well-formed)" };
  return { program };
}

/** `depmap p`: `build` from the empty map. A source depends on itself, an op on its arguments' union. */
export function mechanizedDepmap(
  program: readonly CoreInstr[],
): ReadonlyMap<string, readonly string[]> {
  const m = new Map<string, readonly string[]>();
  for (const i of program) {
    if ("src" in i) m.set(i.src, [i.src]);
    else
      m.set(
        i.out,
        i.args.flatMap((a) => m.get(a) ?? []),
      );
  }
  return m;
}

/** The attestation the mechanized model gives a core graph, in the engine's shape. */
export function mechanizedAttestation(
  g: DucGraph,
  kind: DucAttestation["kind"],
  highSymbols: ReadonlySet<string> = new Set(),
): DucAttestation | { readonly outside: string } {
  const core = coreProgram(g);
  if ("outside" in core) return core;
  const dep = mechanizedDepmap(core.program);
  const reaches = (source: string, obs: string): boolean => (dep.get(obs) ?? []).includes(source);
  if (kind === "duc_influence") {
    const params = g.nodes.filter((n) => n.kind === "param-source");
    const out: DucInfluenceAttestation = {
      kind,
      version: 1,
      params: params.length,
      obs: g.obs.length,
      matrix: params.map((p) => g.obs.map((o) => reaches(p.outputs[0] as string, o))),
    };
    return out;
  }
  const high = g.nodes.filter(
    (n) =>
      n.kind === "diamond-source" && n.diamond !== undefined && highSymbols.has(n.diamond.symbol),
  );
  const holds = !high.some((h) => h.outputs.some((s) => g.obs.some((o) => reaches(s, o))));
  return {
    kind,
    version: 1,
    holds,
    highSymbols: [...highSymbols].sort(),
    leaks: [],
  } satisfies DucNiAttestation;
}

/** The part of an attestation the model decides: the matrix, or the NI verdict (not the witnesses). */
function decided(a: DucAttestation): unknown {
  return a.kind === "duc_influence"
    ? { kind: a.kind, params: a.params, obs: a.obs, matrix: a.matrix }
    : { kind: a.kind, holds: a.holds, highSymbols: [...a.highSymbols].sort() };
}

// ---------------------------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------------------------

/** The signed content of an I1 attestation (DEC-VERIFY-008's sidecar tuple, for the I-axis). */
export interface DucI1Payload {
  readonly kind: DucAttestation["kind"];
  readonly level: "I1";
  /** The block the attestation is about (its content address). */
  readonly block: string;
  /** SHA-256 of the attestation document's JSON. */
  readonly attestation_hash: string;
  readonly verifier_hash: string;
  readonly toolchain: string;
  readonly theorem: string;
  readonly timestamp: string;
}

export interface DucI1Attestation {
  readonly attestation: DucAttestation;
  readonly payload: string;
  readonly signature: string;
  readonly publicKey: string;
}

export type DucIssueResult =
  | { readonly issued: true; readonly signed: DucI1Attestation }
  | { readonly issued: false; readonly level: "I0"; readonly reason: string };

/**
 * Issue a signed I1 attestation, or say why the block stays at I0. Refuses when:
 * - the mechanization run did not pass;
 * - its verifier hash is not this mechanization's;
 * - its theorems do not include the one the kind rests on;
 * - the attestation is malformed;
 * - the graph is outside the mechanized model;
 * - the attestation disagrees with the model.
 */
export function issueDucAttestation(params: {
  readonly graph: DucGraph;
  readonly block: string;
  readonly attestation: DucAttestation;
  readonly run: DucMechanizationRun;
  readonly coqDir: string;
  readonly identity: { readonly privateKey: Uint8Array; readonly publicKey: Uint8Array };
  readonly timestamp?: string;
}): DucIssueResult {
  const { graph, block, attestation, run, coqDir, identity } = params;
  const no = (reason: string): DucIssueResult => ({ issued: false, level: "I0", reason });
  if (!run.ok) return no(`the mechanization did not verify: ${run.output}`);
  if (run.toolchain !== DUC_PINNED_TOOLCHAIN)
    return no(`the run used ${run.toolchain}, not ${DUC_PINNED_TOOLCHAIN}`);
  const verifierHash = ducVerifierHash(coqDir);
  if (run.verifierHash !== verifierHash)
    return no("the run verified a different mechanization (verifier hash)");
  const theorem = DUC_THEOREM[attestation.kind];
  if (!run.theorems.includes(theorem)) return no(`the run did not establish ${theorem}`);
  const invalid = validateDucAttestation(attestation);
  if (invalid !== null) return no(`the attestation is malformed: ${invalid}`);
  const model = mechanizedAttestation(
    graph,
    attestation.kind,
    attestation.kind === "duc_ni" ? new Set(attestation.highSymbols) : new Set(),
  );
  if ("outside" in model) return no(`the graph is outside the mechanized model: ${model.outside}`);
  if (JSON.stringify(decided(model)) !== JSON.stringify(decided(attestation)))
    return no("the attestation disagrees with the mechanized depmap");
  const payload: DucI1Payload = {
    kind: attestation.kind,
    level: "I1",
    block,
    attestation_hash: sha256(JSON.stringify(attestation)),
    verifier_hash: verifierHash,
    toolchain: run.toolchain,
    theorem,
    timestamp: params.timestamp ?? new Date().toISOString(),
  };
  const signed = signPayload(identity.privateKey, payload);
  return {
    issued: true,
    signed: { attestation, ...signed, publicKey: Buffer.from(identity.publicKey).toString("hex") },
  };
}
