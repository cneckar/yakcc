# V2_SELF_HOSTING_DEMO.md — yakcc self-hosting bootstrap

> This document is the sole authority for the v2 bootstrap self-hosting demo
> procedure. It specifies the fresh-clone reproduction, the semantics of
> `bootstrap --verify`, the committed manifest, and the CI integration gate.
> Companion authority docs: `WASM_HOST_CONTRACT.md`, `FEDERATION_PROTOCOL.md`.

> **Status — pre-BOOTSTRAP-03 advisory period:**
> This document is committed ahead of WI-V2-BOOTSTRAP-03 (GitHub issue #8),
> which introduces the `--verify` flag to `packages/cli/src/commands/bootstrap.ts`
> and commits the initial `bootstrap/expected-roots.json` manifest. Until
> BOOTSTRAP-03 merges, step 3 of the fresh-clone reproduction below will fail
> with an unknown-flag error. The CI gate (`.github/workflows/bootstrap.yml`)
> is live but advisory — it is not listed as a required check in branch
> protection. It will be promoted to required after BOOTSTRAP-03 lands and a
> green run on `main` is observed. See the "CI integration" section for the
> exact promotion step.

---

## 1. What this is and why it matters

Yakcc shaves itself. Every `.ts` source file under `packages/*/src/` is run
through the universalizer pipeline. Each file produces one or more blocks; each
block's `BlockMerkleRoot` is a deterministic BLAKE3-based content address
derived from its spec, implementation, and proof artifact bytes (see
`packages/contracts/src/merkle.ts`). The full set of `BlockMerkleRoot` values
from a clean shave of `main` is recorded in a sorted JSON manifest at
`bootstrap/expected-roots.json` and committed to the repository.

CI re-derives that manifest from clean source on every push to `main` and every
pull request targeting `main`, then byte-compares it against the committed file.
Any source change that alters block identity without a corresponding manifest
regeneration fails the gate.

This is the project's strongest external proof of self-consistency. The
compiler's own atoms are content-addressed, reproducible from a clean checkout
on any machine, and auditable from a single manifest file. There are two
determinism guarantees that make this possible:

- **DEC-V2-BOOT-FILE-ORDER-001** — source files are sorted lexicographically
  before shaving, so insertion order into the in-memory registry is stable
  across runs and machines.
- **DEC-V2-BOOT-NO-AI-CORPUS-001** — the bootstrap shave runs `offline: true`
  with no AI-derived property-test corpus (source C), so no live model call
  can introduce nondeterminism.

Both decisions are annotated at the top of
`packages/cli/src/commands/bootstrap.ts`.

---

## 2. Fresh-clone reproduction

Prerequisites: Node.js >= 22, pnpm >= 9 (see `README.md` "Prerequisites").

```sh
git clone https://github.com/cneckar/yakcc.git
cd yakcc
pnpm install --frozen-lockfile
pnpm -r build
node packages/cli/dist/bin.js bootstrap --verify
```

Expected outcome on a clean `main` (post-BOOTSTRAP-03): exit 0, no output
beyond a progress summary. Expected wall-clock time: 30-60 minutes. The shave
pass is CPU-bound on approximately 1,700-1,800 source-derived atoms; the exact
count will drift as the project evolves.

If `bootstrap --verify` exits 0, the local shave result is byte-identical to
the committed manifest. The codebase is self-consistent at that commit.

---

## 3. What `bootstrap --verify` does

`bootstrap --verify` is the read-only verification mode of the bootstrap
command. It runs the full shave pipeline against a fresh in-memory registry and
compares the result against the committed manifest. It does not write to disk
beyond the temporary registry.

Step by step:

1. Discovers all `.ts` source files under `packages/*/src/` and
   `examples/*/src/`. Skips files in `__tests__/`, `__fixtures__/`,
   `__snapshots__/`, `dist/`, or `node_modules/` path segments, and skips
   files whose basename matches `*.test.ts`, `*.d.ts`, or `vitest.config.ts`.

2. Sorts the discovered file list lexicographically
   (DEC-V2-BOOT-FILE-ORDER-001). This is locale-independent; the sort key is
   the absolute path string.

3. Opens a fresh `:memory:` SQLite registry (ephemeral; no on-disk side
   effect). Shaves each file into this registry with `offline: true` and no AI
   corpus (DEC-V2-BOOT-NO-AI-CORPUS-001). The intent strategy is "static"
   (TypeScript Compiler API + JSDoc), which produces deterministic
   `IntentCard` values without any API calls.

4. Calls `Registry.exportManifest()`, which returns the full set of stored
   blocks sorted by `blockMerkleRoot` ASCII-ascending. The `createdAt` and
   `ROWID` fields are excluded from the manifest (they are not part of the
   `BlockMerkleRoot` derivation by design).

5. Byte-compares the derived manifest against the committed
   `bootstrap/expected-roots.json`. If the files are byte-identical, exits 0.
   If they differ, emits a structured diff — added merkle roots, removed
   merkle roots, and the source paths associated with changed roots — then
   exits 1.

The canonical manifest path is the constant `DEFAULT_MANIFEST_PATH =
"bootstrap/expected-roots.json"` in `packages/cli/src/commands/bootstrap.ts`.

---

## 4. Manifest semantics

`bootstrap/expected-roots.json` is a JSON array of objects, one per stored
block, sorted by `blockMerkleRoot` ascending (ASCII byte order). The entry
shape is defined by `BootstrapManifestEntry` in `@yakcc/registry`:

```json
{
  "blockMerkleRoot": "<BLAKE3 hex>",
  "specHash": "<BLAKE3 hex>",
  "canonicalAstHash": "<BLAKE3 hex>",
  "parentBlockRoot": "<BLAKE3 hex | null>",
  "implSourceHash": "<BLAKE3 hex>",
  "manifestJsonHash": "<BLAKE3 hex>"
}
```

The manifest is deterministic across runs, across machines, and across
cold and warm caches. This was validated empirically by WI-V2-BOOT-PREFLIGHT
(referenced in `MASTER_PLAN.md`). The approximate entry count on `main` is
1,700-1,800 entries; the exact count derives from source and will change as
the project evolves.

---

## 5. If verify fails

`bootstrap --verify` exits 1 when the live shave result does not match the
committed manifest. The structured diff output names:

- merkle roots present in the live result but absent from the committed
  manifest (added blocks)
- merkle roots present in the committed manifest but absent from the live
  result (removed blocks)
- source file paths whose shave output changed

A CI failure from this step is load-bearing signal. There are exactly two
valid responses:

**A. The source change was intentional.** Regenerate the manifest, inspect the
diff, and commit it:

```sh
node packages/cli/dist/bin.js bootstrap
git diff bootstrap/expected-roots.json
git add bootstrap/expected-roots.json
git commit -m "Regenerate expected-roots.json for <description of change>"
```

**B. The source change was not intentional.** Revert the source change that
caused the divergence and let CI go green without a manifest update.

The third option -- silencing the gate -- is not available. There is no
`--force` flag and no `continue-on-error` bypass in CI.

---

## 6. CI integration

The CI gate is defined in `.github/workflows/bootstrap.yml`, introduced by
WI-V2-BOOTSTRAP-04. It triggers on:

- every push to `main`
- every pull request targeting `main`

The job runs the 3-command reproduction in a single `ubuntu-latest` job with a
90-minute timeout. There is no `continue-on-error` on any step. The workflow
exits with the same code as `bootstrap --verify`.

**Advisory period and required-checks promotion:** The workflow ships as
advisory until BOOTSTRAP-03's `--verify` mode merges and a green run on `main`
is confirmed. Once a green run exists, the workflow can be promoted to a
required check by adding `bootstrap-verify` to the branch protection rules at
`https://github.com/cneckar/yakcc/settings/branches`. This promotion step is
out of scope for WI-V2-BOOTSTRAP-04 and is performed by the repository
maintainer after BOOTSTRAP-03 lands.

---

## 7. References

- `WASM_HOST_CONTRACT.md` -- sibling authority doc for the WASM execution
  contract.
- `FEDERATION_PROTOCOL.md` -- sibling authority doc for the inter-node block
  exchange protocol.
- `MASTER_PLAN.md` -- WI-V2-BOOTSTRAP-01 through WI-V2-BOOTSTRAP-04 rows
  for the full v2 bootstrap work-item history and DEC-IDs.
- `packages/cli/src/commands/bootstrap.ts` -- canonical constant definitions
  (`DEFAULT_MANIFEST_PATH`, `DEFAULT_REGISTRY_PATH`, `DEFAULT_REPORT_PATH`,
  `SKIP_DIR_SEGMENTS`, `SKIP_FILE_SUFFIXES`, `SKIP_FILE_EXACT`).
- `packages/registry/src/` -- `BootstrapManifestEntry` type and
  `exportManifest()` implementation.
