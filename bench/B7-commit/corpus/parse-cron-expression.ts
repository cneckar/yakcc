// SPDX-License-Identifier: MIT

/** Parsed fields from a 5-field cron expression. */
export interface CronFields {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

/**
 * Parse a standard 5-field cron expression (minute, hour, day-of-month, month,
 * day-of-week) into its component fields. Validates that each field is either
 * "*" (wildcard), a single integer within the allowed range, or a step form
 * ("* /N" notation, e.g. every-N units). Returns null for any expression that
 * does not conform.
 *
 * @param expr - Cron expression string containing exactly 5 space-separated fields.
 * @returns Parsed fields object, or null if the expression is invalid.
 */
export function parseCronExpression(expr: string): CronFields | null {
  if (typeof expr !== "string") return null;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const limits = [
    { min: 0, max: 59 },  // minute
    { min: 0, max: 23 },  // hour
    { min: 1, max: 31 },  // day-of-month
    { min: 1, max: 12 },  // month
    { min: 0, max: 7  },  // day-of-week (0 and 7 = Sunday)
  ];
  for (let i = 0; i < 5; i++) {
    const f = fields[i]!;
    const { min, max } = limits[i]!;
    if (f === "*") continue;
    if (/^\*\/\d+$/.test(f)) {
      const step = Number(f.slice(2));
      if (step < 1 || step > max) return null;
      continue;
    }
    if (!/^\d+$/.test(f)) return null;
    const n = Number(f);
    if (n < min || n > max) return null;
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string,string,string,string,string];
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}
