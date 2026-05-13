// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/debounce-with-cancel/oracle.test.ts
//
// @decision DEC-BENCH-B4-HARNESS-001
// @title B4 harness oracle: debounce wrapper with cancellation
// @status accepted
// @rationale
//   Oracle tests for semantic-equivalence verification. Must pass against reference-impl.ts
//   before Slice 2 measures LLM-generated implementations. Uses vi.useFakeTimers() for
//   deterministic timer control. Tests cover: trailing debounce, cancel(), flush(),
//   pending(), argument forwarding, and waitMs=0 semantics.
//
// Usage:
//   vitest run --config bench/B4-tokens/vitest.config.mjs bench/B4-tokens/tasks/debounce-with-cancel/oracle.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const implPath = process.env["IMPL_PATH"]
  ? resolve(process.env["IMPL_PATH"])
  : resolve(__dirname, "reference-impl.ts");

const implUrl = pathToFileURL(implPath).href;

let debounce: <T extends (...args: unknown[]) => void>(
  fn: T,
  waitMs: number
) => {
  (...args: Parameters<T>): void;
  cancel(): void;
  flush(): void;
  pending(): boolean;
};

beforeEach(async () => {
  vi.useFakeTimers();
  const mod = await import(/* @vite-ignore */ implUrl);
  debounce = mod.debounce ?? mod.default;
  if (typeof debounce !== "function") {
    throw new Error(
      `Implementation at ${implPath} must export debounce as a named or default export function`
    );
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe("debounce — basic trailing debounce", () => {
  it("does not invoke fn synchronously", () => {
    const fn = vi.fn();
    const db = debounce(fn, 100);
    db("a");
    expect(fn).not.toHaveBeenCalled();
  });

  it("invokes fn after waitMs", () => {
    const fn = vi.fn();
    const db = debounce(fn, 100);
    db("a");
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith("a");
  });

  it("does not invoke fn before waitMs elapses", () => {
    const fn = vi.fn();
    const db = debounce(fn, 100);
    db("a");
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("resets timer on repeated calls within window", () => {
    const fn = vi.fn();
    const db = debounce(fn, 100);
    db("first");
    vi.advanceTimersByTime(50);
    db("second");
    vi.advanceTimersByTime(50); // only 50ms since last call
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50); // now 100ms since last call
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith("second");
  });

  it("uses latest arguments when timer resets", () => {
    const fn = vi.fn();
    const db = debounce(fn, 100);
    db(1);
    db(2);
    db(3);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(3);
  });

  it("multiple rapid calls = exactly one invocation", () => {
    const fn = vi.fn();
    const db = debounce(fn, 100);
    for (let i = 0; i < 10; i++) {
      db(i);
    }
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(9);
  });
});

describe("debounce — pending()", () => {
  it("pending() is false before first call", () => {
    const db = debounce(vi.fn(), 100);
    expect(db.pending()).toBe(false);
  });

  it("pending() is true after call, before timer fires", () => {
    const db = debounce(vi.fn(), 100);
    db("x");
    expect(db.pending()).toBe(true);
  });

  it("pending() is false after timer fires", () => {
    const db = debounce(vi.fn(), 100);
    db("x");
    vi.advanceTimersByTime(100);
    expect(db.pending()).toBe(false);
  });

  it("pending() remains true while timer resets", () => {
    const db = debounce(vi.fn(), 100);
    db("a");
    vi.advanceTimersByTime(50);
    db("b"); // reset
    expect(db.pending()).toBe(true);
    vi.advanceTimersByTime(99);
    expect(db.pending()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(db.pending()).toBe(false);
  });
});

describe("debounce — cancel()", () => {
  it("cancel() prevents fn invocation", () => {
    const fn = vi.fn();
    const db = debounce(fn, 100);
    db("x");
    db.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel() sets pending() to false", () => {
    const db = debounce(vi.fn(), 100);
    db("x");
    expect(db.pending()).toBe(true);
    db.cancel();
    expect(db.pending()).toBe(false);
  });

  it("cancel() when not pending is a no-op", () => {
    const fn = vi.fn();
    const db = debounce(fn, 100);
    db.cancel(); // no pending invocation
    expect(fn).not.toHaveBeenCalled();
    expect(db.pending()).toBe(false);
  });

  it("can call debounce again after cancel", () => {
    const fn = vi.fn();
    const db = debounce(fn, 100);
    db("first");
    db.cancel();
    db("second");
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith("second");
  });

  it("cancel during wait — fn never fires", () => {
    const fn = vi.fn();
    const db = debounce(fn, 500);
    db("a");
    vi.advanceTimersByTime(250);
    db.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("debounce — flush()", () => {
  it("flush() invokes fn immediately when pending", () => {
    const fn = vi.fn();
    const db = debounce(fn, 100);
    db("payload");
    db.flush();
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith("payload");
  });

  it("flush() clears pending state", () => {
    const db = debounce(vi.fn(), 100);
    db("x");
    db.flush();
    expect(db.pending()).toBe(false);
  });

  it("flush() does NOT invoke fn again when timer fires after flush", () => {
    const fn = vi.fn();
    const db = debounce(fn, 100);
    db("x");
    db.flush();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledOnce(); // only once from flush
  });

  it("flush() is a no-op when not pending", () => {
    const fn = vi.fn();
    const db = debounce(fn, 100);
    db.flush(); // nothing pending
    expect(fn).not.toHaveBeenCalled();
  });

  it("flush() uses most recent args when called after timer reset", () => {
    const fn = vi.fn();
    const db = debounce(fn, 100);
    db("first");
    vi.advanceTimersByTime(50);
    db("second"); // reset timer, update args
    db.flush();
    expect(fn).toHaveBeenCalledWith("second");
  });
});

describe("debounce — waitMs=0 semantics", () => {
  it("waitMs=0 does not invoke fn synchronously", () => {
    const fn = vi.fn();
    const db = debounce(fn, 0);
    db("x");
    expect(fn).not.toHaveBeenCalled();
    expect(db.pending()).toBe(true);
  });

  it("waitMs=0 fires after vi.runAllTimers()", () => {
    const fn = vi.fn();
    const db = debounce(fn, 0);
    db("x");
    vi.runAllTimers();
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith("x");
  });

  it("waitMs=0 can be cancelled before timer fires", () => {
    const fn = vi.fn();
    const db = debounce(fn, 0);
    db("x");
    db.cancel();
    vi.runAllTimers();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("debounce — argument forwarding", () => {
  it("forwards multiple arguments", () => {
    const fn = vi.fn();
    const db = debounce(fn, 100);
    db(1, 2, 3);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith(1, 2, 3);
  });

  it("forwards object arguments by reference", () => {
    const fn = vi.fn();
    const db = debounce(fn, 100);
    const obj = { key: "value" };
    db(obj);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith(obj);
    expect(fn.mock.calls[0]?.[0]).toBe(obj); // same reference
  });

  it("flush() forwards the most recent arguments", () => {
    const fn = vi.fn();
    const db = debounce(fn, 100);
    db("a", "b");
    db("c", "d");
    db.flush();
    expect(fn).toHaveBeenCalledWith("c", "d");
  });
});

describe("debounce — sequential independent calls (non-overlapping windows)", () => {
  it("two sequential calls separated by > waitMs both fire", () => {
    const fn = vi.fn();
    const db = debounce(fn, 100);
    db("first");
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    db("second");
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[0]?.[0]).toBe("first");
    expect(fn.mock.calls[1]?.[0]).toBe("second");
  });
});
