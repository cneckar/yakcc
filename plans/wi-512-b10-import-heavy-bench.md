# WI-512 — B10 Import-Heavy Bench: Slice-Level Plan

**Issue:** [#512](https://github.com/cneckar/yakcc/issues/512) — "B10 import-heavy bench — measure transitive reachable surface vs natural-import baseline"
**Workflow:** `WI-512-B10-IMPORT-BENCH`
**Branch / worktree:** `feature/wi-512-b10-bench` @ `C:/src/yakcc/.worktrees/wi-512-b10-bench`
**Stage:** planner (plan only — no source code in this pass)
**Authored:** 2026-05-14
**Complexity tier:** Tier 3 (new measurement axis in an unfamiliar sub-domain — transitive `node_modules` traversal; multi-file harness; spans two PR slices with a cross-issue dependency).

This document is the **slice-level** plan that owns #512. It is subordinate to and consistent with the already-landed triad coordination plan `plans/import-replacement-triad.md` (phases P0–P5). In that plan's vocabulary:

- **#512 Slice 1 == triad P1** — "B10 measurement harness (no corpus yet)". Provable **before** #510 lands.
- **#512 Slice 2 == triad P2c** — "B10 demo task + run + result commit". Gated on #510 (atoms) + #508 (already CLOSED/landed).
- **#512 Slice 3 == triad P5** — "Broaden B10 bench" — full 12–20 task corpus + B9 Axis-4 fold-in. Gated on #510 corpus breadth + #508 intercept breadth.

This plan **fully specifies Slice 1** and gives a firm-but-revisable shape for Slices 2 and 3. It does not modify `MASTER_PLAN.md` (triad plan §6 explicitly defers the MASTER_PLAN-registration to a separate slice).

---

## Phase 1 — Requirement Analysis

### 1.1 Problem statement

yakcc's headline value proposition is **dependency replacement**: instead of `import { isEmail } from 'validator'` (which drags validator + its entire `node_modules` closure into the reachable attack surface), yakcc composes a handful of content-addressed, individually-fuzzed atoms. The benchmark that proves this must measure **transitive reachable surface** — every function/byte/file reachable by following `import` statements transitively into `node_modules`.

**Why B9 is degenerate for this claim** (restated in my own words): B9's task corpus (`parse-int-list`, `kebab-to-camel`, `digits-to-sum`, `csv-row-narrow`, `even-only-filter`, `parse-coord-pair`) is made of tasks so small that the LLM's natural ("Arm B") solution is a one-line builtin call — `JSON.parse(...)`, `s.replace(...)`, `arr.filter(...)`. Builtins resolve to TypeScript `lib.*.d.ts` *types*, not to `node_modules` *source*. So Arm B has **no transitive npm surface to measure**, and Arm A (yakcc atom composition) actually emits *more* named local functions than Arm B's one-liner — making yakcc look structurally *worse* on a raw function count. B9 explicitly skipped `node_modules` traversal for exactly this reason (see `bench/B9-min-surface/README.md` Axis-1 footnote; `DEC-V0-MIN-SURFACE-002`).

The dependency-replacement story **only fires when Arm B's natural solution is a real npm import.** B10 fixes the corpus (import-heavy tasks) *and* the metric (transitive `node_modules` traversal).

**Who has this problem / cost:** yakcc's maintainers and any evaluator of the project. Without B10, the central value-prop claim ("yakcc ships a strictly smaller, individually-verified surface than `npm install`") is asserted but unmeasured — and B9, the closest existing artifact, actively produces a misleading signal on it.

### 1.2 Goals (measurable)

- **G1.** A B10 benchmark package at `bench/B10-import-replacement/` mirroring B9's structure, with a **transitive-reachability resolver** that follows `import` statements into `node_modules` and counts reachable TS/JS functions, bytes, and unique source files for an arbitrary emit file.
- **G2.** The resolver is **proven correct on synthetic fixtures with a known surface** (cycles, re-exports, type-only imports, dynamic imports, `package.json#exports` maps, deep transitive chains) — unit tests assert exact counts.
- **G3.** The harness runs Arm B measurement (LLM emit → transitive surface) against a corpus and reports a numerically-bounded result artifact in B9's `results-<platform>-<date>.json` shape.
- **G4.** Slice 1 is **provable before #510 lands** by validating the harness against the **existing B9 task corpus** as a smoke corpus (Arm B emits resolve to small/zero npm surface; Arm A emits resolve to zero npm surface) — bounded, non-NaN, non-negative numbers.
- **G5.** Secondary metrics are wired in Slice 1's resolver output even though they only become headline-relevant in Slice 2/3: (a) count of unique non-builtin import statements, (b) npm-audit CVE pattern-match count over the transitive set (this is B9's deferred Axis 4, folded in here per the issue).

### 1.3 Non-goals (with rationale)

- **NG1. No B10 import-heavy task corpus in Slice 1.** Seeding tasks like `validate-rfc5321-email` is Slice 2/3 work and is *blocked* on #510 atoms (Arm A cannot be populated without atoms). Coupling harness landing to a new corpus invites silent harness bugs masked as "low-coverage tasks" (triad plan P1 "forbidden shortcut"). Slice 1 validates the resolver against the B9 corpus instead.
- **NG2. No production-code changes.** B10 is a bench-local measurement tool. It MUST NOT touch `packages/**`, MUST NOT call the production registry, MUST NOT modify `bench/B9-min-surface/**`. The resolver reads emit *files*; it is not a code path.
- **NG3. No headline >=90% delta in Slice 1.** The headline acceptance ("Arm A >=90% smaller on >=10 of 12–20 tasks") is Slice 3's deliverable. Slice 1 produces the *instrument*; Slice 2 produces the *first real reading*; Slice 3 produces the *headline*.
- **NG4. No live Arm A via the #508 hook in Slice 1.** #508 (import-intercept hook) is already CLOSED/landed, but driving `yakcc compile` through it to populate Arm A for *import-heavy tasks* needs the #510 atoms to resolve against. Slice 1's Arm A inputs are the B9 reference `.mjs` emit files (which have zero npm imports — a valid, measurable lower bound).
- **NG5. No runtime/throughput, token-delta, or coherence measurement.** Those are B1 / B4 / B5's jobs respectively (triad plan §6). B10 measures *surface*.
- **NG6. No new verification-spine machinery.** Atoms enter at their author's claimed level per `VERIFICATION.md`; B10 only *measures*.

### 1.4 Unknowns / ambiguities

| # | Unknown | Resolution |
|---|---|---|
| U1 | Does `ts-morph` reliably resolve modern npm package internals — `package.json#exports` conditional maps, dual ESM/CJS packages, CJS interop? | **Methodology decision, not operator decision.** Resolver uses ts-morph's `Project` with `moduleResolution: "nodenext"` for its module-resolution machinery, *plus* an explicit `package.json#exports`/`main`/`module` reader as a fallback when ts-morph's resolver returns nothing. Any genuinely unresolvable specifier is recorded in an `unresolved_imports[]` field and counted as **0 functions / 0 bytes** — Arm B's surface is thereby *under*-counted, never over-counted. This is the conservative direction for a security claim (mirrors `DEC-V0-MIN-SURFACE-002`'s conservative-bias clause, but inverted because here the *traversal target* — not the entry — is what's uncertain). See §3.3. |
| U2 | What is the function-counting unit? | `FunctionDeclaration` + `FunctionExpression` + `ArrowFunction` + `MethodDeclaration` + `Constructor` nodes encountered in the **closure of import-traversed source files**. Type-only declarations (`interface`, `type`, ambient `declare`) excluded. Matches B9 Axis-1's membership rule extended across the import graph. See §3.4. |
| U3 | Reachable-from-entry vs reachable-via-imports — which does B10 count? | **Both, reported separately.** B9 Axis 1 counts functions *reachable by call-graph BFS from an entry symbol within one file*. B10's new axis counts functions *in the transitive import closure* — i.e. "if you `npm install` this and import it, this is the code that ships." The issue's headline ("follow every `import` transitively") is the **import-closure** count; that is B10's primary metric. The call-graph-from-entry count is retained as a secondary B9-comparable number. See §3.4. |
| U4 | Does the smoke run against B9's `JSON.parse`-based Arm B fixture risk resolving `JSON.parse` into `lib.es5.d.ts` and counting thousands of stdlib functions? | Yes — this is the exact risk flagged in triad plan P1's risk register. **Mitigation locked into the resolver:** TypeScript standard-library files (`lib.*.d.ts`, and any file under a `typescript/lib/` path) and Node.js builtin specifiers (`node:*`, bare `fs`/`path`/`crypto`/... per a builtin list) are **excluded from traversal and from all counts**. Builtins are counted only as "builtin import statements", never as transitive surface. See §3.3, §3.4. |
| U5 | Is there an operator-product decision hidden in Slice 1? | **No.** Every Slice-1 choice is methodology (resolver design, counting units, exclusion lists, fixture shape) — implementer/planner-decidable per CLAUDE.md's Question Merit Test and triad plan §5 ("Items that look like operator decisions but aren't"). The operator decisions in the triad (OD-1 atom naming, OD-2 intercept granularity, OD-3 demo library, OD-4 Slice-2 cost cap) all bind **Slice 2+**, not Slice 1. Therefore this plan posts **no blocking question** to #512. A non-blocking informational comment is posted (see §7). |

### 1.5 Dominant constraints

- **C1. Conservative measurement bias.** A security/surface claim must never *over*-count Arm A or *under*-count Arm B in a way that flatters yakcc. Where the resolver is uncertain, it under-counts Arm B (the import-heavy arm). This is the methodology that makes ">=90% reduction" hard to game.
- **C2. Tooling parity with B9.** B9 already depends on `ts-morph` and `fast-check`; B10 reuses both. No new heavy tooling. `ts-morph ^23.0.0` pinned to match B9 (`bench/B9-min-surface/package.json`).
- **C3. Air-gap discipline.** Arm A measurement and the resolver are fully offline. Arm B *live* mode (Anthropic API) exits the B6 air-gap **by design**, documented exactly as B9 documents it. Dry-run mode (fixtures) is fully offline and is the CI default.
- **C4. Corpus pinning discipline.** Any task corpus B10 ships (Slice 2+) carries sha256 fingerprints over LF-normalized `spec.yak` content, verified on harness startup with hard-abort on drift — B7/B9 discipline (`DEC-BENCH-B7-CORPUS-CANONICAL-LF-001`). Slice 1 ships an *empty* `tasks: []` corpus-spec, so this constraint is structural-only in Slice 1.
- **C5. Bench package is NOT in the pnpm workspace.** B9's `package.json` is deliberately outside `pnpm-workspace.yaml` (only `packages/*` and `examples/*` are members). B10 mirrors this: `@anthropic-ai/sdk` and bench-local deps MUST NOT appear in the root `package.json`. Install via `pnpm --dir bench/B10-import-replacement install`.
- **C6. `.mjs` source for harness + Arm A references.** B9 learned the orchestrator-source-guard hook blocks `.ts|.tsx|.js` writes that match the orchestrator session ID (`DEC-V0-B9-SLICE1-IMPL-DEVIATION-001` item 6). All B10 harness code is `.mjs`; any Arm A reference implementations B10 authors are `.mjs`. This is architecturally correct — bench measurement artifacts are not production source.

---

## Phase 2 — Architecture Design & State-Authority Map

### 2.1 State-authority map

B10 is a **measurement tool**, not a stateful system. It has no runtime state authority of its own. The integration surfaces it *reads* (never writes):

| Domain | Canonical authority | B10's relationship |
|---|---|---|
| B10 task corpus + fingerprints | `bench/B10-import-replacement/corpus-spec.json` (this issue owns it) | **Writes** — Slice 1 ships it empty (`tasks: []`); Slice 2/3 populate it. sha256-pinned, harness-verified. |
| Arm A emit (yakcc atom composition) | The emit *file* on disk: B9 reference `.mjs` (Slice 1) → `yakcc compile` output driven by #508 hook + #510 atoms (Slice 2+) | **Reads** the file. Does NOT invoke the production registry or compile pipeline as a library. |
| Arm B emit (LLM baseline) | Anthropic Messages API (live) or a committed fixture JSON (dry-run) | **Reads** — identical dry-run/live split to B9's `llm-baseline.mjs`. |
| Transitive surface of an emit | `node_modules/**` reachable from the emit's `import` statements | **Reads** — the resolver traverses it; it is the new measurement axis. |
| Run results | `bench/B10-import-replacement/results-<platform>-<date>.json` (Slice 2+) and `bench/B10-import-replacement/test/smoke-fixture-<sha>.json` (Slice 1) | **Writes** — artifact files only. |
| npm-audit CVE DB | `npm audit` / a pinned offline DB snapshot | **Reads** — secondary metric; see §3.6. |
| Root `package.json` `bench:*` scripts | Root `package.json` (workspace authority) | **Writes** — one-line `bench:import-replacement*` script additions, mirroring `bench:min-surface*`. |

**No parallel mechanism risk.** The single load-bearing question — "is there a transitive-surface measurer in this repo already?" — answers *no*. B9's `measure-axis1.mjs` deliberately stops at the entry file's call graph and does *not* traverse `node_modules` (`DEC-V0-MIN-SURFACE-002` "EXCLUDED" + the README footnote). B10's resolver is the *first and only* transitive-`node_modules` measurer. It does not replace B9's axis-1 — B9 keeps its single-file call-graph metric; B10 *adds* the import-closure metric. The two are complementary measurements, documented as such. There is no superseded path to delete (the triad plan P1 scope-forbids touching `bench/B9-min-surface/**`).

### 2.2 Harness architecture (mirrors B9)

B10's directory layout mirrors `bench/B9-min-surface/` exactly so future implementers carry one mental model across both benches:

```
bench/B10-import-replacement/
├── README.md                              # Metric methodology, arms, how-to-run, air-gap note, locked DECs
├── package.json                           # Bench-local deps: ts-morph ^23, fast-check ^3.22, @anthropic-ai/sdk ^0.40  (NOT in pnpm workspace)
├── corpus-spec.json                       # Slice 1: { "tasks": [] }.  Slice 2/3: import-heavy tasks + sha256 fingerprints
├── harness/
│   ├── run.mjs                            # Orchestrator: per-task Arm A + Arm B, verdict, results artifact
│   ├── measure-transitive-surface.mjs     # ★ THE NEW HARD PART — transitive-reachability resolver (Slice 1)
│   ├── measure-axis1.mjs                  # Single-file structural metric (LOC/bytes/import-count) — thin reuse of B9's shape
│   ├── arm-a-emit.mjs                     # Resolve Arm A emit path per (task, strategy)  — Slice 1: B9 reference fallback
│   ├── llm-baseline.mjs                   # Arm B: Anthropic API or dry-run fixture (B9 pattern, parameterised per task)
│   └── classify-arm-b.mjs                 # Arm B emit classification / aggregation across N reps
├── fixtures/
│   └── <task>/arm-b-response.json         # Slice 2+: canned Anthropic responses (import-heavy)
├── tasks/
│   └── <task>/{spec.yak, arm-a/{fine,medium,coarse}.mjs}   # Slice 2+: import-heavy task corpus
└── test/
    ├── measure-transitive-surface.test.mjs   # ★ Exact-count assertions on synthetic fixtures (Slice 1)
    ├── measure-transitive-surface.fixtures/  # ★ Synthetic node_modules trees with KNOWN surface (Slice 1)
    ├── run.test.mjs                          # Harness smoke: dry-run exits 0, artifact well-formed (Slice 1)
    └── smoke-fixture-<sha>.json              # Committed smoke result from B9-corpus validation run (Slice 1)
```

**Decision DEC-B10-S1-LAYOUT-001 — Mirror B9 layout, do not unify.** Each bench is a self-contained measurement package (B1–B9 all follow this). B10 copies B9's *shape* but not its code: the resolver is genuinely new, and B9's `measure-axis2/3/5` (adversarial refusal, byte-equivalence, cost) are not Slice-1 concerns. Slice 2/3 may add a byte-equivalence axis reusing B9's `measure-axis3` *pattern* (re-implemented, not imported — triad plan forbids touching `bench/B9-min-surface/**`). Rationale: a shared bench-harness library is a larger refactor than this issue scopes, and would couple B10's landing to a B9 regression risk. Addition-without-subtraction is normally debt — but here B9's measurer genuinely does a *different* measurement (single-file call graph) and is retained intentionally, not as a stale parallel path.

### 2.3 Alternatives considered

| Decision | Options | Chosen | Rationale |
|---|---|---|---|
| Reachability tool | (a) `ts-morph`; (b) hand-rolled AST walk; (c) V8 runtime coverage; (d) a bundler (`esbuild --metafile`) | **(a) ts-morph** | B9 already depends on it (C2). (b) duplicates ts-morph's symbol/module resolution. (c) measures *executed* paths — under-counts defensive branches a benign corpus never exercises, biasing Arm B *downward* — wrong direction (C1). (d) `esbuild --metafile` gives bytes+files cheaply but **does not give a function count** and tree-shakes — tree-shaking *under*-reports the surface an `npm install` actually ships; we want the un-shaken installed surface. ts-morph is the only option that yields fns + bytes + files over the *un-tree-shaken* import closure. |
| Traversal cutoff | (a) depth-N bounded; (b) depth-unbounded, prod-deps only; (c) everything incl. devDeps | **(b) depth-unbounded, prod-deps only** | Matches what a production-emitted bundle's effective surface is. `devDependencies` / `optionalDependencies` are not shipped; `peerDependencies` included when resolvable. Depth-bounding would arbitrarily truncate deep dependency chains and *under*-count Arm B. Triad plan `DEC-IRT-B10-METRIC-001` already settled this. |
| Counting `import()` dynamic imports | (a) ignore; (b) count statically when the specifier is a string literal, flag non-literal as `non_static` | **(b)** | Mirrors B9's `DEC-V0-MIN-SURFACE-002` dynamic-import clause. Literal `import("pkg")` → resolved and traversed. Non-literal `import(expr)` → cannot resolve statically; recorded in `dynamic_non_literal[]` and **not** counted (Arm B under-counted, conservative). |
| Where the metric DEC lives | (a) a doc under `docs/adr/`; (b) `@decision` block at the top of `measure-transitive-surface.mjs` | **(b)** | Code is Truth (CLAUDE.md). The DEC lives next to its only consumer. Triad plan Appendix B already proposes `DEC-IRT-B10-METRIC-001` lands here. Slice 1 *implements* `DEC-IRT-B10-METRIC-001` as the file-header `@decision` block. |

### 2.4 Research gate

**Research performed:** Full read of issue #512 + comments; full read of the triad coordination plan (`plans/import-replacement-triad.md`, which already did the P0/P1 design work and settled `DEC-IRT-B10-METRIC-001`'s methodology); full read of B9's harness (`run.mjs`, `measure-axis1.mjs`, `llm-baseline.mjs`, `arm-a-emit.mjs`, `corpus-spec.json`, a task layout, a fixture, `README.md`); read of #510's issue body; survey of `bench/` conventions and root `package.json` `bench:*` scripts.

**Why this is sufficient:** The hard sub-domain (transitive `node_modules` traversal) is not unfamiliar territory left unspecified — the triad plan already chose `ts-morph` + recursive resolver and settled the cutoff/counts/CVE-fold-in methodology in `DEC-IRT-B10-METRIC-001`. This slice plan's job is to make that methodology *concretely executable* (the §3 resolver spec) and *verifiable* (the §5 Evaluation Contract), not to re-litigate it. No further external research is needed before implementation; the one genuine technical uncertainty (U1 — ts-morph vs modern `package.json#exports`) is handled by a conservative fallback (`unresolved_imports[]` → counted as 0) rather than by needing more research up front, and the synthetic-fixture test suite (§5) will surface any ts-morph resolution gap as a failing exact-count assertion before Slice 1 lands.

---

## Phase 3 — Transitive-Reachability Resolver Design (the load-bearing piece)

This section is the concrete, implementable specification of `measure-transitive-surface.mjs`. It IS `DEC-IRT-B10-METRIC-001` made executable. The implementer transcribes the `@decision` block from this section into the file header.

### 3.1 Entry point & CLI

```
node bench/B10-import-replacement/harness/measure-transitive-surface.mjs \
  --emit <path-to-emit-file>        # the Arm A or Arm B emitted module (.ts or .mjs/.js)
  [--entry <exportedFnName>]        # optional — enables the secondary call-graph-from-entry count
  [--node-modules <dir>]            # node_modules root to resolve against (default: nearest to --emit)
  [--audit]                         # also run the npm-audit CVE secondary metric (default: off in unit tests, on in run.mjs)
  [--json]                          # machine-readable output (run.mjs always passes this)
```

Output: a single JSON object (the **resolver result schema**, §3.5). Exit 0 on success; exit 1 only on a *harness* error (bad args, emit file missing), never on a *measurement* outcome (an unresolvable import is data, not an error).

### 3.2 Algorithm — recursive import-closure walk

```
INPUT:  emitPath, optional entryName, nodeModulesRoot
STATE:  visitedFiles: Set<absPath>          // cycle guard — a file is processed exactly once
        reachableFns: Map<absPath, count>   // per-file function count
        reachableBytes: Map<absPath, bytes>
        importStmts: { builtin, non_builtin_unique: Set<spec>, type_only, dynamic_literal, dynamic_non_literal }
        unresolvedImports: [ {specifier, fromFile, reason} ]
        queue: [ emitPath ]

1. project = new ts-morph Project({
     compilerOptions: { allowJs: true, checkJs: false, noEmit: true,
                        moduleResolution: ModuleResolutionKind.NodeNext, module: ModuleKind.NodeNext },
     skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false })

2. WHILE queue not empty:
   a. file = queue.shift();  if file in visitedFiles -> continue;  visitedFiles.add(file)
   b. IF file is EXCLUDED (see §3.3) -> continue            // never traversed, never counted
   c. sf = project.addSourceFileAtPathIfExists(file) ?? continue
   d. reachableFns[file]   = countFunctions(sf)             // §3.4
      reachableBytes[file] = byteLengthOnDisk(file)
   e. FOR each ImportDeclaration / ExportDeclaration with a module specifier in sf:
        - IF importKind === 'type'  OR  the whole decl isTypeOnly  -> importStmts.type_only++ ; continue   // EXCLUDED
        - spec = the string specifier
        - classify(spec):
            BUILTIN          (node:*, or in NODE_BUILTINS list)  -> importStmts.builtin++ ; continue        // EXCLUDED from traversal
            RELATIVE         (./ ../ or absolute path)           -> resolved = resolveRelative(spec, file)
            BARE PACKAGE     (everything else)                   -> importStmts.non_builtin_unique.add(spec)
                                                                    resolved = resolvePackage(spec, file)  // §3.3
        - IF resolved -> queue.push(resolved)
          ELSE        -> unresolvedImports.push({specifier: spec, fromFile: file, reason})   // counted as 0 — conservative
   f. FOR each CallExpression `import(<arg>)` and `require(<arg>)` in sf:
        - arg is string literal      -> dynamic_literal++ ; resolve & queue.push (treated like a static import)
        - arg is non-literal         -> dynamic_non_literal++ ; recorded, NOT queued   // conservative under-count
   g. FOR a re-export `export * from "spec"` / `export { x } from "spec"` -> same handling as (e); re-exports
      are followed so the *actual* defining file is traversed exactly once (the visitedFiles guard makes a
      re-export of an already-seen file a no-op — no double counting).

3. RESULT (see §3.5 schema):
     reachable_functions      = sum(reachableFns.values())
     reachable_bytes          = sum(reachableBytes.values())
     reachable_files          = visitedFiles.size minus excluded-but-enqueued  (== reachableFns.size)
     unique_non_builtin_imports = importStmts.non_builtin_unique.size
     builtin_imports / type_only_imports / dynamic_literal / dynamic_non_literal counts
     unresolved_imports[]
   PLUS optional secondary: call_graph_from_entry { count, names[] }  if --entry given (§3.4)
   PLUS optional secondary: npm_audit { cve_pattern_matches, ... }    if --audit given (§3.6)
```

**Cycle handling:** the `visitedFiles` set is the single cycle guard. A file is enqueued any number of times but *processed* exactly once. A circular import (`a.ts` → `b.ts` → `a.ts`) terminates because `a.ts` is already in `visitedFiles` on the second visit. No depth counter is needed (cutoff is depth-unbounded per §2.3) — termination is guaranteed by the finite, de-duplicated file set.

**Re-export handling:** `export * from "./impl"` and `export { f } from "./impl"` are treated identically to imports — the resolver follows them to the *defining* file and counts that file's functions there. Because `visitedFiles` de-dupes by absolute path, a function defined in `impl.ts` and re-exported through `index.ts` is counted **once** (at `impl.ts`), never twice. Barrel files (`index.ts` that only re-exports) contribute their own ~0 functions plus edges to the real files.

**Type-only imports** (`import type {...}`, or any `ImportDeclaration`/`ExportDeclaration` whose `isTypeOnly()` is true, or individual specifiers with `importKind === 'type'`) are **excluded entirely** — counted in `type_only_imports` for transparency but never traversed and never contributing to fn/byte/file counts. Type-only imports erase at compile time and ship zero runtime surface.

**Dynamic imports:** literal `import("pkg")` / `require("pkg")` are resolved and traversed (a literal dynamic import *does* ship that surface). Non-literal `import(someVar)` cannot be resolved statically — recorded in `dynamic_non_literal` and **not** traversed. Per C1 this under-counts Arm B (the import-heavy arm), which is the safe direction. B9's `DEC-V0-MIN-SURFACE-002` chose to *over*-count non-literal dynamic imports because there the risk was an *Arm A atom* using a dynamic import; here the traversal target is npm packages and the conservative direction for the headline claim is to under-count Arm B. The asymmetry is deliberate and documented in the `@decision` block.

### 3.3 Module resolution (the U1 hard part) & exclusion lists

**Resolution order for a bare package specifier `pkg` (or `pkg/sub`) imported from `fromFile`:**

1. Ask ts-morph's own resolver first (`sf.getReferencedSourceFiles()` / `ImportDeclaration.getModuleSpecifierSourceFile()`). ts-morph with `moduleResolution: NodeNext` understands `package.json#exports` conditional maps in modern packages. If it returns a source file, use it.
2. **Fallback** if ts-morph returns nothing: an explicit `package.json` reader. Walk `node_modules` upward from `fromFile`, find `node_modules/pkg/package.json`, and resolve the entry in this precedence: `exports` map (prefer the `"import"`/`"default"` condition, then `"require"`) → `module` field → `main` field → `index.js`. For a subpath `pkg/sub`, resolve `sub` against the `exports` subpath map, else `pkg/sub.{js,mjs,cjs,ts}` / `pkg/sub/index.{js,...}`.
3. If both fail: push `{specifier, fromFile, reason}` to `unresolved_imports[]` and count it as **0 functions / 0 bytes**. This *under*-counts Arm B's true surface — the conservative direction (C1). The result JSON surfaces `unresolved_imports` prominently so a reviewer can see exactly what was not traversed and judge whether the under-count is material.

**`.d.ts`-only packages:** if a resolved file is a `.d.ts` (type declarations only, no runtime `.js` sibling), it contributes its (typically 0) *function-with-body* count. Ambient `declare function` without a body is excluded by the §3.4 counting rule.

**EXCLUSION LISTS (never traversed, never counted as surface):**

- **TypeScript standard library:** any file matching `lib.*.d.ts`, or residing under a `typescript/lib/` path. (Mitigates U4 — prevents `JSON.parse` resolving into `lib.es5.d.ts` and inflating Arm B's count by thousands of stdlib type signatures.)
- **Node.js builtins:** specifiers `node:*` or in an explicit `NODE_BUILTINS` set (`fs`, `path`, `crypto`, `util`, `os`, `child_process`, `url`, `stream`, `events`, `assert`, `buffer`, `http`, `https`, `net`, `zlib`, `querystring`, ... — the standard list, pinned in the resolver). Counted in `builtin_imports`, never traversed.
- **`@types/*` packages:** pure type packages — counted in `type_only_imports`-adjacent stats, not traversed.

These exclusion lists are themselves part of `DEC-IRT-B10-METRIC-001` and are unit-tested (a fixture that imports `node:fs` and `JSON.parse`-style stdlib must produce `reachable_functions: 0` from those edges).

### 3.4 Function counting unit

A node is counted as **one reachable function** iff it is one of: `FunctionDeclaration`, `FunctionExpression`, `ArrowFunction`, `MethodDeclaration`, `Constructor`, `GetAccessor`, `SetAccessor` — **and it has a body** (a block or expression body). Excluded: `interface`, `type` alias, ambient `declare function`/`declare class` *without* a body, function *type* annotations, overload *signatures* without an implementation.

This is B9's `measure-axis1.mjs` membership rule (FunctionDeclaration/Expression/ArrowFunction/MethodDeclaration/Constructor) extended with accessors and made explicit about the "has a body" requirement, applied to **every file in the import closure**, not just the entry file.

**Two counts, reported separately (resolves U3):**

- **`reachable_functions`** (PRIMARY, B10's headline axis): the count of body-bearing function nodes across *all files in the transitive import closure* of the emit. This is "the code that ships when you import this." This is what the issue's ">=90% smaller" acceptance is measured against.
- **`call_graph_from_entry`** (SECONDARY, B9-comparable, only if `--entry` given): a call-graph BFS from the named entry export *within the emit file and its closure*, following `CallExpression`/`NewExpression` to defining functions. This is B9 Axis-1's metric. Retained for cross-bench comparability and to show "even the *call-reachable* subset is smaller" — but it is **not** the headline. (For Arm B, most of an npm package's transitive surface is not call-reachable from one entry; the headline claim is about *installed* surface, which is `reachable_functions`.)

### 3.5 Resolver result schema

```jsonc
{
  "emit_path": "<abs>",
  "entry_function": "isEmail|null",
  "node_modules_root": "<abs>|null",
  // PRIMARY transitive-import-closure metrics:
  "reachable_functions": 0,            // body-bearing fn nodes across the whole import closure
  "reachable_bytes": 0,                // sum of on-disk byte sizes of all traversed files
  "reachable_files": 0,                // unique source files traversed (== count of files contributing fns/bytes)
  // import-statement census:
  "unique_non_builtin_imports": 0,     // SECONDARY METRIC #1 from the issue
  "builtin_imports": 0,
  "type_only_imports": 0,
  "dynamic_literal_imports": 0,
  "dynamic_non_literal_imports": 0,
  "unresolved_imports": [ { "specifier": "", "fromFile": "", "reason": "" } ],
  // SECONDARY call-graph-from-entry (B9-comparable; present only if --entry given):
  "call_graph_from_entry": { "count": 0, "names": [], "entry_found": true },
  // SECONDARY METRIC #2 from the issue (B9 deferred Axis 4); present only if --audit given:
  "npm_audit": { "ran": true, "cve_pattern_matches": 0, "advisories": [], "audit_source": "offline-db|live|skipped" },
  // provenance:
  "ts_morph_version": "23.x",
  "excluded_stdlib_files_seen": 0,     // transparency: how many lib.*.d.ts edges were cut
  "measured_at": "<iso8601>"
}
```

### 3.6 npm-audit CVE secondary metric (B9 deferred Axis 4, folded in)

When `--audit` is passed, after the closure walk the resolver:
1. Collects the set of `(package, version)` pairs whose files were traversed (read each traversed package's `package.json` for name+version).
2. Runs `npm audit` against a **synthesized minimal `package.json`** listing exactly those deps, **preferring an offline/pinned advisory DB snapshot** committed under `bench/B10-import-replacement/fixtures/npm-audit-db/` so the metric is deterministic across hosts and CI (triad plan P1 risk register: "npm-audit invocation is non-deterministic across hosts"). If no offline DB is present, it runs live `npm audit --json` and stamps `audit_source: "live"` so the reviewer knows the number is host-dependent.
3. Counts advisories whose affected range matches a traversed `(package, version)` → `cve_pattern_matches`.

In **Slice 1** `--audit` is wired and unit-tested against a synthetic fixture package + a tiny fixture advisory DB, but the smoke run against the B9 corpus is expected to report `cve_pattern_matches: 0` (B9 emits have no npm deps). The metric becomes load-bearing in Slice 3 (triad P5).

---

## Phase 3b — Wave Decomposition & Slicing

### 3b.1 Slice map

| Slice | Triad phase | Deliverable | Weight | Gate | Deps | Provable when |
|---|---|---|---|---|---|---|
| **S1** | P1 | B10 harness + transitive-reachability resolver + Arm B measurement, validated against the **B9 corpus** as a smoke corpus | **L** | review | none (#508 already landed; B9 corpus exists) | **Now** — fully specified below |
| **S2** | P2c | First import-heavy demo task (`validate-rfc5321-email`) + Arm A via #508 hook + #510 atoms + first real `results-*.json` | M | review + operator (live-run cost) | **#510 slice 1 (validator atoms)**; S1 | After #510 slice 1 lands |
| **S3** | P5 | Full 12–20 import-heavy task corpus + B9 Axis-4 CVE fold-in into the headline + headline `results-*.json` meeting #512 acceptance | L | review + operator (live-run cost, honesty reconciliation) | #510 slices 2–N (>=10 libs); #508 slices 2–N; S2 | After #510/#508 broadening |

**Critical path:** S1 → (wait on #510 s1) → S2 → (wait on #510/#508 broadening) → S3. S1 is **not** on any external critical path — it is shippable immediately and in parallel with #510's planning/implementation. Max wave width during S1: 1 (this issue alone).

### 3b.2 What S1 can build/test before #510 lands — explicit split

**Buildable & fully testable in S1 (no #510 dependency):**
- The entire `measure-transitive-surface.mjs` resolver — it operates on emit *files* and a `node_modules` *dir*; it does not need yakcc atoms.
- The synthetic-fixture test suite (`measure-transitive-surface.test.mjs` + `measure-transitive-surface.fixtures/`) — hand-built mini `node_modules` trees with a *known* function/byte/file count, including cycle / re-export / type-only / dynamic / `package.json#exports` fixtures. This is what *proves* the resolver correct.
- `measure-axis1.mjs` (thin single-file LOC/bytes/import-census reuse of B9's shape).
- `arm-a-emit.mjs` — in S1 it resolves Arm A emit paths to the **B9 reference `.mjs` files** (which legitimately have zero npm imports — a valid measurable lower bound). The `yakcc compile` + #508-hook path is wired as a *documented TODO branch* activated in S2.
- `llm-baseline.mjs` — Arm B via Anthropic API (live) or fixture (dry-run), parameterised per task. In S1 it runs against the **B9 fixtures** (`bench/B9-min-surface/fixtures/*/arm-b-response.json`) — read-only, not copied — to validate the Arm-B measurement path end-to-end.
- `classify-arm-b.mjs`, `run.mjs`, `README.md`, `package.json`, empty `corpus-spec.json`.
- The **B9-corpus smoke validation run**: `run.mjs` against B9's 6 tasks, producing `test/smoke-fixture-<sha>.json` with bounded, non-NaN, non-negative numbers (Arm A reachable npm surface = 0; Arm B reachable npm surface = 0 or small — `JSON.parse` resolves to excluded stdlib).
- Root `package.json` `bench:import-replacement` / `:dry` / `:no-network` script lines.

**Blocked on #510 (S2+), explicitly NOT in S1:**
- Any import-heavy task in `tasks/` (e.g. `validate-rfc5321-email`) — Arm A cannot be populated without #510's atoms; without Arm A the headline delta is unmeasurable.
- Any `fixtures/<import-heavy-task>/arm-b-response.json` — these belong with their task.
- Driving `yakcc compile` through the #508 import-intercept hook to produce a real Arm A emit for an import-heavy task — needs #510 atoms in the registry for the hook's `yakcc_resolve` to return candidates.
- The first non-empty `corpus-spec.json` and the first real `results-<platform>-<date>.json`.
- The headline ">=90% on >=10 tasks" acceptance evaluation.

This split is the load-bearing rationale for slicing: **S1 ships a fully-tested instrument whose correctness does not depend on #510 at all**, validated against a corpus that already exists. The headline reading waits for the corpus; the instrument does not.

### 3b.3 Landing policy

- **S1:** default grant — branch checkpoint commits allowed, reviewer handoff allowed, autoland after `ready_for_guardian` + passing tests, `no_ff` merge to `main`. No operation class in S1 requires user approval (no live API spend — dry-run smoke only; no history rewrite; no production-code touch).
- **S2 / S3:** add one operator-approval class — the **live Anthropic API run** (cost spend). Per triad plan OD-4, S2's cost cap is `DEC-BENCH-B10-SLICE2-COST-001` (suggested $25, operator-confirmable). Dry-run is gated `review` only; the *live* run is gated `operator`.

---

## Phase 3b (cont.) — Evaluation Contract & Scope Manifest for Slice 1

### EVALUATION CONTRACT — Slice 1 (guardian-bound)

A reviewer declares S1 `ready_for_guardian` **iff every item below is satisfied with pasted evidence** (live output, not prose).

**Required tests (must exist and pass):**
1. `bench/B10-import-replacement/test/measure-transitive-surface.test.mjs` — exact-count assertions, one test per resolver behavior, each against a committed synthetic fixture in `measure-transitive-surface.fixtures/` with a hand-verified known surface:
   - **T1 static import traversal** — emit imports a 2-package chain; asserts exact `reachable_functions`, `reachable_bytes`, `reachable_files`.
   - **T2 depth-unbounded prod-deps cutoff** — fixture with a 3-deep transitive chain *and* a `devDependency`; asserts the devDep is excluded and the full 3-deep prod chain is counted.
   - **T3 cycle termination** — fixture with `a → b → a`; asserts the run terminates and each file's functions are counted exactly once.
   - **T4 re-export de-duplication** — fixture with a barrel `index.js` re-exporting `impl.js`; asserts `impl`'s functions are counted exactly once (not once per re-export path).
   - **T5 type-only exclusion** — fixture importing `import type {...}` and an `isTypeOnly` export; asserts those contribute `0` to fn/byte/file counts and increment `type_only_imports`.
   - **T6 dynamic import handling** — fixture with literal `import("pkg")` *and* `import(variable)`; asserts the literal is traversed+counted and the non-literal is in `dynamic_non_literal_imports` and NOT counted.
   - **T7 builtin + stdlib exclusion** — fixture importing `node:fs` and using `JSON.parse`; asserts `reachable_functions` from those edges is `0`, `builtin_imports` incremented, `excluded_stdlib_files_seen` reflects the cut (mitigation proof for U4).
   - **T8 `package.json#exports` resolution** — fixture package using a modern conditional `exports` map; asserts the correct entry file is resolved and counted.
   - **T9 unresolvable import** — fixture importing a non-existent specifier; asserts it lands in `unresolved_imports[]`, is counted as `0`, and the run still exits 0 (measurement outcome, not error).
   - **T10 function-counting unit** — fixture file containing one of each: `FunctionDeclaration`, `ArrowFunction`, `MethodDeclaration`, `Constructor`, `GetAccessor`, an `interface`, a `type` alias, an ambient `declare function` without body; asserts the count is exactly the body-bearing nodes and excludes the type-only/ambient ones.
   - **T11 npm-audit secondary metric** — fixture package set + tiny committed fixture advisory DB; asserts `npm_audit.cve_pattern_matches` equals the known number of planted advisories and `audit_source: "offline-db"`.
2. `bench/B10-import-replacement/test/run.test.mjs` — harness smoke: `run.mjs --dry-run` against the B9 corpus exits `0`; the produced artifact JSON parses, has the B9 results-shape keys, and every numeric field is finite, non-negative, non-NaN.

**Required real-path checks (must be run; output pasted):**
- `pnpm --dir bench/B10-import-replacement install` succeeds (installs ts-morph, fast-check, @anthropic-ai/sdk).
- `node --test bench/B10-import-replacement/test/measure-transitive-surface.test.mjs bench/B10-import-replacement/test/run.test.mjs` — all green.
- `pnpm bench:import-replacement:dry` (or `node bench/B10-import-replacement/harness/run.mjs --dry-run`) exits `0`, prints a tabular per-task summary, and writes `bench/B10-import-replacement/test/smoke-fixture-<sha>.json`.
- The committed `smoke-fixture-<sha>.json` shows, for every B9 task: Arm A `reachable_files == 1` (only the emit file was traversed — no npm `node_modules` entered, stdlib-exclusion proven) and Arm B `reachable_functions` is a small finite number with `JSON.parse`-style edges resolving to `0` via the stdlib-exclusion rule — i.e. the resolver does NOT explode on stdlib (live proof of the U4 mitigation on real B9 inputs).
  <!-- Code-is-Truth correction: the S10 test always asserted reachable_files == 1, not reachable_functions == 0.
       B9 reference emits do contain body-bearing functions (e.g. parse-int-list has reachable_functions = 9)
       so the meaningful invariant is that no extra files were traversed (reachable_files == 1), not that
       the function count is zero.  The test was always right; this text was wrong.
       Finding B10-S1-EC-TEXT-ERROR-001 from the Slice 1 reviewer. -->

**Required authority invariants (must hold):**
- The harness MUST NOT import or call the production registry (`packages/registry/**`) or the compile pipeline as a library. It reads emit *files* only.
- B10 is NOT added to `pnpm-workspace.yaml`; `@anthropic-ai/sdk` and bench-local deps do NOT appear in root `package.json` `dependencies`.
- `bench/B9-min-surface/**` is byte-unchanged (B10 reads B9 fixtures/references read-only; it does not edit them).
- `corpus-spec.json` ships with `tasks: []` — Slice 1 introduces no task corpus.
- The `@decision` block at the head of `measure-transitive-surface.mjs` is `DEC-IRT-B10-METRIC-001` and its content matches §3 of this plan (resolver methodology, exclusion lists, conservative-bias direction).

**Required integration points (must be wired):**
- Root `package.json` gains `bench:import-replacement`, `bench:import-replacement:dry`, `bench:import-replacement:no-network` following the exact `bench:min-surface*` naming/shape pattern.
- `README.md` documents: the metric methodology citing `DEC-IRT-B10-METRIC-001`; the two arms; how-to-run (dry/live/no-network); the air-gap note (live Arm B exits the B6 air-gap by design, mirroring B9); the locked-DEC table.

**Forbidden shortcuts (reviewer must reject if present):**
- Implementing the import walk as a regex over emit text instead of a ts-morph AST traversal. Regex silently fails on quoted-import-string edge cases, multi-line imports, and re-exports.
- Tree-shaking the import closure (e.g. via a bundler) before counting — tree-shaking *under*-reports the surface an `npm install` actually ships; B10 counts the un-shaken installed surface.
- Seeding any import-heavy task in `tasks/` or any fixture under `fixtures/` to "get ahead" on S2 — S1's corpus-spec is empty by contract; a non-empty corpus in S1 couples harness landing to corpus correctness.
- Copying B9 harness files and editing them in place under `bench/B10-import-replacement/` *without* the new transitive-surface logic — the resolver is genuinely new code, not a B9 copy.
- Using V8 runtime coverage or `--entry`-only call-graph counting as the *primary* metric — the headline metric is the transitive *import-closure* count (§3.4 / U3).
- Making the harness exit non-zero on an unresolvable import — an unresolved import is *data* (`unresolved_imports[]`), not a harness failure.

**Ready-for-guardian definition:** All required tests exist and pass with pasted output; all four required real-path checks run with pasted output; all authority invariants verified; both integration points wired; no forbidden shortcut present; `smoke-fixture-<sha>.json` committed and showing the U4-mitigation behavior on real B9 inputs; the `DEC-IRT-B10-METRIC-001` `@decision` block present and matching §3.

### SCOPE MANIFEST — Slice 1

**Allowed files/directories (implementer may touch):**
- `bench/B10-import-replacement/**` (the entire new bench package)
- `package.json` (repo root — *only* the three `bench:import-replacement*` script lines added)
- `plans/wi-512-b10-import-heavy-bench.md` (this plan — implementer may append an implementation-deviation `@decision` note if code diverges from §3, per "Code is Truth")

**Required files/directories (must be created/modified):**
- `bench/B10-import-replacement/harness/measure-transitive-surface.mjs` — the resolver, with the `DEC-IRT-B10-METRIC-001` `@decision` header
- `bench/B10-import-replacement/harness/run.mjs` — orchestrator
- `bench/B10-import-replacement/harness/{measure-axis1.mjs, arm-a-emit.mjs, llm-baseline.mjs, classify-arm-b.mjs}`
- `bench/B10-import-replacement/test/measure-transitive-surface.test.mjs` + `measure-transitive-surface.fixtures/**` (the synthetic known-surface fixtures)
- `bench/B10-import-replacement/test/run.test.mjs`
- `bench/B10-import-replacement/test/smoke-fixture-<sha>.json` (committed output of the B9-corpus validation run)
- `bench/B10-import-replacement/{README.md, package.json, corpus-spec.json}` (`corpus-spec.json` = `{ "tasks": [] }`)
- `bench/B10-import-replacement/fixtures/npm-audit-db/**` (tiny pinned fixture advisory DB for the T11 audit test)
- root `package.json` — three script lines

**Forbidden touch points (must NOT change without re-approval):**
- `packages/**` — no production-code changes; B10 is bench-local (triad plan P1 forbidden touch point)
- `bench/B9-min-surface/**` — read-only reference; do not regress or edit B9
- `bench/B1-*`, `B4-*`, `B5-*`, `B6-*`, `B7-*`, `B8-*`, `v0-release-smoke/**` — other benches untouched
- `pnpm-workspace.yaml` — B10 is deliberately NOT a workspace member
- `MASTER_PLAN.md` — triad plan §6 defers the B10 MASTER_PLAN registration to a separate post-P5 slice
- `bench/B10-import-replacement/tasks/**`, `bench/B10-import-replacement/fixtures/<task>/**` — the import-heavy task corpus is S2/S3 scope, NOT S1

**Expected state authorities touched:** None (runtime). B10 is a measurement tool with no runtime state authority. File-level: it *writes* only `bench/B10-import-replacement/**` artifacts + 3 lines of root `package.json`; it *reads* `bench/B9-min-surface/**` and `node_modules/**` and (live mode) the Anthropic API.

---

## Phase 4 — Decision Log

New decisions introduced by this plan (S1-scoped; the triad-level DECs are owned by `plans/import-replacement-triad.md`):

| DEC-ID | Decision | Rationale | Lands at |
|---|---|---|---|
| `DEC-IRT-B10-METRIC-001` | Transitive-reachable-surface methodology: ts-morph recursive import-closure walk; depth-unbounded prod-deps-only cutoff; body-bearing-fn counting unit; stdlib/builtin/type-only exclusion lists; conservative under-count of Arm B on unresolvable/non-literal-dynamic imports; npm-audit CVE secondary metric. | Proposed by the triad plan (Appendix B); this slice plan §3 makes it concretely executable. Conservative bias (under-count the import-heavy arm) is what makes ">=90% reduction" un-gameable. | `@decision` header of `bench/B10-import-replacement/harness/measure-transitive-surface.mjs` (implemented in S1) |
| `DEC-B10-S1-LAYOUT-001` | B10 mirrors B9's directory *shape* but does not share harness code; B9's single-file call-graph axis 1 is retained as a complementary measurement, not superseded. | A shared bench-harness library is a larger refactor than #512 scopes and would couple B10 landing to B9 regression risk. B9 measures a genuinely *different* thing (single-file call graph), so retaining it is intentional, not stale-parallel-path debt. | `@decision` header of `bench/B10-import-replacement/harness/run.mjs` (implemented in S1) |
| `DEC-BENCH-B10-SLICE2-COST-001` | Live-run cost cap for S2 (suggested $25, operator-confirmable per triad OD-4). | Spend authority; matches the $25 suite reserve in `DEC-V0-B4-SLICE2-COST-CEILING-004` and B9's $50-per-slice-cap pattern. | `@decision` header of `bench/B10-import-replacement/harness/run.mjs` — **lands in S2, not S1** |

### Internal Quality Gate (self-check before emitting trailer)

- ✅ Dependencies & state mapped: §2.1 state-authority map; §3b.1/§3b.2 dependency split (S1 ⟂ #510; S2 ← #510 s1; S3 ← #510/#508 broadening).
- ✅ Every guardian-bound work item has an Evaluation Contract with *executable* acceptance criteria: S1's contract is 11 exact-count unit tests + 4 real-path checks + invariants — all measurable, none narrative.
- ✅ Every guardian-bound work item has a Scope Manifest with explicit file boundaries: S1's allowed/required/forbidden globs are listed; S2/S3 boundaries sketched and deferred to their own slice planners (consistent with triad plan's "each slice's own planner writes its scope rows").
- ✅ No work item relies on narrative completion language: the U4 stdlib-explosion risk is gated by a *pasted* `smoke-fixture` showing `0` from stdlib edges on real B9 inputs, not by "we handled stdlib".

---

## Phase 5 — Continuation & Open Questions

**Open operator questions:** None blocking Slice 1. Every S1 choice is methodology, implementer/planner-decidable (U5). The triad's operator decisions (OD-1 atom naming, OD-2 intercept granularity, OD-3 demo library, OD-4 S2 cost cap) all bind **S2+** and are tracked in `plans/import-replacement-triad.md` §5 — they do not gate S1. An **informational, non-blocking** comment is posted to #512 recording the slice split and that S1 is unblocked now (see commit + §7 below).

**Next action:** Slice 1 is fully specified, has an executable Evaluation Contract and a bounded Scope Manifest, has zero external dependency (#508 already landed; the B9 smoke corpus already exists), and has no open operator decision. It is ready for guardian provisioning and implementer dispatch as the next canonical work item.

---

## Appendix — Cross-references

- Issue: [#512](https://github.com/cneckar/yakcc/issues/512). Companions: [#508](https://github.com/cneckar/yakcc/issues/508) (CLOSED — import-intercept hook), [#510](https://github.com/cneckar/yakcc/issues/510) (in parallel planning — shadow-npm atoms). Related: [#515](https://github.com/cneckar/yakcc/issues/515) (B9 atom correctness — upstream of S2/S3 task implementations), [#446](https://github.com/cneckar/yakcc/issues/446)/[#167](https://github.com/cneckar/yakcc/issues/167) (B9 Axis-4 deferral now folded into B10 per §3.6).
- Triad coordination plan: `plans/import-replacement-triad.md` (this slice plan = its P1; consistent with its `DEC-IRT-B10-METRIC-001`).
- B9 reference harness (the structural template): `bench/B9-min-surface/harness/{run.mjs,measure-axis1.mjs,llm-baseline.mjs,arm-a-emit.mjs,classify-arm-b.mjs}`, `bench/B9-min-surface/{corpus-spec.json,README.md,package.json}`, `bench/B9-min-surface/tasks/<task>/`.
- Bench-discipline DECs reused: `DEC-V0-MIN-SURFACE-002` (ts-morph reachability — B10 extends across `node_modules`), `DEC-V0-MIN-SURFACE-003` (locked Arm B prompt + sha256 — B10's `llm-baseline.mjs` mirrors), `DEC-BENCH-B7-CORPUS-CANONICAL-LF-001` (LF-normalized sha256 corpus pinning — B10 S2+), `DEC-BENCH-B9-SLICE1-COST-001` ($-per-slice cost-cap pattern — B10 `DEC-BENCH-B10-SLICE2-COST-001`), `DEC-V0-B4-SLICE2-COST-CEILING-004` ($150 suite cap incl. the $25 B10 reserve).

*End of plan.*
