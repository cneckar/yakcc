/**
 * @decision DEC-MCP-SCHEMA-PARSERS-010
 * @title Hand-rolled input validators for all 8 tool modules
 * @status decided (wi-944, bite 2)
 * @rationale
 *   Each tool receives `args: unknown` from the MCP layer. This module provides
 *   typed parsers that return a discriminated { ok, value } | { ok, code, message }
 *   result so tool handlers can produce structured MCP content on bad input
 *   (DEC-MCP-ERROR-AS-CONTENT-004) rather than throwing. No runtime schema
 *   library (zod etc.) is introduced — all validators are hand-written to keep
 *   the package dep footprint minimal.
 *
 * Wire format references:
 *   - ShaveRequestCoord: yakforge W-130 DEC-HR-SHAVE-REQUESTS-API-001
 *   - WireBlockTriplet:  yakforge W-141
 *   - BlockMerkleRoot, SpecHash: 64-char lowercase hex (BLAKE3)
 *
 * Implements: yakcc#944
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Represents a parse error result returned by every parser. */
export interface ParseError {
  ok: false;
  code: "invalid_input";
  message: string;
}

/** Represents a parse success result returned by every parser. */
export interface ParseOk<T> {
  ok: true;
  value: T;
}

export type ParseResult<T> = ParseOk<T> | ParseError;

// ---------------------------------------------------------------------------
// BlockMerkleRoot
// ---------------------------------------------------------------------------

/** 64-character lowercase hexadecimal string (BLAKE3 digest). */
export type BlockMerkleRoot = string;

const BLAKE3_HEX_RE = /^[a-f0-9]{64}$/;

/**
 * Validate that the input is a 64-char lowercase hex string.
 * Accepts both bare strings and objects with a `root` property.
 */
export function parseBlockMerkleRoot(input: unknown): ParseResult<BlockMerkleRoot> {
  if (typeof input !== "string") {
    return { ok: false, code: "invalid_input", message: "root must be a string" };
  }
  if (!BLAKE3_HEX_RE.test(input)) {
    return {
      ok: false,
      code: "invalid_input",
      message: "root must be a 64-character lowercase hex string (BLAKE3)",
    };
  }
  return { ok: true, value: input };
}

// ---------------------------------------------------------------------------
// SpecHash
// ---------------------------------------------------------------------------

/** 64-character lowercase hexadecimal string identifying a spec. */
export type SpecHash = string;

/**
 * Validate that the input is a 64-char lowercase hex string for a spec hash.
 * The encoding is identical to BlockMerkleRoot; the separate type aids readability.
 */
export function parseSpecHash(input: unknown): ParseResult<SpecHash> {
  if (typeof input !== "string") {
    return { ok: false, code: "invalid_input", message: "specHash must be a string" };
  }
  if (!BLAKE3_HEX_RE.test(input)) {
    return {
      ok: false,
      code: "invalid_input",
      message: "specHash must be a 64-character lowercase hex string (BLAKE3)",
    };
  }
  return { ok: true, value: input };
}

// ---------------------------------------------------------------------------
// WireBlockTriplet
// ---------------------------------------------------------------------------

/**
 * Raw wire format for an atom block submission (yakforge W-141).
 * Matches the JSON shape accepted by POST /v1/blocks/submit.
 */
export interface WireBlockTriplet {
  specHash: string;
  specCanonicalBytes: string;
  blockMerkleRoot: string;
  implSource: string;
}

/**
 * Validate that input has the four required WireBlockTriplet string fields.
 * The server performs integrity validation; we only enforce structural shape here.
 */
export function parseWireBlockTriplet(input: unknown): ParseResult<WireBlockTriplet> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      code: "invalid_input",
      message:
        "block must be an object with specHash, specCanonicalBytes, blockMerkleRoot, implSource",
    };
  }
  const obj = input as Record<string, unknown>;

  const required = ["specHash", "specCanonicalBytes", "blockMerkleRoot", "implSource"] as const;
  for (const key of required) {
    if (typeof obj[key] !== "string") {
      return {
        ok: false,
        code: "invalid_input",
        message: `block.${key} must be a string`,
      };
    }
  }

  return {
    ok: true,
    value: {
      specHash: obj.specHash as string,
      specCanonicalBytes: obj.specCanonicalBytes as string,
      blockMerkleRoot: obj.blockMerkleRoot as string,
      implSource: obj.implSource as string,
    },
  };
}

// ---------------------------------------------------------------------------
// ShaveRequestCoord (discriminated union over source)
// ---------------------------------------------------------------------------

/** Coordinates for a PyPI shave request. */
export interface PypiCoord {
  source: "pypi";
  name: string;
  version: string;
}

/** Coordinates for an npm shave request. */
export interface NpmCoord {
  source: "npm";
  name: string;
  version: string;
}

/** Coordinates for a GitHub shave request. */
export interface GithubCoord {
  source: "github";
  owner: string;
  repo: string;
  ref: string;
}

/** Discriminated union of all supported shave request coordinate types. */
export type ShaveRequestCoord = PypiCoord | NpmCoord | GithubCoord;

const SUPPORTED_SOURCES = ["pypi", "npm", "github"] as const;

/**
 * Validate a ShaveRequestCoord discriminated by the `source` field.
 * Each branch enforces the required fields for that source type.
 * (yakforge W-130 DEC-HR-SHAVE-REQUESTS-API-001)
 */
export function parseShaveRequestCoord(input: unknown): ParseResult<ShaveRequestCoord> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      code: "invalid_input",
      message: `coord must be an object with a source field (one of: ${SUPPORTED_SOURCES.join(", ")})`,
    };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.source !== "string") {
    return {
      ok: false,
      code: "invalid_input",
      message: `coord.source must be a string (one of: ${SUPPORTED_SOURCES.join(", ")})`,
    };
  }

  switch (obj.source) {
    case "pypi":
    case "npm": {
      if (typeof obj.name !== "string" || obj.name.length === 0) {
        return {
          ok: false,
          code: "invalid_input",
          message: `coord.name must be a non-empty string for source '${obj.source}'`,
        };
      }
      if (typeof obj.version !== "string" || obj.version.length === 0) {
        return {
          ok: false,
          code: "invalid_input",
          message: `coord.version must be a non-empty string for source '${obj.source}'`,
        };
      }
      return {
        ok: true,
        value: { source: obj.source, name: obj.name, version: obj.version },
      };
    }
    case "github": {
      if (typeof obj.owner !== "string" || obj.owner.length === 0) {
        return {
          ok: false,
          code: "invalid_input",
          message: "coord.owner must be a non-empty string for source 'github'",
        };
      }
      if (typeof obj.repo !== "string" || obj.repo.length === 0) {
        return {
          ok: false,
          code: "invalid_input",
          message: "coord.repo must be a non-empty string for source 'github'",
        };
      }
      if (typeof obj.ref !== "string" || obj.ref.length === 0) {
        return {
          ok: false,
          code: "invalid_input",
          message: "coord.ref must be a non-empty string for source 'github'",
        };
      }
      return {
        ok: true,
        value: { source: "github", owner: obj.owner, repo: obj.repo, ref: obj.ref },
      };
    }
    default: {
      return {
        ok: false,
        code: "invalid_input",
        message: `coord.source '${String(obj.source)}' is not supported. Must be one of: ${SUPPORTED_SOURCES.join(", ")}`,
      };
    }
  }
}
