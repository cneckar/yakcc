# @yakcc/hooks-base

Shared types and registry-query logic for all Yakcc IDE hooks.

## What this package provides

This package is a leaf shared by `@yakcc/hooks-claude-code`, `@yakcc/hooks-cursor`, and `@yakcc/hooks-codex`. It exists to satisfy Sacred Practice #12 (single source of truth): the hook contract and registry-query logic live in exactly one place.

- **`EmissionContext`** — structured input describing a code-emission intent. Fields: `hookName`, `toolInput` (raw JSON), `sessionId`.
- **`HookResponse`** — discriminated union of hook outcomes:
  - `{ kind: "registry-hit", block: BlockTripletRow }` — existing block satisfies the intent.
  - `{ kind: "synthesis-required", contractSpecSkeleton: ContractSpec }` — no registry hit; skeleton for downstream synthesis.
  - `{ kind: "passthrough" }` — registry error path only; not a default-success path.
- **`HookOptions`** — construction options for all `createHook()` factories. Fields: `threshold?: number` (cosine distance cutoff; default `DEFAULT_REGISTRY_HIT_THRESHOLD`).
- **`DEFAULT_REGISTRY_HIT_THRESHOLD`** — `0.30`. A cosine distance below this value triggers `registry-hit`.
- **`buildIntentCardQuery(ctx)`** — derive an intent query object from an `EmissionContext`. Used internally by `executeRegistryQuery`.
- **`buildSkeletonSpec(intent)`** — build a minimal `ContractSpec` skeleton from a behavior string. Used to populate `synthesis-required` responses.
- **`writeMarkerCommand(markerDir, filename, payload)`** — write a hook marker file to disk. Used by all three `registerXxxCommand()` implementations.
- **`executeRegistryQuery(registry, ctx, options)`** — the load-bearing shared implementation. Runs `findCandidatesByIntent`, applies the threshold, and returns the appropriate `HookResponse`. All three IDE hooks delegate here.

## Usage

This package is consumed by the three IDE hook packages. Direct use is only needed when building a new hook implementation:

```ts
import {
  executeRegistryQuery,
  buildIntentCardQuery,
  DEFAULT_REGISTRY_HIT_THRESHOLD,
} from "@yakcc/hooks-base";
import type { EmissionContext, HookResponse, HookOptions } from "@yakcc/hooks-base";
```

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
