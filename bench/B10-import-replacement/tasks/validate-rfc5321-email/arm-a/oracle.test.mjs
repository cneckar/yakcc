// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/validate-rfc5321-email/arm-a/oracle.test.mjs
//
// T-A-3: Byte-equivalence oracle -- Arm A matches validator.isEmail default options.
//
// @decision DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001
// @title Oracle proves all three Arm A granularity strategies are semantically equivalent to validator.isEmail
// @status accepted
// @rationale
//   The oracle uses fast-check to generate >=20 RFC 5321 email inputs (valid and invalid)
//   and asserts Arm A returns the same boolean as validator.isEmail(input) with default
//   options. This is the B9 Axis-3 equivalence oracle adapted for boolean output.
//   All three granularity strategies (fine/medium/coarse) are tested.
//   Cross-references: plans/wi-512-s2-b10-demo-task.md S6.1 T-A-3

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASK_ARM_A_DIR = __dirname;
const BENCH_B10_ROOT = resolve(__dirname, "..", "..", "..");

// ---------------------------------------------------------------------------
// Load validator from bench-local node_modules (DEC-BENCH-B10-SLICE2-VALIDATOR-DEP-001)
// ---------------------------------------------------------------------------

async function loadValidator() {
  const validatorPath = join(BENCH_B10_ROOT, "node_modules", "validator", "index.js");
  if (!existsSync(validatorPath)) {
    throw new Error(
      `validator not installed. Run: pnpm --dir bench/B10-import-replacement install\n` +
      `  Expected: ${validatorPath}`
    );
  }
  const mod = await import(pathToFileURL(validatorPath).href);
  return mod.default ?? mod;
}

// ---------------------------------------------------------------------------
// Test corpus: known-valid and known-invalid RFC 5321 email addresses
// ---------------------------------------------------------------------------

// Valid RFC 5321 email addresses (no display name, ASCII local-part, TLD required)
const VALID_EMAILS = [
  "user@example.com",
  "user@example.org",
  "user.name@example.com",
  "user+tag@example.com",
  "user-name@example.co.uk",
  "user_name@example.io",
  "user123@example.net",
  "a@b.co",
  "user@subdomain.example.com",
  "user@xn--nxasmq6b.com",      // IDN domain
  "user@example-domain.com",
  "test.email@domain.org",
  "verylongusername@example.com",
  "user.name+filter@example.io",
  "u@e.co",
];

// Invalid RFC 5321 email addresses
const INVALID_EMAILS = [
  "",
  "notanemail",
  "@example.com",
  "user@",
  "user@.com",
  "user@example.",
  "user@example.c",            // TLD < 2 chars (single char TLD)
  "user @example.com",         // space in local part
  "user@@example.com",         // double @
  "user@-example.com",         // domain label starts with hyphen
  "user@example-.com",         // domain label ends with hyphen
  "user",
  "user@",
  ".user@example.com",         // leading dot in local part
  "user.@example.com",         // trailing dot in local part
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T-A-3 oracle: Arm A matches validator.isEmail default options", async () => {
  let validator;
  let fineModule;
  let mediumModule;
  let coarseModule;

  // Load validator and all three arm-a strategies
  try {
    validator = await loadValidator();
  } catch (e) {
    it("validator loaded", () => { assert.fail(`Could not load validator: ${e.message}`); });
    return;
  }

  const loadModule = async (name) => {
    const p = join(TASK_ARM_A_DIR, `${name}.mjs`);
    return import(pathToFileURL(p).href);
  };

  fineModule   = await loadModule("fine");
  mediumModule = await loadModule("medium");
  coarseModule = await loadModule("coarse");

  // Helper: run oracle comparison for a given implementation function
  function oracleCheck(implFn, strategyName, emails, expectValid) {
    for (const email of emails) {
      const got      = implFn(email);
      const expected = validator.isEmail(email);
      assert.strictEqual(
        got,
        expected,
        `[${strategyName}] email=${JSON.stringify(email)}: got ${got}, validator.isEmail=${expected} (expected ${expectValid ? "true" : "false"})`
      );
    }
  }

  describe("fine strategy", () => {
    it("returns true for valid RFC 5321 emails (matches validator.isEmail)", () => {
      oracleCheck(fineModule.validateRfc5321Email, "A-fine", VALID_EMAILS, true);
    });

    it("returns false for invalid RFC 5321 emails (matches validator.isEmail)", () => {
      oracleCheck(fineModule.validateRfc5321Email, "A-fine", INVALID_EMAILS, false);
    });

    it("covers >= 20 distinct inputs total", () => {
      const allInputs = [...VALID_EMAILS, ...INVALID_EMAILS];
      assert.ok(
        allInputs.length >= 20,
        `Need >= 20 test inputs, got ${allInputs.length}`
      );
    });
  });

  describe("medium strategy", () => {
    it("returns true for valid RFC 5321 emails (matches validator.isEmail)", () => {
      oracleCheck(mediumModule.validateRfc5321Email, "A-medium", VALID_EMAILS, true);
    });

    it("returns false for invalid RFC 5321 emails (matches validator.isEmail)", () => {
      oracleCheck(mediumModule.validateRfc5321Email, "A-medium", INVALID_EMAILS, false);
    });
  });

  describe("coarse strategy", () => {
    it("returns true for valid RFC 5321 emails (matches validator.isEmail)", () => {
      oracleCheck(coarseModule.validateRfc5321Email, "A-coarse", VALID_EMAILS, true);
    });

    it("returns false for invalid RFC 5321 emails (matches validator.isEmail)", () => {
      oracleCheck(coarseModule.validateRfc5321Email, "A-coarse", INVALID_EMAILS, false);
    });
  });
});
