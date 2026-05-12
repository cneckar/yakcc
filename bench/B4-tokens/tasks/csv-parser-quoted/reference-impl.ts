// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/csv-parser-quoted/reference-impl.ts
//
// @decision DEC-BENCH-B4-CORPUS-001
// @title B4 task corpus: csv-parser-quoted reference implementation
// @status accepted
// @rationale
//   Reference implementation for oracle validation (Slice 1). Exists to prove the
//   oracle tests correctly distinguish correct from broken implementations. It is NOT
//   the thing being measured — it is the ground truth that validates the oracle before
//   Slice 2 measures real LLM output. A passing reference + failing broken-impl proves
//   oracle gates are not vacuous. See TASKS_RATIONALE.md for full corpus selection rationale.
//
// State-machine CSV parser implementing RFC 4180 with these extensions:
//   - Auto-detects CRLF vs LF line endings
//   - Embedded newlines inside quoted fields preserved verbatim
//   - Double-quote escaping (two consecutive quotes = one literal quote)
//   - Trailing newline suppression (no spurious empty final row)
//   - BOM handling (strips leading UTF-8 BOM U+FEFF)

export interface ParseCSVOptions {
  delimiter?: string;
  quote?: string;
  newline?: string;
}

type State =
  | "FIELD_START"
  | "IN_UNQUOTED"
  | "IN_QUOTED"
  | "AFTER_QUOTE";

/**
 * Parse RFC 4180-compliant CSV text into a 2D array of strings.
 *
 * @param input - Raw CSV string (LF or CRLF line endings, optional UTF-8 BOM)
 * @param options - Optional delimiter, quote, and newline override
 * @returns Array of rows, each row an array of field strings
 */
export function parseCSV(input: string, options?: ParseCSVOptions): string[][] {
  const delim = options?.delimiter ?? ",";
  const quote = options?.quote ?? '"';

  // Strip UTF-8 BOM if present
  const text = input.startsWith("﻿") ? input.slice(1) : input;

  if (text === "") return [];

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let field = "";
  let state: State = "FIELD_START";
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    switch (state) {
      case "FIELD_START": {
        if (ch === quote) {
          state = "IN_QUOTED";
          i++;
        } else if (ch === delim) {
          currentRow.push("");
          i++;
        } else if (ch === "\r") {
          // CRLF or lone CR
          currentRow.push("");
          rows.push(currentRow);
          currentRow = [];
          i++;
          if (i < len && text[i] === "\n") i++;
        } else if (ch === "\n") {
          currentRow.push("");
          rows.push(currentRow);
          currentRow = [];
          i++;
        } else {
          field += ch;
          state = "IN_UNQUOTED";
          i++;
        }
        break;
      }

      case "IN_UNQUOTED": {
        if (ch === delim) {
          currentRow.push(field);
          field = "";
          state = "FIELD_START";
          i++;
        } else if (ch === "\r") {
          currentRow.push(field);
          field = "";
          rows.push(currentRow);
          currentRow = [];
          state = "FIELD_START";
          i++;
          if (i < len && text[i] === "\n") i++;
        } else if (ch === "\n") {
          currentRow.push(field);
          field = "";
          rows.push(currentRow);
          currentRow = [];
          state = "FIELD_START";
          i++;
        } else {
          field += ch;
          i++;
        }
        break;
      }

      case "IN_QUOTED": {
        if (ch === quote) {
          state = "AFTER_QUOTE";
          i++;
        } else {
          // Preserve all characters verbatim (including \r\n inside quoted fields)
          field += ch;
          i++;
        }
        break;
      }

      case "AFTER_QUOTE": {
        if (ch === quote) {
          // Escaped quote: two consecutive quotes = one literal quote
          field += quote;
          state = "IN_QUOTED";
          i++;
        } else if (ch === delim) {
          currentRow.push(field);
          field = "";
          state = "FIELD_START";
          i++;
        } else if (ch === "\r") {
          currentRow.push(field);
          field = "";
          rows.push(currentRow);
          currentRow = [];
          state = "FIELD_START";
          i++;
          if (i < len && text[i] === "\n") i++;
        } else if (ch === "\n") {
          currentRow.push(field);
          field = "";
          rows.push(currentRow);
          currentRow = [];
          state = "FIELD_START";
          i++;
        } else {
          // Non-standard: character after closing quote before delimiter/newline
          // Treat as part of field (lenient mode)
          field += ch;
          state = "IN_UNQUOTED";
          i++;
        }
        break;
      }
    }
  }

  // Flush the last field / row.
  // Suppress trailing empty row: if input ends with a newline, the loop already
  // pushed the row and started a new empty currentRow with no fields.
  // Only add current row if it has accumulated content or unfinished state.
  if (state === "IN_QUOTED" || state === "AFTER_QUOTE" || field !== "" || currentRow.length > 0) {
    currentRow.push(field);
    rows.push(currentRow);
  }

  return rows;
}
