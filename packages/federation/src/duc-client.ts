// SPDX-License-Identifier: MIT
// The client side of the DUC wire (#1291): list a peer's contracts and implementations, fetch one,
// submit a batch, and mirror a peer. Every implementation a mirror takes is received through the
// receiver's checks (DEC-DUC-RECEIVE-001), as a submission is: a peer is not trusted for its word.

import type { Registry } from "@yakcc/registry";
import { receiveDucSubmission } from "./duc-receive.js";
import type {
  ModuleRecord,
  ReceiverOptions,
  SharedImplementation,
  SubmissionVerdict,
} from "./duc-submission.js";
import { deserializeDucImplementation, serializeDucImplementation } from "./duc-wire.js";

export interface DucClientOptions {
  /** The fetch to use (default: the global fetch). */
  readonly fetch?: typeof fetch;
}

export interface DucClient {
  listSpecs(): Promise<readonly string[]>;
  listImplementations(specHash: string): Promise<readonly string[]>;
  /** One implementation, checked for shape only: its integrity is the receiver's to check. */
  fetchImplementation(specHash: string, root: string): Promise<SharedImplementation>;
  fetchModule(moduleRoot: string): Promise<ModuleRecord>;
  submit(
    batch: readonly SharedImplementation[],
    modules?: readonly ModuleRecord[],
  ): Promise<SubmissionVerdict>;
}

export class DucClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DucClientError";
  }
}

export function createDucClient(baseUrl: string, options: DucClientOptions = {}): DucClient {
  const doFetch = options.fetch ?? fetch;
  const base = baseUrl.replace(/\/+$/, "");
  const json = async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await doFetch(`${base}${path}`, init);
    const body = await res.text();
    if (!res.ok) throw new DucClientError(res.status, `${path}: ${res.status} ${body}`);
    return JSON.parse(body) as unknown;
  };
  return {
    listSpecs: async () => ((await json("/v1/duc/specs")) as { specHashes: string[] }).specHashes,
    listImplementations: async (specHash) =>
      ((await json(`/v1/duc/spec/${specHash}`)) as { graphRoots: string[] }).graphRoots,
    fetchImplementation: async (specHash, root) =>
      deserializeDucImplementation(await json(`/v1/duc/impl/${specHash}/${root}`)),
    fetchModule: async (moduleRoot) => (await json(`/v1/duc/module/${moduleRoot}`)) as ModuleRecord,
    submit: async (batch, modules = []) =>
      (await json("/v1/duc/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          implementations: batch.map(serializeDucImplementation),
          modules,
        }),
      })) as SubmissionVerdict,
  };
}

export interface DucMirrorReport {
  /** Implementations the peer serves that this registry did not hold. */
  readonly fetched: number;
  /** Of those, the ones the receiver's checks admitted and the registry now holds. */
  readonly stored: number;
  readonly refused: readonly {
    readonly specHash: string;
    readonly root: string;
    readonly check: string;
    readonly reason: string;
  }[];
  /** Implementations that could not be fetched or decoded. */
  readonly failures: readonly {
    readonly specHash: string;
    readonly root: string;
    readonly reason: string;
  }[];
}

/**
 * Mirror a peer's DUC implementations into a registry: every implementation the registry does not
 * hold is fetched and received, as one batch so that links between them close, through the
 * receiver's checks. What is refused is reported and not stored.
 */
export async function mirrorDuc(
  client: DucClient,
  registry: Registry,
  options: ReceiverOptions = {},
): Promise<DucMirrorReport> {
  const batch: SharedImplementation[] = [];
  const failures: { specHash: string; root: string; reason: string }[] = [];
  for (const specHash of await client.listSpecs()) {
    const held = new Set(await registry.listDucImplementations(specHash));
    for (const root of await client.listImplementations(specHash)) {
      if (held.has(root)) continue;
      try {
        batch.push(await client.fetchImplementation(specHash, root));
      } catch (e) {
        failures.push({ specHash, root, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  if (batch.length === 0) return { fetched: 0, stored: 0, refused: [], failures };
  const verdict = await receiveDucSubmission(registry, batch, [], options);
  const refused = verdict.implementations.flatMap((v, i) =>
    v.refused !== undefined
      ? [
          {
            specHash: v.specHash,
            root: batch[i]?.root ?? "",
            check: v.refused.check,
            reason: v.refused.reason,
          },
        ]
      : [],
  );
  return {
    fetched: batch.length,
    stored: verdict.implementations.filter((v) => v.level !== undefined).length,
    refused,
    failures,
  };
}
