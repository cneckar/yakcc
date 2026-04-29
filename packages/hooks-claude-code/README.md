# @yakcc/hooks-claude-code

Claude Code hook integration for Yakcc.

## What this package provides

- **`EmissionContext`** — the structured input describing a code-emission
  intent intercepted from a Claude Code hook call. Carries the hook name,
  the tool input as a raw JSON value, and the session identifier.
- **`HookResponse`** — the discriminated union of outcomes a hook handler
  may return:
  - `{ kind: "passthrough" }` — let Claude Code proceed normally with no
    intervention.
  - `{ kind: "substitute", content: string }` — replace the emission with
    the provided content (a pre-assembled block or program from the registry).
  - `{ kind: "block", reason: string }` — prevent the emission and report
    the reason back to the caller.
- **`handleEmission(ctx)`** — the primary hook entry point. Receives an
  `EmissionContext` and returns a `Promise<HookResponse>`. v0 always returns
  `{ kind: "passthrough" }` (see below).

## v0 behavior

v0 ships the command surface and the `EmissionContext`/`HookResponse` contract
so that consumers can wire the hook and test the integration path. The default
response is `passthrough`: all emission intents are forwarded to Claude Code
unchanged. Registry-hit detection (substitute) and synthesis-required blocking
(block) ship in v0.5 once the live registry is available.

## How callers consume this package

```ts
import { handleEmission } from "@yakcc/hooks-claude-code";
import type { EmissionContext, HookResponse } from "@yakcc/hooks-claude-code";

// In a Claude Code hook handler:
const ctx: EmissionContext = {
  hookName: "PreToolUse",
  toolInput: rawInput,
  sessionId: sessionId,
};
const response: HookResponse = await handleEmission(ctx);
if (response.kind === "substitute") {
  return { content: [{ type: "text", text: response.content }] };
}
```

## What this package does not do (yet)

- **No registry lookup** — v0.5 connects `handleEmission` to the live
  registry to detect existing blocks.
- **No synthesis blocking** — v0.5 adds the `block` response path for
  cases where a registry hit should suppress Claude Code's own generation.

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
