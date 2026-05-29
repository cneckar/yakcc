# PLAN — WI-877 yakcc shave/compile/roundtrip Python CLI verbs (Option C)

> Planner output for [`#877`](https://github.com/cneckar/yakcc/issues/877)
> ([Serenity] feat(cli): add `yakcc shave` / `yakcc compile` high-level commands for round-trip workflows).
> Workflow `wi-877-cli-verbs`, work item `wi-877-plan`, goal `g-877`.
> Branch `feature/877-shave-compile-cli` in worktree
> `/Users/cris/src/yakcc/.worktrees/feature-877-shave-compile-cli`.
>
> Operator decision (2026-05-29): **Option C — polyglot dispatcher per verb,
> input-driven defaults.** The TS path stays the default everywhere it was
> default; Python is added as a sniff at the top of the existing entry
> functions. This plan supersedes the prior "options A/B/C" draft.

---

## 0 — Headline

`yakcc shave <file>` and `yakcc compile <entry>` keep their existing TS
behavior verbatim. The polyglot dispatch is a small sniff at the top of each
command's entry function that delegates to a new Python helper when the input
file extension is `.py` (shave) or `--target python` is set (compile).
`yakcc roundtrip <file>` is a brand-new verb wired into the dispatcher;
its Python branch is implemented in this MVP, the TS branch errors with a
follow-up pointer.

This is the minimum surface that satisfies #877 without breaking either of
the two production verbs and without violating the WI scope manifest's
forbids on adapter-package source.

---

## 1 — Problem decomposition (challenge the requirement first)

### Restated in my own words

#877 asks for three high-level CLI verbs that drive the new Python adapter
packages (`@yakcc/shave-python`, `@yakcc/compile-python`) end-to-end. Today
exercising the Python round-trip needs a hand-written TS snippet that reaches
into the untyped libcst envelope. The user wants a one-shell-line UX.

The three verbs:

- `yakcc shave <file>` — IR atoms from a source file; TS path writes atoms to
  the registry (existing behavior), Python path writes IR text to stdout or
  `--out`.
- `yakcc compile <entry> [--target <lang>]` — lower one atom; TS path
  (default, `--target ts`) preserves the registry-backed assembly verbatim,
  Python path emits `module.py` (+ optional `test_module.py` when the atom
  carries `proof/properties.json`).
- `yakcc roundtrip <file>` — chain shave → compile → diff; per-function
  status table. Python-only in this MVP.

All three are MVP Python-only on the polyglot side, future-proofed by a
`--target python|rust|go` flag where rust/go exit 1 with #868 / #870
pointers.

### Goals (measurable)

1. **G1** — A one-shell-line `yakcc roundtrip examples/foo.py` produces a
   per-function status table; #877's "Acceptance" boxes can be ticked.
2. **G2** — Per-function partial failure is observable, not catastrophic. A
   multi-function input with one impure function produces partial IR plus a
   per-function failure row, and only exits non-zero when zero functions
   succeed.
3. **G3** — Existing TS callers see **byte-identical** behavior. A
   regression test snapshots one current `yakcc shave foo.ts` and
   `yakcc compile <root>` run pre/post change and asserts equality.
4. **G4** — Future polyglot targets (Rust #868, Go #870) require no CLI
   re-wiring beyond a single switch arm. `--target rust|go` already exits 1
   with the tracking issue link.

### Non-goals (explicit exclusions)

- **Rust/Go adapters.** Tracked at #868 / #870. CLI emits structured
  "not supported in MVP" errors with the issue links.
- **TS roundtrip.** Out of scope for this MVP. `yakcc roundtrip <file.ts>`
  errors with a follow-up pointer; the dispatcher case exists so the verb is
  registered.
- **Modifying `packages/shave-python/**` or `packages/compile-python/**`.**
  Forbidden by scope manifest. The CLI consumes the public API only.
- **Modifying `packages/shave/**` or `packages/compile/**`.** Forbidden.
- **Registry schema or `BlockTripletRow` changes.** Python compile fetches
  via the existing `registry.getBlock(merkleRoot)` path; Python shave does
  not write to the registry at all.
- **MASTER_PLAN.md churn.** A post-landing planner pass adds a decision-log
  row once the operator approves the merge.
- **Polyglot `yakcc init` auto-detect.** Tracked at #785.

### Unknowns and ambiguities — resolved at planning time

1. **Does `compileToPython` accept a `BlockMerkleRoot`/registry input
   symmetric to the TS compile path?** Resolved by reading
   `packages/compile-python/src/compile-python.ts`: signature is
   `compileToPython(atom: BlockTripletRow, opts?: CompilePythonOptions) →
   PythonCompileResult`. Same input shape as the TS path. The `compile`
   dispatcher can reuse the existing entry-resolution → `getBlock` flow for
   both targets. See DEC-WI877-002.

2. **Does `shave-python` expose a single top-level "shave this file"
   function?** Resolved by reading `packages/shave-python/src/index.ts`: no.
   Exports are pipeline primitives (`parsePythonSource`,
   `extractFunctionSignatures`, `renderBody`,
   `raiseFunctionWithPurityAndNormalization`). The CLI helper composes them.
   See DEC-WI877-001 §B.

3. **Does writing Python IR into the SQLite registry make sense?** No. The
   Python pipeline produces IR text, not a `BlockTripletRow` (no spec, no
   proof, no merkle root). Wedging it into `storeBlock` requires fabricating
   triplet fields and is out of scope. **Python shave writes to stdout or
   `--out <file>`** — the asymmetry with TS shave (registry-write) is
   documented at DEC-WI877-008.

4. **Local file name `compile-python.ts` vs the package import
   `@yakcc/compile-python` — collision risk?** Resolved by precedent:
   `packages/cli/src/commands/compile-self.ts` already coexists with the
   `@yakcc/compile` package import via relative-vs-package import paths.
   No collision.

### Dominant constraints

- Sacred Practice #2: no source edits on `main`; this WI ships from the
  provisioned worktree.
- Sacred Practice #12: existing TS-side `shave` and `compile` verbs are the
  single source of truth for their behavior; Option C preserves them
  verbatim and only adds a sniff at the top of the entry function.
- Scope manifest forbids touching `packages/shave/**`, `packages/compile/**`,
  `packages/shave-python/**`, `packages/compile-python/**`. CLI is the
  only allowed surface.
- Test seam discipline: CLI tests mock the adapter packages at the public
  API boundary (`vi.mock("@yakcc/shave-python", …)`,
  `vi.mock("@yakcc/compile-python", …)`); one gated smoke per Python verb
  exercises the real subprocess.
- Memory `feedback_pre_push_hygiene`: rebase + lint + typecheck before
  every push. Memory `feedback_branch_must_track_origin_main`:
  `git fetch && git diff --stat origin/main..HEAD` before push.

---

## 2 — State authorities & integration surfaces

| Domain                                | Authority (canonical)                                                  | This WI relationship                |
|---------------------------------------|------------------------------------------------------------------------|-------------------------------------|
| TS shave pipeline                     | `packages/shave/` via `@yakcc/shave.shave()`                            | **unchanged** — sniff falls through |
| TS compile / assemble                 | `packages/compile/` via `@yakcc/compile.assemble()`                     | **unchanged** — `--target ts` falls through |
| Python file parsing → libcst envelope | `parsePythonSource` (public export of `@yakcc/shave-python`)            | **read-only consumer**              |
| Python function-signature extraction  | `extractFunctionSignatures`                                             | **read-only consumer**              |
| Python raise + normalize + render     | `raiseFunctionWithPurityAndNormalization` (public export)               | **read-only consumer**              |
| Python wire-stmt body render          | `renderBody` (public export of `@yakcc/shave-python`)                   | **read-only consumer**              |
| Python IR atom → Python source        | `compileToPython` (public export of `@yakcc/compile-python`)            | **read-only consumer**              |
| Registry (BlockMerkleRoot → row)      | `@yakcc/registry.openRegistry`, `registry.getBlock(...)`                | **read-only consumer (compile only)** |
| Spec resolution (specHash → root)     | `@yakcc/contracts.specHash`, `@yakcc/registry.selectBlocks(...)`        | **reused via existing compile.ts path** |
| CLI command registration              | `packages/cli/src/index.ts` switch in `runCli()`                       | **adds case `"roundtrip"`**; help text amended |
| Logger interface                      | `Logger` interface + `CollectingLogger` in `packages/cli/src/index.ts` | **reused verbatim**                 |
| argv parsing                          | `node:util.parseArgs`                                                   | **reused verbatim**                 |
| Language inference                    | New: `packages/cli/src/commands/lang-target.ts`                         | **new single authority for ext→lang** |

### Existing-mechanism survey (Sacred Practice #12)

Already in the worktree under `packages/cli/src/commands/`:

- `shave.ts` (~190 LOC) — wraps `@yakcc/shave.shave()` for **TypeScript**
  sources. Reads `.ts` from disk; runs universalizer pipeline (license gate →
  intent extraction → decompose → slice); stores atoms via registry. Has
  `@decision DEC-CLI-SHAVE-001`. Production verb; **must remain unchanged
  below the sniff line**.
- `compile.ts` (~191 LOC) — wraps `@yakcc/compile.assemble()` to assemble a
  module from a `BlockMerkleRoot` / SpecYak JSON / directory. Has
  `@decision DEC-CLI-COMPILE-001`. Production verb; **must remain unchanged
  below the sniff line** when `--target ts`.

Help text in `index.ts` (lines ~170–186) documents both verbs in the
`USAGE` block. The polyglot help additions go alongside, not replacing.

These existing verbs are the only TS-side entry points for shave/compile.
The polyglot helpers consume the adapter packages' public API exports
audited in §1 #1 and §1 #2 above.

---

## 3 — Architecture design

### 3.1 Polyglot dispatch shape (the part that does NOT depend on naming)

`shave.ts` (existing entry function, append sniff at top):

```
export async function shave(argv, logger): Promise<number> {
  // existing argv parse, help-handling, foreign-policy validate
  const parsed = parseArgs(...);
  if (parsed === null) return 1;
  if (parsed.values.help) { ...print extended help including --target line...; return 0; }

  // --- NEW: polyglot sniff ---
  const positional = parsed.positionals[0];
  const explicitTarget = parsed.values.target as TargetLang | undefined;
  const target = inferTarget(positional, explicitTarget);
  if (target === "python") {
    return runShavePython(parsed, logger);
  }
  if (target === "rust" || target === "go") {
    const issue = target === "rust" ? 868 : 870;
    logger.error(`error: --target ${target} is not yet wired; tracked at #${issue}`);
    return 1;
  }
  // target === "ts" — fall through to existing TS path unchanged
  // ...existing TS shave logic below this line stays verbatim...
}
```

`compile.ts` (existing entry function, append sniff after argv parse):

```
export async function compile(argv, logger, opts?): Promise<number> {
  const { values, positionals } = parseArgs(...);  // existing
  const entryArg = positionals[0];                  // existing
  // (existing entryArg validation, granularity, etc.)

  const target = (values.target as TargetLang | undefined) ?? "ts";
  // --- NEW: polyglot sniff ---
  if (target === "python") {
    return runCompilePython(values, positionals, logger, opts);
  }
  if (target === "rust" || target === "go") {
    const issue = target === "rust" ? 868 : 870;
    logger.error(`error: --target ${target} is not yet wired; tracked at #${issue}`);
    return 1;
  }
  // target === "ts" — fall through to existing TS path unchanged
  // ...existing TS compile logic below this line stays verbatim...
}
```

`roundtrip.ts` (new):

```
export async function roundtrip(argv, logger): Promise<number> {
  // parse argv (positional <file>, --target, --out)
  const target = inferTarget(file, explicitTarget);
  if (target === "python") return runRoundtripPython(file, opts, logger);
  if (target === "ts") {
    logger.error("error: roundtrip --target ts is not wired in this MVP; tracked as #877 follow-up");
    return 1;
  }
  if (target === "rust" || target === "go") {
    const issue = target === "rust" ? 868 : 870;
    logger.error(`error: --target ${target} is not yet wired; tracked at #${issue}`);
    return 1;
  }
  return 1;
}
```

`runShavePython(parsed, logger)` composes the shave-python pipeline:

```
1. read file at parsed.positionals[0]
2. envelope := parsePythonSource(content, {spawnImpl?})
3. signatures := extractFunctionSignatures(envelope)
4. if --function <name>, filter signatures to that name
5. for each sig:
     body := extractWireBody(envelope, sig)   // §3.3 — body-reach helper
     try ir := raiseFunctionWithPurityAndNormalization(envelope, sig, body)
     catch ImpureFunctionError | UnsupportedAstError | UnsupportedTypeError |
           MissingTypeAnnotationError: log per-function error to stderr,
           continue
6. concat IR strings with "\n\n" separators (or per-function banner if --out
    is a directory)
7. write to stdout if no --out; write to --out path otherwise
8. exit 0 if ≥1 function succeeded, 1 if zero succeeded, 2 if parse failed
```

`runCompilePython(values, positionals, logger, opts)` reuses entry resolution:

```
1. resolve entryArg → BlockMerkleRoot using existing logic from compile.ts
   (lifted into a shared helper if minimal, otherwise copied with @decision
   note pointing back to DEC-CLI-COMPILE-001)
2. open registry (read-only)
3. row := registry.getBlock(merkleRoot)
4. if row === null: error "no atom with root <root>"; return 1
5. result := compileToPython(row, { fnName: values.function ?? undefined })
6. outDir := values.out ?? <derived from entryArg, same logic as TS path>
7. write outDir/module.py := result.source
8. if result.testSource: write outDir/test_module.py := result.testSource
9. write outDir/manifest.json := { entryRoot, target: "python", warnings }
10. surface result.warnings to stderr
11. registry.close()
12. return 0
```

`runRoundtripPython(file, opts, logger)`:

```
1. shave-python path → IR per function (in-memory; no --out, no stdout
   print — capture as string)
2. for each function's IR:
   a. synthesize atom := { implSource: ir, artifacts: new Map() } as
      Partial<BlockTripletRow> (cast acknowledged at DEC-WI877-008
      Subsection §B)
   b. result := compileToPython(atom)
   c. compare result.source (snake_case) vs the original function's
      libcst source slice
   d. record per-function row: pass | shave-error | compile-error |
      diff (with line count) | clean-but-renamed
3. print status table to stdout
4. if --out <dir> set, persist intermediates (<dir>/<fn>.ir.ts,
   <dir>/<fn>.module.py, <dir>/<fn>.diff.txt)
5. exit 0 if any function passed; 1 if all failed; 2 if file unparseable
```

### 3.2 The shared helper: `lang-target.ts`

Single authority for extension → language and `--target` validation.

```ts
export type TargetLang = "ts" | "python" | "rust" | "go";

export const TARGETS_TRACKED = {
  rust: 868,
  go: 870,
} as const;

export function inferTarget(
  filePath: string | undefined,
  override: string | undefined,
): TargetLang | "unknown" { ... }

export function isSupportedTarget(t: string): t is TargetLang { ... }
```

Every verb file imports from this module. No verb does its own
`endsWith(".py")` or `--target` string matching. This is the single-source
authority for the polyglot enum.

### 3.3 Body-reach helper for `shave-python`

`raiseFunctionWithPurityAndNormalization(envelope, sig, body)` requires a
`WireStmt[]`. The shave-python public API surface today does not expose a
typed body-extractor (verified at §1 #2). The CLI helper duplicates the
reach pattern used in the existing exploration code:

```ts
const moduleNode = envelope.module as PythonAstNode;
const fns = (moduleNode.functions as PythonAstNode[]) ?? [];
const fnRecord = fns.find(f => (f as {name?: string}).name === sig.name);
const rawBody = (fnRecord as {body?: PythonAstNode[]}).body ?? [];
const body = renderStmt-equivalent translation
```

The implementer adds a `// TODO: file follow-up to publish a typed body
extractor in @yakcc/shave-python; see DEC-WI877-008` comment and files a
new tracking issue for that gap. We do **not** fix the gap here — scope
manifest forbids `packages/shave-python/**`.

### 3.4 Test seam (shared)

CLI tests mock the adapter packages at the public-API boundary:

```ts
import { vi } from "vitest";
vi.mock("@yakcc/shave-python", () => ({
  parsePythonSource: vi.fn(),
  extractFunctionSignatures: vi.fn(),
  raiseFunctionWithPurityAndNormalization: vi.fn(),
  ImpureFunctionError: class extends Error {},
  // ...
}));
```

Fast tests use these mocks; one `describe.skipIf(!hasPython3WithLibcst)`
block per Python verb exercises the real subprocess. Gate env var
`YAKCC_SKIP_PYTHON_SMOKE=1` opts out for CI without libcst (matches the
gate the adapter packages already use).

`compileToPython` is pure (no subprocess) so its CLI wrapper needs no
subprocess seam — fixtures are inline IR strings via the mock.

For roundtrip: small fixture functions (`def double(x: int) -> int:
    return x + x`) exercise the happy path; a second fixture
(`def reads_env() -> str: import os; return os.environ.get('X', '')`)
exercises the impure-rejection path.

---

## 4 — Design decisions

### DEC-WI877-001 — `yakcc shave` argument shape (Option C, input-driven)

**Decision.** `yakcc shave <file> [--registry <p>] [--offline] [--foreign-policy <allow|reject|tag>] [--target <lang>] [--out <path>] [--function <name>]`.

- **Language inference** from extension on `<file>`: `.ts`/`.tsx` → `ts`,
  `.py` → `python`. Other extensions error unless `--target` overrides.
- **`--target`** explicitly overrides extension inference. Required when
  the extension is unknown.
- **TS target** (default for `.ts`/`.tsx`): falls through to the existing
  `shaveImpl()` path. Registry-write, `--foreign-policy`, `--offline`,
  `--registry`, and the full L5 foreign-policy gate output all behave
  exactly as today. **Zero behavior change.**
- **Python target**: dispatches to `runShavePython`, which composes the
  shave-python pipeline. Writes IR text to stdout by default; `--out
  <path>` writes to a single file (functions concatenated with banners) or
  to a directory (one file per function, `<dir>/<fn>.ir.ts`).
- **`--function <name>`** (Python target only): process only one function
  by name; default is all top-level functions.
- **`--registry`/`--offline`/`--foreign-policy`**: ignored when the target
  is Python (Python path does not touch the registry). The dispatcher
  emits a one-line stderr note "warning: --foreign-policy ignored for
  --target python" so the operator is not confused.

**Alternatives considered.**

- *Require explicit `--target` always.* Rejected — the operator decision
  specified input-driven defaults.
- *Wedge Python output into the registry by fabricating a `BlockTripletRow`.*
  Rejected — Python pipeline produces only the impl half (no spec, no
  proof). Forcing the shape misrepresents the data. See DEC-WI877-008.

### DEC-WI877-002 — `yakcc compile` argument shape (Option C, default `ts`)

**Decision.** `yakcc compile <entry> [--registry <p>] [--out <dir>] [--granularity <n>] [--target <lang>] [--function <name>]`.

- `<entry>` keeps the existing union shape: BlockMerkleRoot (64-hex), spec
  file path, or directory containing `spec.yak`. Same code path resolves it
  for both TS and Python targets.
- `--target` defaults to `ts`. When omitted or `--target ts`, falls through
  to the existing `assemble()` call exactly as today. Writes
  `<out>/module.ts` and `<out>/manifest.json`. **Zero behavior change.**
- `--target python`: after entry resolution → `BlockMerkleRoot`, fetches the
  `BlockTripletRow` via `registry.getBlock(merkleRoot)` and calls
  `compileToPython(row, { fnName: values.function })`. Writes
  `<out>/module.py`, optionally `<out>/test_module.py` (only when
  `result.testSource` is non-empty), and `<out>/manifest.json` with
  `"target": "python"` + the warnings array. `<out>` resolution mirrors the
  TS path (default `<entry-dir>/dist` when entry is a directory).
- `--target rust|go`: exit 1 with `#868` / `#870` pointer.

**Rationale.** Symmetric with the TS path at the input side (both fetch
from the registry). Symmetric on output (directory with `module.<ext>` +
`manifest.json`). The operator-stated "no input-shape divergence between
targets" is honored.

**Verified at planning time.** `compileToPython` signature reads
`atom.implSource` and `atom.artifacts.get("proof/properties.json")` only,
per source inspection of `packages/compile-python/src/compile-python.ts`.

### DEC-WI877-003 — `yakcc roundtrip` argument shape and Python-only MVP

**Decision.** `yakcc roundtrip <file> [--target <lang>] [--out <dir>]`.

- Auto-detects source language from `<file>` extension via `lang-target.ts`;
  `--target` overrides.
- **Python branch implemented**: shave-python in-memory → synthesize partial
  `BlockTripletRow` (cast, per DEC-WI877-008 §B) → `compileToPython` →
  per-function diff vs original source.
- **TS branch out of scope** for this WI: exits 1 with
  `error: roundtrip --target ts is not wired in this MVP; tracked as #877
  follow-up`. The dispatcher case exists so the verb is registered and
  `--help` lists it.

**Output**: per-function status table to stdout. Columns:
`function | shave | compile | round-trip | notes`.

- `shave`: `pass` | `impure` | `unsupported-ast` | `unsupported-type` |
  `missing-annotation`.
- `compile`: `pass` | `<n>-warnings` | `skipped` | `error`.
- `round-trip`: `pass` (byte-clean) | `clean-but-renamed` (snake_case ⇄
  camelCase round trip is expected to not be byte-clean) | `diff (<n> lines)`
  | `skipped`.

`--out <dir>`: write per-function artifacts (`<fn>.ir.ts`, `<fn>.module.py`,
`<fn>.diff.txt`) for inspection.

**Exit code rule.** 0 if any function reached round-trip stage (regardless
of byte-cleanliness — `clean-but-renamed` counts as success); 1 if all
failed before round-trip; 2 if the file is unparseable or the target is
unsupported.

### DEC-WI877-004 — Per-function continuation and exit-code semantics

**Decision.** Per-function failures do not abort the whole file. The
pipeline processes one function at a time, logs per-function failures with
structured prefixes to stderr, and continues.

- `yakcc shave --target python`:
  - exit 0 if ≥1 function shaved successfully
  - exit 1 if zero functions shaved
  - exit 2 if parse-level failure (whole file unparseable)
- `yakcc compile --target python`:
  - exit 0 on successful compile (warnings allowed)
  - exit 1 on file-read error, registry miss, or `compileToPython` throw
- `yakcc roundtrip`:
  - exit 0 if any function reached round-trip stage
  - exit 1 if all failed
  - exit 2 if unparseable or unsupported `--target`

**Rationale.** "At least one succeeded" matches Unix batch-tool convention
(e.g. `grep` returns 0 when any line matches). The user explicitly stated
per-function continuation in the dispatch.

### DEC-WI877-005 — Python-only MVP; rust/go stubbed

**Decision.** `lang-target.ts` exports
`TARGETS_TRACKED = { rust: 868, go: 870 } as const`. Every verb that
encounters `--target rust|go` emits:

```
error: --target <lang> is not yet wired; tracked at #<issue>
```

and exits 1. When the Rust adapter lands (#868), the new wiring slots into
the same dispatch with one new switch arm; same shape for Go (#870).

### DEC-WI877-006 — Output format and `--out` semantics

**Decision.**

- `yakcc shave --target python <file>`:
  - Default: stdout.
  - `--out <path>` where path looks like a file (ends in `.ir.ts` or `.ts`
    or has a non-existent parent): write all functions concatenated with
    `\n// ---- function: <name> ----\n` banners.
  - `--out <dir>` where dir is an existing directory or ends in `/`: write
    one file per function (`<dir>/<fn>.ir.ts`).
  - `--out <file>` when input has multiple functions and no `--function`:
    error with `--out must be a directory when input has multiple
    functions; got file path "<...>"`.
- `yakcc compile --target python <entry>`:
  - Writes `<out>/module.py` (required), `<out>/test_module.py`
    (conditional on `testSource` non-empty), `<out>/manifest.json`
    (always).
  - `<out>` resolution: same logic as the TS path (default
    `<entry-dir>/dist` if entry is a directory).
- `yakcc roundtrip <file>`:
  - Default: per-function status table to stdout, no intermediates
    persisted.
  - `--out <dir>` writes `<fn>.ir.ts`, `<fn>.module.py`, `<fn>.diff.txt`
    per function.

### DEC-WI877-007 — Test seam: mock adapter packages at the public-API boundary

**Decision.** CLI tests use `vi.mock("@yakcc/shave-python", …)` and
`vi.mock("@yakcc/compile-python", …)` at the public-API boundary. Fast
tests; no subprocess spawn. One `describe.skipIf(!hasPython3WithLibcst)`
block per Python verb exercises the real adapter (gated by
`YAKCC_SKIP_PYTHON_SMOKE` env var to match the gate the adapter packages
already use).

Regression tests for the TS path of `shave.ts` and `compile.ts` use the
existing test fixtures and snapshot one stdout + manifest run pre/post
change to assert byte-equality.

### DEC-WI877-008 — Preserve TS semantics verbatim; document the Python I/O asymmetry; reach-in helper

**Decision (§A).** The polyglot dispatch is added **as a sniff at the top**
of `shave.ts` and `compile.ts`. The existing code below the sniff is not
refactored, renamed, moved, or restructured. Reading the diff for this WI
should show the existing TS code untouched and a single early-return
delegation block at the top of each function.

**Decision (§B).** Python shave writes to stdout or `--out`; it does not
write to the registry. The asymmetry with TS shave (which writes atoms
into the registry) is documented in the help text and in the
`@decision DEC-WI877-008` annotation in `shave.ts`. If a future WI teaches
the Python adapter to emit `BlockTripletRow`s (or teaches the TS path to
emit IR text to stdout for symmetry), this asymmetry collapses. The
operator's dispatch explicitly accepted this asymmetry.

For roundtrip, the synthetic `BlockTripletRow` cast:

```ts
const atom = {
  implSource: ir,
  artifacts: new Map<string, Uint8Array>(),
} as BlockTripletRow;
```

is justified because `compileToPython` reads only `implSource` and
`artifacts.get(...)`, verified by source inspection at §1 #1. A type-narrow
helper `synthesizePartialAtom(ir): BlockTripletRow` localizes the cast.
A regression test records the current read-set so a future widening of
`compileToPython`'s read shape produces a CI failure at this site.

**Decision (§C).** Body-reach for shave-python is mirrored, not fixed.
A `// TODO(#<follow-up-issue>)` comment cites the gap; the implementer
files the follow-up tracking issue once the WI lands.

---

## 5 — Wave decomposition (implementer slicing guidance)

Single PR. The implementer slices it locally as commits.

| W-ID    | Item                                                                       | Wt | Deps    | Gate                |
|---------|----------------------------------------------------------------------------|----|---------|---------------------|
| W-877-A | `lang-target.ts` helper + tests (`inferTarget`, `isSupportedTarget`, `TARGETS_TRACKED`) | S | — | tests |
| W-877-B | `shave-python.ts` helper (`runShavePython`) + body-reach helper + tests   | M  | A       | tests               |
| W-877-C | `shave.ts` polyglot sniff at top; TS regression snapshot stays green       | S  | A,B     | tests + regression  |
| W-877-D | `compile-python.ts` helper (`runCompilePython`: reuse entry resolution, getBlock, write `module.py`/`test_module.py`/`manifest.json`) + tests | M | A | tests |
| W-877-E | `compile.ts` polyglot sniff at top; TS regression snapshot stays green     | S  | A,D     | tests + regression  |
| W-877-F | `roundtrip.ts` (Python branch only; TS branch errors with #877 follow-up note) + tests | M | A,B,D | tests + real-path |
| W-877-G | `packages/cli/src/index.ts` adds `case "roundtrip"`; help text amended for all three verbs + `--target`; `index.test.ts` smoke | S | F | tests + smoke |

Critical path: A → B → C and A → D → E in parallel; then F → G.
Max parallel width: 2 (B/C in parallel with D/E after A lands).

---

## 6 — Evaluation Contract (canonical — persisted via `tmp/877-evaluation.json`)

### Required tests (vitest unit + gated smoke)

1. **`lang-target.test.ts`** — exhaustive table:
   - `.ts` → ts, `.tsx` → ts, `.py` → python, `.rs` → rust, `.go` → go
   - unknown ext + no `--target` → `"unknown"`
   - `--target` overrides extension when both are present
   - `TARGETS_TRACKED.rust === 868`, `TARGETS_TRACKED.go === 870`
2. **`shave-python.test.ts`** (mocks `@yakcc/shave-python`):
   - happy path: 2-function fixture → 2 IR blocks concatenated to stdout,
     exit 0
   - `--out <file>` writes concatenated IR to file
   - `--out <dir>` (existing directory) writes one file per function
   - `--function <name>` filters to one function (only that function emitted)
   - per-function failure (one impure) → stderr structured error + IR for
     pure function on stdout + exit 0
   - all functions failed → exit 1
   - parse-level failure (`parsePythonSource` throws) → exit 2 + structured
     stderr
   - `--out <file>` with multi-function input + no `--function` → error
     with structured message
3. **`shave.test.ts`** — **regression**:
   - Existing TS-path tests stay byte-identical (no diff in `git diff` for
     the assertion lines).
   - New: `.py` input → calls mocked `runShavePython`
   - New: `--target python` (even with `.ts` extension) → calls mocked
     `runShavePython`
   - New: `--target rust` → exit 1 with `#868` pointer
   - New: `--target go` → exit 1 with `#870` pointer
   - New: `--target python` with `--foreign-policy reject` → stderr
     "warning: --foreign-policy ignored for --target python", continues
     normally
4. **`compile-python.test.ts`** (mocks `@yakcc/compile-python` + registry):
   - happy path: `<BlockMerkleRoot>` → `getBlock` returns a row →
     `compileToPython` returns source — writes `<out>/module.py`,
     `<out>/manifest.json` with `"target": "python"` + warnings array
   - `testSource` non-empty → writes `<out>/test_module.py`
   - `testSource` empty → no test file written
   - registry miss (`getBlock` returns null) → exit 1 with structured error
   - `--function <name>` → passes `{ fnName }` to `compileToPython`
   - `<entry>` as directory → resolves to `<dir>/spec.yak` (reuses existing
     compile.ts resolution); `--out` defaults to `<dir>/dist`
5. **`compile.test.ts`** — **regression**:
   - Existing tests stay byte-identical for no-flag and `--target ts`.
   - New: `--target python` → calls mocked `runCompilePython`
   - New: `--target rust|go` → exit 1 with issue pointer
6. **`roundtrip.test.ts`** (mocks both adapter packages):
   - happy path (2-function fixture, both round-trip cleanly) → status
     table with 2 PASS rows + exit 0
   - mixed (1 pass, 1 impure) → status table with mixed rows + exit 0
   - all fail → exit 1
   - `.ts` input → exit 1 with follow-up note
   - unparseable input → exit 2
   - `--out <dir>` writes per-function intermediates
7. **`index.test.ts`** smoke:
   - top-level `--help` lists `roundtrip` alongside `shave` and `compile`
   - `yakcc roundtrip --help` returns 0 and prints usage
   - `yakcc roundtrip` (no args) prints usage and exits 1
   - help text for `shave` mentions `--target` and Python-extension dispatch
   - help text for `compile` mentions `--target` and default of `ts`
8. **Gated smoke** — `describe.skipIf(process.env.YAKCC_SKIP_PYTHON_SMOKE === "1" || !hasPython3WithLibcst)`:
   - one per Python verb (`shave-python.smoke.test.ts`,
     `compile-python.smoke.test.ts`) exercises the real adapter against a
     tiny fixture under `packages/cli/src/__fixtures__/wi-877/`

### Required evidence (paste verbatim in PR description)

- `pnpm --filter @yakcc/cli test` raw output (all pass).
- Live transcript: `yakcc shave packages/cli/src/__fixtures__/wi-877/double.py`
  emitting IR to stdout.
- Live transcript: `yakcc compile <root> --target python --out tmp/wi877-out`
  showing `module.py` content (the operator may pick any existing root in
  the registry; if none, a `compile-self` round-trip provides one).
- Live transcript: `yakcc roundtrip packages/cli/src/__fixtures__/wi-877/double.py`
  showing the per-function status table.
- Live transcript: `yakcc shave packages/cli/src/__fixtures__/wi-877/double.py --target rust`
  showing exit 1 + `#868` pointer.
- Live transcript: existing `yakcc shave <some-ts-file>` and `yakcc compile <root>`
  invocations producing identical output to pre-WI HEAD (snapshot diff
  empty).

### Required real-path checks

- All three verbs are registered in the `runCli` switch in
  `packages/cli/src/index.ts`.
- `printUsage()` lists all three under a coherent block; `--target` and the
  Python-extension behavior are documented.
- `lang-target.ts` is the only module performing extension → language
  inference. No string match on `.endsWith(".py")` elsewhere in the new
  code (verified by `grep -n "endsWith"` over the new files in the diff).
- `parsePythonSource`, `extractFunctionSignatures`,
  `raiseFunctionWithPurityAndNormalization` are invoked via
  `@yakcc/shave-python` package import only (no deep imports).
- `compileToPython` invoked via `@yakcc/compile-python` package import only.
- `compile --target python` produces `module.py` whose first lines match
  `compileToPython(...).source` exactly (no CLI-side mangling).
- For at least one current `yakcc shave foo.ts` example and one
  `yakcc compile <root>` example, output is byte-identical pre/post change.

### Required authority invariants

- **Zero touched files under `packages/shave-python/**`.** Any gap in the
  public API (e.g. body-extractor) is mirrored, not fixed (DEC-WI877-008 §C).
- **Zero touched files under `packages/compile-python/**`.**
- **Zero touched files under `packages/shave/**` or `packages/compile/**`.**
  Existing TS verbs preserved verbatim below the sniff line.
- **Zero touched files under `packages/registry/**`, `packages/contracts/**`,
  `packages/federation/**`, `packages/hooks-base/**`, `packages/ir/**`,
  `packages/yakcc/**`, `bootstrap/**`, `.github/**`, `.changeset/**`,
  `.claude/**`.**
- **No new state authority.** Python shave writes to stdout/file; Python
  compile reads from registry but does not write; roundtrip is stateless.
- The existing TS code in `shave.ts` and `compile.ts` is unchanged below the
  polyglot sniff — verifiable via per-line diff that shows only insertions
  at the top of each function body.

### Required integration points

- `packages/cli/src/index.ts` adds exactly one new switch case
  (`"roundtrip"`); the help block is amended to list all three polyglot
  verbs and their `--target` semantics.
- Each new verb / helper file exports a `Promise<number>` handler matching
  the existing `(argv, logger) => Promise<number>` contract or a comparable
  per-function helper shape.
- `lang-target.ts` is imported by every new helper file; no duplicate
  ext→lang logic anywhere.

### Forbidden shortcuts

- No reach-around imports into shave-python or compile-python internals
  (e.g. `@yakcc/shave-python/src/libcst-parser.js`). Public exports only.
- No silent default for `--target` when extension inference fails; error
  with a structured message naming the inferred-or-supplied value.
- No "fallback to most-recent registry" magic in compile when `--registry`
  is omitted; use the same default (`.yakcc/registry.sqlite`) the existing
  compile.ts uses.
- No `eval` of IR text; `compileToPython` does its own parsing.
- No `node:child_process` spawn of `yakcc` itself for roundtrip; in-process
  function calls only (Sacred Practice #5).
- No `--out` that creates only an in-memory result; files must persist.
- No fabrication of a `BlockTripletRow` that includes spec/proof fields —
  only `implSource` and `artifacts: Map<string, Uint8Array>()` populated.
- No alteration of `package.json` `bin` entries or the `yakcc` binary name.

### Rollback boundary

Single PR. Reverting the merge restores prior state cleanly because:
(a) the sniffs in `shave.ts` and `compile.ts` are additive top-of-function
blocks — reverting removes the inserted lines and leaves the existing TS
code intact; (b) all new files are net-new — reverting deletes them;
(c) no state authority introduced.

### Ready-for-guardian when

- All required tests pass under `pnpm --filter @yakcc/cli test`.
- Repo-root tests green (`pnpm test`).
- `pnpm lint` and `pnpm typecheck` clean (memory `feedback_pre_push_hygiene`).
- `git -C <worktree> fetch origin && git -C <worktree> diff --stat
  origin/main..HEAD` shows only intended files changed; rebase onto
  `origin/main` is clean (memory `feedback_branch_must_track_origin_main`).
- All §6 "Required evidence" outputs pasted into the PR description.
- Reviewer issued `REVIEW_VERDICT=ready_for_guardian` (or equivalent
  trailer) and the projection ran `cc-policy evaluation set
  ready_for_guardian` for the workflow (memory
  `feedback_agent_tool_completion_projection_gap`).

---

## 7 — Scope Manifest (canonical — persisted via `cc-policy workflow scope-sync`)

### Allowed paths (implementer may touch)

- `packages/cli/src/commands/shave.ts` (sniff at top; existing TS logic untouched)
- `packages/cli/src/commands/compile.ts` (sniff at top; existing TS logic untouched)
- `packages/cli/src/commands/roundtrip.ts` (new)
- `packages/cli/src/commands/lang-target.ts` (new)
- `packages/cli/src/commands/shave-python.ts` (new — wraps `@yakcc/shave-python`)
- `packages/cli/src/commands/compile-python.ts` (new — wraps `@yakcc/compile-python`)
- `packages/cli/src/commands/shave.test.ts` (additions for `.py` dispatch + `--target rust|go`)
- `packages/cli/src/commands/compile.test.ts` (additions for `--target python|rust|go`)
- `packages/cli/src/commands/roundtrip.test.ts` (new)
- `packages/cli/src/commands/lang-target.test.ts` (new)
- `packages/cli/src/commands/shave-python.test.ts` (new)
- `packages/cli/src/commands/compile-python.test.ts` (new)
- `packages/cli/src/commands/shave-python.smoke.test.ts` (new — gated)
- `packages/cli/src/commands/compile-python.smoke.test.ts` (new — gated)
- `packages/cli/src/__fixtures__/wi-877/**` (new test fixtures)
- `packages/cli/src/index.ts` (add `case "roundtrip"` + amend help)
- `packages/cli/src/index.test.ts` (smoke additions)
- `packages/cli/package.json` (only to add `@yakcc/shave-python` and
  `@yakcc/compile-python` workspace deps if not already wired transitively;
  verify before editing)
- `tmp/**` (scratch evidence)
- `PLAN.md` (this document; planner-owned)

### Required paths (must be modified for the WI to be complete)

- `packages/cli/src/commands/shave.ts`
- `packages/cli/src/commands/compile.ts`
- `packages/cli/src/commands/roundtrip.ts`
- `packages/cli/src/commands/lang-target.ts`
- `packages/cli/src/commands/shave-python.ts`
- `packages/cli/src/commands/compile-python.ts`
- `packages/cli/src/index.ts`

### Forbidden paths

- `packages/shave-python/**` — adapter authority; consume public API only.
- `packages/compile-python/**` — adapter authority; consume public API only.
- `packages/shave/**` — TS pipeline authority.
- `packages/compile/**` — TS pipeline authority.
- `packages/contracts/**` — schema authority.
- `packages/registry/**` — read-only consumer via public API.
- `packages/federation/**`, `packages/hooks-base/**`, `packages/ir/**`,
  `packages/yakcc/**` — out of scope.
- `bootstrap/**`, `.github/**`, `.changeset/**`, `.claude/**` — control
  plane.

### State authorities

- **Read-only:** registry SQLite (`getBlock`, `selectBlocks`) via
  `@yakcc/registry`.
- **No new state authority introduced.**

---

## 8 — Decision Log additions (in-file, no MASTER_PLAN churn)

`@decision` annotations the implementer writes in source:

- `DEC-WI877-001` — `yakcc shave` arg shape + extension-driven Python dispatch
  + TS-path preserved verbatim (§4).
- `DEC-WI877-002` — `yakcc compile` arg shape + `--target` dispatch
  defaulting to `ts`; registry-symmetric Python path (§4).
- `DEC-WI877-003` — `yakcc roundtrip` arg shape; Python-only MVP, TS branch
  stubbed (§4).
- `DEC-WI877-004` — Per-function continuation + exit-code semantics (§4).
- `DEC-WI877-005` — Four-slot polyglot enum (ts | python | rust | go);
  rust/go stubbed with issue pointers (§4).
- `DEC-WI877-006` — stdout / `--out` semantics for shave; directory output
  for compile (§4).
- `DEC-WI877-007` — Test seam: mock adapter packages at the public-API
  boundary; gated smoke (§4).
- `DEC-WI877-008` — Preserve TS semantics verbatim; document Python I/O
  asymmetry; body-reach helper mirrors (does not fix) the shave-python
  gap (§4).

Each `@decision` block must include rationale and a back-link to this
PLAN.md (e.g. `Cross-reference: PLAN.md §4 / #877`).

---

## 9 — Implementer marching orders

1. Worktree is provisioned at
   `/Users/cris/src/yakcc/.worktrees/feature-877-shave-compile-cli/`. Branch
   `feature/877-shave-compile-cli` is descended from `origin/main`. **Do not
   commit on `main`** (Sacred Practice #2; memory `feedback_no_main_branch_commits`).
2. Verify HEAD is tracking `origin/main`:
   `git -C /Users/cris/src/yakcc/.worktrees/feature-877-shave-compile-cli fetch origin`
   then `git -C … diff --stat origin/main..HEAD` (memory
   `feedback_branch_must_track_origin_main`).
3. Implement in slice order §5. After each slice, run
   `pnpm --filter @yakcc/cli test` and confirm the TS-path regression
   snapshots stay green.
4. Before pushing: rebase onto `origin/main`, run `pnpm lint`,
   `pnpm typecheck`, full vitest, and the live smokes from §6 "Required
   evidence." Capture all outputs for the PR description (memory
   `feedback_pre_push_hygiene`).
5. After reviewer verdict, run `cc-policy evaluation set ready_for_guardian`
   if the Agent-tool projection did not (memory
   `feedback_agent_tool_completion_projection_gap`).
6. Claim with serenity label on issue #877 to prevent sister-agent
   double-pick: `gh issue edit 877 --add-label serenity` (memory
   `feedback_serenity_claim_label`).
7. PR title: `feat(cli): #877 — polyglot shave/compile/roundtrip CLI verbs (Python MVP)`.
   PR body: paste §6 evidence verbatim; reference #868 / #870 for the
   deferred targets and the new "shave-python typed body-extractor"
   follow-up issue per DEC-WI877-008 §C.
8. Closes #877 (Python MVP of all three verbs).
9. File a follow-up issue for the shave-python body-extractor gap and link
   from the `// TODO` comment per DEC-WI877-008 §C.

---

## 10 — Post-landing follow-ups (backlog issues, not in this WI)

- **TS roundtrip** — wire `yakcc roundtrip <file.ts>` once a single-file
  in-memory TS shave+assemble seam exists.
- **shave-python typed body-extractor** — publish a typed API that returns
  `WireStmt[]` from a `LibcstParseResult` so the CLI no longer reaches
  into the untyped envelope (DEC-WI877-008 §C).
- **Python shave → registry symmetry** — if the Python adapter learns to
  emit `BlockTripletRow`s, collapse the I/O asymmetry documented in
  DEC-WI877-008 §B.
- **Rust target wiring** — tracked at #868. Slots into `lang-target.ts` +
  a new `shave-rust.ts` / `compile-rust.ts` pair when the adapter package
  lands.
- **Go target wiring** — tracked at #870. Same shape as rust.
- **`--json` output for `yakcc roundtrip`** — text table is sufficient for
  #877 MVP; `--json` is a natural follow-up for CI consumption.

---

PLAN authored 2026-05-29 against worktree HEAD on branch
`feature/877-shave-compile-cli`. Operator decision (Option C, polyglot per
verb with input-driven defaults) received at planner continuation time and
encoded throughout §4 / §6 / §7.

PLAN_VERDICT: next_work_item
PLAN_SUMMARY: Operator picked Option C (polyglot dispatch per verb, TS default preserved verbatim); plan rewritten end-to-end with DEC-001..008 reflecting the decision, scope manifest extended with the new helper files (`lang-target.ts`, `shave-python.ts`, `compile-python.ts`) plus their tests, and evaluation contract pinned to byte-identical TS-path regression + mocked-adapter coverage for the Python path. Next dispatch: implementer in the provisioned worktree with the active lease.
