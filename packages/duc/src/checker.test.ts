// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type CheckerSpec, checkerSpecHash, runChecker, validateCheckerSpec } from "./checker.js";
import { liftAtom } from "./lift.js";

const here = dirname(fileURLToPath(import.meta.url));
const loadSpec = (file: string): CheckerSpec =>
  JSON.parse(readFileSync(join(here, "..", "checkers", file), "utf8")) as CheckerSpec;

const WRITE: CheckerSpec = {
  name: "t",
  version: 1,
  sources: [{ kind: "param" }],
  sinks: ["write"],
  sanitizers: ["sanitizeFilename"],
};

describe("declarative checker specs (WI-GUARD A3, #1256)", () => {
  it("reports a parameter that reaches a sink with no sanitizer, unguarded", () => {
    const g = liftAtom("export function f(p: string) { return write(p); }");
    const findings = runChecker(WRITE, g);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.sink).toBe("write");
    expect(findings[0]?.unguarded).toBe(true);
    expect(findings[0]?.witness).toContain("param-source");
  });

  it("a declared sanitizer cuts the flow: no finding", () => {
    const g = liftAtom("export function f(p: string) { return write(sanitizeFilename(p)); }");
    expect(runChecker(WRITE, g)).toEqual([]);
  });

  it("an undeclared check does NOT cut the flow (sanitizers are declared, never inferred)", () => {
    const g = liftAtom("export function f(p: string) { return write(check(p)); }");
    expect(runChecker(WRITE, g)).toHaveLength(1);
  });

  it("a flow through a branch is reported with the guard predicate", () => {
    const g = liftAtom(
      "export function f(c: boolean, p: string) { let v = ''; if (c) { v = p; } return write(v); }",
    );
    // Two sources: the condition `c` reaches the sink implicitly (unguarded), and the
    // value `p` reaches it only through the branch (guarded by `c`).
    const findings = runChecker(WRITE, g);
    expect(findings).toHaveLength(2);
    expect(findings.some((f) => f.unguarded)).toBe(true);
    const guarded = findings.find((f) => !f.unguarded);
    expect(guarded?.guards.length).toBeGreaterThan(0);
  });

  it("a sink call inside a branch: the argument's flow is data, the condition's is control (#1269)", () => {
    const g = liftAtom("export function f(c: boolean, p: string) { if (c) { write(p); } }");
    const findings = runChecker(WRITE, g);
    // p reaches the call's argument with no branch on its path; c decides whether the call happens.
    expect(findings.map((f) => [f.kind, f.unguarded])).toEqual(
      expect.arrayContaining([
        ["data", true],
        ["control", false],
      ]),
    );
    expect(findings).toHaveLength(2);
    expect(findings.find((f) => f.kind === "control")?.guards).toHaveLength(1);
  });

  it("a call gated by a predicate with untainted arguments: control is reported, data is not (#1269)", () => {
    const g = liftAtom(
      'export function f(secret: boolean) { if (secret) { write("x"); } return 1; }',
    );
    const findings = runChecker(WRITE, g);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("control");
    // A call merely ordered after the branch is not reached through its heap token.
    const after = liftAtom(
      'export function f(secret: boolean) { let n = 0; if (secret) { n = 1; } write("x"); return n; }',
    );
    expect(runChecker(WRITE, after)).toEqual([]);
  });

  it("a source selector that matches nothing produces no findings", () => {
    const g = liftAtom("export function f(p: string) { return write(p); }");
    const spec: CheckerSpec = { ...WRITE, sources: [{ kind: "diamond", symbol: "absent" }] };
    expect(runChecker(spec, g)).toEqual([]);
  });

  it("the content address is stable across key order and changes with content", () => {
    const a = checkerSpecHash(WRITE);
    const reordered = {
      sanitizers: ["sanitizeFilename"],
      sinks: ["write"],
      sources: [{ kind: "param" as const }],
      version: 1 as const,
      name: "t",
    };
    expect(checkerSpecHash(reordered as CheckerSpec)).toBe(a);
    expect(checkerSpecHash({ ...WRITE, sinks: ["eval"] })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("validates the spec structure", () => {
    expect(validateCheckerSpec(WRITE)).toBeNull();
    expect(validateCheckerSpec(null)).toMatch(/not an object/);
    expect(validateCheckerSpec({ ...WRITE, name: "" })).toMatch(/name/);
    expect(validateCheckerSpec({ ...WRITE, version: 2 })).toMatch(/version/);
    expect(validateCheckerSpec({ ...WRITE, sources: [] })).toMatch(/source/);
    expect(validateCheckerSpec({ ...WRITE, sinks: [] })).toMatch(/sink/);
    expect(validateCheckerSpec({ ...WRITE, sources: [{ kind: "global" }] })).toMatch(/source kind/);
  });

  describe("the three example checkers in packages/duc/checkers", () => {
    it("each loads, validates, and has a content address", () => {
      for (const file of [
        "untrusted-to-write.json",
        "ambient-to-exec.json",
        "foreign-to-send.json",
      ]) {
        const spec = loadSpec(file);
        expect(validateCheckerSpec(spec)).toBeNull();
        expect(checkerSpecHash(spec)).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it("untrusted-to-write fires on a raw parameter and not on a sanitized one", () => {
      const spec = loadSpec("untrusted-to-write.json");
      expect(
        runChecker(spec, liftAtom("export function f(p: string) { return write(p); }")),
      ).toHaveLength(1);
      expect(
        runChecker(
          spec,
          liftAtom("export function f(p: string) { return write(sanitizeFilename(p)); }"),
        ),
      ).toEqual([]);
    });

    it("ambient-to-exec fires when an ambient global reaches exec", () => {
      const spec = loadSpec("ambient-to-exec.json");
      const findings = runChecker(
        spec,
        liftAtom("export function f() { return exec(globalThis); }"),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.sourceLabel).toBe("globalThis");
    });

    it("foreign-to-send is cut by the declared encrypt step", () => {
      const spec = loadSpec("foreign-to-send.json");
      const src =
        'import { secret } from "vault";\nexport function f() { return send(encrypt(secret)); }';
      expect(runChecker(spec, liftAtom(src))).toEqual([]);
      const plain = 'import { secret } from "vault";\nexport function f() { return send(secret); }';
      expect(runChecker(spec, liftAtom(plain))).toHaveLength(1);
    });
  });
});
