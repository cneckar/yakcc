// SPDX-License-Identifier: MIT
//
// bench/v0-release-smoke/post-smoke-comment.mjs
//
// @decision DEC-V0-RELEASE-SMOKE-CI-001
// @title CI post-comment helper: reads latest smoke artifact, posts step table to #360
// @status accepted
// @rationale
//   This script is called by v0-release-smoke.yml after smoke.mjs completes
//   (always, including on partial-pass runs). It reads the most-recent artifact
//   JSON from tmp/v0-release-smoke/, formats a Markdown comment with the step
//   pass/fail table, and posts to issue #360 via `gh issue comment`.
//
//   Auto-close policy: if all steps pass (summary.allPass === true AND
//   summary.warned === 0), the script also calls `gh issue close 360` with a
//   certification comment. If any steps warn or fail, the issue is left open
//   and the comment carries the diagnosis.
//
//   Non-fatal design: if gh CLI fails (token scope, network), the script exits 0
//   so the CI step remains non-fatal. Artifacts are always uploaded regardless.
//
//   Windows-partial-pass note: when run locally on Windows, Steps 2-4 are
//   WARN (skipped). allPass logic counts warn as not-failed so the Windows
//   partial-pass does NOT auto-close the issue.
//
// Usage: node bench/v0-release-smoke/post-smoke-comment.mjs
// Env:   GH_TOKEN must be set (provided by GitHub Actions)

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Repo root resolution
// ---------------------------------------------------------------------------

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

const REPO_ROOT = resolveRepoRoot();
const ARTIFACT_DIR = join(REPO_ROOT, "tmp", "v0-release-smoke");
const ISSUE_NUMBER = "360";

// ---------------------------------------------------------------------------
// Find most-recent artifact
// ---------------------------------------------------------------------------

function findLatestArtifact() {
  if (!existsSync(ARTIFACT_DIR)) return null;
  const files = readdirSync(ARTIFACT_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("tmp-registry"))
    .map((f) => ({ file: f, path: join(ARTIFACT_DIR, f) }))
    .sort((a, b) => b.file.localeCompare(a.file));
  return files[0]?.path ?? null;
}

// ---------------------------------------------------------------------------
// Format Markdown comment
// ---------------------------------------------------------------------------

function formatComment(artifact) {
  const { runId, timestamp, platform, steps, summary } = artifact;

  const platformNote =
    platform === "win32"
      ? "\n> **Platform note:** Run on Windows — Steps 2-4 are WARN (skipped due to bin.js bug #274). Ubuntu CI is the authoritative run.\n"
      : "";

  const header = [
    `## v0-release-smoke run — ${timestamp}`,
    "",
    `**Run ID:** \`${runId}\` | **Platform:** \`${platform}\` | **Node:** \`${artifact.node ?? "unknown"}\``,
    "",
    platformNote,
    `| Passed | Warned (skipped) | Failed | Overall |`,
    `|--------|-----------------|--------|---------|`,
    `| ${summary.passed} | ${summary.warned} | ${summary.failed} | **${summary.allPass ? "ALL PASS" : "PARTIAL / FAIL"}** |`,
    "",
    "### Step-by-step results",
    "",
    "| Step | Name | Result | Notes |",
    "|------|------|--------|-------|",
  ];

  const rows = (steps ?? []).map((s) => {
    const icon = s.warn ? "⚠ WARN" : s.pass ? "✓ PASS" : "✗ FAIL";
    const notes = s.errorExcerpt
      ? `${s.actual.slice(0, 60)} — \`${s.errorExcerpt.slice(0, 80)}\``
      : s.actual.slice(0, 100);
    return `| ${s.step} | ${s.name} | ${icon} | ${notes} |`;
  });

  const footer = summary.allPass
    ? [
        "",
        "---",
        "",
        `> All ${steps?.length ?? "?"} steps passed on ubuntu-latest.`,
        "> The hook + discovery + substitution + atomize flywheel composes correctly for a fresh user project.",
        "> Steps 8b and 9 (load-bearing flywheel) confirmed: novel emission atomized and round-trip query found it.",
        "> Auto-closing per WI-V0-RELEASE-SMOKE acceptance criteria.",
      ]
    : [
        "",
        "---",
        "",
        "> One or more steps failed or were skipped. Issue remains open.",
        "> See artifact JSON for full details.",
        "> Fix the failing steps before v0 release.",
      ];

  return [...header, ...rows, ...footer].join("\n");
}

// ---------------------------------------------------------------------------
// gh CLI helpers
// ---------------------------------------------------------------------------

function ghComment(body) {
  // Write body to a temp file to avoid shell escaping issues.
  const tmpFile = join(ARTIFACT_DIR, `comment-${Date.now()}.md`);
  writeFileSync(tmpFile, body, "utf8");
  const result = spawnSync(
    "gh",
    ["issue", "comment", ISSUE_NUMBER, "--body-file", tmpFile],
    { encoding: "utf8", timeout: 30_000, env: process.env },
  );
  // Clean up temp file regardless.
  try {
    import("node:fs").then(({ unlinkSync }) => unlinkSync(tmpFile));
  } catch (_) {}
  return result;
}

function ghClose(comment) {
  const result = spawnSync(
    "gh",
    ["issue", "close", ISSUE_NUMBER, "--comment", comment],
    { encoding: "utf8", timeout: 30_000, env: process.env },
  );
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const artifactPath = findLatestArtifact();
  if (artifactPath === null) {
    console.error(
      `post-smoke-comment: no artifact found in ${ARTIFACT_DIR}. ` +
        "Smoke may not have run yet. Exiting 0 (non-fatal).",
    );
    process.exit(0);
  }

  console.log(`post-smoke-comment: reading artifact ${artifactPath}`);

  let artifact;
  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch (err) {
    console.error(`post-smoke-comment: failed to parse artifact: ${err}. Exiting 0 (non-fatal).`);
    process.exit(0);
  }

  const comment = formatComment(artifact);
  console.log("Formatted comment:\n---\n" + comment.slice(0, 800) + "\n---");

  // Post comment to issue #360.
  const commentResult = ghComment(comment);
  if (commentResult.error || commentResult.status !== 0) {
    console.warn(
      `post-smoke-comment: gh comment failed (non-fatal): ` +
        `status=${commentResult.status} stderr=${commentResult.stderr?.slice(0, 200)}`,
    );
  } else {
    console.log("post-smoke-comment: comment posted to issue #360");
  }

  // Auto-close only when ALL steps truly pass (no warns, no fails).
  const { summary } = artifact;
  if (summary.allPass && summary.warned === 0 && summary.failed === 0) {
    const stepCount = artifact.steps?.length ?? "?";
    console.log(`post-smoke-comment: all ${stepCount} steps pass — closing issue #360`);
    const closeResult = ghClose(
      `All ${stepCount} steps pass on ubuntu-latest — v0-release smoke verified. ` +
        "Steps 8b (flywheel atomize) and 9 (round-trip query) confirmed load-bearing flywheel spins. " +
        "Auto-closing per WI-V0-RELEASE-SMOKE acceptance criteria (issue #360).",
    );
    if (closeResult.error || closeResult.status !== 0) {
      console.warn(
        `post-smoke-comment: gh close failed (non-fatal): ` +
          `status=${closeResult.status} stderr=${closeResult.stderr?.slice(0, 200)}`,
      );
    } else {
      console.log("post-smoke-comment: issue #360 closed");
    }
  } else {
    console.log(
      `post-smoke-comment: issue left open (allPass=${summary.allPass} warned=${summary.warned} failed=${summary.failed})`,
    );
  }

  // Always exit 0.
  process.exit(0);
}

main().catch((err) => {
  console.error("post-smoke-comment: fatal error (non-fatal exit):", err);
  process.exit(0);
});
