# @yakcc/hooks-cline

Cline hook integration for Yakcc. Same contract as `@yakcc/hooks-cursor`, adapted for Cline's command registration surface.

## What this package provides

- **`ClineHook`** — the hook interface:
  - `registerCommand()` — writes `~/.config/cline/yakcc-cline-command.json` as a marker file for the Cline extension API.
  - `onCodeEmissionIntent(ctx, toolName, originalCode?)` — delegates to `executeRegistryQueryWithSubstitution()` from `@yakcc/hooks-base`. Returns `registry-hit`, `synthesis-required`, or `passthrough` (errors only).
- **`createHook(registry, options?)`** — factory returning a `ClineHook`.
- **`DEFAULT_REGISTRY_HIT_THRESHOLD`** — `0.30` (re-exported from `@yakcc/hooks-base`).
- **`CLINE_COMMAND_MARKER_FILENAME`** — `"yakcc-cline-command.json"`.
- Re-exports from `@yakcc/hooks-base`: `EmissionContext`, `HookOptions`, `HookResponse`.

## How callers consume this package

```ts
import { createHook } from "@yakcc/hooks-cline";
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
