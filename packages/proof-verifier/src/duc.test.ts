// SPDX-License-Identifier: MIT
/**
 * The DUC mechanization as a verifier-as-block (#1167): I1 attestations for the influence facet,
 * signed and verified through this package's Ed25519 attestations.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { influenceAttestation, liftAtom, niAttestation } from "@yakcc/duc";
import { describe, expect, it } from "vitest";
import {
  DUC_PINNED_TOOLCHAIN,
  type DucI1Payload,
  type DucMechanizationRun,
  claimedTheorems,
  coreProgram,
  ducVerifierHash,
  issueDucAttestation,
  mechanizedAttestation,
  runDucMechanization,
} from "./duc.js";
import { loadOrCreateIdentity } from "./identity.js";
import { verifyAttestation } from "./verifier.js";

const COQ = resolve(dirname(fileURLToPath(import.meta.url)), "../../duc/coq");
const identity = loadOrCreateIdentity(join(mkdtempSync(join(tmpdir(), "duc-verifier-")), "key"));

/** A run as `runDucMechanization` reports a passing one (the real run is checked below, with nix). */
const passing = (): DucMechanizationRun => ({
  ok: true,
  verifierHash: ducVerifierHash(COQ),
  toolchain: DUC_PINNED_TOOLCHAIN,
  theorems: ["influence_soundness_WF", "graph_NI_sound"],
  output: "verify: OK",
});

const STRAIGHT_LINE = [
  "export function f(a: number, b: number) { return a + b; }",
  "export function f(a: number, b: number, c: number) { return [a * 2, b + c, 7]; }",
  "export function f(a: string, b: string) { return a.trim().toUpperCase(); }",
  "export function f(a: number, b: number) { const o = { x: a, y: 1 }; o.y = b; return o.x; }",
  "export function f(a: number) { return secret + a; }",
  "export function f(a: number, b: number) { return Math.max(a, KEY) * 0; }",
  // A selection is an opaque operation over its condition and both arms (control as data).
  "export function f(a: number, b: number) { if (a > 0) return a; return b; }",
  "export function f(a: number, b: number) { let x = 0; if (a > secret) { x = b; } return x; }",
];

describe("the mechanized model, transcribed, agrees with the engine on straight-line graphs", () => {
  for (const source of STRAIGHT_LINE) {
    it(source, () => {
      const g = liftAtom(source);
      expect("program" in coreProgram(g)).toBe(true);
      expect(mechanizedAttestation(g, "duc_influence")).toEqual(influenceAttestation(g));
      for (const high of [new Set(["secret"]), new Set(["KEY"]), new Set<string>()]) {
        const model = mechanizedAttestation(g, "duc_ni", high);
        expect("holds" in model && model.holds).toBe(niAttestation(g, high).holds);
      }
    });
  }

  it("refuses what the model does not cover: a branch, a loop, a closure, an async function", () => {
    const outside = (s: string) => {
      const r = coreProgram(liftAtom(s));
      return "outside" in r ? r.outside : "inside";
    };
    expect(
      outside(
        "export function f(xs: number[], a: number) { if (a > 0) { xs.push(a); } return xs.length; }",
      ),
    ).toMatch(/branch|region/);
    expect(
      outside(
        "export function f(n: number) { let s = 0; for (let i = 0; i < n; i++) s += i; return s; }",
      ),
    ).toMatch(/loop|region/);
    expect(outside("export function f(a: number) { const h = () => a; return h(); }")).toMatch(
      /closure/,
    );
    expect(outside("export async function f(a: number) { return a; }")).toMatch(/async/);
  });
});

describe("the verifier's claims are the Makefile's", () => {
  it("reads every theorem of the CLAIMED list, across continuation lines", () => {
    const makefile = readFileSync(join(COQ, "Makefile"), "utf8");
    const claimed = claimedTheorems(makefile);
    expect(claimed).toContain("push_preserves_conservation");
    expect(claimed).toContain("influence_soundness_WF");
    expect(claimed).toContain("graph_NI_sound");
    expect(claimed.every((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t))).toBe(true);
    expect(claimed.length).toBe(15);
  });
});

describe("issuing I1 attestations, signed and verified (#1167)", () => {
  const g = liftAtom("export function f(a: number, b: number) { return [a + b, secret]; }");

  it("signs an influence attestation the model agrees with, and the signature verifies", () => {
    const r = issueDucAttestation({
      graph: g,
      block: "blk",
      attestation: influenceAttestation(g),
      run: passing(),
      coqDir: COQ,
      identity,
      timestamp: "2026-11-23T00:00:00.000Z",
    });
    expect(r.issued).toBe(true);
    if (!r.issued) return;
    expect(verifyAttestation(r.signed)).toBe(true);
    const p = JSON.parse(r.signed.payload) as DucI1Payload;
    expect(p).toMatchObject({
      kind: "duc_influence",
      level: "I1",
      block: "blk",
      theorem: "influence_soundness_WF",
      toolchain: DUC_PINNED_TOOLCHAIN,
      verifier_hash: ducVerifierHash(COQ),
    });
    // A changed payload no longer verifies.
    expect(
      verifyAttestation({ ...r.signed, payload: r.signed.payload.replace('"I1"', '"I2"') }),
    ).toBe(false);
  });

  it("signs a non-interference attestation, resting on graph_NI_sound", () => {
    const r = issueDucAttestation({
      graph: g,
      block: "blk",
      attestation: niAttestation(g, new Set(["secret"])),
      run: passing(),
      coqDir: COQ,
      identity,
    });
    expect(r.issued).toBe(true);
    if (r.issued)
      expect((JSON.parse(r.signed.payload) as DucI1Payload).theorem).toBe("graph_NI_sound");
  });

  it("stays at I0, with the reason, whenever the mechanization does not back the claim", () => {
    const att = influenceAttestation(g);
    const reason = (over: Partial<Parameters<typeof issueDucAttestation>[0]>) => {
      const r = issueDucAttestation({
        graph: g,
        block: "blk",
        attestation: att,
        run: passing(),
        coqDir: COQ,
        identity,
        ...over,
      });
      return r.issued ? "issued" : r.reason;
    };
    const flipped = { ...att, matrix: att.matrix.map((row) => row.map((x) => !x)) };
    expect(reason({ attestation: flipped })).toMatch(/disagrees with the mechanized depmap/);
    expect(reason({ run: { ...passing(), ok: false, output: "verify: FAILED" } })).toMatch(
      /did not verify/,
    );
    expect(reason({ run: { ...passing(), verifierHash: "0".repeat(64) } })).toMatch(
      /different mechanization/,
    );
    expect(reason({ run: { ...passing(), toolchain: "coq@8.18.0" } })).toMatch(/not rocq@9\.0\.0/);
    expect(reason({ run: { ...passing(), theorems: [] } })).toMatch(
      /did not establish influence_soundness_WF/,
    );
    const branchy = liftAtom(
      "export function f(xs: number[], a: number) { if (a > 0) { xs.push(a); } return xs.length; }",
    );
    expect(reason({ graph: branchy, attestation: influenceAttestation(branchy) })).toMatch(
      /outside the mechanized model/,
    );
    expect(reason({ attestation: { ...att, matrix: [] } })).toMatch(/malformed/);
  });
});

const nix = spawnSync("nix", ["--version"]).status === 0;

describe.skipIf(!nix)("the mechanization itself, through the pinned toolchain (nix)", () => {
  it("make verify passes under Rocq 9.0.0, and the run backs an I1 attestation", () => {
    const run = runDucMechanization(COQ);
    expect(run.toolchain).toBe(DUC_PINNED_TOOLCHAIN);
    expect(run.ok, run.output).toBe(true);
    expect(run.theorems).toContain("influence_soundness_WF");
    expect(run.theorems).toContain("graph_NI_sound");
    const g = liftAtom("export function f(a: number) { return a * 3; }");
    const r = issueDucAttestation({
      graph: g,
      block: "blk",
      attestation: influenceAttestation(g),
      run,
      coqDir: COQ,
      identity,
    });
    expect(r.issued && verifyAttestation(r.signed)).toBe(true);
  }, 900_000);
});
