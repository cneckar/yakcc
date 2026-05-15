# wi-531-asc-compile-cache — asc compile cache + parallelize `closer-parity-as.test.ts beforeAll`

- Workflow ID: `wi-531-asc-compile-cache`
- Goal ID: `g-531-asc-compile-cache`
- Work Item ID: `wi-531-asc-compile-cache`
- Branch: `feature/fix-531-asc-compile-cache`
- Closes: #531 (parent) — references #485 (parallelization root cause, lost in cleanup) and #143 (Phase 2 80% gate-flip; currently masked by timeout)
- Status: planned (planner stage), awaiting `guardian:provision`

---

## Identity

This is the planning record for fixing the `closer-parity-as.test.ts` 60-min `beforeAll` timeout via **two coupled changes that must land together**:

1. **Parallelization recovery** — the lost `WI-FIX-485-CLOSER-PARITY-TIMEOUT` work (per #485 comment 1). Concurrency=9 chunking from a prior attempt hit 5385.70s; the planner-spec'd promise pool with `computeAscConcurrency()` is the canonical shape.
2. **Content-addressed asc compile cache** — a new module that memoizes `assemblyScriptBackend().emit()` outputs keyed on `(canonicalAstHash, ascVersion, ascFlagsHash)`. Warm runs skip the expensive `execFileSync(node, [asc.js, …])` per atom.

Both are required: parallelization alone may not fit cold runs into the budget on slower CI; cache alone does nothing for the cold path. Together: cold ≤ 60 min, warm ≪ 60 min.

This unblocks #143 Phase 2 gate-flip — the `it.fails("coverage >= 80%")` line at L470 of `closer-parity-as.test.ts` is currently obscured by timeout, not actually being evaluated against the 4119-atom corpus.

---

## Problem Statement

### Who has this problem
- Maintainers running `pnpm --filter @yakcc/compile test -- closer-parity-as` locally and in CI.
- Any future Phase 2B–2I sub-slice that needs to observe the actual coverage ratio against the full 4119-atom corpus.

### How often
- Every full test run of `@yakcc/compile`. Currently the suite either:
  - times out at 60 min on cold runs (no cache), OR
  - succeeds slowly without offering byte-stable repeatability.

### What's the cost
- 80% coverage gate (`it.fails` line 470) is meaningless until the test actually completes against the regenerated corpus.
- Developer iteration loop is hostile (>60 min per attempt).
- CI flakiness from runners hitting the hookTimeout ceiling.

### Goals (measurable)
- G1 — cold-cache `beforeAll` < 60 min CI wall-clock (existing `3_600_000` hookTimeout at L297 must NOT be raised).
- G2 — warm-cache `beforeAll` <5 min wall-clock on the unchanged 4119-atom corpus.
- G3 — `pending-atoms-as.json` byte-identical across two back-to-back cold→warm runs (determinism).
- G4 — all five existing closer-parity-as invariants continue to pass:
  - WebAssembly.validate sweep (L367)
  - partition completeness (L383)
  - coverage report (L408)
  - first-slice ≥30% minimum (L453)
  - `it.fails` 80% gate (L470) — still fails as expected
- G5 — `YAKCC_AS_PARITY_CONCURRENCY=1` reproduces serial baseline within ±10% (rollback path proof).
- G6 — new unit tests for the cache module exercise: hash key derivation, hit, miss, version skew, atomic-write integrity.
- G7 — new unit tests for the parallel-pool helper exercise: order independence, concurrency cap, error propagation.

### Non-goals
- WASM byte cache for non-test runtime callers (only `closer-parity-as.test.ts` integrates the cache here; the `assemblyScriptBackend()` emit() signature stays pure — wrapping is the integration shape per D4).
- Replacing `execFileSync` with the in-process asc API (separate WI; significant architecture change).
- CI-side persistent cache mount (separate WI; needs platform decision).
- Raising `hookTimeout` above 60 min (issue #531 Option A is explicitly rejected as a forbidden shortcut).
- Corpus subsetting, `it.skip`, `it.todo` (Sacred Practice #5 + DEC-V1-WAVE-3-WASM-DEMO-CORPUS-LOADER-001).
- Changing `as-backend.ts emit()` signature (eval contract invariant).

### Constraints
- `as-backend.ts emit()` returns `Uint8Array<ArrayBuffer>` — callers (including this test) depend on the typed return; the cache wrapper must preserve that shape.
- Cache writes must be atomic (no torn reads under parallel workers).
- Cache root MUST be under the project `tmp/` tree per Sacred Practice #3 (no `/tmp/`).
- Cache key MUST be content-addressed; no wall-clock TTL.
- All scope file constraints in the workflow contract are hook-enforced.

---

## Architecture & State-Authority Map

### State authorities (canonical)

| Domain | Authority module | Read/write |
|---|---|---|
| `as-backend-compile-cache` (compiled-wasm reuse) | `packages/compile/src/as-compile-cache.ts` (NEW) — sole authority; includes inlined `renameWithRetry` | RW |
| `as-parity-runner` (concurrency + pool) | `packages/compile/src/as-parity-runner.ts` (NEW) — sole authority | RW |
| `closer-parity-as.test.ts` corpus loop | `packages/compile/test/as-backend/closer-parity-as.test.ts` — call-site only | RW |
| asc compiler args | `packages/compile/src/as-backend.ts` (read-only here — must not mutate `emit()` contract) | R |

### Adjacent surfaces (integration points)

- `packages/shave/src/cache/atomic-write.ts` — REFERENCE only. The `renameWithRetry` logic is **inlined privately** inside `as-compile-cache.ts`, not imported, to avoid `@yakcc/compile → @yakcc/shave` coupling for two callers AND to stay within the workflow scope manifest. If a third caller emerges, lift to a shared package then.
- `packages/shave/src/cache/file-cache.ts` — REFERENCE shape (two-level shard `<root>/<key[0..3]>/<key>.<ext>`).
- `examples/v1-wave-3-wasm-lower-demo/test/corpus-loader.js` — already supplies `corpus.atoms` (Map<hash, {implSource, sourcePath}>); the hash here IS the `canonicalAstHash` we'll use in the cache key. No changes.
- `node_modules/assemblyscript/package.json` — read once at process start to derive `ascVersion`.

### Removal targets
- The serial loop at `closer-parity-as.test.ts` L233-L279 (`for (const state of allAtomStates)`) is replaced by `processAtomsInParallel(allAtomStates, perAtomWorker, computeAscConcurrency())`. No parallel-mechanism risk because the loop body is moved verbatim into the worker closure; the serial loop is deleted, not preserved (Sacred Practice #12).

---

## Decisions (D1–D7)

### DEC-AS-COMPILE-CACHE-001 — Cache key composition

**Decision:** Cache key = `sha256(canonicalAstHash || "|" || ascVersion || "|" || ascFlagsHash)` rendered as 64-char hex.

- `canonicalAstHash`: the atom's `state.hash` from `corpus.atoms` (`closer-parity-as.test.ts` L213, L242 already use it as the partition key). This is produced by the shave corpus-loader and is the canonical AST identity for the atom.
- `ascVersion`: read from `node_modules/assemblyscript/package.json` `version` field once at module load time (resolve via `createRequire(import.meta.url).resolve("assemblyscript/package.json")` — same resolution path `resolveAsc()` at `as-backend.ts:696-705` uses). Memoize as a module-level `const`.
- `ascFlagsHash`: `sha256` over a JSON-stringified canonical array of asc args as built by `as-backend.ts:1510-1535` (currently: `[srcPath, "--outFile", outPath, "--optimize", "--runtime", "stub", optional "--noExportMemory" | ("--initialMemory","1")]`). The hash must NOT include `srcPath` or `outPath` (those vary per call); strip them out. Effective flag set for the cache-relevant variant in this test: `["--optimize", "--runtime", "stub", "--noExportMemory"]` (this test never sets `exportMemory: true` — confirmed L231 uses the no-args factory).

Version skew = entry-by-entry invalidation: when `ascVersion` changes, every key changes; old entries become inert (cache miss). No global flush needed. **No TTL** — content-addressed only.

**Rejected alternatives:**
- Single component (canonicalAstHash only) — vulnerable to silent staleness on asc upgrade.
- Wall-clock TTL — explicitly forbidden by workflow contract.

### DEC-AS-COMPILE-CACHE-002 — Cache storage layout

**Decision:** Cache root `<repoRoot>/tmp/yakcc-as-cache/`. Files at `<root>/<key[0..3]>/<key>.wasm`. Two-level shard mirrors `packages/shave/src/cache/file-cache.ts:20-25`.

- Atomic write: tmp file at `<shardDir>/<key>.tmp.<randomUUID>` written with `writeFile`, then atomic rename (via an **inlined** `renameWithRetry` helper, see below). On rename failure, best-effort `unlink(tmp)` in catch.
- Reads use `readFile`; ENOENT = miss (treat as undefined and proceed to compile).
- Corrupt entry (file exists but length 0 or fails `WebAssembly.validate`) → log warn, `unlink`, treat as miss.

**Atomic-write helper sourcing:** The `renameWithRetry` retry-on-EPERM/EBUSY helper from `packages/shave/src/cache/atomic-write.ts` is **inlined as a private function inside `packages/compile/src/as-compile-cache.ts`** (the cache module itself). Rationale:

- The workflow scope manifest does NOT include a separate `packages/compile/src/atomic-write.ts` file. Adding it would require a scope-sync expansion before implementer dispatch.
- The helper is ~30 lines of effective logic; inlining costs ~30 lines and removes the cross-file coupling discussion entirely.
- This is **intentional single-purpose duplication** (Sacred Practice #12 trade-off, recorded). When a third caller emerges, lift to a shared `@yakcc/cache-fs` package as a separate WI.
- Annotation at the inlined function: `// @decision DEC-AS-COMPILE-CACHE-002 — atomic rename helper inlined; mirrors DEC-SHAVE-CACHE-RENAME-RETRY-001 logic in packages/shave/src/cache/atomic-write.ts. Lift to shared package when a third caller emerges.`

**Sacred Practice #3 check:** cache root is `<repoRoot>/tmp/yakcc-as-cache/`, NOT `/tmp/` or `os.tmpdir()`. Resolve from `process.cwd()` at module init, with optional env override `YAKCC_AS_CACHE_DIR` for test isolation. The cache dir is git-ignored by the existing `tmp/` rule.

### DEC-AS-CLOSER-PARITY-CONCURRENCY-001 — Parallelization shape

**Decision:** Restore the lost `WI-FIX-485-CLOSER-PARITY-TIMEOUT` spec as `packages/compile/src/as-parity-runner.ts`:

```ts
export function computeAscConcurrency(opts?: { ci?: boolean }): number {
  // Env override
  const env = process.env.YAKCC_AS_PARITY_CONCURRENCY;
  if (env !== undefined) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  const ci = opts?.ci ?? (process.env.CI === "true" || process.env.CI === "1");
  const cpus = Math.max(1, os.cpus().length);
  return Math.min(cpus, ci ? 4 : 6);
}

export async function processAtomsInParallel<T, R>(
  items: ReadonlyArray<T>,
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]>;
```

- Pure built-in promise pool — no new dependency.
- Stable index input + result-array slot assignment so callers can keep order-stable derived state when needed.
- Errors from `worker` are caught **inside** the worker closure and converted to a result variant (this test's loop body already does try/catch at L240-L278; that try/catch moves verbatim into the worker, so the pool sees only resolved promises). The pool itself surfaces unexpected (worker-internal) throws via `Promise.allSettled` semantics: any rejection re-throws at `processAtomsInParallel` boundary with the original error chained.
- `YAKCC_AS_PARITY_CONCURRENCY=1` MUST reproduce serial order behavior (acceptance criterion G5).

**Default concurrency rationale:**
- Local dev (Mac, 8–10 cores): default 6 — leaves headroom for editor + vitest fork pool itself.
- CI (4-vCPU runners typical): default 4 — matches `maxWorkers: 2` cap in `vitest.config.ts` × 2 child compiles per worker without thrashing.
- Each asc invocation is `execFileSync` spawning a Node process — disk/IO bound, not pure CPU; oversubscribing modestly past `cpus()` would not help and increases scheduler thrash.

### DEC-AS-COMPILE-CACHE-003 — Integration site (cache wrapper)

**Decision:** **Option C — new wrapper module.** `packages/compile/src/as-compile-cache.ts` exports `cachedAsEmit(backend, resolution, atomHash, opts?)`. The test calls this wrapper inside the parallel-pool worker.

```ts
export interface CachedAsEmitOpts {
  readonly cacheDir?: string; // override for tests; defaults to <repoRoot>/tmp/yakcc-as-cache
  readonly disable?: boolean;  // YAKCC_AS_CACHE_DISABLE=1 short-circuit
}
export async function cachedAsEmit(
  backend: WasmBackend,
  resolution: ResolutionResult,
  atomHash: string,
  opts?: CachedAsEmitOpts,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; cacheStatus: "hit" | "miss" | "disabled" }>;
```

**Why Option C over A or B:**
- A (wrap inside `as-backend.ts emit()`) violates the eval-contract invariant "existing `as-backend.ts emit()` contract unchanged".
- B (inline in the test) makes the cache logic untestable in isolation.
- C composes cleanly: `as-backend.ts` stays pure (signature preserved); the cache is unit-testable against any `WasmBackend` impl; the test wires both together at the call site.

**Cache wrapper flow:**
1. Compute `cacheKey = sha256(atomHash + "|" + ASC_VERSION + "|" + ASC_FLAGS_HASH)`.
2. Try `readWasm(cacheDir, cacheKey)`:
   - Hit + `WebAssembly.validate(bytes)` → return `{bytes, cacheStatus: "hit"}`.
   - Hit but invalid → unlink, treat as miss.
   - Miss → fall through.
3. Resolve `getEmitPromise(cacheKey)`: **in-memory promise lock** (D5). If another worker is already compiling this key, await its promise; otherwise create one.
4. On lock owner: `backend.emit(resolution)`, then `writeWasm(cacheDir, cacheKey, bytes)` (atomic), then resolve the promise. Best-effort write — if write fails, log warn but still return bytes (cache write is opportunistic; correctness doesn't depend on it).
5. Return `{bytes, cacheStatus: "miss"}`.

### DEC-AS-COMPILE-CACHE-004 — Thundering herd lock

**Decision:** In-memory `Map<cacheKey, Promise<Uint8Array<ArrayBuffer>>>` inside the cache module. On cache miss, the first caller installs an in-flight promise; subsequent callers awaiting the same key share that promise. Map entry is deleted in a `finally` block after resolution.

- Cost: one `Map` entry per in-flight compile; bounded by concurrency (6 entries max in practice).
- Correctness: prevents duplicate asc compiles on cold runs when two workers happen to be on the same atom (rare given hash uniqueness across the corpus, but defensive).
- Cross-process: NOT a concern — this test runs in a single vitest worker; the cache file on disk handles persistence across runs.

### DEC-AS-COMPILE-CACHE-005 — Determinism guard

**Decision:** Cache wrapper MUST be **side-effect-equivalent** to direct `backend.emit()`:
- `cacheStatus` field is informational ONLY — the test must not branch behavior on it (only counts hit/miss for reporting evidence).
- Bytes returned from cache on warm hit MUST be byte-identical to bytes that would be produced on cold compile (asc 0.28.17 determinism confirmed per `as-backend.ts:34` — Issue #144 Phase 0 spike).
- `pending-atoms-as.json` write logic in `closer-parity-as.test.ts:281-295` is **completely untouched**. The cache changes only the speed of producing `coveredHashes` / `pendingHashes` / `runtimePending` — not the contents.

Determinism test: a new test `as-compile-cache.test.ts → "cold and warm runs produce byte-identical wasm bytes"` compiles the same atom twice (clean cache → bytes A; second call → cache hit → bytes B); asserts `Buffer.compare(A, B) === 0`.

Integration-level determinism is left to the implementer's local validation budget (D7) and reviewer evidence requirement: two back-to-back full runs of `closer-parity-as.test.ts`; diff `pending-atoms-as.json` (must be empty).

### DEC-AS-COMPILE-CACHE-006 — Cache miss path concurrency rules

**Decision:** Cache writes go through `renameWithRetry` (atomic on POSIX; retried on Windows EPERM/EBUSY per `DEC-SHAVE-CACHE-RENAME-RETRY-001`). Two workers racing on the same final path will both succeed cleanly: the in-memory lock (D4) prevents both from compiling, and even if the lock were bypassed, the atomic rename guarantees no torn read.

Cache reads on a partially-populated cache mid-run see exactly one of: ENOENT (miss; fall through to compile), or a fully-written valid wasm (hit). No torn-write window.

### DEC-AS-COMPILE-CACHE-007 — Validation budget and evidence

**Decision:** Implementer MUST capture and paste into the PR body:

1. **Cold-run wall-clock**: full `pnpm --filter @yakcc/compile test -- closer-parity-as.test.ts` from a clean cache directory. Paste vitest's `beforeAll` timing line.
2. **Warm-run wall-clock**: immediately re-run; paste the new `beforeAll` timing.
3. **Cache hit/miss counters**: log on warm run completion (e.g. `[as-cache] hits=N misses=M disabled=0`).
4. **Determinism evidence**: `diff <(jq -S . pending-atoms-as.json @ cold) <(jq -S . pending-atoms-as.json @ warm)` — must be empty.
5. **New unit-test pass output**: `pnpm --filter @yakcc/compile test -- as-compile-cache.test.ts as-parity-runner.test.ts`.
6. **All five existing invariants pass** in the same run; `it.fails` line 470 still reports "expected to fail" (it's the 80% gate guard, not a regression).
7. **`git diff --stat origin/main..HEAD`** scoped to `packages/compile/**` + `plans/wi-531-asc-compile-cache.md` + `tmp/wi-531-scope.json`.

Local validation cost estimate (the implementer must budget for this):
- Cold run: ~10–15 min wall-clock on a clean cache (M-series Mac), ~25 min CI worst case.
- Warm run: ~1–5 min wall-clock.
- Total minimum local validation: ~30 min for one cold+warm pair, plus buffer for any iteration.

**Synthetic small-corpus testing is necessary but not sufficient** — the acceptance criterion is a real 4119-atom run; unit tests alone don't prove the budget claim.

---

## File-by-File Implementation Plan

All paths are absolute or relative to the worktree root.

### New: `packages/compile/src/as-compile-cache.ts` (~220 lines, including inlined helper)

**Inlined private helper** `renameWithRetry` at the top of the module (NOT exported), with this annotation header:

```ts
// @decision DEC-AS-COMPILE-CACHE-002
// Title: Atomic-rename retry helper inlined here (not lifted to a shared package
//        yet). Mirrors DEC-SHAVE-CACHE-RENAME-RETRY-001 logic in
//        packages/shave/src/cache/atomic-write.ts. Two callers do not justify
//        cross-package coupling; lift to @yakcc/cache-fs when a third emerges.
// Status: decided (plans/wi-531-asc-compile-cache.md §DEC-AS-COMPILE-CACHE-002)
async function renameWithRetry(src: string, dst: string): Promise<void> { /* ... */ }
```

Module-level state (computed once at first import):
- `ASC_VERSION: string` — read from `assemblyscript/package.json` via `createRequire`.
- `ASC_FLAGS_HASH: string` — sha256 of `JSON.stringify(["--optimize","--runtime","stub","--noExportMemory"])` (note: matches the test's no-opts factory; if exportMemory variant is ever needed, gate hash on opts).
- `inFlight: Map<string, Promise<Uint8Array<ArrayBuffer>>>` — the lock map.

Exports:
```ts
export interface CachedAsEmitOpts {
  readonly cacheDir?: string;
  readonly disable?: boolean;
}
export interface CachedAsEmitResult {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly cacheStatus: "hit" | "miss" | "disabled";
}
export function deriveCacheKey(atomHash: string): string;
export async function cachedAsEmit(
  backend: WasmBackend,
  resolution: ResolutionResult,
  atomHash: string,
  opts?: CachedAsEmitOpts,
): Promise<CachedAsEmitResult>;
export function defaultCacheDir(): string; // <projectRoot>/tmp/yakcc-as-cache
```

Internal helpers (not exported):
- `readWasm(cacheDir, key)` — readFile + WebAssembly.validate; returns Uint8Array or undefined.
- `writeWasm(cacheDir, key, bytes)` — mkdir + writeFile tmp + renameWithRetry; best-effort.
- `shardPaths(cacheDir, key)` — two-level shard like file-cache.ts.

### New: `packages/compile/src/as-compile-cache.test.ts` (~200 lines)

Unit tests (use a per-test `cacheDir` under `tmp/yakcc-as-cache-test-<uuid>/`):
1. `deriveCacheKey` is deterministic and includes ascVersion (mock ascVersion via dynamic import? — simpler: assert key changes when atomHash changes; assert key is 64 hex chars).
2. Cache miss → calls backend.emit, writes file, returns `cacheStatus: "miss"`.
3. Cache hit → does NOT call backend.emit, returns bytes from disk, `cacheStatus: "hit"`.
4. Corrupt cache entry (truncated file) → falls through to backend, rewrites; `cacheStatus: "miss"`.
5. Disabled (`opts.disable: true` or `YAKCC_AS_CACHE_DISABLE=1`) → never reads or writes; always `cacheStatus: "disabled"`.
6. Concurrent same-key (two simultaneous `cachedAsEmit` calls with same hash on cold cache) → backend.emit called exactly once; both callers get identical bytes; one is "miss", the other is "hit" or "miss" depending on race (assert at least one was deduped via spy counter).
7. Cold→warm byte determinism: write twice with same input; bytes byte-equal.

Use a stub `WasmBackend` that returns a deterministic small valid WASM (`new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, /* minimal export section */])`) so tests don't require asc.

### New: `packages/compile/src/as-parity-runner.ts` (~80 lines)

Exports:
```ts
export function computeAscConcurrency(opts?: { ci?: boolean }): number;
export async function processAtomsInParallel<T, R>(
  items: ReadonlyArray<T>,
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]>;
```

Annotations:
- `@decision DEC-AS-CLOSER-PARITY-CONCURRENCY-001`

### New: `packages/compile/src/as-parity-runner.test.ts` (~120 lines)

Unit tests:
1. `computeAscConcurrency({ ci: true })` returns ≤4.
2. `computeAscConcurrency({ ci: false })` returns ≤6.
3. `YAKCC_AS_PARITY_CONCURRENCY=1` override → returns 1 regardless of ci.
4. `YAKCC_AS_PARITY_CONCURRENCY=12` → returns 12 (allow over-provisioning when user explicitly requests).
5. `processAtomsInParallel` with 100 items, concurrency=4, worker that increments a counter:
   - returns 100 results in input order (index-stable).
   - peak concurrent workers observed ≤4 (use a counter with max).
6. Worker throws on item 50 → `processAtomsInParallel` rejects with that error; remaining workers may still complete (Promise pool may settle, but rejection propagates).
7. Empty items array → resolves to `[]` immediately.

### Modified: `packages/compile/test/as-backend/closer-parity-as.test.ts`

**Only** the call-site loop changes. Specifically:

- L231 `const backend = assemblyScriptBackend();` — unchanged.
- L233-L279 — the `for (const state of allAtomStates)` serial loop is **replaced** by:

```ts
const concurrency = computeAscConcurrency();
console.log(`[corpus-as] AS-emit concurrency: ${concurrency}`);

interface PerAtomResult {
  readonly state: AtomState;
  readonly outcome:
    | { kind: "covered"; bytes: Uint8Array<ArrayBuffer>; cacheStatus: "hit" | "miss" | "disabled" }
    | { kind: "no-exports" }
    | { kind: "compile-error"; reason: string };
}

let cacheHits = 0;
let cacheMisses = 0;
let cacheDisabled = 0;

const perAtomResults = await processAtomsInParallel<AtomState, PerAtomResult>(
  allAtomStates,
  async (state) => {
    if (preSeededPendingSet.has(state.hash)) {
      // Pre-seeded; no compile path. Aggregate phase will record as pending.
      return { state, outcome: { kind: "compile-error", reason: "<pre-seeded>" } };
    }
    try {
      const resolution = makeSingleBlockResolution(state.source);
      const { bytes, cacheStatus } = await cachedAsEmit(backend, resolution, state.hash);
      if (cacheStatus === "hit") cacheHits++;
      else if (cacheStatus === "miss") cacheMisses++;
      else cacheDisabled++;
      const exportCount = countWasmExports(bytes);
      if (exportCount >= 1) return { state, outcome: { kind: "covered", bytes, cacheStatus } };
      return { state, outcome: { kind: "no-exports" } };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const shortReason = errMsg.slice(0, 200).replace(/\n/g, " ").trim();
      return { state, outcome: { kind: "compile-error", reason: `asc compile error: ${shortReason}`.slice(0, 300) } };
    }
  },
  concurrency,
);

// Aggregate (order-insensitive; outputs are sets/arrays of records).
for (const r of perAtomResults) {
  if (preSeededPendingSet.has(r.state.hash)) {
    pendingHashes.add(r.state.hash);
    continue;
  }
  if (r.outcome.kind === "covered") {
    validatedAtoms.push({ hash: r.state.hash, bytes: r.outcome.bytes });
    coveredHashes.add(r.state.hash);
  } else if (r.outcome.kind === "no-exports") {
    runtimePending.push({
      canonicalAstHash: r.state.hash,
      sourcePath: r.state.sourcePath,
      reason: "asc compiled OK but WASM has zero exports — no callable surface for parity testing",
      category: "as-no-exports",
    });
    pendingHashes.add(r.state.hash);
  } else {
    runtimePending.push({
      canonicalAstHash: r.state.hash,
      sourcePath: r.state.sourcePath,
      reason: r.outcome.reason,
      category: "as-compile-error",
    });
    pendingHashes.add(r.state.hash);
  }
}

console.log(`[as-cache] hits=${cacheHits} misses=${cacheMisses} disabled=${cacheDisabled}`);
```

- **No change** to step 3 (`pending-atoms-as.json` write block at L281-L295) — preserves byte-stable output.
- L297 `3_600_000` hookTimeout unchanged.
- Imports added at top: `import { cachedAsEmit } from "../../src/as-compile-cache.js"; import { computeAscConcurrency, processAtomsInParallel } from "../../src/as-parity-runner.js";`
- New `@decision DEC-AS-CLOSER-PARITY-CONCURRENCY-001` and `@decision DEC-AS-COMPILE-CACHE-001` annotations added at the head of the file (preserve existing `DEC-AS-CLOSER-PARITY-SIBLING-FILE-001`/`DEC-AS-MULTI-EXPORT-001`).

### Unchanged but in scope (declared in scope manifest only to allow incidental edits if blocked)

- `packages/compile/src/as-backend.ts` — read-only here; emit() signature is invariant. Listed in scope for the implementer to read freely; **must not** modify.
- `packages/compile/src/as-backend.props.ts`, `packages/compile/src/as-backend.props.test.ts` — in scope only to permit re-running existing prop tests if needed; no expected change.
- `packages/compile/vitest.config.ts` — in scope but **must not** be changed (raising hookTimeout is a forbidden shortcut per workflow contract).

---

## Scope Manifest

This mirrors the runtime-persisted Scope Manifest. The hook-enforced authoritative copy lives in `tmp/wi-531-scope.json` (to be written by guardian provisioning via `cc-policy workflow scope-sync`).

**Allowed paths** (read + write):
- `packages/compile/src/as-backend.ts` *(read-only behavior; listed for awareness)*
- `packages/compile/src/as-backend.props.ts`
- `packages/compile/src/as-backend.props.test.ts`
- `packages/compile/src/as-compile-cache.ts` (NEW)
- `packages/compile/src/as-compile-cache.test.ts` (NEW)
- `packages/compile/src/as-parity-runner.ts` (NEW)
- `packages/compile/src/as-parity-runner.test.ts` (NEW)
- `packages/compile/test/as-backend/closer-parity-as.test.ts`
- `packages/compile/test/as-backend/parallel-pool.ts` *(reserved name from workflow contract; only create if implementer decides to split runner into pool/runner; otherwise unused)*
- `packages/compile/test/as-backend/parallel-pool.test.ts` *(reserved; same as above)*
- `packages/compile/test/as-backend/test-helpers.ts` *(reserved; only if helper extraction is warranted)*
- `packages/compile/vitest.config.ts` *(in scope but must not change hookTimeout)*
- `plans/wi-531-asc-compile-cache.md`

**Required paths** (must be modified):
- `packages/compile/test/as-backend/closer-parity-as.test.ts`

**Forbidden paths**:
- `packages/shave/*`, `packages/shave/**/*` — atomic-rename logic is INLINED privately in `as-compile-cache.ts`, not imported
- `packages/hooks-base/*`, `packages/hooks-base/**/*`
- `packages/universalize/*`, `packages/universalize/**/*`
- `packages/registry/*`, `packages/registry/**/*`
- `.claude/*`, `.claude/**/*`
- `MASTER_PLAN.md`

**Authority domains touched**:
- `as-backend-compile-cache` (sole; defined by this WI)

---

## Evaluation Contract (mirror of persisted contract)

### Required tests
- `pnpm --filter @yakcc/compile test -- closer-parity-as.test.ts` completes under the 60-min `hookTimeout` on a cold-cache run.
- Same test on a warm-cache run completes substantially faster (cache hit ratio measurable; expected >95% on unchanged corpus).
- `pending-atoms-as.json` byte-identical across two back-to-back cold→warm runs (determinism).
- New unit tests for the asc compile cache module: hash key derivation, cache hit, cache miss, version skew invalidates entry, atomic write, thundering-herd dedupe.
- New unit tests for the parallel-pool runner: concurrency cap, order independence, error propagation, env override.
- Existing five closer-parity-as invariants still pass; `it.fails` 80% coverage gate still fails as expected.
- `YAKCC_AS_PARITY_CONCURRENCY=1` reproduces serial baseline within ±10% (rollback path proof).

### Required evidence (paste into PR body)
- Cold-run wall-clock from `beforeAll` (vitest timing).
- Warm-run wall-clock from `beforeAll` (vitest timing).
- Cache hit/miss counters logged on the warm run.
- Diff of `pending-atoms-as.json` across the two runs (must be empty).
- Unit-test pass output for the new cache module and parity runner.
- `git diff --stat origin/main..HEAD` scoped to `packages/compile/**` + `plans/wi-531-asc-compile-cache.md` + `tmp/wi-531-scope.json`.

### Required real-path checks (pre-flight)
- `packages/compile/test/as-backend/closer-parity-as.test.ts` exists ✓ (verified in plan: L1).
- `packages/compile/src/as-backend.ts` exists and exposes `assemblyScriptBackend()` ✓ (verified: L1479).

### Required authority invariants
- `as-compile-cache.ts` is the SOLE authority for compiled-wasm reuse; no parallel cache mechanism added.
- Cache key includes `(canonicalAstHash, ascVersion, ascFlagsHash)` — version skew invalidates entries.
- Cache writes go through `renameWithRetry` (atomic on POSIX; retried on Windows) — no torn writes under concurrent compile.
- `pending-atoms-as.json` sort/write path (`closer-parity-as.test.ts:281-295`) unchanged — deterministic output preserved.
- `as-backend.ts emit()` contract unchanged — callers still get `Uint8Array<ArrayBuffer>`.

### Required integration points
- Parallelization integrates with cache: parallel workers call `cachedAsEmit` which reads cache before invoking `backend.emit()`.
- Cache miss path invokes `backend.emit()` exactly once per `(key, version, flags)` tuple even under concurrency (in-memory promise lock per DEC-AS-COMPILE-CACHE-004).
- `DEC-AS-CLOSER-PARITY-CONCURRENCY-001` annotated at `as-parity-runner.ts` + `closer-parity-as.test.ts` call-site.
- `DEC-AS-COMPILE-CACHE-001` annotated at `as-compile-cache.ts` module head + `closer-parity-as.test.ts` call-site.

### Forbidden shortcuts
- Raising `hookTimeout` above 60 min (Option A in #531 — rejected).
- Corpus subsetting or `it.skip`/`it.todo` on any atom.
- Mutating `as-backend.ts emit()` signature.
- Weakening any of the five existing invariants.
- Writing cache to `/tmp/` or any path outside the project `tmp/` tree.
- Skipping the determinism check.
- Cache invalidation by wall-clock TTL — must be content-addressed.

### Ready for guardian when
- All `required_tests` pass.
- Both DEC annotations present in source (`DEC-AS-CLOSER-PARITY-CONCURRENCY-001`, `DEC-AS-COMPILE-CACHE-001`).
- Reviewer verdict `ready_for_guardian` with current HEAD SHA.
- Cold-run and warm-run wall-clock evidence pasted in PR body.
- `pending-atoms-as.json` determinism evidence pasted.
- Closes #531; references #485, #143.

### Rollback boundary
- `git revert` of the landing commit.
- Cache directory under `<repoRoot>/tmp/yakcc-as-cache/` may be left behind without functional impact (next run rebuilds it).

---

## Wave Decomposition (single bounded slice)

Per workflow_contract, this is a single in-progress work item. No further sub-waves; the implementer lands the cohesive bundle together.

| WI-ID | Title | Weight | Gate | Deps | Files |
|---|---|---|---|---|---|
| wi-531-asc-compile-cache | parallelization + content-addressed cache, single bundle | XL | reviewer → guardian | none | as documented above |

Both halves must land together because:
- Parallelization without cache: cold runs may still exceed 60 min on slow CI runners.
- Cache without parallelization: warm runs are fast but cold runs unchanged (still serial 5400+ seconds).

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Thundering herd** on cold cache (two workers compile same atom) | Low (hash uniqueness per atom in corpus) | In-memory promise lock per DEC-AS-COMPILE-CACHE-004; redundant atomic-rename safety on top. |
| **Cache poisoning across asc version skew** | Negligible | Key includes `ascVersion`; old entries become inert (miss). |
| **Hash collision** producing false cache hit | Negligible at SHA-256 (2^-256) | Defensive: `WebAssembly.validate` on read; corrupt entry → unlink + recompile. |
| **CI runner disk pressure** | Low (4119 wasm files × few KB each = bounded ≤50MB) | Cache lives under `tmp/`; ephemeral by runner convention. Optional future WI: cleanup of stale shards (LRU). |
| **Determinism break** from concurrent map mutation | Low | All shared state (`coveredHashes`/`pendingHashes`/`runtimePending`/`validatedAtoms`) is populated in the **aggregate phase** after `processAtomsInParallel` resolves — no race during workers. |
| **WebAssembly.validate not byte-deterministic over re-compile** | Negligible | asc 0.28.17 determinism confirmed per `as-backend.ts:34` (Issue #144 Phase 0). Determinism test covers this directly. |
| **`pending-atoms-as.json` ordering changes under parallel** | Mitigated by design | `writePendingAtoms` already sorts (existing path L292); aggregate phase runs after all workers finish. |
| **Local validation cost (~30 min)** | Known | Acceptance-criterion-mandated; implementer budgets explicitly. Cannot be substituted with synthetic. |
| **Hooks blocking implementer on scope edge cases** | Low | Scope file pre-synced via `cc-policy workflow scope-sync` before implementer dispatch; provided allowed/required/forbidden cover all planned paths. |

---

## Out-of-Scope (explicit, to prevent scope creep)

- WASM byte cache for non-test runtime callers (e.g. `ts-backend.ts` consumers, production compile path) — separate WI; needs independent eval-contract design.
- In-process asc compiler API (replacing `execFileSync`) — significant architectural change; separate WI #TBD.
- CI-cache integration (persistent cache mount across CI runs) — needs platform decision (GHA cache action, S3, etc.); separate WI.
- Lifting `renameWithRetry` to a shared `@yakcc/cache-fs` package — defer until a third caller emerges (Sacred Practice #12 trade-off, recorded here as deliberate).
- LRU eviction / cache size cap — current pattern relies on `tmp/` cleanup convention; not yet a problem at 4119 entries × few KB.
- Phase 2 80% gate-flip (#143) — this WI unblocks it but doesn't perform the flip.

---

## Decision Log (this WI)

| DEC-ID | Title | Status | Decided |
|---|---|---|---|
| DEC-AS-COMPILE-CACHE-001 | Cache key = sha256(canonicalAstHash, ascVersion, ascFlagsHash) | decided | 2026-05-15 |
| DEC-AS-COMPILE-CACHE-002 | Two-level shard cache at `<repoRoot>/tmp/yakcc-as-cache/`; atomic-rename helper inlined privately in cache module (not a separate file) | decided | 2026-05-15 |
| DEC-AS-CLOSER-PARITY-CONCURRENCY-001 | Promise pool with `computeAscConcurrency()`; default 4 (CI) / 6 (dev); env override `YAKCC_AS_PARITY_CONCURRENCY` | decided | 2026-05-15 |
| DEC-AS-COMPILE-CACHE-003 | Integration via wrapper module `cachedAsEmit` (Option C) — `as-backend.ts emit()` stays pure | decided | 2026-05-15 |
| DEC-AS-COMPILE-CACHE-004 | In-memory promise lock prevents thundering herd on cold cache | decided | 2026-05-15 |
| DEC-AS-COMPILE-CACHE-005 | Cache must be side-effect-equivalent to direct emit; determinism test required | decided | 2026-05-15 |
| DEC-AS-COMPILE-CACHE-006 | Cache writes atomic via `renameWithRetry`; corrupt-entry recovery via unlink+recompile | decided | 2026-05-15 |
| DEC-AS-COMPILE-CACHE-007 | Local validation requires both cold and warm full-corpus runs; evidence in PR body | decided | 2026-05-15 |

---

## Next Action

Guardian provisioning (`guardian:provision`) creates `feature/fix-531-asc-compile-cache` worktree from current `origin/main`, writes `tmp/wi-531-scope.json` mirroring the Scope Manifest above, and dispatches `implementer`.

```
PLAN_SUMMARY: wi-531-asc-compile-cache plan written with D1-D7 decisions, scope manifest, evaluation contract, file-by-file delta; ready for guardian:provision of feature/fix-531-asc-compile-cache.
```
