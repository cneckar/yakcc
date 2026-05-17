Implement a synchronous two-phase commit (2PC) coordinator.

Export these classes:

```typescript
export class TwoPhaseCommitError extends Error {
  constructor(message: string)
}

export class Participant {
  constructor(id: string, vote: 'yes' | 'no')
  getId(): string
  prepare(): 'yes' | 'no'
  commit(): void
  abort(): void
  getState(): 'idle' | 'prepared' | 'committed' | 'aborted'
}

export class Coordinator {
  constructor(participants: Participant[])
  run(): 'committed' | 'aborted'
  getState(): 'idle' | 'running' | 'committed' | 'aborted'
}
```

**Protocol:**
1. `Coordinator.run()` calls `prepare()` on every participant
2. If ALL participants return `'yes'`: call `commit()` on every participant, return `'committed'`
3. If ANY participant returns `'no'`: call `abort()` on every participant, return `'aborted'`

**State machine rules:**
- `Participant` initial state: `'idle'`
- `prepare()` transitions a YES-voter from `'idle'` → `'prepared'`; a NO-voter from `'idle'` → `'aborted'`
- `commit()` transitions from `'prepared'` → `'committed'`; is a no-op from any other state (idempotent)
- `abort()` transitions from `'idle'` or `'prepared'` → `'aborted'`; is a no-op from `'committed'` or `'aborted'` (idempotent)
- `Coordinator` initial state: `'idle'`
- `run()` transitions `'idle'` → `'running'` → `'committed'` or `'aborted'`
- `run()` throws `TwoPhaseCommitError` if `participants` is empty
- `run()` throws `TwoPhaseCommitError` if called when coordinator state is not `'idle'` (no re-run)

Constraints:
- Everything is synchronous (no async/await/Promises)
- `Coordinator` must send `abort()` to ALL participants (including YES-voters) if any participant votes NO
