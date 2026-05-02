// SPDX-License-Identifier: MIT
// Bootstrap fixture: simple greeting function for bootstrap command tests.

/**
 * Produce a greeting string.
 * @param name - The name to greet.
 * @returns A greeting message.
 */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
