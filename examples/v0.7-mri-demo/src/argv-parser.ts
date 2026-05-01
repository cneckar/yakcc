/**
 * Adapted from lukeed/mri (MIT License)
 *  https://github.com/lukeed/mri  (commit: 20c4fb7 — latest main as of 2025-01)
 *
 * SPDX-License-Identifier: MIT
 *
 * Implements the core algorithmic shape: positional args, --flag, --flag=value,
 * --flag value, alias resolution. Simplified TS adaptation for v0.7 demo.
 *
 * @decision DEC-DECOMPOSE-STAGE-015-CORRECTION
 * title: TS argv-parser as mri demo target (not literal mri JS vendoring)
 * status: decided
 * rationale: mri is a JavaScript package; yakcc's IR pipeline is strict-TS.
 *   A TS adaptation preserves the algorithmic shape of mri (the subject of the
 *   demo) while remaining processable by the ts-morph AST canonicalizer. MIT
 *   attribution is preserved in this header. The pipeline behavior is what's
 *   being demonstrated — not byte-equivalent reproduction of the mri source.
 */

// SPDX-License-Identifier: MIT

export interface ParsedArgs {
  readonly _: readonly string[];
  readonly [flag: string]: unknown;
}

export interface ParseOptions {
  /** Alias map: key is canonical flag name, value is array of alias strings. */
  readonly alias?: Readonly<Record<string, readonly string[]>>;
  /** Flags that are treated as booleans (no value consumed). */
  readonly boolean?: readonly string[];
  /** Default values applied before parsing. */
  readonly default?: Readonly<Record<string, unknown>>;
}

/**
 * Parse an argv array into flags and positional arguments.
 *
 * Single function, single control-flow boundary — deliberately shaped so that
 * isAtom() classifies it as atomic at the default maxCF=1 threshold. This
 * exercises the v0.7 universalize() path where the root AtomLeaf maps to a
 * single NovelGlueEntry with an attached intentCard.
 *
 * @param argv    - Argument strings to parse (e.g. process.argv.slice(2)).
 * @param options - Optional alias, boolean, and default configuration.
 */
export function parseArgv(argv: readonly string[], options?: ParseOptions): ParsedArgs {
  const result: Record<string, unknown> = { _: [] };

  // Apply defaults before scanning
  const defaults = options?.default ?? {};
  for (const [k, v] of Object.entries(defaults)) {
    result[k] = v;
  }

  // Build reverse alias map: alias string → canonical name
  const aliases = options?.alias ?? {};
  const canonicalOf: Record<string, string> = {};
  for (const [canonical, aliasArr] of Object.entries(aliases)) {
    for (const a of aliasArr) {
      canonicalOf[a] = canonical;
    }
    canonicalOf[canonical] = canonical;
  }

  const boolFlags = new Set<string>(options?.boolean ?? []);

  const set = (raw: string, val: unknown): void => {
    const key = canonicalOf[raw] ?? raw;
    result[key] = val;
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i++;
      continue;
    }
    if (arg === "--") {
      // Everything after `--` is positional
      for (let j = i + 1; j < argv.length; j++) {
        (result._ as string[]).push(argv[j] ?? "");
      }
      break;
    }

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eqIdx = body.indexOf("=");
      if (eqIdx !== -1) {
        // --flag=value
        set(body.slice(0, eqIdx), body.slice(eqIdx + 1));
      } else {
        const canonical = canonicalOf[body] ?? body;
        const isBool = boolFlags.has(body) || boolFlags.has(canonical);
        const next = argv[i + 1];
        if (!isBool && next !== undefined && !next.startsWith("-")) {
          set(body, next);
          i++;
        } else {
          set(body, !isBool || result[canonical] !== false);
        }
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      // Expand short flags: -abc → -a -b -c
      const chars = arg.slice(1);
      for (let ci = 0; ci < chars.length; ci++) {
        const ch = chars[ci];
        if (ch === undefined) continue;
        const isLast = ci === chars.length - 1;
        const canonical = canonicalOf[ch] ?? ch;
        const isBool = boolFlags.has(ch) || boolFlags.has(canonical);
        if (isLast && !isBool) {
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith("-")) {
            set(ch, next);
            i++;
          } else {
            set(ch, true);
          }
        } else {
          set(ch, true);
        }
      }
    } else {
      (result._ as string[]).push(arg);
    }
    i++;
  }

  return result as ParsedArgs;
}
