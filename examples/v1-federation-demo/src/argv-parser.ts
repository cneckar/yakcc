/**
 * Adapted from lukeed/mri (MIT License)
 *  https://github.com/lukeed/mri  (commit: 20c4fb7 — latest main as of 2025-01)
 *
 * SPDX-License-Identifier: MIT
 *
 * Implements the core algorithmic shape: positional args, --flag, --flag=value,
 * --flag value, alias resolution, and negation via --no-<flag>. Structured as
 * a single exported function that serves as the shave substrate for the v1
 * federation demo. The acceptance harness invokes shave() with
 * `recursionOptions.maxControlFlowBoundaries` set high enough to classify the
 * entire source file as a single atom, ensuring one block is persisted to
 * registryA for the downstream mirror and compile tests.
 *
 * @decision DEC-V1-FEDERATION-DEMO-ARGV-001
 * title: v1-federation-demo argv-parser as shave substrate for federation demo
 * status: decided
 * rationale:
 *   (a) MIT-permissive license for license-gate testing (DEC-LICENSE-WIRING-002).
 *   (b) The shave pipeline persists a block only when the plan has exactly one
 *       NovelGlueEntry with an intentCard (single-leaf case). Multi-leaf plans
 *       do not attach per-leaf intentCards (deferred to future WI per
 *       DEC-UNIVERSALIZE-WIRING-001). The acceptance harness uses
 *       `recursionOptions: { maxControlFlowBoundaries: 100 }` so the SourceFile
 *       itself is classified as the single atom regardless of internal CF count.
 *   (c) The source is MIT-licensed so it passes the license gate and reaches
 *       intent extraction (DEC-LICENSE-WIRING-002).
 *   (d) intentStrategy: "static" (default) uses the TypeScript Compiler API
 *       locally — no ANTHROPIC_API_KEY required (DEC-INTENT-STRATEGY-001).
 *
 *   MIT attribution is preserved in this header.
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
  /** Flags that are treated as strings (always consume the next value). */
  readonly string?: readonly string[];
}

/**
 * Parse an argv array into flags and positional arguments.
 *
 * Handles:
 *   - Positional arguments (anything not starting with `-`).
 *   - `--flag=value` inline-value syntax.
 *   - `--flag value` next-arg value syntax (when flag is not boolean).
 *   - `--no-flag` negation syntax for boolean flags.
 *   - `-abc` short-flag clusters expanded to individual single-flag tokens.
 *   - `--` passthrough: everything after `--` is positional.
 *   - Alias resolution via the alias map.
 *   - Default values applied before scanning.
 *
 * @param argv    - Argument strings to parse (e.g. process.argv.slice(2)).
 * @param options - Optional alias, boolean, string, and default configuration.
 */
export function parseArgv(argv: readonly string[], options?: ParseOptions): ParsedArgs {
  const result: Record<string, unknown> = { _: [] };

  for (const [k, v] of Object.entries(options?.default ?? {})) {
    result[k] = v;
  }

  const canonicalOf: Record<string, string> = {};
  for (const [canonical, aliases] of Object.entries(options?.alias ?? {})) {
    canonicalOf[canonical] = canonical;
    for (const a of aliases) {
      canonicalOf[a] = canonical;
    }
  }

  const boolFlags = new Set<string>(options?.boolean ?? []);
  const strFlags = new Set<string>(options?.string ?? []);
  const resolve = (raw: string): string => canonicalOf[raw] ?? raw;
  const set = (raw: string, val: unknown): void => {
    result[resolve(raw)] = val;
  };

  const expanded: string[] = [];
  for (const tok of argv) {
    if (tok.startsWith("-") && !tok.startsWith("--") && tok.length > 2) {
      for (const ch of tok.slice(1).split("")) {
        expanded.push(`-${ch}`);
      }
    } else {
      expanded.push(tok);
    }
  }

  let i = 0;
  while (i < expanded.length) {
    const arg = expanded[i];
    if (arg === undefined) {
      i++;
      continue;
    }

    if (arg === "--") {
      for (let j = i + 1; j < expanded.length; j++) {
        (result._ as string[]).push(expanded[j] ?? "");
      }
      break;
    }

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      if (body.startsWith("no-")) {
        set(body.slice(3), false);
      } else {
        const eqIdx = body.indexOf("=");
        if (eqIdx !== -1) {
          set(body.slice(0, eqIdx), body.slice(eqIdx + 1));
        } else {
          const canonical = resolve(body);
          const isBool = boolFlags.has(body) || boolFlags.has(canonical);
          const isStr = strFlags.has(body) || strFlags.has(canonical);
          const next = expanded[i + 1];
          if ((isStr || !isBool) && next !== undefined && !next.startsWith("-")) {
            set(body, next);
            i++;
          } else {
            set(body, !isBool || result[canonical] !== false);
          }
        }
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const ch = arg.slice(1);
      const canonical = resolve(ch);
      const isBool = boolFlags.has(ch) || boolFlags.has(canonical);
      const isStr = strFlags.has(ch) || strFlags.has(canonical);
      const next = expanded[i + 1];
      if ((isStr || !isBool) && next !== undefined && !next.startsWith("-")) {
        set(ch, next);
        i++;
      } else {
        set(ch, true);
      }
    } else {
      (result._ as string[]).push(arg);
    }
    i++;
  }

  return result as ParsedArgs;
}
