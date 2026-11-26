import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// SPDX-License-Identifier: MIT
// The L2 verifier-as-block (#1421 slice 6).
import {
  type L2Contract,
  encodeL2Record,
  l2Record,
  l2RecordHash,
  shutdownSolver,
  verifyL2,
} from "@yakcc/verify-l2";
import { afterAll, describe, expect, it } from "vitest";
import { loadOrCreateIdentity } from "./identity.js";
import { issueL2Attestation } from "./l2.js";
import { verifyAttestation } from "./verifier.js";

afterAll(async () => {
  await shutdownSolver();
});

const ABS = "function abs(x: number): number { return x < 0 ? -x : x; }";
const CONTRACT: L2Contract = {
  inputs: [{ name: "x", type: "number" }],
  outputs: [{ type: "number" }],
  preconditions: ["x === x"],
  postconditions: ["result >= 0"],
};

const generateKeypair = () =>
  loadOrCreateIdentity(join(mkdtempSync(join(tmpdir(), "l2-verifier-")), "key"));

describe("issueL2Attestation", () => {
  it("re-checks a record and signs the block, the record hash and the toolchain", async () => {
    const record = encodeL2Record(l2Record(await verifyL2(ABS, CONTRACT), CONTRACT));
    const identity = generateKeypair();
    const r = await issueL2Attestation({
      block: "blake3:abc",
      record,
      implSource: ABS,
      contract: CONTRACT,
      identity,
      timestamp: "2026-11-26T00:00:00.000Z",
    });
    expect(r.issued).toBe(true);
    if (!r.issued) return;
    expect(verifyAttestation({ ...r.signed })).toBe(true);
    const payload = JSON.parse(r.signed.payload);
    expect(payload).toMatchObject({
      level: "L2",
      block: "blake3:abc",
      record_hash: l2RecordHash(record),
    });
    expect(payload.solver).toMatch(/^z3 /);
  });

  it("refuses a record that does not re-check", async () => {
    const record = encodeL2Record(l2Record(await verifyL2(ABS, CONTRACT), CONTRACT));
    const r = await issueL2Attestation({
      block: "blake3:abc",
      record,
      implSource: "function abs(x: number): number { return x; }",
      contract: CONTRACT,
      identity: generateKeypair(),
    });
    expect(r.issued).toBe(false);
  });
});
