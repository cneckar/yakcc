// SPDX-License-Identifier: Apache-2.0
/**
 * The L2 record: what an L2 block's `smt_cert` artifact holds, and how a verifier re-checks it
 * (#1421 slice 6).
 *
 * @decision DEC-VERIFY-L2-RECORD-001
 * title: the record is the obligations' query hashes and outcomes; a re-check recomputes both
 * status: decided (#1421)
 * rationale:
 *   A record lists every obligation (id, kind, condition, outcome, BLAKE3 of its SMT-LIB2 query),
 *   the verdict, the encoder and solver versions, the budgets, the loop invariants (proof hints,
 *   kept here and not in spec.yak, so the spec's identity does not depend on them) and the callees
 *   assumed, with the roots their proofs are for. It is canonical JSON, so its bytes, hashed into
 *   proof_root through the manifest (DEC-PROOF-L2-VALIDATOR-001), are a function of its content.
 *
 *   A re-check runs the verification again from the block's source, contract and the record's
 *   hints, with the callees the verifier itself resolves. It is valid only when the verdict is
 *   proven both times, the encoder version is the same (a different encoder writes different
 *   queries), every callee is supplied with the same root and proof status, and every obligation
 *   has the same query hash and outcome. A different solver version is allowed: the queries are the
 *   same text, decided again by the verifier's own solver, which the attestation names.
 */
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { DucGraph } from "@yakcc/duc";
import type { Callee, L2Contract } from "./types.js";
import { ENCODER_VERSION, type L2Options, type L2Report, verifyL2 } from "./verify.js";

export const L2_RECORD_FORMAT = "yakcc-l2-record/1";

/** The SMT theories the queries use: floating point and bit vectors, no quantifiers. */
export const L2_THEORY: readonly string[] = ["QF_FPBV"];

export interface L2Record {
  readonly format: typeof L2_RECORD_FORMAT;
  readonly encoder: string;
  readonly solver: string;
  readonly budgets: { readonly timeoutMs: number; readonly rlimit: number };
  readonly loopInvariants: readonly (readonly string[])[];
  readonly callees: readonly {
    readonly key: string;
    readonly proven: boolean;
    readonly root?: string;
  }[];
  readonly verdict: L2Report["verdict"];
  readonly obligations: readonly {
    readonly id: string;
    readonly kind: string;
    readonly condition: string;
    readonly outcome: string;
    readonly queryHash?: string;
  }[];
}

/** The record of a report. */
export function l2Record(report: L2Report, contract: L2Contract): L2Record {
  return {
    format: L2_RECORD_FORMAT,
    encoder: report.encoder,
    solver: report.solver,
    budgets: report.budgets,
    loopInvariants: contract.loopInvariants ?? [],
    callees: report.callees,
    verdict: report.verdict,
    obligations: report.obligations.map((o) => ({
      id: o.id,
      kind: o.kind,
      condition: o.condition,
      outcome: o.outcome,
      ...(o.queryHash !== undefined ? { queryHash: o.queryHash } : {}),
    })),
  };
}

/** Canonical JSON: object keys sorted at every level, no whitespace, a final newline. */
export function encodeL2Record(record: L2Record): string {
  return `${canonical(record)}\n`;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** BLAKE3 of a record's bytes, hex: what an attestation names. */
export function l2RecordHash(text: string): string {
  return bytesToHex(blake3(new TextEncoder().encode(text)));
}

/** The manifest entry for a record, as validateProofManifestL2 requires it. */
export function l2Artifact(
  record: L2Record,
  path = "l2.json",
): { kind: "smt_cert"; path: string; checker: string; theory: string[] } {
  return {
    kind: "smt_cert",
    path,
    checker: `${record.encoder} ${record.solver}`,
    theory: [...L2_THEORY],
  };
}

/** The contract L2 reads, from a spec.yak (conditions as strings or `{ description }`). */
export function contractFromSpec(spec: {
  readonly inputs: readonly { readonly name: string; readonly type: string }[];
  readonly outputs: readonly { readonly type: string }[];
  readonly preconditions: readonly (string | { readonly description: string })[];
  readonly postconditions: readonly (string | { readonly description: string })[];
}): L2Contract {
  const text = (c: string | { readonly description: string }): string =>
    typeof c === "string" ? c : c.description;
  return {
    inputs: spec.inputs.map((p) => ({ name: p.name, type: p.type })),
    outputs: spec.outputs.map((p) => ({ type: p.type })),
    preconditions: spec.preconditions.map(text),
    postconditions: spec.postconditions.map(text),
  };
}

export interface L2Recheck {
  readonly valid: boolean;
  /** Why not, one line each; empty when valid. */
  readonly reasons: readonly string[];
  readonly report?: L2Report;
}

/**
 * Re-checks a record against the block it belongs to: the atom (source or graph), its contract,
 * and the callees the verifier resolves itself (by link key, with their roots and L2 status).
 */
export async function recheckL2(
  recordText: string,
  atom: string | DucGraph,
  contract: L2Contract,
  options: Pick<L2Options, "callees" | "replayTimeoutMs"> = {},
): Promise<L2Recheck> {
  let record: L2Record;
  try {
    record = JSON.parse(recordText) as L2Record;
  } catch (e) {
    return { valid: false, reasons: [`the record is not JSON: ${String(e)}`] };
  }
  const reasons: string[] = [];
  if (record.format !== L2_RECORD_FORMAT)
    reasons.push(`unknown record format ${String(record.format)}`);
  if (encodeL2Record(record) !== recordText) reasons.push("the record is not in canonical form");
  if (record.encoder !== ENCODER_VERSION) {
    reasons.push(
      `the record was made by ${record.encoder}; this verifier is ${ENCODER_VERSION}: record it again`,
    );
  }
  if (record.verdict !== "proven") reasons.push(`the record's verdict is ${record.verdict}`);
  const callees: Record<string, Callee> = { ...(options.callees ?? {}) };
  for (const c of record.callees ?? []) {
    const mine = callees[c.key];
    if (mine === undefined) reasons.push(`callee ${c.key} is not supplied`);
    else if (mine.root !== c.root || mine.proven !== c.proven) {
      reasons.push(
        `callee ${c.key}: the record assumed root ${c.root ?? "?"} (proven: ${c.proven}), the verifier has ${mine.root ?? "?"} (proven: ${mine.proven})`,
      );
    }
  }
  if (reasons.length > 0) return { valid: false, reasons };

  const report = await verifyL2(
    atom,
    { ...contract, loopInvariants: record.loopInvariants },
    { ...options, callees, timeoutMs: record.budgets.timeoutMs, rlimit: record.budgets.rlimit },
  );
  if (report.verdict !== "proven") reasons.push(`re-verified, the verdict is ${report.verdict}`);
  const mine = new Map(report.obligations.map((o) => [o.id, o]));
  if (mine.size !== record.obligations.length) {
    reasons.push(
      `the record has ${record.obligations.length} obligations; re-verified, ${mine.size}`,
    );
  }
  for (const o of record.obligations) {
    const m = mine.get(o.id);
    if (m === undefined) reasons.push(`obligation ${o.id} is not produced again`);
    else if (m.queryHash !== o.queryHash) reasons.push(`obligation ${o.id}: a different query`);
    else if (m.outcome !== o.outcome)
      reasons.push(`obligation ${o.id}: ${o.outcome} in the record, ${m.outcome} re-verified`);
  }
  return { valid: reasons.length === 0, reasons, report };
}
