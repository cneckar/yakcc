// SPDX-License-Identifier: MIT
//
// lang-target.ts — single authority for file-extension → target-language inference.
//
// @decision DEC-WI877-005
// @title Four-slot polyglot enum (ts | python | rust | go); rust/go stubbed with issue pointers
// @status accepted (WI-877)
// @rationale
//   All CLI verbs that perform language dispatch (shave, compile, roundtrip) must
//   import from this module. No verb does its own `.endsWith(".py")` or --target
//   string matching. This is the single-source authority for the polyglot enum.
//   rust/go are registered but unimplemented in this MVP — each exits 1 with a
//   tracking-issue pointer (#868 / #870). Slots open for future wiring without
//   any CLI re-wiring beyond a new switch arm.
//   Cross-reference: PLAN.md §4 / #877
//
// @decision DEC-WI877-001 (partial)
// @title Extension-driven language inference lives here, not in each verb
// @status accepted (WI-877)
// @rationale
//   inferTarget() is the canonical extension → TargetLang mapping.  Callers
//   pass the file path (or undefined when no positional was given) and the
//   parsed --target flag value.  The --target flag overrides the extension.
//   Cross-reference: PLAN.md §3.2 / #877

/** Supported target languages.  rust and go are registered but unimplemented in this MVP. */
export type TargetLang = "ts" | "python" | "rust" | "go";

/**
 * Tracking issues for targets that are not yet implemented.
 * When a verb receives one of these targets it emits the pointer and exits 1.
 */
export const TARGETS_TRACKED = {
  rust: 868,
  go: 870,
} as const;

/** Extension → TargetLang mapping (single authority). */
const EXT_MAP: Record<string, TargetLang> = {
  ".ts": "ts",
  ".tsx": "ts",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
};

/**
 * Infer the target language from a file path and/or an explicit --target flag.
 *
 * Resolution order:
 *   1. If `override` is a non-empty string, validate and return it (--target wins).
 *   2. If `filePath` is set, extract the lowercase extension and look it up.
 *   3. Otherwise return `"unknown"`.
 *
 * Returns `"unknown"` when neither override nor extension resolves to a known
 * language.  Callers should emit a structured error and exit 1 in that case.
 *
 * @param filePath  Source file path (positional argument), may be undefined.
 * @param override  Raw --target flag value, may be undefined.
 */
export function inferTarget(
  filePath: string | undefined,
  override: string | undefined,
): TargetLang | "unknown" {
  if (override !== undefined && override !== "") {
    // Validate explicit --target value.
    if (isSupportedTarget(override)) {
      return override;
    }
    return "unknown";
  }

  if (filePath !== undefined) {
    const dotIdx = filePath.lastIndexOf(".");
    if (dotIdx !== -1) {
      const ext = filePath.slice(dotIdx).toLowerCase();
      const mapped = EXT_MAP[ext];
      if (mapped !== undefined) {
        return mapped;
      }
    }
  }

  return "unknown";
}

/**
 * Type-guard: returns true when `t` is a member of the TargetLang union.
 */
export function isSupportedTarget(t: string): t is TargetLang {
  return t === "ts" || t === "python" || t === "rust" || t === "go";
}
