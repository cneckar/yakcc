// SPDX-License-Identifier: MIT
//
// @decision DEC-COMPOSE-BY-REF-MANIFEST-001
// title: ProjectManifest — project-level content-address registry for compose-by-reference
// status: decided (#1044, epic #1043)
// rationale:
//   The compose-by-reference design (DEC-V3-DISCOVERY-D4-001) lets the model emit a
//   ~10-token REFERENCE to an atom by its content-address (BlockMerkleRoot) instead of
//   writing the full implementation (~100–500 tokens). To make that work, the project
//   needs a single source of truth that pins the FULL 64-char content address of every
//   referenced atom while the in-source import uses only a short project-unique alias
//   (default: first 12 hex chars, extended on collision).
//
//   ProjectManifest is that authority. It is a separate concern from ProvenanceManifest
//   (packages/compile/src/manifest.ts), which is a per-assembly audit trail produced by
//   `assemble()`. ProjectManifest is a project-lifecycle artefact, committed to the repo
//   as `.yakcc/manifest.json`, and mutated by `addReference()` as the model adds atoms.
//
//   Downstream consumers:
//     - #1045 (build-inline / yakcc build): reads manifest, materializes .ts for each ref
//     - #1046 (.d.ts): materializes .d.ts stubs so in-source imports typecheck
//     - #1047 (yakcc_reference MCP tool): calls addReference, returns referenceImportLine
//
//   The alias collision-extension rule (12 chars → extend until unique) is defined here
//   and is the single authority for alias computation. No other package re-declares it.

import type { BlockMerkleRoot } from "@yakcc/contracts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical path for the project manifest, relative to project root. */
export const PROJECT_MANIFEST_PATH = ".yakcc/manifest.json";

/** Default alias prefix length (characters). Extended on collision. */
const DEFAULT_ALIAS_LENGTH = 12;

/** Regex for a valid 64-character lowercase hex string. */
const HEX64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/**
 * Thrown by parseProjectManifest() on any validation failure.
 * Fail loudly — no silent defaults (DEC-COMPOSE-BY-REF-MANIFEST-001).
 */
export class ProjectManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectManifestError";
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One atom reference in the project manifest.
 *
 * The `root` is the full 64-char content address (the cryptographic pin).
 * The `alias` is the token-cheap project-unique short prefix used in source imports.
 * The `importPath` is the exact module specifier that in-source code uses, computed
 * as `.yakcc/atoms/<alias>` and recorded here so there is ONE authority.
 *
 * @decision DEC-COMPOSE-BY-REF-MANIFEST-001
 */
export interface AtomReference {
  /** Full 64-char lowercase-hex BLAKE3-256 content address. */
  readonly root: BlockMerkleRoot;
  /** The bound export name the source imports (e.g. "crc32c"). */
  readonly symbol: string;
  /**
   * Project-unique short prefix of `root` used in the materialised file basename
   * and in-source import path. Default: first 12 chars. Extended further along `root`
   * if that prefix already appears in the manifest for a different reference.
   */
  readonly alias: string;
  /**
   * The in-source module specifier. Computed as `.yakcc/atoms/<alias>` (no extension).
   * Recorded here so there is ONE authority for what the source imports.
   */
  readonly importPath: string;
  /** Source registry id for reproducibility / air-gap. Default: "local". */
  readonly registry: string;
  /** Atom or registry version, or null if unavailable. */
  readonly version: string | null;
}

/**
 * The project manifest: pins all referenced atom content-addresses.
 *
 * Stored at `.yakcc/manifest.json` (PROJECT_MANIFEST_PATH).
 * Version field is a literal 1 — a future incompatible schema uses a new version number.
 *
 * @decision DEC-COMPOSE-BY-REF-MANIFEST-001
 */
export interface ProjectManifest {
  readonly version: 1;
  readonly references: AtomReference[];
}

// ---------------------------------------------------------------------------
// Validation helpers (internal)
// ---------------------------------------------------------------------------

function isHex64(s: string): boolean {
  return HEX64_RE.test(s);
}

/** Raw shape of an un-validated reference object from JSON.parse(). */
interface RawRef {
  root: unknown;
  symbol: unknown;
  alias: unknown;
  importPath: unknown;
  registry: unknown;
  version: unknown;
}

function validateReference(ref: unknown, idx: number): AtomReference {
  if (typeof ref !== "object" || ref === null) {
    throw new ProjectManifestError(`references[${idx}]: expected object, got ${typeof ref}`);
  }
  // Destructure from the raw object; unknown properties are ignored.
  const { root, symbol, alias, importPath, registry, version } = ref as RawRef;

  if (typeof root !== "string" || !isHex64(root)) {
    throw new ProjectManifestError(
      `references[${idx}].root must be exactly 64 lowercase hex chars`,
    );
  }
  if (typeof symbol !== "string" || symbol.length === 0) {
    throw new ProjectManifestError(`references[${idx}].symbol must be a non-empty string`);
  }
  if (typeof alias !== "string" || alias.length === 0) {
    throw new ProjectManifestError(`references[${idx}].alias must be a non-empty string`);
  }
  if (!root.startsWith(alias)) {
    throw new ProjectManifestError(
      `references[${idx}].alias "${alias}" is not a prefix of root "${root}"`,
    );
  }
  const expectedImportPath = `.yakcc/atoms/${alias}`;
  if (importPath !== expectedImportPath) {
    throw new ProjectManifestError(
      `references[${idx}].importPath must be "${expectedImportPath}", got "${String(importPath)}"`,
    );
  }
  if (typeof registry !== "string" || registry.length === 0) {
    throw new ProjectManifestError(`references[${idx}].registry must be a non-empty string`);
  }
  if (version !== null && typeof version !== "string") {
    throw new ProjectManifestError(`references[${idx}].version must be a string or null`);
  }

  return {
    root: root as BlockMerkleRoot,
    symbol,
    alias,
    importPath: expectedImportPath,
    registry,
    version: version as string | null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse and validate a ProjectManifest from its JSON text.
 *
 * Throws {@link ProjectManifestError} on any validation failure:
 * - wrong version
 * - root not exactly 64 lowercase hex chars
 * - empty symbol
 * - alias not a prefix of root
 * - importPath inconsistent with alias
 * - duplicate aliases
 *
 * No silent defaults. Fail loudly (DEC-COMPOSE-BY-REF-MANIFEST-001).
 */
export function parseProjectManifest(text: string): ProjectManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ProjectManifestError(`invalid JSON: ${String(e)}`);
  }

  if (typeof raw !== "object" || raw === null) {
    throw new ProjectManifestError("manifest root must be a JSON object");
  }
  const { version: rawVersion, references: rawRefs } = raw as {
    version: unknown;
    references: unknown;
  };

  if (rawVersion !== 1) {
    throw new ProjectManifestError(`manifest.version must be 1, got ${JSON.stringify(rawVersion)}`);
  }
  if (!Array.isArray(rawRefs)) {
    throw new ProjectManifestError("manifest.references must be an array");
  }

  const references: AtomReference[] = [];
  const seenAliases = new Set<string>();

  for (let i = 0; i < rawRefs.length; i++) {
    const ref = validateReference(rawRefs[i], i);
    if (seenAliases.has(ref.alias)) {
      throw new ProjectManifestError(
        `references[${i}].alias "${ref.alias}" is not unique in this manifest`,
      );
    }
    seenAliases.add(ref.alias);
    references.push(ref);
  }

  return { version: 1, references };
}

/**
 * Serialize a ProjectManifest to a deterministic, stable-key-order JSON string.
 *
 * Produces 2-space indent with a trailing newline. Round-trips with parseProjectManifest.
 */
export function serializeProjectManifest(m: ProjectManifest): string {
  const obj = {
    version: m.version,
    references: m.references.map((ref) => ({
      root: ref.root,
      symbol: ref.symbol,
      alias: ref.alias,
      importPath: ref.importPath,
      registry: ref.registry,
      version: ref.version,
    })),
  };
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/**
 * Return an empty, valid ProjectManifest (version 1, no references).
 */
export function emptyManifest(): ProjectManifest {
  return { version: 1, references: [] };
}

/**
 * Compute a project-unique alias for a given root, given the set of aliases already
 * in use across ALL references in the manifest.
 *
 * Starts with the first 12 chars of root. If that prefix is already taken by any
 * existing reference (regardless of which root owns it), extends by one character
 * at a time until a free prefix is found, or the full root is exhausted.
 *
 * This means each reference gets its own unique alias even when two references share
 * the same root but different symbols (e.g. two named exports from one atom).
 *
 * Throws if a unique prefix cannot be found (should never happen for distinct references
 * on roots with 64 hex chars of entropy).
 *
 * @decision DEC-COMPOSE-BY-REF-MANIFEST-001
 * Alias uniqueness is per-reference, not per-root. Two imports of different symbols
 * from the same atom each get a unique import path, keeping the alias namespace flat.
 */
function computeAlias(
  root: BlockMerkleRoot,
  takenAliases: ReadonlySet<string>,
): string {
  for (let len = DEFAULT_ALIAS_LENGTH; len <= root.length; len++) {
    const candidate = root.slice(0, len);
    if (!takenAliases.has(candidate)) {
      // Candidate is free — claim it.
      return candidate;
    }
    // Alias taken by some existing reference — extend by one char.
  }
  throw new ProjectManifestError(
    `cannot compute unique alias for root ${root} — all prefixes are taken`,
  );
}

/**
 * Add an atom reference to a manifest.
 *
 * Idempotent: if the same `root` + `symbol` pair already exists, returns the
 * existing manifest and reference unchanged.
 *
 * Computes a project-unique alias (12-char prefix of root, extended on collision),
 * builds the importPath, and appends the new reference.
 *
 * Does NOT mutate the input manifest.
 *
 * @returns `{ manifest, reference }` — the updated manifest and the (new or existing) reference.
 */
export function addReference(
  m: ProjectManifest,
  opts: {
    root: BlockMerkleRoot;
    symbol: string;
    registry?: string;
    version?: string | null;
  },
): { manifest: ProjectManifest; reference: AtomReference } {
  const { root, symbol, registry = "local", version = null } = opts;

  // Idempotency: return existing if same root + symbol.
  const existing = m.references.find((r) => r.root === root && r.symbol === symbol);
  if (existing !== undefined) {
    return { manifest: m, reference: existing };
  }

  // Build a set of all aliases currently in use for collision detection.
  const takenAliases = new Set<string>(m.references.map((r) => r.alias));

  const alias = computeAlias(root, takenAliases);
  const importPath = `.yakcc/atoms/${alias}`;

  const reference: AtomReference = { root, symbol, alias, importPath, registry, version };
  const references = [...m.references, reference];

  return {
    manifest: { version: 1, references },
    reference,
  };
}

/**
 * The path where `yakcc build` (#1045) will materialise the TypeScript implementation
 * for an atom with the given alias.
 *
 * Relative to project root, e.g. `.yakcc/atoms/abc123def456.ts`.
 */
export function materializedModulePath(alias: string): string {
  return `.yakcc/atoms/${alias}.ts`;
}

/**
 * The path where the .d.ts pass (#1046) will materialise the TypeScript declaration
 * file for an atom with the given alias.
 *
 * Relative to project root, e.g. `.yakcc/atoms/abc123def456.d.ts`.
 */
export function materializedDtsPath(alias: string): string {
  return `.yakcc/atoms/${alias}.d.ts`;
}

/**
 * The exact in-source import line the model emits for a compose-by-reference atom.
 *
 * This is the ~10-token line that replaces writing the full implementation.
 * Example: `import { crc32c } from ".yakcc/atoms/abc123def456";`
 *
 * #1047 (yakcc_reference MCP tool) returns this string to the model.
 */
export function referenceImportLine(ref: AtomReference): string {
  return `import { ${ref.symbol} } from "${ref.importPath}";`;
}
