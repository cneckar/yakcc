// SPDX-License-Identifier: MIT
// @decision DEC-DUC-WIRE-001 (#1291): the wire carries DUC implementations as the receiver checks
// them: a SharedImplementation (DEC-DUC-TRUST-MODEL-001) in JSON, the structure in base64. The wire
// decoder checks shape only; integrity (identity, root, contract hash) and every other check are the
// receiver's (checkSharedSubmission), so a decoded implementation is not trusted until it passes them.

import type { SpecYak } from "@yakcc/contracts";
import type { StoredLink } from "@yakcc/duc";
import type { ConformanceVector, ModuleRecord, SharedImplementation } from "./duc-submission.js";

/** A link as it travels: the reference by reason, symbol and module, and the contract it calls. */
export interface WireDucLink {
  readonly reason: string;
  readonly symbol: string;
  readonly module?: string;
  readonly spec: string;
}

/** One implementation on the wire. */
export interface WireDucImplementation {
  readonly spec: SpecYak;
  readonly specHash: string;
  readonly formatVersion: number;
  /** The packed structure, base64. */
  readonly structure: string;
  readonly identity: string;
  readonly root: string;
  readonly lifterVersion?: number;
  readonly links: readonly WireDucLink[];
  readonly evidence: readonly ConformanceVector[];
  readonly baseSet: { readonly target: string; readonly version: number };
}

/** A submission: implementations, and the module records their statements belong to. */
export interface WireDucSubmission {
  readonly implementations: readonly WireDucImplementation[];
  readonly modules?: readonly ModuleRecord[];
}

export function serializeDucImplementation(impl: SharedImplementation): WireDucImplementation {
  return {
    spec: impl.spec,
    specHash: impl.specHash,
    formatVersion: impl.formatVersion,
    structure: Buffer.from(impl.structure).toString("base64"),
    identity: impl.identity,
    root: impl.root,
    ...(impl.lifterVersion !== undefined ? { lifterVersion: impl.lifterVersion } : {}),
    links: impl.links.map((l) => ({
      reason: l.reason,
      symbol: l.symbol,
      ...(l.module !== undefined ? { module: l.module } : {}),
      spec: l.spec,
    })),
    evidence: impl.evidence,
    baseSet: impl.baseSet,
  };
}

const HEX64 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function fail(what: string): never {
  throw new TypeError(`duc wire: ${what}`);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${what} is not an object`);
  return value as Record<string, unknown>;
}

function text(o: Record<string, unknown>, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== "string") fail(`${what}.${key} is not a string`);
  return v;
}

function hex(o: Record<string, unknown>, key: string, what: string): string {
  const v = text(o, key, what);
  if (!HEX64.test(v)) fail(`${what}.${key} is not 64 lowercase hex digits`);
  return v;
}

function integer(o: Record<string, unknown>, key: string, what: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
    fail(`${what}.${key} is not a non-negative integer`);
  return v;
}

/** An implementation from the wire, checked for shape. Its integrity is the receiver's to check. */
export function deserializeDucImplementation(value: unknown): SharedImplementation {
  const o = record(value, "implementation");
  const spec = record(o.spec, "implementation.spec") as unknown as SpecYak;
  const structure = text(o, "structure", "implementation");
  if (!BASE64.test(structure)) fail("implementation.structure is not base64");
  if (!Array.isArray(o.links)) fail("implementation.links is not an array");
  const links: StoredLink[] = o.links.map((raw, i) => {
    const l = record(raw, `implementation.links[${i}]`);
    const module = l.module;
    if (module !== undefined && typeof module !== "string")
      fail(`implementation.links[${i}].module is not a string`);
    return {
      reason: text(l, "reason", `implementation.links[${i}]`) as StoredLink["reason"],
      symbol: text(l, "symbol", `implementation.links[${i}]`),
      ...(module !== undefined ? { module } : {}),
      spec: text(l, "spec", `implementation.links[${i}]`),
    };
  });
  if (!Array.isArray(o.evidence)) fail("implementation.evidence is not an array");
  const evidence = o.evidence.map((raw, i) => {
    const v = record(raw, `implementation.evidence[${i}]`);
    if (!Array.isArray(v.inputs)) fail(`implementation.evidence[${i}].inputs is not an array`);
    if (!("output" in v)) fail(`implementation.evidence[${i}] has no output`);
    return { inputs: v.inputs, output: v.output };
  });
  const base = record(o.baseSet, "implementation.baseSet");
  const lifterVersion = o.lifterVersion;
  if (
    lifterVersion !== undefined &&
    (typeof lifterVersion !== "number" || !Number.isInteger(lifterVersion))
  )
    fail("implementation.lifterVersion is not an integer");
  return {
    spec,
    specHash: hex(o, "specHash", "implementation"),
    formatVersion: integer(o, "formatVersion", "implementation"),
    structure: new Uint8Array(Buffer.from(structure, "base64")),
    identity: hex(o, "identity", "implementation"),
    root: hex(o, "root", "implementation"),
    ...(lifterVersion !== undefined ? { lifterVersion } : {}),
    links,
    evidence,
    baseSet: {
      target: text(base, "target", "implementation.baseSet"),
      version: integer(base, "version", "implementation.baseSet"),
    },
  };
}

/** A submission from the wire, checked for shape. */
export function deserializeDucSubmission(value: unknown): {
  readonly batch: readonly SharedImplementation[];
  readonly modules: readonly ModuleRecord[];
} {
  const o = record(value, "submission");
  if (!Array.isArray(o.implementations)) fail("submission.implementations is not an array");
  const modules = o.modules ?? [];
  if (!Array.isArray(modules)) fail("submission.modules is not an array");
  return {
    batch: o.implementations.map(deserializeDucImplementation),
    modules: modules.map((m, i) => {
      const r = record(m, `submission.modules[${i}]`);
      text(r, "id", `submission.modules[${i}]`);
      if (!Array.isArray(r.statements)) fail(`submission.modules[${i}].statements is not an array`);
      return r as unknown as ModuleRecord;
    }),
  };
}
