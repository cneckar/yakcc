// Fixture: comparison/src/uses-workspace-pkg.ts
// Purpose: imports a type from @yakcc/contracts (workspace package) to exercise the
// false-positive comparison case. Project mode resolves via pnpm node_modules symlink;
// isolated mode emits no-untyped-imports because the in-memory project has no
// knowledge of the workspace package. This is the critical yakcc self-hosting case.

import type { ContractId } from "@yakcc/contracts";

export type ExportedId = ContractId;
