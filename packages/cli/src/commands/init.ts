// SPDX-License-Identifier: MIT
//
// init.ts — handler for `yakcc init [options]`
//
// First-30-seconds surface for v0.5 GTM. Single command that:
//   1. Creates .yakcc/ directory layout
//   2. Initializes the SQLite registry
//   3. Auto-detects installed IDEs and installs hooks for each
//   4. Seeds the bootstrap corpus (unless --no-seed)
//   5. Writes .yakccrc.json with mode + installedHooks fields
//   6. Prints a concise ≤6-line summary
//
// @decision DEC-CLI-INIT-001
// title: Config-file format, transitive hook install, auto-seed policy
// status: superseded-by-addendum (WI-V05-INIT-COMMAND #204; amended by DEC-CLI-INIT-002)
// rationale:
//   CONFIG FORMAT: `.yakccrc.json` at the target directory root (not inside
//   `.yakcc/`). Rationale — keeps the project config visible at the repo root
//   alongside package.json, .eslintrc, etc. Avoids nesting user-facing config
//   inside the data directory. Alternative `.yakcc/config.json` was rejected
//   because it conflates operational data (SQLite, telemetry) with project
//   configuration. Inline `package.json yakcc:` key was rejected because yakcc
//   is not always used inside a Node.js project.
//
//   TRANSITIVE HOOK INSTALL: yes — `yakcc init` calls each IDE's install function
//   directly (not via shell subprocess). Rationale — composing the real
//   function call ensures the same code path that `yakcc hooks <ide> install`
//   exercises; no duplication, no subprocess overhead, no PATH dependency.
//   DEC-CLI-INDEX-001 establishes the pattern: each command is a callable
//   function, not a subprocess. DEC-CLI-INIT-002 extends this to all four IDEs.
//
//   AUTO-SEED POLICY: changed by DEC-CLI-INIT-002 — `yakcc init` now calls
//   `seedYakccCorpus` by default (the bootstrap corpus, ~3k+ atoms). `--no-seed`
//   is the opt-out that restores the pre-DEC-CLI-INIT-002 quiet-init shape.
//
//   PEER REGISTRATION: when `--peer <url>` is provided, init writes the peer
//   URL into `.yakccrc.json` under `federation.peers[]` and immediately runs
//   `yakcc federation mirror` against it. This gives the user a populated
//   registry from their team peer on first boot. URL validation is strict (must
//   be http: or https:) to fail fast on typos.
//
// @decision DEC-CLI-INIT-002
// title: Single-command `yakcc init` collapses init+seed+hooks-install into one entry;
//        auto-detects IDEs; supersedes the no-auto-seed clause of DEC-CLI-INIT-001
// status: superseded-by-addendum (WI-656-S1; amended by DEC-WPE-DEFAULT-PEER-001)
// rationale:
//   Operator decision 2026-05-17 to collapse the first-touch surface. Every
//   user-facing first-impression flows through `yakcc init`. The 6 new flags
//   (--local, --airgapped, --peer, --skip-hooks, --ide, --no-seed) allow precise
//   control without breaking backward compat for existing --target and --peer usage.
//   IDE auto-detection uses DEC-CLI-IDE-DETECT-SEMANTICS-001 (config-dir probe).
//   Installer dispatch uses a thin table (DEC-CLI-IDE-INSTALLER-DISPATCH-001).
//   Backward compat preserved: --target and --peer semantics unchanged.
//
// @decision DEC-WPE-DEFAULT-PEER-001
// title: registry.yakcc.com becomes the default federation peer on yakcc init
// status: accepted (WI-WPE-C / #771 — Slice 2: registry default mirror-on-init)
// rationale:
//   REVERSAL OF DEC-CLI-INIT-001 / DEC-CLI-INIT-002 offline-first posture:
//   Previously, `yakcc init` (no flags) wrote mode="local" with no federation
//   peer, implementing an offline-first default. This decision reverses that
//   for the init first-touch surface only. yakforge now runs a public registry
//   at registry.yakcc.com; the GTM goal requires new users to get a populated
//   registry on first boot without passing any flags.
//
//   NARROWING OF DEC-AXIS-017 F-axis-opt-in framing:
//   DEC-AXIS-017 frames federation as opt-in via the F-axis. This decision
//   narrows that framing for the `init` first-touch surface: the default peer
//   (registry.yakcc.com) is registered automatically on `yakcc init`, making
//   the public registry the out-of-box experience. The F-axis opt-in posture
//   is preserved for all other federation operations; only init is affected.
//
//   MODE LADDER (unchanged):
//   --airgapped > --peer > --local > default(global/registry.yakcc.com)
//   --local and --airgapped remain valid explicit opt-outs; each writes no
//   default peer and does not mirror. Default init is semantically "global"
//   — that mode value is written to .yakccrc.json to signal peer registration.
//
//   DEFAULT PEER: lives in a single named constant (DEFAULT_REGISTRY_PEER_URL).
//   The mirror path reuses the existing runFederation(["mirror", ...]) seam;
//   no parallel mirror mechanism is introduced. Mirror failure is non-fatal
//   (warning only) — the registry is still initialized and the peer is recorded.
//
//   GRACEFUL DEGRADATION (registry may be down at first-boot time):
//   The mirror attempt is bounded by MIRROR_TIMEOUT_MS (10 s). If the mirror
//   times out or fails, init logs one concise warning and continues — the peer
//   URL is still written to .yakccrc.json so `yakcc federation mirror` can be
//   re-run manually later. This prevents `yakcc init` from hanging on a cold
//   start when registry.yakcc.com is temporarily unreachable.
//
//   TESTABILITY SEAM: InitOptions.runFederation may be injected by tests to
//   replace the real runFederation call. Without this seam, every init test
//   that exercises the default-peer path would attempt a real HTTP call to
//   registry.yakcc.com (or hang on the timeout). The seam lets tests assert
//   the correct mirror args without network I/O. Production callers omit the
//   option; the real runFederation from ./federation.js is used by default.
//
//   ROLLBACK: revert the slice PR; yakcc init returns to offline-first default;
//   no .yakccrc.json migration needed (change affects new init runs only).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PROJECT_MANIFEST_PATH, emptyManifest, serializeProjectManifest } from "@yakcc/compile";
import { type Registry, openRegistry } from "@yakcc/registry";
import type { Logger } from "../index.js";
import { writeCLaudeMdDiscovery } from "../lib/claude-md-config.js";
import { type IdeName, KNOWN_IDE_NAMES, detectInstalledIdes } from "../lib/ide-detect.js";
import { writeMcpJsonEntry } from "../lib/mcp-config.js";
import {
  RC_FILENAME,
  type YakccEmbeddingConfig,
  type YakccRc,
  readRc,
  writeRc,
} from "../lib/yakccrc.js";
import { writeDiscoverySnippet } from "./discovery-snippet.js";
import { hooksAiderInstall } from "./hooks-aider-install.js";
import { hooksClineInstall } from "./hooks-cline-install.js";
import { hooksContinueInstall } from "./hooks-continue-install.js";
import { hooksCursorInstall } from "./hooks-cursor-install.js";
import { hooksClaudeCodeInstall } from "./hooks-install.js";
import { hooksWindsurfInstall } from "./hooks-windsurf-install.js";
import { registryInit } from "./registry-init.js";
import { seedYakccCorpus } from "./seed-yakcc.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Subdirectory for all yakcc operational data: DB, telemetry, etc. */
const YAKCC_DIR = ".yakcc";

/** Subdirs created inside .yakcc/ by init. */
const YAKCC_SUBDIRS = ["registry", "telemetry", "config"] as const;

/** Default registry path relative to target. */
const DEFAULT_REGISTRY_SUBPATH = ".yakcc/registry.sqlite";

/**
 * Default public registry peer URL.
 *
 * A bare `yakcc init` (no flags) registers this peer under
 * `.yakccrc.json` federation.peers[] and runs a mirror against it.
 * `--local` and `--airgapped` are explicit opt-outs that suppress
 * the default peer. (DEC-WPE-DEFAULT-PEER-001)
 */
const DEFAULT_REGISTRY_PEER_URL = "https://registry.yakcc.com";

/**
 * Maximum milliseconds to wait for the mirror-on-init attempt.
 *
 * Mirror failure (timeout or HTTP error) is non-fatal: init exits 0 and
 * logs a one-line warning. This bound prevents `yakcc init` from hanging
 * indefinitely when registry.yakcc.com is temporarily unreachable.
 * (DEC-WPE-DEFAULT-PEER-001 — graceful degradation)
 */
// @decision DEC-WPE-MIRROR-TIMEOUT-002 (closes #790)
// title: bump mirror-on-init timeout from 10s → 60s to match real corpus size
// status: accepted (FuckGoblin #790 triage 2026-05-27)
// rationale:
//   The original 10s bound (WI-WPE-C #771) was tight: the public corpus pulls
//   ~4 MB and routinely takes several seconds on a healthy network. When the
//   bound fired, the user saw a spurious "Note: could not reach …" even though
//   `yakcc federation mirror` succeeded seconds later from the same shell.
//   60s gives the mirror room to finish on commodity broadband. The user
//   explicitly invoked `yakcc init` and is actively waiting; the 60s ceiling
//   still guards against the genuine unreachable case (DNS fail, TLS error,
//   server outage) where the underlying socket I/O surfaces a failure quickly.
//   Sentinel exit codes below distinguish timeout from non-zero-exit from
//   exception so the surfaced log message points at the actual cause.
const MIRROR_TIMEOUT_MS = 60_000;

/** Sentinel exit codes used internally to differentiate mirror failure modes. */
const MIRROR_FAIL_TIMEOUT = 124; // POSIX timeout convention
const MIRROR_FAIL_EXCEPTION = 125;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Mode written to .yakccrc.json.
 *
 * - "local": --local flag; no federation peer, offline-first.
 * - "airgapped": --airgapped flag; explicit offline intent; no peer; written
 *   for forward-compat with future air-gap policy enforcement.
 * - "global": --peer <url> was provided OR default (no flags); will mirror
 *   from the registered peer on init. (DEC-WPE-DEFAULT-PEER-001)
 */
type YakccMode = "local" | "airgapped" | "global";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate a peer URL string: must be http:// or https://.
 * Returns null on success, an error message on failure.
 */
function validatePeerUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `peer URL must use http or https scheme, got: ${parsed.protocol}`;
    }
    return null;
  } catch {
    return `invalid peer URL: ${url}`;
  }
}

/**
 * Parse a comma-separated --ide value into a list of IdeName.
 * Returns { ok: IdeName[] } on success or { err: string } on invalid input.
 */
function parseIdeList(raw: string): { ok: IdeName[] } | { err: string } {
  const parts = raw.split(",").map((s) => s.trim().toLowerCase());
  const invalid = parts.filter((p) => !(KNOWN_IDE_NAMES as readonly string[]).includes(p));
  if (invalid.length > 0) {
    return {
      err:
        `unknown IDE name(s): ${invalid.join(", ")}. ` +
        `Known IDEs: ${KNOWN_IDE_NAMES.join(", ")}`,
    };
  }
  return { ok: parts as IdeName[] };
}

// ---------------------------------------------------------------------------
// IDE installer dispatch table
//
// @decision DEC-CLI-IDE-INSTALLER-DISPATCH-001
// title: Per-IDE installer functions called via a thin dispatch table inside init.ts,
//        NOT via a generic HookInstaller interface
// status: accepted (WI-656-S1)
// rationale:
//   Generic interface would force the lowest common denominator (marker-file only)
//   and demote Claude Code's rich settings.json wiring. Per-IDE installers preserve
//   surface-specific semantics. The dispatch table is kept here (not in ide-detect.ts)
//   because it depends on the installer imports, and ide-detect.ts must remain pure
//   (no I/O dependencies beyond existsSync).
// ---------------------------------------------------------------------------

/**
 * Install the yakcc hook for a single IDE into the target project directory.
 *
 * For claude-code and cursor this writes a settings.json hook entry (rich wiring).
 * For cline and continue this writes a marker file (surface not yet stable).
 *
 * The cline and continue installers accept an optional overrideDir for test isolation.
 * In production (no overrideDir) they default to os.homedir()-derived paths.
 */
async function installHookForIde(
  ide: IdeName,
  targetDir: string,
  logger: Logger,
  overrideHome?: string,
): Promise<void> {
  const { homedir } = await import("node:os");
  const home = overrideHome ?? homedir();

  switch (ide) {
    case "claude-code": {
      const code = await hooksClaudeCodeInstall(["--target", targetDir], logger);
      if (code !== 0) throw new Error(`claude-code hook install failed (exit ${code})`);
      // @decision DEC-CLI-MCP-INIT-001
      // title: yakcc init registers yakcc-mcp-registry in .mcp.json for Claude Code
      // status: accepted (WI-1005-mcp-init / #1005)
      // rationale:
      //   Without a .mcp.json entry, the yakcc-mcp-registry binary is never spawned
      //   by Claude Code, making yakcc_resolve / yakcc_get_atom / search_atoms
      //   uncallable from any default install. The fix belongs in the claude-code
      //   arm of installHookForIde — it is the canonical place for all Claude Code
      //   surface writes. writeMcpJsonEntry merge-by-key preserves any unrelated
      //   MCP servers the user has already configured; re-running yakcc init is
      //   idempotent (same key overwrites the same value).
      //
      //   npx vs direct binary: `npx -y yakcc-mcp-registry` works for both global
      //   and ephemeral installs without requiring the user to have the package on
      //   PATH. A globally-installed binary would need explicit PATH setup; npx
      //   handles package resolution automatically. The -y flag suppresses the
      //   "install?" prompt so the MCP spawn is non-interactive.
      writeMcpJsonEntry(targetDir, "yakcc", {
        command: "npx",
        args: ["-y", "yakcc-mcp-registry"],
      });
      break;
    }
    case "cursor": {
      const code = await hooksCursorInstall(["--target", targetDir], logger);
      if (code !== 0) throw new Error(`cursor hook install failed (exit ${code})`);
      break;
    }
    case "cline": {
      const { join } = await import("node:path");
      const clineDir = join(home, ".config", "cline");
      const code = await hooksClineInstall([], logger, clineDir, targetDir);
      if (code !== 0) throw new Error(`cline hook install failed (exit ${code})`);
      break;
    }
    case "continue": {
      const { join } = await import("node:path");
      const continueDir = join(home, ".continue");
      const code = await hooksContinueInstall([], logger, continueDir, targetDir);
      if (code !== 0) throw new Error(`continue hook install failed (exit ${code})`);
      break;
    }
    case "windsurf": {
      const code = await hooksWindsurfInstall(["--target", targetDir], logger);
      if (code !== 0) throw new Error(`windsurf hook install failed (exit ${code})`);
      break;
    }
    case "aider": {
      const { join } = await import("node:path");
      const aiderDir = join(home, ".aider");
      const code = await hooksAiderInstall([], logger, aiderDir, targetDir);
      if (code !== 0) throw new Error(`aider hook install failed (exit ${code})`);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// InitOptions — internal injection seam
// ---------------------------------------------------------------------------

/**
 * Internal options for `init`. Tests inject these to avoid network I/O and
 * provide the bootstrap corpus path.
 */
export interface InitOptions {
  /**
   * Override the home directory used for IDE detection and cline/continue
   * installer default dirs. When omitted, os.homedir() is used.
   * Used by tests to inject a fake HOME without mutating process state.
   */
  overrideHome?: string;
  /**
   * Override path to the bootstrap corpus sqlite for --yakcc seed mode.
   * Forwarded to seedYakccCorpus() (DEC-CLI-SEED-YAKCC-001).
   */
  corpusPath?: string;
  /**
   * Injectable federation runner for the mirror-on-init path (DEC-WPE-DEFAULT-PEER-001).
   *
   * When omitted, the real `runFederation` from ./federation.js is used.
   * Tests inject a stub to avoid real HTTP calls and assert that the correct
   * mirror arguments are passed without needing registry.yakcc.com to be live.
   *
   * Signature matches runFederation's public contract:
   *   (argv: string[], logger: Logger) => Promise<number>
   */
  runFederation?: (argv: string[], logger: Logger) => Promise<number>;
  /**
   * Optional embedding provider to use when seeding the registry. When
   * omitted, openRegistry's default resolver is used (env var or local BGE).
   *
   * Tests inject an offline-blake3-stub provider to avoid the multi-second
   * BGE model load that otherwise dominates the seed integration test's
   * runtime (closes #802). Production callers should leave this undefined
   * so the user's actual provider configuration applies.
   */
  embeddings?: import("@yakcc/contracts").EmbeddingProvider;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc init [--target <dir>] [--peer <url>] [--local] [--airgapped]
 *                         [--skip-hooks] [--ide <comma-list>] [--no-seed]`.
 *
 * Steps performed (in order):
 *  1. Parse and validate arguments.
 *  2. Create `.yakcc/` directory with standard subdirectories.
 *  3. Call `registryInit` to create `.yakcc/registry.sqlite` (idempotent).
 *  4. IDE hook installation (unless --skip-hooks):
 *     a. If `--ide <list>`: install for each IDE in the explicit list.
 *     b. Otherwise: auto-detect via detectInstalledIdes() and install for each.
 *  5. Seed the bootstrap corpus (unless --no-seed).
 *  6. If `--peer <url>`: register peer in `.yakccrc.json` and mirror blocks.
 *  7. Write / update `.yakccrc.json` with mode + installedHooks additive fields.
 *  8. Print concise summary (≤6 lines on happy path, G6).
 *
 * Idempotency: existing `.yakcc/` is detected; registry and hook installs are
 * themselves idempotent; `.yakccrc.json` is merged (peer list appended, not
 * replaced; installedHooks merged).
 *
 * @param argv   - Remaining argv after `init` has been consumed.
 * @param logger - Output sink; defaults to CONSOLE_LOGGER in production.
 * @param opts   - Internal options (home override, corpus path for tests).
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function init(
  argv: readonly string[],
  logger: Logger,
  opts?: InitOptions,
): Promise<number> {
  // -------------------------------------------------------------------------
  // 1. Parse arguments
  // -------------------------------------------------------------------------

  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        target: { type: "string"; short: "t" };
        peer: { type: "string" };
        local: { type: "boolean" };
        airgapped: { type: "boolean" };
        "skip-hooks": { type: "boolean" };
        "skip-polyglot-hints": { type: "boolean" };
        ide: { type: "string" };
        "no-seed": { type: "boolean" };
      };
    }>
  >;

  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        target: { type: "string", short: "t" },
        peer: { type: "string" },
        local: { type: "boolean" },
        airgapped: { type: "boolean" },
        "skip-hooks": { type: "boolean" },
        "skip-polyglot-hints": { type: "boolean" },
        ide: { type: "string" },
        "no-seed": { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    logger.error("Usage: yakcc init [--target <dir>] [--peer <url>] [--local] [--airgapped]");
    logger.error(
      "                  [--skip-hooks] [--ide <claude-code|cursor|cline|continue|windsurf|aider,...>] [--no-seed] [--skip-polyglot-hints]",
    );
    return 1;
  }

  const targetDir = parsed.values.target ?? ".";
  const peerUrl = parsed.values.peer;
  const isAirgapped = parsed.values.airgapped === true;
  const skipHooks = parsed.values["skip-hooks"] === true;
  const skipPolyglotHints =
    parsed.values["skip-polyglot-hints"] === true || process.env.YAKCC_POLYGLOT_HINTS === "0";
  const noSeed = parsed.values["no-seed"] === true;
  const ideRaw = parsed.values.ide;

  // Determine mode (written to .yakccrc.json for forward-compat).
  // Priority: --airgapped > --peer (implies global) > --local > default (global/registry.yakcc.com).
  // DEC-WPE-DEFAULT-PEER-001: default is now "global" — bare `yakcc init` registers
  // DEFAULT_REGISTRY_PEER_URL. --local and --airgapped are explicit offline opt-outs.
  let mode: YakccMode = "global";
  if (isAirgapped) {
    mode = "airgapped";
  } else if (peerUrl !== undefined) {
    mode = "global";
  } else if (parsed.values.local === true) {
    mode = "local";
  }

  // -------------------------------------------------------------------------
  // 2. Validate peer URL (fail fast before touching the filesystem)
  // -------------------------------------------------------------------------

  if (peerUrl !== undefined) {
    const urlError = validatePeerUrl(peerUrl);
    if (urlError !== null) {
      logger.error(`error: ${urlError}`);
      return 1;
    }
  }

  // -------------------------------------------------------------------------
  // 3. Validate --ide list (fail fast before touching the filesystem)
  // -------------------------------------------------------------------------

  let explicitIdes: IdeName[] | null = null;
  if (ideRaw !== undefined) {
    const parseResult = parseIdeList(ideRaw);
    if ("err" in parseResult) {
      logger.error(`error: ${parseResult.err}`);
      return 1;
    }
    explicitIdes = parseResult.ok;
  }

  // -------------------------------------------------------------------------
  // 4. Create .yakcc/ directory with standard subdirectories
  // -------------------------------------------------------------------------

  const yakccDir = join(targetDir, YAKCC_DIR);
  const yakccDirExists = existsSync(yakccDir);

  try {
    mkdirSync(yakccDir, { recursive: true });
    for (const sub of YAKCC_SUBDIRS) {
      mkdirSync(join(yakccDir, sub), { recursive: true });
    }
  } catch (err) {
    logger.error(`error: cannot create ${yakccDir}: ${String(err)}`);
    return 1;
  }

  if (yakccDirExists) {
    logger.log("  .yakcc/  (already exists — skipping directory creation)");
  } else {
    logger.log("  .yakcc/  created");
  }

  // -------------------------------------------------------------------------
  // 4b. Scaffold .yakcc/manifest.json for compose-by-reference (idempotent)
  //
  // @decision DEC-COMPOSE-BY-REF-DEFAULT-001
  // title: yakcc init scaffolds .yakcc/manifest.json so compose-by-reference
  //        (reference-emit) is the default discovery behavior for new projects;
  //        verbatim remains the fallback when the manifest is absent.
  // status: accepted (WI compose-ref-init-default / #1048 integration point)
  // rationale:
  //   The discovery prompt (#1048) gates reference-emit on the PRESENCE of
  //   .yakcc/manifest.json. Without this file, new projects silently fall to
  //   the verbatim fallback — writing full implementations instead of the
  //   ~10-token reference import. By having `yakcc init` scaffold an empty,
  //   valid manifest at first init, compose-by-reference becomes THE STANDARD
  //   for all new projects without any additional user action.
  //
  //   Verbatim remains the explicit fallback for projects that lack a build
  //   step (no manifest file means no build pipeline, so verbatim is correct).
  //
  //   The manifest is written ONLY via the @yakcc/compile authorities:
  //   emptyManifest() + serializeProjectManifest() — never hand-rolled JSON.
  //   This ensures parseProjectManifest() accepts it (single authority).
  //
  //   Idempotency: if .yakcc/manifest.json already exists (e.g. re-init on
  //   an active project with references), we skip the write to avoid clobbering
  //   the user's existing compose-by-reference registry.
  // -------------------------------------------------------------------------

  const manifestPath = join(targetDir, PROJECT_MANIFEST_PATH);
  if (!existsSync(manifestPath)) {
    try {
      writeFileSync(manifestPath, serializeProjectManifest(emptyManifest()), "utf-8");
    } catch (err) {
      logger.error(`warning: cannot write ${manifestPath}: ${String(err)} — continuing`);
      // Non-fatal: the registry is still initialized and hooks still install.
    }
  }

  // -------------------------------------------------------------------------
  // 5. Initialize the registry (idempotent via openRegistry/applyMigrations)
  // -------------------------------------------------------------------------

  const registryPath = join(targetDir, DEFAULT_REGISTRY_SUBPATH);
  const registryCode = await registryInit(["--path", registryPath], logger);
  if (registryCode !== 0) {
    return registryCode;
  }

  // -------------------------------------------------------------------------
  // 6. IDE hook installation (DEC-CLI-IDE-INSTALLER-DISPATCH-001)
  //
  // If --skip-hooks: skip all hook installation.
  // If --ide <list>: install only the specified IDEs (no auto-detect).
  // Otherwise: auto-detect via detectInstalledIdes() and install each.
  // -------------------------------------------------------------------------

  const installedHooks: string[] = [];

  if (!skipHooks) {
    let idesToInstall: IdeName[];

    if (explicitIdes !== null) {
      idesToInstall = explicitIdes;
    } else {
      // Auto-detect: pass overrideHome so tests can control the probe paths.
      const detected = detectInstalledIdes(opts?.overrideHome);
      idesToInstall = detected.map((d) => d.name);
    }

    for (const ide of idesToInstall) {
      try {
        await installHookForIde(ide, targetDir, logger, opts?.overrideHome);
        installedHooks.push(ide);
        // Write the discovery instruction snippet into the IDE's instruction surface
        // after the hook installer has written/verified the base surface file.
        // DEC-953B-SNIPPET-REFERENCE-001: the snippet references yakcc-discovery.md,
        // not the 12.5 KB body.  DEC-953B-SURFACE-SETTINGS-001: for claude-code this
        // extends .claude/settings.json (no CLAUDE.md resurrection).
        writeDiscoverySnippet(ide, targetDir);
        // Inject the discovery guidance into CLAUDE.md so the LLM context receives
        // the full 299-line prompt body (score bands, self-check, compile-and-stop)
        // on every session start.  DEC-1008-CLAUDE-MD-CONTEXT-INJECT-001: this is
        // the context-loading surface; the hook wiring lives in settings.json (above).
        // Only claude-code uses CLAUDE.md; other IDEs are future follow-ups.
        if (ide === "claude-code") {
          writeCLaudeMdDiscovery(targetDir);
        }
      } catch (err) {
        logger.error(`warning: ${String(err)} — continuing`);
        // Non-fatal: the registry is initialized; other hooks may still succeed.
      }
    }
  }

  // -------------------------------------------------------------------------
  // 7. Seed bootstrap corpus (unless --no-seed)
  //
  // Default: call seedYakccCorpus() (DEC-CLI-INIT-002 flips the no-auto-seed
  // clause of DEC-CLI-INIT-001). --no-seed restores quiet-init behavior.
  // -------------------------------------------------------------------------

  let seedCount = 0;
  if (!noSeed) {
    let registry: Registry | null = null;
    try {
      registry = await openRegistry(
        registryPath,
        opts?.embeddings !== undefined ? { embeddings: opts.embeddings } : undefined,
      );
    } catch (err) {
      logger.error(`warning: cannot open registry for seed: ${String(err)} — continuing`);
    }

    if (registry !== null) {
      try {
        seedCount = await seedYakccCorpus(
          registry,
          { ...(opts?.corpusPath !== undefined ? { corpusPath: opts.corpusPath } : {}) },
          logger,
        );
      } catch (err) {
        // Seed failure is non-fatal — the registry is still initialized.
        logger.error(`warning: seed failed: ${String(err)} — continuing`);
      } finally {
        try {
          await registry.close();
        } catch {
          // ignore close error
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 8. Mirror peer
  //
  // DEC-WPE-DEFAULT-PEER-001: when no --peer flag is given AND --local /
  // --airgapped are not set, effectivePeerUrl falls back to
  // DEFAULT_REGISTRY_PEER_URL so a bare `yakcc init` mirrors the public
  // registry. --local and --airgapped leave effectivePeerUrl undefined,
  // skipping the mirror entirely.
  //
  // The runFederation(["mirror", ...]) seam is reused — no parallel mirror
  // mechanism is introduced (Evaluation Contract forbidden shortcut).
  // Mirror failure is non-fatal (warning) — the registry is still
  // initialized and the peer URL is recorded in .yakccrc.json.
  // -------------------------------------------------------------------------

  const effectivePeerUrl =
    peerUrl !== undefined
      ? peerUrl
      : !isAirgapped && parsed.values.local !== true
        ? DEFAULT_REGISTRY_PEER_URL
        : undefined;

  if (effectivePeerUrl !== undefined) {
    // DEC-WPE-DEFAULT-PEER-001 — graceful degradation:
    // Use the injected runner (tests) or the real runFederation (production).
    // Wrap in a bounded timeout so init never hangs when the registry is down.
    const federationRunner =
      opts?.runFederation ??
      (async (argv: string[], log: Logger) => {
        const { runFederation: realRun } = await import("./federation.js");
        return realRun(argv, log);
      });

    const mirrorArgs = ["mirror", "--remote", effectivePeerUrl, "--registry", registryPath];

    // DEC-WPE-MIRROR-TIMEOUT-002 (#790): distinguish timeout / exception / non-zero-exit
    // so the surfaced log message points at the actual cause instead of the generic
    // "could not reach" that obscured real reachability errors.
    let mirrorCode: number;
    let mirrorException: unknown = null;
    try {
      mirrorCode = await Promise.race([
        federationRunner(mirrorArgs, logger),
        new Promise<number>((resolve) =>
          setTimeout(() => resolve(MIRROR_FAIL_TIMEOUT), MIRROR_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      mirrorException = err;
      mirrorCode = MIRROR_FAIL_EXCEPTION;
    }

    if (mirrorCode !== 0) {
      if (mirrorCode === MIRROR_FAIL_TIMEOUT) {
        logger.error(
          `Note: mirror from ${effectivePeerUrl} did not complete within ${
            MIRROR_TIMEOUT_MS / 1000
          }s — run 'yakcc federation mirror --remote ${effectivePeerUrl} --registry ${registryPath}' to retry without the time bound.`,
        );
      } else if (mirrorCode === MIRROR_FAIL_EXCEPTION) {
        const detail =
          mirrorException instanceof Error ? `${mirrorException.message}` : String(mirrorException);
        logger.error(
          `Note: mirror from ${effectivePeerUrl} threw an error (${detail}) — run 'yakcc federation mirror --remote ${effectivePeerUrl} --registry ${registryPath}' to see full output.`,
        );
      } else {
        logger.error(
          `Note: mirror from ${effectivePeerUrl} exited ${mirrorCode} — run 'yakcc federation mirror --remote ${effectivePeerUrl} --registry ${registryPath}' to see full output.`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // 9. Write / update .yakccrc.json
  //
  // New additive fields per DEC-CLI-INIT-002 (NG4: no version bump, additive only):
  //   - mode: "local" | "airgapped" | "global"
  //   - installedHooks: string[] (merged, deduped)
  // -------------------------------------------------------------------------

  const existingRc = readRc(targetDir);

  // The peer URL to record in federation.peers[] — either the explicit --peer
  // value or the default registry peer (DEC-WPE-DEFAULT-PEER-001). undefined
  // when --local or --airgapped (explicit offline opt-outs).
  const peerUrlToRecord = effectivePeerUrl;

  // @decision DEC-EMBED-ENV-RESOLUTION-001 (WI-778): persist embedding provider to rc.
  // If YAKCC_EMBEDDING_PROVIDER is set at init time, record it in .yakccrc.json so
  // subsequent CLI invocations use the same provider without requiring env vars to be set.
  // API keys are NOT stored (security boundary); users must set key env vars each session.
  const embeddingConfig: YakccEmbeddingConfig | undefined = (() => {
    const providerKind = process.env.YAKCC_EMBEDDING_PROVIDER;
    if (!providerKind || providerKind === "local") return undefined;
    if (providerKind === "openai") {
      const config: YakccEmbeddingConfig = { provider: "openai" };
      if (process.env.YAKCC_EMBEDDING_MODEL) config.model = process.env.YAKCC_EMBEDDING_MODEL;
      if (process.env.YAKCC_EMBEDDING_DIMENSIONS) {
        const d = Number.parseInt(process.env.YAKCC_EMBEDDING_DIMENSIONS, 10);
        if (!Number.isNaN(d)) config.dimensions = d;
      }
      return config;
    }
    if (providerKind === "voyage") {
      const config: YakccEmbeddingConfig = { provider: "voyage" };
      if (process.env.YAKCC_EMBEDDING_MODEL) config.model = process.env.YAKCC_EMBEDDING_MODEL;
      return config;
    }
    if (providerKind === "openai-compatible") {
      const config: YakccEmbeddingConfig = { provider: "openai-compatible" };
      if (process.env.YAKCC_EMBEDDING_BASE_URL)
        config.baseUrl = process.env.YAKCC_EMBEDDING_BASE_URL;
      if (process.env.YAKCC_EMBEDDING_MODEL) config.model = process.env.YAKCC_EMBEDDING_MODEL;
      if (process.env.YAKCC_EMBEDDING_DIMENSION) {
        const d = Number.parseInt(process.env.YAKCC_EMBEDDING_DIMENSION, 10);
        if (!Number.isNaN(d)) config.dimension = d;
      }
      return config;
    }
    return undefined;
  })();

  let rc: YakccRc;
  if (existingRc !== null) {
    // Spread existing rc fields. Ensure registry is always set (a minimal rc created by
    // addInstalledHook in a per-IDE tail call may not have registry yet — WI-759).
    rc = {
      ...existingRc,
      mode,
      registry: existingRc.registry ?? { path: DEFAULT_REGISTRY_SUBPATH },
    };
    if (peerUrlToRecord !== undefined) {
      const existingFed = rc.federation as { peers: string[] } | undefined;
      if (existingFed === undefined) {
        rc = { ...rc, federation: { peers: [peerUrlToRecord] } };
      } else if (!existingFed.peers.includes(peerUrlToRecord)) {
        rc = { ...rc, federation: { peers: [...existingFed.peers, peerUrlToRecord] } };
      }
    }
    // Merge installedHooks (dedupe).
    const existingHooks = rc.installedHooks ?? [];
    const merged = [...new Set([...existingHooks, ...installedHooks])];
    rc = { ...rc, installedHooks: merged };
    // Persist embedding config if newly provided (don't clobber existing config with undefined).
    if (embeddingConfig !== undefined) {
      rc = { ...rc, embeddings: embeddingConfig };
    }
  } else {
    rc = {
      version: 1,
      mode,
      registry: { path: DEFAULT_REGISTRY_SUBPATH },
      ...(peerUrlToRecord !== undefined ? { federation: { peers: [peerUrlToRecord] } } : {}),
      installedHooks,
      ...(embeddingConfig !== undefined ? { embeddings: embeddingConfig } : {}),
    };
  }

  try {
    writeRc(targetDir, rc);
  } catch (err) {
    logger.error(`error: cannot write ${join(targetDir, RC_FILENAME)}: ${String(err)}`);
    return 1;
  }

  logger.log(`  ${RC_FILENAME}  written`);

  // -------------------------------------------------------------------------
  // 10. Print concise summary (G6: ≤6 lines on happy path)
  // -------------------------------------------------------------------------

  const hookedLine =
    installedHooks.length > 0
      ? `Hooked into: ${installedHooks.join(", ")}.`
      : skipHooks
        ? "Hooks: skipped (--skip-hooks)."
        : "Hooks: no IDEs detected.";

  const telemetryDir = process.env.YAKCC_TELEMETRY_DIR ?? join(homedir(), ".yakcc", "telemetry");
  logger.log("");
  logger.log(`Installed in ${targetDir}. ${hookedLine} Registry: ${seedCount} atoms.`);
  logger.log(`Telemetry: ${telemetryDir}/<session>.jsonl (written on next Edit/Write tool call)`);
  logger.log(
    "Compose-by-reference: .yakcc/manifest.json scaffolded — run `yakcc build` to materialize referenced atoms.",
  );

  // @decision DEC-CLI-INIT-NO-IDE-HINT-001 (WI-687-S7 / #746 AC2)
  // title: When auto-detect finds nothing and --skip-hooks was not passed, surface a
  //        structured hint so the first-30-seconds GTM surface does not dead-end silently.
  // status: accepted (WI-746-S7)
  // rationale:
  //   AC2 of #746 requires the user to receive actionable guidance when no IDE config
  //   dirs are found. A silent "Hooks: no IDEs detected." leaves a fresh user with no
  //   recovery path. The hint is non-interactive (parent plan NG6 / DEC-CLI-INIT-002:
  //   init must remain scriptable and non-blocking on stdin). The IDE list is derived
  //   from KNOWN_IDE_NAMES — NOT a hand-typed parallel list — so the hint never drifts
  //   when a future S-slice adds a 7th adapter (Sacred Practice #12 / DEC-WI687-SLICING-001).
  if (!skipHooks && installedHooks.length === 0) {
    logger.log("  Tip: no IDE config dirs found in your home directory. Re-run with");
    logger.log("       `yakcc init --ide <name>` to install for a specific IDE");
    logger.log(`       (supported: ${KNOWN_IDE_NAMES.join(", ")}),`);
    logger.log("       or `yakcc init --skip-hooks` to skip hook setup entirely.");
  }

  // @decision DEC-POLYGLOT-ADAPTER-PACKAGING-001 (WI-POLYGLOT-INIT-AUTODETECT #785)
  // title: After init, scan target dir for polyglot ecosystem config files and
  //        emit non-interactive install hints for the matching @yakcc adapter packages.
  // status: accepted (WI-785; ADR Q7)
  // rationale:
  //   Polyglot adapters (@yakcc/shave-python, @yakcc/shave-go, @yakcc/shave-rust) are
  //   optional add-ons; `yakcc init` must not auto-install them (no surprise network
  //   activity, no surprise dependencies). But surfacing the existence of the right
  //   adapter when a Python/Go/Rust project is detected closes the discovery gap.
  //   Mirrors the IDE-hint pattern (DEC-CLI-INIT-NO-IDE-HINT-001): non-interactive,
  //   exits 0, no stdin, suppressible via --skip-polyglot-hints or YAKCC_POLYGLOT_HINTS=0,
  //   and self-suppressing when the adapter is already installed (require.resolve).
  if (!skipPolyglotHints) {
    emitPolyglotHints(targetDir, logger);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Polyglot adapter detection (DEC-POLYGLOT-ADAPTER-PACKAGING-001 / #785)
// ---------------------------------------------------------------------------

interface PolyglotEcosystem {
  readonly name: string;
  readonly configFiles: readonly string[];
  readonly adapterPackages: readonly string[];
  /** Marker module to probe via require.resolve to detect installed adapters. */
  readonly installedMarker: string;
  /** When true, append the "not yet available on npm" caveat to the hint. */
  readonly notYetPublished: boolean;
  /** Optional follow-up shell command shown beneath the install line. */
  readonly followUp?: string;
}

const POLYGLOT_ECOSYSTEMS: readonly PolyglotEcosystem[] = [
  {
    name: "Python",
    configFiles: ["pyproject.toml", "setup.py"],
    adapterPackages: ["@yakcc/shave-python", "@yakcc/compile-python"],
    installedMarker: "@yakcc/shave-python",
    notYetPublished: true,
    followUp: "yakcc shave <dir> --language=py",
  },
  {
    name: "Go",
    configFiles: ["go.mod"],
    adapterPackages: ["@yakcc/shave-go"],
    installedMarker: "@yakcc/shave-go",
    notYetPublished: true,
  },
  {
    name: "Rust",
    configFiles: ["Cargo.toml"],
    adapterPackages: ["@yakcc/shave-rust"],
    installedMarker: "@yakcc/shave-rust",
    notYetPublished: true,
  },
];

/**
 * Scan `targetDir` for polyglot ecosystem markers and emit install hints to
 * the logger. Self-suppressing per-ecosystem when the adapter is already
 * resolvable via require.resolve.
 *
 * Pure detection (no install, no stdin, no network).
 */
function emitPolyglotHints(targetDir: string, logger: Logger): void {
  for (const eco of POLYGLOT_ECOSYSTEMS) {
    const matchedConfig = eco.configFiles.find((f) => existsSync(join(targetDir, f)));
    if (matchedConfig === undefined) continue;
    if (isAdapterInstalled(eco.installedMarker)) continue;
    logger.log("");
    logger.log(`  hint: ${eco.name} project detected (${matchedConfig})`);
    if (eco.notYetPublished) {
      logger.log(
        `        Install the ${eco.name} shave/compile adapters (not yet published on npm):`,
      );
    } else {
      logger.log(`        Install the ${eco.name} shave/compile adapters:`);
    }
    logger.log(`          npm install ${eco.adapterPackages.join(" ")}`);
    if (eco.followUp !== undefined) {
      logger.log(`        Then run: ${eco.followUp}`);
    }
  }
}

/**
 * True when the adapter package can be resolved from the current Node module
 * search path (already installed). False when require.resolve throws.
 *
 * We use createRequire(import.meta.url) so resolution starts from this file's
 * location, matching where the adapter would be installed by the surrounding
 * project (the yakcc CLI itself or the user's project node_modules).
 */
function isAdapterInstalled(pkgName: string): boolean {
  try {
    const req = createRequire(import.meta.url);
    req.resolve(pkgName);
    return true;
  } catch {
    return false;
  }
}
