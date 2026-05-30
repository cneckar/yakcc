# wi-944 — `@yakcc/mcp-registry`: stdio MCP server for the public registry

**Branch:** `feature/944-mcp-registry`
**Worktree:** `/Users/cris/src/yakcc/.worktrees/feature-944-mcp-registry`
**Base:** `main @ 9c1cec7`
**Anchor:** `37e31f8` (`packages/mcp-registry/README.md` placeholder)
**Closes:** [#944](https://github.com/cneckar/yakcc/issues/944)
**Workflow:** `wi-944-mcp-registry` · Goal: `g-944-mcp` · Work item: `wi-944-impl`

---

## 1. Problem (verbatim intent)

Agent runtimes (Claude Code, Cursor, Codex, Cline, Aider, Windsurf, Continue) need a stable, low-friction surface to **search the public yakcc registry**, **pull atoms / specs / provenance**, and **submit candidate atoms or request shaves** without each runtime hand-writing an HTTP client. The Model Context Protocol (MCP) is the convergent industry surface for "tool catalog the agent can discover and call."

This slice ships **one** stdio MCP server — `@yakcc/mcp-registry` — that proxies the eight registry/federation HTTP endpoints already exposed by the server-side W-135 deployment at `https://registry.yakcc.com`. v1 is anonymous-by-construction; abuse posture is inherited from the server's W-135 ratelimits + content addressing.

## 2. Locked decisions (operator, do not re-deliberate)

| # | Decision | Rationale |
|---|----------|-----------|
| L1 | Single package `@yakcc/mcp-registry` (not `mcp-*` family) | One transport, one surface, one published artifact. Mirrors `hooks-claude-code` convention. |
| L2 | Transport = stdio | Universally supported by every MCP-aware agent runtime. SSE/HTTP transports are deferred. |
| L3 | No per-tool auth in v1 | Inherits server-side W-135 anonymous posture (DEC-COMMONS-NO-AUTH-001 yakforge-side). |
| L4 | Tool outputs returned as-is, no truncation | Agents own context budgeting. Truncation in the proxy creates two authorities for "what the registry said." |
| L5 | Exactly 8 tools | `yakcc_search_atoms`, `yakcc_get_atom`, `yakcc_list_specs`, `yakcc_get_spec`, `yakcc_submit_atom`, `yakcc_request_shave`, `yakcc_get_shave_status`, `yakcc_get_provenance`. Matches the server's W-135 endpoint surface 1:1. |

## 3. Architectural decisions (DECs in this slice)

| DEC | Decision | Rationale |
|-----|----------|-----------|
| **DEC-MCP-SDK-001** | Use the official `@modelcontextprotocol/sdk` TS SDK for stdio server + tool registration. | One authoritative MCP wire implementation; we do not hand-roll JSON-RPC framing. |
| **DEC-MCP-WIRE-REUSE-002** | `submit_atom` payloads use the **bare `WireBlockTriplet`** shape (W-141) — same shape `@yakcc/federation` already serializes. | One canonical wire-format authority. The MCP tool does not re-derive merkle roots; the server computes and validates. We may import the shape *type* from `@yakcc/federation` but do **not** redefine it. |
| **DEC-MCP-COORD-LOCAL-003** | `ShaveRequestCoord` discriminated-union type is **hand-redeclared locally** in `src/schema.ts`, not imported across the yakcc/yakforge boundary. | yakcc#834/#859 cross-substrate publishing blockers make a clean import impossible. The local copy is annotated with the yakforge W-130 source-of-truth pointer and an invariant test that the JSON shape round-trips. Future: collapse when substrate publishing lands. |
| **DEC-MCP-ERROR-AS-CONTENT-004** | Non-200 HTTP responses are **not thrown** — they are returned as MCP `content` of type `text` with a structured error block (`{ error: { kind, status, message, server_payload } }`). | Agents act on tool output; throwing converts a recoverable signal into an opaque MCP error. The agent needs to see "503 worker not implemented" or "400 invalid spec" so it can adapt. |
| **DEC-MCP-STDERR-LOGGING-005** | All diagnostic logging goes to **stderr**; `stdout` is reserved for the MCP wire protocol. | Common stdio-MCP footgun: a stray `console.log` corrupts the wire. Enforced by a grep-based test in CI. |
| **DEC-MCP-FETCH-ONE-CLIENT-006** | One `http-client.ts` module is the **only** code that calls `fetch`. All 8 tool modules go through it. | Single authority for: base URL resolution (`YAKCC_REGISTRY_URL` env override, default `https://registry.yakcc.com`), timeout, error mapping, retry policy. Per Sacred Practice #12. |
| **DEC-MCP-BIN-ENTRY-007** | `package.json` declares `"bin": { "yakcc-mcp-registry": "./dist/index.js" }`. Published as a regular npm package (`private: false`). | Enables `{ "command": "npx", "args": ["@yakcc/mcp-registry"] }` in `.mcp.json` without a separate install step. |
| **DEC-MCP-NODE22-ESM-008** | Node 22 ESM, `type: module`, `main: ./dist/index.js`. Same pattern as `hooks-claude-code`. | Workspace consistency. No CJS interop dragons in a brand-new package. |

## 4. State-Authority Map

| Domain | Canonical authority | This slice's role |
|--------|---------------------|-------------------|
| MCP wire framing (stdio JSON-RPC) | `@modelcontextprotocol/sdk` | Consumer. We do not implement framing. |
| HTTP request shape to registry | `packages/mcp-registry/src/http-client.ts` (new) | **New authority** for this package only — but every call shape mirrors the W-135 endpoint contract, which remains authoritative server-side. |
| `WireBlockTriplet` JSON shape | `@yakcc/federation/src/types.ts` + `@yakcc/contracts` merkle computation | Consumer (type import); server validates round-trip. |
| `ShaveRequestCoord` discriminated union | yakforge W-130 (`hosted-registry`) | Hand-redeclared locally per DEC-MCP-COORD-LOCAL-003 with invariant round-trip test. |
| Tool catalog (the 8 tools) | yakcc#944 issue body + this plan | This slice. Adding a 9th tool requires plan amendment. |
| Auth / identity | None (DEC-COMMONS-NO-AUTH-001 yakforge-side) | No-op. |

## 5. Package layout

```
packages/mcp-registry/
  package.json              private:false; "bin": { "yakcc-mcp-registry": "./dist/index.js" }
  README.md                 replaces anchor; usage + .mcp.json snippet + env vars + tool catalog
  tsconfig.json             extends ../../tsconfig.base.json; composite; references federation, contracts
  tsconfig.typecheck.json   matches sibling pattern
  vitest.config.ts          matches sibling pattern
  src/
    index.ts                stdio server bootstrap; registers all 8 tools; logs to stderr
    http-client.ts          single fetch wrapper: baseUrl, timeout, error-shape mapping
    http-client.test.ts     baseUrl override, timeout, JSON parse, non-200 mapping
    schema.ts               zod (or hand-rolled type-guard) tool-input shapes + ShaveRequestCoord local copy
    schema.test.ts          input validation per tool; ShaveRequestCoord round-trip invariant
    tools/
      search-atoms.ts        + .test.ts
      get-atom.ts            + .test.ts
      list-specs.ts          + .test.ts
      get-spec.ts            + .test.ts
      submit-atom.ts         + .test.ts
      request-shave.ts       + .test.ts
      get-shave-status.ts    + .test.ts
      get-provenance.ts      + .test.ts
    __tests__/
      integration.test.ts    spawns the built stdio server as a child process; sends MCP tools/list + tools/call; asserts against a fake HTTP server bound to 127.0.0.1
  dist/                     gitignored build output
```

**Convention parity:** mirrors `packages/hooks-claude-code/` (build/test/typecheck scripts, ESM, `type: module`, vitest). Workspace globbing (`packages/*` in `pnpm-workspace.yaml`) picks up the new package with no edits to the root workspace file.

## 6. HTTP ↔ MCP mapping (one row per tool)

| MCP tool | HTTP method | HTTP path | Notes |
|----------|-------------|-----------|-------|
| `yakcc_search_atoms`     | GET  | `/v1/atoms?q=...&limit=...` | Returns paginated atom-summary list. |
| `yakcc_get_atom`         | GET  | `/v1/atoms/{block_merkle_root}` | Returns full `WireBlockTriplet`. |
| `yakcc_list_specs`       | GET  | `/v1/specs?limit=...&cursor=...` | Catalog page (matches `CatalogPage` shape). |
| `yakcc_get_spec`         | GET  | `/v1/specs/{spec_hash}` | Returns spec body + `block_merkle_root[]` that satisfy it. |
| `yakcc_submit_atom`      | POST | `/v1/atoms` | Body = bare `WireBlockTriplet` (W-141). Returns server-assigned `block_merkle_root`. |
| `yakcc_request_shave`    | POST | `/v1/shaves` | Body = `ShaveRequestCoord`. May return 503 ("worker not implemented") — surface as content per DEC-MCP-ERROR-AS-CONTENT-004. |
| `yakcc_get_shave_status` | GET  | `/v1/shaves/{shave_id}` | Polls status; passthrough. |
| `yakcc_get_provenance`   | GET  | `/v1/atoms/{block_merkle_root}/provenance` | Returns proof manifest. |

## 7. Evaluation Contract

**Required tests (all in `packages/mcp-registry/src/`):**
- `http-client.test.ts`: (a) `YAKCC_REGISTRY_URL` env override resolves correctly; (b) default base URL is `https://registry.yakcc.com`; (c) timeout aborts in <2s on unresponsive socket; (d) non-200 maps to structured `{ kind, status, message, server_payload }`; (e) JSON parse failure on 200 surfaces as structured error, not throw.
- `schema.test.ts`: (a) each of the 8 tool input shapes accepts a known-valid example and rejects a known-invalid example; (b) `ShaveRequestCoord` JSON round-trips through serialize/parse with byte stability (invariant guarding DEC-MCP-COORD-LOCAL-003).
- One unit test per tool module (8 files): mock `fetch`, assert (a) the HTTP request URL, method, and body match the mapping table above; (b) a 200 response is converted to MCP `content` of type `text` with the registry response embedded as JSON; (c) a 400/503 response is converted to MCP content with the structured error block per DEC-MCP-ERROR-AS-CONTENT-004 — **not** thrown.
- `__tests__/integration.test.ts`: starts a fake HTTP server on `127.0.0.1:<random>`, sets `YAKCC_REGISTRY_URL` to it, spawns `node dist/index.js` as a child, performs a real MCP `tools/list` handshake (asserts all 8 tools present with correct input schemas), then performs `tools/call` for each tool and asserts the round-trip. This must spawn a real child process — not import the module in-process — so the stdio framing is exercised.

**Required evidence (must appear in implementer handoff):**
- `pnpm install` exits 0 (lockfile updates with new deps committed).
- `pnpm --filter @yakcc/mcp-registry build` exits 0.
- `pnpm --filter @yakcc/mcp-registry test` passes; raw vitest summary pasted.
- `pnpm --filter @yakcc/mcp-registry typecheck` exits 0.
- `grep -rn "console\.log\|process\.stdout\.write" packages/mcp-registry/src/` shows **only** MCP-wire writes (the SDK's stdio transport). Diagnostics use `console.error` / stderr.
- The integration test output shows actual MCP JSON-RPC frames exchanged with the child process, not a stub.

**Required authority invariants:**
- No second HTTP client module (all `fetch` calls flow through `http-client.ts`).
- No reimplementation of `serializeWireBlockTriplet` / `deserializeWireBlockTriplet` (we only consume the *type* of `WireBlockTriplet`).
- No silent swallowing of fetch errors (every error path returns structured content).
- No edits outside `packages/mcp-registry/**` other than the pnpm lockfile and this plan doc.

**Forbidden shortcuts:**
- No inline tool definitions in `index.ts` — each tool lives in its own module so reviewers can audit one at a time.
- No "skip the integration test if no MCP SDK available" — the SDK is a hard dependency.
- No truncation of registry responses (L4).
- No per-tool auth gates (L3).

**Ready-for-guardian definition:** all required tests pass on `feature/944-mcp-registry` HEAD; the stdout discipline grep is clean; the reviewer has confirmed each of the 8 tools is wired to the correct HTTP endpoint per §6; `pnpm-lock.yaml` is committed.

**Rollback boundary:** the slice is purely additive. Reverting the merge commit removes `packages/mcp-registry/` entirely; no sibling package observes any change. The new pnpm-lock entries are removed by the same revert. No data migration. No state-authority surface is mutated outside this package.

## 8. Scope Manifest (summary; full JSON at `tmp/wi-944-scope.json`)

- **Allowed (additive only):** everything under `packages/mcp-registry/**`; `pnpm-lock.yaml`; `pnpm-workspace.yaml` (only if globbing fails to pick up); this plan doc; `docs/archive/developer/MASTER_PLAN.md` (one new Initiative row); `tmp/**`.
- **Forbidden:** all other `packages/*` directories; `.github/**`; `release.yml`; `vendor/**`; `bootstrap/**`; `scripts/**`; `tsconfig.base.json`.
- **State authorities touched:** yakcc workspace package set (additive); `pnpm-lock.yaml` (two new deps: `@modelcontextprotocol/sdk`, `zod` — or hand-rolled type guards if a zod-free path is simpler, recorded at implementation time).

## 9. Waves

| W-ID | Item | Weight | Deps | Gate |
|------|------|--------|------|------|
| W-944-1 | Package skeleton: `package.json`, `tsconfig*`, `vitest.config.ts`, install `@modelcontextprotocol/sdk` (+ optional `zod`), empty `src/index.ts` that builds. | S | — | none |
| W-944-2 | `http-client.ts` + tests; resolves base URL, maps errors per DEC-MCP-ERROR-AS-CONTENT-004. | S | W-944-1 | none |
| W-944-3 | `schema.ts` + tests; 8 input shapes + local `ShaveRequestCoord` with round-trip invariant. | S | W-944-1 | none |
| W-944-4 | 8 tool modules + unit tests, one per `src/tools/*.ts`. | M | W-944-2, W-944-3 | none |
| W-944-5 | `index.ts` stdio bootstrap; registers the 8 tools; stderr-only logging. | S | W-944-4 | none |
| W-944-6 | `__tests__/integration.test.ts`: spawn child, MCP handshake, per-tool round-trip vs fake HTTP server. | M | W-944-5 | review |
| W-944-7 | README replaces anchor; documents `.mcp.json` snippet, env vars, tool catalog. | S | W-944-5 | none |

Critical path: W-944-1 → 2 → 4 → 5 → 6. Width 2 after W-944-2 lands (schema + tools sub-modules can develop in parallel). All seven items ship in **one** implementer pass — the wave breakdown is for reviewer auditing order, not for separate landings.

## 10. Cross-repo landing note

The orchestrator session is yakforge-rooted while this work lives in yakcc. Per the `cross-repo-session-rooting` precedent (yakcc#768), the canonical chain (planner → guardian:provision → implementer → reviewer) runs cleanly here, but `guardian:land` cannot fast-forward locally because the bash hook reads yakforge's state DB. **Expected landing path: PR-merge against `cneckar/yakcc:main`**, not local FF. The implementer should not gate on local-landing affordances.

## 11. Decision Log (this slice)

| DEC | Status | Captured at |
|-----|--------|-------------|
| DEC-MCP-SDK-001 | decided | §3 |
| DEC-MCP-WIRE-REUSE-002 | decided | §3 |
| DEC-MCP-COORD-LOCAL-003 | decided (transitional; collapse when yakcc#834/#859 land) | §3 |
| DEC-MCP-ERROR-AS-CONTENT-004 | decided | §3 |
| DEC-MCP-STDERR-LOGGING-005 | decided | §3 |
| DEC-MCP-FETCH-ONE-CLIENT-006 | decided | §3 |
| DEC-MCP-BIN-ENTRY-007 | decided | §3 |
| DEC-MCP-NODE22-ESM-008 | decided | §3 |
