// SPDX-License-Identifier: MIT
/**
 * Re-export of the primary-declaration picker from @yakcc/contracts.
 *
 * The implementation has been moved to packages/contracts/src/source-pick.ts
 * as part of DEC-EMBED-QUERY-ENRICH-HELPER-001 OD-2 Option A: both the
 * atomize path (@yakcc/shave) and the query-enrichment path (@yakcc/contracts)
 * share the same picker so the "which function is primary?" logic has one
 * authoritative implementation.
 *
 * This file is kept as a re-export barrel so that:
 *   - existing shave-internal imports (static-extract.test.ts, static-pick.props.ts)
 *     continue to resolve without modification;
 *   - the public shave API surface is unchanged.
 *
 * @decision DEC-INTENT-STATIC-001 (preserved — see @yakcc/contracts/source-pick)
 */
export { pickPrimaryDeclaration, type PrimaryDeclaration } from "@yakcc/contracts";
