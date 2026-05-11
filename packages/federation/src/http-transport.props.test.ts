// SPDX-License-Identifier: MIT
// Vitest harness for http-transport.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling http-transport.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_fetchBlock_200_returns_body_as_wire,
  prop_fetchBlock_non2xx_with_error_envelope_throws_TransportError,
  prop_fetchBlock_non2xx_without_envelope_throws_internal_error,
  prop_fetchSpec_200_returns_blockMerkleRoots,
  prop_fetchSpec_404_returns_empty_array,
  prop_getSchemaVersion_200_returns_schemaVersion,
  prop_injected_fetch_is_called_not_globalThis,
  prop_listSpecs_200_returns_specHashes,
} from "./http-transport.props.js";

// Async properties; numRuns: 50 balances coverage with async overhead.
const opts = { numRuns: 50 };

it("property: prop_fetchBlock_200_returns_body_as_wire", async () => {
  await fc.assert(prop_fetchBlock_200_returns_body_as_wire, opts);
});

it("property: prop_fetchBlock_non2xx_with_error_envelope_throws_TransportError", async () => {
  await fc.assert(
    prop_fetchBlock_non2xx_with_error_envelope_throws_TransportError,
    opts,
  );
});

it("property: prop_fetchBlock_non2xx_without_envelope_throws_internal_error", async () => {
  await fc.assert(
    prop_fetchBlock_non2xx_without_envelope_throws_internal_error,
    opts,
  );
});

it("property: prop_fetchSpec_404_returns_empty_array", async () => {
  await fc.assert(prop_fetchSpec_404_returns_empty_array, opts);
});

it("property: prop_fetchSpec_200_returns_blockMerkleRoots", async () => {
  await fc.assert(prop_fetchSpec_200_returns_blockMerkleRoots, opts);
});

it("property: prop_getSchemaVersion_200_returns_schemaVersion", async () => {
  await fc.assert(prop_getSchemaVersion_200_returns_schemaVersion, opts);
});

it("property: prop_listSpecs_200_returns_specHashes", async () => {
  await fc.assert(prop_listSpecs_200_returns_specHashes, opts);
});

it("property: prop_injected_fetch_is_called_not_globalThis", async () => {
  await fc.assert(prop_injected_fetch_is_called_not_globalThis, opts);
});
