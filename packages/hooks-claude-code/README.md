# @yakcc/hooks-claude-code

Claude Code hook integration for Yakcc.

## What this package provides

- **`ClaudeCodeHook`** — the hook interface:
  - `registerSlashCommand()` — writes `~/.claude/yakcc-slash-command.json` as a marker file for the Claude Code slash-command extension API (the marker-file pattern avoids requiring a live CLI harness at registration time).
  - `onCodeEmissionIntent(ctx)` — the load-bearing path. Queries the registry via `findCandidatesByIntent`, returning one of three outcomes:
    - `{ kind: "registry-hit", block }` — top candidate's cosine distance is below threshold; an existing block satisfies the intent.
    - `{ kind: "synthesis-required", contractSpecSkeleton }` — no candidate beats threshold; returns a `ContractSpec` skeleton derived from the emission context for downstream synthesis.
    - `{ kind: "passthrough" }` — registry error path only (open failure, embedding failure). Not a default-success path.
- **`createHook(registry, options?)`** — factory. Returns a `ClaudeCodeHook` backed by the given `Registry`.
- **`DEFAULT_REGISTRY_HIT_THRESHOLD`** — `0.30` (cosine distance; lower = closer match). Override via `HookOptions.threshold`.
- **`SLASH_COMMAND_MARKER_FILENAME`** — `"yakcc-slash-command.json"`.
- Re-exports from `@yakcc/hooks-base`: `EmissionContext`, `HookResponse`, `HookOptions`.

## How it works

`onCodeEmissionIntent(ctx)` delegates to `executeRegistryQuery()` from `@yakcc/hooks-base` (DEC-HOOK-BASE-001). The shared implementation lives in exactly one place; all three IDE hooks consume it.

Decision logic:
1. Build an intent query from the emission context (behavior text + inferred input/output types).
2. Call `registry.findCandidatesByIntent(query, { k: 5, rerank: "structural" })`.
3. If the top candidate's `cosineDistance < threshold` → `registry-hit`.
4. If no candidate beats threshold → `synthesis-required` with a skeleton `ContractSpec`.
5. If the registry call itself throws → `passthrough`.

## How callers consume this package

```ts
import { createHook } from "@yakcc/hooks-claude-code";
import type { ClaudeCodeHook, EmissionContext, HookResponse } from "@yakcc/hooks-claude-code";
import { openRegistry } from "@yakcc/registry";

const registry = await openRegistry(".yakcc/registry.db");
const hook: ClaudeCodeHook = createHook(registry, { threshold: 0.25 });

// Register the /yakcc slash command in Claude Code
hook.registerSlashCommand();

// In a Claude Code PreToolUse hook handler:
const ctx: EmissionContext = {
  hookName: "PreToolUse",
  toolInput: rawInput,
  sessionId: sessionId,
};
const response: HookResponse = await hook.onCodeEmissionIntent(ctx);
switch (response.kind) {
  case "registry-hit":
    // Use response.block — an existing atom satisfies this intent
    break;
  case "synthesis-required":
    // Use response.contractSpecSkeleton — derive a new contract from it
    break;
  case "passthrough":
    // Registry unavailable — let Claude Code proceed normally
    break;
}
```

## Related packages

- `@yakcc/hooks-base` — shared `EmissionContext`, `HookResponse`, `HookOptions`, `executeRegistryQuery()`
- `@yakcc/hooks-cursor` — same contract, Cursor-adapted surface
- `@yakcc/hooks-codex` — same contract, Codex CLI-adapted surface

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
