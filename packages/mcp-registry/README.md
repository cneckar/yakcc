# @yakcc/mcp-registry

stdio MCP server that exposes the [yakcc public registry](https://registry.yakcc.com) as 8 typed tools for agent runtimes (Claude Code, Cursor, Codex, Cline, Aider, Windsurf, Continue). Agents can search atoms, pull full block triplets and spec bodies, submit new atoms, request shaves, and poll shave status — all without hand-writing an HTTP client. The server is anonymous-by-construction; authentication is out of scope for v1 (DEC-COMMONS-NO-AUTH-001).

Implements: [yakcc#944](https://github.com/cneckar/yakcc/issues/944) · Tracks: [yakforge#49](https://github.com/cneckar/yakforge/issues/49)

---

## Installation & usage

Add to your `.mcp.json` (Claude Code, Cursor, or any MCP-compatible runtime):

```json
{
  "mcpServers": {
    "yakcc-registry": {
      "command": "npx",
      "args": ["@yakcc/mcp-registry"]
    }
  }
}
```

Or install globally and reference the binary:

```json
{
  "mcpServers": {
    "yakcc-registry": {
      "command": "yakcc-mcp-registry"
    }
  }
}
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `YAKCC_REGISTRY_URL` | `https://registry.yakcc.com` | Base URL of the registry. Override to point at a self-hosted instance. |

---

## Tools

All 8 tools proxy the W-135 HTTP endpoints on `registry.yakcc.com`. Tool outputs are returned as-is with no truncation (L4 — agents own context budgeting).

| Tool name | HTTP | Description |
|-----------|------|-------------|
| `yakcc_search_atoms` | `GET /v1/atoms?q=…&limit=…` | Full-text search over published atoms. Returns a paginated list of atom summaries. |
| `yakcc_get_atom` | `GET /v1/atoms/{block_merkle_root}` | Fetch a full `WireBlockTriplet` by its content-addressed root. |
| `yakcc_list_specs` | `GET /v1/specs?limit=…&cursor=…` | Page through the spec catalog. |
| `yakcc_get_spec` | `GET /v1/specs/{spec_hash}` | Fetch a spec body and the list of `block_merkle_root[]` values that satisfy it. |
| `yakcc_submit_atom` | `POST /v1/atoms` | Submit a new atom. Body is a bare `WireBlockTriplet` (W-141 wire shape). Returns the server-assigned `block_merkle_root`. |
| `yakcc_request_shave` | `POST /v1/shaves` | Request a shave. May return `503 worker_not_implemented` — surfaced as structured content, not an error. |
| `yakcc_get_shave_status` | `GET /v1/shaves/{shave_id}` | Poll the status of a pending or completed shave. |
| `yakcc_get_provenance` | `GET /v1/atoms/{block_merkle_root}/provenance` | Fetch the proof manifest for an atom. |

Non-200 responses are returned as structured MCP content (`{ error: { kind, status, message, server_payload } }`) rather than thrown exceptions, so agents can adapt to server-side signals (DEC-MCP-ERROR-AS-CONTENT-004).

---

## Transport

stdio (JSON-RPC 2.0 framing via `@modelcontextprotocol/sdk`). SSE and HTTP transports are deferred.

All diagnostic logging goes to **stderr**; stdout is reserved for the MCP wire protocol (DEC-MCP-STDERR-LOGGING-005).
