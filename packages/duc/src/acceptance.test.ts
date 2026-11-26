// SPDX-License-Identifier: Apache-2.0
/**
 * The self-rebuild acceptance, interim (#1370): the acceptance command (@yakcc/contracts'
 * canonicalize and contract id) shaved to a record of roots, its closure checked and listed, and
 * built from the roots alone, with no C library: the same executable as from its sources, printing
 * what Node does. Step 5, interim: a native command that computes graphs' roots gives every root of
 * its own closure and of the acceptance command's, as the Node-hosted store does.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalizeText } from "../../contracts/src/canonicalize.js";
import { contractId } from "../../contracts/src/contract-id.js";
import { canRun } from "./__fixtures__/native-harness.js";
import { AcceptanceError, closureListing, programOfRoots, shaveProgram } from "./acceptance.js";
import { buildRecord } from "./build.js";
import { encodeGraph } from "./compact.js";
import { emitNativeModules } from "./emit-llvm-boxed.js";
import { programRecord } from "./program.js";
import { packGraph } from "./store.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const work = mkdtempSync(join(tmpdir(), "yakcc-acceptance-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const field = fc.record({
  name: fc.string({ minLength: 1, maxLength: 12 }),
  type: fc.string({ minLength: 1, maxLength: 24 }),
});
const spec = fc.record({
  inputs: fc.array(field, { maxLength: 3 }),
  outputs: fc.array(field, { maxLength: 3 }),
  behavior: fc.string({ minLength: 1, maxLength: 120 }),
  guarantees: fc.array(
    fc.record({ id: fc.string({ minLength: 1 }), description: fc.string({ minLength: 1 }) }),
    { maxLength: 2 },
  ),
  errorConditions: fc.array(fc.record({ description: fc.string({ minLength: 1 }) }), {
    maxLength: 2,
  }),
  nonFunctional: fc.record({
    purity: fc.constantFrom("pure", "io"),
    threadSafety: fc.constantFrom("safe", "unsafe"),
  }),
  propertyTests: fc.array(
    fc.record({ id: fc.string({ minLength: 1 }), description: fc.string({ minLength: 1 }) }),
    { maxLength: 2 },
  ),
});

describe.skipIf(!canRun("x86_64-linux"))("the self-rebuild acceptance, interim (#1370)", () => {
  it("the acceptance command: shaved to roots, closed, and built from the roots alone with no C library", () => {
    const program = programRecord(
      here("./__fixtures__/program/contract-id-cli.ts"),
      here("../../.."),
    );
    // 1. Shaved: every graph a root in the store; the record's root is stable.
    const shaved = shaveProgram(program);
    expect(shaved.store.size).toBeGreaterThan(0);
    expect(shaveProgram(program).root).toBe(shaved.root);
    // 2. Closed: every free name is a module's binding, an import, a leaf or the runtime's global.
    const listing = closureListing(program);
    expect(listing.unlinked).toEqual([]);
    expect(listing.globals).toContain("JSON");
    expect(listing.runtime).toHaveLength(2);
    // 3. From the roots alone: the same program, so the same IR, the same executable.
    const rebuilt = programOfRoots(shaved.record, shaved.store);
    expect(emitNativeModules(rebuilt.modules).ir).toBe(emitNativeModules(program.modules).ir);
    const fromSources = join(work, "from-sources");
    const fromRoots = join(work, "from-roots");
    buildRecord(program, fromSources, { noLibc: true });
    buildRecord(rebuilt, fromRoots, { noLibc: true });
    expect(readFileSync(fromRoots).equals(readFileSync(fromSources))).toBe(true);
    const specs = fc.sample(spec, { numRuns: 30, seed: 1370 });
    const run = spawnSync(
      fromRoots,
      specs.map((s) => JSON.stringify(s)),
      { maxBuffer: 1 << 24 },
    );
    expect([run.status, run.stderr.toString()]).toEqual([0, ""]);
    expect(run.stdout.toString().split("\n").slice(0, -1)).toEqual(
      specs.map((s) => `${contractId(s as never)} ${canonicalizeText(s as never).length}`),
    );
  }, 900_000);

  it("step 5, the interim fixpoint: the native root command gives every root of its own closure and the acceptance command's, as Node's store does", () => {
    // The root command, built natively with no C library from root.ts's closure alone.
    const command = programRecord(
      here("./__fixtures__/program/graph-root-cli.ts"),
      here("../../.."),
    );
    const listing = closureListing(command);
    expect(listing.unlinked).toEqual([]);
    const binary = join(work, "graph-root");
    buildRecord(command, binary, { noLibc: true });
    const acceptance = programRecord(
      here("./__fixtures__/program/contract-id-cli.ts"),
      here("../../.."),
    );
    for (const program of [command, acceptance]) {
      const graphs = program.modules.flatMap((m) => m.statements.map((st) => st.graph));
      const want = graphs.map((g) => packGraph(g).root);
      const got: string[] = [];
      // Each graph one argument, in batches the kernel's argument limit takes.
      for (let i = 0; i < graphs.length; i += 20) {
        const run = spawnSync(
          binary,
          graphs.slice(i, i + 20).map((g) => JSON.stringify(encodeGraph(g))),
          { maxBuffer: 1 << 24 },
        );
        expect([run.status, run.stderr.toString()]).toEqual([0, ""]);
        got.push(...run.stdout.toString().split("\n").slice(0, -1));
      }
      expect(got).toEqual(want);
      // The same roots shaveProgram stores the program under.
      expect(new Set(got)).toEqual(new Set(shaveProgram(program).store.keys()));
    }
  }, 900_000);

  it("a root missing from the store, or a graph stored under another's root, is refused", () => {
    const program = programRecord(
      here("./__fixtures__/program/contract-id-cli.ts"),
      here("../../.."),
    );
    const shaved = shaveProgram(program);
    const [first, second] = [...shaved.store.keys()];
    const missing = new Map(shaved.store);
    missing.delete(first as string);
    expect(() => programOfRoots(shaved.record, missing)).toThrow(AcceptanceError);
    const swapped = new Map(shaved.store);
    swapped.set(first as string, shaved.store.get(second as string) as never);
    expect(() => programOfRoots(shaved.record, swapped)).toThrow(/not that root's/);
  }, 600_000);
});
