#!/usr/bin/env node
/**
 * @decision DEC-DIST-PACKAGING-001
 * @title Single-binary distribution via @yao-pkg/pkg (Node SEA wrapper)
 * @status accepted
 * @rationale @yao-pkg/pkg is the actively maintained fork of vercel/pkg, supporting
 *   Node 22 via the Node Single Executable Application (SEA) API.  It embeds all JS
 *   deps in a VFS archive and extracts native .node + .so assets to a temp dir at
 *   first run.  Bun was the alternative but onnxruntime-node@1.14.0 compatibility with
 *   Bun's NAPI shim was unverified.  Node SEA (without pkg) was rejected because it
 *   has no native-asset extraction story.  esbuild alone was rejected (no embedded
 *   Node runtime).  See tmp/wi-361-planning/diagnostic.md for full comparison.
 *
 * Build entry point for the yakcc single-file binary (Slice 1: Linux x64 host).
 * Invoked by `pnpm --filter @yakcc/cli build:binary`.
 *
 * Asset inclusion rationale:
 * - better_sqlite3.node   — loaded by `bindings()` via process.dlopen(); must be
 *                           embedded so pkg's bootstrap can extract and dlopen it.
 * - vec0.so               — loaded by sqlite-vec via db.loadExtension() after
 *                           require.resolve("sqlite-vec-linux-x64/vec0.so"); pkg
 *                           embeds it and the bootstrap's VFS intercepts readFileSync
 *                           so the .so path resolves from the snapshot.
 * - onnxruntime_binding.node + libonnxruntime.so.1.14.0 — loaded by onnxruntime-node
 *                           napi-v3 binding for the Linux x64 path; both must be
 *                           co-located so the binding can load the shared lib.
 *
 * Future Implementers:
 * - Slice 2 extends this by adding `--targets` for multi-arch (darwin-arm64,
 *   win32-x64, etc.) and running `prebuild-install` for the target platform.
 * - If the binary grows beyond ~150MB, consider --compress Brotli (requires no
 *   runtime overhead on modern Node; pkg decompresses on first extract).
 * - Model download on first `yakcc query` goes to ~/.cache/huggingface per
 *   transformers.js defaults (DEC-EMBED-MODEL-DEFAULT-002); this is intentional
 *   for Slice 1 — airgap embedding is tracked separately.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, ".."); // packages/cli/
const worktreeRoot = resolve(__dirname, "../../.."); // repo root

// Verify the entry point was built by tsc
const entryPoint = join(pkgRoot, "dist", "bin.js");
if (!existsSync(entryPoint)) {
  console.error(`ERROR: ${entryPoint} does not exist. Run \`pnpm build\` first.`);
  process.exit(1);
}

const outDir = join(pkgRoot, "dist");
mkdirSync(outDir, { recursive: true });

const pkgBin = join(pkgRoot, "node_modules", ".bin", "pkg");
if (!existsSync(pkgBin)) {
  console.error(`ERROR: pkg binary not found at ${pkgBin}. Run \`pnpm install\` first.`);
  process.exit(1);
}

const configFile = join(pkgRoot, "pkg.config.json");
const outputFile = join(outDir, "yakcc-bin");

console.log("Building yakcc binary via @yao-pkg/pkg...");
console.log(`  entry: ${entryPoint}`);
console.log(`  config: ${configFile}`);
console.log(`  output: ${outputFile}`);
console.log("");

// Run pkg - this will take 1-3 minutes on first run (downloads Node binary)
const cmd = `${pkgBin} "${entryPoint}" --config "${configFile}" --output "${outputFile}" --targets node22-linux-x64`;
console.log(`Running: ${cmd}`);
console.log("");

try {
  execSync(cmd, {
    stdio: "inherit",
    cwd: pkgRoot,
    env: {
      ...process.env,
      // Ensure pkg can find node_modules up the tree
      NODE_PATH: [join(pkgRoot, "node_modules"), join(worktreeRoot, "node_modules")].join(":"),
    },
  });
  console.log("");
  console.log(`SUCCESS: Binary written to ${outputFile}`);
} catch (err) {
  console.error("");
  console.error("BUILD FAILED:", err.message);
  process.exit(1);
}
