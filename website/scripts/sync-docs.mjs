// @decision DEC-WEBSITE-SLICE4-002
// Title: Build-time doc copy over content-collection symlink
// Status: accepted
// Rationale: Option 2 from the design spec -- explicit copy at prebuild.
// Source files (docs/*.md) are read-only; writes only to website/src/content/docs/
//
// Dev-doc exclusion: docs/archive/developer/** NOT copied per #667 split.

import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const websiteRoot = join(__dirname, "..");
const monorepoRoot = join(websiteRoot, "..");
const srcDocs = join(monorepoRoot, "docs");
const destDocs = join(websiteRoot, "src", "content", "docs");

mkdirSync(destDocs, { recursive: true });

const DOCS_MAP = [
  { src: "USING_YAKCC.md",     dest: "using-yakcc.md" },
  { src: "ALPHA.md",           dest: "alpha.md" },
  { src: "ADVANCED.md",        dest: "advanced.md" },
  { src: "TROUBLESHOOTING.md", dest: "troubleshooting.md" },
];

let allPresent = true;
for (const { src, dest } of DOCS_MAP) {
  const srcPath = join(srcDocs, src);
  const destPath = join(destDocs, dest);
  if (!existsSync(srcPath)) {
    console.error("[sync-docs] ERROR: source not found: " + srcPath);
    allPresent = false;
    continue;
  }
  copyFileSync(srcPath, destPath);
  console.log("[sync-docs] copied " + src + " -> " + dest);
}

if (!allPresent) { process.exit(1); }
console.log("[sync-docs] done -- 4 docs synced");
