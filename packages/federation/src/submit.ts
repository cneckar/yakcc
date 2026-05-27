// SPDX-License-Identifier: MIT
//
// submit.ts — client-side commons-push submitter (WI-794 slice 3 /
// DEC-COMMONS-SUBMIT-AT-STOREBLOCK-001).
//
// Returns a fire-and-forget function suitable for `RegistryOptions.commonsSubmit`.
// The function never blocks the caller, never throws (unhandled rejections are
// routed through the optional onError hook), and serializes the BlockTripletRow
// via the existing WireBlockTriplet schema (no parallel wire format).

import type { BlockTripletRow } from "@yakcc/registry";
import { serializeWireBlockTriplet } from "./wire.js";

/**
 * Options for createCommonsSubmitter.
 */
export interface CommonsSubmitterOptions {
  /**
   * Base URL of the commons. The path "/v1/blocks/submit" is appended.
   * Example: "https://registry.yakcc.com"
   */
  readonly url: string;

  /**
   * Injectable fetch implementation. Defaults to the global `fetch`. Tests
   * pass a fake to capture call args and avoid real network I/O.
   */
  readonly fetchImpl?: typeof fetch;

  /**
   * Called when a submission fails (network error, non-2xx response, or the
   * post itself throws). The hook is best-effort observability; it must not
   * throw. When omitted, errors are silently swallowed — the local row stays
   * in the unsubmitted queue and a later flush can retry.
   */
  readonly onError?: (err: Error, blockMerkleRoot: string) => void;

  /**
   * Called after a successful 2xx response. Wired by CLI/registry layer to
   * mark the row as submitted (writes `submitted_at`). When omitted, the row
   * stays in the unsubmitted queue (no harm: re-submission is a server-side
   * no-op via BlockMerkleRoot dedupe).
   */
  readonly onSuccess?: (blockMerkleRoot: string) => void;
}

/**
 * Construct a fire-and-forget commons submitter.
 *
 * The returned function:
 *   - serializes the row to a WireBlockTriplet
 *   - POSTs it to `<url>/v1/blocks/submit`
 *   - calls onSuccess on 2xx, onError otherwise
 *   - never blocks (returns immediately; POST runs on the microtask queue)
 *   - never throws (catches sync exceptions and routes them to onError)
 *
 * Designed for `RegistryOptions.commonsSubmit` injection at openRegistry time.
 */
export function createCommonsSubmitter(
  options: CommonsSubmitterOptions,
): (row: BlockTripletRow) => void {
  const baseUrl = options.url.replace(/\/+$/, "");
  const endpoint = `${baseUrl}/v1/blocks/submit`;
  const fetchImpl = options.fetchImpl ?? fetch;

  return (row: BlockTripletRow): void => {
    // Synchronous wire-format serialization happens up-front so a malformed
    // row is reported immediately rather than via an unhandled rejection.
    let body: string;
    try {
      body = JSON.stringify(serializeWireBlockTriplet(row));
    } catch (err) {
      options.onError?.(
        err instanceof Error ? err : new Error(String(err)),
        row.blockMerkleRoot,
      );
      return;
    }

    // Fire-and-forget POST. Caller is not awaiting; we route resolution and
    // rejection to the optional callbacks rather than leaking unhandled
    // promise rejections.
    fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })
      .then((res) => {
        if (res.ok) {
          options.onSuccess?.(row.blockMerkleRoot);
        } else {
          options.onError?.(
            new Error(`commons-submit: HTTP ${res.status} ${res.statusText}`),
            row.blockMerkleRoot,
          );
        }
      })
      .catch((err) => {
        options.onError?.(
          err instanceof Error ? err : new Error(String(err)),
          row.blockMerkleRoot,
        );
      });
  };
}
