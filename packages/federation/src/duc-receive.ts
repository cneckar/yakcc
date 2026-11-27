// SPDX-License-Identifier: MIT
// @decision DEC-DUC-RECEIVE-001 (#1291): a registry receives DUC implementations only through the
// receiver's checks (checkSharedSubmission, DEC-DUC-TRUST-MODEL-001). The store the checks consult
// is the registry: the contracts it has implementations of, and their stored graphs and evidence.
// An implementation that is not refused is stored under its contract and root with the trust level
// it reached, its evidence and base set, and its contract; a refused one is not stored. Module
// records of the submission are stored by their root.

import { type SpecYak, canonicalize } from "@yakcc/contracts";
import { ECMASCRIPT, recordRoot, retrievalSignature, unpackGraph } from "@yakcc/duc";
import type { DucImplementationRow, Registry } from "@yakcc/registry";
import {
  type ConformanceVector,
  type ModuleRecord,
  type ReceiverOptions,
  type ReceiverStore,
  type SharedImplementation,
  type StoredImplementation,
  type SubmissionVerdict,
  checkSharedSubmission,
} from "./duc-submission.js";

const decoder = new TextDecoder();

/** The canonical JSON text of a value, as yakcc canonicalizes contracts. */
function canonicalText(value: unknown): string {
  return decoder.decode(canonicalize(value as Parameters<typeof canonicalize>[0]));
}

/**
 * The receiver's view of a registry for a batch: every contract the registry has implementations
 * or blocks of, and the stored implementations of the contracts the batch names (its own and those
 * its links call), with their graphs and evidence.
 */
export async function receiverStoreOf(
  registry: Registry,
  batch: readonly SharedImplementation[],
): Promise<ReceiverStore> {
  const contracts = new Set<string>([
    ...(await registry.enumerateDucSpecs()),
    ...(await registry.enumerateSpecs()),
  ]);
  const wanted = new Set<string>();
  for (const impl of batch) {
    wanted.add(impl.specHash);
    for (const l of impl.links) wanted.add(l.spec);
  }
  const stored = new Map<string, StoredImplementation[]>();
  for (const spec of wanted) {
    const list: StoredImplementation[] = [];
    for (const root of await registry.listDucImplementations(spec)) {
      const row = await registry.getDucImplementation(spec, root);
      if (row === null) continue;
      try {
        list.push({
          identity: row.graphIdentity,
          graph: unpackGraph({
            formatVersion: row.formatVersion,
            structure: row.structure,
            links: row.links as unknown as Parameters<typeof unpackGraph>[0]["links"],
          }),
          evidence:
            row.evidence !== null && row.evidence !== undefined
              ? (JSON.parse(row.evidence) as ConformanceVector[])
              : [],
        });
      } catch {
        // A stored graph this reader cannot decode is not evidence for or against anything.
      }
    }
    stored.set(spec, list);
  }
  return { contracts, implementationsOf: (spec) => stored.get(spec) ?? [] };
}

/** The row an admitted implementation is stored as. */
export function ducRowOf(
  impl: SharedImplementation,
  level: NonNullable<DucImplementationRow["trustLevel"]>,
): DucImplementationRow {
  const graph = unpackGraph({
    formatVersion: impl.formatVersion,
    structure: impl.structure,
    links: impl.links,
  });
  return {
    specHash: impl.specHash,
    specCanonicalBytes: canonicalize(impl.spec as unknown as Parameters<typeof canonicalize>[0]),
    graphIdentity: impl.identity,
    graphRoot: impl.root,
    formatVersion: impl.formatVersion,
    lifterVersion: impl.lifterVersion ?? 0,
    structure: impl.structure,
    links: impl.links,
    trustLevel: level,
    evidence: canonicalText(impl.evidence),
    baseSet: canonicalText(impl.baseSet),
    signature: retrievalSignature(graph),
  };
}

/** A module record's root: BLAKE3 of its canonical JSON. */
export function moduleRootOf(module: ModuleRecord): string {
  return recordRoot(canonicalText(module));
}

/**
 * Receive a submission into a registry: run the receiver's checks against what the registry holds,
 * store each implementation that is not refused with the trust level it reached, and the module
 * records. Returns the checks' verdict.
 */
export async function receiveDucSubmission(
  registry: Registry,
  batch: readonly SharedImplementation[],
  modules: readonly ModuleRecord[] = [],
  options: ReceiverOptions = {},
): Promise<SubmissionVerdict> {
  const store = await receiverStoreOf(registry, batch);
  const verdict = await checkSharedSubmission(batch, store, { ...options, modules });
  for (const [i, v] of verdict.implementations.entries()) {
    const impl = batch[i];
    if (impl === undefined || v.level === undefined) continue;
    await registry.storeDucImplementation(ducRowOf(impl, v.level));
  }
  for (const m of modules)
    await registry.storeDucModule({ moduleRoot: moduleRootOf(m), record: canonicalText(m) });
  return verdict;
}

/** A stored implementation as it is shared: its row and its contract. */
export function sharedImplementationOf(
  row: DucImplementationRow,
  spec: SpecYak,
): SharedImplementation {
  const base =
    row.baseSet !== null && row.baseSet !== undefined
      ? (JSON.parse(row.baseSet) as { target: string; version: number })
      : { target: ECMASCRIPT.target, version: ECMASCRIPT.version };
  return {
    spec,
    specHash: row.specHash,
    formatVersion: row.formatVersion,
    structure: row.structure,
    identity: row.graphIdentity,
    root: row.graphRoot,
    lifterVersion: row.lifterVersion,
    links: row.links as unknown as SharedImplementation["links"],
    evidence:
      row.evidence !== null && row.evidence !== undefined
        ? (JSON.parse(row.evidence) as ConformanceVector[])
        : [],
    baseSet: base,
  };
}
