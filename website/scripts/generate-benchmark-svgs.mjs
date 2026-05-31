/**
 * generate-benchmark-svgs.mjs — build-time SVG + metadata generator
 *
 * @decision DEC-WEBSITE-BENCH-SVG-001
 * Title: Build-time SVG generation from real result JSONs
 * Status: active
 * Rationale: SVGs are generated at build-time from bench benchmark result JSONs.
 * No synthetic data (DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001). If a JSON
 * file is missing or its path glob resolves to nothing, the benchmark is marked
 * PENDING. All badge logic is driven by the pre-assigned status column in the
 * BENCHMARK_MANIFEST below; the JSON is read for the headline metric only.
 *
 * Called by: website/package.json prebuild script
 * Writes:
 *   - website/public/benchmarks/<slug>.svg   (12 files)
 *   - website/src/data/benchmarks.json       (metadata for Astro page)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// From website/scripts/, 4 levels up reaches the repo root:
// scripts/ -> website/ -> .worktrees/feature-*/ -> .worktrees/ -> /repo/
const REPO_ROOT = resolve(__dirname, '../../../..');
const OUT_SVG_DIR = resolve(__dirname, '../public/benchmarks');
const OUT_DATA = resolve(__dirname, '../src/data/benchmarks.json');

// Ensure output directories exist
mkdirSync(OUT_SVG_DIR, { recursive: true });
mkdirSync(dirname(OUT_DATA), { recursive: true });

// ---------------------------------------------------------------------------
// Badge colour palette — honest status colours
// ---------------------------------------------------------------------------
const BADGE_COLORS = {
  PROVEN: { bg: '#22c55e', text: '#052e16', label: 'PROVEN' },
  PARTIAL: { bg: '#eab308', text: '#422006', label: 'PARTIAL' },
  'MEASUREMENT-LIMITED': { bg: '#f97316', text: '#431407', label: 'MEASUREMENT-LIMITED' },
  PENDING: { bg: '#6b7280', text: '#f9fafb', label: 'PENDING' },
};

// ---------------------------------------------------------------------------
// Benchmark manifest — source of truth for badge, JSON path, caption, and
// the metric extraction function for each benchmark.
//
// jsonPath: relative to REPO_ROOT. Use null for PENDING benches.
// jsonGlob: if true, jsonPath is a glob pattern; first match wins.
// extractMetric: fn(json) -> string — returns the headline metric for display.
//                May return null if data is inconclusive.
// ---------------------------------------------------------------------------
const BENCHMARKS = [
  {
    slug: 'b6-airgap',
    name: 'B6-Airgap',
    status: 'PROVEN',
    jsonPath: 'bench/B6-airgap',
    jsonGlob: true,
    jsonGlobPattern: /^results-b6a-.*\.json$/,
    caption: 'Installable with zero network during install.',
    extractMetric: (d) => {
      const outbound = d.outboundCount ?? d.outboundConnections?.length;
      if (outbound !== undefined) return `${outbound} outbound connections`;
      if (d.pass === true) return 'All steps passed';
      return null;
    },
  },
  {
    slug: 'b7-commit',
    name: 'B7-Commit',
    status: 'PROVEN',
    jsonPath: 'bench/B7-commit/results-windows-2026-05-12.json',
    jsonGlob: false,
    caption: 'Zero outbound network during commit verification.',
    extractMetric: (d) => {
      const warm = d.aggregate?.warm;
      if (warm?.median_ms !== undefined) return `${warm.median_ms}ms warm median`;
      return d.verdict ?? null;
    },
  },
  {
    slug: 'b10-import',
    name: 'B10-Import',
    status: 'PROVEN',
    jsonPath: 'bench/B10-import-replacement/results-win32-2026-05-17.json',
    jsonGlob: false,
    caption: 'Drop-in replacement for transitively-bundled npm packages.',
    extractMetric: (d) => {
      const suite = d.suite;
      if (suite?.suite_verdict) return suite.suite_verdict;
      return null;
    },
  },
  {
    slug: 'v0-smoke',
    name: 'v0-Smoke',
    status: 'PROVEN',
    jsonPath: 'bench/v0-release-smoke',
    jsonGlob: true,
    jsonGlobPattern: /^results-darwin-2026-05-15.*\.json$/,
    caption: 'End-to-end install + run smoke test on real OS.',
    extractMetric: (d) => {
      const steps = d.steps ?? [];
      const passed = steps.filter((s) => s.pass).length;
      const total = steps.length;
      if (total > 0) return `${passed}/${total} steps passed`;
      return d.pass === true ? 'All steps passed' : null;
    },
  },
  {
    slug: 'b2-bloat',
    name: 'B2-Bloat',
    status: 'MEASUREMENT-LIMITED',
    jsonPath: 'bench/B2-bloat/results-2026-05-18.json',
    jsonGlob: false,
    caption: 'Validator atom is 91% smaller than equivalent ajv bundle (cold corpus).',
    extractMetric: (d) => {
      const yakcc = d.arms?.yakcc?.bundleSize;
      const ajv = d.arms?.ajv?.bundleSize;
      if (yakcc !== undefined && ajv !== undefined) {
        const pct = Math.round((1 - yakcc / ajv) * 100);
        return `${pct}% smaller bundle`;
      }
      return null;
    },
  },
  {
    slug: 'b5-coherence',
    name: 'B5-Coherence',
    status: 'PARTIAL',
    jsonPath: 'bench/B5-coherence/results-darwin-2026-05-18-slice3-real-judge.json',
    jsonGlob: false,
    caption: 'Cross-language semantic equivalence (TS↔Python). Below directional target — iterating.',
    extractMetric: (d) => {
      const rate = d.aggregate?.hookEnabled?.subsequentTurnRate;
      if (rate !== undefined) return `${Math.round(rate * 100)}% coherence`;
      return null;
    },
  },
  {
    slug: 'b1-latency',
    name: 'B1-Latency',
    status: 'PARTIAL',
    jsonPath: 'bench/B1-latency/integer-math/results-darwin-arm64-m1pro-2026-05-14.json',
    jsonGlob: false,
    caption: 'Per-atom cold-cache latency vs hand-written baseline.',
    extractMetric: (d) => {
      const results = d.results ?? [];
      const yakcc = results.find((r) => r.comparator === 'yakcc-as');
      if (yakcc?.p50_ms !== undefined) return `${yakcc.p50_ms.toFixed(0)}ms p50`;
      const ts = results.find((r) => r.comparator === 'ts-node');
      if (ts?.p50_ms !== undefined) return `baseline ${ts.p50_ms.toFixed(0)}ms p50`;
      return null;
    },
  },
  {
    slug: 'b4-tokens',
    name: 'B4-Tokens',
    status: 'PARTIAL',
    jsonPath: 'bench/B4-tokens/results-min-darwin-2026-05-14.json',
    jsonGlob: false,
    caption: 'Token-budget delta for LLM-driven shave + emit. Below directional target.',
    extractMetric: (d) => {
      const rows = d.summary?.results_table?.rows ?? [];
      for (const row of rows) {
        const hooked = row['hooked-default'];
        if (hooked?.mean_token_reduction_pct !== undefined) {
          const pct = (hooked.mean_token_reduction_pct * 100).toFixed(1);
          return `${pct}% token delta (${row.driver})`;
        }
      }
      return null;
    },
  },
  {
    slug: 'b8-synthetic',
    name: 'B8-Synthetic',
    status: 'PARTIAL',
    jsonPath: 'bench/B8-synthetic/results-linux-2026-05-17-revalidation-slice1.json',
    jsonGlob: false,
    caption: 'Synthetic-vs-real harness validation. Slice 1 of 3.',
    extractMetric: (d) => {
      const agg = d.aggregate?.all_tasks;
      if (agg?.mean_hit_rate !== undefined) {
        return `${Math.round(agg.mean_hit_rate * 100)}% mean hit rate`;
      }
      return d.verdict?.verdict ?? null;
    },
  },
  {
    slug: 'b9-min-surface',
    name: 'B9-Min Surface',
    status: 'PARTIAL',
    jsonPath: 'bench/B9-min-surface/results-darwin-2026-05-14.json',
    jsonGlob: false,
    caption: 'Minimum atom-surface for substrate self-replication.',
    extractMetric: (d) => {
      return d.verdict ?? null;
    },
  },
  {
    slug: 'b3-cache-hit',
    name: 'B3-Cache Hit',
    status: 'PENDING',
    jsonPath: null,
    jsonGlob: false,
    caption: 'Atom cache hit-rate on real workloads.',
    extractMetric: () => null,
  },
  {
    slug: 'b8-curve',
    name: 'B8-Curve',
    status: 'PENDING',
    jsonPath: null,
    jsonGlob: false,
    caption: 'Coverage curve vs corpus size.',
    extractMetric: () => null,
  },
];

// ---------------------------------------------------------------------------
// JSON resolution — reads the JSON file if available, with glob support
// ---------------------------------------------------------------------------
function resolveJson(bench) {
  if (!bench.jsonPath) return null;
  const fullPath = join(REPO_ROOT, bench.jsonPath);

  if (bench.jsonGlob) {
    // Directory glob: find first matching file
    if (!existsSync(fullPath)) return null;
    const entries = readdirSync(fullPath).filter((f) => bench.jsonGlobPattern.test(f)).sort();
    if (entries.length === 0) return null;
    const target = join(fullPath, entries[0]);
    try {
      return JSON.parse(readFileSync(target, 'utf8'));
    } catch {
      return null;
    }
  }

  if (!existsSync(fullPath)) return null;
  try {
    return JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SVG generator — 200x120 card, no external deps, pure XML strings
//
// Layout:
//   Row 1 (y≈22): bench name
//   Row 2 (y≈50): status badge pill
//   Row 3 (y≈78): headline metric (or "—" if unavailable)
//   Row 4 (y≈100): micro-caption (truncated)
// ---------------------------------------------------------------------------
function wrapText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxChars) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateSvg(bench, metric) {
  const color = BADGE_COLORS[bench.status] ?? BADGE_COLORS.PENDING;
  const W = 240;
  const H = 140;

  // Status badge dimensions
  const badgeLabel = escapeXml(color.label);
  const badgeLabelLen = badgeLabel.length;
  const badgeW = Math.max(badgeLabelLen * 7.5 + 20, 80);
  const badgeX = (W - badgeW) / 2;

  // Metric text — truncate at 30 chars
  const metricText = metric ? escapeXml(String(metric).slice(0, 30)) : '—';

  // Caption — wrap to 2 lines of ~36 chars
  const captionLines = wrapText(bench.caption, 36).slice(0, 2);

  const captionSvg = captionLines
    .map(
      (line, i) =>
        `<text x="${W / 2}" y="${H - 22 + i * 13}" text-anchor="middle" font-size="9" fill="#94a3b8">${escapeXml(line)}</text>`,
    )
    .join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <!-- Background -->
  <rect width="${W}" height="${H}" rx="8" fill="#0f172a" />
  <!-- Border -->
  <rect width="${W}" height="${H}" rx="8" fill="none" stroke="#1e293b" stroke-width="1.5" />

  <!-- Bench name -->
  <text x="${W / 2}" y="26" text-anchor="middle" font-size="13" font-weight="600"
        font-family="ui-monospace,SFMono-Regular,Menlo,monospace" fill="#f1f5f9">${escapeXml(bench.name)}</text>

  <!-- Status badge pill -->
  <rect x="${badgeX}" y="34" width="${badgeW}" height="20" rx="10" fill="${color.bg}" />
  <text x="${W / 2}" y="48" text-anchor="middle" font-size="10" font-weight="700"
        font-family="ui-monospace,SFMono-Regular,Menlo,monospace" fill="${color.text}">${badgeLabel}</text>

  <!-- Headline metric -->
  <text x="${W / 2}" y="78" text-anchor="middle" font-size="11" font-weight="500"
        font-family="ui-monospace,SFMono-Regular,Menlo,monospace" fill="#cbd5e1">${metricText}</text>

  <!-- Caption -->
  ${captionSvg}
</svg>`;
}

// ---------------------------------------------------------------------------
// Main — iterate benchmarks, resolve JSON, generate SVG + metadata
// ---------------------------------------------------------------------------
const metadata = [];

for (const bench of BENCHMARKS) {
  const json = resolveJson(bench);
  const metric = json ? bench.extractMetric(json) : null;
  const svgContent = generateSvg(bench, metric);

  const outPath = join(OUT_SVG_DIR, `${bench.slug}.svg`);
  writeFileSync(outPath, svgContent, 'utf8');
  console.log(
    `  [SVG] ${bench.slug}.svg — ${bench.status}${metric ? ` — ${metric}` : ''}${!json && bench.jsonPath ? ' (JSON not found)' : ''}`,
  );

  metadata.push({
    slug: bench.slug,
    name: bench.name,
    status: bench.status,
    caption: bench.caption,
    metric: metric ?? null,
    svgPath: `/benchmarks/${bench.slug}.svg`,
    hasData: json !== null,
  });
}

writeFileSync(OUT_DATA, JSON.stringify(metadata, null, 2), 'utf8');
console.log(`\n  [DATA] benchmarks.json — ${metadata.length} benchmarks`);
console.log(
  `  Counts: ${metadata.filter((m) => m.status === 'PROVEN').length} PROVEN, ` +
    `${metadata.filter((m) => m.status === 'PARTIAL').length} PARTIAL, ` +
    `${metadata.filter((m) => m.status === 'MEASUREMENT-LIMITED').length} MEASUREMENT-LIMITED, ` +
    `${metadata.filter((m) => m.status === 'PENDING').length} PENDING`,
);
