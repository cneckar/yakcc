// @decision DEC-WEBSITE-001
// Title: Astro as SSG, zero runtime JS by default
// Status: accepted
// Rationale: Astro ships no client JS unless a component uses client:* directives.
// Per DEC-WEBSITE-DOGFOOD-001, all runtime JS must be yakcc atoms (slice 6+).
// Until then, zero JS is the correct shipped surface.
import { defineConfig } from "astro/config";

export default defineConfig({
  // Output static HTML only — no server adapter
  output: "static",
  // Build to website/dist/ (Astro default)
  outDir: "./dist",
});
