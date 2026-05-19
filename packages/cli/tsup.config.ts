import { defineConfig } from "tsup";

/**
 * Bundle configuration for the published @yakcc/cli npm package.
 *
 * Strategy:
 *  - Inline every workspace @yakcc/* package into the cli bundle (noExternal)
 *    so consumers get a single self-contained tarball without having to install
 *    the rest of the monorepo.
 *  - Keep all third-party runtime deps external (declared in package.json
 *    "dependencies"). Native modules (better-sqlite3, sqlite-vec) and large
 *    WASM-bearing libs (@xenova/transformers) must not be bundled.
 *  - Preserve the #!/usr/bin/env node shebang on bin.js so it remains directly
 *    executable after install.
 *  - Emit ESM only (the source is ESM; consumers running Node 18+ are fine).
 *
 * Companion build steps (run via package.json "build:publish"):
 *  - scripts/copy-seed-blocks.mjs — copies the seed-block triplet sources into
 *    dist/blocks/ so seed.ts's import.meta.url-relative resolution lands on
 *    real files at runtime.
 *  - scripts/sync-publish-assets.mjs — copies README.md, LICENSE, LICENSE-ATOMS
 *    from the repo root into the package directory so npm pack picks them up.
 */
export default defineConfig({
  entry: {
    bin: "src/bin.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node18",
  platform: "node",
  outDir: "dist",
  splitting: false,
  sourcemap: true,
  dts: false,
  clean: false,
  shims: false,
  noExternal: [/^@yakcc\//, "@noble/hashes"],
  banner: {
    js: "",
  },
  esbuildOptions(options) {
    options.banner = {
      js: "",
    };
  },
  onSuccess: async () => {
    // Restore the shebang on bin.js so it remains directly executable.
    // tsup strips it by default for non-entry chunks; we add it back on the
    // emitted bin.js.
    const fs = await import("node:fs/promises");
    const path = "dist/bin.js";
    const original = await fs.readFile(path, "utf-8");
    if (!original.startsWith("#!")) {
      await fs.writeFile(path, `#!/usr/bin/env node\n${original}`, "utf-8");
      await fs.chmod(path, 0o755);
    } else {
      await fs.chmod(path, 0o755);
    }
  },
});
