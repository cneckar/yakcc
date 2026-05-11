// SPDX-License-Identifier: MIT
//
// bench/B1-latency/post-nightly-comment.mjs
//
// @decision DEC-BENCH-B1-CI-001
// @title Nightly comment helper: reads latest artifacts, posts verdict summary to #185
// @status accepted
// @rationale
//   This script is called by bench-b1-latency.yml after all three slice benchmarks
//   complete. It reads the most-recent artifact JSON for each slice from
//   tmp/B1-latency/, formats a markdown verdict table, and posts to issue #185
//   via `gh issue comment`.
//
//   Verdict regression detection: each comment includes the verdict (PASS/WARN/KILL)
//   and the raw degradation percentage so a reader can spot regressions at a glance
//   without downloading artifacts.
//
//   Non-fatal design: if gh CLI fails (token scope, network, etc.), the script
//   exits 0 so the CI step remains non-fatal. The workflow already saves artifacts.
//
// Usage: node bench/B1-latency/post-nightly-comment.mjs
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

const REPO_ROOT  = resolveRepoRoot();
const ARTIFACT_DIR = join(REPO_ROOT, "tmp", "B1-latency");

// Slice configs
const SLICES = [
  {
    name:    "integer-math",
    prefix:  "integer-math-",
    verdictKey: "vs_pass_bar_15pct",
    passBar: "≤15%",
    killBar: ">40%",
  },
  {
    name:    "json-transformer",
    prefix:  "json-transformer-",
    verdictKey: "vs_pass_bar_15pct",
    passBar: "≤15%",
    killBar: ">40%",
  },
  {
    name:    "http-routing",
    prefix:  "http-routing-",
    verdictKey: "vs_pass_bar_25pct",
    passBar: "≤25% (glue-heavy)",
    killBar: ">40%",
  },
];

/**
 * Find the most-recent artifact file for a given prefix in the artifact dir.
 */
function findLatestArtifact(prefix) {
  if (!existsSync(ARTIFACT_DIR)) return null;
  const files = readdirSync(ARTIFACT_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()  // ISO timestamp suffix → lexicographic sort = chronological
    .reverse();
  return files.length > 0 ? join(ARTIFACT_DIR, files[0]) : null;
}

/**
 * Format a verdict emoji for markdown.
 */
function verdictEmoji(v) {
  if (v === "pass")    return "✅ PASS";
  if (v === "warn")    return "⚠️ WARN";
  if (v === "kill")    return "🔴 KILL";
  if (v === "blocker") return "🚫 BLOCKER";
  return "❓ UNKNOWN";
}

// ---------------------------------------------------------------------------
// Read latest artifact for each slice
// ---------------------------------------------------------------------------

const rows = [];
let anyMissing = false;

for (const slice of SLICES) {
  const path = findLatestArtifact(slice.prefix);
  if (!path) {
    anyMissing = true;
    rows.push({
      name: slice.name,
      verdict: "❓ MISSING",
      degradation: "—",
      yakccMean: "—",
      rustSoftMean: "—",
      timestamp: "—",
      passBar: slice.passBar,
    });
    continue;
  }

  let artifact;
  try {
    artifact = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    rows.push({
      name: slice.name,
      verdict: `❓ PARSE ERROR: ${e.message}`,
      degradation: "—",
      yakccMean: "—",
      rustSoftMean: "—",
      timestamp: "—",
      passBar: slice.passBar,
    });
    continue;
  }

  const v = artifact.verdict ?? {};
  const verdictVal = v[slice.verdictKey];
  const deg = v.yakcc_vs_rust_software_degradation_pct;
  const degStr = deg !== undefined && deg !== null
    ? (deg >= 0 ? `+${deg.toFixed(1)}%` : `${deg.toFixed(1)}%`)
    : "—";

  // Find yakcc-as and rust-software from results array
  const results = artifact.results ?? [];
  const yakcc    = results.find(r => r.comparator === "yakcc-as");
  const rustSoft = results.find(r => r.comparator === "rust-software");

  rows.push({
    name:         slice.name,
    verdict:      verdictEmoji(verdictVal),
    degradation:  degStr,
    yakccMean:    yakcc?.mean_ms   != null ? `${yakcc.mean_ms.toFixed(2)}ms`     : "—",
    rustSoftMean: rustSoft?.mean_ms != null ? `${rustSoft.mean_ms.toFixed(2)}ms` : "—",
    timestamp:    artifact.timestamp ?? "—",
    passBar:      slice.passBar,
    env:          artifact.environment ?? {},
  });
}

// ---------------------------------------------------------------------------
// Format markdown comment
// ---------------------------------------------------------------------------

const runDate  = new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC";
const platform = rows.find(r => r.env?.platform)?.env;
const envNote  = platform
  ? `${platform.platform}/${platform.arch} · ${platform.cpu ?? "unknown CPU"} · Node ${platform.node ?? "?"} · Rust ${platform.rust ?? "?"}`
  : "ubuntu-latest";

let body = `## B1 Latency Nightly Results — ${runDate}\n\n`;
body += `**Environment:** ${envNote}\n\n`;

body += `| Slice | Verdict | yakcc-as | rust-software | Degradation | Pass bar |\n`;
body += `|-------|---------|----------|---------------|-------------|----------|\n`;
for (const r of rows) {
  body += `| \`${r.name}\` | ${r.verdict} | ${r.yakccMean} | ${r.rustSoftMean} | ${r.degradation} | ${r.passBar} |\n`;
}

body += `\n`;
body += `> Degradation = (yakcc-as mean − rust-software mean) / rust-software mean × 100. `;
body += `Negative = yakcc-as is faster than Rust.\n`;
body += `> Full artifacts: \`tmp/B1-latency/\` — also uploaded as workflow artifact \`b1-latency-<run_number>\`.\n`;

if (anyMissing) {
  body += `\n> ⚠️ One or more slice artifacts were not found — the corresponding benchmark step may have failed.\n`;
}

body += `\n_Posted by [bench-b1-latency workflow](https://github.com/cneckar/yakcc/actions/workflows/bench-b1-latency.yml)_\n`;

// ---------------------------------------------------------------------------
// Post via gh CLI
// ---------------------------------------------------------------------------

console.log("Posting nightly comment to issue #185...");
console.log(body);

const gh = spawnSync("gh", ["issue", "comment", "185", "--body", body], {
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
