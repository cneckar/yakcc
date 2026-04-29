// @decision DEC-CLI-FACADE-V0: The v0 yakcc CLI wires all packages with
// facade command handlers for registry init, propose, search, compile, author.
// Status: provisional (WI-005 wires real assembly; WI-003 wires real registry)
// Rationale: CLI surface must be established before backends exist.
import type { ContractId } from "@yakcc/contracts";
export type { ContractId };

/**
 * Run the yakcc CLI with the given argument vector.
 *
 * Returns the process exit code (0 = success, non-zero = error).
 *
 * v0 facade: prints usage and returns 0. WI-005 wires the real command
 * handlers (registry init, propose, search, compile, block author).
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  // Facade: acknowledge the argv to satisfy the no-unused-vars checker.
  void argv;
  // Facade: real commands ship in WI-005.
  return 0;
}
