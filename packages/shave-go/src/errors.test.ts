// SPDX-License-Identifier: MIT
//
// errors.test.ts — unit tests for the Go raise adapter error taxonomy (WI-870 slice 2).
//
// Verifies that every error class:
// 1. Is instanceof CannotRaiseToIRError (or AmbiguousPurityError) from @yakcc/contracts.
// 2. Populates .construct and .location correctly.
// 3. Has a distinct .name for introspection.

import { AmbiguousPurityError, CannotRaiseToIRError } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import {
  GoAmbiguousPurityError,
  GoChanRecvError,
  GoChanSendError,
  GoDeferError,
  GoGoroutineError,
  GoSelectError,
  GoUnsupportedConstructError,
} from "./errors.js";
import type { SourceLocation } from "./errors.js";

const LOC: SourceLocation = { file: "stdin.go", line: 10, col: 5 };

describe("GoGoroutineError", () => {
  it("is instanceof CannotRaiseToIRError", () => {
    const err = new GoGoroutineError(LOC);
    expect(err).toBeInstanceOf(CannotRaiseToIRError);
    expect(err).toBeInstanceOf(GoGoroutineError);
  });
  it("has construct 'go (goroutine)'", () => {
    const err = new GoGoroutineError(LOC);
    expect(err.construct).toBe("go (goroutine)");
  });
  it("has location matching LOC", () => {
    const err = new GoGoroutineError(LOC);
    expect(err.location).toEqual(LOC);
  });
  it("has name GoGoroutineError", () => {
    expect(new GoGoroutineError(LOC).name).toBe("GoGoroutineError");
  });
  it("message mentions the file:line:col", () => {
    const err = new GoGoroutineError(LOC);
    expect(err.message).toContain("stdin.go:10:5");
  });
});

describe("GoChanSendError", () => {
  it("is instanceof CannotRaiseToIRError", () => {
    expect(new GoChanSendError(LOC)).toBeInstanceOf(CannotRaiseToIRError);
  });
  it("has construct 'chan send (<-)'", () => {
    expect(new GoChanSendError(LOC).construct).toBe("chan send (<-)");
  });
  it("has name GoChanSendError", () => {
    expect(new GoChanSendError(LOC).name).toBe("GoChanSendError");
  });
});

describe("GoChanRecvError", () => {
  it("is instanceof CannotRaiseToIRError", () => {
    expect(new GoChanRecvError(LOC)).toBeInstanceOf(CannotRaiseToIRError);
  });
  it("has construct 'chan recv (<-)'", () => {
    expect(new GoChanRecvError(LOC).construct).toBe("chan recv (<-)");
  });
  it("has name GoChanRecvError", () => {
    expect(new GoChanRecvError(LOC).name).toBe("GoChanRecvError");
  });
});

describe("GoSelectError", () => {
  it("is instanceof CannotRaiseToIRError", () => {
    expect(new GoSelectError(LOC)).toBeInstanceOf(CannotRaiseToIRError);
  });
  it("has construct 'select'", () => {
    expect(new GoSelectError(LOC).construct).toBe("select");
  });
  it("has name GoSelectError", () => {
    expect(new GoSelectError(LOC).name).toBe("GoSelectError");
  });
});

describe("GoDeferError", () => {
  it("is instanceof CannotRaiseToIRError", () => {
    expect(new GoDeferError(LOC)).toBeInstanceOf(CannotRaiseToIRError);
  });
  it("has construct 'defer'", () => {
    expect(new GoDeferError(LOC).construct).toBe("defer");
  });
  it("has name GoDeferError", () => {
    expect(new GoDeferError(LOC).name).toBe("GoDeferError");
  });
});

describe("GoUnsupportedConstructError", () => {
  it("is instanceof CannotRaiseToIRError", () => {
    expect(new GoUnsupportedConstructError("IfStmt", LOC)).toBeInstanceOf(CannotRaiseToIRError);
  });
  it("has construct matching the provided string", () => {
    expect(new GoUnsupportedConstructError("ForStmt", LOC).construct).toBe("ForStmt");
  });
  it("has name GoUnsupportedConstructError", () => {
    expect(new GoUnsupportedConstructError("X", LOC).name).toBe("GoUnsupportedConstructError");
  });
});

describe("GoAmbiguousPurityError", () => {
  it("is instanceof AmbiguousPurityError", () => {
    expect(new GoAmbiguousPurityError("opaque dispatch", LOC)).toBeInstanceOf(AmbiguousPurityError);
  });
  it("has name GoAmbiguousPurityError", () => {
    expect(new GoAmbiguousPurityError("x", LOC).name).toBe("GoAmbiguousPurityError");
  });
  it("has reason populated", () => {
    const err = new GoAmbiguousPurityError("opaque interface call", LOC);
    expect(err.reason).toBe("opaque interface call");
  });
  it("has location populated", () => {
    const err = new GoAmbiguousPurityError("x", LOC);
    expect(err.location).toEqual(LOC);
  });
});

describe("Error taxonomy completeness — >=5 distinct CannotRaiseToIRError subclasses", () => {
  // The evaluation contract requires >= 5 distinct unsupported-construct classes.
  // All 5 banned-construct classes + GoUnsupportedConstructError = 6 classes total.
  const bannedClasses = [
    ["GoGoroutineError", () => new GoGoroutineError(LOC)],
    ["GoChanSendError", () => new GoChanSendError(LOC)],
    ["GoChanRecvError", () => new GoChanRecvError(LOC)],
    ["GoSelectError", () => new GoSelectError(LOC)],
    ["GoDeferError", () => new GoDeferError(LOC)],
    ["GoUnsupportedConstructError", () => new GoUnsupportedConstructError("X", LOC)],
  ] as const;

  for (const [name, factory] of bannedClasses) {
    it(`${name} instanceof CannotRaiseToIRError`, () => {
      expect(factory()).toBeInstanceOf(CannotRaiseToIRError);
    });
    it(`${name} .construct is populated`, () => {
      const err = factory();
      expect(typeof (err as CannotRaiseToIRError).construct).toBe("string");
      expect((err as CannotRaiseToIRError).construct.length).toBeGreaterThan(0);
    });
    it(`${name} .location is populated`, () => {
      const err = factory();
      expect((err as CannotRaiseToIRError).location).toMatchObject({
        file: expect.any(String) as string,
        line: expect.any(Number) as number,
        col: expect.any(Number) as number,
      });
    });
  }
});
