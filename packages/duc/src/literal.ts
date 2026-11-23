// SPDX-License-Identifier: Apache-2.0
/**
 * Literal labels in normal form (#1275). A string literal is labelled by its value as a JSON string,
 * whatever quotes it was written with; a number by its value. So `'a'`, `"a"` and a template with
 * no substitutions are one literal, and `1.0`, `1` and `0x1` are another. Other literals (booleans,
 * null, regular expressions, big integers) keep their text.
 */

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
  "'": "'",
  '"': '"',
  "\\": "\\",
  "`": "`",
};

/** The value of a JavaScript string literal body, or undefined when it uses an escape this does not know. */
function decodeStringBody(body: string): string | undefined {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = body[++i];
    if (n === undefined) return undefined;
    if (n in SIMPLE_ESCAPES && !(n === "0" && /[0-9]/.test(body[i + 1] ?? ""))) {
      out += SIMPLE_ESCAPES[n];
    } else if (n === "x" && /^[0-9a-fA-F]{2}$/.test(body.slice(i + 1, i + 3))) {
      out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (n === "u" && /^[0-9a-fA-F]{4}$/.test(body.slice(i + 1, i + 5))) {
      out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (n === "u" && body[i + 1] === "{") {
      const close = body.indexOf("}", i);
      const hex = body.slice(i + 2, close);
      if (close === -1 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      i = close;
    } else if (n === "\n") {
      // A line continuation adds nothing.
    } else {
      return undefined;
    }
  }
  return out;
}

const NUMBER =
  /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)$/;

/** The normal label of a literal written as `text` (JavaScript source text). */
export function normalizeLiteral(text: string): string {
  const quote = text[0];
  if (
    (quote === "'" || quote === '"' || quote === "`") &&
    text.length >= 2 &&
    text.endsWith(quote)
  ) {
    const body = text.slice(1, -1);
    if (quote === "`" && body.includes("${")) return text;
    const value = decodeStringBody(body);
    if (value !== undefined) return JSON.stringify(value);
    return text;
  }
  if (NUMBER.test(text)) {
    const value = Number(text.replace(/_/g, ""));
    if (Number.isFinite(value)) return String(value);
  }
  return text;
}
