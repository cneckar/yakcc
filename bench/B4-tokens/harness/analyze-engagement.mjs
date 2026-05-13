#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/harness/analyze-engagement.mjs
//
// @decision DEC-V0-B4-ENGAGEMENT-004
// @title Phase 2/3 engagement analyzer: re-processes existing matrix artifacts
// @status accepted
// @rationale
//   WI-479 Phase 2: re-analyze the committed matrix-1 artifacts using the new
//   engagement instrumentation WITHOUT any API spend. This produces the baseline
//   engagement reading from the null-signal run.
//
//   WI-479 Phase 3: analyze new hypothesis-test runs (H1/H2/H3) using the same
//   instrumentation.
//
// Usage:
//   node bench/B4-tokens/harness/analyze-engagement.mjs
//   node bench/B4-tokens/harness/analyze-engagement.mjs --artifact=path/to/results.json
//   node bench/B4-tokens/harness/analyze-engagement.mjs --compare=a.json,b.json

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

// ---------------------------------------------------------------------------
// Import engagement module
// ---------------------------------------------------------------------------

const { classifyEngagement, aggregateEngagement, computeEngagementDelta, ENGAGEMENT_CLASSIFICATIONS } =
  await import(new URL(`file://${join(__dirname, "engagement.mjs")}`).href);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "artifact": { type: "string" },
    "compare":  { type: "string" },
    "verbose":  { type: "boolean", default: false },
  },
  strict: false,
});

// Default artifact: most recent results-min-* in tmp/B4-tokens
function findMostRecentArtifact() {
  const tmpDir = join(REPO_ROOT, "tmp", "B4-tokens");
  try {
    const files = readdirSync(tmpDir)
      .filter((f) => f.startsWith("results-min-") && f.endsWith(".json"))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    return join(tmpDir, files[0]);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Analysis functions
// ---------------------------------------------------------------------------

function loadArtifact(path) {
  if (!existsSync(path)) {
    throw new Error(`Artifact not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function printEngagementReport(report, label = "") {
  const sep = "─".repeat(70);
  console.log(`\n${sep}`);
  if (label) console.log(`ENGAGEMENT REPORT: ${label}`);
  console.log(sep);

  const ov = report.overall;
  console.log("\n## Overall Statistics");
  console.log(`  Total measurements:  ${ov.n}`);
  console.log(`  Hooked arm cells:    ${report.hooked_measurement_count}`);
  console.log(`  Tool invoc. rate:    ${(ov.tool_invocation_rate * 100).toFixed(1)}%`);
  console.log(`  Engagement rate:     ${(ov.engagement_rate * 100).toFixed(1)}% (cells with >=1 useful atom)`);
  console.log(`  Total tool cycles:   ${ov.total_tool_cycles}`);
  console.log(`  Mean cycles/cell:    ${ov.mean_tool_cycles.toFixed(2)}`);
  console.log(`  Atoms returned:      ${ov.atoms_returned_total}`);
  console.log(`  Cells non-engaged:   ${ov.cells_non_engaged}`);
  console.log(`  Cells empty-results: ${ov.cells_empty_results}`);
  console.log(`  Cells active:        ${ov.cells_active}`);
  console.log(`  Cells looped:        ${ov.cells_looped}`);

  if (Object.keys(ov.cycle_distribution).length > 0) {
    const distStr = Object.entries(ov.cycle_distribution)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([k, v]) => `${k}→${v}`)
      .join(", ");
    console.log(`  Cycle distribution:  {${distStr}}`);
  }

  console.log(`\n  Root cause:          ${report.root_cause_hypothesis}`);

  console.log("\n## Findings");
  for (const f of report.findings) {
    console.log(`  • ${f}`);
  }

  console.log("\n## By Driver (hooked arm only)");
  const drivers = ["haiku", "sonnet", "opus"];
  for (const drv of drivers) {
    const drvReport = report.by_driver[drv];
    if (!drvReport) continue;
    const hookedCells = (drvReport.cells_non_engaged + drvReport.cells_empty_results +
                         drvReport.cells_active + drvReport.cells_looped);
    console.log(`  ${drv.padEnd(8)}: inv_rate=${(drvReport.tool_invocation_rate * 100).toFixed(0)}%` +
      ` | active=${drvReport.cells_active}/${hookedCells}` +
      ` | cycles=${drvReport.total_tool_cycles}` +
      ` | atoms=${drvReport.atoms_returned_total}`);
  }

  console.log("\n## By Task (hooked arm only)");
  const taskOrder = [
    "lru-cache-with-ttl", "csv-parser-quoted", "debounce-with-cancel", "levenshtein-with-memo",
    "topological-sort-kahns", "json-pointer-resolve", "base64-encode-rfc4648", "semver-range-satisfies",
  ];
  for (const tid of taskOrder) {
    const taskStats = report.by_task[tid];
    if (!taskStats) continue;
    const hookedCount = taskStats.cells_empty_results + taskStats.cells_active + taskStats.cells_non_engaged + taskStats.cells_looped;
    console.log(`  ${tid.padEnd(35)}: cycles=${taskStats.total_tool_cycles} | atoms=${taskStats.atoms_returned_total} | empty=${taskStats.cells_empty_results}/${hookedCount}`);
  }
}

function printDeltaReport(baseline, variant, labelA, labelB) {
  const delta = computeEngagementDelta(baseline.overall, variant.overall);
  console.log(`\n## Engagement Delta: ${labelA} → ${labelB}`);
  console.log(`  Engagement rate:   ${(baseline.overall.engagement_rate * 100).toFixed(1)}% → ${(variant.overall.engagement_rate * 100).toFixed(1)}% (Δ${(delta.engagement_rate_delta * 100).toFixed(1)}%)`);
  console.log(`  Invocation rate:   ${(baseline.overall.tool_invocation_rate * 100).toFixed(1)}% → ${(variant.overall.tool_invocation_rate * 100).toFixed(1)}% (Δ${(delta.tool_invocation_rate_delta * 100).toFixed(1)}%)`);
  console.log(`  Mean cycles:       ${baseline.overall.mean_tool_cycles.toFixed(2)} → ${variant.overall.mean_tool_cycles.toFixed(2)} (Δ${delta.mean_tool_cycles_delta.toFixed(2)})`);
  console.log(`  Atoms returned:    ${baseline.overall.atoms_returned_total} → ${variant.overall.atoms_returned_total} (Δ${delta.atoms_returned_total_delta})`);
  console.log(`  Verdict:           ${delta.verdict.toUpperCase()}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(70));
  console.log("B4-tokens WI-479 Hook Engagement Analyzer");
  console.log("=".repeat(70));

  if (args["compare"]) {
    // Compare two artifacts
    const [pathA, pathB] = args["compare"].split(",").map((p) => p.trim());
    const artA = loadArtifact(pathA);
    const artB = loadArtifact(pathB);

    const reportA = aggregateEngagement(artA.measurements);
    const reportB = aggregateEngagement(artB.measurements);

    const labelA = artA.config?.promptVariant
      ? `variant=${artA.config.promptVariant} forced=${artA.config.forceToolCall}`
      : pathA.split("/").pop();
    const labelB = artB.config?.promptVariant
      ? `variant=${artB.config.promptVariant} forced=${artB.config.forceToolCall}`
      : pathB.split("/").pop();

    printEngagementReport(reportA, labelA);
    printEngagementReport(reportB, labelB);
    printDeltaReport(reportA, reportB, labelA, labelB);
    return;
  }

  // Single artifact mode
  const artifactPath = args["artifact"] ?? (() => {
    // Find most recent results in tmp/B4-tokens
    const tmpDir = join(REPO_ROOT, "tmp", "B4-tokens");
    try {
      const files = readdirSync(tmpDir)
        .filter((f) => f.startsWith("results-min-") && f.endsWith(".json") && !f.includes("forced") && !f.includes("prompt"))
        .sort()
        .reverse();
      if (files.length === 0) return null;
      return join(tmpDir, files[0]);
    } catch (_) { return null; }
  })();

  if (!artifactPath) {
    console.error("No artifact found. Specify --artifact=path or ensure tmp/B4-tokens has results-min-*.json");
    process.exit(1);
  }

  const art = loadArtifact(artifactPath);
  console.log(`\nArtifact: ${artifactPath}`);
  console.log(`Run ID:   ${art.run_id}`);
  console.log(`Mode:     ${art.environment?.dryRun ? "DRY-RUN" : "REAL API"}`);
  console.log(`Tier:     ${art.config?.tier}`);
  console.log(`Drivers:  ${art.config?.driverFilter ?? "all"}`);

  const report = aggregateEngagement(art.measurements ?? []);
  printEngagementReport(report, art.run_id ?? artifactPath);

  // Summary table matching the dossier format
  console.log("\n## Summary Table (for dossier)");
  console.log("| Metric | Value |");
  console.log("| --- | --- |");
  console.log(`| Total hooked cells | ${report.hooked_measurement_count} |`);
  console.log(`| Tool invocation rate | ${(report.overall.tool_invocation_rate * 100).toFixed(1)}% |`);
  console.log(`| Engagement rate (active) | ${(report.overall.engagement_rate * 100).toFixed(1)}% |`);
  console.log(`| Total tool cycles | ${report.overall.total_tool_cycles} |`);
  console.log(`| Mean cycles/cell | ${report.overall.mean_tool_cycles.toFixed(2)} |`);
  console.log(`| Atoms returned total | ${report.overall.atoms_returned_total} |`);
  console.log(`| Root cause hypothesis | ${report.root_cause_hypothesis} |`);
}

// Handle auto-discovery of most recent artifact
const artifactPathFromCli = args["artifact"];
if (!artifactPathFromCli && !args["compare"]) {
  const tmpDir = join(REPO_ROOT, "tmp", "B4-tokens");
  let files = [];
  try {
    files = readdirSync(tmpDir)
      .filter((f) => f.startsWith("results-min-") && f.endsWith(".json") && !f.includes("forced") && !f.includes("prompt"))
      .sort()
      .reverse();
  } catch (_) {}

  if (files.length > 0) {
    process.argv.push(`--artifact=${join(tmpDir, files[0])}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
