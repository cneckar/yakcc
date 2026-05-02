// Fixture: cross-pkg/src/cross-pkg.ts
// Purpose: imports a type from @yakcc/contracts (workspace cross-package import) to verify
// that project mode resolves it via pnpm node_modules symlinks and tsconfig references,
// emitting zero no-untyped-imports violations. This is the load-bearing case for v2
// self-hosting: every yakcc package imports @yakcc/contracts.
// Isolated mode against this file alone DOES emit a false positive because the
// in-memory project has no knowledge of the workspace package.

import type { ContractId } from "@yakcc/contracts";

export const id: ContractId =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ContractId;
