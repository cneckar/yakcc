// SPDX-License-Identifier: MIT
// @decision DEC-HOOK-FACADE-V0: The v0 hook is a passthrough facade. All
// emission-intent calls return {kind:"passthrough"} so Claude Code behaves normally.
// Status: provisional (WI-0.5 adds real registry-hit and synthesis-required paths)
// Rationale: Consumers need to wire the hook before the registry is live.
// registerSlashCommand() is a no-op; onCodeEmissionIntent() always returns passthrough.
import type { ContractId, ContractSpec } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";

export type { ContractId };

// ---------------------------------------------------------------------------
// Emission context
// ---------------------------------------------------------------------------

/** Describes the context in which Claude Code is about to emit code. */
export interface EmissionContext {
  /** Natural-language description of what the user asked for. */
  readonly intent: string;
  /** Optional surrounding source context at the emission site. */
  readonly sourceContext?: string;
}

// ---------------------------------------------------------------------------
// Hook response
// ---------------------------------------------------------------------------

/**
 * The three possible responses from the hook's emission-intent handler:
 *
 * - registry-hit: an existing implementation was found; use it.
 * - synthesis-required: no match exists; the registry needs a new block.
 * - passthrough: defer to normal Claude Code behaviour (v0 default).
 */
export type HookResponse =
  | { readonly kind: "registry-hit"; readonly id: ContractId }
  | { readonly kind: "synthesis-required"; readonly proposal: ContractSpec }
  | { readonly kind: "passthrough" };

// ---------------------------------------------------------------------------
// Hook interface
// ---------------------------------------------------------------------------

/**
 * The Claude Code hook interface. One instance is created per session and
 * wired into the Claude Code extension via registerSlashCommand().
 */
export interface ClaudeCodeHook {
  /** Register the /yakcc slash command with the Claude Code harness. */
  registerSlashCommand(): void;
  /**
   * Called when Claude Code is about to emit code. Returns a HookResponse
   * indicating whether to use an existing block, synthesise a new one, or
   * fall through to normal behaviour.
   */
  onCodeEmissionIntent(ctx: EmissionContext): Promise<HookResponse>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ClaudeCodeHook backed by the given registry.
 *
 * v0 facade: registerSlashCommand() is a no-op; onCodeEmissionIntent() always
 * returns {kind:"passthrough"}. WI-0.5 adds registry search and synthesis paths.
 *
 * @param _registry - Registry instance to consult for matching blocks.
 */
export function createHook(_registry: Registry): ClaudeCodeHook {
  return {
    registerSlashCommand() {},
    onCodeEmissionIntent(_ctx) {
      return Promise.resolve({ kind: "passthrough" } satisfies HookResponse);
    },
  };
}
