// SPDX-License-Identifier: Apache-2.0
// The L2 record and its re-check (#1421 slice 6).
import { validateProofManifestL2 } from "@yakcc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import {
  contractFromSpec,
  encodeL2Record,
  l2Artifact,
  l2Record,
  l2RecordHash,
  recheckL2,
} from "./record.js";
import { shutdownSolver } from "./solver.js";
import type { L2Contract } from "./types.js";
import { verifyL2 } from "./verify.js";

afterAll(async () => {
  await shutdownSolver();
});

const SUM =
  "function sumTo(n: number): number { let s = 0; for (let i = 0; i < n; i++) { s = s + i; } return s; }";
const SPEC = {
  name: "sum-to",
  inputs: [{ name: "n", type: "number" }],
  outputs: [{ name: "result", type: "number" }],
  preconditions: [],
  postconditions: [{ description: "result >= 0" }],
};
const CONTRACT: L2Contract = { ...contractFromSpec(SPEC), loopInvariants: [["s >= 0 && i >= 0"]] };

async function recorded(): Promise<string> {
  const report = await verifyL2(SUM, CONTRACT);
  expect(report.verdict).toBe("proven");
  return encodeL2Record(l2Record(report, CONTRACT));
}

describe("the L2 record", () => {
  it("is canonical, deterministic, and makes a manifest entry validateProofManifestL2 accepts", async () => {
    const a = await recorded();
    const b = await recorded();
    expect(a).toBe(b);
    expect(l2RecordHash(a)).toMatch(/^[0-9a-f]{64}$/);
    const record = JSON.parse(a);
    expect(record.loopInvariants).toEqual([["s >= 0 && i >= 0"]]);
    expect(() =>
      validateProofManifestL2({
        artifacts: [{ kind: "property_tests", path: "tests.fast-check.ts" }, l2Artifact(record)],
      }),
    ).not.toThrow();
  });

  it("re-checks against the same block", async () => {
    const text = await recorded();
    const r = await recheckL2(text, SUM, contractFromSpec(SPEC));
    expect(r.reasons).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("is invalid for a different implementation", async () => {
    const text = await recorded();
    const other =
      "function sumTo(n: number): number { let s = 0; for (let i = 0; i < n; i++) { s = s + i + 1; } return s; }";
    const r = await recheckL2(text, other, contractFromSpec(SPEC));
    expect(r.valid).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/different query/);
  });

  it("is invalid when edited, or when its claims are not reproduced", async () => {
    const text = await recorded();
    const record = JSON.parse(text);
    const forged = encodeL2Record({ ...record, loopInvariants: [["true"]] });
    const r = await recheckL2(forged, SUM, contractFromSpec(SPEC));
    expect(r.valid).toBe(false);
    expect(
      (await recheckL2(text.replace("proven", "proven "), SUM, contractFromSpec(SPEC))).valid,
    ).toBe(false);
  });

  it("is invalid for a record whose verdict is not proven", async () => {
    const report = await verifyL2(SUM, contractFromSpec(SPEC));
    const text = encodeL2Record(l2Record(report, contractFromSpec(SPEC)));
    const r = await recheckL2(text, SUM, contractFromSpec(SPEC));
    expect(r.valid).toBe(false);
    expect(r.reasons[0]).toMatch(/verdict/);
  });
});
