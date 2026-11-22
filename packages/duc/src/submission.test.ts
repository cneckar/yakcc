// SPDX-License-Identifier: Apache-2.0
// Submission (#1275, P7): an atom is submitted only as closed. Its references are platform
// primitives, or linked to atoms that are in the same batch or already in the store.
import { describe, expect, it } from "vitest";
import { checkSubmission, linkReferences } from "./closure.js";
import { graphIdentity } from "./canonical.js";
import { liftAtom } from "./lift.js";

const PURE = "export function f(x: number): number { return x * 2 + 1; }";
const PRIMITIVE = "export function f(x: number): number { return Math.abs(x); }";
const CALLS_FOO = "export function f(x: number): number { return foo(x) + 1; }";

describe("submission: an atom is submitted only as closed (P7, #1275)", () => {
  it("an atom with no references is closed, and the batch is accepted", () => {
    const report = checkSubmission([{ spec: "pure", graph: liftAtom(PURE) }], new Set());
    expect(report.accepted).toBe(true);
  });

  it("a platform primitive is not a reference that needs a link", () => {
    const report = checkSubmission([{ spec: "abs", graph: liftAtom(PRIMITIVE) }], new Set());
    expect(report.accepted).toBe(true);
  });

  it("an unlinked reference is a hole, and the batch is refused", () => {
    const report = checkSubmission([{ spec: "caller", graph: liftAtom(CALLS_FOO) }], new Set());
    expect(report.accepted).toBe(false);
    expect(report.atoms[0]?.holes).toEqual(["foo"]);
  });

  it("a reference linked to an atom already in the store closes the atom", () => {
    const graph = linkReferences(liftAtom(CALLS_FOO), (d) => (d.symbol === "foo" ? "store-foo" : undefined));
    const report = checkSubmission([{ spec: "caller", graph }], new Set(["store-foo"]));
    expect(report.accepted).toBe(true);
  });

  it("a link to a key that is neither stored nor in the batch is unresolved", () => {
    const graph = linkReferences(liftAtom(CALLS_FOO), () => "missing");
    const report = checkSubmission([{ spec: "caller", graph }], new Set());
    expect(report.accepted).toBe(false);
    expect(report.atoms[0]?.unresolved).toEqual(["missing"]);
  });

  it("atoms that depend on each other are accepted together, and not one at a time", () => {
    const caller = linkReferences(liftAtom(CALLS_FOO), (d) => (d.symbol === "foo" ? "helper" : undefined));
    const helper = liftAtom(PURE);
    const together = checkSubmission(
      [
        { spec: "caller", graph: caller },
        { spec: "helper", graph: helper },
      ],
      new Set(),
    );
    expect(together.accepted).toBe(true);
    const alone = checkSubmission([{ spec: "caller", graph: caller }], new Set());
    expect(alone.accepted).toBe(false);
  });

  it("each atom is keyed by its graph identity, and names the contract it implements", () => {
    const graph = liftAtom(PURE);
    const report = checkSubmission([{ spec: "contract-pure", graph }], new Set());
    expect(report.atoms[0]?.identity).toBe(graphIdentity(graph));
    expect(report.atoms[0]?.spec).toBe("contract-pure");
  });

  it("two implementations of one contract can both be submitted, and either closes a reference to it", () => {
    const caller = linkReferences(liftAtom(CALLS_FOO), () => "contract-helper");
    const one = liftAtom(PURE);
    const other = liftAtom("export function f(x: number): number { return 1 + 2 * x; }");
    const report = checkSubmission(
      [
        { spec: "contract-caller", graph: caller },
        { spec: "contract-helper", graph: one },
        { spec: "contract-helper", graph: other },
      ],
      new Set(),
    );
    expect(report.accepted).toBe(true);
    expect(report.atoms[1]?.identity).not.toBe(report.atoms[2]?.identity);
  });

  it("linking does not change the atom's identity: a link is not structure (2B)", () => {
    const plain = liftAtom(CALLS_FOO);
    const linked = linkReferences(plain, () => "helper");
    expect(graphIdentity(linked)).toBe(graphIdentity(plain));
  });
});
