// SPDX-License-Identifier: Apache-2.0
// The interim acceptance's program (#1361, #1333): @yakcc/contracts' canonicalize and contract id
// (BLAKE3 from @noble/hashes), as a native program built from their sources.
import { canonicalizeText } from "../../../../contracts/src/canonicalize.js";
import { contractId } from "../../../../contracts/src/contract-id.js";
import type { ContractSpec } from "../../../../contracts/src/index.js";

export function idOf(spec: ContractSpec): string {
  return contractId(spec);
}

export function textOf(spec: ContractSpec): string {
  return canonicalizeText(spec);
}
