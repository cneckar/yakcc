// SPDX-License-Identifier: MIT
// @decision DEC-CONTINUOUS-SHAVE-022: Three named error classes cover the three
// distinct failure modes of intent extraction. Named classes (rather than a
// generic Error with a code field) let callers catch specific error types with
// `instanceof` without importing an enum or string constant.
// Status: decided (MASTER_PLAN.md DEC-CONTINUOUS-SHAVE-022)
// Rationale: TypeScript `instanceof` narrowing works reliably for named Error
// subclasses. A code-string approach requires callers to import and compare
// string constants, which is error-prone.
//
// WI-013-02: LicenseRefusedError added as the fourth error class covering
// the license-gate failure mode in universalize().

/**
 * Thrown when a live extraction is attempted but ANTHROPIC_API_KEY is not set
 * and no `client` was provided in ExtractIntentContext.
 *
 * Resolution: set the ANTHROPIC_API_KEY environment variable, or pass a
 * pre-constructed client (including a mock) via ExtractIntentContext.client.
 */
export class AnthropicApiKeyMissingError extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY is not set; cannot extract intent. " +
        "Set the env var or pass `client` in ExtractIntentContext.",
    );
    this.name = "AnthropicApiKeyMissingError";
  }
}

/**
 * Thrown when offline mode is active and the cache does not contain an entry
 * for the requested cache key.
 *
 * Resolution: pre-populate the cache with `extractIntent` in online mode, or
 * disable offline mode to allow live API calls.
 */
export class OfflineCacheMissError extends Error {
  constructor(cacheKey: string) {
    super(`Offline mode: cache miss for key ${cacheKey}.`);
    this.name = "OfflineCacheMissError";
  }
}

/**
 * Thrown when an IntentCard value fails schema validation.
 *
 * This covers: malformed API responses (missing JSON fences, unparseable JSON,
 * wrong types), unknown top-level fields, and invalid field values (e.g.
 * behavior > 200 chars, sourceHash not 64 hex chars).
 *
 * The `detail` parameter names the specific offending field or condition.
 */
export class IntentCardSchemaError extends Error {
  constructor(detail: string) {
    super(`IntentCard schema violation: ${detail}`);
    this.name = "IntentCardSchemaError";
  }
}

import type { LicenseDetection } from "./license/types.js";

/**
 * Thrown by universalize() when the candidate's source carries a refused
 * license (copyleft, proprietary, unrecognized, or no signal).
 *
 * Resolution: only feed permissive-licensed sources to universalize(); per
 * MASTER_PLAN.md v0.7 the registry is permissive-only by structural gate.
 */
export class LicenseRefusedError extends Error {
  readonly detection: LicenseDetection;
  constructor(reason: string, detection: LicenseDetection) {
    super(`License refused: ${reason}`);
    this.name = "LicenseRefusedError";
    this.detection = detection;
  }
}

/**
 * Thrown by shave() when foreignPolicy === 'reject' and the slice plan
 * contains one or more ForeignLeafEntry records.
 *
 * @decision DEC-V2-FOREIGN-BLOCK-SCHEMA-001 (sub-L5: policy gate)
 * title: ForeignPolicyRejectError — structured reject-policy failure
 * status: decided (WI-V2-04 L5)
 * rationale:
 *   Named error class (rather than generic Error) lets the CLI catch it with
 *   `instanceof` and format the error message without string-parsing. The
 *   `foreignRefs` array carries every offending (pkg, export) pair in
 *   source-declaration order so the CLI can emit all offenders in one message.
 *
 *   L5-I3: the structured error must contain pkg+export of each foreign ref.
 *   The message format is: "foreign-policy reject: <pkg>#<export>[, ...]"
 *   so the CLI stderr line contains both the package name and the export name.
 *
 *   Not thrown for 'allow' or 'tag' — only for 'reject'.
 */
export class ForeignPolicyRejectError extends Error {
  /** All foreign (pkg, export) pairs from the slice plan, in source order. */
  readonly foreignRefs: readonly { readonly pkg: string; readonly export: string }[];

  constructor(foreignRefs: readonly { readonly pkg: string; readonly export: string }[]) {
    const refList = foreignRefs.map((r) => `${r.pkg}#${r.export}`).join(", ");
    super(`foreign-policy reject: ${refList}`);
    this.name = "ForeignPolicyRejectError";
    this.foreignRefs = foreignRefs;
  }
}
