# yakcc v2 self-hosting demo

`yakcc bootstrap --verify` is the executable form of the self-hosting claim:
the shave function, applied to this repository, produces exactly the manifest
committed at `bootstrap/expected-roots.json`. A clean exit-zero run from a
fresh clone proves every yakcc atom on disk is content-addressed by the same
hash a fresh shave would assign — i.e., the substrate has not silently drifted
from its own definition.

## 1. Overview — what self-hosting means here

yakcc is a content-addressed registry of "atoms" — shaved code blocks
identified by a deterministic `BlockMerkleRoot` hash. **Self-hosting** is the
property that yakcc's own source tree can be re-derived from yakcc's own
rules. `bootstrap --verify` walks the source tree, shaves it into atoms,
builds an in-memory registry, exports a manifest sorted by `BlockMerkleRoot`,
and byte-compares the result to `bootstrap/expected-roots.json`. Equality is
the proof.

The verify subcommand was delivered by **WI-V2-BOOTSTRAP-03** (committed at
`ab77e61` on `main`). The committed manifest contains **1766 atom entries**.

## 2. Fresh-clone reproduction

Prerequisites:

- **pnpm 9** (matches `package.json` `packageManager` field and the CI
  `pnpm/action-setup@v4` pin).
- **Node.js 22** (matches the CI `actions/setup-node@v4` pin; check
  `.nvmrc` / `.tool-versions` if present).
- A clean clone with no local modifications. The verify path is
  byte-deterministic; uncommitted edits to shaved source files will change
  atom hashes and trigger a mismatch.

From a fresh clone, the entire reproduction is three commands:

```sh
pnpm install --frozen-lockfile
pnpm -r build
node packages/cli/dist/bin.js bootstrap --verify
```

A clean run prints a single-line summary and exits `0`. Captured output from
running this sequence against `main` at `ab77e61`:

```
bootstrap --verify: OK (1766 entries, byte-identical)
```

Wallclock for the verify step on a 2024-class workstation: **~28 minutes**
(28:33 wallclock, 1062.65s user CPU + 25.67s system CPU, 63% CPU
utilisation). Plan accordingly when running locally; in CI, this fits inside
the 90-minute job timeout with margin.

A mismatch exits non-zero and prints a structured diff against
`bootstrap/expected-roots.json` so the offending atoms can be located.

## 3. What `bootstrap --verify` does

Conceptually, the verify path performs the following steps in order:

1. **Walk the source tree.** The yakcc working copy is enumerated using the
   project's standard ignore rules.
2. **Shave each file into atoms.** Hashing follows the rules defined in
   `WASM_HOST_CONTRACT.md`; that contract is the single source of truth for
   how atom boundaries and hashes are computed. This document does not
   re-specify those rules.
3. **Build an in-memory registry.** Atoms are inserted into a transient
   `:memory:` SQLite registry that mirrors the production registry's
   invariants but is discarded at process exit. (See the `verify mode uses
   :memory: registry and byte-identity gate` annotation in
   `packages/cli/src/commands/bootstrap.ts`.)
4. **Export a manifest sorted by `BlockMerkleRoot`.** Per
   **DEC-V2-BOOT-FILE-ORDER-001**, manifest entries are ordered by
   `BlockMerkleRoot`, not by filesystem iteration order. This is what makes
   the manifest reproducible across clones, operating systems, and
   filesystems.
5. **Exclude AI training corpora.** Per **DEC-V2-BOOT-NO-AI-CORPUS-001**, any
   probabilistic / AI-derived training corpora are excluded from the
   deterministic substrate so that the hash of yakcc-itself does not depend
   on a non-deterministic input set.
6. **Byte-compare to `bootstrap/expected-roots.json`.** The exported manifest
   is compared byte-for-byte against the committed file.
7. **Exit code.** `0` on byte-identical match, non-zero on mismatch with a
   structured diff written to stderr.

## 4. Manifest semantics

`bootstrap/expected-roots.json` is the canonical, committed manifest of
yakcc-itself. At HEAD `ab77e61` it contains 1766 atom records, ordered by
`BlockMerkleRoot`.

Why deterministic ordering matters:

- **Reproducibility across clones.** Two contributors on different machines,
  filesystems, and operating systems must produce byte-identical manifests
  from the same tree. Sorting by `BlockMerkleRoot` removes the only common
  source of nondeterminism — filesystem iteration order — from the output.
- **Auditable diffs.** When the manifest does change, the diff is meaningful:
  insertions, deletions, and hash changes appear in stable positions instead
  of being scrambled by directory-walk order.
- **No filesystem-iteration leakage.** Atom identity is intrinsic to the
  atom, not to where it happens to live in the working tree. Sorting by
  `BlockMerkleRoot` enforces that property at the manifest level.

Both decisions cited above govern this surface:

- **DEC-V2-BOOT-FILE-ORDER-001** — manifest ordered by `BlockMerkleRoot`.
- **DEC-V2-BOOT-NO-AI-CORPUS-001** — AI training corpora excluded from the
  deterministic substrate.

## 5. If verify fails

When `bootstrap --verify` exits non-zero, the failure is a concrete drift
report against `bootstrap/expected-roots.json`. The verify implementation
emits a structured diff (see the `VerifyDiff` shape in
`packages/cli/src/commands/bootstrap.ts`) describing exactly which atoms
differ, were added, or were removed. To diagnose:

1. **Read the structured diff the run printed.** It localizes the drift to
   specific atoms, with hash before/after when applicable.
2. **Check for uncommitted local changes.** Even whitespace-only edits in
   shaved files will alter atom hashes. A clean `git status` is a
   precondition for a meaningful verify run.
3. **Check for files added without re-shaving.** New source files added
   since the last manifest regeneration will appear as inserted atom
   records.
4. **Check that `bootstrap/expected-roots.json` was regenerated after
   intentional source changes.** If a PR legitimately changes shaved
   source, the manifest must be regenerated in the same change; otherwise
   verify will (correctly) fail.

Manifest regeneration is the inverse of verify: running the same
`bootstrap` subcommand without `--verify` writes the freshly computed
manifest to `bootstrap/expected-roots.json`. Maintainers run that path
whenever intentional source changes affect atom content; the new manifest
must be committed alongside the source change so subsequent verify runs
remain green.

## 6. CI integration

`.github/workflows/bootstrap.yml` runs the same three-command sequence
documented above on every push to `main` and every pull request targeting
`main`. The job uses a concurrency group keyed to `github.ref` with
`cancel-in-progress: false` so that concurrent verify runs against the
same ref do not invalidate each other mid-flight. It carries a 90-minute
timeout (covering the ~28-minute verify step plus install/build with
ample margin) and does not use `continue-on-error`, so a failed verify is
a hard CI failure.

CI failure semantics, restated explicitly: a source change that alters
atom content but lands without regenerating `bootstrap/expected-roots.json`
will fail this gate at PR time. That is the intended behaviour — the gate
is the project's strongest external proof of self-consistency.

This means the README install block, this document, and the CI workflow
all execute the **same** three commands — any drift between the three is
itself detectable, by both humans reading the docs and CI running on
PRs.

## 7. References

- [`packages/cli/src/commands/bootstrap.ts`](../packages/cli/src/commands/bootstrap.ts)
  — `--verify` implementation, including the `VerifyDiff` structured-diff
  shape and the `:memory:` registry gate.
- [`bootstrap/expected-roots.json`](../bootstrap/expected-roots.json) —
  committed manifest (1766 entries) that `--verify` byte-compares against.
- [`WASM_HOST_CONTRACT.md`](../WASM_HOST_CONTRACT.md) — the wasm-host
  boundary used during shave/verify; canonical authority for atom hashing
  rules.
- [`FEDERATION_PROTOCOL.md`](../FEDERATION_PROTOCOL.md) — how federated
  registries gossip atoms; out-of-scope for this doc but adjacent
  (federation consumes the same content-addressed identities that
  self-hosting verifies).
- Decisions: **DEC-V2-BOOT-FILE-ORDER-001** (manifest ordered by
  `BlockMerkleRoot`), **DEC-V2-BOOT-NO-AI-CORPUS-001** (AI training corpora
  excluded from the deterministic substrate).
- Tracking issues: **#8 — WI-V2-BOOTSTRAP-03** (delivers `--verify`),
  **#9 — WI-V2-BOOTSTRAP-04** (this docs+CI bundle).
