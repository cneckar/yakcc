# WI-525 — Fix Windows EPERM rename race in shave cache writeIntent

**Workflow:** `wi-525-cache-eperm`
**Goal:** `g-525-cache-eperm`
**Issue:** #525
**Stage:** planner → implementer
**Status:** plan ready
**Author:** planner (Serenity)

---

## 1. Problem statement

`packages/shave/src/cache/cache.test.ts:151` — the test
"`writeIntent() + readIntent() round-trip > concurrent writes to same key both
resolve to a valid file`" is non-deterministic on Windows. Two concurrent
`writeIntent()` calls each write their own uniquely-named `*.tmp.<random>`
sidecar (file-cache.ts:88) and then race on `fs.rename(tmp, finalPath)`
(file-cache.ts:94).

- **POSIX**: `rename(2)` is atomic with respect to a target path even when
  another process holds an open handle on it. Both races succeed; "last writer
  wins" is acceptable per the test invariant (it only asserts the final file
  contains *one of the two* cards, not which one).
- **Windows**: `MoveFileEx` (which Node's `fs.rename` invokes) returns
  `ERROR_ACCESS_DENIED` / `ERROR_SHARING_VIOLATION` when the destination is
  briefly held by another handle — typically because a sibling
  `writeFile`/`rename` from a concurrent caller has not yet released its lock.
  Node surfaces this as `EPERM` (or occasionally `EBUSY`) on the second
  rename.
- The lock window is short — empirically under ~100 ms in nearly all cases —
  but it is exposed deterministically by the parallel writes the production
  code relies on (multiple shave invocations against the same source file
  share a cache key).

This is a pre-existing bug. It is not introduced by recent slices (#544, #553,
etc.). It surfaces sporadically in Windows CI runs and would surface in any
Windows production deployment that runs shave with concurrency.

---

## 2. Scope manifest (mirrors persisted scope row)

**Allowed paths:**

- `packages/shave/src/cache/file-cache.ts` — source change (call site)
- `packages/shave/src/cache/atomic-write.ts` — new helper module (retry wrapper)
- `packages/shave/src/cache/atomic-write.test.ts` — new focused unit test
- `packages/shave/src/cache/cache.ts` — present in scope; not expected to be
  touched unless the implementer discovers a barrel re-export
- `packages/shave/src/cache/cache.test.ts` — may be left untouched; the
  existing concurrent-write test is the integration assertion this fix must
  keep green
- `packages/shave/src/cache/file-cache.props.ts` / `file-cache.props.test.ts`
  — likely untouched; only adjust if a property currently asserts "rename
  throws on first attempt"
- `plans/wi-525-cache-eperm.md` — this file

**Forbidden paths:**

- `packages/compile/**`
- `packages/hooks-base/**`
- `packages/universalize/**`
- `.claude/**`

**State authorities touched:** none. This is a local file-IO fix; no SQLite,
no event log, no dispatch state.

---

## 3. Evaluation Contract

(Persisted authority: `cc-policy workflow work-item-get wi-525-cache-eperm`.
This section restates the contract the reviewer will run against; do not
weaken it during implementation.)

### Required tests (must pass)

1. **Existing**: `packages/shave/src/cache/cache.test.ts`
   - All 12 tests in the file must remain green.
   - In particular: `concurrent writes to same key both resolve to a valid
     file` (line 151) and `throws and cleans up tmp file when rename fails
     (destination is a directory)` (line 190).
2. **New**: `packages/shave/src/cache/atomic-write.test.ts`
   - **EPERM-retry-then-success**: mock `fs.rename` to throw `{ code: 'EPERM'
     }` once, then resolve on the second call. Assert the helper resolves
     without throwing and the call count is 2.
   - **EBUSY-retry-then-success**: same shape, with `{ code: 'EBUSY' }`.
   - **Bounded-retries-then-rethrow**: mock `fs.rename` to throw `EPERM` on
     every call. Assert the helper rethrows the *original* `EPERM` error after
     the bounded attempt count and that `fs.rename` was called exactly
     `MAX_ATTEMPTS` times.
   - **Non-retryable-rethrows-immediately**: mock `fs.rename` to throw `{
     code: 'EISDIR' }`. Assert the helper rethrows on the first attempt
     without retry (call count = 1). This protects the existing "destination
     is a directory" test invariant.
   - **No-error-no-retry**: mock `fs.rename` to resolve on the first call.
     Assert call count = 1.

### Required real-path checks

- `writeIntent` still calls the atomic-write helper at exactly one site
  (file-cache.ts ~line 94). No callers bypass the helper.
- `writeIntent` still unlinks the tmp file on terminal failure (the helper
  must surface the error after exhausting retries so the existing cleanup
  branch fires).

### Required authority invariants

- No new state domain introduced.
- Atomic-write semantics preserved: a concurrent reader during the retry
  window must still see either the prior file contents or `ENOENT` — never a
  partial write. (The retry never *opens* the destination; it only renames.
  The atomicity property is unchanged.)

### Required integration points

- `readIntent` continues to round-trip with `writeIntent` (existing test at
  cache.test.ts:133).
- Property tests in `file-cache.props.test.ts` continue to hold.

### Forbidden shortcuts

- **No `try { rename } catch { writeFile(finalPath) }`** fallback. That breaks
  atomicity — a concurrent reader could see a partial file.
- **No unbounded retry loop.** A genuine persistent failure (full disk,
  permissions revoked, destination is a directory) must surface within a
  bounded wall-clock budget.
- **No swallowing of non-EPERM/EBUSY errors.** Any other error code must
  rethrow on the first occurrence.
- **No retry on the `writeFile` step.** The race is the rename, not the
  tmp-file write. Retrying the writeFile would mask other bugs.
- **No `setTimeout` without cleanup** — use `await new Promise(r =>
  setTimeout(r, ms))` so the helper is properly async.

### Ready-for-guardian definition

The reviewer may declare `ready_for_guardian` when:

1. All 5 new tests in `atomic-write.test.ts` pass on macOS/Linux CI.
2. All existing tests in `cache.test.ts` continue to pass.
3. `pnpm -r typecheck` is clean.
4. `pnpm -r lint` is clean.
5. The source change carries a `@decision DEC-SHAVE-CACHE-RENAME-RETRY-001`
   annotation naming the retry policy and rationale.
6. Diff is confined to the scope manifest above.

Note: full Windows-CI verification is **out of scope** for this work item
(see §7). The retry helper is unit-tested with mocked rename failures, which
deterministically exercises the EPERM code path on any platform.

---

## 4. Implementation plan

### 4.1 Retry policy (DEC-SHAVE-CACHE-RENAME-RETRY-001)

**Shape**: 5 attempts (1 initial + 4 retries), exponential backoff
`10ms, 20ms, 40ms, 80ms, 160ms`. Total worst-case wall-clock budget: ~310ms.

**Rationale**:
- Windows lock windows during a concurrent `fs.rename` typically clear in
  <100ms (the OS releases the destination handle as the writer's
  `writeFile`-then-`rename` sequence completes its flush).
- 5 attempts with exponential backoff covers the 99th-percentile Windows lock
  duration without masking persistent failures.
- A bounded total budget (~310ms) is small enough that a genuine bug
  (permissions, EISDIR, full disk) surfaces quickly and large enough to
  absorb realistic contention.
- Exponential (not linear) backoff prevents tight-loop CPU burn during a
  cluster of concurrent writers.

**Retryable error codes**: `EPERM`, `EBUSY`.
- `EPERM` is the dominant Windows symptom (per issue #525).
- `EBUSY` is the sister Windows error class that `MoveFileEx` can surface
  when the destination handle is held longer. Documented in Node fs error
  semantics for cross-platform code that does atomic rename.
- Any other code (`EISDIR`, `ENOENT`, `EACCES` on the parent dir, `ENOSPC`,
  etc.) **rethrows immediately** on the first attempt.

**Non-retryable rethrow**: must preserve the *original* error object so the
existing `cache.test.ts:190` test (which asserts `rejects.toThrow()` on
EISDIR) keeps observing the unmodified error.

### 4.2 Module layout

Create `packages/shave/src/cache/atomic-write.ts` with a single exported
function:

```ts
// SPDX-License-Identifier: MIT
// @decision DEC-SHAVE-CACHE-RENAME-RETRY-001: writeIntent's tmp→final
// rename retries on EPERM/EBUSY (Windows transient lock) with bounded
// exponential backoff (5 attempts: 10/20/40/80/160ms; ~310ms total budget).
// Status: decided (this plan: plans/wi-525-cache-eperm.md §4.1)
// Rationale: Windows MoveFileEx surfaces EPERM/EBUSY when the destination is
// briefly held by a concurrent writer's handle. The lock window is typically
// <100ms; 5 attempts at ~310ms total absorbs the 99th percentile without
// masking persistent failures (EISDIR, ENOSPC, EACCES rethrow immediately).
// POSIX rename is atomic over open handles, so this is a no-op on Linux/macOS.

import { rename } from "node:fs/promises";

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [10, 20, 40, 80, 160] as const;
const RETRYABLE_CODES = new Set(["EPERM", "EBUSY"]);

export async function renameWithRetry(src: string, dst: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await rename(src, dst);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || !RETRYABLE_CODES.has(code)) {
        throw err; // non-retryable: rethrow original error immediately
      }
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise<void>((r) => setTimeout(r, BACKOFF_MS[attempt]));
      }
    }
  }
  throw lastErr; // exhausted retries: rethrow last EPERM/EBUSY
}
```

(The implementer may refine signatures and naming — this sketch defines the
contract, not the exact prose.)

### 4.3 Call-site change in `file-cache.ts`

Replace the bare `rename` call at line 94:

```ts
// Before
await rename(tmpPath, filePath);

// After
import { renameWithRetry } from "./atomic-write.js";
// ...
await renameWithRetry(tmpPath, filePath);
```

Remove the now-unused `rename` import from `node:fs/promises` if it has no
other consumer in the file (it does not — verified at file-cache.ts:11).

The `try { ... } catch { unlink(tmpPath); throw err; }` cleanup block at
file-cache.ts:93-101 stays unchanged. If `renameWithRetry` exhausts retries
or hits a non-retryable error, it surfaces the error and the existing
cleanup branch fires.

### 4.4 Test design (`atomic-write.test.ts`)

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsPromises from "node:fs/promises";
import { renameWithRetry } from "./atomic-write.js";

describe("renameWithRetry()", () => {
  let renameSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { renameSpy = vi.spyOn(fsPromises, "rename"); });
  afterEach(() => { renameSpy.mockRestore(); });

  it("resolves immediately when rename succeeds", async () => {
    renameSpy.mockResolvedValueOnce(undefined);
    await expect(renameWithRetry("a", "b")).resolves.toBeUndefined();
    expect(renameSpy).toHaveBeenCalledTimes(1);
  });

  it("retries on EPERM then succeeds", async () => {
    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
    renameSpy.mockRejectedValueOnce(eperm).mockResolvedValueOnce(undefined);
    await expect(renameWithRetry("a", "b")).resolves.toBeUndefined();
    expect(renameSpy).toHaveBeenCalledTimes(2);
  });

  it("retries on EBUSY then succeeds", async () => {
    const ebusy = Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    renameSpy.mockRejectedValueOnce(ebusy).mockResolvedValueOnce(undefined);
    await expect(renameWithRetry("a", "b")).resolves.toBeUndefined();
    expect(renameSpy).toHaveBeenCalledTimes(2);
  });

  it("rethrows EPERM after bounded retries", async () => {
    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
    renameSpy.mockRejectedValue(eperm);
    await expect(renameWithRetry("a", "b")).rejects.toBe(eperm);
    expect(renameSpy).toHaveBeenCalledTimes(5);
  });

  it("rethrows non-retryable EISDIR immediately (no retry)", async () => {
    const eisdir = Object.assign(new Error("EISDIR"), { code: "EISDIR" });
    renameSpy.mockRejectedValueOnce(eisdir);
    await expect(renameWithRetry("a", "b")).rejects.toBe(eisdir);
    expect(renameSpy).toHaveBeenCalledTimes(1);
  });
});
```

**Mock discipline**: `vi.spyOn(fsPromises, "rename")` then `mockRestore()` in
`afterEach`. Do NOT module-mock `node:fs/promises` — it would cascade into
other tests in the same vitest run.

**Backoff handling in tests**: `setTimeout`-based backoff between retries
adds ~310ms to the "rethrows EPERM after bounded retries" test. That is
acceptable; if the implementer wants to keep the test suite fast they may
inject a clock or wrap `setTimeout` behind a module-private constant they can
override in tests — but the simpler, less-mock-heavy form above is preferred
for clarity. The full suite still runs well under a second.

### 4.5 No `cache.test.ts` change required

The existing concurrent-write test (line 151) is the integration assertion
this fix exists to satisfy. It must remain unchanged. If it remains green on
macOS/Linux after the change (it should — POSIX rename never fails with
EPERM on this path), the implementer should not touch it.

The existing EISDIR test (line 190) must also remain unchanged. With
EISDIR's non-retryable behavior in `renameWithRetry`, the rejection surfaces
on the first attempt with the original error object, preserving the test's
`rejects.toThrow()` expectation.

---

## 5. Decision log

| DEC-ID | Decision | Rationale |
|---|---|---|
| DEC-SHAVE-CACHE-RENAME-RETRY-001 | Bounded retry on EPERM/EBUSY for `fs.rename` in atomic-write helper. 5 attempts; 10/20/40/80/160ms exponential backoff. | Windows `MoveFileEx` surfaces EPERM/EBUSY on transient lock contention from concurrent writers. The lock window clears in <100ms in the dominant case; 5 attempts at ~310ms total absorbs 99p without masking real persistent failures. Non-retryable codes rethrow immediately to preserve existing error semantics (EISDIR test). |

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Retry masks a genuine persistent failure that *happens* to surface as EPERM. | Low. EPERM on `rename` outside the Windows-lock case is rare and usually indicates revoked permissions, which a retry won't resolve. | Bounded retry count (5) and bounded wall-clock budget (~310ms). After exhaustion, the original error surfaces with the full stack trace. |
| The 310ms worst-case adds latency to writeIntent on the rare failure path. | Low — this path is only hit on Windows contention. | Acceptable: this is the failure path. The success path (no contention) adds zero latency. |
| `vi.spyOn(fsPromises, "rename")` leaks across tests if `mockRestore` is forgotten. | Low. | Cookbook `afterEach(() => renameSpy.mockRestore())`. The plan's test sketch already enforces this. |
| Property test `file-cache.props.test.ts` asserts something about rename throwing. | Very low — file is property-based with synthetic inputs; unlikely to depend on rename-attempt counts. | Implementer verifies by running `pnpm -F shave test` after the change. If a property fails, that is a real signal worth surfacing — do not weaken it without re-planning. |

---

## 7. Out of scope

- **Live Windows CI verification.** The shave package does not currently run
  on a Windows CI matrix. Adding one is a separate infrastructure task. The
  unit tests in `atomic-write.test.ts` deterministically exercise the EPERM
  retry path on any platform via mock; that is the verification surface for
  this WI.
- **Generalizing the retry to other fs operations** (writeFile, unlink,
  mkdir). Issue #525 names the rename race specifically; other operations
  have not been reported as flaky. A speculative generalization would expand
  scope without evidence.
- **Replacing `fs.rename` with a userspace copy-then-delete dance.** That
  would break atomicity (a concurrent reader could observe the partial
  copy). Atomic rename is the correct primitive; the fix is to handle the
  transient Windows lock contention, not to abandon the primitive.

---

## 8. Implementer dispatch summary

- **State domains**: none.
- **Adjacent components**: `extractIntent` (calls `writeIntent` / `readIntent`
  from `packages/shave/src/intent/`); no changes required there.
- **Canonical authority**: `writeIntent` (file-cache.ts:79) remains the sole
  on-disk write path for the intent cache.
- **Removal targets**: none. This is additive.
- **Annotations**: `@decision DEC-SHAVE-CACHE-RENAME-RETRY-001` at the top of
  `atomic-write.ts`. Cross-reference from `file-cache.ts:79` if the
  implementer judges it useful.

---
