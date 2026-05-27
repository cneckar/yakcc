// SPDX-License-Identifier: MIT
//
// commons-submit.ts — CLI-side composition helper for the WI-794 commons-push
// (DEC-COMMONS-SUBMIT-AT-STOREBLOCK-001 / DEC-COMMONS-ALWAYS-ON-001).
//
// Combines `@yakcc/federation`'s `createCommonsSubmitter` with the registry's
// `markBlockSubmitted` queue helper (slice 1) and the CLI-level air-gap /
// :memory: gates. Returns a `commonsSubmit` callback suitable for
// `RegistryOptions.commonsSubmit`, plus a `bind(registry)` setter to wire the
// registry handle for the success-callback after openRegistry resolves.

import type { BlockMerkleRoot } from "@yakcc/contracts";
import { createCommonsSubmitter } from "@yakcc/federation";
import type { BlockTripletRow, Registry, RegistryOptions } from "@yakcc/registry";

/** Default commons URL when YAKCC_COMMONS_URL is not set. */
export const DEFAULT_COMMONS_URL = "https://registry.yakcc.com";

/**
 * Caller-supplied policy for whether commons-push should fire.
 *
 * The CLI layer owns these gates because the registry stays mechanism-only
 * (no policy in @yakcc/registry per slice 3 design).
 */
export interface CommonsBindingPolicy {
  /**
   * Filesystem path passed to openRegistry. When ":memory:", commons-push is
   * disabled — test fixtures never reach the network. Preserves
   * DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001.
   */
  readonly registryPath: string;
  /**
   * True when the user's config or env declares this install as air-gapped.
   * Disables commons-push entirely. Mirrors `mode === "airgapped"` in
   * `.yakccrc.json` (DEC-WPE-DEFAULT-PEER-001) and the YAKCC_AIRGAP=1 env.
   */
  readonly airgapped?: boolean;
  /**
   * Optional override for the commons URL. When omitted, reads from
   * `YAKCC_COMMONS_URL` env, falling back to `DEFAULT_COMMONS_URL`.
   */
  readonly commonsUrl?: string;
  /**
   * Optional fetch implementation for tests. Defaults to global `fetch`.
   */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Result of `makeCommonsBinding`. Pass `commonsSubmit` into
 * `openRegistry(..., { commonsSubmit })`, then call `bind(registry)` with the
 * resolved handle so the success callback can record `markBlockSubmitted`.
 */
export interface CommonsBinding {
  /** Pass to `RegistryOptions.commonsSubmit` (or omit if undefined). */
  readonly commonsSubmit: RegistryOptions["commonsSubmit"];
  /** Wire the registry handle after openRegistry resolves. */
  readonly bind: (registry: Registry) => void;
}

/**
 * Compose a commons-push binding for a CLI command's registry call.
 *
 * Returns `{ commonsSubmit: undefined, bind: () => {} }` (no-op) when:
 *   - registryPath is ":memory:" (synthetic fixture, never reaches network)
 *   - airgapped is true (DEC-COMMONS-ALWAYS-ON-001's only opt-out)
 *   - YAKCC_AIRGAP=1 env is set (per-shell air-gap override)
 *
 * Otherwise returns a working binding that POSTs each novel atom to
 * `<commonsUrl>/v1/blocks/submit` and, on 2xx, records `submitted_at` so the
 * local unsubmitted-queue (slice 1) drains.
 *
 * Errors from the POST are intentionally swallowed — the local row stays
 * queued (`submitted_at IS NULL`) and a future invocation can retry via
 * `listUnsubmittedBlocks` (slice 4b will add the flush command).
 */
export function makeCommonsBinding(policy: CommonsBindingPolicy): CommonsBinding {
  const isMemory = policy.registryPath === ":memory:";
  const envAirgap = process.env.YAKCC_AIRGAP === "1";
  const gated = isMemory || policy.airgapped === true || envAirgap;
  if (gated) {
    return { commonsSubmit: undefined, bind: () => {} };
  }

  const url = policy.commonsUrl ?? process.env.YAKCC_COMMONS_URL ?? DEFAULT_COMMONS_URL;

  let bound: Registry | null = null;
  const submitter = createCommonsSubmitter({
    url,
    ...(policy.fetchImpl !== undefined ? { fetchImpl: policy.fetchImpl } : {}),
    onSuccess: (rootStr) => {
      // Best-effort mark-submitted. If markBlockSubmitted throws (e.g. the
      // registry was already closed by command cleanup), we swallow — the
      // POST already landed on the server and is idempotent anyway.
      bound?.markBlockSubmitted(rootStr as BlockMerkleRoot, Date.now()).catch(() => {});
    },
  });

  return {
    commonsSubmit: (row: BlockTripletRow) => submitter(row),
    bind: (r: Registry) => {
      bound = r;
    },
  };
}
