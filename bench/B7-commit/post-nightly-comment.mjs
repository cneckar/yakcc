// SPDX-License-Identifier: MIT
//
// bench/B7-commit/post-nightly-comment.mjs
//
// @decision DEC-BENCH-B7-CI-001
// @title Nightly comment helper: reads latest B7 artifact, posts verdict summary to #191
// @status accepted (WI-B7-SLICE-3, issue #396)
// @rationale
//   Called by bench-b7-commit.yml after the benchmark completes. Reads the most-recent
//   artifact JSON from tmp/B7-commit/, formats a markdown verdict table (4 cells:
//   warm/cold × Windows/ubuntu-latest), and posts to issue #191 via `gh issue comment`.
//
//   Non-fatal design: if gh CLI fails (token scope, network, etc.), the script
//   exits 0 so the CI step remains non-fatal. The workflow already saves artifacts.
//
//   The comment format mirrors bench/B1-latency/post-nightly-comment.mjs but is adapted
//   for B7's 4-cell (cache_state × hardware) table rather than B1's 3-slice structure.
//
// Usage: node bench/B7-commit/post-nightly-comment.mjs
// Env:   GH_TOKEN must be set (provided by GitHub Actions)

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve repo root
function resolveRepoRoot() {
  if (process.env.YAKCC_REPO_ROOT) return process.env.YAKCC_REPO_ROOT;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const p = JSON.parse(readFileSync(pkg, "utf8"));
        if (p.name === "yakcc") return dir;
      } catch (_) {}
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(__dirname, "../..");
}

const REPO_ROOT   = resolveRepoRoot();
const ARTIFACT_DIR = join(REPO_ROOT, "tmp", "B7-commit");

/**
 * Find the most-recent artifact file matching the given prefix.
 */
function findLatestArtifact(prefix) {
  if (!existsSync(ARTIFACT_DIR)) return null;
  const files = readdirSync(ARTIFACT_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()    // ISO timestamp suffix → lexicographic = chronological
    .reverse();
  return files.length > 0 ? join(ARTIFACT_DIR, files[0]) : null;
}

/**
 * Find all artifacts (slice3-*.json) from the current run session.
 * Groups them by hardware label.
 */
function findArtifacts() {
  if (!existsSync(ARTIFACT_DIR)) return [];
  const files = readdirSync(ARTIFACT_DIR)
    .filter(f => f.startsWith("slice3-") && f.endsWith(".json"))
    .sort()
    .reverse();
  return files.map(f => join(ARTIFACT_DIR, f));
}

// ---------------------------------------------------------------------------
// Read latest artifact
// ---------------------------------------------------------------------------

const artifactPaths = findArtifacts();

// Fall back to any slice2 artifact if no slice3 artifacts exist yet
const latestPath = artifactPaths.length > 0
  ? artifactPaths[0]
  : findLatestArtifact("slice2-");

let artifact = null;
let parseError = null;

if (latestPath) {
  try {
    artifact = JSON.parse(readFileSync(latestPath, "utf8"));
  } catch (e) {
    parseError = e.message;
  }
}

// ---------------------------------------------------------------------------
// Format markdown comment
// ---------------------------------------------------------------------------

const runDate  = new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC";
const hardwareLabel = artifact?.environment?.hardwareLabel ?? artifact?.environment?.platform ?? "unknown";
const nodeVersion   = artifact?.environment?.nodeVersion ?? "?";
const envNote  = `${hardwareLabel} · ${nodeVersion}`;

let body = `## B7 Time-to-Commit Nightly Results — ${runDate}\n\n`;
body += `**Environment:** ${envNote}\n`;
body += `**Artifact:** \`${latestPath ? latestPath.split(/[\\/]/).pop() : "not found"}\`\n\n`;

if (!latestPath) {
  body += `> No artifact found in \`tmp/B7-commit/\` — the benchmark step may have failed.\n`;
} else if (parseError) {
  body += `> Artifact parse error: ${parseError}\n`;
} else {
  const agg    = artifact.aggregate ?? {};
  const warm   = agg.warm   ?? {};
  const cold   = agg.cold   ?? {};
  const verdict = artifact.verdict ?? "unknown";
  const atomizedCount = artifact.atomizedCount ?? "?";
  const nUtilities = artifact.corpus?.files?.length ?? artifact.corpus?.n_utilities ?? 32;

  const verdictEmoji = {
    "PASS-aspirational": "✅",
    "PASS-hard-cap":     "✅",
    "WARN":              "⚠️",
    "KILL":              "🔴",
  }[verdict] ?? "❓";

  body += `### Verdict: ${verdictEmoji} \`${verdict}\`\n\n`;
  body += `atomizedCount: **${atomizedCount}/${nUtilities}**\n\n`;

  // 4-cell table: warm/cold × this-hardware
  body += `| Cache state | median\_ms | p95\_ms | p99\_ms | n |\n`;
  body += `|-------------|-----------|---------|---------|---|\n`;

  function fmt(v) { return v != null ? v.toFixed(1) : "—"; }

  body += `| warm | ${fmt(warm.median_ms)} | ${fmt(warm.p95_ms)} | ${fmt(warm.p99_ms)} | ${warm.n ?? "?"} |\n`;
  body += `| cold | ${fmt(cold.median_ms)} | ${fmt(cold.p95_ms)} | ${fmt(cold.p99_ms)} | ${cold.n ?? "?"} |\n`;

  body += `\n`;
  body += `**Verdict bars** (from #191):\n`;
  body += `- PASS-aspirational: median warm ≤3s\n`;
  body += `- PASS-hard-cap: median warm ≤10s\n`;
  body += `- WARN: median warm 10–15s\n`;
  body += `- KILL: median warm >15s (WI-FAST-PATH-VERIFIER required)\n\n`;

  if (artifact.failures && artifact.failures.length > 0) {
    body += `**Failures:** ${artifact.failures.length} measurement(s) atomized=false or score<0.70:\n`;
    for (const f of artifact.failures.slice(0, 5)) {
      body += `- \`${f.utilityName}\` [${f.cacheState}] rep${f.rep}: atomized=${f.atomized} reason=${f.reason ?? "?"}\n`;
    }
    if (artifact.failures.length > 5) {
      body += `- ...and ${artifact.failures.length - 5} more\n`;
    }
    body += `\n`;
  } else {
    body += `Failures: none\n\n`;
  }
}

body += `> Full artifacts: \`tmp/B7-commit/\` — also uploaded as workflow artifact \`b7-commit-<run_number>\`.\n`;
body += `\n_Posted by [bench-b7-commit workflow](https://github.com/cneckar/yakcc/actions/workflows/bench-b7-commit.yml)_\n`;

// ---------------------------------------------------------------------------
// Post via gh CLI
// ---------------------------------------------------------------------------

console.log("Posting nightly comment to issue #191...");
console.log(body);

const gh = spawnSync("gh", ["issue", "comment", "191", "--body", body], {
  stdio: "inherit",
  encoding: "utf8",
  timeout: 30000,
  env: { ...process.env },
});

if (gh.status !== 0) {
  console.error(`Warning: gh issue comment failed (exit ${gh.status}) — non-fatal`);
  process.exit(0);
}

console.log("Comment posted successfully.");
process.exit(0);
