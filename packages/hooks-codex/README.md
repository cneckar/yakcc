# @yakcc/hooks-codex

Codex CLI hook integration for Yakcc. Same contract as `@yakcc/hooks-claude-code`, adapted for OpenAI's Codex CLI extension surface.

## What this package provides

- **`CodexHook`** — the hook interface:
  - `registerCommand()` — writes `~/.yakcc/yakcc-codex-command.json` as a marker file for the Codex CLI extension API (distinct directory from hooks-claude-code's `~/.claude/` per DEC-HOOK-CODEX-001).
  - `onCodeEmissionIntent(ctx)` — delegates to `executeRegistryQuery()` from `@yakcc/hooks-base`. Returns `registry-hit`, `synthesis-required`, or `passthrough` (errors only). Identical semantics to `@yakcc/hooks-claude-code`.
- **`createHook(registry, options?)`** — factory returning a `CodexHook`.
- **`DEFAULT_REGISTRY_HIT_THRESHOLD`** — `0.30` (re-exported from `@yakcc/hooks-base`).
- **`COMMAND_MARKER_FILENAME`** — `"yakcc-codex-command.json"`.
- Re-exports from `@yakcc/hooks-base`: `EmissionContext`, `HookResponse`, `HookOptions`.

## How callers consume this package

```ts
import { createHook } from "@yakcc/hooks-codex";
import { openRegistry } from "@yakcc/registry";

const registry = await openRegistry(".yakcc/registry.db");
const hook = createHook(registry);
hook.registerCommand();

const response = await hook.onCodeEmissionIntent(ctx);
// response.kind: "registry-hit" | "synthesis-required" | "passthrough"
```

## Related packages

- `@yakcc/hooks-base` — shared logic (`executeRegistryQuery`, `EmissionContext`, `HookResponse`)
- `@yakcc/hooks-claude-code` — Claude Code variant
- `@yakcc/hooks-cursor` — Cursor variant

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
