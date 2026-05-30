// SPDX-License-Identifier: MIT
//
// raise-class.integration.test.ts — substrate decomposition bridge test (WI-934).
//
// This is the key acceptance gate for WI-934 and the first empirical proof of
// DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001: a Python class raised via raiseClass()
// feeds into the substrate's standard decompose() pipeline and yields ≥2 atoms
// from a method body with ≥3 statements.
//
// Two test tracks:
//   A. Synthetic envelope (no Python subprocess): uses a hand-constructed EnvelopeClass
//      so the test runs in pure-TS environments without Python toolchain.
//
//   B. Real libcst subprocess: invokes the real parsePythonSource() on the
//      canonical EmailValidator fixture.  Gated by Python availability (same
//      skip-gracefully pattern as integration.test.ts).
//
// The substrate entry point is decompose() from @yakcc/shave — the same function
// universalize() calls.  We do NOT call the full universalize() pipeline because
// that requires ANTHROPIC_API_KEY (intent extraction); decompose() is pure and
// offline.
//
// polyglot-py.yml pre-builds @yakcc/shave before typecheck + test, so the
// static import resolves at typecheck and at runtime in CI.
//
// @decision DEC-WI934-010 — Integration test consumes @yakcc/shave as workspace dev dep
// @title Add @yakcc/shave: workspace:* to packages/shave-python devDependencies
// @status accepted
// @rationale Read-only consumption — substrate source is not edited.
//   The integration test proves DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001 empirically:
//   adapter raises, substrate decomposes, ≥2 atoms emerge from ≥3-statement body.
//
// @decision DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001
// @title Decomposition lives at substrate; adapters only raise
// @status accepted (see docs/decisions/DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001.md)

import { type AtomLeaf, type RecursionNode, type RecursionTree, decompose } from "@yakcc/shave";
import { describe, expect, it } from "vitest";
import { parsePythonSource } from "./libcst-parser.js";
import type { EnvelopeClass } from "./parse-fn-signature.js";
import { extractClassEnvelopes } from "./parse-fn-signature.js";
import { raiseClass } from "./raise-class.js";

// ---------------------------------------------------------------------------
// Helpers — typed via @yakcc/shave's exported RecursionTree types
// ---------------------------------------------------------------------------

/** Flatten a RecursionTree to all AtomLeaf nodes (DFS). */
function collectAtoms(node: RecursionNode): AtomLeaf[] {
  if (node.kind === "atom") return [node];
  return node.children.flatMap((c) => collectAtoms(c));
}

/** Count total AtomLeaf nodes in a RecursionTree. */
function countAtoms(tree: RecursionTree): number {
  return collectAtoms(tree.root).length;
}

import type { ShaveRegistryView } from "@yakcc/shave";

/** Minimal registry stub — no registry lookups needed for decompose(). */
const emptyRegistry: Pick<ShaveRegistryView, "findByCanonicalAstHash"> = {};

// ---------------------------------------------------------------------------
// Runtime availability check (for Track B)
// ---------------------------------------------------------------------------

async function isPythonAvailable(): Promise<boolean> {
  try {
    await parsePythonSource("pass");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Canonical EmailValidator envelope (synthetic — no subprocess required)
// ---------------------------------------------------------------------------
//
// This is a hand-built EnvelopeClass that mirrors what libcst-parse.py would
// emit for the EmailValidator class from #934 issue body.  Used in Track A
// so the substrate bridge test runs in pure-TS CI without a Python toolchain.
//
// The validate() method has ≥3 statements:
//   1. if len(email) > self.max_length: return False   (If with 1 body stmt)
//   2. if email == '': return False                    (If with 1 body stmt)
//   3. return True
//
// The if-statements ARE counted separately by the substrate as independent
// control-flow branches, satisfying the ≥3-statement requirement.

const EMAIL_VALIDATOR_ENVELOPE: EnvelopeClass = {
  name: "EmailValidator",
  bases: [],
  decorators: [],
  metaclass: null,
  init_params: [{ name: "max_length", annotation: "int" }],
  init_assignments: [{ target: "max_length", value: { type: "Name", name: "max_length" } }],
  methods: [
    {
      name: "validate",
      params: [
        { name: "self", annotation: null },
        { name: "email", annotation: "str" },
      ],
      return_annotation: "bool",
      body_source:
        "if len(email) > self.max_length:\n    return False\nif email == '':\n    return False\nreturn True",
      body: [
        // Statement 1: if len(email) > self.max_length: return False
        {
          type: "If",
          test: {
            type: "BinaryOp",
            op: ">",
            left: { type: "LenCall", arg: { type: "Name", name: "email" } },
            right: { type: "Call", func: "self.max_length", args: [] },
          },
          body: [{ type: "Return", value: { type: "Bool", value: false } }],
          orelse: [],
        },
        // Statement 2: if email == '': return False
        {
          type: "If",
          test: {
            type: "BinaryOp",
            op: "==",
            left: { type: "Name", name: "email" },
            right: { type: "String", value: "" },
          },
          body: [{ type: "Return", value: { type: "Bool", value: false } }],
          orelse: [],
        },
        // Statement 3: return True
        { type: "Return", value: { type: "Bool", value: true } },
      ],
      methodKind: "instance",
    },
  ],
  class_vars: [],
  raise_blockers: [],
};

// ---------------------------------------------------------------------------
// Track A: Synthetic envelope → substrate decompose (pure-TS, no subprocess)
//
// polyglot-py.yml pre-builds @yakcc/shave before typecheck + test, so the
// static import of decompose() resolves in CI without dynamic guards.
// ---------------------------------------------------------------------------

describe("@yakcc/shave-python raise-class integration (substrate bridge — DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001)", () => {
  it("raises EmailValidator synthetically and substrate decomposes to ≥2 atoms", async () => {
    // Step 1: raise the class to TS-subset IR
    const raised = raiseClass(EMAIL_VALIDATOR_ENVELOPE);
    expect(raised.methodsTs).toHaveLength(1);

    // Step 2: assemble a TS module from the raised fragments
    const tsSource = [raised.stateInterfaceTs, raised.factoryTs, ...raised.methodsTs].join("\n\n");

    // Log the TS source so the reviewer can inspect it
    console.log("[integration] Raised TS source:\n", tsSource);

    // Step 3: feed to the substrate's decompose() — the real production sequence
    const tree = await decompose(tsSource, emptyRegistry);

    // Count atoms
    const atomCount = countAtoms(tree);
    console.log(
      `[integration] Atom count from substrate decompose(): ${atomCount} ` +
        `(leafCount=${tree.leafCount}, maxDepth=${tree.maxDepth})`,
    );

    // Log atom sources for reviewer visibility
    const atoms = collectAtoms(tree.root);
    for (const [i, atom] of atoms.entries()) {
      console.log(`[integration] atom[${i}]: ${atom.source.slice(0, 80).replace(/\n/g, "\\n")}`);
    }

    // The acceptance gate: ≥2 atoms from the validate() method body
    // (which has ≥3 statements). If this fails, the raise produced
    // malformed IR — diagnose by inspecting the logged TS source above.
    expect(atomCount).toBeGreaterThanOrEqual(2);
  }, 30000); // 30s timeout for substrate decomposition

  it("raised TS source contains EmailValidator_validate free function", () => {
    const raised = raiseClass(EMAIL_VALIDATOR_ENVELOPE);
    const tsSource = [raised.stateInterfaceTs, raised.factoryTs, ...raised.methodsTs].join("\n\n");
    expect(tsSource).toContain("function EmailValidator_validate");
    expect(tsSource).toContain("self: EmailValidatorState");
  });

  it("raised TS source does not contain decomposableChildrenOf or recurse", () => {
    // Authority invariant (§5.4): no adapter-side decomposition
    const raised = raiseClass(EMAIL_VALIDATOR_ENVELOPE);
    const tsSource = [raised.stateInterfaceTs, raised.factoryTs, ...raised.methodsTs].join("\n\n");
    expect(tsSource).not.toContain("decomposableChildrenOf");
    expect(tsSource).not.toMatch(/\brecurse\b/);
  });
});

// ---------------------------------------------------------------------------
// Track B: Real libcst subprocess → raise → substrate (Python required)
// ---------------------------------------------------------------------------

describe("@yakcc/shave-python raise-class integration (real libcst subprocess — skip if Python absent)", async () => {
  const available = await isPythonAvailable();

  if (!available) {
    it.skip("python3 + libcst not available — skipping real-subprocess track", () => {});
    return;
  }

  it("parses EmailValidator via real libcst, raises, and substrate decomposes to ≥2 atoms", async () => {
    const py = `
class EmailValidator:
    def __init__(self, max_length: int):
        self.max_length = max_length

    def validate(self, email: str) -> bool:
        if len(email) > self.max_length:
            return False
        if email == '':
            return False
        return True
`.trim();

    // Parse via real libcst subprocess
    const envelope = await parsePythonSource(py);

    // Extract class envelopes from the new module.classes[] path
    const classes = extractClassEnvelopes(envelope);
    expect(classes).toHaveLength(1);

    const cls = classes[0];
    expect(cls).toBeDefined();
    if (!cls) throw new Error("cls undefined");
    expect(cls.name).toBe("EmailValidator");
    expect(cls.raise_blockers).toHaveLength(0);

    // Raise to TS-subset IR
    const raised = raiseClass(cls);
    const tsSource = [raised.stateInterfaceTs, raised.factoryTs, ...raised.methodsTs].join("\n\n");

    console.log("[integration/libcst] Raised TS source:\n", tsSource);

    // Feed to substrate
    const tree = await decompose(tsSource, emptyRegistry);
    const atomCount = countAtoms(tree);
    console.log(
      `[integration/libcst] Atom count: ${atomCount} ` +
        `(leafCount=${tree.leafCount}, maxDepth=${tree.maxDepth})`,
    );

    // Log atoms for reviewer visibility
    const atoms = collectAtoms(tree.root);
    for (const [i, atom] of atoms.entries()) {
      console.log(
        `[integration/libcst] atom[${i}]: ${atom.source.slice(0, 80).replace(/\n/g, "\\n")}`,
      );
    }

    // Acceptance gate: ≥2 atoms from the validate() body (≥3 statements)
    expect(atomCount).toBeGreaterThanOrEqual(2);
  }, 30000);
});
