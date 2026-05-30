import { describe, it, expect } from "vitest";
import {
  AmbiguousPurityError,
  CannotLowerToPythonError,
  CannotRaiseToIRError,
  type SourceLocation,
} from "./polyglot-errors.js";

const LOC: SourceLocation = { file: "src/foo.py", line: 12, col: 4 };

describe("CannotRaiseToIRError", () => {
  it("default message includes construct + file:line:col", () => {
    const err = new CannotRaiseToIRError("async function", LOC);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CannotRaiseToIRError);
    expect(err.name).toBe("CannotRaiseToIRError");
    expect(err.message).toBe("Cannot raise to IR: async function at src/foo.py:12:4");
    expect(err.construct).toBe("async function");
    expect(err.location).toEqual(LOC);
  });

  it("explicit message overrides the default", () => {
    const err = new CannotRaiseToIRError("yield", LOC, "Python generators are not raiseable");
    expect(err.message).toBe("Python generators are not raiseable");
    expect(err.construct).toBe("yield");
    expect(err.location).toEqual(LOC);
  });

  it("is throw/catch usable via instanceof", () => {
    let caught: unknown = null;
    try {
      throw new CannotRaiseToIRError("decorator", LOC);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CannotRaiseToIRError);
    if (caught instanceof CannotRaiseToIRError) {
      expect(caught.construct).toBe("decorator");
    }
  });
});

describe("AmbiguousPurityError", () => {
  it("message includes reason + file:line:col", () => {
    const err = new AmbiguousPurityError(
      "dynamic dispatch through `getattr`",
      LOC,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AmbiguousPurityError);
    expect(err.name).toBe("AmbiguousPurityError");
    expect(err.message).toBe(
      "Ambiguous purity at src/foo.py:12:4: dynamic dispatch through `getattr`",
    );
    expect(err.reason).toBe("dynamic dispatch through `getattr`");
    expect(err.location).toEqual(LOC);
  });

  it("distinct from CannotRaiseToIRError via instanceof", () => {
    const err = new AmbiguousPurityError("opaque import", LOC);
    expect(err).not.toBeInstanceOf(CannotRaiseToIRError);
  });
});

describe("CannotLowerToPythonError", () => {
  const loc = { line: 7, column: 2 };

  it("message includes nodeKind, fnName, location, and snippet", () => {
    const err = new CannotLowerToPythonError(
      "FunctionExpression",
      loc,
      "function(x) { return x + 1; }",
      "myHelper",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CannotLowerToPythonError);
    expect(err.name).toBe("CannotLowerToPythonError");
    expect(err.message).toBe(
      "Cannot lower TS-subset IR to Python: FunctionExpression at myHelper:7:2 — function(x) { return x + 1; }",
    );
    expect(err.nodeKind).toBe("FunctionExpression");
    expect(err.location).toEqual(loc);
    expect(err.snippet).toBe("function(x) { return x + 1; }");
    expect(err.fnName).toBe("myHelper");
  });

  it("uses <top-level> when fnName is undefined", () => {
    const err = new CannotLowerToPythonError(
      "SwitchStatement",
      { line: 1, column: 0 },
      "switch (x) {",
      undefined,
    );
    expect(err.message).toContain("<top-level>");
    expect(err.fnName).toBeUndefined();
  });

  it("is throw/catch usable via instanceof", () => {
    let caught: unknown = null;
    try {
      throw new CannotLowerToPythonError("ForInStatement", loc, "for (k in obj)", undefined);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CannotLowerToPythonError);
    if (caught instanceof CannotLowerToPythonError) {
      expect(caught.nodeKind).toBe("ForInStatement");
    }
  });

  it("is distinct from CannotRaiseToIRError via instanceof", () => {
    const err = new CannotLowerToPythonError("SwitchStatement", loc, "switch", undefined);
    expect(err).not.toBeInstanceOf(CannotRaiseToIRError);
    expect(err).not.toBeInstanceOf(AmbiguousPurityError);
  });
});
