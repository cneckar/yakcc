// @decision DEC-WEBSITE-001
// Title: Astro as SSG, zero runtime JS by default
// Status: accepted
// Rationale: Astro ships no client JS unless a component uses client:* directives.
// Per DEC-WEBSITE-DOGFOOD-001, all runtime JS must be yakcc atoms (slice 6+).
// Until then, zero JS is the correct shipped surface.
//
// @decision DEC-WEBSITE-SLICE4-001
// Title: Static-only Astro site with build-time shiki highlighting
// Status: accepted
// Rationale: Zero runtime JS requirement (issue #928). Astro output:static with
// shiki at build time produces fully-rendered HTML — no client bundles emitted.
// Shiki is Astro's built-in highlighter; no extra dep needed.

import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://yakcc.com",
  // Output static HTML only — no server adapter
  output: "static",
  // Build to website/dist/ (Astro default)
  outDir: "./dist",
  markdown: {
    // shiki is Astro's default highlighter — build-time only, zero runtime JS
    syntaxHighlight: "shiki",
    shikiConfig: {
      theme: "github-dark",
      wrap: true,
    },
  },
});
