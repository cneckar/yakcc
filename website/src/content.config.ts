// Content collection configuration for end-user docs (Astro v6 Content Layer API).
//
// @decision DEC-WEBSITE-SLICE4-003
// Title: Astro v6 Content Layer glob loader for monorepo docs
// Status: accepted
// Rationale: Astro v6 removed legacy content collections in favour of the Content
// Layer API (loader-based). The glob loader reads from src/content/docs/ which is
// populated at prebuild by scripts/sync-docs.mjs copying the four end-user docs
// from the monorepo docs/ directory. Schema is minimal — most source docs have no
// YAML frontmatter.
//
// Dev docs (docs/archive/developer/**, ADRs) are NOT included — they link to
// GitHub per the #667 end-user / developer split.

import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const docs = defineCollection({
  loader: glob({
    pattern: "**/*.md",
    base: "./src/content/docs",
  }),
  schema: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
  }),
});

export const collections = { docs };
