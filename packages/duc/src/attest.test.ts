// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  DUC_ATTESTATION_VERSION,
  type DucNiAttestation,
  influenceAttestation,
  niAttestation,
  validateDucAttestation,
} from "./attest.js";
import { liftAtom } from "./lift.js";

describe("duc_influence attestation (S3, #1164)", () => {
  it("records each parameter's may-influence row over the observations", () => {
    const g = liftAtom("export function f(a: number, b: number): number { return a + 1; }");
    const att = influenceAttestation(g);
    expect(att.kind).toBe("duc_influence");
    expect(att.version).toBe(DUC_ATTESTATION_VERSION);
    expect(att.params).toBe(2);
    expect(att.obs).toBe(1);
    expect(att.matrix).toEqual([[true], [false]]); // a reaches the result; b does not
  });

  it("is deterministic: the same source yields the same attestation", () => {
    const src = "export function f(x: number): number { return x * 2; }";
    expect(influenceAttestation(liftAtom(src))).toEqual(influenceAttestation(liftAtom(src)));
  });

  it("validates its own output", () => {
    const att = influenceAttestation(
      liftAtom("export function f(x: number): number { return x; }"),
    );
    expect(validateDucAttestation(att)).toBeNull();
  });

  it("rejects a tampered matrix shape", () => {
    const att = influenceAttestation(
      liftAtom("export function f(x: number): number { return x; }"),
    );
    expect(validateDucAttestation({ ...att, matrix: [[true, true]] })).toMatch(/column count/);
    expect(validateDucAttestation({ ...att, matrix: [] })).toMatch(/row count/);
    expect(validateDucAttestation({ ...att, matrix: [["yes"]] })).toMatch(/booleans/);
  });
});

describe("duc_ni attestation (S4, #1165)", () => {
  const SRC = "export function f(x: number): number { return read(x, FLAGS); }";

  it("holds when no high source may-influence a low observation", () => {
    const att = niAttestation(liftAtom(SRC), new Set(["NOT_IN_ATOM"]));
    expect(att.kind).toBe("duc_ni");
    expect(att.holds).toBe(true);
    expect(att.leaks).toEqual([]);
    expect(validateDucAttestation(att)).toBeNull();
  });

  it("witnesses a leak when a high source reaches the observation", () => {
    const att = niAttestation(liftAtom(SRC), new Set(["FLAGS"]));
    expect(att.holds).toBe(false);
    expect(att.leaks).toHaveLength(1);
    expect(att.leaks[0]?.highSource).toBe("FLAGS");
    expect(att.leaks[0]?.obsIndex).toBe(0);
    expect(att.leaks[0]?.witness).toContain("FLAGS");
    expect(validateDucAttestation(att)).toBeNull();
  });

  it("records the declared high symbols sorted and de-duplicated", () => {
    const att = niAttestation(liftAtom(SRC), new Set(["b", "a", "b"]));
    expect(att.highSymbols).toEqual(["a", "b"]);
  });

  it("rejects an internally inconsistent verdict", () => {
    const base: DucNiAttestation = niAttestation(liftAtom(SRC), new Set(["FLAGS"]));
    // holds=true with leaks present is a contradiction.
    expect(validateDucAttestation({ ...base, holds: true })).toMatch(/holds=true/);
    // holds=false with no witnessed leak is unsupported.
    expect(validateDucAttestation({ ...base, leaks: [] })).toMatch(/no leak/);
    // a leak must point at a real observation index.
    expect(
      validateDucAttestation({
        ...base,
        leaks: [{ highSource: "FLAGS", obsIndex: -1, witness: "w" }],
      }),
    ).toMatch(/obsIndex/);
  });
});

describe("validateDucAttestation", () => {
  it("rejects non-objects, unknown kinds, and wrong versions", () => {
    expect(validateDucAttestation(null)).toMatch(/not an object/);
    expect(validateDucAttestation({ kind: "duc_mystery", version: 1 })).toMatch(
      /unknown attestation kind/,
    );
    expect(validateDucAttestation({ kind: "duc_ni", version: 99 })).toMatch(/unsupported version/);
  });
});
