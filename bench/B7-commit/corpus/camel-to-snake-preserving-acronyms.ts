// SPDX-License-Identifier: MIT

/**
 * Convert a camelCase or PascalCase identifier to snake_case, preserving
 * consecutive uppercase acronyms as a single lowercase segment.
 * Examples:
 *   "camelCase"         → "camel_case"
 *   "parseHTTPResponse" → "parse_http_response"
 *   "myURLParser"       → "my_url_parser"
 *   "HTMLParser"        → "html_parser"
 *
 * @param input - A camelCase or PascalCase identifier string.
 * @returns The snake_case equivalent with acronyms collapsed to lowercase segments.
 */
export function camelToSnakePreservingAcronyms(input: string): string {
  if (!input) return input;
  // Insert underscore before a transition from a run of uppercase to lowercase,
  // e.g. "HTTPResponse" → "HTTP_Response", then lowercase everything.
  const step1 = input.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2");
  // Insert underscore before a single uppercase letter preceded by lowercase,
  // e.g. "camelCase" → "camel_Case".
  const step2 = step1.replace(/([a-z\d])([A-Z])/g, "$1_$2");
  return step2.toLowerCase();
}
