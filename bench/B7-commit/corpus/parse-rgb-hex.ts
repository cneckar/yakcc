// SPDX-License-Identifier: MIT

/** RGB color components with each channel in [0, 255]. */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/**
 * Parse a CSS hex color string into its red, green, and blue components (0–255).
 * Accepts 3-digit (#RGB) and 6-digit (#RRGGBB) forms, case-insensitive.
 * Returns null for any string that does not match these forms exactly.
 *
 * @param hex - The hex color string, e.g. "#f0a" or "#ff00aa".
 * @returns RgbColor with { r, g, b } each in [0, 255], or null for invalid input.
 */
export function parseRgbHex(hex: string): RgbColor | null {
  if (typeof hex !== "string" || hex[0] !== "#") return null;
  const body = hex.slice(1).toLowerCase();
  if (body.length === 3) {
    if (!/^[0-9a-f]{3}$/.test(body)) return null;
    const r = parseInt(body[0]! + body[0]!, 16);
    const g = parseInt(body[1]! + body[1]!, 16);
    const b = parseInt(body[2]! + body[2]!, 16);
    return { r, g, b };
  }
  if (body.length === 6) {
    if (!/^[0-9a-f]{6}$/.test(body)) return null;
    const r = parseInt(body.slice(0, 2), 16);
    const g = parseInt(body.slice(2, 4), 16);
    const b = parseInt(body.slice(4, 6), 16);
    return { r, g, b };
  }
  return null;
}
