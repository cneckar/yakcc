// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for rustfmt.ts -- injectable-spawn seam.
 *
 * Tests ONLY use the identity mock (identityRustfmtSpawn).
 * Real-rustfmt tests are gated behind YAKCC_RUST_E2E in polyglot-rust.yml.
 */

import { describe, expect, it } from "vitest";
import { RustfmtError, formatWithRustfmt, identityRustfmtSpawn } from "./rustfmt.js";

const RUST_SOURCE = `pub fn add(a: i32, b: i32) -> i32 {
    return a + b;
}
`;

describe("formatWithRustfmt -- identity mock (pure-Node, no Rust toolchain)", () => {
  it("identity mock returns input unchanged", async () => {
    const result = await formatWithRustfmt(RUST_SOURCE, {
      spawnImpl: identityRustfmtSpawn(),
    });
    expect(result).toBe(RUST_SOURCE);
  });

  it("identity mock works for empty source", async () => {
    const result = await formatWithRustfmt("", {
      spawnImpl: identityRustfmtSpawn(),
    });
    expect(result).toBe("");
  });

  it("identity mock works for multiline source", async () => {
    const multiline = "pub fn a() -> i32 {\n    1\n}\n\npub fn b() -> i32 {\n    2\n}\n";
    const result = await formatWithRustfmt(multiline, {
      spawnImpl: identityRustfmtSpawn(),
    });
    expect(result).toBe(multiline);
  });

  it("RustfmtError is an Error subclass", () => {
    const err = new RustfmtError("test", 1, "stderr text");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RustfmtError);
    expect(err.exitCode).toBe(1);
    expect(err.stderr).toBe("stderr text");
    expect(err.name).toBe("RustfmtError");
  });

  it("SpawnImpl that exits non-zero causes RustfmtError", async () => {
    const failSpawn = () => {
      const { EventEmitter } = require("node:events");
      const { PassThrough } = require("node:stream");
      const emitter = new EventEmitter();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      (emitter as Record<string, unknown>).stdin = stdin;
      (emitter as Record<string, unknown>).stdout = stdout;
      (emitter as Record<string, unknown>).stderr = stderr;
      // emit close with non-zero exit code after a tick
      setImmediate(() => emitter.emit("close", 1));
      return emitter;
    };

    await expect(formatWithRustfmt(RUST_SOURCE, { spawnImpl: failSpawn as never })).rejects.toThrow(
      RustfmtError,
    );
  });
});

// Real-rustfmt suite -- only runs when YAKCC_RUST_E2E=1
// Mirrors shave-rust's DEC-POLYGLOT-RUST-E2E-GATE-001 gating pattern.
describe.skipIf(!process.env.YAKCC_RUST_E2E)(
  "formatWithRustfmt -- real rustfmt (YAKCC_RUST_E2E=1 only)",
  () => {
    it("real rustfmt formats a simple function", async () => {
      // This test requires `rustfmt` on PATH (provisioned by polyglot-rust.yml)
      const unformatted = "pub fn add(a:i32,b:i32)->i32{a+b}\n";
      const formatted = await formatWithRustfmt(unformatted);
      // rustfmt adds spaces and newlines
      expect(formatted).toContain("pub fn add");
      expect(formatted).toContain("i32");
    });
  },
);
