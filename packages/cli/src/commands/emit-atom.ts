// SPDX-License-Identifier: MIT
//
// @decision DEC-WI954-001
// @title MVP triplet ingest is TypeScript-only; format DOC enumerates ts/py/go vocabulary
// @status accepted
// @rationale The CLI initially accepts impl.ts + proof/tests.fast-check.ts. The
//   discovery doc explicitly lists impl.{ts,py,go} and proof/tests.fast-check.{ts,py}
//   as the canonical vocabulary the LLM may emit, with a note that Python and Go
//   ingest are deferred. This keeps the LLM-facing prompt aligned with the long-term
//   shape while bounding implementation scope.
//
// @decision DEC-WI954-002
// @title Directory triplet, not envelope
// @status accepted
// @rationale parseBlockTriplet (@yakcc/ir/block-parser.ts) already consumes directory
//   triplets matching the seed-corpus layout. Symmetry with seeds means a stored atom
//   from emit-atom is byte-indistinguishable from a seeded atom. Envelope adds parse
//   complexity for no benefit.
//
// @decision DEC-WI954-003
// @title Subcommand name: yakcc emit-atom <dir>
// @status accepted
// @rationale "Emit" matches the LLM-side semantics. Avoids overloading compile (which
//   lowers spec→source; conceptually inverse). Avoids "accept" (implies a moderation
//   decision the CLI isn't making — the gate is property-test green).
//
// @decision DEC-WI954-004
// @title Property-test execution via child process: node --import tsx <test-file>
// @status accepted
// @rationale Fastest fail-shut boundary (~200ms vs ~3s for vitest). Tests are plain
//   top-level fc.assert calls — no test framework runner needed. Matches the seed-corpus
//   test file convention. Stderr/stdout captured; non-zero exit → property failed.
//
// @decision DEC-WI954-005
// @title Registry path + commons-binding: reuse propose.ts pattern
// @status accepted
// @rationale openRegistry(registryPath, { commonsSubmit }) via makeCommonsBinding is
//   identical to propose.ts:92-104. Default registryPath is DEFAULT_REGISTRY_PATH.
//   Commons-push fires at storeBlock seam per DEC-COMMONS-SUBMIT-AT-STOREBLOCK-001.
//
// @decision DEC-WI954-007
// @title Strict-subset validation is consumed via parseBlockTriplet, not re-implemented
// @status accepted
// @rationale parseBlockTriplet already invokes validateStrictSubset from @yakcc/ir.
//   The CLI surfaces result.validation.ok + ValidationError[] list verbatim.
//   Exit code 3 on strict-subset failure.
//
// @decision DEC-WI954-008
// @title Test-file cwd convention: spawn with cwd=<emitDir>, import ../impl.js
// @status accepted
// @rationale Test file lives in <emitDir>/proof/tests.fast-check.ts and imports
//   the impl as ../impl.js (tsx resolves .js→.ts). The CLI does NOT copy files.
//   This convention matches the existing seed-corpus layout.
//
// @decision DEC-WI954-009
// @title Foreign triplets out of scope for emit-atom MVP
// @status accepted
// @rationale emit-atom handles local triplets only. Foreign atoms (ForeignTripletFields
//   in @yakcc/contracts) have no impl.ts / proof/tests.fast-check.ts. Documented in
//   yakcc-discovery.md.
//
// @decision DEC-WI954-010
// @title Variance fallback discipline enforced by surface choice, not by code change
// @status accepted
// @rationale This WI does NOT modify @yakcc/variance. Discipline documented in
//   yakcc-discovery.md: triplet emission → yakcc emit-atom (canonical); bare-code
//   emission → existing PreToolUse path → variance synthesis (fallback).
//
// @decision DEC-WI954-011
// @title Distinct exit codes per gate (0..6)
// @status accepted
// @rationale 0=ok, 1=usage/IO, 2=spec invalid, 3=strict-subset violation, 4=manifest
//   invalid, 5=property test failed, 6=storeBlock failed. Encoded as named constants.
//   Lets downstream automation distinguish which gate failed.
//
// @decision DEC-WI954-013
// @title --skip-tests flag for CI seeding bypass
// @status accepted
// @rationale Allows CI scripts to ingest pre-vetted triplets without re-running tests.
//   Documented as DANGEROUS — for human-LLM emission this should never be used.
//
// @decision DEC-WI954-014
// @title Test execution timeout: 30s per file
// @status accepted
// @rationale Spawned node --import tsx runs property tests; reasonable upper bound.
//   Exceeding the timeout → kill child, exit 5 with "property tests exceeded 30s timeout".
//   Encoded as EMIT_ATOM_TEST_TIMEOUT_MS for future tuning.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type CanonicalAstHash,
  type SpecHash,
  canonicalAstHash,
  canonicalize,
} from "@yakcc/contracts";
import { parseBlockTriplet } from "@yakcc/ir";
import {
  type BlockTripletRow,
  type Registry,
  type RegistryOptions,
  openRegistry,
} from "@yakcc/registry";
import type { Logger } from "../index.js";
import { makeCommonsBinding } from "../lib/commons-submit.js";
import { readRc } from "../lib/yakccrc.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";

// ---------------------------------------------------------------------------
// Exit codes — named constants per DEC-WI954-011
// ---------------------------------------------------------------------------

/** Exit 0 — triplet validated, tests green, stored. */
export const EMIT_ATOM_EXIT_OK = 0;
/** Exit 1 — usage error or IO failure (missing argument, unreadable dir). */
export const EMIT_ATOM_EXIT_USAGE = 1;
/** Exit 2 — spec.yak failed validateSpecYak. */
export const EMIT_ATOM_EXIT_SPEC_INVALID = 2;
/** Exit 3 — impl.ts violated the strict-subset rules. */
export const EMIT_ATOM_EXIT_STRICT_SUBSET = 3;
/** Exit 4 — proof/manifest.json failed validateProofManifestL0. */
export const EMIT_ATOM_EXIT_MANIFEST_INVALID = 4;
/** Exit 5 — proof/tests.fast-check.ts failed (property test counterexample). */
export const EMIT_ATOM_EXIT_TESTS_FAILED = 5;
/** Exit 6 — storeBlock threw (registry write error). */
export const EMIT_ATOM_EXIT_STOREBLOCK_FAILED = 6;

/** Property-test subprocess timeout in milliseconds (DEC-WI954-014). */
export const EMIT_ATOM_TEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Internal options for emitAtom — embeddings seam for test injection. */
export interface EmitAtomOptions {
  embeddings?: RegistryOptions["embeddings"];
}

// ---------------------------------------------------------------------------
// Property-test execution helper
// ---------------------------------------------------------------------------

interface TestRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn `node --import tsx proof/tests.fast-check.ts` in `emitDir`.
 *
 * Resolves with the exit code, captured stdout/stderr, and a `timedOut` flag.
 * The child process runs in a clean child process — failures never crash the CLI.
 *
 * DEC-WI954-004, DEC-WI954-008: spawn with cwd=emitDir so relative imports
 * from proof/tests.fast-check.ts resolve correctly (../impl.js → tsx→ ../impl.ts).
 */
function runPropertyTests(emitDir: string, tsxBin: string): Promise<TestRunResult> {
  return new Promise((resolve) => {
    const testFile = join("proof", "tests.fast-check.ts");

    const child = spawn(
      process.execPath, // node
      ["--import", tsxBin, testFile],
      {
        cwd: emitDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, EMIT_ATOM_TEST_TIMEOUT_MS);

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        code: exitCode ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        timedOut,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        code: 1,
        stdout: "",
        stderr: `spawn error: ${err.message}`,
        timedOut: false,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc emit-atom <directory> [--registry <p>] [--skip-tests] [--json]`.
 *
 * Reads an LLM-emitted triplet directory, validates it via parseBlockTriplet,
 * runs the LLM-authored property tests against the impl, and persists via
 * storeBlock only if all gates are green.
 *
 * Gates and exit codes (DEC-WI954-011):
 *   0 — triplet validated, tests green, stored
 *   1 — usage error or IO failure
 *   2 — spec.yak invalid (validateSpecYak)
 *   3 — impl.ts strict-subset violation
 *   4 — proof/manifest.json invalid (validateProofManifestL0)
 *   5 — property tests failed (counterexample found or timeout)
 *   6 — storeBlock failed (registry write error)
 *
 * @param argv  - Remaining argv after `emit-atom` has been consumed.
 * @param logger - Output sink; defaults to CONSOLE_LOGGER via the caller.
 * @param opts   - Internal options (embeddings for test injection).
 * @returns Process exit code.
 */
export async function emitAtom(
  argv: readonly string[],
  logger: Logger,
  opts?: EmitAtomOptions,
): Promise<number> {
  // 1. Parse argv (DEC-V0-CLI-004 pattern).
  const parseArgsConfig = {
    args: [...argv],
    options: {
      registry: { type: "string" as const, short: "r" },
      "skip-tests": { type: "boolean" as const, default: false },
      json: { type: "boolean" as const, default: false },
    },
    allowPositionals: true as const,
    strict: true as const,
  };

  let parsed: ReturnType<typeof parseArgs<typeof parseArgsConfig>>;
  try {
    parsed = parseArgs(parseArgsConfig);
  } catch (err) {
    logger.error(`error: ${String(err)}`);
    return EMIT_ATOM_EXIT_USAGE;
  }

  const { values, positionals } = parsed;
  const dirArg = positionals[0];

  if (dirArg === undefined || dirArg === "") {
    logger.error("error: emit-atom requires a <directory> argument");
    logger.error("Usage: yakcc emit-atom <directory> [--registry <p>] [--skip-tests] [--json]");
    return EMIT_ATOM_EXIT_USAGE;
  }

  const emitDir = resolve(dirArg);
  const registryPath = values.registry ?? DEFAULT_REGISTRY_PATH;
  const skipTests = values["skip-tests"] === true;
  const jsonOutput = values.json === true;

  // 2. Verify the directory exists and contains required files.
  const requiredFiles = [
    "spec.yak",
    "impl.ts",
    join("proof", "manifest.json"),
    join("proof", "tests.fast-check.ts"),
  ];

  for (const rel of requiredFiles) {
    const abs = join(emitDir, rel);
    if (!existsSync(abs)) {
      logger.error(`error: required file not found: ${abs}`);
      logger.error(`  expected: ${rel} in ${emitDir}`);
      return EMIT_ATOM_EXIT_USAGE;
    }
  }

  // 3. Parse the triplet via parseBlockTriplet from @yakcc/ir.
  //    Classifies errors: spec invalid → exit 2, strict-subset → exit 3, manifest → exit 4.
  let parseResult: ReturnType<typeof parseBlockTriplet>;
  try {
    parseResult = parseBlockTriplet(emitDir);
  } catch (err) {
    const msg = String(err);
    // Check manifest first — its error message does NOT contain "validateSpecYak"
    // but parseBlockTriplet validates spec before manifest; both throw TypeError
    // with their function name in the message. Check the specific function name
    // strings to avoid false matches on substring "spec" in other error text.
    if (msg.includes("validateProofManifestL0")) {
      logger.error(`gate:manifest-invalid — ${msg}`);
      return EMIT_ATOM_EXIT_MANIFEST_INVALID;
    }
    // validateSpecYak throws TypeError with "validateSpecYak:" prefix
    if (msg.includes("validateSpecYak")) {
      logger.error(`gate:spec-invalid — ${msg}`);
      return EMIT_ATOM_EXIT_SPEC_INVALID;
    }
    // Any other error (e.g. missing file during parse, JSON syntax error)
    logger.error(`gate:parse-error — ${msg}`);
    return EMIT_ATOM_EXIT_USAGE;
  }

  // Surface spec validation errors (exit 2).
  // validateSpecYak throws before returning, so if we get here the spec is valid.
  // The strict-subset result is available in parseResult.validation (never thrown).

  // 4. Check strict-subset validation result (exit 3).
  if (!parseResult.validation.ok) {
    const errors = parseResult.validation.errors
      .map((e) => `  [${e.rule}] ${e.message}`)
      .join("\n");
    logger.error("gate:strict-subset — impl.ts violates strict-subset rules:");
    logger.error(errors);
    return EMIT_ATOM_EXIT_STRICT_SUBSET;
  }

  // 5. Run property tests (unless --skip-tests).
  if (skipTests) {
    logger.error(
      "WARNING: --skip-tests bypasses property-test gate. " +
        "Only use this for bulk admin seeding of pre-vetted triplets.",
    );
  } else {
    // Locate tsx binary relative to this module's package install location.
    // The tsx dep is in the CLI package's node_modules (added as dependency per
    // DEC-WI954-004; scope-widening approved in PLAN.md §6.5).
    const tsxBin = await resolveTsxBin();
    if (tsxBin === null) {
      logger.error(
        "gate:tests-failed — cannot locate tsx binary to run property tests. " +
          "Ensure tsx is installed (it is a dependency of @yakcc/cli).",
      );
      return EMIT_ATOM_EXIT_TESTS_FAILED;
    }

    const result = await runPropertyTests(emitDir, tsxBin);

    if (result.timedOut) {
      logger.error(
        `gate:tests-failed — property tests exceeded ${EMIT_ATOM_TEST_TIMEOUT_MS}ms timeout`,
      );
      return EMIT_ATOM_EXIT_TESTS_FAILED;
    }

    if (result.code !== 0) {
      logger.error("gate:tests-failed — property tests exited non-zero");
      if (result.stderr.length > 0) {
        logger.error(result.stderr.trimEnd());
      }
      if (result.stdout.length > 0) {
        logger.error(result.stdout.trimEnd());
      }
      return EMIT_ATOM_EXIT_TESTS_FAILED;
    }

    // Log test stdout (e.g. "clamp property tests: ok") at info level.
    if (result.stdout.trim().length > 0) {
      logger.log(result.stdout.trimEnd());
    }
  }

  // 6. Build BlockTripletRow from BlockTripletParseResult.
  //    Pattern mirrors packages/seeds/src/seed.ts:83-117 (DEC-SEEDS-STOREBLOCK-T05-002).
  const specCanonicalBytes = canonicalize(
    parseResult.spec as unknown as Parameters<typeof canonicalize>[0],
  );

  const row: BlockTripletRow = {
    blockMerkleRoot: parseResult.merkleRoot,
    specHash: parseResult.specHashValue as SpecHash,
    specCanonicalBytes,
    implSource: parseResult.implSource,
    proofManifestJson: JSON.stringify(parseResult.manifest),
    level: parseResult.spec.level,
    // createdAt=0 signals the registry to use Date.now() (DEC-STORAGE-IDEMPOTENT-001)
    createdAt: 0,
    canonicalAstHash: canonicalAstHash(parseResult.implSource) as CanonicalAstHash,
    artifacts: parseResult.artifacts,
  };

  // 7. Open registry with commons-binding and call storeBlock.
  //    Pattern mirrors propose.ts:88-105 (DEC-WI954-005).
  const rc = readRc(".");
  const airgapped = rc?.mode === "airgapped";
  const commonsBinding = makeCommonsBinding({ registryPath, airgapped });

  let registry: Registry;
  try {
    const openOpts: RegistryOptions = {};
    if (opts?.embeddings !== undefined) openOpts.embeddings = opts.embeddings;
    if (commonsBinding.commonsSubmit !== undefined) {
      openOpts.commonsSubmit = commonsBinding.commonsSubmit;
    }
    registry = await openRegistry(registryPath, openOpts);
  } catch (err) {
    logger.error(`error: failed to open registry at ${registryPath}: ${String(err)}`);
    return EMIT_ATOM_EXIT_USAGE;
  }

  commonsBinding.bind(registry);

  try {
    await registry.storeBlock(row);
  } catch (err) {
    logger.error(`gate:storeblock-failed — ${String(err)}`);
    return EMIT_ATOM_EXIT_STOREBLOCK_FAILED;
  } finally {
    await registry.close();
  }

  // 8. Print result.
  if (jsonOutput) {
    logger.log(
      JSON.stringify({
        merkleRoot: parseResult.merkleRoot,
        specHash: parseResult.specHashValue,
        stored: true,
      }),
    );
  } else {
    logger.log(`stored: ${parseResult.merkleRoot}`);
  }

  return EMIT_ATOM_EXIT_OK;
}

// ---------------------------------------------------------------------------
// tsx binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the tsx binary path from the CLI package's own node_modules.
 *
 * Tries, in order:
 *   1. The tsx binary in the CLI package's local node_modules/.bin (canonical).
 *   2. The tsx binary in the workspace pnpm virtual store.
 *   3. tsx by absolute path relative to this source file's own module directory.
 *
 * Returns null if tsx cannot be located — the caller treats this as a test-execution
 * failure (exit 5) rather than a hard error.
 */
async function resolveTsxBin(): Promise<string | null> {
  // Attempt to find tsx via the tsx package itself.
  // We look for the "import" entry point (tsx/esm-shim or tsx/cjs/index.cjs).
  // When running from dist, this file is adjacent to node_modules at the package root.
  try {
    const { createRequire } = await import("node:module");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");

    // Use createRequire anchored at this file's location to resolve tsx.
    const require = createRequire(fileURLToPath(import.meta.url));
    const tsxPkg = require.resolve("tsx/package.json");
    const tsxDir = dirname(tsxPkg);
    // tsx's CJS shim used for --import flag: tsx/esm or tsx/esm-shim
    // For `node --import tsx`, we need the ESM entry: resolve tsx's dist/esm.js
    const tsxImportPath = join(tsxDir, "dist", "esm.mjs");
    if (existsSync(tsxImportPath)) {
      return tsxImportPath;
    }
    // Fallback to the tsx package root index (tsx may ship a single entry)
    const tsxIndex = require.resolve("tsx");
    return tsxIndex;
  } catch {
    return null;
  }
}
