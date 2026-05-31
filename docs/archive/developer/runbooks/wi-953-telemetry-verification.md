# WI-953 Telemetry Verification Runbook

**Decision:** DEC-953B-TELEMETRY-MANUAL-001  
**Status:** decided (wi-953-b)  
**Rationale:**  
The yakcc_resolve tool is called by the LLM (via the MCP server) before code-emission
tool calls (Edit/Write/MultiEdit). Correct ordering — `yakcc_resolve` BEFORE `Edit`/`Write` —
can only be verified by replaying a live Claude Code agent session and grepping the
telemetry JSONL for the sequence of MCP tool calls relative to the code-emission events.
No fixture-fed unit test can reproduce this; the check requires a real agent session.

---

## What This Verifies

1. `yakcc_resolve` is called by the LLM **before** the corresponding `Edit` or `Write` call
   for the same intent.
2. The MCP tool call appears in the telemetry JSONL at `~/.yakcc/telemetry/<session-id>.jsonl`.
3. The resolve envelope (`confidence_tier`, `source`, `candidates`, `airgapped`) is present
   and structurally valid.

---

## Prerequisites

- `yakcc` CLI installed and on PATH (`yakcc --version`).
- Claude Code installed and running with the yakcc MCP server active (verify via
  `~/.claude/settings.json` — the `mcpServers` key must include `yakcc-mcp-registry`).
- A project that has been initialized with `yakcc init --ide claude-code` so the
  discovery snippet is present in `.claude/settings.json["yakcc-discovery"]`.
- The yakcc MCP registry server is reachable (`YAKCC_REGISTRY_URL` is set or defaults
  to `https://registry.yakcc.com`).

---

## Procedure

### Step 1: Initialize a throwaway project

```bash
mkdir /tmp/yakcc-telemetry-test && cd /tmp/yakcc-telemetry-test
git init
yakcc init --ide claude-code --no-seed --local
```

Confirm `.claude/settings.json` contains `"yakcc-discovery"`:

```bash
jq '.["yakcc-discovery"]' .claude/settings.json
# Expected: { "_marker": "yakcc-discovery-v1", "promptRef": "...yakcc-discovery.md", ... }
```

### Step 2: Note your current telemetry session ID

The telemetry directory defaults to `~/.yakcc/telemetry/`. Each Claude Code session
creates a file named `<CLAUDE_SESSION_ID>.jsonl` (or a fallback UUID if the env var
is absent).

```bash
ls -lt ~/.yakcc/telemetry/ | head -5
# Note the most recently modified file — that is the current session's JSONL.
```

If no files exist yet, run a quick test task in Step 3 to seed the session file.

### Step 3: Run a real Claude Code agent session

Open Claude Code inside `/tmp/yakcc-telemetry-test` and ask it to implement something
specific enough to have clear intent — for example:

> "Add a function `clamp(value, min, max)` that returns value clamped to [min, max].
> Write it to src/clamp.ts."

The LLM should emit a `yakcc_resolve` MCP tool call (visible in Claude Code's tool-use
panel) BEFORE it emits the `Edit` or `Write` call for `src/clamp.ts`.

### Step 4: Grep the telemetry JSONL for the resolve call

After the session completes, find the session file:

```bash
ls -lt ~/.yakcc/telemetry/ | head -3
SESSION_FILE=~/.yakcc/telemetry/<paste-the-filename-here>.jsonl
```

Grep for `yakcc_resolve` in the JSONL:

```bash
grep '"toolName"' "$SESSION_FILE" | head -20
```

The telemetry events in the file are `TelemetryEvent` records (see
`packages/hooks-base/src/telemetry.ts`). Each line is a JSON object with at minimum:

```jsonc
{
  "t": 1748000000000,         // Unix ms timestamp
  "intentHash": "deadbeef...", // BLAKE3 hex of the intent (not plaintext)
  "toolName": "Edit",         // "Edit" | "Write" | "MultiEdit"
  "candidateCount": 3,
  "topScore": 0.87,
  "substituted": false,
  "substitutedAtomHash": null,
  "latencyMs": 45,
  "outcome": "passthrough"
}
```

**Note:** The telemetry JSONL records events from the PreToolUse hook (fired on
`Edit`/`Write`/`MultiEdit`), not from `yakcc_resolve` directly. To see the
`yakcc_resolve` MCP call relative to Edit/Write events, examine Claude Code's
built-in conversation trace or the `CLAUDE_SESSION_ID`-correlated hook events.

### Step 5: Verify ordering in the Claude Code transcript

Claude Code logs MCP tool calls in its session trace. To confirm `yakcc_resolve` was
called BEFORE `Edit`/`Write`, inspect the transcript in Claude Code's UI: the
`yakcc_resolve` tool call must appear in the tool-use panel BEFORE the file-write
call for the same task.

Alternatively, if `YAKCC_TELEMETRY_DIR` is set to a custom path and the yakcc hooks
are at debug verbosity, each hook invocation logs:

```
[yakcc] PreToolUse: toolName=Edit intent_hash=<hash> candidateCount=N latency=Xms outcome=Y
```

Compare the timestamps `t` in the JSONL: the resolve call (a separate MCP event)
should precede the corresponding `t` in the hook telemetry event for the same intent.

### Step 6: Verify the resolve envelope structure

If MCP tracing is enabled (`MCP_TRACE=1` or Claude Code's debug output), the raw
`yakcc_resolve` response appears in the server stderr or debug log. It should match:

```jsonc
{
  "confidence_tier": "candidate_list",   // or "no_candidates" / "auto_accept"
  "source": "local+global",              // or "local_only" when airgapped
  "candidates": [
    {
      "atom_id": "deadbeef...",
      "score": 0.91,
      "summary": "clamp(value, min, max) ...",
      "source": "local"                   // or "global" for catalog-walk results
    }
  ],
  "airgapped": false
}
```

### Step 7: Cleanup

```bash
rm -rf /tmp/yakcc-telemetry-test
```

---

## Telemetry File Format Reference

- **Path:** `~/.yakcc/telemetry/<CLAUDE_SESSION_ID>.jsonl` (or override via
  `YAKCC_TELEMETRY_DIR` env var).
- **Format:** JSONL (newline-delimited JSON). One `TelemetryEvent` per line.
- **Schema authority:** `packages/hooks-base/src/telemetry.ts` — `TelemetryEvent` type.
- **Intent privacy:** `intentHash` is a BLAKE3 hex digest of the plaintext intent.
  Raw intent text is never written to the JSONL by default (see
  `DEC-TELEMETRY-EXPORT-PRIVACY-006`).

---

## Pass Criteria

| Check | Expected |
|-------|----------|
| `.claude/settings.json["yakcc-discovery"]` present after `yakcc init` | Yes |
| `yakcc_resolve` MCP call appears in Claude Code tool-use panel | Yes, before `Edit`/`Write` |
| `confidence_tier` field in resolve response | One of `auto_accept`, `candidate_list`, `no_candidates` |
| `source` field | `local+global` (online) or `local_only` (airgapped/network-fail) |
| `airgapped` field | Matches `YAKCC_AIRGAPPED` env var |
| Hook telemetry JSONL exists at `~/.yakcc/telemetry/` | Yes, after at least one Edit/Write |

---

## Failure Modes

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `yakcc_resolve` not called before `Edit` | Discovery snippet absent from `.claude/settings.json` | Re-run `yakcc init --ide claude-code` |
| `registry_unavailable` in resolve response | Local SQLite path does not exist or is unreadable | Run `yakcc init` in the project root to create `.yakcc/registry.sqlite` |
| `source: "local_only"` unexpectedly | `YAKCC_AIRGAPPED=1` set, or network error to registry | Check env; verify `YAKCC_REGISTRY_URL` is reachable |
| No JSONL in `~/.yakcc/telemetry/` | Hook not installed or `YAKCC_TELEMETRY_DISABLED=1` | Check `settings.json` `hooks.PreToolUse` entry; unset disabled flag |

---

*Implements: yakcc#953 (WI-953-b). Cross-references: DEC-953B-TELEMETRY-MANUAL-001,
DEC-TELEMETRY-EXPORT-SINK-001 (telemetry-sink.ts), D-HOOK-5 (hook-layer-architecture.md).*
