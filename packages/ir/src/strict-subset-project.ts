// @decision DEC-V2-IR-PROJECT-MODE-001: Project-mode validation uses a real ts-morph
// Project loaded from tsconfig.json rather than the isolated in-memory project used by
// validateStrictSubset. Status: implemented (WI-V2-01).
// Rationale: The isolated validator creates a synthetic in-memory project that has no
// knowledge of cross-file imports, workspace packages, or @types/* declarations. This
// produces false-positive no-untyped-imports violations for any code that imports from
// other files in the same project, from workspace packages (e.g. @yakcc/contracts), or
// from Node built-ins (node:fs, node:path). The project-mode validator solves this by
// loading the real tsconfig, letting ts-morph resolve all source files and their
// transitive dependencies, and running the same rule walkers over the resolved AST.
// The per-file walker (runAllRules) is reused unchanged; only the project bootstrap
// strategy differs. This is the minimum viable change — no new rule registry, no API
// surface changes beyond the new export.

import { Project } from "ts-morph";
import { type ValidationError, runAllRules } from "./strict-subset.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result returned by validateStrictSubsetProject. */
export interface ProjectValidationResult {
  /** Absolute path to the tsconfig.json that was loaded. */
  readonly tsconfigPath: string;
  /** All violations found across every non-external source file. */
  readonly violations: readonly ValidationError[];
  /** Number of source files that were inspected (excludes node_modules / external libs). */
  readonly filesValidated: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate all TypeScript source files in a project against the strict subset rules.
 *
 * Loads a real ts-morph Project from the given tsconfig.json path, resolves all
 * source file dependencies, and runs every strict-subset rule against each
 * non-external source file. External library files (node_modules, .d.ts from
 * @types packages) are skipped — only the project's own source files are checked.
 *
 * This produces significantly fewer false-positive no-untyped-imports violations
 * compared to the isolated-mode validateStrictSubset/validateStrictSubsetFile
 * functions, because the real tsconfig wires up cross-file imports, workspace
 * package references, and @types declarations correctly.
 *
 * @param tsconfigPath - Absolute or relative path to the project's tsconfig.json.
 *
 * @example
 * ```ts
 * const result = await validateStrictSubsetProject("./tsconfig.json");
 * if (result.violations.length > 0) {
 *   for (const v of result.violations) {
 *     console.error(`${v.file}:${v.line}:${v.column} [${v.rule}] ${v.message}`);
 *   }
 * }
 * ```
 */
export async function validateStrictSubsetProject(
  tsconfigPath: string,
): Promise<ProjectValidationResult> {
  const project = new Project({ tsConfigFilePath: tsconfigPath });

  // Resolve all transitive source file dependencies so that cross-file imports
  // and workspace package references are available during type checking.
  await project.resolveSourceFileDependencies();

  const sourceFiles = project.getSourceFiles();
  const violations: ValidationError[] = [];
  let filesValidated = 0;

  for (const sf of sourceFiles) {
    // Skip files that come from node_modules or external declaration packages.
    // ts-morph exposes these via isFromExternalLibrary() and isInNodeModules().
    if (sf.isFromExternalLibrary()) continue;
    if (sf.isInNodeModules()) continue;

    const filePath = sf.getFilePath();
    violations.push(...runAllRules(sf, filePath));
    filesValidated += 1;
  }

  return { tsconfigPath, violations, filesValidated };
}
