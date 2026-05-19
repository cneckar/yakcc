#!/usr/bin/env node
/**
 * ensure-bootstrap-corpus.mjs
 *
 * Generates `bootstrap/yakcc.registry.sqlite` from the current source tree by
 * running `yakcc bootstrap` if the sqlite is missing or older than any source
 * file under packages/*\/src. The sqlite is .gitignored (large binary; CI also
 * regenerates it), so a fresh clone won't have one. This script makes
 * `pnpm --filter @yakcc/cli run build:publish` a single one-shot publish flow:
 * pre-shave the corpus → bundle → pack → publish.
 *
 * Runs the freshly-bundled @yakcc/cli (dist/bin.js) so the bootstrap
 * sqlite reflects the same code that ships in the tarball.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(CLI_ROOT, "..", "..");
const BOOTSTRAP_DIR = join(REPO_ROOT, "bootstrap");
const BOOTSTRAP_SQLITE = join(BOOTSTRAP_DIR, "yakcc.registry.sqlite");
const BIN = join(CLI_ROOT, "dist", "bin.js");

async function newestSourceMtime() {
  let newest = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
        await walk(p);
      } else if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".yak"))) {
        const s = await stat(p);
        if (s.mtimeMs > newest) newest = s.mtimeMs;
      }
    }
  }
  const packagesDir = join(REPO_ROOT, "packages");
  const entries = await readdir(packagesDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) await walk(join(packagesDir, e.name, "src"));
  }
  return newest;
}

async function checkFreshness() {
  if (!existsSync(BOOTSTRAP_SQLITE)) return false;
  const sqliteMtime = statSync(BOOTSTRAP_SQLITE).mtimeMs;
  const newestSrc = await newestSourceMtime();
  return sqliteMtime >= newestSrc;
}

async function main() {
  if (!existsSync(BIN)) {
    process.stderr.write(`[ensure-bootstrap-corpus] ERROR: ${BIN} not found. Run tsup first.\n`);
    process.exit(1);
  }

  const fresh = await checkFreshness();
  if (fresh) {
    process.stdout.write(
      `[ensure-bootstrap-corpus] bootstrap sqlite already current (newer than packages/*/src) — skipping shave\n`,
    );
    return;
  }

  if (!existsSync(BOOTSTRAP_SQLITE)) {
    process.stdout.write(`[ensure-bootstrap-corpus] bootstrap sqlite missing — running yakcc bootstrap\n`);
  } else {
    process.stdout.write(
      `[ensure-bootstrap-corpus] bootstrap sqlite older than source — regenerating via yakcc bootstrap\n`,
    );
  }

  // Redirect --manifest and --report to throwaway paths under packages/cli/dist/
  // so the committed bootstrap/expected-roots.json (the load-bearing manifest
  // per DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001) is NOT mutated by the publish run.
  // Only the sqlite (gitignored) is the artifact we want from this invocation.
  const TMP_MANIFEST = join(CLI_ROOT, "dist", ".publish-bootstrap-manifest.json");
  const TMP_REPORT = join(CLI_ROOT, "dist", ".publish-bootstrap-report.json");
  const result = spawnSync(
    process.execPath,
    [BIN, "bootstrap", "--manifest", TMP_MANIFEST, "--report", TMP_REPORT],
    {
      stdio: "inherit",
      cwd: REPO_ROOT,
    },
  );

  if (result.status !== 0) {
    process.stderr.write(`[ensure-bootstrap-corpus] yakcc bootstrap exited with status ${result.status}\n`);
    process.exit(result.status ?? 1);
  }

  if (!existsSync(BOOTSTRAP_SQLITE)) {
    process.stderr.write(
      `[ensure-bootstrap-corpus] ERROR: yakcc bootstrap succeeded but ${BOOTSTRAP_SQLITE} was not produced\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`[ensure-bootstrap-corpus] bootstrap sqlite generated at ${BOOTSTRAP_SQLITE}\n`);
}

main().catch((err) => {
  process.stderr.write(`[ensure-bootstrap-corpus] FATAL: ${err.message}\n`);
  process.exit(1);
});
