// SPDX-License-Identifier: MIT
/**
 * authored.test.ts — checking graphs a model writes, and the composition loop (#1288,
 * DEC-DUC-AUTHORED-001).
 *
 * Production sequence: model reply (line form) → checkAuthoredGraph(reply, contract, vectors)
 *   → parse → checkSharedSubmission → round trip → findings; composeMissing drives it with a
 *   search and a model.
 *
 * The recorded replies in __fixtures__/authored are the line-form trial (#1275): three models, two
 * runs each, eight tasks. The vectors come from the reference functions.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SpecYak } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import {
  type AuthoringModel,
  type AuthoringRequest,
  checkAuthoredGraph,
  composeMissing,
  tallyCompose,
} from "./authored.js";
import type { ConformanceVector } from "./duc-submission.js";

function contract(name: string, inputs: string[], output: string): SpecYak {
  return {
    name,
    inputs: inputs.map((type, i) => ({ name: `a${i}`, type })),
    outputs: [{ name: "result", type: output }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior: `task ${name}`,
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe" },
    propertyTests: [],
  } as unknown as SpecYak;
}

/** The trial's tasks: the contract, the reference, and inputs to take vectors from. */
const TASKS: Record<
  number,
  { contract: SpecYak; ref: (...a: never[]) => unknown; inputs: unknown[][] }
> = {
  1: {
    contract: contract("1", ["number"], "number"),
    ref: (a: number) => a * 2,
    inputs: [[0], [3], [-2.5]],
  },
  2: {
    contract: contract("2", ["number", "number"], "number"),
    ref: (a: number, b: number) => a - b,
    inputs: [
      [5, 3],
      [0, 7],
      [-1, -1],
    ],
  },
  3: {
    contract: contract("3", ["number", "number"], "boolean"),
    ref: (a: number, b: number) => a < b,
    inputs: [
      [1, 2],
      [2, 1],
      [3, 3],
    ],
  },
  4: {
    contract: contract("4", ["string"], "string"),
    ref: (s: string) => encodeURI(s),
    inputs: [["a b"], ["x/y?z=1&w=ü"], [""]],
  },
  5: {
    contract: contract("5", ["number[]"], "number"),
    ref: (xs: number[]) => (xs[0] as number) - (xs[1] as number),
    inputs: [[[9, 4]], [[1, 1, 7]], [[0, -3]]],
  },
  6: {
    contract: contract("6", ["number", "number"], "number"),
    ref: (a: number, b: number) => a * 2 + b,
    inputs: [
      [1, 1],
      [4, -2],
      [0.5, 0],
    ],
  },
  7: {
    contract: contract("7", ["number", "number"], "number"),
    ref: (a: number, b: number) => b + a,
    inputs: [
      [1, 2],
      [-3, 3],
      [10, 0.25],
    ],
  },
  8: {
    contract: contract("8", ["number"], "number"),
    ref: (a: number) => a - 1,
    inputs: [[1], [0], [-7.5]],
  },
};

function vectorsOf(task: number): ConformanceVector[] {
  const t = TASKS[task];
  if (t === undefined) throw new Error(`no task ${task}`);
  return t.inputs.map((inputs) => ({
    inputs,
    output: (t.ref as (...a: unknown[]) => unknown)(...inputs),
  }));
}

function programsOf(text: string): Map<number, string> {
  const parts = text.split(/^=== task (\d+) ===\s*$/m);
  const out = new Map<number, string>();
  for (let i = 1; i < parts.length; i += 2) out.set(Number(parts[i]), (parts[i + 1] ?? "").trim());
  return out;
}

const FIXTURES = join(__dirname, "__fixtures__/authored");

describe("checking a model-written graph (#1288)", () => {
  it("every recorded reply passes: parses, closes, types, computes its vectors, round-trips", async () => {
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".txt"));
    expect(files).toHaveLength(6);
    let checked = 0;
    for (const file of files) {
      const programs = programsOf(readFileSync(join(FIXTURES, file), "utf8"));
      for (const [task, program] of programs) {
        const t = TASKS[task];
        if (t === undefined) continue;
        const result = await checkAuthoredGraph(program, t.contract, vectorsOf(task));
        expect(result.findings, `${file} task ${task}`).toEqual([]);
        expect(result.ok, `${file} task ${task}`).toBe(true);
        expect(result.level).toBe("conforming");
        checked++;
      }
    }
    expect(checked).toBe(48);
  });

  it("a wrong operation fails at conformance, with the vector it gets wrong", async () => {
    const r = await checkAuthoredGraph(
      "param a\nparam b\nop + a b -> r\nout r",
      TASKS[2]?.contract as SpecYak,
      vectorsOf(2),
    );
    expect(r.ok).toBe(false);
    expect(r.findings[0]?.check).toBe("conformance");
    expect(r.findings[0]?.reason).toContain("[5,3]");
  });

  it("a syntax error names its line", async () => {
    const r = await checkAuthoredGraph(
      'param a\nlit "1" -> one\nop - a one ->\nout r',
      TASKS[8]?.contract as SpecYak,
      vectorsOf(8),
    );
    expect(r.findings).toEqual([expect.objectContaining({ check: "parse", line: 3 })]);
  });

  it("an unlinked helper fails closure; code as text fails before it", async () => {
    const helper = await checkAuthoredGraph(
      "param a\nfree helper -> h\nop CallExpression h a -> r\nout r",
      TASKS[8]?.contract as SpecYak,
      vectorsOf(8),
    );
    expect(helper.findings[0]?.check).toBe("closure");
    expect(helper.findings[0]?.reason).toContain("helper");
    const evil = await checkAuthoredGraph(
      'param a\nfree eval -> e\nlit "\\"a\\"" -> code\nop CallExpression e code -> r\nout r',
      TASKS[8]?.contract as SpecYak,
      vectorsOf(8),
    );
    expect(evil.findings[0]?.check).toBe("external-code");
  });

  it("a result of the wrong type fails at types", async () => {
    // Task 3's graph returns a boolean; this contract says number.
    const r = await checkAuthoredGraph(
      "param a\nparam b\nop < a b -> r\nout r",
      contract("3n", ["number", "number"], "number"),
      [],
    );
    expect(r.findings[0]?.check).toBe("types");
  });
});

/** A model that answers from a script, recording what it was asked. */
function scripted(replies: string[]): AuthoringModel & { requests: AuthoringRequest[] } {
  const requests: AuthoringRequest[] = [];
  return {
    requests,
    async author(request) {
      requests.push(request);
      return replies[Math.min(requests.length - 1, replies.length - 1)] as string;
    },
  };
}

describe("the composition loop (#1288)", () => {
  const SUB = "param a\nparam b\nop - a b -> r\nout r";
  const ADD = "param a\nparam b\nop + a b -> r\nout r";
  const need = { contract: TASKS[2]?.contract as SpecYak, vectors: vectorsOf(2) };

  it("a search hit is used, and the model is not asked", async () => {
    const model = scripted([ADD]);
    const [out] = await composeMissing([need], {
      search: async () => ({ identity: "g-sub", lineForm: SUB }),
      model,
    });
    expect(out?.outcome).toBe("found");
    expect(model.requests).toEqual([]);
  });

  it("a wrong reply gets its findings back, and the corrected one is taken", async () => {
    const model = scripted([ADD, SUB]);
    const [out] = await composeMissing([need], { search: async () => undefined, model });
    expect(out?.outcome).toBe("authored");
    expect(out?.attempts).toBe(2);
    expect(out?.lineForm).toBe(SUB);
    // The second request carries the first reply and why it failed.
    expect(model.requests[1]?.previous).toBe(ADD);
    expect(model.requests[1]?.findings?.[0]?.check).toBe("conformance");
  });

  it("a model that never gets it right stops after the attempts allowed", async () => {
    const model = scripted([ADD]);
    const [out] = await composeMissing(
      [need],
      { search: async () => undefined, model },
      { maxAttempts: 3 },
    );
    expect(out?.outcome).toBe("failed");
    expect(out?.attempts).toBe(3);
    expect(model.requests).toHaveLength(3);
    expect(out?.findings[0]?.check).toBe("conformance");
  });

  it("a search hit that fails a check is a gap: the model is asked, starting from it (#1263)", async () => {
    const holed = "param a\nparam b\nfree helper -> h\nop CallExpression h a b -> r\nout r";
    const model = scripted([SUB]);
    const [out] = await composeMissing([need], {
      search: async () => ({ identity: "g-holed", lineForm: holed }),
      model,
    });
    expect(out?.outcome).toBe("authored");
    expect(out?.trigger).toBe("closure");
    expect(model.requests[0]?.previous).toBe(holed);
    expect(model.requests[0]?.findings?.[0]?.check).toBe("closure");
  });

  it("trigger counts and the synthesis rate (#1263)", async () => {
    const needs = [need, need, need];
    let call = 0;
    const outcomes = await composeMissing(
      needs,
      {
        // A good hit, then no match, then a hit with a hole.
        search: async () =>
          [
            { identity: "g-sub", lineForm: SUB },
            undefined,
            {
              identity: "g-holed",
              lineForm: "param a\nparam b\nfree helper -> h\nop CallExpression h a b -> r\nout r",
            },
          ][call++],
        model: scripted([SUB]),
      },
      { maxAttempts: 2 },
    );
    expect(tallyCompose(outcomes)).toEqual({
      needs: 3,
      found: 1,
      authored: 2,
      failed: 0,
      synthesisRate: 2 / 3,
      triggers: { "no-match": 1, closure: 1 },
    });
  });

  it("the retrieved context reaches the model on a gap, and the outcome records it (#1271)", async () => {
    const item = (id: string, sourcePkg: string) => ({
      id,
      sourcePkg,
      text: `kept work ${id}`,
      citation: {
        merkleRoot: `root-${id}`,
        sourceFile: `${sourcePkg}/x.js`,
        lineStart: 1,
        lineEnd: 3,
      },
    });
    const context = [item("c1", "p"), item("c2", "q")];
    const asked: SpecYak[] = [];
    const model = scripted([ADD, SUB]);
    const [out] = await composeMissing([need], {
      search: async () => undefined,
      model,
      context: async (c) => {
        asked.push(c);
        return context;
      },
    });
    expect(out?.outcome).toBe("authored");
    expect(out?.contextIds).toEqual(["c1", "c2"]);
    expect(asked).toHaveLength(1);
    // Every attempt, including the retry with findings, carries the same cited context.
    expect(model.requests.map((r) => r.context?.map((c) => c.id))).toEqual([
      ["c1", "c2"],
      ["c1", "c2"],
    ]);
    expect(model.requests[1]?.findings?.[0]?.check).toBe("conformance");
  });

  it("no context dependency, or an empty context, leaves the request as before (#1271)", async () => {
    const plain = scripted([SUB]);
    const [a] = await composeMissing([need], { search: async () => undefined, model: plain });
    expect(plain.requests[0]).not.toHaveProperty("context");
    expect(a).not.toHaveProperty("contextIds");
    const empty = scripted([SUB]);
    const [b] = await composeMissing([need], {
      search: async () => undefined,
      model: empty,
      context: async () => [],
    });
    expect(empty.requests[0]).not.toHaveProperty("context");
    expect(b).not.toHaveProperty("contextIds");
  });

  it("a found atom asks for no context (#1271)", async () => {
    let calls = 0;
    await composeMissing([need], {
      search: async () => ({ identity: "g-sub", lineForm: SUB }),
      model: scripted([ADD]),
      context: async () => {
        calls++;
        return [];
      },
    });
    expect(calls).toBe(0);
  });
});
