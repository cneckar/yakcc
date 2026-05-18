# @yakcc/hooks-windsurf

Windsurf hook integration for Yakcc. Same contract as `@yakcc/hooks-cursor`, adapted for Windsurf's command registration surface.

## What this package provides

- **`WindsurfHook`** — the hook interface:
  - `registerCommand()` — writes `~/.windsurf/yakcc-windsurf-hook.json` as a marker file for the Windsurf extension API.
  - `onCodeEmissionIntent(ctx, toolName, originalCode?)` — delegates to `executeRegistryQueryWithSubstitution()` from `@yakcc/hooks-base`. Returns `registry-hit`, `synthesis-required`, or `passthrough` (errors only). Identical semantics to `@yakcc/hooks-cursor`.
- **`createHook(registry, options?)`** — factory returning a `WindsurfHook`.
- **`DEFAULT_REGISTRY_HIT_THRESHOLD`** — `0.30` (re-exported from `@yakcc/hooks-base`).
- **`WINDSURF_COMMAND_MARKER_FILENAME`** — `"yakcc-windsurf-hook.json"`.
- Re-exports from `@yakcc/hooks-base`: `EmissionContext`, `HookResponse`, `HookOptions`.
- **`createYakccResolveTool(options?)`** — factory for the `yakcc_resolve` MCP tool surface.

## How callers consume this package

```ts
import { createHook } from "@yakcc/hooks-windsurf";
import { openRegistry } from "@yakcc/registry";

const registry = await openRegistry(".yakcc/registry.db");
const hook = createHook(registry);
hook.registerCommand();

const response = await hook.onCodeEmissionIntent(ctx, "Edit");
// response.kind: "registry-hit" | "synthesis-required" | "passthrough"
```

## Related packages

- `@yakcc/hooks-base` — shared logic (`executeRegistryQueryWithSubstitution`, `EmissionContext`, `HookResponse`)
- `@yakcc/hooks-claude-code` — Claude Code variant
- `@yakcc/hooks-cursor` — Cursor variant

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
