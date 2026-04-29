// @decision DEC-IR-BLOCK-002: parseBlockTriplet replaces parseBlock as the sole
// block-authoring entry point in @yakcc/ir.
// Status: implemented (WI-T02)
// Rationale: Blocks are now directories (spec.yak, impl.ts, proof/manifest.json)
// rather than single TS files with embedded CONTRACT literals. The inline-CONTRACT
// mechanism (parseBlock + annotations.ts) is deleted per Sacred Practice #12 —
// single source of truth. parseBlockTriplet reads all three files, validates each
// against @yakcc/contracts schema validators, runs the strict-subset validator on
// impl.ts, and resolves sub-block imports to SpecHash references via the existing
// import-detection logic. The registry parameter is accepted for future use (T03)
// but is not called at L0: sub-block SpecHash values are extracted from import
// paths and left for the caller to resolve against the registry.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BlockMerkleRoot,
  type BlockTriplet,
  type ProofManifest,
  type SpecHash,
  type SpecYak,
  blockMerkleRoot,
  specHash,
  validateProofManifestL0,
  validateSpecYak,
} from "@yakcc/contracts";
import { Project } from "ts-morph";
import { type ValidationResult, runAllRules } from "./strict-subset.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A reference to a sub-block imported by impl.ts.
 *
 * Sub-block detection is heuristic: any import from a path matching
 * `@yakcc/seeds/`, `@yakcc/blocks/`, or the configurable `blockPatterns`
 * option is treated as a sub-block reference. The specHashRef is left null
 * at parse time; callers use it as a lookup key against the registry
 * (selectBlocks(specHash) → BlockMerkleRoot[]) in T03+.
 */
export interface SubBlockRef {
  /** The local identifier bound by the import statement. */
  readonly localName: string;
  /** The module specifier as written in impl.ts (e.g. "@yakcc/seeds/blocks/digit"). */
  readonly importedFrom: string;
  /**
   * The SpecHash for the referenced sub-block, if already known.
   * null when the registry has not been consulted (the default at L0).
   */
  readonly specHashRef: SpecHash | null;
}

/**
 * The result of successfully parsing a block triplet directory.
 *
 * All fields are populated: the SpecYak from spec.yak, the impl.ts source,
 * the ProofManifest, the artifact bytes map, the strict-subset ValidationResult,
 * the BlockTriplet (ready to feed into blockMerkleRoot), the derived
 * BlockMerkleRoot, and the sub-block composition references.
 */
export interface BlockTripletParseResult {
  /** The parsed and validated spec.yak content. */
  readonly spec: SpecYak;
  /** The SpecHash derived from the spec (BLAKE3(canonicalize(spec.yak))). */
  readonly specHashValue: SpecHash;
  /** The impl.ts source text as UTF-8. */
  readonly implSource: string;
  /** The parsed and validated proof/manifest.json content. */
  readonly manifest: ProofManifest;
  /**
   * Bytes for each artifact declared in manifest.artifacts.
   * Keys are the artifact path fields as declared in the manifest.
   */
  readonly artifacts: Map<string, Uint8Array>;
  /**
   * Strict-subset validation result for impl.ts.
   * Check result.ok before treating the block as registry-ready.
   */
  readonly validation: ValidationResult;
  /**
   * The assembled BlockTriplet, ready to pass to blockMerkleRoot().
   * Always present; callers may re-derive the root or pass it to the registry.
   */
  readonly triplet: BlockTriplet;
  /**
   * The BlockMerkleRoot derived from the triplet.
   * BLAKE3(spec_hash || impl_hash || proof_root).
   */
  readonly merkleRoot: BlockMerkleRoot;
  /**
   * Sub-block imports detected in impl.ts, resolved to SubBlockRef values.
   * specHashRef is null at parse time; the registry resolves it in T03+.
   */
  readonly composition: ReadonlyArray<SubBlockRef>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ParseBlockTripletOptions {
  /**
   * Additional import path prefixes to treat as sub-block references beyond
   * the built-in patterns ("@yakcc/seeds/", "@yakcc/blocks/").
   */
  readonly blockPatterns?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// Built-in sub-block import patterns
// ---------------------------------------------------------------------------

const BUILTIN_BLOCK_PATTERNS = ["@yakcc/seeds/", "@yakcc/blocks/"] as const;

function isBlockImport(moduleSpecifier: string, extraPatterns: readonly string[]): boolean {
  for (const pattern of BUILTIN_BLOCK_PATTERNS) {
    if (moduleSpecifier.startsWith(pattern)) return true;
  }
  for (const pattern of extraPatterns) {
    if (moduleSpecifier.startsWith(pattern)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sub-block composition extraction
//
// Reuses the import-detection logic from the removed parseBlock(). Walks the
// ts-morph AST of impl.ts and collects all imports matching the block-package
// heuristic. Converts each import binding to a SubBlockRef with specHashRef=null.
// ---------------------------------------------------------------------------

function extractComposition(source: string, extraPatterns: readonly string[]): SubBlockRef[] {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, skipLibCheck: true, target: 99, module: 99 },
  });
  const sourceFile = project.createSourceFile("__impl__.ts", source);

  const refs: SubBlockRef[] = [];

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const specifier = importDecl.getModuleSpecifierValue();
    if (!isBlockImport(specifier, extraPatterns)) continue;

    const namedImports = importDecl.getNamedImports();
    const defaultImport = importDecl.getDefaultImport();
    const namespaceImport = importDecl.getNamespaceImport();

    if (namedImports.length > 0) {
      for (const named of namedImports) {
        refs.push({
          localName: named.getAliasNode()?.getText() ?? named.getName(),
          importedFrom: specifier,
          specHashRef: null,
        });
      }
    } else if (defaultImport !== undefined) {
      refs.push({
        localName: defaultImport.getText(),
        importedFrom: specifier,
        specHashRef: null,
      });
    } else if (namespaceImport !== undefined) {
      refs.push({
        localName: namespaceImport.getText(),
        importedFrom: specifier,
        specHashRef: null,
      });
    }
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Yakcc block triplet from a directory on disk.
 *
 * Reads three files from `directoryPath`:
 *   - spec.yak          — parsed as JSON, validated via validateSpecYak
 *   - impl.ts           — read as UTF-8; validated via the strict-subset rules
 *   - proof/manifest.json — parsed as JSON, validated via validateProofManifestL0
 *
 * Also reads the artifact bytes for each entry declared in proof/manifest.json
 * (paths are relative to the proof/ directory).
 *
 * The `registry` parameter is reserved for T03+ (selectBlocks integration).
 * At L0, sub-block SpecHash references are extracted but not resolved against
 * a registry; specHashRef is null in all returned SubBlockRef values.
 *
 * Throws:
 *   - TypeError  — if spec.yak or proof/manifest.json fails schema validation
 *   - Error      — if a required file cannot be read, or if an artifact declared
 *                  in the manifest is missing from proof/
 *
 * The strict-subset validation result is always returned (never thrown); callers
 * check result.validation.ok to determine registry readiness.
 *
 * @example
 * ```ts
 * const result = parseBlockTriplet("/path/to/blocks/digit-of");
 * if (!result.validation.ok) {
 *   for (const e of result.validation.errors) console.error(e.message);
 * }
 * console.log(result.merkleRoot); // 64-char hex BlockMerkleRoot
 * ```
 */
export function parseBlockTriplet(
  directoryPath: string,
  // registry parameter reserved for T03+ registry integration (selectBlocks)
  _registry?: unknown,
  options?: ParseBlockTripletOptions,
): BlockTripletParseResult {
  const extraPatterns = options?.blockPatterns ?? [];

  // 1. Read and validate spec.yak
  const specPath = join(directoryPath, "spec.yak");
  const specRaw = readFileSync(specPath, "utf-8");
  const specParsed: unknown = JSON.parse(specRaw);
  // validateSpecYak throws TypeError on invalid input (DEC-TRIPLET-L0-ONLY-019)
  const spec = validateSpecYak(specParsed);
  const specHashValue = specHash(spec);

  // 2. Read impl.ts and run the strict-subset validator
  const implPath = join(directoryPath, "impl.ts");
  const implSource = readFileSync(implPath, "utf-8");

  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, skipLibCheck: true, target: 99, module: 99 },
  });
  const sourceFile = project.createSourceFile("impl.ts", implSource);
  const validationErrors = runAllRules(sourceFile, implPath);
  const validation: ValidationResult =
    validationErrors.length === 0 ? { ok: true } : { ok: false, errors: validationErrors };

  // 3. Read and validate proof/manifest.json
  const manifestPath = join(directoryPath, "proof", "manifest.json");
  const manifestRaw = readFileSync(manifestPath, "utf-8");
  const manifestParsed: unknown = JSON.parse(manifestRaw);
  // validateProofManifestL0 throws TypeError if not exactly one property_tests artifact
  const manifest = validateProofManifestL0(manifestParsed);

  // 4. Read artifact bytes for each artifact declared in the manifest.
  //    Paths are relative to proof/ directory.
  const proofDir = join(directoryPath, "proof");
  const artifacts = new Map<string, Uint8Array>();
  for (const artifact of manifest.artifacts) {
    const artifactPath = join(proofDir, artifact.path);
    const artifactBytes = readFileSync(artifactPath);
    artifacts.set(artifact.path, artifactBytes);
  }

  // 5. Assemble the BlockTriplet and derive the BlockMerkleRoot.
  const triplet: BlockTriplet = { spec, implSource, manifest, artifacts };
  const merkleRoot = blockMerkleRoot(triplet);

  // 6. Extract sub-block composition references from impl.ts imports.
  const composition = extractComposition(implSource, extraPatterns);

  return {
    spec,
    specHashValue,
    implSource,
    manifest,
    artifacts,
    validation,
    triplet,
    merkleRoot,
    composition,
  };
}
